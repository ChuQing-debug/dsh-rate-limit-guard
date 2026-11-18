/**
 * Rate limit guard: when a provider answers with a PRM/TPM style rate limit,
 * either wait for the window to refresh (auto-resume the same step) or rotate
 * the provider credential to the next key in a configured pool, instead of
 * letting the attempt fail.
 *
 * The guard owns the `agent/request-error` decision for rate-limit failures
 * (prepended, so it runs before the ordinary retry policy). Every wait is also
 * announced through the durable `llm/retry` / `llm/retry-started` events, which
 * the chat UI already renders as a live countdown row, and through the plugin
 * log plus the `/ratelimit-log` command.
 */
import { randomUUID } from 'node:crypto'
import z from './vendor/schemastery.mjs'
import {
  backupRefFor,
  computeDelay,
  fingerprint,
  isAuthFailure,
  isQuotaFailure,
  isRateLimitFailure,
  isValidRef,
  pickNext,
  previousRefFor,
  refForProvider,
} from './lib.js'

export const name = 'rate-limit-guard'

/** `agents` guarantees the composition that dispatches `agent/request-error`. */
export const inject = ['agents']

const LOG_LIMIT = 200
const STATE_LIMIT = 512
const STATE_TTL_MS = 2 * 60 * 60 * 1000
/**
 * A failure that arrives this soon after a rotation most likely came from a request that was
 * already in flight with the old key (another session, or this one racing). Retry it once on the
 * new key instead of rotating again and skipping a pool entry.
 */
const ROTATE_GRACE_MS = 5000
const CLOCK_SLOP_MS = 50
/** How long after a rotation an auth failure is blamed on the key that rotation installed. */
const REJECT_WINDOW_MS = 60_000
/** A key the provider rejected stays out of the rotation this long (or until the plugin reloads). */
const REJECTED_KEY_COOLDOWN_MS = 24 * 60 * 60 * 1000
/**
 * At most this many pool keys are benched as "rejected" per rate-limit rotation. An auth failure that
 * follows every key around is not about the keys, and must not bench the whole pool.
 */
const MAX_REJECTS_PER_ROTATION = 2

export const Config = z.object({
  mode: z.union(['wait', 'rotate']).default('wait').volatile(),
  waitSeconds: z.number().default(60).volatile(),
  useRetryAfter: z.boolean().default(true).volatile(),
  maxWaitSeconds: z.number().default(900).volatile(),
  maxAttempts: z.number().default(12).volatile(),
  minWaitSeconds: z.number().default(1).volatile(),
  jitter: z.boolean().default(true).volatile(),
  waitOnQuota: z.boolean().default(false).volatile(),
  quotaCooldownMinutes: z.number().default(60).volatile(),
  credentialRef: z.string().default('DEEPSEEK_API_KEY').volatile(),
  alternateKeyRefs: z.array(z.string()).default([]).volatile(),
  providerRefs: z.array(z.string()).default([]).volatile(),
  keepOriginalKey: z.boolean().default(true).volatile(),
  fallbackToWait: z.boolean().default(true).volatile(),
  guardedProviders: z.array(z.string()).default([]).volatile(),
})

function messageOf(error) {
  if (error === undefined || error === null) return 'unknown error'
  return typeof error.message === 'string' ? error.message : String(error)
}

/** Read a config field that may be a plain value or a volatile accessor. */
function readField(value, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'object' && typeof value.get === 'function') {
    try {
      const resolved = value.get()
      return resolved === undefined ? fallback : resolved
    } catch {
      return fallback
    }
  }
  return value
}

function readNumber(value, fallback, min, max) {
  const parsed = Number(readField(value, fallback))
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(Math.max(parsed, min), max)
}

function readBoolean(value, fallback) {
  const resolved = readField(value, fallback)
  return typeof resolved === 'boolean' ? resolved : fallback
}

function readStrings(value) {
  const resolved = readField(value, [])
  if (!Array.isArray(resolved)) return []
  const seen = new Set()
  const out = []
  for (const item of resolved) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed === '' || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

function truncate(text, max) {
  const value = String(text ?? '')
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

function normalizeFailure(failure) {
  const out = {
    message: String(failure?.message ?? 'rate limit reached'),
    code: String(failure?.code ?? 'RATE_LIMIT'),
  }
  if (typeof failure?.status === 'number') out.status = failure.status
  if (typeof failure?.providerRetryAfterMs === 'number') out.providerRetryAfterMs = failure.providerRetryAfterMs
  if (typeof failure?.providerRequestId === 'string') out.providerRequestId = failure.providerRequestId
  return out
}

function fuseSignals(signal, lifetimeSignal) {
  const signals = [signal, lifetimeSignal].filter(Boolean)
  if (signals.length === 0) return undefined
  if (signals.length === 1) return signals[0]
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals)
  const controller = new AbortController()
  const abort = () => controller.abort()
  for (const item of signals) {
    if (item.aborted) {
      controller.abort()
      break
    }
    item.addEventListener('abort', abort, { once: true })
  }
  return controller.signal
}

/** Resolve after `ms`, or as soon as the signal aborts. Resolves true when elapsed. */
function wait(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false)
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve(true)
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      resolve(false)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function shortTime(iso) {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleTimeString('zh-CN', { hour12: false })
  } catch {
    return iso
  }
}

const ACTION_LABELS = {
  detected: '检测到限流',
  waiting: '进入等待',
  resumed: '已恢复并继续',
  aborted: '等待被取消',
  rotated: '已轮换密钥',
  'rotate-raced': '刚轮换过，直接重试',
  'rotate-unavailable': '无法轮换密钥',
  'key-rejected': '密钥被拒绝',
  'original-saved': '已备份原密钥',
  'quota-handoff': '额度耗尽，交回处理',
  exhausted: '达到重试上限',
}

export function apply(ctx, config = {}) {
  const attempts = new Map()
  const logs = []
  const lifetime = new AbortController()
  /** fingerprint -> epoch ms until which that key is known to be limited / exhausted */
  const cooldowns = new Map()
  /** target ref -> { id, at, setAt, toFp, provider, rejects } of the latest rotation */
  const lastRotation = new Map()
  /** target ref -> tail of the promise chain that serializes rotations of that ref */
  const locks = new Map()
  let credentials

  ctx.inject(['credentials'], (sub) => {
    credentials = sub.credentials
    sub.effect(() => () => {
      credentials = undefined
    }, 'rate-limit-guard: credentials handle')
  })

  // The plugin ships its own settings page, so hide the auto-generated one.
  ctx.inject(['settings'], (sub) => {
    try {
      sub.settings.configure({ auto: false }, ctx.fiber)
    } catch (error) {
      ctx.logger?.warn?.(`rate-limit-guard: settings.configure failed: ${messageOf(error)}`)
    }
  })

  function readConfig() {
    const mode = readField(config.mode, 'wait') === 'rotate' ? 'rotate' : 'wait'
    const credentialRef = String(readField(config.credentialRef, 'DEEPSEEK_API_KEY') || '').trim()
    return {
      mode,
      waitSeconds: readNumber(config.waitSeconds, 60, 1, 86400),
      useRetryAfter: readBoolean(config.useRetryAfter, true),
      maxWaitSeconds: readNumber(config.maxWaitSeconds, 900, 1, 86400),
      maxAttempts: readNumber(config.maxAttempts, 12, 1, 100),
      minWaitSeconds: readNumber(config.minWaitSeconds, 1, 0, 60),
      jitter: readBoolean(config.jitter, true),
      waitOnQuota: readBoolean(config.waitOnQuota, false),
      quotaCooldownMinutes: readNumber(config.quotaCooldownMinutes, 60, 1, 7 * 24 * 60),
      credentialRef: isValidRef(credentialRef) ? credentialRef : 'DEEPSEEK_API_KEY',
      alternateKeyRefs: readStrings(config.alternateKeyRefs).filter(isValidRef),
      providerRefs: readStrings(config.providerRefs),
      keepOriginalKey: readBoolean(config.keepOriginalKey, true),
      fallbackToWait: readBoolean(config.fallbackToWait, true),
      guardedProviders: readStrings(config.guardedProviders),
    }
  }

  /** The reference rotation writes for `provider`; undefined when that provider has no key to rotate. */
  function resolveRef(provider, cfg) {
    return refForProvider(provider, cfg.providerRefs, cfg.credentialRef)
  }

  /**
   * Remember that `fp` was just written into `ref`. The step that caused it must not get the
   * "in-flight request" grace retry. `at` anchors the window in which an auth failure is blamed on the
   * rotation; replacing a rejected key inherits it (and counts up `rejects`) so the window never renews.
   */
  function noteRotation(ref, fp, provider, state, inherit) {
    const id = randomUUID()
    const now = Date.now()
    lastRotation.set(ref, { id, at: inherit?.at ?? now, setAt: now, toFp: fp, provider, rejects: inherit?.rejects ?? 0 })
    if (state) state.graceFor = id
  }

  function formatEntry(entry) {
    const parts = ['rate-limit-guard', entry.action]
    if (entry.at) parts.push(`at=${shortTime(entry.at)}`)
    if (entry.provider) parts.push(`provider=${entry.provider}`)
    if (entry.code) parts.push(`code=${entry.code}`)
    if (entry.mode) parts.push(`mode=${entry.mode}`)
    if (typeof entry.retry === 'number') parts.push(`retry=${entry.retry}`)
    if (typeof entry.delayMs === 'number') parts.push(`delay=${Math.round(entry.delayMs / 1000)}s`)
    if (entry.keyRef) parts.push(`key=${entry.keyRef}`)
    if (entry.resumeAt) parts.push(`resumeAt=${shortTime(entry.resumeAt)}`)
    if (entry.note) parts.push(entry.note)
    return parts.join(' ')
  }

  function record(level, fields) {
    const entry = { at: new Date().toISOString(), level, ...fields }
    logs.push(entry)
    if (logs.length > LOG_LIMIT) logs.splice(0, logs.length - LOG_LIMIT)
    const line = formatEntry(entry)
    try {
      if (level === 'warn') ctx.logger?.warn?.(line)
      else if (level === 'error') ctx.logger?.error?.(line)
      else ctx.logger?.info?.(line)
    } catch {
      /* logging must never break the request path */
    }
    return entry
  }

  function describeEntry(entry) {
    const label = ACTION_LABELS[entry.action] ?? entry.action
    const bits = []
    if (entry.provider) bits.push(entry.provider)
    if (entry.code) bits.push(entry.code)
    if (typeof entry.retry === 'number') bits.push(`第 ${entry.retry} 次`)
    if (typeof entry.delayMs === 'number') bits.push(`等待 ${Math.round(entry.delayMs / 1000)}s`)
    if (entry.resumeAt) bits.push(`预计 ${shortTime(entry.resumeAt)} 恢复`)
    if (entry.keyRef) bits.push(`写入 ${entry.keyRef}`)
    if (entry.note) bits.push(entry.note)
    return `${label}${bits.length ? ` · ${bits.join(' · ')}` : ''}`
  }

  function renderLog() {
    const cfg = readConfig()
    const modeText = cfg.mode === 'rotate'
      ? `轮换密钥（目标 ${cfg.credentialRef}${cfg.alternateKeyRefs.length ? `，${cfg.alternateKeyRefs.length} 个备用引用` : '，未配置备用引用'}${cfg.keepOriginalKey ? `，原密钥备份在 ${backupRefFor(cfg.credentialRef)}` : ''}）`
      : `等待（默认 ${cfg.waitSeconds}s，上限 ${cfg.maxWaitSeconds}s）`
    const lines = [`限流守护 · 当前模式：${modeText}`]
    const now = Date.now()
    const cooling = [...cooldowns.values()].filter((until) => until > now).length
    if (cooling > 0) lines.push(`冷却中的密钥：${cooling} 个`)
    if (logs.length === 0) {
      lines.push('尚未记录到限流事件。')
      return lines.join('\n')
    }
    lines.push(`最近事件（${Math.min(logs.length, 20)}/${logs.length} 条）：`)
    for (const entry of logs.slice(-20)) {
      lines.push(`  ${shortTime(entry.at)}  ${describeEntry(entry)}`)
    }
    lines.push('提示：对话中每次等待也会显示一条带倒计时的重试行。')
    return lines.join('\n')
  }

  function prune() {
    const now = Date.now()
    for (const [fp, until] of cooldowns) if (until <= now) cooldowns.delete(fp)
    if (attempts.size <= STATE_LIMIT) return
    const cutoff = now - STATE_TTL_MS
    for (const [key, entry] of attempts) {
      if (entry.startedAt < cutoff) attempts.delete(key)
    }
    // Even when every entry is fresh, keep the map bounded: Map preserves
    // insertion order, so the oldest steps are the first ones dropped.
    while (attempts.size > STATE_LIMIT) {
      const oldest = attempts.keys().next()
      if (oldest.done) break
      attempts.delete(oldest.value)
    }
  }

  function appendScheduled(agent, data) {
    try {
      agent.session.append('llm/retry', data)
    } catch (error) {
      ctx.logger?.debug?.(`rate-limit-guard: llm/retry append skipped: ${messageOf(error)}`)
    }
  }

  function appendStarted(agent, data) {
    try {
      agent.session.append('llm/retry-started', data)
    } catch (error) {
      ctx.logger?.debug?.(`rate-limit-guard: llm/retry-started append skipped: ${messageOf(error)}`)
    }
  }

  /** Run `task` after every earlier rotation of the same ref has finished. */
  function withLock(ref, task) {
    const previous = locks.get(ref) ?? Promise.resolve()
    const run = previous.then(task, task)
    const tail = run.then(() => undefined, () => undefined)
    locks.set(ref, tail)
    tail.then(() => {
      if (locks.get(ref) === tail) locks.delete(ref)
    })
    return run
  }

  async function resolveValue(ref) {
    try {
      const value = (await credentials.resolve(ref))?.value
      return typeof value === 'string' && value.length > 0 ? value : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Read the target reference, keeping "could not read" apart from "empty": overwriting a key we failed
   * to read would lose it without a backup.
   */
  async function readTarget(ref) {
    try {
      const value = (await credentials.resolve(ref))?.value
      return { ok: true, value: typeof value === 'string' && value.length > 0 ? value : undefined }
    } catch (error) {
      return { ok: false, error }
    }
  }

  /** Pool in rotation order: the backed-up keys first, then the configured alternates. */
  async function loadPool(cfg, ref) {
    const refs = []
    if (cfg.keepOriginalKey) refs.push(backupRefFor(ref), previousRefFor(ref))
    for (const alt of cfg.alternateKeyRefs) if (alt !== ref && !refs.includes(alt)) refs.push(alt)
    const pool = []
    for (const poolRef of refs) {
      const value = await resolveValue(poolRef)
      if (value === undefined) continue
      const fp = fingerprint(value)
      if (pool.some((entry) => entry.fp === fp)) continue
      pool.push({ ref: poolRef, fp, value })
    }
    return pool
  }

  /**
   * Rotate `ref` away from the key that just failed. Serialized per ref.
   * Result: { ok: true, keyRef, target } | { ok: true, raced: true } |
   *         { ok: false, reason, readyAt? }  (readyAt: when the earliest key comes off cooldown)
   */
  function rotate(cfg, ref, state, cooldownMs, provider) {
    return withLock(ref, async () => {
      if (lifetime.signal.aborted) return { ok: false, reason: '插件已卸载' }
      const now = Date.now()
      const target = await readTarget(ref)
      if (!target.ok) return { ok: false, reason: `无法读取 ${ref}: ${messageOf(target.error)}` }
      const current = target.value
      const currentFp = current === undefined ? undefined : fingerprint(current)

      const last = lastRotation.get(ref)
      if (last && now - last.setAt < ROTATE_GRACE_MS && last.toFp === currentFp && state.graceFor !== last.id) {
        state.graceFor = last.id
        return { ok: true, raced: true }
      }

      if (currentFp) cooldowns.set(currentFp, Math.max(cooldowns.get(currentFp) ?? 0, now + cooldownMs))

      let pool = await loadPool(cfg, ref)
      const backupRef = backupRefFor(ref)
      const previousRef = previousRefFor(ref)
      const hasAlternates = pool.some((entry) => entry.ref !== backupRef && entry.ref !== previousRef)
      if (cfg.keepOriginalKey && hasAlternates && current !== undefined && !pool.some((entry) => entry.fp === currentFp)) {
        // The key in use is not in the pool (the user's own key): keep a copy before overwriting it,
        // so it rejoins the rotation once its window refreshes. The first such key goes to the
        // ORIGINAL slot and is never overwritten; a later one goes to the PREVIOUS slot.
        const slot = pool.some((entry) => entry.ref === backupRef) ? previousRef : backupRef
        try {
          await credentials.set(slot, current)
        } catch (error) {
          return { ok: false, reason: `无法备份原密钥到 ${slot}: ${messageOf(error)}` }
        }
        const saved = { ref: slot, fp: currentFp, value: current }
        const rest = pool.filter((entry) => entry.ref !== slot)
        const head = rest.filter((entry) => entry.ref === backupRef)
        pool = [...head, saved, ...rest.filter((entry) => entry.ref !== backupRef)]
        record('info', { action: 'original-saved', keyRef: slot, note: `轮换前把 ${ref} 的原值保存到 ${slot}` })
      }

      const choice = pickNext(pool, currentFp, cooldowns, now)
      if (!choice.pick) {
        if (choice.readyAt === undefined) return { ok: false, reason: '未配置可用的备用密钥' }
        return { ok: false, reason: '密钥池中的密钥都在冷却中', readyAt: choice.readyAt }
      }
      try {
        await credentials.set(ref, choice.pick.value)
      } catch (error) {
        return { ok: false, reason: `无法写入 ${ref}: ${messageOf(error)}` }
      }
      noteRotation(ref, choice.pick.fp, provider, state)
      return { ok: true, keyRef: choice.pick.ref, target: ref }
    })
  }

  /**
   * The key a rotation just installed in `ref` was rejected by the provider (revoked or mistyped pool
   * entry). Left in place it would fail every later request, so bench it and install another pool key.
   * Result: { handled: false } when the key in `ref` is not a pool key, otherwise
   *         { handled: true, rejectedRef, keyRef?, ready? }.
   */
  function replaceRejected(cfg, ref, state, provider) {
    return withLock(ref, async () => {
      if (lifetime.signal.aborted) return { handled: false }
      const now = Date.now()
      // Re-check under the lock: only the key that this provider's rotation installed moments ago is
      // the guard's to blame, and only a limited number of times per rotation.
      const last = lastRotation.get(ref)
      if (!last || last.provider !== provider || now - last.at > REJECT_WINDOW_MS) return { handled: false }
      const target = await readTarget(ref)
      if (!target.ok || target.value === undefined) return { handled: false }
      const currentFp = fingerprint(target.value)
      if (last.toFp !== currentFp) return { handled: false }
      // Another request already replaced the rejected key; this failure most likely still used the old
      // one. Retry once on the replacement instead of benching a key nobody has tried yet.
      if (last.rejects > 0 && now - last.setAt < ROTATE_GRACE_MS && state.graceFor !== last.id) {
        state.graceFor = last.id
        return { handled: true, raced: true }
      }
      if (last.rejects >= MAX_REJECTS_PER_ROTATION) return { handled: false }
      const pool = await loadPool(cfg, ref)
      const rejected = pool.find((entry) => entry.fp === currentFp)
      if (!rejected) return { handled: false }
      cooldowns.set(currentFp, now + REJECTED_KEY_COOLDOWN_MS)
      const choice = pickNext(pool, currentFp, cooldowns, now)
      // Nothing ready: still swap in the key that comes back first, so the rejected one is not left behind.
      const pick = choice.pick ?? pool
        .filter((entry) => entry.fp !== currentFp)
        .sort((a, b) => (cooldowns.get(a.fp) ?? 0) - (cooldowns.get(b.fp) ?? 0))[0]
      if (!pick) return { handled: true, rejectedRef: rejected.ref }
      try {
        await credentials.set(ref, pick.value)
      } catch {
        return { handled: true, rejectedRef: rejected.ref }
      }
      const ready = choice.pick !== undefined
      // A key that is still cooling is only parked here; it was not tried, so it earns no grace/blame.
      if (ready) noteRotation(ref, pick.fp, provider, state, { at: last.at, rejects: last.rejects + 1 })
      else lastRotation.delete(ref)
      return { handled: true, rejectedRef: rejected.ref, keyRef: pick.ref, ready }
    })
  }

  /** After waiting out a full pool, put the first key that is off cooldown back into `ref`. */
  function restoreReady(cfg, ref, state, provider) {
    return withLock(ref, async () => {
      if (lifetime.signal.aborted) return undefined
      // Timers may fire a millisecond before Date.now() reaches the cooldown end; allow for that.
      const now = Date.now() + CLOCK_SLOP_MS
      const target = await readTarget(ref)
      if (!target.ok) return undefined
      const current = target.value
      const currentFp = current === undefined ? undefined : fingerprint(current)
      if (currentFp && (cooldowns.get(currentFp) ?? 0) <= now) return undefined
      const pool = await loadPool(cfg, ref)
      const choice = pickNext(pool, currentFp, cooldowns, now)
      if (!choice.pick) return undefined
      try {
        await credentials.set(ref, choice.pick.value)
        noteRotation(ref, choice.pick.fp, provider, state)
        return choice.pick.ref
      } catch {
        return undefined
      }
    })
  }

  async function waitAndRetry({ agent, turn, step, provider, failure, signal }, base, delayMs, note, after) {
    const resumeAt = new Date(Date.now() + delayMs).toISOString()
    appendScheduled(agent, { ...base, delayMs })
    record('info', {
      action: 'waiting',
      provider,
      code: failure.code,
      mode: 'wait',
      retry: base.retry,
      delayMs,
      resumeAt,
      note,
    })

    const completed = await wait(delayMs, fuseSignals(signal, lifetime.signal))
    if (!completed) {
      record('warn', {
        action: 'aborted',
        provider,
        retry: base.retry,
        note: '等待被取消（会话中止或插件卸载）',
      })
      // `undefined` is DSH's "do not retry" action.
      return undefined
    }
    if (after) await after()

    appendStarted(agent, { retryId: base.retryId, turn, step, retry: base.retry })
    record('info', {
      action: 'resumed',
      provider,
      retry: base.retry,
      delayMs,
      note: '限额窗口已刷新，自动继续',
    })
    return { kind: 'retry' }
  }

  /**
   * Count one guarded attempt for this step. Returns undefined once the per-step cap is reached
   * (the caller then hands the failure back), otherwise the step state and the retry event base.
   */
  function beginAttempt({ agent, turn, step, provider, failure }, cfg) {
    prune()
    const stateKey = `${agent?.session?.id ?? 'unknown'}:${turn}:${step}`
    let state = attempts.get(stateKey)
    if (!state) {
      state = { count: 0, retryId: randomUUID(), startedAt: Date.now(), exhausted: false }
      attempts.set(stateKey, state)
    }
    if (state.count >= cfg.maxAttempts) {
      if (!state.exhausted) {
        state.exhausted = true
        record('warn', {
          action: 'exhausted',
          provider,
          code: failure.code,
          retry: state.count,
          note: `本步骤已达到 ${cfg.maxAttempts} 次上限，交回后续处理器`,
        })
      }
      return undefined
    }
    state.count += 1
    const base = {
      retryId: state.retryId,
      turn,
      step,
      provider,
      mode: 'normal',
      policyKey: 'rate-limit-guard',
      retry: state.count,
      maxRetries: cfg.maxAttempts,
      failure: normalizeFailure(failure),
    }
    return { state, retry: state.count, base }
  }

  /** Auth failure right after a rotation: the key the guard just installed is bad. */
  async function handleRejectedKey(payload, next) {
    const { agent, turn, step, provider, failure, signal } = payload
    if (lifetime.signal.aborted || signal?.aborted || !credentials) return next()
    const cfg = readConfig()
    if (cfg.mode !== 'rotate') return next()
    if (cfg.guardedProviders.length > 0 && !cfg.guardedProviders.includes(provider)) return next()
    const ref = resolveRef(provider, cfg)
    if (!ref) return next()
    // Only blame the key when this provider's own rotation installed it moments ago; any other auth
    // failure (a different provider, the user's own key) is not the guard's to fix.
    const last = lastRotation.get(ref)
    if (!last || last.provider !== provider || Date.now() - last.at > REJECT_WINDOW_MS) return next()

    const attempt = beginAttempt(payload, cfg)
    if (!attempt) return next()
    const outcome = await replaceRejected(cfg, ref, attempt.state, provider)
    if (!outcome.handled) return next()
    if (outcome.raced) {
      record('info', { action: 'rotate-raced', provider, retry: attempt.retry, note: '被拒绝的密钥已被换掉，直接用新密钥重试' })
      appendScheduled(agent, { ...attempt.base, delayMs: 0 })
      appendStarted(agent, { retryId: attempt.base.retryId, turn, step, retry: attempt.retry })
      return { kind: 'retry' }
    }
    const usable = outcome.keyRef !== undefined && outcome.ready
    record('warn', {
      action: 'key-rejected',
      provider,
      code: failure.code,
      retry: attempt.retry,
      note: `${outcome.rejectedRef} 的密钥被服务端拒绝，已暂停使用；${
        outcome.keyRef === undefined ? '没有其他密钥可换' : usable ? `改用 ${outcome.keyRef} 重试` : `已换回 ${outcome.keyRef}（仍在冷却），交回后续处理器`}`,
    })
    if (!usable) return next()
    appendScheduled(agent, { ...attempt.base, delayMs: 0 })
    appendStarted(agent, { retryId: attempt.base.retryId, turn, step, retry: attempt.retry })
    return { kind: 'retry' }
  }

  async function handle(payload, next) {
    const { agent, turn, step, provider, failure, signal } = payload ?? {}
    if (!failure) return next()
    if (!isRateLimitFailure(failure)) return isAuthFailure(failure) ? handleRejectedKey(payload, next) : next()
    if (lifetime.signal.aborted || signal?.aborted) return next()

    const cfg = readConfig()
    if (cfg.guardedProviders.length > 0 && !cfg.guardedProviders.includes(provider)) return next()

    const quota = isQuotaFailure(failure)
    // Waiting does not refill a balance; only a different key can help.
    if (quota && cfg.mode === 'wait' && !cfg.waitOnQuota) {
      record('warn', {
        action: 'quota-handoff',
        provider,
        code: failure.code,
        note: '额度/余额已耗尽，等待不会恢复，交回默认处理',
      })
      return next()
    }

    const attempt = beginAttempt(payload, cfg)
    if (!attempt) return next()
    const { state, retry, base } = attempt

    record('info', {
      action: 'detected',
      provider,
      code: failure.code,
      retry,
      note: failure.message ? truncate(failure.message, 140) : undefined,
    })

    const { delayMs, source } = computeDelay(failure, cfg)
    const delayNote = source === 'retry-after'
      ? '使用服务端建议的等待时长'
      : source === 'message-hint'
        ? '从错误信息中解析出等待时长'
        : undefined
    const fallback = quota && !cfg.waitOnQuota ? false : cfg.fallbackToWait

    if (cfg.mode === 'rotate') {
      const ref = resolveRef(provider, cfg)
      if (!credentials || !ref) {
        record('warn', {
          action: 'rotate-unavailable',
          provider,
          retry,
          note: `${credentials ? `提供方 ${provider} 没有可轮换的密钥` : 'credentials 服务不可用'}${fallback ? '，回退为等待' : '，交回后续处理器'}`,
        })
        if (!fallback) return next()
      } else {
        const cooldownMs = quota ? cfg.quotaCooldownMinutes * 60_000 : delayMs
        const outcome = await rotate(cfg, ref, state, cooldownMs, provider)
        if (outcome.ok) {
          appendScheduled(agent, { ...base, delayMs: 0 })
          appendStarted(agent, { retryId: base.retryId, turn, step, retry })
          record('info', outcome.raced
            ? { action: 'rotate-raced', provider, retry, note: '失败请求很可能还在用旧密钥，直接用新密钥重试' }
            : { action: 'rotated', provider, retry, keyRef: outcome.target, note: `使用 ${outcome.keyRef} 的值立即重试` })
          return { kind: 'retry' }
        }
        record('warn', {
          action: 'rotate-unavailable',
          provider,
          retry,
          note: `${outcome.reason}${fallback ? '，回退为等待' : '，交回后续处理器'}`,
        })
        if (!fallback) return next()
        if (outcome.readyAt !== undefined) {
          // Every key is cooling: wait for the first one to come back instead of hammering the pool.
          const untilReady = Math.max(0, Math.min(outcome.readyAt - Date.now(), cfg.maxWaitSeconds * 1000))
          return waitAndRetry(payload, base, Math.round(untilReady), '等待最早恢复的密钥', async () => {
            const restored = await restoreReady(cfg, ref, state, provider)
            if (restored) record('info', { action: 'rotated', provider, retry, keyRef: ref, note: `等待后改用 ${restored}` })
          })
        }
      }
    }

    return waitAndRetry(payload, base, delayMs, delayNote)
  }

  ctx.effect(() => {
    const off = ctx.on(
      'agent/request-error',
      async (payload, next) => {
        try {
          return await handle(payload, next)
        } catch (error) {
          ctx.logger?.warn?.(`rate-limit-guard: handler failed, deferring: ${messageOf(error)}`)
          return next()
        }
      },
      { prepend: true },
    )
    return () => {
      off()
      lifetime.abort()
      attempts.clear()
      cooldowns.clear()
      lastRotation.clear()
    }
  }, 'rate-limit-guard: request-error listener')

  ctx.inject(['commands'], (sub) => {
    sub.commands.register({
      name: 'ratelimit-log',
      description: '查看限流守护最近的等待与轮换记录',
      handler: () => ({ kind: 'success', text: renderLog() }),
    })
  })
}

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
  declaredKeyRef,
  fingerprint,
  hasMapping,
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
const REJECTED_KEY_COOLDOWN_MS = 60 * 60 * 1000
/**
 * At most this many pool keys of one reference are benched as "rejected" within the window below.
 * An auth failure that follows every key around is not about the keys, and must not bench the pool.
 */
const MAX_REJECTS_PER_WINDOW = 2
const REJECT_LIMIT_WINDOW_MS = 10 * 60 * 1000
/** Consecutive automatic "continue" prompts per session before the guard stops and asks for a human. */
const MAX_AUTO_CONTINUES = 20
/** A gap longer than this between two truncations resets the consecutive counter. */
const AUTO_CONTINUE_RESET_MS = 30 * 60 * 1000

export const Config = z.object({
  mode: z.union(['wait', 'rotate']).default('wait').volatile(),
  waitSeconds: z.number().default(60).volatile(),
  useRetryAfter: z.boolean().default(true).volatile(),
  maxWaitSeconds: z.number().default(900).volatile(),
  maxAttempts: z.number().default(12).volatile(),
  minWaitSeconds: z.number().default(1).volatile(),
  maxTotalWaitMinutes: z.number().default(60).volatile(),
  language: z.union(['auto', 'zh', 'en']).default('auto').volatile(),
  jitter: z.boolean().default(true).volatile(),
  waitOnQuota: z.boolean().default(false).volatile(),
  quotaCooldownMinutes: z.number().default(60).volatile(),
  credentialRef: z.string().default('DEEPSEEK_API_KEY').volatile(),
  alternateKeyRefs: z.array(z.string()).default([]).volatile(),
  providerRefs: z.array(z.string()).default([]).volatile(),
  keepOriginalKey: z.boolean().default(true).volatile(),
  fallbackToWait: z.boolean().default(true).volatile(),
  guardedProviders: z.array(z.string()).default([]).volatile(),
  unattended: z.boolean().default(false).volatile(),
  continueText: z.string().default('继续').volatile(),
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

/** The text an unattended turn sends after the model hits its output cap. */
function readContinueText(value) {
  const text = String(readField(value, '继续')).trim()
  return text === '' ? '继续' : text.slice(0, 200)
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

/** Like shortTime, but with the date when the moment is not today (a key benched until tomorrow). */
function untilTime(ms) {
  const date = new Date(ms)
  const time = shortTime(date.toISOString())
  if (date.toDateString() === new Date().toDateString()) return time
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`
}

const ACTION_LABELS = {
  zh: {
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
    exhausted: '达到上限',
    'auto-continue': '自动继续',
    'auto-continue-capped': '连续自动继续已停止',
  },
  en: {
    detected: 'Rate limit detected',
    waiting: 'Waiting',
    resumed: 'Resumed',
    aborted: 'Wait cancelled',
    rotated: 'Key rotated',
    'rotate-raced': 'Just rotated, retrying',
    'rotate-unavailable': 'Cannot rotate',
    'key-rejected': 'Key rejected',
    'original-saved': 'Original key backed up',
    'quota-handoff': 'Quota exhausted, handed back',
    exhausted: 'Limit reached',
    'auto-continue': 'Auto-continued',
    'auto-continue-capped': 'Auto-continue stopped',
  },
}

/** Language for log notes and /ratelimit-log when the setting is "auto": follow the process locale. */
function systemLanguage() {
  try {
    return /^zh\b/i.test(Intl.DateTimeFormat().resolvedOptions().locale) ? 'zh' : 'en'
  } catch {
    return 'en'
  }
}

export function apply(ctx, config = {}) {
  const attempts = new Map()
  /** session id -> { count, lastAt, capped } of consecutive auto-continues after a truncation */
  const autoContinues = new Map()
  const logs = []
  const lifetime = new AbortController()
  /** fingerprint -> epoch ms until which that key is known to be limited / exhausted */
  const cooldowns = new Map()
  /** target ref -> { id, at, setAt, toFp, provider, rejects } of the latest rotation */
  const lastRotation = new Map()
  /** fingerprints of keys benched because the provider rejected them (subset of `cooldowns`) */
  const rejectedFps = new Set()
  /** target ref -> timestamps of recent benches, for MAX_REJECTS_PER_WINDOW */
  const rejectTimes = new Map()
  /** target ref -> tail of the promise chain that serializes rotations of that ref */
  const locks = new Map()
  let credentials
  let llm
  let settings

  /** Pick the Chinese or English text for log notes and the /ratelimit-log report. */
  function language() {
    const value = readField(config.language, 'auto')
    return value === 'zh' || value === 'en' ? value : systemLanguage()
  }
  const L = (zh, en) => (language() === 'en' ? en : zh)

  ctx.inject(['credentials'], (sub) => {
    credentials = sub.credentials
    sub.effect(() => () => {
      credentials = undefined
    }, 'rate-limit-guard: credentials handle')
  })

  // The official provider directory, the same source the desktop model settings page reads. A
  // provider that the operator did not map by hand rotates the reference its own profile declares.
  ctx.inject(['llm'], (sub) => {
    llm = sub.llm
    sub.effect(() => () => {
      llm = undefined
    }, 'rate-limit-guard: llm handle')
  })

  // The plugin ships its own settings page, so hide the auto-generated one.
  ctx.inject(['settings'], (sub) => {
    settings = sub.settings
    try {
      sub.settings.configure({ auto: false }, ctx.fiber)
    } catch (error) {
      ctx.logger?.warn?.(`rate-limit-guard: settings.configure failed: ${messageOf(error)}`)
    }
  })

  function readConfig() {
    const mode = readField(config.mode, 'wait') === 'rotate' ? 'rotate' : 'wait'
    const credentialRef = String(readField(config.credentialRef, 'DEEPSEEK_API_KEY') || '').trim()
    const targetRef = isValidRef(credentialRef) ? credentialRef : 'DEEPSEEK_API_KEY'
    // The rotation target can never sit in its own pool: the desktop picker writes every ticked
    // reference straight into this list, so dropping it here keeps a stale file harmless.
    const alternateKeyRefs = [...new Set(readStrings(config.alternateKeyRefs).filter(isValidRef))]
      .filter((ref) => ref !== targetRef)
    return {
      mode,
      waitSeconds: readNumber(config.waitSeconds, 60, 1, 86400),
      useRetryAfter: readBoolean(config.useRetryAfter, true),
      maxWaitSeconds: readNumber(config.maxWaitSeconds, 900, 1, 86400),
      maxAttempts: readNumber(config.maxAttempts, 12, 1, 100),
      minWaitSeconds: readNumber(config.minWaitSeconds, 1, 0, 60),
      maxTotalWaitMinutes: readNumber(config.maxTotalWaitMinutes, 60, 0, 7 * 24 * 60),
      jitter: readBoolean(config.jitter, true),
      waitOnQuota: readBoolean(config.waitOnQuota, false),
      quotaCooldownMinutes: readNumber(config.quotaCooldownMinutes, 60, 1, 7 * 24 * 60),
      credentialRef: targetRef,
      alternateKeyRefs,
      providerRefs: readStrings(config.providerRefs),
      keepOriginalKey: readBoolean(config.keepOriginalKey, true),
      fallbackToWait: readBoolean(config.fallbackToWait, true),
      guardedProviders: readStrings(config.guardedProviders),
      unattended: readBoolean(config.unattended, false),
      continueText: readContinueText(config.continueText),
    }
  }

  /** How long a provider-to-reference snapshot from the directory stays usable. */
  const DIRECTORY_TTL_MS = 30_000
  /** provider -> reference declared by its profile, refreshed on demand. */
  let directoryRefs
  let directoryAt = 0

  /** Read `path` from `value`, tolerating missing links. */
  function getPath(value, path) {
    let node = value
    for (const key of path) {
      if (node === null || typeof node !== 'object') return undefined
      node = node[key]
    }
    return node
  }

  /**
   * Refresh the map from provider ids to the references their profiles declare. Both inputs come from
   * official services: the LLM directory names each provider profile, and the settings forms carry
   * the profile values, so `apiKeyEnv` here is exactly the reference that provider resolves.
   */
  function loadDirectory() {
    const now = Date.now()
    if (directoryRefs !== undefined && now - directoryAt <= DIRECTORY_TTL_MS) return directoryRefs
    directoryAt = now
    directoryRefs = new Map()
    try {
      const entries = typeof llm?.listConfigurableProviders === 'function' ? llm.listConfigurableProviders() : []
      const views = typeof settings?.describe === 'function' ? settings.describe({ redactSecrets: true }) : []
      const namespaces = new Map((views ?? []).map((view) => [view.ns, view]))
      for (const entry of entries ?? []) {
        if (!entry || typeof entry.provider !== 'string') continue
        const profile = getPath(namespaces.get(entry.settingsNs)?.value, entry.settingsPath ?? [])
        const ref = declaredKeyRef(profile)
        if (ref) directoryRefs.set(entry.provider, ref)
      }
    } catch (error) {
      ctx.logger?.warn?.(`rate-limit-guard: provider directory unavailable: ${messageOf(error)}`)
    }
    return directoryRefs
  }

  /** The reference rotation writes for `provider`; undefined when that provider has no key to rotate. */
  async function resolveRef(provider, cfg) {
    if (!hasMapping(provider, cfg.providerRefs)) {
      const discovered = loadDirectory().get(provider)
      if (discovered) return discovered
    }
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
    const label = ACTION_LABELS[language()][entry.action] ?? entry.action
    const bits = []
    if (entry.provider) bits.push(entry.provider)
    if (entry.code) bits.push(entry.code)
    if (typeof entry.retry === 'number') bits.push(L(`第 ${entry.retry} 次`, `attempt ${entry.retry}`))
    if (typeof entry.delayMs === 'number') bits.push(L(`等待 ${Math.round(entry.delayMs / 1000)}s`, `wait ${Math.round(entry.delayMs / 1000)}s`))
    if (entry.resumeAt) bits.push(L(`预计 ${shortTime(entry.resumeAt)} 恢复`, `resumes at ${shortTime(entry.resumeAt)}`))
    if (entry.keyRef) bits.push(L(`写入 ${entry.keyRef}`, `wrote ${entry.keyRef}`))
    if (entry.note) bits.push(entry.note)
    return `${label}${bits.length ? ` · ${bits.join(' · ')}` : ''}`
  }

  /** Target references rotation can write: the default one, every mapped one, and each provider's own. */
  async function targetRefs(cfg) {
    const refs = [cfg.credentialRef]
    const include = (ref) => {
      if (isValidRef(ref) && !refs.includes(ref)) refs.push(ref)
    }
    for (const item of cfg.providerRefs) {
      const separator = item.indexOf('=')
      if (separator <= 0) continue
      include(item.slice(separator + 1).trim())
    }
    for (const ref of loadDirectory().values()) include(ref)
    return refs
  }

  /** Which pool key each target currently holds and which keys are cooling. Names and times only, never values. */
  async function keyStatusLines(cfg) {
    const lines = []
    if (!credentials) return [L('凭据服务不可用，无法轮换。', 'The credentials service is unavailable; rotation is off.')]
    const now = Date.now()
    for (const ref of await targetRefs(cfg)) {
      const target = await readTarget(ref)
      const pool = await loadPool(cfg, ref)
      const currentFp = target.ok && target.value !== undefined ? fingerprint(target.value) : undefined
      const holder = pool.find((entry) => entry.fp === currentFp)
      const current = !target.ok
        ? L('读取失败', 'unreadable')
        : currentFp === undefined
          ? L('未配置', 'not configured')
          : holder ? holder.ref : L('池外的密钥', 'a key outside the pool')
      lines.push(L(`  ${ref} 当前使用：${current}`, `  ${ref} currently holds: ${current}`))
      for (const entry of pool) {
        const until = cooldowns.get(entry.fp) ?? 0
        const state = until <= now
          ? L('可用', 'ready')
          : rejectedFps.has(entry.fp)
            ? L(`被服务端拒绝，暂停到 ${untilTime(until)}`, `rejected by the provider, benched until ${untilTime(until)}`)
            : L(`冷却到 ${untilTime(until)}`, `cooling until ${untilTime(until)}`)
        lines.push(`    ${entry.ref}: ${state}`)
      }
      for (const slot of pool.unreadable) lines.push(`    ${slot}: ${L('读取失败', 'unreadable')}`)
      for (const slot of pool.ignored) lines.push(L(`    ${slot}: 已忽略（该引用属于其他提供方，只能手动填写非提供方引用作为轮换槽）`, `    ${slot}: ignored (this reference belongs to another provider; only manual non-provider references can be storage slots)`))
      if (pool.length === 0) lines.push(L('    （密钥池为空）', '    (the pool is empty)'))
    }
    return lines
  }

  async function renderLog() {
    const cfg = readConfig()
    const modeText = cfg.mode === 'rotate'
      ? L(
        `轮换密钥（目标 ${cfg.credentialRef}，轮换池 ${cfg.alternateKeyRefs.length} 个引用）`,
        `rotate key (target ${cfg.credentialRef}, ${cfg.alternateKeyRefs.length} reference(s) in the pool)`,
      )
      : L(
        `等待（默认 ${cfg.waitSeconds}s，单次上限 ${cfg.maxWaitSeconds}s）`,
        `wait (default ${cfg.waitSeconds}s, at most ${cfg.maxWaitSeconds}s each)`,
      )
    const lines = [L(`限流守护 · 当前模式：${modeText}`, `Rate limit guard · mode: ${modeText}`)]
    lines.push(cfg.unattended
      ? L(`无人值守：开启（输出被截断时自动发送“${truncate(cfg.continueText, 20)}”）`, `Unattended: on (sends "${truncate(cfg.continueText, 20)}" when output is cut off)`)
      : L('无人值守：关闭（输出被截断时由对话中的提示条提示手动继续）', 'Unattended: off (a prompt above the composer asks you to continue)'))
    if (cfg.mode === 'rotate') {
      lines.push(L('密钥状态：', 'Key status:'))
      try {
        lines.push(...await keyStatusLines(cfg))
      } catch (error) {
        lines.push(L(`  无法读取密钥状态：${messageOf(error)}`, `  could not read key status: ${messageOf(error)}`))
      }
    }
    if (logs.length === 0) {
      lines.push(L('尚未记录到限流事件。', 'No rate limit events recorded yet.'))
      return lines.join('\n')
    }
    lines.push(L(
      `最近事件（${Math.min(logs.length, 20)}/${logs.length} 条）：`,
      `Recent events (${Math.min(logs.length, 20)} of ${logs.length}):`,
    ))
    for (const entry of logs.slice(-20)) {
      lines.push(`  ${shortTime(entry.at)}  ${describeEntry(entry)}`)
    }
    lines.push(L('提示：对话中每次等待也会显示一条带倒计时的重试行。', 'Tip: each wait also shows a countdown row in the conversation.'))
    return lines.join('\n')
  }

  function prune() {
    const now = Date.now()
    for (const [fp, until] of cooldowns) {
      if (until > now) continue
      cooldowns.delete(fp)
      rejectedFps.delete(fp)
    }
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
  function withLock(_ref, task) {
    // One chain for every target: targets can share pool keys, so two rotations must never interleave.
    const key = '*'
    const previous = locks.get(key) ?? Promise.resolve()
    const run = previous.then(task, task)
    const tail = run.then(() => undefined, () => undefined)
    locks.set(key, tail)
    tail.then(() => {
      if (locks.get(key) === tail) locks.delete(key)
    })
    return run
  }

  /**
   * Write `value` into the target, but only if it still holds the key we read at the start of this
   * rotation. A key typed in meanwhile (settings page, another tool) is never overwritten.
   */
  async function writeTarget(ref, value, expectedFp) {
    const check = await readTarget(ref)
    const fp = check.ok && check.value !== undefined ? fingerprint(check.value) : undefined
    if (!check.ok || fp !== expectedFp) {
      throw new Error(L(`${ref} 在轮换过程中被修改或无法读取`, `${ref} changed or became unreadable during the rotation`))
    }
    await credentials.set(ref, value)
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

  /**
   * Pool in rotation order: the backed-up keys first, then the configured alternates.
   * `pool.unreadable` lists backup slots that could not be read: they may hold a key, so nothing may
   * be written to them (an alternate that cannot be read is simply skipped).
   */
  async function loadPool(cfg, ref) {
    const slots = cfg.keepOriginalKey ? [backupRefFor(ref), previousRefFor(ref)] : []
    const refs = [...slots]
    const targets = await targetRefs(cfg)
    // Every provider owns its own reference: writing another provider's key into it would break that
    // provider, so those entries can never act as storage slots for this target. Keep them visible as
    // `ignored` so the settings pages and /ratelimit-log can explain why a configured entry did nothing.
    const ignored = []
    for (const alt of cfg.alternateKeyRefs) {
      if (targets.includes(alt)) {
        if (!ignored.includes(alt)) ignored.push(alt)
        continue
      }
      if (!refs.includes(alt)) refs.push(alt)
    }
    const pool = []
    pool.unreadable = []
    pool.ignored = ignored
    for (const poolRef of refs) {
      const read = await readTarget(poolRef)
      if (!read.ok) {
        if (slots.includes(poolRef)) pool.unreadable.push(poolRef)
        continue
      }
      if (read.value === undefined) continue
      const fp = fingerprint(read.value)
      if (pool.some((entry) => entry.fp === fp)) continue
      pool.push({ ref: poolRef, fp, value: read.value })
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
      if (lifetime.signal.aborted) return { ok: false, reason: L('插件已卸载', 'the plugin was unloaded') }
      const now = Date.now()
      const target = await readTarget(ref)
      if (!target.ok) return { ok: false, reason: L(`无法读取 ${ref}: ${messageOf(target.error)}`, `cannot read ${ref}: ${messageOf(target.error)}`) }
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
      if (cfg.keepOriginalKey && pool.length > 0 && current !== undefined && !pool.some((entry) => entry.fp === currentFp)) {
        // The key in use is stored nowhere else (the user's own key): keep a copy before overwriting
        // it, so it rejoins the rotation once its window refreshes. A slot that already holds a key
        // is never overwritten: the first such key goes to ORIGINAL, a later one to PREVIOUS, and
        // when neither slot is free (or one cannot be read) the rotation is refused instead.
        if (pool.unreadable.length > 0) {
          return { ok: false, reason: L(`无法读取备份引用 ${pool.unreadable.join('、')}，为避免覆盖其中的密钥，本次不轮换`, `cannot read the backup reference ${pool.unreadable.join(', ')}; not rotating, so the key in it is not overwritten`) }
        }
        const slot = [backupRef, previousRef].find((candidate) => !pool.some((entry) => entry.ref === candidate))
        if (!slot) {
          return { ok: false, reason: L(`${ref} 里是一个未备份的新密钥，而 ${backupRef} 和 ${previousRef} 都已占用；为避免丢失密钥，本次不轮换（请把它加入备用密钥，或清理这两个备份引用）`, `${ref} holds a new key that has no backup, and both ${backupRef} and ${previousRef} are in use; not rotating so no key is lost (add it to the pool, or clear one of the two backup references)`) }
        }
        try {
          await credentials.set(slot, current)
        } catch (error) {
          return { ok: false, reason: L(`无法备份原密钥到 ${slot}: ${messageOf(error)}`, `cannot back up the original key to ${slot}: ${messageOf(error)}`) }
        }
        const saved = { ref: slot, fp: currentFp, value: current }
        const rest = pool.filter((entry) => entry.ref !== slot)
        const head = rest.filter((entry) => entry.ref === backupRef)
        const rebuilt = [...head, saved, ...rest.filter((entry) => entry.ref !== backupRef)]
        rebuilt.unreadable = pool.unreadable
        rebuilt.ignored = pool.ignored
        pool = rebuilt
        record('info', { action: 'original-saved', keyRef: slot, note: L(`轮换前把 ${ref} 的原值保存到 ${slot}`, `saved the value of ${ref} to ${slot} before rotating`) })
      }

      const choice = pickNext(pool, currentFp, cooldowns, now)
      if (!choice.pick) {
        const ignoredNote = pool.ignored.length > 0
          ? L(`；已忽略其他提供方的引用 ${pool.ignored.join('、')}`, `; ignored references owned by other providers: ${pool.ignored.join(', ')}`)
          : ''
        if (choice.readyAt === undefined) return { ok: false, reason: L('未配置可用的备用密钥', 'no usable alternate key is configured') + ignoredNote }
        return { ok: false, reason: L('密钥池中的密钥都在冷却中', 'every key in the pool is cooling down') + ignoredNote, readyAt: choice.readyAt }
      }
      try {
        await writeTarget(ref, choice.pick.value, currentFp)
      } catch (error) {
        return { ok: false, reason: L(`无法写入 ${ref}: ${messageOf(error)}`, `cannot write ${ref}: ${messageOf(error)}`) }
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
      // (No time limit beyond the blame window: a slow request may fail well after the swap.)
      if (last.rejects > 0 && state.graceFor !== last.id) {
        state.graceFor = last.id
        return { handled: true, raced: true }
      }
      const isBackup = (name) => name === backupRefFor(ref) || name === previousRefFor(ref)
      const recent = (rejectTimes.get(ref) ?? []).filter((at) => now - at < REJECT_LIMIT_WINDOW_MS)
      const pool = await loadPool(cfg, ref)
      const rejected = pool.find((entry) => entry.fp === currentFp)
      if (!rejected) return { handled: false }
      if (recent.length >= MAX_REJECTS_PER_WINDOW) {
        // Too many rejections in a row to keep blaming keys. Do not bench this one, but do not leave
        // it installed either: park a key that was not rejected (the user's own, if it is there).
        const park = pool
          .filter((entry) => entry.fp !== currentFp && !rejectedFps.has(entry.fp))
          .sort((a, b) => Number(isBackup(b.ref)) - Number(isBackup(a.ref)) || (cooldowns.get(a.fp) ?? 0) - (cooldowns.get(b.fp) ?? 0))[0]
        lastRotation.delete(ref)
        if (!park) return { handled: false }
        try {
          await writeTarget(ref, park.value, currentFp)
        } catch {
          return { handled: false }
        }
        return { handled: true, limited: true, rejectedRef: rejected.ref, keyRef: park.ref }
      }
      cooldowns.set(currentFp, now + REJECTED_KEY_COOLDOWN_MS)
      rejectedFps.add(currentFp)
      rejectTimes.set(ref, [...recent, now])
      const choice = pickNext(pool, currentFp, cooldowns, now)
      // Nothing ready: still swap in a key so the rejected one is not left behind. Never another
      // rejected key, however soon its bench ends; the user's own key first, then whichever is back first.
      const pick = choice.pick ?? pool
        .filter((entry) => entry.fp !== currentFp && !rejectedFps.has(entry.fp))
        .sort((a, b) => Number(isBackup(b.ref)) - Number(isBackup(a.ref)) || (cooldowns.get(a.fp) ?? 0) - (cooldowns.get(b.fp) ?? 0))[0]
      if (!pick) return { handled: true, rejectedRef: rejected.ref }
      try {
        await writeTarget(ref, pick.value, currentFp)
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

  /**
   * After waiting out a pool cooldown, decide what the next attempt should use:
   * - `{ kind: 'ready' }`: the key already in the target came off cooldown, retry with it;
   * - `{ kind: 'switched', ref }`: a pool key is ready and was written into the target;
   * - `{ kind: 'none' }`: nothing is ready (or the target changed underneath us), do not retry.
   * The old `undefined` result could not tell these apart, so the caller could not avoid retrying a
   * key that was still cooling when the wait was capped by `maxWaitSeconds`.
   */
  function restoreReady(cfg, ref, state, provider) {
    return withLock(ref, async () => {
      if (lifetime.signal.aborted) return { kind: 'none' }
      // Timers may fire a millisecond before Date.now() reaches the cooldown end; allow for that.
      const now = Date.now() + CLOCK_SLOP_MS
      const target = await readTarget(ref)
      if (!target.ok) return { kind: 'none' }
      const current = target.value
      const currentFp = current === undefined ? undefined : fingerprint(current)
      if (currentFp && (cooldowns.get(currentFp) ?? 0) <= now) return { kind: 'ready' }
      const pool = await loadPool(cfg, ref)
      // Only replace a key that is also stored in the pool; anything else would be lost.
      if (currentFp && !pool.some((entry) => entry.fp === currentFp)) return { kind: 'none' }
      const choice = pickNext(pool, currentFp, cooldowns, now)
      if (!choice.pick) return { kind: 'none' }
      try {
        await writeTarget(ref, choice.pick.value, currentFp)
        noteRotation(ref, choice.pick.fp, provider, state)
        return { kind: 'switched', ref: choice.pick.ref }
      } catch {
        return { kind: 'none' }
      }
    })
  }

  async function waitAndRetry({ agent, turn, step, provider, failure, signal }, { state, base }, cfg, next, delayMs, note, after) {
    // One step may only sit waiting for so long in total, whatever the per-wait cap and retry count allow.
    const budgetMs = cfg.maxTotalWaitMinutes * 60_000
    // A wait longer than what is left is shortened to it (one last try) rather than skipped.
    if (budgetMs > 0) delayMs = Math.min(delayMs, Math.max(0, budgetMs - state.waitedMs))
    if (budgetMs > 0 && state.waitedMs >= budgetMs) {
      if (!state.exhausted) {
        state.exhausted = true
        record('warn', {
          action: 'exhausted',
          provider,
          code: failure.code,
          retry: base.retry,
          note: L(
            `本步骤累计等待已达到 ${cfg.maxTotalWaitMinutes} 分钟上限，交回后续处理器`,
            `this step has used its ${cfg.maxTotalWaitMinutes} minute total wait budget, handing back`,
          ),
        })
      }
      return next()
    }
    state.waitedMs += delayMs
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
        note: L('等待被取消（会话中止或插件卸载）', 'wait cancelled (session aborted or plugin unloaded)'),
      })
      // `undefined` is DSH's "do not retry" action.
      return undefined
    }
    if (after) {
      const usable = await after()
      if (usable === false) {
        record('warn', {
          action: 'pool-still-cooling',
          provider,
          code: failure.code,
          retry: base.retry,
          delayMs,
          note: L('等待结束仍没有可用的轮换密钥，交回默认处理，避免继续用冷却中的 Key 重试', 'no rotation key became usable after the wait, handing back instead of retrying on a still-cooling key'),
        })
        return next()
      }
    }

    appendStarted(agent, { retryId: base.retryId, turn, step, retry: base.retry })
    record('info', {
      action: 'resumed',
      provider,
      retry: base.retry,
      delayMs,
      note: L('限额窗口已刷新，自动继续', 'the limit window has refreshed, continuing'),
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
      state = { count: 0, waitedMs: 0, retryId: randomUUID(), startedAt: Date.now(), exhausted: false }
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
          note: L(`本步骤已达到 ${cfg.maxAttempts} 次上限，交回后续处理器`, `this step reached the cap of ${cfg.maxAttempts} retries, handing back`),
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
    const ref = await resolveRef(provider, cfg)
    if (!ref) return next()
    // Only blame the key when this provider's own rotation installed it moments ago; any other auth
    // failure (a different provider, the user's own key) is not the guard's to fix.
    const last = lastRotation.get(ref)
    if (!last || last.provider !== provider || Date.now() - last.at > REJECT_WINDOW_MS) return next()

    // Replacing the rejected key is cleanup, not a retry: it happens even when this step has no
    // attempts left (maxAttempts: 1, or the last allowed rotation), so the bad key is never left behind.
    const attempt = beginAttempt(payload, cfg)
    const retryNo = attempt?.retry
    const outcome = await replaceRejected(cfg, ref, attempt?.state ?? {}, provider)
    if (!outcome.handled) return next()
    if (outcome.limited) {
      record('warn', {
        action: 'key-rejected',
        provider,
        code: failure.code,
        retry: retryNo,
        note: L(
          `短时间内已有多个密钥被拒绝，问题可能不在密钥本身；不再暂停密钥，已把 ${ref} 换回 ${outcome.keyRef}，交回后续处理器`,
          `several keys were rejected in a short time, so the keys are probably not the cause; benching stopped, ${ref} switched back to ${outcome.keyRef}, handing back`,
        ),
      })
      return next()
    }
    if (outcome.raced) {
      if (!attempt) return next()
      record('info', { action: 'rotate-raced', provider, retry: attempt.retry, note: L('被拒绝的密钥已被换掉，直接用新密钥重试', 'the rejected key was already replaced, retrying on the new key') })
      appendScheduled(agent, { ...attempt.base, delayMs: 0 })
      appendStarted(agent, { retryId: attempt.base.retryId, turn, step, retry: attempt.retry })
      return { kind: 'retry' }
    }
    const usable = outcome.keyRef !== undefined && outcome.ready && attempt !== undefined
    const swapped = outcome.ready
      ? L(`已改用 ${outcome.keyRef}（本步骤重试次数已用完），交回后续处理器`, `switched to ${outcome.keyRef} (this step has no retries left), handing back`)
      : L(`已换回 ${outcome.keyRef}（仍在冷却），交回后续处理器`, `switched back to ${outcome.keyRef} (still cooling), handing back`)
    record('warn', {
      action: 'key-rejected',
      provider,
      code: failure.code,
      retry: retryNo,
      note: L(
        `${outcome.rejectedRef} 的密钥被服务端拒绝，已暂停使用；${
          outcome.keyRef === undefined ? '没有其他未被拒绝的密钥可换' : usable ? `改用 ${outcome.keyRef} 重试` : swapped}`,
        `the provider rejected the key from ${outcome.rejectedRef}, benched; ${
          outcome.keyRef === undefined ? 'no other key that was not rejected' : usable ? `retrying with ${outcome.keyRef}` : swapped}`,
      ),
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
        note: L('额度/余额已耗尽，等待不会恢复，交回默认处理', 'quota or balance is exhausted; waiting cannot help, handing back'),
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
      ? L('使用服务端建议的等待时长', 'using the wait the server suggested')
      : source === 'message-hint'
        ? L('从错误信息中解析出等待时长', 'using the wait found in the error message')
        : undefined
    const fallback = quota && !cfg.waitOnQuota ? false : cfg.fallbackToWait
    const fallbackNote = fallback ? L('，回退为等待', ', falling back to waiting') : L('，交回后续处理器', ', handing back')

    if (cfg.mode === 'rotate') {
      const ref = await resolveRef(provider, cfg)
      if (!credentials || !ref) {
        record('warn', {
          action: 'rotate-unavailable',
          provider,
          retry,
          note: `${credentials ? L(`提供方 ${provider} 没有可轮换的密钥`, `provider ${provider} has no key to rotate`) : L('credentials 服务不可用', 'the credentials service is unavailable')}${fallbackNote}`,
        })
        if (!fallback) return next()
      } else {
        const cooldownMs = quota ? cfg.quotaCooldownMinutes * 60_000 : delayMs
        const outcome = await rotate(cfg, ref, state, cooldownMs, provider)
        if (outcome.ok) {
          appendScheduled(agent, { ...base, delayMs: 0 })
          appendStarted(agent, { retryId: base.retryId, turn, step, retry })
          record('info', outcome.raced
            ? { action: 'rotate-raced', provider, retry, note: L('失败请求很可能还在用旧密钥，直接用新密钥重试', 'the failed request most likely still used the old key, retrying on the new one') }
            : { action: 'rotated', provider, retry, keyRef: outcome.keyRef, note: L(`使用 ${outcome.keyRef} 的值立即重试`, `retrying at once with the value of ${outcome.keyRef}`) })
          return { kind: 'retry' }
        }
        record('warn', {
          action: 'rotate-unavailable',
          provider,
          retry,
          note: `${outcome.reason}${fallbackNote}`,
        })
        if (!fallback) return next()
        if (outcome.readyAt !== undefined) {
          // Every key is cooling: wait for the first one to come back instead of hammering the pool.
          // A wait capped by maxWaitSeconds may end while keys are still cooling; the post-wait check
          // below then hands back instead of retrying a key that is known to be unusable.
          const waitMs = outcome.readyAt - Date.now()
          if (waitMs > cfg.maxWaitSeconds * 1000) {
            record('warn', {
              action: 'pool-still-cooling',
              provider,
              retry,
              note: L(`最早的密钥要到 ${untilTime(outcome.readyAt)} 才恢复，超过单次等待上限 ${cfg.maxWaitSeconds}s；交回默认处理`, `the earliest key is not back until ${untilTime(outcome.readyAt)}, beyond the ${cfg.maxWaitSeconds}s per-wait cap; handing back`),
            })
            return next()
          }
          const untilReady = Math.max(cfg.minWaitSeconds * 1000, Math.min(waitMs, cfg.maxWaitSeconds * 1000))
          return waitAndRetry(payload, attempt, cfg, next, Math.round(untilReady), L('等待最早恢复的密钥', 'waiting for the first key to come back'), async () => {
            const restored = await restoreReady(cfg, ref, state, provider)
            if (restored.kind === 'switched') record('info', { action: 'rotated', provider, retry, keyRef: restored.ref, note: L(`等待后改用 ${restored.ref}`, `switched to ${restored.ref} after waiting`) })
            return restored.kind !== 'none'
          })
        }
      }
    }

    return waitAndRetry(payload, attempt, cfg, next, delayMs, delayNote)
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
      rejectedFps.clear()
      rejectTimes.clear()
      lastRotation.clear()
    }
  }, 'rate-limit-guard: request-error listener')

  /**
   * Unattended mode. A turn whose output hits the model's token cap ends with
   * `turn/end` reason `max-tokens`; a followup user message lets the model write on from where it
   * stopped. The platform notice does this manually, this listener does it for the user.
   */
  ctx.effect(() => {
    const off = ctx.on('session/event', (session, event) => {
      try {
        if (event?.type !== 'turn/end') return
        const reason = event.data?.reason
        if (reason?.kind !== 'max-tokens') {
          autoContinues.delete(session?.id)
          return
        }
        const cfg = readConfig()
        if (!cfg.unattended) return
        const sessionId = session?.id
        if (sessionId === undefined) return
        const now = Date.now()
        const previous = autoContinues.get(sessionId)
        const count = previous && now - previous.lastAt < AUTO_CONTINUE_RESET_MS ? previous.count : 0
        if (count >= MAX_AUTO_CONTINUES) {
          if (!previous?.capped) {
            record('warn', {
              action: 'auto-continue-capped',
              retry: count,
              note: L(`连续自动继续 ${count} 次后输出仍被截断，已停止，请手动检查。`, `stopped after ${count} automatic continues; please check the session manually`),
            })
          }
          autoContinues.set(sessionId, { count, lastAt: now, capped: true })
          return
        }
        autoContinues.set(sessionId, { count: count + 1, lastAt: now, capped: false })
        // Wait for the turn to finish settling before waking the agent again.
        setTimeout(() => {
          if (lifetime.signal.aborted) return
          const agent = ctx.agents.get(sessionId)
          if (!agent) {
            record('warn', {
              action: 'auto-continue',
              note: L('会话已关闭，未发送“继续”', 'the session closed before "continue" could be sent'),
            })
            return
          }
          try {
            agent.followup({
              id: randomUUID(),
              role: 'user',
              content: [{ type: 'text', text: cfg.continueText }],
              source: { kind: 'user' },
            })
            record('info', {
              action: 'auto-continue',
              retry: count + 1,
              note: L(`输出被 token 上限截断，已自动发送“${truncate(cfg.continueText, 30)}”`, `output was cut off at the token limit; sent "${truncate(cfg.continueText, 30)}" automatically`),
            })
          } catch (error) {
            record('warn', {
              action: 'auto-continue',
              note: L(`自动继续失败：${messageOf(error)}`, `could not auto-continue: ${messageOf(error)}`),
            })
          }
        }, 0)
      } catch (error) {
        ctx.logger?.warn?.(`rate-limit-guard: auto-continue handler failed: ${messageOf(error)}`)
      }
    })
    return () => {
      off()
      autoContinues.clear()
    }
  }, 'rate-limit-guard: unattended auto-continue')

  ctx.inject(['commands'], (sub) => {
    sub.commands.register({
      name: 'ratelimit-log',
      description: L('查看限流守护最近的等待与轮换记录', 'Show recent rate limit guard waits and rotations'),
      handler: async () => ({ kind: 'success', text: await renderLog() }),
    })
  })
}

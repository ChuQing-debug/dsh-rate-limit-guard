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

export const name = 'rate-limit-guard'

/** `agents` guarantees the composition that dispatches `agent/request-error`. */
export const inject = ['agents']

const RATE_LIMIT_CODES = new Set(['RATE_LIMIT', 'HTTP_429', 'QUOTA', 'ACCOUNT_QUOTA'])
const LOG_LIMIT = 200
const STATE_LIMIT = 512
const STATE_TTL_MS = 2 * 60 * 60 * 1000

export const Config = z.object({
  mode: z.string().default('wait').volatile(),
  waitSeconds: z.number().default(60).volatile(),
  useRetryAfter: z.boolean().default(true).volatile(),
  maxWaitSeconds: z.number().default(900).volatile(),
  maxAttempts: z.number().default(12).volatile(),
  credentialRef: z.string().default('DEEPSEEK_API_KEY').volatile(),
  alternateKeyRefs: z.array(z.string()).default([]).volatile(),
  providerRefs: z.array(z.string()).default([]).volatile(),
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

function isRateLimitFailure(failure) {
  if (!failure) return false
  const code = typeof failure.code === 'string' ? failure.code : ''
  if (RATE_LIMIT_CODES.has(code)) return true
  if (code.startsWith('HTTP_429')) return true
  return failure.status === 429
}

/** Best-effort wait hint from a provider message such as "retry after 30s". */
function parseRetryHint(message) {
  if (typeof message !== 'string' || message.length === 0) return undefined
  const patterns = [
    /retry[-_ ]?after[^0-9]{0,12}(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|seconds?|m|minutes?)?/i,
    /try again in[^0-9]{0,12}(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|seconds?|m|minutes?)?/i,
    /reset[s]? in[^0-9]{0,12}(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|seconds?|m|minutes?)?/i,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(message)
    if (!match) continue
    const amount = Number(match[1])
    if (!Number.isFinite(amount) || amount <= 0) continue
    const unit = (match[2] ?? 's').toLowerCase()
    if (unit.startsWith('ms') || unit.startsWith('millisecond')) return amount
    if (unit.startsWith('m')) return amount * 60_000
    return amount * 1000
  }
  return undefined
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
  'rotate-unavailable': '无法轮换密钥',
  exhausted: '达到重试上限',
}

export function apply(ctx, config = {}) {
  const attempts = new Map()
  const logs = []
  const lifetime = new AbortController()
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
    return {
      mode,
      waitSeconds: readNumber(config.waitSeconds, 60, 1, 86400),
      useRetryAfter: readBoolean(config.useRetryAfter, true),
      maxWaitSeconds: readNumber(config.maxWaitSeconds, 900, 1, 86400),
      maxAttempts: readNumber(config.maxAttempts, 12, 1, 100),
      credentialRef: String(readField(config.credentialRef, 'DEEPSEEK_API_KEY') || 'DEEPSEEK_API_KEY'),
      alternateKeyRefs: readStrings(config.alternateKeyRefs),
      providerRefs: readStrings(config.providerRefs),
      fallbackToWait: readBoolean(config.fallbackToWait, true),
      guardedProviders: readStrings(config.guardedProviders),
    }
  }

  function resolveRef(provider, cfg) {
    for (const item of cfg.providerRefs) {
      const separator = item.indexOf('=')
      if (separator <= 0) continue
      if (item.slice(0, separator).trim() !== provider) continue
      return item.slice(separator + 1).trim() || cfg.credentialRef
    }
    return cfg.credentialRef
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
      ? `轮换密钥（目标 ${cfg.credentialRef}${cfg.alternateKeyRefs.length ? `，${cfg.alternateKeyRefs.length} 个备用引用` : '，未配置备用引用'}）`
      : `等待（默认 ${cfg.waitSeconds}s，上限 ${cfg.maxWaitSeconds}s）`
    const lines = [`限流守护 · 当前模式：${modeText}`]
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
    if (attempts.size <= STATE_LIMIT) return
    const cutoff = Date.now() - STATE_TTL_MS
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

  async function rotate(cfg, ref) {
    let current
    try {
      current = (await credentials.resolve(ref))?.value
    } catch (error) {
      return { ok: false, reason: `无法读取 ${ref}: ${messageOf(error)}` }
    }
    const candidates = []
    for (const alt of cfg.alternateKeyRefs) {
      if (alt && alt !== ref && !candidates.includes(alt)) candidates.push(alt)
    }
    if (candidates.length === 0) return { ok: false, reason: '未配置备用密钥引用' }
    for (const alt of candidates) {
      let value
      try {
        value = (await credentials.resolve(alt))?.value
      } catch {
        continue
      }
      if (typeof value !== 'string' || value.length === 0) continue
      if (value === current) continue
      try {
        await credentials.set(ref, value)
      } catch (error) {
        return { ok: false, reason: `无法写入 ${ref}: ${messageOf(error)}` }
      }
      return { ok: true, keyRef: alt, target: ref }
    }
    return { ok: false, reason: `备用密钥均未配置或与当前 ${ref} 相同` }
  }

  async function handle(payload, next) {
    const { agent, turn, step, provider, failure, signal } = payload ?? {}
    if (!failure || !isRateLimitFailure(failure)) return next()
    if (lifetime.signal.aborted || signal?.aborted) return next()

    const cfg = readConfig()
    if (cfg.guardedProviders.length > 0 && !cfg.guardedProviders.includes(provider)) return next()

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
      return next()
    }
    state.count += 1
    const retry = state.count
    const retryId = state.retryId
    const scheduledFailure = normalizeFailure(failure)
    const maxRetries = cfg.maxAttempts

    record('info', {
      action: 'detected',
      provider,
      code: failure.code,
      retry,
      note: failure.message ? truncate(failure.message, 140) : undefined,
    })

    if (cfg.mode === 'rotate') {
      if (!credentials) {
        record('warn', {
          action: 'rotate-unavailable',
          provider,
          retry,
          note: `credentials 服务不可用${cfg.fallbackToWait ? '，回退为等待' : '，交回后续处理器'}`,
        })
        if (!cfg.fallbackToWait) return next()
      } else {
        const ref = resolveRef(provider, cfg)
        const outcome = await rotate(cfg, ref)
        if (outcome.ok) {
          appendScheduled(agent, {
            retryId,
            turn,
            step,
            provider,
            mode: 'normal',
            policyKey: 'rate-limit-guard',
            retry,
            maxRetries,
            delayMs: 0,
            failure: scheduledFailure,
          })
          appendStarted(agent, { retryId, turn, step, retry })
          record('info', {
            action: 'rotated',
            provider,
            retry,
            keyRef: outcome.target,
            note: `使用 ${outcome.keyRef} 的值立即重试`,
          })
          return { kind: 'retry' }
        }
        record('warn', {
          action: 'rotate-unavailable',
          provider,
          retry,
          note: `${outcome.reason}${cfg.fallbackToWait ? '，回退为等待' : '，交回后续处理器'}`,
        })
        if (!cfg.fallbackToWait) return next()
      }
    }

    let delayMs = cfg.waitSeconds * 1000
    let delaySource = 'default'
    const retryAfter = failure.providerRetryAfterMs
    const hintMs = parseRetryHint(failure.message)
    if (cfg.useRetryAfter && Number.isFinite(retryAfter) && retryAfter > 0) {
      delayMs = retryAfter
      delaySource = 'retry-after'
    } else if (cfg.useRetryAfter && Number.isFinite(hintMs) && hintMs > 0) {
      delayMs = hintMs
      delaySource = 'message-hint'
    }
    delayMs = Math.min(Math.max(0, delayMs), cfg.maxWaitSeconds * 1000)
    const resumeAt = new Date(Date.now() + delayMs).toISOString()

    appendScheduled(agent, {
      retryId,
      turn,
      step,
      provider,
      mode: 'normal',
      policyKey: 'rate-limit-guard',
      retry,
      maxRetries,
      delayMs,
      failure: scheduledFailure,
    })
    record('info', {
      action: 'waiting',
      provider,
      code: failure.code,
      mode: 'wait',
      retry,
      delayMs,
      resumeAt,
      note: delaySource === 'retry-after'
        ? '使用服务端建议的等待时长'
        : delaySource === 'message-hint'
          ? '从错误信息中解析出等待时长'
          : undefined,
    })

    const completed = await wait(delayMs, fuseSignals(signal, lifetime.signal))
    if (!completed) {
      record('warn', {
        action: 'aborted',
        provider,
        retry,
        note: '等待被取消（会话中止或插件卸载）',
      })
      return undefined
    }

    appendStarted(agent, { retryId, turn, step, retry })
    record('info', {
      action: 'resumed',
      provider,
      retry,
      delayMs,
      note: '限额窗口已刷新，自动继续',
    })
    return { kind: 'retry' }
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

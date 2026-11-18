/**
 * Pure helpers shared by the host half and the tests. Nothing here touches DSH services.
 */
import { createHash } from 'node:crypto'

export const RATE_LIMIT_CODES = new Set(['RATE_LIMIT', 'HTTP_429', 'QUOTA', 'ACCOUNT_QUOTA'])

/** Exhaustion codes: the balance or quota is used up, so waiting a minute does not help. */
export const QUOTA_CODES = new Set(['QUOTA', 'ACCOUNT_QUOTA'])

/** Credential reference names accepted by the guard (same rule the README documents). */
export const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

export function isValidRef(ref) {
  return typeof ref === 'string' && REF_PATTERN.test(ref)
}

export function isRateLimitFailure(failure) {
  if (!failure) return false
  const code = typeof failure.code === 'string' ? failure.code : ''
  if (RATE_LIMIT_CODES.has(code)) return true
  if (code.startsWith('HTTP_429')) return true
  return failure.status === 429
}

export function isQuotaFailure(failure) {
  return !!failure && typeof failure.code === 'string' && QUOTA_CODES.has(failure.code)
}

const UNIT_MS = [
  [/^(?:ms|msec|milliseconds?|毫秒)$/i, 1],
  [/^(?:s|sec|secs|seconds?|秒|秒钟)$/i, 1000],
  [/^(?:m|min|mins|minutes?|分|分钟)$/i, 60_000],
  [/^(?:h|hr|hrs|hours?|小时|时)$/i, 3_600_000],
]

function unitMs(unit) {
  if (!unit) return 1000
  for (const [pattern, ms] of UNIT_MS) if (pattern.test(unit)) return ms
  return undefined
}

// One "<number><unit>" piece. Longer unit spellings come first so "ms" is not read as "m".
const PIECE = String.raw`(\d+(?:\.\d+)?)\s*(milliseconds?|msec|ms|毫秒|seconds?|secs?|s|秒钟|秒|minutes?|mins?|min|m|分钟|分|hours?|hrs?|hr|h|小时)?`
const DURATION = String.raw`(?:\d+(?:\.\d+)?\s*(?:milliseconds?|msec|ms|毫秒|seconds?|secs?|s|秒钟|秒|minutes?|mins?|min|m|分钟|分|hours?|hrs?|hr|h|小时)?\s*){1,4}`

/** Sum a compound duration such as "1m30s", "6m0s", "1 分 30 秒" or a bare "20" (seconds). */
export function parseDuration(text) {
  const piece = new RegExp(PIECE, 'gi')
  let total = 0
  let found = false
  let match
  while ((match = piece.exec(text)) !== null) {
    if (match[0].trim() === '') {
      piece.lastIndex += 1
      continue
    }
    const amount = Number(match[1])
    const ms = unitMs(match[2])
    if (!Number.isFinite(amount) || ms === undefined) continue
    total += amount * ms
    found = true
  }
  return found && total > 0 ? total : undefined
}

const HINT_PATTERNS = [
  // English: "retry after 30s", "Please try again in 1m30s", "limit resets in 20 seconds"
  new RegExp(String.raw`(?:retry[-_ ]?after|try again in|resets? in|wait)[^0-9]{0,12}(${DURATION})`, 'i'),
  // Chinese: "请在 30 秒后重试", "请 1 分钟后再试", "1分30秒后重试"
  new RegExp(String.raw`(${DURATION})\s*(?:之?后|以后)[^0-9]{0,6}(?:重试|再试|再次|恢复)`, 'i'),
]

/** Best-effort wait hint (ms) from a provider message. */
export function parseRetryHint(message) {
  if (typeof message !== 'string' || message.length === 0) return undefined
  for (const pattern of HINT_PATTERNS) {
    const match = pattern.exec(message)
    if (!match) continue
    const ms = parseDuration(match[1])
    if (ms !== undefined) return ms
  }
  return undefined
}

/**
 * Choose the wait for a rate-limit failure.
 * Order: provider retry-after, then a hint in the message, then the configured default.
 * Jitter (up to 10 %, at most 5 s) spreads sessions that hit the same limit together.
 */
export function computeDelay(failure, cfg, random = Math.random) {
  let delayMs = cfg.waitSeconds * 1000
  let source = 'default'
  const retryAfter = failure?.providerRetryAfterMs
  const hintMs = parseRetryHint(failure?.message)
  if (cfg.useRetryAfter && Number.isFinite(retryAfter) && retryAfter > 0) {
    delayMs = retryAfter
    source = 'retry-after'
  } else if (cfg.useRetryAfter && Number.isFinite(hintMs) && hintMs > 0) {
    delayMs = hintMs
    source = 'message-hint'
  }
  if (cfg.jitter) delayMs += random() * Math.min(delayMs * 0.1, 5000)
  delayMs = Math.round(Math.min(Math.max(0, delayMs), cfg.maxWaitSeconds * 1000))
  return { delayMs, source }
}

/** Short, non-reversible tag for a key value, so in-memory state never keeps the secret itself. */
export function fingerprint(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 16)
}

/** Reference that holds the key the user had before the guard first rotated away from it. */
export function backupRefFor(ref) {
  return `${ref}_RLG_ORIGINAL`
}

/**
 * Pick the next key in round-robin order after the current one, skipping keys that are cooling down.
 * `pool` is [{ ref, fp }] in rotation order; `cooldowns` maps fp -> epoch ms until which the key is limited.
 * Returns { pick } when a key is ready, otherwise { readyAt } (earliest time any pool key, the current one
 * included, comes off cooldown) or {} when the pool has no other key at all.
 */
export function pickNext(pool, currentFp, cooldowns, now) {
  const others = pool.filter((entry) => entry.fp !== currentFp)
  if (others.length === 0) return {}
  const index = pool.findIndex((entry) => entry.fp === currentFp)
  const ordered = index === -1 ? pool : [...pool.slice(index + 1), ...pool.slice(0, index)]
  for (const entry of ordered) {
    if (entry.fp === currentFp) continue
    if ((cooldowns.get(entry.fp) ?? 0) <= now) return { pick: entry }
  }
  let readyAt = Infinity
  for (const entry of pool) readyAt = Math.min(readyAt, cooldowns.get(entry.fp) ?? 0)
  if (currentFp && !pool.some((entry) => entry.fp === currentFp)) {
    readyAt = Math.min(readyAt, cooldowns.get(currentFp) ?? 0)
  }
  return { readyAt }
}

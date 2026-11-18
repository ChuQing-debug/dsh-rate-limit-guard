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

/**
 * The provider rejected the credential itself (revoked, mistyped).
 * 403 is deliberately not included: it usually means "this key may not do that" (model, region,
 * content policy), which another key would not fix.
 */
export function isAuthFailure(failure) {
  if (!failure) return false
  const code = typeof failure.code === 'string' ? failure.code : ''
  // DSH reports both 401 and 403 as AUTH and may leave `status` unset; its message then starts with
  // the HTTP status ("403: {...}"), which is the only place the two can be told apart.
  const given = Number(failure.status)
  const status = Number.isInteger(given) && given >= 100
    ? given
    : Number(/^\s*(?:HTTP\s+)?(\d{3})\b/i.exec(typeof failure.message === 'string' ? failure.message : '')?.[1])
  if (status === 403 || code === 'HTTP_403') return false
  if (code === 'AUTH' || code === 'INVALID_CREDENTIAL' || code === 'HTTP_401') return true
  return status === 401
}

/** Providers that sign in with an account instead of reading an API key: nothing to rotate. */
export const KEYLESS_PROVIDERS = new Set(['deepseek-account'])

/** `provider=-` (or nothing after `=`) in the provider mapping: never rotate for this provider. */
export function isNoRotateMarker(value) {
  return value === '' || value === '-'
}

/**
 * Which credential reference rotation should write for `provider`, or undefined when the provider has
 * no rotatable key. `mappings` are `provider=REFERENCE` lines; an invalid reference falls back to the default.
 */
export function refForProvider(provider, mappings, defaultRef) {
  for (const item of mappings) {
    const separator = item.indexOf('=')
    if (separator <= 0) continue
    if (item.slice(0, separator).trim() !== provider) continue
    const ref = item.slice(separator + 1).trim()
    if (isNoRotateMarker(ref)) return undefined
    return isValidRef(ref) ? ref : defaultRef
  }
  return KEYLESS_PROVIDERS.has(provider) ? undefined : defaultRef
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

const UNIT = String.raw`milliseconds?|msec|ms|毫秒|seconds?|secs?|s|秒钟|秒|minutes?|mins?|min|m|分钟|分|hours?|hrs?|hr|h|小时`
// One "<number><unit>" piece. Longer unit spellings come first so "ms" is not read as "m".
const PIECE = String.raw`(\d+(?:\.\d+)?)\s*(${UNIT})?`
// A duration whose every number carries a unit ("1m30s", "30 秒"). The lookahead keeps a unit letter
// from being the start of a word: "3 samples" is not 3 s.
const UNITED = String.raw`(?:\d+(?:\.\d+)?\s*(?:${UNIT})(?![A-Za-z])\s*){1,4}`
// A number with no unit, read as seconds. Not part of a date/time, a longer number or "<n> <word>"
// (Latin or CJK: "retry after 5 次失败" is not 5 s).
const BARE = String.raw`\d+(?:\.\d+)?(?!\d|\.\d|\s*[-:/A-Za-z\u4e00-\u9fff])`
const NUMBER = String.raw`\d+(?:\.\d+)?`

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

// Words that say requests are being held back (so a following "until <time>" is a wait hint).
const HELD = String.raw`\b(?:hold\w*|held|block\w*|paus\w*|throttl\w*|rate[- ]?limit\w*|suspend\w*|retry\w*|wait\w*|resum\w*)`
const ISO_TIME = String.raw`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})`

/** A unit-less number after "retry after": seconds, unless it looks like an epoch or an HTTP status. */
function bareSeconds(text) {
  const value = Number(text)
  if (value > 86_400 || (Number.isInteger(value) && value >= 400 && value <= 599)) return undefined
  return parseDuration(text)
}

/** "until 2026-11-18T11:11:52.150Z": the wait is the distance from now, if that is a sane future time. */
function untilTimestamp(text, now) {
  const ms = Date.parse(text) - now
  return ms > 0 && ms <= 86_400_000 ? ms : undefined
}

// Each entry: [pattern, how to read capture 1 (text, now)]. First match wins.
const HINT_PATTERNS = [
  // "holding sends until 2026-11-18T11:11:52.150Z (~9s, exponential backoff)": a gateway that says
  // how long it will hold. The relative "(~9s" is preferred, since it does not depend on our clock.
  // Both need a "held until" context: "valid until <date>" and "(~30s window)" are not hints.
  [new RegExp(String.raw`${HELD}[^.;]{0,60}?\b(?:until|till)\b[^()]{0,60}\(\s*~\s*(${UNITED})`, 'i'), parseDuration],
  [new RegExp(String.raw`${HELD}[^.;]{0,60}?\b(?:until|till)\s+(${ISO_TIME})`, 'i'), untilTimestamp],
  // Header-style resets: "x-ratelimit-reset-tokens: 6m0s"
  [new RegExp(String.raw`ratelimit-reset[-a-z]*["']?\s*[:=]\s*["']?(${UNITED})`, 'i'), parseDuration],
  // "retry_after_ms": 1500, "retry-after-ms: 250": the number is milliseconds.
  [new RegExp(String.raw`retry[-_ ]?after[-_ ]?ms[^0-9]{0,12}(${NUMBER})`, 'i'), (text) => Number(text)],
  // "retry after 30s", "try again after 20 seconds".
  [new RegExp(String.raw`(?:retry|try again)[-_ ]?after(?![-_ ]?ms)[^0-9]{0,12}(${UNITED})`, 'i'), parseDuration],
  // "Retry-After: 12", "retry after 30": the one phrasing where a bare number means seconds. Only
  // directly after the words (not "retry after (429)"), and not an epoch timestamp.
  // Not "no retry after 5", and a bare 4xx/5xx is taken for a status code ("retry after 429").
  [new RegExp(String.raw`(?<!\bno\s)retry[-_ ]?after(?![-_ ]?ms)["']?[\s:=]{0,4}["']?(${BARE})`, 'i'), bareSeconds],
  // "try again in 1m30s", "retry in 34.5s", "resets in 20 seconds", "resets after 20s",
  // "available in 5 seconds", "wait 1 minute", "retryDelay":"34s".
  // These need a unit: "please wait (429)" and "resets in 3 requests" are not durations.
  // \bwait\b: "request waited 30s in queue" and "timed out waiting 30s for upstream" are not hints.
  [new RegExp(String.raw`(?:try again in|retry in|retry[-_ ]?delay|resets? (?:in|after)|available in|(?<!\bmax\s)(?<!\bmaximum\s)\bwait\b(?!\s+of\b)(?: for)?)[^0-9]{0,12}(${UNITED})`, 'i'), parseDuration],
  // Chinese: "请在 30 秒后重试", "请 1 分钟后再试", "1分30秒后重试", "请于1分钟后再发起请求"
  [new RegExp(String.raw`(${UNITED})\s*(?:之?后|以后)[^0-9]{0,6}(?:重试|重新|再|恢复|继续)`, 'i'), parseDuration],
  // "请等待 30 秒", "请稍等 30 秒"
  [new RegExp(String.raw`(?:(?<!已)等待|稍等)\s*(${UNITED})`, 'i'), parseDuration],
]

/** Best-effort wait hint (ms) from a provider message. `now` only matters for absolute timestamps. */
export function parseRetryHint(message, now = Date.now()) {
  if (typeof message !== 'string' || message.length === 0) return undefined
  for (const [pattern, read] of HINT_PATTERNS) {
    const match = pattern.exec(message)
    if (!match) continue
    const ms = read(match[1], now)
    if (Number.isFinite(ms) && ms > 0) return ms
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
  // A provider may hint a few milliseconds ("try again in 6ms"); retrying that fast only burns the
  // per-step budget, so hints are raised to the configured floor (default 1 s).
  delayMs = Math.max(delayMs, (cfg.minWaitSeconds ?? 1) * 1000)
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
 * Second backup slot: a later key that is in neither the pool nor the first backup (for example a
 * key the user typed into the target after rotations started). Keeps the first backup intact.
 */
export function previousRefFor(ref) {
  return `${ref}_RLG_PREVIOUS`
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

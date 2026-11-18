import test from 'node:test'
import assert from 'node:assert/strict'
import { computeDelay, fingerprint, isValidRef, parseDuration, parseRetryHint, pickNext } from '../lib.js'

test('parseRetryHint reads English hints', () => {
  assert.equal(parseRetryHint('Rate limit reached. Please retry after 30s.'), 30_000)
  assert.equal(parseRetryHint('retry-after: 2 seconds'), 2_000)
  assert.equal(parseRetryHint('Please try again in 1m30s.'), 90_000)
  assert.equal(parseRetryHint('Limit for tokens resets in 6m0s'), 360_000)
  assert.equal(parseRetryHint('try again in 250ms'), 250)
  assert.equal(parseRetryHint('retry after 2 minutes'), 120_000)
})

test('parseRetryHint reads Chinese hints', () => {
  assert.equal(parseRetryHint('请求过于频繁，请在 30 秒后重试'), 30_000)
  assert.equal(parseRetryHint('错误 429：请 2 分钟后再试'), 120_000)
  assert.equal(parseRetryHint('触发限流，1分30秒后重试'), 90_000)
})

test('parseRetryHint ignores messages without a hint', () => {
  assert.equal(parseRetryHint('HTTP 429 Too Many Requests'), undefined)
  assert.equal(parseRetryHint(''), undefined)
  assert.equal(parseRetryHint(undefined), undefined)
})

test('parseDuration sums compound durations', () => {
  assert.equal(parseDuration('1h2m3s'), 3_723_000)
  assert.equal(parseDuration('20'), 20_000)
})

test('computeDelay prefers retry-after, then the message, then the default, and caps', () => {
  const cfg = { waitSeconds: 60, useRetryAfter: true, maxWaitSeconds: 900, jitter: false }
  assert.deepEqual(computeDelay({ providerRetryAfterMs: 5000, message: 'retry after 30s' }, cfg), { delayMs: 5000, source: 'retry-after' })
  assert.deepEqual(computeDelay({ message: 'retry after 30s' }, cfg), { delayMs: 30_000, source: 'message-hint' })
  assert.deepEqual(computeDelay({ message: 'slow down' }, cfg), { delayMs: 60_000, source: 'default' })
  assert.equal(computeDelay({ message: 'retry after 2 hours' }, cfg).delayMs, 900_000)
  assert.equal(computeDelay({ message: 'retry after 30s' }, { ...cfg, useRetryAfter: false }).delayMs, 60_000)
})

test('computeDelay jitter adds at most 10 % and at most 5 s', () => {
  const cfg = { waitSeconds: 60, useRetryAfter: true, maxWaitSeconds: 900, jitter: true }
  assert.equal(computeDelay({ message: 'retry after 10s' }, cfg, () => 1).delayMs, 11_000)
  assert.equal(computeDelay({ message: 'retry after 600s' }, cfg, () => 1).delayMs, 605_000)
  assert.equal(computeDelay({ message: 'retry after 10s' }, cfg, () => 0).delayMs, 10_000)
})

test('isValidRef follows the documented pattern', () => {
  assert.ok(isValidRef('DEEPSEEK_API_KEY'))
  assert.ok(isValidRef('_k1'))
  assert.ok(!isValidRef('1KEY'))
  assert.ok(!isValidRef('MY-KEY'))
  assert.ok(!isValidRef(''))
})

test('pickNext rotates round-robin and skips cooling keys', () => {
  const fp = (v) => fingerprint(v)
  const pool = ['P', 'A', 'B'].map((ref) => ({ ref, fp: fp(ref) }))
  const none = new Map()
  assert.equal(pickNext(pool, fp('P'), none, 0).pick.ref, 'A')
  assert.equal(pickNext(pool, fp('A'), none, 0).pick.ref, 'B')
  assert.equal(pickNext(pool, fp('B'), none, 0).pick.ref, 'P')
  assert.equal(pickNext(pool, fp('X'), none, 0).pick.ref, 'P')
  const cooling = new Map([[fp('A'), 100]])
  assert.equal(pickNext(pool, fp('P'), cooling, 50).pick.ref, 'B')
  const all = new Map([[fp('P'), 300], [fp('A'), 100], [fp('B'), 200]])
  assert.deepEqual(pickNext(pool, fp('P'), all, 50), { readyAt: 100 })
  assert.deepEqual(pickNext([{ ref: 'P', fp: fp('P') }], fp('P'), none, 0), {})
})

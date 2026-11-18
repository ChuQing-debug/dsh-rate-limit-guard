import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'

/** Minimal stand-in for the DSH context: just what the guard touches. */
function harness(config = {}, initial = {}) {
  const store = new Map(Object.entries(initial))
  const failResolve = new Set()
  const events = []
  const disposers = []
  let listener
  let command
  const credentials = {
    async resolve(ref) {
      if (failResolve.has(ref)) throw new Error('storage busy')
      return store.has(ref) ? { value: store.get(ref) } : undefined
    },
    async set(ref, value) { store.set(ref, value) },
  }
  const sub = {
    credentials,
    settings: { configure() {} },
    commands: { register(c) { command = c } },
    effect(fn) { const d = fn(); if (d) disposers.push(d) },
  }
  const ctx = {
    fiber: {},
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    inject(_deps, cb) { cb(sub) },
    effect(fn) { const d = fn(); if (d) disposers.push(d) },
    on(name, fn, opts) {
      assert.equal(name, 'agent/request-error')
      assert.equal(opts.prepend, true)
      listener = fn
      return () => { listener = undefined }
    },
  }
  apply(ctx, { jitter: false, minWaitSeconds: 0, ...config })
  const agent = { session: { id: 's1', append: (type, data) => events.push({ type, data }) } }
  let nextCalls = 0
  const fire = (failure, { step = 1, signal, provider = 'deepseek' } = {}) =>
    listener({ agent, turn: 1, step, provider, failure, signal }, async () => { nextCalls += 1; return undefined })
  return {
    store,
    failResolve,
    events,
    fire,
    nextCalls: () => nextCalls,
    log: () => command.handler().text,
    dispose: () => disposers.forEach((d) => d()),
  }
}

const limited = (message = 'rate limited') => ({ code: 'RATE_LIMIT', message })

test('wait mode honours a message hint and appends retry events', async () => {
  const h = harness()
  const started = Date.now()
  const action = await h.fire(limited('retry after 0.05s'))
  assert.deepEqual(action, { kind: 'retry' })
  assert.ok(Date.now() - started >= 45)
  assert.deepEqual(h.events.map((e) => e.type), ['llm/retry', 'llm/retry-started'])
  assert.equal(h.events[0].data.delayMs, 50)
})

test('non rate-limit failures go to next()', async () => {
  const h = harness()
  await h.fire({ code: 'NETWORK', message: 'boom' })
  assert.equal(h.nextCalls(), 1)
})

test('exhausted quota is not waited out in wait mode', async () => {
  const h = harness()
  const action = await h.fire({ code: 'ACCOUNT_QUOTA', message: 'insufficient balance' })
  assert.equal(action, undefined)
  assert.equal(h.nextCalls(), 1)
  assert.equal(h.events.length, 0)
})

test('waitOnQuota restores the old behaviour', async () => {
  const h = harness({ waitOnQuota: true })
  const action = await h.fire({ code: 'QUOTA', message: 'retry after 0.01s' })
  assert.deepEqual(action, { kind: 'retry' })
  assert.equal(h.nextCalls(), 0)
})

test('aborting a wait returns undefined (no retry)', async () => {
  const h = harness({ waitSeconds: 30 })
  const controller = new AbortController()
  const pending = h.fire(limited(), { signal: controller.signal })
  setTimeout(() => controller.abort(), 20)
  assert.equal(await pending, undefined)
  assert.equal(h.nextCalls(), 0)
})

test('unloading the plugin cancels a pending wait', async () => {
  const h = harness({ waitSeconds: 30 })
  const pending = h.fire(limited())
  setTimeout(() => h.dispose(), 20)
  assert.equal(await pending, undefined)
})

test('maxAttempts hands the step back once the cap is reached', async () => {
  const h = harness({ maxAttempts: 2 })
  await h.fire(limited('retry after 0.01s'))
  await h.fire(limited('retry after 0.01s'))
  await h.fire(limited('retry after 0.01s'))
  assert.equal(h.nextCalls(), 1)
})

test('rotate mode backs up the original key before overwriting it', async () => {
  const h = harness(
    { mode: 'rotate', alternateKeyRefs: ['KEY_A', 'KEY_B'] },
    { DEEPSEEK_API_KEY: 'orig', KEY_A: 'aaa', KEY_B: 'bbb' },
  )
  assert.deepEqual(await h.fire(limited()), { kind: 'retry' })
  assert.equal(h.store.get('DEEPSEEK_API_KEY'), 'aaa')
  assert.equal(h.store.get('DEEPSEEK_API_KEY_RLG_ORIGINAL'), 'orig')
  assert.equal(h.events.find((e) => e.type === 'llm/retry').data.delayMs, 0)
})

test('rotate mode cycles through the pool and back to the original key', async () => {
  const h = harness(
    { mode: 'rotate', alternateKeyRefs: ['KEY_A', 'KEY_B'], maxAttempts: 20 },
    { DEEPSEEK_API_KEY: 'orig', KEY_A: 'aaa', KEY_B: 'bbb' },
  )
  const seen = []
  // a 0.001 s hint keeps every key's cooldown short, so the whole cycle is visible
  for (let step = 1; step <= 3; step += 1) {
    await h.fire(limited('retry after 0.001s'), { step })      // rotates (or grace-retries)
    await new Promise((r) => setTimeout(r, 5))
    await h.fire(limited('retry after 0.001s'), { step })      // same step fails again: rotates
    seen.push(h.store.get('DEEPSEEK_API_KEY'))
  }
  assert.ok(seen.includes('orig'), `original key should come back into rotation, saw ${seen}`)
})

test('rotate mode: a failure right after a rotation retries once without rotating again', async () => {
  const h = harness(
    { mode: 'rotate', alternateKeyRefs: ['KEY_A', 'KEY_B'] },
    { DEEPSEEK_API_KEY: 'orig', KEY_A: 'aaa', KEY_B: 'bbb' },
  )
  await h.fire(limited(), { step: 1 })
  // another request that was still in flight with the old key
  assert.deepEqual(await h.fire(limited(), { step: 2 }), { kind: 'retry' })
  assert.equal(h.store.get('DEEPSEEK_API_KEY'), 'aaa')
  // the same step failing again, now on the new key, does rotate
  await h.fire(limited(), { step: 2 })
  assert.equal(h.store.get('DEEPSEEK_API_KEY'), 'bbb')
})

test('rotate mode waits for the earliest key when the whole pool is cooling', async () => {
  const h = harness(
    { mode: 'rotate', alternateKeyRefs: ['KEY_A'], maxAttempts: 10 },
    { DEEPSEEK_API_KEY: 'orig', KEY_A: 'aaa' },
  )
  await h.fire(limited('retry after 0.25s'), { step: 1 })           // orig cools for 0.25 s, switch to aaa
  await h.fire(limited('retry after 0.25s'), { step: 2 })           // grace retry on aaa
  const started = Date.now()
  const action = await h.fire(limited('retry after 2s'), { step: 2 })  // aaa cools for 2 s
  assert.deepEqual(action, { kind: 'retry' })
  const waited = Date.now() - started
  assert.ok(waited >= 150 && waited < 1500, `should wait only for orig to come off cooldown, waited ${waited} ms`)
  assert.equal(h.store.get('DEEPSEEK_API_KEY'), 'orig')
})

test('rotate mode hands back exhausted quota when no other key is left', async () => {
  const h = harness({ mode: 'rotate', alternateKeyRefs: [] }, { DEEPSEEK_API_KEY: 'orig' })
  const action = await h.fire({ code: 'QUOTA', message: 'quota exceeded' })
  assert.equal(action, undefined)
  assert.equal(h.nextCalls(), 1)
})

test('concurrent failures rotate only once', async () => {
  const h = harness(
    { mode: 'rotate', alternateKeyRefs: ['KEY_A', 'KEY_B'] },
    { DEEPSEEK_API_KEY: 'orig', KEY_A: 'aaa', KEY_B: 'bbb' },
  )
  await Promise.all([1, 2, 3].map((step) => h.fire(limited(), { step })))
  assert.equal(h.store.get('DEEPSEEK_API_KEY'), 'aaa')
})

test('invalid reference names are ignored', async () => {
  const h = harness(
    { mode: 'rotate', alternateKeyRefs: ['bad-ref', 'KEY_A'], keepOriginalKey: false },
    { DEEPSEEK_API_KEY: 'orig', 'bad-ref': 'zzz', KEY_A: 'aaa' },
  )
  await h.fire(limited())
  assert.equal(h.store.get('DEEPSEEK_API_KEY'), 'aaa')
})

test('/ratelimit-log renders the mode line and events', async () => {
  const h = harness()
  await h.fire(limited('retry after 0.01s'))
  const text = h.log()
  assert.match(text, /当前模式：等待/)
  assert.match(text, /已恢复并继续/)
})

test('the step that caused a rotation rotates again at once if the new key is limited too', async () => {
  const h = harness(
    { mode: 'rotate', alternateKeyRefs: ['KEY_A', 'KEY_B'] },
    { DEEPSEEK_API_KEY: 'orig', KEY_A: 'aaa', KEY_B: 'bbb' },
  )
  await h.fire(limited(), { step: 1 })
  assert.equal(h.store.get('DEEPSEEK_API_KEY'), 'aaa')
  await h.fire(limited(), { step: 1 })
  assert.equal(h.store.get('DEEPSEEK_API_KEY'), 'bbb', 'no wasted retry on the key that just failed')
})

test('a provider mapped to "-" is never rotated, only waited for', async () => {
  const h = harness(
    { mode: 'rotate', alternateKeyRefs: ['KEY_A'], providerRefs: ['lan-qwen=-'] },
    { DEEPSEEK_API_KEY: 'orig', KEY_A: 'aaa' },
  )
  const started = Date.now()
  assert.deepEqual(await h.fire(limited('retry after 0.05s'), { provider: 'lan-qwen' }), { kind: 'retry' })
  assert.ok(Date.now() - started >= 45, 'falls back to waiting')
  assert.equal(h.store.get('DEEPSEEK_API_KEY'), 'orig')
  assert.equal(h.store.has('DEEPSEEK_API_KEY_RLG_ORIGINAL'), false)
})

test('account-login providers are never rotated', async () => {
  const h = harness(
    { mode: 'rotate', alternateKeyRefs: ['KEY_A'], fallbackToWait: false },
    { DEEPSEEK_API_KEY: 'orig', KEY_A: 'aaa' },
  )
  await h.fire(limited(), { provider: 'deepseek-account' })
  assert.equal(h.nextCalls(), 1)
  assert.equal(h.store.get('DEEPSEEK_API_KEY'), 'orig')
})

test('a pool key rejected right after rotation is benched and replaced', async () => {
  const h = harness(
    { mode: 'rotate', alternateKeyRefs: ['KEY_A', 'KEY_B'], maxAttempts: 20 },
    { DEEPSEEK_API_KEY: 'orig', KEY_A: 'revoked', KEY_B: 'bbb' },
  )
  await h.fire(limited('retry after 0.001s'))
  assert.equal(h.store.get('DEEPSEEK_API_KEY'), 'revoked')
  const action = await h.fire({ code: 'AUTH', message: '401: Invalid API key' })
  assert.deepEqual(action, { kind: 'retry' })
  assert.equal(h.store.get('DEEPSEEK_API_KEY'), 'bbb')
  assert.match(h.log(), /密钥被拒绝/)
  // the rejected key does not come back into the rotation
  for (let step = 2; step <= 5; step += 1) {
    await new Promise((r) => setTimeout(r, 5))
    await h.fire(limited('retry after 0.001s'), { step })
    assert.notEqual(h.store.get('DEEPSEEK_API_KEY'), 'revoked')
  }
})

test('auth failures the guard did not cause are left alone', async () => {
  const h = harness(
    { mode: 'rotate', alternateKeyRefs: ['KEY_A', 'KEY_B'] },
    { DEEPSEEK_API_KEY: 'orig', KEY_A: 'aaa', KEY_B: 'bbb' },
  )
  // no rotation happened yet: the user's own key is rejected
  await h.fire({ code: 'AUTH', message: '401' })
  assert.equal(h.nextCalls(), 1)
  assert.equal(h.store.get('DEEPSEEK_API_KEY'), 'orig')
  // after a rotation, an auth failure from a different provider is not blamed on the pool key
  await h.fire(limited(), { step: 2 })
  await h.fire({ code: 'AUTH', message: '401' }, { step: 3, provider: 'other' })
  assert.equal(h.nextCalls(), 2)
  assert.equal(h.store.get('DEEPSEEK_API_KEY'), 'aaa')
})

test('concurrent auth failures bench only the rejected key', async () => {
  const h = harness(
    { mode: 'rotate', alternateKeyRefs: ['KEY_A', 'KEY_B', 'KEY_C'] },
    { DEEPSEEK_API_KEY: 'orig', KEY_A: 'revoked', KEY_B: 'bbb', KEY_C: 'ccc' },
  )
  await h.fire(limited(), { step: 1 })
  assert.equal(h.store.get('DEEPSEEK_API_KEY'), 'revoked')
  // three in-flight requests all used the revoked key
  const auth = { code: 'AUTH', message: '401: Invalid API key' }
  const actions = await Promise.all([1, 2, 3].map((step) => h.fire(auth, { step })))
  assert.deepEqual(actions, [{ kind: 'retry' }, { kind: 'retry' }, { kind: 'retry' }])
  assert.equal(h.store.get('DEEPSEEK_API_KEY'), 'bbb', 'the good replacement stays in place')
})

test('an auth failure that follows every key benches at most two keys', async () => {
  const h = harness(
    { mode: 'rotate', alternateKeyRefs: ['KEY_A', 'KEY_B', 'KEY_C', 'KEY_D'], maxAttempts: 50 },
    { DEEPSEEK_API_KEY: 'orig', KEY_A: 'aaa', KEY_B: 'bbb', KEY_C: 'ccc', KEY_D: 'ddd' },
  )
  await h.fire(limited(), { step: 1 })
  const seen = new Set()
  for (let i = 0; i < 10; i += 1) {
    await h.fire({ code: 'AUTH', message: '401' }, { step: 1 })
    seen.add(h.store.get('DEEPSEEK_API_KEY'))
  }
  assert.deepEqual([...seen].sort(), ['bbb', 'ccc'], 'aaa and bbb benched, then the guard stops')
  assert.equal(h.store.get('DEEPSEEK_API_KEY_RLG_ORIGINAL'), 'orig')
})

test('403 is not treated as a rejected key', async () => {
  const h = harness(
    { mode: 'rotate', alternateKeyRefs: ['KEY_A', 'KEY_B'] },
    { DEEPSEEK_API_KEY: 'orig', KEY_A: 'aaa', KEY_B: 'bbb' },
  )
  await h.fire(limited(), { step: 1 })
  await h.fire({ code: 'HTTP_403', status: 403, message: 'model not allowed in your region' }, { step: 1 })
  assert.equal(h.nextCalls(), 1)
  assert.equal(h.store.get('DEEPSEEK_API_KEY'), 'aaa')
})

test('the first backup is never overwritten; a later unknown key goes to the PREVIOUS slot', async () => {
  const h = harness(
    { mode: 'rotate', alternateKeyRefs: ['KEY_A', 'KEY_B'] },
    { DEEPSEEK_API_KEY: 'k1-old', DEEPSEEK_API_KEY_RLG_ORIGINAL: 'orig', KEY_A: 'k1-new', KEY_B: 'bbb' },
  )
  await h.fire(limited())
  assert.equal(h.store.get('DEEPSEEK_API_KEY_RLG_ORIGINAL'), 'orig')
  assert.equal(h.store.get('DEEPSEEK_API_KEY_RLG_PREVIOUS'), 'k1-old')
  assert.notEqual(h.store.get('DEEPSEEK_API_KEY'), 'k1-old')
})

test('a target that cannot be read is not overwritten', async () => {
  const h = harness(
    { mode: 'rotate', alternateKeyRefs: ['KEY_A'], fallbackToWait: false },
    { DEEPSEEK_API_KEY: 'orig', KEY_A: 'aaa' },
  )
  h.failResolve.add('DEEPSEEK_API_KEY')
  await h.fire(limited())
  assert.equal(h.nextCalls(), 1)
  assert.equal(h.store.get('DEEPSEEK_API_KEY'), 'orig')
})

test('millisecond hints are raised to the one-second floor by default', async () => {
  const h = harness({ minWaitSeconds: undefined, maxAttempts: 3 })
  const started = Date.now()
  await h.fire(limited('Please try again in 6ms'))
  assert.ok(Date.now() - started >= 950, 'waited about a second, not 6 ms')
})

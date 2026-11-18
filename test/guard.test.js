import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'

/** Minimal stand-in for the DSH context: just what the guard touches. */
function harness(config = {}, initial = {}) {
  const store = new Map(Object.entries(initial))
  const events = []
  const disposers = []
  let listener
  let command
  const credentials = {
    async resolve(ref) { return store.has(ref) ? { value: store.get(ref) } : undefined },
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
  apply(ctx, { jitter: false, ...config })
  const agent = { session: { id: 's1', append: (type, data) => events.push({ type, data }) } }
  let nextCalls = 0
  const fire = (failure, { step = 1, signal } = {}) =>
    listener({ agent, turn: 1, step, provider: 'deepseek', failure, signal }, async () => { nextCalls += 1; return undefined })
  return {
    store,
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

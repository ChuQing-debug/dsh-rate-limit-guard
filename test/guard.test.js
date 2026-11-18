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
    async set(ref, value) { store.set(ref, value); api.onSet?.(ref, value) },
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
  apply(ctx, { jitter: false, minWaitSeconds: 0, language: 'zh', ...config })
  const agent = { session: { id: 's1', append: (type, data) => events.push({ type, data }) } }
  let nextCalls = 0
  const fire = (failure, { step = 1, signal, provider = 'deepseek' } = {}) =>
    listener({ agent, turn: 1, step, provider, failure, signal }, async () => { nextCalls += 1; return undefined })
  const api = {
    store,
    failResolve,
    events,
    fire,
    nextCalls: () => nextCalls,
    log: async () => (await command.handler()).text,
    dispose: () => disposers.forEach((d) => d()),
  }
  return api
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
  const text = await h.log()
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
  assert.match(await h.log(), /密钥被拒绝/)
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
  assert.deepEqual([...seen].sort(), ['bbb', 'ccc', 'orig'], 'aaa and bbb benched, then the guard stops')
  assert.equal(h.store.get('DEEPSEEK_API_KEY'), 'orig', 'the last rejected key is not left installed: the original is put back')
  assert.match(await h.log(), /问题可能不在密钥本身/)
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

test('a step stops waiting once its total wait budget is used up', async () => {
  // 0.002 min = 120 ms budget; each hinted wait is 50 ms
  const h = harness({ maxTotalWaitMinutes: 0.002, maxAttempts: 50 })
  assert.deepEqual(await h.fire(limited('retry after 0.05s')), { kind: 'retry' })
  assert.deepEqual(await h.fire(limited('retry after 0.05s')), { kind: 'retry' })
  // 20 ms are left: the third wait is shortened to that for one last try
  let started = Date.now()
  assert.deepEqual(await h.fire(limited('retry after 0.05s')), { kind: 'retry' })
  assert.ok(Date.now() - started < 45, 'the last wait is cut to the remaining budget')
  started = Date.now()
  assert.equal(await h.fire(limited('retry after 0.05s')), undefined)
  assert.ok(Date.now() - started < 30, 'handed back without waiting')
  assert.equal(h.nextCalls(), 1)
  // another step has its own budget
  assert.deepEqual(await h.fire(limited('retry after 0.05s'), { step: 2 }), { kind: 'retry' })
  assert.match(await h.log(), /累计等待/)
})

test('a budget shorter than the first wait still waits, for as long as the budget allows', async () => {
  const h = harness({ maxTotalWaitMinutes: 0.001, waitSeconds: 60 })   // 60 ms budget, 60 s default wait
  const started = Date.now()
  assert.deepEqual(await h.fire(limited()), { kind: 'retry' })
  const waited = Date.now() - started
  assert.ok(waited >= 50 && waited < 1000, 'waited ' + waited + ' ms')
})

test('/ratelimit-log reports which pool key is in use and which are cooling or rejected', async () => {
  const h = harness(
    { mode: 'rotate', alternateKeyRefs: ['KEY_A', 'KEY_B'], waitSeconds: 60 },
    { DEEPSEEK_API_KEY: 'orig', KEY_A: 'revoked-secret', KEY_B: 'bbb-secret' },
  )
  await h.fire(limited())
  await h.fire({ code: 'AUTH', message: '401' })
  const text = await h.log()
  assert.match(text, /DEEPSEEK_API_KEY 当前使用：KEY_B/)
  assert.match(text, /DEEPSEEK_API_KEY_RLG_ORIGINAL: 冷却到/)
  assert.match(text, /KEY_A: 被服务端拒绝，暂停到 /)
  assert.match(text, /KEY_B: 可用/)
  assert.ok(!/secret|orig\b/.test(text.replace(/RLG_ORIGINAL/g, '')), 'key values never appear in the report')
})

test('log and report are in English when language is en', async () => {
  const h = harness({ language: 'en' })
  await h.fire(limited('retry after 0.01s'))
  const text = await h.log()
  assert.match(text, /Rate limit guard · mode: wait/)
  assert.match(text, /Resumed/)
  assert.ok(!/[一-鿿]/.test(text), 'no Chinese left in the English report')
})

test('a backup slot that cannot be read is never written to', async () => {
  const h = harness(
    { mode: 'rotate', alternateKeyRefs: ['KEY_A'], fallbackToWait: false },
    { DEEPSEEK_API_KEY: 'user-typed', DEEPSEEK_API_KEY_RLG_ORIGINAL: 'orig', KEY_A: 'aaa' },
  )
  h.failResolve.add('DEEPSEEK_API_KEY_RLG_ORIGINAL')
  await h.fire(limited())
  assert.equal(h.nextCalls(), 1, 'rotation refused')
  assert.equal(h.store.get('DEEPSEEK_API_KEY_RLG_ORIGINAL'), 'orig')
  assert.equal(h.store.get('DEEPSEEK_API_KEY'), 'user-typed')
})

test('an unknown key is backed up even when the only other key is the earlier backup', async () => {
  const h = harness(
    { mode: 'rotate', alternateKeyRefs: [] },
    { DEEPSEEK_API_KEY: 'user-typed', DEEPSEEK_API_KEY_RLG_ORIGINAL: 'orig' },
  )
  await h.fire(limited())
  assert.equal(h.store.get('DEEPSEEK_API_KEY'), 'orig')
  assert.equal(h.store.get('DEEPSEEK_API_KEY_RLG_PREVIOUS'), 'user-typed')
})

test('rotation is refused rather than overwrite a full PREVIOUS slot', async () => {
  const h = harness(
    { mode: 'rotate', alternateKeyRefs: ['KEY_A'], fallbackToWait: false },
    { DEEPSEEK_API_KEY: 'third', DEEPSEEK_API_KEY_RLG_ORIGINAL: 'orig', DEEPSEEK_API_KEY_RLG_PREVIOUS: 'second', KEY_A: 'aaa' },
  )
  await h.fire(limited())
  assert.equal(h.nextCalls(), 1)
  assert.deepEqual(
    ['DEEPSEEK_API_KEY', 'DEEPSEEK_API_KEY_RLG_ORIGINAL', 'DEEPSEEK_API_KEY_RLG_PREVIOUS'].map((ref) => h.store.get(ref)),
    ['third', 'orig', 'second'],
  )
})

test('auth failures across several rotations still bench at most two keys of a reference', async () => {
  const h = harness(
    { mode: 'rotate', alternateKeyRefs: ['KEY_A', 'KEY_B', 'KEY_C', 'KEY_D'], maxAttempts: 50 },
    { DEEPSEEK_API_KEY: 'orig', KEY_A: 'aaa', KEY_B: 'bbb', KEY_C: 'ccc', KEY_D: 'ddd' },
  )
  for (let step = 1; step <= 4; step += 1) {
    await h.fire(limited('retry after 0.001s'), { step })
    for (let i = 0; i < 3; i += 1) await h.fire({ code: 'AUTH', message: '401: nope' }, { step })
    await new Promise((r) => setTimeout(r, 5))
  }
  const benched = ((await h.log()).match(/被服务端拒绝/g) ?? []).length
  assert.ok(benched <= 2 + 2, 'two status lines plus at most two event lines, got ' + benched)
  assert.equal(((await h.log()).match(/: 被服务端拒绝，暂停到/g) ?? []).length, 2)
})

test('a late auth failure from the old key does not bench the replacement', async () => {
  const h = harness(
    { mode: 'rotate', alternateKeyRefs: ['KEY_A', 'KEY_B', 'KEY_C'] },
    { DEEPSEEK_API_KEY: 'orig', KEY_A: 'revoked', KEY_B: 'bbb', KEY_C: 'ccc' },
  )
  await h.fire(limited(), { step: 1 })
  await h.fire({ code: 'AUTH', message: '401' }, { step: 1 })
  assert.equal(h.store.get('DEEPSEEK_API_KEY'), 'bbb')
  await new Promise((r) => setTimeout(r, 30))
  // another step, whose request was still using the revoked key
  assert.deepEqual(await h.fire({ code: 'AUTH', message: '401' }, { step: 2 }), { kind: 'retry' })
  assert.equal(h.store.get('DEEPSEEK_API_KEY'), 'bbb')
})

test('two targets that list each other as alternates never lose a shared key', async () => {
  const h = harness(
    { mode: 'rotate', credentialRef: 'KEY_ONE', providerRefs: ['p2=KEY_TWO'], alternateKeyRefs: ['KEY_ONE', 'KEY_TWO', 'KEY_A'] },
    { KEY_ONE: 'shared', KEY_TWO: 'shared', KEY_A: 'aaa' },
  )
  await Promise.all([h.fire(limited(), { step: 1, provider: 'p1' }), h.fire(limited(), { step: 2, provider: 'p2' })])
  const values = [...h.store.values()]
  assert.ok(values.includes('shared'), 'the shared key is still stored somewhere: ' + JSON.stringify([...h.store]))
})

test('a key typed into the target during a rotation is not overwritten', async () => {
  const h = harness(
    { mode: 'rotate', alternateKeyRefs: ['KEY_A'], fallbackToWait: false },
    { DEEPSEEK_API_KEY: 'orig', KEY_A: 'aaa' },
  )
  // the user saves a new key right after the guard has written the backup, before it writes the target
  h.onSet = (ref) => { if (ref === 'DEEPSEEK_API_KEY_RLG_ORIGINAL') h.store.set('DEEPSEEK_API_KEY', 'typed-meanwhile') }
  await h.fire(limited())
  assert.equal(h.store.get('DEEPSEEK_API_KEY'), 'typed-meanwhile')
  assert.equal(h.nextCalls(), 1)
})

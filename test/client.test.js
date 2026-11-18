import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

/** A tiny hooks runtime: enough to render the settings section and follow its state updates. */
function createReact() {
  let hooks = []
  let index = 0
  let effects = []
  let dirty = false
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    useState(initial) {
      const i = index++
      if (!(i in hooks)) hooks[i] = typeof initial === 'function' ? initial() : initial
      const set = (value) => {
        hooks[i] = typeof value === 'function' ? value(hooks[i]) : value
        dirty = true
      }
      return [hooks[i], set]
    },
    useCallback(fn, deps) {
      const i = index++
      const prev = hooks[i]
      if (prev && deps && prev.deps.every((d, k) => d === deps[k])) return prev.fn
      hooks[i] = { fn, deps }
      return fn
    },
    useEffect(fn, deps) {
      const i = index++
      const prev = hooks[i]
      if (prev && deps && prev.deps.every((d, k) => d === deps[k])) return
      hooks[i] = { deps }
      effects.push(fn)
    },
  }
  function expand(node) {
    if (node === null || node === undefined || typeof node !== 'object') return node
    if (typeof node.type === 'function') return expand(node.type({ ...node.props, children: node.children }))
    return { ...node, children: node.children.map(expand) }
  }
  async function render(Component, props) {
    let tree
    for (let pass = 0; pass < 20; pass += 1) {
      index = 0
      dirty = false
      tree = expand(React.createElement(Component, props))
      const run = effects
      effects = []
      for (const fn of run) await fn()
      await new Promise((r) => setTimeout(r, 0))
      if (!dirty) return tree
    }
    return tree
  }
  return { React, render }
}

function load() {
  let module
  const window = { __ModuleLoader__: { load: (m) => { module = m } } }
  vm.runInNewContext(source, { window })
  return module
}

function boot(settingsValue, { writable = true } = {}) {
  const { React, render } = createReact()
  const factory = load().factory((name) => {
    assert.equal(name, 'react')
    return React
  })
  let dict
  let section
  const mutations = []
  const ctx = {
    effect: (fn) => fn(),
    locale: {
      register: (_ns, d) => { dict = d },
      bind: () => (key) => (key in dict.zh ? key : `MISSING:${key}`),
    },
    slots: {
      inject: (_name, fn) => fn(),
      register: (entry, Component) => { section = { entry, Component } },
    },
    remote: {
      settings: {
        describe: async () => ({ ok: true, value: { writable, namespaces: [{ ns: 'rate-limit-guard', revision: 1, value: settingsValue }] } }),
        mutate: async (_ns, ops) => { mutations.push(ops); return { ok: true } },
      },
      credentials: {
        describe: async (refs) => ({ ok: true, value: Object.fromEntries(refs.map((r) => [r, { configured: false }])) }),
        set: async () => ({ ok: true }),
      },
    },
  }
  factory.apply(ctx)
  return { dict, section, render, mutations }
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') return
  visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}

function texts(tree) {
  const out = []
  walk(tree, (n) => { for (const c of n.children) if (typeof c === 'string') out.push(c) })
  return out
}

test('zh and en dictionaries have the same keys', () => {
  const { dict } = boot({})
  assert.deepEqual(Object.keys(dict.zh).sort(), Object.keys(dict.en).sort())
})

test('settings section registers once and renders every label from the dictionary', async () => {
  const { section, render } = boot({ mode: 'rotate', credentialRef: 'DEEPSEEK_API_KEY', alternateKeyRefs: ['KEY_A'], keepOriginalKey: true })
  assert.equal(section.entry.id, 'rate-limit-guard')
  const tree = await render(section.Component, section.entry.inject())
  const all = texts(tree)
  assert.ok(!all.some((s) => s.startsWith('MISSING:')), all.filter((s) => s.startsWith('MISSING:')).join(', '))
  for (const key of ['keepOriginalKey', 'quotaCooldownMinutes', 'jitter', 'waitOnQuota']) assert.ok(all.includes(key), key)
  // the backup reference is listed with the pool so its status is visible
  assert.ok(all.includes('DEEPSEEK_API_KEY_RLG_ORIGINAL'))
})

test('saving rejects invalid reference names and writes the new fields otherwise', async () => {
  const bad = boot({ mode: 'rotate', credentialRef: 'MY-KEY' })
  let tree = await bad.render(bad.section.Component, bad.section.entry.inject())
  let saveButton
  walk(tree, (n) => { if (n.type === 'button' && n.children.includes('save')) saveButton = n })
  await saveButton.props.onClick()
  assert.equal(bad.mutations.length, 0)

  const good = boot({ mode: 'rotate', credentialRef: 'DEEPSEEK_API_KEY' })
  tree = await good.render(good.section.Component, good.section.entry.inject())
  walk(tree, (n) => { if (n.type === 'button' && n.children.includes('save')) saveButton = n })
  await saveButton.props.onClick()
  assert.equal(good.mutations.length, 1)
  const paths = good.mutations[0].map((op) => op.path[0])
  for (const field of ['jitter', 'waitOnQuota', 'quotaCooldownMinutes', 'keepOriginalKey']) assert.ok(paths.includes(field), field)
})

test('saving accepts "provider=-" as a no-rotation mapping', async () => {
  const b = boot({ mode: 'rotate', credentialRef: 'DEEPSEEK_API_KEY', providerRefs: ['lan-qwen=-', 'intern=INTERN_API_KEY'] })
  const tree = await b.render(b.section.Component, b.section.entry.inject())
  let saveButton
  walk(tree, (n) => { if (n.type === 'button' && n.children.includes('save')) saveButton = n })
  await saveButton.props.onClick()
  assert.equal(b.mutations.length, 1)
  assert.ok(texts(tree).includes('INTERN_API_KEY'))
  assert.ok(!texts(tree).includes('-'))
})

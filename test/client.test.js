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

function boot(settingsValue, { writable = true, directory = null, namespaces = [], configured = [] } = {}) {
  const { React, render } = createReact()
  const factory = load().factory((name) => {
    assert.equal(name, 'react')
    return React
  })
  let dict
  let section
  let dock
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
    inject: (_deps, cb) => {
      cb({
        slots: {
          inject: (_name, fn) => fn(),
          register: (entry, Component) => { dock = { entry, Component } },
        },
      })
    },
    remote: {
      settings: {
        describe: async () => ({
          ok: true,
          value: {
            writable,
            namespaces: [{ ns: 'rate-limit-guard', revision: 1, value: settingsValue }, ...namespaces],
          },
        }),
        mutate: async (_ns, ops) => { mutations.push(ops); return { ok: true } },
      },
      credentials: {
        describe: async (refs) => ({
          ok: true,
          value: Object.fromEntries(refs.map((ref) => [ref, { configured: configured.includes(ref) }])),
        }),
        set: async () => ({ ok: true }),
      },
    },
  }
  // Only hosts that expose the LLM remote can enumerate the configured keys.
  if (directory) ctx.remote.llm = { listConfigurableProviders: async () => ({ ok: true, value: directory }) }
  factory.apply(ctx)
  return { dict, section, dock, render, mutations }
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
  for (const field of ['jitter', 'waitOnQuota', 'quotaCooldownMinutes', 'keepOriginalKey', 'maxTotalWaitMinutes', 'language']) assert.ok(paths.includes(field), field)
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

function choiceInput(tree, ref, type) {
  let found
  walk(tree, (node) => {
    if (found || node.type !== 'label') return
    if (!texts(node).some((text) => text.includes(ref))) return
    const input = (node.children ?? []).find((child) => child && child.type === 'input' && child.props.type === type)
    if (input) found = input
  })
  return found
}

function textareaWithRows(tree, rows) {
  let found
  walk(tree, (node) => { if (!found && node.type === 'textarea' && node.props.rows === rows) found = node })
  return found
}

function saveButtonOf(tree) {
  let found
  walk(tree, (node) => { if (node.type === 'button' && node.children.includes('save')) found = node })
  return found
}

function groupToggle(tree, title) {
  let found
  walk(tree, (node) => {
    if (found || node.type !== 'button') return
    if (node.props.className !== 'rlg-group-toggle') return
    if (texts(node).includes(title)) found = node
  })
  return found
}

function searchInput(tree) {
  let found
  walk(tree, (node) => { if (!found && node.type === 'input' && node.props.type === 'search') found = node })
  return found
}

function groupCount(tree) {
  let total = 0
  walk(tree, (node) => { if (node.type === 'button' && node.props.className === 'rlg-group-toggle') total += 1 })
  return total
}

function pickerOf(tree, index) {
  const found = []
  walk(tree, (node) => {
    if (node.type !== 'div') return
    if (!String(node.props.className ?? '').split(' ').includes('rlg-picker')) return
    found.push(node)
  })
  return found[index]
}

const pickerDirectory = [
  { provider: 'deepseek-api-key', displayName: 'DeepSeek', settingsNs: 'deepseek-api-key', settingsPath: [] },
  { provider: 'openrouter', displayName: 'OpenRouter', settingsNs: 'pi-ai', settingsPath: ['providers', 'openrouter'] },
  { provider: 'deepseek-account', displayName: 'Desktop account', settingsNs: 'deepseek-account', settingsPath: [] },
]

const pickerNamespaces = [
  { ns: 'deepseek-api-key', revision: 1, value: { apiKeyEnv: 'DEEPSEEK_API_KEY' } },
  { ns: 'pi-ai', revision: 1, value: { providers: { openrouter: { apiKeyEnv: 'OPENROUTER_API_KEY' } } } },
  { ns: 'deepseek-account', revision: 1, value: {} },
]

test('key picker lists the references DSH has configured', async () => {
  const b = boot({ mode: 'rotate', credentialRef: 'DEEPSEEK_API_KEY' }, {
    directory: pickerDirectory,
    namespaces: pickerNamespaces,
    configured: ['OPENROUTER_API_KEY'],
  })
  const tree = await b.render(b.section.Component, b.section.entry.inject())
  const all = texts(tree)
  const labels = all.filter((text) => text.includes('OPENROUTER_API_KEY'))
  assert.ok(labels.length > 0, 'the OpenRouter reference is offered')
  assert.ok(labels.some((text) => text.includes('OpenRouter')), 'the provider name is shown')
  assert.ok(!all.some((text) => text.includes('deepseek-account')), 'account providers are not offered')
  assert.ok(all.includes('keyConfigured'), 'the configured badge is shown')
  assert.ok(all.includes('keyPoolTitle'), 'the rotation pool section renders')
})

test('the rotation pool is a manual list and saving writes alternateKeyRefs', async () => {
  const b = boot({ mode: 'rotate', credentialRef: 'DEEPSEEK_API_KEY' }, {
    directory: pickerDirectory,
    namespaces: pickerNamespaces,
    configured: ['OPENROUTER_API_KEY'],
  })
  let tree = await b.render(b.section.Component, b.section.entry.inject())
  assert.equal(choiceInput(tree, 'OPENROUTER_API_KEY', 'checkbox'), undefined, 'provider keys are not pool checkboxes')
  assert.ok(texts(tree).includes('keyPoolManualHint'), 'the manual-slot explanation is shown')
  const area = textareaWithRows(tree, 3)
  assert.ok(area, 'the manual pool textarea is rendered')
  area.props.onChange({ target: { value: 'KEY_A\nKEY_B' } })
  tree = await b.render(b.section.Component, b.section.entry.inject())

  await saveButtonOf(tree).props.onClick()
  assert.equal(b.mutations.length, 1)
  const ops = b.mutations[0]
  assert.deepEqual([...ops.find((op) => op.path[0] === 'alternateKeyRefs').value], ['KEY_A', 'KEY_B'])
  assert.equal(ops.find((op) => op.path[0] === 'credentialRef').value, 'DEEPSEEK_API_KEY')
})

test('choosing a key as the target removes it from the pool', async () => {
  const b = boot({ mode: 'rotate', credentialRef: 'DEEPSEEK_API_KEY', alternateKeyRefs: ['OPENROUTER_API_KEY'] }, {
    directory: pickerDirectory,
    namespaces: pickerNamespaces,
    configured: ['OPENROUTER_API_KEY'],
  })
  let tree = await b.render(b.section.Component, b.section.entry.inject())
  const radio = choiceInput(tree, 'OPENROUTER_API_KEY', 'radio')
  assert.ok(radio, 'target radio rendered')
  radio.props.onChange({ target: { checked: true } })
  tree = await b.render(b.section.Component, b.section.entry.inject())

  await saveButtonOf(tree).props.onClick()
  const ops = b.mutations[0]
  assert.equal(ops.find((op) => op.path[0] === 'credentialRef').value, 'OPENROUTER_API_KEY')
  assert.deepEqual([...ops.find((op) => op.path[0] === 'alternateKeyRefs').value], [])
})

test('without the LLM remote the picker falls back to manual references', async () => {
  const b = boot({ mode: 'rotate', credentialRef: 'DEEPSEEK_API_KEY' })
  const tree = await b.render(b.section.Component, b.section.entry.inject())
  const all = texts(tree)
  assert.ok(all.includes('keySourceUnavailable'))
  assert.ok(all.some((text) => text.includes('DEEPSEEK_API_KEY')), 'the manual target still renders')
})


test('the picker hides providers whose key is not configured', async () => {
  const b = boot({ mode: 'rotate', credentialRef: 'DEEPSEEK_API_KEY' }, {
    directory: pickerDirectory,
    namespaces: pickerNamespaces,
    configured: ['OPENROUTER_API_KEY'],
  })
  const tree = await b.render(b.section.Component, b.section.entry.inject())
  const picker = pickerOf(tree, 0)
  assert.equal(groupCount(picker), 1, 'only the configured provider is grouped')
  assert.ok(groupToggle(picker, 'OpenRouter'), 'the configured provider is offered')
  assert.ok(!groupToggle(picker, 'DeepSeek'), 'the provider without a key is hidden')
})

test('clicking a group title collapses and expands its options', async () => {
  const b = boot({ mode: 'rotate', credentialRef: 'DEEPSEEK_API_KEY' }, {
    directory: pickerDirectory,
    namespaces: pickerNamespaces,
    configured: ['OPENROUTER_API_KEY'],
  })
  let tree = await b.render(b.section.Component, b.section.entry.inject())
  assert.ok(choiceInput(pickerOf(tree, 0), 'OPENROUTER_API_KEY', 'radio'), 'open by default')
  groupToggle(pickerOf(tree, 0), 'OpenRouter').props.onClick()
  tree = await b.render(b.section.Component, b.section.entry.inject())
  assert.equal(choiceInput(pickerOf(tree, 0), 'OPENROUTER_API_KEY', 'radio'), undefined, 'collapsed hides the option')
  groupToggle(pickerOf(tree, 0), 'OpenRouter').props.onClick()
  tree = await b.render(b.section.Component, b.section.entry.inject())
  assert.ok(choiceInput(pickerOf(tree, 0), 'OPENROUTER_API_KEY', 'radio'), 'expands again')
})

test('search filters options and reports an empty result', async () => {
  const b = boot({ mode: 'rotate', credentialRef: 'DEEPSEEK_API_KEY' }, {
    directory: pickerDirectory,
    namespaces: pickerNamespaces,
    configured: ['OPENROUTER_API_KEY'],
  })
  let tree = await b.render(b.section.Component, b.section.entry.inject())
  searchInput(pickerOf(tree, 0)).props.onChange({ target: { value: 'zzz' } })
  tree = await b.render(b.section.Component, b.section.entry.inject())
  assert.equal(groupCount(pickerOf(tree, 0)), 0, 'no group matches')
  assert.ok(texts(pickerOf(tree, 0)).includes('keyNoMatch'))
  searchInput(pickerOf(tree, 0)).props.onChange({ target: { value: 'openrouter' } })
  tree = await b.render(b.section.Component, b.section.entry.inject())
  assert.ok(choiceInput(pickerOf(tree, 0), 'OPENROUTER_API_KEY', 'radio'), 'the match is shown while searching')
})

test('pool references show as tags and can be removed from the tag itself', async () => {
  const b = boot({ mode: 'rotate', credentialRef: 'DEEPSEEK_API_KEY', alternateKeyRefs: ['OPENROUTER_API_KEY'] }, {
    directory: pickerDirectory,
    namespaces: pickerNamespaces,
    configured: ['OPENROUTER_API_KEY'],
  })
  let tree = await b.render(b.section.Component, b.section.entry.inject())
  let chip
  walk(tree, (node) => {
    if (!chip && node.type === 'button' && node.props.className === 'rlg-chip-x') chip = node
  })
  assert.ok(chip, 'a removable tag is rendered')
  chip.props.onClick()
  tree = await b.render(b.section.Component, b.section.entry.inject())
  await saveButtonOf(tree).props.onClick()
  assert.deepEqual([...b.mutations[0].find((op) => op.path[0] === 'alternateKeyRefs').value], [])
})

function fakeEventSource() {
  const listeners = new Set()
  let snapshot = { change: null }
  return {
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    getSnapshot() { return snapshot },
    push(event) {
      snapshot = { change: { kind: 'append', entries: [{ event }] } }
      for (const fn of [...listeners]) fn()
    },
  }
}

test('truncation banner offers manual continue when unattended is off', async () => {
  const b = boot({ unattended: false, continueText: '继续' })
  assert.equal(b.dock.entry.name, 'conversation.input.dock')
  assert.equal(b.dock.entry.id, 'rate-limit-guard-truncation')
  const eventSource = fakeEventSource()
  const input = { setDraft: () => {}, focus() {} }
  const api = { read: async () => ({ view: { value: { unattended: false, continueText: '继续' } }, writable: true }) }
  const props = { api, t: (key) => key, binding: { eventSource }, input }
  let tree = await b.render(b.dock.Component, props)
  assert.equal(tree, null)
  eventSource.push({ type: 'turn/end', data: { turn: 1, reason: { kind: 'max-tokens' } } })
  await new Promise((resolve) => setTimeout(resolve, 10))
  tree = await b.render(b.dock.Component, props)
  let fill
  walk(tree, (n) => { if (n.type === 'button' && n.children.includes('bannerFill')) fill = n })
  assert.ok(fill, 'fill button rendered')
  let drafted
  input.setDraft = (text) => { drafted = text }
  fill.props.onClick()
  assert.equal(drafted, '继续')
})

test('truncation banner stays hidden in unattended mode', async () => {
  const b = boot({ unattended: true })
  const eventSource = fakeEventSource()
  const api = { read: async () => ({ view: { value: { unattended: true } }, writable: true }) }
  const props = { api, t: (key) => key, binding: { eventSource }, input: { setDraft() {}, focus() {} } }
  await b.render(b.dock.Component, props)
  eventSource.push({ type: 'turn/end', data: { turn: 1, reason: { kind: 'max-tokens' } } })
  await new Promise((resolve) => setTimeout(resolve, 10))
  const tree = await b.render(b.dock.Component, props)
  assert.equal(tree, null)
})

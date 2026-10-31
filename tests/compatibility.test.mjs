import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'

function fixture({ accept = true, credentialAccept = true, served = true } = {}) {
  let plugin
  const effects = []
  const registrations = new Set()
  const listeners = new Set()
  const writes = []
  const keyWrites = []
  // Minimal React stand-in: the bundle only ever calls createElement, and
  // function components are expanded eagerly so the resulting tree is exactly
  // the host elements the Plugins page contract is checked against.
  const react = {
    createElement(type, props, ...children) {
      const args = { ...(props ?? {}), children }
      if (typeof type === 'function') return type(args)
      return { type, props: props ?? {}, children }
    },
    useState: value => [value, () => {}],
  }
  const window = { __ModuleLoader__: { load: row => {
    // The browser bundle is keyed by package name; an isolated Desktop copy must
    // register its own name, never the Web profile's.
    assert.equal(row.id, '@dsh-external/dsh-web-search-multi-desktop')
    plugin = row.factory(id => { assert.equal(id, 'react'); return react })
  } } }
  runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), { window })
  let snapshot = { status: 'ready', writable: true, value: { enabled: true, apiKeyEnv: 'TAVILY_API_KEY' }, user: {} }
  const form = {
    getSnapshot: () => snapshot,
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn) },
    async set(field, value) {
      writes.push(['set', field, value])
      if (accept) snapshot = { ...snapshot, value: { ...snapshot.value, [field]: value } }
      for (const fn of listeners) fn()
      return accept
    },
    async unset(field) { writes.push(['unset', field]); for (const fn of listeners) fn(); return accept },
  }
  plugin.apply({
    effect: fn => { const off = fn(); if (off) effects.push(off); return off },
    configForms: {
      get: ns => { assert.equal(ns, 'web-search-multi'); return form },
      whileServed: (names, register) => { assert.equal(names[0], 'web-search-multi'); return served ? register(new Set(names)) : () => {} },
    },
    remote: { credentials: {
      describe: async () => ({ ok: true, value: {} }),
      set: async (ref, value) => { keyWrites.push([ref, value]); return { ok: credentialAccept } },
    } },
    slots: {
      inject: (name, fn) => { assert.equal(name, 'plugins.item'); return fn() },
      register(options) { registrations.add(options); return () => registrations.delete(options) },
    },
  })
  const entry = [...registrations][0]
  const face = entry?.inject()
  const component = plugin.TavilyCard
  /** Render the registered component the way the `plugins.item` slot does. */
  const render = (view) => component({
    view,
    useTavilyCard: selector => selector(face.hooks.tavilyCard.getSnapshot()),
    edit: (field, raw) => { face.edit(field, raw) },
    resetField: field => { face.resetField(field) },
    save: () => face.save(),
    discard: () => { face.discard() },
  })
  return { entry, face, component, render, writes, keyWrites, listeners, registrations, dispose: () => effects.reverse().forEach(off => off()) }
}

/** Every element type in a rendered tree. */
function typesIn(node, seen = []) {
  if (node === null || node === undefined || typeof node !== 'object') return seen
  if (typeof node.type === 'string') seen.push(node.type)
  for (const child of node.children ?? []) typesIn(child, seen)
  return seen
}

/** Every string in a rendered tree. */
function textIn(node, seen = []) {
  if (typeof node === 'string') { seen.push(node); return seen }
  if (node === null || node === undefined || typeof node !== 'object') return seen
  for (const child of node.children ?? []) textIn(child, seen)
  return seen
}

test('Plugins page is named, namespace-gated and subscription is disposed', () => {
  const f = fixture()
  assert.ok(f.entry.label().includes('Tavily'))
  assert.equal(f.face.hooks.tavilyCard.getSnapshot().available, true)
  assert.equal(f.listeners.size, 1)
  f.dispose()
  assert.equal(f.listeners.size, 0)
  assert.equal(f.registrations.size, 0)
  const absent = fixture({ served: false })
  assert.equal(absent.entry, undefined)
  absent.dispose()
})

test('configForms false results show failure and preserve staged values', async () => {
  const f = fixture({ accept: false })
  f.face.edit('enabled', 'false')
  await f.face.save()
  const state = f.face.hooks.tavilyCard.getSnapshot()
  assert.equal(state.failed, true)
  assert.equal(state.dirty, true)
  assert.equal(state.enabled.staged, 'false')
  assert.equal(state.enabled.effective, 'true')
  f.dispose()
})

test('credential refusals are reported, not silently accepted', async () => {
  const f = fixture({ credentialAccept: false })
  f.face.edit('apiKey', 'local-fake-key')
  await f.face.save()
  assert.equal(f.face.hooks.tavilyCard.getSnapshot().failed, true)
  assert.equal(f.face.hooks.tavilyCard.getSnapshot().dirty, true)
  assert.deepEqual(f.writes, [], 'key material never enters settings')
  f.dispose()
})

test('combined reference/key saves target the new reference and clear accepted drafts', async () => {
  const f = fixture()
  f.face.edit('apiKeyEnv', 'CUSTOM_TAVILY')
  f.face.edit('apiKey', 'local-fake-key')
  f.face.edit('enabled', 'false')
  await f.face.save()
  assert.deepEqual(f.keyWrites, [['CUSTOM_TAVILY', 'local-fake-key']])
  assert.deepEqual(f.writes, [['set', 'apiKeyEnv', 'CUSTOM_TAVILY'], ['set', 'enabled', false]])
  assert.equal(f.face.hooks.tavilyCard.getSnapshot().failed, false)
  assert.equal(f.face.hooks.tavilyCard.getSnapshot().dirty, false)
  f.dispose()
})

// The Plugins list renders `label` as the card title and `view: "summary"` as
// the one-liner beneath it (plugin-manager ItemCard -> CardHead). Returning any
// card chrome here duplicated the title and nested a second card in the row.
test('the list row gets a bare one-liner, never a repeated title or a nested card', () => {
  const f = fixture()
  const summary = f.render('summary')
  assert.equal(typeof summary, 'string', 'summary view must be the row description')
  assert.ok(summary.includes('web_search'), `unexpected summary: ${summary}`)
  assert.ok(!summary.includes(f.entry.label()), 'the summary must not repeat the card title')
  f.dispose()
})

test('the plugin page renders the form, without a second title or a list item', () => {
  const f = fixture()
  const page = f.render('page')
  const types = typesIn(page)
  assert.ok(types.length > 0, 'page view must render the settings form')
  assert.ok(!types.includes('li'), `page view must not render a list item, saw: ${types.join(',')}`)
  const texts = textIn(page)
  assert.ok(!texts.includes(f.entry.label()), 'the page renders the title itself; the form must not repeat it')
  for (const section of ['Tavily', 'Exa', 'DeepSeek 原生搜索']) {
    assert.ok(texts.includes(section), `missing section: ${section}`)
  }
  for (const action of ['保存', '放弃修改']) {
    assert.ok(texts.includes(action), `missing action: ${action}`)
  }
  f.dispose()
})

test('unsaved changes stay visible after the card header was dropped', () => {
  const f = fixture()
  f.face.edit('enabled', 'false')
  assert.ok(textIn(f.render('page')).includes('有未保存的修改'), 'dirty state must remain visible in the form footer')
  f.dispose()
})

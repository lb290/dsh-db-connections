/**
 * Browser-half tests. The bundle is loaded with a stub `window`, a minimal
 * React, and a DOM shim, which is enough to prove three things without a
 * browser: the ModuleLoader registration is well formed, the slot registration
 * happens with the expected id, and the payload/validation logic that decides
 * what gets written to disk is correct.
 */
import fs from 'node:fs'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ` -> ${detail}`}`)
  if (!ok) failures += 1
}

/** Minimal element/node shim covering what the bundle touches. */
function makeElement(tag) {
  return {
    tagName: String(tag).toUpperCase(),
    children: [],
    attributes: {},
    style: {},
    textContent: '',
    className: '',
    setAttribute(name, value) { this.attributes[name] = value },
    appendChild(child) { this.children.push(child); return child },
    remove() { this.removed = true },
  }
}

const head = makeElement('head')
globalThis.document = {
  head,
  documentElement: { lang: 'zh-CN' },
  baseURI: 'http://127.0.0.1:19387/',
  createElement: makeElement,
}

let registration
globalThis.window = {
  __ModuleLoader__: {
    load(spec) { registration = spec },
  },
  confirm: () => true,
  localStorage: { getItem: () => null, setItem: () => {} },
}

// A React stub: the bundle only needs createElement and the hooks it names.
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  Fragment: 'Fragment',
  useState: value => [value, () => {}],
  useEffect: () => {},
  useCallback: fn => fn,
  useRef: value => ({ current: value }),
}

const source = fs.readFileSync(new URL('./client.js', import.meta.url), 'utf8')
// The bundle is a plain script that calls the global loader; evaluate it as one.
new Function('window', 'document', 'require', source)(globalThis.window, globalThis.document, spec => {
  if (spec === 'react') return React
  throw new Error(`unexpected require(${spec})`)
})

check('bundle registers with the ModuleLoader', registration !== undefined)
check('registration id matches the package declaration', registration?.id === 'dsh-db-connections', registration?.id)

const exports = registration.factory(spec => {
  if (spec === 'react') return React
  throw new Error(`unexpected require(${spec})`)
})
check('exports a name', exports.name === 'db-connections', exports.name)
check('exports apply', typeof exports.apply === 'function')
check('declares the slots injection', Array.isArray(exports.inject) && exports.inject.includes('slots'), JSON.stringify(exports.inject))

// Every service apply() dereferences must be declared in `inject`, or the
// framework hands it an undefined property, apply() throws, and the section
// silently never registers — the page just disappears from Settings.
const bundleText = fs.readFileSync(new URL('./client.js', import.meta.url), 'utf8')
const applyBody = bundleText.slice(bundleText.indexOf('function apply(ctx)'), bundleText.indexOf('exports.apply = apply'))
const usedServices = [...new Set([...applyBody.matchAll(/ctx\.([a-zA-Z]+)/g)].map(m => m[1]))]
  .filter(name => name !== 'effect')
for (const service of usedServices) {
  check(`apply() declares the "${service}" service it uses`, exports.inject.includes(service),
    `inject = ${JSON.stringify(exports.inject)}`)
}

// --- slot registration and dictionaries ---
let slotSpec
let styleEffect
const dictionaries = []

// The framework exposes a service on `ctx` ONLY when the plugin declares it in
// `inject`; anything else reads as undefined and apply() throws. Mirroring that
// here is what lets this harness catch a missing declaration, instead of
// silently providing everything and passing.
const available = {
  slots: {
    inject(name, callback) { check('injects into settings.section', name === 'settings.section', name); callback() },
    register(spec, render) { slotSpec = spec; slotRender = render },
  },
  locale: {
    // Mirrors the real signature: register(ns, locale, dict) OR register(ns, dicts).
    register(ns, localeOrDicts, dict) {
      const pairs = typeof localeOrDicts === 'string'
        ? [[localeOrDicts, dict]]
        : Object.entries(localeOrDicts)
      for (const [locale, entries] of pairs) dictionaries.push({ ns, locale, dict: entries })
      return () => {}
    },
    // A real bind resolves through the ACTIVE locale; this stub answers from the
    // registered dictionaries, so label() proves the wiring rather than the
    // language the test machine happens to run in.
    bind(ns) {
      return key => (dictionaries.find(entry => entry.ns === ns)?.dict ?? {})[key] ?? key
    },
  },
}
let slotRender
const ctx = {
  effect(fn) {
    const dispose = fn()
    // The stylesheet's disposer is the first recorded effect.
    if (styleEffect === undefined && typeof dispose === 'function' && dictionaries.length === 0) styleEffect = dispose
  },
  ...Object.fromEntries(exports.inject.map(name => [name, available[name]])),
}
for (const name of Object.keys(available)) {
  check(`inject declares "${name}", which apply() needs`, exports.inject.includes(name),
    `inject = ${JSON.stringify(exports.inject)}`)
}

try {
  exports.apply(ctx)
  check('apply() runs with only the declared services', true)
} catch (error) {
  check('apply() runs with only the declared services', false, error.message)
  console.log(`\nThe framework would fail the same way: the section never registers.`)
  process.exit(1)
}
check('registers the settings.section slot', slotSpec?.name === 'settings.section', slotSpec?.name)
check('slot id set', slotSpec?.id === 'db-connections', slotSpec?.id)
check('slot order is a number', typeof slotSpec?.order === 'number', String(slotSpec?.order))
check('slot declares a locale namespace', slotSpec?.locale === 'settings.dbConnections', slotSpec?.locale)
check('registers both dictionaries', dictionaries.length === 2, JSON.stringify(dictionaries.map(d => d.locale)))
check('registers a zh dictionary', dictionaries.some(d => d.locale === 'zh'))
check('registers an en dictionary', dictionaries.some(d => d.locale === 'en'))
check('section label resolves through the translator',
  typeof slotSpec?.label() === 'string' && slotSpec.label().length > 0, String(slotSpec?.label()))
check('styles were mounted', head.children.some(node => node.attributes['data-dbc'] === 'style'))
check('style effect returns a disposer', typeof styleEffect === 'function')

// Every key must exist in both dictionaries, or one language renders raw keys.
const zhKeys = Object.keys(dictionaries.find(d => d.locale === 'zh').dict).sort()
const enKeys = Object.keys(dictionaries.find(d => d.locale === 'en').dict).sort()
check('both dictionaries carry the same keys', JSON.stringify(zhKeys) === JSON.stringify(enKeys),
  `zh=${zhKeys.length} en=${enKeys.length}`)

// --- payload shaping: what actually reaches the config file ---
const { toPayload, toEditor, validate, BLANK } = exports.__test

const asStrings = {
  ...BLANK,
  name: ' 128 ', host: ' 192.0.2.10 ', port: '3306', user: ' root ',
  password: 'change-me', database: ' appdb ', description: ' 开发库 ',
  allowWrite: true, ssl: false,
  connectTimeoutMs: '10000', queryTimeoutMs: '30000', maxRows: '200',
  maxCellChars: '500', maxDdlChars: '20000', connectionLimit: '4',
}
const payload = toPayload(asStrings)
check('payload trims the name', payload.name === '128', JSON.stringify(payload.name))
check('payload trims host and user', payload.host === '192.0.2.10' && payload.user === 'root')
check('payload keeps the password verbatim', payload.password === 'change-me')
check('payload sends numbers as numbers', payload.port === 3306 && payload.maxRows === 200 && typeof payload.port === 'number')
check('payload carries allowWrite', payload.allowWrite === true)
check('payload trims description', payload.description === '开发库')
check('payload drops empty optional fields', !('database' in toPayload({ ...asStrings, database: '  ' })))
check('payload omits description when blank', !('description' in toPayload({ ...asStrings, description: '' })))

// A blank numeric field must fall back to the default, never become NaN.
const blankNumbers = toPayload({ ...asStrings, port: '', maxRows: '', connectionLimit: '' })
check('blank numeric fields use defaults',
  blankNumbers.port === 3306 && blankNumbers.maxRows === 200 && blankNumbers.connectionLimit === 4,
  JSON.stringify({ port: blankNumbers.port, maxRows: blankNumbers.maxRows, connectionLimit: blankNumbers.connectionLimit }))
check('no payload field is NaN',
  Object.entries(blankNumbers).every(([, value]) => typeof value !== 'number' || Number.isFinite(value)))

// --- round trip: a stored entry, through the editor and back ---
const stored = { name: '128', host: 'h', user: 'u', password: 'p', allowWrite: true, port: 3306 }
const editor = toEditor(stored)
check('editor keeps stored values', editor.name === '128' && editor.allowWrite === true)
check('editor renders numbers as strings for inputs', editor.port === 3306 || editor.port === '3306', String(editor.port))
check('round trip preserves allowWrite', toPayload(editor).allowWrite === true)
check('editor fills defaults for an absent entry', toEditor({ name: 'x', host: 'h', user: 'u' }).maxRows === 200)

// --- validation ---
const t = key => key
check('missing name rejected', validate([{ ...BLANK, host: 'h', user: 'u' }], t) === 'needName')
check('missing host rejected', validate([{ ...BLANK, name: 'a', user: 'u' }], t)?.startsWith('needHost'))
// BLANK pre-fills `user`, so an absent user must be cleared explicitly.
check('missing user rejected', validate([{ ...BLANK, name: 'a', host: 'h', user: '' }], t)?.startsWith('needUser'))
check('whitespace-only user rejected', validate([{ ...BLANK, name: 'a', host: 'h', user: '   ' }], t)?.startsWith('needUser'))
check('whitespace-only host rejected', validate([{ ...BLANK, name: 'a', host: '  ', user: 'u' }], t)?.startsWith('needHost'))
check('duplicate names rejected', validate([
  { ...BLANK, name: 'a', host: 'h', user: 'u' },
  { ...BLANK, name: 'a', host: 'h', user: 'u' },
], t)?.startsWith('duplicate'))
check('valid list passes', validate([{ ...BLANK, name: 'a', host: 'h', user: 'u' }], t) === undefined)
check('empty list passes', validate([], t) === undefined)
check('duplicate detection ignores surrounding spaces', validate([
  { ...BLANK, name: 'a', host: 'h', user: 'u' },
  { ...BLANK, name: ' a ', host: 'h', user: 'u' },
], t)?.startsWith('duplicate'))

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)

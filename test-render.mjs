/**
 * Render test for the settings page.
 *
 * Drives the component with a small hook-aware renderer instead of a browser, so
 * the page's real behaviour is exercised: the list loads over the API, editing a
 * field marks the page dirty, the access dropdown flips a connection between
 * read-only and read-write, Test probes, Add appends, and Save posts exactly the
 * payload the store writes to disk.
 */
import fs from 'node:fs'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ` -> ${detail}`}`)
  if (!ok) failures += 1
}

// ── DOM shim ────────────────────────────────────────────────────────────────
function makeElement(tag) {
  return {
    tagName: String(tag).toUpperCase(), children: [], attributes: {}, style: {},
    textContent: '', className: '',
    setAttribute(n, v) { this.attributes[n] = v },
    appendChild(c) { this.children.push(c); return c },
    remove() { this.removed = true },
  }
}
globalThis.document = {
  head: makeElement('head'),
  documentElement: { lang: 'zh-CN' },
  baseURI: 'http://127.0.0.1:19387/',
  createElement: makeElement,
}
globalThis.window = {
  __ModuleLoader__: { load(spec) { globalThis.__registration = spec } },
  confirm: () => true,
  localStorage: { getItem: () => null, setItem: () => {} },
}

// ── hook-aware renderer ─────────────────────────────────────────────────────
/**
 * Build a renderer owning one React-hook slot table.
 * @returns {object} mount/settle plus the internal hook table.
 */
function createHarness() {
  const slots = []
  let cursor = 0
  let pendingEffects = []
  let dirty = false
  let tree = null
  let component = null

  const hooks = {
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], next => {
        slots[index] = typeof next === 'function' ? next(slots[index]) : next
        dirty = true
      }]
    },
    useRef(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = { current: initial }
      return slots[index]
    },
    useEffect(fn, deps) {
      const index = cursor++
      const previous = slots[index]
      const changed = previous === undefined || deps === undefined || previous.deps === undefined
        || deps.length !== previous.deps.length
        || deps.some((dep, i) => !Object.is(dep, previous.deps[i]))
      if (changed) {
        previous?.cleanup?.()
        slots[index] = { deps, run: fn, cleanup: undefined }
        pendingEffects.push(index)
      }
    },
    useCallback(fn, deps) {
      // Mirror React's memo so effect dependencies behave realistically.
      const index = cursor++
      const previous = slots[index]
      const changed = previous === undefined || deps === undefined || previous.deps === undefined
        || deps.length !== previous.deps.length
        || deps.some((dep, i) => !Object.is(dep, previous.deps[i]))
      if (changed) slots[index] = { deps, fn }
      return slots[index].fn
    },
  }

  // Children arrive as varargs that may themselves contain arrays (from
  // `list.map(...)`), so flatten before walking; React would do the same.
  const flatten = items => items.flat(Infinity).map(renderNode).filter(Boolean)

  function renderNode(node) {
    if (node === null || node === undefined || typeof node === 'boolean') return null
    if (typeof node === 'string' || typeof node === 'number') return { text: String(node), children: [] }
    if (Array.isArray(node)) return flatten(node)
    const { type, props, children } = node
    if (typeof type === 'function') {
      if (type === hooks.Fragment) return flatten(children ?? [])
      return renderNode(type({ ...props, children }))
    }
    return { type, props: props ?? {}, children: flatten(children ?? []) }
  }

  const render = () => {
    cursor = 0
    pendingEffects = []
    tree = renderNode(component())
    for (const index of pendingEffects) {
      const cleanup = slots[index].run()
      slots[index].cleanup = typeof cleanup === 'function' ? cleanup : undefined
    }
    dirty = false
    return tree
  }

  return {
    hooks,
    mount(componentFn) { component = componentFn; return render() },
    async settle(rounds = 20) {
      for (let i = 0; i < rounds; i += 1) {
        await new Promise(resolve => setTimeout(resolve, 0))
        if (!dirty) break
        render()
      }
      return tree
    },
    get tree() { return tree },
  }
}

// ── tree helpers ────────────────────────────────────────────────────────────
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node.text === 'string') return node.text
  return (node.children ?? []).map(textOf).join(' ')
}
function findAll(node, predicate, out = []) {
  if (node === null || node === undefined) return out
  if (node.type !== undefined && predicate(node)) out.push(node)
  for (const child of node.children ?? []) findAll(child, predicate, out)
  return out
}
const buttonNamed = (tree, label) => findAll(tree, n => n.type === 'button').find(b => textOf(b).trim() === label)

// ── load the bundle with the hook table already bound ───────────────────────
const harness = createHarness()
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  Fragment: 'Fragment',
  useState: initial => harness.hooks.useState(initial),
  useEffect: (fn, deps) => harness.hooks.useEffect(fn, deps),
  useCallback: (fn, deps) => harness.hooks.useCallback(fn, deps),
  useRef: initial => harness.hooks.useRef(initial),
}

const source = fs.readFileSync(new URL('./client.js', import.meta.url), 'utf8')
new Function('window', 'document', 'require', source)(globalThis.window, globalThis.document, spec => {
  if (spec === 'react') return React
  throw new Error(`unexpected require(${spec})`)
})

const exports = globalThis.__registration.factory(spec => {
  if (spec === 'react') return React
  throw new Error(`unexpected require(${spec})`)
})

let slotRender
const dictionaries = []
// The framework injects `t` from the locale service; this stub mirrors that by
// answering from the registered dictionaries, so the page renders the labels a
// Chinese shell shows.
const zhDict = () => dictionaries.find(entry => entry.locale === 'zh')?.dict ?? {}
const ctx = {
  effect(fn) { fn() },
  slots: {
    inject(name, cb) { cb() },
    register(spec, render) { slotRender = render },
  },
  locale: {
    // Mirrors the real signature: register(ns, locale, dict) OR register(ns, dicts).
    register(ns, localeOrDicts, dict) {
      const pairs = typeof localeOrDicts === 'string'
        ? [[localeOrDicts, dict]]
        : Object.entries(localeOrDicts)
      for (const [locale, entries] of pairs) dictionaries.push({ locale, dict: entries })
      return () => {}
    },
    bind() { return key => zhDict()[key] ?? key },
  },
}
exports.apply(ctx)
check('slot render captured', typeof slotRender === 'function')
check('dictionaries registered', dictionaries.length === 2, `${dictionaries.length}`)

// ── stub the API ────────────────────────────────────────────────────────────
const calls = []
let stored = [
  { name: '128', host: '192.0.2.10', port: 3306, user: 'root', database: 'appdb', description: '开发库', allowWrite: false, passwordSet: true, passwordSource: 'plain' },
]
const FILE = 'C:/Users/you/.dsh/profiles/desktop/cordis.patch.yml'
const DRIVERS = [
  { id: 'mysql', label: 'MySQL', defaultPort: 3306, maxRows: 200, readOnly: 'server' },
  { id: 'doris', label: 'Doris', defaultPort: 9030, maxRows: 200, readOnly: 'classify' },
  { id: 'postgres', label: 'PostgreSQL', defaultPort: 5432, maxRows: 200, readOnly: 'server' },
  { id: 'tdengine', label: 'TDengine', defaultPort: 6041, maxRows: 50, readOnly: 'classify' },
]
let revision = 'rev-1'
/** Answer the way the real API does: redacted, with a revision and the catalog. */
const redacted = list => list.map(entry => {
  const { password, ...rest } = entry
  const hasPlaintext = typeof password === 'string' && password !== ''
  const hasEnv = typeof entry.passwordEnv === 'string' && entry.passwordEnv !== ''
  return {
    ...rest,
    // A stored entry keeps reporting its own state; a payload that never had
    // the value reports what it does carry.
    passwordSet: entry.passwordSet === true || hasPlaintext || hasEnv,
    passwordSource: hasEnv ? 'env' : hasPlaintext || entry.passwordSource === 'plain' ? 'plain' : 'none',
  }
})
globalThis.fetch = async (url, options) => {
  calls.push({ url, options, body: options?.body === undefined ? undefined : JSON.parse(options.body) })
  const reply = payload => ({ ok: true, status: 200, text: async () => JSON.stringify(payload) })
  if (url.endsWith('/test')) return reply({ reachable: true, version: '8.0.46' })
  if (options?.method === 'POST') {
    stored = JSON.parse(options.body).connections
    revision = 'rev-2'
    return reply({ connections: redacted(stored), revision, problems: [], drivers: DRIVERS, file: FILE })
  }
  return reply({ connections: redacted(stored), revision, problems: [], drivers: DRIVERS, file: FILE })
}

// ── mount the page through the registered slot ──────────────────────────────
// The framework supplies `t` because the registration declares `locale: NS`;
// this harness stands in for that injection.
const props = { close: () => {}, t: key => zhDict()[key] ?? key }
harness.mount(() => slotRender(props))
await harness.settle()

const tree = harness.tree
const allText = textOf(tree)
const inputs = () => findAll(harness.tree, n => n.type === 'input')
const selects = () => findAll(harness.tree, n => n.type === 'select')
const LABEL = { save: '保存', add: '新增连接', reload: '重新加载', test: '测试', remove: '删除' }

check('page renders after loading', tree !== null)
check('page fetched the connection list', calls.some(c => c.url.endsWith('/api/db-connections')))
check('page left the loading state', !allText.includes('正在加载'), allText.slice(0, 80))
check('page shows the host in an input', inputs().some(i => i.props.value === '192.0.2.10'),
  JSON.stringify(inputs().map(i => i.props.value).slice(0, 8)))
check('page shows the connection name in an input', inputs().some(i => i.props.value === '128'))
// The API never sends a stored password, so the page can never render one.
check('page never renders a stored password', inputs().every(i => i.props.value !== 'change-me'),
  JSON.stringify(inputs().map(i => i.props.value)))
check('the password input is a password field', inputs().some(i => i.props.type === 'password'))
check('the page says a password is saved', allText.includes('已保存'), allText.slice(0, 120))
check('page offers the engine picker', selects().some(s => (s.children ?? []).some(o => o.props.value === 'tdengine')))
check('page shows the config file path', allText.includes('cordis.patch.yml'))
check('page shows the plaintext notice', allText.includes('明文'))

const accessSelects = () => selects().filter(s => (s.children ?? []).some(o => o.props.value === 'rw'))
const access = accessSelects()[0]
check('access dropdown rendered', access !== undefined, `${selects().length} select(s)`)
check('dropdown offers read-only and read-write', (access?.children ?? []).length === 2)
check('dropdown starts at read-only', access?.props.value === 'ro', String(access?.props.value))
check('read-only hint shown', allText.includes('只读'))

const saveClean = buttonNamed(tree, LABEL.save)
check('save button rendered', saveClean !== undefined, findAll(tree, n => n.type === 'button').map(b => textOf(b).trim()).join(','))
check('add button rendered', buttonNamed(tree, LABEL.add) !== undefined)
check('save is disabled while clean', saveClean?.props.disabled === true)

// ── flip to read-write through the real onChange ────────────────────────────
access.props.onChange({ target: { value: 'rw' } })
await harness.settle()
check('editing marks the page dirty', buttonNamed(harness.tree, LABEL.save)?.props.disabled === false)
check('dirty badge appears', textOf(harness.tree).includes('未保存'))

// ── save posts the payload the store will write ─────────────────────────────
calls.length = 0
await buttonNamed(harness.tree, LABEL.save).props.onClick()
await harness.settle()

const post = calls.find(c => c.options?.method === 'POST' && c.url.endsWith('/api/db-connections'))
check('save posted to the API', post !== undefined)
check('save sent JSON content-type', post?.options?.headers?.['content-type'] === 'application/json')
check('payload flips the connection to writable', post?.body?.connections?.[0]?.allowWrite === true,
  JSON.stringify(post?.body?.connections?.[0]))
check('payload omits the password the page never saw', post?.body?.connections?.[0]?.password === undefined,
  JSON.stringify(post?.body?.connections?.[0]))
check('payload carries the revision it read', post?.body?.revision === 'rev-1', String(post?.body?.revision))
check('payload carries the engine', post?.body?.connections?.[0]?.driver === 'mysql', String(post?.body?.connections?.[0]?.driver))
check('payload sends the port as a number', post?.body?.connections?.[0]?.port === 3306)
check('page reports saved', textOf(harness.tree).includes('已保存'))
check('save is disabled again after saving', buttonNamed(harness.tree, LABEL.save)?.props.disabled === true)

// ── the test button drives the probe route ──────────────────────────────────
calls.length = 0
await buttonNamed(harness.tree, LABEL.test).props.onClick()
await harness.settle()
const probe = calls.find(c => c.url.endsWith('/test'))
check('test posted to the probe route', probe !== undefined)
check('probe sent the connection name', probe?.body?.name === '128', JSON.stringify(probe?.body))
check('probe result is shown', textOf(harness.tree).includes('8.0.46'), textOf(harness.tree).slice(-140))

// ── add a second connection, which must default to read-only ────────────────
await buttonNamed(harness.tree, LABEL.add).props.onClick()
await harness.settle()
const cards = findAll(harness.tree, n => n.type === 'div' && n.props?.className === 'dbc_card')
check('adding creates a second card', cards.length === 2, `${cards.length} card(s)`)
check('the added connection defaults to read-only', accessSelects()[1]?.props.value === 'ro', String(accessSelects()[1]?.props.value))

// Saving an incomplete entry must be refused locally, with a clear message.
calls.length = 0
await buttonNamed(harness.tree, LABEL.save).props.onClick()
await harness.settle()
check('incomplete entry refuses to save', !calls.some(c => c.options?.method === 'POST'))
check('refusal names the missing field', textOf(harness.tree).includes('连接名不能为空'), textOf(harness.tree).slice(-120))

// ── remove drops it again ───────────────────────────────────────────────────
const removeButtons = findAll(harness.tree, n => n.type === 'button' && textOf(n).trim() === LABEL.remove)
check('each card has a remove button', removeButtons.length === 2, `${removeButtons.length}`)
await removeButtons[1].props.onClick()
await harness.settle()
check('removing drops the card',
  findAll(harness.tree, n => n.type === 'div' && n.props?.className === 'dbc_card').length === 1)

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)

/**
 * Store and API tests. The store is exercised against a COPY of a realistic
 * profile patch, so comments, other rows, and unrelated config must survive.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { ConnectionStore, ROW_ID } from './src/store.js'
import { createApiHandler } from './src/api.js'
import { resolveConnections } from './src/config.js'
import { LiveConnections } from './src/live.js'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ` -> ${detail}`}`)
  if (!ok) failures += 1
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbc-store-'))
const file = path.join(dir, 'cordis.patch.yml')
const ORIGINAL = `# Your patch layer for this dsh profile.
- id: ui-chat
  name: "@deepseek-ai/dsh-client-ui-chat"
  config:
    transcriptView: standard   # keep me
- id: db-connections
  name: "dsh-db-connections"
  config:
    connections:
      - name: "128"
        host: 192.0.2.10
        user: root
        password: "change-me"
        database: appdb
- id: ui-theme
  name: "@deepseek-ai/dsh-client-ui-theme"
  config:
    preference: dark
`
fs.writeFileSync(file, ORIGINAL, 'utf8')
const store = new ConnectionStore(dir)

// --- load ---
const loaded = store.load()
check('load returns the stored list', loaded.length === 1 && loaded[0].name === '128', JSON.stringify(loaded[0]))
check('load keeps the plaintext password', loaded[0].password === 'change-me')

// --- save: add a writable connection, change the first one ---
store.save([
  { ...loaded[0], description: '开发库', allowWrite: false },
  { name: 'prod', host: '192.0.2.9', port: 3306, user: 'app', password: 'p@ss', database: 'app_prod', allowWrite: true },
])
const afterText = fs.readFileSync(file, 'utf8')
check('other rows survive a save', afterText.includes('ui-chat') && afterText.includes('ui-theme'))
check('comments survive a save', afterText.includes('keep me'), afterText.includes('keep me') ? '' : 'comment lost')
check('header comment survives', afterText.includes('Your patch layer'))
check('annotation survives', afterText.includes('@deepseek-ai/dsh-client-ui-chat'))

const reloaded = store.load()
check('two connections after save', reloaded.length === 2, `got ${reloaded.length}`)
check('new connection persisted', reloaded[1].name === 'prod' && reloaded[1].allowWrite === true)
check('allowWrite false preserved', reloaded[0].allowWrite === false)
check('password with @ persisted', reloaded[1].password === 'p@ss')

// The saved file must be valid input for the plugin's own validator.
const normalized = resolveConnections({ connections: reloaded })
check('saved list passes config validation', normalized.length === 2)
check('writable flag survives normalization', normalized[1].allowWrite === true)

// --- save: remove everything ---
store.save([])
check('empty list round-trips', store.load().length === 0)

// --- row absent: save must create it, keeping the rest ---
const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dbc-store2-'))
fs.writeFileSync(path.join(dir2, 'cordis.patch.yml'), '- id: only-row\n  name: "@deepseek-ai/dsh-client-ui-theme"\n', 'utf8')
const store3 = new ConnectionStore(dir2)
check('absent row falls back to mounted list', store3.load([{ name: 'mounted' }]).length === 1)
store3.save([{ name: 'fresh', host: 'h', user: 'u', password: 'p' }])
const created = fs.readFileSync(path.join(dir2, 'cordis.patch.yml'), 'utf8')
check('row created when absent', created.includes(ROW_ID) && created.includes('fresh'))
check('existing row kept when creating', created.includes('only-row'))

// --- invalid YAML must fail loud, not silently overwrite ---
const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'dbc-store3-'))
fs.writeFileSync(path.join(dir3, 'cordis.patch.yml'), '- id: [unclosed\n', 'utf8')
const store4 = new ConnectionStore(dir3)
try {
  store4.load()
  check('invalid YAML rejected', false, 'no error')
} catch (error) {
  check('invalid YAML rejected', /not valid YAML/.test(error.message), error.message.slice(0, 80))
}

// --- API: same-origin, content-type, validation ---
const connections = [{ name: '128', host: '192.0.2.10', port: 3306, user: 'root', password: 'change-me' }]
const live = new LiveConnections(resolveConnections({ connections }))
const apiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbc-api-'))
// A fresh fixture: the store test above intentionally emptied the first file.
fs.writeFileSync(path.join(apiDir, 'cordis.patch.yml'), ORIGINAL, 'utf8')
const apiStore = new ConnectionStore(apiDir)
const handler = createApiHandler({
  list: () => apiStore.load(),
  replace: async raw => {
    const normalized = resolveConnections({ connections: raw })
    apiStore.save(raw)
    live.swap(normalized)
    return raw
  },
  test: async name => ({ reachable: true, version: 'probe', name }),
  file: apiStore.file,
})

const server = http.createServer((req, res) => { void handler(req, res) })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
const call = async (path, options) => {
  const response = await fetch(`${base}${path}`, options)
  return { status: response.status, body: await response.json() }
}

const get = await call('/api/db-connections')
check('GET lists connections', get.status === 200 && get.body.connections.length === 1, JSON.stringify(get.body).slice(0, 100))
check('GET reports the patch file path', typeof get.body.file === 'string' && get.body.file.endsWith('cordis.patch.yml'))

const noType = await call('/api/db-connections', { method: 'POST', body: JSON.stringify({ connections: [] }) })
check('write without JSON content-type is refused', noType.status === 415, `status ${noType.status}`)

const badJson = await call('/api/db-connections', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope',
})
check('malformed JSON is refused', badJson.status === 400, `status ${badJson.status}`)

const badShape = await call('/api/db-connections', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ connections: 'no' }),
})
check('non-list connections refused', badShape.status === 400, `status ${badShape.status}`)

const invalid = await call('/api/db-connections', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ connections: [{ name: 'x', host: 'h' }] }),
})
check('config validation surfaces through the API', invalid.status === 400 && /user is required/.test(invalid.body.error), invalid.body.error)

const crossOrigin = await call('/api/db-connections', {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
  body: JSON.stringify({ connections: [] }),
})
check('cross-origin write refused', crossOrigin.status === 403, `status ${crossOrigin.status}`)

const ok = await call('/api/db-connections', {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: base },
  body: JSON.stringify({ connections: [{ name: 'live', host: 'h', user: 'u', password: 'p', allowWrite: true }] }),
})
check('same-origin write accepted', ok.status === 200, JSON.stringify(ok.body).slice(0, 120))
check('write reached the live registry', live.connections.length === 1 && live.connections[0].name === 'live')
check('write reached the file', apiStore.load().length === 1 && apiStore.load()[0].name === 'live')

const testRoute = await call('/api/db-connections/test', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'live' }),
})
check('test route answers', testRoute.status === 200 && testRoute.body.reachable === true)

const unknownRoute = await call('/api/db-connections/nope')
check('unknown route is 404', unknownRoute.status === 404, `status ${unknownRoute.status}`)

// A failing replace must leave both the file and the live list untouched.
const before = apiStore.load()
const failing = createApiHandler({
  list: () => apiStore.load(),
  replace: async () => { throw new Error('write refused by the harness') },
  test: async () => ({}),
  file: apiStore.file,
})
const server2 = http.createServer((req, res) => { void failing(req, res) })
await new Promise(resolve => server2.listen(0, '127.0.0.1', resolve))
const bad = await (await fetch(`http://127.0.0.1:${server2.address().port}/api/db-connections`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ connections: [] }),
})).json()
check('replace failure reported as an error', /write refused/.test(bad.error), bad.error)
check('failed replace left the file untouched', JSON.stringify(apiStore.load()) === JSON.stringify(before))

// --- passwordEnv indirection must survive a save ---
//
// The settings page edits raw configuration. If it were fed normalized
// connections, `passwordEnv` would be flattened into the resolved plaintext
// password and written back to disk — silently persisting a secret that the
// deployment deliberately kept in the environment.
const dir4 = fs.mkdtempSync(path.join(os.tmpdir(), 'dbc-store4-'))
fs.writeFileSync(path.join(dir4, 'cordis.patch.yml'), `- id: db-connections
  name: "dsh-db-connections"
  config:
    connections:
      - name: prod
        host: 192.0.2.9
        user: app
        passwordEnv: DBC_TEST_SECRET
`, 'utf8')
process.env.DBC_TEST_SECRET = 'resolved-from-env'
const store5 = new ConnectionStore(dir4)
const rawEnvEntry = store5.load()
check('load returns the raw passwordEnv entry', rawEnvEntry[0].passwordEnv === 'DBC_TEST_SECRET'
  && rawEnvEntry[0].password === undefined, JSON.stringify(rawEnvEntry[0]))

store5.save([{ ...rawEnvEntry[0], description: 'touched by the page' }])
const savedEnvText = fs.readFileSync(path.join(dir4, 'cordis.patch.yml'), 'utf8')
check('passwordEnv survives a save', savedEnvText.includes('passwordEnv: DBC_TEST_SECRET'))
check('no plaintext password was written', !savedEnvText.includes('resolved-from-env'), savedEnvText)
check('the edit itself landed', savedEnvText.includes('touched by the page'))

server.close()
server2.close()
live.dispose()
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)

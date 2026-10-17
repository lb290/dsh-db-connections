/**
 * Store and settings-API tests: durable storage that preserves the rest of the
 * profile patch, owner-only file mode, a revision that refuses a lost-update
 * save, and an HTTP surface that never returns a stored password.
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createApiHandler } from '../src/api.js'
import { resolveConnections } from '../src/config.js'
import { driverChoices } from '../src/drivers/index.js'
import { LiveConnections } from '../src/live.js'
import { mergePasswords } from '../src/settings.js'
import { ConnectionStore, ROW_ID, StoreConflictError, revisionOf } from '../src/store.js'

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
check('load reports a revision', /^[0-9a-f]{16}$/u.test(store.read().revision), store.read().revision)
check('the revision follows the contents', revisionOf(ORIGINAL) === store.read().revision)

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
// Windows has no POSIX mode bits: fs.chmod there only toggles the read-only
// attribute, and statSync reports 0o666 whatever was requested, so this
// assertion cannot hold on that platform. The owner-only guarantee is a POSIX
// one; the Windows gap is recorded in TODO.md rather than asserted away.
if (process.platform === 'win32') {
  console.log('      (owner-only file mode is a POSIX guarantee; not asserted on Windows)')
} else {
  check('the patch file is owner-only after a save', (fs.statSync(file).mode & 0o777) === 0o600, (fs.statSync(file).mode & 0o777).toString(8))
}

const reloaded = store.load()
check('two connections after save', reloaded.length === 2, `got ${reloaded.length}`)
check('new connection persisted', reloaded[1].name === 'prod' && reloaded[1].allowWrite === true)
check('allowWrite false preserved', reloaded[0].allowWrite === false)
check('password with @ persisted', reloaded[1].password === 'p@ss')

// The saved file must be valid input for the plugin's own validator.
const normalized = resolveConnections({ connections: reloaded })
check('saved list passes config validation', normalized.connections.length === 2)
check('writable flag survives normalization', normalized.connections[1].allowWrite === true)

// --- the revision guard: a save derived from a stale read must be refused ---
const staleRevision = store.read().revision
fs.writeFileSync(file, `${fs.readFileSync(file, 'utf8')}# touched by something else\n`, 'utf8')
const beforeStale = fs.readFileSync(file, 'utf8')
try {
  store.save([{ name: 'clobber', host: 'h', user: 'u' }], staleRevision)
  check('a save against a stale revision is refused', false, 'the save was accepted')
} catch (error) {
  check('a save against a stale revision is refused', error instanceof StoreConflictError, error.name)
}
check('a refused save changed nothing', fs.readFileSync(file, 'utf8') === beforeStale)
check('a refused save persisted nothing', store.load().some(entry => entry.name === 'clobber') === false)

// A caller that supplies no revision (the CLI path, a hand edit) is unaffected.
store.save(reloaded)
check('a save without a revision still works', store.load().length === 2)
store.save(reloaded, store.read().revision)
check('a save with the current revision works', store.load().length === 2)

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

// --- API: same-origin, content-type, validation, redaction ---
const apiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbc-api-'))
// A fresh fixture: the store test above intentionally emptied the first file.
fs.writeFileSync(path.join(apiDir, 'cordis.patch.yml'), ORIGINAL, 'utf8')
const apiStore = new ConnectionStore(apiDir)
let live = new LiveConnections(resolveConnections({ connections: apiStore.load() }))
const handler = createApiHandler({
  list: () => {
    const current = apiStore.read()
    return { connections: current.connections, revision: current.revision, problems: live.problems }
  },
  replace: async (raw, revision) => {
    const merged = mergePasswords(raw, apiStore.read().connections)
    const resolved = resolveConnections({ connections: merged })
    apiStore.save(merged, revision)
    await live.swap(resolved)
    return merged
  },
  test: async name => ({ reachable: true, version: 'probe', name }),
  drivers: driverChoices,
  file: apiStore.file,
})

const server = http.createServer((req, res) => { void handler(req, res) })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
const call = async (route, options) => {
  const response = await fetch(`${base}${route}`, options)
  return { status: response.status, body: await response.json() }
}
const post = body => call('/api/db-connections', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})

const get = await call('/api/db-connections')
check('GET lists connections', get.status === 200 && get.body.connections.length === 1, JSON.stringify(get.body).slice(0, 100))
check('GET reports the patch file path', typeof get.body.file === 'string' && get.body.file.endsWith('cordis.patch.yml'))
check('GET reports a revision', typeof get.body.revision === 'string' && get.body.revision.length > 0)
check('GET reports the driver choices', Array.isArray(get.body.drivers) && get.body.drivers.length === 4, JSON.stringify(get.body.drivers?.map(choice => choice.id)))
check('GET reports no problems for a resolvable list', Array.isArray(get.body.problems) && get.body.problems.length === 0)

// The whole point of the redaction: no credential in the response, at all.
check('GET never returns the stored password', JSON.stringify(get.body).includes('change-me') === false, JSON.stringify(get.body))
check('GET says a password is set and where it comes from',
  get.body.connections[0].passwordSet === true && get.body.connections[0].passwordSource === 'plain',
  JSON.stringify(get.body.connections[0]))
check('GET keeps every non-credential field', get.body.connections[0].host === '192.0.2.10' && get.body.connections[0].name === '128')

const crossOriginGet = await call('/api/db-connections', { headers: { origin: 'http://evil.example' } })
check('cross-origin read refused', crossOriginGet.status === 403, `status ${crossOriginGet.status}`)

const noType = await call('/api/db-connections', { method: 'POST', body: JSON.stringify({ connections: [] }) })
check('write without JSON content-type is refused', noType.status === 415, `status ${noType.status}`)

const badJson = await call('/api/db-connections', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope',
})
check('malformed JSON is refused', badJson.status === 400, `status ${badJson.status}`)

const badShape = await post({ connections: 'no' })
check('non-list connections refused', badShape.status === 400, `status ${badShape.status}`)

const invalid = await post({ connections: [{ name: 'x', host: 'h' }] })
check('config validation surfaces through the API', invalid.status === 400 && /user is required/.test(invalid.body.error), invalid.body.error)

const crossOrigin = await call('/api/db-connections', {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
  body: JSON.stringify({ connections: [] }),
})
check('cross-origin write refused', crossOrigin.status === 403, `status ${crossOrigin.status}`)

// A save that omits the password keeps the stored one: the page never saw it.
const kept = await post({
  revision: get.body.revision,
  connections: [{ name: '128', host: '192.0.2.10', port: 3306, user: 'root', passwordEnv: '', database: 'appdb', description: 'touched' }],
})
check('a save without a password is accepted', kept.status === 200, JSON.stringify(kept.body).slice(0, 120))
check('the stored password survived the redacted round trip', apiStore.load()[0].password === 'change-me', JSON.stringify(apiStore.load()[0]))
check('the edit itself landed', apiStore.load()[0].description === 'touched')
check('the response to a write is redacted too', JSON.stringify(kept.body).includes('change-me') === false)
check('the response carries the new revision', kept.body.revision !== get.body.revision, `${get.body.revision} -> ${kept.body.revision}`)

// A stale revision must be refused instead of overwriting the newer file.
const conflict = await post({ revision: get.body.revision, connections: [] })
check('a stale revision is refused with 409', conflict.status === 409, `status ${conflict.status}`)
check('the refused write changed nothing', apiStore.load().length === 1 && apiStore.load()[0].name === '128')

// An explicit empty password clears it, because that is what the page means
// when the user clears the field.
const cleared = await post({
  revision: apiStore.read().revision,
  connections: [{ name: '128', host: '192.0.2.10', port: 3306, user: 'root', password: '', passwordEnv: '', database: 'appdb' }],
})
check('an explicit empty password clears the stored one', cleared.status === 200 && apiStore.load()[0].password === '', JSON.stringify(apiStore.load()[0]))

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
  list: () => ({ connections: apiStore.read().connections, revision: apiStore.read().revision, problems: [] }),
  replace: async () => { throw new Error('write refused by the harness') },
  test: async () => ({}),
  drivers: driverChoices,
  file: apiStore.file,
})
const server2 = http.createServer((req, res) => { void failing(req, res) })
await new Promise(resolve => server2.listen(0, '127.0.0.1', resolve))
const bad = await (await fetch(`http://127.0.0.1:${server2.address().port}/api/db-connections`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ connections: [] }),
})).json()
check('replace failure reported as an error', /write refused/.test(bad.error), bad.error)
check('failed replace left the file untouched', JSON.stringify(apiStore.load()) === JSON.stringify(before))

// --- passwordEnv indirection must survive a save from the page ---
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

// The page sends the entry back as it received it (redacted, no password) with
// an edit; the merge is what puts the indirection back.
const pageEntry = { ...rawEnvEntry[0], description: 'touched by the page', passwordEnv: 'DBC_TEST_SECRET' }
store5.save(mergePasswords([pageEntry], rawEnvEntry))
const savedEnvText = fs.readFileSync(path.join(dir4, 'cordis.patch.yml'), 'utf8')
check('passwordEnv survives a save', savedEnvText.includes('passwordEnv: DBC_TEST_SECRET'))
check('no plaintext password was written', !savedEnvText.includes('resolved-from-env'), savedEnvText)
check('the edit itself landed', savedEnvText.includes('touched by the page'))

server.close()
server2.close()
await live.dispose()
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)

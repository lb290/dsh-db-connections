/**
 * Load the plugin through the REAL DSH loader stack (Cordis + real
 * SystemPrompt/ToolRuntime services), then exercise the registered tools, the
 * assembled system prompt, the read-only policy per engine, the plugin's own
 * settings route, and a live connection swap.
 *
 * No database is needed: every check here is about what the plugin decides
 * before a socket is opened, or about a refusal that is correct whether the
 * server exists or not. Live SQL is covered by test-integration.mjs.
 *
 * Harness packages are imported from the runtime directory because this file
 * lives in the plugin workspace, while the harness runtime lives in the dsh
 * installation; a bare specifier would resolve against the wrong tree.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { skip, waitFor } from './tests-support.mjs'

// The harness's own @deepseek-ai module directory; override with
// DSH_RUNTIME_MODULES when your install path differs.
const RUNTIME = process.env.DSH_RUNTIME_MODULES
  ?? 'file:///D:/Program%20Files/nodejs/node_global/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'

const importHarness = async name => {
  try {
    return await import(`${RUNTIME}/${name}/lib/index.js`)
  } catch (error) {
    skip(`cannot import ${name} from ${RUNTIME} (${error.message}); set DSH_RUNTIME_MODULES to the harness's @deepseek-ai directory to run this suite`)
  }
}

const { Context } = await importHarness('cordis')
const { default: SystemPrompt, renderPrompt } = await importHarness('dsh-system-prompt')
const { default: ToolRuntime } = await importHarness('dsh-tools')

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ` -> ${detail}`}`)
  if (!ok) failures += 1
}

// The plugin writes to the profile patch; point it at a scratch profile so the
// real desktop profile is never touched by a test.
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbc-live-'))
fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), `- id: db-connections
  name: "dsh-db-connections"
  config:
    connections: []
`, 'utf8')
process.env.DSH_PROFILE_DIR = profileDir

const ctx = new Context()
ctx.plugin(SystemPrompt, { includeHarnessIdentity: true, persona: 'test persona' })
ctx.plugin(ToolRuntime)
// Readiness is polled, never assumed from a fixed delay.
await waitFor(() => {
  try {
    return typeof ctx.systemPrompt?.assemble === 'function'
  } catch {
    return false
  }
}, { label: 'the systemPrompt service' })

const mod = await import(new URL('../index.js', import.meta.url))
check('plugin name', mod.name === 'dsh-db-connections')

// Names and addresses are only configuration values here: nothing connects.
const HOST = process.env.DB_TEST_HOST ?? '127.0.0.1'
const PORT = Number(process.env.DB_TEST_PORT ?? 3306)
const USER = process.env.DB_TEST_USER ?? 'root'
const PASSWORD = process.env.DB_TEST_PASSWORD ?? ''
const DATABASE = process.env.DB_TEST_DATABASE ?? 'test'
const fiber = ctx.plugin(mod, {
  connections: [
    { name: '128', host: HOST, port: PORT, user: USER, password: PASSWORD, database: DATABASE, description: 'test database' },
    // A classify-only engine, so the read-only policy can be exercised without
    // a server: Doris has no read-only transaction for the server to enforce.
    { name: 'dw', driver: 'doris', host: HOST, port: 9030, user: USER, password: PASSWORD },
    // A per-machine environment must not remove the connection from the list.
    { name: 'env', host: HOST, port: PORT, user: USER, passwordEnv: 'DBC_LOADER_NOT_SET' },
  ],
})
const dbTools = async () => (await ctx.systemPrompt.assemble({})).tools.filter(tool => tool.name.startsWith('db_')).length
check('the plugin registered its three tools', await waitFor(async () => (await dbTools()) === 3, { label: 'three db tools' }))

const assembly = await ctx.systemPrompt.assemble({})
const promptText = renderPrompt(assembly)
console.log('\n=== assembled system prompt ===')
console.log(promptText)

check('prompt section present', promptText.includes('Database connections'))
check('prompt names the connection', promptText.includes('`128`'))
check('prompt never carries the password', !promptText.includes('change-me'))
check('prompt states read-only when no connection is writable', promptText.includes('No connection here allows writes'))
check('prompt reports the engine of each connection', promptText.includes('MySQL') && promptText.includes('Doris'))
check('prompt never carries an address', !promptText.includes(`${HOST}:${PORT}`))
check('prompt names an unusable connection with its reason',
  promptText.includes('`env`') && promptText.includes('DBC_LOADER_NOT_SET'), promptText.slice(-400))
check('three db tools registered', assembly.tools.filter(t => t.name.startsWith('db_')).length === 3)

const run = async (name, args) => ctx.tools.execute({
  callId: `test-${Math.random().toString(36).slice(2)}`,
  name,
  arguments: args,
  signal: new AbortController().signal,
})
const textOf = result => result.content.map(block => block.text ?? '').join('\n')

// ── the read-only policy, decided before any socket is opened ───────────────
const drop = await run('db_query', { connection: '128', sql: 'DROP TABLE _dsh_no_such_table' })
check('a write through db_query is refused', drop.isError === true && /read-only statements only/.test(textOf(drop)), textOf(drop))

const control = await run('db_query', { connection: '128', sql: 'SET SESSION autocommit = 0' })
check('a session statement is refused', control.isError === true && /session or administrative/.test(textOf(control)), textOf(control))

const cteOnServerBacked = await run('db_query', { connection: '128', sql: 'WITH c AS (SELECT 1 AS id) SELECT * FROM c' })
check('an unclassifiable statement is admitted where the server can enforce read-only',
  textOf(cteOnServerBacked).includes('could not be classified') === false, textOf(cteOnServerBacked).slice(0, 140))

const cteOnClassifyOnly = await run('db_query', { connection: 'dw', sql: 'WITH c AS (SELECT 1 AS id) DELETE FROM c' })
check('an unclassifiable statement is refused where the server cannot',
  cteOnClassifyOnly.isError === true && /could not be classified/.test(textOf(cteOnClassifyOnly)), textOf(cteOnClassifyOnly))

const readOnClassifyOnly = await run('db_query', { connection: 'dw', sql: 'SELECT 1' })
check('a provable read is admitted on a classify-only engine',
  textOf(readOnClassifyOnly).includes('could not be classified') === false, textOf(readOnClassifyOnly).slice(0, 140))

const unusable = await run('db_query', { connection: 'env', sql: 'SELECT 1' })
check('an unusable connection explains itself', unusable.isError === true && /not usable here/.test(textOf(unusable)), textOf(unusable))

const multi = await run('db_query', { connection: '128', sql: 'SELECT 1; SELECT 2' })
check('two statements in one call are refused', multi.isError === true && /one statement per call/.test(textOf(multi)), textOf(multi))

// --- live swap: change connections through the plugin's OWN API route ---
//
// The plugin registers a `webServer` prefix route when that service exists, so
// mounting a stand-in `webServer` here captures the real handler the settings
// page talks to — including the plugin's own replace-and-swap wiring. Driving a
// handler built by the test would prove nothing about the plugin.
let captured
ctx.plugin({
  name: 'test-web-server',
  inject: [],
  apply(inner) {
    inner.provide('webServer', {
      register(route) {
        captured = route
        return () => { captured = undefined }
      },
    })
  },
})
await waitFor(() => captured !== undefined, { label: 'the plugin API route' })
check('plugin registered its API route', captured !== undefined && captured.path === '/api/db-connections',
  captured === undefined ? 'no route captured' : captured.path)
if (captured === undefined) {
  console.log('\nNo API route was captured; the remaining checks cannot run.')
  process.exit(1)
}

const http = await import('node:http')
const server = http.createServer((req, res) => { void captured.handler(req, res) })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

const read = await (await fetch(`${base}/api/db-connections`)).json()
check('the route reports the revision', typeof read.revision === 'string' && read.revision.length > 0)
check('the route reports the driver catalog', Array.isArray(read.drivers) && read.drivers.length === 4)
check('the route never returns the configured password', JSON.stringify(read).includes(PASSWORD) === false || PASSWORD === '')

const saved = await fetch(`${base}/api/db-connections`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: base },
  body: JSON.stringify({
    revision: read.revision,
    connections: [
      { name: '128', host: HOST, port: PORT, user: USER, database: DATABASE, passwordEnv: '' },
      { name: 'local', host: '127.0.0.1', port: 3306, user: 'root', password: 'x' },
    ],
  }),
})
check('settings save accepted', saved.status === 200, JSON.stringify(await saved.clone().json()).slice(0, 120))

const { ConnectionStore } = await import(new URL('../src/store.js', import.meta.url))
const store = new ConnectionStore()
check('store points at the scratch profile', store.file.startsWith(profileDir))
check('save reached the profile file', store.load().length === 2)

// The running plugin must now offer both names, with no reload and no restart.
const after = await ctx.systemPrompt.assemble({})
check('prompt now names both connections',
  renderPrompt(after).includes('`local`') && renderPrompt(after).includes('`128`'))
check('the saved prompt keeps the engine of a hand-written entry',
  renderPrompt(after).includes('MySQL'))

const live = await run('db_query', { connection: 'local', sql: 'SELECT 1' })
// The point is that the freshly saved name resolved and reached the network path
// at all: whether 127.0.0.1:3306 answers, refuses, or rejects these credentials,
// the swap is what made the name addressable.
check('newly saved name is addressable without a restart',
  live.isError === true
  && !/no database connection is named/.test(textOf(live))
  && /127\.0\.0\.1:3306/.test(textOf(live)),
  textOf(live).slice(0, 140))

const gone = await run('db_query', { connection: 'nosuch', sql: 'SELECT 1' })
check('unconfigured name still refused', gone.isError === true && /no database connection is named/.test(textOf(gone)))
// Await the close before disposing and exiting. `server.close()` alone returns
// immediately while the listener is still tearing down, and exiting on top of
// that races libuv: on Windows the process then dies with
// `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` after every check has
// already passed, which reads as a plugin defect instead of a teardown race.
await new Promise(resolve => { server.close(resolve) })

await fiber.dispose()
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
// Set the code and let the loop drain instead of calling process.exit(). On
// Windows, exiting while the global fetch dispatcher still owns handles kills
// the process with `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`
// after every check has passed, so a passing suite reports a failing exit code.
process.exitCode = failures === 0 ? 0 : 1

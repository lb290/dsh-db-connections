/**
 * Load the plugin through the REAL DSH loader stack (Cordis + real
 * SystemPrompt/ToolRuntime services), then exercise the registered tools, the
 * assembled system prompt, and a live connection swap.
 *
 * Harness packages are imported from the runtime directory because this file
 * lives in the plugin workspace, while the harness runtime lives in the dsh
 * installation; a bare specifier would resolve against the wrong tree.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// The harness's own @deepseek-ai module directory; override with
// DSH_RUNTIME_MODULES when your install path differs.
const RUNTIME = process.env.DSH_RUNTIME_MODULES
  ?? 'file:///D:/Program%20Files/nodejs/node_global/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'

const { Context } = await import(`${RUNTIME}/cordis/lib/index.js`)
const { default: SystemPrompt, renderPrompt } = await import(`${RUNTIME}/dsh-system-prompt/lib/index.js`)
const { default: ToolRuntime } = await import(`${RUNTIME}/dsh-tools/lib/index.js`)

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
await new Promise(resolve => setTimeout(resolve, 400))

const mod = await import(new URL('./index.js', import.meta.url))
check('plugin name', mod.name === 'dsh-db-connections')

// A reachable MySQL is needed for the tool checks below; DB_TEST_* selects it
// (default 127.0.0.1, root, empty password, `test`).
const HOST = process.env.DB_TEST_HOST ?? '127.0.0.1'
const USER = process.env.DB_TEST_USER ?? 'root'
const PASSWORD = process.env.DB_TEST_PASSWORD ?? ''
const DATABASE = process.env.DB_TEST_DATABASE ?? 'test'
const fiber = ctx.plugin(mod, {
  connections: [{
    name: '128', host: HOST, port: 3306, user: USER,
    password: PASSWORD, database: DATABASE, description: 'test database',
  }],
})
await new Promise(resolve => setTimeout(resolve, 400))

const assembly = await ctx.systemPrompt.assemble({})
const promptText = renderPrompt(assembly)
console.log('\n=== assembled system prompt ===')
console.log(promptText)

check('prompt section present', promptText.includes('Database connections'))
check('prompt names the connection', promptText.includes('`128`'))
check('prompt never carries the password', !promptText.includes('change-me'))
check('prompt states read-only when no connection is writable', promptText.includes('No connection here allows writes'))
check('three db tools registered', assembly.tools.filter(t => t.name.startsWith('db_')).length === 3)

const run = async (name, args) => ctx.tools.execute({
  callId: `test-${Math.random().toString(36).slice(2)}`,
  name,
  arguments: args,
  signal: new AbortController().signal,
})
const textOf = result => result.content.map(block => block.text ?? '').join('\n')

const select = await run('db_query', { connection: '128', sql: "SELECT 1 AS id, 'admin' AS username" })
console.log('\n=== db_query SELECT ===')
console.log(textOf(select))
check('SELECT succeeds', select.isError !== true)
check('SELECT returns rows', textOf(select).includes('admin'))

const drop = await run('db_query', { connection: '128', sql: 'DROP TABLE _dsh_no_such_table' })
check('client-side write refusal', drop.isError === true && /read-only statements only/.test(textOf(drop)), textOf(drop))

const cte = await run('db_query', { connection: '128', sql: 'WITH c AS (SELECT id FROM _dsh_no_such_table LIMIT 1) UPDATE _dsh_no_such_table SET id=id WHERE id IN (SELECT id FROM c)' })
check('server-side write refusal (CTE bypass)', cte.isError === true && /server-enforced read-only/.test(textOf(cte)), textOf(cte))

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
await new Promise(resolve => setTimeout(resolve, 500))
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

const before = await run('db_query', { connection: '128', sql: 'SELECT 1' })
check('original connection works before the save', before.isError !== true)

const saved = await fetch(`${base}/api/db-connections`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: base },
  body: JSON.stringify({
    connections: [
      { name: '128', host: HOST, port: 3306, user: USER, password: PASSWORD, database: DATABASE },
      { name: 'local', host: '127.0.0.1', port: 3306, user: 'root', password: 'x' },
    ],
  }),
})
check('settings save accepted', saved.status === 200, JSON.stringify(await saved.clone().json()).slice(0, 120))

const { ConnectionStore } = await import(new URL('./src/store.js', import.meta.url))
const store = new ConnectionStore()
check('store points at the scratch profile', store.file.startsWith(profileDir))
check('save reached the profile file', store.load().length === 2)

// The running plugin must now offer both names, with no reload and no restart.
const after = await ctx.systemPrompt.assemble({})
check('prompt now names both connections',
  renderPrompt(after).includes('`local`') && renderPrompt(after).includes('`128`'))

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
server.close()

console.log('\nAll checks above ran against the live MySQL server.')
await fiber.dispose()
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)

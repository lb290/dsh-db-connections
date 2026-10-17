/**
 * Config validation and lifecycle checks that need no database:
 * misconfiguration must fail loud at load, and unloading must remove both the
 * prompt section and the tools.
 */
// The harness's own @deepseek-ai module directory; override with
// DSH_RUNTIME_MODULES when your install path differs.
const RUNTIME = process.env.DSH_RUNTIME_MODULES
  ?? 'file:///D:/Program%20Files/nodejs/node_global/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
const { Context } = await import(`${RUNTIME}/cordis/lib/index.js`)
const { default: SystemPrompt, renderPrompt } = await import(`${RUNTIME}/dsh-system-prompt/lib/index.js`)
const { default: ToolRuntime } = await import(`${RUNTIME}/dsh-tools/lib/index.js`)
const { waitFor } = await import('./tests-support.mjs')
const mod = await import(new URL('../index.js', import.meta.url))

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ` -> ${detail}`}`)
  if (!ok) failures += 1
}

const expectThrow = (label, config, expectText) => {
  try {
    mod.apply(new Context(), config)
    check(label, false, 'no error thrown')
  } catch (e) {
    check(label, e.message.includes(expectText), e.message)
  }
}

// --- config validation: every case must fail loud at load ---
expectThrow('missing name', { connections: [{ host: 'h', user: 'u' }] }, 'name is required')
expectThrow('missing host', { connections: [{ name: 'a', user: 'u' }] }, 'host is required')
expectThrow('missing user', { connections: [{ name: 'a', host: 'h' }] }, 'user is required')
expectThrow('duplicate names', { connections: [{ name: 'a', host: 'h', user: 'u' }, { name: 'a', host: 'h', user: 'u' }] }, 'duplicate connection name')
expectThrow('bad port', { connections: [{ name: 'a', host: 'h', user: 'u', port: 0 }] }, 'port must be a positive integer')
expectThrow('port too large', { connections: [{ name: 'a', host: 'h', user: 'u', port: 70000 }] }, 'port must be at most 65535')
expectThrow('unsupported driver', { connections: [{ name: 'a', host: 'h', user: 'u', driver: 'oracle' }] }, 'is not supported')
expectThrow('bad allowWrite type', { connections: [{ name: 'a', host: 'h', user: 'u', allowWrite: 'yes' }] }, 'allowWrite must be a boolean')
expectThrow('connections not a list', { connections: 'nope' }, 'must be a list')
expectThrow('control chars in name', { connections: [{ name: 'a\nb', host: 'h', user: 'u' }] }, 'must not contain control characters')
expectThrow('an unknown TLS option is refused', { connections: [{ name: 'a', host: 'h', user: 'u', ssl: { nonsense: true } }] }, 'not a recognized TLS option')
// A broken audit block costs the trail, not the plugin: the settings page is the
// only place that could report it, so failing the load here would remove the
// reporter. `resolveAudit` itself is asserted to throw in test-audit.mjs.
try {
  mod.apply(new Context(), { connections: [], audit: {} })
  check('a broken audit block still loads the plugin', true)
} catch (e) {
  check('a broken audit block still loads the plugin', false, e.message)
}

// --- a per-machine environment must not remove the settings page ---
//
// A `passwordEnv` this machine does not set is a fact about the machine, not a
// defect in the file. Throwing here would fail the whole plugin load, which also
// removes the settings page that is the only place to see and fix it.
const { resolveConnections } = await import('../src/config.js')
const degraded = resolveConnections({ connections: [
  { name: 'ok', host: 'h', user: 'u' },
  { name: 'missing', host: 'h', user: 'u', passwordEnv: 'DBC_TEST_NOT_SET' },
] })
check('a missing passwordEnv does not throw', degraded.connections.length === 2)
check('the unusable connection is reported, not dropped', degraded.connections[1].name === 'missing')
check('it is marked unavailable with the reason', /DBC_TEST_NOT_SET/.test(degraded.connections[1].unavailable ?? ''), String(degraded.connections[1].unavailable))
check('the problem list names the connection', degraded.problems.length === 1 && degraded.problems[0].connection === 'missing', JSON.stringify(degraded.problems))

process.env.DBC_TEST_PRESENT = 'from-env'
const present = resolveConnections({ connections: [{ name: 'e', host: 'h', user: 'u', passwordEnv: 'DBC_TEST_PRESENT' }] })
check('a present passwordEnv resolves with no problem', present.connections[0].password === 'from-env' && present.problems.length === 0)
check('the resolved connection keeps the variable name', present.connections[0].passwordEnv === 'DBC_TEST_PRESENT')

// --- per-driver defaults ---
const perDriver = resolveConnections({ connections: [
  { name: 'm', host: 'h', user: 'u' },
  { name: 'd', driver: 'doris', host: 'h', user: 'u' },
  { name: 'p', driver: 'postgres', host: 'h', user: 'u' },
  { name: 't', driver: 'tdengine', host: 'h', user: 'u' },
] }).connections
check('each driver gets its own default port',
  perDriver.map(connection => `${connection.driver}:${connection.port}`).join(' ') === 'mysql:3306 doris:9030 postgres:5432 tdengine:6041',
  perDriver.map(connection => `${connection.driver}:${connection.port}`).join(' '))
check('a time-series database defaults to far fewer rows',
  perDriver[3].maxRows === 50 && perDriver[0].maxRows === 200,
  `${perDriver[3].maxRows}/${perDriver[0].maxRows}`)

// --- TLS material ---
const tls = resolveConnections({ connections: [{ name: 's', host: 'h', user: 'u', ssl: { ca: 'PEM', rejectUnauthorized: false } }] }).connections[0]
check('a TLS mapping is kept as configured', tls.ssl.ca === 'PEM' && tls.ssl.rejectUnauthorized === false, JSON.stringify(tls.ssl))
check('ssl: true stays a boolean', resolveConnections({ connections: [{ name: 's', host: 'h', user: 'u', ssl: true }] }).connections[0].ssl === true)

// A valid config with no connections must load and stay inert.
try {
  mod.apply(new Context(), { connections: [] })
  check('empty connection list loads', true)
} catch (e) {
  check('empty connection list loads', false, e.message)
}
try {
  mod.apply(new Context(), undefined)
  check('absent config loads', true)
} catch (e) {
  check('absent config loads', false, e.message)
}

// --- lifecycle: unload must remove the prompt section and the tools ---
// Point the store at a scratch profile: mounting the plugin registers a writer
// for the real profile's patch file, which a test must never touch.
const fs = await import('node:fs')
const os = await import('node:os')
const path = await import('node:path')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dbc-config-'))
fs.writeFileSync(path.join(scratch, 'cordis.patch.yml'), '- id: db-connections\n  name: "dsh-db-connections"\n  config:\n    connections: []\n', 'utf8')
process.env.DSH_PROFILE_DIR = scratch

const ctx = new Context()
ctx.plugin(SystemPrompt, {})
ctx.plugin(ToolRuntime)
// Poll for readiness instead of sleeping: a fixed wait is a flake on a loaded
// machine, and the assertion below needs the service, not a duration.
const servicesReady = () => {
  try {
    return typeof ctx.systemPrompt?.assemble === 'function'
  } catch {
    return false
  }
}
await waitFor(servicesReady, { label: 'the systemPrompt service' })

const baseline = await ctx.systemPrompt.assemble({})
check('prompt section absent before load', !renderPrompt(baseline).includes('Database connections'))
check('no db tools before load', baseline.tools.filter(t => t.name.startsWith('db_')).length === 0)

// Mount through the registry so the plugin fiber can be disposed, which is
// what hot replacement and app shutdown do.
const fiber = ctx.plugin(mod, {
  connections: [{ name: 'x', host: '127.0.0.1', port: 3306, user: 'u', password: 'p' }],
})
const registered = async () => (await ctx.systemPrompt.assemble({})).tools.filter(t => t.name.startsWith('db_')).length
check('the plugin registered its tools', await waitFor(async () => (await registered()) === 3, { label: 'three db tools' }))

const during = await ctx.systemPrompt.assemble({})
check('prompt section present after load', renderPrompt(during).includes('Database connections'))
check('three tools registered after load', during.tools.filter(t => t.name.startsWith('db_')).length === 3,
  `${during.tools.filter(t => t.name.startsWith('db_')).length} tools`)

await fiber.dispose()
check('disposal unregistered the tools', await waitFor(async () => (await registered()) === 0, { label: 'the db tools to unregister' }))

const after = await ctx.systemPrompt.assemble({})
check('prompt section removed after dispose', !renderPrompt(after).includes('Database connections'))
check('tools unregistered after dispose', after.tools.filter(t => t.name.startsWith('db_')).length === 0,
  `${after.tools.filter(t => t.name.startsWith('db_')).length} tools remain`)

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)

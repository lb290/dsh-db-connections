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
const mod = await import(new URL('./index.js', import.meta.url))

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
expectThrow('unsupported driver', { connections: [{ name: 'a', host: 'h', user: 'u', driver: 'postgres' }] }, 'is not supported')
expectThrow('bad allowWrite type', { connections: [{ name: 'a', host: 'h', user: 'u', allowWrite: 'yes' }] }, 'allowWrite must be a boolean')
expectThrow('connections not a list', { connections: 'nope' }, 'must be a list')
expectThrow('missing passwordEnv', { connections: [{ name: 'a', host: 'h', user: 'u', passwordEnv: 'NOT_SET_ANYWHERE' }] }, 'is not set in the environment')
expectThrow('control chars in name', { connections: [{ name: 'a\nb', host: 'h', user: 'u' }] }, 'must not contain control characters')

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
await new Promise(r => setTimeout(r, 400))

const baseline = await ctx.systemPrompt.assemble({})
check('prompt section absent before load', !renderPrompt(baseline).includes('Database connections'))
check('no db tools before load', baseline.tools.filter(t => t.name.startsWith('db_')).length === 0)

// Mount through the registry so the plugin fiber can be disposed, which is
// what hot replacement and app shutdown do.
const fiber = ctx.plugin(mod, {
  connections: [{ name: 'x', host: '127.0.0.1', port: 3306, user: 'u', password: 'p' }],
})
await new Promise(r => setTimeout(r, 400))

const during = await ctx.systemPrompt.assemble({})
check('prompt section present after load', renderPrompt(during).includes('Database connections'))
check('three tools registered after load', during.tools.filter(t => t.name.startsWith('db_')).length === 3,
  `${during.tools.filter(t => t.name.startsWith('db_')).length} tools`)

await fiber.dispose()
await new Promise(r => setTimeout(r, 400))

const after = await ctx.systemPrompt.assemble({})
check('prompt section removed after dispose', !renderPrompt(after).includes('Database connections'))
check('tools unregistered after dispose', after.tools.filter(t => t.name.startsWith('db_')).length === 0,
  `${after.tools.filter(t => t.name.startsWith('db_')).length} tools remain`)

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)

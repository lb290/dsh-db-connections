/**
 * Package and client-discovery checks for the desktop profile.
 *
 * A client plugin must declare BOTH `dsh.client` and `exports["./client"]`.
 * Missing the export makes the harness throw at startup — breaking the whole app,
 * not merely hiding this plugin — so this file runs the harness's own
 * `ClientModuleRegistry.resolveMeta`, the code that decides whether a package's
 * declaration becomes a served bundle. A hand-written package.json check cannot
 * catch that mistake.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Machine locations, overridable by environment when your install differs:
// DSH_RUNTIME_MODULES = the harness's own @deepseek-ai module directory,
// DSH_PROFILE_DIR = the desktop profile directory.
const RUNTIME = process.env.DSH_RUNTIME_MODULES
  ?? 'file:///D:/Program%20Files/nodejs/node_global/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
const PROFILE_DIR = process.env.DSH_PROFILE_DIR ?? 'C:/Users/admin/.dsh/profiles/desktop'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ` -> ${detail}`}`)
  if (!ok) failures += 1
}

const pkgPath = fileURLToPath(new URL('./package.json', import.meta.url))
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
const dir = path.dirname(pkgPath)

// 1. The manifest itself.
check('package name is dsh-db-connections', pkg.name === 'dsh-db-connections', pkg.name)
check('declares a bundle patch', typeof pkg.dsh?.bundle?.patch === 'string', pkg.dsh?.bundle?.patch)
check('bundle patch exists', fs.existsSync(path.join(dir, pkg.dsh?.bundle?.patch ?? '')), pkg.dsh?.bundle?.patch)

const decl = pkg.dsh?.client
check('declares dsh.client', decl !== undefined)
check('client platform is web', decl?.platform === 'web', decl?.platform)
check('declares immediately', decl?.immediately === true)
check('inject is a string array', Array.isArray(decl?.inject) && decl.inject.every(i => typeof i === 'string'))

// 2. The export the scan resolves the bundle through.
const clientEntry = pkg.exports?.['./client']
const clientRel = typeof clientEntry === 'string' ? clientEntry : clientEntry?.default
check('exports a ./client entry', typeof clientRel === 'string', JSON.stringify(pkg.exports?.['./client']))
if (typeof clientRel !== 'string') {
  console.log('\nThe harness would throw "declares dsh.client but exports no ./client bundle" at startup.')
  process.exit(1)
}
check('./client resolves to an existing file', fs.existsSync(path.join(dir, clientRel)), clientRel)

// 3. The bundle registers itself and needs nothing beyond react.
const source = fs.readFileSync(path.join(dir, clientRel), 'utf8')
check('bundle calls the ModuleLoader', source.includes('__ModuleLoader__.load('))
check('bundle id matches the package name', /id:\s*'dsh-db-connections'/.test(source))
check('bundle requires only react beyond the shell', !/require\(['"](?!react)/.test(source),
  (source.match(/require\(['"][^'"]+['"]\)/g) ?? []).join(' '))
try {
  new Function('window', 'document', source)
  check('bundle parses as a script', true)
} catch (error) {
  check('bundle parses as a script', false, error.message)
}

// 4. Every dependency the entry imports must resolve.
for (const dep of ['mysql2/promise', 'yaml']) {
  try {
    const { createRequire } = await import('node:module')
    createRequire(path.join(dir, 'index.js')).resolve(dep)
    check(`${dep} resolves from the plugin`, true)
  } catch (error) {
    check(`${dep} resolves from the plugin`, false, error.code)
  }
}

// 5. What the harness itself would do with this package.
if (!fs.existsSync(PROFILE_DIR)) {
  console.log('\nNo desktop profile on this machine; skipping the live discovery check.')
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

const { ClientModuleRegistry } = await import(`${RUNTIME}/dsh-client-modules/lib/index.js`)
const registry = new ClientModuleRegistry({
  loader: { entries: () => [] },
  on: () => () => {},
  inject: () => {},
  effect: () => {},
  logger: { warn: () => {}, info: () => {} },
  reflect: { provide: () => () => {}, get: () => undefined },
})

// The plugin is not installed into the profile yet, so resolve it from its own
// directory: this is the harness's real resolution code, given a base it can
// resolve the package name from.
let meta
try {
  meta = registry.resolveMeta('dsh-db-connections', `${dir}/`)
  check('the harness resolves the client bundle', meta !== null && meta !== undefined,
    meta === null ? 'null (package not resolvable from that base)' : '')
} catch (error) {
  check('the harness resolves the client bundle', false, error.message)
}
if (meta !== null && meta !== undefined) {
  check('resolved bundle path is client.js', String(meta.meta.clientPath).endsWith('client.js'), meta.meta.clientPath)
  check('resolved bundle exists', fs.existsSync(meta.meta.clientPath), meta.meta.clientPath)
  check('resolved as immediately-loaded', meta.meta.immediately === true)
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)

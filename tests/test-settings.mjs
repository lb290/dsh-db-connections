/**
 * Settings-projection tests: the two rules that keep a credential out of the
 * settings page's response while still letting the page leave one alone.
 */
import { mergePasswords, redactConnections } from '../src/settings.js'
import { resolveConnections } from '../src/config.js'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ` -> ${detail}`}`)
  if (!ok) failures += 1
}

// ── redaction ──────────────────────────────────────────────────────────────
const stored = [
  { name: 'plain', host: 'h', user: 'u', password: 'hunter2' },
  { name: 'env', host: 'h', user: 'u', password: '', passwordEnv: 'WAREHOUSE_PW' },
  { name: 'none', host: 'h', user: 'u', password: '' },
]
const redacted = redactConnections(stored)
check('no password survives redaction', redacted.every(entry => entry.password === undefined), JSON.stringify(redacted))
const serialized = JSON.stringify(redacted)
check('the serialized payload contains no secret value', serialized.includes('hunter2') === false, serialized)
check('a plaintext password reports its source', redacted[0].passwordSet === true && redacted[0].passwordSource === 'plain')
check('an environment reference reports its source and name', redacted[1].passwordSet === true && redacted[1].passwordSource === 'env' && redacted[1].passwordEnv === 'WAREHOUSE_PW')
check('an absent password reports none', redacted[2].passwordSet === false && redacted[2].passwordSource === 'none')
check('redaction keeps every other field', redacted[0].host === 'h' && redacted[0].name === 'plain')

// ── inheritance on save ────────────────────────────────────────────────────
const untouched = mergePasswords(
  [{ name: 'plain', host: 'h', user: 'u', passwordEnv: '' }, { name: 'env', host: 'h', user: 'u', passwordEnv: 'WAREHOUSE_PW' }],
  stored,
)
check('an omitted password keeps the stored plaintext', untouched[0].password === 'hunter2', JSON.stringify(untouched[0]))
check('an untouched environment reference survives', untouched[1].passwordEnv === 'WAREHOUSE_PW')

const cleared = mergePasswords([{ name: 'plain', host: 'h', user: 'u', password: '' }], stored)
check('an explicit empty password clears the stored one', cleared[0].password === '', JSON.stringify(cleared[0]))

const replaced = mergePasswords([{ name: 'env', host: 'h', user: 'u', password: 'new' }], stored)
check('a typed password replaces the stored one and drops the indirection',
  replaced[0].password === 'new' && replaced[0].passwordEnv === undefined, JSON.stringify(replaced[0]))

const added = mergePasswords([{ name: 'fresh', host: 'h', user: 'u' }], stored)
check('a new connection inherits nothing', added[0].password === undefined && added[0].passwordEnv === undefined)

const renamed = mergePasswords([{ name: 'other', host: 'h', user: 'u' }], [{ name: 'plain', password: 'x' }])
check('inheritance is by name, not by position', renamed[0].password === undefined)

// ── the round trip: page payload -> config -> stored list ──────────────────
const payload = [{ name: 'kept', host: 'h', user: 'u', passwordEnv: '', driver: 'mysql', port: 3306, allowWrite: false, ssl: false }]
const merged = mergePasswords(payload, [{ name: 'kept', host: 'h', user: 'u', password: 'secret' }])
const resolved = resolveConnections({ connections: merged })
check('the merged entry resolves with the inherited password', resolved.connections[0].password === 'secret')
check('an empty environment reference is not a problem', resolved.problems.length === 0, JSON.stringify(resolved.problems))

const envResolved = resolveConnections({ connections: [{ name: 'e', host: 'h', user: 'u', passwordEnv: '' }] })
check('an empty environment reference means "no indirection"', envResolved.problems.length === 0 && envResolved.connections[0].passwordEnv === undefined)

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)

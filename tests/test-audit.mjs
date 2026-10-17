/**
 * Audit-trail tests: the setting's validation, the record's shape, and the
 * statement bound. A real database is not involved.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAuditLog, resolveAudit } from '../src/audit.js'
import { waitFor } from './tests-support.mjs'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ` -> ${detail}`}`)
  if (!ok) failures += 1
}
const throws = (label, run, pattern) => {
  try {
    run()
    check(label, false, 'nothing was thrown')
  } catch (error) {
    check(label, pattern.test(error.message), error.message)
  }
}

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dbc-audit-unit-'))
/** The sink appends asynchronously; wait for the file to reach a line count. */
const linesIn = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).length : 0)
const waitForLines = (file, count) => waitFor(() => linesIn(file) >= count, { label: `${file} to hold ${count} line(s)` })

// ── validation ─────────────────────────────────────────────────────────────
check('an absent audit block disables the trail', resolveAudit(undefined, directory) === undefined)
check('audit: false disables the trail', resolveAudit(false, directory) === undefined)
throws('a non-mapping audit block is refused', () => resolveAudit('yes', directory), /must be a mapping/)
throws('a missing path is refused', () => resolveAudit({}, directory), /path is required/)
throws('a blank path is refused', () => resolveAudit({ path: '   ' }, directory), /path is required/)
throws('a bad bound is refused', () => resolveAudit({ path: 'a.jsonl', maxSqlChars: 0 }, directory), /maxSqlChars must be a positive integer/)

const resolved = resolveAudit({ path: 'nested/audit.jsonl' }, directory)
check('a relative path resolves against the profile directory', resolved.path === path.join(directory, 'nested/audit.jsonl'), resolved.path)
check('the bound defaults to 512', resolved.maxSqlChars === 512)
const absolute = resolveAudit({ path: '/tmp/dbc-absolute.jsonl' }, directory)
check('an absolute path is kept', absolute.path === '/tmp/dbc-absolute.jsonl')

// ── recording ──────────────────────────────────────────────────────────────
const file = path.join(directory, 'trail.jsonl')
const log = createAuditLog({ path: file, maxSqlChars: 32 })
check('the sink reports its file', log.file === file)
check('the sink creates a missing directory', fs.existsSync(path.dirname(file)))

log.record({ connection: 'rw', driver: 'mysql', sql: 'UPDATE t SET a = 1', ok: true, affectedRows: 1, elapsedMs: 4 })
log.record({ connection: 'rw', driver: 'postgres', sql: `INSERT INTO t VALUES (${'x'.repeat(80)})`, ok: false, error: 'boom', elapsedMs: 9 })
check('both records reached the file', await waitForLines(file, 2))

const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line))
check('one line per record', lines.length === 2, String(lines.length))
check('a record carries a timestamp', typeof lines[0].time === 'string' && lines[0].time.endsWith('Z'))
check('a record carries the connection and the driver', lines[0].connection === 'rw' && lines[1].driver === 'postgres')
check('a failure is recorded with its error', lines[1].ok === false && lines[1].error === 'boom')
check('a long statement is bounded', lines[1].sql.length <= 32 + 20 && lines[1].sql.includes('more chars'), lines[1].sql)
check('a short statement is kept as written', lines[0].sql === 'UPDATE t SET a = 1')

// A trail whose directory disappears must not break the caller mid-call.
const doomedDirectory = path.join(directory, 'doomed')
const doomed = createAuditLog({ path: path.join(doomedDirectory, 'trail.jsonl'), maxSqlChars: 32 })
fs.rmSync(doomedDirectory, { recursive: true, force: true })
doomed.record({ connection: 'x', sql: 'SELECT 1' })
check('a record that cannot land does not throw at the call site', true)

// A path underneath a regular file cannot be created, and saying so is the
// only way the operator learns the trail is off.
const blocker = path.join(directory, 'blocker')
fs.writeFileSync(blocker, 'not a directory')
throws('a trail under a regular file is refused at creation',
  () => createAuditLog({ path: path.join(blocker, 'trail.jsonl'), maxSqlChars: 32 }),
  /could not be created/)

fs.rmSync(directory, { recursive: true, force: true })
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)

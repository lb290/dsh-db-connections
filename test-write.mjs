/**
 * Write-path test. Proves the read-write mode actually works, that it is the
 * connection's `allowWrite` flag (not the tool) that decides, that a write is
 * recorded in the audit log, and that whatever the test creates is removed
 * afterwards.
 *
 * The table is created and dropped inside this test, on the configured test
 * database: DB_TEST_HOST / DB_TEST_PORT / DB_TEST_USER / DB_TEST_PASSWORD /
 * DB_TEST_DATABASE (default 127.0.0.1:3306, root, empty password, `test`).
 * Without a reachable server the suite reports SKIP.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAuditLog } from './src/audit.js'
import { resolveConnections } from './src/config.js'
import { LiveConnections } from './src/live.js'
import { executeTool, queryTool } from './src/tools.js'
import { requireMysql, waitFor } from './tests-support.mjs'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ` -> ${detail}`}`)
  if (!ok) failures += 1
}

const target = await requireMysql()
const auditDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dbc-audit-'))
const auditFile = path.join(auditDirectory, 'audit.jsonl')
const live = new LiveConnections(resolveConnections({
  connections: [
    { name: 'ro', host: target.host, port: target.port, user: target.user, password: target.password, database: target.database },
    { name: 'rw', host: target.host, port: target.port, user: target.user, password: target.password, database: target.database, allowWrite: true },
  ],
}), { audit: createAuditLog({ path: auditFile, maxSqlChars: 512 }) })

const query = queryTool(live)
const execute = executeTool(live)
const call = (tool, args) => tool.execute(args, { signal: undefined })
const textOf = value => JSON.stringify(value)
/** The audit sink appends asynchronously; poll the file rather than sleeping. */
const auditLines = () => (fs.existsSync(auditFile) ? fs.readFileSync(auditFile, 'utf8').trim().split('\n').filter(Boolean) : [])

const TABLE = '_dsh_rw_probe'

// Clean any leftover from an interrupted earlier run.
try {
  await call(execute, { connection: 'rw', sql: `DROP TABLE IF EXISTS ${TABLE}` })
} catch { /* nothing to clean */ }

try {
  // 1. DDL through the writable connection.
  const created = await call(execute, { connection: 'rw', sql: `CREATE TABLE ${TABLE} (id INT PRIMARY KEY, note VARCHAR(64))` })
  check('CREATE succeeds on a writable connection', created.affectedRows >= 0, textOf(created))

  // 2. INSERT and read it back.
  const inserted = await call(execute, { connection: 'rw', sql: `INSERT INTO ${TABLE} (id, note) VALUES (1, 'hello'), (2, 'world')` })
  check('INSERT reports both rows', inserted.affectedRows === 2, textOf(inserted))
  check('INSERT reports no warnings', inserted.warnings === 0)

  const readBack = await call(query, { connection: 'rw', sql: `SELECT id, note FROM ${TABLE} ORDER BY id` })
  check('read-back sees both rows', readBack.rows.length === 2 && readBack.rows[0][1] === 'hello', JSON.stringify(readBack.rows))

  // 3. UPDATE reports the changed count.
  const updated = await call(execute, { connection: 'rw', sql: `UPDATE ${TABLE} SET note = 'changed' WHERE id = 1` })
  check('UPDATE reports one row', updated.affectedRows === 1, textOf(updated))

  // 4. DELETE.
  const deleted = await call(execute, { connection: 'rw', sql: `DELETE FROM ${TABLE} WHERE id = 2` })
  check('DELETE reports one row', deleted.affectedRows === 1, textOf(deleted))

  // 5. The SAME statement on the read-only connection must be refused by the plugin.
  try {
    await call(execute, { connection: 'ro', sql: `INSERT INTO ${TABLE} (id, note) VALUES (9, 'nope')` })
    check('read-only connection refuses a write', false, 'the write was allowed')
  } catch (error) {
    check('read-only connection refuses a write', /is read-only/.test(error.message), error.message)
  }

  // 6. Even on the writable connection, db_query still cannot write.
  try {
    await call(query, { connection: 'rw', sql: `INSERT INTO ${TABLE} (id, note) VALUES (9, 'nope')` })
    check('db_query refuses a write on a writable connection', false, 'the write was allowed')
  } catch (error) {
    check('db_query refuses a write on a writable connection', /read-only statements only/.test(error.message), error.message)
  }

  // 7. A missing table must surface as a clear message, not a raw driver stack.
  try {
    await call(execute, { connection: 'rw', sql: 'INSERT INTO _dsh_no_such_table (id) VALUES (1)' })
    check('missing table reports clearly', false, 'no error')
  } catch (error) {
    check('missing table reports clearly', /table does not exist/.test(error.message), error.message)
  }

  // 8. A genuine server error must also be explained.
  try {
    await call(execute, { connection: 'rw', sql: `INSERT INTO ${TABLE} (id, note) VALUES (1, 'duplicate')` })
    check('duplicate key reports clearly', false, 'no error')
  } catch (error) {
    check('duplicate key surfaces the server message', /Duplicate entry/.test(error.message), error.message.slice(0, 100))
  }

  // 9. The audit trail recorded the writes and none of the credential.
  // Seven statements reach the server before this point and every one of them is
  // recorded: the leftover-guard DROP, CREATE, INSERT, UPDATE, DELETE, the INSERT
  // into a missing table, and the duplicate-key INSERT. A refusal raised by the
  // plugin's own policy never reaches the driver, so the two refused writes above
  // are correctly absent from the trail.
  //
  // Waiting for the exact count is the point. The old `>= 5` was already true
  // while the last two appends were still queued, so the suite read a growing
  // file and counted whatever had landed -- a race, not a check.
  const EXPECTED_AUDIT_RECORDS = 7
  check('the audit trail recorded every write',
    await waitFor(() => auditLines().length >= EXPECTED_AUDIT_RECORDS, { label: `the audit file to hold ${EXPECTED_AUDIT_RECORDS} records` }))
  const auditText = fs.existsSync(auditFile) ? fs.readFileSync(auditFile, 'utf8') : ''
  const records = auditLines().map(line => JSON.parse(line))
  check('the audit trail has one record per write', records.length === EXPECTED_AUDIT_RECORDS, String(records.length))
  check('an audit record names the connection and the driver', records[0]?.connection === 'rw' && records[0]?.driver === 'mysql', JSON.stringify(records[0] ?? {}))
  check('a successful write is recorded as ok with its row count', records.some(record => record.ok === true && record.affectedRows === 2))
  check('a failed statement is recorded too', records.some(record => record.ok === false && /Duplicate entry|does not exist/.test(record.error ?? '')))
  check('the audit trail holds no credential', target.password === '' || auditText.includes(target.password) === false)
} finally {
  // 10. Clean up regardless of how the checks went.
  try {
    const dropped = await call(execute, { connection: 'rw', sql: `DROP TABLE IF EXISTS ${TABLE}` })
    check('cleanup dropped the probe table', dropped !== undefined)
  } catch (error) {
    check('cleanup dropped the probe table', false, error.message)
  }
  await live.dispose()
  fs.rmSync(auditDirectory, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)

/**
 * Write-path test. Proves the read-write mode actually works, that it is the
 * connection's `allowWrite` flag (not the tool) that decides, and that whatever
 * the test creates is removed afterwards.
 *
 * The table is created and dropped inside this test, on the configured test
 * database: DB_TEST_HOST / DB_TEST_USER / DB_TEST_PASSWORD / DB_TEST_DATABASE
 * (default 127.0.0.1, root, empty password, `test`).
 */
import { resolveConnections } from './src/config.js'
import { LiveConnections } from './src/live.js'
import { executeTool, queryTool } from './src/tools.js'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ` -> ${detail}`}`)
  if (!ok) failures += 1
}

const HOST = process.env.DB_TEST_HOST ?? '127.0.0.1'
const USER = process.env.DB_TEST_USER ?? 'root'
const PASSWORD = process.env.DB_TEST_PASSWORD ?? ''
const DATABASE = process.env.DB_TEST_DATABASE ?? 'test'
const live = new LiveConnections(resolveConnections({
  connections: [
    { name: 'ro', host: HOST, port: 3306, user: USER, password: PASSWORD, database: DATABASE },
    { name: 'rw', host: HOST, port: 3306, user: USER, password: PASSWORD, database: DATABASE, allowWrite: true },
  ],
}))
const query = queryTool(live)
const execute = executeTool(live)
const call = (tool, args) => tool.execute(args, { signal: undefined })
const textOf = value => JSON.stringify(value)

const TABLE = '_dsh_rw_probe'

// Clean any leftover from an interrupted earlier run.
try {
  await call(execute, { connection: 'rw', sql: `DROP TABLE IF EXISTS ${TABLE}` })
} catch { /* nothing to clean */ }

try {
  // 1. DDL through the writable connection.
  const created = await call(execute, { connection: 'rw', sql: `CREATE TABLE ${TABLE} (id INT PRIMARY KEY, note VARCHAR(64))` })
  check('CREATE succeeds on a writable connection', created.affectedRows === 0 || created.affectedRows >= 0, textOf(created))

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
} finally {
  // 9. Clean up regardless of how the checks went.
  try {
    const dropped = await call(execute, { connection: 'rw', sql: `DROP TABLE IF EXISTS ${TABLE}` })
    check('cleanup dropped the probe table', dropped !== undefined)
  } catch (error) {
    check('cleanup dropped the probe table', false, error.message)
  }
  try {
    const leftover = await call(query, { connection: 'rw', sql: `SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${DATABASE}' AND TABLE_NAME = '${TABLE}'` })
    check('no probe table remains', Number(leftover.rows[0][0]) === 0, JSON.stringify(leftover.rows))
  } catch (error) {
    check('no probe table remains', false, error.message)
  }
  live.dispose()
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)

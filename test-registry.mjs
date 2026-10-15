/**
 * Orchestration tests: everything `ConnectionRegistry` and the tools own, driven
 * by a stand-in engine.
 *
 * Row caps, cell conversion, notices, the read policy, formats, and the audit
 * hook are engine-independent, so a stub driver exercises them without a
 * database. What a real server adds is its own protocol behaviour, which the
 * driver suites and `test-integration.mjs` cover.
 */
import { resolveConnections } from './src/config.js'
import { LiveConnections } from './src/live.js'
import { assertSingleStatement, classify } from './src/sql.js'
import { executeTool, queryTool, schemaTool } from './src/tools.js'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ` -> ${detail}`}`)
  if (!ok) failures += 1
}
const throws = async (label, run, pattern) => {
  try {
    await run()
    check(label, false, 'nothing was thrown')
  } catch (error) {
    check(label, pattern.test(error.message), error.message)
  }
}

const RECORDED = []

/**
 * Build a stand-in engine for one connection.
 *
 * It answers from canned data, classifies through the real per-dialect
 * classifier, enforces the same one-statement rule a real driver enforces, and
 * honours the declared read-only mode — so the registry's own decisions are the
 * only thing under test.
 * @param {object} connection - the normalized connection.
 * @param {'server' | 'classify'} readOnly - the read-only capability to declare.
 * @returns {object} the driver.
 */
function stubDriver(connection, readOnly) {
  const dialect = connection.driver === 'doris' ? 'doris' : 'mysql'
  return {
    info: { id: connection.driver, label: 'Stub', defaultPort: 1, readOnly, readOnlyNote: '', promptNotes: [] },
    dialect,
    classify: sql => classify(sql, dialect),
    qualify: (database, table) => `${database}.${table}`,
    describe: error => (error instanceof Error ? error : new Error(String(error))),
    async fetch(sql) {
      assertSingleStatement(sql, dialect)
      RECORDED.push({ kind: 'fetch', sql, connection: connection.name })
      if (sql.includes('many')) {
        return { columns: ['id'], rows: Array.from({ length: connection.maxRows + 5 }, (_value, index) => [index]), notices: [] }
      }
      if (sql.includes('rich')) {
        return {
          columns: ['blob', 'when', 'big', 'long', 'cjk'],
          rows: [[
            Buffer.from([0xde, 0xad]),
            new Date('2026-01-02T03:04:05.000Z'),
            9007199254740993n,
            'x'.repeat(connection.maxCellChars + 20),
            '中文很宽',
          ]],
          notices: ['a driver-supplied notice'],
        }
      }
      return { columns: ['one'], rows: [[1]], notices: [] }
    },
    async execute(sql) {
      RECORDED.push({ kind: 'execute', sql, connection: connection.name })
      if (sql.includes('fail')) throw new Error('the server refused the write')
      return { affectedRows: 2, insertId: '7', info: 'Records: 2  Duplicates: 0', warnings: 1 }
    },
    async schema(target) {
      RECORDED.push({ kind: 'schema', target, connection: connection.name })
      if (target.table !== undefined) {
        return {
          level: 'table',
          database: 'stubdb',
          table: target.table,
          columns: [{ name: 'id', type: 'int', nullable: false, key: 'PRI', default: null, extra: '', comment: '' }],
          indexes: [{ name: 'PRIMARY', unique: true, position: 1, column: 'id', type: 'BTREE' }],
          ddl: 'CREATE TABLE `stubdb`.`t` (`id` int)',
          notices: [],
        }
      }
      if (target.database !== undefined) {
        return { level: 'tables', database: target.database, tables: [{ name: 't', type: 'BASE TABLE', engine: 'stub', approximateRows: 3, comment: '备注' }], notices: ['a notice'] }
      }
      return { level: 'databases', databases: ['stubdb'], notices: [] }
    },
    async ping() {
      return { reachable: true, version: 'stub-1.0' }
    },
    async dispose() {
      RECORDED.push({ kind: 'dispose', connection: connection.name })
    },
  }
}

const auditLines = []
const live = new LiveConnections(resolveConnections({
  connections: [
    { name: 'stub', driver: 'mysql', host: 'h', user: 'u', password: 'p', maxRows: 3, maxCellChars: 10, maxResultChars: 4000 },
    { name: 'tiny', driver: 'mysql', host: 'h', user: 'u', maxResultChars: 40 },
    { name: 'classify-only', driver: 'doris', host: 'h', user: 'u' },
    { name: 'rw', driver: 'mysql', host: 'h', user: 'u', allowWrite: true },
    { name: 'env', driver: 'mysql', host: 'h', user: 'u', passwordEnv: 'DBC_REGISTRY_NOT_SET' },
  ],
}), {
  audit: { record: entry => auditLines.push(entry) },
  createDriver: connection => stubDriver(connection, connection.name === 'classify-only' ? 'classify' : 'server'),
})

const query = queryTool(live)
const execute = executeTool(live)
const schema = schemaTool(live)
const call = (tool, args) => tool.execute(args, { signal: undefined })
// `output.render()` returns the content blocks; a tool call wraps them in
// `{ content }`. Both shapes reach these helpers.
const textOf = result => (Array.isArray(result) ? result : result.content).map(block => block.text ?? '').join('\n')

// ── row caps and notices ───────────────────────────────────────────────────
const many = await call(query, { connection: 'stub', sql: 'SELECT many' })
check('the row cap trims the rows', many.rows.length === 3, String(many.rows.length))
check('the total row count is still reported', many.totalRows === 8, String(many.totalRows))
check('trimming is reported, never silent', many.notices.some(notice => /showing the first 3 of 8/.test(notice)), JSON.stringify(many.notices))
check('the rendered result carries the notice', textOf(query.output.render({}, many)).includes('showing the first 3 of 8'))

// ── cell conversion ────────────────────────────────────────────────────────
const rich = await call(query, { connection: 'stub', sql: 'SELECT rich' })
check('a binary cell becomes hex', rich.rows[0][0].startsWith('0xdead'), String(rich.rows[0][0]))
check('a Date becomes ISO text', rich.rows[0][1] === '2026-01-02T03:04:05.000Z', String(rich.rows[0][1]))
check('a bigint stays exact', rich.rows[0][2] === '9007199254740993', String(rich.rows[0][2]))
check('an over-long cell is bounded and says so', /more chars\)$/.test(rich.rows[0][3]), String(rich.rows[0][3]).slice(-30))
check('a wide character cell survives', rich.rows[0][4] === '中文很宽')
check('a driver notice is preserved', rich.notices.includes('a driver-supplied notice'), JSON.stringify(rich.notices))

// ── formats and the result budget ──────────────────────────────────────────
const table = textOf(query.output.render({ format: 'table' }, rich))
const csv = textOf(query.output.render({ format: 'csv' }, rich))
const json = textOf(query.output.render({ format: 'json' }, rich))
check('the table format aligns by printed width', table.split('\n')[0].includes('blob') && table.split('\n')[2].startsWith('0xdead'))
check('the csv format leads with the header', csv.startsWith('blob,when,big,long,cjk'), csv.split('\n')[0])
check('the json format carries columns and rows', JSON.parse(json.split('\n\n')[0]).columns.length === 5)
check('the aligned table costs more than csv for this result', table.length > csv.length, `${table.length} vs ${csv.length}`)

const tiny = await call(query, { connection: 'tiny', sql: 'SELECT rich' })
const budgeted = textOf(query.output.render({ connection: 'tiny' }, tiny))
check('a result over maxResultChars is cut and says so', budgeted.includes('exceeded maxResultChars'), budgeted.slice(-150))
check('the budget follows the connection the call named', textOf(query.output.render({ connection: 'stub' }, tiny)).includes('exceeded maxResultChars') === false)

// ── the read policy ────────────────────────────────────────────────────────
await throws('a write through db_query is refused', () => call(query, { connection: 'stub', sql: 'DELETE FROM t' }), /read-only statements only/)
await throws('a session statement is refused', () => call(query, { connection: 'stub', sql: 'SET x = 1' }), /session or administrative/)
await throws('a multi-statement call is refused', () => call(query, { connection: 'stub', sql: 'SELECT 1; SELECT 2' }), /one statement per call/)
const unknownOnServer = await call(query, { connection: 'stub', sql: 'WITH c AS (SELECT 1) SELECT * FROM c' })
check('an unclassifiable statement reaches a server-backed engine', unknownOnServer.rows.length === 1)
await throws('an unclassifiable statement is refused on a classify-only engine',
  () => call(query, { connection: 'classify-only', sql: 'WITH c AS (SELECT 1) SELECT * FROM c' }), /could not be classified/)
await throws('an unknown connection is named with the list',
  () => call(query, { connection: 'nope', sql: 'SELECT 1' }), /configured names/)
await throws('an unusable connection explains itself',
  () => call(query, { connection: 'env', sql: 'SELECT 1' }), /not usable here/)

// ── writes and the audit hook ──────────────────────────────────────────────
await throws('a read-only connection refuses db_execute', () => call(execute, { connection: 'stub', sql: 'INSERT INTO t VALUES (1)' }), /is read-only/)
const written = await call(execute, { connection: 'rw', sql: 'INSERT INTO t VALUES (1)' })
check('a write reports the affected rows', written.affectedRows === 2 && written.insertId === '7', JSON.stringify(written))
check('a write reports the warnings and info', written.warnings === 1 && written.info.startsWith('Records: 2'))
check('a write is recorded in the audit trail', auditLines.length === 1 && auditLines[0].ok === true && auditLines[0].connection === 'rw', JSON.stringify(auditLines[0]))
check('the audit record measures and counts the call', typeof auditLines[0].elapsedMs === 'number' && auditLines[0].affectedRows === 2, JSON.stringify(auditLines[0]))
await throws('a failed write surfaces the server error', () => call(execute, { connection: 'rw', sql: 'INSERT INTO fail' }), /server refused/)
check('a failed write is recorded too',
  auditLines.length === 2 && auditLines[1].ok === false && /server refused/.test(auditLines[1].error ?? ''),
  JSON.stringify(auditLines[1]))

// ── schema rendering ───────────────────────────────────────────────────────
const databases = await call(schema, { connection: 'stub' })
check('the schema report carries the connection name', databases.connection === 'stub' && databases.level === 'databases')
const tables = await call(schema, { connection: 'stub', database: 'stubdb' })
check('the tables level renders its rows and notices', textOf(schema.output.render({}, tables)).includes('stubdb'))
check('the schema alias accepts `schema` for `database`', (await call(schema, { connection: 'stub', schema: 'stubdb' })).database === 'stubdb')
const tableOne = await call(schema, { connection: 'stub', database: 'stubdb', table: 't' })
const rendered = textOf(schema.output.render({}, tableOne))
check('the table level renders columns, indexes, and DDL', rendered.includes('PRI') && rendered.includes('PRIMARY') && rendered.includes('CREATE TABLE'))

// ── argument validation runs in front of the driver ────────────────────────
await throws('a missing required argument is refused', () => call(query, { connection: 'stub' }), /sql is required/)
await throws('an unknown argument is refused', () => call(query, { connection: 'stub', sql: 'SELECT 1', nope: 1 }), /not a recognized argument/)
await throws('a wrong argument type is refused', () => call(query, { connection: 'stub', sql: 5 }), /sql must be a string/)
await throws('a bad format value is refused', () => call(query, { connection: 'stub', sql: 'SELECT 1', format: 'xml' }), /format must be one of/)

// ── ping and disposal ──────────────────────────────────────────────────────
check('ping answers through the driver', (await live.registry.ping('stub')).version === 'stub-1.0')
await live.dispose()
const disposed = RECORDED.filter(entry => entry.kind === 'dispose').map(entry => entry.connection).sort()
check('disposal reaches every driver that was created', disposed.join(',') === 'classify-only,rw,stub,tiny', disposed.join(','))
check('a connection refused before use never created a driver', disposed.includes('env') === false)

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)

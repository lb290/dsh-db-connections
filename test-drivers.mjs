/**
 * Driver-layer tests: statement classification and single-statement enforcement
 * per dialect, identifier quoting, and every pure mapping each driver uses to
 * turn a driver answer into the schema report. No database is needed.
 */
import { DRIVER_CATALOG, createDriver, driverChoices, driverInfo } from './src/drivers/index.js'
import { DRIVER_INFO as MYSQL_INFO, mapColumns as mysqlColumns, mapIndexes as mysqlIndexes, mapTables as mysqlTables } from './src/drivers/mysql.js'
import { composeDdl, mapColumns as pgColumns, mapIndexes as pgIndexes, mapTables as pgTables } from './src/drivers/postgres.js'
import {
  affectedRowsOf, ddlFromCreateTable, mapDescribe, mapResult, mapTableList, parseResponse, timeSeriesNotice,
} from './src/drivers/tdengine.js'
import { assertSingleStatement, classify, leadingKeyword, quoteIdent, quoteQualified, statementCount } from './src/sql.js'

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

// ── classification ──────────────────────────────────────────────────────────
check('a select reads on every dialect', ['mysql', 'doris', 'postgres', 'tdengine'].every(d => classify('SELECT 1', d) === 'read'))
check('an explain reads', classify('EXPLAIN SELECT 1', 'postgres') === 'read')
check('a describe reads', classify('DESCRIBE demo.t', 'tdengine') === 'read')
check('TABLE reads on mysql', classify('TABLE t', 'mysql') === 'read')
check('TABLE is unknown elsewhere', classify('TABLE t', 'tdengine') === 'unknown')
check('an insert writes', classify('insert into t values (1)', 'mysql') === 'write')
check('a CTE is unknown', classify('WITH c AS (SELECT 1) SELECT * FROM c', 'doris') === 'unknown')
check('a session statement is control', classify('SET SESSION autocommit = 0', 'mysql') === 'control')
check('USE is control', classify('USE demo', 'tdengine') === 'control')
check('a leading comment does not hide the keyword', leadingKeyword('/* note */ -- x\n  SELECT 1') === 'select')
check('a keyword inside a literal is not the leading keyword', leadingKeyword("- 1") === '')

// ── single-statement enforcement ────────────────────────────────────────────
const counts = [
  ['SELECT 1', 'mysql', 1],
  ['SELECT 1;', 'mysql', 1],
  ['SELECT 1; SELECT 2', 'mysql', 2],
  ["SELECT ';' AS semi", 'mysql', 1],
  ["SELECT 'a\\'; DROP TABLE t; --'", 'mysql', 1],
  ['-- only a comment', 'mysql', 0],
  ['/* only a comment */', 'postgres', 0],
  ['SELECT $$;$$ AS dollar', 'postgres', 1],
  ['SELECT 1; -- trailing comment', 'mysql', 1],
  ['SELECT `a;b` FROM t', 'mysql', 1],
  ['SELECT "a;b" FROM t', 'postgres', 1],
  ['SELECT 1;\nSELECT 2;', 'tdengine', 2],
]
for (const [sql, dialect, expected] of counts) {
  check(`statementCount(${JSON.stringify(sql.slice(0, 28))}, ${dialect}) === ${expected}`, statementCount(sql, dialect) === expected, String(statementCount(sql, dialect)))
}
throws('an empty statement is refused', () => assertSingleStatement('   ', 'mysql'), /empty/)
throws('two statements are refused', () => assertSingleStatement('SELECT 1; DROP TABLE t', 'postgres'), /one statement per call/)

// ── quoting ────────────────────────────────────────────────────────────────
check('mysql quotes with backticks', quoteIdent('a`b', 'mysql') === '`a``b`', quoteIdent('a`b', 'mysql'))
check('postgres quotes with double quotes', quoteIdent('a"b', 'postgres') === '"a""b"', quoteIdent('a"b', 'postgres'))
check('tdengine quotes with backticks', quoteQualified('db', 't', 'tdengine') === '`db`.`t`')
check('postgres qualifies with double quotes', quoteQualified('s', 't', 'postgres') === '"s"."t"')

// ── catalog ────────────────────────────────────────────────────────────────
check('the catalog holds four engines', DRIVER_CATALOG.length === 4, DRIVER_CATALOG.map(entry => entry.id).join(','))
check('the catalog carries the right default ports',
  ['mysql:3306', 'doris:9030', 'postgres:5432', 'tdengine:6041'].every(entry => {
    const [id, port] = entry.split(':')
    return driverInfo(id)?.defaultPort === Number(port)
  }))
check('only MySQL and PostgreSQL promise server-enforced read-only',
  DRIVER_CATALOG.filter(entry => entry.readOnly === 'server').map(entry => entry.id).join(',') === 'mysql,postgres')
check('the picker projection hides internals', driverChoices().every(choice => choice.id !== undefined && choice.label !== undefined && choice.defaultPort !== undefined && choice.promptNotes === undefined))
check('mysql defaults to 200 rows and tdengine to 50',
  MYSQL_INFO.mysql.id === 'mysql' && MYSQL_INFO.doris.readOnly === 'classify')

const connectionFor = driver => ({ name: 'x', driver, host: 'h', port: 1, user: 'u', password: '', allowWrite: false, ssl: false, connectTimeoutMs: 1000, queryTimeoutMs: 1000, maxRows: 10, maxCellChars: 10, maxDdlChars: 10, maxResultChars: 10, connectionLimit: 1 })
check('createDriver dispatches doris to the MySQL-protocol driver', createDriver(connectionFor('doris')).dialect === 'doris')
check('createDriver dispatches postgres', createDriver(connectionFor('postgres')).dialect === 'postgres')
check('createDriver dispatches tdengine', createDriver(connectionFor('tdengine')).dialect === 'tdengine')
throws('an unknown driver is refused', () => createDriver(connectionFor('oracle')), /no driver is registered/)

// ── MySQL-protocol mappings ────────────────────────────────────────────────
const mysqlColumnRows = [['id', 'int unsigned', 'NO', 'PRI', null, 'auto_increment', '主键']]
const mappedMysqlColumns = mysqlColumns(mysqlColumnRows)
check('mysql columns map every field', mappedMysqlColumns[0].name === 'id' && mappedMysqlColumns[0].nullable === false && mappedMysqlColumns[0].key === 'PRI' && mappedMysqlColumns[0].extra === 'auto_increment' && mappedMysqlColumns[0].comment === '主键', JSON.stringify(mappedMysqlColumns[0]))
check('mysql indexes map uniqueness', mysqlIndexes([['PRIMARY', 0, 1, 'id', 'BTREE']])[0].unique === true)
check('mysql tables map the engine and estimate', mysqlTables([['t', 'BASE TABLE', 'InnoDB', 42, '']])[0].approximateRows === 42)

// ── PostgreSQL mappings ────────────────────────────────────────────────────
const pgColumnRows = [{ column_name: 'id', column_type: 'integer', nullable: false, column_default: "nextval('t_id_seq'::regclass)", comment: '', column_key: 'PRI', extra: 'identity' }]
const mappedPgColumns = pgColumns(pgColumnRows)
check('postgres columns map identity and default', mappedPgColumns[0].key === 'PRI' && mappedPgColumns[0].extra === 'identity' && mappedPgColumns[0].default.startsWith('nextval'), JSON.stringify(mappedPgColumns[0]))
check('postgres reports an absent default as null', pgColumns([{ column_name: 'a', column_type: 'text', nullable: true, column_default: '', comment: 'x', column_key: '', extra: '' }])[0].default === null)
check('postgres indexes map uniqueness and position', pgIndexes([{ index_name: 't_pkey', is_unique: true, position: 1, column_name: 'id', index_type: 'btree', definition: 'CREATE UNIQUE INDEX t_pkey ON s.t USING btree (id)' }])[0].position === 1)
check('postgres tables map the relation kind', pgTables([{ table_name: 't', table_type: 'BASE TABLE', approximate_rows: 7, comment: '' }])[0].approximateRows === 7)

const ddl = composeDdl('public', 't', [
  { name: 'id', type: 'integer', nullable: false, key: 'PRI', default: null },
  { name: 'note', type: 'text', nullable: true, key: '', default: null },
], ['CREATE UNIQUE INDEX t_pkey ON public.t USING btree (id)'])
check('the assembled postgres DDL quotes, not-nulls, and keys', ddl.includes('CREATE TABLE "public"."t"') && ddl.includes('"id" integer NOT NULL') && ddl.includes('PRIMARY KEY ("id")') && ddl.includes('CREATE UNIQUE INDEX t_pkey'), ddl.replaceAll('\n', ' ⏎ '))
check('the assembled postgres DDL keeps the index definition from the server', ddl.includes('USING btree (id)'))

// ── TDengine ───────────────────────────────────────────────────────────────
const okAnswer = JSON.stringify({ code: 0, column_meta: [['ts', 'TIMESTAMP', 8], ['current', 'FLOAT', 4]], data: [['2026-01-01T00:00:00.000Z', 10.5]], rows: 1 })
const parsed = parseResponse(okAnswer, connectionFor('tdengine'))
check('a successful answer parses', parsed.code === 0)
const mapped = mapResult(parsed)
check('column_meta becomes the column list', mapped.columns.join(',') === 'ts,current', JSON.stringify(mapped.columns))
check('data becomes positional rows', mapped.rows[0][0] === '2026-01-01T00:00:00.000Z' && mapped.rows[0][1] === 10.5)

check('a write answer reports affected rows', affectedRowsOf({ code: 0, column_meta: [['affected_rows', 'INT', 4]], data: [[3]], rows: 1 }) === 3)
check('a DDL answer without rows reports zero', affectedRowsOf({ code: 0, column_meta: [['affected_rows', 'INT', 4]], data: [[0]], rows: 1 }) === 0)
check('an answer with a different first column reports zero', affectedRowsOf({ code: 0, column_meta: [['ts', 'TIMESTAMP', 8]], data: [['x']], rows: 1 }) === 0)

// The documented failure mode: HTTP 200 with a non-zero code.
throws('a non-zero code fails even though the HTTP status was 200',
  () => parseResponse(JSON.stringify({ code: 9728, desc: 'syntax error near "1"' }), connectionFor('tdengine')),
  /not valid TDengine SQL syntax/)
throws('a missing table is reported in words',
  () => parseResponse(JSON.stringify({ code: 866, desc: 'Table does not exist' }), connectionFor('tdengine')),
  /table does not exist/)
throws('an authentication failure is reported in words',
  () => parseResponse(JSON.stringify({ code: 855, desc: '' }), connectionFor('tdengine')),
  /authentication failed/)
throws('a non-JSON answer is reported as such',
  () => parseResponse('<html>502</html>', connectionFor('tdengine')),
  /not JSON/)

const notices = [
  ['SELECT * FROM demo.t', /no `ts` range/],
  ['SELECT * FROM demo.t WHERE ts >= "2026-01-01"', undefined],
  ['SELECT * FROM demo.t WHERE ts BETWEEN "a" AND "b"', undefined],
  ['SELECT COUNT(*) FROM demo.t INTERVAL(1h)', undefined],
  ['SELECT COUNT(*) FROM demo.t PARTITION BY ts', undefined],
  ['SELECT COUNT(*) FROM demo.t PARTITION BY tbname', /no `ts` range/],
  ['SHOW TABLES', undefined],
  ['DESCRIBE demo.t', undefined],
]
for (const [sql, expected] of notices) {
  const notice = timeSeriesNotice(sql)
  check(`timeSeriesNotice(${JSON.stringify(sql.slice(0, 34))})`, expected === undefined ? notice === undefined : expected.test(notice ?? ''), String(notice))
}

const describeRows = [['ts', 'TIMESTAMP', 8, ''], ['current', 'FLOAT', 4, ''], ['site', 'NCHAR', 20, 'TAG']]
const described = mapDescribe(['field', 'type', 'length', 'note'], describeRows)
check('DESCRIBE maps the timestamp as the primary key', described[0].key === 'PRI' && described[0].nullable === false, JSON.stringify(described[0]))
check('DESCRIBE keeps the length in the type', described[1].type === 'FLOAT(4)')
check('DESCRIBE marks a tag', described[2].key === 'TAG' && described[2].extra === 'TAG', JSON.stringify(described[2]))

const stables = mapTableList(['stable_name', 'create_time'], [['meters', 'x']], 'STABLE')
check('SHOW STABLES maps to STABLE rows', stables[0].type === 'STABLE' && stables[0].name === 'meters', JSON.stringify(stables[0]))
const childTables = mapTableList(['table_name', 'create_time', 'stable_name'], [['d1001', 'x', 'meters']], 'TABLE')
check('SHOW TABLES keeps the parent super table as the comment', childTables[0].comment === 'meters' && childTables[0].type === 'TABLE', JSON.stringify(childTables[0]))

// Measured against TDengine 3.3.5.2: `SHOW CREATE TABLE` answers with the two
// columns `Table` and `Create Table`, so the statement is not the first cell.
// Reading the first returned the table's own name as if it were the DDL.
const realCreateAnswer = ddlFromCreateTable(['Table', 'Create Table'], [['meters', 'CREATE TABLE `meters` (ts TIMESTAMP)']])
check('SHOW CREATE TABLE takes the statement, not the table name',
  realCreateAnswer === 'CREATE TABLE `meters` (ts TIMESTAMP)', realCreateAnswer)
check('SHOW CREATE TABLE finds the column after one the server adds later',
  ddlFromCreateTable(['#', 'Table', 'Create Table'], [['1', 'meters', 'CREATE TABLE `t`']]) === 'CREATE TABLE `t`')
check('SHOW CREATE TABLE falls back to the last column when no name matches',
  ddlFromCreateTable(['a', 'b'], [[1, 'DDL']]) === 'DDL')
check('an empty SHOW CREATE TABLE answer yields no DDL', ddlFromCreateTable(['Table', 'Create Table'], []) === '')
check('a null DDL cell yields an empty string', ddlFromCreateTable(['Table', 'Create Table'], [['meters', null]]) === '')

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)

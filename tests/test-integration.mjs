/**
 * Integration test: exercises the real registry, tools, and prompt rendering
 * against a live MySQL server, without needing the harness.
 *
 * Point DB_TEST_HOST / DB_TEST_PORT / DB_TEST_USER / DB_TEST_PASSWORD /
 * DB_TEST_DATABASE at a MySQL you own; the defaults target 127.0.0.1:3306 with
 * user root and no password. Without a reachable server the suite reports SKIP.
 */
import { resolveConnections } from '../src/config.js'
import { LiveConnections } from '../src/live.js'
import { renderConnections } from '../src/prompt.js'
import { executeTool, queryTool, schemaTool } from '../src/tools.js'
import { requireMysql } from './tests-support.mjs'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ` -> ${detail}`}`)
  if (!ok) failures += 1
}

const target = await requireMysql()
const live = new LiveConnections(resolveConnections({
  connections: [
    { name: '128', host: target.host, port: target.port, user: target.user, password: target.password,
      database: target.database, description: '开发库' },
    { name: '128-nodb', host: target.host, port: target.port, user: target.user, password: target.password },
  ],
}))

const defs = {
  query: queryTool(live),
  schema: schemaTool(live),
  execute: executeTool(live),
}
const call = (which, args) => defs[which].execute(args, { signal: undefined })
const show = (label, content) => {
  console.log(`\n=== ${label} ===`)
  console.log(content.map(block => block.text).join('\n'))
}

console.log('--- prompt section ---')
const prompt = renderConnections(live.connections)
console.log(prompt)
check('the prompt names the connection without its address', prompt.includes('`128`') && prompt.includes(target.host) === false)
check('the prompt reports the engine', prompt.includes('MySQL'))

// 1. schema: list databases (connection with no default schema)
const databases = await call('schema', { connection: '128-nodb' })
show('db_schema (databases)', defs.schema.output.render({}, databases))
check('db_schema lists databases', databases.level === 'databases' && databases.databases.length > 0)
check('engine schemas are hidden and reported', databases.databases.includes('information_schema') === false && databases.notices.length > 0, JSON.stringify(databases.notices))

// 2. schema: tables of the connection's default schema
const tables = await call('schema', { connection: '128' })
show('db_schema (tables)', defs.schema.output.render({}, tables))
check('db_schema lists tables', tables.level === 'tables' && Array.isArray(tables.tables))

// 3. read query
const read = await call('query', { connection: '128', sql: 'SELECT 1 AS one, \'two\' AS two' })
show('db_query (SELECT)', defs.query.output.render({}, read))
// Exact-numeric columns stay strings on the way to the model (see the driver's
// header), so a literal 1 arrives as "1". What matters here is the row and its
// contents, not the JavaScript type that carries them.
check('db_query returns rows', read.rows.length === 1 && String(read.rows[0][0]) === '1' && read.rows[0][1] === 'two', JSON.stringify(read.rows))
check('db_query reports column names', read.columns[0] === 'one', JSON.stringify(read.columns))

// 4. formats render from the same canonical value
const csv = defs.query.output.render({ format: 'csv' }, read)[0].text
const csvLines = csv.split('\n')
check('csv format renders a header and one row',
  csvLines[0] === 'one,two' && csvLines[1] === '1,two' && /1 row in \d+ ms/u.test(csv),
  csv.replaceAll('\n', ' | '))
check('json format renders the canonical value', JSON.parse(defs.query.output.render({ format: 'json' }, read)[0].text).rows.length === 1)

// 5. read-only enforcement: a write through db_query must be refused
const refusal = async (label, which, args, pattern) => {
  try {
    await call(which, args)
    check(label, false, 'the call was allowed')
  } catch (error) {
    check(label, pattern.test(error.message), error.message)
  }
}

await refusal('db_query write', 'query', { connection: '128', sql: 'CREATE TABLE _dsh_ro_probe (id INT)' }, /read-only statements only/)
// `WITH` is deliberately absent from the classifier's read vocabulary, because a
// CTE can front a write. On a server-enforced engine that means the statement is
// admitted on purpose and the read-only transaction is the gate -- the
// classify-only engines (Doris, TDengine) refuse it outright instead. MySQL 8
// stops this particular form in its own parser, because DELETE cannot target a
// CTE, so the read-only error never gets its turn; that is why the pattern also
// accepts the server's wording. What this check proves is that the statement did
// not run, whichever layer stopped it.
await refusal('CTE-led write', 'query', { connection: '128', sql: 'WITH c AS (SELECT 1 AS id) DELETE FROM c' }, /writes|read-only|not updatable/)
await refusal('db_execute on read-only', 'execute', { connection: '128', sql: 'SELECT 1' }, /is read-only/)
await refusal('unknown connection', 'query', { connection: 'nope', sql: 'SELECT 1' }, /no database connection is named/)
await refusal('missing sql argument', 'query', { connection: '128' }, /sql is required/)
await refusal('bad schema target', 'schema', { connection: '128-nodb', table: 'sys_user' }, /needs a schema/)
await refusal('session statement', 'query', { connection: '128', sql: 'SET SESSION autocommit = 0' }, /session or administrative/)
await refusal('two statements in one call', 'query', { connection: '128', sql: 'SELECT 1; SELECT 2' }, /one statement per call/)

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
await live.dispose()
process.exit(failures === 0 ? 0 : 1)

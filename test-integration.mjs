/**
 * Integration test: exercises the real registry, tools, and prompt rendering
 * against the live MySQL server, without needing the harness.
 *
 * Point DB_TEST_HOST / DB_TEST_USER / DB_TEST_PASSWORD / DB_TEST_DATABASE at a
 * MySQL you own; the defaults target 127.0.0.1 with user root and no password.
 */
import { resolveConnections } from './src/config.js'
import { renderConnections } from './src/prompt.js'
import { LiveConnections } from './src/live.js'
import { executeTool, queryTool, schemaTool } from './src/tools.js'

const HOST = process.env.DB_TEST_HOST ?? '127.0.0.1'
const USER = process.env.DB_TEST_USER ?? 'root'
const PASSWORD = process.env.DB_TEST_PASSWORD ?? ''
const DATABASE = process.env.DB_TEST_DATABASE ?? 'test'
const connections = resolveConnections({
  connections: [
    { name: '128', host: HOST, port: 3306, user: USER, password: PASSWORD,
      database: DATABASE, description: '开发库' },
    { name: '128-nodb', host: HOST, port: 3306, user: USER, password: PASSWORD },
  ],
})
const live = new LiveConnections(connections)

const defs = {
  query: queryTool(live),
  schema: schemaTool(live),
  execute: executeTool(live),
}
const call = async (which, args) => defs[which].execute(args, { signal: undefined })
const show = (label, content) => {
  console.log(`\n=== ${label} ===`)
  console.log(content.map(b => b.text).join('\n'))
}

console.log('--- prompt section ---')
console.log(renderConnections(live.connections))

// 1. schema: list databases (connection with no default schema)
show('db_schema (databases)', defs.schema.output.render({}, await call('schema', { connection: '128-nodb' })))

// 2. schema: tables of the connection's default schema
show('db_schema (tables)', defs.schema.output.render({}, await call('schema', { connection: '128' })))

// 3. schema: table columns + indexes + DDL
show('db_schema (table sys_user)', defs.schema.output.render({}, await call('schema', { connection: '128', table: 'sys_user' })))

// 4. read query
show('db_query (SELECT)', defs.query.output.render({}, await call('query', { connection: '128', sql: 'SELECT id, username, realname FROM sys_user LIMIT 5' })))

// 5. read-only enforcement: a write through db_query must be refused
const refusal = async (label, which, args) => {
  try {
    await call(which, args)
    console.log(`\n!!! FAIL (${label}): the call was allowed`)
  } catch (e) {
    console.log(`\n=== ${label} (expected refusal) ===`)
    console.log(e.message)
  }
}

await refusal('db_query write', 'query', { connection: '128', sql: "UPDATE sys_user SET username='x' WHERE id=1" })
await refusal('CTE-led write', 'query', { connection: '128', sql: 'WITH c AS (SELECT id FROM sys_user LIMIT 1) UPDATE sys_user SET username=username WHERE id IN (SELECT id FROM c)' })
await refusal('INTO OUTFILE', 'query', { connection: '128', sql: "SELECT 1 INTO OUTFILE 'C:/ro_probe.txt'" })
await refusal('db_execute on read-only', 'execute', { connection: '128', sql: 'SELECT 1' })
await refusal('unknown connection', 'query', { connection: 'nope', sql: 'SELECT 1' })
await refusal('missing sql argument', 'query', { connection: '128' })
await refusal('bad schema target', 'schema', { connection: '128-nodb', table: 'sys_user' })

live.dispose()

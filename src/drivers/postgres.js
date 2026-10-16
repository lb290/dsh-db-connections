/**
 * PostgreSQL driver, built on `pg`.
 *
 * Three dialect facts shape this module:
 *
 * 1. A read runs inside `BEGIN TRANSACTION READ ONLY`, which the server refuses
 *    to write from (SQLSTATE 25006) even for a superuser. That is the same
 *    guarantee MySQL gives, expressed in PostgreSQL's syntax.
 * 2. `SHOW CREATE TABLE` does not exist. The `ddl` field is therefore assembled
 *    from the catalog — columns plus the server's own `pg_get_indexdef` output —
 *    and the result says so.
 * 3. `pg` hands back JavaScript `Date` objects for temporal columns. They are
 *    parsed back to the server's own text, matching the `dateStrings` decision on
 *    the MySQL side, so no time zone is invented between the server and the model.
 *
 * `pg` is imported on first use, so a deployment that never configures a
 * PostgreSQL connection does not need the package installed.
 *
 * Catalog queries use `attgenerated`, which exists from PostgreSQL 12.
 *
 * @module dsh-db-connections/drivers/postgres
 */

import { assertSingleStatement, classify, quoteIdent } from '../sql.js'
import { asError, isReadOnlyRefusal, transportMessage } from '../errors.js'

/** Display and capability facts for this driver. */
export const DRIVER_INFO = Object.freeze({
  id: 'postgres',
  label: 'PostgreSQL',
  defaultPort: 5432,
  readOnly: 'server',
  readOnlyNote: 'Every statement db_query runs is wrapped in a server-enforced read-only transaction.',
  promptNotes: Object.freeze([
    'On PostgreSQL a connection belongs to one database, so `database` names a schema; table references are `schema.table`.',
  ]),
})

/** `pg` type OIDs whose values must stay the server's own text. */
const TEXT_TYPE_OIDS = Object.freeze([1082, 1114, 1184]) // date, timestamp, timestamptz

/** PostgreSQL SQLSTATE codes translated into an actionable message. */
const PG_MESSAGES = Object.freeze({
  '28P01': connection => `authentication failed for user ${JSON.stringify(connection.user)} on ${connection.host}:${connection.port}`,
  '28000': connection => `the server refused user ${JSON.stringify(connection.user)}: check pg_hba.conf on ${connection.host}:${connection.port}`,
  '3D000': connection => `database ${JSON.stringify(connection.database)} does not exist on ${connection.host}:${connection.port}`,
  '42P01': () => 'the table does not exist',
  '42703': () => 'a column in the statement does not exist',
  '42601': () => 'the statement is not valid PostgreSQL syntax',
  '42501': connection => `user ${JSON.stringify(connection.user)} may not read that relation`,
  '42P07': () => 'a relation with that name already exists',
  '53300': connection => `the server at ${connection.host}:${connection.port} already has too many clients`,
  '57014': connection => `the query exceeded the ${connection.queryTimeoutMs} ms limit`,
})

const SCHEMA_QUERY = 'SELECT nspname FROM pg_namespace WHERE nspname !~ \'^pg_\' AND nspname <> \'information_schema\' ORDER BY nspname'

const TABLE_QUERY = `SELECT c.relname AS table_name,
       CASE c.relkind
         WHEN 'r' THEN 'BASE TABLE' WHEN 'p' THEN 'PARTITIONED TABLE'
         WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW'
         WHEN 'f' THEN 'FOREIGN TABLE' ELSE c.relkind::text END AS table_type,
       COALESCE(s.n_live_tup, 0) AS approximate_rows,
       COALESCE(obj_description(c.oid, 'pg_class'), '') AS comment
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
ORDER BY c.relname`

const COLUMN_QUERY = `SELECT a.attname AS column_name,
       format_type(a.atttypid, a.atttypmod) AS column_type,
       (NOT a.attnotnull) AS nullable,
       COALESCE(pg_get_expr(d.adbin, d.adrelid), '') AS column_default,
       COALESCE(col_description(c.oid, a.attnum), '') AS comment,
       CASE WHEN pk.attnum IS NOT NULL THEN 'PRI' ELSE '' END AS column_key,
       CASE WHEN a.attidentity <> '' THEN 'identity' WHEN a.attgenerated <> '' THEN 'generated' ELSE '' END AS extra
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
LEFT JOIN (SELECT i.indrelid, unnest(i.indkey) AS attnum FROM pg_index i WHERE i.indisprimary) pk
  ON pk.indrelid = a.attrelid AND pk.attnum = a.attnum
WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND a.attisdropped = false
ORDER BY a.attnum`

const INDEX_QUERY = `SELECT i.relname AS index_name,
       ix.indisunique AS is_unique,
       k.ordinality AS position,
       COALESCE(a.attname, '') AS column_name,
       am.amname AS index_type,
       pg_get_indexdef(ix.indexrelid) AS definition
FROM pg_index ix
JOIN pg_class i ON i.oid = ix.indexrelid
JOIN pg_class t ON t.oid = ix.indrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
JOIN pg_am am ON am.oid = i.relam
JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ordinality) ON true
LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
WHERE n.nspname = $1 AND t.relname = $2
ORDER BY i.relname, k.ordinality`

/**
 * Map catalog column rows to the schema report's column entries.
 * @param {object[]} rows - rows from {@link COLUMN_QUERY}.
 * @returns {object[]} the mapped columns.
 */
export function mapColumns(rows) {
  return rows.map(row => ({
    name: String(row.column_name),
    type: String(row.column_type),
    nullable: row.nullable === true,
    key: String(row.column_key ?? ''),
    default: row.column_default === '' || row.column_default === undefined ? null : String(row.column_default),
    extra: String(row.extra ?? ''),
    comment: String(row.comment ?? ''),
  }))
}

/**
 * Map catalog index rows to the schema report's index entries.
 * @param {object[]} rows - rows from {@link INDEX_QUERY}.
 * @returns {object[]} the mapped indexes.
 */
export function mapIndexes(rows) {
  return rows.map(row => ({
    name: String(row.index_name),
    unique: row.is_unique === true,
    position: Number(row.position),
    column: String(row.column_name ?? ''),
    type: String(row.index_type),
  }))
}

/**
 * Map catalog table rows to the schema report's table entries.
 * @param {object[]} rows - rows from {@link TABLE_QUERY}.
 * @returns {object[]} the mapped tables.
 */
export function mapTables(rows) {
  return rows.map(row => ({
    name: String(row.table_name),
    type: String(row.table_type),
    engine: 'heap',
    // `pg_stat_user_tables.n_live_tup` is an estimate, like InnoDB's TABLE_ROWS.
    approximateRows: Number(row.approximate_rows),
    comment: String(row.comment ?? ''),
  }))
}

/**
 * Assemble a `CREATE TABLE` statement from the catalog.
 *
 * PostgreSQL keeps the original statement text to itself, so this is a faithful
 * reconstruction rather than a quotation: column order, types, defaults, the
 * primary key, and the server's own index definitions.
 * @param {string} database - the schema name.
 * @param {string} table - the table name.
 * @param {object[]} columns - entries from {@link mapColumns}.
 * @param {string[]} definitions - `pg_get_indexdef` output, one per index.
 * @returns {string} the assembled DDL.
 */
export function composeDdl(database, table, columns, definitions) {
  const definitionsFor = column => [
    `${quoteIdent(column.name, 'postgres')} ${column.type}`,
    column.nullable ? '' : 'NOT NULL',
    column.default === null ? '' : `DEFAULT ${column.default}`,
  ].filter(part => part !== '').join(' ')
  const lines = columns.map(definitionsFor)
  const primaryKey = columns.filter(column => column.key === 'PRI').map(column => quoteIdent(column.name, 'postgres'))
  if (primaryKey.length > 0) lines.push(`PRIMARY KEY (${primaryKey.join(', ')})`)
  const head = `CREATE TABLE ${quoteIdent(database, 'postgres')}.${quoteIdent(table, 'postgres')} (\n  ${lines.join(',\n  ')}\n);`
  return [head, ...definitions.map(definition => `${definition};`)].join('\n\n')
}

/** The `pg` module, imported on first use so a MySQL-only install needs nothing. */
let pgModule

/**
 * Load `pg` once and pin its temporal parsers to the server's own text.
 * @returns {Promise<object>} the `pg` module namespace.
 * @throws {Error} when the package is not installed.
 */
async function loadPg() {
  if (pgModule !== undefined) return pgModule
  let loaded
  try {
    loaded = await import('pg')
  } catch {
    throw new Error('this connection needs the "pg" package: run `npm install pg` in the dsh-db-connections directory, then restart')
  }
  pgModule = loaded.default ?? loaded
  for (const oid of TEXT_TYPE_OIDS) pgModule.types.setTypeParser(oid, value => value)
  return pgModule
}

/**
 * Build the PostgreSQL driver for one connection.
 * @param {object} connection - the normalized connection.
 * @returns {object} the driver instance.
 */
export function createPostgresDriver(connection) {
  const info = DRIVER_INFO
  /** @type {object | undefined} */
  let pool

  /**
   * Translate one driver failure into an actionable message.
   * @param {unknown} error - the thrown value.
   * @param {'read' | 'write'} mode - whether the failed statement was a read.
   * @returns {Error} the error to surface.
   */
  function describe(error, mode) {
    const identifier = JSON.stringify(connection.name)
    if (isReadOnlyRefusal(error)) {
      return new Error(mode === 'read'
        ? `${identifier} rejected this statement: it writes, and db_query runs reads only. Use db_execute to change data.`
        : `${identifier} rejected this statement: the connection is read-only.`)
    }
    const transport = transportMessage(error, connection)
    if (transport !== undefined) return new Error(`${transport} (connection ${identifier})`)
    const known = PG_MESSAGES[error?.code]
    if (known !== undefined) return new Error(`${known(connection)} (connection ${identifier})`)
    return asError(error)
  }

  /**
   * Create the pool on first use.
   * @returns {Promise<object>} the pool.
   */
  async function poolFor() {
    if (pool !== undefined) return pool
    const pg = await loadPg()
    pool = new pg.Pool({
      host: connection.host,
      port: connection.port,
      user: connection.user,
      password: connection.password,
      ...connection.database === undefined ? {} : { database: connection.database },
      application_name: 'dsh-db-connections',
      max: connection.connectionLimit,
      connectionTimeoutMillis: connection.connectTimeoutMs,
      idleTimeoutMillis: 30_000,
      // Both deadline layers: the server stops the statement, and the client
      // gives up on a server that never answers.
      statement_timeout: connection.queryTimeoutMs,
      query_timeout: connection.queryTimeoutMs,
      ...connection.ssl === false ? {} : { ssl: connection.ssl === true ? { rejectUnauthorized: true } : connection.ssl },
    })
    // A pool-level error (a backend that dies between checkouts) must not take
    // the process down; the checkout path reports the failure to the caller.
    pool.on('error', () => {})
    return pool
  }

  /**
   * Run one function against a checked-out client.
   * @param {AbortSignal | undefined} signal - caller cancellation.
   * @param {(client: object) => Promise<unknown>} run - the work to perform.
   * @returns {Promise<unknown>} the work's result.
   */
  async function withConnection(signal, run) {
    if (signal?.aborted === true) {
      const error = new Error('the call was cancelled before it ran')
      error.name = 'AbortError'
      throw error
    }
    const active = await poolFor()
    let client
    try {
      client = await active.connect()
    } catch (error) {
      throw describe(error, 'read')
    }
    const onAbort = () => {
      // Cancelling the query is the server-side stop; the socket is dropped
      // afterwards by `release(true)`.
      try {
        client.connection?.stream?.destroy()
      } catch {
        // The socket is already gone.
      }
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    let broken = false
    try {
      return await run(client)
    } catch (error) {
      broken = error?.name === 'AbortError' || signal?.aborted === true
      throw error
    } finally {
      signal?.removeEventListener('abort', onAbort)
      try {
        client.release(broken)
      } catch {
        // A client already returned to the pool needs no release.
      }
    }
  }

  return {
    info,
    dialect: info.id,

    /**
     * Classify one statement for this engine.
     * @param {string} sql - the statement.
     * @returns {'read' | 'write' | 'control' | 'unknown'} the classification.
     */
    classify(sql) {
      return classify(sql, info.id)
    },

    /**
     * Quote a qualified identifier.
     * @param {string} database - the schema name.
     * @param {string} table - the table name.
     * @returns {string} the quoted name.
     */
    qualify(database, table) {
      return `${quoteIdent(database, info.id)}.${quoteIdent(table, info.id)}`
    },

    describe,

    /**
     * Run one read statement inside a server-enforced read-only transaction.
     * @param {string} sql - the statement.
     * @param {{ signal?: AbortSignal }} options - caller cancellation.
     * @returns {Promise<{ columns: string[], rows: unknown[][], notices: string[] }>} the raw result.
     */
    async fetch(sql, { signal }) {
      assertSingleStatement(sql, info.id)
      try {
        return await withConnection(signal, async client => {
          await client.query('BEGIN TRANSACTION READ ONLY')
          try {
            const result = await client.query({ text: sql, values: [], rowMode: 'array' })
            return {
              columns: (result.fields ?? []).map(field => field.name),
              rows: (result.rows ?? []).map(row => [...row]),
              notices: [],
            }
          } finally {
            try {
              await client.query('ROLLBACK')
            } catch {
              // The transaction is already closed by the failure.
            }
          }
        })
      } catch (error) {
        throw describe(error, 'read')
      }
    },

    /**
     * Run one writing statement.
     * @param {string} sql - the statement.
     * @param {{ signal?: AbortSignal }} options - caller cancellation.
     * @returns {Promise<object>} the affected-row report.
     */
    async execute(sql, { signal }) {
      assertSingleStatement(sql, info.id)
      try {
        return await withConnection(signal, async client => {
          const result = await client.query({ text: sql, values: [], rowMode: 'array' })
          const returned = result.command === 'INSERT' && Array.isArray(result.rows) && result.rows.length > 0
            ? result.rows[0][0]
            : undefined
          return {
            affectedRows: typeof result.rowCount === 'number' ? result.rowCount : 0,
            insertId: returned === undefined || returned === null ? null : String(returned),
            info: typeof result.command === 'string' ? result.command : '',
            warnings: 0,
          }
        })
      } catch (error) {
        throw describe(error, 'write')
      }
    },

    /**
     * Inspect schema at the requested level.
     * @param {{ database?: string, table?: string }} target - how far to descend.
     * @param {{ signal?: AbortSignal }} options - caller cancellation.
     * @returns {Promise<object>} the schema report without the connection name.
     */
    async schema(target, { signal }) {
      // On PostgreSQL `connection.database` names the database to connect to; the
      // schema is a separate axis, named by this call's own `database` argument.
      // Defaulting the schema to the connection's database asked the catalog for
      // a schema bearing the database's own name, which lists nothing -- and
      // reads as an empty database rather than as the wrong question. With no
      // schema given, the server's current schema is the answer.
      const requested = target.database
      try {
        return await withConnection(signal, async client => {
          const run = async (sql, params) => {
            const result = await client.query({ text: sql, values: params })
            return result.rows ?? []
          }
          const database = requested ?? (await run('SELECT current_schema() AS name', []))[0]?.name
          if (target.table !== undefined && database === undefined) {
            throw new Error(`inspecting table ${JSON.stringify(target.table)} needs a schema: pass database, or set a default database for connection ${JSON.stringify(connection.name)}`)
          }

          if (target.table !== undefined) {
            const columnRows = await run(COLUMN_QUERY, [database, target.table])
            if (columnRows.length === 0) {
              throw new Error(`table ${JSON.stringify(`${database}.${target.table}`)} does not exist (connection ${JSON.stringify(connection.name)})`)
            }
            const indexRows = await run(INDEX_QUERY, [database, target.table])
            const columns = mapColumns(columnRows)
            const definitions = [...new Set(indexRows.map(row => String(row.definition)))]
            const ddl = composeDdl(database, target.table, columns, definitions)
            const notices = ['PostgreSQL has no SHOW CREATE TABLE: this DDL was assembled from the system catalog and may differ from the original statement text.']
            if (ddl.length > connection.maxDdlChars) {
              notices.push(`the DDL is longer than ${connection.maxDdlChars} characters and was truncated; raise maxDdlChars for this connection to see all of it`)
            }
            return {
              level: 'table',
              database,
              table: target.table,
              columns,
              indexes: mapIndexes(indexRows),
              ddl: ddl.length > connection.maxDdlChars ? `${ddl.slice(0, connection.maxDdlChars)}…` : ddl,
              notices,
            }
          }

          if (database !== undefined) {
            const rows = await run(TABLE_QUERY, [database])
            return {
              level: 'tables',
              database,
              tables: mapTables(rows),
              notices: [],
            }
          }

          const rows = await run(SCHEMA_QUERY, [])
          return {
            level: 'databases',
            databases: rows.map(row => String(row.nspname)),
            notices: ['On PostgreSQL this lists the schemas of the connected database; a connection cannot see other databases.'],
          }
        })
      } catch (error) {
        throw describe(error, 'read')
      }
    },

    /**
     * Check whether this connection currently answers.
     * @returns {Promise<{ reachable: boolean, version?: string, error?: string }>} the probe result.
     */
    async ping() {
      try {
        const version = await withConnection(undefined, async client => {
          const result = await client.query({ text: 'SELECT current_setting(\'server_version\')', values: [], rowMode: 'array' })
          return result.rows?.[0]?.[0]
        })
        return { reachable: true, version: String(version ?? 'unknown') }
      } catch (error) {
        return { reachable: false, error: describe(error, 'read').message }
      }
    },

    /** Close the pool. Called when the plugin unloads or the list is replaced. */
    async dispose() {
      const current = pool
      pool = undefined
      if (current === undefined) return
      try {
        await current.end()
      } catch {
        // A pool that fails to close cleanly is already unusable; unload continues.
      }
    },
  }
}

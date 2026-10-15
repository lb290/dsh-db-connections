/**
 * MySQL-protocol driver, shared by MySQL and Doris.
 *
 * Doris speaks the MySQL wire protocol but is not MySQL, and the differences are
 * exactly the ones this plugin depends on:
 *
 * - Doris has no read-only transaction. `START TRANSACTION READ ONLY` is a MySQL
 *   construct; Doris's explicit transactions accept only INSERT/UPDATE/DELETE and
 *   reject a query inside them. So this driver never opens a transaction, and
 *   `db_query` on a Doris connection is gated by statement classification alone
 *   (see `readOnly: 'classify'` in the catalog).
 * - Doris has no `MAX_EXECUTION_TIME`; its session timeout is `query_timeout`,
 *   counted in seconds.
 *
 * Rows are returned positionally (`rowsAsArray`) so the canonical result carries
 * one column list instead of repeating the header on every row. Temporal and
 * exact-numeric columns stay strings, so no precision or time zone is invented
 * on the way to the model.
 *
 * @module dsh-db-connections/drivers/mysql
 */

import mysql from 'mysql2/promise'
import { assertSingleStatement, classify, quoteQualified } from '../sql.js'
import { asError, isReadOnlyRefusal, transportMessage } from '../errors.js'

/** Display and capability facts for the two engines that speak this protocol. */
export const DRIVER_INFO = Object.freeze({
  mysql: Object.freeze({
    id: 'mysql',
    label: 'MySQL',
    defaultPort: 3306,
    readOnly: 'server',
    readOnlyNote: 'Every statement db_query runs is wrapped in a server-enforced read-only transaction.',
    promptNotes: Object.freeze([]),
  }),
  doris: Object.freeze({
    id: 'doris',
    label: 'Doris',
    defaultPort: 9030,
    readOnly: 'classify',
    readOnlyNote: 'Doris has no read-only transaction, so db_query accepts only statements it can prove are reads. Use a read-only account for hard enforcement.',
    promptNotes: Object.freeze([
      'On Doris, db_query accepts only SELECT/SHOW/DESCRIBE/EXPLAIN; a statement it cannot classify is refused because Doris cannot enforce read-only access server-side.',
    ]),
  }),
})

/** MySQL error codes translated into an actionable message. */
const MYSQL_MESSAGES = Object.freeze({
  ER_ACCESS_DENIED_ERROR: connection => `authentication failed for user ${JSON.stringify(connection.user)} on ${connection.host}:${connection.port}`,
  ER_BAD_DB_ERROR: connection => `database ${JSON.stringify(connection.database)} does not exist on ${connection.host}:${connection.port}`,
  ER_NO_SUCH_TABLE: () => 'the table does not exist',
  ER_BAD_FIELD_ERROR: () => 'a column in the statement does not exist',
  ER_PARSE_ERROR: connection => `the statement is not valid ${DRIVER_INFO[connection.driver].label} syntax`,
  ER_NO_DB_ERROR: connection => `no database is selected on this connection; qualify the table as \`schema\`.\`table\` or set a default database for ${JSON.stringify(connection.name)}`,
  ER_TABLEACCESS_DENIED_ERROR: connection => `user ${JSON.stringify(connection.user)} may not read that table`,
  ER_DBACCESS_DENIED_ERROR: connection => `user ${JSON.stringify(connection.user)} may not read that database`,
  ER_QUERY_TIMEOUT: connection => `the query exceeded the ${connection.queryTimeoutMs} ms limit`,
  ER_QUERY_INTERRUPTED: connection => `the query exceeded the ${connection.queryTimeoutMs} ms limit`,
  PROTOCOL_SEQUENCE_TIMEOUT: connection => `the server did not answer within ${connection.queryTimeoutMs} ms`,
})

/**
 * Map `information_schema.COLUMNS` rows to the schema report's column entries.
 * @param {unknown[][]} rows - positional rows from the driver.
 * @returns {object[]} the mapped columns.
 */
export function mapColumns(rows) {
  return rows.map(row => ({
    name: String(row[0]),
    type: String(row[1]),
    nullable: String(row[2]).toUpperCase() === 'YES',
    key: String(row[3]),
    default: row[4],
    extra: String(row[5]),
    comment: String(row[6]),
  }))
}

/**
 * Map `information_schema.STATISTICS` rows to the schema report's index entries.
 * @param {unknown[][]} rows - positional rows from the driver.
 * @returns {object[]} the mapped indexes.
 */
export function mapIndexes(rows) {
  return rows.map(row => ({
    name: String(row[0]),
    unique: Number(row[1]) === 0,
    position: Number(row[2]),
    column: String(row[3]),
    type: String(row[4]),
  }))
}

/**
 * Map `information_schema.TABLES` rows to the schema report's table entries.
 * @param {unknown[][]} rows - positional rows from the driver.
 * @returns {object[]} the mapped tables.
 */
export function mapTables(rows) {
  return rows.map(row => ({
    name: String(row[0]),
    type: String(row[1]),
    engine: String(row[2]),
    // InnoDB and Doris both report an estimate here, never an exact count.
    approximateRows: Number(row[3]),
    comment: String(row[4]),
  }))
}

/** Schemas that are engine bookkeeping rather than user data. */
const SYSTEM_SCHEMAS = new Set(['information_schema', 'performance_schema', 'mysql', 'sys', '__internal_schema'])

const COLUMN_QUERY = 'SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, IFNULL(COLUMN_KEY, \'\'), COLUMN_DEFAULT, IFNULL(EXTRA, \'\'), IFNULL(COLUMN_COMMENT, \'\')'
  + ' FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION'

const INDEX_QUERY = 'SELECT INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME, INDEX_TYPE'
  + ' FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX'

const TABLE_QUERY = 'SELECT TABLE_NAME, TABLE_TYPE, IFNULL(ENGINE, \'\'), IFNULL(TABLE_ROWS, 0), IFNULL(TABLE_COMMENT, \'\')'
  + ' FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME'

/**
 * Build the MySQL-protocol driver for one connection.
 * @param {object} connection - the normalized connection.
 * @returns {object} the driver instance.
 */
export function createMysqlDriver(connection) {
  const info = DRIVER_INFO[connection.driver]
  const readOnlyTransaction = info.readOnly === 'server'
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
        : `${identifier} rejected this statement: the connection is read-only. Turn on "read-write" for it in the dsh-db-connections settings page to permit writes.`)
    }
    const transport = transportMessage(error, connection)
    if (transport !== undefined) return new Error(`${transport} (connection ${identifier})`)
    const known = MYSQL_MESSAGES[error?.code]
    if (known !== undefined) return new Error(`${known(connection)} (connection ${identifier})`)
    return asError(error)
  }

  /** @returns {object} the lazily created pool. */
  function poolFor() {
    if (pool !== undefined) return pool
    pool = mysql.createPool({
      host: connection.host,
      port: connection.port,
      user: connection.user,
      password: connection.password,
      ...connection.database === undefined ? {} : { database: connection.database },
      connectTimeout: connection.connectTimeoutMs,
      connectionLimit: connection.connectionLimit,
      waitForConnections: true,
      queueLimit: 0,
      enableKeepAlive: true,
      rowsAsArray: true,
      // One statement per call: a second statement must be a deliberate call.
      multipleStatements: false,
      namedPlaceholders: false,
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      decimalNumbers: false,
      charset: 'utf8mb4',
      ...connection.ssl === false ? {} : { ssl: connection.ssl === true ? { rejectUnauthorized: true } : connection.ssl },
    })
    // The statement deadline is also bound server-side, which is what stops a
    // runaway query even when the client stops reading the socket.
    pool.pool.on('connection', (raw) => {
      const guard = info.id === 'doris'
        ? `SET query_timeout = ${Math.max(1, Math.ceil(connection.queryTimeoutMs / 1000))}`
        : `SET SESSION MAX_EXECUTION_TIME = ${connection.queryTimeoutMs}`
      raw.query(guard, () => {
        // A failure here is harmless: the client-side timeout still applies.
      })
    })
    return pool
  }

  /**
   * Run one function against a checked-out pooled connection, releasing it
   * afterwards and destroying it if the caller's signal aborts.
   * @param {AbortSignal | undefined} signal - caller cancellation.
   * @param {(conn: object) => Promise<unknown>} run - the work to perform.
   * @returns {Promise<unknown>} the work's result.
   */
  async function withConnection(signal, run) {
    if (signal?.aborted === true) {
      const error = new Error('the call was cancelled before it ran')
      error.name = 'AbortError'
      throw error
    }
    let conn
    try {
      conn = await poolFor().getConnection()
    } catch (error) {
      throw describe(error, 'read')
    }
    let destroyed = false
    const onAbort = () => {
      destroyed = true
      try {
        conn.destroy()
      } catch {
        // The connection is already gone; there is nothing left to release.
      }
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      return await run(conn)
    } finally {
      signal?.removeEventListener('abort', onAbort)
      if (destroyed === false) {
        try {
          conn.release()
        } catch {
          // A connection already returned by the driver needs no release.
        }
      }
    }
  }

  /**
   * Run one guarded read.
   * @param {object} conn - the checked-out connection.
   * @param {string} sql - the statement.
   * @param {unknown[] | undefined} params - placeholder values.
   * @returns {Promise<{ columns: string[], rows: unknown[][] }>} the raw result.
   */
  async function readWith(conn, sql, params) {
    if (readOnlyTransaction) await conn.query('START TRANSACTION READ ONLY')
    try {
      const [rows, fields] = await conn.query({
        sql,
        ...params === undefined ? {} : { values: params },
        timeout: connection.queryTimeoutMs,
      })
      const dataRows = Array.isArray(rows) ? rows : []
      return {
        columns: (fields ?? []).map(field => field.name),
        rows: dataRows.map(row => (Array.isArray(row) ? [...row] : [row])),
      }
    } finally {
      if (readOnlyTransaction) {
        try {
          await conn.query('ROLLBACK')
        } catch {
          // The transaction is already closed by the failure or the aborted connection.
        }
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
      return quoteQualified(database, table, info.id)
    },

    describe,

    /**
     * Run one read statement inside this engine's read-only guard.
     * @param {string} sql - the statement.
     * @param {{ signal?: AbortSignal }} options - caller cancellation.
     * @returns {Promise<{ columns: string[], rows: unknown[][], notices: string[] }>} the raw result.
     */
    async fetch(sql, { signal }) {
      assertSingleStatement(sql, info.id)
      return withConnection(signal, async conn => {
        try {
          const result = await readWith(conn, sql, undefined)
          return { ...result, notices: [] }
        } catch (error) {
          throw describe(error, 'read')
        }
      })
    },

    /**
     * Run one writing statement.
     * @param {string} sql - the statement.
     * @param {{ signal?: AbortSignal }} options - caller cancellation.
     * @returns {Promise<object>} the affected-row report.
     */
    async execute(sql, { signal }) {
      assertSingleStatement(sql, info.id)
      return withConnection(signal, async conn => {
        try {
          const [result] = await conn.query({ sql, timeout: connection.queryTimeoutMs })
          return {
            affectedRows: typeof result?.affectedRows === 'number' ? result.affectedRows : 0,
            insertId: result?.insertId === undefined || result.insertId === null ? null : String(result.insertId),
            info: typeof result?.info === 'string' ? result.info : '',
            warnings: typeof result?.warningStatus === 'number' ? result.warningStatus : 0,
          }
        } catch (error) {
          throw describe(error, 'write')
        }
      })
    },

    /**
     * Inspect schema at the requested level.
     * @param {{ database?: string, table?: string }} target - how far to descend.
     * @param {{ signal?: AbortSignal }} options - caller cancellation.
     * @returns {Promise<object>} the schema report without the connection name.
     */
    async schema(target, { signal }) {
      const database = target.database ?? connection.database
      if (target.table !== undefined && database === undefined) {
        throw new Error(`inspecting table ${JSON.stringify(target.table)} needs a schema: pass database, or set a default database for connection ${JSON.stringify(connection.name)}`)
      }
      return withConnection(signal, async conn => {
        const run = async (sql, params) => {
          try {
            return await readWith(conn, sql, params)
          } catch (error) {
            throw describe(error, 'read')
          }
        }

        if (target.table !== undefined) {
          const columns = await run(COLUMN_QUERY, [database, target.table])
          if (columns.rows.length === 0) {
            throw new Error(`table ${JSON.stringify(`${database}.${target.table}`)} does not exist (connection ${JSON.stringify(connection.name)})`)
          }
          const notices = []
          // Doris indexes OLAP tables by prefix/ inverted index rather than the
          // InnoDB model, and older versions expose no STATISTICS table; a failed
          // best-effort read is reported as "no index information" instead of
          // failing the whole inspection.
          let indexRows = []
          try {
            indexRows = (await run(INDEX_QUERY, [database, target.table])).rows
          } catch (error) {
            notices.push(`index information is not available on this engine (${asError(error).message})`)
          }
          // The DDL is the point of this call, and it is returned as a bounded
          // string rather than as a table cell, so it never hits maxCellChars.
          const ddl = await run(`SHOW CREATE TABLE ${quoteQualified(database, target.table, info.id)}`, undefined)
          const ddlText = ddl.rows.length > 0 ? String(ddl.rows[0][1]) : ''
          if (ddlText.length > connection.maxDdlChars) {
            notices.push(`the DDL is longer than ${connection.maxDdlChars} characters and was truncated; raise maxDdlChars for this connection to see all of it`)
          }
          return {
            level: 'table',
            database,
            table: target.table,
            columns: mapColumns(columns.rows),
            indexes: mapIndexes(indexRows),
            ddl: ddlText.length > connection.maxDdlChars ? `${ddlText.slice(0, connection.maxDdlChars)}…` : ddlText,
            notices,
          }
        }

        if (database !== undefined) {
          const result = await run(TABLE_QUERY, [database])
          return { level: 'tables', database, tables: mapTables(result.rows), notices: [] }
        }

        const result = await run('SHOW DATABASES', undefined)
        const all = result.rows.map(row => String(row[0]))
        const visible = all.filter(name => SYSTEM_SCHEMAS.has(name) === false)
        const hidden = all.filter(name => SYSTEM_SCHEMAS.has(name))
        return {
          level: 'databases',
          databases: visible.sort(),
          notices: hidden.length === 0
            ? []
            : [`engine schemas hidden from this list: ${hidden.sort().join(', ')}; pass one as \`database\` to inspect it anyway`],
        }
      })
    },

    /**
     * Check whether this connection currently answers.
     * @returns {Promise<{ reachable: boolean, version?: string, error?: string }>} the probe result.
     */
    async ping() {
      try {
        const result = await withConnection(undefined, async conn => {
          const [rows] = await conn.query({ sql: 'SELECT VERSION()', timeout: connection.queryTimeoutMs })
          return Array.isArray(rows) ? rows : []
        })
        return { reachable: true, version: String(result[0]?.[0] ?? 'unknown') }
      } catch (error) {
        return { reachable: false, error: asError(error).message }
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

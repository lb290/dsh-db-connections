/**
 * Named connection registry: one MySQL pool per configured connection, plus the
 * read-only execution path every read goes through.
 *
 * Read-only enforcement is the server's, not this module's. A read runs inside
 * an explicit `START TRANSACTION READ ONLY`, which MySQL refuses to write from
 * even for a `root` account, and which also blocks `SELECT … INTO OUTFILE`,
 * `SELECT … FOR UPDATE`, and CTE-led writes. Statement classification in
 * `sql.js` only exists to fail fast with a message naming the right tool.
 *
 * @module dsh-db-connections/registry
 */

import mysql from 'mysql2/promise'
import { classify, quoteQualified } from './sql.js'
import { toJsonRow, toJsonValue } from './values.js'

/** Server error raised when a statement tries to write in a read-only transaction. */
const READ_ONLY_ERROR = 'ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION'

/** Server error raised when a statement is refused for the session's options. */
const OPTION_PREVENTS_STATEMENT = 'ER_OPTION_PREVENTS_STATEMENT'

/** Raised when a tool names a connection that is not configured. */
export class UnknownConnectionError extends Error {
  /**
   * @param {string} name - the requested connection name.
   * @param {string[]} available - the configured names.
   */
  constructor(name, available) {
    super(available.length === 0
      ? `no database connection is named ${JSON.stringify(name)}: no connections are configured at all (add them in the dsh-db-connections settings page)`
      : `no database connection is named ${JSON.stringify(name)}; configured names: ${available.map(item => JSON.stringify(item)).join(', ')}`)
    this.name = 'UnknownConnectionError'
  }
}

/**
 * Translate one driver failure into an actionable message.
 * @param {unknown} error - the thrown value.
 * @param {object} connection - the normalized connection.
 * @param {'read' | 'write'} mode - whether the failed statement was a read.
 * @returns {Error} the error to surface.
 */
function describeFailure(error, connection, mode) {
  const code = error?.code
  const target = `${connection.host}:${connection.port}`
  const identifier = JSON.stringify(connection.name)
  if (code === READ_ONLY_ERROR || code === OPTION_PREVENTS_STATEMENT) {
    return new Error(mode === 'read'
      ? `${identifier} rejected this statement: it writes, and db_query runs every statement in a server-enforced read-only transaction. Use db_execute to change data.`
      : `${identifier} rejected this statement: the connection is read-only. Turn on "read-write" for it in the dsh-db-connections settings page to permit writes.`)
  }
  const known = {
    ECONNREFUSED: `cannot reach ${target}: connection refused`,
    ETIMEDOUT: `timed out connecting to ${target}`,
    ENOTFOUND: `host ${connection.host} could not be resolved`,
    EHOSTUNREACH: `host ${connection.host} is unreachable`,
    ECONNRESET: `the server at ${target} closed the connection`,
    ER_ACCESS_DENIED_ERROR: `authentication failed for user ${JSON.stringify(connection.user)} on ${target}`,
    ER_BAD_DB_ERROR: `database ${JSON.stringify(connection.database)} does not exist on ${target}`,
    ER_NO_SUCH_TABLE: 'the table does not exist',
    ER_BAD_FIELD_ERROR: 'a column in the statement does not exist',
    ER_PARSE_ERROR: 'the statement is not valid MySQL syntax',
    ER_NO_DB_ERROR: `no database is selected on this connection; qualify the table as \`schema\`.\`table\` or set a default database for ${identifier}`,
    ER_TABLEACCESS_DENIED_ERROR: `user ${JSON.stringify(connection.user)} may not read that table`,
    ER_QUERY_TIMEOUT: `the query exceeded the ${connection.queryTimeoutMs} ms limit`,
    PROTOCOL_SEQUENCE_TIMEOUT: `the server did not answer within ${connection.queryTimeoutMs} ms`,
  }[code]
  if (known !== undefined) return new Error(`${known} (connection ${identifier})`)
  return error instanceof Error ? error : new Error(String(error))
}

/** Raised for a call the abort signal cancelled before it reached the server. */
function abortedError() {
  const error = new Error('the call was cancelled before it ran')
  error.name = 'AbortError'
  return error
}

/** Registry of configured connections and their lazily created pools. */
export class ConnectionRegistry {
  /** @type {Map<string, object>} */
  #connections = new Map()
  /** @type {Map<string, object>} */
  #pools = new Map()

  /**
   * @param {object[]} connections - normalized connections from `resolveConnections`.
   */
  constructor(connections) {
    for (const connection of connections) this.#connections.set(connection.name, connection)
  }

  /** @returns {string[]} configured connection names, in configuration order. */
  names() {
    return [...this.#connections.keys()]
  }

  /** @returns {object[]} configured connections, in configuration order. */
  all() {
    return [...this.#connections.values()]
  }

  /**
   * Look up one connection by name.
   * @param {string} name - the connection name.
   * @returns {object} the normalized connection.
   */
  get(name) {
    const connection = this.#connections.get(name)
    if (connection === undefined) throw new UnknownConnectionError(name, this.names())
    return connection
  }

  /**
   * Get or create the pool for one connection.
   * @param {object} connection - the normalized connection.
   * @returns {object} the promise pool.
   */
  #poolFor(connection) {
    const existing = this.#pools.get(connection.name)
    if (existing !== undefined) return existing
    const pool = mysql.createPool({
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
      // Rows arrive as positional arrays matching the result's `columns`. The
      // canonical value is a column list plus row arrays, so keying each row by
      // column name would duplicate the header on every row.
      rowsAsArray: true,
      // One statement per call: a second statement must be a deliberate call.
      multipleStatements: false,
      namedPlaceholders: false,
      // Temporal and exact numeric columns stay strings, so no precision or
      // time-zone interpretation is invented on the way to the model.
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      decimalNumbers: false,
      charset: 'utf8mb4',
      ...connection.ssl ? { ssl: { rejectUnauthorized: true } } : {},
    })
    // Bound each statement server-side as well: MAX_EXECUTION_TIME applies to
    // reads, which is exactly the guarded path.
    pool.pool.on('connection', (raw) => {
      raw.query(`SET SESSION MAX_EXECUTION_TIME = ${connection.queryTimeoutMs}`, () => {
        // A failure here is harmless: the client-side timeout still applies.
      })
    })
    this.#pools.set(connection.name, pool)
    return pool
  }

  /**
   * Run one function against a checked-out pooled connection, releasing it
   * afterwards and destroying it if the caller's signal aborts.
   * @param {object} connection - the normalized connection.
   * @param {AbortSignal | undefined} signal - caller cancellation.
   * @param {(conn: object) => Promise<unknown>} run - the work to perform.
   * @returns {Promise<unknown>} the work's result.
   */
  async #withConnection(connection, signal, run) {
    if (signal?.aborted === true) throw abortedError()
    const pool = this.#poolFor(connection)
    let conn
    try {
      conn = await pool.getConnection()
    } catch (error) {
      throw describeFailure(error, connection, 'read')
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
      if (!destroyed) {
        try {
          conn.release()
        } catch {
          // A connection already returned by the driver needs no release.
        }
      }
    }
  }

  /**
   * Run one statement inside an explicit read-only transaction.
   * @param {object} connection - the normalized connection.
   * @param {object} conn - the checked-out connection.
   * @param {string} sql - the statement.
   * @param {unknown[] | undefined} params - placeholder values.
   * @param {number} started - start timestamp for the elapsed measurement.
   * @param {number} [maxCellChars] - per-cell bound overriding the connection's.
   * @returns {Promise<object>} the normalized result with all string cells.
   */
  async #read(connection, conn, sql, params, started, maxCellChars = connection.maxCellChars) {
    // The server, not this plugin, is what makes a write here impossible.
    await conn.query('START TRANSACTION READ ONLY')
    try {
      const [rows, fields] = await conn.query({
        sql,
        ...params === undefined ? {} : { values: params },
        timeout: connection.queryTimeoutMs,
      })
      const columns = (fields ?? []).map(field => field.name)
      const dataRows = Array.isArray(rows) ? rows : []
      const projected = dataRows.slice(0, connection.maxRows)
      const notices = []
      if (dataRows.length > projected.length) {
        notices.push(`showing the first ${projected.length} of ${dataRows.length} rows; add a LIMIT or a narrower WHERE clause to see the intended rows`)
      }
      return {
        columns,
        rows: projected.map(row => (Array.isArray(row)
          ? toJsonRow(row, maxCellChars)
          : [toJsonValue(row, maxCellChars)])),
        totalRows: dataRows.length,
        elapsedMs: Date.now() - started,
        notices,
      }
    } finally {
      try {
        await conn.query('ROLLBACK')
      } catch {
        // The transaction is already closed by the failure or the aborted connection.
      }
    }
  }

  /**
   * Run one read-only statement.
   * @param {string} name - the connection name.
   * @param {string} sql - the statement.
   * @param {AbortSignal | undefined} signal - caller cancellation.
   * @returns {Promise<object>} the normalized result.
   */
  async query(name, sql, signal) {
    const connection = this.get(name)
    if (classify(sql) === 'write') {
      throw new Error(`db_query runs read-only statements only; this one writes. Use db_execute for connection ${JSON.stringify(name)}.`)
    }
    const started = Date.now()
    return this.#withConnection(connection, signal, async (conn) => {
      try {
        return await this.#read(connection, conn, sql, undefined, started)
      } catch (error) {
        throw describeFailure(error, connection, 'read')
      }
    })
  }

  /**
   * Run one writing statement.
   * @param {string} name - the connection name.
   * @param {string} sql - the statement.
   * @param {AbortSignal | undefined} signal - caller cancellation.
   * @returns {Promise<object>} the affected-row report.
   */
  async execute(name, sql, signal) {
    const connection = this.get(name)
    if (!connection.allowWrite) {
      throw new Error(`connection ${JSON.stringify(name)} is read-only; turn on "read-write" for it in the dsh-db-connections settings page to permit writes.`)
    }
    const started = Date.now()
    return this.#withConnection(connection, signal, async (conn) => {
      try {
        const [result] = await conn.query({ sql, timeout: connection.queryTimeoutMs })
        return {
          affectedRows: typeof result?.affectedRows === 'number' ? result.affectedRows : 0,
          insertId: result?.insertId === undefined || result.insertId === null ? null : String(result.insertId),
          info: typeof result?.info === 'string' ? result.info : '',
          warnings: typeof result?.warningStatus === 'number' ? result.warningStatus : 0,
          elapsedMs: Date.now() - started,
        }
      } catch (error) {
        throw describeFailure(error, connection, 'write')
      }
    })
  }

  /**
   * Inspect schema at the granularity the caller asked for: databases, one
   * schema's tables, or one table's columns, indexes, and DDL.
   * @param {string} name - the connection name.
   * @param {{ database?: string, table?: string }} target - how far to descend.
   * @param {AbortSignal | undefined} signal - caller cancellation.
   * @returns {Promise<object>} the schema report.
   */
  async schema(name, target, signal) {
    const connection = this.get(name)
    const database = target.database ?? connection.database
    if (target.table !== undefined && database === undefined) {
      throw new Error(`inspecting table ${JSON.stringify(target.table)} needs a schema: pass database, or set a default database for connection ${JSON.stringify(name)}`)
    }
    const receiver = JSON.stringify(name)
    return this.#withConnection(connection, signal, async (conn) => {
      const run = async (sql, params, maxCellChars) => {
        const started = Date.now()
        try {
          return await this.#read(connection, conn, sql, params, started, maxCellChars)
        } catch (error) {
          throw describeFailure(error, connection, 'read')
        }
      }

      if (target.table !== undefined) {
        const columns = await run(
          'SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, IFNULL(COLUMN_KEY, \'\'), COLUMN_DEFAULT, IFNULL(EXTRA, \'\'), IFNULL(COLUMN_COMMENT, \'\')'
          + ' FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
          [database, target.table])
        if (columns.rows.length === 0) {
          throw new Error(`table ${JSON.stringify(`${database}.${target.table}`)} does not exist (connection ${receiver})`)
        }
        const indexes = await run(
          'SELECT INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME, INDEX_TYPE'
          + ' FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX',
          [database, target.table])
        // The DDL is the point of this call, so it gets its own wider bound
        // rather than the per-cell limit that trims ordinary column values.
        const ddl = await run(`SHOW CREATE TABLE ${quoteQualified(database, target.table)}`, undefined, connection.maxDdlChars)
        const ddlText = ddl.rows.length > 0 ? String(ddl.rows[0][1]) : ''
        const notices = [...columns.notices, ...indexes.notices]
        if (ddlText.length > connection.maxDdlChars) {
          notices.push(`the DDL is longer than ${connection.maxDdlChars} characters and was truncated; raise maxDdlChars for this connection to see all of it`)
        }
        return {
          connection: name,
          level: 'table',
          database,
          table: target.table,
          columns: columns.rows.map(row => ({
            name: String(row[0]),
            type: String(row[1]),
            nullable: String(row[2]).toUpperCase() === 'YES',
            key: String(row[3]),
            default: row[4],
            extra: String(row[5]),
            comment: String(row[6]),
          })),
          indexes: indexes.rows.map(row => ({
            name: String(row[0]),
            unique: Number(row[1]) === 0,
            position: Number(row[2]),
            column: String(row[3]),
            type: String(row[4]),
          })),
          ddl: ddlText.length > connection.maxDdlChars
            ? `${ddlText.slice(0, connection.maxDdlChars)}…`
            : ddlText,
          notices,
        }
      }

      if (database !== undefined) {
        const result = await run(
          'SELECT TABLE_NAME, TABLE_TYPE, IFNULL(ENGINE, \'\'), IFNULL(TABLE_ROWS, 0), IFNULL(TABLE_COMMENT, \'\')'
          + ' FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
          [database])
        return {
          connection: name,
          level: 'tables',
          database,
          tables: result.rows.map(row => ({
            name: String(row[0]),
            type: String(row[1]),
            engine: String(row[2]),
            // InnoDB reports an estimate here, never an exact count.
            approximateRows: Number(row[3]),
            comment: String(row[4]),
          })),
          notices: result.notices,
        }
      }

      const result = await run('SHOW DATABASES', undefined)
      return {
        connection: name,
        level: 'databases',
        databases: result.rows.map(row => String(row[0])).sort(),
        notices: result.notices,
      }
    })
  }

  /**
   * Check whether one connection currently answers.
   * @param {string} name - the connection name.
   * @returns {Promise<object>} the probe result.
   */
  async ping(name) {
    try {
      const result = await this.query(name, 'SELECT VERSION()', undefined)
      return { reachable: true, version: String(result.rows[0]?.[0] ?? 'unknown') }
    } catch (error) {
      return { reachable: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Close every pool. Called when the plugin unloads. */
  dispose() {
    for (const pool of this.#pools.values()) {
      pool.end().catch(() => {
        // A pool that fails to close cleanly is already unusable; unload continues.
      })
    }
    this.#pools.clear()
  }
}

/**
 * TDengine driver over the taosAdapter REST interface.
 *
 * REST is the right transport here: it needs no native library, so the plugin
 * keeps its "install with npm, no build step" property.
 *
 * Four protocol facts drive this module:
 *
 * 1. REST is stateless. `USE db` has no effect, so the default database can only
 *    be given in the URL path (`/rest/sql/<db>`); table references in the
 *    statement must be database-qualified otherwise.
 * 2. An error answer is still HTTP 200 unless taosAdapter sets
 *    `httpCodeServerError`, so the body's `code` field — not the status — decides
 *    success. A driver that trusted the status would report failures as empty
 *    results.
 * 3. TDengine has no transactions, so there is no server-side read-only mode.
 *    `db_query` is gated by statement classification alone (`readOnly:
 *    'classify'`), and a deployment that needs hard enforcement gives the
 *    connection a read-only account.
 * 4. The protocol has no parameter binding, so this driver never interpolates a
 *    value: introspection uses `SHOW`/`DESCRIBE` with escaped *identifiers* only.
 *
 * Time-series queries are also fundamentally different: a bare `SELECT` on a
 * super table can scan everything, so a statement without a time range or an
 * INTERVAL window comes back with a notice attached.
 *
 * @module dsh-db-connections/drivers/tdengine
 */

import http from 'node:http'
import https from 'node:https'
import { assertSingleStatement, classify, quoteIdent, quoteQualified } from '../sql.js'
import { asError, transportMessage } from '../errors.js'

/** Display and capability facts for this driver. */
export const DRIVER_INFO = Object.freeze({
  id: 'tdengine',
  label: 'TDengine',
  defaultPort: 6041,
  readOnly: 'classify',
  readOnlyNote: 'TDengine has no transactions, so db_query accepts only statements it can prove are reads. Give this connection a read-only account for hard enforcement.',
  promptNotes: Object.freeze([
    'On TDengine the adapter is stateless, so every table reference must be database-qualified (`db.table`) unless it uses the connection default database.',
    'On TDengine a query without a `ts` range or an INTERVAL window can scan a whole super table; always bound the time range.',
  ]),
})

/** TDengine error codes translated into an actionable message. */
const TAOS_CODES = Object.freeze({
  534: () => 'the statement is not valid TDengine SQL syntax',
  539: () => 'the statement is not valid TDengine SQL syntax',
  9728: () => 'the statement is not valid TDengine SQL syntax',
  855: connection => `authentication failed for user ${JSON.stringify(connection.user)} on ${connection.host}:${connection.port}`,
  849: connection => `user ${JSON.stringify(connection.user)} does not exist on ${connection.host}:${connection.port}`,
  852: () => 'the server received no user for this connection',
})

/** Databases that are engine bookkeeping rather than user data. */
const SYSTEM_DATABASES = new Set(['information_schema', 'performance_schema'])

/**
 * Parse one REST answer body.
 *
 * The HTTP status is deliberately not consulted: taosAdapter answers a failed
 * statement with HTTP 200 and a non-zero `code` by default.
 * @param {string} text - the response body.
 * @param {object} connection - the normalized connection, used in the message.
 * @returns {object} the parsed answer.
 * @throws {Error} when the body is not JSON or carries a non-zero code.
 */
export function parseResponse(text, connection) {
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error(`TDengine answered with something that is not JSON (connection ${JSON.stringify(connection.name)}): ${text.slice(0, 200)}`)
  }
  if (payload.code === 0) return payload
  const description = typeof payload.desc === 'string' ? payload.desc : `TDengine error ${payload.code}`
  const known = TAOS_CODES[payload.code]
  const lead = /table does not exist/iu.test(description)
    ? 'the table does not exist'
    : /database not exist|invalid database/iu.test(description)
      ? 'the database does not exist'
      : known === undefined ? description : known(connection)
  throw Object.assign(new Error(`${lead} (connection ${JSON.stringify(connection.name)})`), {
    code: `TAOS_${payload.code}`,
    taosCode: payload.code,
    taosDescription: description,
  })
}

/**
 * Map one parsed answer to positional columns and rows.
 * @param {object} payload - the parsed answer.
 * @returns {{ columns: string[], rows: unknown[][] }} the raw result.
 */
export function mapResult(payload) {
  const columns = Array.isArray(payload.column_meta)
    ? payload.column_meta.map(meta => String(Array.isArray(meta) ? meta[0] : meta))
    : []
  const rows = Array.isArray(payload.data)
    ? payload.data.map(row => (Array.isArray(row) ? [...row] : [row]))
    : []
  return { columns, rows }
}

/**
 * Read the affected-row count out of a write answer.
 *
 * TDengine answers a write with a single `affected_rows` column; some statements
 * (a bare DDL) answer with no rows at all.
 * @param {object} payload - the parsed answer.
 * @returns {number} the affected-row count, or 0 when the answer carries none.
 */
export function affectedRowsOf(payload) {
  const { columns, rows } = mapResult(payload)
  if (columns[0] !== 'affected_rows') return 0
  const value = rows[0]?.[0]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * Whether a statement bounds the time range it reads.
 * @param {string} sql - the statement text.
 * @returns {boolean} whether a `ts` predicate or an INTERVAL window is present.
 */
export function hasTimeRange(sql) {
  if (/\bwhere\b[\s\S]*?\bts\b\s*(?:between|>=|<=|>|<|=)/iu.test(sql)) return true
  if (/\bpartition\s+by\b[\s\S]*?\bts\b/iu.test(sql)) return true
  return /\binterval\s*\(/iu.test(sql)
}

/**
 * Describe the time-series risk of one statement.
 * @param {string} sql - the statement text.
 * @returns {string | undefined} a notice, or undefined when the statement is bounded.
 */
export function timeSeriesNotice(sql) {
  if (/^\s*(?:select|with)\b/iu.test(sql) === false) return undefined
  if (hasTimeRange(sql)) return undefined
  return 'TDengine: this statement has no `ts` range predicate and no INTERVAL window, so the server may scan the whole table. Bound it with `WHERE ts >= ... AND ts < ...` or an INTERVAL window.'
}

/**
 * Map a `DESCRIBE` answer to the schema report's column entries.
 *
 * `DESCRIBE` returns `field`, `type`, `length`, and `note`; the note is where
 * TDengine states that a column is a tag (or the primary timestamp), so it is
 * kept in `extra` rather than being folded into a SQL notion that does not apply.
 * @param {string[]} columns - the answer's column names.
 * @param {unknown[][]} rows - the answer's rows.
 * @returns {object[]} the mapped columns.
 */
export function mapDescribe(columns, rows) {
  const indexOf = name => {
    const found = columns.indexOf(name)
    return found === -1 ? columns.indexOf(columns.find(entry => entry.toLowerCase() === name) ?? '') : found
  }
  const fieldAt = indexOf('field')
  const typeAt = indexOf('type')
  const lengthAt = indexOf('length')
  const noteAt = indexOf('note')
  return rows.map(row => {
    const field = String(row[fieldAt === -1 ? 0 : fieldAt])
    const type = String(row[typeAt === -1 ? 1 : typeAt])
    const length = lengthAt === -1 ? undefined : row[lengthAt]
    const note = noteAt === -1 ? '' : String(row[noteAt] ?? '')
    const isTag = /tag/iu.test(note)
    return {
      name: field,
      type: length === undefined || length === null || String(length) === '' ? type : `${type}(${String(length)})`,
      // Every TDengine column accepts NULL except the timestamp, which is the
      // table's primary key; the note says so when it matters.
      nullable: field !== 'ts',
      key: field === 'ts' ? 'PRI' : isTag ? 'TAG' : '',
      default: null,
      extra: note,
      comment: '',
    }
  })
}

/**
 * Map a `SHOW STABLES`/`SHOW TABLES` answer to the schema report's table entries.
 * @param {string[]} columns - the answer's column names.
 * @param {unknown[][]} rows - the answer's rows.
 * @param {'STABLE' | 'TABLE'} kind - which listing produced the rows.
 * @returns {object[]} the mapped tables.
 */
export function mapTableList(columns, rows, kind) {
  const lower = columns.map(column => column.toLowerCase())
  const nameAt = Math.max(0, lower.indexOf(kind === 'STABLE' ? 'stable_name' : 'table_name'))
  const stableAt = lower.indexOf('stable_name')
  return rows.map(row => ({
    name: String(row[nameAt] ?? row[0]),
    type: kind,
    // TDengine has no per-table engine; the storage engine is not exposed here.
    engine: '',
    // `SHOW TABLES` does not report a row count.
    approximateRows: 0,
    comment: kind === 'TABLE' && stableAt !== -1 ? String(row[stableAt] ?? '') : '',
  }))
}

/**
 * Build the TDengine driver for one connection.
 * @param {object} connection - the normalized connection.
 * @returns {object} the driver instance.
 */
export function createTdengineDriver(connection) {
  const info = DRIVER_INFO

  /**
   * Translate one driver failure into an actionable message.
   * @param {unknown} error - the thrown value.
   * @param {'read' | 'write'} mode - whether the failed statement was a read.
   * @returns {Error} the error to surface.
   */
  function describe(error, mode) {
    void mode
    const identifier = JSON.stringify(connection.name)
    if (error instanceof Error && typeof error.code === 'string' && error.code.startsWith('TAOS_')) return error
    const transport = transportMessage(error, connection)
    if (transport !== undefined) return new Error(`${transport} (connection ${identifier})`)
    return asError(error)
  }

  /**
   * Send one statement to the adapter.
   * @param {string} sql - the statement.
   * @param {{ signal?: AbortSignal, database?: string }} options - cancellation and default database.
   * @returns {Promise<object>} the parsed answer.
   */
  function request(sql, { signal, database }) {
    const secure = connection.ssl !== false
    const transport = secure ? https : http
    const path = database === undefined || database === ''
      ? '/rest/sql'
      : `/rest/sql/${encodeURIComponent(database)}`
    const authorization = `Basic ${Buffer.from(`${connection.user}:${connection.password}`, 'utf8').toString('base64')}`
    const body = Buffer.from(sql, 'utf8')
    return new Promise((resolve, reject) => {
      const req = transport.request({
        host: connection.host,
        port: connection.port,
        path,
        method: 'POST',
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'content-length': String(body.length),
          authorization,
        },
        ...secure && connection.ssl !== true
          ? { ca: connection.ssl.ca, cert: connection.ssl.cert, key: connection.ssl.key, pfx: connection.ssl.pfx, passphrase: connection.ssl.passphrase, servername: connection.ssl.servername, rejectUnauthorized: connection.ssl.rejectUnauthorized }
          : {},
      }, (response) => {
        const chunks = []
        response.on('data', chunk => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          if (response.statusCode === 401) {
            reject(new Error(`authentication failed for user ${JSON.stringify(connection.user)} on ${connection.host}:${connection.port} (connection ${JSON.stringify(connection.name)})`))
            return
          }
          if (response.statusCode === 404) {
            reject(new Error(`the TDengine REST endpoint is not there: ${connection.host}:${connection.port}${path} answered 404, so taosAdapter is probably not running on that port (connection ${JSON.stringify(connection.name)})`))
            return
          }
          if (response.statusCode !== 200) {
            reject(new Error(`TDengine answered HTTP ${response.statusCode}: ${text.slice(0, 200)} (connection ${JSON.stringify(connection.name)})`))
            return
          }
          resolve(text)
        })
      })
      req.setTimeout(connection.queryTimeoutMs, () => {
        req.destroy(Object.assign(new Error(`the server did not answer within ${connection.queryTimeoutMs} ms (connection ${JSON.stringify(connection.name)})`), { code: 'ETIMEDOUT' }))
      })
      req.on('error', reject)
      const onAbort = () => {
        req.destroy(Object.assign(new Error('the call was cancelled before it completed'), { name: 'AbortError' }))
      }
      if (signal?.aborted === true) {
        onAbort()
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      req.on('close', () => signal?.removeEventListener('abort', onAbort))
      req.end(body)
    })
  }

  /**
   * Send one statement and parse its answer.
   * @param {string} sql - the statement.
   * @param {{ signal?: AbortSignal, database?: string }} options - cancellation and default database.
   * @returns {Promise<object>} the parsed answer.
   */
  async function send(sql, options) {
    try {
      return parseResponse(await request(sql, options), connection)
    } catch (error) {
      throw describe(error, 'read')
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
     * @param {string} database - the database name.
     * @param {string} table - the table name.
     * @returns {string} the quoted name.
     */
    qualify(database, table) {
      return quoteQualified(database, table, info.id)
    },

    describe,

    /**
     * Run one read statement.
     * @param {string} sql - the statement.
     * @param {{ signal?: AbortSignal, database?: string }} options - cancellation and default database.
     * @returns {Promise<{ columns: string[], rows: unknown[][], notices: string[] }>} the raw result.
     */
    async fetch(sql, { signal, database }) {
      assertSingleStatement(sql, info.id)
      const payload = await send(sql, { signal, database: database ?? connection.database })
      const notice = timeSeriesNotice(sql)
      return { ...mapResult(payload), notices: notice === undefined ? [] : [notice] }
    },

    /**
     * Run one writing statement.
     * @param {string} sql - the statement.
     * @param {{ signal?: AbortSignal }} options - cancellation.
     * @returns {Promise<object>} the affected-row report.
     */
    async execute(sql, { signal }) {
      assertSingleStatement(sql, info.id)
      const payload = await send(sql, { signal, database: connection.database })
      return {
        affectedRows: affectedRowsOf(payload),
        insertId: null,
        info: '',
        warnings: 0,
      }
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
        throw new Error(`inspecting table ${JSON.stringify(target.table)} needs a database: pass database, or set a default database for connection ${JSON.stringify(connection.name)}`)
      }

      if (target.table !== undefined) {
        const described = await send(`DESCRIBE ${quoteQualified(database, target.table, info.id)}`, { signal })
        const { columns, rows } = mapResult(described)
        if (rows.length === 0) {
          throw new Error(`table ${JSON.stringify(`${database}.${target.table}`)} does not exist (connection ${JSON.stringify(connection.name)})`)
        }
        let ddl = ''
        const notices = []
        try {
          const created = await send(`SHOW CREATE TABLE ${quoteQualified(database, target.table, info.id)}`, { signal })
          const createdResult = mapResult(created)
          // TDengine answers `SHOW CREATE TABLE` with a single `create table`
          // column holding the statement.
          ddl = createdResult.rows.length === 0 ? '' : String(createdResult.rows[0][0] ?? '')
        } catch (error) {
          notices.push(`SHOW CREATE TABLE was not available for this object (${asError(error).message})`)
        }
        if (ddl.length > connection.maxDdlChars) {
          notices.push(`the DDL is longer than ${connection.maxDdlChars} characters and was truncated; raise maxDdlChars for this connection to see all of it`)
        }
        return {
          level: 'table',
          database,
          table: target.table,
          columns: mapDescribe(columns, rows),
          indexes: [],
          ddl: ddl.length > connection.maxDdlChars ? `${ddl.slice(0, connection.maxDdlChars)}…` : ddl,
          notices,
        }
      }

      if (database !== undefined) {
        const stableAnswer = await send('SHOW STABLES', { signal, database })
        const tableAnswer = await send('SHOW TABLES', { signal, database })
        const stables = mapResult(stableAnswer)
        const tables = mapResult(tableAnswer)
        return {
          level: 'tables',
          database,
          tables: [
            ...mapTableList(stables.columns, stables.rows, 'STABLE'),
            ...mapTableList(tables.columns, tables.rows, 'TABLE'),
          ],
          notices: ['`STABLE` rows are super tables; `TABLE` rows are child tables or plain tables, and the comment names the super table they belong to.'],
        }
      }

      const answer = await send('SHOW DATABASES', { signal })
      const { columns, rows } = mapResult(answer)
      const nameAt = Math.max(0, columns.map(column => column.toLowerCase()).indexOf('name'))
      const all = rows.map(row => String(row[nameAt] ?? row[0]))
      const visible = all.filter(name => SYSTEM_DATABASES.has(name) === false)
      const hidden = all.filter(name => SYSTEM_DATABASES.has(name))
      return {
        level: 'databases',
        databases: visible.sort(),
        notices: hidden.length === 0
          ? []
          : [`engine databases hidden from this list: ${hidden.sort().join(', ')}; pass one as \`database\` to inspect it anyway`],
      }
    },

    /**
     * Check whether this connection currently answers.
     * @returns {Promise<{ reachable: boolean, version?: string, error?: string }>} the probe result.
     */
    async ping() {
      try {
        await send('SELECT 1', { signal: undefined })
      } catch (error) {
        return { reachable: false, error: asError(error).message }
      }
      try {
        const answer = await send('SELECT server_version()', { signal: undefined })
        return { reachable: true, version: String(mapResult(answer).rows[0]?.[0] ?? 'unknown') }
      } catch {
        // An older server without that function is still reachable.
        return { reachable: true, version: 'unknown' }
      }
    },

    /** Release nothing: REST holds no connection open. */
    async dispose() {},
  }
}

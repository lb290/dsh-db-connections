/**
 * Named connection registry: one driver per configured connection, plus the
 * read policy every read goes through.
 *
 * The policy lives here because it is dialect-independent:
 *
 * 1. A statement that writes is refused with a message naming `db_execute`.
 * 2. A session or administrative statement is refused outright — no data query
 *    needs `SET`, `USE`, or a transaction command.
 * 3. A statement that cannot be classified is allowed only when the driver
 *    declares a server-enforced read-only mode. There the server is the enforcer
 *    and an unclassified statement is safe by construction. Where it is not (Doris
 *    and TDengine have no read-only transaction) classification is the only gate,
 *    so an unclassified statement is refused instead of guessed at.
 *
 * Row caps, per-cell bounds, and notices are owned here too, so a driver only has
 * to answer a statement with positional rows and its own engine's semantics.
 *
 * @module dsh-db-connections/registry
 */

import { createDriver } from './drivers/index.js'
import { toJsonRow } from './values.js'

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

/** Raised when a configured connection cannot be used in this environment. */
export class UnavailableConnectionError extends Error {
  /**
   * @param {string} name - the requested connection name.
   * @param {string} reason - why the connection is unusable.
   */
  constructor(name, reason) {
    super(`connection ${JSON.stringify(name)} is configured but not usable here: ${reason}`)
    this.name = 'UnavailableConnectionError'
  }
}

/** Registry of configured connections and their lazily created drivers. */
export class ConnectionRegistry {
  /** @type {Map<string, object>} */
  #connections = new Map()
  /** @type {Map<string, object>} */
  #drivers = new Map()
  /** @type {{ record: (entry: object) => void } | undefined} */
  #audit
  /** @type {(connection: object) => object} */
  #createDriver

  /**
   * @param {object[]} connections - normalized connections from `resolveConnections`.
   * @param {{ audit?: { record: (entry: object) => void }, createDriver?: (connection: object) => object }} [options] - collaborators.
   */
  constructor(connections, options = {}) {
    for (const connection of connections) this.#connections.set(connection.name, connection)
    this.#audit = options.audit
    // The factory is a seam: it defaults to the real catalog, and a test can
    // supply a stand-in engine to exercise everything this registry owns —
    // row caps, cell bounds, the read policy, and the audit hook — without one.
    this.#createDriver = options.createDriver ?? createDriver
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
   * @throws {UnknownConnectionError | UnavailableConnectionError} when the name is
   *   not configured, or is configured but unusable in this environment.
   */
  get(name) {
    const connection = this.#connections.get(name)
    if (connection === undefined) throw new UnknownConnectionError(name, this.names())
    if (connection.unavailable !== undefined) throw new UnavailableConnectionError(name, connection.unavailable)
    return connection
  }

  /**
   * Get or create the driver for one connection.
   * @param {object} connection - the normalized connection.
   * @returns {object} the driver instance.
   */
  #driverFor(connection) {
    const existing = this.#drivers.get(connection.name)
    if (existing !== undefined) return existing
    const driver = this.#createDriver(connection)
    this.#drivers.set(connection.name, driver)
    return driver
  }

  /**
   * Refuse anything that is not a read on this connection.
   * @param {object} connection - the normalized connection.
   * @param {object} driver - the connection's driver.
   * @param {string} sql - the statement.
   * @throws {Error} when the statement must not run through `db_query`.
   */
  #assertReadable(connection, driver, sql) {
    const identifier = JSON.stringify(connection.name)
    const kind = driver.classify(sql)
    if (kind === 'write') {
      throw new Error(`db_query runs read-only statements only; this one writes. Use db_execute for connection ${identifier}.`)
    }
    if (kind === 'control') {
      throw new Error(`db_query runs data-reading statements only; this statement sets session or administrative state. It is not available on any connection.`)
    }
    if (kind === 'unknown' && driver.info.readOnly !== 'server') {
      throw new Error(`${driver.info.label} cannot enforce read-only access on the server, so db_query only accepts statements it can prove are reads (SELECT, SHOW, DESCRIBE, EXPLAIN). This statement could not be classified; rewrite it as one of those${connection.allowWrite ? ', or use db_execute if it is meant to change data' : ''}.`)
    }
  }

  /**
   * Record one execution for the audit trail, when one is configured.
   * @param {object} entry - the facts to record.
   */
  #record(entry) {
    this.#audit?.record(entry)
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
    const driver = this.#driverFor(connection)
    this.#assertReadable(connection, driver, sql)
    const started = Date.now()
    const result = await driver.fetch(sql, { signal })
    const dataRows = result.rows
    const projected = dataRows.slice(0, connection.maxRows)
    const notices = [...result.notices]
    if (dataRows.length > projected.length) {
      notices.push(`showing the first ${projected.length} of ${dataRows.length} rows; add a LIMIT or a narrower WHERE clause to see the intended rows`)
    }
    return {
      columns: result.columns,
      rows: projected.map(row => toJsonRow(row, connection.maxCellChars)),
      totalRows: dataRows.length,
      elapsedMs: Date.now() - started,
      notices,
    }
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
    if (connection.allowWrite === false) {
      throw new Error(`connection ${JSON.stringify(name)} is read-only; turn on "read-write" for it in the dsh-db-connections settings page to permit writes.`)
    }
    const driver = this.#driverFor(connection)
    const started = Date.now()
    try {
      const result = await driver.execute(sql, { signal })
      this.#record({
        connection: name,
        driver: connection.driver,
        sql,
        ok: true,
        affectedRows: result.affectedRows,
        elapsedMs: Date.now() - started,
      })
      return { ...result, elapsedMs: Date.now() - started }
    } catch (error) {
      this.#record({
        connection: name,
        driver: connection.driver,
        sql,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        elapsedMs: Date.now() - started,
      })
      throw error
    }
  }

  /**
   * Inspect schema at the granularity the caller asked for.
   * @param {string} name - the connection name.
   * @param {{ database?: string, table?: string }} target - how far to descend.
   * @param {AbortSignal | undefined} signal - caller cancellation.
   * @returns {Promise<object>} the schema report.
   */
  async schema(name, target, signal) {
    const connection = this.get(name)
    const driver = this.#driverFor(connection)
    const report = await driver.schema(target, { signal })
    return { connection: name, ...report }
  }

  /**
   * Check whether one connection currently answers.
   * @param {string} name - the connection name.
   * @returns {Promise<object>} the probe result.
   */
  async ping(name) {
    const connection = this.get(name)
    const driver = this.#driverFor(connection)
    return driver.ping()
  }

  /** Close every driver. Called when the plugin unloads or the list is replaced. */
  async dispose() {
    const drivers = [...this.#drivers.values()]
    this.#drivers.clear()
    await Promise.all(drivers.map(driver => driver.dispose()))
  }
}

/**
 * Driver catalog and factory.
 *
 * The catalog is what the settings page renders (a driver picker with the right
 * default port) and what the prompt reports per connection, so it is the single
 * place a new engine is announced. `pg` is never imported here: only the
 * PostgreSQL driver imports it, and only when a PostgreSQL connection is first
 * used.
 *
 * @module dsh-db-connections/drivers
 */

import { DRIVER_INFO as MYSQL_PROTOCOL_INFO, createMysqlDriver } from './mysql.js'
import { DRIVER_INFO as POSTGRES_INFO, createPostgresDriver } from './postgres.js'
import { DRIVER_INFO as TDENGINE_INFO, createTdengineDriver } from './tdengine.js'
import { DRIVER_DEFAULTS } from '../config.js'

/** MySQL-protocol driver metadata, keyed by the two engines that speak it. */
export const MYSQL_DRIVERS = MYSQL_PROTOCOL_INFO

/** Every driver the plugin can open a connection with, in picker order. */
export const DRIVER_CATALOG = Object.freeze([
  MYSQL_PROTOCOL_INFO.mysql,
  MYSQL_PROTOCOL_INFO.doris,
  POSTGRES_INFO,
  TDENGINE_INFO,
])

/**
 * Look up one driver's metadata.
 * @param {string} id - driver id.
 * @returns {object | undefined} the metadata, or undefined for an unknown id.
 */
export function driverInfo(id) {
  return DRIVER_CATALOG.find(entry => entry.id === id)
}

/**
 * Build the driver for one normalized connection.
 * @param {object} connection - the normalized connection.
 * @returns {object} the driver instance.
 * @throws {Error} when the connection names a driver that is not in the catalog.
 */
export function createDriver(connection) {
  switch (connection.driver) {
    case 'mysql':
    case 'doris':
      return createMysqlDriver(connection)
    case 'postgres':
      return createPostgresDriver(connection)
    case 'tdengine':
      return createTdengineDriver(connection)
    default:
      throw new Error(`no driver is registered for ${JSON.stringify(connection.driver)}`)
  }
}

/**
 * Project the catalog for the settings page.
 *
 * The row cap is included because the default is per engine (a bare TDengine
 * `SELECT` scans far more than a bare MySQL one), and a page that did not know
 * the default would write MySQL's 200 over a TDengine connection it never
 * touched.
 * @returns {object[]} one entry per driver, carrying only what the page needs.
 */
export function driverChoices() {
  return DRIVER_CATALOG.map(info => ({
    id: info.id,
    label: info.label,
    defaultPort: info.defaultPort,
    maxRows: DRIVER_DEFAULTS[info.id].maxRows,
    readOnly: info.readOnly,
    readOnlyNote: info.readOnlyNote,
    tls: true,
  }))
}

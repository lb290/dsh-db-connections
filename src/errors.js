/**
 * Driver-failure translation shared by every dialect.
 *
 * A raw driver error names a code, not a user action. Each dialect module adds
 * its own codes to the tables here; this module owns the transport-level ones
 * every dialect can hit and the read-only refusals that mean the server stopped
 * a statement.
 *
 * @module dsh-db-connections/errors
 */

/** Read-only transaction refusals, by the code each dialect reports. */
const READ_ONLY_CODES = new Set([
  'ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION', // MySQL
  'ER_OPTION_PREVENTS_STATEMENT', // MySQL, read-only account
  '25006', // PostgreSQL, read_only_sql_transaction
])

/** Transport failures every dialect can raise, keyed by Node error code. */
const TRANSPORT_CODES = new Set([
  'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'ECONNRESET',
  'EPIPE', 'ECONNABORTED', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET', 'ERR_SOCKET_CONNECTION_TIMEOUT',
])

/** Whether a thrown value is the dialect's read-only refusal. */
export function isReadOnlyRefusal(error) {
  return READ_ONLY_CODES.has(error?.code)
}

/**
 * Describe a transport failure against one connection.
 * @param {object} error - the thrown value.
 * @param {object} connection - the normalized connection.
 * @returns {string | undefined} the message, or undefined when the code is not a transport failure.
 */
export function transportMessage(error, connection) {
  if (TRANSPORT_CODES.has(error?.code) === false) return undefined
  const target = `${connection.host}:${connection.port}`
  const match = {
    ECONNREFUSED: () => `cannot reach ${target}: connection refused`,
    ETIMEDOUT: () => `timed out connecting to ${target}`,
    ENOTFOUND: () => `host ${connection.host} could not be resolved`,
    EHOSTUNREACH: () => `host ${connection.host} is unreachable`,
    ECONNRESET: () => `the server at ${target} closed the connection`,
    EPIPE: () => `the connection to ${target} was closed while sending the statement`,
    ECONNABORTED: () => `the connection to ${target} was aborted`,
  }[error.code]
  return match === undefined
    ? `the connection to ${target} failed (${error.code})`
    : match()
}

/**
 * Turn any thrown value into an Error, keeping the driver's own message.
 * @param {unknown} error - the thrown value.
 * @returns {Error} the error to surface.
 */
export function asError(error) {
  return error instanceof Error ? error : new Error(String(error))
}

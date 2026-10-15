/**
 * SQL text helpers: leading-keyword classification and identifier quoting.
 *
 * Read-only access is never enforced here. The server enforces it: read
 * statements run inside an explicit `START TRANSACTION READ ONLY`, which MySQL
 * refuses to write from even on a read-write account. Classification exists so
 * a mistaken call fails fast with a message naming the right tool, instead of
 * making the model interpret a server error code.
 *
 * @module dsh-db-connections/sql
 */

/** Leading keywords that change data or schema, or control transactions. */
const WRITE_KEYWORDS = new Set([
  'insert', 'update', 'delete', 'replace', 'create', 'drop', 'alter', 'truncate',
  'rename', 'grant', 'revoke', 'lock', 'unlock', 'flush', 'optimize', 'repair',
  'purge', 'reset', 'install', 'uninstall', 'kill', 'shutdown', 'call', 'load',
  'handler', 'do', 'savepoint', 'commit', 'rollback', 'begin', 'start',
])

/** Leading keywords that only read. */
const READ_KEYWORDS = new Set(['select', 'show', 'describe', 'desc', 'explain', 'table', 'values'])

/**
 * Whitespace and comment runs that may precede a statement's keyword. Only the
 * leading run is removed, so a keyword appearing inside a string literal or a
 * later statement is never re-interpreted as this statement's leading keyword.
 */
const LEADING_NOISE = /^(?:\s+|\/\*[\s\S]*?\*\/|--[^\n]*|#[^\n]*)+/u

/**
 * Read the leading keyword of a statement, ignoring leading whitespace and
 * comments.
 * @param {string} sql - the statement text.
 * @returns {string} the lowercase keyword, or `''` when no keyword leads the text.
 */
export function leadingKeyword(sql) {
  const match = /^[A-Za-z_]+/u.exec(sql.replace(LEADING_NOISE, ''))
  return match === null ? '' : match[0].toLowerCase()
}

/**
 * Classify one statement by its leading keyword.
 *
 * `WITH` reports `'unknown'` because a common table expression may lead either
 * kind; the server's read-only transaction decides those.
 * @param {string} sql - the statement text.
 * @returns {'read' | 'write' | 'unknown'} the classification.
 */
export function classify(sql) {
  const keyword = leadingKeyword(sql)
  if (READ_KEYWORDS.has(keyword)) return 'read'
  if (WRITE_KEYWORDS.has(keyword)) return 'write'
  return 'unknown'
}

/**
 * Quote one MySQL identifier with backticks.
 * @param {string} name - the identifier to quote.
 * @returns {string} the quoted identifier.
 */
export function quoteIdent(name) {
  return `\`${name.replaceAll('`', '``')}\``
}

/**
 * Quote a fully qualified `schema.table` name.
 * @param {string} database - the schema name.
 * @param {string} table - the table name.
 * @returns {string} the quoted qualified name.
 */
export function quoteQualified(database, table) {
  return `${quoteIdent(database)}.${quoteIdent(table)}`
}

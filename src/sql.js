/**
 * SQL text helpers: per-dialect statement classification, single-statement
 * enforcement, and identifier quoting.
 *
 * Read-only access is never *enforced* here for a dialect that has a server-side
 * read-only transaction; there the server is the enforcer and classification
 * only fails fast with a message naming the right tool. For a dialect with no
 * read-only transaction (Doris, TDengine) this module is the only gate, so
 * `db_query` accepts the read keywords below and refuses everything else —
 * including statements it cannot classify.
 *
 * @module dsh-db-connections/sql
 */

/** Statements that only read, per dialect. */
const READ_KEYWORDS = Object.freeze({
  mysql: new Set(['select', 'show', 'describe', 'desc', 'explain', 'table', 'values', 'help']),
  // `SELECT` and `SHOW` are the reads Doris documents; `WITH` is deliberately
  // absent because Doris also accepts a CTE in front of a write.
  doris: new Set(['select', 'show', 'describe', 'desc', 'explain']),
  postgres: new Set(['select', 'show', 'table', 'values', 'explain', 'describe', 'desc']),
  tdengine: new Set(['select', 'show', 'describe', 'desc', 'explain']),
})

/** Statements that change data or schema, shared by every dialect. */
const WRITE_KEYWORDS = new Set([
  'insert', 'update', 'delete', 'replace', 'merge', 'upsert', 'create', 'drop',
  'alter', 'truncate', 'rename', 'comment', 'copy', 'vacuum', 'reindex',
  'cluster', 'refresh', 'import',
])

/** Session, transaction, and administrative statements: never a data query. */
const CONTROL_KEYWORDS = new Set([
  'set', 'use', 'begin', 'start', 'commit', 'rollback', 'savepoint', 'release',
  'prepare', 'execute', 'deallocate', 'lock', 'unlock', 'flush', 'kill',
  'shutdown', 'install', 'uninstall', 'reset', 'purge', 'analyze', 'optimize',
  'repair', 'check', 'call', 'do', 'handler', 'grant', 'revoke', 'load',
])

/**
 * Whitespace and comment runs that may precede a statement's keyword. Only the
 * leading run is removed, so a keyword appearing inside a string literal or a
 * later statement is never re-interpreted as this statement's leading keyword.
 */
const LEADING_NOISE = /^(?:\s+|\/\*[\s\S]*?\*\/|--[^\n]*|#[^\n]*)+/u

/** Dialects whose backslash escape sequences are real inside string literals. */
const BACKSLASH_ESCAPES = new Set(['mysql', 'doris'])

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
 * Classify one statement for one dialect.
 *
 * `'unknown'` means the leading keyword is in neither list — a common table
 * expression, a dialect this module has not seen, or junk. A caller must treat
 * `'unknown'` as unsafe unless the dialect enforces read-only access on the
 * server, which `ConnectionRegistry` decides from the driver's declaration.
 * @param {string} sql - the statement text.
 * @param {string} dialect - driver id (`mysql`, `doris`, `postgres`, `tdengine`).
 * @returns {'read' | 'write' | 'control' | 'unknown'} the classification.
 */
export function classify(sql, dialect) {
  const keyword = leadingKeyword(sql)
  if (READ_KEYWORDS[dialect]?.has(keyword) === true) return 'read'
  if (WRITE_KEYWORDS.has(keyword)) return 'write'
  if (CONTROL_KEYWORDS.has(keyword)) return 'control'
  return 'unknown'
}

/**
 * Skip a line comment that starts at `start` (just past its introducer).
 * @param {string} sql - the statement text.
 * @param {number} start - index of the first character after the introducer.
 * @returns {number} index of the terminating newline, or the text length.
 */
function skipLine(sql, start) {
  const end = sql.indexOf('\n', start)
  return end === -1 ? sql.length : end
}

/**
 * Skip a block comment that starts at `start` (just past its introducer).
 * @param {string} sql - the statement text.
 * @param {number} start - index of the first character inside the comment.
 * @returns {number} index just past the closing delimiter, or the text length.
 */
function skipBlock(sql, start) {
  const end = sql.indexOf('*/', start)
  return end === -1 ? sql.length : end + 2
}

/**
 * Skip a quoted run starting at `start` (the opening quote character).
 *
 * Backslash escapes are honoured only for a dialect that has them, so an
 * unescaped backslash in a PostgreSQL or TDengine statement cannot make two
 * statements read as one: an ambiguous scan finds more statements, never fewer.
 * @param {string} sql - the statement text.
 * @param {number} start - index of the opening quote.
 * @param {string} quote - the quote character (`'`, `"`, or a backtick).
 * @param {boolean} backslash - whether a backslash escapes the next character.
 * @returns {number} index just past the closing quote, or the text length.
 */
function skipQuoted(sql, start, quote, backslash) {
  let index = start + 1
  while (index < sql.length) {
    const character = sql[index]
    if (backslash && character === '\\') {
      index += 2
      continue
    }
    if (character === quote) {
      // A doubled quote is an escaped quote, not a terminator.
      if (sql[index + 1] === quote) {
        index += 2
        continue
      }
      return index + 1
    }
    index += 1
  }
  return sql.length
}

/**
 * Skip a PostgreSQL dollar-quoted run (`$$ … $$`, `$tag$ … $tag$`).
 * @param {string} sql - the statement text.
 * @param {number} start - index of the opening dollar sign.
 * @returns {number} index just past the closing delimiter, or `-1` when this
 *   character does not open a dollar quote.
 */
function skipDollar(sql, start) {
  const opening = /^\$\$|^\$[A-Za-z_][A-Za-z0-9_]*\$/u.exec(sql.slice(start))
  if (opening === null) return -1
  const close = sql.indexOf(opening[0], start + opening[0].length)
  return close === -1 ? sql.length : close + opening[0].length
}

/**
 * Count the statements in one SQL string.
 *
 * The scan is deliberately conservative: where a construct is ambiguous it
 * counts more statements, so the worst case is a refused call.
 * @param {string} sql - the statement text.
 * @param {string} [dialect] - driver id, which decides backslash and dollar handling.
 * @returns {number} the number of statements (0 for blank or comment-only text).
 */
export function statementCount(sql, dialect) {
  const backslash = BACKSLASH_ESCAPES.has(dialect)
  const dollars = dialect === 'postgres'
  let count = 0
  let pending = false
  let index = 0
  while (index < sql.length) {
    const character = sql[index]
    const next = sql[index + 1]
    if (character === '-' && next === '-') {
      index = skipLine(sql, index + 2)
      continue
    }
    if (character === '#') {
      index = skipLine(sql, index + 1)
      continue
    }
    if (character === '/' && next === '*') {
      index = skipBlock(sql, index + 2)
      continue
    }
    if (character === "'" || character === '"' || character === '`') {
      pending = true
      index = skipQuoted(sql, index, character, backslash)
      continue
    }
    if (dollars && character === '$') {
      const end = skipDollar(sql, index)
      if (end !== -1) {
        pending = true
        index = end
        continue
      }
    }
    if (character === ';') {
      if (pending) count += 1
      pending = false
      index += 1
      continue
    }
    if (/\s/u.test(character) === false) pending = true
    index += 1
  }
  return pending ? count + 1 : count
}

/**
 * Refuse a multi-statement string.
 *
 * One statement per call is what makes the read-only classification meaningful:
 * a trailing `SELECT 1; DROP TABLE t` would otherwise be classified by its
 * first keyword alone. MySQL refuses a second statement server-side already;
 * PostgreSQL and TDengine do not.
 * @param {string} sql - the statement text.
 * @param {string} dialect - driver id.
 * @throws {Error} when the text holds no statement or more than one.
 */
export function assertSingleStatement(sql, dialect) {
  const count = statementCount(sql, dialect)
  if (count === 0) throw new Error('the statement is empty')
  if (count > 1) {
    throw new Error(`one statement per call: this text holds ${count} statements separated by ";"`)
  }
}

/**
 * Quote one identifier for a dialect.
 * @param {string} name - the identifier to quote.
 * @param {string} dialect - driver id.
 * @returns {string} the quoted identifier.
 */
export function quoteIdent(name, dialect) {
  if (dialect === 'postgres') return `"${name.replaceAll('"', '""')}"`
  return `\`${name.replaceAll('`', '``')}\``
}

/**
 * Quote a fully qualified `schema.table` name for a dialect.
 * @param {string} database - the schema or database name.
 * @param {string} table - the table name.
 * @param {string} dialect - driver id.
 * @returns {string} the quoted qualified name.
 */
export function quoteQualified(database, table, dialect) {
  return `${quoteIdent(database, dialect)}.${quoteIdent(table, dialect)}`
}

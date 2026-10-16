/**
 * Opt-in audit trail for writing statements.
 *
 * A connection with writes enabled lets the model change data, so the deployment
 * needs a record of what it changed. Records are one JSON object per line, so the
 * file is append-only, greppable, and never rewritten in place.
 *
 * The record holds no credential: the statement text is bounded and the password
 * never appears in it. A write that fails is recorded too — a refusal is exactly
 * the fact a later investigation looks for.
 *
 * @module dsh-db-connections/audit
 */

import fs from 'node:fs'
import path from 'node:path'
import { ConfigError } from './config.js'

/** Default bound on the statement text kept per record. */
const DEFAULT_MAX_SQL_CHARS = 512

/** Raised when the audit setting cannot be used. */
export class AuditError extends Error {
  /**
   * @param {string} message - what is wrong and what to do about it.
   */
  constructor(message) {
    super(message)
    this.name = 'AuditError'
  }
}

/**
 * Validate the `audit` config block.
 * @param {unknown} raw - the configured value.
 * @param {string} baseDir - directory a relative path resolves against.
 * @returns {{ path: string, maxSqlChars: number } | undefined} the resolved setting, or
 *   undefined when auditing is not configured.
 * @throws {ConfigError} when the block is malformed.
 */
export function resolveAudit(raw, baseDir) {
  if (raw === undefined || raw === null || raw === false) return undefined
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError(`config.audit must be a mapping with a path, received ${JSON.stringify(raw)}`)
  }
  const configured = raw.path
  if (typeof configured !== 'string' || configured.trim() === '') {
    throw new ConfigError('config.audit.path is required and must be a non-empty string')
  }
  const maxSqlChars = raw.maxSqlChars ?? DEFAULT_MAX_SQL_CHARS
  if (typeof maxSqlChars !== 'number' || Number.isInteger(maxSqlChars) === false || maxSqlChars <= 0) {
    throw new ConfigError(`config.audit.maxSqlChars must be a positive integer, received ${JSON.stringify(raw.maxSqlChars)}`)
  }
  const resolved = path.isAbsolute(configured) ? configured : path.resolve(baseDir, configured)
  return { path: resolved, maxSqlChars }
}

/**
 * Build the audit sink.
 * @param {{ path: string, maxSqlChars: number }} settings - the resolved setting.
 * @returns {{ record: (entry: object) => void, file: string }} the sink.
 */
export function createAuditLog(settings) {
  const directory = path.dirname(settings.path)
  try {
    fs.mkdirSync(directory, { recursive: true })
  } catch (error) {
    throw new AuditError(`the audit directory could not be created (${directory}): ${error.message}`)
  }

  /**
   * Appends are serialized through this chain.
   *
   * `fs.appendFile` is asynchronous and unordered: two records written back to
   * back reach the file in whichever order the pool finishes them, so the trail
   * can read as if a later statement came first. For an audit log that is not a
   * cosmetic problem — the file is what a later investigation reads the order
   * of events from. Each append therefore starts only after the previous one has
   * settled.
   */
  let pending = Promise.resolve()

  /**
   * Append one record.
   * @param {object} entry - the facts to record.
   */
  function record(entry) {
    const line = `${JSON.stringify({
      time: new Date().toISOString(),
      ...entry,
      sql: typeof entry.sql === 'string' && entry.sql.length > settings.maxSqlChars
        ? `${entry.sql.slice(0, settings.maxSqlChars)}…(${entry.sql.length - settings.maxSqlChars} more chars)`
        : entry.sql,
    })}\n`
    // A failed append must never break the tool call it describes: the caller is
    // told the statement's own outcome, and the audit gap is the lesser problem.
    // That is also why the chain settles either way rather than rejecting.
    pending = pending.then(() => new Promise(resolve => {
      fs.appendFile(settings.path, line, () => { resolve() })
    }))
  }

  return { record, file: settings.path }
}

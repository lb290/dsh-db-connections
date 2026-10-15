/**
 * Cell-value normalization for lossless JSON output.
 *
 * MySQL drivers return JavaScript values that are not JSON: `Buffer` for binary
 * columns, `bigint` for large integers, `Date` for temporal columns. A tool's
 * canonical value must be lossless JSON, so every cell is converted here.
 *
 * @module dsh-db-connections/values
 */

/** Marker used when a binary value is rendered as text. */
const BINARY_PREFIX = '0x'

/**
 * Shorten an over-long string for display, keeping the original length visible.
 * @param {string} text - the text to bound.
 * @param {number} maxChars - the maximum retained characters.
 * @returns {string} the original or abbreviated text.
 */
function bound(text, maxChars) {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}…(${text.length - maxChars} more chars)`
}

/**
 * Convert one driver value into a lossless JSON value.
 * @param {unknown} value - the value returned by the driver.
 * @param {number} maxChars - per-cell character bound.
 * @returns {unknown} a JSON-representable value.
 */
export function toJsonValue(value, maxChars) {
  if (value === null || value === undefined) return null
  switch (typeof value) {
    case 'string': return bound(value, maxChars)
    case 'number': return Number.isFinite(value) ? value : String(value)
    case 'boolean': return value
    // The driver returns bigint only when bigNumberStrings is off; keep it lossless.
    case 'bigint': return value.toString()
    case 'object':
      if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) {
        const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value.buffer, value.byteOffset, value.byteLength)
        return bound(`${BINARY_PREFIX}${buffer.toString('hex')}`, maxChars)
      }
      if (value instanceof Date) return value.toISOString()
      if (Array.isArray(value)) return value.map(item => toJsonValue(item, maxChars))
      // A JSON column arrives already parsed; round-trip it so only plain data is kept.
      try {
        return JSON.parse(JSON.stringify(value, (_key, nested) => (
          typeof nested === 'bigint' ? nested.toString() : nested)))
      } catch {
        return bound(String(value), maxChars)
      }
    default: return String(value)
  }
}

/**
 * Convert one result row into lossless JSON.
 * @param {unknown[]} row - the driver row.
 * @param {number} maxChars - per-cell character bound.
 * @returns {unknown[]} the JSON row.
 */
export function toJsonRow(row, maxChars) {
  return row.map(cell => toJsonValue(cell, maxChars))
}

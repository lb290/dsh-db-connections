/**
 * Raw tool definition, argument validation, and result rendering.
 *
 * Tools are registered as plain `ToolDefinition` objects rather than through
 * `defineTool` from `@deepseek-ai/dsh-tools`. Two reasons: a plugin loaded from
 * an arbitrary path must not depend on resolving a harness package (the
 * harness's own resolver does not apply to a linked checkout), and registering a
 * raw JSON Schema means this module owns input validation — which is what lets
 * the errors below name the offending argument instead of a schema path.
 *
 * @module dsh-db-connections/tool
 */

/** Raised when model-supplied arguments violate the declared parameter schema. */
export class ToolArgsError extends Error {
  /** @type {string[]} */
  violations

  /**
   * @param {string} toolName - the tool that rejected the call.
   * @param {string[]} violations - path-qualified violations.
   */
  constructor(toolName, violations) {
    super(`${toolName} received invalid arguments: ${violations.join('; ')}`)
    this.name = 'ToolArgsError'
    this.violations = violations
  }
}

/**
 * Describe a value's JSON type for an error message.
 * @param {unknown} value - the offending value.
 * @returns {string} the value's type name.
 */
function typeName(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (Number.isInteger(value)) return 'integer'
  return typeof value
}

/**
 * Match one value against one raw JSON Schema node from the enforced subset.
 * @param {Record<string, unknown>} schema - the schema node.
 * @param {unknown} value - the candidate value.
 * @param {string} path - dotted path used in violations.
 * @param {string[]} violations - collector for violations.
 */
function checkNode(schema, value, path, violations) {
  if (schema.const !== undefined && value !== schema.const) {
    violations.push(`${path} must be ${JSON.stringify(schema.const)}, received ${JSON.stringify(value)}`)
    return
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    violations.push(`${path} must be one of ${schema.enum.map(item => JSON.stringify(item)).join(', ')}, received ${JSON.stringify(value)}`)
    return
  }
  const type = schema.type
  if (type === undefined) return
  if (type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      violations.push(`${path} must be an object, received ${typeName(value)}`)
      return
    }
    const record = /** @type {Record<string, unknown>} */ (value)
    const properties = schema.properties ?? {}
    for (const name of schema.required ?? []) {
      if (record[name] === undefined) violations.push(`${path}${path === '' ? '' : '.'}${name} is required`)
    }
    for (const [name, nested] of Object.entries(record)) {
      const child = properties[name]
      const childPath = path === '' ? name : `${path}.${name}`
      if (child === undefined) {
        if (schema.additionalProperties === false) violations.push(`${childPath} is not a recognized argument`)
        continue
      }
      if (nested === undefined) continue
      checkNode(child, nested, childPath, violations)
    }
    return
  }
  if (type === 'array') {
    if (!Array.isArray(value)) {
      violations.push(`${path} must be an array, received ${typeName(value)}`)
      return
    }
    if (schema.items === undefined) return
    value.forEach((item, index) => {
      checkNode(schema.items, item, `${path}[${index}]`, violations)
    })
    return
  }
  if (type === 'string') {
    if (typeof value !== 'string') violations.push(`${path} must be a string, received ${typeName(value)}`)
    return
  }
  if (type === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) violations.push(`${path} must be an integer, received ${typeName(value)}`)
    return
  }
  if (type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) violations.push(`${path} must be a number, received ${typeName(value)}`)
    return
  }
  if (type === 'boolean') {
    if (typeof value !== 'boolean') violations.push(`${path} must be a boolean, received ${typeName(value)}`)
    return
  }
  if (type === 'null' && value !== null) violations.push(`${path} must be null, received ${typeName(value)}`)
}

/**
 * Validate model arguments against an implicit parameter root.
 * @param {Record<string, unknown>} parameters - the declared parameter schema.
 * @param {unknown} args - the candidate arguments.
 * @returns {string[]} path-qualified violations; empty means valid.
 */
export function validateArgs(parameters, args) {
  const violations = []
  checkNode(parameters, args, '', violations)
  return violations
}

/** Merge declared defaults into the arguments the body receives. */
function withDefaults(parameters, args) {
  const properties = parameters.properties ?? {}
  const resolved = { ...args }
  for (const [name, schema] of Object.entries(properties)) {
    if (resolved[name] === undefined && schema.default !== undefined) resolved[name] = schema.default
  }
  return resolved
}

/**
 * Build a registry-ready tool definition that validates its own arguments.
 * @param {object} options - the tool's declaration.
 * @param {string} options.name - model-facing tool name.
 * @param {string} options.description - model-facing description.
 * @param {Record<string, unknown>} options.parameters - implicit parameter root schema.
 * @param {{ schema: Record<string, unknown>, render: (args: object, value: object) => object[] }} options.output - canonical output declaration.
 * @param {number} [options.timeoutMs] - cooperative deadline in milliseconds.
 * @param {(args: object) => boolean} [options.isConcurrencySafe] - sibling-overlap classifier.
 * @param {(args: object, exec: { signal?: AbortSignal }) => Promise<object>} options.execute - the tool body.
 * @returns {object} the definition `ctx.tools.register()` accepts.
 */
export function defineRawTool(options) {
  const { name, parameters } = options
  return {
    name,
    description: options.description,
    parameters,
    output: options.output,
    ...options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
    ...options.isConcurrencySafe === undefined ? {} : { isConcurrencySafe: options.isConcurrencySafe },
    async execute(args, exec) {
      const violations = validateArgs(parameters, args)
      if (violations.length > 0) throw new ToolArgsError(name, violations)
      return options.execute(withDefaults(parameters, args), exec)
    },
  }
}

/**
 * Build a single-block text result.
 * @param {string} text - the text the model reads.
 * @returns {object[]} one content block.
 */
export function textResult(text) {
  return [{ type: 'text', text }]
}

/**
 * Characters that occupy two terminal columns: CJK, fullwidth forms, and emoji.
 *
 * The width matters because the rendered table is read by a model that also
 * reads the surrounding text: a column padded by code-unit count misaligns every
 * row once a Chinese comment or a Chinese table name appears in it.
 */
const WIDE_CHARACTER = /[\u1100-\u115F\u2E80-\u303F\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]|\p{Extended_Pictographic}/u

/**
 * Measure the printed width of one cell.
 * @param {string} text - the cell text.
 * @returns {number} the width in terminal columns.
 */
export function displayWidth(text) {
  let width = 0
  for (const character of text) width += WIDE_CHARACTER.test(character) ? 2 : 1
  return width
}

/**
 * Pad one cell to a printed width.
 * @param {string} text - the cell text.
 * @param {number} width - the target width.
 * @returns {string} the padded cell.
 */
function padTo(text, width) {
  const missing = width - displayWidth(text)
  return missing > 0 ? `${text}${' '.repeat(missing)}` : text
}

/**
 * Render one cell as text.
 * @param {unknown} cell - a JSON-representable cell value.
 * @returns {string} the cell text.
 */
function cellText(cell) {
  if (cell === null) return 'NULL'
  if (typeof cell === 'string') return cell
  if (typeof cell === 'object') return JSON.stringify(cell)
  return String(cell)
}

/**
 * Render one aligned text table from a header and rows.
 * @param {string[]} columns - column names.
 * @param {unknown[][]} rows - row cells, already JSON values.
 * @returns {string} the rendered table.
 */
export function renderTable(columns, rows) {
  const cells = rows.map(row => row.map(cellText))
  const widths = columns.map((column, index) => Math.max(
    displayWidth(column),
    ...cells.map(row => displayWidth(row[index] ?? '')),
  ))
  const line = values => values.map((value, index) => padTo(value, widths[index])).join(' | ').trimEnd()
  const separator = widths.map(width => '-'.repeat(width)).join('-+-')
  return [line(columns), separator, ...cells.map(line)].join('\n')
}

/**
 * Render one field for a comma-separated line.
 * @param {string} value - the cell text.
 * @returns {string} the quoted field when quoting is required.
 */
function csvCell(value) {
  return /[",\n\r]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

/**
 * Render a result in one of the supported formats.
 *
 * `table` is the readable default; `csv` and `json` exist because a wide result
 * costs far fewer tokens without column padding.
 * @param {string[]} columns - column names.
 * @param {unknown[][]} rows - row cells, already JSON values.
 * @param {'table' | 'csv' | 'json'} format - the requested format.
 * @returns {string} the rendered body.
 */
export function formatRows(columns, rows, format) {
  if (format === 'json') return JSON.stringify({ columns, rows })
  if (format === 'csv') {
    return [columns.map(csvCell).join(','), ...rows.map(row => row.map(cell => csvCell(cellText(cell))).join(','))].join('\n')
  }
  return renderTable(columns, rows)
}

/**
 * Bound rendered text to a character budget, cutting at a line boundary.
 * @param {string} text - the rendered text.
 * @param {number} maxChars - the budget.
 * @returns {{ text: string, truncated: boolean }} the bounded text.
 */
export function boundText(text, maxChars) {
  if (maxChars <= 0 || text.length <= maxChars) return { text, truncated: false }
  const boundary = text.lastIndexOf('\n', maxChars - 1)
  return { text: text.slice(0, boundary > maxChars * 0.6 ? boundary : maxChars), truncated: true }
}

/**
 * Raw tool definition and argument validation.
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
 * @param {(args: object) => object | undefined} [options.presentCall] - pending-state card.
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
    ...options.presentCall === undefined ? {} : { presentCall: options.presentCall },
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
 * Render one aligned text table from a header and rows.
 * @param {string[]} columns - column names.
 * @param {unknown[][]} rows - row cells, already JSON values.
 * @returns {string} the rendered table.
 */
export function renderTable(columns, rows) {
  const cells = rows.map(row => row.map(cell => (cell === null ? 'NULL' : String(cell))))
  const widths = columns.map((column, index) => Math.max(
    column.length,
    ...cells.map(row => (row[index] ?? '').length),
  ))
  const line = (values) => values.map((value, index) => value.padEnd(widths[index])).join(' | ').trimEnd()
  const separator = widths.map(width => '-'.repeat(width)).join('-+-')
  return [line(columns), separator, ...cells.map(line)].join('\n')
}

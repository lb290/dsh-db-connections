/**
 * The three model-facing tools: `db_query`, `db_execute`, and `db_schema`.
 *
 * Each returns a canonical JSON value; `output.render` turns it into the text
 * the model reads. Rendering is where the character budget is applied, because
 * the budget bounds the *text* the model receives rather than the canonical
 * result the session log keeps.
 *
 * @module dsh-db-connections/tools
 */

import { DEFAULTS } from './config.js'
import { boundText, defineRawTool, formatRows, textResult } from './tool.js'

/**
 * The `connection` parameter description.
 *
 * A tool schema is registered once, so it cannot name the current connections —
 * the list would go stale the moment the settings page saves. The system-prompt
 * section is re-rendered every turn and is the authoritative list, so the
 * description points there; a wrong name is refused by the registry anyway,
 * with the configured names in the message.
 */
const CONNECTION_PARAMETER = {
  type: 'string',
  description: 'Connection name. The configured names are listed in the current prompt section; an unconfigured name is refused with the list.',
}

/** The `format` parameter, shared by the two row-returning tools. */
const FORMAT_PARAMETER = {
  type: 'string',
  enum: ['table', 'json', 'csv'],
  default: 'table',
  description: 'How to render the rows. "table" is aligned and readable; "csv" and "json" are more compact when the result is wide.',
}

/** Canonical output schema shared by `db_query` and `db_schema`. */
const TABLE_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    columns: { type: 'array', items: { type: 'string' } },
    rows: { type: 'array', items: { type: 'array', items: {} } },
    totalRows: { type: 'integer' },
    elapsedMs: { type: 'integer' },
    notices: { type: 'array', items: { type: 'string' } },
  },
  required: ['columns', 'rows', 'totalRows', 'elapsedMs', 'notices'],
  additionalProperties: false,
})

/**
 * Resolve the character budget for one connection's rendered result.
 * @param {import('./live.js').LiveConnections} live - the live connection holder.
 * @param {string} name - the connection name.
 * @returns {number} the budget in characters.
 */
function budgetFor(live, name) {
  try {
    return live.registry.get(name).maxResultChars ?? DEFAULTS.maxResultChars
  } catch {
    // The name was resolved before the statement ran, so this is unreachable in
    // practice; a renderer must still never throw.
    return DEFAULTS.maxResultChars
  }
}

/**
 * Render a query result as a formatted body plus any bound notices.
 * @param {object} value - the canonical query result.
 * @param {{ format?: string, maxChars: number }} options - the rendering choices.
 * @returns {object[]} the model-facing content.
 */
function renderQueryResult(value, options) {
  const lines = []
  if (value.rows.length === 0) {
    lines.push(value.columns.length === 0 ? 'The statement returned no result set.' : 'No rows matched.')
  } else {
    const bounded = boundText(formatRows(value.columns, value.rows, options.format ?? 'table'), options.maxChars)
    lines.push(bounded.text)
    if (bounded.truncated) {
      lines.push(`Note: the rendered result exceeded maxResultChars (${options.maxChars}) and was cut. Add a LIMIT, narrow the WHERE clause, select fewer columns, ask for format "csv", or raise maxResultChars for this connection.`)
    }
  }
  lines.push(`${value.totalRows} row${value.totalRows === 1 ? '' : 's'} in ${value.elapsedMs} ms`)
  for (const notice of value.notices) lines.push(`Note: ${notice}`)
  return textResult(lines.join('\n\n'))
}

/**
 * Build the `db_query` tool.
 * @param {import('./live.js').LiveConnections} live - the live connection holder.
 * @returns {object} the tool definition.
 */
export function queryTool(live) {
  return defineRawTool({
    name: 'db_query',
    description: 'Run one read-only SQL statement against a named database connection and return the rows. Use this to inspect data; use db_execute to change it.',
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAMETER,
        sql: {
          type: 'string',
          description: 'One read-only SQL statement, in the SQL dialect of that connection. It must be a single statement; a statement that cannot be proven to be a read is refused.',
        },
        format: FORMAT_PARAMETER,
      },
      required: ['connection', 'sql'],
      additionalProperties: false,
    },
    output: {
      schema: TABLE_OUTPUT_SCHEMA,
      render: (args, value) => renderQueryResult(value, {
        format: args.format,
        maxChars: budgetFor(live, args.connection),
      }),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      return live.registry.query(args.connection, args.sql, exec.signal)
    },
  })
}

const EXECUTE_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    affectedRows: { type: 'integer' },
    // The enforced schema subset allows one scalar type per node; a null
    // insert id is expressed by omitting the type constraint entirely.
    insertId: {},
    info: { type: 'string' },
    warnings: { type: 'integer' },
    elapsedMs: { type: 'integer' },
  },
  required: ['affectedRows', 'insertId', 'info', 'warnings', 'elapsedMs'],
  additionalProperties: false,
})

/**
 * Build the `db_execute` tool. It is registered even when no connection allows
 * writes, so the model gets a message naming the setting rather than an
 * unknown-tool error.
 * @param {import('./live.js').LiveConnections} live - the live connection holder.
 * @returns {object} the tool definition.
 */
export function executeTool(live) {
  return defineRawTool({
    name: 'db_execute',
    description: 'Run one writing SQL statement (INSERT, UPDATE, DELETE, or DDL) against a named database connection and report the affected rows. Only a connection configured as writable accepts it; the prompt section marks which ones those are. Every call here is recorded in the audit log when one is configured.',
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAMETER,
        sql: {
          type: 'string',
          description: 'One writing SQL statement, in the SQL dialect of that connection. It must be a single statement.',
        },
      },
      required: ['connection', 'sql'],
      additionalProperties: false,
    },
    output: {
      schema: EXECUTE_OUTPUT_SCHEMA,
      render: (_args, value) => textResult([
        `${value.affectedRows} row${value.affectedRows === 1 ? '' : 's'} affected in ${value.elapsedMs} ms`,
        ...value.insertId === null ? [] : [`insert id ${value.insertId}`],
        ...value.warnings === 0 ? [] : [`${value.warnings} warning(s) reported by the server`],
        ...value.info.length === 0 ? [] : [value.info],
      ].join('\n')),
    },
    async execute(args, exec) {
      return live.registry.execute(args.connection, args.sql, exec.signal)
    },
  })
}

const SCHEMA_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    connection: { type: 'string' },
    level: { type: 'string', enum: ['databases', 'tables', 'table'] },
    databases: { type: 'array', items: { type: 'string' } },
    database: { type: 'string' },
    tables: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          type: { type: 'string' },
          engine: { type: 'string' },
          approximateRows: { type: 'integer' },
          comment: { type: 'string' },
        },
        required: ['name', 'type', 'engine', 'approximateRows', 'comment'],
        additionalProperties: false,
      },
    },
    table: { type: 'string' },
    columns: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          type: { type: 'string' },
          nullable: { type: 'boolean' },
          key: { type: 'string' },
          default: {},
          extra: { type: 'string' },
          comment: { type: 'string' },
        },
        required: ['name', 'type', 'nullable', 'key', 'extra', 'comment'],
        additionalProperties: false,
      },
    },
    indexes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          unique: { type: 'boolean' },
          position: { type: 'integer' },
          column: { type: 'string' },
          type: { type: 'string' },
        },
        required: ['name', 'unique', 'position', 'column', 'type'],
        additionalProperties: false,
      },
    },
    ddl: { type: 'string' },
    notices: { type: 'array', items: { type: 'string' } },
  },
  required: ['connection', 'level', 'notices'],
  additionalProperties: false,
})

/**
 * Render one schema report.
 * @param {object} value - the canonical schema value.
 * @returns {object[]} the model-facing content.
 */
function renderSchema(value) {
  if (value.level === 'databases') {
    return textResult([
      `Schemas on ${value.connection}:`,
      ...value.databases.map(name => `- ${name}`),
      '',
      'Pass one as `database` to list its tables.',
      ...value.notices.map(notice => `Note: ${notice}`),
    ].join('\n'))
  }
  if (value.level === 'tables') {
    const lines = value.tables.length === 0
      ? [`No tables in schema ${value.database}.`]
      : [
        `Tables in ${value.database} (${value.connection}):`,
        renderTableOrEmpty(value.tables),
        'Row counts are engine estimates, not exact counts.',
        'Pass one table name as `table` for its columns, indexes, and DDL.',
      ]
    for (const notice of value.notices) lines.push(`Note: ${notice}`)
    return textResult(lines.join('\n\n'))
  }
  const lines = [
    `${value.database}.${value.table} on ${value.connection}`,
    '',
    'Columns:',
    formatRows(
      ['column', 'type', 'null', 'key', 'default', 'extra'],
      value.columns.map(column => [
        column.name, column.type, column.nullable ? 'YES' : 'NO', column.key,
        column.default === undefined ? null : (column.default === null ? 'NULL' : String(column.default)),
        column.extra,
      ]),
      'table',
    ),
  ]
  if (value.indexes.length > 0) {
    lines.push('', 'Indexes:', formatRows(
      ['index', 'unique', 'seq', 'column', 'type'],
      value.indexes.map(index => [index.name, index.unique ? 'YES' : 'NO', index.position, index.column, index.type]),
      'table',
    ))
  }
  if (value.ddl.length > 0) lines.push('', 'DDL:', '```sql', value.ddl, '```')
  for (const notice of value.notices) lines.push('', `Note: ${notice}`)
  return textResult(lines.join('\n'))
}

/**
 * Render a table listing.
 * @param {object[]} tables - the schema report's table entries.
 * @returns {string} the rendered listing.
 */
function renderTableOrEmpty(tables) {
  return formatRows(
    ['table', 'type', 'engine', '~rows', 'comment'],
    tables.map(table => [table.name, table.type, table.engine, table.approximateRows, table.comment]),
    'table',
  )
}

/**
 * Build the `db_schema` tool.
 * @param {import('./live.js').LiveConnections} live - the live connection holder.
 * @returns {object} the tool definition.
 */
export function schemaTool(live) {
  return defineRawTool({
    name: 'db_schema',
    description: 'Inspect a named database connection before writing SQL against it: list its schemas, then a schema\'s tables, then one table\'s columns, indexes, and DDL. Omit both other arguments to list schemas.',
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAMETER,
        database: {
          type: 'string',
          description: 'Schema (database) to inspect; omit to list the schemas the connection can see. Defaults to the connection\'s own default schema when it has one.',
        },
        schema: {
          type: 'string',
          description: 'Alias of `database`, for engines whose second level is named schema (PostgreSQL).',
        },
        table: {
          type: 'string',
          description: 'Table to describe; requires a schema, from this argument or the connection default. Omit to list the schema\'s tables.',
        },
      },
      required: ['connection'],
      additionalProperties: false,
    },
    output: {
      schema: SCHEMA_OUTPUT_SCHEMA,
      render: (_args, value) => renderSchema(value),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const database = args.database ?? args.schema
      return live.registry.schema(args.connection, {
        ...database === undefined ? {} : { database },
        ...args.table === undefined ? {} : { table: args.table },
      }, exec.signal)
    },
  })
}

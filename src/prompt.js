/**
 * Model-facing prompt text describing the configured connections.
 *
 * This section is what lets a person say "use 128" and have the model resolve it
 * without being told the host. It carries only what a tool call needs — the name,
 * the engine, the default database, and whether writes are allowed — because the
 * section is part of every request and an address is not. It carries no
 * credential: a password is never rendered, and `passwordEnv` is reported as a
 * name only.
 *
 * @module dsh-db-connections/prompt
 */

import { driverInfo } from './drivers/index.js'

/**
 * Describe one connection in the form the model reads.
 * @param {object} connection - the normalized connection.
 * @returns {string} one bullet line.
 */
function describe(connection) {
  const info = driverInfo(connection.driver)
  const parts = [info?.label ?? connection.driver]
  if (connection.database !== undefined) {
    parts.push(`default ${connection.driver === 'postgres' ? 'schema' : 'database'} \`${connection.database}\``)
  }
  parts.push(connection.allowWrite ? 'writes allowed' : 'read-only')
  const detail = connection.description === undefined ? '' : ` — ${connection.description}`
  return `- \`${connection.name}\` (${parts.join(', ')})${detail}`
}

/**
 * Render the whole section. An empty connection list renders an empty string,
 * which the prompt registry drops, so a deployment with no connections adds no
 * prompt cost.
 * @param {object[]} connections - the configured connections.
 * @returns {string} the section text.
 */
export function renderConnections(connections) {
  if (connections.length === 0) return ''
  const names = connections.map(connection => `\`${connection.name}\``).join(', ')
  const writable = connections.filter(connection => connection.allowWrite && connection.unavailable === undefined)
  const notes = [...new Set(connections
    .map(connection => driverInfo(connection.driver))
    .filter(info => info !== undefined && info.promptNotes.length > 0)
    .flatMap(info => info.promptNotes))]
  const lines = [
    '## Database connections',
    '',
    'These named database connections are configured in this deployment. When the user refers to a database by one of these names, pass that exact `connection` value to a tool instead of asking for a host or credentials.',
    '',
    ...connections.map(describe),
  ]

  const unusable = connections.filter(connection => connection.unavailable !== undefined)
  if (unusable.length > 0) {
    lines.push(
      '',
      'These configured connections are NOT usable in this environment — say so instead of retrying them:',
      ...unusable.map(connection => `- \`${connection.name}\`: ${connection.unavailable}`),
    )
  }
  if (notes.length > 0) {
    lines.push('', ...notes.map(note => `- ${note}`))
  }
  lines.push(
    '',
    'Use `db_query` to read. It refuses every statement it cannot classify as a read, and on MySQL and PostgreSQL the server additionally refuses a write inside the read-only transaction the plugin opens. Use `db_schema` to list schemas, tables, columns, indexes, and DDL before writing SQL against an unfamiliar schema'
    + (writable.length === 0
      // Saying the write tool exists but cannot be used would waste a call.
      ? '. No connection here allows writes, so `db_execute` is not available.'
      : `, and \`db_execute\` to change data on a connection marked "writes allowed" (${writable.map(connection => `\`${connection.name}\``).join(', ')}).`),
  )
  if (names !== '') lines.push(`Configured connection names: ${names}.`)
  return lines.join('\n')
}

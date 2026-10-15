/**
 * Model-facing prompt text describing the configured connections.
 *
 * This section is what lets a person say "use 128" and have the model resolve it
 * without being told the host. It is the only place connection facts reach the
 * model, so it deliberately carries no credential: a password is never rendered,
 * and `passwordEnv` is reported as a name only.
 *
 * @module dsh-db-connections/prompt
 */

/**
 * Describe one connection in the form the model reads.
 * @param {object} connection - the normalized connection.
 * @returns {string} one bullet line.
 */
function describe(connection) {
  const parts = [`${connection.host}:${connection.port}`]
  if (connection.database !== undefined) parts.push(`default schema \`${connection.database}\``)
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
  const writable = connections.filter(connection => connection.allowWrite)
  return [
    '## Database connections',
    '',
    'These named database connections are configured in this deployment. When the user refers to a database by one of these names, use the tool with that exact `connection` value instead of asking for host or credentials.',
    '',
    ...connections.map(describe),
    '',
    'Use `db_query` to read (it runs every statement in a server-enforced read-only transaction), `db_schema` to list schemas, tables, columns, indexes, and DDL before writing SQL against an unfamiliar schema'
    + (writable.length === 0
      // Saying the write tool exists but cannot be used would waste a call.
      ? '. No connection here allows writes, so `db_execute` is not available.'
      : `, and \`db_execute\` to change data on a connection marked "writes allowed" (${writable.map(connection => `\`${connection.name}\``).join(', ')}).`),
    `Configured connection names: ${names}.`,
  ].join('\n')
}

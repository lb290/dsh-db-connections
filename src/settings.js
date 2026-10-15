/**
 * Projections between the stored connection list and the settings page.
 *
 * Both rules here exist because the page must never receive a stored password,
 * yet must be able to leave one alone:
 *
 * 1. {@link redactConnections} removes every `password` and reports only whether
 *    one is set and where it comes from. A same-origin GET can therefore no
 *    longer hand a caller the credentials of every configured database. (CORS
 *    hides the response from another origin, but any local process can call the
 *    route, and the value should not be in the response to begin with.)
 * 2. {@link mergePasswords} treats a missing `password` field as "keep what is
 *    stored", so a page that never saw the value cannot delete it. An explicit
 *    value — including the empty string that the page sends when the user clears
 *    the field — always wins.
 *
 * @module dsh-db-connections/settings
 */

/** Whether one entry is a mapping the projections can handle. */
function isEntry(value) {
  return value !== null && typeof value === 'object' && Array.isArray(value) === false
}

/**
 * Remove every credential from a raw connection list.
 * @param {object[]} raw - the raw stored entries.
 * @returns {object[]} the entries, with `password` replaced by `passwordSet` and `passwordSource`.
 */
export function redactConnections(raw = []) {
  return raw.map(entry => {
    if (isEntry(entry) === false) return entry
    const { password, ...rest } = entry
    const passwordEnv = typeof entry.passwordEnv === 'string' && entry.passwordEnv !== '' ? entry.passwordEnv : undefined
    const hasPlaintext = typeof password === 'string' && password !== ''
    return {
      ...rest,
      passwordSet: hasPlaintext || passwordEnv !== undefined,
      passwordSource: passwordEnv === undefined ? (hasPlaintext ? 'plain' : 'none') : 'env',
    }
  })
}

/**
 * Carry stored credentials into a list that omits them.
 *
 * The page sends no `password` for an entry it did not touch, and no
 * `passwordEnv` for one whose indirection it did not edit. Both are inherited
 * from the stored entry with the same name, so a save from the page cannot
 * silently empty a password or drop a `passwordEnv` reference.
 * @param {object[]} incoming - the entries the page sent.
 * @param {object[]} stored - the raw stored entries.
 * @returns {object[]} the entries to validate and persist.
 */
export function mergePasswords(incoming = [], stored = []) {
  const byName = new Map()
  for (const entry of stored) {
    if (isEntry(entry) && typeof entry.name === 'string') byName.set(entry.name, entry)
  }
  return incoming.map(entry => {
    if (isEntry(entry) === false) return entry
    const previous = byName.get(entry.name)
    if (previous === undefined) return entry
    if (entry.password !== undefined) {
      // An explicit password replaces the stored one, so the stored
      // `passwordEnv` must not keep shadowing it.
      if (typeof entry.passwordEnv === 'string' && entry.passwordEnv !== '') return entry
      const { passwordEnv: _dropped, ...rest } = entry
      return rest
    }
    const carried = {}
    if (typeof previous.password === 'string' && previous.password !== '') carried.password = previous.password
    if (entry.passwordEnv === undefined && typeof previous.passwordEnv === 'string') carried.passwordEnv = previous.passwordEnv
    return { ...entry, ...carried }
  })
}

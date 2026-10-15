/**
 * Plugin configuration normalization and validation.
 *
 * The plugin declares no Schemastery `Config` export on purpose: config
 * validation is self-contained here so the plugin has no build-time dependency
 * on the harness packages and can be loaded from any path.
 *
 * Two failure classes are separated deliberately:
 *
 * 1. A self-contained mistake — a missing name, host, or user, an unknown
 *    driver, a duplicate name, a wrong type — throws at load, per the harness
 *    convention.
 * 2. A `passwordEnv` reference that this machine does not set is not a mistake
 *    in the file; it is the normal consequence of a per-machine environment.
 *    Such a connection is reported as unavailable instead of failing the load,
 *    because a thrown error would also remove the settings page that is the only
 *    place to see and fix it.
 *
 * @module dsh-db-connections/config
 */

/** Driver ids this plugin can actually open a connection with. */
export const SUPPORTED_DRIVERS = Object.freeze(['mysql', 'doris', 'postgres', 'tdengine'])

/** Upper bound for a connection name; keeps prompt lines and tool args sane. */
const NAME_MAX_LENGTH = 64

/**
 * Per-driver defaults. A time-series database answers a bare `SELECT` with
 * everything it has, so TDengine's default row cap is far lower than SQL's.
 */
export const DRIVER_DEFAULTS = Object.freeze({
  mysql: Object.freeze({ port: 3306, maxRows: 200 }),
  doris: Object.freeze({ port: 9030, maxRows: 200 }),
  postgres: Object.freeze({ port: 5432, maxRows: 200 }),
  tdengine: Object.freeze({ port: 6041, maxRows: 50 }),
})

/** Config defaults shared by every connection unless overridden per entry. */
export const DEFAULTS = Object.freeze({
  driver: 'mysql',
  connectTimeoutMs: 10_000,
  queryTimeoutMs: 30_000,
  maxRows: 200,
  maxCellChars: 500,
  maxDdlChars: 20_000,
  maxResultChars: 32_000,
  connectionLimit: 4,
  allowWrite: false,
  ssl: false,
})

/** TLS options accepted in the `ssl` mapping, passed through to the driver. */
const SSL_OPTIONS = Object.freeze(['ca', 'cert', 'key', 'pfx', 'passphrase', 'servername', 'rejectUnauthorized'])

/** Raised for any configuration the plugin refuses to load with. */
export class ConfigError extends Error {
  /**
   * @param {string} message - what is wrong and what is accepted.
   */
  constructor(message) {
    super(message)
    this.name = 'ConfigError'
  }
}

/**
 * Read one optional positive integer.
 * @param {unknown} value - configured value.
 * @param {number} fallback - value used when absent.
 * @param {string} label - dotted path used in the error message.
 * @returns {number} the validated integer.
 */
function positiveInt(value, fallback, label) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`${label} must be a positive integer, received ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Read one optional string.
 * @param {unknown} value - configured value.
 * @param {string | undefined} fallback - value used when absent.
 * @param {string} label - dotted path used in the error message.
 * @returns {string | undefined} the validated string.
 */
function optionalString(value, fallback, label) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string') {
    throw new ConfigError(`${label} must be a string, received ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Read one required non-empty string.
 * @param {unknown} value - configured value.
 * @param {string} label - dotted path used in the error message.
 * @returns {string} the validated string.
 */
function requiredString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ConfigError(`${label} is required and must be a non-empty string`)
  }
  return value.trim()
}

/**
 * Validate one connection name: non-empty, single-line, and short enough to be
 * written in a prompt line.
 * @param {unknown} value - configured name.
 * @param {number} index - position in the configured list, for the error message.
 * @returns {string} the validated name.
 */
function connectionName(value, index) {
  const name = requiredString(value, `connections[${index}].name`)
  if (name.length > NAME_MAX_LENGTH) {
    throw new ConfigError(`connections[${index}].name must be at most ${NAME_MAX_LENGTH} characters`)
  }
  if (/[\r\n\t]/u.test(name)) {
    throw new ConfigError(`connections[${index}].name must not contain control characters`)
  }
  return name
}

/**
 * Normalize the `ssl` setting.
 *
 * A boolean is the common case; a mapping carries TLS material for a server
 * whose certificate is not in the system trust store, which a self-signed
 * internal deployment needs.
 * @param {unknown} value - configured value.
 * @param {string} label - dotted path used in the error message.
 * @returns {false | true | Record<string, string | boolean>} the normalized setting.
 */
function normalizeSsl(value, label) {
  if (value === undefined || value === null || value === false) return false
  if (value === true) return true
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError(`${label} must be a boolean or a mapping, received ${JSON.stringify(value)}`)
  }
  const resolved = {}
  for (const [key, entry] of Object.entries(value)) {
    if (SSL_OPTIONS.includes(key) === false) {
      throw new ConfigError(`${label}.${key} is not a recognized TLS option; accepted: ${SSL_OPTIONS.join(', ')}`)
    }
    if (key === 'rejectUnauthorized') {
      if (typeof entry !== 'boolean') throw new ConfigError(`${label}.rejectUnauthorized must be a boolean`)
    } else if (typeof entry !== 'string') {
      throw new ConfigError(`${label}.${key} must be a string (PEM text or a file path)`)
    }
    resolved[key] = entry
  }
  return resolved
}

/**
 * Resolve one connection's password, honouring the `passwordEnv` indirection.
 *
 * A missing environment variable is reported rather than thrown: it is a fact
 * about this machine, not a defect in the configuration file.
 * @param {Record<string, unknown>} raw - the raw connection entry.
 * @param {string} label - dotted path used in the error message.
 * @param {NodeJS.ProcessEnv} env - environment to resolve `passwordEnv` against.
 * @returns {{ password: string, passwordEnv: string | undefined, unavailable: string | undefined }} the resolution.
 */
function resolvePassword(raw, label, env) {
  const configured = optionalString(raw.passwordEnv, undefined, `${label}.passwordEnv`)
  // An empty string is how the settings page says "no environment indirection",
  // so it means the same as leaving the field out.
  const passwordEnv = configured === '' ? undefined : configured
  if (passwordEnv === undefined) {
    return { password: optionalString(raw.password, '', `${label}.password`) ?? '', passwordEnv, unavailable: undefined }
  }
  const fromEnv = env[passwordEnv]
  if (fromEnv === undefined) {
    return {
      password: '',
      passwordEnv,
      unavailable: `${label}.passwordEnv names ${JSON.stringify(passwordEnv)}, which is not set in the environment`,
    }
  }
  return { password: fromEnv, passwordEnv, unavailable: undefined }
}

/**
 * Validate and normalize one raw connection entry.
 * @param {unknown} raw - the configured entry.
 * @param {number} index - position in the configured list.
 * @param {NodeJS.ProcessEnv} env - environment for `passwordEnv` resolution.
 * @returns {object} the normalized connection.
 */
function normalizeConnection(raw, index, env) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`connections[${index}] must be a mapping, received ${JSON.stringify(raw)}`)
  }
  const label = `connections[${index}]`
  const name = connectionName(raw.name, index)

  const driver = optionalString(raw.driver, DEFAULTS.driver, `${label}.driver`)
  if (SUPPORTED_DRIVERS.includes(driver) === false) {
    throw new ConfigError(`${label}.driver ${JSON.stringify(driver)} is not supported; supported drivers: ${SUPPORTED_DRIVERS.join(', ')}`)
  }
  const driverDefaults = DRIVER_DEFAULTS[driver]

  const host = requiredString(raw.host, `${label}.host`)
  const port = positiveInt(raw.port, driverDefaults.port, `${label}.port`)
  if (port > 65_535) {
    throw new ConfigError(`${label}.port must be at most 65535, received ${port}`)
  }

  const user = requiredString(raw.user, `${label}.user`)

  const allowWrite = raw.allowWrite ?? DEFAULTS.allowWrite
  if (typeof allowWrite !== 'boolean') {
    throw new ConfigError(`${label}.allowWrite must be a boolean, received ${JSON.stringify(raw.allowWrite)}`)
  }

  const credentials = resolvePassword(raw, label, env)

  return {
    name,
    driver,
    host,
    port,
    user,
    password: credentials.password,
    passwordEnv: credentials.passwordEnv,
    unavailable: credentials.unavailable,
    database: optionalString(raw.database, undefined, `${label}.database`),
    description: optionalString(raw.description, undefined, `${label}.description`),
    allowWrite,
    ssl: normalizeSsl(raw.ssl ?? DEFAULTS.ssl, `${label}.ssl`),
    connectTimeoutMs: positiveInt(raw.connectTimeoutMs, DEFAULTS.connectTimeoutMs, `${label}.connectTimeoutMs`),
    queryTimeoutMs: positiveInt(raw.queryTimeoutMs, DEFAULTS.queryTimeoutMs, `${label}.queryTimeoutMs`),
    maxRows: positiveInt(raw.maxRows, driverDefaults.maxRows, `${label}.maxRows`),
    maxCellChars: positiveInt(raw.maxCellChars, DEFAULTS.maxCellChars, `${label}.maxCellChars`),
    maxDdlChars: positiveInt(raw.maxDdlChars, DEFAULTS.maxDdlChars, `${label}.maxDdlChars`),
    maxResultChars: positiveInt(raw.maxResultChars, DEFAULTS.maxResultChars, `${label}.maxResultChars`),
    connectionLimit: positiveInt(raw.connectionLimit, DEFAULTS.connectionLimit, `${label}.connectionLimit`),
  }
}

/**
 * Validate the plugin config and return normalized connections in order.
 * @param {unknown} raw - the `config` block from the loader row.
 * @param {NodeJS.ProcessEnv} [env] - environment for `passwordEnv` resolution.
 * @returns {{ connections: object[], problems: { connection: string, message: string }[] }} the
 *   normalized connections, plus one entry per connection that this environment
 *   leaves unusable.
 */
export function resolveConnections(raw, env = process.env) {
  const config = raw ?? {}
  if (typeof config !== 'object' || Array.isArray(config)) {
    throw new ConfigError(`config must be a mapping, received ${JSON.stringify(raw)}`)
  }
  const list = config.connections ?? []
  if (!Array.isArray(list)) {
    throw new ConfigError(`config.connections must be a list, received ${JSON.stringify(config.connections)}`)
  }
  const seen = new Set()
  const connections = []
  const problems = []
  list.forEach((entry, index) => {
    const connection = normalizeConnection(entry, index, env)
    if (seen.has(connection.name)) {
      throw new ConfigError(`duplicate connection name ${JSON.stringify(connection.name)}: names address one connection in chat and must be unique`)
    }
    seen.add(connection.name)
    if (connection.unavailable !== undefined) {
      problems.push({ connection: connection.name, message: connection.unavailable })
    }
    connections.push(connection)
  })
  return { connections, problems }
}

/**
 * Normalize one connection list outside a config block.
 * @param {unknown} list - the raw `connections` value.
 * @param {NodeJS.ProcessEnv} [env] - environment for `passwordEnv` resolution.
 * @returns {{ connections: object[], problems: { connection: string, message: string }[] }} the resolution.
 */
export function resolveConnectionList(list, env = process.env) {
  return resolveConnections({ connections: list }, env)
}

/**
 * Plugin configuration normalization and validation.
 *
 * The plugin declares no Schemastery `Config` export on purpose: config
 * validation is self-contained here so the plugin has no build-time dependency
 * on the harness packages and can be loaded from any path. Misconfiguration
 * fails loud at load, per the harness convention.
 *
 * @module dsh-db-connections/config
 */

/** Driver ids this plugin can actually open a connection with. */
export const SUPPORTED_DRIVERS = Object.freeze(['mysql'])

/** Upper bound for a connection name; keeps prompt lines and tool args sane. */
const NAME_MAX_LENGTH = 64

/** Default TCP port per driver. */
const DEFAULT_PORTS = Object.freeze({ mysql: 3306 })

/** Config defaults shared by every connection unless overridden per entry. */
export const DEFAULTS = Object.freeze({
  driver: 'mysql',
  connectTimeoutMs: 10_000,
  queryTimeoutMs: 30_000,
  maxRows: 200,
  maxCellChars: 500,
  maxDdlChars: 20_000,
  connectionLimit: 4,
  allowWrite: false,
  ssl: false,
})

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
 * Resolve the password for one connection. `passwordEnv` takes precedence so a
 * deployment can keep the secret out of the configuration file entirely.
 * @param {Record<string, unknown>} raw - the raw connection entry.
 * @param {string} label - dotted path used in the error message.
 * @param {NodeJS.ProcessEnv} env - environment to resolve `passwordEnv` against.
 * @returns {string} the resolved password, possibly empty.
 */
function resolvePassword(raw, label, env) {
  const passwordEnv = optionalString(raw.passwordEnv, undefined, `${label}.passwordEnv`)
  if (passwordEnv === undefined) {
    return optionalString(raw.password, '', `${label}.password`) ?? ''
  }
  const fromEnv = env[passwordEnv]
  if (fromEnv === undefined) {
    throw new ConfigError(`${label}.passwordEnv names ${JSON.stringify(passwordEnv)}, which is not set in the environment`)
  }
  return fromEnv
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
  if (!SUPPORTED_DRIVERS.includes(driver)) {
    throw new ConfigError(`${label}.driver ${JSON.stringify(driver)} is not supported; supported drivers: ${SUPPORTED_DRIVERS.join(', ')}`)
  }

  const host = requiredString(raw.host, `${label}.host`)
  const port = positiveInt(raw.port, DEFAULT_PORTS[driver], `${label}.port`)
  if (port > 65_535) {
    throw new ConfigError(`${label}.port must be at most 65535, received ${port}`)
  }

  const user = requiredString(raw.user, `${label}.user`)

  const allowWrite = raw.allowWrite ?? DEFAULTS.allowWrite
  if (typeof allowWrite !== 'boolean') {
    throw new ConfigError(`${label}.allowWrite must be a boolean, received ${JSON.stringify(raw.allowWrite)}`)
  }

  const ssl = raw.ssl ?? DEFAULTS.ssl
  if (typeof ssl !== 'boolean') {
    throw new ConfigError(`${label}.ssl must be a boolean, received ${JSON.stringify(raw.ssl)}`)
  }

  return {
    name,
    driver,
    host,
    port,
    user,
    password: resolvePassword(raw, label, env),
    database: optionalString(raw.database, undefined, `${label}.database`),
    description: optionalString(raw.description, undefined, `${label}.description`),
    allowWrite,
    ssl,
    connectTimeoutMs: positiveInt(raw.connectTimeoutMs, DEFAULTS.connectTimeoutMs, `${label}.connectTimeoutMs`),
    queryTimeoutMs: positiveInt(raw.queryTimeoutMs, DEFAULTS.queryTimeoutMs, `${label}.queryTimeoutMs`),
    maxRows: positiveInt(raw.maxRows, DEFAULTS.maxRows, `${label}.maxRows`),
    maxCellChars: positiveInt(raw.maxCellChars, DEFAULTS.maxCellChars, `${label}.maxCellChars`),
    maxDdlChars: positiveInt(raw.maxDdlChars, DEFAULTS.maxDdlChars, `${label}.maxDdlChars`),
    connectionLimit: positiveInt(raw.connectionLimit, DEFAULTS.connectionLimit, `${label}.connectionLimit`),
  }
}

/**
 * Validate the plugin config and return normalized connections in order.
 * @param {unknown} raw - the `config` block from the loader row.
 * @param {NodeJS.ProcessEnv} [env] - environment for `passwordEnv` resolution.
 * @returns {object[]} normalized connections, in configured order.
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
  const resolved = list.map((entry, index) => {
    const connection = normalizeConnection(entry, index, env)
    if (seen.has(connection.name)) {
      throw new ConfigError(`duplicate connection name ${JSON.stringify(connection.name)}: names address one connection in chat and must be unique`)
    }
    seen.add(connection.name)
    return connection
  })
  return resolved
}

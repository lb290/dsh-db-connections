/**
 * Shared prerequisites for the suites that need more than Node.
 *
 * A suite that cannot run here prints `SKIP` and exits 0, so a missing
 * prerequisite is visible in the run summary instead of looking like a defect.
 * The runner (`run-tests.mjs`) reads that marker.
 */
import net from 'node:net'

/**
 * Report a missing prerequisite and stop this suite successfully.
 * @param {string} reason - what is missing and how to provide it.
 * @returns {never} never returns.
 */
export function skip(reason) {
  console.log(`SKIP  ${reason}`)
  process.exit(0)
}

/**
 * Wait until a condition holds, polling instead of sleeping a fixed time.
 *
 * A suite that sleeps a fixed 60 ms and then asserts on an asynchronous file
 * append passes on an idle machine and fails on a loaded one. Polling to a
 * deadline keeps the assertion honest and makes the suite deterministic.
 * @param {() => boolean | Promise<boolean>} predicate - the condition to wait for.
 * @param {{ timeoutMs?: number, intervalMs?: number, label?: string }} [options] - the wait budget.
 * @returns {Promise<boolean>} whether the condition held before the deadline.
 */
export async function waitFor(predicate, options = {}) {
  const { timeoutMs = 5000, intervalMs = 20, label = 'condition' } = options
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return true
    if (Date.now() >= deadline) {
      console.log(`      (waited ${timeoutMs} ms for ${label})`)
      return false
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
}

/**
 * Check whether something is listening on a TCP port.
 * @param {string} host - hostname or address.
 * @param {number} port - TCP port.
 * @param {number} [timeoutMs] - how long to wait for the connection.
 * @returns {Promise<boolean>} whether the connection was accepted.
 */
export function reachable(host, port, timeoutMs = 1500) {
  return new Promise(resolve => {
    const socket = net.connect({ host, port })
    const settle = value => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => settle(true))
    socket.once('timeout', () => settle(false))
    socket.once('error', () => settle(false))
  })
}

/**
 * Require a reachable MySQL for the suites that drive real SQL.
 * @param {NodeJS.ProcessEnv} [env] - environment to read the connection from.
 * @returns {Promise<{ host: string, port: number, user: string, password: string, database: string }>} the target.
 */
export async function requireMysql(env = process.env) {
  const host = env.DB_TEST_HOST ?? '127.0.0.1'
  const port = Number(env.DB_TEST_PORT ?? 3306)
  if (await reachable(host, port) === false) {
    skip(`no MySQL at ${host}:${port}; start one and set DB_TEST_HOST/DB_TEST_PORT/DB_TEST_USER/DB_TEST_PASSWORD/DB_TEST_DATABASE to run this suite`)
  }
  return {
    host,
    port,
    user: env.DB_TEST_USER ?? 'root',
    password: env.DB_TEST_PASSWORD ?? '',
    database: env.DB_TEST_DATABASE ?? 'test',
  }
}

/**
 * Load one module from the harness's own `@deepseek-ai` directory.
 *
 * `DSH_RUNTIME_MODULES` must point at a directory in which each harness package
 * has its built `lib/`, which is how the desktop install ships them.
 * @param {string} name - the package directory name, such as `dsh-tools`.
 * @returns {Promise<object>} the imported module namespace.
 */
export async function requireHarness(name) {
  const runtime = process.env.DSH_RUNTIME_MODULES
  if (typeof runtime !== 'string' || runtime.trim() === '') {
    skip('DSH_RUNTIME_MODULES is not set; point it at the harness @deepseek-ai directory to run this suite')
  }
  try {
    return await import(`${runtime.replace(/\/$/u, '')}/${name}/lib/index.js`)
  } catch (error) {
    skip(`cannot import ${name} from DSH_RUNTIME_MODULES (${error.message})`)
  }
}

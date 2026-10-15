/**
 * Live connection holder.
 *
 * The settings page can change connections while the plugin is running, so
 * nothing may capture the connection list at load time. The prompt section and
 * the tools all read through this holder, and a save swaps the registry in
 * place: the next tool call and the next prompt assembly both see the new list
 * without unloading the plugin.
 *
 * The holder also carries the problems the current environment produces (a
 * `passwordEnv` this machine does not set), because a prompt that silently omits
 * a connection the user configured is worse than one that names the reason.
 *
 * @module dsh-db-connections/live
 */

import { resolveConnectionList } from './config.js'
import { ConnectionRegistry } from './registry.js'

/** Owns the current connections, their problems, and their drivers. */
export class LiveConnections {
  /** @type {ConnectionRegistry} */
  #registry
  /** @type {object[]} */
  #connections
  /** @type {{ connection: string, message: string }[]} */
  #problems
  /** @type {{ audit?: { record: (entry: object) => void } }} */
  #options

  /**
   * @param {{ connections: object[], problems: { connection: string, message: string }[] }} resolved - the initial resolution.
   * @param {{ audit?: { record: (entry: object) => void }, createDriver?: (connection: object) => object }} [options] - collaborators shared by every registry.
   */
  constructor(resolved, options = {}) {
    this.#connections = resolved.connections
    this.#problems = resolved.problems
    this.#options = options
    this.#registry = new ConnectionRegistry(resolved.connections, options)
  }

  /** @returns {object[]} the current normalized connections. */
  get connections() {
    return this.#connections
  }

  /** @returns {{ connection: string, message: string }[]} this environment's problems. */
  get problems() {
    return this.#problems
  }

  /** @returns {ConnectionRegistry} the registry serving the current connections. */
  get registry() {
    return this.#registry
  }

  /**
   * Replace the live connections, closing the previous registry's drivers.
   * Driver creation is lazy, so this costs nothing for connections never used.
   * @param {{ connections: object[], problems: { connection: string, message: string }[] }} resolved - the new resolution.
   * @returns {Promise<void>} resolves once the previous registry has released its resources.
   */
  async swap(resolved) {
    const previous = this.#registry
    this.#connections = resolved.connections
    this.#problems = resolved.problems
    this.#registry = new ConnectionRegistry(resolved.connections, this.#options)
    await previous.dispose()
  }

  /**
   * Close the live registry's drivers.
   * @returns {Promise<void>} resolves once every driver has been released.
   */
  dispose() {
    return this.#registry.dispose()
  }
}

/**
 * Validate a raw connection list into a resolution.
 * @param {unknown} raw - the raw `connections` list.
 * @param {NodeJS.ProcessEnv} [env] - environment for `passwordEnv` resolution.
 * @returns {{ connections: object[], problems: { connection: string, message: string }[] }} the resolution.
 */
export function normalize(raw, env = process.env) {
  return resolveConnectionList(raw, env)
}

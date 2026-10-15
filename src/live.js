/**
 * Live connection holder.
 *
 * The settings page can change connections while the plugin is running, so
 * nothing may capture the connection list at load time. The prompt section and
 * the tools all read through this holder, and a save swaps the registry in
 * place: the next tool call and the next prompt assembly both see the new list
 * without unloading the plugin.
 *
 * @module dsh-db-connections/live
 */

import { resolveConnections } from './config.js'
import { ConnectionRegistry } from './registry.js'

/** Owns the current connections and their pools. */
export class LiveConnections {
  /** @type {ConnectionRegistry} */
  #registry
  /** @type {object[]} */
  #connections

  /**
   * @param {object[]} connections - normalized connections to start with.
   */
  constructor(connections) {
    this.#connections = connections
    this.#registry = new ConnectionRegistry(connections)
  }

  /** @returns {object[]} the current normalized connections. */
  get connections() {
    return this.#connections
  }

  /** @returns {ConnectionRegistry} the registry serving the current connections. */
  get registry() {
    return this.#registry
  }

  /**
   * Replace the live connections, closing the previous registry's pools.
   * Pool creation is lazy, so this costs nothing for connections never used.
   * @param {object[]} connections - the new normalized connections.
   */
  swap(connections) {
    const previous = this.#registry
    this.#connections = connections
    this.#registry = new ConnectionRegistry(connections)
    previous.dispose()
  }

  /** Close the live registry's pools. */
  dispose() {
    this.#registry.dispose()
  }
}

/**
 * Validate a raw connection list into normalized connections.
 *
 * Shared by the loader path and the settings API so a saved list is validated by
 * exactly the same rules the loader applies at boot.
 * @param {unknown} raw - the raw `connections` list.
 * @param {NodeJS.ProcessEnv} [env] - environment for `passwordEnv` resolution.
 * @returns {object[]} normalized connections.
 */
export function normalize(raw, env = process.env) {
  return resolveConnections({ connections: raw }, env)
}

/**
 * Durable connection storage.
 *
 * The profile's `cordis.patch.yml` is the single source of truth: the same file
 * the loader reads at boot, the file this store writes, and the file a person
 * can edit by hand between sessions. Nothing is duplicated into a plugin-private
 * JSON file, so there is no second copy to reconcile.
 *
 * Writes go through a temporary file and a rename, and parse/update/serialize
 * rather than re-emit, so every other row and every comment in the file survives
 * an edit made through the settings page.
 *
 * @module dsh-db-connections/store
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'

/** Loader row id this plugin owns in the profile patch. */
export const ROW_ID = 'db-connections'

/** Package name the row mounts. */
const ROW_NAME = 'dsh-db-connections'

/** Resolve the harness home the same way the harness's own home-paths helper does. */
function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return path.join(os.homedir(), '.dsh')
}

/**
 * Resolve the directory of the profile that is running this plugin.
 *
 * `DSH_PROFILE_DIR` is authoritative when present. Otherwise the home and the
 * active profile name are combined, which is the same layout the CLI uses.
 * @returns {string} absolute profile directory.
 */
export function resolveProfileDir() {
  const explicit = process.env.DSH_PROFILE_DIR
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim()
  const name = typeof process.env.DSH_PROFILE === 'string' && process.env.DSH_PROFILE.trim() !== ''
    ? process.env.DSH_PROFILE.trim()
    : 'desktop'
  return path.join(resolveDshHome(), 'profiles', name)
}

/** Raised when the patch file exists but cannot be used. */
export class StoreError extends Error {
  /**
   * @param {string} message - what is wrong and what to do about it.
   */
  constructor(message) {
    super(message)
    this.name = 'StoreError'
  }
}

/** Reads and writes the plugin's row in one profile patch file. */
export class ConnectionStore {
  /** @type {string} */
  #file

  /**
   * @param {string} [profileDir] - profile directory; resolved from the environment when omitted.
   */
  constructor(profileDir = resolveProfileDir()) {
    this.#file = path.join(profileDir, 'cordis.patch.yml')
  }

  /** @returns {string} the absolute patch file path. */
  get file() {
    return this.#file
  }

  /**
   * Read the complete patch document.
   * @returns {import('yaml').Document.Parsed} the parsed document.
   */
  #read() {
    if (!fs.existsSync(this.#file)) {
      throw new StoreError(`the profile patch file does not exist: ${this.#file}`)
    }
    const text = fs.readFileSync(this.#file, 'utf8')
    const document = YAML.parseDocument(text, { keepSourceTokens: true })
    if (document.errors.length > 0) {
      throw new StoreError(`the profile patch file is not valid YAML: ${this.#file} (${document.errors[0].message})`)
    }
    if (!YAML.isSeq(document.contents)) {
      throw new StoreError(`the profile patch file must be a top-level YAML list of loader entries: ${this.#file}`)
    }
    return document
  }

  /**
   * Find the plugin's row, if the profile already has one.
   * @param {import('yaml').Document.Parsed} document - the parsed patch.
   * @returns {import('yaml').Node | undefined} the row node.
   */
  #row(document) {
    return document.contents.items.find(item => YAML.isMap(item) && item.get('id') === ROW_ID)
  }

  /**
   * Read the configured connections as raw entries.
   *
   * An absent row means the plugin is running from a different patch layer; the
   * row's own config is read first, then the value the plugin was mounted with,
   * so a deployment whose row lives elsewhere still reports what it uses — and
   * a `passwordEnv` indirection survives as written rather than being flattened
   * into the resolved plaintext password.
   * @param {object[]} [mounted] - raw connections the plugin was mounted with.
   * @returns {object[]} the raw connection entries.
   */
  load(mounted = []) {
    const document = this.#read()
    const row = this.#row(document)
    if (row === undefined) return mounted
    const config = row.get('config')
    const connections = YAML.isMap(config) ? config.get('connections') : undefined
    if (connections === undefined || connections === null) return []
    const plain = typeof connections.toJSON === 'function' ? connections.toJSON() : connections
    if (!Array.isArray(plain)) {
      throw new StoreError(`the ${ROW_ID} row sets config.connections to something other than a list: ${this.#file}`)
    }
    return plain
  }

  /**
   * Replace the plugin's connection list, creating the row when the profile has
   * none. Every other row and comment in the file is preserved.
   * @param {object[]} connections - the raw entries to persist.
   */
  save(connections) {
    const document = this.#read()
    const row = this.#row(document)
    const value = document.createNode(connections)
    if (row === undefined) {
      document.contents.add(document.createNode({ id: ROW_ID, name: ROW_NAME, config: { connections } }))
    } else {
      const config = row.get('config', true)
      if (YAML.isMap(config)) config.set('connections', value)
      else row.set('config', document.createNode({ connections }))
    }
    const text = String(document)
    const temporary = `${this.#file}.${process.pid}.tmp`
    fs.writeFileSync(temporary, text, 'utf8')
    fs.renameSync(temporary, this.#file)
  }
}

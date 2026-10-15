/**
 * Durable connection storage.
 *
 * The profile's `cordis.patch.yml` is the single source of truth: the same file
 * the loader reads at boot, the file this store writes, and the file a person
 * can edit by hand between sessions. Nothing is duplicated into a plugin-private
 * JSON file, so there is no second copy to reconcile.
 *
 * Two properties matter beyond round-tripping the list:
 *
 * 1. **This file holds credentials.** The temporary file is created with mode
 *    `0600`, and because the write is a rename, the patch file keeps that mode —
 *    a file that was world-readable becomes owner-only on the first save from the
 *    settings page.
 * 2. **Other writers exist.** `dsh plugin add` and other plugins edit the same
 *    file. A caller that read the file can pass the revision it read, and a save
 *    that finds a different revision is refused instead of silently discarding
 *    whatever arrived in between.
 *
 * Writes go through a temporary file and a rename, and parse/update/serialize
 * rather than re-emit, so every other row and every comment in the file survives
 * an edit made through the settings page.
 *
 * @module dsh-db-connections/store
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'

/** Loader row id this plugin owns in the profile patch. */
export const ROW_ID = 'db-connections'

/** Package name the row mounts. */
const ROW_NAME = 'dsh-db-connections'

/** Mode for every file this store creates or replaces: owner read and write only. */
const FILE_MODE = 0o600

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

/** Raised when the patch file changed between a read and the save derived from it. */
export class StoreConflictError extends Error {
  /**
   * @param {string} file - the patch file that changed.
   */
  constructor(file) {
    super(`the profile patch file changed since it was read (${file}); something else — the dsh CLI or another plugin — edited it in between. Reload the settings page and apply the change again.`)
    this.name = 'StoreConflictError'
  }
}

/**
 * Compute the revision of one patch file's contents.
 * @param {string} text - the file's text.
 * @returns {string} a stable short digest.
 */
export function revisionOf(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
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
   * Read the complete patch document together with its revision.
   * @returns {{ document: import('yaml').Document.Parsed, revision: string }} the parsed
   *   document and the revision of the text it came from.
   */
  #readWithRevision() {
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
    return { document, revision: revisionOf(text) }
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
   * Read the configured connections as raw entries, plus the file's revision.
   *
   * An absent row means the plugin is running from a different patch layer; the
   * row's own config is read first, then the value the plugin was mounted with,
   * so a deployment whose row lives elsewhere still reports what it uses — and
   * a `passwordEnv` indirection survives as written rather than being flattened
   * into the resolved plaintext password.
   * @param {object[]} [mounted] - raw connections the plugin was mounted with.
   * @returns {{ connections: object[], revision: string }} the raw entries and the revision.
   */
  read(mounted = []) {
    const { document, revision } = this.#readWithRevision()
    const row = this.#row(document)
    if (row === undefined) return { connections: mounted, revision }
    const config = row.get('config')
    const connections = YAML.isMap(config) ? config.get('connections') : undefined
    if (connections === undefined || connections === null) return { connections: [], revision }
    const plain = typeof connections.toJSON === 'function' ? connections.toJSON() : connections
    if (!Array.isArray(plain)) {
      throw new StoreError(`the ${ROW_ID} row sets config.connections to something other than a list: ${this.#file}`)
    }
    return { connections: plain, revision }
  }

  /**
   * Read the configured connections as raw entries.
   * @param {object[]} [mounted] - raw connections the plugin was mounted with.
   * @returns {object[]} the raw connection entries.
   */
  load(mounted = []) {
    return this.read(mounted).connections
  }

  /**
   * Replace the plugin's connection list, creating the row when the profile has
   * none. Every other row and comment in the file is preserved.
   * @param {object[]} connections - the raw entries to persist.
   * @param {string} [expectedRevision] - the revision the caller read; a mismatch refuses the save.
   * @throws {StoreConflictError} when the file changed since `expectedRevision` was read.
   */
  save(connections, expectedRevision) {
    const { document, revision } = this.#readWithRevision()
    if (expectedRevision !== undefined && expectedRevision !== revision) {
      throw new StoreConflictError(this.#file)
    }
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
    try {
      fs.writeFileSync(temporary, text, { encoding: 'utf8', mode: FILE_MODE })
      fs.renameSync(temporary, this.#file)
    } catch (error) {
      // The temporary file holds credentials; a failed write must not leave a
      // copy of them behind.
      try {
        fs.unlinkSync(temporary)
      } catch {
        // The write never created it, or it is already gone.
      }
      throw error
    }
  }
}

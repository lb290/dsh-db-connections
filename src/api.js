/**
 * The settings API served to the plugin's own browser half.
 *
 * Routes live under one prefix and are dispatched here, so the browser half has
 * a single place to talk to. Three rules shape every route, because this API
 * reads and writes database credentials:
 *
 * 1. **A response never carries a password.** The stored entries are redacted on
 *    the way out: the page learns whether a credential is set and where it comes
 *    from, never its value. A request that omits `password` therefore means "keep
 *    the stored one", which is what makes the redacted form sufficient.
 * 2. `Content-Type: application/json` is required on writes, and a present
 *    `Origin` must match the request's own `Host`. A cross-origin write is not a
 *    simple request, so a browser must preflight it, and this server answers no
 *    preflight.
 * 3. A write may carry the `revision` it read. When it does and the file has
 *    moved on, the write is refused with 409 rather than overwriting whatever
 *    the CLI or another plugin wrote in between.
 *
 * @module dsh-db-connections/api
 */

import { ConfigError } from './config.js'
import { redactConnections } from './settings.js'
import { StoreConflictError } from './store.js'

/** Longest request body accepted, in bytes. Generous for a connection list. */
const MAX_BODY_BYTES = 256 * 1024

/** Raised for a request this API refuses before touching the store. */
class RequestError extends Error {
  /** @type {number} */
  status

  /**
   * @param {number} status - HTTP status to answer with.
   * @param {string} message - what was wrong.
   */
  constructor(status, message) {
    super(message)
    this.name = 'RequestError'
    this.status = status
  }
}

/**
 * Read and parse a JSON request body.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @returns {Promise<unknown>} the parsed body.
 */
async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new RequestError(413, `request body exceeds ${MAX_BODY_BYTES} bytes`)
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new RequestError(400, 'request body is not valid JSON')
  }
}

/**
 * Whether a request's declared origin matches the host it arrived on.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @returns {boolean} whether the origin is acceptable.
 */
function originAllowed(req) {
  const origin = req.headers.origin
  if (origin === undefined) return true
  const host = req.headers.host
  if (host === undefined) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * Require the JSON content type a browser cannot send cross-origin without a preflight.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @throws {RequestError} when the content type is missing or wrong.
 */
function requireJsonContentType(req) {
  const contentType = String(req.headers['content-type'] ?? '')
  if (contentType.toLowerCase().startsWith('application/json') === false) {
    throw new RequestError(415, 'writes must send Content-Type: application/json')
  }
}

/**
 * Write one JSON response.
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {number} status - HTTP status.
 * @param {unknown} payload - JSON-serializable body.
 */
function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    // The payload carries structure and configuration facts; never let anything cache it.
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * Build the prefix handler for this plugin's API.
 *
 * The handler owns the complete request lifecycle, so it always ends the
 * response — including on a thrown error.
 * @param {object} deps - the collaborators this API drives.
 * @param {() => { connections: object[], revision: string, problems: object[] }} deps.list - raw stored entries, the file revision, and this environment's problems.
 * @param {(connections: object[], revision: string) => Promise<object[]>} deps.replace - validate, persist, and apply a new list.
 * @param {(name: string) => Promise<object>} deps.test - probe one saved connection.
 * @param {() => object[]} deps.drivers - the driver picker's choices.
 * @param {string} deps.file - the patch file path, reported so the UI can show it.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} the handler.
 */
export function createApiHandler({ list, replace, test, drivers, file }) {
  /**
   * The shape both the read and the write answer with.
   * @param {{ connections: object[], revision: string, problems: object[] }} current - one read of the store.
   * @returns {object} the response payload.
   */
  function payload(current) {
    return {
      connections: redactConnections(current.connections),
      revision: current.revision,
      problems: current.problems,
      drivers: drivers(),
      file,
    }
  }

  return async function handle(req, res) {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const route = url.pathname
      const method = req.method ?? 'GET'

      if (originAllowed(req) === false) {
        throw new RequestError(403, 'this API only answers same-origin requests')
      }

      if (route === '/api/db-connections' && method === 'GET') {
        sendJson(res, 200, payload(list()))
        return
      }

      if (route === '/api/db-connections' && method === 'POST') {
        requireJsonContentType(req)
        const body = await readJson(req)
        const connections = body?.connections
        if (!Array.isArray(connections)) {
          throw new RequestError(400, 'the request body must carry a connections list')
        }
        const revision = typeof body?.revision === 'string' && body.revision !== '' ? body.revision : undefined
        await replace(connections, revision)
        // The answer is the state that is now in effect, read back from the store
        // rather than echoed, so the page's next revision is the file's own.
        sendJson(res, 200, payload(list()))
        return
      }

      if (route === '/api/db-connections/test' && method === 'POST') {
        requireJsonContentType(req)
        const body = await readJson(req)
        if (typeof body?.name !== 'string' || body.name === '') {
          throw new RequestError(400, 'the request body must carry a connection name')
        }
        sendJson(res, 200, await test(body.name))
        return
      }

      throw new RequestError(404, `unknown route ${method} ${route}`)
    } catch (error) {
      if (res.headersSent) {
        res.end()
        return
      }
      const status = error instanceof RequestError
        ? error.status
        : error instanceof ConfigError ? 400
          : error instanceof StoreConflictError ? 409
            : 500
      sendJson(res, status, { error: error instanceof Error ? error.message : String(error) })
    }
  }
}

/**
 * The settings API served to the plugin's own browser half.
 *
 * Routes live under one prefix and are dispatched here, so the browser half has
 * a single place to talk to. Two checks guard every mutating request, because
 * this API writes database credentials to disk:
 *
 * 1. `Content-Type: application/json` is required on writes. A cross-origin
 *    `fetch` with that type is not a simple request, so a browser must preflight
 *    it, and this server answers no preflight — a hostile page cannot reach the
 *    write path.
 * 2. A present `Origin` must match the request's own `Host`. A same-origin
 *    request from the settings page always matches.
 *
 * @module dsh-db-connections/api
 */

import { ConfigError } from './config.js'

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
    // The payload carries credentials and schema facts; never let anything cache it.
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
 * @param {() => object[]} deps.list - raw configured connection entries.
 * @param {(connections: object[]) => Promise<object[]>} deps.replace - validate, persist, and apply a new list.
 * @param {(name: string) => Promise<object>} deps.test - probe one saved connection.
 * @param {string} deps.file - the patch file path, reported so the UI can show it.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} the handler.
 */
export function createApiHandler({ list, replace, test, file }) {
  return async function handle(req, res) {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const route = url.pathname
      const method = req.method ?? 'GET'

      if (route === '/api/db-connections' && method === 'GET') {
        sendJson(res, 200, { connections: list(), file })
        return
      }

      if (!originAllowed(req)) {
        throw new RequestError(403, 'this API only answers same-origin requests')
      }

      if (route === '/api/db-connections' && method === 'POST') {
        const contentType = String(req.headers['content-type'] ?? '')
        if (!contentType.toLowerCase().startsWith('application/json')) {
          throw new RequestError(415, 'writes must send Content-Type: application/json')
        }
        const body = await readJson(req)
        const connections = body?.connections
        if (!Array.isArray(connections)) {
          throw new RequestError(400, 'the request body must carry a connections list')
        }
        const saved = await replace(connections)
        sendJson(res, 200, { connections: saved, file })
        return
      }

      if (route === '/api/db-connections/test' && method === 'POST') {
        const contentType = String(req.headers['content-type'] ?? '')
        if (!contentType.toLowerCase().startsWith('application/json')) {
          throw new RequestError(415, 'writes must send Content-Type: application/json')
        }
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
        : error instanceof ConfigError ? 400 : 500
      sendJson(res, status, { error: error instanceof Error ? error.message : String(error) })
    }
  }
}

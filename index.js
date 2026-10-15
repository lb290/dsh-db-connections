/**
 * dsh-db-connections — named database connections for DeepSeek Harness.
 *
 * A deployment lists its databases, each with a short name. This plugin then
 * contributes three things on that basis:
 *
 * 1. A system-prompt section naming every connection, so "use 128" resolves
 *    without the user restating the host or credentials. The section never
 *    contains a password.
 * 2. `db_query`, `db_execute`, and `db_schema` tools that take one of those
 *    names as their `connection` argument.
 * 3. A settings page, served over the plugin's own HTTP routes, that edits the
 *    same connection list and applies it without a restart.
 *
 * The connection list is therefore live rather than captured at load: the
 * prompt section is a function of the current list, the tools read the current
 * registry, and a save from the settings page swaps both.
 *
 * Services are injected rather than required: a composition without
 * `systemPrompt` still gets the tools, one without `tools` still gets the page,
 * and one without `webServer` still gets both the prompt and the tools. With no
 * connections configured, the prompt section renders empty and the tools refuse
 * with a message naming the settings page.
 *
 * @module dsh-db-connections
 */

import { resolveConnections } from './src/config.js'
import { createApiHandler } from './src/api.js'
import { LiveConnections } from './src/live.js'
import { renderConnections } from './src/prompt.js'
import { ConnectionStore } from './src/store.js'
import { executeTool, queryTool, schemaTool } from './src/tools.js'

export const name = 'dsh-db-connections'

/**
 * Prompt order. The harness convention is `-100` identity, `0` persona, and
 * `100–199` for tool guidance; these connection facts are guidance for the
 * tools above, so they sit in that band, ahead of the generic tool text.
 */
export const CONNECTIONS_SECTION = 'db-connections:connections'
const CONNECTIONS_ORDER = 150

/**
 * Load the configured connections and publish the prompt section, the tools,
 * and the settings API.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {unknown} config - the raw `config` block from the loader row.
 */
export function apply(ctx, config) {
  // A malformed row must fail at load, not on the first tool call.
  const mounted = resolveConnections(config)
  // The raw entries are kept alongside the normalized ones: the settings page
  // edits raw configuration, so a `passwordEnv` indirection must survive a save
  // instead of being flattened into the resolved plaintext password.
  const mountedRaw = Array.isArray(config?.connections) ? config.connections : []
  const store = new ConnectionStore()
  const live = new LiveConnections(mounted)

  // Pools own sockets; closing them is this plugin's responsibility, and the
  // effect disposer runs on unload or hot replacement.
  ctx.effect(() => () => live.dispose())

  // The section re-renders per assembly, so a settings save reaches the model
  // on the next turn without reloading the plugin.
  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.effect(() => promptCtx.systemPrompt.section({
      name: CONNECTIONS_SECTION,
      order: CONNECTIONS_ORDER,
      text: () => renderConnections(live.connections),
    }))
  })

  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.effect(() => toolCtx.tools.register(queryTool(live)))
    toolCtx.effect(() => toolCtx.tools.register(schemaTool(live)))
    toolCtx.effect(() => toolCtx.tools.register(executeTool(live)))
  })

  /**
   * Persist a connection list and apply it live.
   *
   * Order matters: an invalid list throws before anything is written, and a
   * write failure leaves the running list untouched, so the file and the live
   * state never disagree.
   * @param {object[]} raw - the raw connection entries from the settings page.
   * @returns {Promise<object[]>} the raw entries now in effect.
   */
  async function replace(raw) {
    const normalized = resolveConnections({ connections: raw })
    store.save(raw)
    live.swap(normalized)
    return raw
  }

  ctx.inject(['webServer'], (serverCtx) => {
    const handler = createApiHandler({
      list: () => store.load(mountedRaw),
      replace,
      file: store.file,
      test: async (name) => {
        // Resolve through the live registry first so an unknown name reports
        // the configured list instead of a connection error.
        live.registry.get(name)
        return live.registry.ping(name)
      },
    })
    serverCtx.effect(() => serverCtx.webServer.register({
      kind: 'prefix',
      path: '/api/db-connections',
      handler,
    }))
  })
}

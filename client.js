/**
 * dsh-db-connections — browser half.
 *
 * Contributes one settings section holding the connection list: add, edit,
 * delete, and per-connection read-only / read-write. Saving posts the whole list
 * to the plugin's own `/api/db-connections` route, which validates it, writes the
 * profile's `cordis.patch.yml`, and applies it without a restart.
 *
 * A hand-written ModuleLoader bundle: no build step, and no dependency beyond
 * the `react` the shell already provides. Every colour comes from a theme
 * variable so the page survives a scheme switch.
 *
 * Passwords are shown and edited as plain text. That is deliberate: the list is
 * stored in a configuration file the user owns, and a field that hides its value
 * makes a wrong password impossible to spot. The API refuses cross-origin writes
 * (see `src/api.js`), which is what keeps the plaintext value from leaving the
 * machine.
 */
window.__ModuleLoader__.load({
  id: 'dsh-db-connections',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, Fragment, useState, useEffect, useCallback, useRef } = React

    const NS = 'settings.dbConnections'
    // `locale` is required: apply() registers dictionaries and binds the
    // translator through `ctx.locale`, so without the declaration that service
    // is absent, apply() throws, and the whole section never registers.
    const inject = ['slots', 'locale']

    // ── copy ────────────────────────────────────────────────────────────────
    const DICT = {
      zh: {
        nav: '数据库连接',
        intro: '在这里配置数据库，之后在对话里直接用连接名（例如「用 128 查一下」）。保存后立即生效，无需重启。',
        add: '新增连接',
        save: '保存',
        saving: '保存中…',
        saved: '已保存',
        reload: '重新加载',
        test: '测试',
        testing: '连接中…',
        remove: '删除',
        confirmRemove: '确定删除这个连接？',
        empty: '还没有配置任何连接。点「新增连接」开始。',
        loading: '正在加载…',
        loadFailed: '无法读取配置',
        retry: '重试',
        file: '配置文件',
        name: '连接名',
        nameHint: '在对话里使用的名字，例如 128',
        host: '主机',
        port: '端口',
        user: '用户名',
        password: '密码',
        database: '默认库',
        databaseHint: '可留空；留空时 SQL 里要写 库名.表名',
        description: '备注',
        descriptionHint: '可选，会显示给 AI 作为上下文',
        access: '权限',
        readOnly: '只读',
        readWrite: '读写',
        readOnlyHint: '只读：AI 只能查询，服务端强制只读事务',
        readWriteHint: '读写：AI 可以改数据，请谨慎',
        advanced: '高级选项',
        connectTimeoutMs: '连接超时 (ms)',
        queryTimeoutMs: '查询超时 (ms)',
        maxRows: '最多返回行数',
        maxCellChars: '单元格最大字符',
        maxDdlChars: 'DDL 最大字符',
        connectionLimit: '连接池大小',
        ssl: '使用 TLS',
        ok: '连接成功',
        fail: '连接失败',
        mysqlVersion: 'MySQL {v}',
        unsaved: '有未保存的改动',
        duplicate: '连接名重复',
        needName: '连接名不能为空',
        needHost: '主机不能为空',
        needUser: '用户名不能为空',
        plaintextNote: '密码以明文保存在你的配置文件里，仅本机可读写。',
      },
      en: {
        nav: 'Databases',
        intro: 'Configure databases here, then refer to them by name in chat (for example "query 128"). Saving applies immediately; no restart needed.',
        add: 'Add connection',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Saved',
        reload: 'Reload',
        test: 'Test',
        testing: 'Connecting…',
        remove: 'Remove',
        confirmRemove: 'Remove this connection?',
        empty: 'No connections configured yet. Use "Add connection" to start.',
        loading: 'Loading…',
        loadFailed: 'Could not read the configuration',
        retry: 'Retry',
        file: 'Configuration file',
        name: 'Name',
        nameHint: 'The name you use in chat, e.g. 128',
        host: 'Host',
        port: 'Port',
        user: 'User',
        password: 'Password',
        database: 'Default schema',
        databaseHint: 'Optional; without it, qualify SQL as schema.table',
        description: 'Note',
        descriptionHint: 'Optional; shown to the model as context',
        access: 'Access',
        readOnly: 'Read-only',
        readWrite: 'Read-write',
        readOnlyHint: 'Read-only: the model can only query; the server enforces it',
        readWriteHint: 'Read-write: the model can change data — use with care',
        advanced: 'Advanced',
        connectTimeoutMs: 'Connect timeout (ms)',
        queryTimeoutMs: 'Query timeout (ms)',
        maxRows: 'Max rows',
        maxCellChars: 'Max chars per cell',
        maxDdlChars: 'Max DDL chars',
        connectionLimit: 'Pool size',
        ssl: 'Use TLS',
        ok: 'Connected',
        fail: 'Connection failed',
        mysqlVersion: 'MySQL {v}',
        unsaved: 'Unsaved changes',
        duplicate: 'Duplicate connection name',
        needName: 'Name is required',
        needHost: 'Host is required',
        needUser: 'User is required',
        plaintextNote: 'The password is stored as plain text in your own configuration file, readable only on this machine.',
      },
    }


    /** Route base, derived from the document base so a sub-path deployment works. */
    const API = (() => {
      try { return new URL('api/db-connections', document.baseURI).pathname } catch { return '/api/db-connections' }
    })()

    /**
     * Call the plugin's API.
     * @param {string} path - route suffix.
     * @param {object} [options] - fetch options plus an optional `timeout`.
     * @returns {Promise<object>} the parsed JSON body.
     */
    async function api(path, options) {
      const { timeout = 15000, ...rest } = options ?? {}
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeout)
      try {
        const response = await fetch(`${API}${path}`, { ...rest, signal: controller.signal, redirect: 'error' })
        const text = await response.text()
        let payload
        try { payload = text === '' ? {} : JSON.parse(text) } catch { payload = { error: text.slice(0, 300) } }
        if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`)
        return payload
      } finally {
        clearTimeout(timer)
      }
    }

    // ── styles (theme variables only) ───────────────────────────────────────
    const CSS = `
.dbc_root{display:flex;flex-direction:column;gap:14px;font-size:13px;color:var(--dsh-text-primary,#e6e6e6)}
.dbc_hint{color:var(--dsh-text-secondary,#9aa0a6);line-height:1.6}
.dbc_path{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dsh-text-secondary,#9aa0a6);word-break:break-all}
.dbc_bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.dbc_btn{padding:5px 12px;border-radius:6px;border:1px solid var(--dsh-border,#3a3f45);background:var(--dsh-bg-elevated,#23262a);color:inherit;cursor:pointer;font-size:12px;line-height:1.6}
.dbc_btn:hover:not(:disabled){border-color:var(--dsh-accent,#4c8dff)}
.dbc_btn:disabled{opacity:.5;cursor:default}
.dbc_btnPrimary{background:var(--dsh-accent,#4c8dff);border-color:var(--dsh-accent,#4c8dff);color:#fff}
.dbc_btnDanger{color:var(--dsh-danger,#e5534b)}
.dbc_card{border:1px solid var(--dsh-border,#3a3f45);border-radius:8px;padding:12px;display:flex;flex-direction:column;gap:10px;background:var(--dsh-bg-elevated,#1c1f23)}
.dbc_cardHead{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}
.dbc_name{font-weight:600;font-size:14px}
.dbc_badge{font-size:11px;padding:2px 7px;border-radius:10px;border:1px solid var(--dsh-border,#3a3f45);color:var(--dsh-text-secondary,#9aa0a6)}
.dbc_badgeOK{color:var(--dsh-success,#3fb950);border-color:var(--dsh-success,#3fb950)}
.dbc_badgeErr{color:var(--dsh-danger,#e5534b);border-color:var(--dsh-danger,#e5534b)}
.dbc_grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px}
.dbc_field{display:flex;flex-direction:column;gap:4px;min-width:0}
.dbc_label{font-size:11px;color:var(--dsh-text-secondary,#9aa0a6)}
.dbc_input,.dbc_select{padding:5px 8px;border-radius:6px;border:1px solid var(--dsh-border,#3a3f45);background:var(--dsh-bg,#16181b);color:inherit;font-size:12px;font-family:inherit;width:100%;box-sizing:border-box}
.dbc_input:focus,.dbc_select:focus{outline:none;border-color:var(--dsh-accent,#4c8dff)}
.dbc_wide{grid-column:1/-1}
.dbc_err{color:var(--dsh-danger,#e5534b);font-size:12px;white-space:pre-wrap}
.dbc_ok{color:var(--dsh-success,#3fb950);font-size:12px}
.dbc_adv{border:1px dashed var(--dsh-border,#3a3f45);border-radius:6px;padding:10px}
.dbc_advToggle{background:none;border:none;color:var(--dsh-text-secondary,#9aa0a6);cursor:pointer;font-size:12px;padding:0;text-align:left}
`

    /**
     * Inject the stylesheet once.
     * @returns {() => void} disposer removing the element.
     */
    function mountStyles() {
      const element = document.createElement('style')
      element.setAttribute('data-dbc', 'style')
      element.textContent = CSS
      document.head.appendChild(element)
      return () => { try { element.remove() } catch { /* already detached */ } }
    }

    /** Field defaults for a new connection. */
    const BLANK = {
      name: '', host: '', port: '3306', user: 'root', password: '',
      database: '', description: '', allowWrite: false, ssl: false,
      connectTimeoutMs: 10000, queryTimeoutMs: 30000, maxRows: 200,
      maxCellChars: 500, maxDdlChars: 20000, connectionLimit: 4,
    }

    /**
     * One labelled text input.
     * @param {object} props - label, value, and change handler.
     * @returns {object} the element.
     */
    function Field({ label, hint, value, onChange, type = 'text', placeholder, wide }) {
      return h('label', { className: wide ? 'dbc_field dbc_wide' : 'dbc_field' },
        h('span', { className: 'dbc_label' }, hint === undefined ? label : `${label} · ${hint}`),
        h('input', {
          className: 'dbc_input',
          type,
          value: value ?? '',
          placeholder: placeholder ?? '',
          onChange: event => onChange(event.target.value),
        }))
    }

    /** One numeric input that keeps an empty field as an empty string. */
    function NumberField({ label, value, onChange }) {
      return h('label', { className: 'dbc_field' },
        h('span', { className: 'dbc_label' }, label),
        h('input', {
          className: 'dbc_input',
          inputMode: 'numeric',
          value: value ?? '',
          onChange: event => onChange(event.target.value),
        }))
    }

    /**
     * One connection editor card.
     * @param {object} props - the entry, its index, and the page callbacks.
     * @returns {object} the element.
     */
    function Card({ entry, index, t, onChange, onRemove, onTest }) {
      const [advanced, setAdvanced] = useState(false)
      const [probe, setProbe] = useState(undefined)
      const [busy, setBusy] = useState(false)
      const patch = next => onChange(index, { ...entry, ...next })

      const runTest = async () => {
        setBusy(true)
        setProbe(undefined)
        try {
          const result = await onTest(entry)
          setProbe(result)
        } catch (error) {
          setProbe({ reachable: false, error: error instanceof Error ? error.message : String(error) })
        } finally {
          setBusy(false)
        }
      }

      return h('div', { className: 'dbc_card' },
        h('div', { className: 'dbc_cardHead' },
          h('span', { className: 'dbc_name' }, entry.name === '' ? t('add') : entry.name),
          h('div', { className: 'dbc_bar' },
            probe !== undefined && h('span', {
              className: probe.reachable === true ? 'dbc_badge dbc_badgeOK' : 'dbc_badge dbc_badgeErr',
            }, probe.reachable === true
              ? `${t('ok')}${probe.version === undefined ? '' : ` · ${t('mysqlVersion').replace('{v}', String(probe.version))}`}`
              : t('fail')),
            h('button', { className: 'dbc_btn', onClick: runTest, disabled: busy || entry.name === '' }, busy ? t('testing') : t('test')),
            h('button', { className: 'dbc_btn dbc_btnDanger', onClick: () => onRemove(index) }, t('remove')))),

        probe !== undefined && probe.reachable !== true && h('div', { className: 'dbc_err' }, String(probe.error ?? '')),

        h('div', { className: 'dbc_grid' },
          h(Field, { label: t('name'), hint: t('nameHint'), value: entry.name, onChange: value => patch({ name: value }) }),
          h(Field, { label: t('host'), value: entry.host, placeholder: '192.0.2.10', onChange: value => patch({ host: value }) }),
          h(Field, { label: t('port'), value: entry.port, onChange: value => patch({ port: value }) }),
          h(Field, { label: t('user'), value: entry.user, onChange: value => patch({ user: value }) }),
          h(Field, { label: t('password'), type: 'text', value: entry.password ?? '', onChange: value => patch({ password: value }) }),
          h(Field, { label: t('database'), hint: t('databaseHint'), value: entry.database ?? '', placeholder: 'appdb', onChange: value => patch({ database: value }) }),
          h(Field, { label: t('description'), hint: t('descriptionHint'), value: entry.description ?? '', placeholder: '开发库', wide: true, onChange: value => patch({ description: value }) })),

        h('div', { className: 'dbc_grid' },
          h('label', { className: 'dbc_field' },
            h('span', { className: 'dbc_label' }, t('access')),
            h('select', {
              className: 'dbc_select',
              value: entry.allowWrite === true ? 'rw' : 'ro',
              onChange: event => patch({ allowWrite: event.target.value === 'rw' }),
            },
            h('option', { value: 'ro' }, t('readOnly')),
            h('option', { value: 'rw' }, t('readWrite')))),
          h('div', { className: 'dbc_field' },
            h('span', { className: 'dbc_label' }, '\u00a0'),
            h('span', { className: 'dbc_hint' }, entry.allowWrite === true ? t('readWriteHint') : t('readOnlyHint')))),

        h('button', { className: 'dbc_advToggle', onClick: () => setAdvanced(!advanced) },
          `${advanced ? '▾' : '▸'} ${t('advanced')}`),

        advanced && h('div', { className: 'dbc_adv' },
          h('div', { className: 'dbc_grid' },
            h(NumberField, { label: t('connectTimeoutMs'), value: entry.connectTimeoutMs, onChange: value => patch({ connectTimeoutMs: value }) }),
            h(NumberField, { label: t('queryTimeoutMs'), value: entry.queryTimeoutMs, onChange: value => patch({ queryTimeoutMs: value }) }),
            h(NumberField, { label: t('maxRows'), value: entry.maxRows, onChange: value => patch({ maxRows: value }) }),
            h(NumberField, { label: t('maxCellChars'), value: entry.maxCellChars, onChange: value => patch({ maxCellChars: value }) }),
            h(NumberField, { label: t('maxDdlChars'), value: entry.maxDdlChars, onChange: value => patch({ maxDdlChars: value }) }),
            h(NumberField, { label: t('connectionLimit'), value: entry.connectionLimit, onChange: value => patch({ connectionLimit: value }) }),
            h('label', { className: 'dbc_field' },
              h('span', { className: 'dbc_label' }, t('ssl')),
              h('select', {
                className: 'dbc_select',
                value: entry.ssl === true ? 'yes' : 'no',
                onChange: event => patch({ ssl: event.target.value === 'yes' }),
              },
              h('option', { value: 'no' }, '—'),
              h('option', { value: 'yes' }, 'TLS'))))))
    }

    /**
     * Turn the editor's string-typed fields into the values the API validates.
     *
     * Numeric fields are sent as numbers so a saved file reads as configuration
     * rather than as strings, and a blank optional field is omitted entirely so
     * it does not shadow a schema default with an empty value.
     * @param {object} entry - one editor entry.
     * @returns {object} the entry to persist.
     */
    function toPayload(entry) {
      const numeric = key => {
        const raw = entry[key]
        if (raw === '' || raw === undefined || raw === null) return undefined
        const value = Number(raw)
        return Number.isFinite(value) ? value : undefined
      }
      return {
        name: String(entry.name ?? '').trim(),
        host: String(entry.host ?? '').trim(),
        port: numeric('port') ?? 3306,
        user: String(entry.user ?? '').trim(),
        password: String(entry.password ?? ''),
        ...String(entry.database ?? '').trim() === '' ? {} : { database: String(entry.database).trim() },
        ...String(entry.description ?? '').trim() === '' ? {} : { description: String(entry.description).trim() },
        allowWrite: entry.allowWrite === true,
        ssl: entry.ssl === true,
        connectTimeoutMs: numeric('connectTimeoutMs') ?? 10000,
        queryTimeoutMs: numeric('queryTimeoutMs') ?? 30000,
        maxRows: numeric('maxRows') ?? 200,
        maxCellChars: numeric('maxCellChars') ?? 500,
        maxDdlChars: numeric('maxDdlChars') ?? 20000,
        connectionLimit: numeric('connectionLimit') ?? 4,
      }
    }

    /**
     * Normalize one loaded entry into the editor's string-typed fields.
     * @param {object} raw - a persisted entry.
     * @returns {object} the editor entry.
     */
    function toEditor(raw) {
      const merged = { ...BLANK, ...raw }
      return {
        ...merged,
        port: merged.port ?? '',
        connectTimeoutMs: merged.connectTimeoutMs ?? '',
        queryTimeoutMs: merged.queryTimeoutMs ?? '',
        maxRows: merged.maxRows ?? '',
        maxCellChars: merged.maxCellChars ?? '',
        maxDdlChars: merged.maxDdlChars ?? '',
        connectionLimit: merged.connectionLimit ?? '',
        allowWrite: merged.allowWrite === true,
        ssl: merged.ssl === true,
      }
    }

    /**
     * Validate the editor list before a save.
     * @param {object[]} entries - the editor entries.
     * @param {Function} t - the translator.
     * @returns {string | undefined} the first problem, or undefined when valid.
     */
    function validate(entries, t) {
      const seen = new Set()
      for (const entry of entries) {
        const name = String(entry.name ?? '').trim()
        if (name === '') return t('needName')
        if (seen.has(name)) return `${t('duplicate')}: ${name}`
        seen.add(name)
        if (String(entry.host ?? '').trim() === '') return `${t('needHost')}: ${name}`
        if (String(entry.user ?? '').trim() === '') return `${t('needUser')}: ${name}`
      }
      return undefined
    }

    /**
     * The settings page.
     * @param {object} props - slot props; `t` is injected because the
     * registration declares this namespace.
     * @returns {object} the element.
     */
    function SettingsPage({ t }) {
      const [entries, setEntries] = useState(undefined)
      const [file, setFile] = useState('')
      const [dirty, setDirty] = useState(false)
      const [status, setStatus] = useState(undefined)
      const [error, setError] = useState(undefined)
      const [busy, setBusy] = useState(false)
      const alive = useRef(true)

      useEffect(() => {
        alive.current = true
        return () => { alive.current = false }
      }, [])

      const load = useCallback(async () => {
        setError(undefined)
        try {
          const payload = await api('')
          if (!alive.current) return
          setEntries((payload.connections ?? []).map(toEditor))
          setFile(payload.file ?? '')
          setDirty(false)
          setStatus(undefined)
        } catch (failure) {
          if (alive.current) setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [])

      useEffect(() => { void load() }, [load])

      const change = useCallback((index, next) => {
        setEntries(current => current.map((entry, position) => (position === index ? next : entry)))
        setDirty(true)
        setStatus(undefined)
      }, [])

      const add = useCallback(() => {
        setEntries(current => [...(current ?? []), { ...BLANK }])
        setDirty(true)
        setStatus(undefined)
      }, [])

      const remove = useCallback(index => {
        if (!window.confirm(t('confirmRemove'))) return
        setEntries(current => current.filter((_entry, position) => position !== index))
        setDirty(true)
        setStatus(undefined)
      }, [t])

      const save = useCallback(async () => {
        const problem = validate(entries ?? [], t)
        if (problem !== undefined) {
          setStatus({ kind: 'error', text: problem })
          return
        }
        setBusy(true)
        setStatus(undefined)
        try {
          const payload = await api('', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ connections: (entries ?? []).map(toPayload) }),
          })
          if (!alive.current) return
          setEntries((payload.connections ?? []).map(toEditor))
          setFile(payload.file ?? file)
          setDirty(false)
          setStatus({ kind: 'ok', text: t('saved') })
        } catch (failure) {
          if (alive.current) setStatus({ kind: 'error', text: failure instanceof Error ? failure.message : String(failure) })
        } finally {
          if (alive.current) setBusy(false)
        }
      }, [entries, file, t])

      const test = useCallback(async entry => {
        // The probe runs against the SAVED connection, because pools are keyed by
        // saved names. A name that is not saved yet reports that, rather than
        // silently testing something else.
        return api('/test', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: String(entry.name ?? '').trim() }),
        })
      }, [])

      if (error !== undefined) {
        return h('div', { className: 'dbc_root' },
          h('div', { className: 'dbc_err' }, `${t('loadFailed')}: ${error}`),
          h('div', { className: 'dbc_bar' }, h('button', { className: 'dbc_btn', onClick: () => void load() }, t('retry'))))
      }
      if (entries === undefined) return h('div', { className: 'dbc_root' }, h('div', { className: 'dbc_hint' }, t('loading')))

      return h(Fragment, null,
        h('div', { className: 'dbc_root' },
          h('div', { className: 'dbc_hint' }, t('intro')),
          h('div', { className: 'dbc_bar' },
            h('button', { className: 'dbc_btn dbc_btnPrimary', onClick: () => void save(), disabled: busy || !dirty }, busy ? t('saving') : t('save')),
            h('button', { className: 'dbc_btn', onClick: add, disabled: busy }, t('add')),
            h('button', { className: 'dbc_btn', onClick: () => void load(), disabled: busy }, t('reload')),
            dirty && h('span', { className: 'dbc_badge' }, t('unsaved')),
            status?.kind === 'ok' && h('span', { className: 'dbc_ok' }, status.text),
            status?.kind === 'error' && h('span', { className: 'dbc_err' }, status.text)),

          entries.length === 0 && h('div', { className: 'dbc_hint' }, t('empty')),
          entries.map((entry, index) => h(Card, {
            key: index,
            entry,
            index,
            t,
            onChange: change,
            onRemove: remove,
            onTest: test,
          })),

          h('div', { className: 'dbc_hint' }, t('plaintextNote')),
          file !== '' && h('div', null,
            h('div', { className: 'dbc_label' }, t('file')),
            h('div', { className: 'dbc_path' }, file))))
    }

    /**
     * Register the dictionaries and the settings section.
     *
     * The locale service owns language selection: `register(ns, locale, dict)`
     * contributes one language's dictionary, and `bind(ns)` returns the
     * translator for whichever locale is active. Both are effect-scoped, so a
     * hot reload replaces them without leaking. The slot declares `locale: NS`,
     * which makes the framework inject the same `t` seat this component renders
     * with — the section label reads through it too, so a language switch
     * re-renders the section name as well as its body.
     * @param {object} ctx - the client plugin context.
     */
    function apply(ctx) {
      ctx.effect(() => mountStyles(), 'db-connections: styles')

      // One call registers every language, so the disposer removes them
      // together; two separate registrations could leave a half-populated
      // namespace if only one were disposed.
      ctx.effect(() => ctx.locale.register(NS, DICT), 'db-connections: dictionaries')
      const t = ctx.locale.bind(NS)

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'db-connections',
        order: 40,
        label: () => t('nav'),
        locale: NS,
      }, props => h(SettingsPage, props)))
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'db-connections'
    exports.__test = { toPayload, toEditor, validate, BLANK }
    return module.exports
  },
})

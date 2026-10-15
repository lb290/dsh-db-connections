/**
 * dsh-db-connections — browser half.
 *
 * Contributes one settings section holding the connection list: add, edit,
 * delete, a driver per connection, read-only / read-write, and a Test button.
 * Saving posts the whole list to the plugin's own `/api/db-connections` route,
 * which validates it, writes the profile's `cordis.patch.yml`, and applies it
 * without a restart.
 *
 * Two rules the page must respect, because the API enforces them:
 *
 * 1. **A password never arrives here.** The route redacts it and reports only
 *    whether one is set. The input is therefore write-only: leaving it alone
 *    omits the field, which the server reads as "keep the stored one".
 * 2. **A save carries the revision it read.** When the CLI or another plugin
 *    edited the file in between, the server answers 409 and this page says so
 *    instead of overwriting the other change.
 *
 * A hand-written ModuleLoader bundle: no build step, and no dependency beyond
 * the `react` the shell already provides. Every colour comes from a theme
 * variable so the page survives a scheme switch.
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
        intro: '在这里配置数据库，之后在对话里直接用连接名（例如「用 128 查一下」）。保存后立即生效，无需重启。支持 MySQL、Doris、PostgreSQL、TDengine。',
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
        driver: '数据库类型',
        name: '连接名',
        nameHint: '在对话里使用的名字，例如 128',
        host: '主机',
        port: '端口',
        user: '用户名',
        password: '密码',
        passwordSet: '已保存',
        passwordNotSet: '未设置',
        passwordFromEnv: '来自环境变量 {v}',
        passwordKeepHint: '留空表示不修改已保存的密码',
        passwordNewHint: '输入密码',
        passwordClear: '清除密码',
        passwordSource: '密码来源',
        sourcePlain: '直接填写',
        sourceEnv: '环境变量',
        envName: '环境变量名',
        envNameHint: '例如 MYSQL_PWD；密码值不写进配置文件',
        needEnvName: '环境变量名不能为空',
        database: '默认库',
        databaseHint: '可留空；留空时 SQL 里要写 库名.表名',
        databaseHintPg: 'PostgreSQL：填默认 schema，可留空',
        description: '备注',
        descriptionHint: '可选，会显示给 AI 作为上下文',
        access: '权限',
        readOnly: '只读',
        readWrite: '读写',
        hints: {
          server: '只读：AI 只能查询，服务端强制只读事务',
          classify: '只读：本引擎没有服务端只读事务，插件只放行能判定为读的语句；建议再给这个连接配只读账号',
        },
        readWriteHint: '读写：AI 可以改数据，请谨慎；每次写操作都会记入审计日志',
        advanced: '高级选项',
        connectTimeoutMs: '连接超时 (ms)',
        queryTimeoutMs: '查询超时 (ms)',
        maxRows: '最多返回行数',
        maxCellChars: '单元格最大字符',
        maxDdlChars: 'DDL 最大字符',
        maxResultChars: '单次结果字符上限',
        connectionLimit: '连接池大小',
        ssl: 'TLS',
        sslOff: '关闭',
        sslOn: '开启',
        sslInsecure: '开启（不校验证书）',
        sslCa: 'CA 证书 (PEM)',
        sslCaHint: '可选；内网自签证书时粘贴证书内容',
        ok: '连接成功',
        fail: '连接失败',
        version: '版本 {v}',
        unsaved: '有未保存的改动',
        duplicate: '连接名重复',
        needName: '连接名不能为空',
        needHost: '主机不能为空',
        needUser: '用户名不能为空',
        needPort: '端口必须是数字',
        conflict: '配置文件在别处被修改了（可能是命令行或另一个插件）。已阻止本次保存以免覆盖对方的改动，请点「重新加载」后重试。',
        problems: '以下连接的配置没问题，但在本机不可用：',
        plaintextNote: '密码以明文保存在你自己的配置文件里（文件权限已收紧为仅本人可读写）。如果不想落盘，请把「密码来源」改成环境变量。',
      },
      en: {
        nav: 'Databases',
        intro: 'Configure databases here, then refer to them by name in chat (for example "query 128"). Saving applies immediately; no restart needed. MySQL, Doris, PostgreSQL, and TDengine are supported.',
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
        driver: 'Engine',
        name: 'Name',
        nameHint: 'The name you use in chat, e.g. 128',
        host: 'Host',
        port: 'Port',
        user: 'User',
        password: 'Password',
        passwordSet: 'Saved',
        passwordNotSet: 'Not set',
        passwordFromEnv: 'From environment variable {v}',
        passwordKeepHint: 'Leave empty to keep the saved password',
        passwordNewHint: 'Enter the password',
        passwordClear: 'Clear password',
        passwordSource: 'Password source',
        sourcePlain: 'Entered here',
        sourceEnv: 'Environment variable',
        envName: 'Variable name',
        envNameHint: 'e.g. MYSQL_PWD; the secret never enters the file',
        needEnvName: 'The variable name is required',
        database: 'Default schema',
        databaseHint: 'Optional; without it, qualify SQL as schema.table',
        databaseHintPg: 'PostgreSQL: the default schema; optional',
        description: 'Note',
        descriptionHint: 'Optional; shown to the model as context',
        access: 'Access',
        readOnly: 'Read-only',
        readWrite: 'Read-write',
        hints: {
          server: 'Read-only: the model can only query; the server enforces it',
          classify: 'Read-only: this engine has no server-side read-only transaction, so the plugin admits only statements it can prove are reads; give the connection a read-only account too',
        },
        readWriteHint: 'Read-write: the model can change data — use with care; every write is written to the audit log',
        advanced: 'Advanced',
        connectTimeoutMs: 'Connect timeout (ms)',
        queryTimeoutMs: 'Query timeout (ms)',
        maxRows: 'Max rows',
        maxCellChars: 'Max chars per cell',
        maxDdlChars: 'Max DDL chars',
        maxResultChars: 'Max result chars',
        connectionLimit: 'Pool size',
        ssl: 'TLS',
        sslOff: 'Off',
        sslOn: 'On',
        sslInsecure: 'On (certificate not verified)',
        sslCa: 'CA certificate (PEM)',
        sslCaHint: 'Optional; paste it for a self-signed internal certificate',
        ok: 'Connected',
        fail: 'Connection failed',
        version: 'version {v}',
        unsaved: 'Unsaved changes',
        duplicate: 'Duplicate connection name',
        needName: 'Name is required',
        needHost: 'Host is required',
        needUser: 'User is required',
        needPort: 'Port must be a number',
        conflict: 'The configuration file changed elsewhere (the CLI, or another plugin). This save was refused so that change is not overwritten — reload, then apply yours again.',
        problems: 'These connections are configured correctly but are not usable on this machine:',
        plaintextNote: 'The password is stored as plain text in your own configuration file (its mode is tightened to owner-only). Switch "Password source" to an environment variable to keep it out of the file.',
      },
    }

    /** Fallback driver list, used until the API answers with the real catalog. */
    const DRIVER_FALLBACK = [
      { id: 'mysql', label: 'MySQL', defaultPort: 3306, maxRows: 200, readOnly: 'server' },
      { id: 'doris', label: 'Doris', defaultPort: 9030, maxRows: 200, readOnly: 'classify' },
      { id: 'postgres', label: 'PostgreSQL', defaultPort: 5432, maxRows: 200, readOnly: 'server' },
      { id: 'tdengine', label: 'TDengine', defaultPort: 6041, maxRows: 50, readOnly: 'classify' },
    ]

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
        if (!response.ok) {
          const failure = new Error(payload?.error ?? `HTTP ${response.status}`)
          failure.status = response.status
          throw failure
        }
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
.dbc_input,.dbc_select,.dbc_textarea{padding:5px 8px;border-radius:6px;border:1px solid var(--dsh-border,#3a3f45);background:var(--dsh-bg,#16181b);color:inherit;font-size:12px;font-family:inherit;width:100%;box-sizing:border-box}
.dbc_textarea{min-height:64px;resize:vertical}
.dbc_input:focus,.dbc_select:focus,.dbc_textarea:focus{outline:none;border-color:var(--dsh-accent,#4c8dff)}
.dbc_wide{grid-column:1/-1}
.dbc_err{color:var(--dsh-danger,#e5534b);font-size:12px;white-space:pre-wrap}
.dbc_ok{color:var(--dsh-success,#3fb950);font-size:12px}
.dbc_warn{border:1px solid var(--dsh-danger,#e5534b);border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:6px}
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
      name: '', driver: 'mysql', host: '', port: '3306', user: 'root',
      passwordDraft: undefined, passwordMode: 'plain', passwordEnvDraft: '', passwordSet: false, passwordSource: 'none',
      database: '', description: '', allowWrite: false,
      sslMode: 'off', sslCa: '',
      connectTimeoutMs: 10000, queryTimeoutMs: 30000, maxRows: 200,
      maxCellChars: 500, maxDdlChars: 20000, maxResultChars: 32000, connectionLimit: 4,
    }

    /** Monotonic key source for editor entries, so React state follows the card. */
    let keyCounter = 0

    /**
     * One labelled text input.
     * @param {object} props - label, value, and change handler.
     * @returns {object} the element.
     */
    function Field({ label, hint, value, onChange, type = 'text', placeholder, wide, disabled }) {
      return h('label', { className: wide ? 'dbc_field dbc_wide' : 'dbc_field' },
        h('span', { className: 'dbc_label' }, hint === undefined ? label : `${label} · ${hint}`),
        h('input', {
          className: 'dbc_input',
          type,
          value: value ?? '',
          placeholder: placeholder ?? '',
          disabled: disabled === true,
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

    /** One select over a fixed set of options. */
    function Select({ label, value, options, onChange }) {
      return h('label', { className: 'dbc_field' },
        h('span', { className: 'dbc_label' }, label),
        h('select', { className: 'dbc_select', value, onChange: event => onChange(event.target.value) },
          ...options.map(option => h('option', { key: option.value, value: option.value }, option.label))))
    }

    /**
     * One connection editor card.
     * @param {object} props - the entry, its position, and the page callbacks.
     * @returns {object} the element.
     */
    function Card({ entry, index, t, drivers, onChange, onRemove, onTest }) {
      const [advanced, setAdvanced] = useState(false)
      const [probe, setProbe] = useState(undefined)
      const [busy, setBusy] = useState(false)
      const patch = next => onChange(index, { ...entry, ...next })
      const driver = drivers.find(item => item.id === entry.driver) ?? drivers[0] ?? DRIVER_FALLBACK[0]

      const runTest = async () => {
        setBusy(true)
        setProbe(undefined)
        try {
          setProbe(await onTest(entry))
        } catch (error) {
          setProbe({ reachable: false, error: error instanceof Error ? error.message : String(error) })
        } finally {
          setBusy(false)
        }
      }

      /** Switching the engine moves a field only when it still holds the old default. */
      const changeDriver = id => {
        const previous = drivers.find(item => item.id === entry.driver) ?? DRIVER_FALLBACK[0]
        const next = drivers.find(item => item.id === id) ?? DRIVER_FALLBACK[0]
        const currentPort = String(entry.port ?? '')
        const currentRows = String(entry.maxRows ?? '')
        patch({
          driver: id,
          port: currentPort !== '' && currentPort !== String(previous.defaultPort) ? currentPort : String(next.defaultPort),
          maxRows: currentRows !== '' && currentRows !== String(previous.maxRows) ? currentRows : String(next.maxRows),
        })
      }

      const passwordState = entry.passwordMode === 'env'
        ? { text: entry.passwordEnvDraft === '' ? t('passwordNotSet') : t('passwordFromEnv').replace('{v}', entry.passwordEnvDraft), kind: entry.passwordEnvDraft === '' ? 'dbc_badge' : 'dbc_badge dbc_badgeOK' }
        : entry.passwordSet
          ? { text: t('passwordSet'), kind: 'dbc_badge dbc_badgeOK' }
          : { text: t('passwordNotSet'), kind: 'dbc_badge dbc_badgeErr' }

      return h('div', { className: 'dbc_card' },
        h('div', { className: 'dbc_cardHead' },
          h('span', { className: 'dbc_name' }, entry.name === '' ? t('add') : entry.name),
          h('div', { className: 'dbc_bar' },
            probe !== undefined && h('span', {
              className: probe.reachable === true ? 'dbc_badge dbc_badgeOK' : 'dbc_badge dbc_badgeErr',
            }, probe.reachable === true
              ? `${t('ok')}${probe.version === undefined ? '' : ` · ${t('version').replace('{v}', String(probe.version))}`}`
              : t('fail')),
            h('button', { className: 'dbc_btn', onClick: runTest, disabled: busy || entry.name === '' }, busy ? t('testing') : t('test')),
            h('button', { className: 'dbc_btn dbc_btnDanger', onClick: () => onRemove(index) }, t('remove')))),

        probe !== undefined && probe.reachable !== true && h('div', { className: 'dbc_err' }, String(probe.error ?? '')),

        h('div', { className: 'dbc_grid' },
          h(Select, {
            label: t('driver'),
            value: entry.driver,
            options: drivers.map(item => ({ value: item.id, label: item.label })),
            onChange: changeDriver,
          }),
          h(Field, { label: t('name'), hint: t('nameHint'), value: entry.name, onChange: value => patch({ name: value }) }),
          h(Field, { label: t('host'), value: entry.host, placeholder: '192.0.2.10', onChange: value => patch({ host: value }) }),
          h(Field, { label: t('port'), value: entry.port, onChange: value => patch({ port: value }) }),
          h(Field, { label: t('user'), value: entry.user, onChange: value => patch({ user: value }) })),

        h('div', { className: 'dbc_grid' },
          h('label', { className: 'dbc_field' },
            h('span', { className: 'dbc_label' }, `${t('password')} · `,
              h('span', { className: passwordState.kind }, passwordState.text)),
            h('div', { className: 'dbc_bar' },
              h('input', {
                className: 'dbc_input',
                type: 'password',
                value: entry.passwordDraft ?? '',
                placeholder: entry.passwordSet && entry.passwordDraft === undefined ? t('passwordKeepHint') : t('passwordNewHint'),
                disabled: entry.passwordMode === 'env',
                onChange: event => patch({ passwordDraft: event.target.value }),
              }),
              h('button', {
                className: 'dbc_btn',
                disabled: entry.passwordMode === 'env' || entry.passwordSet === false,
                onClick: () => patch({ passwordDraft: '', passwordSet: false }),
              }, t('passwordClear')))),
          h(Field, {
            label: t('database'),
            hint: entry.driver === 'postgres' ? t('databaseHintPg') : t('databaseHint'),
            value: entry.database ?? '',
            placeholder: entry.driver === 'postgres' ? 'public' : 'appdb',
            onChange: value => patch({ database: value }),
          }),
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
            h('span', { className: 'dbc_hint' }, entry.allowWrite === true
              ? t('readWriteHint')
              : (t('hints')?.[driver.readOnly] ?? t('hints')?.server ?? '')))),

        h('button', { className: 'dbc_advToggle', onClick: () => setAdvanced(!advanced) },
          `${advanced ? '▾' : '▸'} ${t('advanced')}`),

        advanced && h('div', { className: 'dbc_adv' },
          h('div', { className: 'dbc_grid' },
            h(Select, {
              label: t('passwordSource'),
              value: entry.passwordMode,
              options: [{ value: 'plain', label: t('sourcePlain') }, { value: 'env', label: t('sourceEnv') }],
              onChange: value => patch({ passwordMode: value }),
            }),
            entry.passwordMode === 'env' && h(Field, {
              label: t('envName'),
              hint: t('envNameHint'),
              value: entry.passwordEnvDraft,
              onChange: value => patch({ passwordEnvDraft: value }),
            }),
            h(Select, {
              label: t('ssl'),
              value: entry.sslMode,
              options: [
                { value: 'off', label: t('sslOff') },
                { value: 'on', label: t('sslOn') },
                { value: 'insecure', label: t('sslInsecure') },
              ],
              onChange: value => patch({ sslMode: value }),
            }),
            entry.sslMode !== 'off' && h('label', { className: 'dbc_field dbc_wide' },
              h('span', { className: 'dbc_label' }, `${t('sslCa')} · ${t('sslCaHint')}`),
              h('textarea', {
                className: 'dbc_textarea',
                value: entry.sslCa ?? '',
                onChange: event => patch({ sslCa: event.target.value }),
              })),
            h(NumberField, { label: t('connectTimeoutMs'), value: entry.connectTimeoutMs, onChange: value => patch({ connectTimeoutMs: value }) }),
            h(NumberField, { label: t('queryTimeoutMs'), value: entry.queryTimeoutMs, onChange: value => patch({ queryTimeoutMs: value }) }),
            h(NumberField, { label: t('maxRows'), value: entry.maxRows, onChange: value => patch({ maxRows: value }) }),
            h(NumberField, { label: t('maxCellChars'), value: entry.maxCellChars, onChange: value => patch({ maxCellChars: value }) }),
            h(NumberField, { label: t('maxDdlChars'), value: entry.maxDdlChars, onChange: value => patch({ maxDdlChars: value }) }),
            h(NumberField, { label: t('maxResultChars'), value: entry.maxResultChars, onChange: value => patch({ maxResultChars: value }) }),
            h(NumberField, { label: t('connectionLimit'), value: entry.connectionLimit, onChange: value => patch({ connectionLimit: value }) }))))
    }

    /**
     * Turn the editor's string-typed fields into the values the API validates.
     *
     * Numeric fields are sent as numbers so a saved file reads as configuration
     * rather than as strings, and a blank optional field is omitted entirely so
     * it does not shadow a schema default with an empty value. The password is
     * sent only when the user actually set one: an absent field is what tells the
     * server to keep the stored value it never disclosed.
     * @param {object} entry - one editor entry.
     * @param {object[]} drivers - the driver catalog.
     * @returns {object} the entry to persist.
     */
    function toPayload(entry, drivers = DRIVER_FALLBACK) {
      const numeric = key => {
        const raw = entry[key]
        if (raw === '' || raw === undefined || raw === null) return undefined
        const value = Number(raw)
        return Number.isFinite(value) ? value : undefined
      }
      const driver = drivers.find(item => item.id === entry.driver) ?? DRIVER_FALLBACK[0]
      const envMode = entry.passwordMode === 'env'
      const ssl = entry.sslMode === 'off'
        ? false
        : entry.sslMode === 'insecure'
          ? { rejectUnauthorized: false }
          : String(entry.sslCa ?? '').trim() === '' ? true : { ca: String(entry.sslCa).trim() }
      return {
        name: String(entry.name ?? '').trim(),
        driver: driver.id,
        host: String(entry.host ?? '').trim(),
        port: numeric('port') ?? driver.defaultPort,
        user: String(entry.user ?? '').trim(),
        // An empty string clears a stored environment indirection; the name is
        // the only password fact this payload carries. Environment mode also
        // clears any stored plaintext, because keeping a secret out of the file
        // is the reason to choose it.
        passwordEnv: envMode ? String(entry.passwordEnvDraft ?? '').trim() : '',
        ...envMode ? { password: '' } : entry.passwordDraft === undefined ? {} : { password: entry.passwordDraft },
        ...String(entry.database ?? '').trim() === '' ? {} : { database: String(entry.database).trim() },
        ...String(entry.description ?? '').trim() === '' ? {} : { description: String(entry.description).trim() },
        allowWrite: entry.allowWrite === true,
        ssl,
        connectTimeoutMs: numeric('connectTimeoutMs') ?? 10000,
        queryTimeoutMs: numeric('queryTimeoutMs') ?? 30000,
        maxRows: numeric('maxRows') ?? driver.maxRows ?? 200,
        maxCellChars: numeric('maxCellChars') ?? 500,
        maxDdlChars: numeric('maxDdlChars') ?? 20000,
        maxResultChars: numeric('maxResultChars') ?? 32000,
        connectionLimit: numeric('connectionLimit') ?? 4,
      }
    }

    /**
     * Normalize one loaded entry into the editor's fields.
     *
     * The API never sends a password, so the editor holds no password value at
     * all: `passwordSet` says whether one exists, `passwordDraft` stays undefined
     * until the user types, and the payload omits the field while it does.
     * @param {object} raw - a persisted or returned entry.
     * @param {string} key - the stable React key for this card.
     * @param {object[]} [drivers] - the driver catalog, for per-engine defaults.
     * @returns {object} the editor entry.
     */
    function toEditor(raw, key, drivers = DRIVER_FALLBACK) {
      const merged = { ...BLANK, ...raw }
      const driverDefaults = drivers.find(item => item.id === merged.driver) ?? DRIVER_FALLBACK[0]
      const sslMode = merged.ssl === false || merged.ssl === undefined || merged.ssl === null
        ? 'off'
        : merged.ssl === true ? 'on' : merged.ssl.rejectUnauthorized === false ? 'insecure' : 'on'
      return {
        ...merged,
        key,
        passwordDraft: undefined,
        passwordMode: raw.passwordSource === 'env' || typeof raw.passwordEnv === 'string' && raw.passwordEnv !== '' ? 'env' : 'plain',
        passwordEnvDraft: typeof raw.passwordEnv === 'string' ? raw.passwordEnv : '',
        passwordSet: raw.passwordSet === true,
        sslMode,
        sslCa: merged.ssl !== null && typeof merged.ssl === 'object' && typeof merged.ssl.ca === 'string' ? merged.ssl.ca : '',
        // An absent port or row cap must show the engine's own default: writing
        // MySQL's 3306 over a Doris connection the user never touched would
        // point the connection at the wrong port.
        port: raw.port === undefined || raw.port === null ? String(driverDefaults.defaultPort ?? '') : merged.port,
        maxRows: raw.maxRows === undefined || raw.maxRows === null ? String(driverDefaults.maxRows ?? '') : merged.maxRows,
        connectTimeoutMs: merged.connectTimeoutMs ?? '',
        queryTimeoutMs: merged.queryTimeoutMs ?? '',
        maxCellChars: merged.maxCellChars ?? '',
        maxDdlChars: merged.maxDdlChars ?? '',
        maxResultChars: merged.maxResultChars ?? '',
        connectionLimit: merged.connectionLimit ?? '',
        allowWrite: merged.allowWrite === true,
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
        const port = Number(String(entry.port ?? '').trim())
        if (Number.isInteger(port) === false || port <= 0 || port > 65535) return `${t('needPort')}: ${name}`
        if (entry.passwordMode === 'env' && String(entry.passwordEnvDraft ?? '').trim() === '') {
          return `${t('needEnvName')}: ${name}`
        }
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
      const [revision, setRevision] = useState('')
      const [problems, setProblems] = useState([])
      const [drivers, setDrivers] = useState(DRIVER_FALLBACK)
      const [dirty, setDirty] = useState(false)
      const [status, setStatus] = useState(undefined)
      const [error, setError] = useState(undefined)
      const [busy, setBusy] = useState(false)
      const alive = useRef(true)
      const keys = useRef(new Map())

      useEffect(() => {
        alive.current = true
        return () => { alive.current = false }
      }, [])

      /** Give one returned entry a key that survives a save when its name does. */
      const adopt = useCallback((raw, catalog = DRIVER_FALLBACK) => {
        const name = String(raw?.name ?? '')
        const map = keys.current
        if (name !== '' && map.has(name)) return toEditor(raw, map.get(name), catalog)
        keyCounter += 1
        const key = `e${keyCounter}`
        if (name !== '') map.set(name, key)
        return toEditor(raw, key, catalog)
      }, [])

      const load = useCallback(async () => {
        setError(undefined)
        try {
          const payload = await api('')
          if (!alive.current) return
          const catalog = Array.isArray(payload.drivers) && payload.drivers.length > 0 ? payload.drivers : DRIVER_FALLBACK
          keys.current = new Map()
          setDrivers(catalog)
          setEntries((payload.connections ?? []).map(entry => adopt(entry, catalog)))
          setFile(payload.file ?? '')
          setRevision(payload.revision ?? '')
          setProblems(payload.problems ?? [])
          setDirty(false)
          setStatus(undefined)
        } catch (failure) {
          if (alive.current) setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [adopt])

      useEffect(() => { void load() }, [load])

      const change = useCallback((index, next) => {
        setEntries(current => current.map((entry, position) => (position === index ? { ...next, key: entry.key } : entry)))
        setDirty(true)
        setStatus(undefined)
      }, [])

      const add = useCallback(() => {
        keyCounter += 1
        setEntries(current => [...(current ?? []), { ...BLANK, key: `e${keyCounter}` }])
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
            body: JSON.stringify({ connections: (entries ?? []).map(entry => toPayload(entry, drivers)), revision }),
          })
          if (!alive.current) return
          setEntries((payload.connections ?? []).map(entry => adopt(entry, drivers)))
          setFile(payload.file ?? file)
          setRevision(payload.revision ?? '')
          setProblems(payload.problems ?? [])
          setDirty(false)
          setStatus({ kind: 'ok', text: t('saved') })
        } catch (failure) {
          if (!alive.current) return
          const conflict = failure?.status === 409
          setStatus({ kind: 'error', text: conflict ? t('conflict') : (failure instanceof Error ? failure.message : String(failure)) })
          if (conflict) setDirty(true)
        } finally {
          if (alive.current) setBusy(false)
        }
      }, [adopt, drivers, entries, file, revision, t])

      const test = useCallback(async entry => {
        // The probe runs against the SAVED connection, because drivers are keyed by
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
          problems.length > 0 && h('div', { className: 'dbc_warn' },
            h('div', { className: 'dbc_label' }, t('problems')),
            ...problems.map(problem => h('div', { key: problem.connection, className: 'dbc_err' }, `${problem.connection}: ${problem.message}`))),
          h('div', { className: 'dbc_bar' },
            h('button', { className: 'dbc_btn dbc_btnPrimary', onClick: () => void save(), disabled: busy || !dirty }, busy ? t('saving') : t('save')),
            h('button', { className: 'dbc_btn', onClick: add, disabled: busy }, t('add')),
            h('button', { className: 'dbc_btn', onClick: () => void load(), disabled: busy }, t('reload')),
            dirty && h('span', { className: 'dbc_badge' }, t('unsaved')),
            status?.kind === 'ok' && h('span', { className: 'dbc_ok' }, status.text),
            status?.kind === 'error' && h('span', { className: 'dbc_err' }, status.text)),

          entries.length === 0 && h('div', { className: 'dbc_hint' }, t('empty')),
          entries.map((entry, index) => h(Card, {
            key: entry.key,
            entry,
            index,
            t,
            drivers,
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
    exports.__test = { toPayload, toEditor, validate, BLANK, DRIVER_FALLBACK }
    return module.exports
  },
})

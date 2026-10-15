# dsh-db-connections

English | [中文](README.zh.md)

**Named database connections** for DeepSeek Harness. Configure your databases in a settings page, then refer to them by name in chat — say "use 128" and the model knows which database to reach and how.

## The problem it solves

Asking an AI to query a database normally means restating host, port, user, and password every time. This plugin stores those in configuration and leaves one short name (`128`) for you and the model to use:

- The connection names are contributed to the system prompt, so "use 128" resolves without you repeating an address or a credential.
- All three tools take `connection` as their first argument, so the model only carries names.
- **No password ever reaches the prompt** — only host, port, default schema, and whether the connection is writable.

## Install

Plugin directory: `<path-to>/dsh-db-connections`

Install dependencies first (`mysql2` and `yaml`):

```sh
cd <path-to>/dsh-db-connections
npm install
```

Then install into a profile with the DSH plugin command. The Electron desktop app owns its `desktop` profile exclusively, so use the CLI the app ships:

```sh
# Default Windows desktop path; substitute your own if installed elsewhere.
"C:\Program Files\deepseek\resources\runtime\cli\bin\dsh.cmd" ^
  plugin --profile desktop add "<path-to>/dsh-db-connections"
```

`dsh plugin add` records the package in the profile's `dsh.profile.bundles`, and the package's own `cordis.patch.yml` inserts the `id: db-connections` row with `connections: []` (connect to nothing by default).

Any other profile (`web`, `tui`, your own) uses the ordinary CLI:

```sh
dsh plugin --profile <name> add /absolute/path/to/dsh-db-connections
```

> **Restart the desktop app once after installing**, so the settings page appears: the client-plugin roster is scanned at startup, not re-scanned while running.
>
> Conversely, **the plugin directory must not be deleted, renamed, or moved**: the profile references it through a `link:`, and a missing directory produces `cannot resolve profile bundle "dsh-db-connections"`.

## Configure a database

Two routes, one configuration — use whichever you prefer.

### Route 1: click through the app (recommended)

Open **Settings → Databases** to add, edit, and delete connections, pick **read-only** or **read-write** per connection from a dropdown, and press **Test** to verify a connection on the spot. Saving applies immediately — no restart, and no need to touch the configuration file.

The page follows the shell's own language setting (Chinese/English): dictionaries are contributed with `ctx.locale.register()` and lookups go through `ctx.locale.bind()`, rather than guessing from the browser, so the page follows a language switch.

Passwords are shown and edited as plain text: the value lives in a file you own, and hiding it only makes a wrong password impossible to spot.

### Route 2: edit the configuration file

**Redefine** the `db-connections` row in the profile's `cordis.patch.yml`. The loader replaces a row's whole `config` rather than deep-merging it, so restate every key:

```yaml
- id: db-connections
  name: "dsh-db-connections"
  config:
    connections:
      - name: "128"              # the name you and the model use in chat
        host: 192.0.2.10
        port: 3306               # optional, default 3306
        user: root
        password: "change-me"       # or use passwordEnv, below
        database: appdb     # optional default schema
        description: dev database # optional; shown in the prompt
        allowWrite: false        # optional, default false = read-only
```

Where the profile's `cordis.patch.yml` lives:

| Platform | Path |
| --- | --- |
| Windows | `C:\Users\<you>\.dsh\profiles\desktop\cordis.patch.yml` |
| macOS / Linux | `~/.dsh/profiles/desktop/cordis.patch.yml` |

Press **Reload** on the settings page, or restart the app, to apply a hand edit. A change made through the settings page needs neither.

### Several connections

`connections` is a list, in order; names must be unique:

```yaml
- id: db-connections
  name: "dsh-db-connections"
  config:
    connections:
      - name: "128"
        host: 192.0.2.10
        user: root
        password: "change-me"
        database: appdb
        description: dev database
      - name: "prod"
        host: 192.0.2.9
        user: readonly_user
        passwordEnv: PROD_DB_PASSWORD   # keeps the secret out of the file
        database: app_prod
        description: production (read-only account)
      - name: "local"
        host: 127.0.0.1
        user: root
        password: ""
        description: local MySQL
```

### Keep the password out of the file

Name an environment variable with `passwordEnv`; it is resolved at load, and a missing variable fails loudly rather than becoming an empty password:

```yaml
        passwordEnv: PROD_DB_PASSWORD
```

When both are present, `passwordEnv` wins. **A settings-page save does not destroy this**: the page edits raw configuration, so a resolved password is never written back to the file.

### Write access

**Set per connection, read-only by default.** The settings page's dropdown ("Read-only" / "Read-write") is exactly the `allowWrite` flag in the configuration file.

Read-only has two independent layers, neither of which is keyword matching in the plugin:

1. With `allowWrite: false` (the default), `db_execute` refuses outright.
2. Even on a writable connection, every `db_query` statement runs inside a server-enforced `START TRANSACTION READ ONLY` — **MySQL rejects the write** — so bypass-shaped statements such as `SELECT ... INTO OUTFILE`, `SELECT ... FOR UPDATE`, and `WITH ... UPDATE` are refused by the server too.

Before enabling writes, confirm the database should accept changes from the agent. A read-only account is the better choice for most deployments than turning on `allowWrite`.

## The three tools

| Tool | Purpose |
| --- | --- |
| `db_query` | Read-only queries, in a server-enforced read-only transaction. Returns columns plus rows. |
| `db_execute` | Writes (INSERT/UPDATE/DELETE/DDL). Available only with `allowWrite: true`. |
| `db_schema` | Inspect structure: omit `database` to list schemas; pass `database` to list tables; add `table` for columns, indexes, and DDL. |

You do not call these yourself. Typical requests:

- "list the schemas on 128" → `db_schema`
- "what does sys_user look like in 128?" → `db_schema`
- "show me the first 10 users in 128" → `db_query`
- "change the remark on id=1 in 128" → `db_execute` (needs a writable connection)

## Per-connection options

| Key | Default | Meaning |
| --- | --- | --- |
| `name` | required | Connection name, unique, ≤64 characters |
| `host` | required | Hostname or IP |
| `user` | required | Account name |
| `password` | `''` | Password, stored as plain text in the configuration file |
| `passwordEnv` | — | Environment variable holding the password; wins over `password` |
| `port` | `3306` | TCP port |
| `driver` | `mysql` | Only `mysql` is supported |
| `database` | — | Default schema; without it, qualify SQL as `schema.table` |
| `description` | — | Shown in the prompt, for context |
| `allowWrite` | `false` | Whether this connection accepts writes; the settings page's read-only / read-write dropdown |
| `ssl` | `false` | Connect over TLS |
| `connectTimeoutMs` | `10000` | Connection timeout |
| `queryTimeoutMs` | `30000` | Per-statement timeout (client and server `MAX_EXECUTION_TIME`) |
| `maxRows` | `200` | Rows returned per call; an excess is reported, never silently dropped |
| `maxCellChars` | `500` | Characters kept per cell |
| `maxDdlChars` | `20000` | Bound for the table DDL `db_schema` returns, kept separate so a CREATE TABLE is not cut off |
| `connectionLimit` | `4` | Pool size |

A bad configuration fails **at plugin load** naming the offending key, rather than when the model first calls a tool.

## Security notes

- Passwords never appear in the prompt or in tool results.
- Read-only comes from a server-side transaction, not a keyword denylist.
- Multiple statements are disabled (`multipleStatements: false`): one call runs one statement.
- Temporal and exact numeric columns are returned as strings (`dateStrings`, `bigNumberStrings`) so the plugin never invents a time-zone interpretation or loses precision.
- The settings API answers **same-origin writes only**, and requires `Content-Type: application/json` on them (a cross-origin request with that type must preflight, and the API answers no preflight). Another web page therefore cannot read or change your passwords.

## Which file the settings page writes

A save edits the `id: db-connections` row in the running profile's `cordis.patch.yml`; the page shows the full path at the bottom. The write parses the document, replaces only that row, and re-serializes, so:

- other plugins' configuration is preserved verbatim;
- **comments are preserved**, including indented and trailing ones.

If the row is absent (for example you keep it in a different patch layer), a save creates it and leaves everything else alone. A file that is not valid YAML fails the save rather than being overwritten.

## Development and tests

```sh
cd <path-to>/dsh-db-connections
npm install

node test-config.mjs      # config validation + load/dispose lifecycle (no database)
node test-store.mjs       # configuration file read/write + settings API (no database)
node test-client.mjs      # browser half: slot registration, inject declarations, save payload
node test-render.mjs      # renders the settings page: dropdown, save, test, add/remove (no browser)
node test-meta.mjs        # plugin-list display name/description localization (locale files + export map)
node test-plugin-meta.mjs # calls the harness's own readPluginMeta to verify display metadata
node test-profile.mjs     # package manifest + the harness's own scan deciding the page loads
node test-integration.mjs # real database: tools and every refusal path
node test-write.mjs       # real database: read-write mode (creates and drops its own table)
node test-loader.mjs      # loads through the real SystemPrompt/ToolRuntime services, then saves live
```

The scripts that contact a real database (`test-integration`, `test-write`, `test-loader`) hard-code connection settings at the top; read them before running.

Two tests run the harness's **real** logic rather than a restatement of it:

- `test-plugin-meta.mjs` calls the exported `readPluginMeta()`, the code that decides what the plugin list displays. It imposes hard rules (the English file must be named exactly `en.json`, it must resolve through the export map, every language file must share its directory, filenames must be bare language ids); violating any one fails the **whole** metadata read and the list silently falls back to the English technical name. A hand-written check would miss that.
- `test-profile.mjs` calls `ClientModuleRegistry.resolveMeta()`. A client plugin must declare both `dsh.client` **and** `exports["./client"]`; without the latter the harness throws at startup — breaking the whole app, not merely hiding this plugin.

## Layout

```
dsh-db-connections/
├── index.js              # entry: config, prompt section, three tools, settings API
├── client.js             # browser half: the settings page (hand-written ModuleLoader bundle, no build step)
├── cordis.patch.yml      # bundle layer: inserts the db-connections row
├── icon.svg              # the icon shown in the plugin list
├── locale/
│   ├── en.json           # plugin-list name and description, English
│   └── zh.json           # plugin-list name and description, Chinese
├── src/
│   ├── api.js            # settings API: same-origin, JSON, and error mapping
│   ├── config.js         # config validation and normalization (fails loud at load)
│   ├── live.js           # the mutable runtime connection set (a save swaps it in place)
│   ├── prompt.js         # model-facing connection list (never a password)
│   ├── registry.js       # pools plus the read-only execution path
│   ├── sql.js            # statement classification and identifier quoting
│   ├── store.js          # reads/writes the profile's cordis.patch.yml (keeps comments and other rows)
│   ├── tool.js           # raw tool definition and argument validation
│   ├── tools.js          # db_query / db_execute / db_schema
│   └── values.js         # cell values to lossless JSON
└── test-*.mjs
```

## How localization is wired

The plugin has two independent localizations, covering two different surfaces:

| Surface | Mechanism | Files |
| --- | --- | --- |
| Inside the settings page (field labels, buttons, hints) | the client locale service | the `DICT` in `client.js`, contributed with `ctx.locale.register()` and read through `ctx.locale.bind()` |
| The plugin list's **name and description** | package metadata | `locale/en.json` + `locale/zh.json`, each a `meta.title` / `meta.description` |

The second has hard rules, and violating any one silently falls back to the English technical name (no error is shown):

- The English file must be named **exactly** `en.json`; the harness finds it first, then scans that directory for other `.json` files as further languages.
- `package.json` must export `"./locale/*.json": "./locale/*.json"`, or the harness cannot resolve it.
- Filenames must be bare language ids (`zh.json` is fine, so is `zh-CN.json`; `zh_CN.json` is not).
- Every language file must sit in the **same directory** as `en.json`.
- `package.json`'s `description` participates in fallback alongside the English dictionary; when the two disagree the list shows one text and other surfaces the other, so `test-meta.mjs` asserts they match.

To add a third language, drop a file into `locale/` (say `ja.json`); no code changes are needed.

## Known limitations

- MySQL / MariaDB only. Adding PostgreSQL means a second pool and read-only path in `src/registry.js`, plus a `SUPPORTED_DRIVERS` entry in `src/config.js`.
- The read-only guarantee relies on the server supporting `START TRANSACTION READ ONLY` (MySQL 5.6+, MariaDB 10.0+). On older servers, use a read-only account instead.
- Schema answers are read live from `information_schema` on every `db_schema` call — no cache, so what you see is current.
- The client-plugin roster is scanned at **app startup**, so a first install (or any new client half) needs one desktop restart before the page appears. Later configuration and code changes hot-reload without a restart.
- The page's **Test** button probes the *saved* connection, because pools are built from saved names. Change the settings, save, then test.
- The profile references this directory by link, so **do not delete, rename, or move it**; to relocate, `dsh plugin remove` and `add` again.

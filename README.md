# dsh-db-connections

English | [中文](README.zh.md)

**Named database connections** for DeepSeek Harness. Configure MySQL, Doris, PostgreSQL, or TDengine in a settings page, then refer to them by name in chat — say "use 128" and the model knows which database to reach and how.

## The problem it solves

Asking an AI to query a database normally means restating host, port, user, and password every time. This plugin stores those in configuration and leaves one short name (`128`) for you and the model to use:

- The connection names are contributed to the system prompt, so "use 128" resolves without you repeating an address or a credential.
- All three tools take `connection` as their first argument, so the model only carries names.
- **No password ever reaches the prompt**, and none reaches the settings page either — only the engine, the default schema, and whether the connection is writable.
- **No address reaches the prompt** either: the section carries a name, an engine, and a purpose, not your network topology.

## Install

Plugin directory: `<path-to>/dsh-db-connections`

Install dependencies first (`mysql2` and `yaml`; `pg` arrives as an optional dependency and is only imported when a PostgreSQL connection is used):

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

Passwords are **write-only** here: the API never sends a stored password back, so the field shows whether one is set and starts empty. Leaving it alone keeps the saved value; typing replaces it; **Clear password** empties it. To keep a secret out of the file entirely, switch **Password source** to *environment variable* and name one.

The page also picks the engine per connection, offers TLS (including a self-signed mode), and keeps the advanced limits out of the way until you open them.

### Route 2: edit the configuration file

**Redefine** the `db-connections` row in the profile's `cordis.patch.yml`. The loader replaces a row's whole `config` rather than deep-merging it, so restate every key:

```yaml
- id: db-connections
  name: "dsh-db-connections"
  config:
    connections:
      - name: "128"              # the name you and the model use in chat
        driver: mysql            # mysql | doris | postgres | tdengine
        host: 192.0.2.10
        port: 3306               # optional, default per driver
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

### Engines

| `driver` | Talks to | Default port | Read-only enforced by |
| --- | --- | --- | --- |
| `mysql` | MySQL / MariaDB | 3306 | the server: every read runs in `START TRANSACTION READ ONLY` |
| `doris` | Apache Doris (MySQL protocol) | 9030 | the plugin: Doris has no read-only transaction, so only statements it can prove are reads are admitted |
| `postgres` | PostgreSQL 12+ | 5432 | the server: every read runs in `BEGIN TRANSACTION READ ONLY` |
| `tdengine` | TDengine via taosAdapter REST | 6041 | the plugin: TDengine has no transactions, so only statements it can prove are reads are admitted |

Per-engine facts worth knowing:

- **Doris** speaks the MySQL wire protocol but is not MySQL: `START TRANSACTION READ ONLY` is not available, its statement timeout is `query_timeout` in *seconds*, and indexes may not be exposed through `information_schema`.
- **PostgreSQL** has no `SHOW CREATE TABLE`, so `db_schema` assembles the DDL from the system catalog and says so. A connection belongs to one database, so `database` names a **schema**; temporal columns are returned as the server's own text rather than JavaScript dates.
- **TDengine**'s REST interface is stateless, so `USE db` has nothing to act on: set `database` and the plugin puts it in the request path, and a table in another database must be written `db.table`. `db_schema` reports super tables (`STABLE`) and their child tables (the comment names the parent). A query with no `ts` range and no INTERVAL window comes back with a notice, because it may scan a whole super table.
- A connection whose engine cannot enforce read-only access on the server should also be given a **read-only account**. The plugin's classification is the second layer there, not the only one you rely on.

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

Name an environment variable with `passwordEnv`; it is resolved at load. A variable this machine does not set does **not** fail the plugin: that connection is reported as unusable — in the prompt, in the log, and on the settings page — because a load failure would also remove the settings page that is the only place to see the reason.

```yaml
        passwordEnv: PROD_DB_PASSWORD
```

When both are present, `passwordEnv` wins. **A settings-page save does not destroy either one**: the page edits raw configuration, the API carries an untouched password over from the stored entry, and the response never contained the value to begin with. You can also create the indirection from the page now — set **Password source** to *environment variable*.

### Write access

**Set per connection, read-only by default.** The settings page's dropdown ("Read-only" / "Read-write") is exactly the `allowWrite` flag in the configuration file.

Read-only is decided in two places, and which ones apply depends on the engine:

1. With `allowWrite: false` (the default), `db_execute` refuses outright.
2. `db_query` refuses every statement it can prove writes, every session or administrative statement (`SET`, `USE`, transaction control), and any string holding more than one statement — that layer is engine-independent.
3. On **MySQL and PostgreSQL** it also refuses to run a write on the server: every read is wrapped in a read-only transaction, so bypass-shaped statements such as `SELECT ... INTO OUTFILE`, `SELECT ... FOR UPDATE`, and `WITH ... UPDATE` are stopped by the database itself.
4. On **Doris and TDengine**, where no such transaction exists, a statement the plugin cannot prove is a read is refused instead of being guessed at ("could not be classified"). That is why those engines pair better with a read-only account: classification is a gate, not a guarantee the server can back up.

Before enabling writes, confirm the database should accept changes from the agent. A read-only account is the better choice for most deployments than turning on `allowWrite`.

### Audit trail (optional)

Writes are worth recording. Add an `audit` block and every `db_execute` call appends one JSON line — time, connection, engine, statement (bounded), affected rows, duration, and whether it succeeded:

```yaml
- id: db-connections
  name: "dsh-db-connections"
  config:
    audit:
      path: .dsh-db/audit.jsonl   # relative paths resolve against the profile directory
      maxSqlChars: 512            # optional
    connections: []
```

A failed statement is recorded too, with its error. No credential is ever part of a record.

## The three tools

| Tool | Purpose |
| --- | --- |
| `db_query` | Read-only queries. Returns columns plus rows, in `table`, `csv`, or `json` form. |
| `db_execute` | Writes (INSERT/UPDATE/DELETE/DDL). Available only with `allowWrite: true`, and audited when a trail is configured. |
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
| `driver` | `mysql` | `mysql`, `doris`, `postgres`, or `tdengine` |
| `host` | required | Hostname or IP |
| `user` | required | Account name |
| `password` | `''` | Password, stored as plain text in the configuration file |
| `passwordEnv` | — | Environment variable holding the password; wins over `password` |
| `port` | per driver | TCP port (3306 / 9030 / 5432 / 6041) |
| `database` | — | Default schema (PostgreSQL: the schema; TDengine: the request path's database); without it, qualify SQL as `schema.table` |
| `description` | — | Shown in the prompt, for context |
| `allowWrite` | `false` | Whether this connection accepts writes; the settings page's read-only / read-write dropdown |
| `ssl` | `false` | `true`, or a mapping with `ca`, `cert`, `key`, `pfx`, `passphrase`, `servername`, `rejectUnauthorized` |
| `connectTimeoutMs` | `10000` | Connection timeout |
| `queryTimeoutMs` | `30000` | Per-statement timeout (client-side, plus the engine's own limit) |
| `maxRows` | `200` (`50` on TDengine) | Rows returned per call; an excess is reported, never silently dropped |
| `maxCellChars` | `500` | Characters kept per cell |
| `maxDdlChars` | `20000` | Bound for the table DDL `db_schema` returns, kept separate so a CREATE TABLE is not cut off |
| `maxResultChars` | `32000` | Character budget for one rendered result; a cut result says so |
| `connectionLimit` | `4` | Pool size (MySQL and PostgreSQL; TDengine's REST interface holds nothing open) |

A bad configuration fails **at plugin load** naming the offending key, rather than when the model first calls a tool. The one exception is `passwordEnv` pointing at a variable this machine does not set: that connection is marked unusable instead, so the settings page stays reachable.

## Security notes

- Passwords never appear in the prompt, in tool results, or in an API response: the settings page learns *whether* a credential is set and where it comes from, never its value.
- An untouched password survives a save because the payload omits it; an explicit empty string is what clears it.
- The configuration file is written with mode `0600` (owner read/write only), because it holds credentials.
- Read-only comes from the engine's own read-only transaction where one exists, and from statement classification where it does not; a deny-by-default rule covers everything the plugin cannot classify.
- One statement per call, on every engine: a trailing `; DROP TABLE ...` cannot ride along behind a classified `SELECT`.
- Temporal and exact numeric columns are returned as strings so the plugin never invents a time-zone interpretation or loses precision — on PostgreSQL this means overriding `pg`'s date parsers.
- The settings API answers **same-origin requests only** (reads included) and requires `Content-Type: application/json` on writes (a cross-origin request with that type must preflight, and the API answers no preflight).
- A write can carry the file revision it read; when the CLI or another plugin edited the file in between, the save is refused with **409** instead of silently discarding that change.

## Which file the settings page writes

A save edits the `id: db-connections` row in the running profile's `cordis.patch.yml`; the page shows the full path at the bottom. The write parses the document, replaces only that row, and re-serializes, so:

- other plugins' configuration is preserved verbatim;
- **comments are preserved**, including indented and trailing ones.

If the row is absent (for example you keep it in a different patch layer), a save creates it and leaves everything else alone. A file that is not valid YAML fails the save rather than being overwritten. A file that changed since the page read it fails the save with 409 rather than overwriting the newer edit.

## Development and tests

```sh
cd <path-to>/dsh-db-connections
npm install
npm test                 # every suite below, one summary line each
```

A suite that needs something this machine lacks — a database, a harness runtime, an installed profile — prints `SKIP` with the reason instead of failing.

```sh
node tests/test-drivers.mjs     # classification, single-statement enforcement, quoting, every driver mapping
node tests/test-registry.mjs    # row caps, cell conversion, formats, the read policy, and the audit hook (stub engine)
node tests/test-settings.mjs    # redaction and password inheritance between the page and the store
node tests/test-store.mjs       # configuration file read/write, revision conflicts, file mode, settings API
node tests/test-audit.mjs       # the audit setting, record shape, statement bound
node tests/test-config.mjs      # config validation + load/dispose lifecycle
node tests/test-client.mjs      # browser half: slot registration, inject declarations, save payload
node tests/test-render.mjs      # renders the settings page: pickers, save, test, add/remove (no browser)
node tests/test-meta.mjs        # plugin-list display name/description localization (locale files + export map)
node tests/test-plugin-meta.mjs # calls the harness's own readPluginMeta to verify display metadata
node tests/test-profile.mjs     # package manifest + the harness's own scan deciding the page loads
node tests/test-loader.mjs      # loads through the real SystemPrompt/ToolRuntime services, then saves live
node tests/test-integration.mjs # real MySQL: tools, schema, formats, and every refusal path
node tests/test-write.mjs       # real MySQL: read-write mode and the audit trail (creates and drops its own table)
```

Environment for the suites that need more than Node:

| Variable | Used by | Meaning |
| --- | --- | --- |
| `DSH_RUNTIME_MODULES` | `test-loader`, `test-profile`, `test-plugin-meta` | directory holding the harness's own `@deepseek-ai` packages (the app ships one) |
| `DSH_PROFILE_DIR` | `test-loader`, `test-profile` | a profile directory; `test-loader` writes a scratch one itself |
| `DSH_PROFILE_BASE` | `test-plugin-meta` | `file://` URL of a profile the plugin is installed into |
| `DB_TEST_HOST` / `DB_TEST_PORT` / `DB_TEST_USER` / `DB_TEST_PASSWORD` / `DB_TEST_DATABASE` | `test-integration`, `test-write` | the MySQL to test against (defaults `127.0.0.1:3306`, `root`, empty password, `test`) |

The working checklist of what still needs a live database — per-engine assumptions to confirm, and the deliberately deferred work — lives in [TODO.md](TODO.md).

Two tests run the harness's **real** logic rather than a restatement of it:

- `test-plugin-meta.mjs` calls the exported `readPluginMeta()`, the code that decides what the plugin list displays. It imposes hard rules (the English file must be named exactly `en.json`, it must resolve through the export map, every language file must share its directory, filenames must be bare language ids); violating any one fails the **whole** metadata read and the list silently falls back to the English technical name. A hand-written check would miss that.
- `test-profile.mjs` calls `ClientModuleRegistry.resolveMeta()`. A client plugin must declare both `dsh.client` **and** `exports["./client"]`; without the latter the harness throws at startup — breaking the whole app, not merely hiding this plugin.

## Layout

```
dsh-db-connections/
├── index.js              # entry: config, prompt section, three tools, settings API, audit sink
├── client.js             # browser half: the settings page (hand-written ModuleLoader bundle, no build step)
├── cordis.patch.yml      # bundle layer: inserts the db-connections row
├── icon.svg              # the icon shown in the plugin list
├── run-tests.mjs         # runs every suite and prints one summary
├── tests-support.mjs     # shared prerequisites (skip, TCP probe, harness import)
├── locale/
│   ├── en.json           # plugin-list name and description, English
│   └── zh.json           # plugin-list name and description, Chinese
├── src/
│   ├── api.js            # settings API: same-origin, JSON, redaction, conflict mapping
│   ├── audit.js          # optional JSONL trail for writing statements
│   ├── config.js         # config validation and normalization (fails loud at load)
│   ├── errors.js         # transport and read-only failure translation shared by drivers
│   ├── live.js           # the mutable runtime connection set (a save swaps it in place)
│   ├── prompt.js         # model-facing connection list (never a password, never an address)
│   ├── registry.js       # the engine-independent read policy, row caps, and audit hook
│   ├── settings.js       # redaction and password inheritance for the settings page
│   ├── sql.js            # per-dialect classification, single-statement enforcement, quoting
│   ├── store.js          # reads/writes the profile's cordis.patch.yml (comments, other rows, revision)
│   ├── tool.js           # raw tool definition, argument validation, result rendering
│   ├── tools.js          # db_query / db_execute / db_schema
│   ├── values.js         # cell values to lossless JSON
│   └── drivers/
│       ├── index.js      # catalog + factory (the one place an engine is announced)
│       ├── mysql.js      # MySQL and Doris (same wire protocol, different guarantees)
│       ├── postgres.js   # PostgreSQL over `pg`, imported on first use
│       └── tdengine.js   # TDengine over the taosAdapter REST interface
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

- **Two engines have no server-side read-only mode.** On Doris and TDengine, `db_query` refuses everything it cannot prove is a read, and that classification is the gate. Give those connections a read-only account for enforcement you can rely on.
- **PostgreSQL needs 12+**: `db_schema` reads `attgenerated`, which older servers do not have.
- **PostgreSQL's DDL is reconstructed**, not quoted: the server keeps the original `CREATE TABLE` text to itself, so `db_schema` assembles it from the catalog (columns, defaults, primary key, and the server's own index definitions). The report says so.
- **TDengine's REST interface holds no session**, so `USE db` has no effect: the default database is the connection's, and a table elsewhere must be qualified.
- `pg` is an optional dependency: a deployment that never configures PostgreSQL does not need it, and the PostgreSQL driver says so with the exact command if it is missing.
- Schema answers are read live from the engine's catalog on every `db_schema` call — no cache, so what you see is current. A table-name search across connections is not implemented; the model walks the list.
- The client-plugin roster is scanned at **app startup**, so a first install (or any new client half) needs one desktop restart before the page appears. Later configuration and code changes hot-reload without a restart.
- The page's **Test** button probes the *saved* connection, because drivers are built from saved names. Change the settings, save, then test.
- The profile references this directory by link, so **do not delete, rename, or move it**; to relocate, `dsh plugin remove` and `add` again.
- A save from the page replaces the whole `connections` list. Two people editing different connections at once is serialized by the revision check (the second gets a 409 and reloads), not merged.

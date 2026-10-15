# Changelog

All notable changes to `dsh-db-connections` are documented here.

## v0.2.0 — Four engines, and a settings page that never holds a password

The driver layer was split out of the registry so one plugin can reach MySQL, Doris, PostgreSQL, and TDengine, and the read-only path was rebuilt around what each engine can actually enforce.

### ✨ Features

- **Four engines**: `driver: mysql | doris | postgres | tdengine`, each with its own default port (3306 / 9030 / 5432 / 6041), timeout mechanism, catalog queries, error translation, and prompt notes. `pg` is an optional dependency, imported only when a PostgreSQL connection is used.
- **Per-engine read-only**: a read runs in a server-enforced read-only transaction on MySQL (`START TRANSACTION READ ONLY`) and PostgreSQL (`BEGIN TRANSACTION READ ONLY`); on Doris and TDengine, which have no such transaction, `db_query` admits only statements it can prove are reads and refuses the rest instead of guessing.
- **Result formats and a budget**: `db_query` takes `format: table | csv | json`, and `maxResultChars` bounds one rendered result, saying so when it cuts.
- **Audit trail (opt-in)**: `audit.path` appends one JSON line per `db_execute` — connection, engine, statement (bounded), affected rows, duration, success, and the error on failure.
- **Settings page**: an engine picker per connection, write-only password field with a **Password source** choice (entered here / environment variable), TLS with a self-signed mode and optional CA, and the per-engine row cap.
- **`db_schema`** accepts `schema` as an alias of `database`, and reports each engine's own vocabulary (PostgreSQL schemas, TDengine super tables and their child tables).

### 🔒 Security

- **A response never carries a stored password.** The settings route redacts it and reports `passwordSet` / `passwordSource`; a save that omits `password` keeps the stored value, and an explicit empty string clears it.
- **`passwordEnv` is no longer destroyed by a settings-page save**, and the indirection can now be created from the page.
- **A missing `passwordEnv` variable no longer fails the plugin load** — that connection is reported as unusable in the prompt, the log, and the page, so the page that explains it stays reachable.
- **One statement per call on every engine**, so a trailing `; DROP TABLE ...` cannot ride behind a classified `SELECT`; MySQL already refused this, PostgreSQL and TDengine did not.
- Session and administrative statements (`SET`, `USE`, transaction control) are refused on every connection.
- The patch file is written with mode `0600`, and a save can carry the revision it read: a file that changed in the meantime is refused with **409** instead of being overwritten.
- The same-origin check now covers reads as well as writes.

### 🧪 Quality

- `npm test` runs every suite with one summary; a suite whose prerequisite is missing (no database, no harness runtime, no installed profile) prints `SKIP` with the reason.
- New suites: `test-drivers` (classification, quoting, every driver mapping, single-statement enforcement), `test-registry` (row caps, cell conversion, formats, the read policy, and the audit hook, driven by a stub engine through an injectable driver factory), `test-settings` (redaction and inheritance), `test-audit`.
- `test-loader` now exercises the read-only policy per engine without needing a database at all.

### 📝 Notes

- `maxRows` defaults to 50 on TDengine, because a bare `SELECT` there can scan a whole super table.
- PostgreSQL catalog queries use `attgenerated`, so PostgreSQL 12+ is required.

## v0.1.0 — Initial release (2026-10-14)

Named database connections for DeepSeek Harness. Configure your MySQL databases in a settings page, then refer to them by name in chat.

### ✨ Features

- **Named connections** — say "use 128" (or whatever you named it); the names are contributed to the system prompt, so the model resolves them without host, port, or password ever being restated.
- **Settings page** — add / edit / delete connections under Settings → Databases, a read-only ↔ read-write dropdown per connection, and a Test button for an on-the-spot connectivity probe. Saving applies immediately, no restart.
- **Three tools** —
  - `db_query`: read-only; every statement runs in a server-enforced read-only transaction
  - `db_execute`: only accepted on connections where you opted in to writes (`allowWrite`)
  - `db_schema`: schemas, tables, columns, indexes, and DDL
- **Secrets stay local** — no password ever reaches the prompt; `passwordEnv` keeps secrets out of the config file entirely.
- **Bilingual UI** — the settings page follows the shell's zh/en language setting via locale dictionaries.
- **Hot swap** — connections changed through the settings page or the API route are addressable immediately, without a restart.

### 📦 Install

```sh
cd <path-to>/dsh-db-connections
npm install

dsh plugin --profile <name> add <path-to>/dsh-db-connections
```

Requires Node `^22.19.0 || >=24.0.0` and a DeepSeek Harness installation. See [README.md](README.md) for desktop-profile specifics and configuration details（中文说明见 [README.zh.md](README.zh.md)）.

### 🧪 Quality

10 test suites cover config validation, store round-trip, settings-page rendering, the client bundle, the live loader stack, the write path, and end-to-end integration — including checks that read-only enforcement holds against CTE-led writes and `INTO OUTFILE`.

### 中文摘要

为 DeepSeek Harness 提供命名数据库连接：在「设置 → 数据库连接」里配好 MySQL，之后在对话里直接用连接名（例如「用 128 查一下」）。默认只读（服务端强制只读事务），可逐个连接开启读写；密码永不进入提示词，并支持 `passwordEnv` 从环境变量引用。保存立即生效，无需重启。

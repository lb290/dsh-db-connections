# Changelog

All notable changes to `dsh-db-connections` are documented here.

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

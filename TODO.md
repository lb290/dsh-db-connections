# 续做清单（工作文档）

这是一份**工程续做清单**：还没做完的验证、我照文档写但没连过真库的假设、以及有意缓做的功能。
面向用户的能力边界写在 [README.md](README.md) 的 *Known Limitations* / [README.zh.md](README.zh.md) 的「已知限制」里，这里不重复，只放可执行的待办和落点。

当前分支：`feat/four-engines-and-security-hardening`（`main` 未改动）
最近一次全量测试：**14/14 通过**，2 个需要真实 MySQL 的套件 SKIP（本机没有任何数据库）。

---

## 0. 明天开工前的准备（Windows）

### 0.1 拿到代码

```powershell
cd <你的代码目录>
git fetch origin
git checkout feat/four-engines-and-security-hardening
cd dsh-db-connections
npm install            # 会装上 mysql2 / yaml，以及可选依赖 pg
npm test               # 期望：14/14；结果里 SKIP 的行会写明缺什么
```

> `npm install` 如果慢，可以临时 `--registry=https://registry.npmmirror.com`，但**不要把这个带镜像地址的 `package-lock.json` 提交**（我这边已核对 lockfile 里没有任何镜像地址）。

### 0.2 给依赖 harness 的测试指路（可选，不设就是 SKIP）

有 3 个套件（`test-loader`、`test-profile`、`test-plugin-meta`）会加载 harness 自己的模块，需要 `DSH_RUNTIME_MODULES` 指向一个**扁平目录**，里面每个 harness 包都有自己的 `lib/index.js`。两种来源：

**来源 A：全局安装的 dsh（最省事，我已在 macOS 上验证可用）**

```powershell
$rt = "$(npm root -g)\@deepseek-ai\dsh\node_modules\@deepseek-ai"
$env:DSH_RUNTIME_MODULES = "file:///" + ($rt -replace '\\','/')
```

**来源 B：dsh 源码 checkout**（`<checkout>` 换成你的路径，用目录联接摊平）

```powershell
$h = "C:\path\to\deepseek-harness"
$flat = "$env:TEMP\dsh-runtime"
New-Item -ItemType Directory -Force -Path $flat | Out-Null
$map = @{
  'cordis'             = "$h\vendor\cordis"
  'dsh-system-prompt'  = "$h\packages\core\system-prompt"
  'dsh-tools'          = "$h\packages\core\tools"
  'dsh-app-boot'       = "$h\packages\boot\app-boot"
  'dsh-client-modules' = "$h\packages\client\modules"
}
foreach ($k in $map.Keys) {
  $dest = Join-Path $flat $k
  if (-not (Test-Path $dest)) { New-Item -ItemType Junction -Path $dest -Target $map[$k] | Out-Null }
}
$env:DSH_RUNTIME_MODULES = "file:///" + ($flat -replace '\\','/')
```

> 注意：应用包里的 `app.asar.unpacked` **不是**这个目录（我查过，里面只有 5 个原生/桌面包，没有 `dsh-tools` 等），所以指它没用。
>
> `test-plugin-meta` 还需要一个装了本插件的 profile（`DSH_PROFILE_BASE`）；`dsh 0.1.x` 的 `dsh-app-boot` 不导出 `readPluginMeta`，那种情况下这个套件会打印 SKIP 并说明原因，属预期。

### 0.3 scratch profile（给 `test-plugin-meta` 用）

```powershell
$p = "$env:TEMP\dbc-profile"
New-Item -ItemType Directory -Force -Path "$p\node_modules" | Out-Null
New-Item -ItemType Junction -Path "$p\node_modules\dsh-db-connections" -Target "<你的 dsh-db-connections 路径>" | Out-Null
$env:DSH_PROFILE_BASE = "file:///" + ($p -replace '\\','/') + "/"
```

### 0.4 真正装进 DSH 里用起来

按 [README.md](README.md#install)（或 [README.zh.md](README.zh.md) 的「安装」）用桌面版自带的 CLI 装进 `desktop` profile，然后**重启一次桌面版**，设置页才会出现。装完 `npm test` 之外，手工验收路径是：**设置 → 数据库连接** → 新增连接 → 测试 → 让 AI 跑一次 `db_schema` + `db_query`。

---

## 1. 必做验收：真库（本机无数据库，全部待做）

```powershell
$env:DB_TEST_HOST="127.0.0.1"; $env:DB_TEST_PORT="3306"
$env:DB_TEST_USER="root"; $env:DB_TEST_PASSWORD="<密码>"; $env:DB_TEST_DATABASE="test"
npm test
```

- [ ] **MySQL**：`test-integration` 与 `test-write` 由 SKIP 转为 PASS。
      `test-write` 会自己建 `_dsh_rw_probe` 表、跑完自己删，并断言审计日志写了 5 条记录、且不含密码。
- [ ] **Doris**：新增一个 `driver: doris` 连接（默认端口 9030）→ 测试 → `db_schema` 三级 → 一条 `SELECT`。
      重点确认三件事：
      1. `SHOW INDEX FROM \`db\`.\`t\`` 是否可用。不可用时**应该是**给一条 notice（"index information is not available on this engine…"）而不是整个 `db_schema` 报错。
      2. `SET query_timeout = <秒>` 是否被接受（Doris 的单位是秒，MySQL 是毫秒，代码已按引擎区分）。
      3. 在一个 Doris 连接上跑 `WITH c AS (SELECT 1) SELECT * FROM c`：**应当被拒绝**并提示"could not be classified"（Doris 没有服务端只读事务，所以分类就是闸门）。
- [ ] **PostgreSQL 12+**：新增 `driver: postgres` 连接 → 测试 → `db_schema` 三级。
      重点确认：
      1. `db_query` 里跑 `CREATE TABLE x(id int)` → 应被服务端以 SQLSTATE `25006` 拒绝，插件翻译成"writes, and db_query runs reads only"。
      2. `db_schema` 返回的 DDL 是从系统目录拼的（有 notice 说明），字段/默认值/主键/索引定义是否合理。
      3. 时间类型列（`date`/`timestamp`/`timestamptz`）是否按**服务端原文**返回，而不是被转成本地时区的 JS 时间字符串。
      4. `database` 参数按 schema 理解是否符合预期（`public` 等）。
- [ ] **TDengine**：新增 `driver: tdengine` 连接（默认端口 6041，走 taosAdapter；`database` 填库名）→ 测试 → `db_schema` 三级 → 一条带时间范围的 `SELECT`。
      重点确认（这几处我是按官方文档写的，没连过库）：
      1. `DESCRIBE \`db\`.\`t\`` 的返回列名是否为 `field` / `type` / `length` / `note`。
      2. `SHOW CREATE TABLE \`db\`.\`t\`` 的返回列是否为单个 `create table` 列（我取 `rows[0][0]`）。
      3. `SHOW TABLES` 的返回里是否有 `stable_name` 列（有的话会作为子表的 comment 显示父超级表名）。
      4. 一条**不带** `ts` 范围也没有 `INTERVAL` 的 `SELECT`，是否附带"可能扫全表"的 notice。
      5. `SELECT server_version()` 是否存在；不存在时测试按钮应仍显示"连接成功"、版本显示 `unknown`，而不是判定连接失败。
      6. 写操作（`INSERT`）返回的 `affected_rows` 是否被正确读成 `affectedRows`。

---

## 2. 我照文档写、但没连过真库的具体假设

发现任何一条不成立，改这里即可（都在 `src/drivers/`）：

| 引擎 | 我的假设 | 不成立时改哪 |
| --- | --- | --- |
| Doris | `SET query_timeout = N`（秒）在会话上生效 | `src/drivers/mysql.js` 的 `pool.on('connection')` 里那段 guard |
| Doris | `information_schema.TABLES/COLUMNS` 可用；`STATISTICS` 不一定，失败即降级 | 同上 `TABLE_QUERY` / `COLUMN_QUERY` / `INDEX_QUERY` 三个常量 |
| Doris | `SHOW CREATE TABLE \`db\`.\`t\`` 第二列是 DDL | `schema()` 里 `ddl.rows[0][1]` |
| Doris | 不接受 `START TRANSACTION READ ONLY`，所以完全不发事务 | `DRIVER_INFO.doris.readOnly = 'classify'` |
| PostgreSQL | 需要 12+（用了 `attgenerated`） | `COLUMN_QUERY` 里那段 `CASE` |
| PostgreSQL | `pg_get_indexdef` / `format_type` / `pg_stat_user_tables.n_live_tup` 语义正确 | `INDEX_QUERY` / `TABLE_QUERY` |
| PostgreSQL | `BEGIN TRANSACTION READ ONLY` + `ROLLBACK` 足以挡住写（25006） | `fetch()` 与 `PG_MESSAGES['25006']` |
| PostgreSQL | `pool` 的 `statement_timeout` / `query_timeout` 配置项存在且单位是毫秒 | `poolFor()` |
| TDengine | `DESCRIBE` 返回 `field/type/length/note` | `mapDescribe()` |
| TDengine | 错误体是 HTTP 200 + `code != 0`；`desc` 是文字描述 | `parseResponse()` |
| TDengine | 默认库走 URL 路径 `/rest/sql/<db>`，`USE db` 无效 | `createTdengineDriver` 的 `request()` |
| TDengine | 写操作返回 `column_meta[0][0] === 'affected_rows'` | `affectedRowsOf()` |
| TDengine | `SHOW DATABASES` 首列（或名为 `name` 的列）是库名 | `schema()` 的 databases 分支 |
| TDengine | Generic Basic 认证（`root:taosdata` base64）够用 | `request()` 里的 `authorization` |

---

## 3. 有意缓做的功能（按建议顺序）

- [ ] **迁到 harness 原生的 `ctx.settings`**：schema 派生表单 + `role('secret')` 脱敏 + revision 乐观锁都是自带的，现在的等价语义是我手写的。
      **前提**：你们的安装方式能 `resolve('@deepseek-ai/schemastery')`（当初为了「任意路径可加载」才刻意不依赖 harness 包）。
      落点：`index.js`（导出 `Config`）、`src/api.js`、`src/settings.js`、`client.js`（大半设置页可删）。
- [ ] **`ctx.credentials` 的 `passwordRef`**：比自建 `passwordEnv` 更原生，且按次解析（改了环境变量下一次调用就生效，不用重载）。
      落点：`src/config.js` 的 `resolvePassword` + 各 driver 建池/发请求时取值。
- [ ] **`db_find`（跨连接按表名搜索）+ schema 缓存（TTL + refresh）**：四个引擎几十个库时，这是模型最大的摩擦点；现在每次 `db_schema` 都实打实查目录。
      落点：新增 `src/cache.js`，`src/tools.js` 加第四个工具，`src/registry.js` 暴露跨连接枚举。
- [ ] **SSH 隧道 / 堡垒机选项**：生产库常在内网。落点：`src/config.js` 加 `ssh` 字段，driver 建池前起隧道。
- [ ] **会话级只读以省掉每条读 2 次 RTT**：⚠️ 现在的写法（每条语句开一个只读事务）更安全，还顺手挡住了 CTE 绕过；只有跨 WAN/高延迟才值得换，且**必须同时把 `unknown` 全部拒绝**，否则 `SET SESSION TRANSACTION READ WRITE` 能毒化会话。
- [ ] **`test-write` 支持其他引擎**：现在只测 MySQL（建表/删表的 SQL 是 MySQL 方言）。可以按 `DB_TEST_DRIVER` 参数化，或各引擎单独一个套件。

---

## 4. 小尾巴

- [ ] `CHANGELOG.md` 里 `v0.2.0` 的标题等正式发布时补上日期。
- [ ] 两份 README 只改了对应段落，若真库实测发现文案/默认值要调整，记得**两份同步**并跑 `npm test`。
- [ ] `test-plugin-meta` 在 `dsh 0.1.x` 上是 SKIP（那个版本没有 `readPluginMeta`）；等你的 dsh 升级后它会自动转成 PASS。

---

## 5. 提交纪律（明天别踩）

1. 小步提交，一个主题一个 commit；提交前跑 `npm test`。
2. **不要把任何 token / 凭据写进文件**（包括 `.git/config` 里的 remote URL）；推送用一次性 URL 或系统的凭据管理器。
3. **不要把镜像源地址写进 `package-lock.json`**（提交前 `grep -c npmmirror package-lock.json` 应为 0）。
4. 不要 force push `main`；这个分支上随便改。

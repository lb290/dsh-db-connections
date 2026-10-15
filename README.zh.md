# dsh-db-connections

[English](README.md) | 中文

给 DeepSeek Harness 用的**命名数据库连接**插件。在设置页里配好数据库，之后在对话里直接用连接名（比如"用 128 查一下"），AI 就知道连哪个库、怎么查。

## 它解决什么问题

平时让 AI 查数据库，你得反复告诉它主机、端口、用户名、密码。这个插件把这些存进配置，只留一个短名字（如 `128`）给你和 AI 使用：

- 连接名会写进系统提示词，所以你说"用 128 查"AI 就能直接解析，不用你再报地址和账号。
- 三个工具都以 `connection` 作为第一个参数，AI 只需要记住名字。
- **提示词里永远不出现密码**，只出现主机、端口、默认库，以及是否可写。

## 安装

插件目录：`<path-to>/dsh-db-connections`

先装依赖（`mysql2` 和 `yaml`）：

```sh
cd <path-to>/dsh-db-connections
npm install
```

再用 DSH 自己的安装功能装进 profile。桌面版的 `desktop` profile 由桌面应用独占管理，要用它自带的 CLI：

```sh
# Windows 桌面版默认路径；装到别处就换成你的
"C:\Program Files\deepseek\resources\runtime\cli\bin\dsh.cmd" ^
  plugin --profile desktop add "<path-to>/dsh-db-connections"
```

装完 `dsh plugin add` 会把插件加进 profile 的 `dsh.profile.bundles`，插件自带的 `cordis.patch.yml` 会自动插入一行 `id: db-connections`（初始 `connections: []`，也就是默认什么都不连）。

其他 profile（`web`/`tui`/自建 profile）用普通 CLI：

```sh
dsh plugin --profile <name> add /absolute/path/to/dsh-db-connections
```

> **装完要重启一次桌面版**，设置页才会出现——客户端插件的清单是启动时扫描的，运行中不会重新扫描。
>
> 反过来，**插件目录不能删也不能改名**：profile 里是以链接（`link:`）方式引用这个目录的，目录没了就会报 `cannot resolve profile bundle "dsh-db-connections"`。

## 配置数据库

有两条路，改的是同一份配置，随你用哪条。

### 方式一：在 DSH 里点（推荐）

打开 **设置 → 数据库连接**，就能增删改所有连接，每个连接用下拉框选**只读**或**读写**，还能点「测试」当场验证能不能连上。保存后立即生效，不用重启，也不用碰配置文件。

界面跟随 DSH 自己的语言设置（中文/英文）：词典用 `ctx.locale.register()` 注册、翻译用 `ctx.locale.bind()`，不靠猜浏览器语言，所以切语言时设置页会跟着变。

密码是明文显示和编辑的：配置存在你自己的文件里，隐藏它只会让填错的密码看不出来。

### 方式二：直接改配置文件

在 profile 的 `cordis.patch.yml` 里**重定义** `db-connections` 这一行。注意 loader 是**整块替换** `config`、不做深合并，所以每个键都要写全：

```yaml
- id: db-connections
  name: "dsh-db-connections"
  config:
    connections:
      - name: "128"              # 你和 AI 在对话里用的名字
        host: 192.0.2.10
        port: 3306               # 可选，默认 3306
        user: root
        password: "change-me"       # 或者用 passwordEnv，见下
        database: appdb     # 可选，默认库
        description: 开发库       # 可选，会显示在提示词里
        allowWrite: false        # 可选，默认 false = 只读
```

profile 的 `cordis.patch.yml` 位置：

| 平台 | 路径 |
| --- | --- |
| Windows | `C:\Users\<你>\.dsh\profiles\desktop\cordis.patch.yml` |
| macOS / Linux | `~/.dsh/profiles/desktop/cordis.patch.yml` |

保存后点设置页的「重新加载」，或重启应用即生效。用设置页改则不用。

### 配置多个连接

`connections` 是列表，按顺序加就行，名字必须唯一：

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
        description: 开发库
      - name: "prod"
        host: 192.0.2.9
        user: readonly_user
        passwordEnv: PROD_DB_PASSWORD   # 从环境变量读，密码不进配置文件
        database: app_prod
        description: 生产库（只读账号）
      - name: "local"
        host: 127.0.0.1
        user: root
        password: ""
        description: 本机 MySQL
```

### 密码不写进配置文件

用 `passwordEnv` 指定环境变量名，插件启动时从环境变量读；变量不存在会在加载时报错（不会静默变成空密码）：

```yaml
        passwordEnv: PROD_DB_PASSWORD
```

`password` 和 `passwordEnv` 同时写时以 `passwordEnv` 为准。**在设置页里保存不会破坏这种写法**——页面编辑的是原始配置，解出来的密码不会被写回文件。

### 写权限

**每个连接各自设置，默认只读。** 设置页里用下拉框选「只读」或「读写」，等价于配置文件里的 `allowWrite`。

只读有两个独立层次，都不是靠插件做字符串匹配：

1. `allowWrite: false`（默认）时 `db_execute` 直接拒绝。
2. 即使连接可写，`db_query` 的每条语句也跑在服务端强制的 `START TRANSACTION READ ONLY` 里——**由 MySQL 拒绝写入**，所以 `SELECT ... INTO OUTFILE`、`SELECT ... FOR UPDATE`、`WITH ... UPDATE` 这类绕过写法同样会被服务端拦住。

开写权限之前请确认：这个库允许 AI 改数据。多数情况下建议给插件一个只读账号，而不是开 `allowWrite`。

## 三个工具

| 工具 | 用途 |
| --- | --- |
| `db_query` | 只读查询。服务端强制只读事务；返回列名 + 行数据。 |
| `db_execute` | 写操作（INSERT/UPDATE/DELETE/DDL）。`allowWrite: true` 才可用。 |
| `db_schema` | 看结构：不传 `database` 列出所有库；传 `database` 列出表；再传 `table` 看字段、索引、DDL。 |

典型用法（你只要这么说，AI 自己会调）：

- "用 128 看看有哪些库" → `db_schema`
- "128 里 sys_user 表结构是什么" → `db_schema`
- "用 128 查一下用户表前 10 条" → `db_query`
- "把 128 里 id=1 的备注改掉" → `db_execute`（需要该连接可写）

## 每个连接可以配的项

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `name` | 必填 | 连接名，唯一，≤64 字符 |
| `host` | 必填 | 主机名或 IP |
| `user` | 必填 | 用户名 |
| `password` | `''` | 密码（明文保存在配置文件里） |
| `passwordEnv` | — | 用环境变量提供密码，优先于 `password` |
| `port` | `3306` | 端口 |
| `driver` | `mysql` | 目前只支持 `mysql` |
| `database` | — | 默认库；不配则 SQL 里要写 `库名.表名` |
| `description` | — | 显示在提示词里，给 AI 一点上下文 |
| `allowWrite` | `false` | 该连接是否可写；设置页里就是「只读 / 读写」下拉框 |
| `ssl` | `false` | 是否用 TLS 连接 |
| `connectTimeoutMs` | `10000` | 连接超时 |
| `queryTimeoutMs` | `30000` | 单条语句超时（客户端 + 服务端 `MAX_EXECUTION_TIME`） |
| `maxRows` | `200` | 单次最多返回多少行（超出会提示，不会静默截断） |
| `maxCellChars` | `500` | 单个单元格最多多少字符 |
| `maxDdlChars` | `20000` | `db_schema` 返回的表 DDL 上限，单独放宽以免建表语句被截断 |
| `connectionLimit` | `4` | 连接池大小 |

配置写错会在**插件加载时**直接报错并指出是哪一项，不会等到 AI 调用才失败。

## 安全说明

- 提示词和工具结果里**不包含密码**。
- 只读由服务端事务保证，不是关键字黑名单。
- 多语句默认关闭（`multipleStatements: false`），一条调用只能执行一条语句。
- 时间和精确数值列以字符串返回（`dateStrings`/`bigNumberStrings`），避免插件擅自解释时区或丢精度。
- 设置接口只接受**同源**写请求，并要求写请求带 `Content-Type: application/json`（跨域下这必须先通过预检，而接口不响应预检），所以别的网页无法读到或改掉你的密码。

## 设置页会写哪个文件

设置页保存时，改的是当前 profile 的 `cordis.patch.yml` 里 `id: db-connections` 那一行，页面底部会显示完整路径。写入是按文档解析后只替换这一行再序列化，所以：

- 文件里其他插件的配置**原样保留**；
- **注释也保留**，包括缩进注释和行尾注释。

如果那一行不存在（比如你把它放在别的 patch 层里），保存会新建这一行，其他内容不动。文件不是合法 YAML 时保存会直接报错，不会覆盖。

## 开发与测试

```sh
cd <path-to>/dsh-db-connections
npm install

node test-config.mjs      # 配置校验 + 加载/卸载生命周期（不需要数据库）
node test-store.mjs       # 配置文件读写 + 设置接口（不需要数据库）
node test-client.mjs      # 浏览器半身：槽位注册、inject 声明、保存载荷、校验（不需要浏览器）
node test-render.mjs      # 设置页真实渲染：下拉框、保存、测试、增删（不需要浏览器）
node test-meta.mjs        # 插件列表的显示名/描述本地化（语言文件 + 导出映射）
node test-plugin-meta.mjs # 调用 harness 自己的 readPluginMeta 验证显示元数据
node test-profile.mjs     # 包清单 + 用 harness 自己的扫描逻辑确认设置页会被加载
node test-integration.mjs # 真实连库跑三个工具和全部拒绝路径
node test-write.mjs       # 真实连库跑读写模式（自己建表、自己删表）
node test-loader.mjs      # 用真实 SystemPrompt/ToolRuntime 服务加载插件，并验证保存后立即生效
```

会连真实数据库的脚本（`test-integration` / `test-write` / `test-loader`）在文件顶部写死了连接参数，改之前先看一眼。

有两个测试跑的是 harness 的**真逻辑**，不是我的复述：

- `test-plugin-meta.mjs` 直接调用 harness 导出的 `readPluginMeta()`，也就是插件列表决定显示什么的那段代码。它有几条硬规矩（英文文件名必须正好是 `en.json`、必须能通过 export map 解析、所有语言文件必须和英文文件同目录、文件名必须是纯语言 id），**违反任何一条都会让整个元数据读取失败**，列表退回英文技术名。手写检查看不出这些。
- `test-profile.mjs` 调用 `ClientModuleRegistry.resolveMeta()`。客户端插件必须同时声明 `dsh.client` **和** `exports["./client"]`，缺后者 harness 会在启动时抛错（不是这个插件不显示，是整个启动失败）。

## 目录结构

```
dsh-db-connections/
├── index.js              # 插件入口：读配置、挂提示词、三个工具、设置接口
├── client.js             # 浏览器半身：设置页（手写 ModuleLoader bundle，无构建步骤）
├── cordis.patch.yml      # bundle 层：插入 db-connections 行
├── icon.svg              # 插件列表里的图标
├── locale/
│   ├── en.json           # 插件列表里的英文名与描述
│   └── zh.json           # 中文名与描述
├── src/
│   ├── api.js            # 设置接口：同源校验、JSON 校验、错误映射
│   ├── config.js         # 配置校验与归一化（加载时 fail loud）
│   ├── live.js           # 运行时可变连接表（保存后原地替换，无需重启）
│   ├── prompt.js         # 模型可见的连接清单（不含密码）
│   ├── registry.js       # 连接池 + 只读事务执行路径
│   ├── sql.js            # 语句分类与标识符引用
│   ├── store.js          # 读写 profile 的 cordis.patch.yml（保留注释与其他行）
│   ├── tool.js           # 原生工具定义与参数校验
│   ├── tools.js          # db_query / db_execute / db_schema
│   └── values.js         # 单元格值转无损 JSON
└── test-*.mjs
```

## 本地化是怎么接的

这个插件有两套彼此独立的本地化，分别覆盖两个不同的界面：

| 界面 | 机制 | 文件 |
| --- | --- | --- |
| 设置页内部（字段名、按钮、提示） | 客户端 locale 服务 | `client.js` 里的 `DICT`，用 `ctx.locale.register()` 注册、`ctx.locale.bind()` 取用 |
| 插件列表的**名称与描述** | 包元数据 | `locale/en.json` + `locale/zh.json`，各自一个 `meta.title` / `meta.description` |

第二套有几条硬规矩，踩中任何一条都会让列表退回英文技术名（不会报错提示）：

- 英文文件名必须**正好**是 `en.json`（harness 先找它，再扫同目录的其他 `.json` 当其他语言）。
- `package.json` 的 `exports` 必须有 `"./locale/*.json": "./locale/*.json"`，否则 harness 解析不到。
- 文件名必须是纯语言 id（`zh.json` 可以，`zh-CN.json` 也匹配，但 `zh_CN.json` 不行）。
- 所有语言文件必须和 `en.json` **在同一个目录**。
- `package.json` 的 `description` 会和英文词典一起参与回退，两者不一致会让列表显示另一种文案——`test-meta.mjs` 会检查它们一致。

要加第三种语言，就在 `locale/` 下加文件（比如 `ja.json`），不需要改代码。

## 已知限制

- 驱动只支持 MySQL / MariaDB。加 PostgreSQL 需要在 `src/config.js` 的 `SUPPORTED_DRIVERS` 和 `src/registry.js` 的池与只读路径里各加一套。
- 只读保证依赖服务端支持 `START TRANSACTION READ ONLY`（MySQL 5.6+、MariaDB 10.0+）。更老的版本应改用只读账号。
- 插件不自己读表结构缓存，每次 `db_schema` 都查 `information_schema`，所以看到的一定是当前状态。
- 客户端插件的清单在**应用启动时**扫描，所以首次安装（或新增客户端半身）后要重启一次桌面版，设置页才会出现。之后改配置、改代码都走热重载，不用再重启。
- 设置页里的「测试」按钮测的是**已经保存**的连接，因为连接池按保存的名字建。改了参数先保存再测。
- profile 以链接方式引用本目录，所以**目录不能删、不能改名、不能移动**；要换位置就先 `dsh plugin remove` 再重新 `add`。

# dsh-db-connections

[English](README.md) | 中文

给 DeepSeek Harness 用的**命名数据库连接**插件。在设置页里配好 MySQL / Doris / PostgreSQL / TDengine，之后在对话里直接用连接名（比如"用 128 查一下"），AI 就知道连哪个库、怎么查。

## 它解决什么问题

平时让 AI 查数据库，你得反复告诉它主机、端口、用户名、密码。这个插件把这些存进配置，只留一个短名字（如 `128`）给你和 AI 使用：

- 连接名会写进系统提示词，所以你说"用 128 查"AI 就能直接解析，不用你再报地址和账号。
- 三个工具都以 `connection` 作为第一个参数，AI 只需要记住名字。
- **提示词里永远不出现密码**，设置页也不回传密码；只出现引擎、默认库，以及是否可写。
- 提示词里同样**不出现地址**：只给名字、引擎和用途，不外泄你的网络拓扑。

## 安装

插件目录：`<path-to>/dsh-db-connections`

先装依赖（`mysql2` 和 `yaml`；`pg` 是可选依赖，只在真的配了 PostgreSQL 连接时才会被加载）：

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

密码是**只写**的：接口从不把已保存的密码回传给页面，所以输入框只显示"是否已设置"，并且默认是空的。留空 = 保持原密码，输入 = 替换，点「清除密码」= 清空。想让密码完全不落盘，把**密码来源**切成"环境变量"再填变量名。

设置页每张卡片还能选**数据库类型**、配 TLS（含自签证书模式），高级限制项默认收起。

### 方式二：直接改配置文件

在 profile 的 `cordis.patch.yml` 里**重定义** `db-connections` 这一行。注意 loader 是**整块替换** `config`、不做深合并，所以每个键都要写全：

```yaml
- id: db-connections
  name: "dsh-db-connections"
  config:
    connections:
      - name: "128"              # 你和 AI 在对话里用的名字
        driver: mysql            # mysql | doris | postgres | tdengine
        host: 192.0.2.10
        port: 3306               # 可选，默认值按引擎不同
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

### 支持的引擎

| `driver` | 连的是 | 默认端口 | 只读由谁保证 |
| --- | --- | --- | --- |
| `mysql` | MySQL / MariaDB | 3306 | 服务端：每条读都跑在 `START TRANSACTION READ ONLY` 里 |
| `doris` | Apache Doris（MySQL 协议） | 9030 | 插件：Doris 没有只读事务，只放行能判定为读的语句 |
| `postgres` | PostgreSQL 12+ | 5432 | 服务端：每条读都跑在 `BEGIN TRANSACTION READ ONLY` 里 |
| `tdengine` | TDengine（走 taosAdapter REST） | 6041 | 插件：TDengine 没有事务，只放行能判定为读的语句 |

各引擎需要知道的点：

- **Doris** 说的是 MySQL 协议但不是 MySQL：没有 `START TRANSACTION READ ONLY`，语句超时是 `query_timeout`（单位是**秒**），索引信息在老版本里可能查不到。
- **PostgreSQL** 没有 `SHOW CREATE TABLE`，所以 `db_schema` 的 DDL 是从系统目录拼出来的（结果里会说明）；一个连接只属于一个库，所以 `database` 填的是 **schema**；时间类型按服务端原文返回，不会被转成带时区的 JS 日期。
- **TDengine** 的 REST 是无状态的，`USE db` 没有意义：填了 `database` 插件会把它放进请求路径，访问别的库要写 `库名.表名`。`db_schema` 会区分超级表（`STABLE`）和子表（备注里写父表名）。查询既没有 `ts` 范围也没有 INTERVAL 窗口时会附带提醒，因为它可能扫全表。
- 引擎本身没有服务端只读能力的连接（Doris、TDengine），建议再配一个**只读账号**：那里的语句分类是一道闸门，不是服务端给的保证。

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

用 `passwordEnv` 指定环境变量名，插件启动时从环境变量读。**变量不存在不会让插件加载失败**：这个连接会被标记为"本机不可用"，并在提示词、日志和设置页三处说明原因——因为加载失败会连设置页一起打不开，而那是唯一能看到原因的地方。

```yaml
        passwordEnv: PROD_DB_PASSWORD
```

`password` 和 `passwordEnv` 同时写时以 `passwordEnv` 为准。**在设置页里保存不会破坏这两种写法**：页面编辑的是原始配置，接口会把没动过的密码从已存条目里带过来，而响应里本来就没有密码值。现在也可以在页面上直接建这个间接引用——把**密码来源**选成"环境变量"。

### 写权限

**每个连接各自设置，默认只读。** 设置页里用下拉框选「只读」或「读写」，等价于配置文件里的 `allowWrite`。

只读分几层，具体生效哪几层取决于引擎：

1. `allowWrite: false`（默认）时 `db_execute` 直接拒绝。
2. `db_query` 会拒绝所有能判定为写的语句、所有会话/管理类语句（`SET`、`USE`、事务控制），以及任何包含多条语句的字符串——这一层与引擎无关。
3. **MySQL 和 PostgreSQL** 还会在服务端拒绝：每条读都包在只读事务里，所以 `SELECT ... INTO OUTFILE`、`SELECT ... FOR UPDATE`、`WITH ... UPDATE` 这类绕过写法由数据库自己拦住。
4. **Doris 和 TDengine** 没有这种事务，所以插件判定不了的语句一律拒绝（提示"could not be classified"），不做猜测。这也是这两个引擎更建议配只读账号的原因：分类是闸门，不是服务端能兜底的保证。

开写权限之前请确认：这个库允许 AI 改数据。多数情况下建议给插件一个只读账号，而不是开 `allowWrite`。

### 审计日志（可选）

既然允许写，就值得留痕。加上 `audit` 后，每次 `db_execute` 都会追加一行 JSON：时间、连接名、引擎、语句（有长度上限）、影响行数、耗时、是否成功：

```yaml
- id: db-connections
  name: "dsh-db-connections"
  config:
    audit:
      path: .dsh-db/audit.jsonl   # 相对路径按 profile 目录解析
      maxSqlChars: 512            # 可选
    connections: []
```

失败的语句也会记录，并带上错误信息。记录里永远不含密码。

## 三个工具

| 工具 | 用途 |
| --- | --- |
| `db_query` | 只读查询。返回列名 + 行数据，可按 `table`/`csv`/`json` 渲染。 |
| `db_execute` | 写操作（INSERT/UPDATE/DELETE/DDL）。`allowWrite: true` 才可用；配了审计就每次留痕。 |
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
| `driver` | `mysql` | `mysql`、`doris`、`postgres`、`tdengine` |
| `host` | 必填 | 主机名或 IP |
| `user` | 必填 | 用户名 |
| `password` | `''` | 密码（明文保存在配置文件里） |
| `passwordEnv` | — | 用环境变量提供密码，优先于 `password` |
| `port` | 按引擎 | 端口（3306 / 9030 / 5432 / 6041） |
| `database` | — | 默认库（PostgreSQL 填 schema；TDengine 进请求路径）；不配则 SQL 里要写 `库名.表名` |
| `description` | — | 显示在提示词里，给 AI 一点上下文 |
| `allowWrite` | `false` | 该连接是否可写；设置页里就是「只读 / 读写」下拉框 |
| `ssl` | `false` | `true`，或映射：`ca`、`cert`、`key`、`pfx`、`passphrase`、`servername`、`rejectUnauthorized` |
| `connectTimeoutMs` | `10000` | 连接超时 |
| `queryTimeoutMs` | `30000` | 单条语句超时（客户端，加上引擎自己的限制） |
| `maxRows` | `200`（TDengine 为 `50`） | 单次最多返回多少行（超出会提示，不会静默截断） |
| `maxCellChars` | `500` | 单个单元格最多多少字符 |
| `maxDdlChars` | `20000` | `db_schema` 返回的表 DDL 上限，单独放宽以免建表语句被截断 |
| `maxResultChars` | `32000` | 单次结果渲染的字符上限（被截断时会说明） |
| `connectionLimit` | `4` | 连接池大小（MySQL、PostgreSQL；TDengine 的 REST 不保持连接） |

配置写错会在**插件加载时**直接报错并指出是哪一项，不会等到 AI 调用才失败。唯一的例外是 `passwordEnv` 指向本机没设的变量：那种情况只把那一个连接标为不可用，好让设置页仍然能打开。

## 安全说明

- 密码不出现在提示词、工具结果和接口响应里：设置页只知道"是否已设置"和"来源是什么"，拿不到值。
- 没动过的密码能在保存后保留，因为载荷里直接不带这个字段；显式传空字符串才会清空。
- 配置文件写入时权限收紧为 `0600`（仅本人可读写），因为它存的是凭据。
- 只读优先由引擎自己的只读事务保证；引擎没有这种事务时，由插件的语句分类兜住，分类不了的一律拒绝。
- 每次调用只允许一条语句，任何引擎都一样：`SELECT ...; DROP TABLE ...` 这种夹带不会被执行。
- 时间和精确数值列按原样字符串返回，插件不擅自解释时区或丢精度——在 PostgreSQL 上这意味着覆盖 `pg` 的日期解析器。
- 设置接口只接受**同源**请求（读也一样），并要求写请求带 `Content-Type: application/json`（跨域下这必须先通过预检，而接口不响应预检）。
- 写请求可以带上它读到的文件修订号；如果这期间命令行或别的插件改过这个文件，保存会以 **409** 拒绝，而不是把对方的改动覆盖掉。

## 设置页会写哪个文件

设置页保存时，改的是当前 profile 的 `cordis.patch.yml` 里 `id: db-connections` 那一行，页面底部会显示完整路径。写入是按文档解析后只替换这一行再序列化，所以：

- 文件里其他插件的配置**原样保留**；
- **注释也保留**，包括缩进注释和行尾注释。

如果那一行不存在（比如你把它放在别的 patch 层里），保存会新建这一行，其他内容不动。文件不是合法 YAML 时保存会直接报错，不会覆盖。

## 开发与测试

```sh
cd <path-to>/dsh-db-connections
npm install
npm test                  # 跑下面全部套件，每个一行结论
```

需要本机缺东西的套件（数据库、harness 运行时、装好的 profile）会打印 `SKIP` 和原因，而不是判失败。

```sh
node test-drivers.mjs     # 语句分类、单语句约束、标识符引用、各驱动的映射函数
node test-registry.mjs    # 行数上限、单元格转换、输出格式、只读策略、审计挂钩（用替身驱动）
node test-settings.mjs    # 脱敏与密码在页面/存储之间的继承
node test-store.mjs       # 配置文件读写、修订号冲突、文件权限、设置接口
node test-audit.mjs       # 审计开关、记录结构、语句长度上限
node test-config.mjs      # 配置校验 + 加载/卸载生命周期
node test-client.mjs      # 浏览器半身：槽位注册、inject 声明、保存载荷、校验
node test-render.mjs      # 设置页真实渲染：选择器、保存、测试、增删
node test-meta.mjs        # 插件列表的显示名/描述本地化（语言文件 + 导出映射）
node test-plugin-meta.mjs # 调用 harness 自己的 readPluginMeta 验证显示元数据
node test-profile.mjs     # 包清单 + 用 harness 自己的扫描逻辑确认设置页会被加载
node test-loader.mjs      # 用真实 SystemPrompt/ToolRuntime 服务加载插件，并验证保存后立即生效
node test-integration.mjs # 真实 MySQL：三个工具、schema、输出格式、全部拒绝路径
node test-write.mjs       # 真实 MySQL：读写模式 + 审计日志（自己建表、自己删表）
```

需要额外环境变量的套件：

| 变量 | 用于 | 含义 |
| --- | --- | --- |
| `DSH_RUNTIME_MODULES` | `test-loader`、`test-profile`、`test-plugin-meta` | harness 自己的 `@deepseek-ai` 包目录（桌面版自带一个） |
| `DSH_PROFILE_DIR` | `test-loader`、`test-profile` | profile 目录；`test-loader` 会自己建临时目录 |
| `DSH_PROFILE_BASE` | `test-plugin-meta` | 装了本插件的 profile 的 `file://` 地址 |
| `DB_TEST_HOST` / `DB_TEST_PORT` / `DB_TEST_USER` / `DB_TEST_PASSWORD` / `DB_TEST_DATABASE` | `test-integration`、`test-write` | 要测的 MySQL（默认 `127.0.0.1:3306`、`root`、空密码、`test` 库） |

有两个测试跑的是 harness 的**真逻辑**，不是我的复述：

- `test-plugin-meta.mjs` 直接调用 harness 导出的 `readPluginMeta()`，也就是插件列表决定显示什么的那段代码。它有几条硬规矩（英文文件名必须正好是 `en.json`、必须能通过 export map 解析、所有语言文件必须和英文文件同目录、文件名必须是纯语言 id），**违反任何一条都会让整个元数据读取失败**，列表退回英文技术名。手写检查看不出这些。
- `test-profile.mjs` 调用 `ClientModuleRegistry.resolveMeta()`。客户端插件必须同时声明 `dsh.client` **和** `exports["./client"]`，缺后者 harness 会在启动时抛错（不是这个插件不显示，是整个启动失败）。

## 目录结构

```
dsh-db-connections/
├── index.js              # 插件入口：读配置、挂提示词、三个工具、设置接口、审计
├── client.js             # 浏览器半身：设置页（手写 ModuleLoader bundle，无构建步骤）
├── cordis.patch.yml      # bundle 层：插入 db-connections 行
├── icon.svg              # 插件列表里的图标
├── run-tests.mjs         # 跑全部套件并汇总
├── tests-support.mjs     # 共用前置条件（skip、TCP 探测、导入 harness 包）
├── locale/
│   ├── en.json           # 插件列表里的英文名与描述
│   └── zh.json           # 中文名与描述
├── src/
│   ├── api.js            # 设置接口：同源校验、JSON 校验、脱敏、冲突映射
│   ├── audit.js          # 可选：写操作的 JSONL 审计日志
│   ├── config.js         # 配置校验与归一化（加载时 fail loud）
│   ├── errors.js         # 各驱动共用的网络错误与只读拒绝翻译
│   ├── live.js           # 运行时可变连接表（保存后原地替换，无需重启）
│   ├── prompt.js         # 模型可见的连接清单（不含密码，也不含地址）
│   ├── registry.js       # 与引擎无关的只读策略、行数上限、审计挂钩
│   ├── settings.js       # 设置页的脱敏与密码继承
│   ├── sql.js            # 分方言的语句分类、单语句约束、标识符引用
│   ├── store.js          # 读写 profile 的 cordis.patch.yml（保留注释、其他行、修订号）
│   ├── tool.js           # 原生工具定义、参数校验、结果渲染
│   ├── tools.js          # db_query / db_execute / db_schema
│   ├── values.js         # 单元格值转无损 JSON
│   └── drivers/
│       ├── index.js      # 驱动目录 + 工厂（新增引擎只改这一处）
│       ├── mysql.js      # MySQL 与 Doris（同一协议，不同的保证）
│       ├── postgres.js   # PostgreSQL（用 `pg`，首次使用时才加载）
│       └── tdengine.js   # TDengine（走 taosAdapter REST）
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

- **两种引擎没有服务端只读能力。** Doris 和 TDengine 上，`db_query` 会拒绝一切判定不了是读的语句，这道分类就是闸门。这两个连接建议配只读账号，才有真正能依赖的强制力。
- **PostgreSQL 需要 12+**：`db_schema` 会读 `attgenerated`，更老的版本没有这一列。
- **PostgreSQL 的 DDL 是拼出来的**，不是原文：服务端不提供原始建表语句，所以 `db_schema` 用系统目录（列、默认值、主键、服务端自己的索引定义）重建，结果里会说明。
- **TDengine 的 REST 不保持会话**，`USE db` 没有意义：默认库来自连接配置，访问其他库必须写全 `库名.表名`。
- `pg` 是可选依赖：不用 PostgreSQL 的部署不需要它；真的缺了，PostgreSQL 驱动会把安装命令写在错误信息里。
- 插件不自己缓存表结构，每次 `db_schema` 都查引擎目录，所以看到的一定是当前状态。跨连接的"按表名搜索"没有实现，AI 会按连接逐个看。
- 客户端插件的清单在**应用启动时**扫描，所以首次安装（或新增客户端半身）后要重启一次桌面版，设置页才会出现。之后改配置、改代码都走热重载，不用再重启。
- 设置页里的「测试」按钮测的是**已经保存**的连接，因为驱动按保存的名字建。改了参数先保存再测。
- profile 以链接方式引用本目录，所以**目录不能删、不能改名、不能移动**；要换位置就先 `dsh plugin remove` 再重新 `add`。
- 设置页保存时整份 `connections` 列表一起替换。两个人同时改不同连接由修订号串行化（后到的拿到 409 并需重新加载），不是自动合并。

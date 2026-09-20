# 更新日志

本文件记录所有值得注意的变更。
格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.2.0] - 2026-09-20

这一版动的是存储层。目标是让**访问量不再影响短链定义的写入成本**。

### 变更（架构）

- **访问计数与短链定义彻底拆开。** 1.1.x 把 `hits` / `lastHitAt` 直接存在每条 link 里，
  于是一次扫码就让整份文档变脏，默认 5 秒落盘一次——2 万条短链就是每 5 秒重写 6 MB。
  现在三条线各走各的：

  | 文件 | 内容 | 写入时机 | 成本 |
  |---|---|---|---|
  | `links.json` | 短链定义 | 只在增 / 删 / 改时 | 与访问量无关 |
  | `links.hits.log` | 计数增量，一行一次扫码 | 默认每 1 秒追加一批 | 约 26 字节/次，**与短链总数无关** |
  | `links.stats.json` | 计数快照 | 默认每 5 分钟压实 | 与被扫过的条数成正比 |

  实测（2 万条短链 + 1 万次扫码）：定义文件重写 **0 次**，磁盘总写入从约 122 MB
  降到约 257 KB。最坏情况（2 万条全被扫过）快照 1.7 MB、每 5 分钟一次。

- **崩溃恢复改用单调命中序号 `seq`，不再用日志字节偏移。** 快照记下已并入的
  `appliedSeq`，加载时只回放比它大的日志行，因此「清空日志」这一步崩在哪都不会
  重复计数或丢计数。`kill -9` 最多丢最后一次追加（默认 1 秒）以内的扫码量，
  正常 `SIGTERM` 退出一点都不丢。
  （实现过程中先写过字节偏移的版本，被测试抓出来是错的：日志一旦被清空，偏移就从 0
  重新开始，无法与新写入的行区分，会把新命中误判成已计入。）

- **数据文件升到 v2 并自动迁移。** 读入 1.1.x 的文件时，记录里的 `hits` / `lastHitAt`
  会被搬到计数存储，定义文件随即改写为 v2。老文件不用手工处理。

- **自定义存储分成两档，升级不用改代码。** 只实现 `load` / `save` 的适配器照常工作
  （`inline` 模式，计数内联在 `db.counts`，行为与 1.1.x 一致）；额外实现 `counters`
  即为 `separate` 模式，拿到全部收益。

### 新增

- `app.counters`：计数管理器，可查 `mode` / `tracked` / `pending` / `seq` / `journalBytes`。
- 配置项 `trackHits`（不需要统计就设 `false`，零计数 I/O）、`hitAppendIntervalMs`、
  `hitCompactIntervalMs`、`hitJournalMaxBytes`。
- 导出 `counters.memoryBackend` / `counters.fileBackend` 作为自定义后端的参考实现，
  以及 `DB_VERSION`。
- **分页不再全量排序**：内存里维护创建顺序索引，不带搜索词的 `page()` 代价只和本页
  条数有关（5 万条实测 0.07 ms，对比 `list()` 全量遍历 44 ms）。

### 修复

- 命令行的帮助文本里，文档链接原本硬编码为仓库根地址；本包已移入仓库的
  `oss-shortlink/` 子目录，该链接会指向错误位置。改为读取 `package.json` 的
  `homepage`，缺失时回退到 npm 包页面。

### 兼容性

- **对外 API 形状不变**：`LinkRecord` 仍然带 `hits` / `lastHitAt`（读取时合并），
  `links` 的各个方法、`app.snapshot()`、HTTP 端点与统计口径都不变。
- **磁盘格式变了（v2），迁移是单向的**：升级无需操作；要降级回 1.1.x 会丢掉计数
  （短链定义不受影响，`links.json` 本身仍是合法 JSON 且能被 1.1.x 读）。保险起见
  升级前把整个 `data/` 目录备份一份。

## [1.1.0] - 2026-09-20

这一版修的是「装完之后到底能不能当包用」，以及几个只在真实流量下才暴露的问题。

### 修复

- **命令行读不到用户的配置和数据（本次最重要的一条）**：`oss-shortlink` 与
  `oss-shortlink-qr` 此前都以**包目录**为基准，配置、数据、二维码输出全落在
  `node_modules/oss-shortlink/` 里面。用户在自己项目里放好的 `config.json` 和
  `data/links.json` 完全读不到，`oss-shortlink-qr` 会回一句「没有可生成的短链」并以
  退出码 0 结束，同时在 `node_modules` 里凭空创建一个空的数据文件。
  现在统一以**当前工作目录**为基准，并支持 `--config` / `--data`
  （以及 `CONFIG_FILE` / `DATA_FILE`），两个命令共用同一套路径解析。
- **`oss-shortlink-qr` 没有任何办法指定配置路径**：`CONFIG_FILE` 只被 `cli.js` 读取，
  二维码命令里根本没有这个逻辑。现已补齐，并加了 `--out` / `--size` 的取值校验。
- **超过 64 KB 的请求体客户端收到的是连接被重置**：`readJsonBody()` 在超限时先
  `req.destroy()` 再想返回 413，socket 已经被拆掉，响应根本发不出去，
  调用方只看到 `ECONNRESET / socket hang up`。现在改为停住读取、正常回 413，
  并声明 `Connection: close`（避免剩余请求体被当作下一个请求解析）。
- **`test/` 没进 `files`**：README 让用户跑 `npm test`，但发布出去的包里没有 `test/`，
  装完必然 `MODULE_NOT_FOUND`。已加入 `files`，现在装机后 `npm test` 可以直接跑
  （134 项断言全过）。
- **`STREAM_MODE` 环境变量只在帮助文档里存在**：1.0.1 的 `--help` 把它列在环境变量里，
  但 `applyEnv()` 从未处理过它。现已实现；取值非法时保留配置文件里的原值，
  而不是悄悄改成 `redirect`。
- **`oss.endpoint` 是死配置**：`normalize()`、`index.d.ts`、`config.example.json`
  都定义了它，签名逻辑却从不读取。已从三处一并移除
  （已有配置里的这个键会被忽略，不影响启动）。
- **`/healthz` 和 `stats()` 每次都要排一遍全量记录**：为了拿一个长度调用了
  `links.list().length`，2 万条时单次 5.4 ms。改用 `links.count()`，O(1)。
- **短码生成有取模偏差**：`256 % 55 = 36`，直接 `buf[i] % 55` 会让字符集前 36 个字符
  各多出 1/256 的概率（实测最高与最低频次差约 10%）。改用拒绝采样。

### 变更

- **`GET /api/links` 默认分页**（破坏性）：默认返回 200 条，响应新增 `total` / `offset` /
  `limit` 字段，并支持 `q` 关键词搜索。依赖「一次拿全量」的调用请显式传 `limit=0`。
- **管理台不再把密钥拼在 URL 里**：`/admin?key=...` 现在会换成 HttpOnly + SameSite=Strict
  的会话 cookie，然后 302 到 `/admin`。密钥不再出现在后续请求、浏览器历史和
  下游代理的访问日志里。`X-Admin-Key` 请求头与 `?key=` 查询参数仍然可用。
- **`configFile` 不再回退到同目录的 `config.example.json`**：文件不存在时直接抛
  `code='CONFIG_NOT_FOUND'`。之前那种「猜一个文件来读」的行为会让人以为自己改的配置
  生效了，其实跑的是示例文件。`config.loadFromDisk()` 保留旧行为，但已标记 deprecated。
- **新增 `oss-shortlink init`**：复制示例配置到当前目录并生成一个随机 `adminKey`，
  省掉「随便想个长随机串」这一步。

### 新增

- **安全响应头**：`X-Content-Type-Options`、`Referrer-Policy`、
  `X-Frame-Options`（播放页 `SAMEORIGIN`、管理台 `DENY`）、
  以及 CSP（`default-src 'none'` + `frame-ancestors`，播放页与 404 页分别收紧），
  公网前缀是 https 时额外下发 HSTS。
- **管理接口限速**：同一 IP 连续 10 次密钥错误后返回 `429` + `Retry-After`，
  5 分钟窗口；验证成功即清零。
- **`links.page({limit, offset, q})`** 与 **`links.count()`**；类型定义同步补齐。

## [1.0.1] - 2026-09-20

发布后实测消费者路径时发现的可用性缺陷，全部与命令行有关。

### 修复

- **命令行缺 `--help`**：`oss-shortlink` 与 `oss-shortlink-qr` 此前完全不支持帮助参数，
  首次使用者敲 `--help` 只会看到服务被闷声启动。现在两者都输出完整的用法、选项、环境变量与前置条件说明。
- **未知参数被静默忽略**：`oss-shortlink` 收到不认识的参数会直接尝试启动服务。现在会明确报错并提示查看帮助，退出码 1。
- **`oss-shortlink-qr` 的帮助依赖可选包**：`qrcode` 此前在模块顶层加载，
  没装这个可选依赖时连 `--help` 都跑不起来。改为按需加载，帮助信息始终可读。

### 新增

- **`--version`**：`oss-shortlink --version` 输出当前版本号。

## [1.0.0] - 2026-09-20

首个正式版本。

### 新增

- **可编程接口**：`createShortlink(options)` 返回 app 实例，暴露 `links` 管理器、`handler`、`listen`、`attach`、`snapshot`、`stats`、`save`、`close`。
- **存储适配器**：`memoryStore()`、`fileStore(path)`、`customStore(obj)`，可接数据库或外部持久化。
- **同域 H5 播放页**：二维码里只出现自己的域名，扫码后不暴露对象存储地址。
- **两种取流模式**：`redirect`（302 直跳，服务器零带宽）与 `proxy`（服务端代理，源站彻底隐形）。
- **OSS 私有读签名**：`signedRead` 开关，每次取流现签短时效地址。
- **管理台与管理 API**：新建、查询、换源、启停、删除，按密钥鉴权。
- **扫码统计**：每条短链累计访问次数与最后访问时间。
- **命令行**：`oss-shortlink` 启动服务、`oss-shortlink-qr` 批量生成二维码。
- **内嵌支持**：`app.handler` 可直接挂到已有 Node HTTP 服务上。
- **类型定义**：随包提供 `index.d.ts`。
- **测试**：SDK 接口层与 HTTP 端点层两套自检，共 100 余项断言。

### 说明

- 运行时零依赖，仅需 Node 18+。`qrcode` 为可选依赖，只在生成二维码时使用。
- 从早期单体 `server.js` 版本升级：`node server.js` 仍可用，行为不变。

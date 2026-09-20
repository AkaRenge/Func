# 更新日志

本文件记录所有值得注意的变更。
格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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

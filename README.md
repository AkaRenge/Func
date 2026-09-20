# oss-shortlink

[![npm version](https://img.shields.io/npm/v/oss-shortlink.svg?color=cb3837)](https://www.npmjs.com/package/oss-shortlink)
[![npm downloads](https://img.shields.io/npm/dm/oss-shortlink.svg)](https://www.npmjs.com/package/oss-shortlink)
[![license](https://img.shields.io/npm/l/oss-shortlink.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/oss-shortlink.svg)](./package.json)

把对象存储上的视频包成**短链 + 同域 H5 播放页**，让扫码的人全程只看到你自己的域名。

二维码印出去之后想换视频？改后台映射就行，码不用重印。

- **可编程**：`createShortlink()` 拿到 app 实例，直接建短链、换源、读统计；也能作为中间件挂到已有 Node 服务上。
- **零运行时依赖**：只用 Node 内置模块，不需要数据库、不需要 Redis。
- **两种取流**：默认 302 直跳对象存储（服务器零带宽），可切换服务端代理让源站彻底隐形。
- **可插拔存储**：内存 / JSON 文件 / 自定义适配器（接 MySQL、Redis、对象存储都行）。

---

## 它解决什么

裸的 OSS 直链，扫码时有三层暴露面：

| 层次 | 裸 OSS 直链 | 本 SDK |
|---|---|---|
| 扫一扫识别出的内容 | 一长串带签名的地址 | `https://v.你的域名/v/Ab3xK9` |
| 地址栏 / 网页由…提供 | `aliyuncs.com` | `v.你的域名` |
| 视频文件真实地址 | 直接可见 | 默认走 302 仍可见，可切换为代理模式隐藏 |
| 二维码有效期 | 公共读则永久 | 永久，且可随时撤销 |
| 扫码统计 | 无 | 每个短码累计次数与最后访问时间 |

---

## 安装

```bash
npm install oss-shortlink
```

要求 Node 18 或以上。生成二维码需要可选依赖 `qrcode`：

```bash
npm install qrcode
```

---

## 快速开始

### 作为 SDK 使用

```js
const { createShortlink, memoryStore } = require('oss-shortlink');

const app = await createShortlink({
  publicBaseUrl: 'https://v.example.com',
  adminKey: '换成你自己的长随机串',
  brand: '你的品牌',
  store: memoryStore()
});

const { code, shareUrl } = app.links.create({
  title: '产品介绍',
  desc: '三分钟看懂我们的方案',
  videoUrl: 'https://你的bucket.oss-cn-hangzhou.aliyuncs.com/video/intro.mp4'
});

console.log(shareUrl);   // https://v.example.com/v/Ab3xK9
app.listen(3000);
```

就这么多。扫码的人看到的是 `v.example.com`，视频从 OSS 流过去，流量不经过你的服务器。

### 先跑一下 demo 看效果

```bash
git clone <本仓库> && cd oss-shortlink
node examples/minimal-demo.js
```

demo 用内存存储起一个真实服务，自动跑一轮验证，然后把播放页和管理台的地址打给你手动点开：

```
  [4] 结果：11 项通过，没有失败

  服务保持运行，下面两个地址可以直接点开看：

    播放页    http://127.0.0.1:3080/v/f75p5b
    管理台    http://127.0.0.1:3080/admin?key=demo-admin-key-xxxxxxxx
```

想换成自己的视频：`DEMO_VIDEO=https://... node examples/minimal-demo.js`。

### 作为独立服务部署

```bash
cp config.example.json config.json   # 改 publicBaseUrl、adminKey、brand
npm start                            # 等价于 node bin/cli.js
```

---

## API 参考

### `createShortlink(options)`

返回 `Promise<ShortlinkApp>`。

| 选项 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `publicBaseUrl` | string | `http://127.0.0.1:<port>` | 对外前缀，影响 shareUrl 与绝对地址 |
| `adminKey` | string | — | 管理密钥。不填则管理相关端点返回 503 |
| `store` | Store \| string | 内存 | 存储适配器，或直接给文件路径 |
| `dataFile` | string | — | 便捷写法，等价于 `store: fileStore(dataFile)` |
| `port` / `host` | number / string | `3000` / `127.0.0.1` | 监听地址 |
| `codeLength` | number | `6` | 自动短码长度，4-16 |
| `brand` | string | — | 播放页品牌名 |
| `footerText` | string | — | 播放页底部补充文字 |
| `streamMode` | `'redirect' \| 'proxy'` | `'redirect'` | 取流方式 |
| `oss` | object | — | 见下方 OSS 签名 |
| `viewDir` | string | 内置 `views/` | 替换整套模板目录 |
| `templates` | object | — | 只覆盖个别模板，如 `{'player.html': '...'}` |
| `logRequests` | boolean | `true` | 是否打印访问日志 |
| `flushIntervalMs` | number | `5000` | 落盘间隔，0 表示不定时落盘 |
| `log` | function | console.log | 自定义日志 |
| `now` | function | Date.now | 时间源，便于测试 |

### `app`

| 成员 | 说明 |
|---|---|
| `app.config` | 规整后的配置（已补默认值、已校正类型） |
| `app.links` | 短链管理器 |
| `app.handler(req, res)` | 请求处理器，可挂到任意 Node HTTP 服务 |
| `app.listen(port?, host?)` | 起服务，返回原生 `http.Server` |
| `app.attach(server)` | 接管已有 server 的请求 |
| `app.snapshot()` | 数据深拷贝，用于断言或备份 |
| `app.stats()` | 记录数、取流模式、签名状态、存储类型 |
| `app.save()` | 立即落盘 |
| `app.close()` | 停定时器、关服务、落盘。可重复调用 |

### `app.links`

```js
app.links.create({ videoUrl, title?, desc?, cover?, mode?, code? })
// → { code, shareUrl, link }

app.links.get(code)               // → LinkRecord | undefined
app.links.require(code)           // → LinkRecord，不存在抛 status=404
app.links.has(code)               // → boolean
app.links.update(code, patch)     // → LinkRecord
app.links.remove(code)            // → boolean，重复删除返回 false 不报错
app.links.list()                  // → LinkRecord[]，按创建时间倒序
app.links.touch(code)             // 记一次访问，返回 LinkRecord | null
app.links.shareUrl(code)          // → string
```

`LinkRecord` 字段：`code` `title` `desc` `videoUrl` `cover` `mode` `enabled` `createdAt` `updatedAt` `hits` `lastHitAt`。

非法参数（比如 `videoUrl` 不是 http/https）会抛带 `status = 400` 的错误。

---

## 存储适配器

```js
const { memoryStore, fileStore, customStore } = require('oss-shortlink');

// 进程退出即丢，适合 demo 和测试
store: memoryStore()

// JSON 文件，原子写入，适合单机部署
store: fileStore('./data/links.json')

// 接你自己的数据库
store: customStore({
  async load() { return JSON.parse(await redis.get('shortlink:db') || 'null'); },
  async save(db) { await redis.set('shortlink:db', JSON.stringify(db)); }
})
```

只要 `load()` 返回 `{ version, links }` 结构、`save(db)` 落盘即可。
`load()` 返回 `null` 也没关系，会自动初始化为空库。

---

## 命令行

```bash
oss-shortlink              # 读 config.json 启动服务
oss-shortlink-qr           # 为全部启用中的短链生成二维码
oss-shortlink-qr Ab3xK9 --size 900 --out ./qr
```

也可以直接 `npm start` / `npm run qr`。

---

## 必须做的 OSS 配置（防盗链）

不做这步，别人拿到视频地址就能白嫖你的流量。

阿里云 OSS 控制台 → 你的 Bucket → **数据安全 → 防盗链**：

| 项 | 设置 |
|---|---|
| Referer 白名单 | 填 `https://v.你的域名`（只填域名，不带路径） |
| 允许 Empty Referer | **关闭**（关掉后直接粘 URL 到浏览器会 403） |
| 是否允许 Referer 带查询参数 | 允许 |

配好后：从你的播放页播放 → 带 Referer → 放行；别人直接粘 URL → 空 Referer → 403。

> 极少数老旧安卓播放器不带 Referer。遇到个别机型播不了，可临时打开「允许 Empty Referer」观察，确认没有盗链再关回去。

---

## 部署到服务器

### 1. 进程守护

```bash
npm install -g pm2
pm2 start bin/cli.js --name oss-shortlink
pm2 save && pm2 startup
```

### 2. nginx 反向代理

```nginx
server {
    listen 443 ssl http2;
    server_name v.example.com;

    ssl_certificate     /etc/nginx/ssl/v.example.com.pem;
    ssl_certificate_key /etc/nginx/ssl/v.example.com.key;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_buffering off;      # 用 proxy 取流模式时建议关掉
        proxy_read_timeout 300s;
    }
}

server {
    listen 80;
    server_name v.example.com;
    return 301 https://$host$request_uri;
}
```

必须是 **HTTPS + 已备案域名**，否则微信里会弹安全提示。

---

## 进阶

### 让 OSS 地址也彻底隐形

默认 302 模式里，按 F12 仍能看到真实 OSS 地址。两种方式可以藏掉：

**方式一：服务端代理**（简单，吃服务器带宽）

```js
await createShortlink({ streamMode: 'proxy', /* ... */ });
```

所有视频流量改为经你的服务器转发，客户端全程只看到你的域名。
代价是并发观看会占你的出网带宽 —— 视频不大、人数不多时很划算。

**方式二：私有读 + 实时签名**（推荐，零额外带宽）

```js
await createShortlink({
  oss: {
    signedRead: true,
    bucket: '你的bucket',
    accessKeyId: 'RAM 子账号的 AK',
    accessKeySecret: '...',
    signTtlSeconds: 300
  }
});
```

Bucket 读写权限改为**私有**，之后每次取流服务端会现签一个 5 分钟有效的地址。
扒到了也很快失效。

> 这个 AccessKey 请用**只有该 Bucket 只读权限的 RAM 子账号**，不要用主账号密钥。

### 内嵌到已有服务

```js
const http = require('http');

const app = await createShortlink({ /* ... */ });

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/my-api')) return handleMyApi(req, res);
  app.handler(req, res);          // 其余请求交给 SDK
});
server.listen(3000);
```

---

## 测试

```bash
npm test              # SDK 接口层 + HTTP 端点层，共 132 项断言
npm run test:sdk      # 只跑接口层，不起服务
npm run test:http     # 只跑端点层
```

两套测试都是零依赖、进程内起服务，跑完自动释放资源。

---

## 目录结构

```
oss-shortlink/
├── src/
│   ├── index.js         SDK 主入口
│   ├── server.js        createShortlink 组装
│   ├── router.js        路由与 HTTP 处理
│   ├── links.js         短链管理器
│   ├── store.js         存储适配器
│   ├── config.js        配置规整
│   ├── render.js        模板渲染
│   ├── codes.js         短码生成
│   └── oss.js           OSS 签名
├── views/               播放页 / 管理台 / 404
├── bin/
│   ├── cli.js           命令行启动
│   └── gen-qrcode.js    批量生成二维码
├── examples/minimal-demo.js
├── test/                自检用例
├── index.d.ts           类型定义
└── config.example.json
```

---

## 常见问题

**微信提示「已停止访问该网页」？**
域名没备案，或被举报进黑名单。备案 + HTTPS 是前提。

**视频画面要等很久才出来？**
mp4 建议先重排 moov 原子，否则要下完整个文件才能播：

```bash
ffmpeg -i in.mp4 -c copy -movflags +faststart out.mp4
```

编码建议 H.264 + AAC。

**换了视频，二维码要重印吗？**
不用。`app.links.update(code, { videoUrl })` 或管理台改一下即可，短码不变。

**能用 SQLite / MySQL 存吗？**
可以。用 `customStore()` 包一层就行，SDK 不关心你怎么存。

**要统计更细的数据（来源、地域）？**
`LinkRecord` 已经记了累计次数和最后访问时间。要更细的埋点在 `touch` 调用处扩展，
或自己写一个中间件统计 `req.headers`。

**必须用 Redis 或数据库吗？**
不必。默认的文件存储够单机用到几十万条。

---

## License

MIT

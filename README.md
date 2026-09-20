# Func

一个存放可复用工具与 SDK 的仓库，每个项目独立成目录、独立发布。

## 子项目

| 目录 | 包名 | 说明 |
|---|---|---|
| [`oss-shortlink/`](./oss-shortlink) | [`oss-shortlink`](https://www.npmjs.com/package/oss-shortlink) | 把对象存储上的视频包成短链 + 同域 H5 播放页，扫码者全程只看到自己的域名 |

## 目录约定

- 每个子项目在自己的目录内自成一体：独立的 `package.json`、测试、README
- 第三方依赖只装在子项目内，仓库根不放 `node_modules`
- 发布用 `npm publish` 在对应子目录执行

## 许可

各子项目以其目录内 `LICENSE` 为准，目前均为 MIT。

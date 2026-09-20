#!/usr/bin/env node
'use strict';

/**
 * 向后兼容入口。等价于 `oss-shortlink` 命令（bin/cli.js）。
 *
 * 推荐改用：npm start  或  node bin/cli.js
 * 想在代码里嵌入使用，见 src/index.js 的 createShortlink。
 */

require('./bin/cli.js');

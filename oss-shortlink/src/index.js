'use strict';

/**
 * oss-shortlink —— 把对象存储上的视频包成短链 + 同域 H5 播放页。
 *
 * 最小用法：
 *
 *   const { createShortlink, memoryStore } = require('oss-shortlink');
 *
 *   const app = await createShortlink({
 *     publicBaseUrl: 'https://v.example.com',
 *     adminKey: 'a-long-random-string',
 *     store: memoryStore()
 *   });
 *
 *   app.links.create({ title: '产品介绍', videoUrl: 'https://bucket.oss.../a.mp4' });
 *   app.listen(3000);
 */

const serverLib = require('./server');
const storeLib = require('./store');
const configLib = require('./config');
const codesLib = require('./codes');
const ossLib = require('./oss');
const linksLib = require('./links');
const countersLib = require('./counters');
const renderLib = require('./render');
const routerLib = require('./router');

const pkg = require('../package.json');

module.exports = {
  // 主入口
  createShortlink: serverLib.createShortlink,

  // 存储适配器
  memoryStore: storeLib.memoryStore,
  fileStore: storeLib.fileStore,
  customStore: storeLib.customStore,
  normalizeDb: storeLib.normalizeDb,
  DB_VERSION: storeLib.DB_VERSION,

  // 计数器后端：想自己接 Redis / MySQL 时可以用这两个做参考实现
  counters: {
    create: countersLib.createCounters,
    memoryBackend: storeLib.memoryCounterBackend,
    fileBackend: storeLib.fileCounterBackend,
    isBackend: storeLib.isCounterBackend
  },

  // 辅助能力，按需单独调用
  config: {
    normalize: configLib.normalize,
    loadFromFile: configLib.loadFromFile,
    loadFromDisk: configLib.loadFromDisk,
    applyEnv: configLib.applyEnv,
    normalizeStreamMode: configLib.normalizeStreamMode,
    isValidStreamMode: configLib.isValidStreamMode,
    hasUsableAdminKey: configLib.hasUsableAdminKey
  },
  codes: {
    randomCode: codesLib.randomCode,
    isValidCode: codesLib.isValidCode,
    resolveCode: codesLib.resolveCode
  },
  oss: {
    signUrl: ossLib.signUrl,
    canSign: ossLib.canSign,
    resolveVideoUrl: ossLib.resolveVideoUrl,
    isHttpUrl: ossLib.isHttpUrl
  },

  // 低层工厂，适合深度定制
  createLinkManager: linksLib.createLinkManager,
  createRenderer: renderLib.createRenderer,
  createRouter: routerLib.createRouter,

  PLACEHOLDER_KEY: configLib.PLACEHOLDER_KEY,
  version: pkg.version
};

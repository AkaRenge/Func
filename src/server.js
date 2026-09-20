'use strict';

const http = require('http');
const path = require('path');

const configLib = require('./config');
const storeLib = require('./store');
const renderLib = require('./render');
const linksLib = require('./links');
const routerLib = require('./router');
const ossLib = require('./oss');

/**
 * 创建一个短链服务实例。
 *
 * @param {object} [options]
 * @param {object} [options.store]        存储适配器，见 store.memoryStore / fileStore / customStore
 * @param {string} [options.dataFile]     便捷写法：等价于 store = fileStore(dataFile)
 * @param {string} [options.configFile]   直接从配置文件启动（CLI 用）
 * @param {boolean} [options.applyEnv]    是否用环境变量覆盖配置，默认 false
 * @param {string} [options.publicBaseUrl]
 * @param {string} [options.adminKey]
 * @param {string} [options.brand]
 * @param {string} [options.streamMode]   'redirect' | 'proxy'
 * @param {object} [options.oss]
 * @param {object} [options.templates]    覆盖内置视图模板
 * @param {function} [options.log]        自定义日志函数
 * @returns {Promise<object>} app
 */
async function createShortlink(options) {
  const opts = Object.assign({}, options || {});

  let cfg;
  if (opts.configFile) {
    const rootDir = path.dirname(path.resolve(opts.configFile));
    cfg = configLib.loadFromDisk(rootDir, process.env);
    if (!opts.dataFile && !opts.store) {
      opts.dataFile = path.join(rootDir, 'data', 'links.json');
    }
  } else {
    cfg = configLib.normalize(opts);
    if (opts.applyEnv) configLib.applyEnv(cfg, process.env);
  }

  const store = storeLib.pickStore(opts.store, opts.dataFile);
  // 容错：自定义存储可能返回 null / 结构不完整的对象，统一规整成合法 db
  const db = storeLib.normalizeDb(await store.load());

  let dirty = false;
  let inflight = null;
  let closed = false;

  function markDirty() {
    dirty = true;
  }

  function getDb() {
    return db;
  }

  function flush() {
    if (!dirty) return inflight || Promise.resolve();
    dirty = false;
    inflight = Promise.resolve()
      .then(function () { return store.save(db); })
      .catch(function (e) {
        log('[warn] 落盘失败：' + e.message);
      });
    return inflight;
  }

  const log = opts.log || function (line) { console.log(line); };

  const render = renderLib.createRenderer({
    viewDir: cfg.viewDir,
    cfg: cfg,
    templates: opts.templates
  });

  const links = linksLib.createLinkManager({
    getDb: getDb,
    markDirty: markDirty,
    getConfig: function () { return cfg; },
    now: opts.now
  });

  const router = routerLib.createRouter({
    config: cfg,
    links: links,
    render: render,
    flush: flush,
    log: log
  });

  let timer = null;
  if (cfg.flushIntervalMs > 0) {
    timer = setInterval(function () { flush(); }, cfg.flushIntervalMs);
    if (timer.unref) timer.unref();
  }

  let httpServer = null;

  const app = {
    config: cfg,
    store: store,
    links: links,
    render: render,
    handler: router.handleRequest,

    /** 快捷起服务。返回 Node 原生 http.Server。 */
    listen: function (port, host) {
      const p = port != null ? port : cfg.port;
      const h = host != null ? host : cfg.host;
      httpServer = http.createServer(router.handleRequest);
      httpServer.listen(p, h);
      return httpServer;
    },

    /** 直接把已有 server 接管过来，只负责挂 handler。 */
    attach: function (server) {
      server.on('request', router.handleRequest);
      httpServer = server;
      return server;
    },

    /** 当前数据快照（深拷贝），用于断言或备份。 */
    snapshot: function () {
      return JSON.parse(JSON.stringify(db));
    },

    /** 健康信息。 */
    stats: function () {
      return {
        links: links.list().length,
        streamMode: cfg.streamMode,
        signedRead: ossLib.canSign(cfg.oss),
        storeKind: store.kind || 'custom',
        dirty: dirty
      };
    },

    /** 立即落盘。 */
    save: function () {
      dirty = true;
      return flush();
    },

    /** 关闭：停定时器、关服务、落盘。 */
    close: async function () {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      dirty = true;
      await flush();
      if (httpServer) {
        await new Promise(function (resolve) {
          httpServer.close(function () { resolve(); });
          httpServer = null;
        });
      }
    }
  };

  return app;
}

module.exports = { createShortlink: createShortlink };

'use strict';

const http = require('http');
const path = require('path');

const configLib = require('./config');
const storeLib = require('./store');
const renderLib = require('./render');
const linksLib = require('./links');
const countersLib = require('./counters');
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
    // 明确读用户指定的那个文件，不再「回退到同目录 config.example.json」
    cfg = configLib.loadFromFile(path.resolve(opts.configFile), process.env);
    if (!opts.dataFile && !opts.store) {
      opts.dataFile = path.join(path.dirname(path.resolve(opts.configFile)), 'data', 'links.json');
    }
  } else {
    cfg = configLib.normalize(opts);
    if (opts.applyEnv) configLib.applyEnv(cfg, process.env);
  }

  const store = storeLib.pickStore(opts.store, opts.dataFile);
  // 容错：自定义存储可能返回 null / 结构不完整的对象，统一规整成合法 db
  const loaded = storeLib.normalizeDb(await store.load());
  const db = { version: storeLib.DB_VERSION, links: loaded.links };

  // 迁移：v1（≤1.1.x）把 hits 内联在每条记录里，上面已摘出来，落一次盘把文件改写成 v2
  let migrated = loaded.migrated;

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
    // inline 模式（自定义存储没实现 counters）下，计数只能跟着定义一起走
    const payload = counterMode === 'inline'
      ? { version: storeLib.DB_VERSION, links: db.links, counts: counters.snapshot() }
      : db;
    inflight = Promise.resolve()
      .then(function () { return store.save(payload); })
      .catch(function (e) {
        log('[warn] 落盘失败：' + e.message);
      });
    return inflight;
  }

  const log = opts.log || function (line) { console.log(line); };

  /* ---------------- 访问计数：和定义分开的一条线 ---------------- *
   * 存储实现了 counters 就走分离模式：高频命中只往追加日志写一行，
   * 定义文档完全不参与。没实现就退化成 inline（跟着定义一起落盘，1.1.x 行为）。
   * ------------------------------------------------------------------ */
  let counterMode;
  if (cfg.trackHits === false) counterMode = 'off';
  else if (storeLib.isCounterBackend(store.counters)) counterMode = 'separate';
  else counterMode = 'inline';

  const backend = counterMode === 'separate' ? store.counters : null;

  let initialCounts = loaded.counts;
  let initialSeq = 0;

  if (backend) {
    let persisted = { counts: {}, seq: 0 };
    try {
      const r = await backend.load();
      // 宽容一点：手写的自定义后端可能直接返回 counts 对象，而不是 { counts, seq }
      persisted = (r && typeof r === 'object' && r.counts && typeof r.counts === 'object')
        ? { counts: r.counts, seq: Number(r.seq) || 0 }
        : { counts: r || {}, seq: 0 };
    } catch (e) {
      log('[warn] 计数读取失败，从 0 开始：' + e.message);
    }
    // v1 文件里迁移出来的计数没有 seq，合并进初始状态即可
    initialCounts = storeLib.mergeCounts(persisted.counts, loaded.counts);
    initialSeq = persisted.seq;
  }

  const counters = countersLib.createCounters({
    mode: counterMode,
    backend: backend,
    counts: initialCounts,
    seq: initialSeq,
    markDirty: markDirty,
    log: log,
    now: opts.now,
    appendIntervalMs: cfg.hitAppendIntervalMs,
    compactIntervalMs: cfg.hitCompactIntervalMs,
    maxJournalBytes: cfg.hitJournalMaxBytes
  });

  // 清掉已经找不到定义的残留计数（短链被删过、或换了数据文件）
  counters.prune(function (code) {
    return Object.prototype.hasOwnProperty.call(db.links, code);
  });

  const render = renderLib.createRenderer({
    viewDir: cfg.viewDir,
    cfg: cfg,
    templates: opts.templates
  });

  const links = linksLib.createLinkManager({
    getDb: getDb,
    markDirty: markDirty,
    getConfig: function () { return cfg; },
    counters: counters,
    now: opts.now
  });

  // 从 v1 数据文件升上来时，把 hits 从记录里摘掉这件事需要落一次盘
  if (migrated) {
    dirty = true;
    log('[info] 检测到旧版数据格式，已把访问计数拆到独立存储');
  }

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

    /**
     * 当前数据快照（深拷贝）。
     * 保持 1.1.x 的形状：links 里带回 hits / lastHitAt，方便断言与备份。
     */
    snapshot: function () {
      const out = {
        version: storeLib.DB_VERSION,
        links: {},
        counts: counters.snapshot()
      };
      links.list().forEach(function (l) { out.links[l.code] = l; });
      return JSON.parse(JSON.stringify(out));
    },

    /** 访问计数管理器（内部成员，主要给测试和诊断用）。 */
    counters: counters,

    /** 健康信息。 */
    stats: function () {
      return {
        links: links.count(),
        streamMode: cfg.streamMode,
        signedRead: ossLib.canSign(cfg.oss),
        storeKind: store.kind || 'custom',
        dirty: dirty,
        counters: counters.stats()
      };
    },

    /** 立即落盘：定义与计数一起。 */
    save: function () {
      dirty = true;
      return Promise.all([flush(), counters.compact()]).then(function () {});
    },

    /** 关闭：停定时器、关服务、把定义和计数都落干净。 */
    close: async function () {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      await counters.close();          // 先停计数定时器并压实，避免关闭后还有写入
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

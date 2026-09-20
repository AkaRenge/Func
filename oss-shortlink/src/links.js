'use strict';

const codes = require('./codes');
const oss = require('./oss');

const MAX_TITLE = 120;
const MAX_DESC = 500;
const DEFAULT_PAGE_LIMIT = 200;

function toIntOr(value, fallback) {
  const n = parseInt(value, 10);
  return isFinite(n) ? n : fallback;
}

function badRequest(message) {
  const e = new Error(message);
  e.status = 400;
  return e;
}

function nowIso(nowMs) {
  return new Date(Number(nowMs || Date.now())).toISOString();
}

function clip(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

/**
 * 短链管理器。
 *
 * 内存里维护两份东西：
 *   db().links  定义（code / 标题 / 地址 / 开关 …）—— 落盘由外层 app 决定
 *   order       短码的创建顺序（新→旧）—— 让分页不必每次排序全量
 *
 * 访问计数不在这一层：由 counters 单独管，`touch()` 只是转交过去。
 * 所以一次扫码不会让定义文档变脏，也就不会触发整份文件重写。
 *
 * @param {object} ctx
 * @param {function} ctx.getDb      取得当前 db 引用
 * @param {function} ctx.markDirty  标记有未落盘改动
 * @param {function} ctx.getConfig  取得规整后的配置
 * @param {object}   ctx.counters   访问计数管理器
 * @param {function} [ctx.now]      取当前时间戳，便于测试注入
 */
function createLinkManager(ctx) {
  const getDb = ctx.getDb;
  const markDirty = ctx.markDirty;
  const getConfig = ctx.getConfig;
  const counters = ctx.counters;
  const now = ctx.now || Date.now;

  function db() {
    return getDb();
  }

  function validateVideoUrl(value) {
    const url = String(value == null ? '' : value).trim();
    if (!oss.isHttpUrl(url)) throw badRequest('videoUrl 必须是 http/https 开头的完整地址');
    return url;
  }

  function validateCover(value) {
    const url = String(value == null ? '' : value).trim();
    if (url && !oss.isHttpUrl(url)) throw badRequest('cover 必须是 http/https 开头的地址');
    return url;
  }

  function isTaken(code) {
    return Object.prototype.hasOwnProperty.call(db().links, code);
  }

  /* ---------------- 创建顺序索引 ---------------- *
   * 列表要按创建时间倒序。以前每次分页都 Object.keys + sort 一遍全量，
   * 20 万条时单次要几百毫秒；而短链是「只增不减、偶尔删」的形态，
   * 维护一个数组反而更划算：新建 unshift，删除 splice，分页直接切片。
   * 搜索（q）仍然要走全量，那是搜索本身的代价，不是分页的。
   * ------------------------------------------------------------------ */

  let order = null;
  let cachedCount = null;

  function buildOrder() {
    const links = db().links;
    order = Object.keys(links).sort(function (a, b) {
      return String(links[b].createdAt).localeCompare(String(links[a].createdAt));
    });
    return order;
  }

  /**
   * 取创建顺序索引。条数与真实条目对不上时重建（防外部直接改 db）。
   * 正常情况下 create/remove 已经增量维护过，这里只是 O(1) 的一致性检查。
   */
  function ensureOrder() {
    if (!order || order.length !== total()) buildOrder();
    return order;
  }

  function view(def) {
    const c = counters.get(def.code);
    return Object.assign({}, def, {
      hits: c ? c.hits : 0,
      lastHitAt: c ? c.lastHitAt : null
    });
  }

  function viewList(defs) {
    return defs.map(view);
  }

  function total() {
    // Object.keys() 本身就要遍历 + 分配一个 n 长的数组，20 万条时单次仍是几十毫秒，
    // 所以只在第一次点一次，之后靠 create/remove 增量维护。
    if (cachedCount === null) cachedCount = Object.keys(db().links).length;
    return cachedCount;
  }

  function defOf(code) {
    return db().links[code];
  }

  function requireDef(code) {
    const def = defOf(code);
    if (!def) {
      const e = new Error('短码不存在：' + code);
      e.status = 404;
      throw e;
    }
    return def;
  }

  function addToOrder(code) {
    if (!order) return;
    order.unshift(code);
  }

  function removeFromOrder(code) {
    if (!order) return;
    const i = order.indexOf(code);
    if (i >= 0) order.splice(i, 1);
  }

  return {
    /** 新建一条短链。 */
    create: function (input) {
      const body = input || {};
      const cfg = getConfig();

      const videoUrl = validateVideoUrl(body.videoUrl);
      const cover = validateCover(body.cover);
      const code = codes.resolveCode(body.code, isTaken, cfg.codeLength);
      const stamp = nowIso(now());

      // 定义里不再存 hits / lastHitAt：那是计数，另有归宿
      const link = {
        code: code,
        title: clip(body.title, MAX_TITLE) || '视频',
        desc: clip(body.desc, MAX_DESC),
        videoUrl: videoUrl,
        cover: cover,
        mode: body.mode === 'jump' ? 'jump' : 'player',
        enabled: body.enabled === false ? false : true,
        createdAt: stamp,
        updatedAt: null
      };

      db().links[code] = link;
      if (cachedCount !== null) cachedCount += 1;
      addToOrder(code);
      markDirty();

      return {
        code: code,
        shareUrl: cfg.publicBaseUrl + '/v/' + code,
        link: view(link)
      };
    },

    /** 按短码取记录（已合并计数），不存在返回 undefined。 */
    get: function (code) {
      const def = defOf(code);
      return def ? view(def) : undefined;
    },

    /** 取记录，不存在直接抛 404。 */
    require: function (code) {
      return view(requireDef(code));
    },

    has: isTaken,

    /** 局部更新。只覆盖传入的字段，未传的保持原值。 */
    update: function (code, patch) {
      const link = requireDef(code);
      const body = patch || {};

      if (body.title != null) link.title = clip(body.title, MAX_TITLE);
      if (body.desc != null) link.desc = clip(body.desc, MAX_DESC);
      if (body.videoUrl != null) link.videoUrl = validateVideoUrl(body.videoUrl);
      if (body.cover != null) link.cover = validateCover(body.cover);
      if (body.mode != null) link.mode = body.mode === 'jump' ? 'jump' : 'player';
      if (body.enabled != null) link.enabled = !!body.enabled;

      link.updatedAt = nowIso(now());
      markDirty();
      return view(link);
    },

    /** 删除。不存在也当成功，便于幂等调用。 */
    remove: function (code) {
      if (!isTaken(code)) return false;
      delete db().links[code];
      if (cachedCount !== null) cachedCount -= 1;
      removeFromOrder(code);
      counters.drop(code);
      markDirty();
      return true;
    },

    /** 全量列表（已合并计数），按创建时间倒序。 */
    list: function () {
      return viewList(ensureOrder().map(defOf).filter(Boolean));
    },

    /** 只数个数，O(1)。健康检查和 stats() 走这里。 */
    count: total,

    /**
     * 分页 + 关键词搜索（匹配短码 / 标题 / 描述 / 视频地址）。
     * limit <= 0 表示不分页；total 是过滤后的总数，不是本页条数。
     *
     * 没有搜索词时走创建顺序索引，代价只和本页条数有关，与总量无关。
     */
    page: function (opts) {
      const o = opts || {};
      const limit = o.limit === undefined ? DEFAULT_PAGE_LIMIT : toIntOr(o.limit, DEFAULT_PAGE_LIMIT);
      const offset = Math.max(0, toIntOr(o.offset, 0));
      const q = String(o.q == null ? '' : o.q).trim().toLowerCase();

      if (!q) {
        const keys = ensureOrder();
        const slice = limit > 0 ? keys.slice(offset, offset + limit) : keys.slice(offset);
        return {
          total: keys.length,
          offset: offset,
          limit: limit,
          list: viewList(slice.map(defOf).filter(Boolean))
        };
      }

      const hits = [];
      const keys = ensureOrder();
      for (let i = 0; i < keys.length; i++) {
        const def = defOf(keys[i]);
        if (!def) continue;
        if (String(def.code + '\u0000' + def.title + '\u0000' + def.desc + '\u0000' + def.videoUrl)
          .toLowerCase().indexOf(q) >= 0) hits.push(def);
      }
      return {
        total: hits.length,
        offset: offset,
        limit: limit,
        list: viewList(limit > 0 ? hits.slice(offset, offset + limit) : hits.slice(offset))
      };
    },

    /** 记一次访问。返回合并后的记录。 */
    touch: function (code) {
      const def = defOf(code);
      if (!def) return null;
      counters.record(code, now());
      return view(def);
    },

    /** 分享链接。 */
    shareUrl: function (code) {
      return getConfig().publicBaseUrl + '/v/' + code;
    },

    /** 内部用：丢弃索引，下次访问重建（改过 db 之后调）。 */
    invalidate: function () {
      order = null;
      cachedCount = null;
    }
  };
}

module.exports = { createLinkManager: createLinkManager };

'use strict';

const codes = require('./codes');
const oss = require('./oss');

const MAX_TITLE = 120;
const MAX_DESC = 500;

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
 * 短链管理器。所有写操作只改内存，落盘时机由外层 app 决定（防抖 + 退出前强制）。
 *
 * @param {object} ctx
 * @param {function} ctx.getDb      取得当前 db 引用
 * @param {function} ctx.markDirty  标记有未落盘改动
 * @param {function} ctx.getConfig  取得规整后的配置
 * @param {function} [ctx.now]      取当前时间戳，便于测试注入
 */
function createLinkManager(ctx) {
  const getDb = ctx.getDb;
  const markDirty = ctx.markDirty;
  const getConfig = ctx.getConfig;
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

  function require(code) {
    const link = db().links[code];
    if (!link) {
      const e = new Error('短码不存在：' + code);
      e.status = 404;
      throw e;
    }
    return link;
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

      const link = {
        code: code,
        title: clip(body.title, MAX_TITLE) || '视频',
        desc: clip(body.desc, MAX_DESC),
        videoUrl: videoUrl,
        cover: cover,
        mode: body.mode === 'jump' ? 'jump' : 'player',
        enabled: body.enabled === false ? false : true,
        createdAt: stamp,
        updatedAt: null,
        hits: 0,
        lastHitAt: null
      };

      db().links[code] = link;
      markDirty();

      return {
        code: code,
        shareUrl: cfg.publicBaseUrl + '/v/' + code,
        link: link
      };
    },

    /** 按短码取记录，不存在返回 undefined。 */
    get: function (code) {
      return db().links[code];
    },

    /** 取记录，不存在直接抛 404。 */
    require: require,

    has: function (code) {
      return isTaken(code);
    },

    /** 局部更新。只覆盖传入的字段，未传的保持原值。 */
    update: function (code, patch) {
      const link = require(code);
      const body = patch || {};

      if (body.title != null) link.title = clip(body.title, MAX_TITLE);
      if (body.desc != null) link.desc = clip(body.desc, MAX_DESC);
      if (body.videoUrl != null) link.videoUrl = validateVideoUrl(body.videoUrl);
      if (body.cover != null) link.cover = validateCover(body.cover);
      if (body.mode != null) link.mode = body.mode === 'jump' ? 'jump' : 'player';
      if (body.enabled != null) link.enabled = !!body.enabled;

      link.updatedAt = nowIso(now());
      markDirty();
      return link;
    },

    /** 删除。不存在也当成功，便于幂等调用。 */
    remove: function (code) {
      if (!isTaken(code)) return false;
      delete db().links[code];
      markDirty();
      return true;
    },

    /** 全量列表，按创建时间倒序。 */
    list: function () {
      const all = db().links;
      return Object.keys(all)
        .map(function (k) { return all[k]; })
        .sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); });
    },

    /** 记一次访问。 */
    touch: function (code) {
      const link = db().links[code];
      if (!link) return null;
      link.hits = (link.hits || 0) + 1;
      link.lastHitAt = nowIso(now());
      markDirty();
      return link;
    },

    /** 分享链接。 */
    shareUrl: function (code) {
      return getConfig().publicBaseUrl + '/v/' + code;
    }
  };
}

module.exports = { createLinkManager: createLinkManager };

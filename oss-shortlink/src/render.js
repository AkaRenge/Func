'use strict';

const fs = require('fs');
const path = require('path');

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
    return ENTITIES[c];
  });
}

/**
 * 极简模板填充：把 {{KEY}} 换成 vars 里的值。
 * 用函数式替换，避免 $& 之类的替换模式被当成特殊语法。
 */
function fill(html, vars) {
  return html.replace(/\{\{([A-Z_]+)\}\}/g, function (m, key) {
    return Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : '';
  });
}

/**
 * 渲染器。视图来源优先级：templates 覆盖 > viewDir 目录。
 *
 * @param {object} opts
 * @param {string} opts.viewDir      视图目录
 * @param {object} opts.cfg          规整后的配置
 * @param {object} [opts.templates]  视图名 -> 模板字符串，用于整体替换内置模板
 */
function createRenderer(opts) {
  const viewDir = opts.viewDir;
  const cfg = opts.cfg;
  const overrides = opts.templates || {};
  const cache = new Map();

  function view(name) {
    if (Object.prototype.hasOwnProperty.call(overrides, name)) return String(overrides[name]);
    if (!cache.has(name)) {
      cache.set(name, fs.readFileSync(path.join(viewDir, name), 'utf8'));
    }
    return cache.get(name);
  }

  return {
    escapeHtml: escapeHtml,
    fill: fill,
    raw: view,

    /** 播放页：所有变量都过一遍转义，取流地址用同域相对路径。 */
    player: function (link) {
      let html = view('player.html');
      html = html.replace(/\s*poster="\{\{COVER\}\}"/,
        link.cover ? ' poster="' + escapeHtml(link.cover) + '"' : '');
      return fill(html, {
        TITLE: escapeHtml(link.title || '视频播放'),
        DESC: escapeHtml(link.desc || ''),
        BRAND: escapeHtml(cfg.brand || ''),
        FOOTER: escapeHtml(cfg.footerText || ''),
        STREAM: '/v/' + encodeURIComponent(link.code) + '/stream'
      });
    },

    admin: function () {
      return view('admin.html');
    },

    notFound: function () {
      return fill(view('404.html'), { BRAND: escapeHtml(cfg.brand || '') });
    },

    clearCache: function () {
      cache.clear();
    }
  };
}

module.exports = {
  escapeHtml: escapeHtml,
  fill: fill,
  createRenderer: createRenderer
};

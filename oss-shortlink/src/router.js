'use strict';

const http = require('http');
const https = require('https');
const crypto = require('crypto');

const ossLib = require('./oss');
const configLib = require('./config');

const MAX_BODY = 64 * 1024;
const CODE_PATH = '([A-Za-z0-9]{4,16})';

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function isApi(pathname) {
  return pathname.indexOf('/api/') === 0;
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf) return xf.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || '-';
}

function readJsonBody(req) {
  return new Promise(function (resolve, reject) {
    let size = 0;
    const chunks = [];

    req.on('data', function (c) {
      size += c.length;
      if (size > MAX_BODY) {
        reject(httpError(413, '请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });

    req.on('end', function () {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(httpError(400, 'JSON 解析失败：' + e.message));
      }
    });

    req.on('error', reject);
  });
}

/**
 * 创建请求处理器。
 *
 * @param {object} ctx
 * @param {object} ctx.config   规整后的配置
 * @param {object} ctx.links    短链管理器
 * @param {object} ctx.render   渲染器
 * @param {function} ctx.flush  立即落盘
 * @param {function} [ctx.log]  日志函数，默认 console.log
 */
function createRouter(ctx) {
  const cfg = ctx.config;
  const links = ctx.links;
  const render = ctx.render;
  const flush = ctx.flush || function () {};
  const log = ctx.log || function (line) { console.log(line); };

  function send(res, status, type, body, extra) {
    const headers = Object.assign({
      'Content-Type': type,
      'Content-Length': Buffer.byteLength(body),
      'X-Content-Type-Options': 'nosniff'
    }, extra || {});
    res.writeHead(status, headers);
    res.end(body);
  }

  function sendJson(res, status, obj) {
    send(res, status, 'application/json; charset=utf-8',
      JSON.stringify(obj, null, 2), { 'Cache-Control': 'no-store' });
  }

  function sendHtml(res, status, html) {
    send(res, status, 'text/html; charset=utf-8', html, { 'Cache-Control': 'no-store' });
  }

  function redirectTo(res, location) {
    res.writeHead(302, {
      Location: location,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'X-Robots-Tag': 'noindex'
    });
    res.end();
  }

  function requireAdmin(req, url) {
    if (!configLib.hasUsableAdminKey(cfg)) {
      throw httpError(503, '尚未设置 adminKey，请在配置中给一个长随机字符串');
    }
    const given = url.searchParams.get('key') || req.headers['x-admin-key'] || '';
    if (!safeEqual(given, cfg.adminKey)) throw httpError(401, '管理密钥不正确');
  }

  function videoUrlOf(link) {
    return ossLib.resolveVideoUrl(link, cfg.oss);
  }

  function proxyStream(req, res, target) {
    let u;
    try {
      u = new URL(target);
    } catch (e) {
      throw httpError(500, '视频地址不合法');
    }

    const mod = u.protocol === 'https:' ? https : http;
    const headers = {
      'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0',
      'Referer': cfg.publicBaseUrl + '/'
    };
    if (req.headers.range) headers.Range = req.headers.range;

    const upstream = mod.request({
      method: 'GET',
      hostname: u.hostname,
      port: u.port || undefined,
      path: u.pathname + u.search,
      headers: headers,
      timeout: 20000
    }, function (up) {
      const passthrough = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];
      const out = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' };
      passthrough.forEach(function (k) {
        if (up.headers[k]) out[k] = up.headers[k];
      });
      res.writeHead(up.statusCode || 200, out);
      up.pipe(res);
    });

    upstream.on('timeout', function () {
      upstream.destroy(new Error('回源超时'));
    });
    upstream.on('error', function (e) {
      log('[error] 回源失败：' + e.message);
      if (res.headersSent) return res.end();
      send(res, 502, 'text/plain; charset=utf-8', '视频源暂时不可用\n');
    });
    res.on('close', function () {
      upstream.destroy();
    });
    upstream.end();
  }

  function handlePage(req, res, code) {
    const link = links.get(code);
    if (!link || !link.enabled) return sendHtml(res, 404, render.notFound());

    links.touch(code);

    if (link.mode === 'jump') return redirectTo(res, videoUrlOf(link));
    return sendHtml(res, 200, render.player(link));
  }

  function handleStream(req, res, code) {
    const link = links.get(code);
    if (!link || !link.enabled) return sendHtml(res, 404, render.notFound());

    const target = videoUrlOf(link);
    if (cfg.streamMode === 'proxy') return proxyStream(req, res, target);
    return redirectTo(res, target);
  }

  async function route(req, res, url) {
    const p = url.pathname;
    const m = req.method;
    let match;

    if (p === '/healthz') {
      if (m !== 'GET' && m !== 'HEAD') throw httpError(405, '只支持 GET');
      return sendJson(res, 200, {
        ok: true,
        links: links.list().length,
        streamMode: cfg.streamMode,
        signedRead: ossLib.canSign(cfg.oss),
        uptimeSeconds: Math.round(process.uptime())
      });
    }

    if (p === '/robots.txt') {
      return send(res, 200, 'text/plain; charset=utf-8',
        'User-agent: *\nDisallow: /v/\nDisallow: /admin\nDisallow: /api/\n',
        { 'Cache-Control': 'public, max-age=86400' });
    }

    if (p === '/admin' || p === '/admin/') {
      if (m !== 'GET') throw httpError(405, '只支持 GET');
      requireAdmin(req, url);
      return sendHtml(res, 200, render.admin());
    }

    if (p === '/api/links') {
      requireAdmin(req, url);

      if (m === 'GET' || m === 'HEAD') {
        const list = links.list();
        return sendJson(res, 200, {
          publicBaseUrl: cfg.publicBaseUrl,
          count: list.length,
          list: list
        });
      }

      if (m === 'POST') {
        const body = await readJsonBody(req);
        const created = links.create(body);
        flush();
        return sendJson(res, 201, created);
      }

      throw httpError(405, '不支持的请求方法');
    }

    match = p.match(new RegExp('^/api/links/' + CODE_PATH + '$'));
    if (match) {
      requireAdmin(req, url);
      const code = match[1];
      const link = links.require(code);

      if (m === 'GET') return sendJson(res, 200, link);

      if (m === 'PATCH' || m === 'PUT') {
        const body = await readJsonBody(req);
        const updated = links.update(code, body);
        flush();
        return sendJson(res, 200, updated);
      }

      if (m === 'DELETE') {
        links.remove(code);
        flush();
        return sendJson(res, 200, { deleted: code });
      }

      throw httpError(405, '不支持的请求方法');
    }

    match = p.match(new RegExp('^/v/' + CODE_PATH + '/stream$'));
    if (match) {
      if (m !== 'GET' && m !== 'HEAD') throw httpError(405, '只支持 GET');
      return handleStream(req, res, match[1]);
    }

    match = p.match(new RegExp('^/v/' + CODE_PATH + '$'));
    if (match) {
      if (m !== 'GET' && m !== 'HEAD') throw httpError(405, '只支持 GET');
      return handlePage(req, res, match[1]);
    }

    if (p === '/') {
      return send(res, 200, 'text/plain; charset=utf-8', 'oss-shortlink is running.\n');
    }

    throw httpError(404, 'Not Found');
  }

  /** 直接挂到任意 http server 上用的处理器。 */
  async function handleRequest(req, res) {
    const t0 = Date.now();
    let url;

    try {
      url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    } catch (e) {
      return sendJson(res, 400, { error: '非法请求路径' });
    }

    if (cfg.logRequests) {
      res.on('finish', function () {
        log('[' + new Date().toISOString() + '] ' + clientIp(req) + ' ' +
          req.method + ' ' + url.pathname + ' -> ' + res.statusCode + ' ' + (Date.now() - t0) + 'ms');
      });
    }

    try {
      await route(req, res, url);
    } catch (err) {
      const status = (err && err.status) ? err.status : 500;
      if (status >= 500) log('[error] ' + ((err && err.stack) || err));

      if (res.headersSent) {
        res.end();
        return;
      }
      if (isApi(url.pathname)) return sendJson(res, status, { error: err.message || '服务器内部错误' });
      if (status === 404) return sendHtml(res, 404, render.notFound());
      return send(res, status, 'text/plain; charset=utf-8', (err.message || '服务器内部错误') + '\n');
    }
  }

  return {
    handleRequest: handleRequest,
    route: route,
    send: send,
    sendJson: sendJson,
    sendHtml: sendHtml,
    redirectTo: redirectTo
  };
}

module.exports = {
  createRouter: createRouter,
  handleRequest: null,
  httpError: httpError,
  readJsonBody: readJsonBody
};

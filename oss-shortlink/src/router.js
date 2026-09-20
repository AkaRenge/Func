'use strict';

const http = require('http');
const https = require('https');
const crypto = require('crypto');

const ossLib = require('./oss');
const configLib = require('./config');

const MAX_BODY = 64 * 1024;
const CODE_PATH = '([A-Za-z0-9]{4,16})';

const ADMIN_COOKIE = 'oss_shortlink_admin';
const SESSION_TTL_SECONDS = 12 * 3600;
const AUTH_MAX_FAILS = 10;
const AUTH_WINDOW_MS = 5 * 60 * 1000;
const AUTH_MAX_TRACKED_IPS = 10000;

const DEFAULT_PAGE_LIMIT = 200;
const MAX_PAGE_LIMIT = 1000;

// 播放页：视频/封面可能来自对象存储，所以放行 http(s)；其余一律不允许。
// script/style 用 inline，所以留着 'unsafe-inline'——真正的 XSS 防线是模板转义，
// CSP 在这里主要挡住 <base> 劫持、表单外发和被 iframe 套壳。
const PLAYER_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
  "img-src 'self' data: http: https:",
  "media-src 'self' http: https:",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'"
].join('; ');

const ADMIN_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'"
].join('; ');

const MINIMAL_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "style-src 'unsafe-inline'"
].join('; ');

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function isApi(pathname) {
  return pathname.indexOf('/api/') === 0;
}

function toIntOr(value, fallback) {
  const n = parseInt(value, 10);
  return isFinite(n) ? n : fallback;
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

function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return '';
  const parts = String(raw).split(';');
  for (let i = 0; i < parts.length; i++) {
    const s = parts[i].trim();
    const eq = s.indexOf('=');
    if (eq > 0 && s.slice(0, eq) === name) return decodeURIComponent(s.slice(eq + 1));
  }
  return '';
}

/** 会话票据 = 过期时间戳 + 用 adminKey 派生的 HMAC，无状态、轮换密钥即全部失效。 */
function signSession(adminKey, exp) {
  const payload = String(exp);
  return payload + '.' + crypto.createHmac('sha256', adminKey).update(payload).digest('base64url');
}

function verifySession(adminKey, token, nowMs) {
  const t = String(token || '');
  const i = t.indexOf('.');
  if (i <= 0) return false;
  const payload = t.slice(0, i);
  const expect = crypto.createHmac('sha256', adminKey).update(payload).digest('base64url');
  if (!safeEqual(t.slice(i + 1), expect)) return false;
  const exp = Number(payload);
  return isFinite(exp) && exp > Math.floor(Number(nowMs || Date.now()) / 1000);
}

function readJsonBody(req) {
  return new Promise(function (resolve, reject) {
    let size = 0;
    let settled = false;
    const chunks = [];

    function fail(status, message) {
      if (settled) return;
      settled = true;
      req.removeListener('data', onData);
      // 注意：这里绝不能 destroy socket —— 那样响应就发不出去，客户端只会看到
      // ECONNRESET / socket hang up，拿不到 413。停住读取，交给上层去回应。
      req.pause();
      reject(httpError(status, message));
    }

    function onData(c) {
      size += c.length;
      if (size > MAX_BODY) return fail(413, '请求体过大');
      chunks.push(c);
    }

    req.on('data', onData);

    req.on('end', function () {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(httpError(400, 'JSON 解析失败：' + e.message));
      }
    });

    req.on('error', function (e) {
      if (settled) return;
      settled = true;
      reject(e);
    });
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

  /** ip -> { count, resetAt }，用于限制管理密钥爆破。 */
  const authFailures = new Map();

  function baseSecurityHeaders() {
    const h = {
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin'
    };
    // 只有对外真的是 https 时才发 HSTS，本地 http 调试不受影响
    if (/^https:/i.test(cfg.publicBaseUrl)) {
      h['Strict-Transport-Security'] = 'max-age=15552000; includeSubDomains';
    }
    return h;
  }

  function send(res, status, type, body, extra) {
    const headers = Object.assign(
      { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) },
      baseSecurityHeaders(),
      extra || {}
    );
    res.writeHead(status, headers);
    res.end(body);
  }

  function sendJson(res, status, obj) {
    send(res, status, 'application/json; charset=utf-8',
      JSON.stringify(obj, null, 2), { 'Cache-Control': 'no-store' });
  }

  function sendHtml(res, status, html, opts) {
    const o = opts || {};
    const extra = { 'Cache-Control': 'no-store' };
    if (o.csp) extra['Content-Security-Policy'] = o.csp;
    if (o.frame) extra['X-Frame-Options'] = o.frame;
    send(res, status, 'text/html; charset=utf-8', html, extra);
  }

  function redirectTo(res, location) {
    res.writeHead(302, {
      Location: location,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'X-Robots-Tag': 'noindex',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end();
  }

  /* ---------- 管理鉴权：cookie 会话 + 头部 + 限速 ---------- */

  function noteAuthFailure(req) {
    const ip = clientIp(req);
    const nowMs = Date.now();

    if (authFailures.size > AUTH_MAX_TRACKED_IPS) {
      authFailures.forEach(function (rec, key) {
        if (rec.resetAt <= nowMs) authFailures.delete(key);
      });
      if (authFailures.size > AUTH_MAX_TRACKED_IPS) authFailures.clear();
    }

    const rec = authFailures.get(ip);
    if (!rec || rec.resetAt <= nowMs) {
      authFailures.set(ip, { count: 1, resetAt: nowMs + AUTH_WINDOW_MS });
      return;
    }
    rec.count += 1;
  }

  function assertNotRateLimited(req) {
    const rec = authFailures.get(clientIp(req));
    if (!rec || rec.resetAt <= Date.now() || rec.count < AUTH_MAX_FAILS) return;
    const e = httpError(429, '管理密钥错误次数过多，请稍后再试');
    e.retryAfter = Math.max(1, Math.ceil((rec.resetAt - Date.now()) / 1000));
    throw e;
  }

  function setAdminCookie(res) {
    const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
    res.setHeader('Set-Cookie',
      ADMIN_COOKIE + '=' + signSession(cfg.adminKey, exp) +
      '; Path=/; Max-Age=' + SESSION_TTL_SECONDS + '; HttpOnly; SameSite=Strict' +
      (/^https:/i.test(cfg.publicBaseUrl) ? '; Secure' : ''));
  }

  /**
   * 返回本次是通过什么方式通过的：'query' | 'header' | 'cookie'。
   * 调用方据此决定要不要把 query 里的密钥换成 cookie。
   */
  function requireAdmin(req, url) {
    if (!configLib.hasUsableAdminKey(cfg)) {
      throw httpError(503, '尚未设置 adminKey，请在配置中给一个长随机字符串');
    }

    assertNotRateLimited(req);

    const fromQuery = url.searchParams.get('key');
    const fromHeader = req.headers['x-admin-key'];
    const given = fromQuery || fromHeader || '';

    if (given) {
      if (!safeEqual(given, cfg.adminKey)) {
        noteAuthFailure(req);
        throw httpError(401, '管理密钥不正确');
      }
      authFailures.delete(clientIp(req));
      return fromQuery ? 'query' : 'header';
    }

    if (verifySession(cfg.adminKey, readCookie(req, ADMIN_COOKIE), Date.now())) {
      authFailures.delete(clientIp(req));
      return 'cookie';
    }

    noteAuthFailure(req);
    throw httpError(401, '管理密钥不正确');
  }

  /* ---------- 取流 ---------- */

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
    if (!link || !link.enabled) {
      return sendHtml(res, 404, render.notFound(), { csp: MINIMAL_CSP, frame: 'DENY' });
    }

    links.touch(code);

    if (link.mode === 'jump') return redirectTo(res, videoUrlOf(link));
    return sendHtml(res, 200, render.player(link), { csp: PLAYER_CSP, frame: 'SAMEORIGIN' });
  }

  function handleStream(req, res, code) {
    const link = links.get(code);
    if (!link || !link.enabled) {
      return sendHtml(res, 404, render.notFound(), { csp: MINIMAL_CSP, frame: 'DENY' });
    }

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
        links: links.count(),
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
      // 用 ?key= 进来时：换成 HttpOnly cookie，然后 302 到不带 key 的地址。
      // 密钥不再留在地址栏、浏览器历史和下游代理的访问日志里。
      if (requireAdmin(req, url) === 'query') {
        setAdminCookie(res);
        return redirectTo(res, '/admin');
      }
      return sendHtml(res, 200, render.admin(), { csp: ADMIN_CSP, frame: 'DENY' });
    }

    if (p === '/api/links') {
      requireAdmin(req, url);

      if (m === 'GET' || m === 'HEAD') {
        const rawLimit = url.searchParams.get('limit');
        // 缺省 200 条；显式 limit=0 表示不分页（给脚本/迁移用）
        const limit = rawLimit === null
          ? DEFAULT_PAGE_LIMIT
          : Math.min(MAX_PAGE_LIMIT, Math.max(0, toIntOr(rawLimit, DEFAULT_PAGE_LIMIT)));
        const offset = Math.max(0, toIntOr(url.searchParams.get('offset'), 0));
        const q = url.searchParams.get('q') || '';

        const page = links.page({ limit: limit, offset: offset, q: q });
        return sendJson(res, 200, {
          publicBaseUrl: cfg.publicBaseUrl,
          total: page.total,
          count: page.list.length,
          offset: page.offset,
          limit: page.limit,
          list: page.list
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
      if (err && err.retryAfter) res.setHeader('Retry-After', String(err.retryAfter));

      // 请求体还没读完就报错（典型是 413）：必须声明不复用连接，否则剩下的请求体
      // 会被当成下一个请求解析；等响应真正写完后，再把 socket 收掉。
      if (!req.readableEnded) {
        res.setHeader('Connection', 'close');
        res.on('finish', function () { if (req.socket) req.socket.destroy(); });
      }

      if (isApi(url.pathname)) return sendJson(res, status, { error: err.message || '服务器内部错误' });
      if (status === 404) return sendHtml(res, 404, render.notFound(), { csp: MINIMAL_CSP, frame: 'DENY' });
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
  readJsonBody: readJsonBody,
  signSession: signSession,
  verifySession: verifySession,
  PLAYER_CSP: PLAYER_CSP,
  ADMIN_CSP: ADMIN_CSP,
  MINIMAL_CSP: MINIMAL_CSP
};

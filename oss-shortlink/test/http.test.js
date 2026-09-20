#!/usr/bin/env node
'use strict';

/** HTTP 端点层自检：在进程内起真实服务，跑完整请求。 */

const http = require('http');
const { once } = require('events');

const sdk = require('../src');
const harness = require('./harness');

const PORT = 39217;
const BASE = 'http://127.0.0.1:' + PORT;
const KEY = 'http-test-key-please-change';
const V1 = 'https://demo-bucket.oss-cn-hangzhou.aliyuncs.com/video/intro.mp4';
const V2 = 'https://other-bucket.oss-cn-beijing.aliyuncs.com/v2/new.mp4';

async function main() {
  const h = harness.createHarness('oss-shortlink HTTP 端点自检');
  let app = null;

  try {
    app = await sdk.createShortlink({
      publicBaseUrl: BASE,
      adminKey: KEY,
      brand: '测试品牌',
      store: sdk.memoryStore(),
      logRequests: false,
      flushIntervalMs: 0
    });

    const server = app.listen(PORT, '127.0.0.1');
    await once(server, 'listening');

    // ---------------------------------------------------------- 健康检查
    h.section('基础端点');

    let r = await fetch(BASE + '/healthz');
    let j = await r.json();
    h.check('GET /healthz 返回 200', r.status === 200, 'HTTP ' + r.status);
    h.check('healthz 返回 JSON 类型',
      String(r.headers.get('content-type') || '').indexOf('application/json') >= 0);
    h.check('healthz 报告 redirect 模式', j.streamMode === 'redirect', '实际 ' + j.streamMode);
    h.check('healthz 报告未启用签名', j.signedRead === false);

    r = await fetch(BASE + '/robots.txt');
    h.check('robots.txt 屏蔽 /v/', (await r.text()).indexOf('Disallow: /v/') >= 0);

    r = await fetch(BASE + '/');
    h.check('根路径有响应', r.status === 200);

    // ---------------------------------------------------------- 鉴权
    h.section('管理接口鉴权');

    r = await fetch(BASE + '/api/links');
    h.check('无密钥返回 401', r.status === 401, 'HTTP ' + r.status);

    r = await fetch(BASE + '/api/links?key=wrong-key-here');
    h.check('错误密钥返回 401', r.status === 401, 'HTTP ' + r.status);

    r = await fetch(BASE + '/api/links', { headers: { 'X-Admin-Key': KEY } });
    h.check('支持 X-Admin-Key 请求头', r.status === 200, 'HTTP ' + r.status);

    r = await fetch(BASE + '/api/links?key=' + KEY);
    h.check('query 密钥可访问', r.status === 200, 'HTTP ' + r.status);

    r = await fetch(BASE + '/admin?key=bad');
    h.check('管理台错误密钥返回 401', r.status === 401, 'HTTP ' + r.status);

    r = await fetch(BASE + '/admin?key=' + KEY, { redirect: 'manual' });
    const setCookie = r.headers.get('set-cookie') || '';
    h.check('管理台用 query 密钥换 cookie 后跳转，把密钥从地址里摘掉',
      r.status === 302 && r.headers.get('location') === '/admin', 'HTTP ' + r.status);
    h.check('会话 cookie 带 HttpOnly + SameSite=Strict',
      /HttpOnly/i.test(setCookie) && /SameSite=Strict/i.test(setCookie), setCookie);

    r = await fetch(BASE + '/admin', { headers: { Cookie: setCookie.split(';')[0] } });
    h.check('管理台可正常打开',
      r.status === 200 && (await r.text()).indexOf('短链管理台') >= 0, 'HTTP ' + r.status);

    // ---------------------------------------------------------- 创建
    h.section('创建与校验');

    r = await fetch(BASE + '/api/links?key=' + KEY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'HTTP 测试视频', desc: '自动生成的记录', videoUrl: V1 })
    });
    j = await r.json();
    h.check('创建返回 201', r.status === 201, 'HTTP ' + r.status + ' ' + JSON.stringify(j));
    const code = j.code;
    h.check('返回短码', !!code && code.length >= 4);
    h.check('分享链接使用 publicBaseUrl', String(j.shareUrl || '').indexOf(BASE + '/v/') === 0, j.shareUrl);

    r = await fetch(BASE + '/api/links?key=' + KEY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '坏地址', videoUrl: 'javascript:alert(1)' })
    });
    h.check('非法 videoUrl 返回 400', r.status === 400, 'HTTP ' + r.status);

    r = await fetch(BASE + '/api/links?key=' + KEY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '重复码', videoUrl: V1, code: code })
    });
    h.check('重复短码返回 400', r.status === 400, 'HTTP ' + r.status);

    r = await fetch(BASE + '/api/links?key=' + KEY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json-at-all'
    });
    h.check('非法 JSON 返回 400', r.status === 400, 'HTTP ' + r.status);

    // ---------------------------------------------------------- 播放页
    h.section('播放页');

    r = await fetch(BASE + '/v/' + code);
    const html = await r.text();
    h.check('播放页返回 200', r.status === 200, 'HTTP ' + r.status);
    h.check('播放页是 HTML', String(r.headers.get('content-type') || '').indexOf('text/html') >= 0);
    h.check('播放页显示标题', html.indexOf('HTTP 测试视频') >= 0);
    h.check('播放页使用同域取流地址', html.indexOf('/v/' + code + '/stream') >= 0);
    h.check('播放页不泄露源站域名', html.indexOf('aliyuncs.com') < 0);
    h.check('播放页带 noindex', html.indexOf('noindex') >= 0);
    h.check('响应头禁止嗅探', r.headers.get('x-content-type-options') === 'nosniff');

    // ---------------------------------------------------------- 取流
    h.section('取流 302');

    r = await fetch(BASE + '/v/' + code + '/stream', { redirect: 'manual' });
    const loc = r.headers.get('location') || '';
    h.check('取流返回 302', r.status === 302, 'HTTP ' + r.status);
    h.check('302 指向 OSS 原始地址', loc === V1, loc);
    h.check('302 禁止缓存', String(r.headers.get('cache-control') || '').indexOf('no-store') >= 0);
    h.check('302 带 noindex', String(r.headers.get('x-robots-tag') || '').indexOf('noindex') >= 0);

    // ---------------------------------------------------------- 统计
    h.section('统计');

    r = await fetch(BASE + '/api/links/' + code + '?key=' + KEY);
    j = await r.json();
    h.check('扫码量已累加', j.hits >= 1, 'hits=' + j.hits);
    h.check('记录了最后访问时间', !!j.lastHitAt);

    // ---------------------------------------------------------- 启停
    h.section('启停与换源');

    r = await fetch(BASE + '/api/links/' + code + '?key=' + KEY, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false })
    });
    h.check('停用返回 200', r.status === 200, 'HTTP ' + r.status);

    r = await fetch(BASE + '/v/' + code);
    h.check('停用后页面 404', r.status === 404, 'HTTP ' + r.status);

    r = await fetch(BASE + '/v/' + code + '/stream', { redirect: 'manual' });
    h.check('停用后取流 404', r.status === 404, 'HTTP ' + r.status);

    r = await fetch(BASE + '/api/links/' + code + '?key=' + KEY, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, title: '换过标题的视频' })
    });
    j = await r.json();
    h.check('重新启用并改标题', r.status === 200 && j.title === '换过标题的视频');

    r = await fetch(BASE + '/v/' + code, { redirect: 'manual' });
    h.check('启用后恢复可访问', r.status === 200, 'HTTP ' + r.status);

    r = await fetch(BASE + '/api/links/' + code + '?key=' + KEY, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoUrl: V2 })
    });
    h.check('后台换源返回 200', r.status === 200);

    r = await fetch(BASE + '/v/' + code + '/stream', { redirect: 'manual' });
    h.check('换源后 302 指向新地址',
      (r.headers.get('location') || '') === V2, r.headers.get('location'));

    // ---------------------------------------------------------- 异常与安全
    h.section('异常与安全');

    r = await fetch(BASE + '/v/zzzzzz');
    h.check('不存在的短码返回 404', r.status === 404, 'HTTP ' + r.status);

    r = await fetch(BASE + '/v/%2e%2e%2f%2e%2e%2fetc/passwd');
    h.check('路径穿越被挡', r.status === 404 || r.status === 400, 'HTTP ' + r.status);

    r = await fetch(BASE + '/api/links/' + code, { method: 'PUT', body: '{}' });
    h.check('缺密钥的写操作被拒', r.status === 401, 'HTTP ' + r.status);

    r = await fetch(BASE + '/healthz', { method: 'POST' });
    h.check('不支持的方法返回 405', r.status === 405, 'HTTP ' + r.status);

    // ---------------------------------------------------------- 列表与删除
    h.section('列表与删除');

    r = await fetch(BASE + '/api/links?key=' + KEY);
    j = await r.json();
    h.check('列表返回 publicBaseUrl', j.publicBaseUrl === BASE);
    h.check('列表数量正确', j.count === j.list.length);
    h.check('列表能搜到刚建的记录', j.list.some(function (x) { return x.code === code; }));

    r = await fetch(BASE + '/api/links/' + code + '?key=' + KEY, { method: 'DELETE' });
    h.check('删除返回 200', r.status === 200, 'HTTP ' + r.status);

    r = await fetch(BASE + '/v/' + code);
    h.check('删除后 404', r.status === 404, 'HTTP ' + r.status);

    r = await fetch(BASE + '/api/links/' + code + '?key=' + KEY);
    h.check('删除后单查 404', r.status === 404, 'HTTP ' + r.status);

    // ---------------------------------------------------------- 内嵌式挂载
    h.section('挂到已有 http server');

    const embeddedPort = PORT + 1;
    const plain = http.createServer(function (req, res) {
      if (req.url === '/my-own-route') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end('host app speaking');
      }
      app.handler(req, res);
    });
    plain.listen(embeddedPort, '127.0.0.1');
    await once(plain, 'listening');

    r = await fetch('http://127.0.0.1:' + embeddedPort + '/my-own-route');
    h.check('宿主应用自有路由不受影响', (await r.text()) === 'host app speaking');

    r = await fetch('http://127.0.0.1:' + embeddedPort + '/healthz');
    h.check('SDK 路由在宿主 server 上可用', r.status === 200 && (await r.json()).ok === true);

    await new Promise(function (resolve) { plain.close(resolve); });
  } catch (e) {
    h.check('测试执行未抛未捕获异常', false, (e && e.stack) || String(e));
  } finally {
    if (app) await app.close();
  }

  process.exit(h.summary() ? 1 : 0);
}

main();

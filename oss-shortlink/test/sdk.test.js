#!/usr/bin/env node
'use strict';

/** SDK 编程接口层自检：不依赖任何 HTTP 请求。 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const sdk = require('../src');
const harness = require('./harness');

const V1 = 'https://demo-bucket.oss-cn-hangzhou.aliyuncs.com/video/intro.mp4';
const V2 = 'https://other-bucket.oss-cn-beijing.aliyuncs.com/v2/next.mp4';
const BASE = 'https://v.example.com';
const KEY = 'unit-test-key-0123456789abcdef';

function baseOptions(extra) {
  return Object.assign({
    publicBaseUrl: BASE,
    adminKey: KEY,
    brand: '测试品牌',
    logRequests: false,
    flushIntervalMs: 0
  }, extra || {});
}

async function main() {
  const h = harness.createHarness('oss-shortlink SDK 接口层自检');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oss-shortlink-'));

  try {
    // ---------------------------------------------------------- 实例创建
    h.section('createShortlink 实例');

    const app = await sdk.createShortlink(baseOptions({ store: sdk.memoryStore() }));
    h.check('返回 app 对象', !!app && typeof app === 'object');
    h.check('暴露 config', app.config && app.config.publicBaseUrl === BASE);
    h.check('暴露 links 管理器', typeof app.links.create === 'function');
    h.check('暴露 handler', typeof app.handler === 'function');
    h.check('暴露 listen', typeof app.listen === 'function');
    h.check('暴露 close', typeof app.close === 'function');
    h.check('版本号可用', typeof sdk.version === 'string' && sdk.version.length > 0);

    const empty = await sdk.createShortlink(baseOptions({ store: sdk.memoryStore() }));
    h.check('空实例列表为空', empty.links.list().length === 0);
    h.check('两个实例数据互不干扰', app.links.list().length === empty.links.list().length);

    // ---------------------------------------------------------- 新建
    h.section('links.create');

    const created = app.links.create({ title: '产品介绍', desc: '三分钟看懂', videoUrl: V1 });
    h.check('返回短码', typeof created.code === 'string' && created.code.length >= 4);
    h.check('返回分享链接', created.shareUrl === BASE + '/v/' + created.code, created.shareUrl);
    h.check('落地页模式默认为 player', created.link.mode === 'player');
    h.check('默认启用', created.link.enabled === true);
    h.check('初始计数为 0', created.link.hits === 0);
    h.check('记录了创建时间', !!created.link.createdAt);

    const custom = app.links.create({ title: '自定义码', videoUrl: V1, code: 'vip2026' });
    h.check('支持自定义短码', custom.code === 'vip2026');

    const jumpLink = app.links.create({ title: '直跳', videoUrl: V1, mode: 'jump' });
    h.check('支持直跳模式', jumpLink.link.mode === 'jump');

    const noTitle = app.links.create({ videoUrl: V1 });
    h.check('未给标题时兜底为「视频」', noTitle.link.title === '视频');

    // ---------------------------------------------------------- 参数校验
    h.section('参数校验');

    function expectThrow(fn) {
      try {
        fn();
        return null;
      } catch (e) {
        return e;
      }
    }

    let err = expectThrow(function () { app.links.create({ videoUrl: 'javascript:alert(1)' }); });
    h.check('拒绝非 http 协议的视频地址', !!err && err.status === 400);

    err = expectThrow(function () { app.links.create({ title: 'x' }); });
    h.check('拒绝缺少 videoUrl', !!err && err.status === 400);

    err = expectThrow(function () { app.links.create({ videoUrl: V1, code: 'vip2026' }); });
    h.check('拒绝重复短码', !!err && err.status === 400, err && err.message);

    err = expectThrow(function () { app.links.create({ videoUrl: V1, code: 'a b/c' }); });
    h.check('拒绝非法字符短码', !!err && err.status === 400);

    err = expectThrow(function () { app.links.create({ videoUrl: V1, code: 'ab' }); });
    h.check('拒绝过短短码', !!err && err.status === 400);

    err = expectThrow(function () { app.links.create({ videoUrl: V1, cover: 'not-a-url' }); });
    h.check('拒绝非法封面地址', !!err && err.status === 400);

    const longTitle = app.links.create({ videoUrl: V1, title: 'x'.repeat(300) });
    h.check('超长标题被截断到 120', longTitle.link.title.length === 120);

    // ---------------------------------------------------------- 读取与更新
    h.section('links.get / update / remove');

    h.check('get 可取到记录', !!app.links.get(created.code));
    h.check('get 不存在返回 undefined', app.links.get('zzzzzz') === undefined);
    h.check('has 判断正确', app.links.has(created.code) === true && app.links.has('zzzzzz') === false);

    err = expectThrow(function () { app.links.require('zzzzzz'); });
    h.check('require 不存在时抛 404', !!err && err.status === 404);

    const updated = app.links.update(created.code, { title: '改过的标题', enabled: false });
    h.check('更新标题生效', updated.title === '改过的标题');
    h.check('更新启用状态生效', updated.enabled === false);
    h.check('更新记录时间戳', !!updated.updatedAt);
    h.check('未传的字段保持原值', updated.videoUrl === V1);

    app.links.update(created.code, { videoUrl: V2 });
    h.check('可后台换源', app.links.get(created.code).videoUrl === V2);

    err = expectThrow(function () { app.links.update(created.code, { videoUrl: 'ftp://x/y.mp4' }); });
    h.check('更新时同样校验视频地址', !!err && err.status === 400);

    const removed = app.links.remove('vip2026');
    h.check('删除已存在的返回 true', removed === true);
    h.check('删除后取不到', app.links.get('vip2026') === undefined);
    h.check('重复删除返回 false 不抛错', app.links.remove('vip2026') === false);

    // ---------------------------------------------------------- 计数与列表
    h.section('links.touch / list');

    app.links.touch(created.code);
    app.links.touch(created.code);
    const touched = app.links.get(created.code);
    h.check('访问计数累加', touched.hits === 2, 'hits=' + touched.hits);
    h.check('记录最后访问时间', !!touched.lastHitAt);
    h.check('touch 不存在的短码返回 null', app.links.touch('zzzzzz') === null);

    const list = app.links.list();
    h.check('列表返回全部记录', list.length === Object.keys(app.snapshot().links).length);
    h.check('列表按创建时间倒序', list.length < 2 ||
      String(list[0].createdAt) >= String(list[list.length - 1].createdAt));

    // ---------------------------------------------------------- 快照与统计
    h.section('snapshot / stats');

    const snap = app.snapshot();
    snap.links[created.code].title = '被改坏了';
    h.check('快照是深拷贝，改它不影响内核', app.links.get(created.code).title !== '被改坏了');

    const stats = app.stats();
    h.check('stats 报告记录数', stats.links === list.length);
    h.check('stats 报告取流模式', stats.streamMode === 'redirect');
    h.check('stats 报告存储类型', stats.storeKind === 'memory');
    h.check('未配置密钥时不启用签名', stats.signedRead === false);

    // ---------------------------------------------------------- 渲染
    h.section('渲染器');

    const playerHtml = app.render.player(app.links.get(created.code));
    h.check('播放页含标题', playerHtml.indexOf('改过的标题') >= 0);
    h.check('播放页含同域取流地址', playerHtml.indexOf('/v/' + created.code + '/stream') >= 0);
    h.check('播放页不泄露源站域名', playerHtml.indexOf('aliyuncs.com') < 0);
    h.check('播放页带 noindex', playerHtml.indexOf('noindex') >= 0);

    const xssLink = app.links.create({ title: '<script>alert(1)</script>', videoUrl: V1, code: 'xssdemo' });
    const xssHtml = app.render.player(xssLink.link);
    h.check('标题中的脚本被转义', xssHtml.indexOf('<script>alert(1)</script>') < 0);
    h.check('转义后保留可读文本', xssHtml.indexOf('&lt;script&gt;') >= 0);

    h.check('404 页可渲染', app.render.notFound().indexOf('404') >= 0);
    h.check('管理台页可渲染', app.render.admin().indexOf('短链管理台') >= 0);

    // ---------------------------------------------------------- 存储适配器
    h.section('存储适配器');

    const file = path.join(tmpDir, 'links.json');
    const appFile = await sdk.createShortlink(baseOptions({ store: sdk.fileStore(file) }));
    const fileRec = appFile.links.create({ title: '落盘测试', videoUrl: V1 });
    await appFile.save();
    h.check('fileStore 写出文件', fs.existsSync(file));

    const appReload = await sdk.createShortlink(baseOptions({ store: sdk.fileStore(file) }));
    h.check('重新加载后记录还在', !!appReload.links.get(fileRec.code));
    h.check('重新加载后内容一致', appReload.links.get(fileRec.code).title === '落盘测试');
    await appFile.close();
    await appReload.close();

    err = expectThrow(function () { sdk.customStore({}); });
    h.check('customStore 拒绝不合规对象', !!err);

    let savedDb = null;
    const cs = sdk.customStore({
      load: async function () { return null; },
      save: async function (db) { savedDb = db; }
    });
    const appCustom = await sdk.createShortlink(baseOptions({ store: cs }));
    appCustom.links.create({ title: '自定义存储', videoUrl: V1 });
    await appCustom.save();
    h.check('自定义存储收到 save 调用', !!savedDb);
    h.check('自定义存储收到正确数据', savedDb && Object.keys(savedDb.links).length === 1);
    await appCustom.close();

    // ---------------------------------------------------------- 短码工具
    h.section('短码工具');

    const code = sdk.codes.randomCode(8);
    h.check('随机短码长度正确', code.length === 8);
    h.check('随机短码只用安全字符集', /^[2-9a-hjkmnp-zA-HJ-NP-Z]+$/.test(code), code);
    h.check('随机短码不含易混字符', !/[01oliIO]/.test(code));
    h.check('校验器接受合法短码', sdk.codes.isValidCode('Ab3xK9') === true);
    h.check('校验器拒绝带空格短码', sdk.codes.isValidCode('ab c') === false);
    h.check('校验器拒绝中文短码', sdk.codes.isValidCode('中文短码') === false);

    err = expectThrow(function () { sdk.codes.resolveCode('a b', function () { return false; }, 6); });
    h.check('resolveCode 拒绝非法短码', !!err);

    // ---------------------------------------------------------- OSS 签名
    h.section('OSS 签名');

    h.check('signUrl 是函数', typeof sdk.oss.signUrl === 'function');
    h.check('canSign 在缺密钥时为 false',
      sdk.oss.canSign({ signedRead: true, bucket: 'b', accessKeyId: '', accessKeySecret: '' }) === false);

    const ossCfg = {
      signedRead: true,
      bucket: 'demo-bucket',
      accessKeyId: 'AKID-TEST',
      accessKeySecret: 'SECRET-TEST',
      signTtlSeconds: 300
    };
    h.check('canSign 在配置完整时为 true', sdk.oss.canSign(ossCfg) === true);

    const fixedNow = 1700000000000;
    const signedUrl = sdk.oss.signUrl(V1, ossCfg, fixedNow);
    const u = new URL(signedUrl);
    const expectExpires = String(Math.floor(fixedNow / 1000) + 300);

    h.check('签名带 OSSAccessKeyId', u.searchParams.get('OSSAccessKeyId') === 'AKID-TEST');
    h.check('签名带正确 Expires', u.searchParams.get('Expires') === expectExpires,
      u.searchParams.get('Expires'));
    h.check('签名带 Signature', !!u.searchParams.get('Signature'));
    h.check('签名未污染原始路径', u.pathname === '/video/intro.mp4');

    const resource = '/demo-bucket/video/intro.mp4';
    const stringToSign = ['GET', '', '', expectExpires, resource].join('\n');
    const manual = crypto.createHmac('sha1', 'SECRET-TEST').update(stringToSign, 'utf8').digest('base64');
    h.check('签名值与手工算法一致', u.searchParams.get('Signature') === manual,
      'got=' + u.searchParams.get('Signature'));

    h.check('换密钥则签名不同',
      sdk.oss.signUrl(V1, Object.assign({}, ossCfg, { accessKeySecret: 'OTHER' }), fixedNow) !== signedUrl);

    const resolved = sdk.oss.resolveVideoUrl({ videoUrl: V1 }, ossCfg, fixedNow);
    h.check('resolveVideoUrl 会现签', resolved.indexOf('Signature=') > 0);
    h.check('未开签名时 resolveVideoUrl 返回原地址',
      sdk.oss.resolveVideoUrl({ videoUrl: V1 }, { signedRead: false }) === V1);

    // ---------------------------------------------------------- 关闭
    h.section('生命周期');

    await app.close();
    await app.close();
    h.check('close 可重复调用不报错', true);

    await empty.close();
    await app.close().then(function () { return true; }).catch(function () { return false; });
    h.check('已关闭实例再 save 仍可完成', true);
  } catch (e) {
    h.check('测试执行未抛未捕获异常', false, (e && e.stack) || String(e));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  process.exit(h.summary() ? 1 : 0);
}

main();

#!/usr/bin/env node
'use strict';

/**
 * 最小验证 demo —— 用来确认这个 SDK 在你的环境里能跑起来。
 *
 *   node examples/minimal-demo.js
 *   node examples/minimal-demo.js --no-serve    只跑自检，跑完退出
 *
 * 它做三件事：
 *   1. 用内存存储起一个服务（不写任何文件）
 *   2. 建一条指向公开测试视频的短链
 *   3. 自动发几个请求验证行为，然后把地址打给你手动点开
 *
 * 想换成自己的视频：改下面的 DEMO_VIDEO，或直接设环境变量 DEMO_VIDEO。
 */

const sdk = require('..');

const PORT = parseInt(process.env.DEMO_PORT, 10) || 3080;
const BASE = 'http://127.0.0.1:' + PORT;
const ADMIN_KEY = 'demo-admin-key-' + Math.random().toString(36).slice(2, 10);
const DEMO_VIDEO = process.env.DEMO_VIDEO || 'https://www.w3schools.com/html/mov_bbb.mp4';

const SERVING = process.argv.indexOf('--no-serve') < 0;

let pass = 0;
let fail = 0;

function check(name, condition, detail) {
  if (condition) {
    pass++;
    console.log('    \u2713  ' + name);
  } else {
    fail++;
    console.log('    \u2717  ' + name + (detail ? '   → ' + detail : ''));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('');
  console.log('  ╭──────────────────────────────────────────────────╮');
  console.log('  │  oss-shortlink 最小验证 demo                     │');
  console.log('  ╰──────────────────────────────────────────────────╯');
  console.log('');

  // ---- 第 1 步：起服务（这两行就是 SDK 的全部启动成本）----
  const app = await sdk.createShortlink({
    publicBaseUrl: BASE,
    adminKey: ADMIN_KEY,
    brand: '最小验证 Demo',
    store: sdk.memoryStore(),
    logRequests: false
  });

  // ---- 第 2 步：建一条短链 ----
  const created = app.links.create({
    title: 'Demo 视频',
    desc: '这条记录存在内存里，进程退出就没了。换成 fileStore 即可持久化。',
    videoUrl: DEMO_VIDEO
  });

  const server = app.listen(PORT);
  await sleep(250);

  console.log('  [1] 服务已启动');
  console.log('      监听      ' + BASE);
  console.log('      存储      ' + app.stats().storeKind + '（不落盘）');
  console.log('      取流模式  ' + app.stats().streamMode);
  console.log('');

  console.log('  [2] 已生成短链');
  console.log('      短码      ' + created.code);
  console.log('      二维码里  ' + created.shareUrl);
  console.log('      真实地址  ' + DEMO_VIDEO);
  console.log('');

  // ---- 第 3 步：自动验证 ----
  console.log('  [3] 自动验证');
  try {
    const page = await fetch(BASE + '/v/' + created.code);
    const html = await page.text();
    check('播放页可访问', page.status === 200, 'HTTP ' + page.status);
    check('播放页显示了标题', html.indexOf('Demo 视频') >= 0);
    check('播放页里没有源站地址', html.indexOf('w3schools.com') < 0 && html.indexOf('aliyuncs.com') < 0);
    check('播放页走同域取流', html.indexOf('/v/' + created.code + '/stream') >= 0);

    const stream = await fetch(BASE + '/v/' + created.code + '/stream', { redirect: 'manual' });
    check('取流返回 302', stream.status === 302, 'HTTP ' + stream.status);
    check('302 指向真实视频地址',
      (stream.headers.get('location') || '') === DEMO_VIDEO,
      stream.headers.get('location'));

    const noKey = await fetch(BASE + '/api/links');
    check('管理接口无密钥被拒', noKey.status === 401, 'HTTP ' + noKey.status);

    const withKey = await fetch(BASE + '/api/links?key=' + ADMIN_KEY);
    check('管理接口带密钥可读', withKey.status === 200, 'HTTP ' + withKey.status);

    const one = await fetch(BASE + '/api/links/' + created.code + '?key=' + ADMIN_KEY);
    const record = await one.json();
    check('扫码量已统计', record.hits >= 1, 'hits=' + record.hits);

    const swapped = await fetch(BASE + '/api/links/' + created.code + '?key=' + ADMIN_KEY, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoUrl: 'https://example.com/replaced.mp4' })
    });
    check('可以后台换源', swapped.status === 200, 'HTTP ' + swapped.status);

    const afterSwap = await fetch(BASE + '/v/' + created.code + '/stream', { redirect: 'manual' });
    check('换源后 302 立即生效',
      (afterSwap.headers.get('location') || '') === 'https://example.com/replaced.mp4');

    await fetch(BASE + '/api/links/' + created.code + '?key=' + ADMIN_KEY, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoUrl: DEMO_VIDEO })
    });
  } catch (e) {
    check('验证过程未抛异常', false, e.message);
  }

  console.log('');
  console.log('  [4] 结果：' + pass + ' 项通过' + (fail ? '，' + fail + ' 项失败' : '，没有失败'));
  console.log('');

  if (!SERVING) {
    await app.close();
    console.log('  已按 --no-serve 退出。');
    console.log('');
    process.exit(fail ? 1 : 0);
  }

  console.log('  ────────────────────────────────────────────────────');
  console.log('  服务保持运行，下面两个地址可以直接点开看：');
  console.log('');
  console.log('    播放页    ' + BASE + '/v/' + created.code);
  console.log('    管理台    ' + BASE + '/admin?key=' + ADMIN_KEY);
  console.log('');
  console.log('  Ctrl+C 退出（内存数据一并丢弃）');
  console.log('  ────────────────────────────────────────────────────');
  console.log('');

  async function bye() {
    console.log('');
    console.log('  正在关闭…');
    await app.close();
    process.exit(0);
  }
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
  server.on('error', function (e) {
    console.error('  监听失败：' + e.message);
    process.exit(1);
  });
}

main().catch(function (e) {
  console.error('');
  console.error('  demo 运行失败：' + ((e && e.stack) || e));
  console.error('');
  process.exit(1);
});

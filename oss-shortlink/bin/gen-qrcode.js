#!/usr/bin/env node
'use strict';

/**
 * 批量生成二维码 PNG。
 *
 *   oss-shortlink-qr                    生成全部启用中的短链
 *   oss-shortlink-qr Ab3xK9             只生成指定短码
 *   oss-shortlink-qr Ab3xK9 --size 900 --out ./qr
 *
 * 依赖可选包 qrcode：npm i qrcode
 */

const fs = require('fs');
const path = require('path');
const configLib = require('../src/config');
const { fileStore } = require('../src/store');

const ROOT = path.join(__dirname, '..');

function parseArgs(argv) {
  const opts = { codes: [], size: 720, out: path.join(ROOT, 'output', 'qrcode') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--size') opts.size = parseInt(argv[++i], 10) || 720;
    else if (a === '--out') opts.out = path.resolve(process.cwd(), argv[++i]);
    else if (a[0] !== '-') opts.codes.push(a);
  }
  return opts;
}

const USAGE = [
  '',
  '  oss-shortlink-qr —— 批量生成短链二维码 PNG',
  '',
  '  用法',
  '    oss-shortlink-qr                      生成全部启用中的短链',
  '    oss-shortlink-qr Ab3xK9               只生成指定短码',
  '    oss-shortlink-qr Ab3xK9 xy12Zw        同时生成多个短码',
  '    oss-shortlink-qr --size 900 --out ./qr',
  '    oss-shortlink-qr --help               显示本帮助',
  '',
  '  选项',
  '    --size <px>   图片边长，默认 720',
  '    --out <dir>   输出目录，默认 <包目录>/output/qrcode',
  '',
  '  前置条件',
  '    1. 已装可选依赖：npm install qrcode',
  '    2. config.json 里的 publicBaseUrl 是公网域名（不能是本地地址）',
  '    3. data/links.json 里已有短链记录',
  '',
  '  注意',
  '    二维码指向 config.json 里的 publicBaseUrl，换了域名要重新生成。',
  ''
].join('\n');

async function main() {
  const argv = process.argv.slice(2);

  if (argv.indexOf('--help') >= 0 || argv.indexOf('-h') >= 0) {
    console.log(USAGE);
    return;
  }

  const opts = parseArgs(argv);

  let QRCode;
  try {
    QRCode = require('qrcode');
  } catch (e) {
    console.error('');
    console.error('  缺少依赖 qrcode，请先执行：');
    console.error('    npm install qrcode');
    console.error('');
    process.exit(1);
  }

  const cfg = configLib.loadFromDisk(ROOT, process.env);

  if (!cfg.publicBaseUrl || cfg.publicBaseUrl === 'http://127.0.0.1:' + cfg.port) {
    throw new Error('配置里的 publicBaseUrl 还是本地地址，请改成你的公网域名后再生成');
  }

  const store = fileStore(path.join(ROOT, 'data', 'links.json'));
  const db = await store.load();
  const all = Object.keys(db.links).map(function (k) { return db.links[k]; });

  const picked = opts.codes.length
    ? all.filter(function (l) { return opts.codes.indexOf(l.code) >= 0; })
    : all.filter(function (l) { return l.enabled; });

  if (!picked.length) {
    console.log('没有可生成的短链。');
    if (opts.codes.length) console.log('指定的短码不存在：' + opts.codes.join(', '));
    return;
  }

  fs.mkdirSync(opts.out, { recursive: true });

  for (const link of picked) {
    const url = cfg.publicBaseUrl + '/v/' + link.code;
    const file = path.join(opts.out, link.code + '.png');
    await QRCode.toFile(file, url, {
      width: opts.size,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: { dark: '#000000ff', light: '#ffffffff' }
    });
    console.log('  ' + link.code + '  ->  ' + url);
    console.log('      已保存 ' + file);
  }

  console.log('');
  console.log('  共生成 ' + picked.length + ' 张，输出目录：' + opts.out);
  console.log('');
}

main().catch(function (e) {
  console.error('[error] ' + e.message);
  process.exit(1);
});

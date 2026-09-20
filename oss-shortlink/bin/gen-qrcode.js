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

const { parseArgs, resolveProject, UsageError } = require('./paths');

const configLib = require('../src/config');
const { fileStore } = require('../src/store');

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
  '    --size <px>       图片边长，100-4000，默认 720',
  '    --out <dir>       输出目录，默认 ./output/qrcode',
  '    --config <file>   配置文件路径，默认 ./config.json',
  '    --data <file>     数据文件路径，默认 <配置文件所在目录>/data/links.json',
  '',
  '  环境变量',
  '    CONFIG_FILE / DATA_FILE   同 --config / --data',
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

function isLocalBaseUrl(value) {
  try {
    const h = new URL(String(value)).hostname;
    return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '0.0.0.0' || h === '[::1]';
  } catch (e) {
    return true;
  }
}

async function main() {
  let argv;
  try {
    argv = parseArgs(process.argv.slice(2), {
      values: ['--config', '--data', '--out', '--size'],
      bools: ['--help', '-h']
    });
  } catch (e) {
    if (e.name !== 'UsageError') throw e;
    console.error('');
    console.error('  ' + e.message);
    console.error('  运行 oss-shortlink-qr --help 查看用法');
    console.error('');
    process.exit(1);
  }

  if (argv.help || argv.h) { console.log(USAGE); return; }

  let size = 720;
  if (argv.size !== undefined) {
    size = parseInt(argv.size, 10);
    if (!isFinite(size) || size < 100 || size > 4000) {
      console.error('');
      console.error('  --size 需要在 100-4000 之间，收到：' + argv.size);
      console.error('');
      process.exit(1);
    }
  }

  // 按需加载可选依赖：没装 qrcode 时 --help 依然可用
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

  const proj = resolveProject(argv, process.env);
  const outDir = argv.out
    ? path.resolve(proj.cwd, argv.out)
    : path.join(proj.cwd, 'output', 'qrcode');

  let cfg;
  try {
    cfg = configLib.loadFromFile(proj.configFile, process.env);
  } catch (e) {
    console.error('');
    console.error('  ' + e.message);
    if (e.code === 'CONFIG_NOT_FOUND') {
      console.error('  首次使用先执行：oss-shortlink init');
    }
    console.error('');
    process.exit(1);
  }

  if (!/^https?:\/\//i.test(cfg.publicBaseUrl) || isLocalBaseUrl(cfg.publicBaseUrl)) {
    console.error('');
    console.error('  配置里的 publicBaseUrl 还是本地地址（' + cfg.publicBaseUrl + '），');
    console.error('  二维码印出去就扫不开了，请先改成你的公网域名。');
    console.error('');
    process.exit(1);
  }

  if (!fs.existsSync(proj.dataFile)) {
    console.error('');
    console.error('  找不到数据文件：' + proj.dataFile);
    console.error('  先用 oss-shortlink 启动服务并建立短链，或用 --data 指定路径。');
    console.error('');
    process.exit(1);
  }

  const db = await fileStore(proj.dataFile).load();
  const all = Object.keys(db.links).map(function (k) { return db.links[k]; });

  const picked = argv.rest.length
    ? all.filter(function (l) { return argv.rest.indexOf(l.code) >= 0; })
    : all.filter(function (l) { return l.enabled; });

  if (!picked.length) {
    console.log('没有可生成的短链。');
    if (argv.rest.length) console.log('指定的短码不存在：' + argv.rest.join(', '));
    return;
  }

  fs.mkdirSync(outDir, { recursive: true });

  for (const link of picked) {
    const url = cfg.publicBaseUrl + '/v/' + link.code;
    const file = path.join(outDir, link.code + '.png');
    await QRCode.toFile(file, url, {
      width: size,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: { dark: '#000000ff', light: '#ffffffff' }
    });
    console.log('  ' + link.code + '  ->  ' + url);
    console.log('      已保存 ' + file);
  }

  console.log('');
  console.log('  共生成 ' + picked.length + ' 张，输出目录：' + outDir);
  console.log('');
}

main().catch(function (e) {
  console.error('[error] ' + e.message);
  process.exit(1);
});

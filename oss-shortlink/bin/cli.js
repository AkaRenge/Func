#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { parseArgs, resolveProject, UsageError } = require('./paths');
const pkg = require('../package.json');

const EXAMPLE = path.join(__dirname, '..', 'config.example.json');

const USAGE = [
  '',
  '  oss-shortlink —— 把对象存储上的视频包成短链 + 同域 H5 播放页',
  '',
  '  用法',
  '    oss-shortlink                在当前目录读取 config.json 并启动服务',
  '    oss-shortlink init           生成一份 config.json（adminKey 随机生成）',
  '    oss-shortlink --help         显示本帮助',
  '    oss-shortlink --version      显示版本号',
  '',
  '  选项',
  '    --config <file>   配置文件路径，默认 ./config.json',
  '    --data <file>     数据文件路径，默认 <配置文件所在目录>/data/links.json',
  '',
  '  环境变量（覆盖配置文件里的同名项）',
  '    CONFIG_FILE       同 --config',
  '    DATA_FILE         同 --data',
  '    PORT / HOST       监听端口与地址',
  '    PUBLIC_BASE_URL   公网前缀，如 https://v.example.com',
  '    ADMIN_KEY         管理密钥',
  '    STREAM_MODE       redirect(默认) 或 proxy',
  '',
  '  起步',
  '    oss-shortlink init            生成 config.json，密钥已随机填好',
  '    然后改这两项：publicBaseUrl 换成你的域名、brand 换成你的品牌',
  '    oss-shortlink                 启动',
  '',
  '  相关命令',
  '    oss-shortlink-qr   批量生成短链二维码 PNG',
  '',
  '  文档',
  '    ' + (pkg.homepage || 'https://www.npmjs.com/package/' + pkg.name),
  ''
].join('\n');

function initProject(argv) {
  const target = path.resolve(process.cwd(), 'config.json');

  if (fs.existsSync(target) && !argv.force) {
    console.error('');
    console.error('  config.json 已存在：' + target);
    console.error('  要覆盖请加 --force');
    console.error('');
    return 1;
  }

  const cfg = JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));
  // 24 字节 base64url ≈ 32 个字符，直接可用，省掉「随便想个随机串」这一步
  cfg.adminKey = crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(target, JSON.stringify(cfg, null, 2) + '\n', 'utf8');

  console.log('');
  console.log('  已生成 ' + target);
  console.log('  adminKey 已随机生成，publicBaseUrl 还需要你改成自己的域名：');
  console.log('    ' + cfg.publicBaseUrl + '   ->   https://v.你的域名');
  console.log('');
  console.log('  改完后运行：oss-shortlink');
  console.log('');
  return 0;
}

async function main() {
  let argv;
  try {
    argv = parseArgs(process.argv.slice(2), {
      values: ['--config', '--data'],
      bools: ['--help', '-h', '--version', '-v', '--force']
    });
  } catch (e) {
    if (e.name !== 'UsageError') throw e;
    console.error('');
    console.error('  ' + e.message);
    console.error('  运行 oss-shortlink --help 查看用法');
    console.error('');
    process.exit(1);
  }

  if (argv.help || argv.h) { console.log(USAGE); return; }
  if (argv.version || argv.v) { console.log(pkg.version); return; }

  const cmd = argv.rest[0];
  if (cmd === 'init') { process.exit(initProject(argv)); }
  if (cmd) {
    console.error('');
    console.error('  未知子命令：' + cmd);
    console.error('  运行 oss-shortlink --help 查看用法');
    console.error('');
    process.exit(1);
  }

  const configLib = require('../src/config');
  const { createShortlink } = require('../src');

  const proj = resolveProject(argv, process.env);

  if (process.env.STREAM_MODE && !configLib.isValidStreamMode(process.env.STREAM_MODE)) {
    console.error('  [warn] STREAM_MODE=' + process.env.STREAM_MODE + ' 不是 redirect/proxy，已忽略');
  }

  let app;
  try {
    app = await createShortlink({ configFile: proj.configFile, dataFile: proj.dataFile });
  } catch (e) {
    console.error('');
    console.error('  启动失败：' + e.message);
    if (e.code === 'CONFIG_NOT_FOUND') {
      console.error('  首次使用先执行：oss-shortlink init');
    }
    console.error('');
    process.exit(1);
  }

  const cfg = app.config;
  const server = app.listen();

  server.on('error', function (e) {
    if (e.code === 'EADDRINUSE') {
      console.error('  端口 ' + cfg.port + ' 已被占用，改一下 config.json 里的 port');
    } else {
      console.error('  监听失败：' + e.message);
    }
    process.exit(1);
  });

  server.on('listening', function () {
    console.log('');
    console.log('  oss-shortlink 已启动');
    console.log('  配置文件   ' + (cfg.__source || '内存配置'));
    console.log('  数据文件   ' + proj.dataFile);
    console.log('  监听地址   ' + cfg.host + ':' + cfg.port);
    console.log('  公网前缀   ' + cfg.publicBaseUrl);
    console.log('  取流模式   ' + (cfg.streamMode === 'proxy' ? '服务端代理（源站隐形）' : '302 直跳 OSS（推荐）'));
    console.log('  管理入口   ' + cfg.publicBaseUrl + '/admin?key=***');
    console.log('  已有短链   ' + app.links.count() + ' 条');
    console.log('');
  });

  let shuttingDown = false;
  async function bye() {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('');
    console.log('  正在落盘并退出…');
    await app.close();
    process.exit(0);
  }

  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}

main();

#!/usr/bin/env node
'use strict';

const path = require('path');
const pkg = require('../package.json');

const ROOT = path.join(__dirname, '..');

const USAGE = [
  '',
  '  oss-shortlink —— 把对象存储上的视频包成短链 + 同域 H5 播放页',
  '',
  '  用法',
  '    oss-shortlink                 读取 config.json 并启动服务',
  '    oss-shortlink --help          显示本帮助',
  '    oss-shortlink --version       显示版本号',
  '',
  '  环境变量（覆盖配置文件里的同名项）',
  '    CONFIG_FILE       配置文件路径，默认 <包目录>/config.json',
  '    PORT / HOST       监听端口与地址',
  '    PUBLIC_BASE_URL   公网前缀，如 https://v.example.com',
  '    ADMIN_KEY         管理密钥',
  '    STREAM_MODE       redirect(默认) 或 proxy',
  '',
  '  起步',
  '    cp config.example.json config.json',
  '    然后至少改这三项：',
  '      publicBaseUrl    你的公网前缀',
  '      adminKey         32 位以上随机串',
  '      brand            播放页品牌名',
  '',
  '  相关命令',
  '    oss-shortlink-qr   批量生成短链二维码 PNG',
  '',
  '  文档',
  '    ' + (pkg.homepage || 'https://www.npmjs.com/package/' + pkg.name),
  ''
].join('\n');

async function main() {
  const argv = process.argv.slice(2);

  if (argv.indexOf('--help') >= 0 || argv.indexOf('-h') >= 0) {
    console.log(USAGE);
    return;
  }
  if (argv.indexOf('--version') >= 0 || argv.indexOf('-v') >= 0) {
    console.log(pkg.version);
    return;
  }

  const known = ['--help', '-h', '--version', '-v'];
  const unknown = argv.filter(function (a) { return a.charAt(0) === '-' && known.indexOf(a) < 0; });
  if (unknown.length) {
    console.error('');
    console.error('  未知参数：' + unknown.join(', '));
    console.error('  运行 oss-shortlink --help 查看用法');
    console.error('');
    process.exit(1);
  }

  const { createShortlink } = require('../src');

  let app;
  try {
    app = await createShortlink({
      configFile: process.env.CONFIG_FILE || path.join(ROOT, 'config.json')
    });
  } catch (e) {
    console.error('');
    console.error('  启动失败：' + e.message);
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
    console.log('  配置来源   ' + (cfg.__source || '内存配置'));
    console.log('  监听地址   ' + cfg.host + ':' + cfg.port);
    console.log('  公网前缀   ' + cfg.publicBaseUrl);
    console.log('  取流模式   ' + (cfg.streamMode === 'proxy' ? '服务端代理（源站隐形）' : '302 直跳 OSS（推荐）'));
    console.log('  管理入口   ' + cfg.publicBaseUrl + '/admin?key=***');
    console.log('  已有短链   ' + app.links.list().length + ' 条');
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

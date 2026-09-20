'use strict';

const fs = require('fs');
const path = require('path');

const PLACEHOLDER_KEY = 'CHANGE-ME-TO-A-LONG-RANDOM-STRING';
const DEFAULT_PORT = 3000;
const DEFAULT_CODE_LENGTH = 6;
const DEFAULT_SIGN_TTL = 300;

function readJsonFile(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
  if (!raw) throw new Error('配置文件内容为空：' + file);
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error('配置文件不是合法 JSON（' + file + '）：' + e.message);
  }
}

function findConfigFile(rootDir) {
  const own = path.join(rootDir, 'config.json');
  const sample = path.join(rootDir, 'config.example.json');
  if (fs.existsSync(own)) return own;
  if (fs.existsSync(sample)) return sample;
  return null;
}

function toInt(value, fallback, min, max) {
  const n = parseInt(value, 10);
  if (!isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function normalizeOss(input) {
  const o = Object.assign({}, input || {});
  return {
    signedRead: !!o.signedRead,
    endpoint: String(o.endpoint || ''),
    bucket: String(o.bucket || ''),
    accessKeyId: String(o.accessKeyId || ''),
    accessKeySecret: String(o.accessKeySecret || ''),
    signTtlSeconds: toInt(o.signTtlSeconds, DEFAULT_SIGN_TTL, 10, 86400)
  };
}

/**
 * 把外部配置规整成内部结构：补默认值、校正类型、夹紧范围。
 * 纯函数，不读文件、不碰环境变量。
 */
function normalize(input) {
  const raw = Object.assign({}, input || {});
  const port = toInt(raw.port, DEFAULT_PORT, 1, 65535);

  return {
    port: port,
    host: String(raw.host || '127.0.0.1'),
    publicBaseUrl: String(raw.publicBaseUrl || ('http://127.0.0.1:' + port)).replace(/\/+$/, ''),
    adminKey: String(raw.adminKey || ''),
    codeLength: toInt(raw.codeLength, DEFAULT_CODE_LENGTH, 4, 16),
    brand: String(raw.brand || ''),
    footerText: String(raw.footerText || ''),
    streamMode: raw.streamMode === 'proxy' ? 'proxy' : 'redirect',
    viewDir: raw.viewDir || path.join(__dirname, '..', 'views'),
    logRequests: raw.logRequests !== false,
    flushIntervalMs: toInt(raw.flushIntervalMs, 5000, 0, 600000),
    oss: normalizeOss(raw.oss)
  };
}

function applyEnv(cfg, env) {
  const e = env || {};
  if (e.PORT) cfg.port = toInt(e.PORT, cfg.port, 1, 65535);
  if (e.HOST) cfg.host = String(e.HOST);
  if (e.ADMIN_KEY) cfg.adminKey = String(e.ADMIN_KEY);
  if (e.PUBLIC_BASE_URL) cfg.publicBaseUrl = String(e.PUBLIC_BASE_URL).replace(/\/+$/, '');
  return cfg;
}

/** 从磁盘读配置（config.json 优先，回退 config.example.json），再用环境变量覆盖。 */
function loadFromDisk(rootDir, env) {
  const file = findConfigFile(rootDir);
  if (!file) throw new Error('找不到 config.json 或 config.example.json，请先创建配置文件');
  const cfg = normalize(readJsonFile(file));
  applyEnv(cfg, env || {});
  cfg.__source = path.basename(file);
  return cfg;
}

function hasUsableAdminKey(cfg) {
  return !!cfg.adminKey && cfg.adminKey !== PLACEHOLDER_KEY;
}

module.exports = {
  normalize: normalize,
  normalizeOss: normalizeOss,
  loadFromDisk: loadFromDisk,
  readJsonFile: readJsonFile,
  findConfigFile: findConfigFile,
  applyEnv: applyEnv,
  hasUsableAdminKey: hasUsableAdminKey,
  PLACEHOLDER_KEY: PLACEHOLDER_KEY,
  DEFAULT_PORT: DEFAULT_PORT,
  DEFAULT_CODE_LENGTH: DEFAULT_CODE_LENGTH
};

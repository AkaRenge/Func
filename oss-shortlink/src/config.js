'use strict';

const fs = require('fs');
const path = require('path');

const PLACEHOLDER_KEY = 'CHANGE-ME-TO-A-LONG-RANDOM-STRING';
const DEFAULT_PORT = 3000;
const DEFAULT_CODE_LENGTH = 6;
const DEFAULT_SIGN_TTL = 300;
const STREAM_MODES = ['redirect', 'proxy'];
const DEFAULT_HIT_APPEND_MS = 1000;            // 计数增量多久写一次日志
const DEFAULT_HIT_COMPACT_MS = 300000;         // 计数多久压实一次全量快照
const DEFAULT_HIT_JOURNAL_MAX = 4 * 1024 * 1024;

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

function isValidStreamMode(value) {
  return STREAM_MODES.indexOf(String(value)) >= 0;
}

/** 取流模式只有两个合法值，非法值一律回落到 fallback。 */
function normalizeStreamMode(value, fallback) {
  return isValidStreamMode(value) ? String(value) : fallback;
}

function normalizeOss(input) {
  const o = Object.assign({}, input || {});
  return {
    signedRead: !!o.signedRead,
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
    streamMode: normalizeStreamMode(raw.streamMode, 'redirect'),
    viewDir: raw.viewDir || path.join(__dirname, '..', 'views'),
    logRequests: raw.logRequests !== false,
    flushIntervalMs: toInt(raw.flushIntervalMs, 5000, 0, 600000),
    // 访问计数与短链定义分开落盘，所以它有自己的一套节奏：
    trackHits: raw.trackHits !== false,
    hitAppendIntervalMs: toInt(raw.hitAppendIntervalMs, DEFAULT_HIT_APPEND_MS, 0, 600000),
    hitCompactIntervalMs: toInt(raw.hitCompactIntervalMs, DEFAULT_HIT_COMPACT_MS, 0, 86400000),
    hitJournalMaxBytes: toInt(raw.hitJournalMaxBytes, DEFAULT_HIT_JOURNAL_MAX, 0, 1 << 30),
    oss: normalizeOss(raw.oss)
  };
}

function applyEnv(cfg, env) {
  const e = env || {};
  if (e.PORT) cfg.port = toInt(e.PORT, cfg.port, 1, 65535);
  if (e.HOST) cfg.host = String(e.HOST);
  if (e.ADMIN_KEY) cfg.adminKey = String(e.ADMIN_KEY);
  if (e.PUBLIC_BASE_URL) cfg.publicBaseUrl = String(e.PUBLIC_BASE_URL).replace(/\/+$/, '');
  // 非法取值保留配置文件里的原值，而不是悄悄改成 redirect
  if (e.STREAM_MODE) cfg.streamMode = normalizeStreamMode(e.STREAM_MODE, cfg.streamMode);
  return cfg;
}

/**
 * 从一个明确的文件路径读配置。
 * 找不到就报 CONFIG_NOT_FOUND，不做「回退到同目录 config.example.json」这种猜测——
 * 那会让用户以为自己改的配置生效了，其实跑的是示例文件。
 */
function loadFromFile(file, env) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) {
    const e = new Error('找不到配置文件：' + abs);
    e.code = 'CONFIG_NOT_FOUND';
    throw e;
  }
  const cfg = normalize(readJsonFile(abs));
  applyEnv(cfg, env || {});
  cfg.__source = abs;
  return cfg;
}

/**
 * 兼容旧行为：给一个目录，自动找 config.json / config.example.json。
 * @deprecated 新代码请用 loadFromFile() 明确指定文件，避免猜错文件。
 */
function loadFromDisk(rootDir, env) {
  const file = findConfigFile(rootDir);
  if (!file) {
    const e = new Error('找不到 config.json 或 config.example.json，请先创建配置文件');
    e.code = 'CONFIG_NOT_FOUND';
    throw e;
  }
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
  normalizeStreamMode: normalizeStreamMode,
  isValidStreamMode: isValidStreamMode,
  loadFromFile: loadFromFile,
  loadFromDisk: loadFromDisk,
  readJsonFile: readJsonFile,
  findConfigFile: findConfigFile,
  applyEnv: applyEnv,
  hasUsableAdminKey: hasUsableAdminKey,
  PLACEHOLDER_KEY: PLACEHOLDER_KEY,
  STREAM_MODES: STREAM_MODES,
  DEFAULT_PORT: DEFAULT_PORT,
  DEFAULT_CODE_LENGTH: DEFAULT_CODE_LENGTH
};

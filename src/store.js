'use strict';

const fs = require('fs');
const path = require('path');

function emptyDb() {
  return { version: 1, links: {} };
}

function normalizeDb(db) {
  const out = (db && typeof db === 'object') ? db : emptyDb();
  if (!out.links || typeof out.links !== 'object') out.links = {};
  if (!out.version) out.version = 1;
  return out;
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/** 同目录临时文件 + rename，避免写一半断电留下损坏的 JSON。 */
function writeAtomic(file, content) {
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * 内存存储。进程退出即丢，适合 demo、测试，或把本 SDK 嵌进已有应用时由外层托管持久化。
 */
function memoryStore(initial) {
  let db = normalizeDb(initial ? clone(initial) : null);
  return {
    kind: 'memory',
    load: async function () {
      return db;
    },
    save: async function (next) {
      db = normalizeDb(next);
    },
    snapshot: function () {
      return clone(db);
    }
  };
}

/**
 * 文件存储。单机部署的默认选择。
 */
function fileStore(file) {
  if (!file) throw new Error('fileStore 需要一个文件路径');
  const target = path.resolve(file);

  return {
    kind: 'file',
    file: target,
    load: async function () {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (!fs.existsSync(target)) {
        writeAtomic(target, JSON.stringify(emptyDb(), null, 2));
        return emptyDb();
      }
      const raw = fs.readFileSync(target, 'utf8').replace(/^\uFEFF/, '').trim();
      return normalizeDb(raw ? JSON.parse(raw) : null);
    },
    save: async function (db) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      writeAtomic(target, JSON.stringify(normalizeDb(db), null, 2));
    }
  };
}

/**
 * 自定义存储适配器。只要实现 load() 与 save(db) 即可接数据库、Redis、对象存储等。
 */
function customStore(obj) {
  if (!obj || typeof obj.load !== 'function' || typeof obj.save !== 'function') {
    throw new Error('自定义存储必须实现 load() 与 save(db) 两个方法');
  }
  return obj;
}

function pickStore(option, fallbackFile) {
  if (option && typeof option.load === 'function' && typeof option.save === 'function') {
    return option;
  }
  if (typeof option === 'string') return fileStore(option);
  if (fallbackFile) return fileStore(fallbackFile);
  return memoryStore();
}

module.exports = {
  memoryStore: memoryStore,
  fileStore: fileStore,
  customStore: customStore,
  pickStore: pickStore,
  emptyDb: emptyDb,
  normalizeDb: normalizeDb
};

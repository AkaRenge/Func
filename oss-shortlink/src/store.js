'use strict';

const fs = require('fs');
const path = require('path');

const DB_VERSION = 2;

function emptyDb() {
  return { version: DB_VERSION, links: {} };
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** 同目录临时文件 + rename，避免写一半断电留下损坏的 JSON。 */
function writeAtomic(file, content) {
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

function readJsonSafe(file) {
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
  if (!raw) return null;
  return JSON.parse(raw);
}

function laterIso(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return a >= b ? a : b;
}

function readInlineCount(rec) {
  const hits = Number(rec && rec.hits);
  const lastHitAt = (rec && typeof rec.lastHitAt === 'string') ? rec.lastHitAt : null;
  if (!hits && !lastHitAt) return null;
  return { hits: isFinite(hits) && hits > 0 ? hits : 0, lastHitAt: lastHitAt };
}

/**
 * 把任意来源的数据规整成 v2 结构：
 *
 *   { version: 2,
 *     links:  { code: Definition },                 // 只有定义，没有计数
 *     counts: { code: { hits, lastHitAt } },
 *     migrated: boolean }                           // 是否从 v1 搬过计数
 *
 * v1（≤ 1.1.x）把 hits / lastHitAt 直接存在每条 link 里。这里把它们摘出来放进 counts，
 * 于是老数据文件不用手工迁移——代价是读一次就得重写一次，所以返回 migrated 让上层
 * 知道要落一次盘。
 */
function normalizeDb(input) {
  const raw = isPlainObject(input) ? input : {};
  const inLinks = isPlainObject(raw.links) ? raw.links : {};
  const inCounts = isPlainObject(raw.counts) ? raw.counts : {};

  const links = {};
  const counts = {};
  let migrated = false;

  Object.keys(inLinks).forEach(function (code) {
    const rec = inLinks[code];
    if (!isPlainObject(rec)) return;

    const def = Object.assign({}, rec);
    if ('hits' in def || 'lastHitAt' in def) {
      migrated = true;
      const inline = readInlineCount(rec);
      if (inline) counts[code] = inline;
      delete def.hits;
      delete def.lastHitAt;
    }
    links[code] = def;
  });

  // 自定义存储可能把计数内联在同一个文档里（inline 模式）
  Object.keys(inCounts).forEach(function (code) {
    if (!links[code]) return;                       // 定义没了，计数一并丢弃
    const c = isPlainObject(inCounts[code]) ? inCounts[code] : {};
    const prev = counts[code] || { hits: 0, lastHitAt: null };
    counts[code] = {
      hits: prev.hits + (Number(c.hits) || 0),
      lastHitAt: laterIso(prev.lastHitAt, typeof c.lastHitAt === 'string' ? c.lastHitAt : null)
    };
  });

  Object.keys(counts).forEach(function (code) {
    if (!links[code]) delete counts[code];
  });

  return { version: DB_VERSION, links: links, counts: counts, migrated: migrated };
}

/** 写盘时只保留定义部分。 */
function definitionsOf(db) {
  const src = isPlainObject(db) && isPlainObject(db.links) ? db.links : {};
  const out = {};
  Object.keys(src).forEach(function (code) {
    const rec = src[code];
    if (!isPlainObject(rec)) return;
    const def = Object.assign({}, rec);
    delete def.hits;
    delete def.lastHitAt;
    out[code] = def;
  });
  return out;
}

function mergeCounts(a, b) {
  const out = {};
  [a || {}, b || {}].forEach(function (src) {
    Object.keys(src).forEach(function (code) {
      const c = src[code] || {};
      const prev = out[code] || { hits: 0, lastHitAt: null };
      out[code] = {
        hits: prev.hits + (Number(c.hits) || 0),
        lastHitAt: laterIso(prev.lastHitAt, typeof c.lastHitAt === 'string' ? c.lastHitAt : null)
      };
    });
  });
  return out;
}

/* ------------------------------------------------------------------ *
 * 计数器后端
 *
 * 约定：
 *   load()                     → { counts, seq }
 *   applyIncrements(items)      高频；items = [{ seq, code, at }]，实现方可以做成
 *                               O(1) 的追加 / INCR，必须与短链总数无关
 *   saveSnapshot(counts, seq)   低频；全量快照，实现方可以做压实、清理
 *
 * seq 是全局单调递增的命中序号，也是整套崩溃恢复的地基：
 * 快照记下「已并入快照的 appliedSeq」，加载时只回放 seq > appliedSeq 的日志行。
 * 这样「日志清空」这个动作本身就与正确性无关了——崩在写快照之前、之后、
 * 或是清日志的中途，都不会重复计数，也不会丢计数。
 *
 * （早期草稿用的是「已并入日志的字节数」，那是错的：日志一旦被清空，
 *   字节偏移就从 0 重新开始，无法与新写入的行区分，会把新命中误判成已计入。）
 * ------------------------------------------------------------------ */

/**
 * 文件计数器后端。
 *
 *   <base>.stats.json   压实后的全量快照 + appliedSeq
 *   <base>.hits.log     追加式增量日志，每行 "<seq> <code> <at>"
 */
function fileCounterBackend(base) {
  const statsFile = base + '.stats.json';
  const journalFile = base + '.hits.log';

  function ensureDir() {
    fs.mkdirSync(path.dirname(statsFile), { recursive: true });
  }

  function journalSize() {
    try {
      return fs.existsSync(journalFile) ? fs.statSync(journalFile).size : 0;
    } catch (e) {
      return 0;
    }
  }

  function readSnapshot() {
    try {
      const j = readJsonSafe(statsFile);
      if (isPlainObject(j)) {
        return {
          appliedSeq: Number(j.appliedSeq) || 0,
          counts: isPlainObject(j.counts) ? j.counts : {}
        };
      }
    } catch (e) {
      // 快照坏了不能让服务起不来：计数从 0 重来，短链定义不受影响
    }
    return { appliedSeq: 0, counts: {} };
  }

  function applyLines(buf, counts, fromSeq) {
    let maxSeq = fromSeq;
    const lines = buf.toString('utf8').split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;

      const p1 = line.indexOf(' ');
      if (p1 <= 0) continue;                        // 崩溃时写了一半的行
      const p2 = line.indexOf(' ', p1 + 1);
      if (p2 < 0) continue;

      const seq = Number(line.slice(0, p1));
      if (!isFinite(seq) || seq <= fromSeq) continue;   // 已经并入快照，跳过
      const code = line.slice(p1 + 1, p2);
      const at = Number(line.slice(p2 + 1));

      const rec = counts[code] || (counts[code] = { hits: 0, lastHitAt: null });
      rec.hits += 1;
      if (isFinite(at)) rec.lastHitAt = laterIso(rec.lastHitAt, new Date(at).toISOString());
      if (seq > maxSeq) maxSeq = seq;
    }
    return maxSeq;
  }

  return {
    kind: 'file',
    statsFile: statsFile,
    journalFile: journalFile,

    load: async function () {
      ensureDir();
      const snap = readSnapshot();
      const counts = snap.counts;
      const buf = fs.existsSync(journalFile) ? fs.readFileSync(journalFile) : Buffer.alloc(0);
      return { counts: counts, seq: applyLines(buf, counts, snap.appliedSeq) };
    },

    applyIncrements: async function (items) {
      if (!items || !items.length) return;
      ensureDir();
      let out = '';
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        out += it.seq + ' ' + it.code + ' ' + it.at + '\n';
      }
      fs.appendFileSync(journalFile, out, 'utf8');
    },

    saveSnapshot: async function (counts, seq) {
      ensureDir();
      // 全程同步：不会有新的命中插进来
      writeAtomic(statsFile, JSON.stringify({
        version: DB_VERSION,
        appliedSeq: Number(seq) || 0,
        counts: counts
      }, null, 2));
      // 先写快照再清日志。有了 seq 判定，清日志这一步崩在哪都不影响正确性。
      fs.writeFileSync(journalFile, '', 'utf8');
    },

    size: journalSize,

    clear: function () {
      fs.rmSync(statsFile, { force: true });
      fs.rmSync(journalFile, { force: true });
    }
  };
}

/** 内存计数器后端。进程退出即丢，适合 demo / 测试。 */
function memoryCounterBackend(seed, seedSeq) {
  let counts = clone(seed || {});
  let seq = Number(seedSeq) || 0;

  return {
    kind: 'memory',
    load: async function () { return { counts: clone(counts), seq: seq }; },
    applyIncrements: async function (items) {
      for (let i = 0; i < (items || []).length; i++) {
        const it = items[i];
        const rec = counts[it.code] || (counts[it.code] = { hits: 0, lastHitAt: null });
        rec.hits += 1;
        rec.lastHitAt = laterIso(rec.lastHitAt, new Date(it.at).toISOString());
        if (it.seq > seq) seq = it.seq;
      }
    },
    saveSnapshot: async function (next, nextSeq) {
      counts = clone(next || {});
      if (Number(nextSeq) > seq) seq = Number(nextSeq);
    },
    size: function () { return 0; },
    clear: function () { counts = {}; seq = 0; }
  };
}

function isCounterBackend(obj) {
  return !!obj &&
    typeof obj.load === 'function' &&
    typeof obj.applyIncrements === 'function' &&
    typeof obj.saveSnapshot === 'function';
}

/** 把 dataFile 的路径映射到计数器的文件基名：links.json → links */
function counterBaseOf(file) {
  return path.resolve(file).replace(/\.json$/i, '');
}

/**
 * 内存存储。进程退出即丢，适合 demo、测试，或把本 SDK 嵌进已有应用时由外层托管持久化。
 */
function memoryStore(initial) {
  const first = normalizeDb(initial ? clone(initial) : null);
  let links = first.links;
  const counters = memoryCounterBackend(first.counts);

  return {
    kind: 'memory',
    counters: counters,
    load: async function () {
      return { version: DB_VERSION, links: clone(links) };
    },
    save: async function (next) {
      links = definitionsOf(next);
    },
    snapshot: function () {
      return { version: DB_VERSION, links: clone(links) };
    }
  };
}

/**
 * 文件存储。单机部署的默认选择。
 *
 * 定义与计数分开落盘：
 *   links.json        短链定义，只在增删改时写
 *   links.stats.json  计数快照，低频压实
 *   links.hits.log    计数增量日志，高频追加
 */
function fileStore(file) {
  if (!file) throw new Error('fileStore 需要一个文件路径');
  const target = path.resolve(file);

  return {
    kind: 'file',
    file: target,
    counters: fileCounterBackend(counterBaseOf(target)),

    load: async function () {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (!fs.existsSync(target)) {
        writeAtomic(target, JSON.stringify(emptyDb(), null, 2));
        return emptyDb();
      }
      const raw = fs.readFileSync(target, 'utf8').replace(/^\uFEFF/, '').trim();
      const parsed = raw ? JSON.parse(raw) : null;
      // 原样返回 links，不做剥离：v1 的 hits 要留着让 normalizeDb 迁移出来。
      // 剥掉 hits 是 save() 的事，不是 load() 的。
      return {
        version: DB_VERSION,
        links: (isPlainObject(parsed) && isPlainObject(parsed.links)) ? parsed.links : {}
      };
    },

    save: async function (db) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      writeAtomic(target, JSON.stringify({
        version: DB_VERSION,
        links: definitionsOf(db)
      }, null, 2));
    }
  };
}

/**
 * 自定义存储适配器。
 *
 * 最少只要 load() 与 save(db) —— 此时计数会内联在同一个文档里跟着定义一起落盘，
 * 行为与 1.1.x 一致（一次 hits+1 会重写整个文档）。
 *
 * 想让访问计数不再触发全量重写，额外实现 counters：
 *
 *   customStore({
 *     load, save,
 *     counters: {
 *       async load() { return { counts, seq }; },      // 也可以只返回 counts
 *       async applyIncrements(items) { ... },          // items=[{seq,code,at}]，建议 INCRBY
 *       async saveSnapshot(counts, seq) { ... }        // 低频全量快照
 *     }
 *   })
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
  DB_VERSION: DB_VERSION,
  memoryStore: memoryStore,
  fileStore: fileStore,
  customStore: customStore,
  pickStore: pickStore,
  memoryCounterBackend: memoryCounterBackend,
  fileCounterBackend: fileCounterBackend,
  isCounterBackend: isCounterBackend,
  counterBaseOf: counterBaseOf,
  emptyDb: emptyDb,
  normalizeDb: normalizeDb,
  definitionsOf: definitionsOf,
  mergeCounts: mergeCounts,
  readJsonSafe: readJsonSafe,
  writeAtomic: writeAtomic
};

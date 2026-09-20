'use strict';

/**
 * 访问计数管理器。
 *
 * 关键性质：记一次访问只改内存 + 往增量日志写一行，**完全不碰短链定义那份文档**。
 * 文件多大、访问多密，都不会因为一次 hits+1 去重写整个 links.json。
 *
 * 三种模式：
 *   separate  定义与计数分开存（文件 / 实现了 counters 的自定义存储）——默认
 *   inline    存储不支持分离时，计数跟着定义一起落盘（1.1.x 的行为）
 *   off       完全不记（trackHits: false），零写入
 */

const MODES = ['separate', 'inline', 'off'];

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function laterIso(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return a >= b ? a : b;
}

function emptyCount() {
  return { hits: 0, lastHitAt: null };
}

function createCounters(opts) {
  const o = opts || {};
  const mode = MODES.indexOf(o.mode) >= 0 ? o.mode : 'separate';
  const backend = o.backend || null;
  const markDirty = o.markDirty || function () {};
  const log = o.log || function () {};
  const now = o.now || Date.now;
  const appendIntervalMs = o.appendIntervalMs == null ? 1000 : o.appendIntervalMs;
  const compactIntervalMs = o.compactIntervalMs == null ? 300000 : o.compactIntervalMs;
  const maxJournalBytes = o.maxJournalBytes == null ? 4 * 1024 * 1024 : o.maxJournalBytes;

  let counts = o.counts && typeof o.counts === 'object' ? o.counts : {};
  // 全局单调递增的命中序号。后端靠它判断「这条日志是否已经并进快照」，
  // 所以它必须跨重启延续——初值来自上次落盘的 appliedSeq。
  let hitSeq = Number(o.seq) || 0;
  const pending = [];
  const timers = [];
  let closed = false;

  function canPersist() {
    return mode === 'separate' && !!backend;
  }

  function journalSize() {
    if (!backend || typeof backend.size !== 'function') return 0;
    try { return backend.size(); } catch (e) { return 0; }
  }

  /** 把一批增量交给后端。失败只记日志：内存里的 counts 才是读路径的依据，
   *  下一次 compaction 会把全量快照写下去，不会因为一次追加失败就丢数据。 */
  function pushIncrements(items) {
    if (!items.length) return;
    try {
      const r = backend.applyIncrements(items);
      if (r && typeof r.catch === 'function') r.catch(function (e) { log('[warn] 计数追加失败：' + e.message); });
    } catch (e) {
      log('[warn] 计数追加失败：' + e.message);
    }
  }

  async function flush() {
    if (!canPersist() || !pending.length) return;
    const items = pending.splice(0, pending.length);
    try {
      await backend.applyIncrements(items);
    } catch (e) {
      log('[warn] 计数追加失败：' + e.message);
    }
  }

  async function compact() {
    if (mode === 'off') return;
    if (mode === 'inline') { markDirty(); return; }
    if (!canPersist()) return;

    await flush();
    try {
      await backend.saveSnapshot(counts, hitSeq);
    } catch (e) {
      log('[warn] 计数落盘失败：' + e.message);
    }
  }

  function onAppendTimer() {
    flush();
    // 日志涨太快（命中率高 / 压实间隔太长）就提前压实一次，别让它无限长
    if (maxJournalBytes > 0 && journalSize() > maxJournalBytes) compact();
  }

  function startTimers() {
    if (!canPersist() || closed) return;
    if (appendIntervalMs > 0) {
      timers.push(setInterval(onAppendTimer, appendIntervalMs));
    }
    if (compactIntervalMs > 0) {
      timers.push(setInterval(function () { compact(); }, compactIntervalMs));
    }
    timers.forEach(function (t) { if (t.unref) t.unref(); });
  }

  startTimers();

  return {
    mode: mode,

    /** 取计数。返回的是内部对象，调用方只读。 */
    get: function (code) {
      return counts[code] || null;
    },

    /** 记一次访问。返回该短码的计数。 */
    record: function (code, atMs) {
      if (mode === 'off') return null;
      const at = atMs == null ? now() : atMs;
      const seq = (hitSeq += 1);

      const rec = counts[code] || (counts[code] = emptyCount());
      rec.hits += 1;
      rec.lastHitAt = laterIso(rec.lastHitAt, new Date(at).toISOString());

      if (mode === 'inline') {
        markDirty();                       // 只能跟着定义一起落盘
      } else if (appendIntervalMs === 0) {
        pushIncrements([{ seq: seq, code: code, at: at }]);   // 每次命中立刻追加
      } else {
        pending.push({ seq: seq, code: code, at: at });
      }
      return rec;
    },

    /** 短码被删除时清掉它的计数，避免计数文件无限膨胀。 */
    drop: function (code) {
      if (!counts[code]) return;
      delete counts[code];
      if (mode === 'inline') markDirty();
    },

    /** 丢掉没有对应定义的计数（加载后做一次，清理历史残留）。 */
    prune: function (exists) {
      let removed = 0;
      Object.keys(counts).forEach(function (code) {
        if (!exists(code)) { delete counts[code]; removed += 1; }
      });
      return removed;
    },

    flush: flush,
    compact: compact,
    snapshot: function () { return clone(counts); },

    stats: function () {
      return {
        mode: mode,
        tracked: Object.keys(counts).length,
        pending: pending.length,
        seq: hitSeq,
        journalBytes: journalSize()
      };
    },

    close: async function () {
      if (closed) return;
      closed = true;
      timers.forEach(function (t) { clearInterval(t); });
      timers.length = 0;
      await flush();
      await compact();
    }
  };
}

module.exports = {
  createCounters: createCounters,
  MODES: MODES
};

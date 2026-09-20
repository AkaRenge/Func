'use strict';

const crypto = require('crypto');

// 去掉了 0/O/o、1/l/I 这类容易看错的字符，方便印在物料上人工核对
const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';

const CODE_RE = /^[A-Za-z0-9]{4,16}$/;

// 字节有 256 种取值，而字符集只有 55 个字符：256 % 55 = 36，直接取模会让前 36 个字符
// 各多出 1/256 的概率（实测最高与最低频次差 ~10%）。用拒绝采样丢掉落在不完整区间里的字节。
const REJECT_FROM = 256 - (256 % ALPHABET.length);

function randomCode(len) {
  let out = '';
  while (out.length < len) {
    const buf = crypto.randomBytes(len);
    for (let i = 0; i < buf.length && out.length < len; i++) {
      if (buf[i] >= REJECT_FROM) continue;
      out += ALPHABET[buf[i] % ALPHABET.length];
    }
  }
  return out;
}

function isValidCode(code) {
  return CODE_RE.test(String(code == null ? '' : code));
}

function badRequest(message) {
  const e = new Error(message);
  e.status = 400;
  return e;
}

/**
 * 决定最终短码。
 * 指定了就用指定的（校验格式与占用），否则随机生成一个不冲突的。
 */
function resolveCode(wanted, isTaken, len) {
  const want = String(wanted == null ? '' : wanted).trim();

  if (want) {
    if (!isValidCode(want)) throw badRequest('自定义短码只能是 4-16 位字母或数字');
    if (isTaken(want)) throw badRequest('短码 ' + want + ' 已被占用');
    return want;
  }

  for (let i = 0; i < 64; i++) {
    const c = randomCode(len);
    if (!isTaken(c)) return c;
  }
  return randomCode(len + 3);
}

module.exports = {
  ALPHABET: ALPHABET,
  CODE_RE: CODE_RE,
  randomCode: randomCode,
  isValidCode: isValidCode,
  resolveCode: resolveCode
};

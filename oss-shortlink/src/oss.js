'use strict';

const crypto = require('crypto');

/**
 * 阿里云 OSS 签名（V1，URL 参数形式），针对 GET 且无自定义 header 的场景。
 *
 * StringToSign = VERB \n Content-MD5 \n Content-Type \n Expires \n CanonicalizedResource
 */
function signUrl(rawUrl, oss, nowMs) {
  const now = Number(nowMs || Date.now());
  const expires = Math.floor(now / 1000) + oss.signTtlSeconds;

  const u = new URL(rawUrl);
  const resource = '/' + oss.bucket + decodeURIComponent(u.pathname);
  const stringToSign = ['GET', '', '', String(expires), resource].join('\n');

  const signature = crypto
    .createHmac('sha1', oss.accessKeySecret)
    .update(stringToSign, 'utf8')
    .digest('base64');

  u.searchParams.set('OSSAccessKeyId', oss.accessKeyId);
  u.searchParams.set('Expires', String(expires));
  u.searchParams.set('Signature', signature);
  return u.toString();
}

/** 是否具备签名条件：开关打开 + 密钥与 bucket 齐备。 */
function canSign(oss) {
  return !!(oss && oss.signedRead && oss.bucket && oss.accessKeyId && oss.accessKeySecret);
}

/**
 * 把记录里的视频地址解析成最终可访问地址。
 * 没开签名就直接返回原地址；签名出错也回退原地址，不让播放整体失败。
 */
function resolveVideoUrl(link, oss, nowMs) {
  if (!canSign(oss)) return link.videoUrl;
  try {
    return signUrl(link.videoUrl, oss, nowMs);
  } catch (e) {
    return link.videoUrl;
  }
}

function isHttpUrl(value) {
  try {
    const u = new URL(String(value));
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (e) {
    return false;
  }
}

module.exports = {
  signUrl: signUrl,
  canSign: canSign,
  resolveVideoUrl: resolveVideoUrl,
  isHttpUrl: isHttpUrl
};

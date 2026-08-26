/**
 * System Encoding detection — cross-platform.
 *
 * Windows: reads active code page via `chcp`.
 * Unix: reads LC_ALL / LC_CTYPE / LANG, falls back to `locale charmap`.
 */
'use strict';

const { execSync } = require('child_process');
const os = require('os');

// Windows code page → Node encoding name
const CP_MAP = {
  437: 'cp437',
  850: 'cp850',
  852: 'cp852',
  866: 'cp866',
  874: 'windows-874',
  932: 'shift_jis',
  936: 'gbk',
  949: 'euc-kr',
  950: 'big5',
  1200: 'utf16le',
  1201: 'utf16be',
  1250: 'windows-1250',
  1251: 'windows-1251',
  1252: 'windows-1252',
  1253: 'windows-1253',
  1254: 'windows-1254',
  1255: 'windows-1255',
  1256: 'windows-1256',
  1257: 'windows-1257',
  1258: 'windows-1258',
  65001: 'utf-8',
};

// 成功探测的结果永久缓存(码页在进程生命周期内不会变);**失败不永久缓存**。
//
// 原实现把失败也写进 `_cached = null` 并当作终态。于是一次瞬时故障(chcp 3s 超时、
// 子进程创建被杀软拦一下、容器里临时没有 comspec)就把整个进程钉死在「探测失败」上,
// 后续所有解码回落 utf-8 —— GBK 控制台字节按 UTF-8 解出来就是 U+FFFD 乱码,而这类
// 乱码被判为不可修复,于是同一条乱码告警会一直重复到进程结束。这正是「出现错误就
// 永远报相同的错误」的一条根因。
//
// 现在失败只压制 FAILURE_RETRY_MS,过期后下一次调用重新探测。压制窗口是必要的:
// getEncodingForBuffer 在每个非 UTF-8 数据块上都会调,不能每次都 fork 一个 chcp。
const FAILURE_RETRY_MS = 60_000;

let _cached = undefined; // undefined = 未探测, null = 探测失败(受 _failedAt 冷却约束)
let _failedAt = 0;

/**
 * Detect the system's default text encoding.
 *
 * @param {object} [opts]
 * @param {() => number} [opts.now] - 时钟注入(测试用),默认 Date.now。
 * @returns {string|null} 编码名;探测失败返回 null(失败态最多保留 FAILURE_RETRY_MS)。
 */
function getSystemEncoding(opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  if (_cached !== undefined && _cached !== null) {
    return _cached;
  }
  if (_cached === null && now() - _failedAt < FAILURE_RETRY_MS) {
    return null; // 仍在失败冷却窗口内,不重复 fork 探测进程
  }

  function fail() {
    _cached = null;
    _failedAt = now();
    return null;
  }

  if (os.platform() === 'win32') {
    try {
      const out = execSync('chcp', {
        encoding: 'utf8',
        timeout: 3000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      // 本地化 Windows 的 chcp 表头是 OEM 字节（如中文「活动代码页」），用 utf8 解码后
      // 多半成乱码，且分隔符可能是全角冒号「：」而非 ASCII「:」——旧正则 `/:\s*(\d+)/`
      // 依赖 ASCII 冒号，在中文 Windows 上会匹配失败导致探测落空、回落 utf8 致输出乱码。
      // 改为：扫出所有数字组，取首个落在已知代码页表内的（码页号本身是 ASCII，恒存活）。
      const nums = out.match(/\d+/g) || [];
      for (const tok of nums) {
        const cp = parseInt(tok, 10);
        if (Object.prototype.hasOwnProperty.call(CP_MAP, cp)) {
          _cached = CP_MAP[cp];
          return _cached;
        }
      }
    } catch {
      /* ignore */
    }
    return fail();
  }

  // Unix
  const env = process.env;
  let locale = env.LC_ALL || env.LC_CTYPE || env.LANG || '';

  if (!locale) {
    try {
      locale = execSync('locale charmap', {
        encoding: 'utf8',
        timeout: 3000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {
      return fail();
    }
  }

  // e.g. "en_US.UTF-8" → "utf-8"
  const m = locale.match(/\.(.+)/);
  if (m && m[1]) {
    _cached = m[1].toLowerCase().replace(/_/g, '-');
    return _cached;
  }

  // locale charmap returns just the encoding name (e.g. "UTF-8")
  if (locale && !locale.includes('.')) {
    _cached = locale.toLowerCase().replace(/_/g, '-');
    return _cached;
  }

  return fail();
}

/**
 * Detect encoding of a Buffer.
 * Strategy: UTF-8 first → system encoding → 'utf-8' fallback.
 * @param {Buffer} buf
 * @returns {string}
 */
function getEncodingForBuffer(buf) {
  // Check BOM
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return 'utf16le';
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return 'utf-8';
  }

  // Check if valid UTF-8
  try {
    // Node's Buffer.isEncoding + TextDecoder validation
    const td = new TextDecoder('utf-8', { fatal: true });
    td.decode(buf);
    return 'utf-8';
  } catch {
    /* not valid UTF-8 */
  }

  // Fall back to system encoding
  const sys = getSystemEncoding();
  return sys || 'utf-8';
}

/**
 * Reset cache (for testing).
 */
function resetEncodingCache() {
  _cached = undefined;
  _failedAt = 0;
}

module.exports = {
  getSystemEncoding,
  getEncodingForBuffer,
  resetEncodingCache,
};

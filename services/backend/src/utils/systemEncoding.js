/**
 * System Encoding detection — cross-platform.
 *
 * Windows: reads active code page via `chcp`.
 * Unix: reads LC_ALL / LC_CTYPE / LANG, falls back to `locale charmap`.
 */
'use strict';

const os = require('os');
const { execSync } = require('child_process');

// Windows code page → Node encoding name
const CP_MAP = {
  437: 'cp437', 850: 'cp850', 852: 'cp852', 866: 'cp866',
  874: 'windows-874',
  932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5',
  1200: 'utf16le', 1201: 'utf16be',
  1250: 'windows-1250', 1251: 'windows-1251', 1252: 'windows-1252',
  1253: 'windows-1253', 1254: 'windows-1254', 1255: 'windows-1255',
  1256: 'windows-1256', 1257: 'windows-1257', 1258: 'windows-1258',
  65001: 'utf-8',
};

let _cached = undefined; // undefined = not checked, null = checked but failed

/**
 * Detect the system's default text encoding.
 * @returns {string|null}
 */
function getSystemEncoding() {
  if (_cached !== undefined) return _cached;

  if (os.platform() === 'win32') {
    try {
      const out = execSync('chcp', { encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] });
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
    } catch { /* ignore */ }
    _cached = null;
    return _cached;
  }

  // Unix
  const env = process.env;
  let locale = env.LC_ALL || env.LC_CTYPE || env.LANG || '';

  if (!locale) {
    try {
      locale = execSync('locale charmap', { encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    } catch {
      _cached = null;
      return _cached;
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

  _cached = null;
  return _cached;
}

/**
 * Detect encoding of a Buffer.
 * Strategy: UTF-8 first → system encoding → 'utf-8' fallback.
 * @param {Buffer} buf
 * @returns {string}
 */
function getEncodingForBuffer(buf) {
  // Check BOM
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return 'utf16le';
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return 'utf-8';

  // Check if valid UTF-8
  try {
    // Node's Buffer.isEncoding + TextDecoder validation
    const td = new TextDecoder('utf-8', { fatal: true });
    td.decode(buf);
    return 'utf-8';
  } catch { /* not valid UTF-8 */ }

  // Fall back to system encoding
  const sys = getSystemEncoding();
  return sys || 'utf-8';
}

/**
 * Reset cache (for testing).
 */
function resetEncodingCache() {
  _cached = undefined;
}

module.exports = {
  getSystemEncoding,
  getEncodingForBuffer,
  resetEncodingCache,
};

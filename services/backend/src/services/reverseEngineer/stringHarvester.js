'use strict';

/**
 * stringHarvester.js — 字符串提取与分类 (DESIGN-ARCH-054 §3.3)。
 *
 * 从二进制里捞出可打印字符串（ASCII + UTF-16LE），并按语义分类：URL、文件路径、版本串、
 * 工具链/编译器指纹、可疑密钥样式。字符串是逆向里信息密度最高的免费证据——很多时候不必
 * 反汇编就能从字符串还原出「这是什么语言写的、用了哪些库、入口在哪」。
 *
 * 纯确定性、零模型、只读 Buffer。绝不执行制品。
 */

/** 提取一个 Buffer 中长度 >= minLen 的可打印 ASCII run。 */
function _harvestAscii(buf, minLen) {
  const out = [];
  let start = -1;
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    const printable = c >= 0x20 && c <= 0x7e;
    if (printable) {
      if (start < 0) start = i;
    } else {
      if (start >= 0 && i - start >= minLen) {
        out.push({ offset: start, text: buf.toString('ascii', start, i), enc: 'ascii' });
      }
      start = -1;
    }
  }
  if (start >= 0 && buf.length - start >= minLen) {
    out.push({ offset: start, text: buf.toString('ascii', start, buf.length), enc: 'ascii' });
  }
  return out;
}

/** 提取 UTF-16LE 可打印 run（Windows 二进制宽字符串常见）。 */
function _harvestUtf16le(buf, minLen) {
  const out = [];
  let start = -1;
  let count = 0;
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const lo = buf[i];
    const hi = buf[i + 1];
    const printable = hi === 0x00 && lo >= 0x20 && lo <= 0x7e;
    if (printable) {
      if (start < 0) { start = i; count = 0; }
      count++;
    } else {
      if (start >= 0 && count >= minLen) {
        out.push({ offset: start, text: buf.toString('utf16le', start, i), enc: 'utf16le' });
      }
      start = -1; count = 0;
    }
  }
  if (start >= 0 && count >= minLen) {
    out.push({ offset: start, text: buf.toString('utf16le', start, buf.length - (buf.length % 2)), enc: 'utf16le' });
  }
  return out;
}

// ── 语义分类（声明式正则单一真源）─────────────────────────────────
const CLASSIFIERS = [
  { kind: 'url', re: /\bhttps?:\/\/[^\s"'<>]{4,}/i },
  { kind: 'path', re: /(?:[A-Za-z]:\\[^\s"'<>]+|\/(?:usr|home|opt|var|etc|tmp|Users|Library)\/[^\s"'<>]+)/ },
  { kind: 'version', re: /\bv?\d+\.\d+(?:\.\d+){0,2}(?:[-+][0-9A-Za-z.]+)?\b/ },
  { kind: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },
  { kind: 'secret', re: /\b(?:sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]+PRIVATE KEY-----)/ },
];

// 工具链/编译器/运行时指纹（声明式；命中即作为「inferred toolchain」证据）。
const TOOLCHAIN_FINGERPRINTS = [
  { id: 'gcc', re: /GCC: \(.*?\) \d/ },
  { id: 'clang', re: /clang version \d/ },
  { id: 'msvc', re: /Microsoft \(R\) (?:C\/C\+\+|Optimizing Compiler)/ },
  { id: 'rustc', re: /rustc-?\d|\/rustc\// },
  { id: 'go', re: /Go build ID:|go1\.\d+|go\.buildinfo/ },
  { id: 'python', re: /Python \d\.\d+|pyinstaller|PyInstaller|site-packages/ },
  { id: 'node', re: /node_modules|NODE_SEA_BLOB|process\.versions|v8::internal/ },
  { id: 'dotnet', re: /\.NETFramework|System\.Private\.CoreLib|mscorlib/ },
  { id: 'electron', re: /electron|app\.asar|chromium/i },
  { id: 'upx', re: /UPX!|\$Info: This file is packed with the UPX/ },
];

/** 对单条字符串归类（可命中多类，但返回首要类别 + 是否敏感）。 */
function classify(text) {
  const tags = [];
  for (const c of CLASSIFIERS) {
    if (c.re.test(text)) tags.push(c.kind);
  }
  return tags;
}

/**
 * 从 Buffer 收割字符串并产出结构化证据包。
 * @param {Buffer} buf
 * @param {object} [opts]
 * @param {number} [opts.minLen=4]      最小字符串长度
 * @param {number} [opts.maxStrings=2000] 上限（防止巨型二进制撑爆）
 * @returns {object} { total, truncated, classified:{url,path,version,...}, toolchains:[], samples:[] }
 */
function harvest(buf, opts = {}) {
  const minLen = Math.max(2, opts.minLen || 4);
  const maxStrings = Math.max(50, opts.maxStrings || 2000);
  if (!Buffer.isBuffer(buf)) {
    return { total: 0, truncated: false, classified: {}, toolchains: [], samples: [] };
  }

  let strings = [..._harvestAscii(buf, minLen), ..._harvestUtf16le(buf, minLen)];
  const total = strings.length;
  const truncated = total > maxStrings;
  if (truncated) strings = strings.slice(0, maxStrings);

  const classified = { url: [], path: [], version: [], email: [], secret: [] };
  const toolchainHits = new Set();

  for (const s of strings) {
    const tags = classify(s.text);
    for (const t of tags) {
      if (classified[t] && classified[t].length < 50) classified[t].push({ offset: s.offset, text: s.text.slice(0, 256) });
    }
    for (const fp of TOOLCHAIN_FINGERPRINTS) {
      if (fp.re.test(s.text)) toolchainHits.add(fp.id);
    }
  }

  // samples: 最长的若干条（信息量代理），脱去过短噪音。
  const samples = strings
    .filter((s) => s.text.length >= Math.max(minLen, 6))
    .sort((a, b) => b.text.length - a.text.length)
    .slice(0, 40)
    .map((s) => ({ offset: s.offset, enc: s.enc, text: s.text.slice(0, 200) }));

  return {
    total,
    truncated,
    classified,
    toolchains: Array.from(toolchainHits),
    samples,
  };
}

module.exports = {
  harvest,
  classify,
  TOOLCHAIN_FINGERPRINTS,
  _harvestAscii,
  _harvestUtf16le,
};

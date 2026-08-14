'use strict';

/**
 * 读取工具的「二进制/压缩文件」防护 —— 纯叶子（零 IO · 绝不抛）。
 *
 * ── 补的缺口：把已存在的 fileFormatDetector.isBinary 能力接进 readFile ──────────
 * `services/formatInspect/fileFormatDetector.js` 早已提供 magic-bytes + NUL/非可打印
 * 启发的 `detectFile(absPath).isBinary` 判定，**写工具** `replaceAtLocation.js` 与
 * `inspectDocument.js` 都在消费它拒绝二进制——**唯独读工具 `tools/readFile.js` 从不
 * 消费**。于是当 agent 分析一个含 `.tar.gz` / 可执行文件 / 图片的目录时，readFile 把
 * 二进制字节经 `readTextFileSmart` 解码成含 NUL 的 mojibake，以 `success:true` 注入
 * 模型上下文。这坨二进制垃圾 payload 发给（尤其中转/relay 的）模型端点后会让请求
 * 卡死/超时——实测「分析 D:\moonbit-linux 项目」在读 `moonbit-linux-x86_64.tar.gz`
 * 时卡了 1h+。文本 `.sha256` 同目录秒读，正好印证是二进制文件毒化了请求。
 *
 * 本叶把这条缺失的读前防护接上线：给定 `detectFile` 的结果，保守判断是否二进制，
 * 并渲染一条**信息性**拒绝消息（点明类型 + 大小 + 改用哪个工具），让 readFile 快速
 * 返回而非解码注入。真正的 IO（探测 head/tail 字节、stat）留在 readFile 薄壳里。
 *
 * ── 保守边界（绝不误伤文本）─────────────────────────────────────────────────
 * - 仅当 `fmt.isBinary === true` 才判为二进制；`fmt` 缺失 / 非对象 / isBinary 非严格
 *   true → 一律放行（返回 false），让正常文本读取路径继续。
 * - 门控 `KHY_READFILE_BINARY_GUARD`（默认开；env ∈ {0,false,off,no} 归一后关）：
 *   关 → readFile 逐字节回退历史「解码注入」行为，本防护完全旁路。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

function _isOff(raw) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return OFF_VALUES.includes(v);
}

/**
 * 门控 KHY_READFILE_BINARY_GUARD（默认开）。
 * @param {object} [env=process.env]
 * @returns {boolean}
 */
function binaryReadGuardEnabled(env = process.env) {
  return !_isOff(env && env.KHY_READFILE_BINARY_GUARD);
}

/**
 * 保守判定：给定 fileFormatDetector.detectFile 的结果，是否应拦下「按文本读取」。
 * 只认严格 true，任何不确定都放行（返回 false），绝不误伤文本文件。
 * @param {object} fmt  detectFile 返回的 {isBinary, format, ...}
 * @returns {boolean}
 */
function isBinaryForRead(fmt) {
  return !!fmt && typeof fmt === 'object' && fmt.isBinary === true;
}

/** 人类可读的字节数（B / KB / MB），用于拒绝消息。 */
function _humanBytes(size) {
  // Number(null) === 0 陷阱:缺失/空串须显式判为未知,不能当 0 B。
  if (size == null || size === '') return '未知大小';
  const n = Number(size);
  if (!Number.isFinite(n) || n < 0) return '未知大小';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** detectFile 结果里最可读的类型标签（优先 magic 识别的格式）。 */
function _typeLabel(fmt) {
  if (!fmt || typeof fmt !== 'object') return '二进制文件';
  const f = fmt.magicFormat || (fmt.format && fmt.format !== 'unknown' ? fmt.format : null);
  const cat = fmt.category && fmt.category !== 'unknown' ? fmt.category : null;
  if (f && cat) return `${f}（${cat}）`;
  if (f) return String(f);
  if (cat) return `二进制文件（${cat}）`;
  return '二进制文件';
}

/**
 * 构造「拒绝按文本读取二进制文件」的信息性消息（纯字符串 · 绝不抛）。
 * 点明类型 + 大小，并把 agent 重定向到正确工具，避免把二进制垃圾注入模型上下文。
 * @param {object} info  {format, magicFormat, category, size}
 * @returns {string}
 */
function buildBinaryReadRefusal(info) {
  let fmt = info;
  try {
    if (!fmt || typeof fmt !== 'object') fmt = {};
    const type = _typeLabel(fmt);
    const size = _humanBytes(fmt.size);
    return (
      `拒绝按文本读取：这是${type}，${size}。二进制/压缩文件按文本读取会把乱码注入上下文` +
      `（并可能拖垮模型请求），故不作文本读取。` +
      `\n可改用：analyzeBinary（分析 ELF/PE 可执行文件）｜ UpstreamStudy（只读列出压缩包目录，零解压）` +
      `｜ 或先校验/解压后再读对应文本文件。` +
      `\n如确需强制按文本读取，设 KHY_READFILE_BINARY_GUARD=0 后重试。`
    );
  } catch {
    return '拒绝按文本读取：目标疑为二进制/压缩文件，未作文本读取。如确需强读设 KHY_READFILE_BINARY_GUARD=0。';
  }
}

module.exports = {
  binaryReadGuardEnabled,
  isBinaryForRead,
  buildBinaryReadRefusal,
};

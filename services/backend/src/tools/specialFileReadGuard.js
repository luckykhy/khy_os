'use strict';

/**
 * 读取工具的「特殊文件（FIFO / 套接字 / 字符或块设备）」读前防护 —— 纯叶子（零 IO · 绝不抛）。
 *
 * ── 补的缺口：按「文件类型」而非「路径名」拦下会永久阻塞的读 ─────────────────
 * `tools/readFile.js` 历史上只对 `stat.isDirectory()` 做了特判，二进制/格式路由由
 * OPS-121（readBinaryGuard）/ OPS-123（readFileFormatRouter）接线。但仍有一类**会让
 * 进程永久卡死**的目标从所有守卫下溜过去：**非常规文件**——命名管道（FIFO）、UNIX
 * 域套接字、字符设备（/dev/random 之类）、块设备。它们的共同特征：
 *   - `stat.size === 0`（或无意义），故 OPS-121 之后的「超限」检查放行；
 *   - 不是二进制格式（detectFile 会去**读 magic 字节**——而读 FIFO 的第一个字节就
 *     会阻塞等待写端），故二进制守卫不但拦不住，反而 **detectFile 自己先卡死**；
 *   - 随后 `readTextFileSmart` 打开并读取，在无写端的 FIFO / 阻塞设备上**永久挂起**。
 * 已复现：`mkfifo project/data.pipe` 后读它，进程 6s 超时仍未返回（EXIT=124）。
 *
 * `inputValidators.validateNotDevicePath` 只是一张**路径精确名单**（/dev/zero、
 * /dev/stdin…），无法按类型拦下任意位置的 FIFO / 套接字 / 自建设备节点。本叶子按
 * **`fs.statSync` 返回的类型**（isFIFO/isSocket/isCharacterDevice/isBlockDevice）拦下，
 * 而 `statSync` 对 FIFO/设备**只读元数据、瞬时返回、绝不阻塞**（已实测 0ms），所以在
 * 任何会阻塞的 open/read 之前就能安全判定。
 *
 * 本叶只做纯判定 + 渲染信息性拒绝消息；真正的 IO（stat）留在 readFile 薄壳里，且
 * readFile 已经算好了 `stat`，本叶只消费其类型谓词，零额外 IO。
 *
 * ── 保守边界（绝不误伤常规文件）─────────────────────────────────────────────
 * - 仅当 stat 明确是 FIFO/套接字/字符设备/块设备之一才拦；常规文件、目录、stat 缺失
 *   / 非对象 / 谓词非函数 → 一律放行（返回 null），让正常读取路径继续。
 * - 目录由 readFile 既有的 isDirectory 特判处理，本叶对目录返回 null（不接管）。
 * - 门控 `KHY_READFILE_SPECIAL_GUARD`（默认开；env ∈ {0,false,off,no} 归一后关）：
 *   关 → readFile 逐字节回退历史行为（对特殊文件照旧走 detectFile/解码 → 卡死），
 *   本防护完全旁路。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

function _isOff(raw) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return OFF_VALUES.includes(v);
}

/**
 * 门控 KHY_READFILE_SPECIAL_GUARD（默认开）。
 * @param {object} [env=process.env]
 * @returns {boolean}
 */
function specialReadGuardEnabled(env = process.env) {
  return !_isOff(env && env.KHY_READFILE_SPECIAL_GUARD);
}

/**
 * 按 fs.Stats 的类型谓词判定「会阻塞的特殊文件」种类。
 * 只认明确的 FIFO / 套接字 / 字符设备 / 块设备；常规文件、目录、任何不确定 → null。
 * 绝不抛（谓词缺失/非函数 → 视为不匹配）。
 * @param {object} stat  fs.statSync 返回的 Stats（或鸭子类型：暴露 isFIFO 等方法）
 * @returns {('fifo'|'socket'|'char-device'|'block-device'|null)}
 */
function classifySpecialFile(stat) {
  try {
    if (!stat || typeof stat !== 'object') return null;
    const _is = (name) => typeof stat[name] === 'function' && stat[name]() === true;
    // 目录不在本叶职责内（readFile 有专门的 isDirectory 特判）。
    if (_is('isDirectory')) return null;
    if (_is('isFIFO')) return 'fifo';
    if (_is('isSocket')) return 'socket';
    if (_is('isCharacterDevice')) return 'char-device';
    if (_is('isBlockDevice')) return 'block-device';
    return null;
  } catch {
    return null;
  }
}

const _KIND_LABEL = Object.freeze({
  'fifo': '命名管道（FIFO）',
  'socket': 'UNIX 域套接字',
  'char-device': '字符设备',
  'block-device': '块设备',
});

/** 人类可读字节数。Number(null)===0 陷阱：缺失/空串判未知，不当 0 B。 */
function _humanBytes(size) {
  if (size == null || size === '') return '未知大小';
  const n = Number(size);
  if (!Number.isFinite(n) || n < 0) return '未知大小';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 构造「拒绝读取特殊文件」的信息性消息（纯字符串 · 绝不抛）。
 * 点明类型 + 为何危险（会永久阻塞）+ 逃生门，避免进程挂死。
 * @param {object} info  {kind, path, size}
 * @returns {string}
 */
function buildSpecialFileRefusal(info) {
  let i = info;
  try {
    if (!i || typeof i !== 'object') i = {};
    const label = _KIND_LABEL[i.kind] || '特殊文件';
    const shown = i.path == null ? '' : String(i.path);
    const tail = shown ? `：${shown}` : '';
    const sizeNote = i.kind === 'fifo' || i.kind === 'socket' || i.kind === 'char-device'
      ? '读取它会永久阻塞（等待写端/无尽输入），使进程卡死'
      : `大小 ${_humanBytes(i.size)}，按文件读取会阻塞或读出海量原始字节`;
    return (
      `拒绝读取：这是${label}${tail}。${sizeNote}，故不作读取。` +
      `\n若你想要的是该路径背后的数据，请改用面向流/设备的专用手段（如带超时的 shell 命令），` +
      `不要用文件读取工具。` +
      `\n如确需强制读取（可能导致卡死），设 KHY_READFILE_SPECIAL_GUARD=0 后重试。`
    );
  } catch {
    return '拒绝读取：目标疑为会阻塞的特殊文件（FIFO/套接字/设备），未作读取。如确需强读设 KHY_READFILE_SPECIAL_GUARD=0。';
  }
}

module.exports = {
  specialReadGuardEnabled,
  classifySpecialFile,
  buildSpecialFileRefusal,
  _KIND_LABEL,
};

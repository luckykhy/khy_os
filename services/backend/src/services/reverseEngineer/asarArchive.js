'use strict';

/**
 * asarArchive.js — 原生 Electron `.asar` 归档头解析（纯函数、零依赖、fail-closed）。
 *
 * 为什么需要它：asar **不是** zip（无 `PK` 魔数），是 Electron 自定义容器，node-stream-zip
 * 读不了。此前 unpack 工具对 `.asar` 直接判「Unsupported archive format」。asar 是验证
 * 「khy 生成/分析的 Electron 应用」最直接的一条源码还原路径（formatRegistry 记为 SOURCE 档）。
 *
 * 字节布局（对齐 @electron/asar 磁盘格式）：
 *   [8 字节 size pickle]  UInt32LE payloadLen(=4) + UInt32LE headerSize
 *   [headerSize 字节 header pickle]  UInt32LE payloadLen + UInt32LE jsonLen + jsonBytes(4 字节对齐)
 *   [文件数据区]  基址 = 8 + headerSize；每个 info.offset（十进制**字符串**，容 >2^53）相对该基址，
 *                读 info.size 字节。`unpacked:true` 的成员存在同级 `<archive>.unpacked/` 目录里，
 *                不在归档内。
 *
 * 铁律：任何解析异常/畸形输入一律返回 null 或空数组，绝不抛错、绝不臆造条目（fail-closed）。
 */

/** 文件数据区基址中的固定前缀：8 字节 size pickle。 */
const HEADER_BASE = 8;
/** header pickle 体量上限（512 MiB）——防御畸形/恶意 headerSize 触发超大分配。 */
const _MAX_HEADER_SIZE = 512 * 1024 * 1024;

/**
 * 解析 8 字节 size pickle → 后随 header pickle 的字节长度 headerSize。
 * @param {Buffer} head 文件前 8 字节
 * @returns {number|null} headerSize；畸形返回 null
 */
function parseHeaderSize(head) {
  if (!Buffer.isBuffer(head) || head.length < 8) return null;
  // size pickle 的载荷恰好是一个 UInt32（4 字节）。
  if (head.readUInt32LE(0) !== 4) return null;
  const headerSize = head.readUInt32LE(4);
  if (!Number.isInteger(headerSize) || headerSize <= 0 || headerSize > _MAX_HEADER_SIZE) return null;
  return headerSize;
}

/**
 * 解析 header pickle（长度 == headerSize）→ { header, dataOffset }。
 * @param {Buffer} headerBuf 从文件 offset 8 读入的 headerSize 字节
 * @param {number} headerSize
 * @returns {{header:object, dataOffset:number}|null} 畸形返回 null
 */
function parseHeader(headerBuf, headerSize) {
  if (!Buffer.isBuffer(headerBuf) || headerBuf.length < 8) return null;
  try {
    const jsonLen = headerBuf.readUInt32LE(4); // pickle 内字符串的字节长度
    if (!Number.isInteger(jsonLen) || jsonLen <= 0 || jsonLen + 8 > headerBuf.length) return null;
    const header = JSON.parse(headerBuf.toString('utf8', 8, 8 + jsonLen));
    if (!header || typeof header !== 'object' || !header.files || typeof header.files !== 'object') {
      return null;
    }
    return { header, dataOffset: HEADER_BASE + headerSize };
  } catch { return null; }
}

/**
 * 递归展开 header.files → 扁平条目数组。目录不产出条目（隐式创建）；软链单列。
 * @param {object} header parseHeader 返回的 header
 * @returns {Array<{path:string,type:'file'|'link',offset?:number,size?:number,unpacked?:boolean,link?:string}>}
 */
function flattenEntries(header) {
  const out = [];
  const walk = (node, prefix) => {
    if (!node || !node.files || typeof node.files !== 'object') return;
    for (const name of Object.keys(node.files)) {
      const info = node.files[name];
      if (!info || typeof info !== 'object') continue;
      const rel = prefix ? `${prefix}/${name}` : name;
      if (info.files && typeof info.files === 'object') {
        walk(info, rel); // 目录
      } else if (typeof info.link === 'string') {
        out.push({ path: rel, type: 'link', link: info.link });
      } else {
        const offset = parseInt(info.offset, 10);
        const size = Number(info.size);
        out.push({
          path: rel,
          type: 'file',
          offset: Number.isFinite(offset) ? offset : null,
          size: Number.isFinite(size) && size >= 0 ? size : 0,
          unpacked: info.unpacked === true,
        });
      }
    }
  };
  try { walk(header, ''); } catch { /* fail-closed: 返回已收集部分 */ }
  return out;
}

module.exports = {
  HEADER_BASE,
  parseHeaderSize,
  parseHeader,
  flattenEntries,
};

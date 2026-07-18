'use strict';

/**
 * offloadStore.js — L3 卸载离境的外部持久层（§3.2 L3 / §3.3 外部卸载指针集）。
 *
 * 当上下文 > 90%，冷数据必须被驱赶出寄存器，上下文里只留一枚**寻址指针**。本模块把
 * 冷记录原子落盘到项目数据目录，并返回可回填进上下文的指针 `<offloaded ref="…"/>`。
 * 指针体量极小（仅 ref/sha/bytes），符合「上下文仅留寻址指针，~0.1% 留存」。
 *
 * 复用单一真源 `utils/dataHome.getProjectDataDir`（与 sessionPersistence 同一套
 * 项目分桶），不另立持久化机制。落盘走 tmp+rename 原子写，绝不产生半截文件。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function _dir() {
  try {
    const { getProjectDataDir } = require('../../utils/dataHome');
    return getProjectDataDir('cognitive_snapshots', 'offload');
  } catch {
    const os = require('os');
    return path.join(os.tmpdir(), 'khy-cognitive-offload');
  }
}

// 收敛到 utils/ensureDirSync 单一真源(逐字节委托,调用点不变)
const _ensure = require('../../utils/ensureDirSync');

function _atomicWrite(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

/**
 * 卸载一条冷记录到外部持久层。
 * @param {string} taskId
 * @param {string} key   记录键（如 step 序号），用于稳定文件名
 * @param {*} data       冷数据（将 JSON 序列化）
 * @returns {{ref:string, file:string, key:string, sha:string, bytes:number}}
 */
function offload(taskId, key, data) {
  const dir = path.join(_dir(), _safe(taskId));
  _ensure(dir);
  const payload = JSON.stringify({ taskId, key, data, at: _stamp() });
  const sha = crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
  const file = path.join(dir, `${_safe(String(key))}.${sha}.json`);
  _atomicWrite(file, payload);
  return {
    ref: `<offloaded ref="${file}" sha="${sha}" bytes="${Buffer.byteLength(payload)}"/>`,
    file,
    key: String(key),
    sha,
    bytes: Buffer.byteLength(payload),
  };
}

/**
 * 按指针或文件路径取回冷记录（断点恢复 / 模型按需回读）。
 * @param {string} pointerOrPath  `<offloaded ref="…"/>` 字符串或裸文件路径
 * @returns {*|null} 原始 data，缺失/损坏返回 null（绝不抛）
 */
function load(pointerOrPath) {
  try {
    const file = _resolvePath(pointerOrPath);
    if (!file || !fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return parsed && 'data' in parsed ? parsed.data : parsed;
  } catch {
    return null;
  }
}

function _resolvePath(pointerOrPath) {
  if (!pointerOrPath) return '';
  const s = String(pointerOrPath);
  const m = s.match(/ref="([^"]+)"/);
  return m ? m[1] : s;
}

const _safe = require('../../utils/slugifyToken'); // 文件名安全化单一真源

// new Date()/Date.now() 在工作流脚本里被禁；此处是普通服务模块，可用，但保持容错。
function _stamp() {
  try { return Date.now(); } catch { return 0; }
}

module.exports = { offload, load, _resolvePath };

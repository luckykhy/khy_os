'use strict';

/**
 * guardedReadFileSync — 对「非主读工具」裸 fs.readFileSync 的防卡死 IO 包装。
 *
 * 主读工具(readFile.js / FileReadTool)有各自更细的内联读守卫(有界读 / 格式路由),
 * 不改用本包装。本包装服务于**辅助读路径**——imageOcr / recognizeImage / securityScan /
 * coverageReport 等:它们此前直接 `fs.readFileSync(调用方 / 遍历供给的路径)`,遇 FIFO /
 * 套接字 / 字符或块设备 / 阻塞伪文件(/proc·/sys)会**永久卡死**——同步读第一个字节冻结
 * 事件循环,连 services/toolCalling.js 的 120s 工具超时(Promise.race + setTimeout)都救不了
 * (定时器所在的事件循环已被冻结)。
 *
 * 机制:触碰字节前先 `fs.statSync`(对 FIFO / 设备只读 inode 元数据,**不阻塞**)拿到类型,
 * 再过 `filePreReadHangGuard.classifyPreReadHang` 前检;命中会卡死的向量 → 抛
 * `EREADHANG` 错(附刷新级拒绝消息 + hangKind),否则照常 `fs.readFileSync`。
 *
 * 契约(逐字节回退,绝不改变正常文件的读取结果):
 *   - 仅当能 statSync 时前检;statSync 失败(ENOENT / EACCES 等,均为**快速失败**非卡死)
 *     则跳过守卫、直接 readFileSync,让它抛与历史完全一致的错。
 *   - 各向量各自沿用其族门(default-on);族门关 → 该向量不命中(逐字节回退)。
 *   - 绝不因守卫吞掉正常读:命中才抛,未命中透传 readFileSync 的返回值 / 错误。
 *
 * @param {string} absPath 目标路径(遵循 readFileSync 语义,跟随符号链接)
 * @param {object|string} [options] 传给 fs.readFileSync 的 options / encoding
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Buffer|string} readFileSync 的返回值
 * @throws {Error} 命中卡死向量时抛 err.code='EREADHANG';否则透传 readFileSync 的错
 */
function guardedReadFileSync(absPath, options, env = process.env) {
  const fs = require('fs');
  let stat = null;
  try { stat = fs.statSync(absPath); } catch { stat = null; }
  if (stat) {
    let verdict = null;
    try {
      const { classifyPreReadHang } = require('./filePreReadHangGuard');
      verdict = classifyPreReadHang({ absPath, stat, env });
    } catch { verdict = null; }
    if (verdict && verdict.blocked) {
      const err = new Error(verdict.error);
      err.code = 'EREADHANG';
      err.hangKind = verdict.kind;
      throw err;
    }
  }
  return fs.readFileSync(absPath, options);
}

module.exports = { guardedReadFileSync };

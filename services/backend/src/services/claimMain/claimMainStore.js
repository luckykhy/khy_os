'use strict';

/**
 * claimMainStore.js — `/claim-main` 的薄壳 IO 层:同机多实例共享的「主角色」持久指针 +
 * 进程存活判定。
 *
 * 为什么存在:khy 的「主」角色需要一个**跨独立 `khy` 调用可发现**的落点。镜像
 * remoteDevSessionStore 的成熟做法:在 `getDataDir('instances')/main.json` 放一个原子写
 * (temp + rename)的指针,best-effort、绝不抛、损坏/缺失一律当「无人持有」。存活判定用
 * `process.kill(pid, 0)`(同 consolidationLock/daemonManager 的判据:不发真信号,仅探测进程
 * 是否存在 + 是否有权限),据此让纯叶子 claimMainPlan 决定认领/接管/覆盖。
 *
 * 所有逻辑(认领该不该写、release 该不该清)都在纯叶子;本壳只做 fs 读写 + PID 探测,绝不决策。
 */

const fs = require('fs');
const path = require('path');
const { getDataDir } = require('../../utils/dataHome');

/** 主指针文件绝对路径:<dataHome>/instances/main.json */
function pointerPath() {
  return path.join(getDataDir('instances'), 'main.json');
}

/** 读取持久指针,缺失/损坏 → null。 */
function readPointer() {
  try {
    const raw = fs.readFileSync(pointerPath(), 'utf8');
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

/** 原子写指针(temp + rename)。成功返回 descriptor,失败 null。 */
function writePointer(descriptor) {
  if (!descriptor || typeof descriptor !== 'object') return null;
  try {
    const file = pointerPath();
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(descriptor, null, 2));
    fs.renameSync(tmp, file);
    return descriptor;
  } catch {
    return null;
  }
}

/** 清除指针。删成功 true,否则 false。 */
function clearPointer() {
  try {
    fs.unlinkSync(pointerPath());
    return true;
  } catch {
    return false;
  }
}

/**
 * 用 process.kill(pid, 0) 探测进程是否存活(同 consolidationLock/daemonManager 判据)。
 * 返回 true=存活;false=不存在(ESRCH)。EPERM(存在但无权限)按存活处理。绝不抛。
 * @param {number} pid
 * @returns {boolean}
 */
function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  try {
    process.kill(Math.floor(n), 0);
    return true;
  } catch (err) {
    // EPERM:进程存在但本进程无权限发信号 → 仍视为存活。
    if (err && err.code === 'EPERM') return true;
    return false;
  }
}

module.exports = {
  pointerPath,
  readPointer,
  writePointer,
  clearPointer,
  isPidAlive,
};

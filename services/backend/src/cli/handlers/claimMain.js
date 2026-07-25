'use strict';

/**
 * claimMain.js — `/claim-main` 命令薄壳:在同机多 khy 实例间认领唯一「主」角色。对齐 Claude Code 的
 * /claim-main(强制当前实例成为 main),但**诚实落到 khy 的本地语义**:不伪造 Unix socket / 命名管道
 * NDJSON pipe-IPC 协议,而是复用 getDataDir 的共享持久领地 + 「指针 + PID 存活 + 陈旧接管」模式
 * (consolidationLock/daemonManager/remoteDevSessionStore 同款),在 <dataHome>/instances/main.json 上
 * 以 pid 为身份认领主角色。
 *
 * **背后逻辑**(认领/接管/覆盖判定、release 判定、文本渲染)全在纯叶子 services/claimMain/claimMainPlan.js
 * (单一真源·零 IO·绝不抛);本薄壳只做:门控、读指针(claimMainStore)、用 process.kill(pid,0) 判存活、
 * 把结果交叶子决策、原子写/清指针、渲染。绝不另起炉灶,绝不写任何 host/port/model 硬编码。
 *
 * 诚实边界:khy 的「主」是共享指针上的逻辑角色,不是真的 pipe-IPC server —— 不会自动重绑其它实例
 * (khy 无 sub 注册表/socket);仅同机多实例,跨机器不支持;release 仅清本进程自己持有的指针。
 *
 * 用法:`/claim-main [claim|status|release|help]`(空参 = claim)。门控 KHY_CLAIM_MAIN 默认开;
 * 关 → 命令不接管(字节回退)。
 */

const os = require('os');
const { printInfo, printError } = require('../formatters');
const leaf = require('../../services/claimMain/claimMainPlan');
const store = require('../../services/claimMain/claimMainStore');

// try/catch combinator 单一真源 utils/tryOr:执行 fn,任何异常 → dflt。
const _safe = require('../../utils/tryOr');

/** 读当前指针(best-effort)。 */
function _readPointer() {
  return _safe(() => store.readPointer(), null);
}

/** 判持有者是否存活(委托 store 的 process.kill(pid,0))。 */
function _holderAlive(pointer) {
  if (!pointer || pointer.pid == null) return false;
  return _safe(() => store.isPidAlive(pointer.pid), false) === true;
}

/**
 * `/claim-main` 入口。
 * @param {string} _subCommand
 * @param {string[]} [args]
 * @param {object} [_options]
 * @returns {Promise<boolean>} 是否接管该命令(门控关 → false)。
 */
async function handleClaimMain(_subCommand, args = [], _options = {}) {
  if (!leaf.isEnabled(process.env)) {
    printInfo('claim-main 命令未启用(KHY_CLAIM_MAIN 为关)。');
    return false;
  }

  const parsed = leaf.parseClaimArgs(args);

  if (parsed.action === 'help') {
    printInfo(leaf.buildHelpText());
    return true;
  }
  if (!parsed.valid && parsed.parseError === 'unknown_action') {
    printError(leaf.buildUnknownText());
    return true;
  }

  const selfPid = process.pid;
  const pointer = _readPointer();

  if (parsed.action === 'status') {
    const holderAlive = _holderAlive(pointer);
    printInfo(leaf.buildStatusText({ pointer, holderAlive, selfPid }));
    return true;
  }

  if (parsed.action === 'release') {
    const decision = leaf.decideRelease({ pointer, selfPid });
    if (decision.shouldClear) _safe(() => store.clearPointer(), false);
    printInfo(leaf.buildReleaseText(decision));
    return true;
  }

  // claim(默认):判存活 → 叶子决策 → 必要时原子写。
  const holderAlive = _holderAlive(pointer);
  const decision = leaf.decideClaim({ pointer, holderAlive, selfPid });
  if (decision.shouldWrite) {
    const host = _safe(() => os.hostname(), null);
    const claimedAt = new Date().toISOString();
    const descriptor = leaf.buildClaimDescriptor({ pid: selfPid, host, claimedAt });
    _safe(() => store.writePointer(descriptor), null);
  }
  printInfo(leaf.buildClaimText(decision, selfPid));
  return true;
}

module.exports = { handleClaimMain };

'use strict';

/**
 * claimMainPlan.js — `/claim-main`(在同机多 khy 实例间认领「主」角色)的零 IO 确定性单一真源(纯叶子)。
 *
 * 契约 (CONTRACT): 零 IO、确定性、绝不抛、无副作用;当前持有者指针、本进程 pid、各进程存活判定结果、env
 * 全经入参注入,本叶子绝不读 process.env、绝不触文件、绝不调 process.kill、绝不调 Date、绝不持有状态。真正的
 * 「读/写主指针 + 用 process.kill(pid,0) 判存活」(有 fs/进程 IO)都在薄壳 store/handler,委托既有
 * getDataDir + 同款原子写(镜像 remoteDevSessionStore)+ 同款存活判据(镜像 consolidationLock/daemonManager),
 * 绝不另起炉灶。本叶子只做:由「当前指针 + 持有者是否存活 + 本进程身份」推导认领结果 + 构造待持久化描述符 + 文本渲染。
 *
 * 背后的逻辑(对齐 Claude Code /claim-main —— 但**诚实落到 khy 的本地语义**):CC 的 /claim-main 是在同机/局域网
 * 多个 CLI 实例间,通过 **Unix domain socket / 命名管道 NDJSON 协议 + 共享 registry.json** 协调出一个 main + N 个 sub,
 * `/claim-main` 强制当前实例成为 main(覆盖现持有者),并把所有 sub 重绑到它。khy **没有那套 pipe-IPC 传输层 —— 绝不
 * 伪造一个 socket 协议**;但 khy **真有**同构的本地基质:① `getDataDir` 给出**跨实例可发现**的持久领地,② 一套成熟的
 * 「指针 + PID 存活 + 陈旧接管」模式(consolidationLock/daemonManager/remoteDevSessionStore)。把它们一合,khy 的
 * /claim-main = **在 `<dataHome>/instances/main.json` 这个共享指针上,以 PID 为身份认领主角色**:无人持有 → 认领;
 * 持有者进程已死(陈旧)→ 接管;持有者活着且是别的 pid → 覆盖式认领(对齐 CC「强制成为 main」语义);已是自己 → no-op。
 * 这正是「学习 CC 的逻辑(认领唯一主角色 + 可强制覆盖),而非表面的 socket 协议」。
 *
 * 诚实边界(刻意不编造 khy 没有的语义):① khy 的「主」是**一个共享指针上的逻辑角色**,不是一个真的 pipe-IPC server —— 故
 * 不会自动把别的实例「重绑」过来(khy 无 sub 注册表/socket);角色仅作为协调标记,如实说明;② 跨**机器**不支持(指针在
 * 本机 dataHome),仅同机多实例;③ `release` 仅当本进程是当前持有者时才清除(绝不替别人释放);④ status 只读,如实透出
 * 持有者 pid/是否存活/是否本进程。
 *
 * 注意:本文件刻意不在注释里书写 require-调用样式,避免架构债扫描器把它当成幽灵依赖边。本叶子零依赖。
 */

const _CLAIM_WORDS = new Set(['claim', 'take', 'acquire', '认领', '抢', '占用', '成为主']);
const _STATUS_WORDS = new Set(['status', 'state', 'who', 'show', '状态', '查看', '谁']);
const _RELEASE_WORDS = new Set(['release', 'off', 'drop', 'unclaim', '释放', '放弃', '退出']);
const _HELP_WORDS = new Set(['help', '-h', '--help', '帮助', '用法']);

/** 认领结果种类。 */
const CLAIM_RESULT = {
  CLAIMED_FREE: 'claimed_free',       // 此前无人持有 → 认领
  TOOK_OVER_STALE: 'took_over_stale', // 持有者进程已死 → 接管
  OVERRODE_LIVE: 'overrode_live',     // 持有者活着但非本进程 → 覆盖式认领
  ALREADY_SELF: 'already_self',       // 已是本进程 → no-op
};

/**
 * 解析 `/claim-main [claim|status|release|help]`。空参 = claim(对齐 CC 默认就是认领)。
 * @param {string[]} args
 * @returns {{action:'claim'|'status'|'release'|'help', valid:boolean, parseError:(string|null)}}
 */
function parseClaimArgs(args) {
  const list = Array.isArray(args) ? args : [];
  const first = list.length > 0 ? String(list[0] == null ? '' : list[0]).trim().toLowerCase() : '';
  if (first === '') return { action: 'claim', valid: true, parseError: null };
  if (_HELP_WORDS.has(first)) return { action: 'help', valid: true, parseError: null };
  if (_CLAIM_WORDS.has(first)) return { action: 'claim', valid: true, parseError: null };
  if (_STATUS_WORDS.has(first)) return { action: 'status', valid: true, parseError: null };
  if (_RELEASE_WORDS.has(first)) return { action: 'release', valid: true, parseError: null };
  return { action: 'claim', valid: false, parseError: 'unknown_action' };
}

/**
 * 由「当前指针 + 持有者是否存活 + 本进程身份」推导认领该如何进行。纯函数,不做任何 IO。
 * @param {object} input
 * @param {object|null} input.pointer - 当前主指针({pid, host, claimedAt, ...} 或 null)
 * @param {boolean} input.holderAlive - 薄壳用 process.kill(holderPid,0) 判出的存活结果(无持有者时无意义)
 * @param {number} input.selfPid - 本进程 pid
 * @returns {{ result:string, shouldWrite:boolean, priorPid:(number|null), priorAlive:boolean }}
 */
function decideClaim(input) {
  const src = input && typeof input === 'object' ? input : {};
  const ptr = src.pointer && typeof src.pointer === 'object' ? src.pointer : null;
  const selfPid = _intOrNull(src.selfPid);
  const priorPid = ptr ? _intOrNull(ptr.pid) : null;

  if (!ptr || priorPid == null) {
    return { result: CLAIM_RESULT.CLAIMED_FREE, shouldWrite: true, priorPid: null, priorAlive: false };
  }
  if (selfPid != null && priorPid === selfPid) {
    return { result: CLAIM_RESULT.ALREADY_SELF, shouldWrite: false, priorPid, priorAlive: true };
  }
  const alive = src.holderAlive === true;
  if (!alive) {
    return { result: CLAIM_RESULT.TOOK_OVER_STALE, shouldWrite: true, priorPid, priorAlive: false };
  }
  // 持有者活着且非本进程 → 覆盖式认领(对齐 CC「强制成为 main」)。
  return { result: CLAIM_RESULT.OVERRODE_LIVE, shouldWrite: true, priorPid, priorAlive: true };
}

/**
 * 构造待持久化的主指针描述符。纯:调用方注入 claimedAt(ISO 串)与 host,叶子保持无时钟。
 * @param {object} args - { pid, host, claimedAt }
 */
function buildClaimDescriptor({ pid, host, claimedAt } = {}) {
  return {
    pid: _intOrNull(pid),
    host: host == null ? null : String(host),
    claimedAt: claimedAt == null ? null : String(claimedAt),
    role: 'main',
  };
}

/**
 * 由「当前指针 + 是否本进程 + 持有者是否存活」决定 release 该如何进行。
 * 仅当本进程是当前持有者时才清除(绝不替别人释放)。
 * @param {object} input - { pointer, selfPid }
 * @returns {{ shouldClear:boolean, reason:string, holderPid:(number|null) }}
 */
function decideRelease(input) {
  const src = input && typeof input === 'object' ? input : {};
  const ptr = src.pointer && typeof src.pointer === 'object' ? src.pointer : null;
  const selfPid = _intOrNull(src.selfPid);
  const holderPid = ptr ? _intOrNull(ptr.pid) : null;
  if (!ptr || holderPid == null) {
    return { shouldClear: false, reason: 'none', holderPid: null };
  }
  if (selfPid != null && holderPid === selfPid) {
    return { shouldClear: true, reason: 'self', holderPid };
  }
  return { shouldClear: false, reason: 'not_self', holderPid };
}

/** 渲染认领结果文本。 */
function buildClaimText(decision, selfPid) {
  const d = decision && typeof decision === 'object' ? decision : {};
  const self = _intOrNull(selfPid);
  const lines = [];
  lines.push('👑 claim-main · 主角色认领');
  switch (d.result) {
    case CLAIM_RESULT.CLAIMED_FREE:
      lines.push(`  ✓ 已认领主角色(此前无人持有)。本进程 pid=${self == null ? '?' : self}`);
      break;
    case CLAIM_RESULT.TOOK_OVER_STALE:
      lines.push(`  ✓ 已接管主角色 —— 原持有者 pid=${d.priorPid} 进程已不存在(陈旧指针)。本进程 pid=${self == null ? '?' : self}`);
      break;
    case CLAIM_RESULT.OVERRODE_LIVE:
      lines.push(`  ✓ 已覆盖式认领主角色 —— 原持有者 pid=${d.priorPid} 仍在运行,现已让位给本进程 pid=${self == null ? '?' : self}。`);
      lines.push('    (对齐 Claude Code「强制成为 main」语义;khy 无 sub 注册表,故不会自动重绑其它实例。)');
      break;
    case CLAIM_RESULT.ALREADY_SELF:
      lines.push(`  ℹ 本进程 pid=${self == null ? '?' : self} 已是主角色(无变化)。`);
      break;
    default:
      lines.push('  认领结果未知。');
  }
  return lines.join('\n');
}

/** 渲染 status 文本(只读)。 */
function buildStatusText(input) {
  const src = input && typeof input === 'object' ? input : {};
  const ptr = src.pointer && typeof src.pointer === 'object' ? src.pointer : null;
  const self = _intOrNull(src.selfPid);
  const lines = [];
  lines.push('👑 claim-main · 当前主角色');
  if (!ptr || _intOrNull(ptr.pid) == null) {
    lines.push('  当前无实例持有主角色(可用 /claim-main 认领)。');
    lines.push(`  本进程 pid=${self == null ? '?' : self}`);
    return lines.join('\n');
  }
  const holderPid = _intOrNull(ptr.pid);
  const isSelf = self != null && holderPid === self;
  const alive = src.holderAlive === true;
  lines.push(`  持有者 pid=${holderPid}${isSelf ? '(本进程)' : ''} · ${alive ? '存活' : '已不存在(陈旧)'}`);
  if (ptr.host) lines.push(`  主机: ${ptr.host}`);
  if (ptr.claimedAt) lines.push(`  认领时间: ${ptr.claimedAt}`);
  if (!alive && !isSelf) lines.push('  提示: 持有者已死,可用 /claim-main 接管。');
  return lines.join('\n');
}

/** 渲染 release 结果文本。 */
function buildReleaseText(decision) {
  const d = decision && typeof decision === 'object' ? decision : {};
  switch (d.reason) {
    case 'self':
      return '👑 claim-main · 已释放本进程持有的主角色。';
    case 'not_self':
      return `👑 claim-main · 当前主角色由 pid=${d.holderPid} 持有,非本进程 —— 拒绝替他人释放(请在该实例上操作,或用 /claim-main 覆盖式认领)。`;
    case 'none':
    default:
      return '👑 claim-main · 当前无实例持有主角色,无需释放。';
  }
}

function buildHelpText() {
  return [
    '/claim-main —— 在同机多 khy 实例间认领「主」角色(对齐 Claude Code /claim-main 的「强制成为 main」逻辑)',
    '  用法:',
    '    /claim-main           认领主角色(无人持有→认领;持有者已死→接管;活着→覆盖式认领)(默认)',
    '    /claim-main status    查看当前主角色持有者(pid/存活/是否本进程)',
    '    /claim-main release   释放本进程持有的主角色(仅当持有者是自己)',
    '  说明:',
    '    · 与 CC 的 Unix socket / 命名管道 NDJSON pipe-IPC 不同:khy 不伪造 socket 协议,而是复用 getDataDir 的',
    '      共享持久领地 + 「指针 + PID 存活 + 陈旧接管」模式(consolidationLock/daemonManager 同款),在',
    '      <dataHome>/instances/main.json 上以 pid 为身份认领唯一主角色。',
    '    · khy 无 sub 注册表/socket,故不会自动重绑其它实例;主角色仅作协调标记。仅同机多实例,跨机器不支持。',
  ].join('\n');
}

function buildUnknownText() {
  return `未知子命令。${buildHelpText()}`;
}

/**
 * 门控 KHY_CLAIM_MAIN(默认开;关时薄壳字节回退为「不接管」)。
 * @param {object} env
 * @returns {boolean}
 */
function isEnabled(env) {
  const e = env || {};
  const raw = e.KHY_CLAIM_MAIN === undefined ? 'true' : e.KHY_CLAIM_MAIN;
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  return !(s === '' || s === '0' || s === 'false' || s === 'off' || s === 'no');
}

// ── 内部纯助手 ───────────────────────────────────────────────────────────────
function _intOrNull(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

module.exports = {
  CLAIM_RESULT,
  parseClaimArgs,
  decideClaim,
  buildClaimDescriptor,
  decideRelease,
  buildClaimText,
  buildStatusText,
  buildReleaseText,
  buildHelpText,
  buildUnknownText,
  isEnabled,
};

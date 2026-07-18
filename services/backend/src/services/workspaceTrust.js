'use strict';

/**
 * workspaceTrust.js — 纯叶子:首次在「陌生/未信任文件夹」启动 khy 时,是否需要弹出
 * 「快速安全检查 / 信任此文件夹」对话框的**决策与文案单一真源**(对齐 Claude Code 的
 * workspace trust)。
 *
 * 背景(先核实再动手):khy 此前**无**任何「文件夹信任」机制 —— handlers/onboarding.js
 * 甚至显式声明这是「诚实边界」并为 /onboarding trust 留了「不可用」占位。Claude Code 的
 * 逻辑是:进 REPL、做任何读/写/执行**之前**,先查当前目录(及其父目录,可继承)是否已被
 * 持久化信任;home 目录只做 session 级信任(不把整个 home 永久标信任);未信任则弹对话框
 * 「Is this a project you trust? 1. Yes / 2. No, exit」,接受后持久化
 * projects[path].hasTrustDialogAccepted。
 *
 * 本叶子只做**决策与文案**,零 IO:调用方(cli/trustGate.js)读入「已信任路径集合 + cwd +
 * homedir + 本会话 home 信任标记」,叶子判定 trusted / 是否需弹窗,并产出确定性对话框文案。
 * 读写信任存储、弹 inquirer、process.exit 一律留给调用方。
 *
 * 契约:零 IO(不碰 fs/网络/子进程/process.exit;不读时钟/env 决策值,homedir/cwd 由调用方
 * 注入)、确定性、绝不抛(fail-soft)、env 门控 KHY_WORKSPACE_TRUST 默认开;关 →
 * isTrustGateEnabled=false,调用方逐字节回退到「不弹窗、视为已信任」的今日行为。
 *
 * 诚实边界:决策异常时 computeTrustState fail-**open**(视为已信任、不弹窗)—— 可用性优先,
 * 与 cli/onboarding.js 「非交互则放行」同口径;trust 是启动期 UX/安全**提示闸**,不是硬安全
 * 边界(真正的执行权限仍受 permissions/riskGate 管控),故绝不因本闸异常而挡住 khy 启动。
 */

const path = require('path');

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/** KHY_WORKSPACE_TRUST 门控:默认开,{0,false,off,no} 回退关。 */
function isTrustGateEnabled(env = process.env) {
  const raw = env && env.KHY_WORKSPACE_TRUST;
  const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
  return !_FALSY.has(v);
}

/**
 * KHY_TRUST_PERSIST_HOME 门控:**默认关**。
 *
 * home 目录接受信任后**默认即落盘(exact-scope)**——确认一次不再重复弹窗(实现用户诉求
 * 「信任文件夹后下次打开只需点一次即可」),但仅精确信任 home 目录本身,子目录仍各自单独批准。
 *
 * 显式置真({1,true,on,yes,y})→ 把 home 目录信任**升级为 tree-scope**(整棵 home 子树都视为
 * 信任,子目录不再弹窗)。诚实权衡:trust 是启动期 UX 提示闸,非硬安全边界——真正执行权限仍受
 * permissions/riskGate 管控。默认关时子树不继承,粒度更细、更安全。
 */
function isPersistHomeTrustEnabled(env = process.env) {
  const raw = env && env.KHY_TRUST_PERSIST_HOME;
  const v = String(raw === undefined || raw === null ? '' : raw).trim().toLowerCase();
  return ['1', 'true', 'on', 'yes', 'y'].includes(v);
}

/**
 * KHY_TRUST_EXACT_DIR 门控:**默认关**(对齐 CC 的父目录继承——信任 ~/projects 后
 * ~/projects/foo 自动信任)。显式置真({1,true,on,yes,y})→ **每个目录独立批准**:仅精确
 * 命中的目录被信任,子目录另开新会话须单独批准(不继承父目录信任)。默认关 → 逐字节回退今日
 * 继承行为。标志由壳读取后注入 computeTrustState(叶子不读 env 决策值,保持零 IO 契约)。
 */
function isExactDirTrustEnabled(env = process.env) {
  const raw = env && env.KHY_TRUST_EXACT_DIR;
  const v = String(raw === undefined || raw === null ? '' : raw).trim().toLowerCase();
  return ['1', 'true', 'on', 'yes', 'y'].includes(v);
}

/** 把路径规整为稳定的绝对路径 key(纯字符串/path 运算,零 IO)。失败回退原串。 */
function normalizePathForKey(p) {
  try {
    if (!p) return '';
    return path.resolve(String(p));
  } catch {
    return String(p || '');
  }
}

/** cwd 是否就是 home 目录(home 只做 session 级信任,不落盘整棵 home)。 */
function isHomeDir(cwd, homedir) {
  const a = normalizePathForKey(cwd);
  const b = normalizePathForKey(homedir);
  return !!a && a === b;
}

/**
 * cwd 是否被已信任集合覆盖。
 *
 * 两种匹配语义:
 *   • **父目录继承(默认,exactMatch=false)**:cwd 或其任一祖先命中即信任(对齐 CC:信任
 *     ~/projects 后 ~/projects/foo 自动继承)。
 *   • **精确匹配(exactMatch=true)**:仅当 cwd 本身在集合中才信任;子目录另开会话须单独批准。
 *     由门控 KHY_TRUST_EXACT_DIR 驱动,标志由壳注入(叶子不读 env 决策值)。
 * @param {string} cwd
 * @param {Set<string>|string[]} trustedPaths 已信任的绝对路径集合
 * @param {boolean} [exactMatch=false] true → 只精确匹配当前目录,不继承父目录
 */
function isPathTrusted(cwd, trustedPaths, exactMatch = false) {
  try {
    const set = trustedPaths instanceof Set
      ? trustedPaths
      : new Set((Array.isArray(trustedPaths) ? trustedPaths : []).map(normalizePathForKey));
    let cur = normalizePathForKey(cwd);
    if (!cur) return false;
    // 精确匹配:仅当前目录命中,子目录须单独批准。
    if (exactMatch) return set.has(cur);
    // 向上遍历所有父目录,任一命中即信任;到根(parent===cur)停止。
    // 有界:绝对路径的父链长度有限,不会死循环。
    while (true) {
      if (set.has(cur)) return true;
      const parent = normalizePathForKey(path.resolve(cur, '..'));
      if (parent === cur) return false;
      cur = parent;
    }
  } catch {
    return false;
  }
}

/**
 * 决策:这次启动是否需要弹「信任此文件夹」对话框。
 *
 * 两类已信任集合(壳按落盘条目的 scope 拆分后注入):
 *   • **tree-scope(trustedPaths)**:默认可继承(exactDir 关时子目录自动信任),普通项目目录。
 *   • **exact-scope(exactTrustedPaths)**:**永不继承**,仅精确命中当前目录才算信任。home 目录
 *     即用此作用域落盘——确认一次不再重复弹窗,又不把整棵 home 子树标为信任(子目录仍各自单独
 *     批准)。这直接实现用户诉求:「信任文件夹后下次打开只需点一次即可」。
 * @param {object} args
 * @param {string} args.cwd 当前工作目录(调用方注入 process.cwd())
 * @param {string} args.homedir 用户 home(调用方注入 os.homedir())
 * @param {Set<string>|string[]} args.trustedPaths tree-scope 已信任路径(可继承)
 * @param {Set<string>|string[]} [args.exactTrustedPaths] exact-scope 已信任路径(永不继承)
 * @param {boolean} args.sessionTrusted 本会话 home 目录信任标记(内存态)
 * @param {boolean} [args.exactDir] true → 每个目录独立批准,不继承父目录信任
 *   (由壳读门控 KHY_TRUST_EXACT_DIR 注入;叶子不读 env 决策值)
 * @returns {{ trusted:boolean, needsPrompt:boolean, isHomeDir:boolean, reason:string }}
 */
function computeTrustState({ cwd, homedir, trustedPaths, exactTrustedPaths, sessionTrusted, exactDir } = {}) {
  try {
    if (sessionTrusted) {
      return { trusted: true, needsPrompt: false, isHomeDir: false, reason: 'session' };
    }
    const home = isHomeDir(cwd, homedir);
    // tree-scope:cwd 或其祖先命中(exactDir 关时继承,开时仅当前目录)。
    if (isPathTrusted(cwd, trustedPaths, !!exactDir)) {
      return { trusted: true, needsPrompt: false, isHomeDir: home, reason: 'persisted' };
    }
    // exact-scope:仅精确命中当前目录才信任,永不继承(home 目录走此路)。
    if (exactTrustedPaths && isPathTrusted(cwd, exactTrustedPaths, true)) {
      return { trusted: true, needsPrompt: false, isHomeDir: home, reason: 'persisted-exact' };
    }
    return { trusted: false, needsPrompt: true, isHomeDir: home, reason: 'untrusted' };
  } catch {
    // fail-open:决策异常 → 视为已信任、不打扰(可用性优先,见文件头诚实边界)。
    return { trusted: true, needsPrompt: false, isHomeDir: false, reason: 'error' };
  }
}

/**
 * 确定性对话框文案(中文,语义对齐 CC 的「Quick safety check」)。
 * @param {string} cwd
 * @returns {string[]} 逐行文案(不含选项;选项见 TRUST_CHOICES)
 */
function buildTrustPromptLines(cwd) {
  const dir = String(cwd || '');
  return [
    '正在访问工作目录:',
    '',
    `  ${dir}`,
    '',
    '快速安全检查:这是你自己创建、或你信任的项目吗?(比如你自己的代码、知名的开源',
    '项目,或来自你团队的工作)。如果不是,请先花点时间看看这个文件夹里有什么。',
    '',
    '一旦信任,khy 将能够在此读取、编辑并执行文件。',
  ];
}

/** 对话框选项(对齐 CC:Yes, I trust this folder / No, exit)。 */
const TRUST_CHOICES = Object.freeze([
  { name: '是,我信任这个文件夹', value: 'trust' },
  { name: '否,退出', value: 'exit' },
]);

module.exports = {
  isTrustGateEnabled,
  isPersistHomeTrustEnabled,
  isExactDirTrustEnabled,
  normalizePathForKey,
  isHomeDir,
  isPathTrusted,
  computeTrustState,
  buildTrustPromptLines,
  TRUST_CHOICES,
};

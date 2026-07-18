'use strict';

/**
 * trustGate.js — 「快速安全检查 / 信任此文件夹」对话框的 IO 外壳(非纯叶子)。
 *
 * 决策与文案委派给纯叶子 services/workspaceTrust.js(单一真源);本壳只做 IO:读写信任存储、
 * 弹 inquirer、产出「退出」意图交调用方执行。用法镜像 cli/onboarding.js —— PRE-MOUNT
 * 在 repl.js 里调用,同时覆盖默认 Ink TUI 与经典 readline REPL 两条路径。
 *
 * 持久化:<dataHome>/trusted-folders.json = { paths: { "<abs>": { trustedAt, scope } } }
 * (自成一档、最小爆炸半径,不动全局 config schema)。scope ∈ {'tree','exact'}:tree 可继承
 * (普通项目目录),exact 永不继承(home 目录)。历史条目无 scope 字段 → 视为 'tree'(向后兼容)。
 *
 * home 目录接受信任 → **默认落盘 exact-scope**:确认一次不再重复弹窗(实现用户诉求「信任文件夹
 * 后下次打开只需点一次即可」),但只精确信任 home 本身,子目录仍各自单独批准。门控
 * KHY_TRUST_PERSIST_HOME(默认关)开启后把 home 升级为 tree-scope(整棵 home 子树都信任)。
 * 落盘失败 fail-soft 退回本会话内存信任。门控复用叶子 KHY_WORKSPACE_TRUST。
 *
 * fail-soft/fail-open:本壳任何异常都返回 { trusted:true },绝不挡 khy 启动(trust 是启动期
 * UX/安全提示闸,不是硬安全边界 —— 真正执行权限仍受 permissions/riskGate 管控)。无法交互
 * (无 inquirer)时诚实降级为放行但**不落盘**(不假装已持久化信任)。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const trust = require('../services/workspaceTrust');

// home 目录的 session 级信任(内存态,不落盘;对齐 CC 的 setSessionTrustAccepted)。
let _sessionTrusted = false;

/** 信任存储路径:落 dataHome;解析失败回退 ~/.khy。 */
function _storePath() {
  try {
    const home = require('../utils/dataHome').getDataHome();
    if (home) return path.join(home, 'trusted-folders.json');
  } catch { /* 回退 */ }
  return path.join(os.homedir(), '.khy', 'trusted-folders.json');
}

/** 读已信任路径清单(绝对路径数组,tree+exact 全部);任何错误 → 空数组。 */
function _readTrustedPaths() {
  try {
    const raw = fs.readFileSync(_storePath(), 'utf-8');
    const obj = JSON.parse(raw);
    if (obj && obj.paths && typeof obj.paths === 'object') return Object.keys(obj.paths);
    return [];
  } catch {
    return [];
  }
}

/**
 * 读信任存储并按 scope 拆分:{ treePaths, exactPaths }。任何错误 → 两空数组。
 * 无 scope 字段的历史条目视为 'tree'(向后兼容,旧存储零迁移即可继承旧继承语义)。
 */
function _readTrustStore() {
  const treePaths = [];
  const exactPaths = [];
  try {
    const raw = fs.readFileSync(_storePath(), 'utf-8');
    const obj = JSON.parse(raw);
    if (obj && obj.paths && typeof obj.paths === 'object') {
      for (const [k, v] of Object.entries(obj.paths)) {
        if (v && v.scope === 'exact') exactPaths.push(k);
        else treePaths.push(k);
      }
    }
  } catch { /* 缺档/损坏 → 空 */ }
  return { treePaths, exactPaths };
}

/**
 * 落盘一条信任记录(best-effort,绝不抛)。返回是否成功。
 * @param {string} absPath 绝对路径 key
 * @param {'tree'|'exact'} [scope='tree'] 信任作用域:tree 可继承、exact 永不继承
 */
function _persistTrust(absPath, scope = 'tree') {
  try {
    if (!absPath) return false;
    const p = _storePath();
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    let obj = { paths: {} };
    try {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
      if (parsed && typeof parsed === 'object') obj = parsed;
    } catch { /* 新文件 */ }
    if (!obj.paths || typeof obj.paths !== 'object') obj.paths = {};
    obj.paths[absPath] = {
      trustedAt: new Date().toISOString(),
      scope: scope === 'exact' ? 'exact' : 'tree',
    };
    fs.writeFileSync(p, JSON.stringify(obj, null, 2));
    return true;
  } catch {
    return false;
  }
}

/**
 * 进 REPL 前的信任闸。绝不抛。
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd] 默认 process.cwd()
 * @param {string} [opts.homedir] 默认 os.homedir()
 * @param {object} [opts.inquirer] inquirer 实例(prompt(qs)=>answers);'inquirer' in opts
 *   时一律尊重传入值(含显式 null=强制非交互),仅省略时才加载真 inquirer
 * @param {object} [opts.c] chalk 实例(可选着色)
 * @param {object} [opts.io] { log }
 * @returns {Promise<{trusted:boolean, action?:'exit', code?:number, persisted?:boolean, reason:string}>}
 */
async function ensureWorkspaceTrust(opts = {}) {
  try {
    // 门控关 → 逐字节回退:不弹窗、视为已信任(今日行为)。
    if (!trust.isTrustGateEnabled()) return { trusted: true, reason: 'gate-off' };

    const cwd = opts.cwd || process.cwd();
    const homedir = opts.homedir || os.homedir();

    const { treePaths, exactPaths } = _readTrustStore();
    const state = trust.computeTrustState({
      cwd,
      homedir,
      trustedPaths: treePaths,
      exactTrustedPaths: exactPaths,
      sessionTrusted: _sessionTrusted,
      exactDir: trust.isExactDirTrustEnabled(),
    });
    if (state.trusted) return { trusted: true, reason: state.reason };

    // ── 需要弹窗 ──
    const inquirer = ('inquirer' in opts)
      ? opts.inquirer
      : (() => { try { return require('inquirer'); } catch { return null; } })();
    const c = opts.c || null;
    const paint = (fn, s) => (c && typeof c[fn] === 'function' ? c[fn](s) : s);
    const log = (...a) => { try { (opts.io && opts.io.log ? opts.io.log : console.log)(...a); } catch { /* non-critical */ } };

    if (!inquirer || typeof inquirer.prompt !== 'function') {
      // 无法交互:可用性优先,放行但不落盘(诚实降级,绝不假装已持久化信任)。
      return { trusted: true, persisted: false, reason: 'non-interactive' };
    }

    log('');
    for (const line of trust.buildTrustPromptLines(cwd)) log(paint('dim', line));
    log('');

    let answer;
    try {
      ({ answer } = await inquirer.prompt([{
        type: 'list',
        name: 'answer',
        message: '是否信任此文件夹?',
        choices: trust.TRUST_CHOICES.map((ch) => ({ name: ch.name, value: ch.value })),
      }]));
    } catch {
      // 取消(Ctrl+C / ESC)= 不信任 → 退出(对齐 CC:ESC → exit)。
      return { trusted: false, action: 'exit', code: 0, reason: 'cancelled' };
    }

    if (answer !== 'trust') {
      return { trusted: false, action: 'exit', code: 0, reason: 'declined' };
    }

    // 接受:
    //   • home 目录 → 默认落盘 exact-scope(确认一次不再弹窗,但不把整棵 home 子树标信任;
    //     子目录仍各自单独批准)。门控 KHY_TRUST_PERSIST_HOME 开 → 升级为 tree-scope(整棵
    //     home 子树信任)。落盘失败 fail-soft 退回本会话内存信任。
    //   • 其他目录 → 落盘 tree-scope(可继承)。
    if (state.isHomeDir) {
      if (trust.isPersistHomeTrustEnabled()) {
        const persisted = _persistTrust(trust.normalizePathForKey(cwd), 'tree');
        if (persisted) return { trusted: true, persisted: true, reason: 'home-persisted' };
      } else {
        const persisted = _persistTrust(trust.normalizePathForKey(cwd), 'exact');
        if (persisted) return { trusted: true, persisted: true, reason: 'home-persisted-exact' };
      }
      _sessionTrusted = true;
      return { trusted: true, persisted: false, reason: 'home-session' };
    }
    const persisted = _persistTrust(trust.normalizePathForKey(cwd), 'tree');
    return { trusted: true, persisted, reason: 'accepted' };
  } catch {
    // fail-open:本闸任何异常都绝不挡启动。
    return { trusted: true, reason: 'error' };
  }
}

module.exports = {
  ensureWorkspaceTrust,
  // 供测试/复用的 IO helper 与 session 态钩子
  _storePath,
  _readTrustedPaths,
  _readTrustStore,
  _persistTrust,
  _setSessionTrusted(v) { _sessionTrusted = !!v; },
  _resetSessionTrusted() { _sessionTrusted = false; },
  // 只读 session 信任态(供 /onboarding trust 如实展示 home 目录的本会话信任)。
  _isSessionTrusted() { return _sessionTrusted; },
};

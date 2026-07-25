'use strict';

/**
 * mdEditorRegister — 首次运行时把 khyosMarkdown 幂等注册进系统右键「打开方式」。
 *
 * 背景:pip wheel 无可靠 post-install 钩子,故「安装时自动注册」实现为「首次运行幂等注册」——
 * 装完首次用 khyos 即在系统「打开方式」看到 khyos,功能等价。
 *
 * 语义:
 *   - 门控:KHY_MD_EDITOR ∧ KHY_MD_AUTO_REGISTER(均 default-on)。任一关 → 不注册。
 *   - 平台:仅 linux / win32(既有注册脚本覆盖范围;darwin 等静默跳过)。
 *   - 权威检测优先:每次先真实探测系统是否已注册(win32 `reg query` HKCU ProgID、
 *     linux 检测 `~/.local/share/applications/khyosMarkdown.desktop`)。已注册 → 写成功
 *     sentinel 并短路;未注册 → 有界重试 spawn。
 *   - 有界重试:失败**绝不**永久写「已完成」标记(这是历史 bug:上一版 spawn 后无条件
 *     markRegistered(),一次静默失败即永久跳过,用户永远看不到 khyos)。改为:成功 sentinel
 *     仅在**真实检测到已注册**时写;否则只累加 attempts,最多重试 MAX_ATTEMPTS 次,超过则
 *     放弃自动注册(用户仍可 `khy md register`),避免每次启动都 spawn。
 *   - 兼容旧 sentinel:旧版 sentinel 内容 `{registeredAt, version:'1.0.0'}` 无 `success` 字段,
 *     不被信任(避免陈旧失败标记继续压制自愈)——只有 `success===true` 的 v2 sentinel 才短路。
 *   - fire-and-forget:detached spawn 注册脚本,不阻塞启动;绝不抛(在 setup 里已 try/catch,
 *     此处再自兜底,双保险)。
 *
 * 用户仍可随时 `khy md register` / `khy md unregister` 手动增删关联。
 */

const fs = require('fs');
const path = require('path');

const SENTINEL_NAME = '.md-registered';
const SENTINEL_VERSION = '2.0.0';
// 自动注册最多重试次数(跨启动累加)。超过 → 放弃(仍留手动 `khy md register` 逃生口),
// 避免注册脚本恒失败时每次启动都 spawn。
const MAX_ATTEMPTS = 3;

/** default-on 语义:仅 {0,false,off,no} 视为关。 */
function flagOn(name, env) {
  const src = env || process.env;
  const raw = String(src[name] == null ? '' : src[name]).trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(raw);
}

/**
 * 把「md 编辑器文件关联已注册」记进安装台账,供 `khy uninstall` 逆序撤销(khy md unregister)。
 * fail-soft、绝不抛、门控 KHY_INSTALL_LEDGER 关时自动 no-op(逐字节回退)。
 */
function _recordMdRegistrationLedger(plat, env) {
  try {
    require('./uninstall/ledgerWriter').appendSideEffect({
      kind: 'registration',
      target: `md-editor:${plat}`,
      action: 'unregister-md-editor',
      meta: { platform: plat, label: 'md-editor' },
    }, { env });
  } catch { /* 记台账绝不拖累注册主流程 */ }
}

/** sentinel 绝对路径;dataHome 解析失败返 null(则本次不落标记,下次再试,不致命)。 */
function sentinelPath() {
  try {
    const home = require('../utils/dataHome').getDataHome();
    if (home) return path.join(home, SENTINEL_NAME);
  } catch (_) { /* fall through */ }
  return null;
}

/** 读 sentinel JSON;不存在/损坏 → null(视为「无可信标记」)。best-effort,绝不抛。 */
function readSentinel(target) {
  try {
    const p = target || sentinelPath();
    if (!p) return null;
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf8');
    const obj = JSON.parse(raw);
    return (obj && typeof obj === 'object') ? obj : null;
  } catch (_) { return null; }
}

/** 写 sentinel(合并给定字段);best-effort,只读文件系统/权限不足等一律忽略。 */
function writeSentinel(fields, target) {
  try {
    const p = target || sentinelPath();
    if (!p) return;
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const payload = Object.assign({ version: SENTINEL_VERSION, updatedAt: new Date().toISOString() }, fields || {});
    fs.writeFileSync(p, JSON.stringify(payload));
  } catch (_) { /* best-effort */ }
}

/** 幂等写「成功」sentinel(仅在确认已注册时调用)。保留旧导出名以兼容既有引用。 */
function markRegistered(target) {
  writeSentinel({ success: true, registeredAt: new Date().toISOString() }, target);
}

/** sentinel 是否为可信的「已成功注册」标记(仅 v2 且 success===true 才短路)。 */
function isSuccessSentinel(obj) {
  return !!(obj && obj.success === true);
}

/**
 * 权威探测系统是否已注册 khyosMarkdown 关联(只读,绝不抛;不确定 → false)。
 * @param {string} plat process.platform
 * @param {object} [deps] 注入 { spawnSync, existsSync, env } 便于单测。
 */
function isRegistered(plat, deps) {
  const d = deps || {};
  const existsSync = d.existsSync || fs.existsSync;
  const env = d.env || process.env;
  try {
    if (plat === 'win32') {
      const spawnSync = d.spawnSync || require('child_process').spawnSync;
      // reg query 命中 HKCU ProgID → status 0。缺失 → 非零。任何异常 → 保守 false。
      const r = spawnSync('reg', ['query', 'HKCU\\Software\\Classes\\KhyOS.Markdown'], {
        stdio: 'ignore', windowsHide: true, timeout: 4000,
      });
      return !!(r && r.status === 0);
    }
    if (plat === 'linux') {
      const base = String(env.XDG_DATA_HOME || '').trim()
        || path.join(require('os').homedir(), '.local', 'share');
      const desktop = path.join(base, 'applications', 'khyosMarkdown.desktop');
      return !!existsSync(desktop);
    }
  } catch (_) { /* fall through → false */ }
  return false;
}

/**
 * 若门控开、平台受支持:权威检测已注册则记成功短路;否则有界重试 fire-and-forget 注册。
 * @param {object} [env] 便于测试注入环境。
 * @param {object} [deps] 注入 { spawn, spawnSync, existsSync, platform, target, resolveToolsDir } 便于单测(默认真实实现)。
 * @returns {'skip-gate'|'skip-platform'|'skip-sentinel'|'already'|'skip-maxed'|'skip-no-tools'|'spawned'|'error'}
 */
function ensureMdRegistered(env, deps) {
  const source = env || process.env;
  const d = deps || {};
  try {
    if (!(flagOn('KHY_MD_EDITOR', source) && flagOn('KHY_MD_AUTO_REGISTER', source))) return 'skip-gate';

    const plat = d.platform || process.platform;
    if (plat !== 'linux' && plat !== 'win32') return 'skip-platform';

    const target = d.target || sentinelPath();
    // dataHome 不可用(target=null)→ 无处落标记,保守跳过(避免每次启动都 spawn/探测)。
    if (!target) return 'skip-sentinel';

    // 1. 可信成功标记存在 → 快路径短路(不做 reg query,零启动开销)。
    const prev = readSentinel(target);
    if (isSuccessSentinel(prev)) return 'skip-sentinel';

    // 2. 权威检测:系统实际已注册(含旧版失败 sentinel 后手动/上次 spawn 成功的情形)
    //    → 补写成功标记并短路,自愈陈旧标记。
    if (isRegistered(plat, { spawnSync: d.spawnSync, existsSync: d.existsSync, env: source })) {
      markRegistered(target);
      _recordMdRegistrationLedger(plat, source); // 台账留证,供 uninstall 逆序撤销(fail-soft)
      return 'already';
    }

    // 3. 未注册:检查重试预算。超过 MAX_ATTEMPTS → 放弃自动注册(留手动逃生口)。
    const attempts = Number.isFinite(prev && prev.attempts) ? prev.attempts : 0;
    if (attempts >= MAX_ATTEMPTS) return 'skip-maxed';

    // 4. 定位脚本。
    let toolsDir = null;
    try {
      toolsDir = d.resolveToolsDir
        ? d.resolveToolsDir()
        : require('../cli/handlers/md').resolveToolsDir();
    } catch (_) {}
    if (!toolsDir) return 'skip-no-tools';

    let cmd, scriptArgs, scriptFile;
    if (plat === 'win32') {
      scriptFile = 'register-windows.ps1';
      cmd = 'powershell';
      scriptArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(toolsDir, scriptFile)];
    } else {
      scriptFile = 'register-linux.sh';
      cmd = 'bash';
      scriptArgs = [path.join(toolsDir, scriptFile)];
    }
    const scriptPath = path.join(toolsDir, scriptFile);
    const existsSync = d.existsSync || fs.existsSync;
    try { if (!existsSync(scriptPath)) return 'skip-no-tools'; } catch (_) { return 'skip-no-tools'; }

    // 5. fire-and-forget spawn。**不**写成功标记——只累加 attempts。真正成功由下次启动的
    //    权威检测(步骤 2)确认后补写成功标记;失败则下次启动继续重试直到 MAX_ATTEMPTS。
    const spawn = d.spawn || require('child_process').spawn;
    const child = spawn(cmd, scriptArgs, { cwd: toolsDir, detached: true, stdio: 'ignore', windowsHide: true });
    if (child && child.unref) child.unref();

    writeSentinel({ success: false, attempts: attempts + 1, lastAttemptAt: new Date().toISOString() }, target);
    return 'spawned';
  } catch (_) {
    return 'error';
  }
}

module.exports = {
  ensureMdRegistered,
  sentinelPath,
  readSentinel,
  writeSentinel,
  markRegistered,
  isRegistered,
  isSuccessSentinel,
  SENTINEL_NAME,
  SENTINEL_VERSION,
  MAX_ATTEMPTS,
};

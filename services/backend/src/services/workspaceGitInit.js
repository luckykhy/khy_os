'use strict';

/**
 * workspaceGitInit — 把 khy 的启动工作目录视为 git 仓库（不是则一次性 git init）。
 *
 * 目标：让每个 khy 工作目录都能直接「提交 / 回滚 / 管理」。会话启动时若当前目录
 * 还不在任何 git 仓库内，就在此自动 `git init`，后续 checkpoint / rollback / commit
 * 等能力即可直接生效。
 *
 * 职责划分（重要）：本模块**执行 IO**（git 探测 / git init），因此**不是**自声明纯叶子。
 *   「哪些目录可以 init、哪些必须拒绝（HOME / 文件系统根 / 系统目录 / 已是仓库）」的
 *   安全判定全部收敛在纯叶子 `workspaceGitInitPolicy.js`；本模块只执行被它批准的初始化。
 *   设计上镜像 gitContextService 的 `_git(cmd, cwd)` fail-soft 包装。
 *
 * 不变量：fail-soft——任何 git/IO 失败都不得抛出、不得阻塞会话；最差只是「这次没初始化」。
 */

const { execSync, spawnSync } = require('child_process');
const os = require('os');
const policy = require('./workspaceGitInitPolicy');
const gitDetector = require('./gitExecutableDetector');

/**
 * 极薄 git 包装：失败返回 null（绝不抛），5s 超时，吞掉 stderr。
 * 注入点：测试可传 runner 覆盖真实 execSync。
 *
 * 增强（2026-07-08）：Windows 优先使用 Git Bash 的 git.exe，回退到系统 PATH。
 * 通过 gitExecutableDetector 解析 git 路径，支持降级链。
 *
 * 传输（2026-07-08）：与 gitContextService 一致,默认走无 shell 派生(spawnSync 直接
 * 派生 git,去掉 Windows execSync 的 cmd.exe 中介)。ensureWorkspaceRepo 在每次启动的
 * **阻塞路径**上跑 `rev-parse`,此改动把该 git 进程数在 Windows 上减半。门控
 * KHY_GIT_SHELL_FREE;含 shell 元字符或门关时逐字节回退 execSync。
 */
function _git(args, cwd, runner) {
  const run = typeof runner === 'function' ? runner : _defaultRunner;
  try {
    const out = run(`git ${args}`, cwd);
    return typeof out === 'string' ? out.trim() : '';
  } catch {
    return null;
  }
}

function _defaultRunner(cmd, cwd) {
  // 检测可用的 git 可执行文件路径（Windows 优先 Git Bash）
  const gitPath = gitDetector.detectGitExecutable();

  // 无可用 git → 返回空（_git 的 catch 会捕获并返回 null）
  if (!gitPath) {
    throw new Error('git not available');
  }

  // ── 传输方式判定（不执行）──────────────────────────────────────────────
  // 与 gitContextService._git 对齐:能安全分词时用 spawnSync 直接派生 git,去掉
  // Windows 上 execSync 的 cmd.exe 中介(cmd.exe → git 两个进程降为单个 git.exe)。
  // 这是**启动阻塞路径**——repl.js 的 ensureWorkspaceRepo 每次启动都同步跑一次
  // `rev-parse --show-toplevel`;Windows 进程创建昂贵,减半即改善冷启动。
  // 判定与执行分离:含 shell 元字符(如 config 写值 / commit 消息里的引号)→ argv=null
  // → 逐字节回退下方 execSync;绝不让「命令真失败」误触发回退而二次派生。
  // 门控 KHY_GIT_SHELL_FREE(default-on CANON);任何判定异常 → argv=null 回退。
  let argv = null;
  try {
    const plan = require('./gitSpawnPlan');
    if (plan.isShellFreeGitEnabled(process.env)) {
      argv = plan.toGitArgv(cmd.replace(/^git\s+/, ''));
    }
  } catch {
    argv = null;
  }

  if (argv) {
    // 无 shell 派生:单个 git 进程(Windows 无 cmd.exe 中介)。含空格的显式路径
    // (如 "C:\Program Files\Git\bin\git.exe")由 spawnSync 原生处理,无需手动引号。
    // 语义对齐 execSync:spawn 出错 / 非零退出 / 被信号杀 → 抛(由 _git 捕获成 null)。
    const res = spawnSync(gitPath, argv, {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (res && res.error) throw res.error;
    if (!res || res.status !== 0) {
      throw new Error(`git exited with status ${res ? res.status : 'unknown'}`);
    }
    return res.stdout == null ? '' : String(res.stdout);
  }

  // ── 逐字节回退:历史 execSync 字符串路径 ─────────────────────────────────
  // 门控关 / 含 shell 元字符 / 判定异常时走这里,与历史行为逐字节一致。
  // 显式路径需要引号包裹（Windows 路径可能含空格）。
  const actualCmd = cmd.replace(/^git\s+/, `"${gitPath}" `);

  return execSync(actualCmd, {
    cwd,
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5000,
    encoding: 'utf8',
  });
}

/**
 * cwd 是否已在某 git 仓库内（rev-parse 会向上层目录回溯）。
 * @returns {boolean|null}  null 表示探测失败（git 不可用等）。
 */
function detectIsGitRepo(cwd, runner) {
  const top = _git('rev-parse --show-toplevel', cwd, runner);
  if (top === null) return null; // git 不可用 / 探测失败
  return top.length > 0;
}

/**
 * 确保启动工作目录被视为 git 仓库：必要时 git init。
 *
 * @param {Object} [options]
 * @param {string} [options.cwd]      启动目录（默认 KHYQUANT_CWD || process.cwd()）
 * @param {Object} [options.env]      环境（默认 process.env）——读 KHY_AUTO_GIT_INIT 门控
 * @param {string} [options.home]     HOME（默认 os.homedir()）
 * @param {Function} [options.log]    通知打印 (line) => void
 * @param {Function} [options.runner] 注入 git runner (cmd, cwd) => string（测试用）
 * @returns {{status:string, reason?:string, cwd?:string}}
 *          status ∈ disabled | skip | initialized | error（永不抛）
 */
function ensureWorkspaceRepo(options = {}) {
  const env = options.env || (typeof process !== 'undefined' ? process.env : {});
  const log = typeof options.log === 'function' ? options.log : () => {};
  const runner = options.runner;
  try {
    if (!policy.isEnabled(env)) return { status: 'disabled' };

    const cwd = options.cwd || env.KHYQUANT_CWD || process.cwd();
    const home = options.home || os.homedir();

    // 前置检查：git 是否可用（Windows 优先 Git Bash，回退系统 PATH）
    if (!runner) { // 非测试注入时才检查真实 git
      const gitPath = gitDetector.detectGitExecutable();
      if (!gitPath) {
        // 无可用 git → 友好提示后返回 error
        try {
          const msg = gitDetector.buildNoGitMessage({ platform: process.platform });
          log(msg);
        } catch { /* 提示失败不影响返回 */ }
        return { status: 'error', reason: 'git-not-found', cwd };
      }
    }

    let isGitRepo;
    try { isGitRepo = detectIsGitRepo(cwd, runner); } catch { isGitRepo = null; }

    const verdict = policy.assessGitInitTarget({ cwd, home, isGitRepo });
    if (!verdict.shouldInit) {
      // 用户显式白名单覆盖(gitTrackWhitelist,此前零生产消费者):仅对「精确系统/共享根」
      // (reason==='system-dir',如 /opt、/srv、/mnt)这类**可覆盖**拒绝生效,让用户能对自己
      // 真正的项目根(挂载点/共享目录)显式声明「我确实要 git 化」。文件系统根 / 盘符根 / HOME /
      // HOME 祖先 / 已是仓库 属硬安全约束,白名单**永不**覆盖(见 gitTrackWhitelist 契约)。
      // 白名单空(默认)→ isWhitelisted 恒 false → 逐字节回退到今日行为。fail-soft:读白名单
      // 任何异常都不覆盖。惰性 require:仅在 system-dir 拒绝这一罕见分支才加载,不拖累启动阻塞路径。
      let overridden = false;
      if (verdict.reason === 'system-dir') {
        try {
          const { isWhitelisted } = require('./gitTrackWhitelist');
          overridden = isWhitelisted(cwd) === true;
        } catch { overridden = false; }
      }
      if (!overridden) return { status: 'skip', reason: verdict.reason, cwd };
    }

    const initOut = _git('init', cwd, runner);
    if (initOut === null) return { status: 'error', reason: 'git-init-failed', cwd };

    try { log(policy.noticeLine(cwd)); } catch { /* 通知失败不影响结果 */ }

    // 全自动一条龙(向导):init 之后按栈写 .gitignore + 有 git 身份时首次 commit。
    // 全 fail-soft——任何一步失败都不影响「已 init」这个结果。门控关 → 逐字节退回今日「仅 init」。
    try { _runInitWizard(cwd, runner, log, env); } catch { /* 向导失败不影响 init 成功 */ }

    return { status: 'initialized', cwd };
  } catch (e) {
    return { status: 'error', reason: (e && e.message) || 'unknown' };
  }
}

/**
 * init 成功后的「一条龙」向导:建首 .gitignore + 首次 commit(缺身份时用仓库级 fallback 身份)。
 * 判定收敛在纯叶子 workspaceGitInitWizardPolicy;本函数只执行被批准的 IO。全 fail-soft。
 *
 * 目标(2026-07-07):init 后把全部文件纳入 git 管理并落一个可用的 `main` 主线——缺 git 身份时
 * 也用**仓库级** fallback 身份提交(仅作用于此仓库,不碰全局),让用户能立即提交/建分支。
 */
function _runInitWizard(cwd, runner, log, env) {
  const wizardPolicy = require('./workspaceGitInitWizardPolicy');

  let hasGitignore = false;
  try {
    const gis = require('./gitignoreService');
    hasGitignore = gis.hasGitignore(cwd);
  } catch { /* 探测失败按无处理 */ }

  const hasGitIdentity = _hasGitIdentity(cwd, runner);
  const plan = wizardPolicy.planInitWizard({ hasGitignore, hasGitIdentity, env });
  if (!plan.enabled) return; // 门控关 → 逐字节退回「仅 init」

  // 1) 建首 .gitignore(按探测到的技术栈)。
  if (plan.writeGitignore) {
    try {
      const gis = require('./gitignoreService');
      gis.generateForProject(cwd);
    } catch { /* 建 gitignore 失败不影响后续 */ }
  }

  // 2) 首次 commit。缺身份 + fallback 门开 → 先写仓库级 fallback 身份(仅此仓库)。
  if (!plan.commit) {
    try { log(wizardPolicy.noIdentityNoticeLine()); } catch { /* 提示失败无妨 */ }
    return;
  }

  let fallbackLabel = '';
  if (plan.useFallbackIdentity) {
    const id = _resolveFallbackIdentity(env, wizardPolicy.FALLBACK_IDENTITY);
    // repo-local(不带 --global):仅作用于该自动创建的仓库,绝不污染用户全局配置。
    _git(`config user.name ${_shellQuote(id.name)}`, cwd, runner);
    _git(`config user.email ${_shellQuote(id.email)}`, cwd, runner);
    fallbackLabel = `${id.name} <${id.email}>`;
  }

  const added = _git('add -A', cwd, runner);
  if (added === null) return; // add 失败 → 放弃 commit(init 仍成功)

  const committed = _git(`commit -m "${wizardPolicy.INITIAL_COMMIT_MESSAGE}"`, cwd, runner);
  if (committed === null) return; // commit 失败(如 git 拒绝)→ fail-soft,不再改分支

  // 3) 规范主线名为 `main`(commit 之后分支才存在,-M 强制重命名当前分支;幂等)。
  if (plan.setDefaultBranch) {
    _git(`branch -M ${wizardPolicy.DEFAULT_BRANCH}`, cwd, runner);
  }

  try {
    log(plan.useFallbackIdentity
      ? wizardPolicy.fallbackCommitNoticeLine(fallbackLabel)
      : wizardPolicy.noIdentityNoticeLine()); // 有真身份时不打无身份提示;仅 fallback 分支有提示
  } catch { /* 提示失败无妨 */ }
}

/**
 * 派生仓库级 fallback git 身份。优先用 OS 用户名 + hostname(与 git 自身的自动猜测同源、更自然),
 * 消毒到 git 安全字符;任一不可用则回退到策略提供的静态兜底常量。纯派生 + fail-soft。
 * @param {object} env
 * @param {{name:string,email:string}} fallback 策略静态兜底
 * @returns {{name:string,email:string}}
 */
function _resolveFallbackIdentity(env, fallback) {
  const safe = (s) => String(s || '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64);
  const fb = fallback && fallback.name ? fallback : { name: 'Khy OS', email: 'khy@localhost' };
  try {
    let user = '';
    try { user = (os.userInfo && os.userInfo().username) || ''; } catch { user = ''; }
    if (!user && env) user = env.USER || env.USERNAME || env.LOGNAME || '';
    let host = '';
    try { host = (os.hostname && os.hostname()) || ''; } catch { host = ''; }
    const name = safe(user) || fb.name;
    const emailUser = safe(user) || 'khy';
    const emailHost = safe(host) || 'localhost';
    const email = `${emailUser}@${emailHost}`;
    return { name, email };
  } catch {
    return { name: fb.name, email: fb.email };
  }
}

/**
 * 极简 shell 单引号包裹(用于 git config 值)。单引号内除 `'` 外一切字面,`'` 用 `'\''` 转义。
 * 值已先经 _resolveFallbackIdentity 消毒到 [A-Za-z0-9._-]/`@`,此处为纵深防御。
 */
function _shellQuote(v) {
  return `'${String(v === undefined || v === null ? '' : v).replace(/'/g, `'\\''`)}'`;
}

/** 是否已配置 git 身份(user.name 且 user.email)。fail-soft → false。 */
function _hasGitIdentity(cwd, runner) {
  try {
    const name = _git('config user.name', cwd, runner);
    const email = _git('config user.email', cwd, runner);
    return !!(name && name.trim() && email && email.trim());
  } catch {
    return false;
  }
}

module.exports = {
  ensureWorkspaceRepo,
  detectIsGitRepo,
  _git,
  _hasGitIdentity,
  _runInitWizard,
  _resolveFallbackIdentity,
  _shellQuote,
};

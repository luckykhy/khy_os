'use strict';

/**
 * workspaceGitInitWizardPolicy.js — 纯叶子:仓库初始化「向导」(init 之后要不要建首
 * .gitignore、要不要首次 commit)的确定性判定单一真源。
 *
 * 背景(真缺口):既有 `workspaceGitInit.js` 在合适目录只执行 `git init`,**不建 .gitignore、
 * 不做首次 commit**。用户定案「全自动一条龙」:init 后按栈写 .gitignore、并在有 git 身份时
 * 落一个 "chore: initial commit"。但「一条龙」里每一步是否该做,应是可单测的确定性规则,
 * 而不是散落在 IO 层的 if。本叶子把这套判定收成单一真源;真正的 IO(写文件 / add / commit)
 * 由薄壳 workspaceGitInit.js 执行本叶子批准的动作。
 *
 * 契约(CONTRACT):零 IO、确定性、绝不抛(fail-soft)、env 门控 `KHY_GIT_INIT_WIZARD` 默认开。
 *   门控关 → planInitWizard 返回 {enabled:false, writeGitignore:false, commit:false},
 *   让薄壳字节回退到今日「仅 git init」行为。
 *
 * 目标演进(goal 2026-07-07「安装后 khy 应把每个文件与文件夹都纳入 git 管理,可以提交、
 *   创建分支、主线等」):旧版在缺 git 身份时**跳过 commit**——但这样文件永不被跟踪、无 HEAD、
 *   无分支,用户既不能提交也不能建分支,与目标相悖。新策略:init 后**总是**把全部文件 add 并落
 *   一个首次 commit,从而得到一个可用的 `main` 主线;缺 git 身份时用**仓库级 fallback 身份**
 *   (仅作用于该自动创建的仓库,绝不碰用户全局配置),让首次 commit 与用户后续 commit 都能成功。
 *   该「无身份也提交」行为由子门控 `KHY_GIT_INIT_FALLBACK_IDENTITY`(默认开)控制;关 → 逐字节
 *   回退旧的「缺身份跳过 commit」行为。
 */

const _OFF = new Set(['0', 'false', 'off', 'no']);

/** 门控:KHY_GIT_INIT_WIZARD 默认开,仅 {0,false,off,no} 关。 */
function isEnabled(env = (typeof process !== 'undefined' ? process.env : {})) {
  try {
    const raw = env && env.KHY_GIT_INIT_WIZARD;
    const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
    return !_OFF.has(v);
  } catch {
    return true;
  }
}

/**
 * 子门控:KHY_GIT_INIT_FALLBACK_IDENTITY 默认开,仅 {0,false,off,no} 关。
 * 开 → 缺 git 身份时也用仓库级 fallback 身份落首次 commit(让工作区立刻有可用 main 主线)。
 * 关 → 逐字节回退旧行为(缺身份跳过 commit,仅建 .gitignore)。
 * 注:父→子优先级(KHY_AUTO_GIT_INIT / KHY_GIT_INIT_WIZARD 关则本门无意义)由调用结构强制
 *   ——ensureWorkspaceRepo 顶层门关直接 disabled、planInitWizard 在 wizard 门关时早退,
 *   故本 in-file 门只需读自身 flag。
 */
function isFallbackIdentityEnabled(env = (typeof process !== 'undefined' ? process.env : {})) {
  try {
    const raw = env && env.KHY_GIT_INIT_FALLBACK_IDENTITY;
    const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
    return !_OFF.has(v);
  } catch {
    return true;
  }
}

/**
 * 规划 init 向导的后续步骤。
 *
 * @param {object} ctx
 * @param {boolean} [ctx.hasGitignore]  工作区根是否已有 .gitignore(有则不覆盖)。
 * @param {boolean} [ctx.hasGitIdentity] 是否已配置 git user.name/email。
 * @param {object}  [ctx.env]
 * @returns {{enabled:boolean, writeGitignore:boolean, commit:boolean,
 *            useFallbackIdentity:boolean, setDefaultBranch:boolean, reason:string}}
 *          fail-soft:任何异常 → 全 false。
 *          - commit:是否落首次 commit(有身份、或 fallback 门开时的无身份均为 true)。
 *          - useFallbackIdentity:commit 前是否需先写仓库级 fallback 身份(仅无身份 + 门开)。
 *          - setDefaultBranch:commit 后是否把主线规范为 DEFAULT_BRANCH(`main`)。
 */
function planInitWizard(ctx = {}) {
  try {
    const env = (ctx && ctx.env) || (typeof process !== 'undefined' ? process.env : {});
    if (!isEnabled(env)) {
      return {
        enabled: false, writeGitignore: false, commit: false,
        useFallbackIdentity: false, setDefaultBranch: false, reason: 'wizard-disabled',
      };
    }
    const hasGitignore = !!(ctx && ctx.hasGitignore === true);
    const hasIdentity = !!(ctx && ctx.hasGitIdentity === true);
    const fallbackEnabled = isFallbackIdentityEnabled(env);

    const writeGitignore = !hasGitignore;
    // 有身份 → 直接 commit;无身份 → 仅在 fallback 门开时用仓库级身份 commit,否则跳过(旧行为)。
    const commit = hasIdentity || fallbackEnabled;
    const useFallbackIdentity = !hasIdentity && fallbackEnabled;
    const setDefaultBranch = commit; // 只有真落了 commit,规范主线名才有意义。

    let reason;
    if (!commit) reason = 'no-git-identity-skip-commit';        // fallback 门关 + 无身份
    else if (useFallbackIdentity) reason = 'fallback-identity-commit';
    else if (!writeGitignore) reason = 'gitignore-exists';
    else reason = 'full-wizard';

    return { enabled: true, writeGitignore, commit, useFallbackIdentity, setDefaultBranch, reason };
  } catch {
    return {
      enabled: false, writeGitignore: false, commit: false,
      useFallbackIdentity: false, setDefaultBranch: false, reason: 'error',
    };
  }
}

/** 首次提交信息(单一真源,便于测试/复用)。 */
const INITIAL_COMMIT_MESSAGE = 'chore: initial commit';

/** 规范主线分支名(git init 后 commit 完成再 `branch -M`,给用户可预期的「主线」)。 */
const DEFAULT_BRANCH = 'main';

/**
 * 无 git 身份时的仓库级 fallback 身份(静态兜底)。引擎优先用 OS 用户名/hostname 派生更自然的
 * 身份,仅在派生失败时回退到这里。**仅写入该自动创建仓库的 repo-local config**,绝不碰全局配置。
 */
const FALLBACK_IDENTITY = Object.freeze({ name: 'Khy OS', email: 'khy@localhost' });

/** 缺 git 身份且 fallback 门**关**时的友好提示行(IO 层跳过 commit 后打印)。 */
function noIdentityNoticeLine(opts = {}) {
  const color = typeof opts.color === 'function' ? opts.color : (t) => t;
  return color(
    '📝 已建 .gitignore,但未配置 git 身份(user.name/email),已跳过首次提交。'
    + '配置后可用 `khy repo save "首次提交"` 保存首个版本。',
    'init',
  );
}

/**
 * 用 fallback 身份完成首次 commit 后的提示行(IO 层打印)。
 * @param {string} [identityLabel] 实际写入的 fallback 身份标签(如 `alice <alice@host>`)。
 */
function fallbackCommitNoticeLine(identityLabel, opts = {}) {
  const color = typeof opts.color === 'function' ? opts.color : (t) => t;
  const who = identityLabel ? `(${identityLabel})` : '';
  return color(
    `📦 已把当前目录全部文件纳入 git 管理并创建首个提交,主线 \`${DEFAULT_BRANCH}\` 就绪,可直接提交/建分支。`
    + `未检测到 git 身份,已为本仓库配置本地身份 ${who}(仅作用于此目录,不影响全局)。`,
    'init',
  );
}

module.exports = {
  isEnabled,
  isFallbackIdentityEnabled,
  planInitWizard,
  INITIAL_COMMIT_MESSAGE,
  DEFAULT_BRANCH,
  FALLBACK_IDENTITY,
  noIdentityNoticeLine,
  fallbackCommitNoticeLine,
};

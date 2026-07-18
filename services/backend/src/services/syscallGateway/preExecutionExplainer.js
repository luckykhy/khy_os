'use strict';

/**
 * preExecutionExplainer.js — 面向小白的「执行前说明」单一真源。
 *
 * 在一次工具调用真正执行前，按它的「难易」与「重要程度」生成深浅不同的中文说明：
 *   · 越简单 / 越只读 → 越简短（一句话，甚至 L0 只给一行）；
 *   · 越重要 / 越破坏 → 越详尽（讲清「做什么 / 为什么是红线 / 可能后果 / 怎么撤销 /
 *     当前工作区状态」），让没有经验的用户也能在按下确认前明白自己在批准什么。
 *
 * 「必须基于 khyos 获取的数据」：说明依据全部来自系统已采集的真实信号——
 *   · 分级裁决与红线语义        → redLine.describe（委托 resourceClassifier）
 *   · 动态风险 / 只读 / 破坏性    → 已写入 intent 的字段（riskGate 的产物）
 *   · 工作区状态                → workspaceContext.collectWorkspaceContext
 *   · 命令 / 资源文本            → intent.resource / intent.raw
 * 工作区数据缺失时**主动获取**（gather-if-missing），绝不凭空编造。
 *
 * 纯函数 + 依赖注入，fail-soft：任何子项失败都降级为安全简述，绝不抛——执行前
 * 说明永远拿得到一个可渲染的对象。
 */

const { ACTIONS } = require('./intentSchema');
const redLine = require('./redLine');

// 动作 → 小白能懂的「这一步会做什么」。
const ACTION_WHAT = Object.freeze({
  [ACTIONS.READ]: '读取信息（不会改变任何东西）',
  [ACTIONS.WRITE]: '写入或修改文件',
  [ACTIONS.DELETE]: '删除或覆盖数据',
  [ACTIONS.NETWORK]: '访问网络',
  [ACTIONS.PROCESS]: '运行一个程序 / 进程',
  [ACTIONS.KILL]: '终止一个正在运行的进程',
  [ACTIONS.ENV]: '修改系统环境变量',
  [ACTIONS.INSTALL]: '在系统上安装软件包',
  [ACTIONS.LISTEN]: '对外开放一个网络端口',
  [ACTIONS.EXEC_CODE]: '执行任意代码',
  [ACTIONS.SANDBOX_ESCAPE]: '以完全权限运行（跳出沙箱）',
  [ACTIONS.UNKNOWN]: '一个系统无法自动识别的操作',
});

// 动作 → 「可能的后果」（主要用于 L2，讲清风险）。
const ACTION_RISKS = Object.freeze({
  [ACTIONS.DELETE]: ['被删除或覆盖的数据可能无法找回'],
  [ACTIONS.INSTALL]: ['全局安装会改动系统，可能影响其他项目'],
  [ACTIONS.ENV]: ['修改环境变量会影响之后运行的所有命令'],
  [ACTIONS.KILL]: ['终止进程可能导致它正在进行的工作丢失'],
  [ACTIONS.EXEC_CODE]: ['将以较高权限运行任意代码，可能影响整个系统'],
  [ACTIONS.SANDBOX_ESCAPE]: ['将跳出隔离环境以完全权限运行，风险最高'],
  [ACTIONS.LISTEN]: ['对外开放端口可能让外部访问到你的机器'],
});

// 动作 → 「如果结果不对怎么撤销」。null 表示无通用撤销建议。
const ACTION_UNDO = Object.freeze({
  [ACTIONS.WRITE]: '若结果不对，可用 `khy repo` 查看改动，并回退到上一个版本快照',
  [ACTIONS.DELETE]: '删除通常不可逆；若文件曾被 git 跟踪，可尝试 `git restore <文件>`',
  [ACTIONS.INSTALL]: '如不需要，可手动卸载对应软件包',
  [ACTIONS.ENV]: '需手动把环境变量改回原值',
});

// 面向小白的 git 危险操作专项说明（force-push / reset --hard / clean -fd）。
// 抽象动作矩阵看不出「push 是普通推送还是强制覆盖」，故在此按命令文本补足
// 「做什么 / 后果 / 怎么撤销」——这是这三类高破坏 git 操作的人类语义单一真源，
// preExecutionExplainer 在 detailed 深度时叠加，全链自动生效。
// 每条 test(resource+raw 拼接的命令文本) 命中即注入；顺序即优先级。
const GIT_HAZARD_HINTS = Object.freeze([
  {
    key: 'force-push',
    // 匹配 `git push ... --force` / `-f` / `--force-with-lease`。
    test: (s) => /\bgit\b[^\n]*\bpush\b/.test(s) && /(--force-with-lease|--force|(^|\s)-[a-zA-Z]*f)/.test(s),
    what: '强制推送——用本地历史覆盖远程分支',
    risks: [
      '会覆盖远程分支：别人（或你自己在别处）已推送的提交可能被抹掉且难以找回',
      '若他人正基于旧历史工作，强推会打乱协作、造成对方本地与远程分叉',
    ],
    undo: '若刚强推：远程端可用 `git reflog` 找回被覆盖的旧提交哈希再 `git push` 回去；本地可 `git reflog` + `git reset` 回到强推前状态',
  },
  {
    key: 'reset-hard',
    test: (s) => /\bgit\b[^\n]*\breset\b[^\n]*--hard/.test(s),
    what: '硬重置——丢弃工作区与暂存区的所有未提交改动',
    risks: [
      '所有未提交（未 commit）的改动会被直接丢弃，且不进回收站、通常无法找回',
      '若同时移动了分支指针，被跳过的提交也会从当前分支消失',
    ],
    undo: '被丢弃的**提交**通常还能用 `git reflog` 找到并 `git reset` 回去；但从未 commit 过的改动无法恢复——重置前建议先 `khy repo save "说明"` 存一个快照',
  },
  {
    key: 'clean-fd',
    // 匹配 `git clean` 带 -f 且带 -d（任意顺序/合并形式，如 -fd / -df / -f -d）。
    test: (s) => /\bgit\b[^\n]*\bclean\b/.test(s)
      && /(^|\s)-[a-zA-Z]*f/.test(s) && /(^|\s)-[a-zA-Z]*d/.test(s),
    what: '清理——永久删除工作区里所有未被 git 跟踪的文件和目录',
    risks: [
      '未被 git 跟踪的新文件/目录会被**直接删除**，不进回收站，几乎无法找回',
      '常误删：本地配置、临时产物、尚未 `git add` 的新代码',
    ],
    undo: '此操作不可逆——被删的未跟踪文件无法用 git 恢复。执行前建议先 `git clean -nd` 预览将删除什么，或先把要保留的文件 `git add`',
  },
]);

/**
 * 从 intent 里挑出命中的 git 危险操作说明。命令文本取 intent.resource 与 intent.raw
 * 的拼接（大小写不敏感）。纯函数、fail-soft：无命中 / 异常 → null。
 * @param {object} intent
 * @returns {{key:string, what:string, risks:string[], undo:string}|null}
 */
function _gitHazardHint(intent) {
  try {
    const parts = [];
    if (intent && typeof intent.resource === 'string') parts.push(intent.resource);
    if (intent && typeof intent.raw === 'string') parts.push(intent.raw);
    const s = parts.join(' ').toLowerCase();
    if (!s.trim()) return null;
    for (const h of GIT_HAZARD_HINTS) {
      if (h.test(s)) return h;
    }
    return null;
  } catch {
    return null;
  }
}


/**
 * 由 intent 推导「难易」(difficulty) 与「重要程度」(importance)。
 * importance 直接对应分级（影响越大越重要）；difficulty 反映「这步好不好懂、好不好撤销」。
 * @returns {{ importance:'low'|'medium'|'high', difficulty:'easy'|'moderate'|'hard' }}
 */
function _gradeFromIntent(intent, level) {
  const importance = level === redLine.LEVELS.L2 ? 'high'
    : level === redLine.LEVELS.L1 ? 'medium' : 'low';

  const action = intent && intent.action;
  const hardActions = [ACTIONS.DELETE, ACTIONS.KILL, ACTIONS.INSTALL, ACTIONS.ENV,
    ACTIONS.EXEC_CODE, ACTIONS.SANDBOX_ESCAPE, ACTIONS.LISTEN];
  let difficulty;
  if (intent && (intent.isReadOnly === true || action === ACTIONS.READ)) difficulty = 'easy';
  else if ((intent && intent.isDestructive === true) || hardActions.includes(action)) difficulty = 'hard';
  else difficulty = 'moderate';

  return { importance, difficulty };
}

/** 说明详尽程度：取「重要程度」与「难易」中更高者。 */
function _depthOf(importance, difficulty) {
  if (importance === 'high' || difficulty === 'hard') return 'detailed';
  if (importance === 'medium' || difficulty === 'moderate') return 'standard';
  return 'brief';
}

/** 该不该附上工作区状态：写入 / 删除 / 进程 / 网络等会改变东西的操作，或 L1 以上。 */
function _wantsWorkspace(intent, level) {
  if (level !== redLine.LEVELS.L0) return true;
  const a = intent && intent.action;
  return a === ACTIONS.WRITE || a === ACTIONS.DELETE || a === ACTIONS.PROCESS || a === ACTIONS.NETWORK;
}

/**
 * 生成执行前说明。
 *
 * @param {object} intent  buildIntent() 产出的规约意图
 * @param {object} [opts]
 * @param {string} [opts.cwd]                工作目录（采集工作区用）
 * @param {object} [opts.workspace]          已采集的工作区上下文（缺省则主动获取）
 * @param {Function} [opts.describe]         注入 redLine.describe（测试用）
 * @param {Function} [opts.collectWorkspace] 注入 workspaceContext.collectWorkspaceContext（测试用）
 * @returns {{
 *   level:string, importance:string, difficulty:string, depth:string,
 *   headline:string, whatHappens:string, reasons:string[], risks:string[],
 *   howToUndo:(string|null), workspace:(string|null), text:string
 * }}
 */
function explain(intent, opts = {}) {
  const describe = opts.describe || redLine.describe;

  let d;
  try {
    d = describe(intent);
  } catch {
    d = { isRedLine: true, level: redLine.LEVELS.L2, summary: '高危操作（分级异常，保守提示）', reasons: [] };
  }
  const level = d.level || redLine.LEVELS.L2;
  const { importance, difficulty } = _gradeFromIntent(intent, level);
  const depth = _depthOf(importance, difficulty);

  const action = (intent && intent.action) || ACTIONS.UNKNOWN;
  const gitHazard = _gitHazardHint(intent);
  const whatHappens = gitHazard ? gitHazard.what : (ACTION_WHAT[action] || ACTION_WHAT[ACTIONS.UNKNOWN]);

  // Headline：一眼看清「将要做什么、危不危险」。
  let headline;
  if (level === redLine.LEVELS.L2) headline = `⚠ 高风险操作：${whatHappens}`;
  else if (level === redLine.LEVELS.L1) headline = `即将：${whatHappens}（影响有限，确认一次即可）`;
  else headline = `即将：${whatHappens}`;

  const reasons = Array.isArray(d.reasons) ? d.reasons.slice() : [];

  // Risks / undo 只在重要或难撤销时给，避免 L0 噪音。
  let risks = [];
  let howToUndo = null;
  if (depth === 'detailed') {
    risks = (ACTION_RISKS[action] || []).slice();
    if (gitHazard) {
      // git 危险操作：用专项后果/撤销覆盖泛化文案，讲清这条命令的真实破坏面。
      for (const r of gitHazard.risks) if (!risks.includes(r)) risks.push(r);
    }
    if (intent && intent.isDestructive === true && action !== ACTIONS.DELETE) {
      risks.push('这是破坏性操作，可能修改或销毁既有状态');
    }
    if (!risks.length) risks.push('这是被判定为高风险的操作，请确认你了解其后果');
    howToUndo = gitHazard ? gitHazard.undo : (ACTION_UNDO[action] || '此操作可能不可逆，请在确认前再次核对');
  } else if (depth === 'standard') {
    howToUndo = gitHazard ? gitHazard.undo : (ACTION_UNDO[action] || null);
  }

  // 工作区状态：必须基于已采集数据；缺则主动获取（gather-if-missing），全程 fail-soft。
  let workspace = null;
  if (_wantsWorkspace(intent, level)) {
    try {
      let ws = opts.workspace;
      if (!ws) {
        const wc = opts.collectWorkspace
          || require('../workspace/workspaceContext').collectWorkspaceContext;
        ws = wc(opts.cwd);
      }
      if (ws) {
        const { formatSummary } = require('../workspace/workspaceContext');
        workspace = formatSummary(ws);
      }
    } catch {
      workspace = null; // 采集失败不阻断说明
    }
  }

  const text = renderText({ level, importance, difficulty, depth, headline, whatHappens, reasons, risks, howToUndo, workspace });
  return { level, importance, difficulty, depth, headline, whatHappens, reasons, risks, howToUndo, workspace, text };
}

/**
 * 把结构化说明渲染成一段小白中文文本，深浅由 depth 决定。
 * @param {object} e
 * @returns {string}
 */
function renderText(e) {
  // brief：只给一行（L0 只读 / 低风险）。
  if (e.depth === 'brief') return e.headline;

  const lines = [e.headline];

  // standard：补一句「在哪做、可不可逆」。
  if (e.depth === 'standard') {
    if (e.workspace) lines.push('', '当前工作区：', e.workspace);
    if (e.howToUndo) lines.push('', `撤销方式：${e.howToUndo}`);
    return lines.join('\n');
  }

  // detailed（L2 / 难撤销）：讲全。
  if (e.reasons && e.reasons.length) {
    lines.push('', '为什么需要你确认：');
    for (const r of e.reasons) lines.push(`  · ${r}`);
  }
  if (e.risks && e.risks.length) {
    lines.push('', '可能的后果：');
    for (const r of e.risks) lines.push(`  · ${r}`);
  }
  if (e.howToUndo) lines.push('', `撤销方式：${e.howToUndo}`);
  if (e.workspace) lines.push('', '当前工作区：', e.workspace);
  return lines.join('\n');
}

module.exports = {
  explain,
  renderText,
  // test seams
  _gradeFromIntent,
  _depthOf,
  _gitHazardHint,
  ACTION_WHAT,
  GIT_HAZARD_HINTS,
};

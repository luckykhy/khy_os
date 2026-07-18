'use strict';

/**
 * autofixPrPlan.js — `/autofix-pr`(读取 CI 状态 → 本地审计修复)的零 IO 确定性单一真源(纯叶子)。
 *
 * 契约 (CONTRACT): 零 IO、确定性、绝不抛、无副作用;CI 结果、模型可用性、改动文件、env 全经入参注入,
 * 本叶子绝不读 process.env、绝不触文件、绝不调 gh/网络、绝不调 Date、绝不持有状态。真正的「读 CI 状态
 * (gh/glab)+ 派发审计/修复智能体」都在薄壳 handlers/autofixPr.js,委托既有 SSOT(ciStatusService.checkCIStatus
 * 读状态 + auditFixLoop.runAuditFixCycle 修复 + AgentTool 派发),绝不另起炉灶。本叶子只做:语法解析 +
 * 由「CI 分类 + 模型是否可用」推导该不该修 + 文本渲染。
 *
 * 背后的逻辑(对齐 Claude Code /autofix-pr —— 但**诚实落到 khy 的本地语义**):CC 的 /autofix-pr 是
 * `teleportToRemote`:把任务发到**云端远程 agent**(CCR · Claude.ai OAuth · 绑 github.com),让它 checkout
 * 某个 PR 分支、修好失败的 CI、push 回去,本地只**监控**。khy **没有云端远程 agent 这一层 —— 绝不伪造一个云会话/
 * teleport**;但 khy **真有**同构的本地基质:① `ciStatusService.checkCIStatus` 能读**当前分支**的 CI 结果
 * (gh→glab),② `auditFixLoop.runAuditFixCycle` 是一套「审计→修复→重审」的有界闭环(已在 toolUseLoop 完成时
 * 自动跑),复用单例 AgentTool 派发同一套权限/深度受控的子智能体。把两者一合,khy 的 /autofix-pr =
 * **读当前分支 CI,若失败则在本地工作树跑审计修复闭环,再如实汇报**。这正是「学习 CC 的逻辑(自动修好 CI),
 * 而非表面 teleport」。绝不引入任何 host/port 硬编码 —— CI 平台/仓库全由 gh/glab 自行解析,修复全由既有闭环驱动。
 *
 * 诚实边界(刻意不编造 khy 没有的语义):① khy 是**同步本地修复**当前分支工作树,**不是**云端 checkout 任意 PR 分支
 * 再 push —— 故 PR 号仅作为「目标分支」线索透传给 CI 查询,绝不假装能远程操作他人 PR;② **无模型(Tier A)时**
 * 如实报告「CI 失败,但当前无可用模型派发修复智能体」,**绝不**假装修了;③ CI 通过/进行中/无 CI 平台时不修,如实说明;
 * ④ `stop`:khy 的 autofix 是同步前台流程,**没有后台会话可停**,如实说明(对齐 CC 有云会话故有 stop,khy 没有故诚实);
 * ⑤ 修复仍受既有 audit-fix 闭环的边界(只修 CRITICAL/HIGH、有界轮数、自修复事务回滚)约束,绝不在此叶子伪造修复。
 *
 * 注意:本文件刻意不在注释里书写 require-调用样式,避免架构债扫描器把它当成幽灵依赖边。本叶子零依赖。
 */

const _RUN_WORDS = new Set(['run', 'fix', 'go', 'start', '修', '修复', '执行', '开始']);
const _STATUS_WORDS = new Set(['status', 'state', 'check', '状态', '查看', '检查']);
const _STOP_WORDS = new Set(['stop', 'off', 'cancel', '停', '停止', '取消']);
const _HELP_WORDS = new Set(['help', '-h', '--help', '帮助', '用法']);

/**
 * 解析 `/autofix-pr [run|status|stop|help] [<pr-or-branch>]`。空参 = run(对齐 CC 默认就是发起修复)。
 * 第一个非动作 token 视为目标(PR 号/分支线索)。
 * @param {string[]} args
 * @returns {{action:'run'|'status'|'stop'|'help', target:(string|null), valid:boolean, parseError:(string|null)}}
 */
function parseAutofixArgs(args) {
  const list = (Array.isArray(args) ? args : []).map((a) => String(a == null ? '' : a).trim()).filter((a) => a !== '');
  if (list.length === 0) return { action: 'run', target: null, valid: true, parseError: null };

  const first = list[0].toLowerCase();
  let action = null;
  let rest = list;
  if (_HELP_WORDS.has(first)) return { action: 'help', target: null, valid: true, parseError: null };
  if (_RUN_WORDS.has(first)) { action = 'run'; rest = list.slice(1); }
  else if (_STATUS_WORDS.has(first)) { action = 'status'; rest = list.slice(1); }
  else if (_STOP_WORDS.has(first)) { action = 'stop'; rest = list.slice(1); }

  if (action === null) {
    // 第一个 token 不是动作词 —— 当作目标(PR 号/分支),动作默认 run。
    const target = _normalizeTarget(list[0]);
    return { action: 'run', target, valid: true, parseError: null };
  }
  const target = rest.length > 0 ? _normalizeTarget(rest[0]) : null;
  return { action, target, valid: true, parseError: null };
}

function _normalizeTarget(raw) {
  const t = String(raw == null ? '' : raw).trim();
  if (t === '') return null;
  // 去掉前缀 # / PR 字样,仅作线索透传,绝不在此解析仓库。
  return t.replace(/^#/, '').trim() || null;
}

/**
 * 由「CI 结果 + 模型是否可用」推导该不该在本地跑修复闭环。纯函数。
 * @param {object} input
 * @param {object} input.ciResult - ciStatusService.checkCIStatus 的输出({error} 或 {classification,...})
 * @param {boolean} input.modelAvailable
 * @returns {{ proceed:boolean, kind:'fix'|'already_pass'|'pending'|'unknown'|'no_ci'|'no_model', ciClass:(string|null), reason:string }}
 */
function decideFixPlan(input) {
  const src = input && typeof input === 'object' ? input : {};
  const ci = src.ciResult && typeof src.ciResult === 'object' ? src.ciResult : {};
  const modelAvailable = src.modelAvailable === true;

  if (ci.error || (!ci.classification && !ci.status)) {
    return { proceed: false, kind: 'no_ci', ciClass: null,
      reason: ci.error ? String(ci.error) : '未检测到 CI 平台(需 gh 或 glab CLI 已安装并登录)。' };
  }
  const cls = String(ci.classification || '').toLowerCase();

  if (cls === 'pass') {
    return { proceed: false, kind: 'already_pass', ciClass: cls, reason: '当前分支 CI 已通过,无需修复。' };
  }
  if (cls === 'pending') {
    return { proceed: false, kind: 'pending', ciClass: cls, reason: 'CI 仍在进行中,待其得出结论后再修复(可用 /ci watch 等待)。' };
  }
  if (cls === 'fail') {
    if (!modelAvailable) {
      return { proceed: false, kind: 'no_model', ciClass: cls,
        reason: 'CI 失败,但当前无可用模型派发修复智能体(Tier A);请先用 /model 配置可用通道后重试。' };
    }
    return { proceed: true, kind: 'fix', ciClass: cls,
      reason: 'CI 失败 —— 将在本地工作树运行「审计→修复→重审」闭环修复严重/高优先级问题。' };
  }
  return { proceed: false, kind: 'unknown', ciClass: cls || 'unknown',
    reason: 'CI 结论未知,保守起见不自动修复(可用 /ci status 查看详情)。' };
}

/** 渲染 CI 状态文本(action=status,或 run 的前置披露)。 */
function buildCiStatusText(ciResult, target) {
  const ci = ciResult && typeof ciResult === 'object' ? ciResult : {};
  const lines = [];
  lines.push('🔧 autofix-pr · CI 状态');
  if (target) lines.push(`  目标线索: ${target}(本地修复当前分支工作树;khy 不远程操作他人 PR)`);
  if (ci.error || (!ci.classification && !ci.status)) {
    lines.push(`  CI: 不可用 —— ${ci.error ? String(ci.error) : '未检测到 CI 平台'}`);
    return lines.join('\n');
  }
  lines.push(`  平台: ${ci.platform || '未知'}`);
  lines.push(`  结论: ${_classLabel(ci.classification)}${ci.conclusion ? `(${ci.conclusion})` : ''}`);
  if (ci.name) lines.push(`  工作流: ${ci.name}`);
  if (ci.url) lines.push(`  链接: ${ci.url}`);
  return lines.join('\n');
}

/** 渲染「将要做什么 / 为何不修」的决策文本。 */
function buildPlanText(decision) {
  const d = decision && typeof decision === 'object' ? decision : {};
  const lines = [];
  if (d.proceed) {
    lines.push('▶ 开始本地审计修复闭环(只修 CRITICAL/HIGH · 有界轮数 · 自修复事务回滚保护)…');
    lines.push(`  原因: ${d.reason}`);
  } else {
    lines.push(`ℹ 不执行修复:${d.reason}`);
  }
  return lines.join('\n');
}

/**
 * 渲染审计修复闭环的结果文本(委托既有 auditFixLoop.buildAnnotation 的同款语义,但此处给独立 fallback)。
 * @param {object} afResult - auditFixLoop.runAuditFixCycle 的输出
 */
function buildOutcomeText(afResult) {
  const r = afResult && typeof afResult === 'object' ? afResult : {};
  const outcome = String(r.outcome || '');
  const lines = [];
  lines.push('🔧 autofix-pr · 本地修复结果');
  if (outcome === 'clean') {
    lines.push('  审计未发现需修复的严重/高优先级问题(CI 失败可能由环境/外部因素导致,请查看 CI 日志)。');
  } else if (outcome === 'fixed') {
    const fixed = _countFixed(r);
    lines.push(`  ✓ 已自动修复${fixed > 0 ? ` ${fixed} 项` : ''}严重/高优先级问题并通过重审。请重新触发 CI 验证。`);
  } else if (outcome === 'exhausted') {
    const remaining = _intNonNeg(r.totalActionableRemaining);
    lines.push(`  ⚠ 经自动审计与修复后,仍有 ${remaining} 个严重/高优先级问题需人工关注(已达有界轮数上限)。`);
  } else if (outcome === 'error') {
    lines.push(`  ✗ 修复闭环出错:${r.error ? String(r.error) : '未知错误'}(未对工作树造成保留性改动)。`);
  } else {
    lines.push('  修复闭环未返回有效结果。');
  }
  const fixedFiles = Array.isArray(r.filesFixed) ? r.filesFixed : [];
  if (fixedFiles.length > 0) {
    lines.push(`  改动文件: ${fixedFiles.slice(0, 10).join(', ')}${fixedFiles.length > 10 ? ` …(+${fixedFiles.length - 10})` : ''}`);
  }
  return lines.join('\n');
}

/** `stop` 的诚实说明:khy 无后台云会话可停。 */
function buildStopText() {
  return [
    'ℹ khy 的 autofix-pr 是**同步前台**的本地修复流程,没有后台云会话可停止',
    '  (与 Claude Code 不同 —— CC 的 stop 是释放云端远程会话的本地监控锁;khy 不存在该会话)。',
    '  若想中断正在进行的修复,请直接 Ctrl-C。',
  ].join('\n');
}

function buildHelpText() {
  return [
    '/autofix-pr —— 读取 CI 状态并在本地修复失败的 CI(对齐 Claude Code /autofix-pr 的「自动修好 CI」逻辑)',
    '  用法:',
    '    /autofix-pr              读当前分支 CI;若失败则在本地工作树跑审计修复闭环(默认)',
    '    /autofix-pr status       仅查看当前分支 CI 状态',
    '    /autofix-pr <pr|branch>  目标线索(仅用于 CI 查询;khy 修复的始终是当前分支工作树)',
    '    /autofix-pr stop         说明:khy 是同步前台流程,无后台会话可停',
    '  说明:',
    '    · 与 CC 的云端 teleport 远程 agent 不同:khy 不远程 checkout/push 他人 PR,而是复用本地',
    '      ciStatusService(读 CI)+ auditFixLoop(审计→修复→重审有界闭环)在**当前工作树**诚实修复。',
    '    · 无可用模型(Tier A)时只报告 CI 状态,绝不假装修复。',
  ].join('\n');
}

function buildUnknownText() {
  return `未知子命令。${buildHelpText()}`;
}

/**
 * 门控 KHY_AUTOFIX_PR(默认开;关时薄壳字节回退为「不接管」)。
 * @param {object} env
 * @returns {boolean}
 */
function isEnabled(env) {
  const e = env || {};
  const raw = e.KHY_AUTOFIX_PR === undefined ? 'true' : e.KHY_AUTOFIX_PR;
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  return !(s === '' || s === '0' || s === 'false' || s === 'off' || s === 'no');
}

// ── 内部纯助手 ───────────────────────────────────────────────────────────────
function _classLabel(cls) {
  switch (String(cls || '').toLowerCase()) {
    case 'pass': return '通过 ✓';
    case 'fail': return '失败 ✗';
    case 'pending': return '进行中 …';
    default: return '未知';
  }
}
function _countFixed(r) {
  const rounds = Array.isArray(r && r.rounds) ? r.rounds : [];
  return rounds
    .filter((x) => x && x.fixed && x.fixReport)
    .reduce((n, x) => n + (_intNonNeg(x.fixReport.fixed)), 0);
}
function _intNonNeg(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

module.exports = {
  parseAutofixArgs,
  decideFixPlan,
  buildCiStatusText,
  buildPlanText,
  buildOutcomeText,
  buildStopText,
  buildHelpText,
  buildUnknownText,
  isEnabled,
};

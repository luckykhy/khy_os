'use strict';

/**
 * autofixPr.js — `/autofix-pr` 命令薄壳:读当前分支 CI 状态,若失败则在本地工作树运行审计修复闭环。
 * 对齐 Claude Code 的 /autofix-pr(自动修好失败的 CI),但**诚实落到 khy 的本地语义**:不伪造云端 teleport
 * 远程 agent,而是复用 ciStatusService(读 CI)+ auditFixLoop(审计→修复→重审有界闭环)。
 *
 * **背后逻辑**(语法解析 + 由 CI 分类/模型可用性推导该不该修 + 文本渲染)在纯叶子 services/autofixPr/autofixPrPlan.js
 * (单一真源·零 IO);本薄壳只做:门控、读 CI(委托 ciStatusService.checkCIStatus)、判模型可用、派发智能体
 * (复用单例 AgentTool,与 toolUseLoop 完成时审计同一套权限/深度受控路径)、跑 auditFixLoop.runAuditFixCycle、渲染。
 * 绝不另起炉灶,绝不写 host/port 硬编码 —— CI 平台/仓库由 gh/glab 自解析,修复由既有闭环驱动。
 *
 * 诚实边界:khy 同步本地修复**当前分支工作树**,不远程 checkout/push 他人 PR;无模型(Tier A)如实报告不修;
 * stop 说明无后台会话可停。修复受既有 audit-fix 闭环边界(只修 CRITICAL/HIGH、有界轮数、自修复事务回滚)约束。
 *
 * 用法:`/autofix-pr [run|status|stop|help] [<pr-or-branch>]`(空参 = run)。门控 KHY_AUTOFIX_PR 默认开;
 * 关 → 命令不接管(字节回退)。
 */

const { printInfo, printError } = require('../formatters');
const leaf = require('../../services/autofixPr/autofixPrPlan');

// try/catch combinator 单一真源 utils/tryOr:执行 fn,任何异常 → dflt。
const _safe = require('../../utils/tryOr');
// async try/catch combinator 单一真源 utils/tryOrAsync:await fn,任何异常 → dflt。
const _safeAsync = require('../../utils/tryOrAsync');

/** 读当前分支 CI 状态(委托既有 ciStatusService SSOT)。 */
function _checkCi(target) {
  const svc = _safe(() => require('../../services/ciStatusService'), null);
  if (!svc || typeof svc.checkCIStatus !== 'function') {
    return { error: 'ciStatusService 不可用' };
  }
  const options = {};
  // target 仅作分支线索透传给既有 CI 查询(绝不在此解析仓库)。
  if (target && !/^\d+$/.test(target)) options.branch = target;
  return _safe(() => svc.checkCIStatus(options), { error: 'CI 状态读取失败' });
}

/** 判模型是否可用(复用 localBrainService 的既有判据,与 Tier A 降级口径一致)。 */
function _modelAvailable() {
  const lbs = _safe(() => require('../../services/localBrainService'), null);
  if (lbs && typeof lbs.isModelAvailable === 'function') {
    return _safe(() => !!lbs.isModelAvailable(), false);
  }
  return false;
}

/**
 * 构造审计/修复智能体派发器:复用单例 AgentTool(与 toolUseLoop 完成时审计同一套权限/深度受控路径)。
 * 镜像 toolUseLoop 的 _runAgent;不重写智能体机制。
 */
function _makeDispatchAgent(options) {
  return async ({ role, prompt, timeout }) => {
    return _safeAsync(async () => {
      const agentTool = require('../../tools/AgentTool');
      const res = await agentTool.execute(
        { prompt, subagent_type: role, role, timeout },
        { _agentContext: (options && options._agentContext) || null, traceContext: {} },
      );
      return {
        text: (res && (res.output || res.error)) || '',
        filesModified: (res && res.filesModified) || [],
        success: !!(res && res.success !== false),
      };
    }, { text: '', filesModified: [], success: false });
  };
}

/**
 * `/autofix-pr` 入口。
 * @param {string} _subCommand
 * @param {string[]} [args]
 * @param {object} [options]
 * @returns {Promise<boolean>} 是否接管该命令(门控关 → false)。
 */
async function handleAutofixPr(_subCommand, args = [], options = {}) {
  if (!leaf.isEnabled(process.env)) {
    printInfo('autofix-pr 命令未启用(KHY_AUTOFIX_PR 为关)。');
    return false;
  }

  const parsed = leaf.parseAutofixArgs(args);

  if (parsed.action === 'help') {
    printInfo(leaf.buildHelpText());
    return true;
  }
  if (!parsed.valid && parsed.parseError) {
    printError(leaf.buildUnknownText());
    return true;
  }
  if (parsed.action === 'stop') {
    printInfo(leaf.buildStopText());
    return true;
  }

  // status / run 都先读 CI 并披露状态。
  const ciResult = _checkCi(parsed.target);
  printInfo(leaf.buildCiStatusText(ciResult, parsed.target));

  if (parsed.action === 'status') {
    return true;
  }

  // run:由 CI 分类 + 模型可用性推导该不该修。
  const decision = leaf.decideFixPlan({ ciResult, modelAvailable: _modelAvailable() });
  printInfo(leaf.buildPlanText(decision));

  if (!decision.proceed) {
    return true;
  }

  // 执行本地审计修复闭环(委托既有 auditFixLoop SSOT,注入 AgentTool 派发器)。
  const afLoop = _safe(() => require('../../services/auditFixLoop'), null);
  if (!afLoop || typeof afLoop.runAuditFixCycle !== 'function') {
    printError('审计修复闭环(auditFixLoop)不可用,无法执行本地修复。');
    return true;
  }
  const dispatchAgent = _makeDispatchAgent(options);
  const afResult = await _safeAsync(
    () => afLoop.runAuditFixCycle({
      dispatchAgent,
      taskDescription: `修复当前分支失败的 CI${parsed.target ? `(目标线索: ${parsed.target})` : ''}`,
      files: [],
      onEvent: (evt) => {
        if (evt && (evt.type === 'audit_start' || evt.type === 'fix_start')) {
          printInfo(`  · ${evt.type === 'audit_start' ? '审计' : '修复'}(第 ${evt.round} 轮)…`);
        }
      },
    }),
    { outcome: 'error', error: '修复闭环执行异常', filesFixed: [], totalActionableRemaining: 0, rounds: [] },
  );

  printInfo(leaf.buildOutcomeText(afResult));
  return true;
}

module.exports = { handleAutofixPr };

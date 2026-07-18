'use strict';

/**
 * autonomy.js — `/autonomy` 命令薄壳:把 khy 分散的自治面汇成一份只读巡检报告,并支持对单个
 * 受管 flow 做 view / cancel / resume。对齐 Claude Code 的 /autonomy(只读自治巡检)。
 *
 * **背后逻辑**(语法解析 + 报告渲染)在纯叶子 services/autonomy/autonomyInspectPlan.js(单一真源·零 IO);
 * 本薄壳只做:门控、**调既有各读 API 采快照**(绝不另写读取)、把 flow cancel/resume **委托既有
 * 编排服务**(orchestrationService.cancelRun/resumeRun,不另起炉灶)、渲染。
 *
 * 诚实采面(每面 best-effort try/catch,缺面 → 不渲染,绝不编造):
 *   - 编排运行 / 受管 flow : services/orchestrator/orchestrationService.{listRuns,getRunStatus,cancelRun,resumeRun}
 *   - 任务板               : coordinator/taskBoard.listTasks
 *   - cron 计划任务         : services/cronScheduler.listJobs
 *   - proactive idle-tick   : assistant/proactive.isProactiveActive
 *   - 远端会话             : services/remotedev/remoteDevService.status(async)
 *   - 权限模式             : services/toolCalling.getPermissionMode
 *
 * 用法:`/autonomy [status [--deep] | runs [N] | flows [N] | flow <id> | flow cancel <id> | flow resume <id>]`。
 * 门控 KHY_AUTONOMY 默认开;关 → 命令不接管(字节回退)。
 */

const { printInfo, printError, printSuccess, printWarn } = require('../formatters');
const leaf = require('../../services/autonomy/autonomyInspectPlan');

// try/catch combinator 单一真源 utils/tryOr:执行 fn,任何异常 → dflt。
const _safe = require('../../utils/tryOr');

// async try/catch combinator 单一真源 utils/tryOrAsync:await fn,任何异常 → dflt。
const _safeAsync = require('../../utils/tryOrAsync');

/** 编排服务(可能因门控/缺依赖不可用 → null)。 */
function _orch() {
  return _safe(() => require('../../services/orchestrator/orchestrationService'), null);
}

/** 采集只读快照(每面独立 best-effort;缺面 → 该字段 undefined,叶子据此渲染「不可用」)。 */
async function _gatherSnapshot() {
  const snap = {};

  const svc = _orch();
  if (svc) {
    snap.enabled = _safe(() => svc.orchestrateEnabled(process.env), undefined);
    snap.runs = _safe(() => svc.listRuns({}), undefined);
  }

  snap.tasks = _safe(() => {
    const tb = require('../../coordinator/taskBoard');
    return tb.listTasks({});
  }, undefined);

  snap.cronJobs = _safe(() => require('../../services/cronScheduler').listJobs(), undefined);

  snap.proactiveActive = _safe(() => require('../../assistant/proactive').isProactiveActive(), undefined);

  snap.permissionMode = _safe(() => require('../../services/toolCalling').getPermissionMode(), undefined);

  const rd = await _safeAsync(async () => require('../../services/remotedev/remoteDevService').status({}), null);
  if (rd && rd.session && rd.session.state) snap.remotedev = { state: rd.session.state };

  return snap;
}

function _help() {
  printInfo([
    '/autonomy — 自治活动只读巡检(对齐 Claude Code /autonomy)',
    '',
    '  status [--deep]      自治总览(--deep 全量诊断)',
    '  runs [N]             近期编排运行（默认 10）',
    '  flows [N]            近期受管 flow（默认 10）',
    '  flow <id>            单个 flow 详情',
    '  flow cancel <id>     取消一个受管 flow（委托编排服务）',
    '  flow resume <id>     恢复一个受管 flow（委托编排服务）',
    '',
    '  门控: KHY_AUTONOMY=0 关闭此命令。',
  ].join('\n'));
}

/**
 * @param {string} _subCommand 预留(语法全在 args)
 * @param {string[]} args
 * @param {object} _options
 * @returns {Promise<boolean>}
 */
async function handleAutonomy(_subCommand, args = [], options = {}) {
  if (!leaf.isEnabled(process.env)) {
    printInfo('autonomy 命令未启用(KHY_AUTONOMY=off)。');
    return false;
  }

  // parseInput pulls `--deep` into options (not args); re-thread it so the leaf's
  // grammar (`status --deep`) sees it whether typed as a flag or a bare token.
  const effArgs = (options && (options.deep || options.d) && !args.includes('--deep'))
    ? args.concat(['--deep'])
    : args;
  const parsed = leaf.parseAutonomyArgs(effArgs);
  if (!parsed.valid) {
    if (parsed.parseError === 'missing_flow_id') printError('用法: /autonomy flow <id> | flow cancel <id> | flow resume <id>');
    else printError('未知子命令。用 /autonomy help 查看用法。');
    return true;
  }

  try {
    switch (parsed.action) {
      case 'help':
        _help();
        return true;

      case 'status': {
        const snap = await _gatherSnapshot();
        printInfo(parsed.deep ? leaf.buildDeep(snap) : leaf.buildOverview(snap));
        return true;
      }

      case 'runs': {
        const svc = _orch();
        const runs = svc ? _safe(() => svc.listRuns({}), []) : [];
        printInfo(leaf.buildRunsList(runs, parsed.limit));
        return true;
      }

      case 'flows': {
        const svc = _orch();
        const flows = svc ? _safe(() => svc.listRuns({}), []) : [];
        printInfo(leaf.buildFlowsList(flows, parsed.limit));
        return true;
      }

      case 'flow-view': {
        const svc = _orch();
        const status = svc ? _safe(() => svc.getRunStatus(parsed.flowId, {}), null) : null;
        if (!status) { printError(`flow 未找到: ${parsed.flowId}`); return true; }
        printInfo(leaf.buildFlowView(status));
        return true;
      }

      case 'flow-cancel': {
        const svc = _orch();
        if (!svc) { printError('编排服务不可用，无法取消 flow。'); return true; }
        const status = svc.cancelRun(parsed.flowId, {});
        if (!status) { printError(`flow 未找到: ${parsed.flowId}`); return true; }
        printSuccess(`flow ${parsed.flowId} 已取消（control=${status.control}）。`);
        return true;
      }

      case 'flow-resume': {
        const svc = _orch();
        if (!svc) { printError('编排服务不可用，无法恢复 flow。'); return true; }
        printInfo(`正在恢复 flow ${parsed.flowId}…`);
        const status = await svc.resumeRun(parsed.flowId, {});
        if (!status) { printError(`flow 未找到: ${parsed.flowId}`); return true; }
        const ok = status.control === 'done';
        (ok ? printSuccess : printWarn)(`flow ${parsed.flowId} 已恢复（control=${status.control}）。`);
        return true;
      }

      default:
        _help();
        return true;
    }
  } catch (e) {
    printError(`autonomy ${parsed.action} 失败: ${(e && e.message) || e}`);
    return true;
  }
}

module.exports = { handleAutonomy };

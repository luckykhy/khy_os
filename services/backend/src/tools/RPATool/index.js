/**
 * RPATool — "Agent as brain + RPA as hands": search / persist / replay
 * deterministic workflows previously distilled by the Agent.
 *
 * Thin dispatch layer over the workflow foundation modules:
 *   - flowRegistry (save/load/list/remove/find) — flow storage & intent matching
 *   - flowStats (record/getSuccessRate/getAvgDuration/recentRuns) — telemetry
 *   - retryPrimitives (buildRetryPrimitives/buildProgressLogger) — reliability
 *   - workflowExecutor (runGraph) — canonical graph interpreter
 *
 * Contract: every action is fail-soft — execute() never lets an exception
 * escape; failures come back as structured { success: false, error, ... }
 * objects so the Agent can self-repair (fix graph errors, fall back to
 * step-by-step tools, etc.). No paths are hardcoded here: all IO is delegated
 * to the registry/stats modules which resolve storage via dataHome.
 */
'use strict';

const crypto = require('crypto');

const { BaseTool } = require('../_baseTool');

const ACTIONS = ['find', 'save', 'run', 'list', 'show', 'stats', 'delete'];

class RPATool extends BaseTool {
  static toolName = 'RPA';
  // NOTE: 'automation' is not in the _baseTool CATEGORIES whitelist and would
  // make toToolDef() throw during registry discovery; 'coordinator' is the
  // closest valid category (same as WorkflowTool).
  static category = 'coordinator';
  static risk = 'high';
  static aliases = ['rpa', 'process_automation'];
  static searchHint = 'rpa automation flow replay 自动化 流程 重放';
  static shouldDefer = true;

  isConcurrencySafe() {
    return false;
  }

  prompt() {
    return `Deterministic RPA workflow tool: search, persist and replay distilled flows so repetitive tasks skip LLM re-planning.

DECISION GUIDE (follow this order for any repetitive automation task):
1. FIRST call { action: 'find', intent: '<task description>' } to search for an already-distilled flow.
2. If a match exists with an acceptable successRate (and no platformMismatch), replay it via { action: 'run', name, inputs }.
3. If nothing matches, complete the task step by step with ordinary tools. Afterwards, if the steps are reusable, distill them into a canonical graph and persist with { action: 'save', name, graph, intent, tags, params } so the next occurrence can be replayed deterministically.
4. Use 'stats' to inspect reliability before trusting a flow; use 'show' to inspect its graph; use 'delete' to drop an obsolete flow.

CANONICAL GRAPH CHEAT SHEET — graph = { nodes: [...], connections: [...] }:
- Node: { id, type, name?, data? }. Types:
  - start / end — exactly one start; end terminates the run.
  - toolCall — data: { tool, args, outputVar? }; runs a registered tool, stores its text result in vars[outputVar].
  - ifElse — data: { expression }; routes via fromPort 'branch-true' / 'branch-false'.
  - loop — data: { mode: 'forEach'|'count', itemsVar?, itemVar?, count? }; ports 'loop-body' / 'loop-done'.
  - prompt — data: { prompt, model?, outputVar? }; one LLM call.
  - http — data: { method, url, headers?, body?, outputVar? }.
  - code — data: { language, source, outputVar? }.
- Connection: { from, to, fromPort? } (fromPort defaults to 'default').
- Variable interpolation: use {{var}} inside strings of prompt/args/url/body/source; run inputs seed the initial vars.

SAFETY: replay is NOT a permission bypass — every toolCall executed during 'run' still goes through the standard tool permission funnel exactly as if the Agent called it directly. High-risk steps will still require the usual approvals. Flows recorded on another platform are refused at run time (platformMismatch).

save() validation errors are returned verbatim in 'errors' — fix the graph and save again. run() is fail-soft: failures return { success: false, error, failedStep, log } instead of throwing, and every run (success or failure) is recorded into flow stats.

ENVIRONMENT & PERMISSIONS: every step goes through the unified tool permission funnel — replay grants no exemption. Desktop flows require desktop control to be enabled; headless browser steps require Playwright to be available. When a step fails, run() returns a structured refusal reason (error, failedStep, log) so the Agent can take over the flow.

FAILURE HANDLING & SELF-HEALING: when run() returns success:false, read failedStep / failedTool / resumeVars (variable snapshot at failure time) / recentLog (last steps, compressed). Take over from the failure point with ordinary tools — resumeVars tells you what the flow had already computed, so only the REMAINING user intent needs to be completed manually. After the takeover succeeds, repair the graph (fix the broken node/args) and save it again with healedFrom=<failed node id> to publish a new version; also consider adding a contract so future replays are self-verifying.

INTENT CONTRACT: on save you may attach contract — an array of post-condition assertions verified automatically after every successful run. 5 types: { type:'fileExists', path }, { type:'fileContains', path, text }, { type:'varContains', var, text }, { type:'windowTitle', pattern }, { type:'httpStatus', url, expect }. String fields support {{var}} interpolation from run vars. When run() returns contractFailed:true with failedAssertions, the flow ran but did NOT satisfy the user intent — follow the same takeover protocol above to complete the remaining intent, then heal the flow.`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ACTIONS,
          description:
            'Operation to perform. find→requires intent; save→requires name+graph (intent/tags/params recommended); run→requires name (inputs optional); show/stats/delete→require name; list→no extra fields.',
        },
        intent: {
          type: 'string',
          description:
            'Natural-language task description. Required by find (used for keyword matching); recommended on save so future find calls can match this flow.',
        },
        name: {
          type: 'string',
          description: 'Flow name. Required by save/run/show/stats/delete.',
        },
        graph: {
          type: 'object',
          description:
            'Canonical workflow graph { nodes, connections }. Required by save. See the graph cheat sheet in the tool description.',
        },
        tags: {
          type: 'array',
          description:
            'Optional keyword tags for save, e.g. ["invoice","excel"]. Improves find matching.',
        },
        params: {
          type: 'array',
          description:
            'Optional declared input parameter names for save, e.g. ["month","outputDir"].',
        },
        inputs: {
          type: 'object',
          description:
            'Optional initial variables for run, keyed by parameter name, e.g. {"month":"2026-07"}.',
        },
        contract: {
          type: 'array',
          description:
            'Optional intent-contract assertions for save, auto-verified after each successful run. Items: {type:"fileExists",path} / {type:"fileContains",path,text} / {type:"varContains",var,text} / {type:"windowTitle",pattern} / {type:"httpStatus",url,expect}. Strings support {{var}} interpolation, e.g. [{"type":"fileExists","path":"{{outputDir}}/report.xlsx"}].',
        },
        healedFrom: {
          type: 'string',
          description:
            'Optional for save: node id of the failed step this new version heals (self-healing provenance).',
        },
      },
      required: ['action'],
    };
  }

  async execute(params, ctx = {}) {
    const p = params || {};
    try {
      switch (p.action) {
        case 'find':
          return this._find(p);
        case 'save':
          return this._save(p);
        case 'run':
          return this._run(p, ctx);
        case 'list':
          return this._list();
        case 'show':
          return this._show(p);
        case 'stats':
          return this._stats(p);
        case 'delete':
          return this._delete(p);
        default:
          return {
            success: false,
            error: `未知 action：${String(p.action)}（可选：${ACTIONS.join('/')}）`,
          };
      }
    } catch (err) {
      // Fail-soft: never let an exception escape to the tool loop.
      return { success: false, error: (err && err.message) || String(err) };
    }
  }

  /* ── Action handlers ─────────────────────────────────────────────── */

  _registry() {
    return require('../../services/workflow/flowRegistry');
  }
  _flowStats() {
    return require('../../services/workflow/flowStats');
  }

  _find(p) {
    if (!p.intent) {
      return { success: false, error: 'find 需要 intent 字段（任务描述文本）' };
    }
    const matches = this._registry().find(String(p.intent));
    if (!matches.length) {
      return { success: true, matches: [], hint: '无沉淀流程，建议逐步执行后用 save 沉淀' };
    }
    return { success: true, matches };
  }

  _save(p) {
    if (!p.name) {
      return { success: false, error: 'save 需要 name 字段' };
    }
    if (!p.graph || typeof p.graph !== 'object') {
      return {
        success: false,
        error: 'save 需要 graph 字段（canonical { nodes, connections } 图）',
      };
    }
    const res = this._registry().save(p.name, p.graph, {
      intent: p.intent,
      tags: p.tags,
      params: p.params,
      createdBy: 'agent',
      contract: p.contract,
      healedFrom: p.healedFrom,
    });
    if (!res.ok) {
      // Surface validation errors verbatim so the Agent can self-repair the graph.
      return {
        success: false,
        errors: res.errors,
        hint: '图校验失败，请按 errors 修正后重新 save',
      };
    }
    const out = {
      success: true,
      name: res.name,
      slug: res.slug,
      version: res.version,
      unchanged: res.unchanged,
    };
    if (Array.isArray(p.contract) && p.contract.length) {
      out.contractCount = p.contract.length;
    }
    return out;
  }

  async _run(p, ctx) {
    if (!p.name) {
      return { success: false, error: 'run 需要 name 字段' };
    }
    const loaded = this._registry().load(p.name);
    if (!loaded.ok) {
      return { success: false, error: loaded.errors.join('；') };
    }

    const flow = loaded.flow;
    const meta = flow._meta || {};
    if (meta.platform && meta.platform !== process.platform) {
      return {
        success: false,
        error: `流程「${p.name}」录制于平台 ${meta.platform}，与当前平台 ${process.platform} 不符，已拒绝执行。请在原平台重放，或在当前平台重新沉淀。`,
      };
    }

    const {
      buildRetryPrimitives,
      buildProgressLogger,
    } = require('../../services/workflow/retryPrimitives');
    const executor = require('../../services/workflow/workflowExecutor');
    const stats = this._flowStats();

    const progress = [];
    const retryEvents = [];
    const { primitives, getRetryTotal } = buildRetryPrimitives(
      { userId: ctx && ctx.userId != null ? ctx.userId : null },
      {
        retryPolicy: meta.retryPolicy,
        onRetry: (info) => {
          retryEvents.push(info);
        },
      }
    );
    const onLog = buildProgressLogger({
      flowName: flow.name || p.name,
      totalSteps: Array.isArray(flow.nodes) ? flow.nodes.length : undefined,
      print: (line) => {
        progress.push(line);
      },
      getRetryTotal,
    });

    // runGraph wraps node errors into a fresh Error (keeping only vars/log),
    // so capture the original retry-exhaustion error here to preserve its
    // failedTool / lastResult / retryCount metadata for the fail-soft report.
    let lastToolErr = null;
    const origExecuteTool = primitives.executeTool;
    primitives.executeTool = async (name, args) => {
      try {
        return await origExecuteTool(name, args);
      } catch (err) {
        lastToolErr = err;
        throw err;
      }
    };

    const executionId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    let outcome = null;
    let runErr = null;
    try {
      outcome = await executor.runGraph(
        { nodes: flow.nodes, connections: flow.connections },
        { primitives, vars: p.inputs || {}, onLog }
      );
    } catch (err) {
      runErr = err;
    }
    const durationMs = Date.now() - t0;

    const log = (outcome && outcome.log) || (runErr && runErr.log) || [];
    const failedEntry = log.filter((e) => e && e.status === 'failed').pop() || null;
    // Prefer the retry-exhaustion metadata attached by retryPrimitives
    // (err.failedTool / err.lastResult / err.retryCount) over the log entry.
    const toolErr = runErr && runErr.failedTool ? runErr : runErr ? lastToolErr : null;
    const failedStep =
      toolErr && toolErr.failedTool
        ? String(toolErr.failedTool)
        : failedEntry
          ? String(failedEntry.name || failedEntry.nodeId || '')
          : null;
    const succeeded = !runErr && outcome && outcome.status === 'completed';

    // Post-condition intent contract: verified AFTER a successful replay but
    // BEFORE telemetry, so a contract miss is recorded as a failed run
    // (record() is called exactly once per run, after this verdict).
    let contractFailed = false;
    let contractOutcome = null;
    let contractCheckError = null;
    if (succeeded && Array.isArray(meta.contract) && meta.contract.length) {
      try {
        const { checkContract } = require('../../services/workflow/contractChecker');
        // Same permission funnel as flow steps: reuse the run's executeTool
        // primitive. Wrap throws (retry exhaustion / denied) into an
        // error-shaped result so windowTitle degrades to skipped, not failed.
        const contractExecuteTool = async (toolName, args) => {
          try {
            return await origExecuteTool(toolName, args);
          } catch (err) {
            return { success: false, error: (err && err.message) || String(err) };
          }
        };
        contractOutcome = await checkContract(meta.contract, {
          vars: outcome.vars,
          executeTool: contractExecuteTool,
        });
        contractFailed = !(contractOutcome && contractOutcome.passed === true);
      } catch (err) {
        // Fail-soft: checkContract never throws by design, but a checker-side
        // defect must not sink an otherwise successful run — treat the
        // contract as passed and surface a hint instead.
        contractCheckError = `契约校验环节异常，已按通过处理：${(err && err.message) || String(err)}`;
        contractFailed = false;
      }
    }

    // Record telemetry for BOTH success and failure (feeds find() weighting).
    // Called exactly once, after the contract verdict above.
    stats.record({
      flowName: flow.name || String(p.name),
      executionId,
      status: succeeded && !contractFailed ? 'completed' : 'failed',
      durationMs,
      stepCount: log.length,
      failedStep,
      retryTotal: getRetryTotal(),
      startedAt,
      ...(contractFailed ? { contractFailed: true } : {}),
    });

    if (succeeded && contractFailed) {
      const failedAssertions = ((contractOutcome && contractOutcome.results) || []).filter(
        (r) => r && r.passed !== true && r.skipped !== true
      );
      return {
        success: false,
        error: '流程执行完成但意图契约校验未通过',
        contractFailed: true,
        failedAssertions,
        contractResults: (contractOutcome && contractOutcome.results) || [],
        vars: outcome.vars,
        log,
        progress,
        durationMs,
        executionId,
      };
    }

    if (succeeded) {
      const ok = { success: true, vars: outcome.vars, log, progress, durationMs, executionId };
      if (contractOutcome) {
        ok.contractChecked = true;
        ok.contractResults = contractOutcome.results;
      }
      if (contractCheckError) {
        ok.contractChecked = false;
        ok.contractCheckWarning = contractCheckError;
      }
      return ok;
    }
    // Fail-soft: structured failure, never rethrown. resumeVars + recentLog
    // give the Agent takeover material (variable snapshot + compressed tail).
    const recentLog = log.slice(-5).map((e) => ({
      step: String((e && (e.name || e.nodeId)) || ''),
      summary: String((e && (e.error || e.summary || e.status)) || '').slice(0, 120),
    }));
    return {
      success: false,
      error: runErr
        ? (runErr && runErr.message) || String(runErr)
        : `流程未完成（状态：${outcome ? outcome.status : '未知'}）`,
      failedStep,
      failedTool: (toolErr && toolErr.failedTool) || null,
      lastResult: toolErr && toolErr.lastResult !== undefined ? toolErr.lastResult : null,
      retryCount:
        toolErr && Number.isFinite(Number(toolErr.retryCount)) ? Number(toolErr.retryCount) : null,
      resumeVars: (runErr && runErr.vars) || {},
      recentLog,
      log,
      progress,
      retryEvents,
      durationMs,
      executionId,
    };
  }

  _list() {
    const res = this._registry().list();
    if (!res.ok) {
      return { success: false, error: res.errors.join('；') };
    }
    return { success: true, flows: res.flows, warnings: res.warnings };
  }

  _show(p) {
    if (!p.name) {
      return { success: false, error: 'show 需要 name 字段' };
    }
    const res = this._registry().load(p.name);
    if (!res.ok) {
      return { success: false, error: res.errors.join('；') };
    }
    return { success: true, flow: res.flow };
  }

  _stats(p) {
    if (!p.name) {
      return { success: false, error: 'stats 需要 name 字段' };
    }
    const stats = this._flowStats();
    return {
      success: true,
      name: String(p.name),
      successRate: stats.getSuccessRate(p.name),
      avgDurationMs: stats.getAvgDuration(p.name),
      recentRuns: stats.recentRuns(p.name, 10),
    };
  }

  _delete(p) {
    if (!p.name) {
      return { success: false, error: 'delete 需要 name 字段' };
    }
    const res = this._registry().remove(p.name);
    if (!res.ok) {
      return { success: false, error: res.errors.join('；') };
    }
    return { success: true, removed: res.removed };
  }

  /* ── Metadata ────────────────────────────────────────────────────── */

  getActivityDescription(input) {
    const i = input || {};
    const target = i.name || i.intent || '';
    switch (i.action) {
      case 'find':
        return `RPA 检索流程：${i.intent || ''}`;
      case 'save':
        return `RPA 沉淀流程：${target}`;
      case 'run':
        return `RPA 重放流程：${target}`;
      case 'list':
        return 'RPA 列出已沉淀流程';
      case 'show':
        return `RPA 查看流程：${target}`;
      case 'stats':
        return `RPA 查看流程统计：${target}`;
      case 'delete':
        return `RPA 删除流程：${target}`;
      default:
        return `RPA 操作：${String(i.action || '')}`;
    }
  }
}

module.exports = RPATool;

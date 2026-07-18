'use strict';

/**
 * orchestrate.js — thin CLI handler for the unified multi-agent orchestration entry.
 *
 * One command, three workflow types (sequential / parallel / phase), plus the
 * pause / resume / replay / status / list control surface. All real logic lives in
 * services/orchestrator/orchestrationService.js; this handler only parses args,
 * loads the spec, and renders via the shared formatters. Nothing orchestration-
 * related is scattered elsewhere.
 *
 * Spec format (JSON file or inline):
 *   { "mode": "sequential", "label": "...", "steps": [ { "prompt": "...", "role": "...", "duration": 3 } ] }
 *   { "mode": "parallel",   "steps": [ ... ] }
 *   { "mode": "phase",      "phases": [ { "name": "research", "steps": [...] }, { "steps": [...] } ] }
 *
 * The `schedule` (alias `plan`) sub-command computes the 统筹/critical-path plan
 * WITHOUT running any agent and additionally accepts a raw task DAG so any
 * dependency graph is expressible:
 *   { "tasks": [ { "id": "boil", "label": "烧水", "duration": 15, "dependsOn": ["kettle"] }, ... ] }
 */

const fs = require('fs');

function _fmt() { return require('../formatters'); }

function _loadSpec(arg) {
  if (!arg) throw new Error('missing spec — provide a JSON file path or inline JSON');
  const trimmed = String(arg).trim();
  if (trimmed === '-') {
    const data = fs.readFileSync(0, 'utf-8'); // stdin
    return JSON.parse(data);
  }
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  const text = fs.readFileSync(trimmed, 'utf-8');
  return JSON.parse(text);
}

function _renderStatus(status, fmt) {
  const { printInfo, printTable } = fmt;
  const p = status.progress || {};
  printInfo(
    `Run ${status.runId}  ·  mode=${status.mode}  ·  control=${status.control}  ·  ` +
    `${p.done || 0}/${p.total || 0} done` +
    (p.failed ? `  ·  ${p.failed} failed` : '') +
    (p.running ? `  ·  ${p.running} running` : '')
  );
  const rows = (status.steps || []).map((s) => [
    s.stepId,
    s.role || '',
    s.status,
    s.error ? `✗ ${s.error}` : (s.result != null ? s.result : ''),
  ]);
  if (rows.length) printTable(['Step', 'Role', 'Status', 'Result / Error'], rows);
}

/** Short, table-friendly label for a plan step / DAG task in the schedule view. */
function _stepLabel(step) {
  if (step.label && step.label !== step.id) return String(step.label);
  if (step.role && step.role !== 'general') return step.role;
  const p = String(step.prompt || step.id || '').replace(/\s+/g, ' ').trim();
  return p.length > 40 ? p.slice(0, 39) + '…' : (p || step.id);
}

/**
 * Render the 统筹 / critical-path schedule analysis (no agents are run). This is
 * the "boil water while you watch TV" planner: it shows the minimum wall-clock
 * time (critical path), how much it beats doing everything one-by-one, and which
 * flexible tasks can be slotted into each long task's wait.
 */
function _renderSchedule(plan, analysis, fmt) {
  const { printInfo, printTable, printSuccess } = fmt;
  const labelById = {};
  for (const s of plan.steps) labelById[s.id] = _stepLabel(s);

  printInfo(`统筹 schedule for "${plan.label}"  ·  mode=${plan.mode}  ·  ${plan.stepCount} tasks`);
  const saved = analysis.savedTime;
  const pct = analysis.serialTotal > 0 ? Math.round((saved / analysis.serialTotal) * 100) : 0;
  printSuccess(
    `One-by-one: ${analysis.serialTotal}  →  with 统筹: ${analysis.makespan}  ` +
    `(saves ${saved}${pct ? `, ${pct}%` : ''}; units = your spec's "duration")`
  );

  const rows = analysis.tasks.map((t) => [
    t.id,
    labelById[t.id] || t.label,
    String(t.duration),
    `${t.es}–${t.ef}`,
    String(t.slack),
    t.critical ? '★ critical' : '',
  ]);
  printTable(['Step', 'Label', 'Dur', 'Window', 'Slack', ''], rows);

  if (analysis.criticalPath.length) {
    printInfo(
      'Critical path (the backbone that fixes total time): ' +
      analysis.criticalPath.map((id) => labelById[id] || id).join(' → ')
    );
  }

  if (analysis.waitFill.length) {
    printInfo('统筹 hints — fill the waits (like rinsing cups while the water boils):');
    for (const w of analysis.waitFill) {
      const chores = w.canDo.map((c) => `${labelById[c.id] || c.label}(${c.duration})`).join('、');
      printInfo(`  ⏳ While 「${labelById[w.during] || w.label}」 runs [${w.window[0]}–${w.window[1]}], also do: ${chores}`);
    }
  } else if (analysis.stepCount > 1) {
    printInfo('No overlap opportunities — every task is on the critical path (a strict chain).');
  }
}

/** Map a built plan's steps into the schedule leaf's task shape. */
function _planToScheduleTasks(plan) {
  return plan.steps.map((s) => ({
    id: s.id,
    label: _stepLabel(s),
    duration: s.duration, // undefined → schedule leaf defaults to 1
    dependsOn: s.dependsOn || [],
  }));
}


function _help(fmt) {
  fmt.printInfo([
    'khy orchestrate — unified multi-agent orchestration',
    '',
    '  run <spec.json|->     Start a workflow (sequential / parallel / phase)',
    '  schedule <spec|->     统筹/critical-path plan (no agents run): minimum time,',
    '                        time saved vs one-by-one, and what to do during waits',
    '  status [runId]        Unified monitoring view (latest run if id omitted)',
    '  list                  List known runs',
    '  pause   <runId>       Stop accepting new steps (in-flight steps finish)',
    '  resume  <runId>       Continue a paused run',
    '  replay  <runId>       Reset blocked/failed steps and re-run (done steps skipped)',
    '  cancel  <runId>       Mark a run cancelled',
    '',
    '  Spec: { "mode":"sequential|parallel|phase", "steps":[{"prompt","role","duration"}] }',
    '        phase mode uses "phases":[{"name","steps":[...]}]',
    '        schedule also accepts a raw DAG: { "tasks":[{"id","label","duration","dependsOn":[]}] }',
    '        "duration" (optional, any unit) powers the schedule analysis.',
    '  Gate: KHY_ORCHESTRATE=0 disables this command;',
    '        KHY_ORCHESTRATE_SCHEDULE=0 disables only the schedule sub-command.',
  ].join('\n'));
}

async function handleOrchestrate(subCommand, args = [], options = {}) {
  const fmt = _fmt();
  const { printError, printSuccess } = fmt;
  const svc = require('../../services/orchestrator/orchestrationService');

  if (!svc.orchestrateEnabled(process.env)) {
    fmt.printWarn('orchestrate is disabled (KHY_ORCHESTRATE=0). Unset it to enable.');
    return true;
  }

  const sub = String(subCommand || (args && args[0]) || 'help').toLowerCase();
  // If subCommand was peeled by the router, args holds the remainder; otherwise drop args[0].
  const rest = subCommand ? args : (args || []).slice(1);
  const arg0 = rest && rest[0];

  try {
    switch (sub) {
      case 'run': {
        const spec = _loadSpec(arg0);
        fmt.printInfo(`Starting orchestration (mode=${spec.mode || '?'})…`);
        const status = await svc.runOrchestration(spec, {
          timeout: options.timeout ? Number(options.timeout) : undefined,
          maxRetries: options.retries ? Number(options.retries) : undefined,
        });
        const ok = status.control === 'done';
        (ok ? printSuccess : fmt.printWarn)(
          `Run ${status.runId} finished: control=${status.control}, ` +
          `${status.progress.done}/${status.progress.total} done` +
          (status.progress.failed ? `, ${status.progress.failed} failed` : '')
        );
        _renderStatus(status, fmt);
        if (!ok && status.progress.failed) {
          fmt.printInfo(`Re-run failed steps with:  khy orchestrate replay ${status.runId}`);
        }
        return true;
      }
      case 'schedule':
      case 'plan': {
        const sched = require('../../services/orchestrator/criticalPathSchedule');
        if (!sched.scheduleEnabled(process.env)) {
          fmt.printWarn('orchestrate schedule is disabled (KHY_ORCHESTRATE_SCHEDULE=0). Unset it to enable.');
          return true;
        }
        const spec = _loadSpec(arg0);
        // Two spec shapes:
        //   1. a raw task DAG  { "tasks": [{ id, label, duration, dependsOn:[...] }] }
        //      — expresses ANY dependency graph (e.g. the true 烧水泡茶 example).
        //   2. a workflow spec { "mode": ..., "steps"|"phases": ... } — reuses the
        //      sequential/parallel/phase plan builder so `run` and `schedule` share one spec.
        let label, stepCount, scheduleTasks, mode;
        if (Array.isArray(spec.tasks)) {
          mode = 'dag';
          label = (typeof spec.label === 'string' && spec.label.trim()) || 'schedule';
          scheduleTasks = spec.tasks;
          stepCount = spec.tasks.length;
        } else {
          const builtPlan = require('../../services/orchestrator/orchestrationPlan').buildOrchestrationPlan(spec);
          mode = builtPlan.mode;
          label = builtPlan.label;
          stepCount = builtPlan.stepCount;
          scheduleTasks = _planToScheduleTasks(builtPlan);
        }
        const analysis = sched.analyzeSchedule(scheduleTasks);
        _renderSchedule({ label, mode, stepCount, steps: scheduleTasks }, analysis, fmt);
        return true;
      }
      case 'status': {
        let runId = arg0;
        if (!runId) {
          const runs = svc.listRuns({});
          if (!runs.length) { fmt.printInfo('No orchestration runs found.'); return true; }
          runId = runs[runs.length - 1].runId;
        }
        const status = svc.getRunStatus(runId, {});
        if (!status) { printError(`Run not found: ${runId}`); return false; }
        _renderStatus(status, fmt);
        return true;
      }
      case 'list': {
        const runs = svc.listRuns({});
        if (!runs.length) { fmt.printInfo('No orchestration runs found.'); return true; }
        const rows = runs.map((r) => [
          r.runId, r.mode, r.control, `${r.progress.done}/${r.progress.total}`,
          r.progress.failed ? String(r.progress.failed) : '', r.label || '',
        ]);
        fmt.printTable(['Run', 'Mode', 'Control', 'Done', 'Failed', 'Label'], rows);
        return true;
      }
      case 'pause':
      case 'cancel': {
        if (!arg0) { printError(`usage: khy orchestrate ${sub} <runId>`); return false; }
        const status = sub === 'pause' ? svc.pauseRun(arg0, {}) : svc.cancelRun(arg0, {});
        if (!status) { printError(`Run not found: ${arg0}`); return false; }
        printSuccess(`Run ${arg0} ${sub === 'pause' ? 'paused' : 'cancelled'} (control=${status.control}).`);
        return true;
      }
      case 'resume':
      case 'replay': {
        if (!arg0) { printError(`usage: khy orchestrate ${sub} <runId>`); return false; }
        fmt.printInfo(`${sub === 'replay' ? 'Replaying' : 'Resuming'} run ${arg0}…`);
        const status = sub === 'resume' ? await svc.resumeRun(arg0, {}) : await svc.replayRun(arg0, {});
        if (!status) { printError(`Run not found: ${arg0}`); return false; }
        const ok = status.control === 'done';
        (ok ? printSuccess : fmt.printWarn)(
          `Run ${arg0} ${sub}d: control=${status.control}, ` +
          `${status.progress.done}/${status.progress.total} done`
        );
        _renderStatus(status, fmt);
        return true;
      }
      case 'help':
      default:
        _help(fmt);
        return true;
    }
  } catch (e) {
    printError(`orchestrate ${sub} failed: ${(e && e.message) || e}`);
    return false;
  }
}

module.exports = { handleOrchestrate };

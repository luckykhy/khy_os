'use strict';

/**
 * autonomyInspectPlan.js — `/autonomy`(自治活动只读巡检)的零 IO 确定性单一真源(纯叶子)。
 *
 * 契约 (CONTRACT): 零 IO、确定性、绝不抛、无副作用;所有自治面快照(orchestration runs / taskBoard /
 * cron / proactive / remotedev / permissionMode)与 env 全经入参注入,本叶子绝不读 process.env、绝不
 * 触文件、绝不查 SQLite、绝不 spawn、绝不调 Date、绝不持有状态。真正的读取(各 read API)与 flow
 * cancel/resume 的写,都在薄壳 handlers/autonomy.js;本叶子只解析语法 + 把快照渲染成报告文本。
 *
 * 背后的逻辑(对齐 Claude Code /autonomy):CC 的 /autonomy 是一个**只读巡检器** ——「Inspect automatic
 * autonomy runs recorded for proactive ticks and scheduled tasks」,把分散的自治面(自动运行 / 受管
 * flow / cron 计划 / proactive tick / 远端控制 …)的计数与最新活动汇成一份诊断报告,语法
 * `status [--deep] | runs [N] | flows [N] | flow <id> | flow cancel <id> | flow resume <id>`。khy 早已**真有**
 * 这些自治面(我先前搭的 orchestration 编排层 = 受管 flow·cronScheduler = 计划任务·assistant/proactive =
 * idle-tick·remotedev = 远端会话·toolCalling.getPermissionMode = 权限模式),只是从无一处把它们汇成
 * 「自治总览」。本叶子把**纯确定性**那块(语法解析 + 报告渲染)收敛成单一真源,诚实只渲染 khy 真有的面:
 *
 *   - parseAutonomyArgs(args)
 *       → { action:'status'|'runs'|'flows'|'flow-view'|'flow-cancel'|'flow-resume'|'help',
 *           deep, limit, flowId, valid, parseError }
 *   - buildOverview(snapshot)   → status 概览文本(deep=false)
 *   - buildDeep(snapshot)       → status --deep 全量诊断文本
 *   - buildRunsList(runs, limit)/ buildFlowsList(flows, limit) → 近期列表文本
 *   - buildFlowView(status)     → 单个 flow 详情文本
 *
 * 诚实边界(刻意不渲染 khy 没有的字段):cron 无 next-run / durable / recurring(只 enabled/lastRunAt);
 * proactiveCollaboration 无状态读面(只 env 门控);persisted workflow-run 无 list API。这些一律不编造。
 *
 * 注意:本文件刻意不在注释里书写 require-调用样式,避免架构债扫描器把它当成幽灵依赖边。本叶子零依赖。
 */

const _DEFAULT_LIMIT = 10;
const _MAX_LIMIT = 200;

function _intArg(raw, dflt) {
  const n = parseInt(String(raw == null ? '' : raw).trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return dflt;
  return n > _MAX_LIMIT ? _MAX_LIMIT : n;
}

/**
 * 解析 /autonomy 参数。绝不抛;非法 → { valid:false, parseError }。
 * 语法:`status [--deep] | runs [N] | flows [N] | flow <id> | flow cancel <id> | flow resume <id>`。
 * 空参 → status 概览。
 * @param {string[]} [args]
 * @returns {{action:string, deep:boolean, limit:number, flowId:string|null, valid:boolean, parseError:string|null}}
 */
function parseAutonomyArgs(args) {
  const list = Array.isArray(args) ? args.map((a) => String(a == null ? '' : a).trim()).filter((s) => s !== '') : [];
  const base = { action: 'status', deep: false, limit: _DEFAULT_LIMIT, flowId: null, valid: true, parseError: null };
  if (list.length === 0) return base;

  const head = list[0].toLowerCase();

  if (head === 'help' || head === '-h' || head === '--help') {
    return Object.assign({}, base, { action: 'help' });
  }

  if (head === 'status') {
    const deep = list.slice(1).some((t) => t === '--deep' || t === '-d' || t === 'deep');
    return Object.assign({}, base, { action: 'status', deep });
  }

  if (head === 'runs') {
    return Object.assign({}, base, { action: 'runs', limit: _intArg(list[1], _DEFAULT_LIMIT) });
  }

  if (head === 'flows') {
    return Object.assign({}, base, { action: 'flows', limit: _intArg(list[1], _DEFAULT_LIMIT) });
  }

  if (head === 'flow') {
    const second = (list[1] || '').toLowerCase();
    if (second === 'cancel' || second === 'resume') {
      const id = list[2];
      if (!id) return Object.assign({}, base, { valid: false, parseError: 'missing_flow_id' });
      return Object.assign({}, base, { action: `flow-${second}`, flowId: id });
    }
    const id = list[1];
    if (!id) return Object.assign({}, base, { valid: false, parseError: 'missing_flow_id' });
    return Object.assign({}, base, { action: 'flow-view', flowId: id });
  }

  return Object.assign({}, base, { valid: false, parseError: 'unknown_action' });
}

function _n(v) { return Number.isFinite(v) ? v : 0; }

/**
 * 把 runs 数组按 control 分桶计数。runs 元素形如 { runId, mode, label, control, progress }。
 * @param {Array<object>} runs
 * @returns {{total:number, running:number, paused:number, done:number, failed:number, cancelled:number, idle:number}}
 */
function tallyRuns(runs) {
  const t = { total: 0, running: 0, paused: 0, done: 0, failed: 0, cancelled: 0, idle: 0 };
  if (!Array.isArray(runs)) return t;
  for (const r of runs) {
    if (!r || typeof r !== 'object') continue;
    t.total += 1;
    const c = String(r.control || '').toLowerCase();
    if (c === 'running') t.running += 1;
    else if (c === 'paused') t.paused += 1;
    else if (c === 'done') t.done += 1;
    else if (c === 'failed') t.failed += 1;
    else if (c === 'cancelled') t.cancelled += 1;
    else t.idle += 1;
  }
  return t;
}

/**
 * 把 taskBoard 任务数组按 status 分桶计数(canonical 状态)。
 * @param {Array<object>} tasks
 * @returns {{total:number, [status:string]:number}}
 */
function tallyTasks(tasks) {
  const t = { total: 0 };
  if (!Array.isArray(tasks)) return t;
  for (const task of tasks) {
    if (!task || typeof task !== 'object') continue;
    t.total += 1;
    const s = String(task.status || 'unknown').toLowerCase();
    t[s] = (t[s] || 0) + 1;
  }
  return t;
}

function _runLine(r) {
  const p = (r && r.progress) || {};
  const done = _n(p.done);
  const total = _n(p.total);
  const failed = _n(p.failed) ? ` · ${_n(p.failed)} failed` : '';
  return `  ${r.runId}  [${r.control || '?'}]  ${done}/${total}${failed}  ${r.mode || ''}  ${r.label || ''}`.replace(/\s+$/, '');
}

/**
 * status 概览(deep=false)。snapshot 字段全部可缺(缺面 → 该行标「不可用」,绝不抛)。
 * @param {object} snapshot { enabled, permissionMode, proactiveActive, runs[], cronJobs[], tasks[], remotedev:{state}, generatedAt }
 * @returns {string}
 */
function buildOverview(snapshot) {
  const s = snapshot || {};
  const lines = [];
  lines.push('自治活动总览(/autonomy)');
  lines.push('');

  // 权限模式 — 当前自治档位。
  lines.push(`权限模式: ${s.permissionMode || '(未知)'}`);

  // 编排运行 / 受管 flow。
  if (Array.isArray(s.runs)) {
    const rt = tallyRuns(s.runs);
    lines.push(`编排运行: 共 ${rt.total}（running ${rt.running} · paused ${rt.paused} · done ${rt.done} · failed ${rt.failed} · cancelled ${rt.cancelled}）`);
    if (s.enabled === false) lines.push('  （编排已禁用 KHY_ORCHESTRATE=0）');
    const latest = s.runs[s.runs.length - 1];
    if (latest) lines.push(`  最新:${_runLine(latest).trim()}`);
  } else {
    lines.push('编排运行: 不可用');
  }

  // taskBoard 任务。
  if (Array.isArray(s.tasks)) {
    const tt = tallyTasks(s.tasks);
    const parts = Object.keys(tt).filter((k) => k !== 'total').map((k) => `${k} ${tt[k]}`);
    lines.push(`任务板: 共 ${tt.total}${parts.length ? `（${parts.join(' · ')}）` : ''}`);
  } else {
    lines.push('任务板: 不可用');
  }

  // cron 计划任务(诚实:无 next-run/durable/recurring 字段)。
  if (Array.isArray(s.cronJobs)) {
    const enabled = s.cronJobs.filter((j) => j && j.enabled !== false).length;
    lines.push(`计划任务(cron): 共 ${s.cronJobs.length}（启用 ${enabled}）`);
  } else {
    lines.push('计划任务(cron): 不可用');
  }

  // proactive idle-tick。
  if (typeof s.proactiveActive === 'boolean') {
    lines.push(`Proactive idle-tick: ${s.proactiveActive ? '活跃' : '未激活'}`);
  } else {
    lines.push('Proactive idle-tick: 不可用');
  }

  // 远端开发会话。
  if (s.remotedev && typeof s.remotedev === 'object' && s.remotedev.state) {
    lines.push(`远端会话: ${s.remotedev.state}`);
  } else {
    lines.push('远端会话: none');
  }

  lines.push('');
  lines.push('更多: /autonomy status --deep · /autonomy runs [N] · /autonomy flows [N] · /autonomy flow <id>');
  return lines.join('\n');
}

/**
 * status --deep 全量诊断:概览 + 每个自治面的逐项展开(仍只渲染真有的面)。
 * @param {object} snapshot 同 buildOverview,外加可选 runs 全量、cronJobs 全量。
 * @returns {string}
 */
function buildDeep(snapshot) {
  const s = snapshot || {};
  const out = [buildOverview(s), ''];

  out.push('── 编排运行明细 ──');
  if (Array.isArray(s.runs) && s.runs.length) {
    for (const r of s.runs.slice(-_DEFAULT_LIMIT)) out.push(_runLine(r));
  } else {
    out.push('  （无）');
  }

  out.push('');
  out.push('── 计划任务(cron)明细 ──');
  if (Array.isArray(s.cronJobs) && s.cronJobs.length) {
    for (const j of s.cronJobs) {
      const last = j && j.lastRunAt ? `  最近运行 ${j.lastRunAt}` : '';
      const en = j && j.enabled === false ? '[禁用]' : '[启用]';
      out.push(`  ${j.id} ${en}  ${j.cron || ''}${last}`);
    }
  } else {
    out.push('  （无）');
  }

  out.push('');
  out.push('── 权限模式 ──');
  out.push(`  当前:${s.permissionMode || '(未知)'}`);

  return out.join('\n');
}

/**
 * 近期 runs 列表(取最后 limit 条)。
 * @param {Array<object>} runs
 * @param {number} [limit]
 * @returns {string}
 */
function buildRunsList(runs, limit) {
  const n = _intArg(limit, _DEFAULT_LIMIT);
  if (!Array.isArray(runs) || runs.length === 0) return '编排运行: （无）';
  const slice = runs.slice(-n);
  return ['近期编排运行（最多 ' + n + ' 条）:'].concat(slice.map(_runLine)).join('\n');
}

/**
 * 近期 flows 列表 —— 与 runs 同源(khy 的「受管 flow」即编排 run);仅渲染含 control 的条目。
 * @param {Array<object>} flows
 * @param {number} [limit]
 * @returns {string}
 */
function buildFlowsList(flows, limit) {
  const n = _intArg(limit, _DEFAULT_LIMIT);
  if (!Array.isArray(flows) || flows.length === 0) return '受管 flow: （无）';
  const slice = flows.slice(-n);
  return ['近期受管 flow（最多 ' + n + ' 条）:'].concat(slice.map(_runLine)).join('\n');
}

/**
 * 单个 flow/run 详情。status 形如 getRunStatus 返回的 { runId, mode, label, control, progress, steps[] }。
 * @param {object} status
 * @returns {string}
 */
function buildFlowView(status) {
  if (!status || typeof status !== 'object') return 'flow 未找到。';
  const p = status.progress || {};
  const lines = [];
  lines.push(`Flow ${status.runId}`);
  lines.push(`  mode=${status.mode || ''} · control=${status.control || '?'} · ${_n(p.done)}/${_n(p.total)} done${_n(p.failed) ? ` · ${_n(p.failed)} failed` : ''}`);
  if (status.label) lines.push(`  目标: ${status.label}`);
  const steps = Array.isArray(status.steps) ? status.steps : [];
  if (steps.length) {
    lines.push('  步骤:');
    for (const st of steps) {
      const mark = st.error ? `✗ ${st.error}` : (st.result != null ? st.result : '');
      lines.push(`    - ${st.stepId} [${st.status}] ${st.role || ''} ${mark}`.replace(/\s+$/, ''));
    }
  }
  return lines.join('\n');
}

/**
 * 门控:KHY_AUTONOMY 默认开。falsy(0/false/off/no/空)→ 关。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env) {
  const e = env || {};
  const raw = e.KHY_AUTONOMY === undefined ? 'true' : e.KHY_AUTONOMY;
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  return !(s === '' || s === '0' || s === 'false' || s === 'off' || s === 'no');
}

module.exports = {
  parseAutonomyArgs,
  tallyRuns,
  tallyTasks,
  buildOverview,
  buildDeep,
  buildRunsList,
  buildFlowsList,
  buildFlowView,
  isEnabled,
  _DEFAULT_LIMIT,
  _MAX_LIMIT,
};

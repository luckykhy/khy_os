#!/usr/bin/env node
'use strict';

/**
 * parityScorecard.js — khy「vibe-coding / spec-coding 能力对齐 Claude Code」的
 * 可量化验收评分卡(Gate A：结构就绪度 / Structural Readiness）。
 *
 * 权威定义见 docs/08_MGMT_项目管理/[MGMT-STD-006]。该标准用**双闸模型**回答
 * 「什么时候可以真的确认 khy 能像 cc 一样做 vibe/spec-coding」：
 *   - Gate A（本脚本）：结构就绪度——khy 是否**具备**做这两件事的机制。可静态、
 *     可复现地量化(守卫/契约/闭环存在性)。是**必要非充分**条件。
 *   - Gate B（golden-task 基准，需人工/harness 跑）：实证对齐——khy 在一组
 *     代表性任务上**真的做到**的客观 pass 率。本脚本只**列出**Gate B 待办,不自动打分。
 *
 * 设计:只读、零副作用、fail-soft(任一维度探测失败记 0 分并附原因,绝不抛)。
 * 复用既有真实机制(toolContract 审计 / goalCore / planModeService / acceptanceCriteria
 * / deliveryGate / commandSchema 等),不新造判据。镜像 archDebtScan.js 的报告版式。
 *
 * 用法:
 *   node scripts/parityScorecard.js            # 人类可读表格
 *   node scripts/parityScorecard.js --json      # 机器可读 JSON(供 CI/release 消费)
 *   node scripts/parityScorecard.js --gate=0.9  # 覆盖 Gate A 通过阈值(默认 0.90)
 */

const path = require('path');

const BACKEND_ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.join(BACKEND_ROOT, '..', '..');

function req(rel) {
  // 相对 backend 根解析,避免受 cwd 影响。探测失败由调用方 fail-soft 兜。
  return require(path.join(BACKEND_ROOT, rel));
}

/** 每个 check 返回 { score, max, detail }。score<=max。绝不抛。 */
function safe(fn, max) {
  try {
    const r = fn();
    if (r && typeof r === 'object' && typeof r.score === 'number') {
      return { score: Math.max(0, Math.min(max, r.score)), max, detail: String(r.detail || '') };
    }
    return { score: 0, max, detail: 'check 返回形状异常' };
  } catch (e) {
    return { score: 0, max, detail: 'probe 失败: ' + String((e && e.message) || e).split('\n')[0] };
  }
}

function hasFns(mod, names) {
  return names.filter((n) => mod && typeof mod[n] === 'function');
}
function hasKeys(mod, names) {
  return names.filter((n) => mod && typeof mod[n] !== 'undefined');
}

// ─────────────────────────────────────────────────────────────────────
// VIBE 域:对话式 / 意图驱动 / 快速 agentic 循环
// ─────────────────────────────────────────────────────────────────────

// V1 Agentic 循环完整性:核心工具循环 + 迭代上限 + 收尾判据 + 流式退化守卫
function v1AgenticLoop() {
  const fs = require('fs');
  const loopPath = path.join(BACKEND_ROOT, 'src/services/toolUseLoop.js');
  if (!fs.existsSync(loopPath)) return { score: 0, detail: 'toolUseLoop.js 缺失' };
  const src = fs.readFileSync(loopPath, 'utf-8');
  const signals = {
    runToolUseLoop: /runToolUseLoop/.test(src),
    maxIterations: /max.?iteration|MAX_ITER|maxIter/i.test(src),
    streamGuard: /_streamRepGuard|_sawStreamedText|degenerat/i.test(src),
  };
  let closure = false;
  try { closure = !!req('src/services/projectCoherence/deliverableClosure'); } catch { closure = false; }
  const hit = Object.values(signals).filter(Boolean).length + (closure ? 1 : 0);
  return { score: hit, detail: 'loop=' + signals.runToolUseLoop + ' maxIter=' + signals.maxIterations + ' streamGuard=' + signals.streamGuard + ' closure=' + closure + ' (' + hit + '/4)' };
}

// V2 工具覆盖面:CC 基线核心工具是否齐备(比例)
function v2ToolCoverage() {
  const idx = req('src/tools/index');
  const names = new Set([...idx.getAll().keys()]);
  // Bash 的 canonical 名是 shellCommand;其余按注册名
  const CORE = ['Read', 'Write', 'Edit', 'MultiEdit', 'Grep', 'Glob', 'shellCommand',
    'Agent', 'WebFetch', 'WebSearch', 'TaskCreate', 'TodoWrite', 'Skill',
    'EnterPlanMode', 'ExitPlanMode', 'VerifyPlanExecution'];
  const present = CORE.filter((c) => names.has(c));
  const ratio = present.length / CORE.length;
  const missing = CORE.filter((c) => !names.has(c));
  return { score: ratio * 3, detail: '核心工具 ' + present.length + '/' + CORE.length + (missing.length ? ' 缺:' + missing.join(',') : '') + ' · 注册总数 ' + names.size };
}

// V3 工具契约洁净:契约审计 0 error(冲突/形状/schema),warning 仅报告
function v3ToolContract() {
  const { auditTools } = req('src/services/toolCatalog/toolContract');
  const r = auditTools();
  const errors = Number(r.errors) || 0;
  const warnings = Number(r.warnings) || 0;
  return { score: errors === 0 ? 2 : 0, detail: 'errors=' + errors + ' warnings=' + warnings + ' total=' + r.total + (errors === 0 ? ' ✓' : ' ✗ 存在契约冲突') };
}

// V4 收敛 / 有界终止:目标不会无限跑(轮次预算 + 终止态词汇)
function v4Convergence() {
  const g = req('src/services/goalCore');
  const need = ['isBounded', 'resolveMaxTurns', 'advanceGoalTurn'];
  const fns = hasFns(g, need);
  const terminal = Array.isArray(g.GOAL_TERMINAL_STATUSES) && g.GOAL_TERMINAL_STATUSES.length >= 3;
  const hit = fns.length + (terminal ? 1 : 0);
  return { score: hit >= 4 ? 2 : (hit >= 2 ? 1 : 0), detail: '有界函数 ' + fns.length + '/' + need.length + ' 终止态=' + terminal };
}

// V5 安全 / 权限门:多级审批 + 风险分类
function v5Safety() {
  const e = req('src/services/execApproval');
  const hasPerm = e && e.PERMISSION && typeof e.PERMISSION === 'object';
  const hasRisk = typeof e.classifyRisk === 'function';
  let router = false;
  try { router = !!req('src/services/syscallGateway/approvalRouter'); } catch { router = false; }
  const hit = (hasPerm ? 1 : 0) + (hasRisk ? 1 : 0) + (router ? 1 : 0);
  return { score: hit >= 2 ? 2 : hit, detail: 'PERMISSION=' + hasPerm + ' classifyRisk=' + hasRisk + ' approvalRouter=' + router + ' (' + hit + '/3)' };
}

// V6 自我认知:命令目录规模 + 自我定位
function v6SelfAwareness() {
  const { getBuiltinSlashCommands } = req('src/constants/commandSchema');
  const cmds = getBuiltinSlashCommands();
  const count = Array.isArray(cmds) ? cmds.length : 0;
  let selfLoc = false;
  try { const sl = req('src/services/selfLocation'); selfLoc = typeof sl.formatLocationForSystemPrompt === 'function'; } catch { selfLoc = false; }
  const ok = count >= 150 && selfLoc;
  return { score: ok ? 1 : (count >= 150 || selfLoc ? 0.5 : 0), detail: 'slash 命令 ' + count + ' 条 · selfLocation=' + selfLoc };
}

// ─────────────────────────────────────────────────────────────────────
// SPEC 域:规格 / 计划先行 · 可对照规格验证
// ─────────────────────────────────────────────────────────────────────

// S1 Plan mode:进入/退出/持久化/审批
function s1PlanMode() {
  const p = req('src/services/planModeService');
  const fns = hasFns(p, ['savePlan', 'loadPersistedPlan', 'listPersistedPlans']);
  const fs = require('fs');
  const enter = fs.existsSync(path.join(BACKEND_ROOT, 'src/tools/EnterPlanModeTool/index.js'));
  const exit = fs.existsSync(path.join(BACKEND_ROOT, 'src/tools/ExitPlanModeTool/index.js'));
  const hit = fns.length + (enter ? 1 : 0) + (exit ? 1 : 0);
  return { score: hit >= 4 ? 2 : (hit >= 2 ? 1 : 0), detail: 'planModeService ' + fns.length + '/3 · EnterPlanMode=' + enter + ' ExitPlanMode=' + exit };
}

// S2 计划执行验证:对照计划逐项核验 + runtime 证据
function s2PlanVerify() {
  const fs = require('fs');
  const tool = fs.existsSync(path.join(BACKEND_ROOT, 'src/tools/VerifyPlanExecutionTool/index.js'));
  // runtime-evidence 门控是 planModeService 内部函数(未 export,但已接进 executePlanSteps),
  // 故按源码存在性+接线判定,而非公开导出。
  let evidence = false;
  try {
    const src = fs.readFileSync(path.join(BACKEND_ROOT, 'src/services/planModeService.js'), 'utf-8');
    evidence = /function hasRuntimeEvidence/.test(src) && /function isStepExecutionFailure/.test(src) && /hasRuntimeEvidence\(reply\)/.test(src);
  } catch { evidence = false; }
  const hit = (tool ? 1 : 0) + (evidence ? 1 : 0);
  return { score: hit, detail: 'VerifyPlanExecution=' + tool + ' runtimeEvidence门控=' + evidence + '(内部接线)' };
}

// S3 规格→实现→对照验证闭环:acceptance pack + deliveryGate verdict + remediation 回灌
function s3SpecClosedLoop() {
  const ac = req('src/services/acceptanceCriteria');
  const dg = req('src/services/deliveryGate');
  const acOk = typeof ac.buildAcceptancePack === 'function';
  const evalOk = typeof dg.evaluateDelivery === 'function';
  const remedy = typeof dg.buildRemediationPrompt === 'function';
  const hit = (acOk ? 1 : 0) + (evalOk ? 1 : 0) + (remedy ? 1 : 0);
  return { score: hit >= 3 ? 3 : hit, detail: 'buildAcceptancePack=' + acOk + ' evaluateDelivery=' + evalOk + ' remediation=' + remedy + ' (' + hit + '/3)' };
}

// S4 任务分解 / 追踪:创建 + 依赖(blockedBy)
function s4TaskDecomp() {
  const idx = req('src/tools/index');
  const names = new Set([...idx.getAll().keys()]);
  const tools = ['TaskCreate', 'TaskList', 'TaskUpdate'].filter((t) => names.has(t));
  const fs = require('fs');
  const storePath = path.join(BACKEND_ROOT, 'src/tools/_taskStore.js');
  const blocked = fs.existsSync(storePath) && /blockedBy/.test(fs.readFileSync(storePath, 'utf-8'));
  const hit = tools.length + (blocked ? 1 : 0);
  return { score: hit >= 3 ? 2 : (hit >= 2 ? 1 : 0), detail: '任务工具 ' + tools.length + '/3 · blockedBy 依赖=' + blocked };
}

// S5 spec-driven 技能:SPECIFY→PLAN→TASKS→IMPLEMENT 分阶段 gated
function s5SpecSkill() {
  const fs = require('fs');
  const skill = path.join(BACKEND_ROOT, 'src/skills/built-in/spec-driven-development/prompt.md');
  if (!fs.existsSync(skill)) return { score: 0, detail: 'spec-driven-development 技能缺失' };
  const src = fs.readFileSync(skill, 'utf-8');
  const stages = ['SPECIFY', 'PLAN', 'TASKS', 'IMPLEMENT'].filter((s) => new RegExp(s, 'i').test(src));
  return { score: stages.length >= 4 ? 1 : (stages.length >= 2 ? 0.5 : 0), detail: '四阶段命中 ' + stages.length + '/4 (' + stages.join('→') + ')' };
}

// S6 外部编辑器编排:AgentTool subagent_type 含 claude/codex/opencode + 适配器齐备
function s6ExternalOrch() {
  const fs = require('fs');
  const atSrc = fs.readFileSync(path.join(BACKEND_ROOT, 'src/tools/AgentTool/index.js'), 'utf-8');
  const editors = ['claude', 'codex', 'opencode'].filter((e) => new RegExp("'" + e + "'", 'i').test(atSrc));
  const adapters = ['claudeAdapter', 'codexAdapter', 'opencodeAdapter'].filter((a) =>
    fs.existsSync(path.join(BACKEND_ROOT, 'src/services/gateway/adapters/' + a + '.js')));
  const hit = (editors.length >= 3 ? 1 : 0) + (adapters.length >= 3 ? 1 : 0);
  return { score: hit, detail: 'subagent 编辑器 ' + editors.length + '/3 · 专属适配器 ' + adapters.length + '/3' };
}

// ─────────────────────────────────────────────────────────────────────
// 横切:可验证性证据(测试规模)
// ─────────────────────────────────────────────────────────────────────
function x1TestScale() {
  const { execFileSync } = require('child_process');
  let nodeTest = 0;
  try {
    const out = execFileSync('bash', ['-c',
      "grep -rl --include=*.test.js 'node:test' " + JSON.stringify(BACKEND_ROOT) + "/src " + JSON.stringify(BACKEND_ROOT) + "/tests 2>/dev/null | wc -l"],
      { encoding: 'utf-8', timeout: 20000 });
    nodeTest = parseInt(String(out).trim(), 10) || 0;
  } catch { nodeTest = 0; }
  return { score: nodeTest >= 500 ? 1 : (nodeTest >= 200 ? 0.5 : 0), detail: 'node:test 文件 ' + nodeTest + ' 个(阈值 ≥500=满分)' };
}

// ─────────────────────────────────────────────────────────────────────
// 评分卡组装
// ─────────────────────────────────────────────────────────────────────
const DIMENSIONS = [
  { id: 'V1', domain: 'vibe', label: 'Agentic 循环完整性', max: 4, run: v1AgenticLoop },
  { id: 'V2', domain: 'vibe', label: '工具覆盖面(CC 基线)', max: 3, run: v2ToolCoverage },
  { id: 'V3', domain: 'vibe', label: '工具契约洁净(0 冲突)', max: 2, run: v3ToolContract },
  { id: 'V4', domain: 'vibe', label: '收敛/有界终止', max: 2, run: v4Convergence },
  { id: 'V5', domain: 'vibe', label: '安全/权限门', max: 2, run: v5Safety },
  { id: 'V6', domain: 'vibe', label: '自我认知/命令目录', max: 1, run: v6SelfAwareness },
  { id: 'S1', domain: 'spec', label: 'Plan mode(持久+审批)', max: 2, run: s1PlanMode },
  { id: 'S2', domain: 'spec', label: '计划执行验证', max: 2, run: s2PlanVerify },
  { id: 'S3', domain: 'spec', label: '规格→验证闭环(verdict)', max: 3, run: s3SpecClosedLoop },
  { id: 'S4', domain: 'spec', label: '任务分解/依赖', max: 2, run: s4TaskDecomp },
  { id: 'S5', domain: 'spec', label: 'spec-driven 技能', max: 1, run: s5SpecSkill },
  { id: 'S6', domain: 'spec', label: '外部编辑器编排', max: 2, run: s6ExternalOrch },
  { id: 'X1', domain: 'cross', label: '可验证性(测试规模)', max: 1, run: x1TestScale },
];

// Gate B 实证维度(本脚本不自动打分,仅提醒 golden-task 基准须跑)
const GATE_B = [
  'GB1 vibe golden-task 一次成型率(≥ 阈值)',
  'GB2 spec golden-task deliveryGate verdict=pass 率(≥ 阈值)',
  'GB3 计划执行 runtime-evidence 覆盖率',
  'GB4 需求原子项 → 实现 × 测试 覆盖率',
  'GB5 红线拒绝零漏(安全对照)',
];

function computeScorecard(opts) {
  const rows = DIMENSIONS.map((d) => {
    const r = safe(d.run, d.max);
    return { id: d.id, domain: d.domain, label: d.label, score: r.score, max: d.max, detail: r.detail };
  });
  const sum = (dom) => rows.filter((r) => dom === 'all' || r.domain === dom)
    .reduce((a, r) => ({ score: a.score + r.score, max: a.max + r.max }), { score: 0, max: 0 });
  const vibe = sum('vibe'), spec = sum('spec'), cross = sum('cross'), total = sum('all');
  const gate = opts.gate;
  const ratio = total.max ? total.score / total.max : 0;
  const vibeRatio = vibe.max ? vibe.score / vibe.max : 0;
  const specRatio = spec.max ? spec.score / spec.max : 0;
  // 判定:两域各须 ≥ gate 且总分 ≥ gate → Gate A PASS;任一 < gate*0.7 → FAIL;之间 PARTIAL
  let verdict;
  const floor = gate * 0.7;
  if (vibeRatio >= gate && specRatio >= gate && ratio >= gate) verdict = 'PASS';
  else if (vibeRatio < floor || specRatio < floor) verdict = 'FAIL';
  else verdict = 'PARTIAL';
  return { rows, vibe, spec, cross, total, ratio, vibeRatio, specRatio, gate, verdict, gateB: GATE_B };
}

function pct(n) { return (n * 100).toFixed(1) + '%'; }

function renderText(sc) {
  const L = [];
  L.push('');
  L.push('  khy ↔ Claude Code · vibe/spec-coding 能力对齐评分卡');
  L.push('  Gate A(结构就绪度 / Structural Readiness)· 权威标准 [MGMT-STD-006]');
  L.push('  ' + '─'.repeat(66));
  L.push('  维度   分/满   域    说明');
  L.push('  ' + '─'.repeat(66));
  for (const r of sc.rows) {
    const s = (r.score % 1 === 0 ? r.score.toFixed(0) : r.score.toFixed(1));
    const cell = (r.id + ' ' + r.label).padEnd(24, ' ').slice(0, 24);
    L.push('  ' + cell + ' ' + (s + '/' + r.max).padEnd(6) + r.domain.padEnd(6) + r.detail);
  }
  L.push('  ' + '─'.repeat(66));
  L.push('  VIBE 域: ' + sc.vibe.score.toFixed(1) + '/' + sc.vibe.max + ' (' + pct(sc.vibeRatio) + ')');
  L.push('  SPEC 域: ' + sc.spec.score.toFixed(1) + '/' + sc.spec.max + ' (' + pct(sc.specRatio) + ')');
  L.push('  总  分: ' + sc.total.score.toFixed(1) + '/' + sc.total.max + ' (' + pct(sc.ratio) + ') · 阈值 ' + pct(sc.gate));
  L.push('  Gate A 判定: ' + sc.verdict);
  L.push('');
  L.push('  Gate B(实证对齐 / 需 golden-task 基准跑,本脚本不自动打分):');
  for (const g of sc.gateB) L.push('    ☐ ' + g);
  L.push('');
  L.push('  ★ 真正「确认对齐」= Gate A PASS ∧ Gate B 全部达阈值。');
  L.push('    结构就绪是**必要非充分**:具备机制 ≠ 已证明能力。见 [MGMT-STD-006] §5。');
  L.push('');
  return L.join('\n');
}

function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  let gate = 0.90;
  for (const a of argv) { const m = /^--gate=([0-9.]+)$/.exec(a); if (m) gate = Math.max(0, Math.min(1, parseFloat(m[1]))); }
  const sc = computeScorecard({ gate });
  if (json) {
    process.stdout.write(JSON.stringify({
      standard: 'MGMT-STD-006', gateA: 'structural-readiness',
      gate, verdict: sc.verdict,
      total: sc.total, ratio: sc.ratio,
      domains: { vibe: { ...sc.vibe, ratio: sc.vibeRatio }, spec: { ...sc.spec, ratio: sc.specRatio }, cross: sc.cross },
      rows: sc.rows, gateB: sc.gateB,
    }, null, 2) + '\n');
  } else {
    process.stdout.write(renderText(sc));
  }
  // 退出码:PASS=0 / PARTIAL=0(就绪但未证明,非失败)/ FAIL=1(结构缺口)
  process.exit(sc.verdict === 'FAIL' ? 1 : 0);
}

if (require.main === module) main();

module.exports = { computeScorecard, DIMENSIONS, GATE_B };

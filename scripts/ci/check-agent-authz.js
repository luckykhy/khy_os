#!/usr/bin/env node
'use strict';

/**
 * check-agent-authz.js — 智能体工具授权一致性守卫（[DESIGN-AGENT-002]）。
 *
 * 判据：**「明确授予」原则是否被破坏** —— 一个智能体/角色没有被显式授予的工具，
 * 是否可能被获得。
 *
 * 本脚本逐项检查 [DESIGN-AGENT-002] §1 的七条红线：
 *   A2-1 未声明 ≠ 全权（formatAgentLine 不得对未声明者输出 "All tools"）
 *   A2-2 只读 profile / 只读 agent 不得持有 shell（Bash/shellCommand）写通道
 *   A2-3 授权解析不得 fail-open（未知 profile ⇒ 收敛，非放行）
 *   A2-4 声明面收窄必须有执行面强制（executeTool 必须查 agentContext denylist）
 *   A2-5 只读角色集合不得有两份不一致定义
 *   A2-6 提示词「你没有权限」必须与机制事实一致
 *   A2-7 权限判定失败不得静默降级为放行
 *
 * ── 阶段（PROCESS-008）─────────────────────────────────────────────────
 * **S1 观察期：只记录，不阻断。** 所有 finding 恒为 `severity: 'warning'`，
 * 退出码恒为 0。毕业按样本量计（S1 ≥200 样本 → S2 误报率 <10% → S3 可豁免），
 * 禁止直进 S3，禁止同时升两阶。
 *
 * ── 输出契约（与 scripts/ci 其余守卫一致）──────────────────────────────
 * `--json` 输出单行 JSON；其后仍追加 `Summary: N error(s), M warning(s)` 行。
 * 解析前须 `split(/\n(?=Summary:)/)[0]`。退出码：0 恒（S1 不阻断）；2 用法错误。
 *
 * ⚠ 判读纪律：本脚本做的是**源码文本扫描**，不做 AST。`docs/` 与生成物不在扫描面。
 *    只读 shim 会让文本扫描失真 —— 仓库纪律：跟随 re-export shim 读真实文件。
 */

const fs = require('fs');
const path = require('path');

const RULE_ID = 'RUNTIME-010';
const STAGE = 'S1';

const REPO_ROOT = process.env.KHY_RULEGUARD_ROOT
  ? path.resolve(process.env.KHY_RULEGUARD_ROOT)
  : path.resolve(__dirname, '..', '..');

const findings = [];

/** 追加一条 finding。S1 阶段 severity 恒为 warning（只记录不阻断）。 */
function add(checkId, file, message, detail = '') {
  findings.push({
    severity: 'warning', // [DESIGN-AGENT-002] S1 观察期：恒定降级
    rule: RULE_ID,
    stage: STAGE,
    check: checkId,
    file,
    message,
    detail,
  });
}

/**
 * 读文件（相对仓库根）。缺失返回 null。
 * ⚠ 根目录字面量 `nul` 会让某些遍历崩 —— 本脚本只读**点名的**文件，不做目录遍历。
 * @param {string} rel
 * @returns {string|null}
 */
function readText(rel) {
  const abs = path.join(REPO_ROOT, rel);
  try {
    if (!fs.existsSync(abs)) {
      return null;
    }
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

function readJson(rel) {
  const text = readText(rel);
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const SHELL_NAMES = ['Bash', 'bash', 'shellCommand', 'shell_command'];

// ── A2-2: 只读 profile 不得含 shell ─────────────────────────────────────
function checkA2_2_readOnlyProfileHasNoShell() {
  const rel = 'services/backend/src/tools/toolProfile.js';
  const text = readText(rel);
  if (!text) {
    add('A2-2', rel, '文件不存在：无法核对只读 profile 的授权面。');
    return;
  }
  // 定位 explore profile 的 tools 数组块。
  const m = text.match(/explore:\s*\{[\s\S]*?tools:\s*\[([\s\S]*?)\]/);
  if (!m) {
    add('A2-2', rel, '未能定位 explore profile 的 tools 数组（结构可能已变，请人工核对）。');
    return;
  }
  const body = m[1];
  for (const shell of SHELL_NAMES) {
    const re = new RegExp(`['"]${shell}['"]`);
    if (re.test(body)) {
      add(
        'A2-2',
        rel,
        `只读 profile 'explore' 仍含 shell 工具 '${shell}'：读-only 角色可借此写文件 / 改系统状态。`,
        'A2-2 要求只读授权面不含任何写通道。若某角色确需跑命令，应显式授予 verification profile。'
      );
    }
  }
}

// ── A2-2: 只读 agent 定义不得缺 shell 拒绝 ──────────────────────────────
const READ_ONLY_AGENT_FILES = [
  'services/backend/src/agents/built-in/exploreAgent.js',
  'services/backend/src/agents/built-in/readingAgent.js',
  'services/backend/src/agents/built-in/mapAgent.js',
  'services/backend/src/agents/built-in/auditAgent.js',
  'services/backend/src/agents/built-in/planAgent.js',
];

function checkA2_2_readOnlyAgentsDenyShell() {
  for (const rel of READ_ONLY_AGENT_FILES) {
    const text = readText(rel);
    if (!text) {
      add('A2-2', rel, '只读 agent 文件不存在（清单可能已过期，请核对）。');
      continue;
    }
    // 反模式：把常量数组**不展开**地塞进 disallowedTools，
    // `disallowedTools: [..., SHELL_TOOL_NAMES]` ⇒ 产生嵌套数组 ⇒ deny 匹配失效。
    // 这是"看起来加了拒绝、实际没生效"的假修补，文本扫描的经典盲区。
    if (/\n\s+SHELL_TOOL_NAMES,/.test(text)) {
      add(
        'A2-2',
        rel,
        'disallowedTools 中 SHELL_TOOL_NAMES 未用展开运算符（缺 ...）：会产生嵌套数组，拒绝失效。',
        '必须写成 `...SHELL_TOOL_NAMES,`。嵌套数组会让 deny 匹配静默失败 —— 假修补。'
      );
    }

    // 只读 agent 的授权面：要么没有 shell 提及（说明已彻底移除），
    // 要么在 disallowedTools 里显式拒绝 shell，要么经由 SHELL_TOOL_NAMES 常量注入。
    const deniesShellLiteral = SHELL_NAMES.some((s) => {
      const inDeny = new RegExp(
        `disallowedTools:\\s*\\[[\\s\\S]*?['"]${s}['"][\\s\\S]*?\\]`
      );
      return inDeny.test(text);
    });
    const deniesViaConstant = /\.\.\.SHELL_TOOL_NAMES/.test(text);
    const hasShellMention = SHELL_NAMES.some((s) => new RegExp(`['"]${s}['"]`).test(text));

    if (hasShellMention && !deniesShellLiteral && !deniesViaConstant) {
      add(
        'A2-2',
        rel,
        '只读 agent 提到了 shell 工具但未在 disallowedTools 中显式拒绝。',
        '授权面必须显式 —— 提示词里的「不要用 Bash」不构成机制拒绝。'
      );
    }
  }
}

// ── A2-3: 授权解析不得 fail-open ────────────────────────────────────────
function checkA2_3_noFailOpen() {
  const rel = 'services/backend/src/tools/toolProfile.js';
  const text = readText(rel);
  if (!text) {
    return;
  }
  // 反例：`if (!allowed) { return toolsMap; }` —— 未知 profile 放行。
  const failOpen = /if\s*\(\s*!allowed\s*\)\s*\{\s*return\s+toolsMap\s*;?\s*\}/;
  if (failOpen.test(text)) {
    add(
      'A2-3',
      rel,
      'filterToolsByProfile 对未知 profile 返回原 map（fail-open）：写错 profile 名即全权放行。',
      'A2-3 要求未知 profile 收敛为拒绝，而不是放行。'
    );
  }
  // 反例注释：`// unknown profile = full access`
  if (/unknown\s+profile\s*=\s*full\s+access/i.test(text)) {
    add('A2-3', rel, '仍存在「unknown profile = full access」语义（注释或实现）。');
  }
}

// ── A2-1: 未声明不得等于全权 ────────────────────────────────────────────
function checkA2_1_undeclaredIsNotAllTools() {
  const rel = 'services/backend/src/agents/builtInAgents.js';
  const text = readText(rel);
  if (!text) {
    return;
  }
  // 反例：最后的 else 分支直接赋 'All tools'
  const hasBareAllTools = /toolsDescription\s*=\s*['"]All tools['"]\s*;/.test(text);
  if (hasBareAllTools) {
    add(
      'A2-1',
      rel,
      'formatAgentLine 对「既无 tools 又无 disallowedTools」的 agent 输出 "All tools"。',
      'A2-1：未声明授权面不得被展示为全权；应输出警告并要求作者补白名单。'
    );
  }
}

// ── A2-4: 声明面收窄必须有执行面强制 ────────────────────────────────────
function checkA2_4_executionBoundaryEnforcesScope() {
  const rel = 'services/backend/src/services/tool/toolCalling.js';
  const text = readText(rel);
  if (!text) {
    add('A2-4', rel, '执行漏斗文件不存在：无法核对执行面强制。');
    return;
  }
  if (!/_agentContext/.test(text)) {
    add(
      'A2-4',
      rel,
      'executeTool 未读取 traceContext._agentContext：子代理 denylist 只在定义面生效，执行面不拦。',
      'A2-4：声明面收窄必须与执行面强制配对，否则被禁工具仍可被直接点名调用。'
    );
  }
}

// ── A2-5: 只读角色集合需单一真源 ────────────────────────────────────────
// 权威 role 词表来自 taskDecomposer._inferRole（见 mergeRoleAttribution.js
// 的 _ROLE_LABELS）：implement / verify / explore / general。
// 两个消费者必须对该词表内的只读角色（explore / verify）给出一致处置：
//   - roleToolScope 剥其写工具（verify 保留 shell）
//   - AgentTool 给其只读 profile（verify 除外，explore profile 无 shell）
// 词表外的角色（planner/reading/map/audit/research…）是工具直调时的扩展名，
// 不要求两侧同名 —— 只要求**权威词表内的角色**不出现矛盾处置。
const AUTHORITATIVE_READ_ONLY_ROLES = ['explore', 'verify'];

function checkA2_5_singleRoleSet() {
  const scopeRel = 'services/backend/src/services/domain/state/orchestrator/roleToolScope.js';
  const agentRel = 'services/backend/src/tools/AgentTool/index.js';
  const scopeText = readText(scopeRel);
  const agentText = readText(agentRel);
  if (!scopeText || !agentText) {
    return;
  }

  const scopeSetMatch = scopeText.match(/_READ_ONLY_ROLES\s*=\s*new\s+Set\(\[([^\]]*)\]/);
  const scopeRoles = new Set(
    scopeSetMatch ? (scopeSetMatch[1].match(/'([^']+)'/g) || []).map((s) => s.replace(/'/g, '')) : []
  );

  const agentSetMatch = agentText.match(/_EXPLORE_PROFILE_ROLES\s*=\s*new\s+Set\(\[([^\]]*)\]/);
  if (!agentSetMatch) {
    if (/toolFilter:\s*[\s\S]{0,400}role\s*===\s*'explore'/.test(agentText)) {
      add(
        'A2-5',
        agentRel,
        'toolFilter 仍由内联 ||-链决定角色集合，与 roleToolScope 各行其是（无单一真源）。',
        'A2-5：同一个「只读角色」概念不得有两份独立定义。'
      );
    }
    return;
  }
  const agentRoles = new Set((agentSetMatch[1].match(/'([^']+)'/g) || []).map((s) => s.replace(/'/g, '')));

  // 权威词表内的只读角色：必须两侧都认得（else 一侧漏、另一侧收，即矛盾）。
  for (const role of AUTHORITATIVE_READ_ONLY_ROLES) {
    const inScope = scopeRoles.has(role);
    if (!inScope) {
      add(
        'A2-5',
        scopeRel,
        `权威 role 词表内的只读角色 '${role}' 不在 roleToolScope._READ_ONLY_ROLES 中：该角色的写工具不会被剥。`,
        'A2-5：权威词表（taskDecomposer._inferRole）内的只读角色必须有明确处置。'
      );
    }
  }

  // explore 必须拿到只读 profile；verify 有意不拿（explore profile 无 shell，
  // verify 要跑 build/test）。若 explore 缺失，则是漏接线。
  if (!agentRoles.has('explore')) {
    add(
      'A2-5',
      agentRel,
      "AgentTool 的 explore-profile 角色集不含 'explore'：只读探针拿不到只读白名单。",
      'A2-5：只读角色必须落到只读 profile。'
    );
  }
}

// ── A2-7: 权限判定失败不得静默降级 ──────────────────────────────────────
function checkA2_7_noSilentDegradation() {
  const rel = 'services/backend/src/cli/aiMessageBuilder.js';
  const text = readText(rel);
  if (!text) {
    return;
  }
  // 反例：裸 catch 把 toolDefs 置空却不记录。
  const bareCatch = /catch\s*(?:\([^)]*\))?\s*\{\s*toolDefs\s*=\s*undefined\s*;?\s*\}/;
  if (bareCatch.test(text)) {
    add(
      'A2-7',
      rel,
      '工具作用域解析异常被裸 catch 吞掉（toolDefs = undefined），无任何记录。',
      'A2-7：授权故障必须留痕（台账），不得静默变成「无工具」。'
    );
  }
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(
      'check-agent-authz.js — 智能体工具授权一致性守卫（[DESIGN-AGENT-002] / RUNTIME-010，阶段 S1）\n' +
        '  --json     单行 JSON 输出（其后仍追加 Summary: 行）\n' +
        '  --changed  接受该参数以便挂入 commit 门（本守卫为全仓一致性检查，\n' +
        '             不按改动集裁剪 —— 授权面是全局不变量，单点改动可能破坏别处的一致性）\n' +
        '  S1 观察期：只记录不阻断，退出码恒为 0。\n'
    );
    return;
  }
  const asJson = argv.includes('--json');

  checkA2_1_undeclaredIsNotAllTools();
  checkA2_2_readOnlyProfileHasNoShell();
  checkA2_2_readOnlyAgentsDenyShell();
  checkA2_3_noFailOpen();
  checkA2_4_executionBoundaryEnforcesScope();
  checkA2_5_singleRoleSet();
  checkA2_7_noSilentDegradation();

  const errorsCount = findings.filter((f) => f.severity === 'error').length;
  const warnsCount = findings.length - errorsCount;

  if (asJson) {
    process.stdout.write(
      JSON.stringify({
        rule: RULE_ID,
        stage: STAGE,
        advisory: true,
        checks: 7,
        findings,
        errorCount: errorsCount,
        warningCount: warnsCount,
      }) + '\n'
    );
  } else if (!findings.length) {
    process.stdout.write(
      `check-agent-authz 通过（阶段 ${STAGE}）：7 项授权一致性判据均未发现偏差。\n`
    );
  } else {
    for (const f of findings) {
      process.stderr.write(`[WARN ] ${f.rule} ${f.check} ${f.file}\n  ${f.message}\n`);
    }
  }

  process.stdout.write(`Summary: ${errorsCount} error(s), ${warnsCount} warning(s)\n`);

  // S1 观察期：不阻断。退出码恒 0（--help 走 return 也是 0）。
  process.exitCode = 0;
}

main();

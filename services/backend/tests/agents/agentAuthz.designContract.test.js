'use strict';
/**
 * agentAuthz.designContract.test.js — [DESIGN-AGENT-002] 授权一致性契约测试。
 *
 * 契约：**明确授予原则** —— 没有被显式授予的工具不得可被获得。
 *
 * 本文件把 2026-09-22 落地的修补固化下来，防止回退：
 *   A2-1 未声明 ≠ 全权（formatAgentLine 不再输出裸 'All tools'）
 *   A2-2 只读 profile / 只读 agent 不持有 shell 写通道
 *   A2-3 授权解析 fail-closed（未知 profile ⇒ 空集，不是全量）
 *   A2-4 执行面强制（executeTool 读 traceContext._agentContext.disallowedTools）
 *
 * node:test（与同目录 tests/agents/*.test.js 同运行器：`node --test`）。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const SRC = path.resolve(__dirname, '..', '..', 'src');

// ── A2-3: fail-closed ──────────────────────────────────────────────────
test('A2-3: unknown profile yields NO tools, not all tools', () => {
  const { filterToolsByProfile, getProfileTools } = require(path.join(SRC, 'tools/toolProfile'));
  const registry = new Map([
    ['Read', { aliases: [] }],
    ['Edit', { aliases: [] }],
    ['Bash', { aliases: [] }],
  ]);

  const filtered = filterToolsByProfile(registry, 'no-such-profile-zzz');
  assert.strictEqual(filtered.size, 0, '未知 profile 必须收敛为空集，不得放行');

  const tools = getProfileTools('no-such-profile-zzz');
  assert.deepStrictEqual(tools, [], '未知 profile 的工具列表必须为空');
});

test('A2-3: explicit "full" is still the only all-tools path', () => {
  const { filterToolsByProfile, getProfileTools } = require(path.join(SRC, 'tools/toolProfile'));
  const registry = new Map([
    ['Read', { aliases: [] }],
    ['Edit', { aliases: [] }],
  ]);
  assert.strictEqual(filterToolsByProfile(registry, 'full').size, 2);
  assert.strictEqual(getProfileTools('full'), null, 'full 仍以 null 表示不过滤');
});

// ── A2-2: 只读 profile 无 shell ────────────────────────────────────────
test('A2-2: the read-only explore profile carries no shell channel', () => {
  const { getProfileTools, PROFILES } = require(path.join(SRC, 'tools/toolProfile'));
  const tools = getProfileTools('explore');
  for (const shell of ['Bash', 'bash', 'shellCommand', 'shell_command']) {
    assert.ok(!tools.includes(shell), `explore profile 不得含 ${shell}（写通道）`);
  }
  // 描述与实际必须一致（A2-6）。
  assert.match(PROFILES.explore.description, /read-only/i);
});

test('A2-2: verification profile DOES grant shell (explicit, for build/test)', () => {
  const { getProfileTools } = require(path.join(SRC, 'tools/toolProfile'));
  const tools = getProfileTools('verification');
  const hasShell = ['Bash', 'bash', 'shellCommand', 'shell_command'].some((s) => tools.includes(s));
  assert.ok(hasShell, 'verification 需要 shell 跑 build/test —— 这是显式授予');
});

// ── A2-2: 只读 agent 机制拒绝 shell ────────────────────────────────────
test('A2-2: read-only built-in agents explicitly deny the shell channel', () => {
  const files = [
    'exploreAgent',
    'readingAgent',
    'mapAgent',
    'auditAgent',
    'planAgent',
  ];
  for (const name of files) {
    const mod = require(path.join(SRC, `agents/built-in/${name}.js`));
    const def = Object.values(mod).find((v) => v && typeof v === 'object' && v.disallowedTools);
    assert.ok(def, `${name}: 未找到带 disallowedTools 的定义`);
    const deniesShell = ['Bash', 'bash', 'shellCommand', 'shell_command'].some((s) =>
      def.disallowedTools.includes(s)
    );
    assert.ok(deniesShell, `${name}: 只读 agent 必须机制拒绝 shell，而非仅提示词约束`);
  }
});

// ── A2-1: 未声明不得等于全权 ───────────────────────────────────────────
test('A2-1: an undeclared agent is not advertised as "All tools"', () => {
  const { formatAgentLine } = require(path.join(SRC, 'agents/builtInAgents'));
  const line = formatAgentLine({ agentType: 'ghost', whenToUse: 'no declarations' });
  assert.ok(!/\(Tools: All tools\)/.test(line), '未声明授权面不得被展示为裸 All tools');
  assert.match(line, /WARNING|undeclared/i, '应显式警告授权面未声明');
});

test('A2-1: declarative agents still render their allow-list', () => {
  const { formatAgentLine } = require(path.join(SRC, 'agents/builtInAgents'));
  const line = formatAgentLine({
    agentType: 'reader',
    whenToUse: 'reads',
    tools: ['Read', 'Grep'],
  });
  assert.match(line, /Read, Grep/);
});

// ── A2-4: 执行面强制 ───────────────────────────────────────────────────
test('A2-4: executeTool blocks a tool named in traceContext._agentContext.disallowedTools', async () => {
  const { executeTool } = require(path.join(SRC, 'services/tool/toolCalling'));
  const res = await executeTool('Edit', { file_path: 'x.txt' }, {
    _agentContext: { role: 'explore', disallowedTools: ['Edit', 'Write', 'NotebookEdit', 'Bash'] },
  });
  assert.strictEqual(res.success, false, '执行面必须拒绝被授权作用域禁用的工具');
  assert.match(String(res.error), /authorization scope|disallowedTools/i);
});

test('A2-4: the scope gate matches aliases too (bash vs Bash)', async () => {
  const { executeTool } = require(path.join(SRC, 'services/tool/toolCalling'));
  const res = await executeTool('bash', { command: 'echo hi > f' }, {
    _agentContext: { role: 'explore', disallowedTools: ['Bash'] },
  });
  assert.strictEqual(res.success, false, '别名拼写不得绕过执行面授权作用域');
});

// ── A2-7: 台账存在且绝不抛 ─────────────────────────────────────────────
test('A2-7: the authz failure ledger records without throwing', () => {
  const os = require('os');
  const fs = require('fs');
  const prev = process.env.KHY_AUTHZ_LEDGER;
  const target = path.join(os.tmpdir(), `authz-ledger-${Date.now()}.jsonl`);
  process.env.KHY_AUTHZ_LEDGER = target;
  try {
    const { recordAuthzFailure, readAuthzFailures } = require(
      path.join(SRC, 'services/domain/state/orchestrator/authzFailureLedger')
    );
    assert.strictEqual(recordAuthzFailure({ where: 'test', role: 'explore' }), true);
    const rows = readAuthzFailures();
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].where, 'test');
    // 畸形输入绝不抛（S1 只记录，不得影响主流程）。
    assert.doesNotThrow(() => recordAuthzFailure(null));
    assert.doesNotThrow(() => recordAuthzFailure('nope'));
  } finally {
    if (prev === undefined) {
      delete process.env.KHY_AUTHZ_LEDGER;
    } else {
      process.env.KHY_AUTHZ_LEDGER = prev;
    }
    try {
      fs.rmSync(target, { force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

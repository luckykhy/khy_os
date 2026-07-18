'use strict';

/**
 * researchReadingMap.test.js (node:test)
 *
 * Goal「还有研究子智能体，阅读子智能体，map 子智能体，我希望 khyos 同样能拥有」.
 * Three new READ-ONLY built-in sub-agents, siblings of the Explore/Plan/audit
 * family:
 *   - research — multi-source investigator (local code + live web + synthesis),
 *   - reading  — deep-comprehension of specified files/documents,
 *   - map      — codebase-structure cartographer aligned with .ai/MAP.md.
 * These tests pin the contract:
 *   - each definition is read-only (denies Edit/Write/NotebookEdit/Agent/ExitPlanMode)
 *     and uses model:'inherit' (no hardcoded tier alias),
 *   - research retains WebSearch/WebFetch after the denylist,
 *   - map's prompt aligns its output with the repo's .ai/MAP.md skeleton,
 *   - they are registered behind enableResearch/enableReading/enableMap,
 *   - AgentTool exposes them as subagent_type + sub-task role and routes them
 *     to read-only role handling,
 *   - role aliasing + proactive role inference route the intents correctly
 *     WITHOUT stealing the existing explore bucket (研究/调研 stays explore).
 * Pure (no spawning, no model calls) — fully unit-testable.
 */

const test = require('node:test');
const assert = require('node:assert');

const { RESEARCH_AGENT, getResearchSystemPrompt } = require('../../src/agents/built-in/researchAgent');
const { READING_AGENT, getReadingSystemPrompt } = require('../../src/agents/built-in/readingAgent');
const { MAP_AGENT, getMapSystemPrompt } = require('../../src/agents/built-in/mapAgent');
const { getBuiltInAgents, formatAgentLine } = require('../../src/agents/builtInAgents');
const claudeCompat = require('../../src/services/claudeCompat');
const agentTool = require('../../src/tools/AgentTool');
const { inferRole } = require('../../src/services/proactiveCollaboration/delegationPlanner');

const READ_ONLY_DENIED = ['Edit', 'Write', 'NotebookEdit', 'Agent', 'ExitPlanMode'];

// ── agent definition shape ──────────────────────────────────────────────────

test('the three agents are read-only definitions with model:inherit', () => {
  const cases = [
    [RESEARCH_AGENT, 'research'],
    [READING_AGENT, 'reading'],
    [MAP_AGENT, 'map'],
  ];
  for (const [agent, type] of cases) {
    assert.strictEqual(agent.agentType, type, `agentType ${type}`);
    assert.strictEqual(agent.source, 'built-in', `${type} source`);
    assert.strictEqual(agent.baseDir, 'built-in', `${type} baseDir`);
    // model:'inherit' deliberately avoids pinning a bare tier alias (e.g. 'haiku').
    assert.strictEqual(agent.model, 'inherit', `${type} model`);
    assert.strictEqual(agent.omitClaudeMd, true, `${type} omitClaudeMd`);
    for (const denied of READ_ONLY_DENIED) {
      assert.ok(agent.disallowedTools.includes(denied), `${type} denies ${denied}`);
    }
    // Read-only repo inspection (git log/diff) stays available: Bash is NOT denied.
    assert.ok(!agent.disallowedTools.includes('Bash'), `${type} keeps Bash`);
    // Never a hardcoded allowlist that would strip the read tools.
    assert.ok(!Array.isArray(agent.tools) || agent.tools.length === 0, `${type} has no allowlist`);
  }
});

test('research keeps web access after the read-only denylist', () => {
  // The denylist must not touch WebSearch/WebFetch — research is code + web + synthesis.
  for (const web of ['WebSearch', 'WebFetch']) {
    assert.ok(!RESEARCH_AGENT.disallowedTools.includes(web), `research keeps ${web}`);
  }
});

test('each system prompt is read-only and role-appropriate', () => {
  const research = getResearchSystemPrompt();
  const reading = getReadingSystemPrompt();
  const map = getMapSystemPrompt();

  for (const [name, p] of [['research', research], ['reading', reading], ['map', map]]) {
    assert.ok(typeof p === 'string' && p.length > 200, `${name} prompt non-trivial`);
    // Read-only contract shared across the family.
    assert.match(p, /read-only|READ-ONLY/i, `${name} prompt read-only`);
    assert.match(p, /Edit|Write|NotebookEdit/, `${name} prompt names mutating tools`);
  }

  // research: local-first, then web, then Sources.
  assert.match(research, /WebFetch/);
  assert.match(research, /WebSearch/);
  assert.match(research, /Sources:/);
  assert.match(research, /cross-check|cross check/i);

  // reading: read whole files, cite file:line, do not invent.
  assert.match(reading, /whole|end-to-end/i);
  assert.match(reading, /file:line/);
  assert.match(reading, /never invent|NEVER invent/i);

  // map: aligned with .ai/MAP.md skeleton, must NOT write files.
  assert.match(map, /\.ai\/MAP\.md/);
  assert.match(map, /## Tech Stack/);
  assert.match(map, /## Entry Points/);
  assert.match(map, /## Build \/ Run \/ Test/);
  assert.match(map, /## Directory Tree/);
  assert.match(map, /## Key Symbols/);
  assert.match(map, /do NOT .*write|not .*khy metadata refresh/i);
});

test('getSystemPrompt returns the exported prompt builders', () => {
  assert.strictEqual(RESEARCH_AGENT.getSystemPrompt(), getResearchSystemPrompt());
  assert.strictEqual(READING_AGENT.getSystemPrompt(), getReadingSystemPrompt());
  assert.strictEqual(MAP_AGENT.getSystemPrompt(), getMapSystemPrompt());
});

// ── registry registration (enable* gates) ─────────────────────────────────────

test('the three agents are registered by default and each removable via its gate', () => {
  const byType = t => getBuiltInAgents().find(a => a.agentType === t);
  assert.strictEqual(byType('research'), RESEARCH_AGENT);
  assert.strictEqual(byType('reading'), READING_AGENT);
  assert.strictEqual(byType('map'), MAP_AGENT);

  assert.strictEqual(
    getBuiltInAgents({ enableResearch: false }).find(a => a.agentType === 'research'),
    undefined, 'research absent when gate off');
  assert.strictEqual(
    getBuiltInAgents({ enableReading: false }).find(a => a.agentType === 'reading'),
    undefined, 'reading absent when gate off');
  assert.strictEqual(
    getBuiltInAgents({ enableMap: false }).find(a => a.agentType === 'map'),
    undefined, 'map absent when gate off');

  // Gating one does not remove the others.
  const onlyMapOff = getBuiltInAgents({ enableMap: false });
  assert.ok(onlyMapOff.find(a => a.agentType === 'research'));
  assert.ok(onlyMapOff.find(a => a.agentType === 'reading'));
});

test('formatAgentLine renders each as an all-tools-except (read-only) line', () => {
  for (const [agent, type] of [[RESEARCH_AGENT, 'research'], [READING_AGENT, 'reading'], [MAP_AGENT, 'map']]) {
    const line = formatAgentLine(agent);
    assert.match(line, new RegExp(`^- ${type}:`), `${type} line prefix`);
    assert.match(line, /All tools except .*Edit/, `${type} read-only tool summary`);
  }
});

// ── AgentTool spawn surface ───────────────────────────────────────────────────

test('AgentTool exposes research/reading/map as subagent_type and sub-task roles', () => {
  const schema = agentTool.inputSchema;
  const typeEnum = schema.properties.subagent_type.enum;
  for (const t of ['research', 'Research', 'reading', 'Reading', 'map', 'Map']) {
    assert.ok(typeEnum.includes(t), `subagent_type enum includes ${t}`);
  }
  const roleEnum = schema.properties.subtasks.items.properties.role.enum;
  for (const r of ['research', 'reading', 'map']) {
    assert.ok(roleEnum.includes(r), `role enum includes ${r}`);
  }
});

test('AgentTool prompt() documents the three new read-only types', () => {
  const prompt = agentTool.prompt();
  assert.match(prompt, /"research"/);
  assert.match(prompt, /"reading"/);
  assert.match(prompt, /"map"/);
  assert.match(prompt, /research[\s\S]*Sources:/i);
  assert.match(prompt, /map[\s\S]*\.ai\/MAP\.md/i);
});

// ── role aliasing + proactive role inference ──────────────────────────────────

test('normalizeAgentRole maps the aliases to research/reading/map', () => {
  for (const alias of ['research', 'researcher', 'RESEARCH']) {
    assert.strictEqual(claudeCompat.normalizeAgentRole(alias), 'research', `alias ${alias}`);
  }
  for (const alias of ['reading', 'reader', 'READER']) {
    assert.strictEqual(claudeCompat.normalizeAgentRole(alias), 'reading', `alias ${alias}`);
  }
  for (const alias of ['map', 'cartographer', 'MAP']) {
    assert.strictEqual(claudeCompat.normalizeAgentRole(alias), 'map', `alias ${alias}`);
  }
});

test('proactive inferRole routes reading/map intents without stealing explore', () => {
  // New narrow buckets fire on explicit intent.
  assert.strictEqual(inferRole('通读这个文件'), 'reading');
  assert.strictEqual(inferRole('read through the parser'), 'reading');
  assert.strictEqual(inferRole('给代码库画一张架构地图'), 'map');
  assert.strictEqual(inferRole('map the codebase'), 'map');
  assert.strictEqual(inferRole('梳理整体结构'), 'map');

  // Honest boundary: 研究/调研 stays explore (research uses the explicit subagent_type path).
  assert.strictEqual(inferRole('调研三个框架'), 'explore');
  assert.strictEqual(inferRole('研究一下这个库'), 'explore');

  // Neighbours untouched.
  assert.strictEqual(inferRole('编写后端 API'), 'implement');
  assert.strictEqual(inferRole('分析性能瓶颈'), 'planner');
  assert.strictEqual(inferRole('添加单元测试'), 'verify');
});

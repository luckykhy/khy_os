'use strict';

// keyFindings — milestone-level "关键节点主动汇报" (key-findings reporter).
//
// The per-tool narration in toolPrefaceVoice.js is mechanical ("正在读取…",
// "好，N 个条目"). This module adds the MISSING milestone layer the user asked
// for as a code-level capability: during execution the agent surfaces real
// findings instead of going silent until the end. Four finding types:
//
//   1. 测试结果   — DETERMINISTIC: parse a test runner's output (jest / vitest /
//                   pytest / go test / cargo test / mocha / node:test) into
//                   pass/fail counts + failing names. Owned entirely here.
//   2. 根因       — SEMANTIC: the model emits <finding type="root_cause">…</finding>.
//   3. 突破       — SEMANTIC: <finding type="breakthrough">…</finding>.
//   4. 受阻+下一步 — SEMANTIC: <finding type="blocked">…</finding>.
//
// The model-emitted half mirrors the existing <execution_plan> convention
// (toolUseLoop.js _parseExecutionPlan / _stripExecutionPlan): the loop parses
// the tag, strips it from displayed text, and a consumer renders the formatted
// report. This module is a PURE LEAF — no requires, env-gated, unit-testable.
//
// Env gates (default ON, `0/false/off/no` disables — mirrors KHY_OUTCOME_HINT):
//   KHY_KEY_FINDINGS        master switch for the whole feature
//   KHY_KEY_FINDINGS_TESTS  deterministic test-result detection
//   KHY_KEY_FINDINGS_MODEL  model <finding> parsing + prompt injection
//   KHY_KEY_FINDINGS_DEGENERATE_GUARD  drop <finding> blocks whose body is a
//                           non-finding (a bare negation / triviality note like
//                           "无" or "这是简单笑话请求"). Prevents "💡 突破：无".

// ── env helper (local copy so the module has zero deps) ──────────────────────
function _flagEnabled(rawValue, defaultValue = true) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '') return defaultValue;
  const v = String(rawValue).trim().toLowerCase();
  if (['1', 'true', 'on', 'yes', 'y'].includes(v)) return true;
  if (['0', 'false', 'off', 'no', 'n'].includes(v)) return false;
  return defaultValue;
}

function keyFindingsEnabled(env = process.env) {
  return _flagEnabled(env && env.KHY_KEY_FINDINGS, true);
}
function testFindingsEnabled(env = process.env) {
  return keyFindingsEnabled(env) && _flagEnabled(env && env.KHY_KEY_FINDINGS_TESTS, true);
}
function modelFindingsEnabled(env = process.env) {
  return keyFindingsEnabled(env) && _flagEnabled(env && env.KHY_KEY_FINDINGS_MODEL, true);
}
// Child of the model-findings gate: when a finding survives parsing it must be a
// real milestone. A model handling a trivial conversational turn (e.g. "讲个
// 笑话") sometimes dumps its own reasoning into a tag — `<finding
// type="breakthrough">无，这是简单笑话请求</finding>` — which surfaces as the
// nonsense line "💡 突破：无". This guard drops such degenerate bodies. Default
// ON; `0/false/off/no` byte-reverts to the old pass-through behavior.
function degenerateGuardEnabled(env = process.env) {
  return modelFindingsEnabled(env) && _flagEnabled(env && env.KHY_KEY_FINDINGS_DEGENERATE_GUARD, true);
}

// A finding body is "degenerate" when it announces the ABSENCE of a finding or
// declares the turn trivial, rather than reporting an actual milestone. Two
// shapes, both observed from real transcripts:
//   1. bare negation / placeholder — "无", "没有", "暂无", "none", "n/a", "null"
//      (optionally the whole body IS just that token, or it leads the body and
//      is followed by punctuation: "无，这是简单笑话请求").
//   2. explicit triviality note — "这是简单…请求/任务/问题", "无需/不需要…工具/执行".
// Kept deliberately narrow: a real finding that merely CONTAINS the word "无"
// mid-sentence (e.g. "空指针来自未初始化的 config，无默认值") is NOT dropped.
const _NEGATION_TOKENS = ['无', '没有', '暂无', '无明显', '无异常', '无突破', '无根因', '不适用',
  'none', 'n/a', 'na', 'null', 'nothing', 'nil'];
function _isDegenerateFindingBody(body) {
  const raw = String(body || '').trim();
  if (!raw) return true; // empty is already rejected downstream, but be explicit
  const lower = raw.toLowerCase();
  // 2. triviality meta-statements about the turn itself.
  if (/这是(个|一个)?\s*简单.*(请求|任务|问题|需求)/.test(raw)) return true;
  if (/(无需|不需要).*(工具|执行|调用|命令|操作)/.test(raw)) return true;
  // 1. bare negation / placeholder, either as the whole body or leading it.
  for (const tok of _NEGATION_TOKENS) {
    const t = tok.toLowerCase();
    if (lower === t) return true;                       // whole body is the token
    // Leading negation followed by separating punctuation → "无，…" / "none: …".
    const rest = lower.slice(t.length);
    if (lower.startsWith(t) && /^[\s，,。.、:：;；—-]/.test(rest)) return true;
  }
  return false;
}

// ── tool / result normalization ──────────────────────────────────────────────
// 收敛到 utils/normalizeToolName 单一真源(逐字节委托,调用点不变)
const _normToolName = require('../utils/normalizeToolName');
const _SHELL_TOOLS = new Set(['bash', 'shell', 'shellcommand', 'command']);

function _resultText(result) {
  if (!result || typeof result !== 'object') return '';
  const out = result.output ?? result.content ?? result.result ?? result.text ?? '';
  return typeof out === 'string' ? out : '';
}

// ── test-runner detection ────────────────────────────────────────────────────
// Recognize a command as a test run by the runner it invokes. Conservative:
// a command must explicitly call a known runner, so `ls` / `git status` never
// trip it. Returns a framework tag or null.
function _frameworkOfCommand(command) {
  const c = String(command || '').toLowerCase();
  if (!c) return null;
  // jest (incl. `node …/jest/bin/jest.js`), vitest
  if (/\bjest\b/.test(c)) return 'jest';
  if (/\bvitest\b/.test(c)) return 'vitest';
  if (/\bpytest\b/.test(c) || /\bpy\.test\b/.test(c) || /python.*-m\s+pytest/.test(c)) return 'pytest';
  if (/\bgo\s+test\b/.test(c)) return 'go';
  if (/\bcargo\s+test\b/.test(c)) return 'cargo';
  if (/\bmocha\b/.test(c)) return 'mocha';
  if (/\bnode\b[^|&;]*--test\b/.test(c) || /\bnode:test\b/.test(c)) return 'node';
  // `npm test` / `pnpm test` / `yarn test` — generic; tag as npm and rely on
  // output parsing (the underlying runner's summary still appears in stdout).
  if (/\b(npm|pnpm|yarn)\s+(run\s+)?test\b/.test(c)) return 'npm';
  return null;
}

const _MAX_FAILURES_LISTED = 5;

// Parse jest / vitest summary: "Tests: 1 failed, 22 passed, 23 total"
function _parseJestLike(text) {
  const m = text.match(/Tests:\s*(.+)/);
  if (!m) return null;
  const line = m[1];
  const passed = _numBefore(line, /(\d+)\s+passed/);
  const failed = _numBefore(line, /(\d+)\s+failed/);
  const total = _numBefore(line, /(\d+)\s+total/);
  if (passed == null && failed == null && total == null) return null;
  // Failing test names: jest marks them with "✕ name" or "  ● Suite › test".
  const failures = [];
  const re = /^\s*(?:✕|✗|●)\s+(.+?)\s*$/gm;
  let f;
  while ((f = re.exec(text)) && failures.length < _MAX_FAILURES_LISTED) {
    failures.push(f[1].trim());
  }
  return { passed: passed || 0, failed: failed || 0, total, failures };
}

// pytest: "===== 1 failed, 22 passed in 0.42s =====" (order varies)
function _parsePytest(text) {
  const m = text.match(/=+\s*([^=]*?(?:passed|failed|error)[^=]*?)\s*=+\s*$/m)
    || text.match(/(\d+\s+(?:passed|failed|error)[^\n]*)/);
  if (!m) return null;
  const line = m[1];
  const passed = _numBefore(line, /(\d+)\s+passed/);
  const failed = (_numBefore(line, /(\d+)\s+failed/) || 0) + (_numBefore(line, /(\d+)\s+error/) || 0);
  const failures = [];
  const re = /^FAILED\s+(\S+)/gm;
  let f;
  while ((f = re.exec(text)) && failures.length < _MAX_FAILURES_LISTED) failures.push(f[1].trim());
  if (passed == null && !failed && !failures.length) return null;
  const total = (passed || 0) + (failed || 0);
  return { passed: passed || 0, failed, total: total || null, failures };
}

// go test: per-test "--- FAIL: TestName" lines, plus trailing PASS/FAIL/ok.
function _parseGo(text) {
  const failures = [];
  const fre = /^---\s*FAIL:\s*(\S+)/gm;
  let f;
  while ((f = fre.exec(text)) && failures.length < _MAX_FAILURES_LISTED) failures.push(f[1].trim());
  const passCount = (text.match(/^---\s*PASS:/gm) || []).length;
  const hasFail = /^FAIL\b/m.test(text) || failures.length > 0;
  const hasOk = /^ok\s+\S/m.test(text) || /^PASS\b/m.test(text);
  if (!hasFail && !hasOk && passCount === 0) return null;
  const failed = failures.length;
  return { passed: passCount, failed, total: passCount + failed || null, failures };
}

// cargo: "test result: ok. 22 passed; 0 failed; 0 ignored; …"
function _parseCargo(text) {
  const m = text.match(/test result:\s*\w+\.\s*(\d+)\s+passed;\s*(\d+)\s+failed/);
  if (!m) return null;
  const passed = parseInt(m[1], 10);
  const failed = parseInt(m[2], 10);
  const failures = [];
  const re = /^----\s*(\S+)\s+stdout\s*----|^test\s+(\S+)\s+\.\.\.\s+FAILED/gm;
  let f;
  while ((f = re.exec(text)) && failures.length < _MAX_FAILURES_LISTED) {
    failures.push((f[1] || f[2] || '').trim());
  }
  return { passed, failed, total: passed + failed, failures: failures.filter(Boolean) };
}

// mocha: "22 passing" / "1 failing"; node:test: "# pass 22" / "# fail 1".
function _parseMochaNode(text) {
  let passed = _numBefore(text, /(\d+)\s+passing/);
  let failed = _numBefore(text, /(\d+)\s+failing/);
  if (passed == null && failed == null) {
    passed = _numBefore(text, /#\s*pass\s+(\d+)/);
    failed = _numBefore(text, /#\s*fail\s+(\d+)/);
  }
  if (passed == null && failed == null) return null;
  const failures = [];
  // mocha failing block: "  1) Suite test:" ; keep it best-effort.
  const re = /^\s*\d+\)\s+(.+?):?\s*$/gm;
  let f;
  while ((f = re.exec(text)) && failures.length < _MAX_FAILURES_LISTED) failures.push(f[1].trim());
  return { passed: passed || 0, failed: failed || 0, total: (passed || 0) + (failed || 0) || null, failures };
}

function _numBefore(text, re) {
  const m = String(text).match(re);
  return m ? parseInt(m[1], 10) : null;
}

const _PARSERS = {
  jest: _parseJestLike,
  vitest: _parseJestLike,
  pytest: _parsePytest,
  go: _parseGo,
  cargo: _parseCargo,
  mocha: _parseMochaNode,
  node: _parseMochaNode,
  npm: _parseJestLike, // npm test usually wraps jest/mocha — jest summary first
};

/**
 * Detect a test-run outcome from a tool result. Returns a structured finding or
 * null. Only acts on shell-class tools whose command invokes a known runner.
 */
function detectTestOutcome(toolName, params, result, env = process.env) {
  if (!testFindingsEnabled(env)) return null;
  if (!_SHELL_TOOLS.has(_normToolName(toolName))) return null;
  if (!result || typeof result !== 'object') return null;
  if (result._background) return null; // background run — no final output yet

  const command = String((params && params.command) || '').trim();
  let framework = _frameworkOfCommand(command);
  if (!framework) return null;

  const text = _resultText(result);
  if (!text) {
    // No captured output: fall back to exit code only (can't name failures).
    const exit = typeof result.exitCode === 'number' ? result.exitCode : null;
    if (exit == null) return null;
    return {
      kind: 'test', framework, passed: null, failed: null, total: null,
      failures: [], green: exit === 0, command,
    };
  }

  let parsed = _PARSERS[framework] ? _PARSERS[framework](text) : null;
  // npm/yarn wrappers: if the jest-style summary missed, try mocha/node shape.
  if (!parsed && framework === 'npm') parsed = _parseMochaNode(text);
  if (!parsed) {
    const exit = typeof result.exitCode === 'number' ? result.exitCode : null;
    if (exit == null) return null;
    return { kind: 'test', framework, passed: null, failed: null, total: null, failures: [], green: exit === 0, command };
  }

  const failed = parsed.failed || 0;
  const exit = typeof result.exitCode === 'number' ? result.exitCode : null;
  const green = failed === 0 && (exit == null || exit === 0);
  return {
    kind: 'test',
    framework,
    passed: parsed.passed,
    failed,
    total: parsed.total,
    failures: Array.isArray(parsed.failures) ? parsed.failures : [],
    green,
    command,
  };
}

/**
 * Render a deterministic test-result finding into a Chinese report line.
 */
function composeFindingReport(finding) {
  if (!finding || finding.kind !== 'test') return '';
  const passed = Number.isFinite(finding.passed) ? finding.passed : null;
  const failed = Number.isFinite(finding.failed) ? finding.failed : null;
  const total = Number.isFinite(finding.total) ? finding.total : null;

  if (finding.green) {
    if (passed != null) {
      return total != null && total !== passed
        ? `✅ 测试结果：${passed} 绿（共 ${total}）`
        : `✅ 测试结果：${passed} 绿（0 失败）`;
    }
    return '✅ 测试结果：全部通过';
  }

  // Failure path.
  const head = (failed != null && passed != null)
    ? `❌ 测试结果：${failed} 失败 / ${passed} 绿`
    : (failed != null ? `❌ 测试结果：${failed} 失败` : '❌ 测试结果：有失败');
  const lines = [head];
  const names = Array.isArray(finding.failures) ? finding.failures.slice(0, _MAX_FAILURES_LISTED) : [];
  for (const n of names) lines.push(`  · ${n}`);
  const omitted = (finding.failures || []).length - names.length;
  if (omitted > 0) lines.push(`  …（还有 ${omitted} 个）`);
  lines.push('下一步：先定位第一个失败的断言再调整。');
  return lines.join('\n');
}

// ── model-emitted findings (<finding> blocks) ────────────────────────────────
const _FINDING_RE = /<finding\s+type="(root_cause|breakthrough|blocked)"\s*>([\s\S]*?)<\/finding>/gi;

/**
 * Parse model-emitted <finding type="…">…</finding> blocks into structured
 * findings. Mirrors _parseExecutionPlan. Returns [] when none / disabled.
 */
function parseModelFindings(text, env = process.env) {
  if (!modelFindingsEnabled(env)) return [];
  const s = String(text || '');
  if (!s) return [];
  const guard = degenerateGuardEnabled(env);
  const out = [];
  let m;
  _FINDING_RE.lastIndex = 0;
  while ((m = _FINDING_RE.exec(s))) {
    const type = m[1].toLowerCase();
    const body = String(m[2] || '').trim();
    if (!body) continue;
    // Drop non-findings ("💡 突破：无") when the guard is on; byte-revert when off.
    if (guard && _isDegenerateFindingBody(body)) continue;
    out.push({ kind: 'model', type, text: body });
  }
  return out;
}

/**
 * Strip <finding> blocks from text for display. Mirrors _stripExecutionPlan.
 * Always strips regardless of env so a disabled feature never leaks raw tags.
 */
function stripFindings(text) {
  if (!text) return text;
  return String(text).replace(/<finding\s+type="[^"]*"\s*>[\s\S]*?<\/finding>/gi, '').trim();
}

const _MODEL_FINDING_HEADERS = {
  root_cause: '🔎 根因',
  breakthrough: '💡 突破',
  blocked: '⛔ 受阻',
};

/**
 * Render a model-emitted finding into a Chinese report line.
 */
function composeModelFinding(finding) {
  if (!finding || finding.kind !== 'model') return '';
  const header = _MODEL_FINDING_HEADERS[finding.type];
  const body = String(finding.text || '').trim();
  if (!header || !body) return '';
  return `${header}：${body}`;
}

/**
 * Build the user-message preamble that instructs the model to emit <finding>
 * blocks at real milestones. Mirrors _injectPlanningPrompt's convention (a
 * bracketed [System: …] preamble, not a separate system prompt). Returns ''
 * when the model-findings feature is disabled.
 */
function buildKeyFindingsInstruction(env = process.env) {
  if (!modelFindingsEnabled(env)) return '';
  return [
    '[System: 执行过程中遇到关键发现请主动汇报，单独成行用以下标记（仅在真正命中时使用，不要为凑数而写）:',
    '- 定位到 bug 的根本原因 → <finding type="root_cause">一句话说清是什么导致、在哪一层</finding>',
    '- 攻克一个卡住的难题 → <finding type="breakthrough">一句话说清突破口</finding>',
    '- 受阻或失败 → <finding type="blocked">一句话说清卡在哪 + 下一步打算怎么做</finding>',
    '没有命中时不要输出任何 <finding> 标记（不要写「无」「暂无」「这是简单请求」之类占位内容）。',
    '这些标记会被单独提取展示，正文无需重复其内容。]',
  ].join('\n');
}

module.exports = {
  detectTestOutcome,
  composeFindingReport,
  parseModelFindings,
  stripFindings,
  composeModelFinding,
  buildKeyFindingsInstruction,
  // gates exposed for the loop's wiring + unit tests
  keyFindingsEnabled,
  testFindingsEnabled,
  modelFindingsEnabled,
  degenerateGuardEnabled,
  // exposed for unit tests
  _isDegenerateFindingBody,
};

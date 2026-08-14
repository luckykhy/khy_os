'use strict';

/**
 * searchHintCoverage.test.js — metadata-only guard for tool searchHint values.
 *
 * Task #22 filled searchHint for every defineTool / BaseTool tool that lacked
 * one. This suite:
 *   1. asserts each filled tool exposes a non-empty searchHint that does NOT
 *      repeat the tool name itself (that would only duplicate name matching);
 *   2. asserts recommendTools (weight-4 consumer of searchHint) recalls the
 *      expected tools for Chinese and English keywords actually used in hints.
 *
 * Hermetic: tool modules are required directly (frozen metadata objects) —
 * the module-level registry singleton in tools/index.js is never touched, and
 * no real ~/.khy data is read or written (jest setup files pin data home).
 */

const path = require('path');

const TOOLS_DIR = path.join(__dirname, '..', '..', 'src', 'tools');

// Flat defineTool files filled in Task #22 (file base name, no extension).
const FILLED_FLAT_TOOLS = [
  'analyzeBinary',
  'backtest',
  'buildProject',
  'configureCapability',
  'dataFetch',
  'executeCode',
  'forgeCodeSearch',
  'forgeCommits',
  'forgeRecon',
  'forgeSearch',
  'gitBlame',
  'gitClone',
  'gitCommit',
  'gitDiff',
  'gitLog',
  'gitPush',
  'gitStatus',
  'GoalTool',
  'lintCode',
  'LocalMemoryRecall',
  'manageDeps',
  'MeshPeer',
  'optimizeConfig',
  'quote',
  'RecordProgress',
  'repoAudit',
  'reverseEngineer',
  'runTests',
  'SaveInstruction',
  'SaveMemory',
  'search',
  'SessionInsights',
  'shellCommand',
  'strategyList',
  'verifyArtifact',
  'writeFile',
];

function loadFlatTools() {
  const out = [];
  for (const base of FILLED_FLAT_TOOLS) {
    // Direct require of the frozen tool object; no registry, no IO beyond require.
    const tool = require(path.join(TOOLS_DIR, `${base}.js`));
    out.push(tool);
  }
  return out;
}

describe('searchHint metadata coverage (Task #22)', () => {
  let tools;

  beforeAll(() => {
    tools = loadFlatTools();
  });

  test('every filled flat tool has a non-empty string searchHint', () => {
    for (const tool of tools) {
      expect(typeof tool.name).toBe('string');
      expect(typeof tool.searchHint).toBe('string');
      expect(tool.searchHint.trim().length).toBeGreaterThan(0);
    }
  });

  test('searchHint never repeats the tool name itself', () => {
    for (const tool of tools) {
      const hint = tool.searchHint.toLowerCase();
      expect(hint).not.toContain(tool.name.toLowerCase());
    }
  });

  test('high-frequency tools carry both Chinese and English keywords', () => {
    const highFrequency = ['writeFile', 'shellCommand', 'gitCommit', 'gitStatus', 'run_tests', 'manageDeps'];
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const name of highFrequency) {
      const tool = byName.get(name);
      expect(tool).toBeDefined();
      // At least one CJK char and one ASCII letter → bilingual discoverability.
      expect(tool.searchHint).toMatch(/[\u4e00-\u9fff]/);
      expect(tool.searchHint).toMatch(/[a-z]/i);
    }
  });

  test('SyntheticOutputTool (BaseTool subclass) declares a static searchHint', () => {
    const Ctor = require(path.join(TOOLS_DIR, 'SyntheticOutputTool', 'index.js'));
    expect(typeof Ctor.searchHint).toBe('string');
    expect(Ctor.searchHint.trim().length).toBeGreaterThan(0);
    expect(Ctor.searchHint.toLowerCase()).not.toContain('syntheticoutput');
  });
});

describe('recommendTools recalls tools via the filled searchHint values', () => {
  let recommendTools;
  let tools;
  const savedGate = process.env.KHY_TOOL_RECOMMEND;

  beforeAll(() => {
    // Force the recommend gate on regardless of ambient env; restored below.
    process.env.KHY_TOOL_RECOMMEND = '1';
    jest.resetModules();
    ({ recommendTools } = require(path.join(TOOLS_DIR, 'toolRecommend.js')));
    tools = loadFlatTools();
  });

  afterAll(() => {
    if (savedGate === undefined) delete process.env.KHY_TOOL_RECOMMEND;
    else process.env.KHY_TOOL_RECOMMEND = savedGate;
  });

  function names(query) {
    return recommendTools(query, tools, { limit: 5 }).map((r) => r.name);
  }

  test.each([
    ['写文件', 'writeFile'],
    ['执行命令', 'shellCommand'],
    ['克隆 仓库', 'gitClone'],
    ['回测 策略', 'backtest'],
    ['日志 提交记录', 'gitLog'],
    ['依赖 安装包', 'manageDeps'],
  ])('Chinese keyword "%s" recalls %s as top hit', (query, expected) => {
    const out = names(query);
    expect(out[0]).toBe(expected);
  });

  test.each([
    ['shell command terminal', 'shellCommand'],
    ['decompile disassemble', 'reverse_engineer'],
    ['checksum integrity', 'verify_artifact'],
    ['install dependencies', 'manageDeps'],
    ['compile gradle maven', 'build_project'],
  ])('English keyword "%s" recalls %s among top hits', (query, expected) => {
    const out = names(query);
    expect(out).toContain(expected);
  });

  test('hint-only match scores exactly the searchHint weight (4)', () => {
    const { scoreTool } = require(path.join(TOOLS_DIR, 'toolRecommend.js'));
    const byName = new Map(tools.map((t) => [t.name, t]));
    // '回测' appears only in backtest's searchHint — not in its name/aliases.
    expect(scoreTool(byName.get('backtest'), ['回测'])).toBe(4);
  });
});

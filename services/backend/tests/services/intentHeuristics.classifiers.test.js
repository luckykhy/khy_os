'use strict';

/**
 * intentHeuristics.classifiers.test.js — locks the intent-classifier heuristics
 * in src/services/intentHeuristics.js (zero-dependency leaf module). Pins the
 * single source of truth for: web-search mode resolution, quoted-phrase /
 * quoted-「」 candidate extraction, the delivery-conclusion / progress-only /
 * choice-response / action-request classifiers, tool-name shape detection,
 * user tool-constraint extraction + directive building, and app-target
 * extraction. If a heuristic drifts, this test goes red first.
 */

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const ih = require('../../src/services/intentHeuristics');

describe('resolveAutoWebSearchMode', () => {
  test('explicit valid mode wins over content sniffing', () => {
    assert.equal(ih.resolveAutoWebSearchMode('anything', 'docs'), 'docs');
    assert.equal(ih.resolveAutoWebSearchMode('anything', 'academic'), 'academic');
    assert.equal(ih.resolveAutoWebSearchMode('anything', 'news'), 'news');
  });

  test('invalid requested mode falls back to content sniffing', () => {
    assert.equal(ih.resolveAutoWebSearchMode('看这篇 arxiv 论文的 benchmark', 'bogus'), 'academic');
    assert.equal(ih.resolveAutoWebSearchMode('查一下 API 文档', 'bogus'), 'docs');
    assert.equal(ih.resolveAutoWebSearchMode('今天的新闻热点', 'bogus'), 'news');
    assert.equal(ih.resolveAutoWebSearchMode('随便聊聊', 'bogus'), 'general');
  });

  test('empty message → general', () => {
    assert.equal(ih.resolveAutoWebSearchMode('', 'auto'), 'general');
  });
});

describe('buildSearchQueryCandidates', () => {
  test('empty message → no candidates', () => {
    assert.deepEqual(ih.buildSearchQueryCandidates(''), []);
  });

  test('full message is always candidate #1', () => {
    const out = ih.buildSearchQueryCandidates('查询 PostgreSQL 索引优化');
    assert.ok(out.length >= 1);
    assert.equal(out[0], '查询 PostgreSQL 索引优化');
  });

  test('quoted Chinese「」phrases become candidates', () => {
    const out = ih.buildSearchQueryCandidates('研究「量子计算」的进展');
    assert.ok(out.includes('量子计算'), `expected quoted phrase in ${JSON.stringify(out)}`);
  });

  test('candidates are deduped and capped at the limit', () => {
    const out = ih.buildSearchQueryCandidates('a b c d e f g h i j k l', 2, 'general');
    assert.ok(out.length <= 2, `expected <=2 candidates, got ${out.length}`);
    assert.equal(new Set(out).size, out.length, 'candidates must be unique');
  });
});

describe('delivery / progress / choice classifiers', () => {
  test('looksLikeDeliveryConclusion', () => {
    assert.equal(ih.looksLikeDeliveryConclusion('已完成，结果如上'), true);
    assert.equal(ih.looksLikeDeliveryConclusion('All done.'), true);
    assert.equal(ih.looksLikeDeliveryConclusion('让我再想想'), false);
    assert.equal(ih.looksLikeDeliveryConclusion(''), false);
  });

  test('looksLikeProgressOnlyReply flags preface-style work messages', () => {
    assert.equal(ih.looksLikeProgressOnlyReply('我先检查一下日志，然后定位问题'), true);
    assert.equal(ih.looksLikeProgressOnlyReply('Let me investigate the failing test first'), true);
    assert.equal(ih.looksLikeProgressOnlyReply('最终答案：42'), false);
    assert.equal(ih.looksLikeProgressOnlyReply(''), false);
  });

  test('looksLikeProgressOnlyReply is not a preface when it contains code blocks', () => {
    assert.equal(ih.looksLikeProgressOnlyReply('```\ncode\n```'), false);
  });

  test('looksLikeChoiceResponse requires a numbered/bulleted option list + choice cue', () => {
    assert.equal(
      ih.looksLikeChoiceResponse('你可以选择以下方案：\n1. 方案A\n2. 方案B'),
      true
    );
    assert.equal(ih.looksLikeChoiceResponse('这是直接答案'), false);
  });

  test('looksLikeActionRequest', () => {
    assert.equal(ih.looksLikeActionRequest('帮我修复这个 bug'), true);
    assert.equal(ih.looksLikeActionRequest('请运行测试'), true);
    assert.equal(ih.looksLikeActionRequest('什么是熵？'), false);
  });
});

describe('tool name shape detection', () => {
  test('isShellToolName', () => {
    assert.equal(ih.isShellToolName('bash'), true);
    assert.equal(ih.isShellToolName('Shell_Command'), true);
    assert.equal(ih.isShellToolName('web_search'), false);
  });

  test('isWebLookupToolName normalizes separators', () => {
    assert.equal(ih.isWebLookupToolName('web-search'), true);
    assert.equal(ih.isWebLookupToolName('WebFetch'), true);
    assert.equal(ih.isWebLookupToolName('shell_command'), false);
  });
});

describe('user tool constraints', () => {
  test('CN + EN disallow-all-tools phrasing sets disallowAllTools', () => {
    assert.equal(ih.extractUserToolConstraints('不要调用任何工具').disallowAllTools, true);
    assert.equal(ih.extractUserToolConstraints("do not use any tools").disallowAllTools, true);
    assert.equal(ih.extractUserToolConstraints('随便用工具都行').disallowAllTools, false);
  });

  test('search / file-read disallows are detected separately', () => {
    assert.equal(ih.extractUserToolConstraints('别联网搜索').disallowSearch, true);
    assert.equal(ih.extractUserToolConstraints('不要读取任何文件').disallowFileRead, true);
  });

  test('buildUserToolConstraintDirective: empty constraints → empty directive', () => {
    assert.equal(ih.buildUserToolConstraintDirective({}), '');
    assert.equal(
      ih.buildUserToolConstraintDirective({ hasExplicitConstraint: false }),
      ''
    );
  });

  test('buildUserToolConstraintDirective renders per-constraint rules', () => {
    const all = ih.buildUserToolConstraintDirective({
      hasExplicitConstraint: true,
      disallowAllTools: true,
    });
    assert.match(all, /Do not call any tools/);
    const searchOnly = ih.buildUserToolConstraintDirective({
      hasExplicitConstraint: true,
      disallowSearch: true,
    });
    assert.match(searchOnly, /Do not use web_search/);
    assert.doesNotMatch(searchOnly, /Do not call any tools/);
  });
});

describe('app target extraction + launch request', () => {
  test('extractAppTargetFromUserMessage CN no-space target', () => {
    assert.equal(ih.extractAppTargetFromUserMessage('打开飞书'), '飞书');
  });

  test('extractAppTargetFromUserMessage EN spaced target', () => {
    const t = ih.extractAppTargetFromUserMessage('open VS Code');
    assert.ok(t.length > 0, 'expected a non-empty target for "open VS Code"');
  });

  test('no launch verb → empty target', () => {
    assert.equal(ih.extractAppTargetFromUserMessage('今天天气如何'), '');
  });

  test('looksLikeAppLaunchRequest: direct launch vs troubleshooting', () => {
    assert.equal(ih.looksLikeAppLaunchRequest('请打开飞书'), true);
    assert.equal(ih.looksLikeAppLaunchRequest('为什么打不开飞书'), false);
    assert.equal(ih.looksLikeAppLaunchRequest(''), false);
  });
});

describe('shell / scaffold / info-search classifiers', () => {
  test('looksLikeShellAppProbeCommand', () => {
    assert.equal(ih.looksLikeShellAppProbeCommand('which python3'), true);
    assert.equal(ih.looksLikeShellAppProbeCommand('grep -i foo bar.txt'), true);
    assert.equal(ih.looksLikeShellAppProbeCommand('ls -la'), false);
    assert.equal(ih.looksLikeShellAppProbeCommand(''), false);
  });

  test('looksLikeProjectScaffoldRequest', () => {
    assert.equal(ih.looksLikeProjectScaffoldRequest('帮我创建一个 Vue 项目脚手架'), true);
    assert.equal(ih.looksLikeProjectScaffoldRequest('create a new project structure'), true);
    assert.equal(ih.looksLikeProjectScaffoldRequest('今天吃什么'), false);
  });

  test('looksLikeInfoSearchRequest honors disallow-search constraint', () => {
    assert.equal(ih.looksLikeInfoSearchRequest('帮我搜索一下量子计算'), true);
    assert.equal(ih.looksLikeInfoSearchRequest('不要联网搜索，直接回答'), false);
    assert.equal(ih.looksLikeInfoSearchRequest('1+1等于几'), false);
  });
});

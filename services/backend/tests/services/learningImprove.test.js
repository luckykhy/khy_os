'use strict';

/**
 * learningImprove.test.js — 「边学边发现不足」改进清单锁定测试:
 *   - appendFinding 清单永远先落库（即使无模型 / 模型抛错 / 超时 / 空回复）
 *   - 注入式 fake callModel → proposal 存档、proposalSource='model'
 *   - listFindings 最新在前
 *   - 原子写无 .tmp 残留 + 二次写出 .bak
 *   - 损坏清单 → fail-soft 后仍能 append
 *   - classify 确定性关键词分类
 *   - KHY_LEARN_IMPROVE_MAX FIFO 上限挤掉最旧
 *   - evo 路由默认开（route=true 即触发）；KHY_EVO_ENGINE=off 显式关闭
 *
 * Isolation: HOME / KHYOS_HOME 指向私有临时目录（require 之前）。
 */

const { describe, test, beforeEach, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ── isolate home dirs before requiring module under test ──
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-imp-'));
const ORIG = {
  HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, KHYOS_HOME: process.env.KHYOS_HOME,
  MAX: process.env.KHY_LEARN_IMPROVE_MAX, EVO: process.env.KHY_EVO_ENGINE, TO: process.env.KHY_LEARN_FETCH_TIMEOUT_MS,
};
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
process.env.KHYOS_HOME = path.join(TMP_HOME, '.khyos');
delete process.env.KHY_LEARN_IMPROVE_MAX;
delete process.env.KHY_EVO_ENGINE;

const improve = require('../../src/services/learningImprove');

const DIR = path.join(TMP_HOME, '.khyos', 'growth');
const FILE = path.join(DIR, 'learn_findings.json');
const BAK = path.join(DIR, 'learn_findings.bak');

function wipe() {
  try { fs.rmSync(FILE, { force: true }); } catch { /* ignore */ }
  try { fs.rmSync(BAK, { force: true }); } catch { /* ignore */ }
  delete process.env.KHY_LEARN_IMPROVE_MAX;
  delete process.env.KHY_EVO_ENGINE;
}

before(() => wipe());
beforeEach(() => wipe());
after(() => {
  process.env.HOME = ORIG.HOME;
  process.env.USERPROFILE = ORIG.USERPROFILE;
  process.env.KHYOS_HOME = ORIG.KHYOS_HOME;
  if (ORIG.MAX === undefined) delete process.env.KHY_LEARN_IMPROVE_MAX; else process.env.KHY_LEARN_IMPROVE_MAX = ORIG.MAX;
  if (ORIG.EVO === undefined) delete process.env.KHY_EVO_ENGINE; else process.env.KHY_EVO_ENGINE = ORIG.EVO;
  if (ORIG.TO === undefined) delete process.env.KHY_LEARN_FETCH_TIMEOUT_MS; else process.env.KHY_LEARN_FETCH_TIMEOUT_MS = ORIG.TO;
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('classify 确定性分类', () => {
  test('关键词命中', () => {
    assert.strictEqual(improve.classify('这里好慢，性能差'), 'perf');
    assert.strictEqual(improve.classify('运行时崩溃报错了'), 'bug');
    assert.strictEqual(improve.classify('这块缺一个边界检查、没有处理空值'), 'gap');
    assert.strictEqual(improve.classify('文档看不懂、注释太少'), 'doc');
    assert.strictEqual(improve.classify('这里耦合太重，应该重构'), 'design');
    assert.strictEqual(improve.classify('随便写点别的'), 'unknown');
    assert.strictEqual(improve.classify(''), 'unknown');
    assert.strictEqual(improve.classify(null), 'unknown');
  });
});

describe('appendFinding 清单先落库', () => {
  test('无模型(callModel=null) → 仍落库, proposal 空', async () => {
    const { ok, finding } = await improve.appendFinding(
      { layerId: 5, topicId: '5:1', topicTitle: '工具循环', files: ['x.js'], note: '错误处理我没看懂为什么吞异常' },
      { callModel: null },
    );
    assert.strictEqual(ok, true);
    assert.strictEqual(finding.proposalSource, 'none');
    assert.strictEqual(finding.proposal, '');
    assert.strictEqual(finding.kind, 'bug'); // "异常" 命中 bug
    assert.strictEqual(finding.evoRouted, false);
    assert.ok(fs.existsSync(FILE));
    assert.strictEqual(improve.loadFindings().findings.length, 1);
  });

  test('注入 fake callModel → proposal 存档, source=model', async () => {
    let seenPrompt = null;
    const fake = async (prompt) => { seenPrompt = prompt; return '建议：把 catch 里加日志再 rethrow。'; };
    const { finding } = await improve.appendFinding(
      { layerId: 4, topicId: '4:2', topicTitle: '工具调用', files: ['executeTool.js'], note: '这里慢' },
      { callModel: fake },
    );
    assert.match(seenPrompt, /改进提议/);
    assert.match(seenPrompt, /executeTool\.js/);
    assert.strictEqual(finding.proposalSource, 'model');
    assert.match(finding.proposal, /catch/);
    assert.strictEqual(finding.kind, 'perf');
  });

  test('callModel 抛错 → finding 仍落库, proposal 空', async () => {
    const boom = async () => { throw new Error('model down'); };
    const { ok, finding } = await improve.appendFinding({ note: '崩了' }, { callModel: boom });
    assert.strictEqual(ok, true);
    assert.strictEqual(finding.proposalSource, 'none');
    assert.strictEqual(improve.loadFindings().findings.length, 1);
  });

  test('callModel 空回复 → proposalSource=none', async () => {
    const empty = async () => '   ';
    const { finding } = await improve.appendFinding({ note: '缺东西' }, { callModel: empty });
    assert.strictEqual(finding.proposalSource, 'none');
    assert.strictEqual(finding.kind, 'gap');
  });

  test('callModel 超时 → finding 仍落库（短超时 race）', async () => {
    process.env.KHY_LEARN_FETCH_TIMEOUT_MS = '30';
    const slow = () => new Promise(res => setTimeout(() => res('太晚了'), 500));
    const { ok, finding } = await improve.appendFinding({ note: '设计问题' }, { callModel: slow });
    assert.strictEqual(ok, true);
    assert.strictEqual(finding.proposalSource, 'none');
    delete process.env.KHY_LEARN_FETCH_TIMEOUT_MS;
  });
});

describe('listFindings 顺序与持久化', () => {
  test('最新在前', async () => {
    await improve.appendFinding({ note: '第一条' }, { callModel: null });
    await improve.appendFinding({ note: '第二条' }, { callModel: null });
    const items = improve.listFindings();
    assert.strictEqual(items.length, 2);
    assert.strictEqual(items[0].note, '第二条');
    assert.strictEqual(items[1].note, '第一条');
  });

  test('limit 截断', async () => {
    await improve.appendFinding({ note: 'a' }, { callModel: null });
    await improve.appendFinding({ note: 'b' }, { callModel: null });
    await improve.appendFinding({ note: 'c' }, { callModel: null });
    assert.strictEqual(improve.listFindings({ limit: 2 }).length, 2);
  });

  test('无 .tmp 残留 + 二次写出 .bak', async () => {
    await improve.appendFinding({ note: '一' }, { callModel: null });
    assert.strictEqual(fs.existsSync(BAK), false, '首写不应有 .bak');
    await improve.appendFinding({ note: '二' }, { callModel: null });
    assert.ok(fs.existsSync(BAK), '二次写应轮转 .bak');
    const stray = fs.readdirSync(DIR).filter(f => f.includes('.tmp'));
    assert.deepStrictEqual(stray, []);
  });
});

describe('fail-soft 与上限', () => {
  test('损坏清单 → loadFindings 回落空、仍能 append', async () => {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(FILE, 'not json at all', 'utf-8');
    assert.deepStrictEqual(improve.loadFindings().findings, []);
    const { ok } = await improve.appendFinding({ note: '恢复写入' }, { callModel: null });
    assert.strictEqual(ok, true);
    assert.strictEqual(improve.loadFindings().findings.length, 1);
  });

  test('KHY_LEARN_IMPROVE_MAX FIFO 挤掉最旧', async () => {
    process.env.KHY_LEARN_IMPROVE_MAX = '2';
    await improve.appendFinding({ note: 'one' }, { callModel: null });
    await improve.appendFinding({ note: 'two' }, { callModel: null });
    await improve.appendFinding({ note: 'three' }, { callModel: null });
    const all = improve.loadFindings().findings;
    assert.strictEqual(all.length, 2);
    assert.strictEqual(all[0].note, 'two', '最旧的 one 应被挤掉');
    assert.strictEqual(all[1].note, 'three');
  });
});

describe('evo 路由默认开（KHY_EVO_ENGINE=off 关）', () => {
  test('未设 KHY_EVO_ENGINE + route=true → evoRouted=true（默认开）', async () => {
    const { finding } = await improve.appendFinding({ note: '默认路由' }, { callModel: null, route: true });
    assert.strictEqual(finding.evoRouted, true);
  });

  test('KHY_EVO_ENGINE=off + route=true → evoRouted=false（显式关闭）', async () => {
    process.env.KHY_EVO_ENGINE = 'off';
    const { finding } = await improve.appendFinding({ note: '显式关闭' }, { callModel: null, route: true });
    assert.strictEqual(finding.evoRouted, false);
    delete process.env.KHY_EVO_ENGINE;
  });

  test('未带 route → evoRouted=false（即便引擎开）', async () => {
    process.env.KHY_EVO_ENGINE = '1';
    const { finding } = await improve.appendFinding({ note: '不显式路由' }, { callModel: null });
    assert.strictEqual(finding.evoRouted, false);
    delete process.env.KHY_EVO_ENGINE;
  });
});

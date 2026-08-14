'use strict';

// 本地模式（无模型）数据管理能力验证：
//  1. 本地数据获取（存储报告）确定性可达，渲染含分类占用。
//  2. 数据清理默认仅预览，删除分支由「确认」闸门把守（破坏性操作需确认红线）。
//  3. 意图门控：清理词不被误判为存储查询，反之亦然。
//  4. 多数据源署名：≥2 引擎才显示「数据源：...（多引擎聚合）」，单源/关闭时为空。
//  5. 端到端经 quickTaskService 链路（detect → execute → format）可达。

const assert = require('assert');
const lb = require('../../src/services/localBrainService');
const quickTaskService = require('../../src/services/quickTaskService');

// ── 1. 存储意图门控 ──────────────────────────────────────────────
{
  assert.ok(lb._isStorageIntent('khy本地数据占用了多少'), 'storage query detected');
  assert.ok(lb._isStorageIntent('查看存储报告'), 'storage report detected');
  // 含清理词的应让位给清理意图，不被存储查询拦截
  assert.ok(!lb._isStorageIntent('清理本地数据'), 'cleanup phrasing not treated as storage');
}

// ── 2. 清理意图门控 + 确认闸门 ───────────────────────────────────
{
  assert.ok(lb._isCleanupIntent('清理一下垃圾文件'), 'cleanup intent detected');
  assert.ok(lb._isCleanupIntent('清缓存释放空间'), 'free-space cleanup detected');

  const preview = lb._detectCleanup('清理本地数据');
  assert.strictEqual(preview.type, 'data_cleanup');
  assert.strictEqual(preview.confirmed, false, 'plain cleanup defaults to preview');

  const confirmed = lb._detectCleanup('确认清理本地数据');
  assert.strictEqual(confirmed.confirmed, true, 'explicit 确认 enables deletion');
}

// ── 3. 存储报告执行 + 渲染（只读，安全） ─────────────────────────
{
  const result = lb._executeStorage();
  assert.strictEqual(result.type, 'storage_report');
  assert.ok(result.success, 'storage report succeeds against real BASE_DIR');
  assert.ok(result.report && typeof result.report === 'object', 'report object present');

  const out = lb._formatStorage(result);
  assert.ok(typeof out === 'string' && out.length > 0, 'storage render non-empty');
  assert.ok(/占用|存储|总计|MB|KB|GB|B\b/.test(out), 'render mentions usage');
}

// ── 4. 清理预览不删除文件（破坏性闸门） ──────────────────────────
{
  const previewResult = lb._executeCleanup({ type: 'data_cleanup', confirmed: false });
  assert.strictEqual(previewResult.preview, true, 'unconfirmed cleanup stays preview');
  assert.ok(previewResult.success, 'preview succeeds');

  const out = lb._formatCleanup(previewResult);
  assert.ok(/确认/.test(out), 'preview render instructs user to confirm');
  assert.ok(!/已释放/.test(out), 'preview must not claim deletion happened');
}

// ── 5. 多数据源署名 ──────────────────────────────────────────────
{
  const multi = [
    { title: 'a', url: 'http://a', engines: ['baidu', 'bing-cn'] },
    { title: 'b', url: 'http://b', engines: ['sogou'] },
  ];
  const sources = lb._collectSources(multi);
  assert.deepStrictEqual(sources, ['百度', 'Bing', '搜狗'], 'engine labels deduped + mapped');

  const footer = lb._sourceFooter(multi);
  assert.ok(footer.includes('数据源'), 'footer announces data sources');
  assert.ok(footer.includes('多引擎聚合'), 'footer notes multi-engine aggregation');

  // 单一来源不显示署名（避免「只靠一家」的误导）
  const single = [{ title: 'x', url: 'http://x', engines: ['baidu'] }];
  assert.strictEqual(lb._sourceFooter(single), '', 'single source → no footer');

  // 环境开关关闭时为空
  const prev = process.env.KHY_LOCAL_SHOW_SOURCES;
  process.env.KHY_LOCAL_SHOW_SOURCES = '0';
  assert.strictEqual(lb._sourceFooter(multi), '', 'footer disabled via env');
  if (prev === undefined) delete process.env.KHY_LOCAL_SHOW_SOURCES;
  else process.env.KHY_LOCAL_SHOW_SOURCES = prev;
}

// ── 6. 端到端：经 quickTaskService 链路可达（无模型路径） ────────
{
  const plan = quickTaskService.detectQuickTask('khy本地数据占用了多少');
  assert.ok(plan, 'quickTask detects storage intent');
  assert.strictEqual(plan.type, 'storage_report');

  const result = quickTaskService.executeQuickTask(plan);
  assert.ok(result.success, 'quickTask executes storage report');

  const rendered = quickTaskService.formatQuickTaskResult(result);
  assert.ok(typeof rendered === 'string' && rendered.length > 0, 'quickTask renders storage');

  const cleanPlan = quickTaskService.detectQuickTask('清理一下垃圾文件释放空间');
  assert.ok(cleanPlan, 'quickTask detects cleanup intent');
  assert.strictEqual(cleanPlan.type, 'data_cleanup');
  assert.strictEqual(cleanPlan.confirmed, false, 'cleanup via quickTask defaults to preview');
}

console.log('localDataCleanup: all assertions passed');

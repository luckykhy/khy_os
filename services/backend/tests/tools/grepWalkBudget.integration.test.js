'use strict';

/**
 * grepWalkBudget.integration.test.js — 证明 Grep 的 pure-JS 回退(pureJsGrep / pureJsGrepAsync)
 * 在真实文件树上受墙钟预算约束:预算耗尽提前收尾并标 truncated/timedOut,不假死。
 *
 * 这是回归「Windows 上无 rg/grep 时一显示正在搜索就卡死 25+ 分钟」的守卫:根因是纯 JS 回退
 * 的**同步递归 walk 无时间上限**,遇超大树 / Windows junction 回环 / 慢盘(Defender、网络盘)
 * 时阻塞整个事件循环、ESC 打不断——与 GlobTool/ListDirTool 同一根因,而 Glob/ListDir 早前已加
 * 预算,唯独 pureJsGrep 漏了。核心不变量:无论树多大 / I-O 多慢,带预算的 walk 都在预算耗尽时
 * 优雅提前返回,且异步孪生与同步版结果一致。
 *
 * 运行:node --test services/backend/tests/tools/grepWalkBudget.integration.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { pureJsGrep, pureJsGrepAsync } = require('../../src/tools/platformUtils');
const walkBudget = require('../../src/tools/_walkBudget');
const grepTool = require('../../src/tools/grep');

function mkTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-grep-walk-'));
  fs.writeFileSync(path.join(root, 'a.txt'), 'hello world\nline2\n', 'utf8');
  const sub = path.join(root, 'sub');
  fs.mkdirSync(sub);
  for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(sub, `f${i}.py`), `x${i} target-${i % 7}\n`);
  return { root, sub };
}

function withEnv(key, value, fn) {
  const saved = process.env[key];
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
  try { return fn(); } finally {
    if (saved === undefined) delete process.env[key]; else process.env[key] = saved;
  }
}

test('pureJsGrep:极小墙钟预算 → 提前收尾、truncated+timedOut,不假死', (t) => {
  const { root } = mkTree();
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

  // 已耗尽的判定器:首次检查即超预算 → walk 应立刻返回。
  const deadline = { exceeded: () => true };
  const res = pureJsGrep(root, /target/, {
    mode: 'files_with_matches', maxResults: 1000, excludeDirs: [], deadline,
  });
  assert.equal(res.success, undefined); // 原始 walk 结果形状(非结构化工具结果)
  assert.equal(res.truncated, true);
  assert.equal(res.timedOut, true);
});

test('pureJsGrepAsync:异步孪生结果与同步 pureJsGrep 一致(同一小树)', async (t) => {
  const { root } = mkTree();
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

  const opts = { mode: 'content', maxResults: 100, excludeDirs: [] };
  const syncRes = pureJsGrep(root, /target-3/, opts);
  const asyncRes = await pureJsGrepAsync(root, /target-3/, opts);
  assert.deepEqual(asyncRes.matches, syncRes.matches);
  assert.equal(asyncRes.count, syncRes.count);
  assert.equal(asyncRes.truncated, syncRes.truncated);
  assert.equal(asyncRes.timedOut, syncRes.timedOut);
});

test('grep 工具(纯JS路径):门开走异步 + 预算,极小预算下成功返回且带 timedOut', async (t) => {
  const { root, sub } = mkTree();
  for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(sub, `more${i}.py`), `line ${i} needle\n`);
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

  // 强制走纯 JS 路径(关 RTK 免得在本机命中 rtk 二进制;关 async 无所谓,门开即异步)。
  const res = await withEnv('KHY_RTK_MODE', 'off', () =>
    withEnv('KHY_FS_WALK_BUDGET_MS', '250', () =>
      grepTool.execute({
        pattern: 'needle', path: root, output_mode: 'content', max_results: 10,
      }, { traceContext: { env: {} } })));
  assert.equal(res.success, true);
  assert.equal(Array.isArray(res.matches), true);
  // 预算门控默认开:result 一定带 truncated(不管是否恰好命中预算,诚实标注都在)。
  assert.equal(typeof res.truncated, 'boolean');
});

test('grep 工具(纯JS路径):预算门控关(KHY_FS_WALK_BUDGET=off)→ 无 timedOut(字节回退)', async (t) => {
  const { root } = mkTree();
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

  const res = await withEnv('KHY_RTK_MODE', 'off', () =>
    withEnv('KHY_FS_WALK_BUDGET', 'off', () =>
      grepTool.execute({
        pattern: 'target-3', path: root, output_mode: 'content', max_results: 100,
      }, { traceContext: { env: {} } })));
  assert.equal(res.success, true);
  assert.equal(res.timedOut, undefined);
});

test('walkBudget 门控与数值解析:默认 on,预算毫秒默认 8000、clamp 生效', () => {
  assert.equal(walkBudget.isWalkBudgetEnabled({}), true);
  assert.equal(walkBudget.isWalkAsyncEnabled({}), true);
  assert.equal(walkBudget.resolveWalkBudgetMs({}), 8000);
  assert.equal(walkBudget.resolveWalkBudgetMs({ KHY_FS_WALK_BUDGET_MS: '250' }), 250);
  assert.equal(walkBudget.resolveWalkBudgetMs({ KHY_FS_WALK_BUDGET_MS: '99999999' }), 600000);
});

test('glob 工具:极小预算下成功返回,不假死;门控关无 timedOut(字节回退)', async (t) => {
  const { root, sub } = mkTree();
  for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(sub, `g${i}.py`), `x${i}\n`);
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

  const globTool = require('../../src/tools/glob');
  // 门开:async walk + 预算,结果必然成功、不悬挂。
  const res = await withEnv('KHY_FS_WALK_BUDGET_MS', '250', () =>
    globTool.execute({ pattern: '*.py', path: root }));
  assert.equal(res.success, true);
  assert.equal(Array.isArray(res.files), true);
  assert.equal(typeof res.truncated, 'boolean');

  // 门控关:无 timedOut 字段(字节回退今日无预算行为)。
  const resOff = await withEnv('KHY_FS_WALK_BUDGET', 'off', () =>
    globTool.execute({ pattern: '*.py', path: root }));
  assert.equal(resOff.success, true);
  assert.equal(resOff.timedOut, undefined);
});

test('security_scan:极小预算下成功返回并带 meta.timedOut,不假死', async (t) => {
  const { root, sub } = mkTree();
  for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(sub, `s${i}.js`), `var x${i} = ${i};\n`);
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

  const scanTool = require('../../src/tools/securityScan');
  const res = await withEnv('KHY_FS_WALK_BUDGET_MS', '250', () =>
    scanTool.execute({ cwd: root, maxFiles: 5000 }));
  assert.equal(res.success, true);
  // 预算门控默认开:meta 一定带 timedOut(布尔),诚实标注兜底在。
  assert.equal(typeof res.meta.timedOut, 'boolean');
});

test('grep content 搜索:RTK 开启但 rtk 不可用(grep 依赖缺失)时,回落原生/纯JS 仍找到真实匹配,不误报 0', async (t) => {
  const { root } = mkTree();
  fs.writeFileSync(path.join(root, 'needle.txt'), 'here is the target-42 needle\n', 'utf8');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

  // 强制 RTK 开启。本机若 rtk 存在但缺 grep 依赖 → rtk 报 "Failed to resolve 'grep'"
  // (exit code 1,非「无匹配」)。修复前会误报 count:0;修复后回落原生路径找到 target-42。
  // 若 rtk 恰好完整可用 → 直接由 rtk 返回匹配;两种情况都应找到 target-42(不误报 0)。
  const res = await withEnv('KHY_RTK_MODE', 'on', () =>
    withEnv('KHY_FS_WALK_BUDGET_MS', '8000', () =>
      grepTool.execute({
        pattern: 'target-42', path: root, output_mode: 'content', max_results: 20,
      }, { traceContext: { env: {} } })));
  assert.equal(res.success, true);
  const matches = (res.matches || []);
  assert.ok(matches.length >= 1, `RTK 不可用时应回落找到 target-42,实际 count=${res.count}`);
  assert.ok(matches.some((m) => String(m.content || '').includes('target-42')));
});

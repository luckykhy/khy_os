'use strict';

/**
 * localBrainListDir — Tier A 目录列举意图（local_list）单测（node:test，确定性）。
 *
 * 目标契约:「自然语言要能驱动一切 —— 无网络无模型(Tier A)也应可以」。此前
 * 「看看当前目录有哪些文件」无任何 handler 命中,只出兜底菜单而不真列目录。
 * 本测试锁定:
 *   - isListIntent 命中纯列举 NL / ls·dir 命令,且不误判搜索/查看/闲聊;
 *   - detectList 默认当前目录,仅显式路径 token 才改目录;
 *   - executeList 只读列目录(目录在前、按名排序、带大小、失败给中文原因);
 *   - 门控 KHY_LOCAL_LIST 关 → isListIntent 字节回退为 false;
 *   - localBrainService 经 Tier-1 注册表(cooperative,无模型时)能分派 local_list;
 *   - 既有 search/view 意图不被 local_list 抢占(注册表优先级不变)。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const fl = require('../../src/services/localBrainFileLookup');
const lb = require('../../src/services/localBrainService');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lblist-test-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('isListIntent: 命中纯列举 NL（CJK 无空格）与 ls/dir 命令', () => {
  // 规范缺口句:看看当前目录有哪些文件（CJK 无空格 → _VIEW_RE 落空,只剩 local_list）
  assert.strictEqual(fl.isListIntent('看看当前目录有哪些文件'), true);
  assert.strictEqual(fl.isListIntent('帮我看看当前目录有哪些文件'), true);
  assert.strictEqual(fl.isListIntent('这个文件夹里有什么'), true);
  assert.strictEqual(fl.isListIntent('列出当前目录的文件'), true);
  assert.strictEqual(fl.isListIntent('列目录'), true);
  assert.strictEqual(fl.isListIntent('ls'), true);
  assert.strictEqual(fl.isListIntent('ls src'), true);
  assert.strictEqual(fl.isListIntent('dir'), true);
  assert.strictEqual(fl.isListIntent('list files'), true);
  // 计数问法与列举同一能力(输出含「共 N 项」)
  assert.strictEqual(fl.isListIntent('统计这个目录有多少文件'), true);
  assert.strictEqual(fl.isListIntent('当前目录有多少个文件'), true);
});

test('isListIntent: 不误判搜索/查看/闲聊/删除', () => {
  assert.strictEqual(fl.isListIntent('今天天气怎么样'), false);
  assert.strictEqual(fl.isListIntent('查看 a.txt'), false);
  assert.strictEqual(fl.isListIntent('搜索 foo 在 /tmp'), false);
  assert.strictEqual(fl.isListIntent('这个目录不错'), false);
  assert.strictEqual(fl.isListIntent('删除目录里的临时文件'), false);
  assert.strictEqual(fl.isListIntent(''), false);
  assert.strictEqual(fl.isListIntent(null), false);
  assert.strictEqual(fl.isListIntent(123), false);
});

test('门控 KHY_LOCAL_LIST=off → isListIntent 字节回退 false', () => {
  const prev = process.env.KHY_LOCAL_LIST;
  try {
    process.env.KHY_LOCAL_LIST = 'off';
    assert.strictEqual(fl.isListIntent('看看当前目录有哪些文件'), false);
    process.env.KHY_LOCAL_LIST = '0';
    assert.strictEqual(fl.isListIntent('ls'), false);
    // 默认(未设置)→ 开
    delete process.env.KHY_LOCAL_LIST;
    assert.strictEqual(fl.isListIntent('看看当前目录有哪些文件'), true);
  } finally {
    if (prev === undefined) delete process.env.KHY_LOCAL_LIST;
    else process.env.KHY_LOCAL_LIST = prev;
  }
});

test('detectList: NL 默认当前目录;命令带相对路径解析到该目录', () => {
  const plan = fl.detectList('看看当前目录有哪些文件', { cwd: '/tmp/some/cwd' });
  assert.strictEqual(plan.type, 'local_list');
  assert.strictEqual(plan.dir, '/tmp/some/cwd');

  const plan2 = fl.detectList('ls src', { cwd: '/tmp/some/cwd' });
  assert.strictEqual(plan2.dir, path.resolve('/tmp/some/cwd', 'src'));

  // NL 含显式路径 token → 取该路径
  const plan3 = fl.detectList('看看 ./sub 目录有哪些文件', { cwd: '/tmp/some/cwd' });
  assert.strictEqual(plan3.dir, path.resolve('/tmp/some/cwd', './sub'));
});

test('executeList: 只读列目录,目录在前、带大小;空目录与非目录均给中文原因', () => {
  withTempDir((dir) => {
    fs.mkdirSync(path.join(dir, 'zsub'));
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'world!!');
    const res = fl.executeList({ dir });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.total, 3);
    // 目录在前
    assert.strictEqual(res.entries[0].kind, 'dir');
    assert.strictEqual(res.entries[0].name, 'zsub');
    // 文件带 size
    const aEntry = res.entries.find((e) => e.name === 'a.txt');
    assert.strictEqual(aEntry.kind, 'file');
    assert.strictEqual(aEntry.size, 5);
  });

  // 非目录 → 失败
  withTempDir((dir) => {
    const f = path.join(dir, 'f.txt');
    fs.writeFileSync(f, 'x');
    const res = fl.executeList({ dir: f });
    assert.strictEqual(res.success, false);
    assert.match(res.error, /不是目录|目录不存在/);
  });

  // 不存在 → 失败
  const miss = fl.executeList({ dir: '/no/such/dir/zzz' });
  assert.strictEqual(miss.success, false);
  assert.match(miss.error, /目录不存在/);
});

test('formatList: 成功/空/失败分支均产出中文摘要', () => {
  const ok = fl.formatList({ success: true, dir: '/d', total: 2, truncated: false, entries: [
    { name: 'sub', kind: 'dir', size: null },
    { name: 'a.txt', kind: 'file', size: 2048 },
  ] });
  assert.match(ok, /共 2 项/);
  assert.match(ok, /sub\//);
  assert.match(ok, /KB/);

  const empty = fl.formatList({ success: true, dir: '/d', total: 0, truncated: false, entries: [] });
  assert.match(empty, /目录为空/);

  const fail = fl.formatList({ success: false, error: '目录不存在: /x' });
  assert.match(fail, /目录列举失败/);
});

test('localBrainService 经 Tier-1 注册表分派 local_list（cooperative,无模型时）', () => {
  withTempDir((dir) => {
    fs.writeFileSync(path.join(dir, 'marker_file.txt'), 'x');
    // 用 `ls <dir>` 命令形式指向临时目录:不触发 file_view 的 _VIEW_RE(无 看看/查看
    // 等动词),也不被任何 cooperative:false 前置 handler 抢占 → 落到 local_list。
    const plan = lb.detectDeterministic('ls ' + dir, {});
    assert.ok(plan && plan.type === 'local_list', 'registry 应分派到 local_list');
    const out = lb.formatDeterministicResult(lb.executeDeterministic(plan, {}));
    assert.match(out, /marker_file\.txt/);
  });
});

test('既有 search/view 意图不被 local_list 抢占（注册表优先级不变）', () => {
  withTempDir((dir) => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'TOKEN_X\n');
    const searchPlan = lb.detectDeterministic('搜索 TOKEN_X 在 ' + dir, {});
    assert.strictEqual(searchPlan.type, 'local_search', 'search 仍优先');
    const viewPlan = lb.detectDeterministic('查看 ' + path.join(dir, 'a.txt'), {});
    assert.strictEqual(viewPlan.type, 'file_view', 'view 仍优先');
  });
});

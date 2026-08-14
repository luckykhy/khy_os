'use strict';

/**
 * listDirTool.test.js — 专用列目录工具(node:test)。
 *
 * 背景(goal 2026-07-03「分析压缩包/文件夹/盘符时文件太多抓不住重点」):khy 此前无专用
 * list_directory 工具,FileReadTool 把 agent 推去用 Bash ls/find(裸 dump)。ListDirTool 在
 * 列目录后经 fileSalience 附加「关键文件 + 目录/扩展名分组 + 最大文件」摘要。
 *
 * 本测证:① BaseTool 契约字段(toolName/category/risk/aliases/isReadOnly);② 真临时目录列举
 * → files[] 含所有文件、summary 抓住关键文件(README/package.json/index.js);③ 门控 off →
 * 模块导出 benign 非工具对象(自动发现全部跳过 = 工具不注册,今日行为);④ 坏路径不抛,返错误对象。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const TOOL_PATH = path.join(__dirname, '..', '..', 'src', 'tools', 'ListDirTool', 'index.js');
const mod = require(TOOL_PATH);
const tool = mod && mod.ListDirTool ? mod : null;

// ── BaseTool 契约(门控开,默认)────────────────────────────────────────────────
test('ListDirTool:BaseTool 契约字段', () => {
  assert.ok(tool, '门控默认开 → 导出工具实例');
  const Cls = mod.ListDirTool;
  assert.strictEqual(Cls.toolName, 'ListDir');
  assert.strictEqual(Cls.category, 'filesystem');
  assert.strictEqual(Cls.risk, 'safe');
  assert.ok(Array.isArray(Cls.aliases) && Cls.aliases.includes('list_directory'));
  assert.strictEqual(mod.isReadOnly(), true);
  assert.strictEqual(mod.isConcurrencySafe(), true);
  assert.strictEqual(typeof mod.prompt(), 'string');
});

// ── 真临时目录列举 + salience summary ──────────────────────────────────────────
test('ListDir:真临时目录 → files[] 全含 + summary 抓住关键文件', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'listdir-'));
  try {
    fs.writeFileSync(path.join(dir, 'README.md'), '# hi\n');
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x"}\n');
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'index.js'), 'module.exports={}\n');
    fs.writeFileSync(path.join(dir, 'src', 'util.js'), 'exports.f=1\n');
    // 噪声目录应被剪枝(不出现在 files[])。
    fs.mkdirSync(path.join(dir, 'node_modules'));
    fs.writeFileSync(path.join(dir, 'node_modules', 'junk.js'), 'x\n');

    const out = await mod.execute({ path: dir, depth: 3 });
    assert.strictEqual(out.success, true);
    assert.ok(Array.isArray(out.files));
    assert.ok(out.files.includes('README.md'));
    assert.ok(out.files.includes('package.json'));
    assert.ok(out.files.includes('src/index.js'));
    assert.ok(!out.files.some(f => f.includes('node_modules')), 'node_modules 被剪枝');
    assert.strictEqual(out.count, out.files.length);

    // salience summary(门控默认开)抓住关键文件。
    assert.ok(typeof out.summary === 'string' && out.summary.length > 0, '应有 summary');
    assert.ok(out.summary.includes('README.md') || out.summary.includes('package.json'),
      'summary 应突出关键文件');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ListDir:坏路径不抛,返 success:false', async () => {
  const out = await mod.execute({ path: path.join(os.tmpdir(), 'nope-does-not-exist-xyz-123') });
  assert.strictEqual(out.success, false);
  assert.ok(typeof out.error === 'string');
});

// ── 异步 walk(P3:防单个同步系统调用冻结事件循环)── 结果与同步版逐字节一致 ──────────────
test('ListDir:异步 walk(默认)与同步 walk(门控关)输出逐字节一致', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'listdir-async-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'bb\n');
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'c.js'), 'ccc\n');
    fs.mkdirSync(path.join(dir, 'node_modules'));
    fs.writeFileSync(path.join(dir, 'node_modules', 'junk.js'), 'x\n');

    const saved = process.env.KHY_FS_WALK_ASYNC;
    try {
      delete process.env.KHY_FS_WALK_ASYNC; // 默认 on → 异步 walk
      const asyncOut = await mod.execute({ path: dir, depth: 3 });
      process.env.KHY_FS_WALK_ASYNC = 'off'; // 门控关 → 同步 walk(今日行为)
      const syncOut = await mod.execute({ path: dir, depth: 3 });
      assert.strictEqual(asyncOut.success, true);
      assert.strictEqual(syncOut.success, true);
      assert.deepStrictEqual(asyncOut.files, syncOut.files, '异步/同步 files[] 逐字节一致');
      assert.strictEqual(asyncOut.count, syncOut.count);
      assert.ok(asyncOut.files.includes('sub/c.js'));
      assert.ok(!asyncOut.files.some(f => f.includes('node_modules')), 'node_modules 被剪枝');
    } finally {
      if (saved === undefined) delete process.env.KHY_FS_WALK_ASYNC;
      else process.env.KHY_FS_WALK_ASYNC = saved;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 门控 off → 工具不注册(子进程 env-at-load 验证)──────────────────────────────
test('门控 KHY_LISTDIR_TOOL=off → 模块导出 benign 非工具对象(自动发现跳过)', () => {
  const script = `
    const m = require(${JSON.stringify(TOOL_PATH)});
    // 门控关 → 导出 { _khyListDirDisabled: true },无 name / execute / BaseTool 标记
    // → tools/index.js Phase 1 Case 1-6 全部跳过 = 工具不注册。
    const isTool = m && (m.name || typeof m.execute === 'function' || m.ListDirTool);
    process.stdout.write(JSON.stringify({ disabled: !!(m && m._khyListDirDisabled), isTool: !!isTool }));
  `;
  const out = execFileSync(process.execPath, ['-e', script], {
    env: { ...process.env, KHY_LISTDIR_TOOL: 'off' },
    encoding: 'utf8',
  });
  const res = JSON.parse(out);
  assert.strictEqual(res.disabled, true, '门控关导出 _khyListDirDisabled');
  assert.strictEqual(res.isTool, false, '无工具标记 → 自动发现跳过 → 不注册');
});

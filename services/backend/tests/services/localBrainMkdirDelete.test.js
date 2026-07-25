'use strict';

/**
 * localBrainMkdirDelete — Tier A 写/删类意图(dir_create / file_delete)单测（node:test）。
 *
 * 目标契约:「自然语言要能驱动一切 —— 无网络无模型(Tier A)也应可以」的写/删闭环。此前
 * 「新建文件夹 X」「删除 X」无任何 handler 命中,只出兜底菜单。两者**非对称设计**:
 *   - dir_create(mkdir):非破坏、幂等 → 直接执行;
 *   - file_delete(rm):**破坏性** → data_cleanup 同款 confirmed 闸门(默认仅预览,须同句
 *     带明确「确认/确定/执行删除」字样才真删),叠加结构性安全护栏(拒删根/家目录/cwd/cwd 上级)。
 *
 * 本测试锁定:
 *   - mkdir 识别命令/NL 形,执行真建目录,幂等(已存在不报错),门控关字节回退;
 *   - rm 默认预览(只读、绝不删除),确认字样才真删,门控关字节回退;
 *   - 安全护栏拒删 cwd/家目录/根;不存在目标优雅报错(不抛);
 *   - 经 localBrainService Tier-1 注册表(cooperative:true)在无模型时分派;
 *   - 不误判/不抢占既有 file_op/search/view/list 意图。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const lb = require('../../src/services/localBrainService');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lbmkrm-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// ── mkdir (dir_create) ────────────────────────────────────────────────

test('mkdir: 识别命令/NL 形并真建目录;幂等', () => {
  withTempDir((dir) => {
    const opts = { cwd: dir };
    for (const phrase of ['新建文件夹 build', '创建目录 logs', 'mkdir nested/deep']) {
      const p = lb.detectDeterministic(phrase, opts);
      assert.ok(p && p.type === 'dir_create', `「${phrase}」应命中 dir_create`);
      const res = lb.executeDeterministic(p, opts);
      assert.strictEqual(res.success, true, `「${phrase}」应建目录成功`);
    }
    assert.ok(fs.existsSync(path.join(dir, 'build')) && fs.statSync(path.join(dir, 'build')).isDirectory());
    assert.ok(fs.existsSync(path.join(dir, 'logs')));
    assert.ok(fs.existsSync(path.join(dir, 'nested', 'deep')), 'recursive 应创建多级');

    // 幂等:再建已存在目录不报错
    const p2 = lb.detectDeterministic('新建文件夹 build', opts);
    const res2 = lb.executeDeterministic(p2, opts);
    assert.strictEqual(res2.success, true);
    assert.strictEqual(res2.already, true);
  });
});

test('mkdir: 同名文件已存在(非目录)→ 失败给中文原因,不抛', () => {
  withTempDir((dir) => {
    fs.writeFileSync(path.join(dir, 'conflict'), 'x');
    const p = lb.detectDeterministic('新建文件夹 conflict', { cwd: dir });
    const res = lb.executeDeterministic(p, { cwd: dir });
    assert.strictEqual(res.success, false);
    assert.match(res.error, /已存在同名文件/);
  });
});

test('mkdir 门控 KHY_DIR_CREATE=off → 字节回退(不命中)', () => {
  const prev = process.env.KHY_DIR_CREATE;
  try {
    process.env.KHY_DIR_CREATE = 'off';
    assert.strictEqual(lb.detectDeterministic('新建文件夹 build', { cwd: '/tmp' }), null);
    delete process.env.KHY_DIR_CREATE;
    const p = lb.detectDeterministic('新建文件夹 build', { cwd: '/tmp' });
    assert.ok(p && p.type === 'dir_create', '默认(未设)→ 开');
  } finally {
    if (prev === undefined) delete process.env.KHY_DIR_CREATE;
    else process.env.KHY_DIR_CREATE = prev;
  }
});

// ── rm (file_delete，确认闸门) ─────────────────────────────────────────

test('rm: 默认仅预览(只读、绝不删除)', () => {
  withTempDir((dir) => {
    const f = path.join(dir, 'tmp.txt');
    fs.writeFileSync(f, 'hello');
    const opts = { cwd: dir };
    const p = lb.detectDeterministic('删除 tmp.txt', opts);
    assert.ok(p && p.type === 'file_delete');
    assert.strictEqual(p.confirmed, false, '无确认字样 → confirmed=false');
    const res = lb.executeDeterministic(p, opts);
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.preview, true);
    assert.ok(fs.existsSync(f), '预览绝不删除');
    const out = lb.formatDeterministicResult(res);
    assert.match(out, /删除预览（未执行）/);
    assert.match(out, /确认删除/);
  });
});

test('rm: 同句带确认字样 → 真正删除文件与目录', () => {
  withTempDir((dir) => {
    const f = path.join(dir, 'tmp.txt');
    fs.writeFileSync(f, 'hello');
    const opts = { cwd: dir };
    const c = lb.detectDeterministic('确认删除 tmp.txt', opts);
    assert.ok(c && c.type === 'file_delete');
    assert.strictEqual(c.confirmed, true);
    const res = lb.executeDeterministic(c, opts);
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.preview, false);
    assert.ok(!fs.existsSync(f), '确认后文件应被删除');

    // 目录递归删除(确认)
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'a.txt'), 'x');
    const cd = lb.detectDeterministic('删除目录 sub 确认', opts);
    assert.ok(cd && cd.type === 'file_delete' && cd.confirmed === true);
    const rd = lb.executeDeterministic(cd, opts);
    assert.strictEqual(rd.success, true);
    assert.ok(!fs.existsSync(path.join(dir, 'sub')), '确认后目录应被递归删除');
  });
});

test('rm: 安全护栏拒删 cwd/家目录/根;不存在目标优雅报错', () => {
  withTempDir((dir) => {
    const opts = { cwd: dir };
    // 删 cwd 本身(用 . 或绝对路径)
    const pCwd = lb.detectDeterministic('确认删除 ' + dir, opts);
    if (pCwd && pCwd.type === 'file_delete') {
      const r = lb.executeDeterministic(pCwd, opts);
      assert.strictEqual(r.success, false);
      assert.match(r.error, /拒绝删除/);
    }
    // 删家目录
    const pHome = lb.detectDeterministic('确认删除 ' + os.homedir(), opts);
    if (pHome && pHome.type === 'file_delete') {
      const r = lb.executeDeterministic(pHome, opts);
      assert.strictEqual(r.success, false);
      assert.match(r.error, /拒绝删除/);
    }
    // 不存在目标
    const pMiss = lb.detectDeterministic('确认删除 no_such_file.xyz', opts);
    const rMiss = lb.executeDeterministic(pMiss, opts);
    assert.strictEqual(rMiss.success, false);
    assert.match(rMiss.error, /目标不存在/);
  });
});

test('rm: 保守判据 — 无具体目标的删除句不拦截(避免吞「删除这行代码」)', () => {
  // 「删除这行代码」无扩展名/分隔符,且不含「文件/文件夹/目录」→ 不命中 file_delete
  const p = lb.detectDeterministic('删除这行代码', { cwd: '/tmp' });
  assert.ok(!p || p.type !== 'file_delete', '不应拦截无具体文件目标的删除句');
});

test('rm 门控 KHY_FILE_DELETE=off → 字节回退(不命中)', () => {
  const prev = process.env.KHY_FILE_DELETE;
  try {
    process.env.KHY_FILE_DELETE = 'off';
    assert.strictEqual(lb.detectDeterministic('删除 tmp.txt', { cwd: '/tmp' }), null);
    delete process.env.KHY_FILE_DELETE;
    const p = lb.detectDeterministic('删除 tmp.txt', { cwd: '/tmp' });
    assert.ok(p && p.type === 'file_delete', '默认(未设)→ 开');
  } finally {
    if (prev === undefined) delete process.env.KHY_FILE_DELETE;
    else process.env.KHY_FILE_DELETE = prev;
  }
});

// ── 不抢占既有意图(回归保护) ──────────────────────────────────────────

test('不误判/不抢占既有 file_op / search / view / list', () => {
  const cwd = '/tmp/mkrm-reg';
  const move = lb.detectDeterministic('把 a.txt 移到 backup/', { cwd });
  assert.strictEqual(move && move.type, 'file_op', 'file_op 仍优先(不被 delete/mkdir 抢)');
  const ren = lb.detectDeterministic('重命名 a.txt 为 b.txt', { cwd });
  assert.strictEqual(ren && ren.type, 'file_op');
  withTempDir((dir) => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'TOKEN\n');
    const s = lb.detectDeterministic('搜索 TOKEN 在 ' + dir, { cwd });
    assert.strictEqual(s && s.type, 'local_search');
    const v = lb.detectDeterministic('查看 ' + path.join(dir, 'a.txt'), { cwd });
    assert.strictEqual(v && v.type, 'file_view');
    const l = lb.detectDeterministic('ls ' + dir, { cwd });
    assert.strictEqual(l && l.type, 'local_list');
  });
});

'use strict';

/**
 * atomicWriteMigration.test.js — F2 第一批「裸 writeFileSync → 原子写」迁移的回归网。
 *
 * 这一批迁移的**唯一意图**是换掉写入原语(临时文件 + rename),盘上字节、文件权限、
 * 调用方可见的失败语义都必须与迁移前逐字节一致。因此本文件不测「原子写好不好用」
 * (那是 atomicWriteJson.test.js 的事),只钉三件会让迁移悄悄破坏存量数据的事:
 *
 *   1. **字节等价**:atomicWriteJson/atomicWriteText 的输出与它们替换掉的那行
 *      `fs.writeFileSync(...)` 字节相同 —— 包含 mcpConfigStore 的尾换行、
 *      apiKeyPool/customProviderRegistry 的 legacy 逐字节搬运。
 *   2. **权限不变**:迁移点一律显式传 mode(0o666 = writeFileSync 的默认值,实际权限
 *      由 umask 定;msgConfigStore/sessionPersistence 保持既有的 0600)。atomicWriteJson
 *      的默认值是 0600,少传一个 mode 就会静默收紧共享 KHY_DATA_HOME 的可读性。
 *   3. **失败仍可见**:atomicWriteJson 返回 false 而不抛。原来靠 writeFileSync 抛异常
 *      让上层感知失败的调用点(mcpConfigStore / msgConfigStore / evoLedger / traceChain /
 *      sessionPersistence._writeAtomic)必须把 false 变回异常;meshStore 必须变回
 *      {ok:false,error}。这条最容易在迁移里被漏掉,漏了就是静默丢数据。
 *
 * 数据家全部重定向到临时目录(KHY_DATA_HOME / KHY_PROJECT_DATA_HOME / KHYOS_HOME),
 * 必须在 require 任何服务之前设置 —— 各解析器在 require 时缓存路径。
 */

const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, describe } = require('node:test');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-atomic-migration-'));
process.env.KHY_DATA_HOME = path.join(TMP, 'khy');
process.env.KHY_PROJECT_DATA_HOME = path.join(TMP, 'project');
process.env.KHYOS_HOME = path.join(TMP, 'khyos');

const atomicWriteJson = require('../src/utils/atomicWriteJson');
const { atomicWriteText } = require('../src/utils/atomicWriteJson');

const IS_WIN = process.platform === 'win32';

let _n = 0;
function _tmpFile(name) {
  _n += 1;
  const dir = path.join(TMP, `case-${_n}`);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name || 'x.json');
}

/** 目标目录里不允许残留任何 .tmp- 中间文件。 */
function _noLeftovers(file) {
  const left = fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.tmp-'));
  assert.deepStrictEqual(left, [], `残留临时文件: ${left.join(', ')}`);
}

/** 读回原始字节(不做任何解码归一)。 */
function _bytes(file) {
  return fs.readFileSync(file);
}

// 迁移点上真实出现过的负载形状(权限表/用量表/代理配置/provider 数组/presence/链)。
const PAYLOADS = [
  ['permissionStore 形状', { approved: {}, denied: {}, dangerousAcknowledged: false }],
  ['嵌套对象', { a: { b: { c: [1, 2, 3] } }, d: null, e: '' }],
  ['数组顶层(customProviderRegistry)', [{ poolKey: 'x', name: '名字', models: ['m1'] }]],
  ['空对象', {}],
  ['空数组', []],
  ['非 ASCII 与转义', { 中文键: '值\n带换行', quote: 'a"b', tab: '\t', emoji: '🌱' }],
  ['数字边界', { zero: 0, neg: -1, float: 1.5, big: 9007199254740991 }],
];

describe('迁移字节等价:atomicWriteJson vs 被替换掉的 writeFileSync', () => {
  for (const [label, payload] of PAYLOADS) {
    test(`${label} —— 与 JSON.stringify(x, null, 2) 字节相同`, () => {
      const a = _tmpFile('atomic.json');
      const b = _tmpFile('legacy.json');
      assert.strictEqual(atomicWriteJson(a, payload, { mode: 0o666 }), true);
      fs.writeFileSync(b, JSON.stringify(payload, null, 2));
      assert.deepStrictEqual(_bytes(a), _bytes(b));
      _noLeftovers(a);
    });
  }

  test('trailingNewline:true —— 与 `${JSON.stringify(x, null, 2)}\\n` 字节相同(mcpConfigStore)', () => {
    const cfg = { mcpServers: { demo: { command: 'node', args: ['s.js'] } } };
    const a = _tmpFile('atomic.json');
    const b = _tmpFile('legacy.json');
    assert.strictEqual(
      atomicWriteJson(a, cfg, { mode: 0o666, trailingNewline: true }),
      true
    );
    fs.writeFileSync(b, `${JSON.stringify(cfg, null, 2)}\n`, 'utf-8');
    assert.deepStrictEqual(_bytes(a), _bytes(b));
    // 尾换行是**一个**,不是零个也不是两个 —— project 作用域的 .khy/mcp.json 常被提交进仓库。
    const text = fs.readFileSync(a, 'utf-8');
    assert.ok(text.endsWith('}\n'), '应恰好以一个换行结尾');
    assert.ok(!text.endsWith('\n\n'), '不应出现两个换行');
  });

  test('默认(不传 trailingNewline)不会偷偷补尾换行', () => {
    const a = _tmpFile('atomic.json');
    atomicWriteJson(a, { k: 1 }, { mode: 0o666 });
    assert.strictEqual(fs.readFileSync(a, 'utf-8').endsWith('\n'), false);
  });
});

describe('迁移字节等价:atomicWriteText vs writeFileSync(逐字节搬运场景)', () => {
  // legacy 迁移(apiKeyPool / customProviderRegistry)读旧文件写新路径:重新序列化会改变
  // 缩进与键序,那就不再是「搬运」而是「改写用户数据」。这些形状必须原样落盘。
  const TEXTS = [
    ['四空格缩进的旧文件', '{\n    "keys": [\n        "sk-a"\n    ]\n}'],
    ['单行紧凑 JSON', '{"a":1,"b":2}'],
    ['键序与格式化都反常', '{ "z" : 1 ,\n"a":2}\n'],
    ['CRLF 行尾', '{\r\n  "a": 1\r\n}\r\n'],
    ['带 BOM', '﻿{"a":1}'],
    ['无尾换行', '{"a":1}'],
    ['两个尾换行', '{"a":1}\n\n'],
    ['非 ASCII', '{"名字":"值","emoji":"🌱"}'],
    ['空字符串', ''],
    ['快照正文(growthService.restoreSnapshot)', 'line1\nline2\n'],
  ];
  for (const [label, text] of TEXTS) {
    test(`${label} —— 与 writeFileSync(s, 'utf-8') 字节相同`, () => {
      const a = _tmpFile('atomic.txt');
      const b = _tmpFile('legacy.txt');
      assert.strictEqual(atomicWriteText(a, text, { mode: 0o666 }), true);
      fs.writeFileSync(b, text, 'utf-8');
      assert.deepStrictEqual(_bytes(a), _bytes(b));
      _noLeftovers(a);
    });
  }

  test('读旧写新往返:legacy 文件字节在搬运后完全不变', () => {
    const legacy = _tmpFile('legacy_pool.json');
    const raw = '{\n    "deepseek": [ "sk-1" ],\n  "qwen":["sk-2"]\n}\n';
    fs.writeFileSync(legacy, raw, 'utf-8');
    const moved = _tmpFile('api_keys.json');
    assert.strictEqual(
      atomicWriteText(moved, fs.readFileSync(legacy, 'utf-8'), { mode: 0o666 }),
      true
    );
    assert.deepStrictEqual(_bytes(moved), _bytes(legacy));
  });
});

describe('权限不变:显式 mode 与 writeFileSync 默认值一致', () => {
  test('mode 0o666 与 fs.writeFileSync 默认权限一致(受同一 umask 影响)', (t) => {
    if (IS_WIN) {
      t.skip('Windows 不适用 POSIX 权限位');
      return;
    }
    const a = _tmpFile('atomic.json');
    const b = _tmpFile('legacy.json');
    atomicWriteJson(a, { k: 1 }, { mode: 0o666 });
    fs.writeFileSync(b, '{}');
    assert.strictEqual(fs.statSync(a).mode & 0o777, fs.statSync(b).mode & 0o777);
  });

  test('不传 mode 会落到 0600 —— 这正是迁移必须显式传 0o666 的原因', (t) => {
    if (IS_WIN) {
      t.skip('Windows 不适用 POSIX 权限位');
      return;
    }
    const a = _tmpFile('atomic.json');
    atomicWriteJson(a, { k: 1 });
    assert.strictEqual(fs.statSync(a).mode & 0o777, 0o600);
  });

  test('凭据文件保持 0600(msgConfigStore / sessionPersistence 的既有约定)', (t) => {
    if (IS_WIN) {
      t.skip('Windows 不适用 POSIX 权限位');
      return;
    }
    const a = _tmpFile('creds.json');
    atomicWriteJson(a, { secret: 's' }, { mode: 0o600 });
    assert.strictEqual(fs.statSync(a).mode & 0o777, 0o600);
  });

  test('覆盖已有文件不改变其权限位(rename 后的目标沿用 tmp 的 mode)', (t) => {
    if (IS_WIN) {
      t.skip('Windows 不适用 POSIX 权限位');
      return;
    }
    const a = _tmpFile('exists.json');
    fs.writeFileSync(a, '{}');
    fs.chmodSync(a, 0o644);
    atomicWriteJson(a, { k: 2 }, { mode: 0o644 });
    assert.strictEqual(fs.statSync(a).mode & 0o777, 0o644);
  });
});

describe('端到端:mcpConfigStore(注入路径,尾换行)', () => {
  const store = require('../src/services/mcp/mcpConfigStore');

  function _fresh() {
    const home = _tmpFile('home');
    fs.mkdirSync(home, { recursive: true });
    return home;
  }

  test('addServer 落盘字节 = JSON.stringify(config, null, 2) + 换行', () => {
    const dataHome = _fresh();
    const r = store.addServer('demo', { command: 'node', args: ['a.js'] }, { dataHome });
    assert.strictEqual(r.replaced, false);
    const text = fs.readFileSync(r.path, 'utf-8');
    const parsed = JSON.parse(text);
    assert.strictEqual(text, `${JSON.stringify(parsed, null, 2)}\n`);
    _noLeftovers(r.path);
  });

  test('同名覆盖只改一个键,其余顶层字段与 server 原样保留', () => {
    const dataHome = _fresh();
    const file = path.join(dataHome, 'mcp.json');
    fs.writeFileSync(
      file,
      `${JSON.stringify({ 自定义顶层: 1, mcpServers: { keep: { command: 'keep' } } }, null, 2)}\n`
    );
    const r = store.addServer('demo', { command: 'node' }, { dataHome });
    assert.strictEqual(r.replaced, false);
    const cfg = JSON.parse(fs.readFileSync(file, 'utf-8'));
    assert.strictEqual(cfg['自定义顶层'], 1);
    assert.strictEqual(cfg.mcpServers.keep.command, 'keep');
    assert.strictEqual(cfg.mcpServers.demo.command, 'node');
    const r2 = store.addServer('demo', { command: 'node2' }, { dataHome });
    assert.strictEqual(r2.replaced, true);
  });

  test('写入失败仍抛异常(调用方一直靠异常感知失败)', () => {
    const dataHome = _fresh();
    // 目标路径被一个**目录**占住 → rename 必失败。迁移前 writeFileSync 抛,迁移后必须照抛。
    fs.mkdirSync(path.join(dataHome, 'mcp.json'), { recursive: true });
    assert.throws(() => store.addServer('demo', { command: 'node' }, { dataHome }));
  });
});

describe('端到端:traceChain(哈希链 sidecar,失败即抛 → {ok:false})', () => {
  const traceChain = require('../src/services/trajectoryProvenance/traceChain');

  test('append 后字节 = pretty-2 无尾换行,且 verify 通过', () => {
    const chainFile = _tmpFile('s.trace-chain.json');
    const r1 = traceChain.append(chainFile, { uuid: 'u1', producer: 'user', trust: 'high' });
    assert.strictEqual(r1.ok, true, r1.error || '');
    const r2 = traceChain.append(chainFile, { uuid: 'u2', producer: 'model', trust: 'low' });
    assert.strictEqual(r2.ok, true, r2.error || '');
    const text = fs.readFileSync(chainFile, 'utf-8');
    assert.strictEqual(text, JSON.stringify(JSON.parse(text), null, 2));
    assert.strictEqual(traceChain.verify(chainFile).ok, true);
    _noLeftovers(chainFile);
  });

  test('写入失败 → append 返回 {ok:false},不静默成功', () => {
    const chainFile = _tmpFile('blocked.trace-chain.json');
    fs.mkdirSync(chainFile, { recursive: true }); // 目标被目录占住
    const r = traceChain.append(chainFile, { uuid: 'u1', producer: 'user', trust: 'high' });
    assert.strictEqual(r.ok, false);
    assert.ok(r.error, '失败必须带 error');
  });
});

describe('端到端:evoLedger(进化黑历史,fsync 强制开)', () => {
  const ledger = require('../src/services/evoEngine/evoLedger');
  const branch = `mig-${crypto.randomBytes(3).toString('hex')}`;

  test('append 后字节 = pretty-2 无尾换行,verify 通过,链可续写', () => {
    const a = ledger.append(ledger.KIND.REQUIREMENT, { want: '备份工具' }, { branch });
    assert.strictEqual(a.ok, true, a.error || '');
    const b = ledger.append(ledger.KIND.SANDBOX, { verdict: 'pass' }, { branch });
    assert.strictEqual(b.ok, true, b.error || '');
    assert.strictEqual(b.seq, a.seq + 1);
    const file = ledger._file(branch);
    const text = fs.readFileSync(file, 'utf-8');
    assert.strictEqual(text, JSON.stringify(JSON.parse(text), null, 2));
    assert.strictEqual(ledger.verify({ branch }).ok, true);
    assert.strictEqual(ledger.read({ branch }).length, 2);
    _noLeftovers(file);
  });

  test('写入失败 → append 返回 {ok:false}(原实现靠 _writeRaw 抛错)', () => {
    const blocked = `mig-blocked-${crypto.randomBytes(3).toString('hex')}`;
    const file = ledger._file(blocked);
    fs.mkdirSync(file, { recursive: true });
    const r = ledger.append(ledger.KIND.ALERT, { x: 1 }, { branch: blocked });
    assert.strictEqual(r.ok, false);
    assert.ok(r.error, '失败必须带 error');
  });
});

describe('端到端:msgConfigStore(凭据文件 0600 + .bak)', () => {
  const store = require('../src/services/messaging/msgConfigStore');
  const file = path.join(process.env.KHYOS_HOME, 'msg.json');

  test('setPlatform 落盘字节 = pretty-2 无尾换行,权限 0600,.bak 在二次写时生成', (t) => {
    fs.rmSync(file, { force: true });
    fs.rmSync(path.join(process.env.KHYOS_HOME, 'msg.bak'), { force: true });

    assert.strictEqual(store.setPlatform('dingtalk', { webhook: 'https://x/y', secret: 's' }).ok, true);
    const text = fs.readFileSync(file, 'utf-8');
    assert.strictEqual(text, JSON.stringify(JSON.parse(text), null, 2));
    assert.strictEqual(fs.existsSync(path.join(process.env.KHYOS_HOME, 'msg.bak')), false);
    if (!IS_WIN) {
      assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
    } else {
      t.diagnostic('Windows:跳过权限位断言');
    }

    // 二次写:先备份旧文件,再原子替换。旧 platform 不被抹掉。
    assert.strictEqual(store.setPlatform('feishu', { webhook: 'https://f/w' }).ok, true);
    assert.strictEqual(fs.existsSync(path.join(process.env.KHYOS_HOME, 'msg.bak')), true);
    assert.ok(store.getPlatform('dingtalk'));
    assert.ok(store.getPlatform('feishu'));
    _noLeftovers(file);
  });
});

describe('端到端:meshStore(presence,失败 → {ok:false,error})', () => {
  const mesh = require('../src/services/meshStore');

  test('register 落盘字节 = pretty-2 无尾换行,listPeers 读回', () => {
    const r = mesh.register({ id: 'mig-peer-a', name: 'a', pid: process.pid });
    assert.strictEqual(r.ok, true, r.error || '');
    const file = path.join(process.env.KHYOS_HOME, 'peers', 'mig-peer-a.json');
    const text = fs.readFileSync(file, 'utf-8');
    assert.strictEqual(text, JSON.stringify(JSON.parse(text), null, 2));
    assert.ok(mesh.listPeers().some((p) => p.id === 'mig-peer-a'));
    _noLeftovers(file);
    mesh.deregister('mig-peer-a');
  });

  test('写入失败 → register 返回 {ok:false,error},绝不谎报成功', () => {
    const id = 'mig-peer-blocked';
    const file = path.join(process.env.KHYOS_HOME, 'peers', `${id}.json`);
    fs.rmSync(file, { force: true, recursive: true });
    fs.mkdirSync(file, { recursive: true }); // 目标被目录占住
    const r = mesh.register({ id, name: 'b', pid: process.pid });
    assert.strictEqual(r.ok, false);
    assert.ok(r.error, '失败必须带 error');
    fs.rmSync(file, { force: true, recursive: true });
  });
});

describe('端到端:sessionPersistence(.project.json 与快照)', () => {
  const sp = require('../src/services/sessionPersistence');

  test('persistSession 写出的快照与 .project.json 都是 pretty-2 无尾换行', () => {
    const cwd = path.join(TMP, 'fake-project');
    fs.mkdirSync(cwd, { recursive: true });
    const sid = `mig-${crypto.randomBytes(4).toString('hex')}`;
    sp.persistSession(sid, {
      title: '备份工具',
      model: 'claude-opus-5',
      messages: [{ role: 'user', content: '你好' }],
      metadata: { cwd },
    });

    const bucket = path.join(
      process.env.KHY_PROJECT_DATA_HOME,
      'sessions',
      cwd.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-')
    );
    const meta = path.join(bucket, '.project.json');
    const metaText = fs.readFileSync(meta, 'utf-8');
    assert.strictEqual(metaText, JSON.stringify(JSON.parse(metaText), null, 2));
    assert.strictEqual(JSON.parse(metaText).cwd, cwd);

    const snap = path.join(bucket, `${sid}.json`);
    const snapText = fs.readFileSync(snap, 'utf-8');
    assert.strictEqual(snapText, JSON.stringify(JSON.parse(snapText), null, 2));
    assert.strictEqual(JSON.parse(snapText).title, '备份工具');
    _noLeftovers(snap);

    // 快照可被 restoreSession 读回(迁移不能破坏恢复路径)。
    const restored = sp.restoreSession(sid);
    assert.ok(restored, '会话应可恢复');
    assert.strictEqual(restored.title, '备份工具');
  });

  test('.project.json 是就地更新而非覆盖丢字段', () => {
    const cwd = path.join(TMP, 'fake-project-2');
    fs.mkdirSync(cwd, { recursive: true });
    const bucket = path.join(
      process.env.KHY_PROJECT_DATA_HOME,
      'sessions',
      cwd.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-')
    );
    fs.mkdirSync(bucket, { recursive: true });
    const meta = path.join(bucket, '.project.json');
    fs.writeFileSync(meta, JSON.stringify({ 自定义: '保留我' }, null, 2));
    sp.persistSession(`mig-${crypto.randomBytes(4).toString('hex')}`, {
      messages: [],
      metadata: { cwd },
    });
    const parsed = JSON.parse(fs.readFileSync(meta, 'utf-8'));
    assert.strictEqual(parsed['自定义'], '保留我');
    assert.strictEqual(parsed.cwd, cwd);
  });

  test('_writeAtomic 的失败即抛契约仍在(saveCheckpoint 目标被目录占住)', () => {
    const cwd = path.join(TMP, 'fake-project-3');
    fs.mkdirSync(cwd, { recursive: true });
    const sid = `migblocked${crypto.randomBytes(3).toString('hex')}`;
    const bucket = path.join(
      process.env.KHY_PROJECT_DATA_HOME,
      'sessions',
      cwd.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-')
    );
    fs.mkdirSync(bucket, { recursive: true });
    // 快照路径被目录占住:persistSession 首轮同步写 → 异常必须向上传播。
    fs.mkdirSync(path.join(bucket, `${sid}.json`), { recursive: true });
    assert.throws(() =>
      sp.persistSession(sid, { messages: [{ role: 'user', content: 'x' }], metadata: { cwd } })
    );
  });
});

describe('端到端:customProviderRegistry(数组顶层)', () => {
  const reg = require('../src/services/customProviderRegistry');
  const file = path.join(process.env.KHY_DATA_HOME, 'custom_providers.json');

  test('saveProvider 落盘字节 = pretty-2 无尾换行,读回一致', () => {
    reg._resetCache();
    fs.rmSync(file, { force: true });
    reg.saveProvider({ poolKey: 'mig-p', name: '迁移测试', endpoint: 'https://e', models: ['m'] });
    const text = fs.readFileSync(file, 'utf-8');
    assert.strictEqual(text, JSON.stringify(JSON.parse(text), null, 2));
    assert.ok(Array.isArray(JSON.parse(text)));
    reg._resetCache();
    assert.strictEqual(reg.getProvider('mig-p').name, '迁移测试');
    _noLeftovers(file);
    assert.strictEqual(reg.removeProvider('mig-p'), true);
  });
});

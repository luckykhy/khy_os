'use strict';

/**
 * ledgerWriter.test.js — 安装台账写入 IO 边界 + 创建点接线(node:test)。
 *
 * 锁死块C:
 *   - appendSideEffect:门开 → 追加一行合法 jsonl;门关 → no-op(不写盘,逐字节回退);
 *   - append-only:多次调用累加不覆盖;
 *   - 绝不抛(hostile 输入 / 不可写路径);
 *   - mdEditorRegister 的 'already' 分支会经台账记一条 unregister-md-editor(创建点已接线);
 *   - 与 uninstall handler 回滚闭环:写入的记录被 _rollbackLedger 读回并计算出回滚步骤。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const writer = require('../../src/services/uninstall/ledgerWriter');
const handler = require('../../src/cli/handlers/uninstall');

function _tmpHome() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-writer-'));
  const dataHome = path.join(base, '.khy');
  fs.mkdirSync(dataHome, { recursive: true });
  return { base, dataHome, cleanup: () => { try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ } } };
}

test('appendSideEffect writes one valid jsonl line when gate on', () => {
  const h = _tmpHome();
  try {
    const ok = writer.appendSideEffect(
      { kind: 'runtime', target: path.join(h.base, 'portable-node'), action: 'remove-runtime', meta: { label: 'node' }, ts: 1700000000000 },
      { env: { KHY_DATA_HOME: h.dataHome } });
    assert.equal(ok, true);
    const file = path.join(h.dataHome, '.install-ledger.jsonl');
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const rec = JSON.parse(lines[0]);
    assert.equal(rec.kind, 'runtime');
    assert.equal(rec.action, 'remove-runtime');
    assert.equal(rec.meta.label, 'node');
  } finally { h.cleanup(); }
});

test('appendSideEffect is a no-op when gate off (byte-revert)', () => {
  const h = _tmpHome();
  try {
    const ok = writer.appendSideEffect(
      { kind: 'file', target: path.join(h.base, 'x'), action: 'unlink' },
      { env: { KHY_DATA_HOME: h.dataHome, KHY_INSTALL_LEDGER: 'off' } });
    assert.equal(ok, false);
    assert.equal(fs.existsSync(path.join(h.dataHome, '.install-ledger.jsonl')), false);
  } finally { h.cleanup(); }
});

test('appendSideEffect appends (does not overwrite)', () => {
  const h = _tmpHome();
  try {
    const env = { KHY_DATA_HOME: h.dataHome };
    writer.appendSideEffect({ kind: 'file', target: path.join(h.base, 'a'), action: 'unlink', ts: 1 }, { env });
    writer.appendSideEffect({ kind: 'file', target: path.join(h.base, 'b'), action: 'unlink', ts: 2 }, { env });
    const lines = fs.readFileSync(path.join(h.dataHome, '.install-ledger.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
  } finally { h.cleanup(); }
});

test('appendSideEffect never throws on hostile input', () => {
  assert.doesNotThrow(() => writer.appendSideEffect(null, { env: {} }));
  assert.doesNotThrow(() => writer.appendSideEffect({ kind: 'nope' }, { env: {} }));
});

test('written records round-trip through uninstall handler rollback', () => {
  const h = _tmpHome();
  try {
    const env = { KHY_DATA_HOME: h.dataHome };
    const rtDir = path.join(h.base, 'runtime-dir');
    fs.mkdirSync(rtDir, { recursive: true });
    writer.appendSideEffect({ kind: 'runtime', target: rtDir, action: 'remove-runtime' }, { env });
    writer.appendSideEffect({ kind: 'registration', target: 'md-editor:linux', action: 'unregister-md-editor' }, { env });

    const preview = handler._rollbackLedger(env, { dryRun: true });
    assert.equal(preview.entryCount, 2);
    // registration ordered before runtime.
    assert.equal(preview.steps[0].kind, 'registration');
    assert.ok(preview.steps.some((s) => s.action === 'remove-runtime'));
  } finally { h.cleanup(); }
});

test('mdEditorRegister already-branch records an unregister-md-editor ledger entry', () => {
  const h = _tmpHome();
  try {
    const md = require('../../src/services/mdEditorRegister');
    const env = {
      KHY_DATA_HOME: h.dataHome,
      KHY_MD_EDITOR: '1',
      KHY_MD_AUTO_REGISTER: '1',
      KHY_INSTALL_LEDGER: '1',
    };
    // Force the authoritative 'already' branch: platform linux + system reports registered.
    const res = md.ensureMdRegistered(env, {
      platform: 'linux',
      target: path.join(h.dataHome, '.md-registered'),
      spawnSync: () => ({ status: 0 }),
      existsSync: () => true, // isRegistered → desktop file present
    });
    assert.equal(res, 'already');
    const file = path.join(h.dataHome, '.install-ledger.jsonl');
    assert.ok(fs.existsSync(file), 'ledger line written on registration');
    const rec = JSON.parse(fs.readFileSync(file, 'utf8').trim().split('\n')[0]);
    assert.equal(rec.action, 'unregister-md-editor');
    assert.equal(rec.kind, 'registration');
  } finally { h.cleanup(); }
});

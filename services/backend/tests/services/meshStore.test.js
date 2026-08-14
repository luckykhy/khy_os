'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// KHYOS_HOME must be set BEFORE requiring dataHome (it caches base home on first call).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-mesh-test-'));
process.env.KHYOS_HOME = TMP;

const store = require('../../src/services/meshStore');

test('empty mesh lists nothing', () => {
  assert.deepStrictEqual(store.listPeers(), []);
});

test('register creates a live presence (self pid) and listPeers shows it', () => {
  const r = store.register({ id: 'inst-a', name: 'Alpha' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.id, 'inst-a');

  const peers = store.listPeers({ selfId: 'inst-a' });
  assert.strictEqual(peers.length, 1);
  assert.strictEqual(peers[0].id, 'inst-a');
  assert.strictEqual(peers[0].name, 'Alpha');
  assert.strictEqual(peers[0].isSelf, true);
  assert.strictEqual(peers[0].pid, process.pid);

  // presence file lives under ~/.khyos/peers
  assert.ok(fs.existsSync(path.join(TMP, 'peers', 'inst-a.json')));
});

test('dead peer is pruned on listPeers', () => {
  // hand-write a presence with an impossible pid
  const dir = path.join(TMP, 'peers');
  fs.writeFileSync(
    path.join(dir, 'inst-dead.json'),
    JSON.stringify({ id: 'inst-dead', pid: 2147483640, startedAt: '2026-01-01' }),
    'utf-8',
  );
  const peers = store.listPeers();
  assert.ok(!peers.find((p) => p.id === 'inst-dead'));
  // pruned from disk
  assert.ok(!fs.existsSync(path.join(dir, 'inst-dead.json')));
});

test('auto-generated id when none provided', () => {
  const r = store.register({ name: 'auto' });
  assert.strictEqual(r.ok, true);
  assert.ok(/^auto-/.test(r.id) || /^khy-/.test(r.id));
  store.deregister(r.id);
});

test('send delivers to a live peer inbox; drain reads and clears', () => {
  store.register({ id: 'inst-b', name: 'Beta' });
  const s = store.send('inst-a', 'inst-b', 'hello beta');
  assert.strictEqual(s.ok, true);
  assert.strictEqual(store.peekInbox('inst-b'), 1);

  // a second message
  store.send('inst-a', 'inst-b', 'second');
  assert.strictEqual(store.peekInbox('inst-b'), 2);

  const drained = store.drainInbox('inst-b');
  assert.strictEqual(drained.ok, true);
  assert.strictEqual(drained.messages.length, 2);
  assert.strictEqual(drained.messages[0].from, 'inst-a');
  assert.strictEqual(drained.messages[0].text, 'hello beta');
  assert.strictEqual(drained.messages[1].text, 'second');

  // inbox now empty
  assert.strictEqual(store.peekInbox('inst-b'), 0);
  assert.deepStrictEqual(store.drainInbox('inst-b').messages, []);
});

test('send to offline/unknown peer fails', () => {
  const s = store.send('inst-a', 'ghost', 'anyone?');
  assert.strictEqual(s.ok, false);
  assert.match(s.error, /不在线|不存在/);
});

test('attach/detach updates presence.attachedTo', () => {
  const a = store.attach('inst-a', 'inst-b');
  assert.strictEqual(a.ok, true);
  let peers = store.listPeers();
  assert.strictEqual(peers.find((p) => p.id === 'inst-a').attachedTo, 'inst-b');

  const d = store.detach('inst-a');
  assert.strictEqual(d.ok, true);
  peers = store.listPeers();
  assert.strictEqual(peers.find((p) => p.id === 'inst-a').attachedTo, '');
});

test('attach to offline peer fails', () => {
  const r = store.attach('inst-a', 'ghost');
  assert.strictEqual(r.ok, false);
});

test('deregister purges presence + inbox', () => {
  store.send('inst-a', 'inst-b', 'pending');
  store.deregister('inst-b');
  const peers = store.listPeers();
  assert.ok(!peers.find((p) => p.id === 'inst-b'));
  assert.ok(!fs.existsSync(path.join(TMP, 'peers', 'inst-b.json')));
  assert.ok(!fs.existsSync(path.join(TMP, 'peers', 'inst-b.inbox.jsonl')));
});

test('_isAlive: self pid alive, impossible pid dead', () => {
  assert.strictEqual(store._isAlive(process.pid), true);
  assert.strictEqual(store._isAlive(2147483640), false);
  assert.strictEqual(store._isAlive(0), false);
});

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
});

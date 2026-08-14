'use strict';

const test = require('node:test');
const assert = require('node:assert');

const core = require('../../src/services/meshCore');

test('isEnabled: default-on, falsy-off', () => {
  assert.strictEqual(core.isEnabled({}), true);
  assert.strictEqual(core.isEnabled({ KHY_MESH: 'true' }), true);
  assert.strictEqual(core.isEnabled({ KHY_MESH: 'off' }), false);
  assert.strictEqual(core.isEnabled({ KHY_MESH: '0' }), false);
  assert.strictEqual(core.isEnabled({ KHY_MESH: 'no' }), false);
  assert.strictEqual(core.isEnabled({ KHY_MESH: 'false' }), false);
});

test('isValidId / normalizeId', () => {
  assert.ok(core.isValidId('khy-abc'));
  assert.ok(core.isValidId('session.id_1-2'));
  assert.ok(!core.isValidId('-leading'));
  assert.ok(!core.isValidId('has space'));
  assert.ok(!core.isValidId(''));
  assert.ok(!core.isValidId('a'.repeat(65)));
  assert.strictEqual(core.normalizeId('  ok-id '), 'ok-id');
  assert.strictEqual(core.normalizeId('bad id'), null);
  assert.strictEqual(core.normalizeId(null), null);
});

test('truncateMessage caps at MAX_MESSAGE_CHARS', () => {
  const long = 'x'.repeat(core.MAX_MESSAGE_CHARS + 100);
  const out = core.truncateMessage(long);
  assert.ok(out.length <= core.MAX_MESSAGE_CHARS + 20);
  assert.match(out, /truncated/);
  assert.strictEqual(core.truncateMessage('short'), 'short');
});

test('buildInstanceId: deterministic given parts', () => {
  const a = core.buildInstanceId({ time: 1000, pid: 42, rand: 'ab12' });
  const b = core.buildInstanceId({ time: 1000, pid: 42, rand: 'ab12' });
  assert.strictEqual(a, b);
  assert.ok(core.isValidId(a));
  // honors a valid prefix
  const p = core.buildInstanceId({ time: 1, pid: 2, rand: 'cd', prefix: 'worker' });
  assert.ok(p.startsWith('worker-'));
});

test('buildEnvelope: validates from/to/text', () => {
  const ok = core.buildEnvelope({ from: 'a', to: 'b', text: 'hi', ts: 5 });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.envelope.from, 'a');
  assert.strictEqual(ok.envelope.to, 'b');
  assert.strictEqual(ok.envelope.text, 'hi');
  assert.strictEqual(ok.envelope.type, 'message');

  assert.strictEqual(core.buildEnvelope({ from: 'bad id', to: 'b', text: 'x' }).ok, false);
  assert.strictEqual(core.buildEnvelope({ from: 'a', to: '', text: 'x' }).ok, false);
  assert.strictEqual(core.buildEnvelope({ from: 'a', to: 'b', text: '   ' }).ok, false);
});

test('parseEnvelopeLine: round-trips, rejects junk', () => {
  const built = core.buildEnvelope({ from: 'a', to: 'b', text: 'hello', ts: 9 });
  const line = JSON.stringify(built.envelope);
  const parsed = core.parseEnvelopeLine(line);
  assert.strictEqual(parsed.from, 'a');
  assert.strictEqual(parsed.text, 'hello');
  assert.strictEqual(parsed.ts, 9);
  assert.strictEqual(core.parseEnvelopeLine(''), null);
  assert.strictEqual(core.parseEnvelopeLine('{ not json'), null);
  assert.strictEqual(core.parseEnvelopeLine(JSON.stringify({ from: 'bad id', to: 'b' })), null);
});

test('shapePeers: filters invalid, sorts, marks self, attaches inbox counts', () => {
  const records = [
    { id: 'b-peer', name: 'B', pid: 2, startedAt: '2026-01-02' },
    { id: 'a-peer', name: 'A', pid: 1, startedAt: '2026-01-01' },
    { id: 'bad id', pid: 3, startedAt: '2026-01-03' }, // dropped
    { nope: true }, // dropped
  ];
  const out = core.shapePeers(records, {
    inboxCounts: { 'a-peer': 3 },
    selfId: 'a-peer',
  });
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].id, 'a-peer'); // earliest startedAt first
  assert.strictEqual(out[0].isSelf, true);
  assert.strictEqual(out[0].inbox, 3);
  assert.strictEqual(out[1].id, 'b-peer');
  assert.strictEqual(out[1].isSelf, false);
  assert.strictEqual(out[1].inbox, 0);
});

test('shapePeers: junk -> []', () => {
  assert.deepStrictEqual(core.shapePeers(null), []);
  assert.deepStrictEqual(core.shapePeers('nope'), []);
});

test('buildSendSummary / buildPeersSummary', () => {
  const env = core.buildEnvelope({ from: 'a', to: 'b', text: 'yo', ts: 1 });
  assert.match(core.buildSendSummary(env), /已发送给实例「b」/);
  assert.match(core.buildSendSummary({ ok: false, error: 'boom' }), /boom/);
  assert.match(core.buildPeersSummary([]), /没有/);
  assert.match(core.buildPeersSummary([{ id: 'x' }]), /1 个/);
});

test('determinism: shapePeers stable across calls', () => {
  const recs = [{ id: 'z', pid: 1, startedAt: 's' }, { id: 'a', pid: 2, startedAt: 's' }];
  assert.deepStrictEqual(core.shapePeers(recs), core.shapePeers(recs));
});

// ── peer 会话区分标签(KHY_MESH_PEER_LABELS)──────────────────────────────────

test('peerLabelsEnabled: CANON gating (0/false/off/no → off; disable stays on)', () => {
  assert.strictEqual(core.peerLabelsEnabled({}), true);
  assert.strictEqual(core.peerLabelsEnabled({ KHY_MESH_PEER_LABELS: 'off' }), false);
  assert.strictEqual(core.peerLabelsEnabled({ KHY_MESH_PEER_LABELS: '0' }), false);
  assert.strictEqual(core.peerLabelsEnabled({ KHY_MESH_PEER_LABELS: 'no' }), false);
  assert.strictEqual(core.peerLabelsEnabled({ KHY_MESH_PEER_LABELS: 'false' }), false);
  // EXTENDED 词对 CANON flag 视为「开」
  assert.strictEqual(core.peerLabelsEnabled({ KHY_MESH_PEER_LABELS: 'disable' }), true);
});

test('shapePeers labels ON: same-cwd → #N by startedAt, cross-cwd → plain basename', () => {
  const records = [
    { id: 'sess-aaaa1111', pid: 10, cwd: '/home/k/Khy-OS', startedAt: '2026-01-01T00:00:00Z' },
    { id: 'sess-bbbb2222', pid: 11, cwd: '/home/k/Khy-OS', startedAt: '2026-01-01T00:01:00Z' },
    { id: 'sess-cccc3333', pid: 12, cwd: '/home/k/other-proj', startedAt: '2026-01-01T00:02:00Z' },
  ];
  const out = core.shapePeers(records, { env: {} });
  assert.strictEqual(out[0].label, 'Khy-OS#1');
  assert.strictEqual(out[1].label, 'Khy-OS#2');
  assert.strictEqual(out[2].label, 'other-proj');
  assert.strictEqual(out[0].cwdLabel, 'Khy-OS');
  assert.strictEqual(out[2].cwdLabel, 'other-proj');
  assert.strictEqual(out[0].shortId, 'aaaa1111');
});

test('shapePeers labels ON: explicit name preferred, still disambiguated when shared', () => {
  const single = core.shapePeers([
    { id: 'sess-x', name: 'builder', pid: 1, cwd: '/a/b', startedAt: 's' },
  ], { env: {} });
  assert.strictEqual(single[0].label, 'builder');

  const shared = core.shapePeers([
    { id: 'id-1', name: 'w', pid: 1, cwd: '/a', startedAt: 's1' },
    { id: 'id-2', name: 'w', pid: 2, cwd: '/b', startedAt: 's2' },
  ], { env: {} });
  assert.strictEqual(shared[0].label, 'w#1');
  assert.strictEqual(shared[1].label, 'w#2');
});

test('shapePeers labels ON: Windows cwd basename + empty-cwd falls back to shortId', () => {
  const out = core.shapePeers([
    { id: 'sess-winwin99', pid: 1, cwd: 'C:\\Users\\k\\proj', startedAt: 's1' },
    { id: 'sess-nocwd777', pid: 2, cwd: '', startedAt: 's2' },
  ], { env: {} });
  assert.strictEqual(out[0].label, 'proj');
  assert.strictEqual(out[1].label, 'nocwd777'); // 无名无目录 → shortId
});

test('shapePeers labels OFF (CANON) → byte-revert, no label/cwdLabel/shortId fields', () => {
  const records = [{ id: 'sess-aaaa1111', pid: 10, cwd: '/home/k/Khy-OS', startedAt: 's' }];
  const off = core.shapePeers(records, { env: { KHY_MESH_PEER_LABELS: 'off' } });
  assert.strictEqual('label' in off[0], false);
  assert.strictEqual('cwdLabel' in off[0], false);
  assert.strictEqual('shortId' in off[0], false);
  assert.deepStrictEqual(off[0], {
    id: 'sess-aaaa1111', name: '', pid: 10, cwd: '/home/k/Khy-OS',
    startedAt: 's', attachedTo: '', inbox: 0, isSelf: false,
  });
});

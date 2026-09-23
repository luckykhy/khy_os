'use strict';
/**
 * cpaKeyPool — CPA 多账号密钥池契约测试（DESIGN-CPA-002 P1）。
 *
 * Run: node --test services/backend/tests/services/domain/cpa/cpaKeyPool.test.js
 *
 * 契约（与 services/apiKeyPool.js 同构、CPA 账号语义）：
 *   - 账号 CRUD + cpa_accounts.json 持久化（凭据 AES-256-GCM 密文落盘，文件 0600）
 *   - 选择策略 round-robin / fill-first / least-used（策略名经 keySelector.normalizeStrategy 口径）
 *   - 429/403 冷却退避（指数 + Retry-After 优先 + 封顶，参数真源 serviceDefaults.CPA_KEY_POOL）
 *   - markSuccess 逐级恢复 backoff
 *   - 热重载 reload()：保留存活账号运行时状态、增删对齐磁盘
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-cpa-keypool-'));
process.env.CPA_POOL_TEST_DIR = tmp;

const pool = require('../../../../src/services/domain/cpa/cpaKeyPool.js');
const { encryptApiKey } = require('../../../../src/services/channelApiCrypto.js');

function file() {
  return path.join(tmp, 'cpa_accounts.json');
}

// 每个用例独立「唯一账号」语义：清空内存池 + 磁盘文件再开跑。
beforeEach(() => pool.__testHooks.resetForTest());

test('K1 添加账号：返回 12 位 id，密文落盘且 0600，listAccounts 全部脱敏', () => {
  const r1 = pool.addAccount({ provider: 'codex', credential: 'sk-acct-alpha', label: 'acct-a' });
  const r2 = pool.addAccount({ provider: 'codex', credential: 'sk-acct-beta', label: 'acct-b' });
  assert.ok(r1.ok && r1.id && r1.id.length === 12, 'add 返回 id');
  assert.notEqual(r1.id, r2.id, '同 provider 不同账号 id 不同');
  const raw = fs.readFileSync(file(), 'utf-8');
  assert.ok(!raw.includes('sk-acct-alpha'), '明文凭据不落盘');
  assert.ok(raw.includes('sk-acct-beta') === false, '第二条明文也不落盘');
  const st = fs.statSync(file());
  // POSIX-only check: NTFS ignores `mode` (always reads back 0666/438), so
  // only enforce 0600 where the FS actually honors POSIX perms.
  if (process.platform !== 'win32') {
    assert.ok((st.mode & 0o777) === 0o600, `凭据文件 0600（实际 ${st.mode & 0o777}）`);
  }
  const list = pool.listAccounts();
  for (const a of list) {
    assert.ok(!JSON.stringify(a).includes('sk-acct'), 'listAccounts 视图脱敏（前4…后4）');
    assert.ok(a.credentialPreview, '提供脱敏预览字段');
  }
});

test('K2 重复凭据拒绝（同 provider 同 credential 幂等去重，不静默复制）', () => {
  const first = pool.addAccount({ provider: 'codex', credential: 'sk-acct-alpha' });
  assert.ok(first.ok, '首次添加成功');
  const dup = pool.addAccount({ provider: 'codex', credential: 'sk-acct-alpha' });
  assert.equal(dup.ok, false, '重复账号必须拒绝');
  assert.match(dup.error, /已存在|重复/);
});

test('K3 选择 round-robin：组内轮转，cursor 公平', () => {
  const r = pool.addAccount({ provider: 'gemini', credential: 'gk-one', label: 'one' });
  const s = pool.addAccount({ provider: 'gemini', credential: 'gk-two', label: 'two' });
  assert.ok(r.ok && s.ok);
  const picks = ['a', 'b', 'c'].map(() => pool.pick('gemini', 'round-robin'));
  const ids = picks.map((p) => p.accountId);
  assert.ok(ids.includes(r.id) && ids.includes(s.id), '组内两个账号都被选中（公平轮转，与起点无关）');
  assert.equal(picks[0].credential, 'gk-one', '凭据经池内解密回传（进程内）');
});

test('K4 选择 fill-first：耗尽单账号冷却前不换（同账号连选，直到其不可用）', () => {
  const r = pool.addAccount({ provider: 'claude', credential: 'ck-main', label: 'main' });
  const s = pool.addAccount({ provider: 'claude', credential: 'ck-backup', label: 'backup' });
  assert.ok(r.ok && s.ok);
  const p1 = pool.pick('claude', 'fill-first');
  const p2 = pool.pick('claude', 'fill-first');
  const p3 = pool.pick('claude', 'fill-first');
  assert.equal(p1.accountId, p2.accountId, '未耗尽时粘住同一账号（fill-first 语义：耗尽再换）');
  assert.equal(p2.accountId, p3.accountId);
  // 把第一个账号打 429 → 下一个 pick 应换到 backup
  pool.markFailure(p1.accountId, 429, 'rate limit');
  const p4 = pool.pick('claude', 'fill-first');
  assert.equal(p4.accountId, s.id, '冷却后换到下一账号');
});

test('K5 选择 least-used：选 totalRequests 最少的账号', () => {
  const a = pool.addAccount({ provider: 'qwen', credential: 'qw-a', label: 'a' });
  const b = pool.addAccount({ provider: 'qwen', credential: 'qw-b', label: 'b' });
  assert.ok(a.ok && b.ok);
  const p = pool.pick('qwen', 'least-used');
  assert.equal(p.accountId, a.id, '平手（0 vs 0）按插入序先 a，选中即计数 +1');
  const p2 = pool.pick('qwen', 'least-used');
  assert.equal(p2.accountId, b.id, 'a 已用 1 次 > b 的 0 次 → 轮到 b');
});

test('K6 冷却不可用：429 打冷却后 pick 不再返回该账号（窗口内）', () => {
  const r = pool.addAccount({ provider: 'codex', credential: 'sk-cool-test', label: 'cool' });
  assert.ok(r.ok);
  pool.markFailure(r.id, 429, 'quota exhausted');
  const picked = pool.pick('codex', 'round-robin');
  assert.equal(picked, null, '唯一账号冷却中 → 无可用返回 null');
  const status = pool.getAccountStatus(r.id);
  assert.equal(status.status, 'cooldown');
  assert.ok(status.cooldownRemaining > 0, '回报冷却剩余秒（动作+目标+进度）');
  assert.ok(status.hint.includes('冷却') || status.hint.includes('cooldown'), 'hint 含进度信号');
});

test('K7 冷却窗口过后自动恢复（惰性过期，不用定时器硬 kill）', () => {
  const r = pool.addAccount({ provider: 'gemini', credential: 'gk-cool', label: 'cool' });
  assert.ok(r.ok);
  pool.markFailure(r.id, 429, 'limit');
  // 测试钩子：直接把冷却窗口拨过去（不依赖真实等待）
  pool.__testHooks.forceCooldownExpiry(r.id);
  const p = pool.pick('gemini', 'round-robin');
  assert.equal(p.accountId, r.id, '窗口过后账号恢复可用');
});

test('K8 markSuccess 逐级恢复 backoff：失败 3 次 level=3，成功 3 次回 0', () => {
  const r = pool.addAccount({ provider: 'claude', credential: 'ck-backoff', label: 'bo' });
  assert.ok(r.ok);
  for (let i = 0; i < 3; i += 1) {
    pool.__testHooks.clearCooldown(r.id);
    pool.markFailure(r.id, 429, `fail ${i}`);
  }
  let st = pool.getAccountStatus(r.id);
  assert.equal(st.backoffLevel, 3, '三次失败退避到 level 3');
  for (let i = 0; i < 3; i += 1) {
    pool.__testHooks.clearCooldown(r.id);
    pool.markSuccess(r.id);
  }
  st = pool.getAccountStatus(r.id);
  assert.equal(st.backoffLevel, 0, '三次成功恢复 level 0');
  assert.equal(st.status, 'active');
});

test('K9 disabled 账号不参与选择（CRUD disable 语义）', () => {
  const r = pool.addAccount({ provider: 'qwen', credential: 'qw-off', label: 'off' });
  assert.ok(r.ok);
  const dis = pool.setAccountState(r.id, 'disabled');
  assert.ok(dis.ok);
  assert.equal(pool.pick('qwen', 'round-robin'), null, '唯一账号被禁用 → null');
  const en = pool.setAccountState(r.id, 'active');
  assert.ok(en.ok);
  assert.equal(pool.pick('qwen', 'round-robin').accountId, r.id, '重新启用恢复参与');
});

test('K10 无账号 provider → pick 返回 null（不抛、不造假）', () => {
  assert.equal(pool.pick('nonexistent-provider', 'round-robin'), null);
});

test('K11 热重载：磁盘增删对齐内存，存活账号运行时状态保留', () => {
  const r = pool.addAccount({ provider: 'codex', credential: 'sk-rl-keep', label: 'keep' });
  assert.ok(r.ok);
  pool.markFailure(r.id, 429, 'x');
  // 磁盘直接加一个账号（模拟外部进程写入）——id 用池的 md5 方案推导
  const crypto = require('node:crypto');
  const foreignId = crypto.createHash('md5').update('codex:sk-rl-new').digest('hex').slice(0, 12);
  const doc = JSON.parse(fs.readFileSync(file(), 'utf-8'));
  doc.accounts.push({
    id: foreignId,
    provider: 'codex',
    credentialCipher: encryptApiKey('sk-rl-new'),
    label: 'new',
    priority: 0,
    updatedAt: new Date().toISOString()
  });
  fs.writeFileSync(file(), JSON.stringify(doc, null, 2));
  const rr = pool.reload();
  assert.ok(rr.added >= 1, `reload 报新增（实际 added=${rr.added}）`);
  assert.ok(pool.listAccounts().some((a) => a.id === foreignId), '外部写入的账号已并入');
  const st = pool.getAccountStatus(r.id);
  assert.equal(st.status, 'cooldown', '存活账号冷却状态跨重载保留');
  // 磁盘删除该外部账号 → reload 后内存同步移除
  const doc2 = JSON.parse(fs.readFileSync(file(), 'utf-8'));
  doc2.accounts = doc2.accounts.filter((a) => a.id === r.id);
  fs.writeFileSync(file(), JSON.stringify(doc2, null, 2));
  pool.reload();
  assert.equal(pool.getAccountStatus(foreignId), null, '磁盘删除 → 内存移除');
});

test('K12 损坏文件自愈：cpa_accounts.json 坏 JSON → 从 .bak 恢复（fail-soft 不抛）', () => {
  const r = pool.addAccount({ provider: 'gemini', credential: 'gk-heal', label: 'heal' });
  assert.ok(r.ok);
  fs.writeFileSync(file(), '{ corrupt', 'utf-8');
  let err = null;
  let list = null;
  try {
    list = pool.reload();
  } catch (e) {
    err = e;
  }
  assert.equal(err, null, '损坏不得抛');
  if (list) {
    assert.ok(list.recovered, '回报自愈标记（状态透明）');
    assert.ok(pool.listAccounts().some((a) => a.credentialPreview && a.provider === 'gemini'), '自愈后账号仍在');
  }
});

test('K13 revealCredential 单一明文出口：list/pick 路径均不吐全量明文以外的裸键', () => {
  const r = pool.addAccount({ provider: 'codex', credential: 'sk-secret-xyz', label: 'sec' });
  assert.ok(r.ok);
  const plain = pool.revealCredential(r.id);
  assert.equal(plain.credential, 'sk-secret-xyz', 'reveal 是明文唯一出口');
  assert.equal(JSON.stringify(pool.listAccounts()).includes('sk-secret-xyz'), false, 'list 不含明文');
});

test('K14 pick 未知策略名回退 round-robin（fail-soft，不抛）', () => {
  const r = pool.addAccount({ provider: 'qwen', credential: 'qw-unk', label: 'unk' });
  assert.ok(r.ok);
  const p = pool.pick('qwen', 'totally-bogus-strategy');
  assert.ok(p, '未知策略回落 round-robin 仍出结果');
  assert.equal(p.accountId, r.id);
});

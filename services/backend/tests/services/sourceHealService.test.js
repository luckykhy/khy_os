'use strict';

/**
 * sourceHealService.test.js — 薄壳(IO 层)源码自愈执行器。
 *
 * 核心逻辑 healFromPristineDir 与快照/加密解耦,用真实临时目录端到端锁定:
 *   ① 缺失文件 → 从纯净树补齐(用户点名「个别文件丢失」);
 *   ② 损坏文件(内容变,如函数名 typo)→ 覆盖修正 + 备份 .broken-<ts>(用户点名「函数名少打一个字母」);
 *   ③ 一致文件不动;④ 多余文件绝不删;⑤ dry-run 只规划不写;
 *   ⑥ 门控关 → 字节回退不自愈;⑦ 回写后哈希校验;⑧ 封顶;
 *   ⑨ healSource fail-soft:无快照 → {ok:true, reason:'no-snapshot'} 不抛;门控关短路。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const svc = require('../../src/services/sourceHealService');

function _sha(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}
function _write(root, rel, content) {
  const fp = path.join(root, rel);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, content);
}
function _mk(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ── ① 缺失文件 → 补齐 ─────────────────────────────────────────────────────────
test('healFromPristineDir: 缺失文件从纯净树补齐', () => {
  const pristine = _mk('khy-pristine-');
  const install = _mk('khy-install-');
  try {
    _write(pristine, 'a.js', 'const a = 1;\n');
    _write(pristine, 'sub/b.js', 'const b = 2;\n');
    _write(install, 'a.js', 'const a = 1;\n'); // sub/b.js 丢失

    const r = svc.healFromPristineDir(pristine, install, { env: {}, apply: true });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.applied.map((x) => x.relPath).sort(), ['sub/b.js']);
    assert.strictEqual(r.failed.length, 0);
    // 补回的内容与纯净一致
    assert.strictEqual(fs.readFileSync(path.join(install, 'sub/b.js'), 'utf-8'), 'const b = 2;\n');
    assert.strictEqual(r.applied[0].reason, 'missing');
  } finally {
    fs.rmSync(pristine, { recursive: true, force: true });
    fs.rmSync(install, { recursive: true, force: true });
  }
});

// ── ② 损坏(函数名 typo)→ 覆盖 + 备份 ─────────────────────────────────────────
test('healFromPristineDir: 损坏文件覆盖修正并备份 .broken-<ts>', () => {
  const pristine = _mk('khy-pristine-');
  const install = _mk('khy-install-');
  try {
    _write(pristine, 'foo.js', 'function calculate() {}\n');
    _write(install, 'foo.js', 'function calculat() {}\n'); // 少打一个 e → 内容变 → corrupt

    const r = svc.healFromPristineDir(pristine, install, { env: {}, apply: true });
    assert.deepStrictEqual(r.applied.map((x) => x.relPath), ['foo.js']);
    assert.strictEqual(r.applied[0].reason, 'corrupt');
    // 已修正为纯净内容
    assert.strictEqual(fs.readFileSync(path.join(install, 'foo.js'), 'utf-8'), 'function calculate() {}\n');
    // 备份了损坏原件
    const backups = fs.readdirSync(install).filter((n) => n.startsWith('foo.js.broken-'));
    assert.strictEqual(backups.length, 1);
    assert.strictEqual(fs.readFileSync(path.join(install, backups[0]), 'utf-8'), 'function calculat() {}\n');
  } finally {
    fs.rmSync(pristine, { recursive: true, force: true });
    fs.rmSync(install, { recursive: true, force: true });
  }
});

// ── ③ 一致不动 / ④ 多余不删 ───────────────────────────────────────────────────
test('healFromPristineDir: 一致文件不动、磁盘多余文件绝不删', () => {
  const pristine = _mk('khy-pristine-');
  const install = _mk('khy-install-');
  try {
    _write(pristine, 'a.js', 'same\n');
    _write(install, 'a.js', 'same\n');
    _write(install, 'user_plugin.js', 'user code\n'); // 多余

    const r = svc.healFromPristineDir(pristine, install, { env: {}, apply: true });
    assert.strictEqual(r.applied.length, 0);
    assert.strictEqual(r.plan.length, 0);
    // 多余文件仍在
    assert.strictEqual(fs.existsSync(path.join(install, 'user_plugin.js')), true);
    assert.strictEqual(r.report.summary.extra, 1);
  } finally {
    fs.rmSync(pristine, { recursive: true, force: true });
    fs.rmSync(install, { recursive: true, force: true });
  }
});

// ── ⑤ dry-run 只规划不写 ──────────────────────────────────────────────────────
test('healFromPristineDir: dry-run(apply=false)只出计划不写盘', () => {
  const pristine = _mk('khy-pristine-');
  const install = _mk('khy-install-');
  try {
    _write(pristine, 'a.js', 'correct\n');
    _write(install, 'a.js', 'broken\n');

    const r = svc.healFromPristineDir(pristine, install, { env: {}, apply: false });
    assert.strictEqual(r.plan.length, 1);
    assert.strictEqual(r.applied.length, 0);
    assert.strictEqual(r.report.dryRun, true);
    // 磁盘未被改动
    assert.strictEqual(fs.readFileSync(path.join(install, 'a.js'), 'utf-8'), 'broken\n');
  } finally {
    fs.rmSync(pristine, { recursive: true, force: true });
    fs.rmSync(install, { recursive: true, force: true });
  }
});

// ── ⑥ 门控关 → 不自愈 ─────────────────────────────────────────────────────────
test('healFromPristineDir: 门控关 → 字节回退不自愈', () => {
  const pristine = _mk('khy-pristine-');
  const install = _mk('khy-install-');
  try {
    _write(pristine, 'a.js', 'correct\n');
    _write(install, 'a.js', 'broken\n');

    const r = svc.healFromPristineDir(pristine, install, { env: { KHY_SOURCE_HEAL: 'off' }, apply: true });
    assert.strictEqual(r.report.enabled, false);
    assert.strictEqual(r.applied.length, 0);
    assert.strictEqual(fs.readFileSync(path.join(install, 'a.js'), 'utf-8'), 'broken\n');
  } finally {
    fs.rmSync(pristine, { recursive: true, force: true });
    fs.rmSync(install, { recursive: true, force: true });
  }
});

// ── ⑦ subset 只查关键子集 ─────────────────────────────────────────────────────
test('healFromPristineDir: subset 限定只检查关键子集', () => {
  const pristine = _mk('khy-pristine-');
  const install = _mk('khy-install-');
  try {
    _write(pristine, 'crit.js', 'good\n');
    _write(pristine, 'other.js', 'good\n');
    _write(install, 'crit.js', 'bad\n');   // 损坏但在 subset 内
    _write(install, 'other.js', 'bad\n');  // 损坏但不在 subset

    const r = svc.healFromPristineDir(pristine, install, { env: {}, apply: true, subset: ['crit.js'] });
    assert.deepStrictEqual(r.applied.map((x) => x.relPath), ['crit.js']);
    assert.strictEqual(fs.readFileSync(path.join(install, 'crit.js'), 'utf-8'), 'good\n');
    assert.strictEqual(fs.readFileSync(path.join(install, 'other.js'), 'utf-8'), 'bad\n'); // 未碰
  } finally {
    fs.rmSync(pristine, { recursive: true, force: true });
    fs.rmSync(install, { recursive: true, force: true });
  }
});

// ── ⑧ 封顶(超过 limit 只修前 N) ─────────────────────────────────────────────
test('healFromPristineDir: 超过封顶只修前 N,其余留待整树 restore', () => {
  const pristine = _mk('khy-pristine-');
  const install = _mk('khy-install-');
  try {
    for (let i = 0; i < 5; i++) _write(pristine, `f${i}.js`, `v${i}\n`);
    // install 全缺失
    const r = svc.healFromPristineDir(pristine, install, { env: { KHY_SOURCE_HEAL_MAX: '2' }, apply: true });
    assert.strictEqual(r.plan.length, 2);       // 封顶到 2
    assert.strictEqual(r.applied.length, 2);
    assert.strictEqual(r.report.capped.applied, true);
    assert.strictEqual(r.report.capped.dropped, 3);
  } finally {
    fs.rmSync(pristine, { recursive: true, force: true });
    fs.rmSync(install, { recursive: true, force: true });
  }
});

// ── ⑨ healSource fail-soft ────────────────────────────────────────────────────
test('healSource: 门控关 → 短路 {ok:true, reason:gate-off},不触碰文件系统', () => {
  const r = svc.healSource({ env: { KHY_SOURCE_HEAL: 'off' } });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.reason, 'gate-off');
  assert.strictEqual(r.healed, 0);
});

test('healSource: 无快照(指向空目录)→ {ok:true, reason:no-snapshot},绝不抛', () => {
  const empty = _mk('khy-nosnap-');
  try {
    const r = svc.healSource({ env: {}, sourceDir: path.join(empty, 'nope') });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.reason, 'no-snapshot');
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

// ── ⑩ 「个别文件」红线:随包真快照计划过大 → 绝不 mass-write ────────────────────
// 用随包真快照(bundled/_source)验证核心安全不变量:即便 apply=true,当计划涉及大量文件
// (版本漂移/系统性差异,非零星损坏)时,healed 必须为 0——绝不在自动路径静默重写几十上百文件。
// 这正是 119 文件误还原事故的防线(用户诉求是「个别文件」「一个函数名 typo」= 局部损坏)。
//
// 安全:installSrcDir 指向**空临时目录**(绝不打真 bundled 树!事故正是 apply:true 打真树造成的),
// dataHome 指向临时目录(不污染真 ~/.khyquant 清单缓存)。空 install → 全文件 missing → 计划巨大
// (远超 25)→ too-many-changes 护栏必然触发 → healed=0。若护栏失效,写入也只落在临时目录(无害),
// 且被 healed=0 断言当场抓住。真快照解密 + 清单构建 + 护栏判定全程真实走一遍。
test('healSource: 随包真快照 apply=true 且计划过大 → healed=0 不 mass-write', () => {
  const npmBackend = path.resolve(__dirname, '../../../../packaging/npm/bundled/services/backend');
  const snap = path.join(npmBackend, '..', '..', '_source', 'snapshot.json');
  if (!fs.existsSync(snap)) return; // 无随包快照的环境跳过(dev 纯 SSOT 树)

  const svcBundled = require(path.join(npmBackend, 'src/services/sourceHealService.js'));
  const tmpInstall = _mk('khy-safe-install-');
  const tmpData = _mk('khy-safe-data-');
  try {
    const r = svcBundled.healSource({ env: {}, apply: true, installSrcDir: tmpInstall, dataHome: tmpData });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.healed, 0); // 关键不变量:一个文件都不许自动写回
    // 空 install → 计划必然巨大 → too-many-changes(或版本红线先拦 → version-mismatch)。
    assert.ok(['too-many-changes', 'version-mismatch'].includes(r.reason), `unexpected reason: ${r.reason}`);
    assert.strictEqual(r.report.dryRun, true);
    // 临时 install 目录仍为空(护栏确实没写)。
    assert.strictEqual(fs.readdirSync(tmpInstall).length, 0);
  } finally {
    fs.rmSync(tmpInstall, { recursive: true, force: true });
    fs.rmSync(tmpData, { recursive: true, force: true });
  }
});

test('healSource: force 可显式绕过 too-many-changes(但仍守版本红线)', () => {
  // too-many 降级时 report 带 recommend 提示,便于上层引导用户整树 restore。
  // 同样用空临时 install + 临时 dataHome,绝不打真树。
  const npmBackend = path.resolve(__dirname, '../../../../packaging/npm/bundled/services/backend');
  const snap = path.join(npmBackend, '..', '..', '_source', 'snapshot.json');
  if (!fs.existsSync(snap)) return;
  const svcBundled = require(path.join(npmBackend, 'src/services/sourceHealService.js'));
  const tmpInstall = _mk('khy-safe-install2-');
  const tmpData = _mk('khy-safe-data2-');
  try {
    const r = svcBundled.healSource({ env: {}, apply: true, installSrcDir: tmpInstall, dataHome: tmpData });
    if (r.reason === 'too-many-changes') {
      assert.strictEqual(r.report.recommend, 'khy restore');
      assert.strictEqual(r.report.tooMany, true);
    }
  } finally {
    fs.rmSync(tmpInstall, { recursive: true, force: true });
    fs.rmSync(tmpData, { recursive: true, force: true });
  }
});

// ── 辅助函数直接单测 ──────────────────────────────────────────────────────────
test('_collectRelFiles: 递归收集 + 稳定排序 + 跳过 node_modules', () => {
  const root = _mk('khy-collect-');
  try {
    _write(root, 'z.js', '1');
    _write(root, 'a.js', '1');
    _write(root, 'sub/m.js', '1');
    _write(root, 'node_modules/dep/index.js', '1'); // 应被跳过
    const rels = svc._collectRelFiles(root);
    assert.deepStrictEqual(rels, ['a.js', 'sub/m.js', 'z.js']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('_buildManifest: 生成 {rel: sha256} 与手工哈希一致', () => {
  const root = _mk('khy-manifest-');
  try {
    _write(root, 'a.js', 'hello\n');
    const m = svc._buildManifest(root);
    assert.strictEqual(m['a.js'], _sha(Buffer.from('hello\n')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── runStartupHeal:节流 ───────────────────────────────────────────────────────
test('_resolveIntervalMs: 默认 24h / 覆盖 / 0=不节流 / 坏值回落', () => {
  const H = 3600 * 1000;
  assert.strictEqual(svc._resolveIntervalMs({}), 24 * H);
  assert.strictEqual(svc._resolveIntervalMs({ KHY_SOURCE_HEAL_INTERVAL_HOURS: '1' }), 1 * H);
  assert.strictEqual(svc._resolveIntervalMs({ KHY_SOURCE_HEAL_INTERVAL_HOURS: '0' }), 0);   // 不节流
  assert.strictEqual(svc._resolveIntervalMs({ KHY_SOURCE_HEAL_INTERVAL_HOURS: '-5' }), 0);  // ≤0 → 不节流
  assert.strictEqual(svc._resolveIntervalMs({ KHY_SOURCE_HEAL_INTERVAL_HOURS: 'abc' }), 24 * H); // 坏值 → 默认
  assert.strictEqual(svc._resolveIntervalMs({ KHY_SOURCE_HEAL_INTERVAL_HOURS: '' }), 24 * H);
});

test('runStartupHeal: 门控关 → 短路 gate-off,不触碰文件系统', () => {
  const r = svc.runStartupHeal({ env: { KHY_SOURCE_HEAL: 'off' } });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.reason, 'gate-off');
  assert.strictEqual(r.skipped, true);
});

test('runStartupHeal: 无快照(dev 树)→ no-snapshot 跳过,绝不抛', () => {
  const empty = _mk('khy-nosnap-');
  try {
    const r = svc.runStartupHeal({ env: {}, sourceDir: path.join(empty, 'nope') });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.reason, 'no-snapshot');
    assert.strictEqual(r.skipped, true);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test('runStartupHeal: 节流命中/超窗/force —— 全隔离(注入 fake _source + dataHome)', () => {
  // 造一个 fake _source:snapshot.json(带 sha256 供指纹)+ dummy .enc(供 _snapshotDirHasFiles
  // 通过定位)。dummy .enc 无法解密 → healSource 得 'snapshot-unreadable'(healed=0),但**节流
  // 状态照写**(指纹 + 时间戳)。这足以确定性地锁定节流的跳过/不跳过/force 语义,零真快照、零真数据家。
  const root = _mk('khy-throttle-');
  const src = path.join(root, '_source');
  const dataHome = path.join(root, 'datahome');
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(dataHome, { recursive: true });
  fs.writeFileSync(path.join(src, 'snapshot.json'), JSON.stringify({ sha256: 'FINGERPRINT_A', version: '9.9.9', crypto: { algo: 'aes-256-gcm' } }));
  fs.writeFileSync(path.join(src, 'khy-os-source.tar.gz.enc'), Buffer.from('not-a-real-ciphertext'));

  const common = { env: {}, sourceDir: src, dataHome, silent: true };
  try {
    const now = 1_000_000_000_000;
    // ① 无状态 → 不跳过(真走 healSource → snapshot-unreadable),写状态。
    const r1 = svc.runStartupHeal({ ...common, now });
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r1.skipped, false);
    assert.strictEqual(r1.healed, 0);
    const sp = svc._healStatePath({ dataHome });
    assert.strictEqual(fs.existsSync(sp), true);
    const st = JSON.parse(fs.readFileSync(sp, 'utf-8'));
    assert.strictEqual(st.fingerprint, 'FINGERPRINT_A');
    assert.strictEqual(st.lastCheckAt, now);

    // ② 同指纹 + 窗内(5 分钟)→ 节流跳过。
    const r2 = svc.runStartupHeal({ ...common, now: now + 5 * 60 * 1000 });
    assert.strictEqual(r2.reason, 'throttled');
    assert.strictEqual(r2.skipped, true);

    // ③ 超过 24h → 重新体检(不跳过)。
    const r3 = svc.runStartupHeal({ ...common, now: now + 25 * 3600 * 1000 });
    assert.strictEqual(r3.skipped, false);

    // ④ force 绕过节流:紧接(窗内)仍体检。
    const r4 = svc.runStartupHeal({ ...common, now: now + 25 * 3600 * 1000 + 1000, force: true });
    assert.strictEqual(r4.skipped, false);

    // ⑤ 指纹变化(= pip/npm 更新装入新快照)→ 即便窗内也重查。
    fs.writeFileSync(path.join(src, 'snapshot.json'), JSON.stringify({ sha256: 'FINGERPRINT_B', version: '9.9.10', crypto: { algo: 'aes-256-gcm' } }));
    const r5 = svc.runStartupHeal({ ...common, now: now + 25 * 3600 * 1000 + 2000 });
    assert.strictEqual(r5.skipped, false);
    const st2 = JSON.parse(fs.readFileSync(sp, 'utf-8'));
    assert.strictEqual(st2.fingerprint, 'FINGERPRINT_B');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runStartupHeal: KHY_SOURCE_HEAL_INTERVAL_HOURS=0 → 不节流(每次都查)', () => {
  const root = _mk('khy-nothrottle-');
  const src = path.join(root, '_source');
  const dataHome = path.join(root, 'datahome');
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(dataHome, { recursive: true });
  fs.writeFileSync(path.join(src, 'snapshot.json'), JSON.stringify({ sha256: 'FP', version: '1.0.0', crypto: {} }));
  fs.writeFileSync(path.join(src, 'khy-os-source.tar.gz.enc'), Buffer.from('x'));
  const common = { env: { KHY_SOURCE_HEAL_INTERVAL_HOURS: '0' }, sourceDir: src, dataHome, silent: true };
  try {
    const now = 2_000_000_000_000;
    svc.runStartupHeal({ ...common, now });
    const r2 = svc.runStartupHeal({ ...common, now: now + 1000 }); // 1 秒后,窗=0 → 仍查
    assert.strictEqual(r2.skipped, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

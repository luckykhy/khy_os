'use strict';

/**
 * healEscalationService.test.js — 自愈失败的三级升级链(L1 → L2 → L3)。
 *
 * 锁定的行为(对应任务「自愈失败后有明确的下一步,而非静默失败」):
 *   ① 门控 KHY_HEAL_ESCALATION=0 → 字节回退:不写盘、不审计、不告警;
 *   ② 升级表是单一真源:各组件的 L2 手段/建议命令/严重级只在表里定义;
 *   ③ classifySourceHealFailure 只把**真故障**判成失败(护栏拒写、开发树无快照不升级);
 *   ④ 验收①:sourceHeal 快照被删 → 升级到 L2(restore),审计含「L1 失败，升级到 L2(restore)」;
 *   ⑤ 验收②:L2 也失败 → .khy/heal_escalation.json 生成(含契约五字段)+ 终端告警含具体故障与建议;
 *   ⑥ 无 L2 手段的组件(selfRepairTransaction)直接交人;skipL2 / L2 门控关同样落 L3;
 *   ⑦ 冷却窗:同组件 24h 内不重复跑重手段,--force 可绕过;
 *   ⑧ fail-soft:垃圾输入 / 审计与告警失败都不抛回自愈调用方。
 *
 * 全部用注入(deps.audit / deps.log / deps.runRestore …)+ 临时 khyDir,零真实 restore/doctor。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const svc = require('../../src/services/healEscalationService');
const healSvc = require('../../src/services/sourceHealService');

function _mk(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 采集器:审计条目 + 终端告警文本。 */
function _spies() {
  const audits = [];
  const logs = [];
  return {
    audits,
    logs,
    deps: {
      audit: (e) => {
        audits.push(e);
        return true;
      },
      log: (t) => logs.push(t),
    },
    find: (action) => audits.find((a) => a && a.action === action) || null,
  };
}

// ── ① 门控关 = 字节回退 ──────────────────────────────────────────────────────
test('门控 KHY_HEAL_ESCALATION=0 → 不升级、不写盘、不审计', async () => {
  const khyDir = _mk('khy-esc-gate-');
  const s = _spies();
  const out = await svc.escalate({
    component: 'sourceHealService',
    failedAttempts: [{ step: 'snapshot_read', error: 'decrypt_fail' }],
    env: { KHY_HEAL_ESCALATION: '0' },
    khyDir,
    deps: s.deps,
  });
  assert.strictEqual(out.reason, 'gate-off');
  assert.strictEqual(out.escalated, false);
  assert.strictEqual(out.level, 'none');
  assert.strictEqual(s.audits.length, 0);
  assert.strictEqual(s.logs.length, 0);
  assert.strictEqual(fs.existsSync(path.join(khyDir, 'heal_escalation.json')), false);
});

test('isEnabled/isL2Enabled: 默认开,仅 0/false/off/no 关', () => {
  assert.strictEqual(svc.isEnabled({}), true);
  assert.strictEqual(svc.isEnabled({ KHY_HEAL_ESCALATION: '' }), true);
  assert.strictEqual(svc.isEnabled({ KHY_HEAL_ESCALATION: '1' }), true);
  for (const v of ['0', 'false', 'OFF', 'no']) {
    assert.strictEqual(svc.isEnabled({ KHY_HEAL_ESCALATION: v }), false, v);
  }
  assert.strictEqual(svc.isL2Enabled({}), true);
  assert.strictEqual(svc.isL2Enabled({ KHY_HEAL_ESCALATION_L2: 'off' }), false);
});

// ── ② 升级表(单一真源) ───────────────────────────────────────────────────────
test('planEscalation: 各组件的 L2 手段与建议来自升级表', () => {
  const src = svc.planEscalation('sourceHealService');
  assert.strictEqual(src.known, true);
  assert.strictEqual(src.l2Action, 'restore');
  assert.strictEqual(src.l2Label, 'restore');
  assert.match(src.suggestedAction, /khy restore/);
  assert.strictEqual(src.severity, 'high');

  assert.strictEqual(svc.planEscalation('configGuard').l2Action, 'freshInstallDoctor');
  assert.strictEqual(svc.planEscalation('dbHealth').l2Action, 'rebuildEmptyDb');
  assert.strictEqual(svc.planEscalation('dbHealth').severity, 'critical');

  // 工作树状态须人工确认 → 没有更重的自动手段。
  const selfRepair = svc.planEscalation('selfRepairTransaction');
  assert.strictEqual(selfRepair.known, true);
  assert.strictEqual(selfRepair.l2Action, null);

  // 未登记组件 → 无 L2,直接交人。
  const unknown = svc.planEscalation('somethingElse');
  assert.strictEqual(unknown.known, false);
  assert.strictEqual(unknown.l2Action, null);
});

test('normalizeComponent: 各调用方历史叫法归一到规范名', () => {
  assert.strictEqual(svc.normalizeComponent('sourceHeal'), 'sourceHealService');
  assert.strictEqual(svc.normalizeComponent('dbHealthService'), 'dbHealth');
  assert.strictEqual(svc.normalizeComponent('CONFIGGUARD'), 'configGuard');
  assert.strictEqual(svc.normalizeComponent('selfRepair'), 'selfRepairTransaction');
  assert.strictEqual(svc.normalizeComponent(''), '');
  assert.strictEqual(svc.normalizeComponent(null), '');
});

test('formatUpgradeMessage: 审计与终端共用同一句升级语', () => {
  assert.strictEqual(svc.formatUpgradeMessage('L1', 'L2', 'restore'), 'L1 失败，升级到 L2(restore)');
  assert.strictEqual(svc.formatUpgradeMessage('L2', 'L3', null), 'L2 失败，升级到 L3(交人)');
});

// ── ③ 失败判据:护栏拒写 ≠ 故障 ─────────────────────────────────────────────
test('classifySourceHealFailure: 只有真故障才升级', () => {
  // 开发树本来就没快照 → 日常正常路径,绝不升级。
  assert.strictEqual(
    svc.classifySourceHealFailure({ ok: true, reason: 'no-snapshot' }, {}).failed,
    false
  );
  // 曾经有过却不见了 → 参照被删,属故障。
  const gone = svc.classifySourceHealFailure(
    { ok: true, reason: 'no-snapshot' },
    { hadSnapshotBefore: true }
  );
  assert.strictEqual(gone.failed, true);
  assert.deepStrictEqual(gone.attempts, [{ step: 'snapshot_locate', error: 'snapshot_missing' }]);

  // 快照解不开。
  const unreadable = svc.classifySourceHealFailure({ ok: true, reason: 'snapshot-unreadable' }, {});
  assert.strictEqual(unreadable.failed, true);
  assert.deepStrictEqual(unreadable.attempts, [{ step: 'snapshot_read', error: 'decrypt_fail' }]);

  // 护栏主动拒写(已给人工建议)→ 不是故障,自动升级会把护栏挡住的重活偷偷做掉。
  assert.strictEqual(
    svc.classifySourceHealFailure({ ok: true, reason: 'version-mismatch' }, {}).failed,
    false
  );
  assert.strictEqual(
    svc.classifySourceHealFailure({ ok: true, reason: 'too-many-changes' }, {}).failed,
    false
  );
  // 健康 / dry-run 不算失败。
  assert.strictEqual(svc.classifySourceHealFailure({ ok: true, reason: 'healthy' }, {}).failed, false);

  // 跑挂了。
  const errored = svc.classifySourceHealFailure(
    { ok: false, reason: 'error', report: { error: 'boom' } },
    {}
  );
  assert.strictEqual(errored.failed, true);
  assert.strictEqual(errored.attempts[0].error, 'boom');

  // 修了一部分但有文件失败 → 局部失败也算 L1 未竟。
  const partial = svc.classifySourceHealFailure(
    { ok: true, reason: 'healed', healed: 2, failed: [{ relPath: 'a.js', error: 'EACCES' }] },
    {}
  );
  assert.strictEqual(partial.failed, true);
  assert.strictEqual(partial.reason, 'partial-failure');
  assert.strictEqual(partial.attempts[0].error, 'EACCES');

  // 垃圾输入不抛。
  assert.strictEqual(svc.classifySourceHealFailure(null, {}).failed, false);
  assert.strictEqual(svc.classifySourceHealFailure(undefined).failed, false);
});

// ── ④ 验收①:快照被删 → 自动升级到 L2(restore) + 审计留痕 ────────────────────
test('验收①: sourceHeal 快照被删 → 升级到 L2(restore),审计含「L1 失败，升级到 L2(restore)」', async () => {
  const khyDir = _mk('khy-esc-l2ok-');
  const s = _spies();
  let restoreCtx = null;

  // 现场重演:删掉随包快照后 healSource 返回 no-snapshot,而本机曾记录过指纹。
  const verdict = svc.classifySourceHealFailure(
    { ok: true, reason: 'no-snapshot', skipped: true, healed: 0 },
    { hadSnapshotBefore: true }
  );
  assert.strictEqual(verdict.failed, true);

  const out = await svc.escalate({
    component: 'sourceHealService',
    trigger: 'cli-heal',
    failedAttempts: verdict.attempts,
    env: {},
    khyDir,
    now: 1_700_000_000_000,
    deps: {
      ...s.deps,
      runRestore: (ctx) => {
        restoreCtx = ctx;
        return { ok: true, detail: 'khy restore' };
      },
    },
  });

  assert.strictEqual(out.escalated, true);
  assert.strictEqual(out.level, 'L2');
  assert.strictEqual(out.reason, 'l2-ok');
  assert.strictEqual(out.action, 'restore');
  assert.ok(restoreCtx, 'L2 执行器应被调用');

  const up = s.find('escalate_l1_to_l2');
  assert.ok(up, '应写入升级审计');
  assert.strictEqual(up.component, 'sourceHealService');
  assert.strictEqual(up.details.message, 'L1 失败，升级到 L2(restore)');
  assert.strictEqual(up.details.from, 'L1');
  assert.strictEqual(up.details.to, 'L2');
  assert.deepStrictEqual(up.details.failedAttempts, [
    { step: 'snapshot_locate', error: 'snapshot_missing' },
  ]);
  assert.strictEqual(up.details.trigger, 'cli-heal');

  const res = s.find('escalate_l2_result');
  assert.strictEqual(res.result, 'success');

  // L2 成功 → 不交人:既不写记录文件,也不刷终端告警。
  assert.strictEqual(fs.existsSync(path.join(khyDir, 'heal_escalation.json')), false);
  assert.strictEqual(s.logs.length, 0);
  assert.strictEqual(s.find('escalate_to_l3'), null);
});

// ── ⑤ 验收②:L2 也失败 → 落盘 + 终端告警 ──────────────────────────────────────
test('验收②: L2 也失败 → .khy/heal_escalation.json 生成 + 终端告警含具体故障与建议', async () => {
  const khyDir = _mk('khy-esc-l3-');
  const s = _spies();

  const out = await svc.escalate({
    component: 'sourceHealService',
    trigger: 'cli-heal',
    failedAttempts: [{ step: 'snapshot_read', error: 'decrypt_fail' }],
    context: { healReason: 'snapshot-unreadable' },
    env: {},
    khyDir,
    now: Date.parse('2026-08-16T17:13:26.000Z'),
    deps: {
      ...s.deps,
      runRestore: () => ({ ok: false, error: 'restore_download_failed' }),
    },
  });

  assert.strictEqual(out.level, 'L3');
  assert.strictEqual(out.reason, 'l3-handoff');
  assert.strictEqual(out.ok, false);

  // 记录文件落盘,且契约五字段齐备。
  const fp = path.join(khyDir, 'heal_escalation.json');
  assert.strictEqual(out.file, fp);
  assert.strictEqual(fs.existsSync(fp), true);
  const rec = JSON.parse(fs.readFileSync(fp, 'utf-8'));
  assert.strictEqual(rec.timestamp, '2026-08-16T17:13:26.000Z');
  assert.strictEqual(rec.component, 'sourceHealService');
  assert.strictEqual(rec.severity, 'high');
  assert.match(rec.suggestedAction, /khy restore/);
  assert.deepStrictEqual(rec.failedAttempts[0], { step: 'snapshot_read', error: 'decrypt_fail' });
  // L2 的失败本身也进故障清单(否则人看不出重手段试过没有)。
  assert.deepStrictEqual(rec.failedAttempts[1], {
    step: 'l2:restore',
    error: 'restore_download_failed',
  });
  assert.strictEqual(rec.escalation.from, 'L2');
  assert.strictEqual(rec.escalation.to, 'L3');
  assert.strictEqual(rec.escalation.l2Attempted, true);
  assert.strictEqual(rec.context.healReason, 'snapshot-unreadable');

  // 终端告警:具体故障 + 建议 + 取证路径。
  assert.strictEqual(s.logs.length, 1);
  const alert = s.logs[0];
  assert.match(alert, /自愈失败已升级到 L3/);
  assert.match(alert, /sourceHealService/);
  assert.match(alert, /snapshot_read: decrypt_fail/);
  assert.match(alert, /restore_download_failed/);
  assert.match(alert, /建议: .*khy restore/);
  assert.ok(alert.includes(fp), '告警应给出记录文件位置');

  // 审计:L2 → L3 的升级原因与级别。
  const l3 = s.find('escalate_to_l3');
  assert.strictEqual(l3.details.message, 'L2 失败，升级到 L3(交人)');
  assert.strictEqual(l3.details.from, 'L2');
  assert.strictEqual(l3.result, 'failure');
  assert.strictEqual(l3.details.severity, 'high');

  // 读回 / 清除。
  const pending = svc.readPendingEscalation({ khyDir });
  assert.strictEqual(pending.component, 'sourceHealService');
  assert.strictEqual(svc.clearEscalation({ khyDir }), true);
  assert.strictEqual(svc.readPendingEscalation({ khyDir }), null);
  assert.strictEqual(svc.clearEscalation({ khyDir }), false);
});

test('L2 执行器抛异常 → 视为 L2 失败并交人,不外抛', async () => {
  const khyDir = _mk('khy-esc-throw-');
  const s = _spies();
  const out = await svc.escalate({
    component: 'configGuard',
    failedAttempts: [{ step: 'read_main', error: 'json_parse_failed' }],
    env: {},
    khyDir,
    deps: {
      ...s.deps,
      runFreshInstallDoctor: () => {
        throw new Error('doctor exploded');
      },
    },
  });
  assert.strictEqual(out.level, 'L3');
  assert.match(out.record.failedAttempts[1].error, /doctor exploded/);
  assert.match(s.logs[0], /L2 已尝试: freshInstallDoctor/);
});

// ── ⑥ 无 L2 / 跳过 L2 / L2 门控关 ───────────────────────────────────────────
test('selfRepairTransaction 无自动手段 → 直接交人', async () => {
  const khyDir = _mk('khy-esc-selfrepair-');
  const s = _spies();
  const out = await svc.escalate({
    component: 'selfRepairTransaction',
    trigger: 'self-repair-rollback',
    failedAttempts: [
      { step: 'validate', error: 'syntax: a.js' },
      { step: 'rollback', error: 'rollback_incomplete' },
    ],
    env: {},
    khyDir,
    deps: s.deps,
  });
  assert.strictEqual(out.level, 'L3');
  assert.strictEqual(out.record.escalation.l2Attempted, false);
  assert.strictEqual(out.record.escalation.l2Action, null);
  assert.match(out.record.suggestedAction, /git status/);
  assert.match(s.logs[0], /该组件无自动升级手段/);
  assert.match(s.logs[0], /rollback: rollback_incomplete/);
  assert.strictEqual(s.find('escalate_l1_to_l2'), null);
  assert.strictEqual(s.find('escalate_to_l3').details.from, 'L1');
});

test('skipL2(调用方已自行跑过该手段)→ 不重复跑重活,直接交人', async () => {
  const khyDir = _mk('khy-esc-skip-');
  const s = _spies();
  let ran = false;
  const out = await svc.escalate({
    component: 'dbHealth',
    skipL2: true,
    failedAttempts: [{ step: 'rebuild_empty', error: 'failed' }],
    context: { dbPath: 'C:/nope/x.db' },
    env: {},
    khyDir,
    deps: {
      ...s.deps,
      runRebuildEmptyDb: () => {
        ran = true;
        return { ok: true };
      },
    },
  });
  assert.strictEqual(ran, false, '已失败过的 L2 不得重复执行');
  assert.strictEqual(out.level, 'L3');
  assert.strictEqual(out.record.severity, 'critical');
  assert.strictEqual(out.record.escalation.l2Attempted, false);
  assert.match(out.record.escalation.l2Skipped, /已自行执行/);
  assert.match(s.logs[0], /L2 未执行: rebuildEmptyDb/);
});

test('KHY_HEAL_ESCALATION_L2=0 → 只记录/告警,不自动跑重手段', async () => {
  const khyDir = _mk('khy-esc-l2off-');
  const s = _spies();
  let ran = false;
  const out = await svc.escalate({
    component: 'sourceHealService',
    failedAttempts: [{ step: 'snapshot_read', error: 'decrypt_fail' }],
    env: { KHY_HEAL_ESCALATION_L2: '0' },
    khyDir,
    deps: {
      ...s.deps,
      runRestore: () => {
        ran = true;
        return { ok: true };
      },
    },
  });
  assert.strictEqual(ran, false);
  assert.strictEqual(out.level, 'L3');
  assert.match(out.record.escalation.l2Skipped, /KHY_HEAL_ESCALATION_L2/);
});

// ── ⑦ 冷却窗 ────────────────────────────────────────────────────────────────
test('冷却窗: 同组件默认 24h 内不重复升级,force 绕过', async () => {
  const khyDir = _mk('khy-esc-cool-');
  const s = _spies();
  const deps = { ...s.deps, runRestore: () => ({ ok: true }) };
  const T = 1_700_000_000_000;

  const first = await svc.escalate({
    component: 'sourceHealService',
    failedAttempts: [{ step: 'snapshot_read', error: 'decrypt_fail' }],
    env: {},
    khyDir,
    now: T,
    deps,
  });
  assert.strictEqual(first.level, 'L2');

  const second = await svc.escalate({
    component: 'sourceHealService',
    failedAttempts: [{ step: 'snapshot_read', error: 'decrypt_fail' }],
    env: {},
    khyDir,
    now: T + 3600 * 1000,
    deps,
  });
  assert.strictEqual(second.reason, 'cooldown');
  assert.strictEqual(second.escalated, false);
  assert.ok(s.find('escalation_throttled'), '冷却跳过也应留痕');

  // 别的组件不受影响。
  const other = await svc.escalate({
    component: 'configGuard',
    failedAttempts: [{ step: 'read_main', error: 'x' }],
    env: {},
    khyDir,
    now: T + 3600 * 1000,
    deps: { ...deps, runFreshInstallDoctor: () => ({ ok: true }) },
  });
  assert.strictEqual(other.level, 'L2');

  // --force 绕过冷却窗。
  const forced = await svc.escalate({
    component: 'sourceHealService',
    failedAttempts: [{ step: 'snapshot_read', error: 'decrypt_fail' }],
    env: {},
    khyDir,
    now: T + 3600 * 1000,
    force: true,
    deps,
  });
  assert.strictEqual(forced.level, 'L2');

  // 窗口外自然放行。
  const later = await svc.escalate({
    component: 'sourceHealService',
    failedAttempts: [{ step: 'snapshot_read', error: 'decrypt_fail' }],
    env: {},
    khyDir,
    now: T + 25 * 3600 * 1000,
    deps,
  });
  assert.strictEqual(later.level, 'L2');
});

test('_cooldownMs: 默认 24h,可由环境变量覆盖,0 = 不限流', () => {
  assert.strictEqual(svc._cooldownMs({}), 24 * 3600 * 1000);
  assert.strictEqual(svc._cooldownMs({ KHY_HEAL_ESCALATION_COOLDOWN_HOURS: '1' }), 3600 * 1000);
  assert.strictEqual(svc._cooldownMs({ KHY_HEAL_ESCALATION_COOLDOWN_HOURS: '0' }), 0);
  assert.strictEqual(svc._cooldownMs({ KHY_HEAL_ESCALATION_COOLDOWN_HOURS: 'abc' }), 24 * 3600 * 1000);
});

// ── ⑧ fail-soft ─────────────────────────────────────────────────────────────
test('fail-soft: 垃圾输入不抛,审计/告警失败也不抛', async () => {
  const khyDir = _mk('khy-esc-soft-');

  assert.strictEqual((await svc.escalate()).reason, 'no-component');
  assert.strictEqual((await svc.escalate({ component: '' })).reason, 'no-component');
  assert.strictEqual((await svc.escalate({ component: null, env: {} })).reason, 'no-component');

  // 审计与告警都炸 → 仍然完成 L3 落盘,且不抛。
  const out = await svc.escalate({
    component: 'selfRepairTransaction',
    failedAttempts: 'not-an-array',
    env: {},
    khyDir,
    deps: {
      audit: () => {
        throw new Error('audit down');
      },
      log: () => {
        throw new Error('tty down');
      },
    },
  });
  assert.strictEqual(out.level, 'L3');
  assert.strictEqual(fs.existsSync(path.join(khyDir, 'heal_escalation.json')), true);

  // 记录文件写不进去(路径指向一个文件而非目录)→ 降级为「只告警」,不抛。
  const bogus = path.join(_mk('khy-esc-bogus-'), 'as-file');
  fs.writeFileSync(bogus, 'x');
  const s = _spies();
  const out2 = await svc.escalate({
    component: 'selfRepairTransaction',
    env: {},
    khyDir: bogus,
    deps: s.deps,
  });
  assert.strictEqual(out2.level, 'L3');
  assert.strictEqual(out2.file, null);
  assert.strictEqual(s.logs.length, 1);
});

test('normalizeAttempts / buildEscalationRecord / formatEscalationAlert: 纯函数不抛且封顶', () => {
  assert.deepStrictEqual(svc.normalizeAttempts(null), []);
  assert.deepStrictEqual(svc.normalizeAttempts('x'), []);
  assert.deepStrictEqual(svc.normalizeAttempts(['boom']), [{ step: 'unknown', error: 'boom' }]);
  assert.deepStrictEqual(svc.normalizeAttempts([{ error: 1 }]), [{ step: 'unknown', error: '1' }]);
  const many = svc.normalizeAttempts(
    Array.from({ length: 50 }, (_, i) => ({ step: `s${i}`, error: 'e' }))
  );
  assert.strictEqual(many.length, 20);
  const long = svc.normalizeAttempts([{ step: 'x'.repeat(500), error: 'y'.repeat(2000) }]);
  assert.strictEqual(long[0].step.length, 120);
  assert.strictEqual(long[0].error.length, 500);

  const rec = svc.buildEscalationRecord({});
  assert.strictEqual(rec.component, 'unknown');
  assert.ok(rec.timestamp);
  assert.deepStrictEqual(rec.failedAttempts, []);
  assert.ok(typeof svc.formatEscalationAlert(null) === 'string');
  assert.ok(typeof svc.formatEscalationAlert(rec, null) === 'string');

  // 故障条目过多时折叠,不刷屏。
  const big = svc.formatEscalationAlert(
    svc.buildEscalationRecord({
      component: 'dbHealth',
      failedAttempts: Array.from({ length: 9 }, (_, i) => ({ step: `s${i}`, error: 'e' })),
    })
  );
  assert.match(big, /另有 3 条/);
});

// ── ⑨ 调用方接线:sourceHealService ─────────────────────────────────────────
test('sourceHealService._hadSnapshotBefore: 只有记过指纹才算「曾有快照」', () => {
  const home = _mk('khy-heal-home-');
  assert.strictEqual(healSvc._hadSnapshotBefore({ dataHome: home }), false);
  fs.writeFileSync(path.join(home, 'source_heal_state.json'), JSON.stringify({ lastAt: 1 }));
  assert.strictEqual(healSvc._hadSnapshotBefore({ dataHome: home }), false);
  fs.writeFileSync(
    path.join(home, 'source_heal_state.json'),
    JSON.stringify({ lastAt: 1, fingerprint: 'abc' })
  );
  assert.strictEqual(healSvc._hadSnapshotBefore({ dataHome: home }), true);
});

test('sourceHealService._isDevTree: 安装树里有 .git → 开发树(不升级)', () => {
  const repo = _mk('khy-devtree-');
  const src = path.join(repo, 'services', 'backend', 'src');
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(path.join(repo, '.git'));
  assert.strictEqual(healSvc._isDevTree({ installSrcDir: src }), true);

  const installed = _mk('khy-installed-');
  assert.strictEqual(healSvc._isDevTree({ installSrcDir: installed }), false);

  // 本仓库自身就是开发树 → 默认(不传 installSrcDir)必须判 true。
  assert.strictEqual(healSvc._isDevTree({}), true);
});

test('sourceHealService._maybeEscalate: 真故障才调升级链,且带对的载荷', () => {
  const install = _mk('khy-esc-install-'); // 非 git 工作树 = 已装副本
  const calls = [];
  const escalateFn = (payload) => {
    calls.push(payload);
    return Promise.resolve({ level: 'L3' });
  };

  // 健康 → 不升级。
  assert.strictEqual(
    healSvc._maybeEscalate(
      { ok: true, reason: 'healthy' },
      { escalateFn, env: {}, installSrcDir: install },
      true
    ),
    null
  );
  assert.strictEqual(calls.length, 0);

  // 快照解不开 → 升级,载荷含组件名与具体故障。
  const v = healSvc._maybeEscalate(
    { ok: true, reason: 'snapshot-unreadable' },
    { escalateFn, env: {}, reason: 'cli-bootstrap', installSrcDir: install },
    true
  );
  assert.ok(v && v.failed);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].component, 'sourceHealService');
  assert.strictEqual(calls[0].trigger, 'cli-bootstrap');
  assert.deepStrictEqual(calls[0].failedAttempts, [{ step: 'snapshot_read', error: 'decrypt_fail' }]);

  // 开发树(安装树上方有 .git)→ 交给 git,绝不升级。
  const repo = _mk('khy-esc-devtree-');
  const devSrc = path.join(repo, 'services', 'backend', 'src');
  fs.mkdirSync(devSrc, { recursive: true });
  fs.mkdirSync(path.join(repo, '.git'));
  assert.strictEqual(
    healSvc._maybeEscalate(
      { ok: true, reason: 'snapshot-unreadable' },
      { escalateFn, env: {}, installSrcDir: devSrc },
      true
    ),
    null
  );
  assert.strictEqual(calls.length, 1);

  // 显式关闭(escalate:false)→ 不调。
  assert.strictEqual(
    healSvc._maybeEscalate(
      { ok: true, reason: 'snapshot-unreadable' },
      { escalateFn, env: {}, escalate: false, installSrcDir: install },
      true
    ),
    null
  );
  assert.strictEqual(calls.length, 1);

  // 升级链自身抛错也不能反噬自愈。
  assert.doesNotThrow(() =>
    healSvc._maybeEscalate(
      { ok: true, reason: 'error' },
      {
        env: {},
        installSrcDir: install,
        escalateFn: () => {
          throw new Error('chain down');
        },
      },
      true
    )
  );
});

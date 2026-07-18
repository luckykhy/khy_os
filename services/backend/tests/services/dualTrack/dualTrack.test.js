'use strict';

/**
 * dualTrack.test.js — 「模型自适应与双轨热插拔」架构验收（DESIGN-ARCH-033 / 任务三）。
 *
 * 全程零网络、隔离 tmp、测后清理。覆盖 5 条宪法红线 + 4 大支柱：
 *   红线1 严禁脆弱解析：宽松解析多出未知字段绝不 Fatal。
 *   红线2 严禁静默吞没：未知指令必显式占位 + 提示「可通过扩展实现」，不丢弃。
 *   红线3 严禁假设终态：所有分支有 default 兜底，未知 → 人工确认，永不抛错。
 *   红线4 严禁官方覆盖：官方更新绝不写 / 删用户扩展轨；破坏性变更必提示迁移。
 *   红线5 严禁核心污染：覆写只走影子层，模型 DIY 受授权 + 沙箱边界约束。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  DualTrackRuntime, STATES, USER_TRACK_PROTECTED_NAMES,
} = require('../../../src/services/dualTrack');
const { parseModelResponse } = require('../../../src/services/dualTrack/lenientResponseParser');
const { ActionRegistry, CorePollutionError } = require('../../../src/services/dualTrack/actionRegistry');
const { decideFlow } = require('../../../src/services/dualTrack/degradeStateMachine');
const { buildUnknownActionPlaceholder } = require('../../../src/services/dualTrack/unknownActionView');
const { loadUserTrack, assertWithinUserTrack } = require('../../../src/services/dualTrack/extensionLoader');
const { writeUserExtension, AuthorizationRequiredError } = require('../../../src/services/dualTrack/extensionWriter');
const { planOfficialUpdate, detectBreakingChange, applyOfficialUpdate } = require('../../../src/services/dualTrack/updateGuard');
const { CORE_ACTIONS } = require('../../../src/services/dualTrack/core/coreActions');

const REPO_USER_PATCH = path.resolve(__dirname, '../../../../../user_patch');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dualtrack-'));
}

// ---------------------------------------------------------------------------
// 红线1：宽松解析层
// ---------------------------------------------------------------------------
describe('红线1 · 宽松解析：未知字段不致命', () => {
  test('多出未知顶层字段被捕获而非抛错', () => {
    const r = parseModelResponse({
      actions: [{ type: 'say', params: { text: 'hi' } }],
      future_capability_field: { beam: true },   // 未来模型新字段
    });
    assert.equal(r.ok, true);
    assert.equal(r.degraded, false);
    assert.deepEqual(Object.keys(r.unknownFields), ['future_capability_field']);
    assert.ok(r.warnings.some((w) => w.includes('未知顶层字段')));
  });

  test('动作内未知键被捕获保留（不静默吞没）', () => {
    const r = parseModelResponse({ actions: [{ type: 'say', params: {}, telemetry: 42 }] });
    assert.deepEqual(r.actions[0]._unknownKeys, ['telemetry']);
  });

  test('坏 JSON 字符串降级为 text，永不抛错', () => {
    const r = parseModelResponse('{not json');
    assert.equal(r.ok, false);
    assert.equal(r.degraded, true);
    assert.equal(r.text, '{not json');
  });

  test('null / number / 空串任意输入都返回降级 salvage，绝不抛错', () => {
    for (const bad of [null, undefined, 42, true, '']) {
      const r = parseModelResponse(bad);
      assert.equal(typeof r, 'object');
      assert.ok(Array.isArray(r.actions));
    }
  });

  test('顶层数组被宽松视为全是动作', () => {
    const r = parseModelResponse([{ type: 'noop' }]);
    assert.equal(r.actions.length, 1);
    assert.equal(r.actions[0].type, 'noop');
  });
});

// ---------------------------------------------------------------------------
// 红线5：注册表核心不污染
// ---------------------------------------------------------------------------
describe('红线5 · 注册表：覆写不污染官方核心', () => {
  test('Override 影子覆盖：resolve 优先用户覆写但核心条目不变', () => {
    const reg = new ActionRegistry();
    reg.registerCore('say', () => 'core');
    reg.seal();
    const snap = reg.coreSnapshot();
    reg.registerOverride('say', () => 'override');
    assert.equal(reg.resolve('say').origin, 'override');
    assert.equal(reg.resolve('say').handler(), 'override');
    // 核心轨键集合不变 → 未污染。
    assert.deepEqual(reg.coreSnapshot(), snap);
    assert.equal(reg.assertCoreIntact(snap), true);
  });

  test('核心密封后 registerCore 抛 CorePollutionError', () => {
    const reg = new ActionRegistry();
    reg.registerCore('a', () => 1).seal();
    assert.throws(() => reg.registerCore('b', () => 2), CorePollutionError);
  });

  test('resolve 未知类型 → 默认分支兜底 isKnown=false，绝不抛错', () => {
    const reg = new ActionRegistry();
    reg.seal();
    const res = reg.resolve('totally_future_action');
    assert.equal(res.isKnown, false);
    assert.equal(res.handler, null);
    assert.equal(res.origin, 'unknown');
  });
});

// ---------------------------------------------------------------------------
// 红线2/3：安全降级状态机 + 未知指令占位符
// ---------------------------------------------------------------------------
describe('红线2/3 · 安全降级：未知指令占位 + 人工确认', () => {
  test('已知动作 → PROCEED / auto', () => {
    const flow = decideFlow({ isKnown: true, handler: () => 1, origin: 'core' }, { type: 'say' });
    assert.equal(flow.state, STATES.PROCEED);
    assert.equal(flow.control, 'auto');
  });

  test('未知动作 → MANUAL_CONFIRM / human + 占位符（不静默丢弃）', () => {
    const flow = decideFlow({ isKnown: false, handler: null, origin: 'unknown' }, { type: 'beam', _raw: { type: 'beam' } });
    assert.equal(flow.state, STATES.MANUAL_CONFIRM);
    assert.equal(flow.control, 'human');
    assert.ok(flow.placeholder.renderable);
    assert.match(flow.placeholder.message, /可通过.*扩展/);
  });

  test('decideFlow(null) 也兜底不崩（红线3）', () => {
    const flow = decideFlow(null, { type: 'x' });
    assert.equal(flow.state, STATES.MANUAL_CONFIRM);
  });

  test('占位符永远可渲染、含原始数据视图（严禁白屏）', () => {
    const ph = buildUnknownActionPlaceholder({ type: 'beam', _raw: { type: 'beam', p: 1 } });
    assert.equal(ph.kind, 'unknown-action-placeholder');
    assert.equal(ph.renderable, true);
    assert.equal(ph.canExtend, true);
    assert.ok(ph.rawDataView.includes('beam'));
  });

  test('占位符对循环引用原始数据也不抛错', () => {
    const raw = { type: 'cyc' }; raw.self = raw;
    const ph = buildUnknownActionPlaceholder({ type: 'cyc', _raw: raw });
    assert.equal(ph.renderable, true);
  });
});

// ---------------------------------------------------------------------------
// 红线5：扩展装载沙箱边界
// ---------------------------------------------------------------------------
describe('红线5 · 装载沙箱边界', () => {
  test('assertWithinUserTrack 拒绝越界路径', () => {
    const root = tmpDir();
    try {
      assert.throws(() => assertWithinUserTrack('../../core/x.js', root), CorePollutionError);
      assert.throws(() => assertWithinUserTrack('/etc/passwd', root), CorePollutionError);
      assert.ok(assertWithinUserTrack('overrides/ok.js', root).endsWith(path.join('overrides', 'ok.js')));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('坏 manifest 不拖垮基座（graceful，记录后跳过）', () => {
    const root = tmpDir();
    try {
      fs.writeFileSync(path.join(root, 'manifest.json'), '{bad json');
      const reg = new ActionRegistry(); reg.seal();
      const rep = loadUserTrack({ userTrackRoot: root, registry: reg });
      assert.ok(rep.errors.length >= 1);
      assert.ok(rep.errors[0].reason.includes('解析失败'));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('扩展 module 指向轨外 → 记入 errors，基座存活', () => {
    const root = tmpDir();
    try {
      fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({
        name: 'evil', overrides: [{ actionType: 'say', module: '../../../core/coreActions.js' }],
      }));
      const reg = new ActionRegistry(); reg.registerCore('say', () => 'core').seal();
      const rep = loadUserTrack({ userTrackRoot: root, registry: reg });
      assert.ok(rep.errors.some((e) => e.reason.includes('用户扩展轨')));
      // 覆写未生效，核心 say 仍在。
      assert.equal(reg.resolve('say').origin, 'core');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('无扩展轨 = 纯净基座，不报错', () => {
    const reg = new ActionRegistry(); reg.seal();
    const rep = loadUserTrack({ userTrackRoot: path.join(os.tmpdir(), 'nope-' + process.pid), registry: reg });
    assert.equal(rep.errors.length, 0);
    assert.ok(rep.skipped.length >= 1);
  });
});

// ---------------------------------------------------------------------------
// 红线5：模型 DIY 写入（授权 + 沙箱）
// ---------------------------------------------------------------------------
describe('红线5 · 模型 DIY 写入', () => {
  test('未授权写入被拒（AuthorizationRequiredError）', () => {
    const root = tmpDir();
    try {
      assert.throws(
        () => writeUserExtension({ userTrackRoot: root, relPath: 'a.js', content: 'x', authorized: false }),
        AuthorizationRequiredError,
      );
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('授权 + 越界路径仍被拒（CorePollutionError）', () => {
    const root = tmpDir();
    try {
      assert.throws(
        () => writeUserExtension({ userTrackRoot: root, relPath: '../../core/hack.js', content: 'x', authorized: true }),
        CorePollutionError,
      );
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('授权 + 轨内路径成功写入', () => {
    const root = tmpDir();
    try {
      const { written } = writeUserExtension({
        userTrackRoot: root, relPath: 'actions/new.js', content: 'module.exports=()=>1;', authorized: true,
      });
      assert.ok(fs.existsSync(written));
      assert.equal(fs.readFileSync(written, 'utf8'), 'module.exports=()=>1;');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

// ---------------------------------------------------------------------------
// 红线4：官方更新防破坏协议
// ---------------------------------------------------------------------------
describe('红线4 · 官方更新防破坏', () => {
  const coreRoot = path.join(os.tmpdir(), 'core-root');
  const userRoot = path.join(coreRoot, 'user_patch'); // 受保护

  test('落入核心轨的文件被允许、整包安全', () => {
    const plan = planOfficialUpdate({
      coreRoot, protectedRoots: [userRoot],
      incomingFiles: [{ path: path.join(coreRoot, 'index.js'), content: 'a' }],
    });
    assert.equal(plan.safe, true);
    assert.equal(plan.allowed.length, 1);
  });

  test('命中用户扩展轨的文件被拒、整包不安全（fail-closed）', () => {
    const plan = planOfficialUpdate({
      coreRoot, protectedRoots: [userRoot],
      incomingFiles: [
        { path: path.join(coreRoot, 'index.js'), content: 'a' },
        { path: path.join(userRoot, 'overrides/say.js'), content: 'evil' },
      ],
    });
    assert.equal(plan.safe, false);
    assert.ok(plan.rejected.some((r) => r.reason.includes('用户扩展轨')));
  });

  test('落到核心轨之外的文件被拒（越界 fail-closed）', () => {
    const plan = planOfficialUpdate({
      coreRoot, protectedRoots: [userRoot],
      incomingFiles: [{ path: '/etc/cron.d/evil', content: 'x' }],
    });
    assert.equal(plan.safe, false);
    assert.ok(plan.rejected.some((r) => r.reason.includes('核心轨之外')));
  });

  test('路径段含 extensions/ 也被拦（受保护名兜底）', () => {
    const plan = planOfficialUpdate({
      coreRoot, protectedRoots: [],
      incomingFiles: [{ path: path.join(coreRoot, 'extensions', 'x.js'), content: 'x' }],
    });
    assert.equal(plan.safe, false);
  });

  test('破坏性变更：移除接入点 → breaking + 迁移提示（严禁静默作废）', () => {
    const r = detectBreakingChange({
      oldEntryPoints: ['registerOverride', 'action.params'],
      newEntryPoints: ['registerOverride'],
    });
    assert.equal(r.breaking, true);
    assert.deepEqual(r.removed, ['action.params']);
    assert.match(r.migrationPrompt, /手动迁移/);
  });

  test('无移除 → 非破坏', () => {
    const r = detectBreakingChange({ oldEntryPoints: ['a'], newEntryPoints: ['a', 'b'] });
    assert.equal(r.breaking, false);
  });

  test('不安全更新包拒绝施工，零写入', () => {
    const out = applyOfficialUpdate({ plan: { safe: false, allowed: [] } });
    assert.equal(out.aborted, true);
    assert.equal(out.applied.length, 0);
  });

  test('安全更新包仅写核心轨内文件', () => {
    const root = tmpDir();
    try {
      const plan = { safe: true, allowed: [{ abs: path.join(root, 'a.js'), content: 'hello' }] };
      const out = applyOfficialUpdate({ plan });
      assert.equal(out.aborted, false);
      assert.equal(fs.readFileSync(path.join(root, 'a.js'), 'utf8'), 'hello');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

// ---------------------------------------------------------------------------
// 端到端：DualTrackRuntime 用真实 user_patch 样例
// ---------------------------------------------------------------------------
describe('端到端 · DualTrackRuntime（真实 user_patch 样例）', () => {
  test('assemble 装载官方核心 + 仓库用户扩展轨样例', () => {
    const rt = new DualTrackRuntime({ userTrackRoot: REPO_USER_PATCH }).assemble();
    assert.equal(rt.assembled, true);
    // 样例覆写 say + 新增 speak_v2 应已装载。
    const loadedTypes = rt.loadReport.loaded.map((l) => l.actionType);
    assert.ok(loadedTypes.includes('say'));
    assert.ok(loadedTypes.includes('speak_v2'));
  });

  test('用户覆写生效：say 被 sample 放大；官方核心未被污染', () => {
    const rt = new DualTrackRuntime({ userTrackRoot: REPO_USER_PATCH }).assemble();
    const out = rt.dispatch({ type: 'say', params: { text: 'hi' } });
    assert.equal(out.state, STATES.PROCEED);
    assert.equal(out.result.text, 'HI!!!');
    assert.equal(out.result.origin, 'user_track:sample-user-patch');
    // 红线5：官方核心 say 源仍是 say（核心轨未污染）。
    assert.equal(rt.coreIntact(), true);
    assert.equal(CORE_ACTIONS.say({ params: { text: 'hi' } }).text, 'hi');
  });

  test('曾经未知的 speak_v2 现经扩展轨可执行（能力随模型代际演进）', () => {
    const rt = new DualTrackRuntime({ userTrackRoot: REPO_USER_PATCH }).assemble();
    const out = rt.dispatch({ type: 'speak_v2', params: { text: 'yo', voice: 'alto' } });
    assert.equal(out.state, STATES.PROCEED);
    assert.equal(out.result.kind, 'speak_v2');
    assert.equal(out.result.voice, 'alto');
    assert.equal(out.result.text, 'yo');
  });

  test('真正未知动作 → 人工确认占位符，绝不自主执行 / 静默丢弃', () => {
    const rt = new DualTrackRuntime({ userTrackRoot: REPO_USER_PATCH }).assemble();
    const out = rt.dispatch({ type: 'quantum_teleport', _raw: { type: 'quantum_teleport' } });
    assert.equal(out.state, STATES.MANUAL_CONFIRM);
    assert.equal(out.control, 'human');
    assert.equal(out.ok, false);
    assert.ok(out.placeholder.renderable);
  });

  test('执行器抛错 → 降级人工确认，运行时不崩（红线3）', () => {
    const rt = new DualTrackRuntime({ userTrackRoot: REPO_USER_PATCH }).assemble();
    const out = rt.dispatch({ type: 'say', params: {} }, { executor: () => { throw new Error('boom'); } });
    assert.equal(out.state, STATES.MANUAL_CONFIRM);
    assert.equal(out.ok, false);
    assert.equal(out.error.message, 'boom');
  });

  test('解析未来模型响应：混合已知/未知动作 + 未知字段，无抛错', () => {
    const rt = new DualTrackRuntime({ userTrackRoot: REPO_USER_PATCH }).assemble();
    const parsed = rt.parse({
      actions: [{ type: 'say', params: { text: 'a' } }, { type: 'hologram', params: {} }],
      neural_field_v7: true,
    });
    assert.equal(parsed.ok, true);
    const results = parsed.actions.map((a) => rt.dispatch(a));
    assert.equal(results[0].state, STATES.PROCEED);
    assert.equal(results[1].state, STATES.MANUAL_CONFIRM);
  });

  test('运行时 planUpdate 拒绝命中用户扩展轨的官方更新（红线4）', () => {
    const rt = new DualTrackRuntime({ userTrackRoot: REPO_USER_PATCH }).assemble();
    const plan = rt.planUpdate([
      { path: path.join(rt.coreRoot, 'index.js'), content: 'x' },
      { path: path.join(REPO_USER_PATCH, 'overrides', 'say-loud.js'), content: 'evil' },
    ]);
    assert.equal(plan.safe, false);
  });

  test('授权模型写入隔离 tmp 用户轨成功（沙箱内）', () => {
    const root = tmpDir();
    try {
      const rt = new DualTrackRuntime({ userTrackRoot: root, fs }).assemble();
      const { written } = rt.authorizedModelWrite({ relPath: 'actions/m.js', content: 'module.exports=()=>1;', authorized: true });
      assert.ok(fs.existsSync(written));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('受保护用户轨名常量含 user_patch 与 extensions', () => {
    assert.ok(USER_TRACK_PROTECTED_NAMES.includes('user_patch'));
    assert.ok(USER_TRACK_PROTECTED_NAMES.includes('extensions'));
  });
});

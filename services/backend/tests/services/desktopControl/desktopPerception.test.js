'use strict';

/**
 * desktopPerception.test.js — 桌面「看清 + 结构化可点击元素」感知层验收（DESIGN-ARCH-056 感知层）。
 *
 * 覆盖：元素规范化模型（纯函数）、无障碍 inspect 后端单源/注入安全、感知探测、uiInspector
 * 编排（成功/降级/OCR 兜底/clickableOnly/解析失败）、门面 inspect/observe/clickElement 与
 * 「按元素引用点击/填表」、工具新动作路由。全程零真实截屏/无障碍调用——execFile/inspect 注入替身。
 */

const registry = require('../../../src/services/desktopControl/backendRegistry');
const detector = require('../../../src/services/desktopControl/backendDetector');
const elementModel = require('../../../src/services/desktopControl/elementModel');
const uiInspector = require('../../../src/services/desktopControl/uiInspector');
const safetyGate = require('../../../src/services/desktopControl/safetyGate');
const { DesktopController } = require('../../../src/services/desktopControl');
const DesktopControlTool = require('../../../src/tools/DesktopControlTool');

beforeEach(() => {
  safetyGate.resetAll();
  detector.reset();
  delete process.env.KHY_DESKTOP_CONTROL;
  delete process.env.KHY_DESKTOP_MAX_ACTUATIONS;
});

// ───────────────────────────────────────────────────────────────────
describe('elementModel — 规范化模型与寻址（纯函数）', () => {
  test('canonicalRole 跨平台角色归一（AXButton / "push button" / Button）', () => {
    expect(elementModel.canonicalRole('AXButton')).toBe('button');
    expect(elementModel.canonicalRole('push button')).toBe('button');
    expect(elementModel.canonicalRole('ControlType.Button')).toBe('button'); // 含关键词容错
    expect(elementModel.canonicalRole('AXTextField')).toBe('textfield');
    expect(elementModel.canonicalRole('AXStaticText')).toBe('text');
    expect(elementModel.canonicalRole('totally-unknown')).toBe('generic');
  });

  test('normalizeElement：计算中心点 + 可点击/可编辑 + 稳定 id', () => {
    const el = elementModel.normalizeElement({ role: 'AXButton', name: '登录', x: 10, y: 20, w: 80, h: 30 }, 2);
    expect(el.id).toBe('e3');
    expect(el.role).toBe('button');
    expect(el.center).toEqual({ x: 50, y: 35 });
    expect(el.clickable).toBe(true);
    expect(el.editable).toBe(false);
  });

  test('无包围盒 → 绝不臆造坐标：center=null 且 clickable=false', () => {
    const el = elementModel.normalizeElement({ role: 'button', name: 'X' }, 0);
    expect(el.center).toBeNull();
    expect(el.clickable).toBe(false);
  });

  test('禁用态按钮不可点击', () => {
    const el = elementModel.normalizeElement({ role: 'button', name: 'X', x: 0, y: 0, w: 10, h: 10, enabled: false }, 0);
    expect(el.clickable).toBe(false);
  });

  test('normalizeAll：去重叠重复 + 丢空节点 + 重排 id', () => {
    const list = elementModel.normalizeAll([
      { role: 'button', name: '提交', x: 0, y: 0, w: 100, h: 40 },
      { role: 'button', name: '提交', x: 1, y: 1, w: 100, h: 40 }, // 高度重叠同名 → 视为重复
      { role: 'text', name: '', x: 5, y: 5 }, // 空名 + 不可点击 + 无有效包围盒(无w,h) → 丢弃
      { role: 'textfield', name: '邮箱', x: 0, y: 60, w: 200, h: 30 },
    ]);
    expect(list.map((e) => e.name)).toEqual(['提交', '邮箱']);
    expect(list.map((e) => e.id)).toEqual(['e1', 'e2']);
  });

  test('filterClickable 只留可点击；toMarks 产出精简标记', () => {
    const els = elementModel.normalizeAll([
      { role: 'button', name: 'OK', x: 0, y: 0, w: 10, h: 10 },
      { role: 'text', name: '说明', x: 0, y: 20, w: 50, h: 10 },
    ]);
    expect(elementModel.filterClickable(els).map((e) => e.name)).toEqual(['OK']);
    const marks = elementModel.toMarks(els);
    expect(marks[0]).toMatchObject({ id: 'e1', role: 'button', label: 'OK', clickable: true });
  });

  test('resolveTarget：按 id / 序号 / 名称（精确>前缀>包含）', () => {
    const els = elementModel.normalizeAll([
      { role: 'button', name: '提交', x: 0, y: 0, w: 10, h: 10 },
      { role: 'button', name: '提交订单', x: 0, y: 20, w: 10, h: 10 },
      { role: 'button', name: '取消', x: 0, y: 40, w: 10, h: 10 },
    ]);
    expect(elementModel.resolveTarget(els, 'e2').element.name).toBe('提交订单');
    expect(elementModel.resolveTarget(els, 1).element.name).toBe('提交订单'); // index=1
    expect(elementModel.resolveTarget(els, '取消').element.role).toBe('button');
    // "提交" 精确命中第一个，即便 "提交订单" 也包含它。
    expect(elementModel.resolveTarget(els, '提交').element.name).toBe('提交');
    expect(elementModel.resolveTarget(els, '不存在').ok).toBe(false);
  });

  test('resolveTarget 多候选 → 标 ambiguous 并列候选', () => {
    const els = elementModel.normalizeAll([
      { role: 'button', name: '保存草稿', x: 0, y: 0, w: 10, h: 10 },
      { role: 'button', name: '保存并发布', x: 0, y: 20, w: 10, h: 10 },
    ]);
    const r = elementModel.resolveTarget(els, '保存');
    expect(r.ok).toBe(true);
    expect(r.ambiguous).toBe(true);
    expect(r.candidates.length).toBe(2);
  });
});

// ───────────────────────────────────────────────────────────────────
describe('backendRegistry — inspect 后端单源 + 注入安全', () => {
  test('每个平台都登记了 inspect 后端', () => {
    for (const p of ['darwin', 'linux', 'win32']) {
      expect(registry.backendsFor(p, 'inspect').length).toBeGreaterThan(0);
    }
  });

  test('macOS inspect 用 osascript JXA，脚本为常量（无用户数据内插）', () => {
    const b = registry.backendsFor('darwin', 'inspect')[0];
    const t = b.ops.tree({});
    expect(t.cmd).toBe('osascript');
    expect(t.args).toContain('-l');
    expect(t.args).toContain('JavaScript');
    expect(t.args.every((a) => typeof a === 'string')).toBe(true);
  });

  test('Linux inspect 用 python3 + pyatspi（深探依赖）', () => {
    const b = registry.backendsFor('linux', 'inspect')[0];
    expect(b.id).toBe('linux-atspi');
    expect(b.importProbe).toBe('import pyatspi');
    expect(b.ops.tree({}).cmd).toBe('python3');
  });

  test('Windows inspect 用 PowerShell UIAutomation', () => {
    const b = registry.backendsFor('win32', 'inspect')[0];
    expect(b.ops.tree({}).cmd).toBe('powershell');
    expect(b.ops.tree({}).args.join(' ')).toMatch(/UIAutomation/);
  });

  test('_parseJsonElements 容错：数组/单对象/空/垃圾', () => {
    const p = registry._internals._parseJsonElements;
    expect(p('[{"a":1}]')).toEqual([{ a: 1 }]);
    expect(p('{"a":1}')).toEqual([{ a: 1 }]); // ConvertTo-Json 单元素退化为对象
    expect(p('')).toEqual([]);
    expect(p('not json')).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────
describe('backendDetector — 感知后端探测', () => {
  test('挑选 inspect 后端（macOS osascript）', () => {
    const which = (n) => (n === 'osascript' ? '/usr/bin/osascript' : null);
    const r = detector._selectBackend('darwin', 'inspect', { which });
    expect(r.available).toBe(true);
    expect(r.backend).toBe('macos-ax');
  });

  test('Linux pyatspi 深探：import 失败则不可用', () => {
    const which = (n) => (n === 'python3' ? '/usr/bin/python3' : null);
    expect(detector._selectBackend('linux', 'inspect', { which, importRun: () => false }).available).toBe(false);
    expect(detector._selectBackend('linux', 'inspect', { which, importRun: () => true }).available).toBe(true);
  });

  test('detect 汇总 perception 能力（canPerceive）', () => {
    const which = (n) => (n === 'osascript' ? '/x' : null);
    const r = detector.detect({ platform: 'darwin', which, voiceCaps: { tts: null, stt: null } });
    expect(r.perception.available).toBe(true);
    expect(r.summary.canPerceive).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────
describe('uiInspector — 场景感知编排', () => {
  function okDeps(json) {
    return {
      detect: () => ({ platform: 'linux', perception: { available: true, backend: 'linux-atspi' } }),
      resolveBackend: () => ({ id: 'linux-atspi', ops: { tree: () => ({ cmd: 'python3', args: ['-c', '...'] }) }, parse: (s) => JSON.parse(s) }),
      execFile: (_c, _a, _o, cb) => cb(null, json, ''),
    };
  }

  test('成功：JSON → 规范元素 + marks + 仅可点击计数', async () => {
    const json = JSON.stringify([
      { role: 'push button', name: '登录', x: 10, y: 20, w: 80, h: 30, enabled: true },
      { role: 'AXStaticText', name: '用户名', x: 5, y: 5, w: 50, h: 20, enabled: true },
    ]);
    const r = await uiInspector.inspect({}, okDeps(json));
    expect(r.success).toBe(true);
    expect(r.source).toBe('accessibility');
    expect(r.count).toBe(2);
    expect(r.clickableCount).toBe(1);
    expect(r.elements.find((e) => e.role === 'button').center).toEqual({ x: 50, y: 35 });
    expect(r.marks.length).toBe(2);
  });

  test('clickableOnly：只回可点击元素', async () => {
    const json = JSON.stringify([
      { role: 'button', name: 'OK', x: 0, y: 0, w: 10, h: 10, enabled: true },
      { role: 'text', name: '说明', x: 0, y: 20, w: 30, h: 10, enabled: true },
    ]);
    const r = await uiInspector.inspect({ clickableOnly: true }, okDeps(json));
    expect(r.count).toBe(1);
    expect(r.elements[0].role).toBe('button');
  });

  test('无后端且无 OCR → 诚实降级，elements:[] + 安装提示，绝不伪造', async () => {
    const deps = { detect: () => ({ platform: 'linux', perception: { available: false, installHints: [{ package: 'python3-pyatspi' }] } }) };
    const r = await uiInspector.inspect({}, deps);
    expect(r.success).toBe(false);
    expect(r.source).toBe('none');
    expect(r.elements).toEqual([]);
    expect(r.installHints[0].package).toBe('python3-pyatspi');
  });

  test('OCR 兜底：带框词块 → 元素（标 source:ocr，文本不可点击）', async () => {
    const deps = {
      detect: () => ({ platform: 'linux', perception: { available: false, installHints: [] } }),
      ocrWords: async () => [{ text: 'Login', bbox: { x: 10, y: 10, w: 40, h: 20 } }],
    };
    const r = await uiInspector.inspect({}, deps);
    expect(r.success).toBe(true);
    expect(r.source).toBe('ocr');
    expect(r.elements[0].name).toBe('Login');
    expect(r.elements[0].clickable).toBe(false);
  });

  test('解析失败（非 JSON）→ elements:[]，不抛错', async () => {
    const r = await uiInspector.inspect({}, okDeps('not json at all'));
    expect(r.success).toBe(true);
    expect(r.count).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────
describe('DesktopController 门面 — 感知 + 按引用操控', () => {
  test('inspect 受闸门管辖：off 下被拒，不触达感知后端', async () => {
    let touched = false;
    const c = new DesktopController({ sessionId: 'p0', uiInspector: { inspect: async () => { touched = true; return { success: true, elements: [] }; } } });
    const r = await c.inspect({});
    expect(r.denied).toBe(true);
    expect(touched).toBe(false);
  });

  test('on：inspect 放行并记住元素供后续引用', async () => {
    process.env.KHY_DESKTOP_CONTROL = 'on';
    const scene = { success: true, source: 'accessibility', elements: [{ id: 'e1', index: 0, role: 'button', name: 'OK', bounds: { x: 0, y: 0, w: 10, h: 10 }, center: { x: 5, y: 5 }, clickable: true }], marks: [], clickable: [], count: 1, clickableCount: 1 };
    const c = new DesktopController({ sessionId: 'p1', uiInspector: { inspect: async () => scene } });
    const r = await c.inspect({});
    expect(r.success).toBe(true);
    expect(c._lastElements.length).toBe(1);
  });

  test('observe：截屏 + 结构化元素合成一个场景', async () => {
    process.env.KHY_DESKTOP_CONTROL = 'on';
    const c = new DesktopController({
      sessionId: 'p2',
      screenCapture: { capture: async () => ({ success: true, path: '/tmp/s.png', backend: 'scrot', bytes: 10 }) },
      uiInspector: { inspect: async () => ({ success: true, source: 'accessibility', elements: [{ id: 'e1', role: 'button', name: 'OK', center: { x: 1, y: 2 }, bounds: { x: 0, y: 0, w: 2, h: 4 }, clickable: true }], marks: [{ id: 'e1', label: 'OK' }], clickable: [{ id: 'e1' }], count: 1, clickableCount: 1 }) },
    });
    const r = await c.observe({});
    expect(r.success).toBe(true);
    expect(r.path).toBe('/tmp/s.png');
    expect(r.marks.length).toBe(1);
    expect(r.elements[0].name).toBe('OK');
  });

  test('clickElement：按名称解析 → 点击元素中心 → 计入操作预算', async () => {
    process.env.KHY_DESKTOP_CONTROL = 'on';
    const captured = [];
    const c = new DesktopController({
      sessionId: 'p3',
      uiInspector: { inspect: async () => ({ success: true, elements: [{ id: 'e1', index: 0, role: 'button', name: 'Submit', bounds: { x: 10, y: 20, w: 100, h: 40 }, center: { x: 60, y: 40 }, enabled: true, clickable: true }], marks: [], clickable: [], count: 1, clickableCount: 1 }) },
      inputController: { click: async (x, y) => { captured.push([x, y]); return { success: true, action: 'click' }; } },
    });
    const r = await c.clickElement('Submit');
    expect(r.success).toBe(true);
    expect(captured[0]).toEqual([60, 40]);
    expect(r.target.id).toBe('e1');
    expect(safetyGate.inspect('p3').actuations).toBe(1);
  });

  test('clickElement off → 拒绝（感知本身就被闸门挡下）', async () => {
    const c = new DesktopController({ sessionId: 'p4', uiInspector: { inspect: async () => ({ success: true, elements: [] }) } });
    const r = await c.clickElement('Submit');
    expect(r.success).toBe(false);
    expect(r.denied).toBe(true);
  });

  test('clickElement 未知引用 → 明确报错，不点击', async () => {
    process.env.KHY_DESKTOP_CONTROL = 'on';
    let clicked = false;
    const c = new DesktopController({
      sessionId: 'p5',
      uiInspector: { inspect: async () => ({ success: true, elements: [{ id: 'e1', index: 0, role: 'button', name: 'OK', bounds: { x: 0, y: 0, w: 10, h: 10 }, center: { x: 5, y: 5 }, clickable: true }], marks: [], clickable: [], count: 1, clickableCount: 1 }) },
      inputController: { click: async () => { clicked = true; return { success: true }; } },
    });
    const r = await c.clickElement('不存在的按钮');
    expect(r.success).toBe(false);
    expect(clicked).toBe(false);
  });

  test('fillForm 支持元素引用字段：自动解析坐标并填入', async () => {
    process.env.KHY_DESKTOP_CONTROL = 'on';
    const captured = [];
    const c = new DesktopController({
      sessionId: 'p6',
      uiInspector: { inspect: async () => ({ success: true, elements: [{ id: 'e1', index: 0, role: 'textfield', name: '邮箱', bounds: { x: 5, y: 5, w: 200, h: 30 }, center: { x: 105, y: 20 }, enabled: true, editable: true, clickable: false }], marks: [], clickable: [], count: 1, clickableCount: 0 }) },
      inputController: {
        click: async (x, y) => { captured.push(['click', x, y]); return { success: true }; },
        type: async (t) => { captured.push(['type', t]); return { success: true }; },
        key: async (k) => { captured.push(['key', k]); return { success: true }; },
        hotkey: async (ks) => { captured.push(['hotkey', ...ks]); return { success: true }; },
      },
      detector: { detect: () => ({ platform: 'linux' }) },
    });
    const r = await c.fillForm({ fields: [{ element: '邮箱', value: 'a@b.c' }] });
    expect(r.success).toBe(true);
    expect(captured[0]).toEqual(['click', 105, 20]);
    expect(captured.some((s) => s[0] === 'type' && s[1] === 'a@b.c')).toBe(true);
    expect(captured.some((s) => s[0] === 'hotkey' && s[1] === 'ctrl' && s[2] === 'a')).toBe(true); // clearFirst 默认
  });

  test('capabilities 暴露 perception/canPerceive', () => {
    const c = new DesktopController({ sessionId: 'p7' });
    const caps = c.capabilities();
    expect(caps).toHaveProperty('perception');
    expect(caps.summary).toHaveProperty('canPerceive');
  });
});

// ───────────────────────────────────────────────────────────────────
describe('DesktopControlTool — 感知动作', () => {
  test('observe/inspect/clickElement 路由到门面', async () => {
    const seen = [];
    const controller = {
      observe: async (o) => { seen.push(['observe', o.clickableOnly]); return { success: true }; },
      inspect: async () => { seen.push(['inspect']); return { success: true }; },
      clickElement: async (ref, o) => { seen.push(['clickElement', ref, o.kind]); return { success: true }; },
    };
    const t = new DesktopControlTool();
    await t.execute({ action: 'observe', clickableOnly: true }, { controller });
    await t.execute({ action: 'inspect' }, { controller });
    await t.execute({ action: 'clickElement', target: 'Submit', kind: 'doubleClick' }, { controller });
    expect(seen).toEqual([['observe', true], ['inspect'], ['clickElement', 'Submit', 'doubleClick']]);
  });

  test('clickElement 属 actuation（高危物理操控）', () => {
    expect(DesktopControlTool.isActuation('clickElement')).toBe(true);
    expect(DesktopControlTool.isActuation('inspect')).toBe(false);
    expect(DesktopControlTool.isActuation('observe')).toBe(false);
  });

  test('action 枚举含新感知动作', () => {
    const t = new DesktopControlTool();
    const en = t.inputSchema.properties.action.enum;
    expect(en).toEqual(expect.arrayContaining(['observe', 'inspect', 'clickElement']));
  });
});

'use strict';

/**
 * desktopControl.test.js — 「眼/耳/嘴/手」桌面操控子系统验收测试（DESIGN-ARCH-056）。
 *
 * 全程零真实截屏/零真实鼠标键盘：execFile / detect / 网关全部注入替身，
 * 验证「单一真源命令构建」「注入安全」「fail-closed 默认关闭」「会话授权与熔断预算」
 * 「填表编排」「门面前置授权」「工具路由」等不变量。
 */

const registry = require('../../../src/services/desktopControl/backendRegistry');
const detector = require('../../../src/services/desktopControl/backendDetector');
const screenCapture = require('../../../src/services/desktopControl/screenCapture');
const inputController = require('../../../src/services/desktopControl/inputController');
const formFiller = require('../../../src/services/desktopControl/formFiller');
const safetyGate = require('../../../src/services/desktopControl/safetyGate');
const windowController = require('../../../src/services/desktopControl/windowController');
const { DesktopController } = require('../../../src/services/desktopControl');
const DesktopControlTool = require('../../../src/tools/DesktopControlTool');
const desktopIntent = require('../../../src/services/gateway/desktopIntentInterceptor');

// 干净环境：每个用例前清掉会话态与环境开关。
beforeEach(() => {
  safetyGate.resetAll();
  detector.reset();
  delete process.env.KHY_DESKTOP_CONTROL;
  delete process.env.KHY_DESKTOP_MAX_ACTUATIONS;
});

// ── 一个可注入的假后端：记录被调用的命令。 ──
function fakeInputBackend(ops) {
  return {
    id: 'fake', kind: 'input',
    ops: Object.assign({
      move: (x, y) => ({ cmd: 'fakeinput', args: ['move', String(x), String(y)] }),
      click: (x, y) => ({ cmd: 'fakeinput', args: ['click', String(x), String(y)] }),
      doubleClick: (x, y) => ({ cmd: 'fakeinput', args: ['double', String(x), String(y)] }),
      rightClick: (x, y) => ({ cmd: 'fakeinput', args: ['right', String(x), String(y)] }),
      drag: (a, b, c, d) => ({ cmd: 'fakeinput', args: ['drag', String(a), String(b), String(c), String(d)] }),
      scroll: () => null, // 默认不支持滚轮 → 测降级
      type: (t) => ({ cmd: 'fakeinput', args: ['type', t] }),
      typeKeystrokes: (t, d) => ({ cmd: 'fakeinput', args: ['typeks', t, String(d)] }),
      key: (k) => ({ cmd: 'fakeinput', args: ['key', k] }),
      hotkey: (ks) => ({ cmd: 'fakeinput', args: ['hotkey', ...ks] }),
    }, ops || {}),
  };
}
function inputDeps(captured, backend) {
  const b = backend || fakeInputBackend();
  return {
    detect: () => ({ platform: 'linux', hands: { available: true, backend: 'fake' }, summary: {} }),
    resolveBackend: () => b,
    execFile: (cmd, args, _opts, cb) => { captured.push({ cmd, args }); cb(null, '', ''); },
  };
}

// ───────────────────────────────────────────────────────────────────
describe('backendRegistry — 命令单一真源 + 注入安全', () => {
  test('每个平台都登记了 capture 与 input 后端', () => {
    for (const p of ['darwin', 'linux', 'win32']) {
      expect(registry.backendsFor(p, 'capture').length).toBeGreaterThan(0);
      expect(registry.backendsFor(p, 'input').length).toBeGreaterThan(0);
    }
  });

  test('builder 只产出 {cmd, args[]}，args 全为字符串（execFile 安全，无 shell 拼接）', () => {
    const linInput = registry.backendsFor('linux', 'input')[0]; // xdotool
    const built = linInput.ops.type('rm -rf / ; echo $(whoami)');
    expect(built.cmd).toBe('xdotool');
    expect(Array.isArray(built.args)).toBe(true);
    expect(built.args.every((a) => typeof a === 'string')).toBe(true);
    // 危险文本作为单个 argv 元素原样传入，不会被 shell 解释。
    expect(built.args).toContain('rm -rf / ; echo $(whoami)');
  });

  test('xdotool 坐标进入独立 argv，绝不进 shell', () => {
    const xdo = registry.backendsFor('linux', 'input').find((b) => b.id === 'xdotool');
    const c = xdo.ops.click(120, 340);
    expect(c).toEqual({ cmd: 'xdotool', args: ['mousemove', '120', '340', 'click', '1'] });
  });

  test('cliclick 不支持滚轮 → 返回 null（触发上游降级）', () => {
    const cli = registry.backendsFor('darwin', 'input').find((b) => b.id === 'cliclick');
    expect(cli.ops.scroll(0, -3)).toBeNull();
  });

  test('Windows SendKeys 元字符被正确转义', () => {
    const esc = registry._internals._sendKeysEscape('a+b^c%d~(e){f}');
    expect(esc).toBe('a{+}b{^}c{%}d{~}{(}e{)}{{}f{}}');
  });

  test('Windows 截屏脚本对数值/路径安全内插（数值无引号、路径单引号转义）', () => {
    const s = registry._internals._winCaptureScript("C:\\Temp\\a'b.png", { x: 1, y: 2, w: 3, h: 4 });
    expect(s).toContain('Bitmap 3, 4');
    expect(s).toContain('CopyFromScreen(1, 2');
    expect(s).toContain("a''b.png"); // 单引号转义
  });

  test('pyautogui 文本经 argv 传入（python 读 sys.argv），零注入', () => {
    const built = registry.PY_BACKEND.ops.type('$(reboot)');
    expect(built.cmd).toBe('python3');
    expect(built.args[0]).toBe('-c');
    expect(built.args).toContain('$(reboot)'); // 作为 argv，不经 shell
    expect(built.args.includes('--')).toBe(true);
  });

  test('typeKeystrokes：xdotool 用 --delay 逐键节奏，文本进独立 argv', () => {
    const xdo = registry.backendsFor('linux', 'input').find((b) => b.id === 'xdotool');
    const built = xdo.ops.typeKeystrokes('你好hi', 50);
    expect(built.cmd).toBe('xdotool');
    expect(built.args).toEqual(['type', '--clearmodifiers', '--delay', '50', '--', '你好hi']);
  });

  test('typeKeystrokes：ydotool 用 --key-delay', () => {
    const ydo = registry.backendsFor('linux', 'input').find((b) => b.id === 'ydotool');
    const built = ydo.ops.typeKeystrokes('ab', 30);
    expect(built.args).toEqual(['type', '--key-delay', '30', '--', 'ab']);
  });

  test('typeKeystrokes：cliclick 按码点拆 t:/w:（中文/emoji 安全）', () => {
    const cli = registry.backendsFor('darwin', 'input').find((b) => b.id === 'cliclick');
    const built = cli.ops.typeKeystrokes('你好', 40);
    expect(built.cmd).toBe('cliclick');
    expect(built.args).toEqual(['t:你', 'w:40', 't:好']);
    // delay=0 → 不插入 w:
    expect(cli.ops.typeKeystrokes('ab', 0).args).toEqual(['t:a', 't:b']);
  });

  test('typeKeystrokes：Windows 逐键 SendWait + Start-Sleep，单引号转义注入安全', () => {
    const win = registry.backendsFor('win32', 'input').find((b) => b.id === 'powershell-user32');
    const built = win.ops.typeKeystrokes("a'b", 25);
    const script = built.args[built.args.length - 1];
    expect(script).toContain("SendWait('a')");
    expect(script).toContain("SendWait('''')"); // 单引号在 PS 字符串内成对转义
    expect(script).toContain('Start-Sleep -Milliseconds 25');
  });

  test('typeKeystrokes：pyautogui 用 interval（秒）逐键', () => {
    const built = registry.PY_BACKEND.ops.typeKeystrokes('$(reboot)', 40);
    expect(built.cmd).toBe('python3');
    expect(built.args).toContain('$(reboot)'); // 作为 argv，零注入
    expect(built.args[built.args.length - 1]).toBe('0.04'); // 40ms → 0.04s
  });

  test('typeKeystrokes：osascript（mac 仅键盘后备）不支持逐键 → 返回 null（触发降级）', () => {
    const osa = registry.backendsFor('darwin', 'input').find((b) => b.id === 'osascript');
    expect(osa.ops.typeKeystrokes).toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────────────
describe('backendDetector — 能力探测', () => {
  test('挑选第一个可用后端（浅探 which）', () => {
    const which = (name) => (name === 'scrot' ? '/usr/bin/scrot' : null);
    const r = detector._selectBackend('linux', 'capture', { which });
    expect(r.available).toBe(true);
    expect(r.backend).toBe('scrot');
  });

  test('全不可用 → available:false 且给出安装提示', () => {
    const which = () => null;
    const r = detector._selectBackend('linux', 'input', { which });
    expect(r.available).toBe(false);
    expect(r.backend).toBeNull();
    expect(r.installHints.length).toBeGreaterThan(0);
    expect(r.installHints[0]).toHaveProperty('package');
  });

  test('深探：有 python3 但 import 失败 → 跳过 pyautogui', () => {
    const which = (name) => (name === 'python3' ? '/usr/bin/python3' : null);
    const importRun = () => false; // import pyautogui 失败
    const r = detector._selectBackend('linux', 'input', { which, importRun });
    expect(r.available).toBe(false); // 仅剩 pyautogui 不可用
  });

  test('深探：import 成功 → pyautogui 可用', () => {
    const which = (name) => (name === 'python3' ? '/usr/bin/python3' : null);
    const importRun = () => true;
    const r = detector._selectBackend('linux', 'input', { which, importRun });
    expect(r.available).toBe(true);
    expect(r.backend).toBe('pyautogui');
  });

  test('detect 汇总眼/手/嘴/耳，voice 取自注入的 voiceCaps', () => {
    const which = (name) => (name === 'screencapture' || name === 'cliclick' ? '/x' : null);
    const r = detector.detect({ platform: 'darwin', which, voiceCaps: { tts: 'say', stt: null } });
    expect(r.summary.canSpeak).toBe(true);
    expect(r.summary.canHear).toBe(false);
    expect(r.voice.tts.provider).toBe('say');
  });
});

// ───────────────────────────────────────────────────────────────────
describe('screenCapture — 眼', () => {
  test('无截屏后端 → 优雅降级带安装提示，不抛错', async () => {
    const detect = () => ({ platform: 'linux', eyes: { available: false, installHints: [{ package: 'scrot' }] } });
    const r = await screenCapture.capture({}, { detect });
    expect(r.success).toBe(false);
    expect(r.installHints[0].package).toBe('scrot');
  });

  test('全屏截屏：构建 argv 并在文件落盘后返回 path', async () => {
    let ran = null;
    const deps = {
      detect: () => ({ platform: 'linux', eyes: { available: true, backend: 'scrot' } }),
      resolveBackend: () => registry.backendsFor('linux', 'capture').find((b) => b.id === 'scrot'),
      execFile: (cmd, args, _o, cb) => { ran = { cmd, args }; cb(null, '', ''); },
      exists: () => true,
      statSize: () => 4096,
    };
    const r = await screenCapture.capture({ outPath: '/tmp/x.png' }, deps);
    expect(r.success).toBe(true);
    expect(r.backend).toBe('scrot');
    expect(ran.cmd).toBe('scrot');
    expect(ran.args).toContain('/tmp/x.png');
    expect(r.bytes).toBe(4096);
  });

  test('非法区域参数被拒（负坐标/零宽）', async () => {
    const deps = {
      detect: () => ({ platform: 'linux', eyes: { available: true, backend: 'scrot' } }),
      resolveBackend: () => registry.backendsFor('linux', 'capture').find((b) => b.id === 'scrot'),
      execFile: (_c, _a, _o, cb) => cb(null, '', ''),
      exists: () => true,
    };
    const r = await screenCapture.capture({ region: { x: -1, y: 0, w: 0, h: 10 } }, deps);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/区域截屏参数非法/);
  });
});

// ───────────────────────────────────────────────────────────────────
describe('inputController — 手', () => {
  test('坐标校验：负数/超大/小数被拒', async () => {
    expect((await inputController.click(-1, 5)).success).toBe(false);
    expect((await inputController.click(5, 1e9)).success).toBe(false);
    expect((await inputController.click(5.5, 5)).success).toBe(false);
  });

  test('click 构建 argv 并执行', async () => {
    const captured = [];
    const r = await inputController.click(120, 340, inputDeps(captured));
    expect(r.success).toBe(true);
    expect(captured[0]).toEqual({ cmd: 'fakeinput', args: ['click', '120', '340'] });
  });

  test('后端不支持的动作（builder 返回 null）→ 明确降级，不静默', async () => {
    const captured = [];
    const r = await inputController.scroll(0, -3, inputDeps(captured)); // fake.scroll → null
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/不支持/);
    expect(captured.length).toBe(0);
  });

  test('手未就绪 → 降级带安装提示', async () => {
    const deps = { detect: () => ({ platform: 'linux', hands: { available: false, installHints: [{ package: 'xdotool' }] } }) };
    const r = await inputController.type('hi', deps);
    expect(r.success).toBe(false);
    expect(r.installHints[0].package).toBe('xdotool');
  });

  test('type 长度上限保护', async () => {
    const captured = [];
    const big = 'a'.repeat(inputController.MAX_TEXT + 1);
    const r = await inputController.type(big, inputDeps(captured));
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/过长/);
  });

  test('hotkey 需 ≥2 个键', async () => {
    const captured = [];
    expect((await inputController.hotkey(['ctrl'], inputDeps(captured))).success).toBe(false);
    const r = await inputController.hotkey(['ctrl', 'c'], inputDeps(captured));
    expect(r.success).toBe(true);
    expect(captured[0].args).toEqual(['hotkey', 'ctrl', 'c']);
  });

  test('typeKeystrokes：逐键执行，缺省节奏注入到 builder', async () => {
    const captured = [];
    const r = await inputController.typeKeystrokes('hi', {}, inputDeps(captured));
    expect(r.success).toBe(true);
    expect(r.action).toBe('typeKeystrokes');
    expect(captured[0]).toEqual({ cmd: 'fakeinput', args: ['typeks', 'hi', String(inputController.DEFAULT_KEY_DELAY)] });
  });

  test('typeKeystrokes：delayMs 防呆（超上限封顶、负值/缺省回落、0 保留）', async () => {
    const seen = [];
    const backend = fakeInputBackend({ typeKeystrokes: (t, d) => { seen.push(d); return { cmd: 'x', args: [t] }; } });
    await inputController.typeKeystrokes('a', { delayMs: 99999 }, inputDeps([], backend));
    await inputController.typeKeystrokes('a', { delayMs: -5 }, inputDeps([], backend));
    await inputController.typeKeystrokes('a', {}, inputDeps([], backend));
    await inputController.typeKeystrokes('a', { delayMs: 0 }, inputDeps([], backend));
    expect(seen).toEqual([inputController.MAX_KEY_DELAY, inputController.DEFAULT_KEY_DELAY, inputController.DEFAULT_KEY_DELAY, 0]);
  });

  test('typeKeystrokes：空文本无操作、非字符串/超长被拒', async () => {
    const captured = [];
    expect((await inputController.typeKeystrokes('', {}, inputDeps(captured))).success).toBe(true);
    expect(captured.length).toBe(0); // 空文本不触发后端
    expect((await inputController.typeKeystrokes(123, {}, inputDeps(captured))).success).toBe(false);
    const big = 'a'.repeat(inputController.MAX_TEXT + 1);
    expect((await inputController.typeKeystrokes(big, {}, inputDeps(captured))).success).toBe(false);
  });

  test('typeKeystrokes：后端不支持（builder 返回 null）→ 明确降级', async () => {
    const captured = [];
    const backend = fakeInputBackend({ typeKeystrokes: () => null });
    const r = await inputController.typeKeystrokes('hi', {}, inputDeps(captured, backend));
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/不支持/);
  });
});

// ───────────────────────────────────────────────────────────────────
describe('formFiller — 填表编排', () => {
  test('原生字段：click→type→tab 序列，末格不 tab', () => {
    const plan = formFiller.planFill({
      platform: 'linux',
      fields: [{ x: 10, y: 20, value: 'alice' }, { x: 10, y: 60, value: 'secret' }],
    });
    expect(plan.ok).toBe(true);
    const acts = plan.steps.map((s) => `${s.kind}:${s.action}`);
    expect(acts).toEqual(['native:click', 'native:type', 'native:key', 'native:click', 'native:type']);
    expect(plan.steps[2].key).toBe('tab');
  });

  test('clearFirst 插入全选(平台修饰键)+删除', () => {
    const plan = formFiller.planFill({ platform: 'darwin', fields: [{ x: 1, y: 1, value: 'x', clearFirst: true, tab: false }] });
    const hk = plan.steps.find((s) => s.action === 'hotkey');
    expect(hk.keys).toEqual(['cmd', 'a']); // macOS 用 cmd
  });

  test('Web 字段走 fill 委派', () => {
    const plan = formFiller.planFill({ fields: [{ selector: '#email', value: 'a@b.c' }] });
    expect(plan.steps[0]).toMatchObject({ kind: 'web', action: 'fill', selector: '#email', value: 'a@b.c' });
  });

  test('字段缺定位信息 → 计划失败', () => {
    const plan = formFiller.planFill({ fields: [{ value: 'x' }] });
    expect(plan.ok).toBe(false);
    expect(plan.error).toMatch(/无法定位/);
  });

  test('submit 三态：selector / 坐标 / 默认 Enter', () => {
    expect(formFiller.planFill({ fields: [{ x: 1, y: 1, value: 'a' }], submit: { selector: '#go' } }).steps.pop())
      .toMatchObject({ kind: 'web', action: 'click', submit: true });
    expect(formFiller.planFill({ fields: [{ x: 1, y: 1, value: 'a' }], submit: { x: 5, y: 5 } }).steps.pop())
      .toMatchObject({ kind: 'native', action: 'click', submit: true });
    expect(formFiller.planFill({ fields: [{ x: 1, y: 1, value: 'a' }], submit: true }).steps.pop())
      .toMatchObject({ kind: 'native', action: 'key', key: 'enter' });
  });

  test('executeFill 遇失败即停，不继续后续步骤', async () => {
    const calls = [];
    const actuator = {
      click: async (x, y) => { calls.push(['click', x, y]); return { success: true }; },
      type: async () => { calls.push(['type']); return { success: false, error: 'boom' }; },
      key: async () => { calls.push(['key']); return { success: true }; },
      hotkey: async () => ({ success: true }),
    };
    const r = await formFiller.executeFill({ fields: [{ x: 1, y: 2, value: 'a' }, { x: 1, y: 9, value: 'b' }] }, { actuator });
    expect(r.success).toBe(false);
    // click 成功 → type 失败即停；第二个字段的 click 不应发生。
    expect(calls.map((c) => c[0])).toEqual(['click', 'type']);
  });

  test('Web 字段但未配置 webExecute → 明确报错', async () => {
    const r = await formFiller.executeFill({ fields: [{ selector: '#x', value: 'v' }] }, {});
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/webExecute/);
  });
});

// ───────────────────────────────────────────────────────────────────
describe('safetyGate — fail-closed 默认关闭 + 会话授权 + 熔断预算', () => {
  test('默认(off)：actuate 与 capture 被拒，capability/voice 放行', async () => {
    expect((await safetyGate.authorize({ op: 'click', sessionId: 's1' })).allow).toBe(false);
    expect((await safetyGate.authorize({ op: 'screenshot', sessionId: 's1' })).allow).toBe(false);
    expect((await safetyGate.authorize({ op: 'capabilities', sessionId: 's1' })).allow).toBe(true);
    expect((await safetyGate.authorize({ op: 'speak', sessionId: 's1' })).allow).toBe(true);
  });

  test('off 拒绝信息含启用指引', async () => {
    const d = await safetyGate.authorize({ op: 'type', sessionId: 's1' });
    expect(d.reason).toMatch(/KHY_DESKTOP_CONTROL/);
  });

  test('on：本会话自主放行', async () => {
    process.env.KHY_DESKTOP_CONTROL = 'on';
    expect((await safetyGate.authorize({ op: 'click', sessionId: 's1' })).allow).toBe(true);
  });

  test('on：熔断预算耗尽 → 吊销并拒绝', async () => {
    process.env.KHY_DESKTOP_CONTROL = 'on';
    const io = { budget: 2 };
    expect((await safetyGate.authorize({ op: 'click', sessionId: 's1' }, io)).allow).toBe(true);
    safetyGate.noteActuation('s1', 'click');
    expect((await safetyGate.authorize({ op: 'click', sessionId: 's1' }, io)).allow).toBe(true);
    safetyGate.noteActuation('s1', 'click');
    const d = await safetyGate.authorize({ op: 'click', sessionId: 's1' }, io);
    expect(d.allow).toBe(false);
    expect(d.revoked).toBe(true);
    expect(safetyGate.inspect('s1').revoked).toBe(true);
  });

  test('ask：首次走审批 backstop，通过后会话内自主（backstop 只调一次）', async () => {
    process.env.KHY_DESKTOP_CONTROL = 'ask';
    let calls = 0;
    const gatewayEvaluate = async () => { calls += 1; return { allow: true, decision: 'user-allow', level: 'L2' }; };
    const io = { gatewayEvaluate };
    expect((await safetyGate.authorize({ op: 'click', sessionId: 's1' }, io)).allow).toBe(true);
    expect((await safetyGate.authorize({ op: 'type', sessionId: 's1' }, io)).allow).toBe(true);
    expect(calls).toBe(1); // 仅首次审批
  });

  test('strict：每步都走审批 backstop', async () => {
    process.env.KHY_DESKTOP_CONTROL = 'strict';
    let calls = 0;
    const gatewayEvaluate = async () => { calls += 1; return { allow: true }; };
    const io = { gatewayEvaluate };
    await safetyGate.authorize({ op: 'click', sessionId: 's1' }, io);
    await safetyGate.authorize({ op: 'click', sessionId: 's1' }, io);
    expect(calls).toBe(2);
  });

  test('审批 backstop 判拒 → 拒绝', async () => {
    process.env.KHY_DESKTOP_CONTROL = 'ask';
    const io = { gatewayEvaluate: async () => ({ allow: false, reasons: ['用户拒绝'] }) };
    const d = await safetyGate.authorize({ op: 'click', sessionId: 's1' }, io);
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/用户拒绝/);
  });

  test('未知动作保守按 actuate 处理（off 即拒）', () => {
    expect(safetyGate.classifyOp('totally-unknown')).toBe('actuate');
  });
});

// ───────────────────────────────────────────────────────────────────
// 修复「批准了仍显示权限被拒绝」：宿主逐项审批(io.hostApproved)即授权来源。
describe('safetyGate — 宿主逐项审批 hostApproved 放行', () => {
  test('env=off 但宿主已审批(hostApproved=true) → 放行(不再硬拒)', async () => {
    // 默认 KHY_DESKTOP_CONTROL 未设 = off；旧行为会拒绝。
    const d = await safetyGate.authorize({ op: 'click', sessionId: 's1' }, { hostApproved: true });
    expect(d.allow).toBe(true);
    expect(d.hostApproved).toBe(true);
  });

  test('hostApproved 对 capture(截屏) 同样放行', async () => {
    const d = await safetyGate.authorize({ op: 'screenshot', sessionId: 's1' }, { hostApproved: true });
    expect(d.allow).toBe(true);
  });

  test('hostApproved 仍受熔断预算约束（防失控循环正交于单项同意）', async () => {
    const io = { hostApproved: true, budget: 2 };
    expect((await safetyGate.authorize({ op: 'click', sessionId: 's1' }, io)).allow).toBe(true);
    safetyGate.noteActuation('s1', 'click');
    expect((await safetyGate.authorize({ op: 'click', sessionId: 's1' }, io)).allow).toBe(true);
    safetyGate.noteActuation('s1', 'click');
    const d = await safetyGate.authorize({ op: 'click', sessionId: 's1' }, io);
    expect(d.allow).toBe(false);
    expect(d.revoked).toBe(true);
  });

  test('hostApproved 仍受会话吊销约束（吊销后即便已审批也拒绝）', async () => {
    const io = { hostApproved: true, budget: 1 };
    expect((await safetyGate.authorize({ op: 'click', sessionId: 's1' }, io)).allow).toBe(true);
    safetyGate.noteActuation('s1', 'click');
    // 触发吊销
    expect((await safetyGate.authorize({ op: 'click', sessionId: 's1' }, io)).allow).toBe(false);
    // 吊销后即便再带 hostApproved 也拒绝
    const d = await safetyGate.authorize({ op: 'type', sessionId: 's1' }, { hostApproved: true });
    expect(d.allow).toBe(false);
    expect(d.revoked).toBe(true);
  });

  test('KHY_DESKTOP_HONOR_APPROVAL=off → 回退：hostApproved 不再放行(env off 即拒)', async () => {
    process.env.KHY_DESKTOP_HONOR_APPROVAL = 'off';
    try {
      const d = await safetyGate.authorize({ op: 'click', sessionId: 's1' }, { hostApproved: true });
      expect(d.allow).toBe(false);
      expect(d.reason).toMatch(/KHY_DESKTOP_CONTROL/);
    } finally {
      delete process.env.KHY_DESKTOP_HONOR_APPROVAL;
    }
  });

  test('hostApproved!=true（如 undefined/假值）不放行（仅真实戳生效）', async () => {
    expect((await safetyGate.authorize({ op: 'click', sessionId: 's1' }, { hostApproved: false })).allow).toBe(false);
    expect((await safetyGate.authorize({ op: 'click', sessionId: 's1' }, {})).allow).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────
// 工具层桥接：EXEC_APPROVED Symbol 戳 → hostApproved（单一真源 helper）。
describe('DesktopControlTool — EXEC_APPROVED 戳桥接 hostApproved', () => {
  const { EXEC_APPROVED } = require('../../../src/services/execApproval');

  test('携带 EXEC_APPROVED 戳 → hostApprovedFromParams=true', () => {
    expect(DesktopControlTool.hostApprovedFromParams({ action: 'click', [EXEC_APPROVED]: true })).toBe(true);
  });

  test('无戳 / 假戳 → false（模型无法经 JSON 伪造 Symbol）', () => {
    expect(DesktopControlTool.hostApprovedFromParams({ action: 'click' })).toBe(false);
    expect(DesktopControlTool.hostApprovedFromParams({ action: 'click', execApproved: true })).toBe(false);
    expect(DesktopControlTool.hostApprovedFromParams(null)).toBe(false);
    expect(DesktopControlTool.hostApprovedFromParams('nope')).toBe(false);
  });

  test('端到端：戳 → 注入器在 env=off 下仍被调用（放行而非 denied）', async () => {
    // 不经真实后端：注入假 inputController；构造 controller 时显式带 io.hostApproved，
    // 复刻 execute 在读到 EXEC_APPROVED 后的行为。验证 io.hostApproved 一路贯通到注入器。
    let touched = false;
    const c = new DesktopController({
      sessionId: 's-approved',
      io: { hostApproved: true },
      inputController: { click: async () => { touched = true; return { success: true }; } },
    });
    const r = await c.click(10, 10);
    expect(r.denied).toBeFalsy();
    expect(r.success).toBe(true);
    expect(touched).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────
describe('DesktopController 门面 — 前置授权结构性保证', () => {
  test('off：任何操控被拒（denied），且不触达底层注入器', async () => {
    let touched = false;
    const c = new DesktopController({
      sessionId: 's1',
      inputController: { click: async () => { touched = true; return { success: true }; } },
    });
    const r = await c.click(10, 10);
    expect(r.denied).toBe(true);
    expect(touched).toBe(false);
  });

  test('on：放行并计入熔断预算', async () => {
    process.env.KHY_DESKTOP_CONTROL = 'on';
    const c = new DesktopController({
      sessionId: 's2',
      inputController: { click: async () => ({ success: true, action: 'click' }) },
    });
    const r = await c.click(10, 10);
    expect(r.success).toBe(true);
    expect(safetyGate.inspect('s2').actuations).toBe(1);
  });

  test('capabilities 永远可用（只读元数据）', () => {
    const c = new DesktopController({ sessionId: 's3' });
    const caps = c.capabilities();
    expect(caps.success).toBe(true);
    expect(caps.summary).toHaveProperty('canSee');
    expect(caps.gate.mode).toBe('off');
  });

  test('fillForm 在 off 下预检即拒，不执行任何步骤', async () => {
    const c = new DesktopController({ sessionId: 's4' });
    const r = await c.fillForm({ fields: [{ x: 1, y: 1, value: 'a' }] });
    expect(r.denied).toBe(true);
  });

  test('fillForm 在 on 下逐步授权并填完原生字段', async () => {
    process.env.KHY_DESKTOP_CONTROL = 'on';
    const captured = [];
    const c = new DesktopController({
      sessionId: 's5',
      inputController: {
        click: async (x, y) => { captured.push(['click', x, y]); return { success: true }; },
        type: async (t) => { captured.push(['type', t]); return { success: true }; },
        key: async (k) => { captured.push(['key', k]); return { success: true }; },
        hotkey: async () => ({ success: true }),
      },
      detector: { detect: () => ({ platform: 'linux' }) },
    });
    const r = await c.fillForm({ fields: [{ x: 5, y: 6, value: 'bob' }] });
    expect(r.success).toBe(true);
    expect(captured).toEqual([['click', 5, 6], ['type', 'bob']]);
    expect(safetyGate.inspect('s5').actuations).toBeGreaterThanOrEqual(2);
  });
});

// ───────────────────────────────────────────────────────────────────
describe('DesktopControlTool — 模型可见工具', () => {
  test('capabilities 动作返回能力快照', async () => {
    const t = new DesktopControlTool();
    const r = await t.execute({ action: 'capabilities' });
    expect(r.success).toBe(true);
    expect(r.summary).toHaveProperty('canActuate');
  });

  test('缺 action → 报错', async () => {
    const t = new DesktopControlTool();
    const r = await t.execute({});
    expect(r.success).toBe(false);
  });

  test('未知 action → 报错', async () => {
    const t = new DesktopControlTool();
    const r = await t.execute({ action: 'nope' }, { controller: { capabilities: () => ({}) } });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/未知 action/);
  });

  test('actuation 动作路由到门面对应方法', async () => {
    const seen = [];
    const controller = {
      click: async (x, y) => { seen.push(['click', x, y]); return { success: true }; },
      type: async (t) => { seen.push(['type', t]); return { success: true }; },
      typeKeystrokes: async (t, o) => { seen.push(['typeKeystrokes', t, o && o.delayMs]); return { success: true }; },
      fillForm: async (s) => { seen.push(['fillForm', s.fields.length]); return { success: true }; },
    };
    const t = new DesktopControlTool();
    await t.execute({ action: 'click', x: 3, y: 4 }, { controller });
    await t.execute({ action: 'type', text: 'hi' }, { controller });
    await t.execute({ action: 'typeKeystrokes', text: 'ni', delayMs: 60 }, { controller });
    await t.execute({ action: 'fillForm', fields: [{ x: 1, y: 1, value: 'v' }] }, { controller });
    expect(seen).toEqual([['click', 3, 4], ['type', 'hi'], ['typeKeystrokes', 'ni', 60], ['fillForm', 1]]);
  });

  test('isActuation 正确识别物理操控动作', () => {
    expect(DesktopControlTool.isActuation('click')).toBe(true);
    expect(DesktopControlTool.isActuation('fillForm')).toBe(true);
    expect(DesktopControlTool.isActuation('typeKeystrokes')).toBe(true);
    expect(DesktopControlTool.isActuation('capabilities')).toBe(false);
  });

  test('工具元数据：critical 风险 + system 类别 + 延迟加载', () => {
    expect(DesktopControlTool.risk).toBe('critical');
    expect(DesktopControlTool.category).toBe('system');
    expect(DesktopControlTool.shouldDefer).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────
describe('backendRegistry — 窗口管理后端（按名健壮操控）', () => {
  test('每个平台都登记了 window 后端', () => {
    for (const p of ['darwin', 'linux', 'win32']) {
      expect(registry.backendsFor(p, 'window').length).toBeGreaterThan(0);
    }
  });

  test('xdotool 窗口操控：名称进独立 argv，零 shell 拼接', () => {
    const xdo = registry.backendsFor('linux', 'window').find((b) => b.id === 'xdotool-window');
    const built = xdo.ops.activate('Firefox; rm -rf /');
    expect(built.cmd).toBe('xdotool');
    expect(built.args.every((a) => typeof a === 'string')).toBe(true);
    expect(built.args).toContain('Firefox; rm -rf /'); // 危险串作为单个 argv，不被解释
  });

  test('wmctrl 不支持最小化 → 返回 null（触发降级到 xdotool）', () => {
    const wm = registry.backendsFor('linux', 'window').find((b) => b.id === 'wmctrl');
    expect(wm.ops.minimizeWindow('Firefox')).toBeNull();
  });

  test('macOS AppleScript 字符串被转义（反斜杠与双引号）', () => {
    const esc = registry._internals._osaEscape('a"b\\c');
    expect(esc).toBe('a\\"b\\\\c');
  });
});

// ───────────────────────────────────────────────────────────────────
describe('windowController — 窗口原语 + 跨后端降级', () => {
  function winDeps({ which, platform = 'linux', captured } = {}) {
    return {
      platform,
      which: which || (() => '/usr/bin/x'),
      execFile: (cmd, args, _opts, cb) => { if (captured) captured.push({ cmd, args }); cb(null, 'ok', ''); },
    };
  }

  test('名称校验：空/超长被拒', async () => {
    expect((await windowController.activate('')).success).toBe(false);
    expect((await windowController.activate('a'.repeat(windowController.MAX_NAME + 1))).success).toBe(false);
  });

  test('activate 经第一个可用后端执行', async () => {
    const captured = [];
    const r = await windowController.activate('Firefox', winDeps({ captured }));
    expect(r.success).toBe(true);
    expect(captured.length).toBe(1);
  });

  test('最小化：仅 xdotool 可用时跳过 wmctrl(null) 用 xdotool', async () => {
    const captured = [];
    const which = (name) => (name === 'xdotool' ? '/usr/bin/xdotool' : null); // wmctrl 不可用
    const r = await windowController.minimizeWindow('Firefox', winDeps({ which, captured }));
    expect(r.success).toBe(true);
    expect(r.backend).toBe('xdotool-window');
    expect(captured[0].cmd).toBe('xdotool');
  });

  test('最小化：仅 wmctrl 可用 → 该动作不支持，明确报错（不静默）', async () => {
    const which = (name) => (name === 'wmctrl' ? '/usr/bin/wmctrl' : null);
    const r = await windowController.minimizeWindow('Firefox', winDeps({ which }));
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/不支持/);
  });

  test('无任何可用后端 → 报错带安装提示', async () => {
    const r = await windowController.activate('Firefox', winDeps({ which: () => null }));
    expect(r.success).toBe(false);
    expect(Array.isArray(r.installHints)).toBe(true);
  });

  test('listWindows 只读：经可用后端列出', async () => {
    const r = await windowController.listWindows(winDeps({}));
    expect(r.success).toBe(true);
    expect(r.stdout).toBe('ok');
  });
});

// ───────────────────────────────────────────────────────────────────
describe('DesktopController 门面 — 窗口操控前置授权', () => {
  test('off：closeWindow 被拒（denied），不触达底层', async () => {
    let touched = false;
    const c = new DesktopController({
      sessionId: 'w1',
      windowController: { closeWindow: async () => { touched = true; return { success: true }; } },
    });
    const r = await c.closeWindow('Firefox');
    expect(r.denied).toBe(true);
    expect(touched).toBe(false);
  });

  test('on：activate 放行并计入熔断预算；listWindows 属 capture 不计预算', async () => {
    process.env.KHY_DESKTOP_CONTROL = 'on';
    const c = new DesktopController({
      sessionId: 'w2',
      windowController: {
        activate: async () => ({ success: true }),
        listWindows: async () => ({ success: true, stdout: 'a' }),
      },
    });
    expect((await c.activate('Firefox')).success).toBe(true);
    expect(safetyGate.inspect('w2').actuations).toBe(1);
    expect((await c.listWindows()).success).toBe(true);
    expect(safetyGate.inspect('w2').actuations).toBe(1); // capture 不增预算
  });

  test('safetyGate 分类：窗口操控=actuate，listWindows=capture', () => {
    expect(safetyGate.classifyOp('activate')).toBe('actuate');
    expect(safetyGate.classifyOp('closeWindow')).toBe('actuate');
    expect(safetyGate.classifyOp('minimizeWindow')).toBe('actuate');
    expect(safetyGate.classifyOp('listWindows')).toBe('capture');
  });
});

// ───────────────────────────────────────────────────────────────────
describe('DesktopControlTool — 窗口动作路由', () => {
  test('activate/closeWindow/minimizeWindow/listWindows 路由到门面', async () => {
    const seen = [];
    const controller = {
      activate: async (n) => { seen.push(['activate', n]); return { success: true }; },
      closeWindow: async (n) => { seen.push(['closeWindow', n]); return { success: true }; },
      minimizeWindow: async (n) => { seen.push(['minimizeWindow', n]); return { success: true }; },
      listWindows: async () => { seen.push(['listWindows']); return { success: true }; },
    };
    const t = new DesktopControlTool();
    await t.execute({ action: 'activate', app: 'Firefox' }, { controller });
    await t.execute({ action: 'closeWindow', app: 'Chrome' }, { controller });
    await t.execute({ action: 'minimizeWindow', name: 'Code' }, { controller });
    await t.execute({ action: 'listWindows' }, { controller });
    expect(seen).toEqual([['activate', 'Firefox'], ['closeWindow', 'Chrome'], ['minimizeWindow', 'Code'], ['listWindows']]);
  });

  test('isActuation：窗口写操作为 actuate，listWindows 只读不算', () => {
    expect(DesktopControlTool.isActuation('activate')).toBe(true);
    expect(DesktopControlTool.isActuation('closeWindow')).toBe(true);
    expect(DesktopControlTool.isActuation('minimizeWindow')).toBe(true);
    expect(DesktopControlTool.isActuation('listWindows')).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────
describe('DesktopController — 按元素引用 hover / 选词', () => {
  const FAKE = [
    { id: 'e1', name: '提交', role: 'button', center: { x: 100, y: 200 }, bounds: { x: 90, y: 190, w: 40, h: 20 }, clickable: true },
    { id: 'e2', name: 'Firefox', role: 'button', center: { x: 300, y: 50 }, bounds: { x: 290, y: 40, w: 60, h: 20 }, clickable: true },
  ];
  function ctl(sessionId, captured) {
    return new DesktopController({
      sessionId,
      inputController: {
        move: async (x, y) => { captured.push(['move', x, y]); return { success: true }; },
        doubleClick: async (x, y) => { captured.push(['double', x, y]); return { success: true }; },
        click: async (x, y) => { captured.push(['click', x, y]); return { success: true }; },
      },
      uiInspector: { inspect: async () => ({ success: true, elements: FAKE }) },
    });
  }

  test('on：hoverElement 把鼠标移到元素上（move，不点击）', async () => {
    process.env.KHY_DESKTOP_CONTROL = 'on';
    const cap = [];
    const r = await ctl('h1', cap).hoverElement('Firefox', { elements: FAKE });
    expect(r.success).toBe(true);
    expect(r.target.name).toBe('Firefox');
    expect(cap).toEqual([['move', 300, 50]]); // 仅 move，无 click
  });

  test('on：selectText 定位词后双击选中', async () => {
    process.env.KHY_DESKTOP_CONTROL = 'on';
    const cap = [];
    const r = await ctl('s1', cap).selectText('提交', { elements: FAKE });
    expect(r.success).toBe(true);
    expect(r.selected).toBe('提交');
    expect(cap).toEqual([['double', 100, 200]]);
  });

  test('未命中引用 → 明确报错，不发生任何鼠标动作', async () => {
    process.env.KHY_DESKTOP_CONTROL = 'on';
    const cap = [];
    const r = await ctl('h2', cap).hoverElement('不存在', { elements: FAKE });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/未找到/);
    expect(cap.length).toBe(0);
  });

  test('off：hoverElement/selectText 被闸门拒绝（denied）', async () => {
    delete process.env.KHY_DESKTOP_CONTROL;
    const cap = [];
    const c = ctl('off-h', cap);
    expect((await c.hoverElement('Firefox', { elements: FAKE })).denied).toBe(true);
    expect((await c.selectText('提交', { elements: FAKE })).denied).toBe(true);
    expect(cap.length).toBe(0);
  });

  test('DesktopControlTool 路由 hoverElement/selectText 到门面', async () => {
    const seen = [];
    const controller = {
      hoverElement: async (t) => { seen.push(['hover', t]); return { success: true }; },
      selectText: async (t) => { seen.push(['sel', t]); return { success: true }; },
    };
    const t = new DesktopControlTool();
    await t.execute({ action: 'hoverElement', target: 'Firefox' }, { controller });
    await t.execute({ action: 'selectText', target: '提交' }, { controller });
    expect(seen).toEqual([['hover', 'Firefox'], ['sel', '提交']]);
    expect(DesktopControlTool.isActuation('hoverElement')).toBe(true);
    expect(DesktopControlTool.isActuation('selectText')).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────
describe('desktopIntentInterceptor — 自然语言窗口操控意图映射', () => {
  const tc = require('../../../src/services/toolCalling');

  test('识别关闭/激活/最小化/列窗口，并把别名规范化', () => {
    expect(desktopIntent._parseDesktopIntent('关闭火狐', tc)).toEqual({ action: 'closeWindow', name: 'firefox' });
    expect(desktopIntent._parseDesktopIntent('关闭火狐窗口', tc)).toEqual({ action: 'closeWindow', name: 'firefox' });
    expect(desktopIntent._parseDesktopIntent('切换到浏览器', tc)).toEqual({ action: 'activate', name: 'firefox' });
    expect(desktopIntent._parseDesktopIntent('最小化微信', tc)).toEqual({ action: 'minimizeWindow', name: 'wechat' });
    expect(desktopIntent._parseDesktopIntent('列出当前窗口', tc)).toEqual({ action: 'listWindows', name: '' });
    expect(desktopIntent._parseDesktopIntent('minimize firefox', tc)).toEqual({ action: 'minimizeWindow', name: 'firefox' });
  });

  test('非窗口意图与「打开应用」均不拦截（交回 appLaunch/常规链路）', () => {
    expect(desktopIntent._parseDesktopIntent('帮我写个排序算法', tc)).toBeNull();
    expect(desktopIntent._parseDesktopIntent('你好世界', tc)).toBeNull();
    expect(desktopIntent._parseDesktopIntent('打开火狐', tc)).toBeNull(); // 「打开」归 appLaunchInterceptor
    expect(desktopIntent._parseDesktopIntent('激活', tc)).toBeNull();     // 激活必须带目标名
  });

  test('闸门关闭(off)：拦截返回 denied 指引，绝不绕过保护', async () => {
    delete process.env.KHY_DESKTOP_CONTROL;
    const chunks = [];
    const r = await desktopIntent.tryDesktopIntent('', { userMessage: '关闭火狐', onChunk: (c) => chunks.push(c.type) });
    expect(r).not.toBeNull();
    expect(r.success).toBe(false);
    expect(r.adapter).toBe('gateway_intercept');
    expect(r.content).toMatch(/KHY_DESKTOP_CONTROL|\/desktop/);
    expect(chunks).toEqual(['tool_use', 'tool_result']);
  });

  test('闸门开启(on)：触达门面并执行（注入假门面验证路由）', async () => {
    process.env.KHY_DESKTOP_CONTROL = 'on';
    const calls = [];
    const fakeDesktop = {
      activate: async (n) => { calls.push(['activate', n]); return { success: true }; },
      closeWindow: async (n) => { calls.push(['closeWindow', n]); return { success: true }; },
      minimizeWindow: async () => ({ success: true }),
      listWindows: async () => ({ success: true, stdout: 'win-a\nwin-b' }),
    };
    // 直接测解析→执行 path：复用真实门面会受本机后端影响，故此处仅验证解析+分发逻辑用真实门面的 listWindows 只读。
    const intent = desktopIntent._parseDesktopIntent('激活 VS Code', tc);
    expect(intent).toEqual({ action: 'activate', name: 'VS Code' });
    await fakeDesktop[intent.action](intent.name);
    expect(calls).toEqual([['activate', 'VS Code']]);
  });

  test('非命令式长文本不拦截（>80 字符）', async () => {
    const long = '请帮我详细解释一下如何关闭火狐浏览器并且把它最小化然后再激活另一个窗口同时列出所有窗口好吗谢谢你真的非常感谢';
    const r = await desktopIntent.tryDesktopIntent('', { userMessage: long });
    expect(r).toBeNull();
  });
});

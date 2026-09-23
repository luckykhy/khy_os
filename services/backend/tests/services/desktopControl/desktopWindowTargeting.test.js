'use strict';

/**
 * desktopWindowTargeting.test.js — 感知层必须按「显式目标窗口」定域（F4）。
 *
 * 症状：win-uia-tree.ps1 用 AutomationElement::FocusedElement 的祖先 Window 定域，而
 * activate() 走 SetForegroundWindow 只置前台、不搬 UIA 焦点。于是 inspect() 读的是
 * 「焦点此刻在哪个应用」，不是「刚激活了哪个窗口」——实测同一台机器同一 API 先后返回
 * 1 / 15 / 16 / 168 个元素，且一律 success:true。任何自动化流程都会静默读到错误窗口，
 * 然后把点击打到别的应用上。
 *
 * 不变量：
 *   1) 给了目标窗口名 → 按该名定域，并把名字透传到脚本 argv；
 *   2) 目标窗口找不到 → 诚实失败（success:false + 指名 requested），
 *      绝不返回「别的窗口的元素」，也绝不 success:true 空树。
 */

const fs = require('fs');
const path = require('path');

const provider = require('../../../src/services/domain/desktop/desktopControl/a11yTreeProvider.js');
const registry = require('../../../src/services/domain/desktop/desktopControl/backendRegistry.js');

const UIA_SCRIPT = path.join(
  __dirname,
  '../../../src/services/domain/desktop/desktopControl/scripts/win-uia-tree.ps1'
);

const CAPS = {
  platform: 'win32',
  perception: { available: true, backend: 'windows-uia' },
  eyes: { available: true, backend: 'powershell-gdi' },
  hands: { available: true, backend: 'powershell-user32' },
};

function _uiaBackend() {
  const backends = registry.backendsFor('win32', 'inspect') || [];
  const b = backends.find((x) => x.id === 'windows-uia');
  if (!b) throw new Error('windows-uia inspect backend missing from registry');
  return b;
}

function _depsReturning(payload) {
  const calls = [];
  return {
    calls,
    detect: () => CAPS,
    resolveBackend: () => _uiaBackend(),
    execFile: (cmd, args, opts, cb) => {
      calls.push({ cmd, args });
      cb(null, typeof payload === 'string' ? payload : JSON.stringify(payload), '');
    },
  };
}

describe('F4 — 目标窗口名必须透传到 UIA 脚本 argv', () => {
  test('_winUiaTree 带 targetName 时追加 -TargetName', () => {
    const argv = _uiaBackend().ops.tree({ targetName: 'KhyOS Desktop' });
    const i = argv.args.indexOf('-TargetName');
    expect(i).toBeGreaterThan(-1);
    expect(argv.args[i + 1]).toBe('KhyOS Desktop');
  });

  test('不带 targetName 时不得出现空的 -TargetName（保持旧行为）', () => {
    const argv = _uiaBackend().ops.tree({ selfPids: '1,2' });
    expect(argv.args).not.toContain('-TargetName');
  });

  test('getTree 把 opts.targetName 透传给脚本', async () => {
    const deps = _depsReturning([{ role: 'button', name: 'ok', x: 1, y: 1, w: 10, h: 10 }]);
    await provider.getTree({ platform: 'win32', targetName: 'ZCode' }, deps);
    expect(deps.calls).toHaveLength(1);
    expect(deps.calls[0].args).toContain('-TargetName');
    expect(deps.calls[0].args).toContain('ZCode');
  });
});

describe('F4 — 目标窗口找不到时必须诚实失败', () => {
  test('win-uia-tree.ps1 具备按名定域与 target-not-found 哨兵', () => {
    const src = fs.readFileSync(UIA_SCRIPT, 'utf8');
    expect(/\$TargetName/.test(src)).toBe(true);
    // 按名定域必须从桌面根找顶层窗口，而不是靠 FocusedElement
    expect(/RootElement/.test(src)).toBe(true);
    expect(/__khyTargetNotFound/.test(src)).toBe(true);
  });

  test('provider 收到 target-not-found 哨兵 → success:false 且带上 requested 名', async () => {
    const deps = _depsReturning([{ __khyTargetNotFound: true, requested: 'NoSuchWindow' }]);
    const tree = await provider.getTree({ platform: 'win32', targetName: 'NoSuchWindow' }, deps);
    expect(tree.meta.success).toBe(false);
    expect(tree.length).toBe(0);
    expect(tree.meta.error).toContain('NoSuchWindow');
  });

  test('哨兵不得被当成普通元素（避免下游误点）', async () => {
    const deps = _depsReturning([{ __khyTargetNotFound: true, requested: 'X' }]);
    const tree = await provider.getTree({ platform: 'win32', targetName: 'X' }, deps);
    expect(tree.some((e) => e && e.__khyTargetNotFound)).toBe(false);
  });
});

describe('F4 — 点名目标后 UIA 抓取失败也不得回落整屏 OCR', () => {
  test('targetName + 抓取抛错 → success:false，绝不返回 OCR 元素', async () => {
    let ocrCalled = false;
    const deps = {
      detect: () => CAPS,
      resolveBackend: () => _uiaBackend(),
      execFile: (cmd, args, opts, cb) => cb(new Error('killed'), '', 'timeout'),
      ocrWords: async () => {
        ocrCalled = true;
        return [{ text: '别的应用的画面', bbox: { x: 0, y: 0, w: 100, h: 20 } }];
      },
    };
    const tree = await provider.getTree({ platform: 'win32', targetName: 'KhyOS Desktop' }, deps);
    expect(ocrCalled).toBe(false);
    expect(tree.meta.success).toBe(false);
    expect(tree.meta.source).not.toBe('ocr');
    expect(tree.meta.error).toContain('KhyOS Desktop');
    expect(tree.length).toBe(0);
  });

  test('未点名目标时保留原有 OCR 兜底（不回归）', async () => {
    const deps = {
      detect: () => CAPS,
      resolveBackend: () => _uiaBackend(),
      execFile: (cmd, args, opts, cb) => cb(new Error('killed'), '', 'timeout'),
      ocrWords: async () => [{ text: '屏幕文字', bbox: { x: 0, y: 0, w: 100, h: 20 } }],
    };
    const tree = await provider.getTree({ platform: 'win32' }, deps);
    expect(tree.meta.success).toBe(true);
    expect(tree.meta.source).toBe('ocr');
    expect(tree.length).toBe(1);
  });
});

describe('F4 — 行为验证（真跑 UIA，仅 Windows）', () => {
  const t = process.platform === 'win32' ? test : test.skip;
  t('请求一个不存在的窗口 → 不得返回别的窗口的元素', async () => {
    const { DesktopController } = require('../../../src/services/domain/desktop/desktopControl');
    const prev = process.env.KHY_DESKTOP_CONTROL;
    process.env.KHY_DESKTOP_CONTROL = 'on';
    try {
      const c = new DesktopController({ sessionId: 'test-F4' });
      // timeoutMs 放宽：powershell 冷启动在负载机器上可超过默认 10s 抓取预算。
      const r = await c.inspect({ app: '__khy_no_such_window_zzz__', timeoutMs: 45000 });
      expect(r.success).toBe(false);
      expect((r.elements || []).length).toBe(0);
    } finally {
      if (prev == null) delete process.env.KHY_DESKTOP_CONTROL;
      else process.env.KHY_DESKTOP_CONTROL = prev;
    }
  }, 90000);
});

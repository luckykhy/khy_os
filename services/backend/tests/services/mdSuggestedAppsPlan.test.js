'use strict';

/**
 * mdSuggestedAppsPlan.test.js — 让 khy 出现在 Windows「建议的应用/Recommended apps」的契约。
 *
 * 真实缺口（用户截图佐证）：右键 .md →「选择一个应用以打开此 .md 文件」，建议的应用里
 * 有 Quark/Trae/Windsurf/记事本，**唯独没有 khy**。register-windows.ps1 只写了
 * OpenWithProgids（让 ProgID 进「更多选项」列表），却没写 Windows 用来填充「建议的应用/
 * Recommended Programs」的关键机制：Applications\<app>\SupportedTypes\.md。
 *
 * 依据 Microsoft Win32 shell 文档：SupportedTypes 子键「causes the application to appear
 * in the Recommended Programs list」。本文件把「让 khy 进建议的应用」的注册项做成纯叶子
 * SSOT + 契约测：既单测 plan，也静态断言 register/unregister PS1 与 plan 不漂移、且对称零残留。
 *
 * 诚实边界：本 dev 机无 Windows/PowerShell，PS1 行为以静态契约测验证（断言必需的注册写入
 * 存在 + 卸载对称），非实机执行。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const plan = require('../../src/services/mdSuggestedAppsPlan');

const CMD = 'wscript.exe "C:\\tools\\khyos-md-launch.vbs" "%1"';

// ── 纯叶子单测 ───────────────────────────────────────────────────────────────
test('buildSuggestedAppsPlan: SupportedTypes for .md and .markdown', () => {
  const p = plan.buildSuggestedAppsPlan({ command: CMD });
  const st = p.ops.filter((o) => o.kind === 'supported-type');
  const exts = st.map((o) => o.name);
  assert.ok(exts.includes('.md'), '须声明 .md 为 SupportedType');
  assert.ok(exts.includes('.markdown'), '须声明 .markdown 为 SupportedType');
  for (const o of st) {
    assert.ok(o.key.includes('\\Applications\\'), 'SupportedTypes 须挂在 Applications 下');
    assert.ok(o.key.endsWith('\\SupportedTypes'), 'key 须为 ...\\SupportedTypes');
    assert.strictEqual(o.value, '', 'SupportedTypes 值为空串（值名即扩展名）');
  }
});

test('buildSuggestedAppsPlan: FriendlyAppName + shell\\open\\command present', () => {
  const p = plan.buildSuggestedAppsPlan({ command: CMD });
  const friendly = p.ops.find((o) => o.name === 'FriendlyAppName');
  assert.ok(friendly && friendly.value, '须有 FriendlyAppName（决定建议的应用里显示名）');
  const cmd = p.ops.find((o) => o.kind === 'command');
  assert.ok(cmd && cmd.key.endsWith('\\shell\\open\\command'), '须有 shell\\open\\command');
  assert.strictEqual(cmd.value, CMD, 'command 须透传');
});

test('buildSuggestedAppsPlan: base under HKCU Applications', () => {
  const p = plan.buildSuggestedAppsPlan({ command: CMD });
  assert.ok(p.base.startsWith('HKCU:\\Software\\Classes\\Applications\\'),
    'base 须在用户级 Applications 下（红线：不写 HKLM，免 UAC）');
});

test('buildSuggestedAppsPlan: custom exts filtered to dotted strings', () => {
  const p = plan.buildSuggestedAppsPlan({ command: CMD, exts: ['.md', 'nope', 42, '.mkd'] });
  assert.deepStrictEqual(p.exts, ['.md', '.mkd'], '非点头字符串一律剔除');
});

test('buildSuggestedAppsPlan: deterministic', () => {
  const a = JSON.stringify(plan.buildSuggestedAppsPlan({ command: CMD }));
  const b = JSON.stringify(plan.buildSuggestedAppsPlan({ command: CMD }));
  assert.strictEqual(a, b);
});

test('buildSuggestedAppsPlan: never throws on garbage input', () => {
  let p;
  assert.doesNotThrow(() => { p = plan.buildSuggestedAppsPlan(null); });
  assert.ok(p && Array.isArray(p.ops));
  assert.doesNotThrow(() => { plan.buildSuggestedAppsPlan(42); });
  assert.doesNotThrow(() => { plan.buildSuggestedAppsPlan({ exts: 'x' }); });
});

test('suggestedAppsUninstallKeys: returns the Applications base key to remove', () => {
  const keys = plan.suggestedAppsUninstallKeys({ command: CMD });
  assert.ok(Array.isArray(keys) && keys.length >= 1);
  assert.ok(keys[0].includes('\\Applications\\'), '卸载须移除 Applications\\<app> 顶层键');
});

// ── PS1 静态契约：register-windows.ps1 不得与 plan 漂移 ──────────────────────
function readTool(name) {
  return fs.readFileSync(
    path.join(__dirname, '..', '..', '..', '..', 'tools', 'khyos-markdown', name),
    'utf8',
  );
}

test('contract: register-windows.ps1 writes Applications SupportedTypes for each ext', () => {
  const src = readTool('register-windows.ps1');
  const p = plan.buildSuggestedAppsPlan({ command: CMD });
  assert.ok(/Applications\\/.test(src), 'register 须写 Applications 键（建议的应用机制）');
  assert.ok(/SupportedTypes/.test(src), 'register 须写 SupportedTypes');
  for (const ext of p.exts) {
    // ext 作为 SupportedTypes 下的值名出现
    assert.ok(src.includes(`SupportedTypes`) && src.includes(ext),
      `register 须为 ${ext} 声明 SupportedType`);
  }
  assert.ok(/FriendlyAppName/.test(src), 'register 须写 FriendlyAppName');
  assert.ok(/Applications[\s\S]*shell\\open\\command/.test(src),
    'register 须为 Applications 写 shell\\open\\command');
});

test('contract: unregister-windows.ps1 removes the Applications key (zero residue)', () => {
  const src = readTool('unregister-windows.ps1');
  assert.ok(/Applications\\/.test(src), 'unregister 须清除 Applications 键');
  assert.ok(/Remove-Item[\s\S]*Applications\\/.test(src) || /Applications\\[\s\S]*Remove-Item/.test(src),
    'unregister 须 Remove-Item 掉 Applications\\<app>（与 register 对称）');
});

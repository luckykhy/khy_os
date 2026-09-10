'use strict';
/**
 * nativeUninstallWiring.test.js �?原生卸载 T2 层接线的源级 + 功能级断言(node:test)�?
 *
 * 源级(readFileSync + regex,绕过 CLI/tool 的重依赖):�?device.js �?DeviceAppsTool �?
 * 真正 require �?uninstallRoute + nativeUninstaller,并在卸载路径上调�?decideUninstallRoute;
 * �?flagRegistry 声明�?KHY_DEVICE_APPS_NATIVE_UNINSTALL(�?KHY_DEVICE_APPS)�?
 * 功能�?tool._uninstallRouted �?T3 场景(无包管理�?+ 无原生命�?返回 refuse 而非猜删�?
 */
const fs = require('fs');
const path = require('path');
const SRC = path.resolve(__dirname, '../../../src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

describe('Native Uninstall Wiring', () => {
  test('device.js wires uninstall through decideUninstallRoute + native uninstaller', async () => {
      const s = read('cli/handlers/device.js');
      expect(s).toMatch(/require\(['"]\.\.\/\.\.\/services\/deviceApps\/uninstallRoute['"]\)/);
      expect(s).toMatch(/require\(['"]\.\.\/\.\.\/services\/deviceApps\/nativeUninstaller['"]\)/);
      expect(s).toMatch(/decideUninstallRoute\(/);
      expect(s).toMatch(/_handleUninstallRouted/);
      // T3 honest-refusal path present.
      expect(s).toMatch(/route\.tier === 'refuse'/);
  });

  test('DeviceAppsTool wires uninstall through the router + native uninstaller', async () => {
      const s = read('tools/DeviceAppsTool/index.js');
      expect(s).toMatch(/require\(['"]\.\.\/\.\.\/services\/deviceApps\/uninstallRoute['"]\)/);
      expect(s).toMatch(/require\(['"]\.\.\/\.\.\/services\/deviceApps\/nativeUninstaller['"]\)/);
      expect(s).toMatch(/_uninstallRouted/);
      expect(s).toMatch(/tier: 'refuse'/);
  });

  test('flagRegistry declares KHY_DEVICE_APPS_NATIVE_UNINSTALL under parent KHY_DEVICE_APPS', async () => {
      const s = read('services/flagRegistry.js');
      expect(s).toMatch(/KHY_DEVICE_APPS_NATIVE_UNINSTALL:\s*\{[^}]*parent:\s*'KHY_DEVICE_APPS'/);
  });

  test('functional: tool._uninstallRouted refuses (T3) when no pm and no native match', async () => {
      // Load the tool class directly (gate on by default).
      const mod = require('../../../src/tools/DeviceAppsTool');
      const Tool = mod.DeviceAppsTool || (mod.constructor && mod.constructor.name === 'DeviceAppsTool' && mod.constructor);
      expect(Tool).toBeTruthy();
      const tool = new Tool();
      // mgr unavailable (no pm), env forces native off �?both routes closed �?refuse.
      const res = await tool._uninstallRouted('Some Random App', false, { available: false }, { KHY_DEVICE_APPS_NATIVE_UNINSTALL: '0' });
      expect(res.success).toBe(false);
      expect(res.tier).toBe('refuse');
      expect(res.error).toMatch(/无法安全卸载/);
  });

});


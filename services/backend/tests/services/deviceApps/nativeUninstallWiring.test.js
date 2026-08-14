'use strict';

/**
 * nativeUninstallWiring.test.js — 原生卸载 T2 层接线的源级 + 功能级断言(node:test)。
 *
 * 源级(readFileSync + regex,绕过 CLI/tool 的重依赖):证 device.js 与 DeviceAppsTool 都
 * 真正 require 了 uninstallRoute + nativeUninstaller,并在卸载路径上调用 decideUninstallRoute;
 * 证 flagRegistry 声明了 KHY_DEVICE_APPS_NATIVE_UNINSTALL(父 KHY_DEVICE_APPS)。
 * 功能级:tool._uninstallRouted 在 T3 场景(无包管理器 + 无原生命中)返回 refuse 而非猜删。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '../../../src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

test('device.js wires uninstall through decideUninstallRoute + native uninstaller', () => {
  const s = read('cli/handlers/device.js');
  assert.match(s, /require\(['"]\.\.\/\.\.\/services\/deviceApps\/uninstallRoute['"]\)/);
  assert.match(s, /require\(['"]\.\.\/\.\.\/services\/deviceApps\/nativeUninstaller['"]\)/);
  assert.match(s, /decideUninstallRoute\(/);
  assert.match(s, /_handleUninstallRouted/);
  // T3 honest-refusal path present.
  assert.match(s, /route\.tier === 'refuse'/);
});

test('DeviceAppsTool wires uninstall through the router + native uninstaller', () => {
  const s = read('tools/DeviceAppsTool/index.js');
  assert.match(s, /require\(['"]\.\.\/\.\.\/services\/deviceApps\/uninstallRoute['"]\)/);
  assert.match(s, /require\(['"]\.\.\/\.\.\/services\/deviceApps\/nativeUninstaller['"]\)/);
  assert.match(s, /_uninstallRouted/);
  assert.match(s, /tier: 'refuse'/);
});

test('flagRegistry declares KHY_DEVICE_APPS_NATIVE_UNINSTALL under parent KHY_DEVICE_APPS', () => {
  const s = read('services/flagRegistry.js');
  assert.match(s, /KHY_DEVICE_APPS_NATIVE_UNINSTALL:\s*\{[^}]*parent:\s*'KHY_DEVICE_APPS'/);
});

test('functional: tool._uninstallRouted refuses (T3) when no pm and no native match', async () => {
  // Load the tool class directly (gate on by default).
  const mod = require('../../../src/tools/DeviceAppsTool');
  const Tool = mod.DeviceAppsTool || (mod.constructor && mod.constructor.name === 'DeviceAppsTool' && mod.constructor);
  assert.ok(Tool, 'DeviceAppsTool class exported');
  const tool = new Tool();
  // mgr unavailable (no pm), env forces native off → both routes closed → refuse.
  const res = await tool._uninstallRouted('Some Random App', false, { available: false }, { KHY_DEVICE_APPS_NATIVE_UNINSTALL: '0' });
  assert.equal(res.success, false);
  assert.equal(res.tier, 'refuse');
  assert.match(res.error, /无法安全卸载/);
});

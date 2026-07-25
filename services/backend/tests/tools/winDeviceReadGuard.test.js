'use strict';

/**
 * winDeviceReadGuard 纯叶 + readFile 接线的确定性测试(纯路径 · 零 IO · 显式 platform 形参
 * 使其在任何宿主平台上都可全测)。承 OPS-MAN-143。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
  WIN_DEVICE_GUARD_FLAG,
  winDeviceGuardEnabled,
  classifyWindowsDevice,
  buildWinDeviceRefusal,
} = require('../../src/tools/winDeviceReadGuard');

// ── 门控 ─────────────────────────────────────────────────────────────────────

test('flag: 默认开(缺省 env)', () => {
  assert.strictEqual(winDeviceGuardEnabled({}), true);
  assert.strictEqual(winDeviceGuardEnabled(undefined), true);
});

test('flag: 仅 {0,false,off,no} 归一后关', () => {
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(winDeviceGuardEnabled({ [WIN_DEVICE_GUARD_FLAG]: off }), false, `off=${off}`);
  }
  for (const on of ['1', 'true', 'yes', 'on', '']) {
    assert.strictEqual(winDeviceGuardEnabled({ [WIN_DEVICE_GUARD_FLAG]: on }), true, `on=${on}`);
  }
});

// ── win32:保留设备名正例 ─────────────────────────────────────────────────────

test('win32: 裸保留名命中 reserved-name', () => {
  for (const name of ['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM9', 'LPT1', 'LPT9']) {
    assert.strictEqual(classifyWindowsDevice(name, 'win32'), 'reserved-name', name);
    // 大小写不敏感
    assert.strictEqual(classifyWindowsDevice(name.toLowerCase(), 'win32'), 'reserved-name', name.toLowerCase());
  }
});

test('win32: 带扩展名/带目录/带盘符仍命中(Windows 无关扩展名与目录)', () => {
  const cases = [
    'con.txt',
    'COM1.log',
    'C:\\temp\\CON',
    'C:\\Users\\me\\Documents\\NUL.dat',
    'sub/dir/LPT1.bin',          // 正斜杠也归一
    'CON ',                       // 尾部空格被忽略
    'CON.',                       // 尾部点被忽略
  ];
  for (const c of cases) {
    assert.strictEqual(classifyWindowsDevice(c, 'win32'), 'reserved-name', c);
  }
});

test('win32: 设备命名空间前缀命中 device-namespace', () => {
  for (const p of ['\\\\.\\PhysicalDrive0', '\\\\.\\COM1', '\\\\.\\pipe\\foo', '\\\\?\\GLOBALROOT\\Device\\Harddisk0']) {
    assert.strictEqual(classifyWindowsDevice(p, 'win32'), 'device-namespace', p);
  }
});

// ── win32:反例(绝不误伤合法文件)────────────────────────────────────────────

test('win32: 词干相似但非保留名 → null', () => {
  const legit = [
    'CONFIG',            // 词干 CONFIG,非 CON
    'CONfig.json',
    'COM10',             // COM10 需 \\.\ 前缀才是设备,裸名是合法文件
    'COM0',              // 只认 COM1-9
    'LPT0',
    'foo.con',           // 词干 FOO
    'console.log',       // 词干 CONSOLE
    'NULable.txt',       // 词干 NULABLE
    'readme.md',
    'C:\\projects\\Khy-OS\\package.json',
  ];
  for (const c of legit) {
    assert.strictEqual(classifyWindowsDevice(c, 'win32'), null, c);
  }
});

test('win32: 扩展长度前缀的普通路径 \\\\?\\C:\\... → null(非设备)', () => {
  assert.strictEqual(classifyWindowsDevice('\\\\?\\C:\\very\\long\\path\\file.txt', 'win32'), null);
});

// ── 非 win32:平台门(POSIX 上这些是合法文件名,一律放行)────────────────────

test('非 win32: 保留名一律 null(平台门)', () => {
  for (const plat of ['linux', 'darwin', 'freebsd']) {
    for (const name of ['CON', 'COM1', 'NUL', 'LPT1', 'con.txt', '\\\\.\\PhysicalDrive0']) {
      assert.strictEqual(classifyWindowsDevice(name, plat), null, `${plat}:${name}`);
    }
  }
});

// ── null-safe(绝不抛)─────────────────────────────────────────────────────────

test('null-safe: 空/非串输入 → null', () => {
  for (const bad of [null, undefined, '', 42, {}, []]) {
    assert.strictEqual(classifyWindowsDevice(bad, 'win32'), null, String(bad));
  }
});

// ── 拒绝消息 ─────────────────────────────────────────────────────────────────

test('refusal: reserved-name 消息含设备名与卡死原因', () => {
  const msg = buildWinDeviceRefusal({ kind: 'reserved-name', path: 'C:\\tmp\\COM1.log' });
  assert.match(msg, /COM1/);
  assert.match(msg, /保留设备/);
  assert.match(msg, /卡死/);
});

test('refusal: device-namespace 消息含原路径', () => {
  const msg = buildWinDeviceRefusal({ kind: 'device-namespace', path: '\\\\.\\PhysicalDrive0' });
  assert.match(msg, /PhysicalDrive0/);
});

test('refusal: 空输入不抛', () => {
  assert.doesNotThrow(() => buildWinDeviceRefusal());
  assert.doesNotThrow(() => buildWinDeviceRefusal({}));
});

// ── 源级接线断言(readFileSync + regex)──────────────────────────────────────

test('wiring: readFile.js require 本守卫且门控消费', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/tools/readFile.js'), 'utf8');
  assert.match(src, /require\(['"]\.\/winDeviceReadGuard['"]\)/, 'requires the leaf');
  assert.match(src, /winDeviceGuardEnabled\(process\.env\)/, 'consults the gate');
  assert.match(src, /classifyWindowsDevice\(filePath\)/, 'classifies resolved filePath');
  assert.match(src, /buildWinDeviceRefusal\(/, 'renders refusal');
});

test('wiring: 守卫排在 fs.statSync 之前(设备触碰前拦下)', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/tools/readFile.js'), 'utf8');
  const guardIdx = src.indexOf("require('./winDeviceReadGuard')");
  const statIdx = src.indexOf('fs.statSync(filePath)');
  assert.ok(guardIdx > 0, 'guard present');
  assert.ok(statIdx > 0, 'statSync present');
  assert.ok(guardIdx < statIdx, 'guard must precede statSync');
});

// ── 主读工具 `Read`(FileReadTool)接线断言 ──────────────────────────────────
// 面向模型的主读工具与 readFile.js 是并行两条读路径(见 tools/index.js 定义暴露)。
// 模型多按 `Read` 惯例调用 → 守卫必须同样落在此路径,否则 win-device 卡死仍会复现。
test('wiring: FileReadTool(Read)require 本守卫且门控消费', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/tools/FileReadTool/index.js'), 'utf8');
  assert.match(src, /require\(['"]\.\.\/winDeviceReadGuard['"]\)/, 'requires the leaf');
  assert.match(src, /winDeviceGuardEnabled\(process\.env\)/, 'consults the gate');
  assert.match(src, /classifyWindowsDevice\(filePath\)/, 'classifies resolved filePath');
  assert.match(src, /buildWinDeviceRefusal\(/, 'renders refusal');
});

test('wiring: FileReadTool 守卫排在 fs.existsSync/statSync 之前(设备触碰前拦下)', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/tools/FileReadTool/index.js'), 'utf8');
  const guardIdx = src.indexOf("require('../winDeviceReadGuard')");
  const existsIdx = src.indexOf('fs.existsSync(filePath)');
  const statIdx = src.indexOf('fs.statSync(filePath)');
  assert.ok(guardIdx > 0, 'guard present');
  assert.ok(existsIdx > 0, 'existsSync present');
  assert.ok(statIdx > 0, 'statSync present');
  assert.ok(guardIdx < existsIdx, 'guard must precede existsSync');
  assert.ok(guardIdx < statIdx, 'guard must precede statSync');
});

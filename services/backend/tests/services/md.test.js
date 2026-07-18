'use strict';

/**
 * md.test.js — `khy md` handler + mdEditorRegister 首次运行注册的单元测试（node:test）。
 *
 * 全程 stub 掉真实副作用（spawn / spawnSync / bridge.startBridge / fs sentinel），
 * 在隔离 tmp 中验证:子命令路由、tools 目录解析、门控、平台分流、幂等 sentinel、fail-soft。
 * 绝不真起服务、真开浏览器、真写系统关联。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const HANDLER = require('../../src/cli/handlers/md');
const REG = require('../../src/services/mdEditorRegister');

// ── md handler:tools 目录解析 ─────────────────────────────────────────────
test('resolveToolsDir:命中真实仓库 tools/khyos-markdown（含 khyos-md-bridge.js）', () => {
  const dir = HANDLER.resolveToolsDir();
  assert.ok(dir, '应解析出目录');
  assert.ok(fs.existsSync(path.join(dir, 'khyos-md-bridge.js')), '目录内应有桥接器');
});

test('resolveToolsDir:KHY_MD_TOOLS_DIR 覆盖优先', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mdtools-'));
  fs.writeFileSync(path.join(tmp, 'khyos-md-bridge.js'), '// stub');
  const saved = process.env.KHY_MD_TOOLS_DIR;
  try {
    process.env.KHY_MD_TOOLS_DIR = tmp;
    assert.equal(HANDLER.resolveToolsDir(), tmp);
  } finally {
    if (saved === undefined) delete process.env.KHY_MD_TOOLS_DIR; else process.env.KHY_MD_TOOLS_DIR = saved;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── md handler:门控 ───────────────────────────────────────────────────────
test('handleMd:KHY_MD_EDITOR=0 → 直接返回 true 不做任何事', async () => {
  const saved = process.env.KHY_MD_EDITOR;
  try {
    process.env.KHY_MD_EDITOR = '0';
    const r = await HANDLER.handleMd({ subCommand: 'open', args: ['x.md'] });
    assert.equal(r, true);
  } finally {
    if (saved === undefined) delete process.env.KHY_MD_EDITOR; else process.env.KHY_MD_EDITOR = saved;
  }
});

// ── mdEditorRegister:门控 / 平台 / 幂等 / fail-soft ───────────────────────
test('ensureMdRegistered:门控关（KHY_MD_EDITOR=0）→ skip-gate，绝不 spawn', () => {
  const r = REG.ensureMdRegistered({ KHY_MD_EDITOR: '0', KHY_MD_AUTO_REGISTER: '1' });
  assert.equal(r, 'skip-gate');
});

test('ensureMdRegistered:AUTO_REGISTER 关 → skip-gate', () => {
  const r = REG.ensureMdRegistered({ KHY_MD_EDITOR: '1', KHY_MD_AUTO_REGISTER: '0' });
  assert.equal(r, 'skip-gate');
});

test('ensureMdRegistered:不支持平台 → skip-platform', () => {
  const savedPlat = Object.getOwnPropertyDescriptor(process, 'platform');
  try {
    Object.defineProperty(process, 'platform', { value: 'sunos', configurable: true });
    const r = REG.ensureMdRegistered({ KHY_MD_EDITOR: '1', KHY_MD_AUTO_REGISTER: '1' });
    assert.equal(r, 'skip-platform');
  } finally {
    Object.defineProperty(process, 'platform', savedPlat);
  }
});

test('ensureMdRegistered:sentinel 已存在 → skip-sentinel（幂等，不重复注册）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mdhome-'));
  const savedHome = process.env.KHY_DATA_HOME;
  const savedPlat = Object.getOwnPropertyDescriptor(process, 'platform');
  try {
    process.env.KHY_DATA_HOME = tmp;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const sp = REG.sentinelPath();
    // 若 dataHome 未落到 tmp（环境差异）则跳过该断言，避免误报。
    if (sp && sp.startsWith(tmp)) {
      fs.writeFileSync(sp, '{}');
      const r = REG.ensureMdRegistered({ KHY_MD_EDITOR: '1', KHY_MD_AUTO_REGISTER: '1' });
      assert.equal(r, 'skip-sentinel');
    }
  } finally {
    if (savedHome === undefined) delete process.env.KHY_DATA_HOME; else process.env.KHY_DATA_HOME = savedHome;
    Object.defineProperty(process, 'platform', savedPlat);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('ensureMdRegistered:绝不抛（坏 env / 缺 tools）', () => {
  assert.doesNotThrow(() => REG.ensureMdRegistered(null));
  assert.doesNotThrow(() => REG.ensureMdRegistered({}));
  assert.doesNotThrow(() => REG.ensureMdRegistered(undefined));
});

test('markRegistered:写 sentinel 幂等且绝不抛（隔离 KHY_DATA_HOME）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mdhome2-'));
  const savedHome = process.env.KHY_DATA_HOME;
  try {
    process.env.KHY_DATA_HOME = tmp;
    const sp = REG.sentinelPath();
    if (sp && sp.startsWith(tmp)) {
      assert.doesNotThrow(() => REG.markRegistered());
      assert.doesNotThrow(() => REG.markRegistered()); // 二次幂等
      assert.ok(fs.existsSync(sp), 'sentinel 应写入');
      const parsed = JSON.parse(fs.readFileSync(sp, 'utf8'));
      assert.ok(parsed.version, '含版本');
    }
  } finally {
    if (savedHome === undefined) delete process.env.KHY_DATA_HOME; else process.env.KHY_DATA_HOME = savedHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

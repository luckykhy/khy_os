'use strict';

/**
 * learningProfile.test.js — 学习者讲解档位（normal / beginner）持久化锁定测试:
 *   - 无文件无 env → DEFAULT_LEVEL ('normal')
 *   - setLevel('beginner') 持久化 + 二次写出 .bak
 *   - 非法档位被拒且文件不变
 *   - KHY_LEARN_LEVEL 环境默认（无文件时生效）
 *   - 损坏 JSON → fail-soft 回落默认，绝不抛
 *   - 指令耦合：buildLearningPrompt(...,{level:'beginner'}) 含「零基础讲解模式」;
 *     {level:'normal'}/{} 不含且与无 opts 字节一致；simple builder 仅含紧凑 [零基础] 标签;
 *     {ragContext} 仍嵌入且无零基础块（back-compat）
 *
 * Isolation: HOME / KHYOS_HOME 指向私有临时目录（require 之前），档位只落临时区。
 */

const { describe, test, beforeEach, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ── isolate home dirs before requiring modules under test ──
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-prof-'));
const ORIG = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, KHYOS_HOME: process.env.KHYOS_HOME, LVL: process.env.KHY_LEARN_LEVEL };
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
process.env.KHYOS_HOME = path.join(TMP_HOME, '.khyos');
delete process.env.KHY_LEARN_LEVEL;

const profile = require('../../src/services/learningProfile');
const curriculum = require('../../src/services/learningCurriculum');

const PROFILE_DIR = path.join(TMP_HOME, '.khyos', 'growth');
const PROFILE_FILE = path.join(PROFILE_DIR, 'learn_profile.json');
const PROFILE_BAK = path.join(PROFILE_DIR, 'learn_profile.bak');

function wipe() {
  try { fs.rmSync(PROFILE_FILE, { force: true }); } catch { /* ignore */ }
  try { fs.rmSync(PROFILE_BAK, { force: true }); } catch { /* ignore */ }
  delete process.env.KHY_LEARN_LEVEL;
}

before(() => wipe());
beforeEach(() => wipe());
after(() => {
  process.env.HOME = ORIG.HOME;
  process.env.USERPROFILE = ORIG.USERPROFILE;
  process.env.KHYOS_HOME = ORIG.KHYOS_HOME;
  if (ORIG.LVL === undefined) delete process.env.KHY_LEARN_LEVEL; else process.env.KHY_LEARN_LEVEL = ORIG.LVL;
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('档位默认与持久化', () => {
  test('无文件无 env → 默认 normal', () => {
    assert.strictEqual(profile.getLevel(), 'normal');
    assert.strictEqual(profile.isBeginner(), false);
  });

  test('setLevel(beginner) 持久化并被读回', () => {
    const res = profile.setLevel('beginner');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.level, 'beginner');
    assert.ok(fs.existsSync(PROFILE_FILE), '档位文件应已写入');
    assert.strictEqual(profile.getLevel(), 'beginner');
    assert.strictEqual(profile.isBeginner(), true);
    const onDisk = JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf-8'));
    assert.strictEqual(onDisk.level, 'beginner');
    assert.strictEqual(onDisk.version, 1);
    assert.strictEqual(typeof onDisk.updatedAt, 'string');
  });

  test('大小写/空白归一化', () => {
    const res = profile.setLevel('  BEGINNER  ');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(profile.getLevel(), 'beginner');
  });

  test('二次写出 .bak 备份', () => {
    profile.setLevel('beginner');
    assert.strictEqual(fs.existsSync(PROFILE_BAK), false, '首写不应有 .bak');
    profile.setLevel('normal');
    assert.ok(fs.existsSync(PROFILE_BAK), '二次写应轮转出 .bak');
    assert.strictEqual(profile.getLevel(), 'normal');
  });

  test('无 .tmp 残留', () => {
    profile.setLevel('beginner');
    const stray = fs.readdirSync(PROFILE_DIR).filter(f => f.includes('.tmp'));
    assert.deepStrictEqual(stray, []);
  });
});

describe('非法输入与 fail-soft', () => {
  test('非法档位被拒、文件不变', () => {
    profile.setLevel('beginner');
    const before = fs.readFileSync(PROFILE_FILE, 'utf-8');
    const res = profile.setLevel('expert');
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /invalid level/);
    assert.strictEqual(fs.readFileSync(PROFILE_FILE, 'utf-8'), before, '非法设置不应改动文件');
    assert.strictEqual(profile.getLevel(), 'beginner');
  });

  test('KHY_LEARN_LEVEL 环境默认（无文件时生效）', () => {
    process.env.KHY_LEARN_LEVEL = 'beginner';
    assert.strictEqual(profile.getLevel(), 'beginner');
    // 非法 env → 回落 normal
    process.env.KHY_LEARN_LEVEL = 'wizard';
    assert.strictEqual(profile.getLevel(), 'normal');
  });

  test('磁盘文件优先于 env', () => {
    profile.setLevel('normal');
    process.env.KHY_LEARN_LEVEL = 'beginner';
    assert.strictEqual(profile.getLevel(), 'normal', '已有档位文件时 env 不应覆盖');
  });

  test('损坏 JSON → fail-soft 回落默认，不抛', () => {
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
    fs.writeFileSync(PROFILE_FILE, '{ not valid json ', 'utf-8');
    assert.doesNotThrow(() => profile.getLevel());
    assert.strictEqual(profile.getLevel(), 'normal');
  });
});

describe('档位 → prompt 指令耦合', () => {
  const floor = curriculum.getLayers().filter(l => !l._source);
  const layer = floor.find(l => l.topics && l.topics.length) || floor[0];
  const topic = layer.topics[0];

  test('beginner 档位注入「零基础讲解模式」整块', () => {
    const out = curriculum.buildLearningPrompt(layer, topic, { level: 'beginner' });
    assert.match(out, /零基础讲解模式/);
    assert.match(out, /这门语言为什么要这样写|为什么这样写/);
    assert.match(out, /learn improve/);
  });

  test('normal 档位 / 缺省 与无 opts 字节一致（back-compat）', () => {
    const base = curriculum.buildLearningPrompt(layer, topic);
    const normal = curriculum.buildLearningPrompt(layer, topic, { level: 'normal' });
    const empty = curriculum.buildLearningPrompt(layer, topic, {});
    assert.strictEqual(normal, base, 'normal 档位输出应与无 opts 一致');
    assert.strictEqual(empty, base, '空 opts 输出应与无 opts 一致');
    assert.doesNotMatch(base, /零基础讲解模式/);
  });

  test('ragContext 仍嵌入且无零基础块（back-compat）', () => {
    const out = curriculum.buildLearningPrompt(layer, topic, { ragContext: 'RAG_MARKER_XYZ' });
    assert.match(out, /RAG_MARKER_XYZ/);
    assert.doesNotMatch(out, /零基础讲解模式/);
  });

  test('simple builder 仅含紧凑 [零基础] 标签、不含整块', () => {
    const out = curriculum.buildSimpleTopicPrompt(layer, topic, { level: 'beginner' });
    assert.match(out, /\[零基础\]/);
    assert.doesNotMatch(out, /零基础讲解模式/, 'simple 不应混入大块指令（防小模型膨胀）');
    const normal = curriculum.buildSimpleTopicPrompt(layer, topic, { level: 'normal' });
    assert.doesNotMatch(normal, /\[零基础\]/);
  });

  test('layer overview builder 也接 beginner', () => {
    const out = curriculum.buildLayerOverviewPrompt(layer, { level: 'beginner' });
    assert.match(out, /零基础讲解模式/);
    const base = curriculum.buildLayerOverviewPrompt(layer);
    assert.doesNotMatch(base, /零基础讲解模式/);
  });
});

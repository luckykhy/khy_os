'use strict';

/**
 * toolPrefaceVoice.gating.test.js — 批2 过程叙述 gating 放宽(缺口④,纯函数侧)。
 *
 * 锁定两件事:
 *  - segmentMentionsTool: 给定模型本段文字 + 工具名 + 参数,判断模型是否**已具体点到这个
 *    工具的动作**(类别关键词 / 路径 basename / 命令首 token / pattern 回显四路并集)。命中即
 *    视为"模型已自述",上层据此静音合成 preface;未命中则 preface 照常出。偏向静音(保守)。
 *  - toolOutcomeNarration 失败分支:默认(KHY_TOOL_OUTCOME_FAIL on)给一句中性恢复衔接,
 *    KHY_TOOL_OUTCOME_FAIL=0 回退旧的"失败即静音"。
 */

const voice = require('../../src/cli/toolPrefaceVoice');

describe('segmentMentionsTool — 段内点名检测', () => {
  test('类别关键词命中(读→read)', () => {
    expect(voice.segmentMentionsTool('我先读一下实现', 'read', {})).toBe(true);
    expect(voice.segmentMentionsTool('我先看看', 'read', {})).toBe(true);
  });

  test('类别关键词命中(搜→grep / 改→edit / 跑→bash)', () => {
    expect(voice.segmentMentionsTool('我搜一下 TODO', 'grep', {})).toBe(true);
    expect(voice.segmentMentionsTool('我来改下这里', 'edit', {})).toBe(true);
    expect(voice.segmentMentionsTool('我跑一下测试', 'bash', {})).toBe(true);
  });

  test('路径 basename 命中(跨 OS)', () => {
    expect(
      voice.segmentMentionsTool('稍等，我处理 foo.js', 'read', { file_path: '/a/b/foo.js' })
    ).toBe(true);
    expect(
      voice.segmentMentionsTool('看看 Desktop 里有什么', 'ls', { path: 'D:\\Users\\x\\Desktop' })
    ).toBe(true);
  });

  test('命令首 token(去路径裸命令名)命中', () => {
    expect(voice.segmentMentionsTool('我用 npm 装一下', 'bash', { command: 'npm install' })).toBe(true);
    expect(voice.segmentMentionsTool('跑 pytest', 'bash', { command: '/usr/bin/pytest -q' })).toBe(true);
  });

  test('pattern/query 原样回显命中', () => {
    expect(voice.segmentMentionsTool('找一下 FIXME 标记', 'grep', { pattern: 'FIXME' })).toBe(true);
  });

  test('泛泛而谈、没点到这个工具 → 不命中(preface 照常出)', () => {
    expect(voice.segmentMentionsTool('好的，我来处理一下。', 'read', { file_path: '/a/b/foo.js' })).toBe(false);
    expect(voice.segmentMentionsTool('明白了，这就开始。', 'bash', { command: 'npm test' })).toBe(false);
  });

  test('空文字 / 空工具名 → false,绝不抛', () => {
    expect(voice.segmentMentionsTool('', 'read', {})).toBe(false);
    expect(voice.segmentMentionsTool('   ', 'read', {})).toBe(false);
    expect(voice.segmentMentionsTool('随便说点', '', {})).toBe(false);
    expect(voice.segmentMentionsTool(undefined, undefined, undefined)).toBe(false);
  });

  test('单字符 basename 不参与匹配(避免噪声误命中)', () => {
    // basename "a" 长度 1 → 不应仅因文字里出现 "a" 就静音
    expect(voice.segmentMentionsTool('this is a sentence', 'read', { file_path: '/x/a' })).toBe(false);
  });
});

describe('toolOutcomeNarration 失败衔接句 — KHY_TOOL_OUTCOME_FAIL', () => {
  afterEach(() => { delete process.env.KHY_TOOL_OUTCOME_FAIL; });

  test('默认 on:失败步给一句中性恢复衔接(带 basename)', () => {
    const out = voice.toolOutcomeNarration('read', { success: false }, { file_path: '/a/foo.js' });
    expect(out).toMatch(/foo\.js/);
    expect(out).toMatch(/没走通/);
  });

  test('默认 on:denied / 非零退码也发声', () => {
    expect(voice.toolOutcomeNarration('write', { denied: true }, { file_path: '/a/foo.js' })).toMatch(/没走通/);
    const nonZero = voice.toolOutcomeNarration('bash', { success: true, exitCode: 3 }, { command: 'make' });
    expect(nonZero).toMatch(/非零/);
    expect(nonZero).toMatch(/3/);
  });

  test('KHY_TOOL_OUTCOME_FAIL=0:回退旧的"失败即静音"', () => {
    process.env.KHY_TOOL_OUTCOME_FAIL = '0';
    expect(voice.toolOutcomeNarration('read', { success: false }, { file_path: '/a/foo.js' })).toBe('');
    expect(voice.toolOutcomeNarration('bash', { success: true, exitCode: 3 }, { command: 'make' })).toBe('');
  });

  test('成功步不受影响(仍是原文案)', () => {
    expect(voice.toolOutcomeNarration('bash', { success: true, exitCode: 0 }, { command: 'make' })).toMatch(/跑通/);
  });
});

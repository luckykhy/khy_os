'use strict';

/**
 * Unit tests for memoryTrigger.js — the capture-side classifier (when to
 * remember, at which tier) for the layered-memory goal:
 *   (a) proactive remember trigger (conservative, zero-false-positive),
 *   (b) tier inference incl. stable topic key for proactive update,
 *   (c) reliable explicit「请记住」capture.
 *
 * Pure functions, no IO; we only toggle the env gates.
 */

const MT = require('../../src/services/memoryTrigger');
const TIERS = require('../../src/services/memoryTier').TIERS;

const SAVED = {};
beforeEach(() => {
  SAVED.trigger = process.env.KHY_MEMORY_TRIGGER;
  SAVED.proactive = process.env.KHY_PROACTIVE_CAPTURE;
  delete process.env.KHY_MEMORY_TRIGGER;
  delete process.env.KHY_PROACTIVE_CAPTURE;
});
afterEach(() => {
  if (SAVED.trigger === undefined) delete process.env.KHY_MEMORY_TRIGGER; else process.env.KHY_MEMORY_TRIGGER = SAVED.trigger;
  if (SAVED.proactive === undefined) delete process.env.KHY_PROACTIVE_CAPTURE; else process.env.KHY_PROACTIVE_CAPTURE = SAVED.proactive;
});

describe('memoryTrigger.classify — explicit「请记住」(must capture)', () => {
  test('plain remember ⇒ explicit, body stripped of trigger prefix', () => {
    const d = MT.classify('记住：部署用 docker compose');
    expect(d.kind).toBe('explicit');
    expect(d.note).toBe('部署用 docker compose');
    expect(d.tier).toBe(TIERS.CROSS_SESSION);
  });

  test('remember this (English) ⇒ explicit', () => {
    const d = MT.classify('remember this: the api base is api.example.com');
    expect(d.kind).toBe('explicit');
    expect(d.note).toContain('api.example.com');
  });

  test('identity inside an explicit remember ⇒ permanent + user + stable topic key', () => {
    const d = MT.classify('记住我叫张三');
    expect(d.kind).toBe('explicit');
    expect(d.tier).toBe(TIERS.PERMANENT);
    expect(d.type).toBe('user');
    expect(d.name).toBe('user-name'); // stable ⇒ re-declaration supersedes
  });

  test('「永久记住」⇒ permanent tier', () => {
    const d = MT.classify('永久记住这个密钥前缀是 sk-proj');
    expect(d.kind).toBe('explicit');
    expect(d.tier).toBe(TIERS.PERMANENT);
  });

  test('「这次临时记一下」⇒ short_term tier', () => {
    const d = MT.classify('这次临时记一下端口是 8080');
    expect(d.kind).toBe('explicit');
    expect(d.tier).toBe(TIERS.SHORT_TERM);
  });

  test('feedback-flavored explicit ⇒ feedback type', () => {
    const d = MT.classify('记住以后回复都用中文');
    expect(d.kind).toBe('explicit');
    expect(d.type).toBe('feedback');
  });
});

describe('memoryTrigger.classify — proactive (conservative, zero false positive)', () => {
  test('「我叫X」(no explicit ask) ⇒ proactive permanent identity with stable key', () => {
    const d = MT.classify('对了，我叫李四');
    expect(d.kind).toBe('proactive');
    expect(d.tier).toBe(TIERS.PERMANENT);
    expect(d.type).toBe('user');
    expect(d.name).toBe('user-name');
  });

  test('stable preference declaration ⇒ proactive cross_session feedback', () => {
    const d = MT.classify('我习惯用 tab 缩进');
    expect(d.kind).toBe('proactive');
    expect(d.tier).toBe(TIERS.CROSS_SESSION);
    expect(d.type).toBe('feedback');
    expect(d.name).toBeNull(); // distinct preferences coexist
  });

  test('ordinary task statements do NOT trigger (no false positive)', () => {
    for (const msg of [
      '帮我把这个函数重构一下',
      '现在用的是 8080 端口',
      '这个 bug 怎么修',
      '运行一下测试',
      'what files handle routing?',
    ]) {
      expect(MT.classify(msg).kind).toBe('none');
    }
  });
});

describe('memoryTrigger gates', () => {
  test('KHY_MEMORY_TRIGGER=off ⇒ everything is none', () => {
    process.env.KHY_MEMORY_TRIGGER = 'off';
    expect(MT.classify('记住我叫张三').kind).toBe('none');
    expect(MT.classify('我习惯用 tab').kind).toBe('none');
  });

  test('KHY_PROACTIVE_CAPTURE=off ⇒ explicit still works, proactive suppressed', () => {
    process.env.KHY_PROACTIVE_CAPTURE = 'off';
    expect(MT.classify('记住：用 docker').kind).toBe('explicit');
    expect(MT.classify('我叫王五').kind).toBe('none'); // proactive off
  });

  test('empty / oversized input ⇒ none', () => {
    expect(MT.classify('').kind).toBe('none');
    expect(MT.classify('记住 ' + 'x'.repeat(2100)).kind).toBe('none');
  });
});

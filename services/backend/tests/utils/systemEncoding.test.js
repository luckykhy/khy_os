'use strict';

/**
 * Tests for systemEncoding.getEncodingForBuffer — the deterministic, platform-
 * independent buffer sniffing path. getSystemEncoding() is OS/locale-dependent and
 * exercised indirectly by the spawn encoding tests.
 */

const { getEncodingForBuffer } = require('../../src/utils/systemEncoding');

// 探测失败不得永久锁定:一次瞬时 chcp 失败曾把整个进程钉在「探测失败」上,
// 后续全部回落 utf-8,GBK 控制台字节解出 U+FFFD,同一条乱码告警重复到进程结束。
const LOCALE_ENVS = ['LC_ALL', 'LC_CTYPE', 'LANG'];

function loadWithProbe(probe) {
  let mod;
  jest.isolateModules(() => {
    jest.doMock('child_process', () => ({ execSync: probe }));
    mod = require('../../src/utils/systemEncoding');
  });
  return mod;
}


describe('getEncodingForBuffer', () => {
  test('detects a UTF-16LE BOM', () => {
    expect(getEncodingForBuffer(Buffer.from([0xff, 0xfe, 0x41, 0x00]))).toBe('utf16le');
  });

  test('detects a UTF-8 BOM', () => {
    expect(getEncodingForBuffer(Buffer.from([0xef, 0xbb, 0xbf, 0x41]))).toBe('utf-8');
  });

  test('classifies valid UTF-8 (multibyte) as utf-8', () => {
    expect(getEncodingForBuffer(Buffer.from('你好世界', 'utf8'))).toBe('utf-8');
  });

  test('classifies pure ASCII as utf-8', () => {
    expect(getEncodingForBuffer(Buffer.from('hello world', 'utf8'))).toBe('utf-8');
  });

  test('returns a non-empty encoding name for invalid-UTF-8 bytes (system fallback)', () => {
    // GBK-encoded Chinese is not valid UTF-8 → must reach the system-encoding
    // fallback branch and still yield a usable encoding name (never throws/empty).
    const invalidUtf8 = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]); // GBK "中文"
    const enc = getEncodingForBuffer(invalidUtf8);
    expect(typeof enc).toBe('string');
    expect(enc.length).toBeGreaterThan(0);
  });
});

describe('getSystemEncoding 的失败态只冷却不锁定', () => {
  const saved = {};

  beforeEach(() => {
    // Unix 分支在 locale env 存在时根本不会调探测子进程,先摘掉才能走到失败路径。
    for (const k of LOCALE_ENVS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of LOCALE_ENVS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    jest.dontMock('child_process');
  });

  test('冷却窗口内不重复 fork 探测进程', () => {
    let calls = 0;
    const mod = loadWithProbe(() => {
      calls += 1;
      throw new Error('probe unavailable');
    });
    const now = () => 1_000_000;

    expect(mod.getSystemEncoding({ now })).toBeNull();
    expect(calls).toBe(1);
    // 第二次调用命中冷却,不该再探测一次(getEncodingForBuffer 每块都会调它)。
    expect(mod.getSystemEncoding({ now })).toBeNull();
    expect(calls).toBe(1);
  });

  test('冷却过期后重新探测,瞬时故障可自愈', () => {
    let calls = 0;
    const mod = loadWithProbe(() => {
      calls += 1;
      if (calls === 1) throw new Error('transient timeout');
      return 'Active code page: 936';
    });
    const base = 5_000_000;

    expect(mod.getSystemEncoding({ now: () => base })).toBeNull();
    expect(calls).toBe(1);

    // 60s 冷却期内仍然是失败态
    expect(mod.getSystemEncoding({ now: () => base + 59_000 })).toBeNull();
    expect(calls).toBe(1);

    // 过期后重探 —— 这一次成功,乱码根因随之消失
    const enc = mod.getSystemEncoding({ now: () => base + 61_000 });
    expect(calls).toBe(2);
    // win32 走 chcp 码页表;Unix 走 `locale charmap`,拿到的是整串小写化结果。
    expect(enc === 'gbk' || typeof enc === 'string').toBe(true);
    expect(enc).not.toBeNull();
  });

  test('成功结果仍然永久缓存,不受冷却逻辑影响', () => {
    let calls = 0;
    const mod = loadWithProbe(() => {
      calls += 1;
      return 'Active code page: 65001';
    });
    const first = mod.getSystemEncoding({ now: () => 1 });
    expect(calls).toBe(1);
    expect(mod.getSystemEncoding({ now: () => 1 + 10 * 60_000 })).toBe(first);
    expect(calls).toBe(1);
  });
});

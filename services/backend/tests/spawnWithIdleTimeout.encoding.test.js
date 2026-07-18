'use strict';

/**
 * Regression tests for Windows non-UTF-8 console output decoding.
 *
 * On a Chinese Windows the cmd.exe console emits command output and error text
 * in the OEM code page (GBK/CP936). The previous implementation forced
 * stdout/stderr to UTF-8, turning that text into mojibake and hiding the real
 * error (e.g. "系统找不到指定的路径。") from the agent. These tests lock in that
 * the GBK bytes are now stream-decoded on the Windows path while the Unix /
 * UTF-8 fast path stays byte-for-byte unchanged.
 *
 * The decoding gate depends on `process.platform` and the detected system
 * encoding, so each case loads a fresh module with both mocked.
 */

const GBK_ZHONGWEN_HEX = 'd6d0cec4'; // iconv-lite: GBK encoding of "中文"
const EXPECTED = '中文';

function loadSpawn({ platform, sysEnc }) {
  jest.resetModules();
  jest.doMock('../src/utils/systemEncoding', () => ({
    getSystemEncoding: () => sysEnc,
    getEncodingForBuffer: () => sysEnc || 'utf-8',
    resetEncodingCache: () => {},
  }));
  const platformDesc = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  // eslint-disable-next-line global-require
  const { spawnWithIdleTimeout } = require('../src/utils/spawnWithIdleTimeout');
  return {
    spawnWithIdleTimeout,
    restore() {
      Object.defineProperty(process, 'platform', platformDesc);
      jest.dontMock('../src/utils/systemEncoding');
    },
  };
}

// A child that writes the given hex buffer to stdout in one shot.
function emitArgs(hex) {
  return ['-e', `process.stdout.write(Buffer.from('${hex}','hex'))`];
}

// A child that splits the buffer across two writes, forcing a multibyte
// character to straddle a chunk boundary (first byte, then the rest).
function emitSplitArgs(hex) {
  return [
    '-e',
    `const b=Buffer.from('${hex}','hex');` +
      `process.stdout.write(b.slice(0,1));` +
      `setTimeout(()=>process.stdout.write(b.slice(1)),25);`,
  ];
}

describe('spawnWithIdleTimeout output decoding', () => {
  test('Windows GBK console: GBK bytes decode to correct characters', async () => {
    const { spawnWithIdleTimeout, restore } = loadSpawn({ platform: 'win32', sysEnc: 'gbk' });
    try {
      const r = await spawnWithIdleTimeout(process.execPath, emitArgs(GBK_ZHONGWEN_HEX), { idleMs: 5000 });
      expect(r.code).toBe(0);
      expect(r.stdout).toBe(EXPECTED);
    } finally {
      restore();
    }
  });

  test('Windows GBK console: multibyte char split across chunks still decodes', async () => {
    const { spawnWithIdleTimeout, restore } = loadSpawn({ platform: 'win32', sysEnc: 'gbk' });
    try {
      const r = await spawnWithIdleTimeout(process.execPath, emitSplitArgs(GBK_ZHONGWEN_HEX), { idleMs: 5000 });
      expect(r.stdout).toBe(EXPECTED);
    } finally {
      restore();
    }
  });

  test('Windows UTF-8 console (chcp 65001): unchanged utf8 fast path', async () => {
    const utf8Hex = Buffer.from(EXPECTED, 'utf8').toString('hex');
    const { spawnWithIdleTimeout, restore } = loadSpawn({ platform: 'win32', sysEnc: 'utf-8' });
    try {
      const r = await spawnWithIdleTimeout(process.execPath, emitArgs(utf8Hex), { idleMs: 5000 });
      expect(r.stdout).toBe(EXPECTED);
    } finally {
      restore();
    }
  });

  test('Windows with undetectable code page (null): falls back to utf8 path', async () => {
    const utf8Hex = Buffer.from(EXPECTED, 'utf8').toString('hex');
    const { spawnWithIdleTimeout, restore } = loadSpawn({ platform: 'win32', sysEnc: null });
    try {
      const r = await spawnWithIdleTimeout(process.execPath, emitArgs(utf8Hex), { idleMs: 5000 });
      expect(r.stdout).toBe(EXPECTED);
    } finally {
      restore();
    }
  });

  test('Unix path is never iconv-decoded even if encoding is non-utf8', async () => {
    // On non-win32, GBK bytes are read as utf8 (legacy behavior preserved).
    // They must NOT silently decode to the GBK characters.
    const { spawnWithIdleTimeout, restore } = loadSpawn({ platform: 'linux', sysEnc: 'gbk' });
    try {
      const r = await spawnWithIdleTimeout(process.execPath, emitArgs(GBK_ZHONGWEN_HEX), { idleMs: 5000 });
      expect(r.stdout).not.toBe(EXPECTED);
    } finally {
      restore();
    }
  });
});

describe('smartDecodeWinOutput — multi-candidate OEM fallback', () => {
  // These exercise the pure decoder directly so they run identically on any host.
  // The real-world trigger: `chcp 65001` self-blinds getSystemEncoding() to
  // 'utf-8' (or the probe fails → null), yet cmd built-ins (dir/ver) still emit
  // raw OEM bytes. The fallback must recover them WITHOUT a usable detected page.
  const iconv = require('iconv-lite');

  function load(sysEnc) {
    jest.resetModules();
    jest.doMock('../src/utils/systemEncoding', () => ({
      getSystemEncoding: () => sysEnc,
      getEncodingForBuffer: () => sysEnc || 'utf-8',
      resetEncodingCache: () => {},
    }));
    // eslint-disable-next-line global-require
    const { smartDecodeWinOutput } = require('../src/utils/spawnWithIdleTimeout');
    return {
      smartDecodeWinOutput,
      restore() { jest.dontMock('../src/utils/systemEncoding'); },
    };
  }

  test('detected page utf-8 (chcp self-blind) but bytes are GBK → recovered via candidates', () => {
    const { smartDecodeWinOutput, restore } = load('utf-8');
    try {
      const gbkBuf = iconv.encode('C 盘的卷标', 'gbk');
      expect(smartDecodeWinOutput(gbkBuf)).toBe('C 盘的卷标');
    } finally {
      restore();
    }
  });

  test('undetectable page (null) but bytes are GBK → recovered via candidates', () => {
    const { smartDecodeWinOutput, restore } = load(null);
    try {
      const gbkBuf = iconv.encode('目录 测试', 'gbk');
      expect(smartDecodeWinOutput(gbkBuf)).toBe('目录 测试');
    } finally {
      restore();
    }
  });

  test('genuine UTF-8 bytes are never corrupted by a misapplied OEM decode', () => {
    const { smartDecodeWinOutput, restore } = load('utf-8');
    try {
      const utf8Buf = Buffer.from('中文 directory', 'utf8');
      expect(smartDecodeWinOutput(utf8Buf)).toBe('中文 directory');
    } finally {
      restore();
    }
  });

  test('pure ASCII passes through unchanged regardless of detected page', () => {
    const { smartDecodeWinOutput, restore } = load(null);
    try {
      const ascii = Buffer.from('Volume Serial Number is 04C4-1C6A', 'utf8');
      expect(smartDecodeWinOutput(ascii)).toBe('Volume Serial Number is 04C4-1C6A');
    } finally {
      restore();
    }
  });

  test('empty buffer → empty string', () => {
    const { smartDecodeWinOutput, restore } = load(null);
    try {
      expect(smartDecodeWinOutput(Buffer.alloc(0))).toBe('');
    } finally {
      restore();
    }
  });
});

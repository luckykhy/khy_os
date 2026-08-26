'use strict';

const Table = require('cli-table3');

// Mock heavy/optional dependencies before loading the module
jest.mock('chalk', () => {
  // Build a chainable chalk mock where every property returns itself
  // and calling it as a function returns the input string unchanged.
  function createChalkMock() {
    const fn = (...args) => args.join(' ');
    // All style methods return the same callable mock
    const methods = [
      'bold', 'dim', 'cyan', 'red', 'green', 'yellow', 'blue', 'white',
      'underline', 'italic', 'strikethrough', 'inverse', 'visible',
      'bgRed', 'bgGreen', 'bgYellow', 'bgBlue', 'bgCyan', 'bgWhite',
    ];
    for (const m of methods) {
      fn[m] = fn;
    }
    fn.hex = () => fn;
    fn.rgb = () => fn;
    fn.default = fn;
    return fn;
  }
  return createChalkMock();
});

jest.mock('cli-table3', () => {
  return jest.fn().mockImplementation(() => ({
    push: jest.fn(),
    toString: () => 'mocked-table',
  }));
});

jest.mock('ora', () => jest.fn(() => ({
  start: jest.fn().mockReturnThis(),
  succeed: jest.fn(),
  fail: jest.fn(),
})));

// Suppress console output during tests
beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => {
  console.log.mockRestore();
  console.warn.mockRestore();
});

const fmt = require('../../src/cli/formatters');

describe('formatters', () => {
  describe('displayWidth()', () => {
    test('returns correct width for ASCII strings', () => {
      expect(fmt.displayWidth('hello')).toBe(5);
      expect(fmt.displayWidth('')).toBe(0);
      expect(fmt.displayWidth('abc 123')).toBe(7);
    });

    test('returns double width for CJK characters', () => {
      // Each CJK character occupies 2 columns
      expect(fmt.displayWidth('\u4f60\u597d')).toBe(4); // "你好"
      expect(fmt.displayWidth('\u6d4b\u8bd5')).toBe(4); // "测试"
    });

    test('returns double width for fullwidth forms', () => {
      // FF01 = ！ (fullwidth exclamation mark)
      expect(fmt.displayWidth('\uFF01')).toBe(2);
    });

    test('returns double width for emoji in the Misc Symbols range', () => {
      // 1F600 = 😀 (grinning face) — in the 1F300-1F9FF range
      expect(fmt.displayWidth('\u{1F600}')).toBe(2);
    });

    test('handles mixed ASCII and CJK', () => {
      // "hi\u4f60\u597d" = "hi" (2) + "你好" (4) = 6
      expect(fmt.displayWidth('hi\u4f60\u597d')).toBe(6);
    });

    test('ignores ANSI escape sequences', () => {
      const withAnsi = '\u001b[31mhello\u001b[0m';
      expect(fmt.displayWidth(withAnsi)).toBe(5);
    });

    test('combining diacritical marks have zero width', () => {
      // U+0301 = combining acute accent — zero width
      expect(fmt.displayWidth('e\u0301')).toBe(1);
    });
  });

  describe('padToWidth()', () => {
    test('pads a short string to the target width', () => {
      const result = fmt.padToWidth('hi', 6);
      expect(result).toBe('hi    ');
    });

    test('does not truncate if string is already at target width', () => {
      expect(fmt.padToWidth('abcde', 5)).toBe('abcde');
    });

    test('does not truncate if string exceeds target width', () => {
      const result = fmt.padToWidth('toolong', 3);
      expect(result).toBe('toolong'); // no truncation, just no padding
    });

    test('pads CJK strings accounting for double width', () => {
      // "你" = width 2, target 6 → needs 4 spaces
      const result = fmt.padToWidth('\u4f60', 6);
      expect(fmt.displayWidth(result)).toBe(6);
      expect(result).toBe('\u4f60    ');
    });

    test('accepts a custom fill character', () => {
      const result = fmt.padToWidth('hi', 6, '-');
      expect(result).toBe('hi----');
    });
  });

  describe('truncateToWidth()', () => {
    test('returns the original string if within max width', () => {
      expect(fmt.truncateToWidth('hello', 10)).toBe('hello');
    });

    test('truncates and appends ellipsis when exceeding max width', () => {
      const result = fmt.truncateToWidth('hello world', 8);
      expect(result.endsWith('...')).toBe(true);
      expect(fmt.displayWidth(result)).toBeLessThanOrEqual(8);
    });

    test('handles CJK truncation', () => {
      const cjk = '\u4f60\u597d\u4e16\u754c\u4eba\u6c11'; // "你好世界人民" = width 12
      const result = fmt.truncateToWidth(cjk, 8);
      expect(result.endsWith('...')).toBe(true);
    });
  });

  describe('stripAnsi()', () => {
    test('removes ANSI color codes', () => {
      expect(fmt.stripAnsi('\u001b[31mred\u001b[0m')).toBe('red');
    });

    test('returns plain strings unchanged', () => {
      expect(fmt.stripAnsi('plain')).toBe('plain');
    });
  });

  describe('safeTerminalString()', () => {
    test('removes control characters', () => {
      expect(fmt.safeTerminalString('hello\x00world')).toBe('helloworld');
      expect(fmt.safeTerminalString('a\x07b')).toBe('ab');
    });

    test('preserves newlines and tabs', () => {
      // \n (0x0A) and \t (0x09) should be preserved by the regex
      expect(fmt.safeTerminalString('a\tb\nc')).toBe('a\tb\nc');
    });

    test('returns empty string for falsy input', () => {
      expect(fmt.safeTerminalString(null)).toBe('');
      expect(fmt.safeTerminalString('')).toBe('');
      expect(fmt.safeTerminalString(undefined)).toBe('');
    });
  });

  describe('formatVolume()', () => {
    test('formats volumes over 100 million as yi', () => {
      expect(fmt.formatVolume(1e8)).toBe('1.00\u4ebf');
      expect(fmt.formatVolume(2.5e8)).toBe('2.50\u4ebf');
    });

    test('formats volumes over 10,000 as wan', () => {
      expect(fmt.formatVolume(1e4)).toBe('1.00\u4e07');
      expect(fmt.formatVolume(5e5)).toBe('50.00\u4e07');
    });

    test('formats small volumes as plain numbers', () => {
      expect(fmt.formatVolume(999)).toBe('999');
    });

    test('returns "0" for falsy input', () => {
      expect(fmt.formatVolume(0)).toBe('0');
      expect(fmt.formatVolume(null)).toBe('0');
    });
  });

  describe('formatCurrency()', () => {
    test('prefixes with yen symbol', () => {
      expect(fmt.formatCurrency(100)).toMatch(/^¥/);
    });

    test('has two decimal places', () => {
      expect(fmt.formatCurrency(1234.5)).toMatch(/\d+\.\d{2}$/);
    });
  });

  describe('printTable()', () => {
    test('does not throw with valid input', () => {
      expect(() => {
        fmt.printTable(['Name', 'Value'], [['a', '1'], ['b', '2']]);
      }).not.toThrow();
    });

    test('does not throw with empty rows', () => {
      expect(() => {
        fmt.printTable(['Col'], []);
      }).not.toThrow();
    });

    test('strips ANSI sequences in non-interactive output mode', () => {
      const prevIsTTY = process.stdout.isTTY;
      const prevNoColor = process.env.NO_COLOR;
      const prevForceColor = process.env.FORCE_COLOR;
      process.stdout.isTTY = false;
      process.env.NO_COLOR = '1';
      process.env.FORCE_COLOR = '0';

      fmt.printTable(['Name', 'Value'], [['a', '1']]);

      expect(Table).toHaveBeenCalledWith(expect.objectContaining({
        head: ['Name', 'Value'],
        style: expect.objectContaining({
          head: [],
          border: [],
        }),
      }));
      const rendered = console.log.mock.calls.at(-1)?.[0] || '';
      expect(rendered).toBe('mocked-table');

      process.stdout.isTTY = prevIsTTY;
      if (prevNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = prevNoColor;
      if (prevForceColor === undefined) delete process.env.FORCE_COLOR;
      else process.env.FORCE_COLOR = prevForceColor;
    });
  });

  describe('getRandomFarewell()', () => {
    test('returns a non-empty string', () => {
      const farewell = fmt.getRandomFarewell();
      expect(typeof farewell).toBe('string');
      expect(farewell.length).toBeGreaterThan(0);
    });
  });

  describe('exported constants', () => {
    test('MASCOT_MINI is a string', () => {
      expect(typeof fmt.MASCOT_MINI).toBe('string');
    });

    test('ICON constants are strings', () => {
      for (const key of ['ICON_PROMPT', 'ICON_AI', 'ICON_BOT', 'ICON_CHART', 'ICON_GEAR', 'ICON_ROCKET', 'ICON_KEY', 'ICON_DB', 'ICON_SEARCH', 'ICON_HEART', 'ICON_PLUG', 'ICON_BULL', 'ICON_BEAR', 'ICON_GATEWAY']) {
        expect(typeof fmt[key]).toBe('string');
      }
    });
  });

  describe('printHelp() column alignment', () => {
    const stringWidth = fmt.displayWidth;

    function renderHelpRows() {
      const calls = [];
      console.log.mockImplementation((line) => {
        calls.push(typeof line === 'string' ? line : String(line ?? ''));
      });
      try {
        fmt.printHelp();
      } finally {
        console.log.mockImplementation(() => {});
      }
      return calls.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
    }

    test('命令说明列在中英文命令后保持同一视觉列', () => {
      const rows = renderHelpRows();
      const coreDescriptions = new Set(['应用管理', '服务管理', '数据库', '交互辅助']);
      const descOffsets = [];
      for (const r of rows) {
        const m = r.match(/^ {4}(\S.*?\s{2,})(\S.*)$/);
        if (!m || !coreDescriptions.has(m[2])) continue;
        const descStart = r.lastIndexOf(m[2]);
        descOffsets.push(stringWidth(r.slice(0, descStart)));
      }
      expect(descOffsets).toHaveLength(4);
      expect([...new Set(descOffsets)]).toHaveLength(1);
    });
  });

  describe('printBacktestResult() column alignment', () => {
    const stringWidth = fmt.displayWidth;

    function renderRows() {
      const calls = [];
      console.log.mockImplementation((line) => {
        calls.push(typeof line === 'string' ? line : String(line ?? ''));
      });
      try {
        fmt.printBacktestResult({
          symbol: 'AAPL', startDate: '2020', endDate: '2021',
          initialCapital: 1e5, finalCapital: 12e4, totalReturn: 0.2,
          annualizedReturn: 0.1, maxDrawdown: -0.05, sharpeRatio: 1.23,
          winRate: 0.6, totalTrades: 42, winningTrades: 25,
          losingTrades: 17, tradingDays: 200,
        });
      } finally {
        console.log.mockImplementation(() => {});
      }
      return calls.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
    }

    test('value column aligns across mixed-width CJK labels', () => {
      const rows = renderRows();
      // 无框数据行以两个空格缩进开头;值列仍由显示宽度补齐,不依赖边框字符。
      const valueOffsets = [];
      for (const r of rows) {
        const m = r.match(/^ {2}(\S.*?)\s+(\S.*)$/);
        if (!m || !/[一-鿿]/.test(m[1])) continue;
        const valCol = r.lastIndexOf(m[2]);
        valueOffsets.push(stringWidth(r.slice(0, valCol)));
      }
      expect(valueOffsets.length).toBeGreaterThan(5);
      expect([...new Set(valueOffsets)]).toHaveLength(1);
    });
  });
});

// printInfo 的 label 前缀:启动屏一屏能冒出七八条通知,全挂同一个 ℹ 就看不出
// 哪条讲登录、哪条讲版本。补齐必须按显示宽度算 —— 汉字 2 列、英文 1 列,按
// String.length 补会让中英混排的标签把正文顶歪,而这种歪只有人眼能发现。
describe('printInfo() 场景词前缀', () => {
  function render(msg, label) {
    const calls = [];
    console.log.mockImplementation((line) => calls.push(line));
    try {
      fmt.printInfo(msg, label);
    } finally {
      console.log.mockImplementation(() => {});
    }
    return calls.at(-1) || '';
  }

  test('不传 label 时逐字节保持原样（全仓两千多处调用不受影响）', () => {
    expect(render('X')).toBe('  ℹ X');
  });

  test('空串 / 非字符串 label 一律回落到原样，不吐出半截前缀', () => {
    for (const bad of ['', null, undefined, 0, 42, {}, []]) {
      expect(render('X', bad)).toBe('  ℹ X');
    }
  });

  test('中文 label 渲染成「两空格 + 词 + 两空格」', () => {
    expect(render('mfplg075', '登录')).toBe('  登录  mfplg075');
  });

  test('中英文 label 混排后正文都落在同一列', () => {
    const cols = new Set();
    for (const label of ['登录', '版本', '更新', '来源', 'IDE', 'ok', 'x']) {
      const line = render('X', label);
      cols.add(fmt.displayWidth(line.slice(0, line.lastIndexOf('X'))));
    }
    expect([...cols]).toEqual([fmt.NOTICE_LABEL_WIDTH + 4]);
  });

  test('超宽 label 不会把正文吞掉，只是不再对齐（宁可歪也不能截断）', () => {
    expect(render('X', '这是一个很长的标签')).toContain('这是一个很长的标签');
    expect(render('X', '这是一个很长的标签')).toMatch(/X$/);
  });
});

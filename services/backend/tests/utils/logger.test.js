/**
 * Unit tests for logger utility.
 *
 * The logger is a Winston instance exported from @khy/shared/utils/logger.
 * We verify it exposes the standard log methods and is properly configured.
 */

const logger = require('../../src/utils/logger');

describe('logger utility', () => {
  test('exports a truthy value', () => {
    expect(logger).toBeTruthy();
  });

  test('is an object', () => {
    expect(typeof logger).toBe('object');
  });

  test('has info method', () => {
    expect(typeof logger.info).toBe('function');
  });

  test('has error method', () => {
    expect(typeof logger.error).toBe('function');
  });

  test('has warn method', () => {
    expect(typeof logger.warn).toBe('function');
  });

  test('has debug method', () => {
    expect(typeof logger.debug).toBe('function');
  });

  test('info method can be called without throwing', () => {
    expect(() => logger.info('test log message')).not.toThrow();
  });

  test('error method can be called without throwing', () => {
    expect(() => logger.error('test error message')).not.toThrow();
  });

  test('has a level property', () => {
    expect(logger.level).toBeDefined();
    expect(typeof logger.level).toBe('string');
  });
});

// setConsoleLevel 存在的理由:CLI 启动时内部审计日志会以 `[info] [DB Health] …` 打进
// 用户终端并撞碎引导进度行。降的必须只是控制台音量 —— 文件 transport 一律不能动,
// 否则日志就真的丢了,而不是「不显示」。
describe('logger.setConsoleLevel', () => {
  function fakeLogger() {
    return {
      transports: [
        { name: 'dailyRotateFile', level: 'info' },
        { name: 'dailyRotateFile', level: 'error' },
        { name: 'console' },
      ],
    };
  }

  test('只调控制台 transport，文件 transport 原级别不变', () => {
    const target = fakeLogger();
    expect(logger.setConsoleLevel('warn', target)).toBe(true);
    expect(target.transports.map((t) => t.level)).toEqual(['info', 'error', 'warn']);
  });

  test('没有控制台 transport 时如实返回 false（生产模式下不挂 Console）', () => {
    const target = { transports: [{ name: 'dailyRotateFile', level: 'info' }] };
    expect(logger.setConsoleLevel('warn', target)).toBe(false);
  });

  test('目标畸形也不抛：启动路径绝不能被音量调节拖垮', () => {
    expect(() => logger.setConsoleLevel('warn', null)).not.toThrow();
    expect(logger.setConsoleLevel('warn', {})).toBe(false);
  });

  test('真实 logger 上控制台 transport 被降到 warn，info 不再落终端', () => {
    const console3 = logger.transports.find((t) => t.name === 'console');
    if (!console3) {
      // NODE_ENV=production 下 shared 不挂 Console transport，此断言无对象可验。
      expect(logger.setConsoleLevel('warn')).toBe(false);
      return;
    }
    const before = console3.level;
    try {
      expect(logger.setConsoleLevel('warn')).toBe(true);
      expect(console3.level).toBe('warn');
    } finally {
      console3.level = before;
    }
  });
});

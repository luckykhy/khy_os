'use strict';

/**
 * notificationPort.test.js — unit tests for the background-event → TUI
 * notification port (services/backend/src/services/notificationPort.js).
 *
 * Covers: register/emit happy path, unregistered degrade (false), throwing
 * renderer degrade, adjacent same-type merge, KHY_NOTIFY_MAX cap, invalid
 * level normalization, and _resetForTest.
 */

const port = require('../../services/backend/src/services/notificationPort');

describe('notificationPort — register/emit 正常路径', () => {
  beforeEach(() => {
    port._resetForTest();
    delete process.env.KHY_NOTIFY_MAX;
  });

  it('注册渲染器后 emit 返回 true 且渲染器收到归一化条目', () => {
    const seen = [];
    port.registerNotificationRenderer((n) => seen.push(n));
    const ok = port.emitNotification({
      type: 'background_task',
      level: 'info',
      title: '后台任务完成：build',
      detail: '构建成功',
      timestamp: 12345,
    });
    expect(ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      type: 'background_task',
      level: 'info',
      title: '后台任务完成：build',
      detail: '构建成功',
      timestamp: 12345,
      count: 1,
    });
  });

  it('timestamp 缺省时自动补 Date.now()', () => {
    port.registerNotificationRenderer(() => {});
    const before = Date.now();
    port.emitNotification({ type: 'turn_complete', title: 'x' });
    const after = Date.now();
    const [entry] = port.getRecentNotifications();
    expect(entry.timestamp).toBeGreaterThanOrEqual(before);
    expect(entry.timestamp).toBeLessThanOrEqual(after);
  });

  it('传非函数清空注册 → 后续 emit 返回 false', () => {
    port.registerNotificationRenderer(() => {});
    port.registerNotificationRenderer(null);
    expect(port.emitNotification({ type: 'a', title: 't' })).toBe(false);
  });
});

describe('notificationPort — 降级路径', () => {
  beforeEach(() => {
    port._resetForTest();
    delete process.env.KHY_NOTIFY_MAX;
  });

  it('未注册渲染器 → emit 返回 false 但仍入缓冲', () => {
    expect(port.emitNotification({ type: 'a', title: 't' })).toBe(false);
    expect(port.getRecentNotifications()).toHaveLength(1);
  });

  it('渲染器抛错 → emit 返回 false 不抛出', () => {
    port.registerNotificationRenderer(() => { throw new Error('boom'); });
    expect(() => port.emitNotification({ type: 'a', title: 't' })).not.toThrow();
    expect(port.emitNotification({ type: 'b', title: 't2' })).toBe(false);
  });

  it('非对象入参不抛出', () => {
    expect(() => port.emitNotification(null)).not.toThrow();
    expect(() => port.emitNotification('oops')).not.toThrow();
  });
});

describe('notificationPort — 相邻同 type 合并', () => {
  beforeEach(() => {
    port._resetForTest();
    delete process.env.KHY_NOTIFY_MAX;
  });

  it('相邻同 type 合并为一条：计数递增 + 最新消息 + title 后缀', () => {
    port.emitNotification({ type: 'background_task', title: '后台任务完成：a', detail: 'A' });
    port.emitNotification({ type: 'background_task', title: '后台任务完成：b', detail: 'B' });
    port.emitNotification({ type: 'background_task', title: '后台任务完成：c', detail: 'C' });
    const buf = port.getRecentNotifications();
    expect(buf).toHaveLength(1);
    expect(buf[0].count).toBe(3);
    expect(buf[0].title).toBe('后台任务完成：c（共 3 条）');
    expect(buf[0].detail).toBe('C');
  });

  it('不同 type 交替不合并', () => {
    port.emitNotification({ type: 'background_task', title: 'a' });
    port.emitNotification({ type: 'turn_complete', title: 'b' });
    port.emitNotification({ type: 'background_task', title: 'c' });
    const buf = port.getRecentNotifications();
    expect(buf).toHaveLength(3);
    expect(buf.map((n) => n.count)).toEqual([1, 1, 1]);
  });
});

describe('notificationPort — KHY_NOTIFY_MAX 缓冲上限', () => {
  beforeEach(() => {
    port._resetForTest();
    delete process.env.KHY_NOTIFY_MAX;
  });
  afterEach(() => {
    delete process.env.KHY_NOTIFY_MAX;
  });

  it('默认保留最近 5 条（丢最旧）', () => {
    for (let i = 1; i <= 7; i++) {
      port.emitNotification({ type: `t${i}`, title: `n${i}` });
    }
    const buf = port.getRecentNotifications();
    expect(buf).toHaveLength(port.DEFAULT_NOTIFY_MAX);
    expect(buf[0].title).toBe('n3');
    expect(buf[buf.length - 1].title).toBe('n7');
  });

  it('KHY_NOTIFY_MAX 覆盖上限', () => {
    process.env.KHY_NOTIFY_MAX = '2';
    for (let i = 1; i <= 4; i++) {
      port.emitNotification({ type: `t${i}`, title: `n${i}` });
    }
    const buf = port.getRecentNotifications();
    expect(buf).toHaveLength(2);
    expect(buf.map((n) => n.title)).toEqual(['n3', 'n4']);
  });

  it('KHY_NOTIFY_MAX 低于下限 1 时按 1 处理', () => {
    process.env.KHY_NOTIFY_MAX = '0';
    port.emitNotification({ type: 'a', title: 'x' });
    port.emitNotification({ type: 'b', title: 'y' });
    const buf = port.getRecentNotifications();
    expect(buf).toHaveLength(1);
    expect(buf[0].title).toBe('y');
  });

  it('非法 KHY_NOTIFY_MAX 回落默认值', () => {
    process.env.KHY_NOTIFY_MAX = 'abc';
    for (let i = 1; i <= 6; i++) {
      port.emitNotification({ type: `t${i}`, title: `n${i}` });
    }
    expect(port.getRecentNotifications()).toHaveLength(port.DEFAULT_NOTIFY_MAX);
  });
});

describe('notificationPort — 非法 level 归一', () => {
  beforeEach(() => {
    port._resetForTest();
    delete process.env.KHY_NOTIFY_MAX;
  });

  it("非法 level 归一为 'info'，合法 level 原样保留", () => {
    port.emitNotification({ type: 'a', level: 'fatal', title: 'x' });
    port.emitNotification({ type: 'b', level: 'warn', title: 'y' });
    port.emitNotification({ type: 'c', level: 'error', title: 'z' });
    const buf = port.getRecentNotifications();
    expect(buf.map((n) => n.level)).toEqual(['info', 'warn', 'error']);
  });

  it('缺省 level 归一为 info', () => {
    port.emitNotification({ type: 'a', title: 'x' });
    expect(port.getRecentNotifications()[0].level).toBe('info');
  });
});

describe('notificationPort — _resetForTest 与浅拷贝', () => {
  it('_resetForTest 清空注册与缓冲', () => {
    port.registerNotificationRenderer(() => {});
    port.emitNotification({ type: 'a', title: 'x' });
    port._resetForTest();
    expect(port.getRecentNotifications()).toEqual([]);
    expect(port.emitNotification({ type: 'a', title: 'x' })).toBe(false);
  });

  it('getRecentNotifications 返回浅拷贝（改动不影响内部缓冲）', () => {
    port._resetForTest();
    port.emitNotification({ type: 'a', title: 'x' });
    const copy = port.getRecentNotifications();
    copy.pop();
    expect(port.getRecentNotifications()).toHaveLength(1);
  });
});

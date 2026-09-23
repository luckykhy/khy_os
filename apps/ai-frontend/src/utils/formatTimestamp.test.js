import { describe, it, expect } from 'vitest';
import { formatTime } from './formatTimestamp';

/**
 * formatTime — 锁列表视图共用的时间戳格式化叶子：
 * 空值 → '-'，合法值 → 本机 toLocaleString，与 Projects/Workflows 两处的
 * 抽取前行为逐字节一致。
 */

describe('formatTime', () => {
  it('falsy 输入（null/undefined/0/空串）→ "-"', () => {
    for (const v of [null, undefined, 0, '']) {
      expect(formatTime(v)).toBe('-');
    }
  });

  it('数字时间戳 → 本机格式化的同一日期（与参照实现比对，不锁死 locale 文案）', () => {
    const ts = Date.parse('2024-01-02T03:04:05Z');
    expect(formatTime(ts)).toBe(new Date(ts).toLocaleString());
  });

  it('合法字符串时间戳 → 与 Date 参照一致', () => {
    expect(formatTime('2024-01-02T03:04:05Z')).toBe(
      new Date('2024-01-02T03:04:05Z').toLocaleString()
    );
  });

  it('非法时间字符串 → 原样 String(t)（catch 兜底）', () => {
    // toLocaleString 对 Invalid Date 返回 "Invalid Date"；锁定的是「不抛、不静默成 -」
    const out = formatTime('not-a-date');
    expect(out).toBe(new Date('not-a-date').toLocaleString());
    expect(out).not.toBe('-');
  });
});

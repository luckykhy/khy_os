'use strict';

const { ProgressFeedback, withTimeout, formatElapsed, formatETA } = require('../../src/utils/userFeedback');

describe('userFeedback', () => {
  describe('ProgressFeedback', () => {
    test('creates instance with default options', () => {
      const feedback = new ProgressFeedback();
      expect(feedback.isRunning).toBe(false);
    });

    test('starts and stops', () => {
      const feedback = new ProgressFeedback();
      feedback.start('test');
      expect(feedback.isRunning).toBe(true);
      feedback.stop();
      expect(feedback.isRunning).toBe(false);
    });

    test('updates progress', () => {
      const feedback = new ProgressFeedback();
      feedback.start('test');
      feedback.update({ percent: 50 });
      expect(feedback.lastProgress.percent).toBe(50);
      feedback.stop();
    });

    test('ends with result', () => {
      const feedback = new ProgressFeedback();
      feedback.start('test');
      feedback.end({ success: true });
      expect(feedback.isRunning).toBe(false);
    });

    test('gets elapsed time', () => {
      const feedback = new ProgressFeedback();
      feedback.start('test');
      expect(feedback.getElapsed()).toBeGreaterThanOrEqual(0);
      expect(feedback.getElapsedSeconds()).toBeGreaterThanOrEqual(0);
      feedback.stop();
    });
  });

  describe('withTimeout', () => {
    test('resolves before timeout', async () => {
      const result = await withTimeout(Promise.resolve('success'), { timeout: 1000 });
      expect(result).toBe('success');
    });

    test('rejects on timeout', async () => {
      const slowPromise = new Promise((resolve) => setTimeout(resolve, 5000));
      await expect(withTimeout(slowPromise, { timeout: 50 })).rejects.toThrow('超时');
    });
  });

  describe('formatElapsed', () => {
    test('formats milliseconds', () => {
      expect(formatElapsed(500)).toBe('< 1s');
    });

    test('formats seconds', () => {
      expect(formatElapsed(5000)).toBe('5s');
    });

    test('formats minutes', () => {
      expect(formatElapsed(65000)).toBe('1m 5s');
    });
  });

  describe('formatETA', () => {
    test('returns calculating for no progress', () => {
      expect(formatETA(5000, 0)).toBe('计算中...');
    });

    test('returns soon for negative remaining', () => {
      expect(formatETA(1000, 1)).toBe('即将完成');
    });

    test('formats remaining time', () => {
      expect(formatETA(5000, 0.5)).toContain('约');
    });
  });
});

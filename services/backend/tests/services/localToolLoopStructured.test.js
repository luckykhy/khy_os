'use strict';
const loop = require('../../src/services/localToolLoop');
const ON = () => { process.env.KHY_LOCAL_STRUCTURED = '1'; };
// ── renderStructuredSteps ────────────────────────────────────────────────────

describe('Local Tool Loop Structured', () => {
  test('renderStructuredSteps emits ordered phase-labelled sections', async () => {
      ON();
      const steps = [
        { name: 'Read', params: { file_path: 'a.txt' }, phase: 'read', result: { success: true, content: '旧内容' } },
        { name: 'Edit', params: { file_path: 'a.txt' }, phase: 'write', result: { success: true, path: 'a.txt', changed: true } },
        { name: 'Read', params: { file_path: 'a.txt' }, phase: 'verify', result: { success: true, content: '新内容' } },
      ];
      const out = loop.renderStructuredSteps(steps, '把 a.txt 改一下再读回');
      expect(out).toMatch(/# 本地顺序执行结果/);
      expect(out).toMatch(/第 1 步 · 读取 · Read a\.txt/);
      expect(out).toMatch(/第 2 步 · 写入 · Edit a\.txt/);
      expect(out).toMatch(/第 3 步 · 验证 · Read a\.txt/);
      // order preserved: read section before write section before verify section
      expect(out.indexOf('第 1 步').toBeTruthy() < out.indexOf('第 2 步'));
      expect(out.indexOf('第 2 步').toBeTruthy() < out.indexOf('第 3 步'));
      // meta footer marks no-model + local
      expect(out).toMatch(/本地 · 无模型/);
      expect(out).toMatch(/先读后写 \/ 先写再读/);
  });

  test('renderStructuredSteps returns empty when all steps failed/denied', async () => {
      ON();
      const steps = [
        { name: 'Edit', params: { file_path: 'x' }, phase: 'write', result: { denied: true, error: '权限不足' } },
      ];
      expect(loop.renderStructuredSteps(steps, 'q')).toBe('');
  });

  test('renderStructuredSteps returns empty when disabled', async () => {
      process.env.KHY_LOCAL_STRUCTURED = '0';
      const steps = [{ name: 'Read', params: { file_path: 'a' }, phase: 'read', result: { success: true, content: 'x' } }];
      expect(loop.renderStructuredSteps(steps, 'q')).toBe('');
      ON();
  });

});

'use strict';
/**
 * permissionReply — 权限回复词识别叶子单测(node:test)。
 *
 * 锁定 KHY_PERMISSION_REPLY_TOKENS(默认开)管的 classifyPermissionReply:
 *   - 中文/英文自然肯定词 → 'allow';信任/总是类 → 'allow-always';否定 → 'deny';
 *   - 否定优先(不允许/不批准/不确认 → deny,绝不因含 allow 子串误判);
 *   - 全角折半角(NFKC);空串/乱码 → null(fail-closed,call-site 维持 default-deny);
 *   - 门控关 → 恒 null(逐字节回退)。
 */
const { classifyPermissionReply, permissionReplyEnabled } = require('../../src/cli/permissionReply');
const ON = {}; // 未设 → 默认开
const OFF = { KHY_PERMISSION_REPLY_TOKENS: 'off' };

describe('Permission Reply', () => {
  test('allow: 中文自然肯定词', () => {
      for (const w of ['是', '是的', '好', '好的', '可以', '行', '同意', '批准', '允许', '确认', '对', '嗯', '继续', '执行']) {
        expect(classifyPermissionReply(w)).toBe(ON);
      }
  });

  test('allow: 英文自然肯定词', () => {
      for (const w of ['y', 'yes', 'ok', 'okay', 'sure', 'yep', 'yeah', 'approve', 'approved', 'allow', 'proceed', 'continue']) {
        expect(classifyPermissionReply(w)).toBe(ON);
      }
  });

  test('allow-always: 信任/总是类(在 allow 之前)', () => {
      for (const w of ['信任', '总是', '一直', '永久', '始终', '永远', 'always', 'trust', 'a']) {
        expect(classifyPermissionReply(w)).toBe(ON);
      }
  });

  test('allow-always: 「总是允许」含「允许」仍判 always(顺序正确)', () => {
      expect(classifyPermissionReply('总是允许')).toBe(ON);
  });

  test('deny: 中文/英文否定词', () => {
      for (const w of ['不', '否', '别', '拒绝', '取消', '算了', '放弃', '停', 'no', 'n', 'nope', 'cancel', 'deny', 'stop', 'reject', 'abort']) {
        expect(classifyPermissionReply(w)).toBe(ON);
      }
  });

  test('否定优先: 「不允许」「不批准」「不确认」→ deny(不因含 allow 子串误判)', () => {
      expect(classifyPermissionReply('不允许')).toBe(ON);
      expect(classifyPermissionReply('不批准')).toBe(ON);
      expect(classifyPermissionReply('不确认')).toBe(ON);
      expect(classifyPermissionReply('不要')).toBe(ON);
  });

  test('NFKC: 全角 １/Ｙ → allow', () => {
      expect(classifyPermissionReply('１')).toBe(ON);
      expect(classifyPermissionReply('Ｙ')).toBe(ON);
  });

  test('null: 空串/纯空白/乱码 → null(fail-closed)', () => {
      expect(classifyPermissionReply('')).toBe(ON);
      expect(classifyPermissionReply('   ')).toBe(ON);
      expect(classifyPermissionReply('asdfgh')).toBe(ON);
      expect(classifyPermissionReply(null)).toBe(ON);
      expect(classifyPermissionReply(undefined)).toBe(ON);
  });

  test('门控关: KHY_PERMISSION_REPLY_TOKENS=off → 恒 null(字节回退)', () => {
      expect(permissionReplyEnabled(OFF)).toBe(false);
      for (const w of ['同意', '批准', '不允许', 'approve', 'no', '总是']) {
        expect(classifyPermissionReply(w)).toBe(OFF);
      }
  });

  test('门控默认: 未设/空值 → 开', () => {
      expect(permissionReplyEnabled({})).toBe(true);
      expect(permissionReplyEnabled({ KHY_PERMISSION_REPLY_TOKENS: '' })).toBe(true);
      expect(permissionReplyEnabled({ KHY_PERMISSION_REPLY_TOKENS: '1' })).toBe(true);
  });

});

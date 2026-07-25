'use strict';

/**
 * uiPrompt — inquirer→FormFlow translation bridge. The pure core
 * (translateQuestion / inquirerToFormSpec) needs no ink/React, so it runs under
 * the default jest runtime. promptCompat's routing (native vs inquirer fallback)
 * is exercised with a registered fake askForm and a mocked inquirer.
 */

// Mock inquirer so the classic-fallback path is observable without a real TTY.
// jest requires the factory's captured variable to be `mock`-prefixed.
const mockInquirerPrompt = jest.fn(async () => ({ mocked: true }));
jest.mock('inquirer', () => ({ prompt: (...a) => mockInquirerPrompt(...a) }), { virtual: true });

const uiPrompt = require('../../src/cli/uiPrompt');
const { translateQuestion, inquirerToFormSpec, promptCompat, register, unregister, isTuiActive } = uiPrompt;

afterEach(() => {
  unregister();
  delete process.env.KHY_INK_TUI_ACTIVE;
  mockInquirerPrompt.mockClear();
});

describe('translateQuestion', () => {
  test('input keeps label, default and validate', () => {
    const v = (s) => s.length > 0 || 'required';
    const t = translateQuestion({ type: 'input', name: 'u', message: '用户名:', default: 'abc', validate: v });
    expect(t.ok).toBe(true);
    expect(t.field).toMatchObject({ name: 'u', label: '用户名:', type: 'input', defaultValue: 'abc' });
    expect(t.field.validate).toBe(v);
  });

  test('password preserves the mask', () => {
    const t = translateQuestion({ type: 'password', name: 'p', message: '密码:', mask: '*' });
    expect(t.field).toMatchObject({ type: 'password', mask: '*' });
  });

  test('confirm becomes a 是/否 select with boolean coercion, default-yes first', () => {
    const t = translateQuestion({ type: 'confirm', name: 'go', message: '继续?', default: true });
    expect(t.field.type).toBe('select');
    expect(t.field.choices[0]).toEqual({ name: '是', value: true });
    expect(t.field.__coerce).toBe('boolean');
  });

  test('confirm default:false puts 否 first', () => {
    const t = translateQuestion({ type: 'confirm', name: 'rm', message: '删除?', default: false });
    expect(t.field.choices[0]).toEqual({ name: '否', value: false });
  });

  test('list normalizes string and {name,value} choices', () => {
    const t = translateQuestion({
      type: 'list', name: 'env', message: '环境:',
      choices: ['dev', { name: '生产', value: 'prod' }],
    });
    expect(t.field).toMatchObject({ type: 'select' });
    expect(t.field.choices).toEqual([
      { name: 'dev', value: 'dev' },
      { name: '生产', value: 'prod' },
    ]);
    expect(t.field.multi).toBeUndefined();
  });

  test('checkbox marks the field multi:true', () => {
    const t = translateQuestion({ type: 'checkbox', name: 'feats', message: '功能:', choices: ['a', 'b'] });
    expect(t.field.multi).toBe(true);
    expect(t.field.type).toBe('select');
  });

  test('number coerces and validates numericness', () => {
    const t = translateQuestion({ type: 'number', name: 'n', message: '数量:' });
    expect(t.field.__coerce).toBe('number');
    expect(t.field.validate('abc')).toBe('请输入有效数字');
    expect(t.field.validate('42')).toBe(true);
  });

  test('drops separators from list choices', () => {
    const t = translateQuestion({
      type: 'list', name: 'x', message: 'm',
      choices: ['a', { type: 'separator' }, 'b'],
    });
    expect(t.field.choices).toEqual([{ name: 'a', value: 'a' }, { name: 'b', value: 'b' }]);
  });

  test('rejects unsupported types', () => {
    expect(translateQuestion({ type: 'editor', name: 'e', message: 'm' }).ok).toBe(false);
    expect(translateQuestion({ type: 'expand', name: 'e', message: 'm' }).ok).toBe(false);
  });

  test('rejects questions carrying unsupported features (when/filter)', () => {
    expect(translateQuestion({ type: 'input', name: 'a', message: 'm', when: () => true }).ok).toBe(false);
    expect(translateQuestion({ type: 'input', name: 'a', message: 'm', filter: (x) => x }).ok).toBe(false);
  });

  test('ignores cosmetic-only keys (pageSize/loop/suffix/prefix) — no fallback', () => {
    // These never change the collected answer, so a list carrying them must
    // still translate natively rather than topple the TUI via inquirer fallback.
    const t = translateQuestion({
      type: 'list', name: 'a', message: 'm',
      choices: ['x', 'y'], pageSize: 16, loop: false, suffix: ' >', prefix: '? ',
    });
    expect(t.ok).toBe(true);
    expect(t.field.choices.map((c) => c.value)).toEqual(['x', 'y']);
  });

  test('evaluates a function message against answers', () => {
    const t = translateQuestion({ type: 'input', name: 'a', message: (ans) => `hi ${ans.who || '?'}` }, { who: 'X' });
    expect(t.field.label).toBe('hi X');
  });
});

describe('inquirerToFormSpec', () => {
  test('translates a whole batch and records coercions', () => {
    const r = inquirerToFormSpec([
      { type: 'input', name: 'u', message: '用户名:' },
      { type: 'password', name: 'p', message: '密码:' },
      { type: 'confirm', name: 'ok', message: '确认?', default: true },
    ]);
    expect(r.ok).toBe(true);
    expect(r.spec.fields.map((f) => f.name)).toEqual(['u', 'p', 'ok']);
    expect(r.coerce).toEqual({ ok: 'boolean' });
    // __coerce is stripped off the field once recorded in the coerce map.
    expect(r.spec.fields.every((f) => !('__coerce' in f))).toBe(true);
  });

  test('all-or-nothing: one unsupported question rejects the batch', () => {
    const r = inquirerToFormSpec([
      { type: 'input', name: 'u', message: 'm' },
      { type: 'editor', name: 'big', message: 'm' },
    ]);
    expect(r.ok).toBe(false);
  });

  test('accepts a single question object (not just an array)', () => {
    const r = inquirerToFormSpec({ type: 'input', name: 'x', message: 'm' });
    expect(r.ok).toBe(true);
    expect(r.spec.fields).toHaveLength(1);
  });
});

describe('isTuiActive', () => {
  test('requires BOTH a registered askForm and the env flag', () => {
    expect(isTuiActive()).toBe(false);
    register(async () => ({}));
    expect(isTuiActive()).toBe(false); // env flag still missing
    process.env.KHY_INK_TUI_ACTIVE = '1';
    expect(isTuiActive()).toBe(true);
    unregister();
    expect(isTuiActive()).toBe(false); // registration gone
  });
});

describe('promptCompat routing', () => {
  test('native path: confirm answer is coerced to a boolean', async () => {
    process.env.KHY_INK_TUI_ACTIVE = '1';
    const askForm = jest.fn(async () => ({ ok: true })); // select returns the raw value
    register(askForm);
    const answers = await promptCompat([{ type: 'confirm', name: 'ok', message: '确认?', default: true }]);
    expect(askForm).toHaveBeenCalledTimes(1);
    expect(answers).toEqual({ ok: true });
    expect(mockInquirerPrompt).not.toHaveBeenCalled();
  });

  test('native cancel (Esc) resolves to empty answers, never inquirer', async () => {
    process.env.KHY_INK_TUI_ACTIVE = '1';
    register(async () => null); // Esc
    const answers = await promptCompat([{ type: 'input', name: 'u', message: 'm' }]);
    expect(answers).toEqual({});
    expect(mockInquirerPrompt).not.toHaveBeenCalled();
  });

  test('falls back to inquirer when the TUI is not active', async () => {
    const answers = await promptCompat([{ type: 'input', name: 'u', message: 'm' }]);
    expect(mockInquirerPrompt).toHaveBeenCalledTimes(1);
    expect(answers).toEqual({ mocked: true });
  });

  test('falls back to inquirer when a question is untranslatable, even under TUI', async () => {
    process.env.KHY_INK_TUI_ACTIVE = '1';
    const askForm = jest.fn(async () => ({}));
    register(askForm);
    await promptCompat([{ type: 'editor', name: 'big', message: 'm' }]);
    expect(askForm).not.toHaveBeenCalled();
    expect(mockInquirerPrompt).toHaveBeenCalledTimes(1);
  });
});

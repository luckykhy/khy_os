'use strict';

/**
 * selectMenu — when the Ink TUI owns the terminal it must collect choices through
 * the native uiPrompt bridge (promptCompat → FormFlow) instead of its own
 * raw-readline Select, which would topple the managed UI. These tests register a
 * fake askForm + the env flag so isTuiActive() is true, then assert selectMenu
 * routes through it (the readline path is never reached).
 */

const uiPrompt = require('../../src/cli/uiPrompt');
const { selectMenu } = require('../../src/cli/ui/inkComponents');

afterEach(() => {
  uiPrompt.unregister();
  delete process.env.KHY_INK_TUI_ACTIVE;
});

function activate(askForm) {
  process.env.KHY_INK_TUI_ACTIVE = '1';
  uiPrompt.register(askForm);
}

test('single-select routes through the native bridge and returns the picked value', async () => {
  const seen = [];
  activate(async (spec) => {
    seen.push(spec);
    return { value: 'gateway' }; // FormFlow select returns the chosen value
  });
  const result = await selectMenu({
    message: '请选择操作:',
    choices: [
      { name: '系统管理', value: 'system' },
      { name: 'AI 网关', value: 'gateway' },
    ],
  });
  expect(result).toBe('gateway');
  // The bridge saw a single-field list spec carrying both choices.
  expect(seen).toHaveLength(1);
  expect(seen[0].fields).toHaveLength(1);
  expect(seen[0].fields[0].type).toBe('select');
  expect(seen[0].fields[0].choices.map((c) => c.value)).toEqual(['system', 'gateway']);
});

test('string choices are normalized to {name,value}', async () => {
  let captured;
  activate(async (spec) => { captured = spec; return { value: 'b' }; });
  const result = await selectMenu({ message: 'pick', choices: ['a', 'b', 'c'] });
  expect(result).toBe('b');
  expect(captured.fields[0].choices).toEqual([
    { name: 'a', value: 'a' }, { name: 'b', value: 'b' }, { name: 'c', value: 'c' },
  ]);
});

test('multi-select maps to a checkbox field and returns the array', async () => {
  let captured;
  activate(async (spec) => { captured = spec; return { value: ['x', 'z'] }; });
  const result = await selectMenu({
    message: 'pick many', multi: true,
    choices: [{ name: 'X', value: 'x' }, { name: 'Y', value: 'y' }, { name: 'Z', value: 'z' }],
  });
  expect(result).toEqual(['x', 'z']);
  expect(captured.fields[0].multi).toBe(true);
});

test('cancel (Esc) returns null', async () => {
  activate(async () => null);
  const result = await selectMenu({ message: 'pick', choices: ['a', 'b'] });
  expect(result).toBeNull();
});

test('allowOther: picking 其他 triggers a follow-up free-text prompt', async () => {
  const OTHER = '__khy_other__';
  let call = 0;
  activate(async (spec) => {
    call += 1;
    if (call === 1) {
      // The "其他" sentinel choice is appended to the list.
      expect(spec.fields[0].choices.some((c) => c.value === OTHER)).toBe(true);
      return { value: OTHER };
    }
    // Second call is the free-text input.
    expect(spec.fields[0].type).toBe('input');
    return { custom: '自定义值' };
  });
  const result = await selectMenu({ message: 'pick', choices: ['a', 'b'], allowOther: true });
  expect(result).toBe('自定义值');
  expect(call).toBe(2);
});

test('allowOther in multi mode replaces the sentinel with the typed value', async () => {
  const OTHER = '__khy_other__';
  let call = 0;
  activate(async () => {
    call += 1;
    return call === 1 ? { value: ['a', OTHER] } : { custom: 'extra' };
  });
  const result = await selectMenu({
    message: 'pick', multi: true, allowOther: true,
    choices: [{ name: 'A', value: 'a' }, { name: 'B', value: 'b' }],
  });
  expect(result).toEqual(['a', 'extra']);
});

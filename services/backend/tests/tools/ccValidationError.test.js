'use strict';

// 纯叶子 ccValidationError 的单测:对齐 CC `src/utils/toolErrors.ts`
// `formatZodValidationError` / `formatValidationPath` 的后端逻辑。
//  - 门控开:`${tool} failed due to the following issue(s):\n` + 分组(缺失→类型→约束)逐条换行,
//    嵌套路径 `todos[0].activeForm`;
//  - 门控关:逐字节回退历史 `Validation failed: ${errors.join('; ')}`;
//  - 无结构化 issues(裸 errors / 定制 validate)→ 仅对齐 CC 标题信封,逐条沿用原句;
//  - 防呆:空 errors / 缺 toolName / issues 全空 → 安全回退,绝不抛。
const test = require('node:test');
const assert = require('node:assert');
const {
  ccValidationErrorEnabled,
  formatValidationPath,
  formatValidationError,
} = require('../../src/tools/ccValidationError');

test('ccValidationErrorEnabled:门控梯(默认开,标准 falsy 串关)', () => {
  assert.strictEqual(ccValidationErrorEnabled({}), true);
  assert.strictEqual(ccValidationErrorEnabled({ KHY_CC_VALIDATION_ERROR: '1' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(ccValidationErrorEnabled({ KHY_CC_VALIDATION_ERROR: off }), false, `应关: ${off}`);
  }
});

test('formatValidationPath:逐字节同 CC(数字→[n]、首段裸名、后续 .name)', () => {
  assert.strictEqual(formatValidationPath(['todos', 0, 'activeForm']), 'todos[0].activeForm');
  assert.strictEqual(formatValidationPath(['model']), 'model');
  assert.strictEqual(formatValidationPath(['a', 'b', 'c']), 'a.b.c');
  assert.strictEqual(formatValidationPath([0]), '[0]');
  assert.strictEqual(formatValidationPath(['items', 2, 'tags', 1]), 'items[2].tags[1]');
  assert.strictEqual(formatValidationPath([]), '');
  assert.strictEqual(formatValidationPath(null), ''); // 防呆
});

test('门控关 → 逐字节回退历史 `Validation failed: a; b`', () => {
  const v = { valid: false, errors: ['model is required', 'x must be of type number, got string'], issues: [] };
  assert.strictEqual(
    formatValidationError('export_ollama_model', v, { KHY_CC_VALIDATION_ERROR: 'off' }),
    'Validation failed: model is required; x must be of type number, got string'
  );
});

test('门控开 + 结构化 issues → CC 分组(缺失 + 类型)带工具名标题', () => {
  const v = {
    valid: false,
    errors: ['model is required', 'head must be of type number, got string'],
    issues: [
      { kind: 'missing', param: 'model' },
      { kind: 'type', param: 'head', expected: 'number', received: 'string' },
    ],
  };
  const out = formatValidationError('export_ollama_model', v, { KHY_CC_VALIDATION_ERROR: '1' });
  assert.strictEqual(
    out,
    'export_ollama_model failed due to the following issues:\n' +
    'The required parameter `model` is missing\n' +
    'The parameter `head` type is expected as `number` but provided as `string`'
  );
});

test('门控开 + 单 issue → 单数 "issue"(CC 语法 N>1?issues:issue)', () => {
  const v = { valid: false, errors: ['model is required'], issues: [{ kind: 'missing', param: 'model' }] };
  const out = formatValidationError('export_ollama_model', v, { KHY_CC_VALIDATION_ERROR: '1' });
  assert.strictEqual(out, 'export_ollama_model failed due to the following issue:\nThe required parameter `model` is missing');
});

test('门控开 + 约束类(other)→ 忠实保留 Khy 原句', () => {
  const v = {
    valid: false,
    errors: ['name must be at least 3 characters', 'level must be one of: a, b'],
    issues: [
      { kind: 'other', param: 'name', message: 'name must be at least 3 characters' },
      { kind: 'other', param: 'level', message: 'level must be one of: a, b' },
    ],
  };
  const out = formatValidationError('set_thing', v, { KHY_CC_VALIDATION_ERROR: '1' });
  assert.strictEqual(
    out,
    'set_thing failed due to the following issues:\n' +
    'name must be at least 3 characters\n' +
    'level must be one of: a, b'
  );
});

test('门控开 + 分组顺序固定:缺失 → 类型 → 约束(与 CC errorParts 追加序一致)', () => {
  const v = {
    valid: false,
    errors: ['c', 'b', 'a'],
    issues: [
      { kind: 'other', param: 'a', message: 'a-constraint' },
      { kind: 'type', param: 'b', expected: 'number', received: 'string' },
      { kind: 'missing', param: 'c' },
    ],
  };
  const out = formatValidationError('t', v, { KHY_CC_VALIDATION_ERROR: '1' });
  const body = out.split('\n').slice(1);
  assert.strictEqual(body[0], 'The required parameter `c` is missing');   // missing 最前
  assert.strictEqual(body[1], 'The parameter `b` type is expected as `number` but provided as `string`');
  assert.strictEqual(body[2], 'a-constraint');                            // other 最后
});

test('门控开 + 嵌套 path → 走 formatValidationPath', () => {
  const v = { valid: false, errors: ['x'], issues: [{ kind: 'missing', path: ['todos', 0, 'activeForm'] }] };
  const out = formatValidationError('t', v, { KHY_CC_VALIDATION_ERROR: '1' });
  assert.strictEqual(out, 't failed due to the following issue:\nThe required parameter `todos[0].activeForm` is missing');
});

test('门控开 + 无 issues(裸 errors / 定制 validate)→ CC 标题信封逐条沿用原句', () => {
  const v = { valid: false, errors: ['model is required', 'foo too big'] }; // 无 issues 字段
  const out = formatValidationError('legacy_tool', v, { KHY_CC_VALIDATION_ERROR: '1' });
  assert.strictEqual(out, 'legacy_tool failed due to the following issues:\nmodel is required\nfoo too big');
  // 裸数组入参亦可
  const out2 = formatValidationError('legacy_tool', ['only one'], { KHY_CC_VALIDATION_ERROR: '1' });
  assert.strictEqual(out2, 'legacy_tool failed due to the following issue:\nonly one');
});

test('防呆:缺 toolName → 中性主语;空 errors / issues 全空 → 历史串兜底,绝不抛', () => {
  const env = { KHY_CC_VALIDATION_ERROR: '1' };
  // 缺 toolName
  assert.strictEqual(
    formatValidationError(undefined, { valid: false, errors: ['x'], issues: [{ kind: 'missing', param: 'x' }] }, env),
    'The tool call failed due to the following issue:\nThe required parameter `x` is missing'
  );
  // 空 errors → 历史串
  assert.strictEqual(formatValidationError('t', { valid: false, errors: [], issues: [] }, env), 'Validation failed: ');
  // issues 全是垃圾项被过滤空 → 退历史串
  assert.strictEqual(
    formatValidationError('t', { valid: false, errors: ['raw'], issues: [{ kind: 'other', message: '' }] }, env),
    'Validation failed: raw'
  );
});

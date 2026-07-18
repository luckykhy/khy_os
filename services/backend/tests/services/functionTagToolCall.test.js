'use strict';

/**
 * functionTagToolCall.test.js — `<function=NAME>…</function>` 提取叶子契约(node:test,零 IO)。
 *
 * 锁定:门控梯;name/argsText/index 切分;跨行 body;多调用;闭标签空白容忍;
 * 不匹配未闭合截断;畸形带属性标签;大小写不敏感;防呆;门控关字节回退 []。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { isEnabled, extractFunctionTags, parseParameterTags } = require('../../src/services/functionTagToolCall');

describe('门控 isEnabled', () => {
  test('默认(未设)→ 开', () => {
    assert.equal(isEnabled({}), true);
    assert.equal(isEnabled(undefined), true);
    assert.equal(isEnabled({ KHY_FUNCTION_TAG_TOOLCALL: 'true' }), true);
  });
  test('falsy → 关', () => {
    for (const v of ['0', 'false', 'off', 'no', ' OFF ', 'No']) {
      assert.equal(isEnabled({ KHY_FUNCTION_TAG_TOOLCALL: v }), false);
    }
  });
  test('空串 env → 开(沿用仓库门控习语:仅 0/false/off/no 关)', () => {
    assert.equal(isEnabled({ KHY_FUNCTION_TAG_TOOLCALL: '' }), true);
  });
});

describe('extractFunctionTags 切分', () => {
  test('单个 JSON body → name + 原始 argsText + index', () => {
    const text = 'sure, let me run it.\n<function=shell_command>{"command": "ls -la"}</function>';
    const tags = extractFunctionTags(text, {});
    assert.equal(tags.length, 1);
    assert.equal(tags[0].name, 'shell_command');
    assert.equal(tags[0].argsText, '{"command": "ls -la"}');
    assert.equal(tags[0].index, text.indexOf('<function='));
  });

  test('跨行 body 完整保留(trim 外层空白)', () => {
    const text = '<function=write_file>\n{\n  "path": "a.txt",\n  "content": "hi"\n}\n</function>';
    const tags = extractFunctionTags(text, {});
    assert.equal(tags.length, 1);
    assert.equal(tags[0].name, 'write_file');
    assert.equal(tags[0].argsText, '{\n  "path": "a.txt",\n  "content": "hi"\n}');
  });

  test('多个调用按出现顺序', () => {
    const text = '<function=git_status></function> then <function=read_file>{"path":"x"}</function>';
    const tags = extractFunctionTags(text, {});
    assert.equal(tags.length, 2);
    assert.equal(tags[0].name, 'git_status');
    assert.equal(tags[0].argsText, '');
    assert.equal(tags[1].name, 'read_file');
    assert.equal(tags[1].argsText, '{"path":"x"}');
    assert.ok(tags[1].index > tags[0].index);
  });

  test('闭标签尾随空白 </function > 容忍', () => {
    const tags = extractFunctionTags('<function=quote>{"symbol":"AAPL"}</function >', {});
    assert.equal(tags.length, 1);
    assert.equal(tags[0].name, 'quote');
  });

  test('大小写不敏感(<FUNCTION=...>)', () => {
    const tags = extractFunctionTags('<FUNCTION=Bash>{"command":"pwd"}</FUNCTION>', {});
    assert.equal(tags.length, 1);
    assert.equal(tags[0].name, 'Bash');
  });

  test('未闭合截断尾巴 → 不匹配(刻意 deferred)', () => {
    const tags = extractFunctionTags('<function=shell_command>{"command": "ls', {});
    assert.deepEqual(tags, []);
  });

  test('畸形带属性脏标签 → 不匹配(保守)', () => {
    const tags = extractFunctionTags('<function=foo bar=baz>{}</function>', {});
    assert.deepEqual(tags, []);
  });

  test('colon/eq 键值 body 原样透传(参数解析留 call-site)', () => {
    const tags = extractFunctionTags('<function=open_app>name: Quark</function>', {});
    assert.equal(tags.length, 1);
    assert.equal(tags[0].argsText, 'name: Quark');
  });
});

describe('门控关 / 防呆 → 字节回退 []', () => {
  test('门控关 → []', () => {
    assert.deepEqual(
      extractFunctionTags('<function=shell_command>{}</function>', { KHY_FUNCTION_TAG_TOOLCALL: 'off' }),
      []
    );
  });
  test('空 / 非字符串 / 无标签 → []', () => {
    assert.deepEqual(extractFunctionTags('', {}), []);
    assert.deepEqual(extractFunctionTags(null, {}), []);
    assert.deepEqual(extractFunctionTags(undefined, {}), []);
    assert.deepEqual(extractFunctionTags(42, {}), []);
    assert.deepEqual(extractFunctionTags('plain text no tags', {}), []);
  });
});

describe('parseParameterTags — <parameter=NAME>VALUE</parameter> 嵌套方言', () => {
  test('transcript 复现:Search + pattern → 干净值,不泄字面标签', () => {
    // goal 2026-07-11: <function=Search><parameter=pattern>**/skills/**</parameter></function>
    // 旧路径把 `<parameter=pattern>` 误当 key=value → Invalid tool parameters。
    const p = parseParameterTags('<parameter=pattern>**/skills/**</parameter>');
    assert.deepEqual(p, { pattern: '**/skills/**' });
    assert.ok(!JSON.stringify(p).includes('<parameter'));
  });
  test('多 parameter 子标签 → 全部解出', () => {
    const p = parseParameterTags('<parameter=command>ls -la</parameter><parameter=cwd>/tmp</parameter>');
    assert.deepEqual(p, { command: 'ls -la', cwd: '/tmp' });
  });
  test('值含反斜杠与 = (transcript 的 D=\\Python312 类)→ 原样保留', () => {
    const p = parseParameterTags('<parameter=command>dir D:\\Python312\\Lib</parameter>');
    assert.deepEqual(p, { command: 'dir D:\\Python312\\Lib' });
  });
  test('跨行值 → 保留换行(只 trim 外围)', () => {
    const p = parseParameterTags('<parameter=content>line1\nline2</parameter>');
    assert.deepEqual(p, { content: 'line1\nline2' });
  });
  test('大小写不敏感标签', () => {
    assert.deepEqual(parseParameterTags('<Parameter=Pattern>x</Parameter>'), { Pattern: 'x' });
  });
  test('闭标签尾随空白容忍', () => {
    assert.deepEqual(parseParameterTags('<parameter=k>v</parameter >'), { k: 'v' });
  });
  test('非该方言(JSON / key:value / 裸串)→ null(让 call-site 落回 _parseFunctionArgs)', () => {
    assert.equal(parseParameterTags('{"a":1}'), null);
    assert.equal(parseParameterTags('command: "dir"'), null);
    assert.equal(parseParameterTags('**/skills/**'), null);
  });
  test('防呆:空 / 非字符串 / 无 parameter → null', () => {
    assert.equal(parseParameterTags(''), null);
    assert.equal(parseParameterTags(null), null);
    assert.equal(parseParameterTags(undefined), null);
    assert.equal(parseParameterTags(42), null);
    assert.equal(parseParameterTags('<parameter></parameter>'), null); // 空 NAME → 不计
  });
});

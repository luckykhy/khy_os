'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const cd = require('../src/services/memoryContentDedup');

function withEnv(val, fn) {
  const prev = process.env.KHY_MEMORY_CONTENT_DEDUP;
  if (val === undefined) delete process.env.KHY_MEMORY_CONTENT_DEDUP;
  else process.env.KHY_MEMORY_CONTENT_DEDUP = val;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.KHY_MEMORY_CONTENT_DEDUP;
    else process.env.KHY_MEMORY_CONTENT_DEDUP = prev;
  }
}

test('normalizeBody:折叠空白+去白+小写·确定性', () => {
  assert.equal(cd.normalizeBody('  Hello   World\n\tFoo '), 'hello world foo');
  assert.equal(cd.normalizeBody('用户  偏好\n中文'), '用户 偏好 中文');
  assert.equal(cd.normalizeBody(null), '');
  assert.equal(cd.normalizeBody(undefined), '');
});

test('bodiesEquivalent:仅归一化后完全相等才判真·空不判真', () => {
  assert.equal(cd.bodiesEquivalent('a b c', 'A  B\nC'), true);
  assert.equal(cd.bodiesEquivalent('用户喜欢深色主题', '用户喜欢深色主题 '), true);
  assert.equal(cd.bodiesEquivalent('a b c', 'a b d'), false);
  assert.equal(cd.bodiesEquivalent('', ''), false);
  assert.equal(cd.bodiesEquivalent('x', ''), false);
});

test('findContentDuplicate:异名同内容命中既有文件', () => {
  withEnv('on', () => {
    const existing = [
      { filename: 'project_a.md', name: 'A', body: '用户偏好使用 TypeScript 严格模式' },
      { filename: 'project_b.md', name: 'B', body: '完全不同的另一条事实' },
    ];
    const dup = cd.findContentDuplicate(
      { name: 'A 改了个标题', body: '用户偏好使用  TypeScript   严格模式\n' },
      existing,
    );
    assert.ok(dup);
    assert.equal(dup.filename, 'project_a.md');
  });
});

test('findContentDuplicate:无等价内容返回 null(零假阳性·不同事实不合并)', () => {
  withEnv('on', () => {
    const existing = [
      { filename: 'x.md', name: 'X', body: '光速等于 299792458 m/s' },
      { filename: 'y.md', name: 'Y', body: '普朗克常数是定义值' },
    ];
    const dup = cd.findContentDuplicate({ name: 'Z', body: '阿伏伽德罗常数是定义值' }, existing);
    assert.equal(dup, null);
  });
});

test('findContentDuplicate:不与自身比(filename 相同跳过)', () => {
  withEnv('on', () => {
    const existing = [{ filename: 'self.md', name: 'S', body: '同一条内容' }];
    const dup = cd.findContentDuplicate({ name: 'S', body: '同一条内容', filename: 'self.md' }, existing);
    assert.equal(dup, null);
  });
});

test('门控关闭即不介入(任一关词)', () => {
  for (const off of ['0', 'false', 'off', 'no']) {
    withEnv(off, () => {
      const existing = [{ filename: 'a.md', name: 'A', body: '相同内容' }];
      const dup = cd.findContentDuplicate({ name: 'B', body: '相同内容' }, existing);
      assert.equal(dup, null, `KHY_MEMORY_CONTENT_DEDUP=${off} 应不介入`);
    });
  }
});

test('默认(未设)即开', () => {
  withEnv(undefined, () => {
    assert.equal(cd._enabled(), true);
    const existing = [{ filename: 'a.md', name: 'A', body: '相同内容' }];
    const dup = cd.findContentDuplicate({ name: 'B', body: '相同内容' }, existing);
    assert.ok(dup);
  });
});

test('fail-soft:畸形入参一律 null·绝不抛', () => {
  withEnv('on', () => {
    assert.equal(cd.findContentDuplicate(null, []), null);
    assert.equal(cd.findContentDuplicate({ body: 'x' }, null), null);
    assert.equal(cd.findContentDuplicate({ body: '' }, [{ filename: 'a', body: '' }]), null);
    assert.equal(cd.findContentDuplicate({ body: 'x' }, [null, { nofile: true }, {}]), null);
  });
});

test('空候选正文不介入', () => {
  withEnv('on', () => {
    const existing = [{ filename: 'a.md', body: '非空' }];
    assert.equal(cd.findContentDuplicate({ name: 'n', body: '   \n\t ' }, existing), null);
  });
});

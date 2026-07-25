'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const dedup = require('../src/services/toolRegistryDedup');

// 每个用例独立设置门控,避免互相污染。
function withEnv(val, fn) {
  const prev = process.env.KHY_TOOL_DEDUP;
  if (val === undefined) delete process.env.KHY_TOOL_DEDUP;
  else process.env.KHY_TOOL_DEDUP = val;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.KHY_TOOL_DEDUP;
    else process.env.KHY_TOOL_DEDUP = prev;
  }
}

const sampleDefs = () => ([
  { name: 'Read', description: 'canonical read', parameters: {} },
  { name: 'readFile', description: 'flat read', parameters: {} },
  { name: 'Write', description: 'canonical write', parameters: {} },
  { name: 'writeFile', description: 'flat write', parameters: {} },
  { name: 'Edit', description: 'canonical edit', parameters: {} },
  { name: 'editFile', description: 'flat edit', parameters: {} },
  { name: 'Bash', description: 'shell', parameters: {} },
]);

test('单一真源:冗余索引覆盖三对已核实重复', () => {
  const idx = dedup.buildRedundancyIndex();
  assert.equal(idx.get('readfile').canonical, 'Read');
  assert.equal(idx.get('writefile').canonical, 'Write');
  assert.equal(idx.get('editfile').canonical, 'Edit');
  assert.equal(idx.size, 3);
});

test('门控默认开:折叠三个冗余实现', () => {
  withEnv(undefined, () => {
    const out = dedup.collapseRedundant(sampleDefs());
    const names = out.map((d) => d.name);
    assert.deepEqual(names, ['Read', 'Write', 'Edit', 'Bash']);
  });
});

test('被折叠名并入规范工具别名(仍可调用·零能力损失)', () => {
  withEnv('on', () => {
    const out = dedup.collapseRedundant(sampleDefs());
    const read = out.find((d) => d.name === 'Read');
    assert.ok(read.aliases.includes('readFile'), 'readFile 应作为 Read 的别名保留');
    const write = out.find((d) => d.name === 'Write');
    assert.ok(write.aliases.includes('writeFile'));
    const edit = out.find((d) => d.name === 'Edit');
    assert.ok(edit.aliases.includes('editFile'));
  });
});

test('已有别名被保留并合并·归一化不重复', () => {
  withEnv('1', () => {
    const defs = sampleDefs();
    defs[0].aliases = ['read_file', 'cat'];
    const out = dedup.collapseRedundant(defs);
    const read = out.find((d) => d.name === 'Read');
    assert.ok(read.aliases.includes('cat'), '原有别名 cat 保留');
    // read_file 已归一化等于 readFile,合并时不应重复出现两条
    const norm = read.aliases.map((a) => a.toLowerCase().replace(/_/g, ''));
    assert.ok(norm.includes('readfile'), '冗余名经 read_file 已覆盖');
    assert.equal(new Set(norm).size, norm.length, '别名归一化后无重复');
  });
});

test('门控关闭即字节回退原列表(同引用)', () => {
  for (const off of ['0', 'false', 'off', 'no']) {
    withEnv(off, () => {
      const defs = sampleDefs();
      const out = dedup.collapseRedundant(defs);
      assert.strictEqual(out, defs, `KHY_TOOL_DEDUP=${off} 应原样返回`);
    });
  }
});

test('规范工具缺席时保留冗余实现(宁可冗余不丢能力)', () => {
  withEnv('on', () => {
    // 只有 readFile,没有 Read → 不能折叠
    const defs = [
      { name: 'readFile', description: 'flat read', parameters: {} },
      { name: 'Bash', description: 'shell', parameters: {} },
    ];
    const out = dedup.collapseRedundant(defs);
    assert.deepEqual(out.map((d) => d.name), ['readFile', 'Bash']);
  });
});

test('顺序稳定:折叠后保留原相对顺序', () => {
  withEnv('on', () => {
    const out = dedup.collapseRedundant(sampleDefs());
    assert.deepEqual(out.map((d) => d.name), ['Read', 'Write', 'Edit', 'Bash']);
  });
});

test('不就地破坏入参:原 def 对象不被改名/删除', () => {
  withEnv('on', () => {
    const defs = sampleDefs();
    const before = defs.map((d) => d.name);
    dedup.collapseRedundant(defs);
    assert.deepEqual(defs.map((d) => d.name), before, '入参数组不应被就地修改');
  });
});

test('fail-soft:非数组入参原样返回·绝不抛', () => {
  withEnv('on', () => {
    assert.strictEqual(dedup.collapseRedundant(null), null);
    assert.strictEqual(dedup.collapseRedundant(undefined), undefined);
    const obj = { not: 'array' };
    assert.strictEqual(dedup.collapseRedundant(obj), obj);
  });
});

test('fail-soft:畸形 def(无 name)不致崩·原样穿过', () => {
  withEnv('on', () => {
    const defs = [{ description: 'no name' }, { name: 'Read' }, { name: 'readFile' }];
    const out = dedup.collapseRedundant(defs);
    // 无 name 的穿过;readFile 折叠进 Read
    assert.equal(out.length, 2);
    assert.ok(out.some((d) => d.name === 'Read'));
    assert.ok(out.some((d) => !d.name));
  });
});

test('无冗余存在时返回等价列表', () => {
  withEnv('on', () => {
    const defs = [{ name: 'Bash' }, { name: 'Grep' }, { name: 'Glob' }];
    const out = dedup.collapseRedundant(defs);
    assert.deepEqual(out.map((d) => d.name), ['Bash', 'Grep', 'Glob']);
  });
});

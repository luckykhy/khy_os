'use strict';

// slashMenuFilter — TUI 斜杠命令菜单过滤/排序 SSOT(刀24)。
// 对齐 CC commandSuggestions(partKey 按 [:_-] 分段 + 描述匹配),消费既有
// rankSlashCommands SSOT,与经典 REPL 收敛。门控 KHY_TUI_SLASH_SUBSTRING 默认开;
// 关 → 注入式前缀回退,逐字节等价历史。
const test = require('node:test');
const assert = require('node:assert/strict');

const { slashSubstringEnabled, slashMenuCommandNames } = require('../../src/cli/tui/slashMenuFilter');

// 仿真命令表(含连字符命令,复刻真缺口场景)。
const CMDS = [
  { cmd: '/proactive', desc: '主动 idle-tick' },
  { cmd: '/profile', desc: '性能剖析' },
  { cmd: '/prompt', desc: '提示词' },
  { cmd: '/autofix-pr', desc: '自动修复并开 PR' },
  { cmd: '/commit-push-pr', desc: '提交推送开 PR' },
  { cmd: '/subscribe-pr', desc: '订阅 PR' },
  { cmd: '/model', desc: '选择模型', label: '模型' },
  { cmd: '/models', desc: '列出模型' },
];

// 门控关回退源:仅前缀 startsWith + 字母序(复刻 commandRegistry.getCompletions)。
function legacyPrefix(value) {
  const lower = String(value).toLowerCase();
  return CMDS.map((c) => c.cmd).filter((c) => c.toLowerCase().startsWith(lower)).sort();
}

function withGate(value, fn) {
  const saved = process.env.KHY_TUI_SLASH_SUBSTRING;
  if (value === undefined) delete process.env.KHY_TUI_SLASH_SUBSTRING;
  else process.env.KHY_TUI_SLASH_SUBSTRING = value;
  try { return fn(); } finally {
    if (saved === undefined) delete process.env.KHY_TUI_SLASH_SUBSTRING;
    else process.env.KHY_TUI_SLASH_SUBSTRING = saved;
  }
}

const deps = { slashCommands: CMDS, getCompletionsFn: legacyPrefix };

test('门控开(默认):/pr 经子串命中连字符命令(历史前缀路径搜不到)', () => {
  withGate(undefined, () => {
    const names = slashMenuCommandNames('/pr', deps);
    // 前缀匹配(score 3)在前:/proactive /profile /prompt
    assert.deepEqual(names.slice(0, 3), ['/proactive', '/profile', '/prompt']);
    // 子串匹配(score 2)随后:连字符命令的 -pr 段被命中
    for (const c of ['/autofix-pr', '/commit-push-pr', '/subscribe-pr']) {
      assert.ok(names.includes(c), `应包含 ${c}`);
    }
  });
});

test('门控关:逐字节回退历史前缀路径(连字符命令消失)', () => {
  withGate('0', () => {
    const names = slashMenuCommandNames('/pr', deps);
    assert.deepEqual(names, legacyPrefix('/pr')); // 与注入前缀源逐字节一致
    for (const c of ['/autofix-pr', '/commit-push-pr', '/subscribe-pr']) {
      assert.ok(!names.includes(c), `前缀路径不应包含 ${c}`);
    }
  });
});

test('门控开:/push 经子串命中 /commit-push-pr(前缀路径只会有 /push 类前缀)', () => {
  withGate(undefined, () => {
    const names = slashMenuCommandNames('/push', deps);
    assert.ok(names.includes('/commit-push-pr'));
    // 前缀路径对 /push 在本命令表里为空(无以 /push 开头者)
    assert.deepEqual(legacyPrefix('/push'), []);
  });
});

test('门控开:描述/标签子串也能命中(委托 rankSlashCommands)', () => {
  withGate(undefined, () => {
    // "模型" 是 /model 的 label;desc 含「模型」的 /models 也应出现
    const names = slashMenuCommandNames('/模型', deps);
    assert.ok(names.includes('/model'));
  });
});

test('门控梯:大小写/空白/真值不当关', () => {
  assert.equal(slashSubstringEnabled({}), true);
  assert.equal(slashSubstringEnabled({ KHY_TUI_SLASH_SUBSTRING: '' }), true);
  assert.equal(slashSubstringEnabled({ KHY_TUI_SLASH_SUBSTRING: '1' }), true);
  assert.equal(slashSubstringEnabled({ KHY_TUI_SLASH_SUBSTRING: 'on' }), true);
  assert.equal(slashSubstringEnabled({ KHY_TUI_SLASH_SUBSTRING: '  OFF  ' }), false);
  assert.equal(slashSubstringEnabled({ KHY_TUI_SLASH_SUBSTRING: 'No' }), false);
  assert.equal(slashSubstringEnabled({ KHY_TUI_SLASH_SUBSTRING: '0' }), false);
});

test('防呆:无 getCompletionsFn 时门控关返回空数组,门控开 slashCommands 非数组返回空', () => {
  withGate('0', () => {
    assert.deepEqual(slashMenuCommandNames('/x', {}), []);
  });
  withGate(undefined, () => {
    assert.deepEqual(slashMenuCommandNames('/x', { slashCommands: null }), []);
  });
});

test('门控开:纯前缀查询 /mo 仍含 /model /models(前缀分数最高在前)', () => {
  withGate(undefined, () => {
    const names = slashMenuCommandNames('/mo', deps);
    assert.ok(names.includes('/model'));
    assert.ok(names.includes('/models'));
    // 二者均 score 3,按原始下标:/model 在 /models 前
    assert.ok(names.indexOf('/model') < names.indexOf('/models'));
  });
});

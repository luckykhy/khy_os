'use strict';

/**
 * useCompletions × slashExtraCommands 集成断言(node:test)。
 *   node --test services/backend/tests/cli/useCompletionsSlashExtras.test.js
 *
 * 证「改一处两入口同步」的 TUI 侧收益:此前 TUI 菜单只读 router.SLASH_COMMANDS,
 * commandRegistry 之外的 13 条 extras(/study /hud /mind …)在 TUI 完全搜不到。
 * 并入 slashExtraCommands 后,computeSlash 应能命中这些命令并带出其描述。
 *
 * 功能级(非源级 grep):直接调 computeSlash / slashDescription 验证真实菜单产出。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { computeSlash } = require('../../src/cli/tui/hooks/useCompletions.js');
const { SLASH_EXTRA_COMMANDS } = require('../../src/cli/slashExtraCommands');

// 保证默认(门开)子串路径:确保 KHY_TUI_SLASH_SUBSTRING 未被显式关掉。
delete process.env.KHY_TUI_SLASH_SUBSTRING;

test('computeSlash: /study 现身 TUI 菜单(此前 registry 之外搜不到)', () => {
  const res = computeSlash('/study');
  assert.ok(res, '应返回菜单描述符');
  assert.equal(res.kind, 'slash');
  const values = res.items.map((i) => i.value);
  assert.ok(values.includes('/study'), `/study 应在候选里,实得: ${values.join(',')}`);
});

test('computeSlash: /hud /mind /folded 等 extras 均可命中', () => {
  for (const cmd of ['/hud', '/mind', '/folded', '/optimize']) {
    const res = computeSlash(cmd);
    assert.ok(res, `${cmd} 应返回菜单`);
    const values = res.items.map((i) => i.value);
    assert.ok(values.includes(cmd), `${cmd} 应在候选里,实得: ${values.join(',')}`);
  }
});

test('computeSlash: extras 带出描述(与 SLASH_EXTRA_COMMANDS 一致,不是空 desc)', () => {
  const res = computeSlash('/study');
  const item = res.items.find((i) => i.value === '/study');
  assert.ok(item, '/study 项存在');
  const expected = SLASH_EXTRA_COMMANDS.find((e) => e.cmd === '/study').desc;
  assert.equal(item.desc, expected);
});

test('computeSlash: 非斜杠输入返回 null(不误触发)', () => {
  assert.equal(computeSlash('hello'), null);
  assert.equal(computeSlash('/study x'), null); // 已有空格 → 不再是命令 token
});

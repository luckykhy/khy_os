'use strict';

/**
 * roleToolScope.test.js — 角色→工具作用域策略纯叶的 node:test。
 *
 * 覆盖：门开只读角色剥写工具（不剥 Bash 的诚实边界）、write / 未知角色不误伤、
 * 大小写空白归一、畸形绝不抛、门关四 falsy token 逐字节回退、mergeRoleScopeInto
 * union 去重与 SSOT 形状对齐、以及与 buildSubagentDenylist union 点的端到端联通。
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  roleToolScope,
  mergeRoleScopeInto,
} = require('../../../src/services/orchestrator/roleToolScope');

// 切门 helper：设定 KHY_ROLE_TOOL_SCOPE，跑 fn，恢复原值。
function withGate(value, fn) {
  const prev = process.env.KHY_ROLE_TOOL_SCOPE;
  if (value === undefined) delete process.env.KHY_ROLE_TOOL_SCOPE;
  else process.env.KHY_ROLE_TOOL_SCOPE = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.KHY_ROLE_TOOL_SCOPE;
    else process.env.KHY_ROLE_TOOL_SCOPE = prev;
  }
}

const READ_ONLY_ROLES = ['explore', 'verify', 'plan', 'research', 'audit', 'review'];
const WRITE_ROLES = ['implement', 'coder', 'general'];

test('gate on: read-only roles strip Edit/Write/NotebookEdit', () => {
  withGate('on', () => {
    for (const role of READ_ONLY_ROLES) {
      const scope = roleToolScope(role);
      assert.ok(scope.includes('Edit'), `${role} should strip Edit`);
      assert.ok(scope.includes('Write'), `${role} should strip Write`);
      assert.ok(scope.includes('NotebookEdit'), `${role} should strip NotebookEdit`);
    }
  });
});

test('gate on: read-only roles do NOT strip Bash (honest boundary)', () => {
  withGate('on', () => {
    for (const role of READ_ONLY_ROLES) {
      assert.ok(!roleToolScope(role).includes('Bash'), `${role} must keep Bash (read-only shell)`);
    }
  });
});

test('gate on: write / unknown roles get an empty scope (no false-strip)', () => {
  withGate('on', () => {
    for (const role of WRITE_ROLES) {
      assert.deepStrictEqual(roleToolScope(role), [], `${role} should not be scoped`);
    }
    assert.deepStrictEqual(roleToolScope('totally-unknown-role'), []);
  });
});

test('gate on: role matching is case- and whitespace-insensitive', () => {
  withGate('on', () => {
    assert.ok(roleToolScope('  Explore ').includes('Edit'));
    assert.ok(roleToolScope('VERIFY').includes('Write'));
    assert.deepStrictEqual(roleToolScope('  IMPLEMENT  '), []);
  });
});

test('malformed input never throws → []', () => {
  withGate('on', () => {
    for (const bad of [null, undefined, '', 42, {}, [], true]) {
      assert.deepStrictEqual(roleToolScope(bad), [], `roleToolScope(${JSON.stringify(bad)}) should be []`);
    }
  });
});

test('returned array is a fresh copy (caller may mutate safely)', () => {
  withGate('on', () => {
    const a = roleToolScope('explore');
    a.push('MUTATED');
    const b = roleToolScope('explore');
    assert.ok(!b.includes('MUTATED'), 'each call must return an independent array');
  });
});

test('gate off (all falsy tokens): read-only role → [] (byte-revert)', () => {
  for (const off of ['0', 'false', 'off', 'no']) {
    withGate(off, () => {
      for (const role of READ_ONLY_ROLES) {
        assert.deepStrictEqual(roleToolScope(role), [], `gate=${off} must disable scoping for ${role}`);
      }
    });
  }
});

test('gate default (unset) → scoping active', () => {
  withGate(undefined, () => {
    assert.ok(roleToolScope('explore').includes('Edit'), 'default (unset) should be on');
  });
});

test('mergeRoleScopeInto: unions role scope into a base denylist, deduped', () => {
  withGate('on', () => {
    const merged = mergeRoleScopeInto(['Agent'], 'explore');
    assert.ok(merged.includes('Agent'), 'base entries preserved');
    assert.ok(merged.includes('Edit') && merged.includes('Write') && merged.includes('NotebookEdit'));
    // dedupe: a base already containing Edit must not duplicate it.
    const deduped = mergeRoleScopeInto(['Edit', 'Agent'], 'explore');
    assert.strictEqual(deduped.filter((t) => t === 'Edit').length, 1, 'Edit must appear once');
  });
});

test('mergeRoleScopeInto: null/undefined/non-array base does not throw', () => {
  withGate('on', () => {
    assert.deepStrictEqual(mergeRoleScopeInto(null, 'implement'), []);
    assert.deepStrictEqual(mergeRoleScopeInto(undefined, 'implement'), []);
    assert.deepStrictEqual(mergeRoleScopeInto('nope', 'implement'), []);
    // write role + valid base → base unchanged (set-normalized).
    assert.deepStrictEqual(mergeRoleScopeInto(['Agent'], 'implement'), ['Agent']);
  });
});

test('gate off: mergeRoleScopeInto returns base only (byte-revert)', () => {
  withGate('off', () => {
    assert.deepStrictEqual(mergeRoleScopeInto(['Agent'], 'explore'), ['Agent']);
  });
});

test('e2e: mergeRoleScopeInto with the spawn-tool base ⊇ Agent+write-tools (seam closes)', () => {
  // Mirrors AgentTool.buildSubagentDenylist's union shape: base carries the spawn
  // tool at ceiling; role scope adds the read-only write-tool strip. This proves the
  // leaf can plug into that seam so an `explore` subtask ends up read-only.
  withGate('on', () => {
    const merged = mergeRoleScopeInto(['Agent'], 'explore');
    for (const t of ['Agent', 'Edit', 'Write', 'NotebookEdit']) {
      assert.ok(merged.includes(t), `merged denylist should contain ${t}`);
    }
  });
});

// ─── LIVE WIRE (OPS-MAN-094 tenth gift) ─────────────────────────────────────
// The seam is no longer hypothetical: AgentTool.buildSubagentDenylist now takes
// a `role` and folds mergeRoleScopeInto in. These cases call the PRODUCTION
// static method directly, so a regression that unwires it turns them red.
const { AgentTool } = require('../../../src/tools/AgentTool');

test('live: buildSubagentDenylist(null, below-ceiling, _, "verify") strips write tools even with NO agentDef', () => {
  // agentDef=null (SDK mode / built-ins disabled): pre-wire this denylist would
  // have been empty for a below-ceiling child. The role now supplies the strip.
  withGate('on', () => {
    const deny = AgentTool.buildSubagentDenylist(null, 1, 2, 'verify');
    for (const t of ['Edit', 'Write', 'NotebookEdit']) {
      assert.ok(deny.includes(t), `verify (no agentDef) should strip ${t}`);
    }
    assert.ok(!deny.includes('Agent'), 'below ceiling → spawn tool retained');
  });
});

test('live: buildSubagentDenylist strips write tools for an explore role too', () => {
  withGate('on', () => {
    const deny = AgentTool.buildSubagentDenylist(null, 1, 2, 'explore');
    assert.ok(deny.includes('Edit') && deny.includes('Write') && deny.includes('NotebookEdit'));
  });
});

test('live: at ceiling, role scope AND spawn-tool strip both apply, deduped', () => {
  withGate('on', () => {
    const deny = AgentTool.buildSubagentDenylist(null, 2, 2, 'verify');
    for (const t of ['Edit', 'Write', 'NotebookEdit', 'Agent', 'Task']) {
      assert.ok(deny.includes(t), `at ceiling should contain ${t}`);
    }
    assert.strictEqual(deny.filter((n) => n === 'Edit').length, 1, 'no duplicate Edit');
  });
});

test('live: gate OFF → role scope is a no-op (byte-revert to pre-wire denylist)', () => {
  withGate('off', () => {
    // Below ceiling, null agentDef, gate off → empty, exactly as before the wire.
    assert.deepStrictEqual(AgentTool.buildSubagentDenylist(null, 1, 2, 'verify'), []);
  });
});

test('live: write / omitted role leaves the denylist byte-equivalent to the 3-arg call', () => {
  withGate('on', () => {
    const threeArg = AgentTool.buildSubagentDenylist(null, 1, 2);
    const writeRole = AgentTool.buildSubagentDenylist(null, 1, 2, 'implement');
    const omitted = AgentTool.buildSubagentDenylist(null, 1, 2, undefined);
    assert.deepStrictEqual(writeRole, threeArg, 'write role must not scope');
    assert.deepStrictEqual(omitted, threeArg, 'omitted role must be byte-equivalent');
  });
});

test('live: an agentDef denylist is preserved and unioned with the role scope', () => {
  withGate('on', () => {
    const deny = AgentTool.buildSubagentDenylist({ disallowedTools: ['Bash', 'Edit'] }, 1, 2, 'verify');
    assert.ok(deny.includes('Bash'), 'agentDef own denylist preserved');
    assert.ok(deny.includes('Write') && deny.includes('NotebookEdit'), 'role scope unioned in');
    assert.strictEqual(deny.filter((n) => n === 'Edit').length, 1, 'overlapping Edit deduped');
  });
});

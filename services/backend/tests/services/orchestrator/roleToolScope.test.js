'use strict';
/**
 * roleToolScope.test.js — 角色→工具作用域策略纯叶的 node:test。
 *
 * 覆盖：门开只读角色剥写工具（不剥 Bash 的诚实边界）、write / 未知角色不误伤、
 * 大小写空白归一、畸形绝不抛、门关四 falsy token 逐字节回退、mergeRoleScopeInto
 * union 去重与 SSOT 形状对齐、以及与 buildSubagentDenylist union 点的端到端联通。
 */
const {
  roleToolScope,
  mergeRoleScopeInto,
} = require('../../../src/services/domain/state/orchestrator/roleToolScope.js');
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
      expect(deny).toContain(t);
    }
    expect(!deny).toContain('Agent');
  });
});

describe('Role Tool Scope', () => {
  test('gate on: read-only roles strip Edit/Write/NotebookEdit', () => {
      withGate('on', () => {
        for (const role of READ_ONLY_ROLES) {
          const scope = roleToolScope(role);
          expect(scope.includes('Edit')).toBeTruthy();
          expect(scope.includes('Write')).toBeTruthy();
          expect(scope.includes('NotebookEdit')).toBeTruthy();
        }
      });
  });

  test('gate on: read-only roles do NOT strip Bash (honest boundary)', () => {
      withGate('on', () => {
        for (const role of READ_ONLY_ROLES) {
          expect(!roleToolScope(role).includes('Bash')).toBeTruthy();
        }
      });
  });

  test('gate on: write / unknown roles get an empty scope (no false-strip)', () => {
      withGate('on', () => {
        for (const role of WRITE_ROLES) {
          expect(roleToolScope(role)).toEqual([], `${role} should not be scoped`);
        }
        expect(roleToolScope('totally-unknown-role')).toEqual([]);
      });
  });

  test('gate on: role matching is case- and whitespace-insensitive', () => {
      withGate('on', () => {
        expect(roleToolScope('  Explore ')).toContain('Edit');
        expect(roleToolScope('VERIFY')).toContain('Write');
        expect(roleToolScope('  IMPLEMENT  ')).toEqual([]);
      });
  });

  test('malformed input never throws → []', () => {
      withGate('on', () => {
        for (const bad of [null, undefined, '', 42, {}, [], true]) {
          expect(roleToolScope(bad)).toEqual([], `roleToolScope(${JSON.stringify(bad)}) should be []`);
        }
      });
  });

  test('returned array is a fresh copy (caller may mutate safely)', () => {
      withGate('on', () => {
        const a = roleToolScope('explore');
        a.push('MUTATED');
        const b = roleToolScope('explore');
        expect(!b.includes('MUTATED')).toBeTruthy();
      });
  });

  test('gate off (all falsy tokens): read-only role → [] (byte-revert)', () => {
      for (const off of ['0', 'false', 'off', 'no']) {
        withGate(off, () => {
          for (const role of READ_ONLY_ROLES) {
            expect(roleToolScope(role)).toEqual([], `gate=${off} must disable scoping for ${role}`);
          }
        });
      }
  });

  test('gate default (unset) → scoping active', () => {
      withGate(undefined, () => {
        expect(roleToolScope('explore').includes('Edit')).toBeTruthy();
      });
  });

  test('mergeRoleScopeInto: unions role scope into a base denylist, deduped', () => {
      withGate('on', () => {
        const merged = mergeRoleScopeInto(['Agent'], 'explore');
        expect(merged.includes('Agent')).toBeTruthy();
        expect(merged.includes('Edit') && merged.includes('Write') && merged).toContain('NotebookEdit');
        // dedupe: a base already containing Edit must not duplicate it.
        const deduped = mergeRoleScopeInto(['Edit', 'Agent'], 'explore');
        expect(deduped.filter((t) => t === 'Edit').length).toBe(1, 'Edit must appear once');
      });
  });

  test('mergeRoleScopeInto: null/undefined/non-array base does not throw', () => {
      withGate('on', () => {
        expect(mergeRoleScopeInto(null).toEqual('implement'), []);
        expect(mergeRoleScopeInto(undefined).toEqual('implement'), []);
        expect(mergeRoleScopeInto('nope').toEqual('implement'), []);
        // write role + valid base → base unchanged (set-normalized).
        expect(mergeRoleScopeInto(['Agent']).toEqual('implement'), ['Agent']);
      });
  });

  test('gate off: mergeRoleScopeInto returns base only (byte-revert)', () => {
      withGate('off', () => {
        expect(mergeRoleScopeInto(['Agent']).toEqual('explore'), ['Agent']);
      });
  });

  test('e2e: mergeRoleScopeInto with the spawn-tool base ⊇ Agent+write-tools (seam closes)', () => {
      // Mirrors AgentTool.buildSubagentDenylist's union shape: base carries the spawn
      // tool at ceiling; role scope adds the read-only write-tool strip. This proves the
      // leaf can plug into that seam so an `explore` subtask ends up read-only.
      withGate('on', () => {
        const merged = mergeRoleScopeInto(['Agent'], 'explore');
        for (const t of ['Agent', 'Edit', 'Write', 'NotebookEdit']) {
          expect(merged.includes(t)).toBeTruthy();
        }
      });
  });

  test('live: buildSubagentDenylist strips write tools for an explore role too', () => {
      withGate('on', () => {
        const deny = AgentTool.buildSubagentDenylist(null, 1, 2, 'explore');
        expect(deny.includes('Edit') && deny.includes('Write') && deny).toContain('NotebookEdit');
      });
  });

  test('live: at ceiling, role scope AND spawn-tool strip both apply, deduped', () => {
      withGate('on', () => {
        const deny = AgentTool.buildSubagentDenylist(null, 2, 2, 'verify');
        for (const t of ['Edit', 'Write', 'NotebookEdit', 'Agent', 'Task']) {
          expect(deny.includes(t)).toBeTruthy();
        }
        expect(deny.filter((n) => n === 'Edit').length).toBe(1, 'no duplicate Edit');
      });
  });

  test('live: gate OFF → role scope is a no-op (byte-revert to pre-wire denylist)', () => {
      withGate('off', () => {
        // Below ceiling, null agentDef, gate off → empty, exactly as before the wire.
        expect(AgentTool.buildSubagentDenylist(null).toEqual(1, 2, 'verify'), []);
      });
  });

  test('live: write / omitted role leaves the denylist byte-equivalent to the 3-arg call', () => {
      withGate('on', () => {
        const threeArg = AgentTool.buildSubagentDenylist(null, 1, 2);
        const writeRole = AgentTool.buildSubagentDenylist(null, 1, 2, 'implement');
        const omitted = AgentTool.buildSubagentDenylist(null, 1, 2, undefined);
        expect(writeRole).toEqual(threeArg, 'write role must not scope');
        expect(omitted).toEqual(threeArg, 'omitted role must be byte-equivalent');
      });
  });

  test('live: an agentDef denylist is preserved and unioned with the role scope', () => {
      withGate('on', () => {
        const deny = AgentTool.buildSubagentDenylist({ disallowedTools: ['Bash', 'Edit'] }, 1, 2, 'verify');
        expect(deny.includes('Bash')).toBeTruthy();
        expect(deny.includes('Write') && deny.includes('NotebookEdit')).toBeTruthy();
        expect(deny.filter((n) => n === 'Edit').length).toBe(1, 'overlapping Edit deduped');
      });
  });

});

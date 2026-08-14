'use strict';

// R4: empty-param patch functions must match shell / web-search tool names by
// NORMALIZED form (case + separators), not a case-sensitive literal Set — so a
// model emitting `BASH`, `Bash`, lowercase `shellcommand`, `WebSearch`, or
// `WEB_SEARCH` still gets its empty command / query back-filled instead of
// dispatching with an empty param and failing. Gated by KHY_PATCH_TOOLNAME_NORMALIZE
// (default ON); OFF byte-reverts to the old literal Set.

const test = require('node:test');
const assert = require('node:assert');
const loop = require('../../src/services/toolUseLoop');

const USER_MSG = '看看桌面上有什么文件'; // triggers the desktop/file inference branch

function shellCall(name) {
  return { name, params: { command: '' } }; // empty → eligible for patch
}
function searchCall(name) {
  return { name, params: { query: '' } };
}

// Run a patch with a specific env, then restore.
function withEnv(key, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, key);
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try { return fn(); } finally {
    if (had) process.env[key] = prev; else delete process.env[key];
  }
}

test('_isShellToolName normalizes case for the three logical shell names', () => {
  for (const n of ['bash', 'BASH', 'Bash', 'shell_command', 'SHELL_COMMAND', 'shellCommand', 'shellcommand']) {
    assert.strictEqual(loop._isShellToolName(n), true, n);
  }
  for (const n of ['read_file', 'grep', 'shell', 'command', '']) {
    assert.strictEqual(loop._isShellToolName(n), false, n);
  }
});

test('ON: empty command patched for case-variant shell names (BASH / Bash / shellcommand)', () => {
  withEnv('KHY_PATCH_TOOLNAME_NORMALIZE', undefined, () => {
    for (const name of ['BASH', 'Bash', 'shellcommand', 'shell_command', 'shellCommand', 'bash']) {
      const calls = [shellCall(name)];
      loop._patchEmptyShellCommand(calls, USER_MSG);
      assert.ok(calls[0].params.command.length > 0, `expected command inferred for ${name}`);
    }
  });
});

test('OFF: byte-reverts to literal Set — case-variant names are NOT patched', () => {
  withEnv('KHY_PATCH_TOOLNAME_NORMALIZE', '0', () => {
    // camelCase/exact names in the old Set still work
    for (const name of ['shell_command', 'shellCommand', 'bash']) {
      const calls = [shellCall(name)];
      loop._patchEmptyShellCommand(calls, USER_MSG);
      assert.ok(calls[0].params.command.length > 0, `old Set should still patch ${name}`);
    }
    // but the variants the old Set missed stay empty (documents the pre-fix gap)
    for (const name of ['BASH', 'Bash', 'shellcommand']) {
      const calls = [shellCall(name)];
      loop._patchEmptyShellCommand(calls, USER_MSG);
      assert.strictEqual(calls[0].params.command, '', `old Set misses ${name}`);
    }
  });
});

test('ON: empty query patched for case/sep-variant web-search names', () => {
  withEnv('KHY_PATCH_TOOLNAME_NORMALIZE', undefined, () => {
    for (const name of ['WebSearch', 'WEB_SEARCH', 'web-search', 'web_search', 'webSearch', 'search_web', 'searchWeb']) {
      const calls = [searchCall(name)];
      loop._patchEmptySearchQuery(calls, 'khyos 是什么项目');
      assert.ok(String(calls[0].params.query || '').length > 0, `expected query inferred for ${name}`);
    }
  });
});

test('OFF: web-search byte-reverts — variants missed by the old literal Set', () => {
  withEnv('KHY_PATCH_TOOLNAME_NORMALIZE', 'off', () => {
    for (const name of ['web_search', 'webSearch', 'websearch', 'search_web']) {
      const calls = [searchCall(name)];
      loop._patchEmptySearchQuery(calls, 'khyos 是什么项目');
      assert.ok(String(calls[0].params.query || '').length > 0, `old Set patches ${name}`);
    }
    for (const name of ['WebSearch', 'WEB_SEARCH', 'searchWeb']) {
      const calls = [searchCall(name)];
      loop._patchEmptySearchQuery(calls, 'khyos 是什么项目');
      assert.strictEqual(String(calls[0].params.query || ''), '', `old Set misses ${name}`);
    }
  });
});

test('non-empty command / query is never overwritten (both gate states)', () => {
  for (const flag of [undefined, '0']) {
    withEnv('KHY_PATCH_TOOLNAME_NORMALIZE', flag, () => {
      const s = [{ name: 'bash', params: { command: 'ls -la' } }];
      loop._patchEmptyShellCommand(s, USER_MSG);
      assert.strictEqual(s[0].params.command, 'ls -la');
      const w = [{ name: 'web_search', params: { query: 'existing query' } }];
      loop._patchEmptySearchQuery(w, 'khyos');
      assert.strictEqual(w[0].params.query, 'existing query');
    });
  }
});

test('fail-soft: bad input never throws', () => {
  assert.doesNotThrow(() => loop._patchEmptyShellCommand(null, USER_MSG));
  assert.doesNotThrow(() => loop._patchEmptyShellCommand([null, {}], USER_MSG));
  assert.doesNotThrow(() => loop._patchEmptySearchQuery(undefined, USER_MSG));
  assert.doesNotThrow(() => loop._patchEmptyShellCommand([shellCall('bash')], ''));
});

// R5: the inline dispatch gates (proactive platform rewrite + analyzeCommand
// shell-safety, toolUseLoop.js ~5152/5160/5630/5638) historically compared the
// RAW tool name case-sensitively, so a `BASH`/`Bash` call — which the executor
// resolves via normalizeToolName → shell_command and RUNS — slipped past
// shell-safety. _matchesShellDispatchName closes that hole under the same gate.
test('R5 ON: normalized dispatch match catches BASH/Bash (safety-bypass closed)', () => {
  withEnv('KHY_PATCH_TOOLNAME_NORMALIZE', undefined, () => {
    for (const n of ['bash', 'BASH', 'Bash', 'shell_command', 'SHELL_COMMAND', 'shellCommand', 'shellcommand']) {
      assert.strictEqual(loop._matchesShellDispatchName(n), true, n);
    }
    for (const n of ['read_file', 'grep', 'write_file', 'agent', '']) {
      assert.strictEqual(loop._matchesShellDispatchName(n), false, n);
    }
  });
});

test('R5 OFF: byte-reverts to the exact legacy 3-way literal compare', () => {
  withEnv('KHY_PATCH_TOOLNAME_NORMALIZE', '0', () => {
    // the three literals the legacy gate accepted
    for (const n of ['shell_command', 'shellCommand', 'bash']) {
      assert.strictEqual(loop._matchesShellDispatchName(n), true, n);
    }
    // case variants the legacy gate MISSED (documents the pre-fix bypass)
    for (const n of ['BASH', 'Bash', 'shellcommand', 'SHELL_COMMAND']) {
      assert.strictEqual(loop._matchesShellDispatchName(n), false, n);
    }
  });
});

test('R5 fail-soft: never throws on odd input', () => {
  assert.doesNotThrow(() => loop._matchesShellDispatchName(null));
  assert.doesNotThrow(() => loop._matchesShellDispatchName(undefined));
  assert.strictEqual(loop._matchesShellDispatchName(undefined), false);
});

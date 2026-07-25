'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '../src');
const port = require('../src/services/permissionPromptPort');

function read(rel) {
  return fs.readFileSync(path.join(SRC, rel), 'utf8');
}

test('register/get/reset basic lifecycle', () => {
  port._resetForTest();
  assert.strictEqual(port.getPermissionPrompter(), null, 'starts unregistered (headless degrade)');
  const prompt = async () => 'allow';
  const promptBatch = async () => ({ decision: 'approve-all' });
  port.registerPermissionPrompter({ prompt, promptBatch });
  const p = port.getPermissionPrompter();
  assert.strictEqual(p.prompt, prompt);
  assert.strictEqual(p.promptBatch, promptBatch);
  port._resetForTest();
  assert.strictEqual(port.getPermissionPrompter(), null);
});

test('partial impl: only members that are functions survive', () => {
  port._resetForTest();
  port.registerPermissionPrompter({ prompt: async () => 'deny' });
  const p = port.getPermissionPrompter();
  assert.strictEqual(typeof p.prompt, 'function');
  assert.strictEqual(p.promptBatch, null);
  port._resetForTest();
});

test('invalid impl → null (non-object / non-functions rejected)', () => {
  port._resetForTest();
  port.registerPermissionPrompter(null);
  assert.strictEqual(port.getPermissionPrompter(), null);
  port.registerPermissionPrompter('nope');
  assert.strictEqual(port.getPermissionPrompter(), null);
  port.registerPermissionPrompter({ prompt: 'not a fn', promptBatch: 42 });
  const p = port.getPermissionPrompter();
  assert.strictEqual(p.prompt, null);
  assert.strictEqual(p.promptBatch, null);
  port._resetForTest();
});

// ── Architectural invariant guard (REQ-2026-001 / DESIGN-ARCH-057) ──

test('the port is a zero-dependency leaf (can never join a cycle)', () => {
  const src = read('services/permissionPromptPort.js')
    .replace(/\/\*[\s\S]*?\*\//g, '')   // strip block comments (prose mentions require())
    .replace(/\/\/.*$/gm, '');          // strip line comments
  // No require() calls in actual code — a true leaf.
  assert.ok(!/\brequire\s*\(/.test(src), 'permissionPromptPort must not require anything');
});

test('service layer no longer reverse-requires cli/ui/permissionDialog', () => {
  for (const rel of ['services/toolCalling.js', 'services/preflightPermission.js']) {
    const src = read(rel);
    assert.ok(
      !/require\(['"]\.\.\/cli\/ui\/permissionDialog['"]\)/.test(src),
      `${rel} must not require ../cli/ui/permissionDialog (reverse layering edge)`,
    );
  }
});

test('cli/ui/permissionDialog self-registers its prompter into the port on load', () => {
  port._resetForTest();
  // Fresh require of the cli dialog must wire both prompters via the port.
  delete require.cache[require.resolve('../src/cli/ui/permissionDialog')];
  require('../src/cli/ui/permissionDialog');
  const p = port.getPermissionPrompter();
  assert.ok(p, 'prompter registered after cli dialog load');
  assert.strictEqual(typeof p.prompt, 'function');
  assert.strictEqual(typeof p.promptBatch, 'function');
  port._resetForTest();
});

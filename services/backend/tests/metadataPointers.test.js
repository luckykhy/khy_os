'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ptr = require('../src/services/metadataPointers');

function read(root, rel) { return fs.readFileSync(path.join(root, rel), 'utf8'); }

describe('metadataPointers — AI entry-point pointers to .ai/', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-ptr-')); });
  afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

  test('creates pointer files for all targets when absent', () => {
    const r = ptr.linkAgentPointers(tmp);
    assert.equal(r.ok, true);
    for (const f of ['AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md',
      '.cursor/rules/khy-maintainability.mdc', '.windsurfrules', '.clinerules']) {
      assert.ok(fs.existsSync(path.join(tmp, f)), `${f} should exist`);
      assert.match(read(tmp, f), /\.ai\/MAP\.md/);
    }
    // mdc carries frontmatter so Cursor always applies it.
    assert.match(read(tmp, '.cursor/rules/khy-maintainability.mdc'), /alwaysApply: true/);
  });

  test('injects a marked block into an existing file without destroying content', () => {
    const original = '# My Project\n\nSome existing human-written guidance.\n';
    fs.writeFileSync(path.join(tmp, 'AGENTS.md'), original, 'utf8');
    const r = ptr.linkAgentPointers(tmp, {});
    assert.ok(r.written.includes('AGENTS.md'));
    const after = read(tmp, 'AGENTS.md');
    assert.ok(after.startsWith(original), 'original content preserved at top');
    assert.match(after, /khy-metadata:pointer START/);
    assert.match(after, /\.ai\/GUARDS\.md/);
  });

  test('is idempotent: a second run changes nothing', () => {
    ptr.linkAgentPointers(tmp);
    const before = read(tmp, 'AGENTS.md');
    const r2 = ptr.linkAgentPointers(tmp);
    assert.ok(r2.unchanged.includes('AGENTS.md'));
    assert.equal(read(tmp, 'AGENTS.md'), before);
  });

  test('updates only the marked block, leaving surrounding edits intact', () => {
    ptr.linkAgentPointers(tmp);
    // Human appends content after our block.
    const p = path.join(tmp, 'AGENTS.md');
    fs.writeFileSync(p, read(tmp, 'AGENTS.md') + '\n## Human section\nkeep me\n', 'utf8');
    // Tamper inside the block to force a rewrite.
    const dirty = read(tmp, 'AGENTS.md').replace('read `.ai/` first', 'TAMPERED');
    fs.writeFileSync(p, dirty, 'utf8');
    const r = ptr.linkAgentPointers(tmp);
    assert.ok(r.written.includes('AGENTS.md'));
    const after = read(tmp, 'AGENTS.md');
    assert.match(after, /read `\.ai\/` first/);   // block restored
    assert.match(after, /## Human section\nkeep me/); // human content untouched
  });

  test('never overwrites a foreign .mdc at our path', () => {
    const mdc = path.join(tmp, '.cursor/rules/khy-maintainability.mdc');
    fs.mkdirSync(path.dirname(mdc), { recursive: true });
    fs.writeFileSync(mdc, 'someone elses cursor rule\n', 'utf8');
    const r = ptr.linkAgentPointers(tmp);
    assert.ok(r.skipped.includes('.cursor/rules/khy-maintainability.mdc'));
    assert.equal(read(tmp, '.cursor/rules/khy-maintainability.mdc'), 'someone elses cursor rule\n');
  });

  test('KHY_META_POINTER_TARGETS restricts the set; KHY_META_LINK=0 disables', () => {
    const prevT = process.env.KHY_META_POINTER_TARGETS;
    process.env.KHY_META_POINTER_TARGETS = 'agents';
    try {
      const r = ptr.linkAgentPointers(tmp);
      assert.deepEqual(r.written, ['AGENTS.md']);
      assert.ok(!fs.existsSync(path.join(tmp, 'CLAUDE.md')));
    } finally {
      if (prevT === undefined) delete process.env.KHY_META_POINTER_TARGETS;
      else process.env.KHY_META_POINTER_TARGETS = prevT;
    }

    const prevL = process.env.KHY_META_LINK;
    process.env.KHY_META_LINK = '0';
    try {
      const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-ptr2-'));
      const r = ptr.linkAgentPointers(tmp2);
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'disabled');
      fs.rmSync(tmp2, { recursive: true, force: true });
    } finally {
      if (prevL === undefined) delete process.env.KHY_META_LINK;
      else process.env.KHY_META_LINK = prevL;
    }
  });
});

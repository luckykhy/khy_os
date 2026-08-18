'use strict';

/**
 * instructionEcosystemDiscovery — integration test for the SHELL half of the
 * rules-ecosystem bridge (`instructionFileService.discoverEcosystemInstructionFiles`).
 *
 * The pure leaf (instructionEcosystemRegistry) is covered separately; this file
 * pins the parts that only exist once real files are on disk:
 *   - foreign rule files are actually read and attributed to their ecosystem,
 *   - directory sources are scanned, sorted, and capped,
 *   - path-scoped rules are dropped (Cursor `alwaysApply:false`, narrow `applyTo:`),
 *   - the tier has its own char budget and never crowds khy's own instructions,
 *   - `seen` de-dup: a file khy already loaded natively is not loaded twice,
 *   - gate OFF ⇒ byte-identical revert (empty array).
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const reg = require('../src/services/instructionEcosystemRegistry');
const svc = require('../src/services/instructionFileService');

let _n = 0;
function mkProject(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `khy-eco-rules-${_n++}-`));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body, 'utf-8');
  }
  return root;
}

function discover(root, seen = new Set()) {
  return svc.discoverEcosystemInstructionFiles(root, seen);
}

/** Run body with env vars applied, then restore. */
function withEnv(vars, body) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  try {
    return body();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }
}

test('a foreign rule file is discovered, attributed, and marked ecosystem-level', () => {
  const root = mkProject({ 'GEMINI.md': '# House rules\n- run the tests\n' });
  const out = discover(root);
  const hit = out.find((f) => f.path.endsWith('GEMINI.md'));
  assert.ok(hit, 'a rule file another agent wrote must be picked up');
  assert.strictEqual(hit.level, 'ecosystem');
  assert.strictEqual(hit.ecosystem, 'gemini');
  assert.match(hit.label, /Gemini/);
  assert.match(hit.content, /run the tests/);
});

test('CLAUDE.md / AGENTS.md are left to the prompts.js compat block, not double-injected', () => {
  const root = mkProject({
    'AGENTS.md': 'agents rules',
    'CLAUDE.md': 'claude rules',
    '.claude/CLAUDE.md': 'claude dir rules',
  });
  assert.deepStrictEqual(
    discover(root),
    [],
    'the eco tier must cede these three to their dedicated bridge'
  );
});

test('several ecosystems in one repo are all picked up, in table order', () => {
  const root = mkProject({
    '.cursorrules': 'cursor legacy rules',
    '.github/copilot-instructions.md': 'copilot rules',
    'GEMINI.md': 'gemini rules',
    '.rules': 'zed rules',
    'CONVENTIONS.md': 'aider conventions',
  });
  const ids = discover(root).map((f) => f.ecosystem);
  assert.deepStrictEqual(ids, ['cursor', 'copilot', 'gemini', 'zed', 'aider']);
});

test('directory sources are scanned, sorted by filename, and capped', () => {
  const files = {};
  for (let i = 0; i < reg.ECO_MAX_FILES_PER_DIR + 5; i++) {
    files[`.roo/rules/${String(i).padStart(2, '0')}-rule.md`] = `rule ${i}\n`;
  }
  const root = mkProject(files);
  const roo = discover(root).filter((f) => f.ecosystem === 'roo');
  assert.strictEqual(roo.length, reg.ECO_MAX_FILES_PER_DIR, 'a big rules dir must not blow the budget');
  assert.ok(roo[0].path.endsWith('00-rule.md'), 'sorted, so the order is deterministic');
  assert.ok(roo[1].path.endsWith('01-rule.md'));
});

test('scoped rules: only always-on Cursor rules are adopted', () => {
  const root = mkProject({
    '.cursor/rules/a-global.mdc': '---\ndescription: style\nalwaysApply: true\n---\nUse 2 spaces.',
    '.cursor/rules/b-scoped.mdc': '---\ndescription: react\nglobs: src/**\nalwaysApply: false\n---\nHooks only.',
    '.cursor/rules/c-plain.md': 'No frontmatter, always on.',
  });
  const paths = discover(root)
    .filter((f) => f.ecosystem === 'cursor')
    .map((f) => path.basename(f.path));
  assert.deepStrictEqual(paths, ['a-global.mdc', 'c-plain.md']);
});

test('scoped rules: Copilot instructions honour applyTo width', () => {
  const root = mkProject({
    '.github/instructions/wide.instructions.md': "---\napplyTo: '**'\n---\nAlways write tests.",
    '.github/instructions/narrow.instructions.md': "---\napplyTo: 'src/**/*.ts'\n---\nUse strict.",
  });
  const hits = discover(root).filter((f) => f.ecosystem === 'copilot');
  assert.strictEqual(hits.length, 1);
  assert.ok(hits[0].path.endsWith('wide.instructions.md'));
});

test('non-scoped sources are adopted verbatim even with frontmatter-looking text', () => {
  // .cursorrules has no scoping convention, so it must not be filtered.
  const root = mkProject({ '.cursorrules': '---\nglobs: src/**\n---\nlegacy rules body' });
  const hits = discover(root).filter((f) => f.ecosystem === 'cursor');
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].kind, 'legacy');
});

test('budgets: per-file truncation and a hard tier total', () => {
  const big = 'x'.repeat(reg.ECO_MAX_FILE_CHARS * 2);
  const root = mkProject({
    '.cursorrules': big,
    'GEMINI.md': big,
    '.rules': big,
    'CONVENTIONS.md': big,
  });
  const out = discover(root);
  const total = out.reduce((n, f) => n + f.content.length, 0);
  assert.ok(total <= reg.ECO_MAX_TOTAL_CHARS, `tier total ${total} must stay within budget`);
  for (const f of out) {
    assert.ok(f.content.length <= reg.ECO_MAX_FILE_CHARS);
    assert.strictEqual(f.truncated, true);
  }
});

test('empty / whitespace-only rule files are skipped rather than injected', () => {
  const root = mkProject({ '.cursorrules': '   \n\n\t\n', 'GEMINI.md': 'real content' });
  const ids = discover(root).map((f) => f.ecosystem);
  assert.deepStrictEqual(ids, ['gemini']);
});

test('`seen` de-dup: a file khy already loaded is not loaded again', () => {
  const root = mkProject({ 'GEMINI.md': 'rules' });
  const seen = new Set([path.resolve(path.join(root, 'GEMINI.md'))]);
  assert.deepStrictEqual(discover(root, seen), []);
});

test('gate OFF ⇒ byte-identical revert (nothing discovered at all)', () => {
  const root = mkProject({ 'GEMINI.md': 'rules', '.cursorrules': 'more rules' });
  assert.ok(discover(root).length > 0, 'sanity: the gate is on by default');
  withEnv({ KHY_RULES_ECOSYSTEM: '0' }, () => {
    assert.deepStrictEqual(discover(root), []);
  });
  // Per-family gate removes exactly one family.
  withEnv({ KHY_RULES_ECO_CURSOR: '0' }, () => {
    const ids = discover(root).map((f) => f.ecosystem);
    assert.deepStrictEqual(ids, ['gemini']);
  });
});

test('a missing / unreadable project dir is fail-soft, never throws', () => {
  assert.deepStrictEqual(discover(path.join(os.tmpdir(), 'khy-eco-does-not-exist-xyz')), []);
  assert.deepStrictEqual(discover(''), []);
  assert.deepStrictEqual(discover(null), []);
  assert.deepStrictEqual(discover(undefined, new Set()), []);
});

test('loadInstructions attributes the source agent in the injected header', () => {
  const root = mkProject({ 'GEMINI.md': 'ecosystem body text' });
  const merged = svc.loadInstructions(root);
  assert.match(merged, /\[生态指令\(Gemini[^\]]*\) - /, 'header must name where the rule came from');
  assert.match(merged, /ecosystem body text/);
});

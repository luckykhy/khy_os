'use strict';

/**
 * instructionEcosystemRegistry — pins the declarative SSOT that lets khy **reuse
 * the project rules other agents already have on disk** (goal 2026-08-18
 * 「蹭生态」第二块). Zero-IO: homedir/projectDir/env are injected and file TEXT
 * is passed in, so the suite is deterministic and platform-independent.
 *
 * Covers: table well-formedness, the two-level gate (global + per-family),
 * source enumeration/ordering/dedup, base resolution, frontmatter parsing, and
 * the scope filter that keeps path-scoped rules (Cursor `alwaysApply:false` /
 * `globs:`, Copilot narrow `applyTo:`, Kiro `inclusion:fileMatch`) out of a
 * prompt that has no per-file scoping — plus fail-soft on junk (never throws).
 */

const assert = require('node:assert');
const path = require('node:path');
const { test } = require('node:test');

const reg = require('../src/services/instructionEcosystemRegistry');

const HOME = '/home/u';
const PROJ = '/work/repo';

// ── table shape ─────────────────────────────────────────────────────────────

test('ECOSYSTEMS: every entry is well-formed and uniquely gated', () => {
  const ids = new Set();
  const gates = new Set();
  const BASES = new Set(['home', 'project']);
  assert.ok(reg.ECOSYSTEMS.length >= 12, 'the point of the registry is breadth');
  for (const e of reg.ECOSYSTEMS) {
    assert.ok(e.id && !ids.has(e.id), `duplicate/missing id: ${e.id}`);
    ids.add(e.id);
    assert.ok(e.label, `${e.id}: missing label`);
    assert.match(e.gate, /^KHY_RULES_ECO_[A-Z0-9_]+$/, `${e.id}: gate naming`);
    assert.ok(!gates.has(e.gate), `${e.id}: duplicate gate ${e.gate}`);
    gates.add(e.gate);
    assert.ok(['local', 'doc'].includes(e.evidence), `${e.id}: evidence must be local|doc`);
    assert.ok(Array.isArray(e.sources) && e.sources.length, `${e.id}: no sources`);
    for (const s of e.sources) {
      assert.ok(BASES.has(s.base), `${e.id}: bad base ${s.base}`);
      assert.ok(Array.isArray(s.segs) && s.segs.length, `${e.id}: empty segs`);
      assert.ok(['file', 'dir'].includes(s.mode), `${e.id}: bad mode ${s.mode}`);
      assert.ok(s.kind, `${e.id}: source missing kind`);
      if (s.mode === 'dir') {
        assert.ok(Array.isArray(s.exts) && s.exts.length, `${e.id}: dir source needs exts`);
        for (const ext of s.exts) {
          assert.match(ext, /^\.[a-z0-9]+$/, `${e.id}: ext must be lowercase dotted`);
        }
      }
    }
  }
});

test('ECOSYSTEMS: frozen, and khy-native / already-owned sources are deliberately absent', () => {
  assert.ok(Object.isFrozen(reg.ECOSYSTEMS));
  assert.ok(Object.isFrozen(reg.ECOSYSTEMS[0]));
  assert.ok(Object.isFrozen(reg.ECOSYSTEMS[0].sources));
  const segs = reg.ECOSYSTEMS.flatMap((e) => e.sources.map((s) => s.segs.join('/')));
  // khy's own discovery chain must not be duplicated into the ecosystem tier.
  for (const own of ['khy.md', 'KHY.md', '.khy/rules', 'agent.md', 'AGENT.md']) {
    assert.ok(!segs.includes(own), `${own} belongs to khy's native chain, not the eco tier`);
  }
  // prompts.js `_findCompatInstructionFiles` already injects these three (with its
  // own language-directive reconciliation) — registering them here would inject the
  // same rules twice and scramble the fixed KHY > CLAUDE > AGENTS precedence.
  for (const owned of ['CLAUDE.md', '.claude/CLAUDE.md', 'AGENTS.md']) {
    assert.ok(!segs.includes(owned), `${owned} is owned by prompts.js's compat block`);
  }
  // Commands/skills are other bridges' surfaces, not rules.
  assert.ok(!segs.some((s) => s.startsWith('.claude/commands')));
  assert.ok(!segs.some((s) => s.startsWith('.claude/skills')));
  for (const k of ['khy', 'claude-md', 'agents-md-root', 'github-prompts', 'claude-commands', 'claude-skills']) {
    assert.ok(Object.prototype.hasOwnProperty.call(reg.EXCLUDED, k), `EXCLUDED should document ${k}`);
  }
});

test('the user-level ~/.codex/AGENTS.md IS registered — the compat block never reads it', () => {
  const codex = reg.ECOSYSTEMS.find((e) => e.id === 'codex');
  assert.ok(codex, 'codex entry must exist');
  assert.deepStrictEqual(
    codex.sources.map((s) => [s.base, s.segs.join('/')]),
    [['home', '.codex/AGENTS.md']]
  );
});

// ── gates ───────────────────────────────────────────────────────────────────

test('global gate KHY_RULES_ECOSYSTEM: default ON, {0,false,off,no} OFF', () => {
  assert.strictEqual(reg.isInstructionEcosystemEnabled({}), true);
  assert.strictEqual(reg.isInstructionEcosystemEnabled({ KHY_RULES_ECOSYSTEM: 'true' }), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(
      reg.isInstructionEcosystemEnabled({ KHY_RULES_ECOSYSTEM: v }),
      false,
      `expected off for ${v}`
    );
  }
});

test('gate OFF → no sources at all (shell loop becomes a no-op)', () => {
  assert.deepStrictEqual(
    reg.instructionEcosystemSources({
      homedir: HOME,
      projectDir: PROJ,
      env: { KHY_RULES_ECOSYSTEM: '0' },
    }),
    []
  );
  assert.deepStrictEqual(reg.getEcosystems({ KHY_RULES_ECOSYSTEM: 'off' }), []);
});

test('per-family gate turns off exactly one ecosystem; parent OFF wins', () => {
  assert.strictEqual(reg.isEcosystemEnabled('cursor', {}), true);
  assert.strictEqual(reg.isEcosystemEnabled('cursor', { KHY_RULES_ECO_CURSOR: '0' }), false);
  assert.strictEqual(reg.isEcosystemEnabled('aider', { KHY_RULES_ECO_CURSOR: '0' }), true);
  assert.strictEqual(reg.isEcosystemEnabled('cursor', { KHY_RULES_ECOSYSTEM: '0' }), false);
  assert.strictEqual(reg.isEcosystemEnabled('nope-not-a-thing', {}), false);
  const ids = reg
    .instructionEcosystemSources({ projectDir: PROJ, env: { KHY_RULES_ECO_CURSOR: 'no' } })
    .map((s) => s.ecosystem);
  assert.ok(!ids.includes('cursor'));
  assert.ok(ids.includes('aider'));
});

// ── path resolution / enumeration ───────────────────────────────────────────

test('resolveBase: home/project resolve, everything else is empty', () => {
  assert.strictEqual(reg.resolveBase('home', { homedir: HOME }), HOME);
  assert.strictEqual(reg.resolveBase('project', { projectDir: PROJ }), PROJ);
  assert.strictEqual(reg.resolveBase('project', {}), '');
  assert.strictEqual(reg.resolveBase('userAppConfig', { homedir: HOME }), '');
  assert.strictEqual(reg.resolveBase('nope', { homedir: HOME }), '');
});

test('sources: the well-known rules paths all appear', () => {
  const paths = reg
    .instructionEcosystemSources({ homedir: HOME, projectDir: PROJ, env: {} })
    .map((s) => s.path);
  for (const expected of [
    path.join(HOME, '.codex', 'AGENTS.md'),
    path.join(PROJ, '.cursor', 'rules'),
    path.join(PROJ, '.cursorrules'),
    path.join(PROJ, '.github', 'copilot-instructions.md'),
    path.join(PROJ, '.github', 'instructions'),
    path.join(PROJ, '.windsurfrules'),
    path.join(PROJ, '.clinerules'),
    path.join(PROJ, 'GEMINI.md'),
    path.join(PROJ, '.kiro', 'steering'),
    path.join(PROJ, 'CONVENTIONS.md'),
    path.join(PROJ, '.rules'),
  ]) {
    assert.ok(paths.includes(expected), `missing source: ${expected}`);
  }
});

test('sources: each carries the read recipe, and ordering is deterministic', () => {
  const args = { homedir: HOME, projectDir: PROJ, env: {} };
  const a = reg.instructionEcosystemSources(args);
  assert.deepStrictEqual(a, reg.instructionEcosystemSources(args));

  const cursorRules = a.find((s) => s.ecosystem === 'cursor' && s.mode === 'dir');
  assert.deepStrictEqual(cursorRules.exts, ['.mdc', '.md']);
  assert.strictEqual(cursorRules.scoped, true);
  assert.strictEqual(cursorRules.maxFiles, reg.ECO_MAX_FILES_PER_DIR);

  const conventions = a.find((s) => s.ecosystem === 'aider');
  assert.strictEqual(conventions.mode, 'file');
  assert.strictEqual(
    conventions.scoped,
    false,
    'CONVENTIONS.md has no scoping frontmatter convention'
  );
  assert.ok(conventions.label && conventions.kind && conventions.evidence);

  // Table order is the injection order the shell relies on.
  const ids = [...new Set(a.map((s) => s.ecosystem))];
  assert.deepStrictEqual(ids, reg.ECOSYSTEMS.map((e) => e.id).filter((id) => ids.includes(id)));
});

test('sources: .clinerules is registered as BOTH a file and a directory', () => {
  const cline = reg
    .instructionEcosystemSources({ projectDir: PROJ, env: {} })
    .filter((s) => s.ecosystem === 'cline');
  assert.strictEqual(cline.length, 2, 'the same path under two modes must not be deduped away');
  assert.deepStrictEqual(
    cline.map((s) => s.mode).sort(),
    ['dir', 'file']
  );
});

test('sources: missing homedir/projectDir drops only the affected sources', () => {
  const projPrefix = path.join(PROJ);
  const projOnly = reg.instructionEcosystemSources({ projectDir: PROJ, env: {} });
  assert.ok(projOnly.length > 0);
  assert.ok(projOnly.every((s) => s.path.startsWith(projPrefix)));

  const homeOnly = reg.instructionEcosystemSources({ homedir: HOME, env: {} });
  assert.ok(homeOnly.length > 0);
  assert.ok(homeOnly.every((s) => s.path.startsWith(path.join(HOME))));

  assert.deepStrictEqual(reg.instructionEcosystemSources({ env: {} }), []);
  assert.deepStrictEqual(reg.instructionEcosystemSources(), reg.instructionEcosystemSources({}));
});

// ── frontmatter parsing ─────────────────────────────────────────────────────

test('parseRuleFrontmatter: reads the keys we act on, ignores the rest', () => {
  const meta = reg.parseRuleFrontmatter(
    ['---', 'description: My rule', 'globs: "*.tsx"', 'alwaysApply: false', 'other: junk', '---', 'body'].join('\n')
  );
  assert.strictEqual(meta.description, 'My rule');
  assert.strictEqual(meta.globs, '*.tsx');
  assert.strictEqual(meta.alwaysApply, false);
  assert.strictEqual(meta.other, undefined);
});

test('parseRuleFrontmatter: CRLF, single quotes, and applyTo/inclusion', () => {
  assert.strictEqual(
    reg.parseRuleFrontmatter("---\r\napplyTo: '**'\r\n---\r\nbody").applyTo,
    '**'
  );
  assert.strictEqual(
    reg.parseRuleFrontmatter('---\ninclusion: fileMatch\n---\n').inclusion,
    'fileMatch'
  );
  assert.strictEqual(reg.parseRuleFrontmatter('---\nalwaysApply: TRUE\n---\n').alwaysApply, true);
});

test('parseRuleFrontmatter: fail-soft — no frontmatter, junk, non-string → {}', () => {
  for (const bad of ['', null, undefined, 42, {}, 'plain markdown', 'text\n---\nnot at top\n---\n']) {
    assert.deepStrictEqual(reg.parseRuleFrontmatter(bad), {}, `expected {} for ${bad}`);
  }
});

// ── scope filter ────────────────────────────────────────────────────────────

test('isAlwaysOnRule: alwaysApply is authoritative when present', () => {
  assert.strictEqual(reg.isAlwaysOnRule({ alwaysApply: true, globs: '*.ts' }), true);
  assert.strictEqual(reg.isAlwaysOnRule({ alwaysApply: false }), false);
});

test('isAlwaysOnRule: Kiro inclusion — only `always` is always-on', () => {
  assert.strictEqual(reg.isAlwaysOnRule({ inclusion: 'always' }), true);
  assert.strictEqual(reg.isAlwaysOnRule({ inclusion: 'Always' }), true);
  assert.strictEqual(reg.isAlwaysOnRule({ inclusion: 'fileMatch' }), false);
  assert.strictEqual(reg.isAlwaysOnRule({ inclusion: 'manual' }), false);
});

test('isAlwaysOnRule: only repo-wide globs survive the applyTo/globs filter', () => {
  for (const g of ['**', '**/*', '*', './**']) {
    assert.strictEqual(reg.isAlwaysOnRule({ applyTo: g }), true, `${g} is repo-wide`);
  }
  for (const g of ['src/**', '*.tsx', '**/*.py']) {
    assert.strictEqual(reg.isAlwaysOnRule({ applyTo: g }), false, `${g} is scoped`);
  }
  // Comma-separated list: any repo-wide member makes it global.
  assert.strictEqual(reg.isAlwaysOnRule({ globs: '"src/**", "**"' }), true);
  assert.strictEqual(reg.isAlwaysOnRule({ globs: 'src/**, test/**' }), false);
});

test('isAlwaysOnRule: no scoping keys at all → adopted (plain rule file)', () => {
  assert.strictEqual(reg.isAlwaysOnRule({}), true);
  assert.strictEqual(reg.isAlwaysOnRule({ description: 'just a description' }), true);
  assert.strictEqual(reg.isAlwaysOnRule(null), true);
  assert.strictEqual(reg.isAlwaysOnRule(42), true);
});

test('evaluateScopedRule: end-to-end on realistic rule files', () => {
  // Cursor: agent-requested rule → not always-on.
  const cursorScoped = reg.evaluateScopedRule(
    ['---', 'description: React component conventions', 'globs: src/components/**', 'alwaysApply: false', '---', '- use hooks'].join('\n')
  );
  assert.strictEqual(cursorScoped.accept, false);
  assert.strictEqual(cursorScoped.meta.description, 'React component conventions');

  // Cursor: always-applied rule → adopted.
  assert.strictEqual(
    reg.evaluateScopedRule('---\ndescription: House style\nalwaysApply: true\n---\n- 2 spaces').accept,
    true
  );
  // Copilot: repo-wide instructions file → adopted.
  assert.strictEqual(reg.evaluateScopedRule("---\napplyTo: '**'\n---\nAlways write tests.").accept, true);
  // Copilot: narrow applyTo → skipped.
  assert.strictEqual(reg.evaluateScopedRule("---\napplyTo: '**/*.ts'\n---\nUse strict.").accept, false);
  // Plain markdown with no frontmatter → adopted.
  assert.strictEqual(reg.evaluateScopedRule('# Rules\n- be nice').accept, true);
  // Junk → never throws.
  assert.strictEqual(reg.evaluateScopedRule(null).accept, true);
});

// ── budgets ─────────────────────────────────────────────────────────────────

test('the ecosystem tier can never crowd out khy own instructions', () => {
  const own = require('../src/services/instructionFileService');
  assert.ok(reg.ECO_MAX_FILE_CHARS <= own.MAX_FILE_CHARS);
  assert.ok(reg.ECO_MAX_TOTAL_CHARS < own.MAX_TOTAL_CHARS);
  assert.ok(reg.ECO_MAX_FILES_PER_DIR > 0);
});

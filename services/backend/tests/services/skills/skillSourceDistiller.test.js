'use strict';

/**
 * skillSourceDistiller.test.js — pure-leaf contract lock for the `/learn` source
 * distiller (Hermes v0.18.0 `/learn` reference, adapted to Khy-OS's deterministic
 * engine model).
 *
 * Locks the HARDLINE guarantees:
 *   - description clamped to <=60 chars, ends with a period, marketing words stripped;
 *   - name lowercase-hyphenated <=64 (dir basename / url host+path);
 *   - commands + headings extracted VERBATIM (never invented);
 *   - deterministic (same input → byte-identical output);
 *   - never throws on null / garbage / empty;
 *   - empty documents → { ok:false }.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const L = require('../../../src/services/skills/skillSourceDistiller');

const DOC = {
  name: 'README.md',
  text: [
    '# Arxiv Search',
    '',
    'Search papers by keyword.',
    '',
    '## When to Use',
    '- find academic papers',
    '',
    '## Quick Reference',
    '```bash',
    '$ arxiv-search --q neural',
    'npm run build',
    '# a comment that must be skipped',
    '```',
  ].join('\n'),
};

test('description: <=60 chars, ends with period, marketing words stripped', () => {
  const d = L.clampDescription(
    'A powerful comprehensive seamless advanced robust tool for searching arxiv papers by keyword and author quickly'
  );
  assert.ok(d.length <= 60, `len=${d.length}`);
  assert.ok(d.endsWith('.'));
  assert.ok(!/powerful|comprehensive|seamless|advanced|robust/i.test(d), 'no marketing words');
});

test('description: empty / null → safe default', () => {
  assert.strictEqual(L.clampDescription(''), 'Learned skill from source.');
  assert.strictEqual(L.clampDescription(null), 'Learned skill from source.');
});

test('name: directory basename → lowercase-hyphenated, extension dropped', () => {
  assert.strictEqual(L.deriveSkillName('/tmp/foo/My_Cool Tool/', 'directory'), 'my-cool-tool');
  assert.strictEqual(L.deriveSkillName('/a/b/parser.js', 'directory'), 'parser');
});

test('name: url → hostname + last path segment', () => {
  assert.strictEqual(L.deriveSkillName('https://www.example.com/docs/auth-flow?x=1', 'url'), 'example-auth-flow');
  assert.strictEqual(L.deriveSkillName('http://api.site.io/', 'url'), 'api');
});

test('name: empty / garbage → learned-skill fallback', () => {
  assert.strictEqual(L.deriveSkillName('', 'directory'), 'learned-skill');
  assert.strictEqual(L.deriveSkillName('////', 'directory'), 'learned-skill');
  assert.strictEqual(L.deriveSkillName(null, 'url'), 'learned-skill');
});

test('commands: extracted verbatim, prompt stripped, comments skipped, deduped', () => {
  const cmds = L.extractCommands(DOC.text);
  assert.deepStrictEqual(cmds, ['arxiv-search --q neural', 'npm run build']);
  assert.ok(!cmds.some((c) => c.includes('comment')), 'comment line skipped');
});

test('headings: extracted verbatim, deduped, order preserved', () => {
  const hs = L.extractHeadings(DOC.text);
  assert.deepStrictEqual(hs, ['Arxiv Search', 'When to Use', 'Quick Reference']);
});

test('distill: happy path shape + verbatim content + no invention', () => {
  const r = L.distillSkillFromSources({ sourceType: 'directory', sourceRef: '/x/arxiv', documents: [DOC] });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.name, 'arxiv');
  assert.ok(r.description.length <= 60 && r.description.endsWith('.'));
  assert.strictEqual(r.category, 'reference');
  assert.deepStrictEqual(r.commands, ['arxiv-search --q neural', 'npm run build']);
  assert.deepStrictEqual(r.sources, ['README.md']);
  // Body only contains verbatim commands — nothing invented.
  assert.ok(r.body.includes('arxiv-search --q neural'));
  assert.ok(!/invent/i.test(r.commands.join(' ')));
});

test('distill: deterministic — same input → byte-identical output', () => {
  const input = { sourceType: 'directory', sourceRef: '/x/arxiv', documents: [DOC] };
  const a = L.distillSkillFromSources(input);
  const b = L.distillSkillFromSources(input);
  assert.deepStrictEqual(a, b);
  assert.strictEqual(a.body, b.body);
});

test('distill: empty docs / null / garbage → ok:false, never throws', () => {
  assert.strictEqual(L.distillSkillFromSources({ documents: [] }).ok, false);
  assert.strictEqual(L.distillSkillFromSources(null).ok, false);
  assert.strictEqual(L.distillSkillFromSources({ documents: [{ text: '   ' }] }).ok, false);
  assert.doesNotThrow(() => L.distillSkillFromSources({ documents: [{ text: 123 }] }));
});

test('distill: source with no headings/commands → ok with warning', () => {
  const r = L.distillSkillFromSources({
    sourceType: 'url', sourceRef: 'https://x.io/notes', documents: [{ name: 'notes', text: 'just some prose here' }],
  });
  assert.strictEqual(r.ok, true);
  assert.ok(r.warnings.length >= 1);
});

test('MAX_DESCRIPTION_CHARS constant is 60', () => {
  assert.strictEqual(L.MAX_DESCRIPTION_CHARS, 60);
});

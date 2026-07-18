'use strict';

const test = require('node:test');
const assert = require('node:assert');

const spec = require('../../src/skills/skillSourceSpec');

// ── 门控 ──────────────────────────────────────────────────────────────────────
test('isSkillAddEnabled: CANON gating (0/false/off/no → off; disable stays on)', () => {
  assert.strictEqual(spec.isSkillAddEnabled({}), true);
  assert.strictEqual(spec.isSkillAddEnabled({ KHY_SKILL_ADD: 'off' }), false);
  assert.strictEqual(spec.isSkillAddEnabled({ KHY_SKILL_ADD: '0' }), false);
  assert.strictEqual(spec.isSkillAddEnabled({ KHY_SKILL_ADD: 'no' }), false);
  assert.strictEqual(spec.isSkillAddEnabled({ KHY_SKILL_ADD: 'false' }), false);
  // EXTENDED 词对 CANON flag 视为「开」
  assert.strictEqual(spec.isSkillAddEnabled({ KHY_SKILL_ADD: 'disable' }), true);
});

// ── parseSource:各种写法 ──────────────────────────────────────────────────────
test('parseSource: owner/repo shorthand → github https .git', () => {
  const r = spec.parseSource('anthropics/skills');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.spec.host, 'github.com');
  assert.strictEqual(r.spec.owner, 'anthropics');
  assert.strictEqual(r.spec.repo, 'skills');
  assert.strictEqual(r.spec.url, 'https://github.com/anthropics/skills.git');
  assert.strictEqual(r.spec.ref, '');
  assert.strictEqual(r.spec.subdir, '');
  assert.strictEqual(r.spec.kind, 'shorthand');
});

test('parseSource: owner/repo#ref carries ref', () => {
  const r = spec.parseSource('anthropics/skills#v2');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.spec.ref, 'v2');
  assert.strictEqual(r.spec.url, 'https://github.com/anthropics/skills.git');
});

test('parseSource: owner/repo/sub/dir → subdir', () => {
  const r = spec.parseSource('anthropics/skills/doc-coauthoring');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.spec.repo, 'skills');
  assert.strictEqual(r.spec.subdir, 'doc-coauthoring');
});

test('parseSource: https URL normalizes to .git', () => {
  const r = spec.parseSource('https://github.com/anthropics/skills');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.spec.url, 'https://github.com/anthropics/skills.git');
  assert.strictEqual(r.spec.host, 'github.com');
});

test('parseSource: https .git kept', () => {
  const r = spec.parseSource('https://github.com/anthropics/skills.git');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.spec.repo, 'skills');
  assert.strictEqual(r.spec.url, 'https://github.com/anthropics/skills.git');
});

test('parseSource: tree URL splits ref + subdir', () => {
  const r = spec.parseSource('https://github.com/anthropics/skills/tree/main/doc-coauthoring');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.spec.ref, 'main');
  assert.strictEqual(r.spec.subdir, 'doc-coauthoring');
  assert.strictEqual(r.spec.url, 'https://github.com/anthropics/skills.git');
});

test('parseSource: git@ ssh', () => {
  const r = spec.parseSource('git@github.com:anthropics/skills.git');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.spec.kind, 'ssh');
  assert.strictEqual(r.spec.host, 'github.com');
  assert.strictEqual(r.spec.owner, 'anthropics');
  assert.strictEqual(r.spec.repo, 'skills');
  assert.strictEqual(r.spec.url, 'git@github.com:anthropics/skills.git');
});

test('parseSource: explicit --skill overrides path subdir', () => {
  const r = spec.parseSource('anthropics/skills/ignored', { skill: 'find-skills' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.spec.subdir, 'find-skills');
});

test('parseSource: rejects empty / junk / traversal', () => {
  assert.strictEqual(spec.parseSource('').ok, false);
  assert.strictEqual(spec.parseSource('   ').ok, false);
  assert.strictEqual(spec.parseSource('not a url').ok, false);
  // .. in --skill rejected
  const bad = spec.parseSource('a/b', { skill: '../escape' });
  assert.strictEqual(bad.ok, false);
  // absolute --skill rejected
  assert.strictEqual(spec.parseSource('a/b', { skill: '/etc' }).ok, false);
});

test('parseSource: rejects illegal ref chars', () => {
  const r = spec.parseSource('a/b#bad ref');
  assert.strictEqual(r.ok, false);
});

// ── normalizeSubdir ───────────────────────────────────────────────────────────
test('normalizeSubdir: strips ./, rejects abs/.. /drive', () => {
  assert.strictEqual(spec.normalizeSubdir('./foo/bar'), 'foo/bar');
  assert.strictEqual(spec.normalizeSubdir('foo'), 'foo');
  assert.strictEqual(spec.normalizeSubdir(''), null);
  assert.strictEqual(spec.normalizeSubdir('/abs'), null);
  assert.strictEqual(spec.normalizeSubdir('a/../b'), null);
  assert.strictEqual(spec.normalizeSubdir('C:\\x'), null);
  assert.strictEqual(spec.normalizeSubdir('a\\b'), 'a/b');
});

// ── inferSkillName ────────────────────────────────────────────────────────────
test('inferSkillName: subdir last seg preferred, else repo', () => {
  assert.strictEqual(spec.inferSkillName({ repo: 'skills', subdir: 'doc-coauthoring' }), 'doc-coauthoring');
  assert.strictEqual(spec.inferSkillName({ repo: 'skills', subdir: 'a/b/find-skills' }), 'find-skills');
  assert.strictEqual(spec.inferSkillName({ repo: 'my-skill' }), 'my-skill');
  assert.strictEqual(spec.inferSkillName({}), null);
});

// ── candidateSkillDirs ────────────────────────────────────────────────────────
test('candidateSkillDirs: subdir → only it; else root+containers', () => {
  assert.deepStrictEqual(spec.candidateSkillDirs({ subdir: 'x/y' }), ['x/y']);
  assert.deepStrictEqual(spec.candidateSkillDirs({}), ['', 'skill', 'skills', '.skills']);
});

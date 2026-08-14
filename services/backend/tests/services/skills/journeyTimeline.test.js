'use strict';

/**
 * journeyTimeline.test.js — pure leaf contract + wiring lock for `skill journey`
 * (Hermes v0.18.0 /journey, adapted to Khy-OS engine).
 *
 * The leaf is pure (zero IO, deterministic, never throws), so it is tested
 * directly with in-memory records. Wiring greps assert the service exports
 * getSkillJourney + requires the leaf, the CLI has a journey case, and
 * flagRegistry registers KHY_SKILL_JOURNEY.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { buildJourneyTimeline, formatJourneyTimeline } = require('../../../src/services/skills/journeyTimeline');

const SKILLS = [
  { id: 's1', name: 'arxiv-tool', description: 'search papers', category: 'reference', source: 'dir', learnedAt: '2026-03-01T10:00:00.000Z' },
  { id: 's2', name: 'auth-flow', description: 'call endpoint', category: 'reference', source: 'url', learnedAt: '2026-01-15T08:00:00.000Z' },
];
const MEMORIES = [
  { filename: 'a.md', frontmatter: { name: 'first-memory', description: 'earliest', metadata: { type: 'project' } }, modifiedAt: new Date('2026-02-01T00:00:00.000Z') },
  { filename: 'b.md', frontmatter: { name: 'later-memory', description: 'newest', metadata: { type: 'feedback' } }, modifiedAt: new Date('2026-04-01T00:00:00.000Z') },
];

test('buildJourneyTimeline: merges skills + memories, sorted oldest → newest', () => {
  const r = buildJourneyTimeline({ skills: SKILLS, memories: MEMORIES });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.entries.length, 4);
  const titles = r.entries.map((e) => e.title);
  // Chronological: auth-flow(01-15) < first-memory(02-01) < arxiv-tool(03-01) < later-memory(04-01)
  assert.deepStrictEqual(titles, ['auth-flow', 'first-memory', 'arxiv-tool', 'later-memory']);
  const kinds = r.entries.map((e) => e.kind);
  assert.deepStrictEqual(kinds, ['skill', 'memory', 'skill', 'memory']);
});

test('buildJourneyTimeline: summary counts + range', () => {
  const r = buildJourneyTimeline({ skills: SKILLS, memories: MEMORIES });
  assert.strictEqual(r.summary.total, 4);
  assert.strictEqual(r.summary.skillCount, 2);
  assert.strictEqual(r.summary.memoryCount, 2);
  assert.strictEqual(r.summary.earliest, '2026-01-15T08:00:00.000Z');
  assert.strictEqual(r.summary.latest, '2026-04-01T00:00:00.000Z');
  assert.strictEqual(r.summary.byCategory.reference, 2);
  assert.strictEqual(r.summary.byCategory.project, 1);
  assert.strictEqual(r.summary.byCategory.feedback, 1);
});

test('buildJourneyTimeline: memory frontmatter fields normalized; no _order leak', () => {
  const r = buildJourneyTimeline({ skills: [], memories: [MEMORIES[0]] });
  const e = r.entries[0];
  assert.strictEqual(e.kind, 'memory');
  assert.strictEqual(e.title, 'first-memory');
  assert.strictEqual(e.description, 'earliest');
  assert.strictEqual(e.category, 'project');
  assert.strictEqual(e.source, 'memory');
  assert.strictEqual(e.date, '2026-02-01T00:00:00.000Z');
  assert.ok(!('_order' in e), 'internal ordering key not leaked');
});

test('buildJourneyTimeline: undated entries sort last, preserving input order', () => {
  const skills = [
    { id: 'nd1', name: 'no-date-1', learnedAt: null },
    { id: 'dated', name: 'dated', learnedAt: '2026-05-01T00:00:00.000Z' },
    { id: 'nd2', name: 'no-date-2' },
  ];
  const r = buildJourneyTimeline({ skills, memories: [] });
  assert.deepStrictEqual(r.entries.map((e) => e.title), ['dated', 'no-date-1', 'no-date-2']);
});

test('buildJourneyTimeline: deterministic — identical inputs → identical output', () => {
  const a = buildJourneyTimeline({ skills: SKILLS, memories: MEMORIES });
  const b = buildJourneyTimeline({ skills: SKILLS, memories: MEMORIES });
  assert.deepStrictEqual(a, b);
});

test('buildJourneyTimeline: never throws on malformed / missing inputs', () => {
  assert.doesNotThrow(() => buildJourneyTimeline(undefined));
  assert.doesNotThrow(() => buildJourneyTimeline({}));
  assert.doesNotThrow(() => buildJourneyTimeline({ skills: null, memories: 'nope' }));
  const r = buildJourneyTimeline({ skills: [null, {}, 42, { name: 'ok' }], memories: [undefined, { frontmatter: null }] });
  assert.strictEqual(r.ok, true);
  // Only the one skill with a title survives; nameless/typeless records dropped.
  assert.strictEqual(r.entries.length, 1);
  assert.strictEqual(r.entries[0].title, 'ok');
});

test('buildJourneyTimeline: accepts epoch-ms and ISO date shapes', () => {
  const r = buildJourneyTimeline({
    skills: [{ id: 'e', name: 'epoch', learnedAt: Date.parse('2026-06-01T00:00:00.000Z') }],
    memories: [],
  });
  assert.strictEqual(r.entries[0].date, '2026-06-01T00:00:00.000Z');
});

test('formatJourneyTimeline: renders day/label/title lines + summary footer', () => {
  const r = buildJourneyTimeline({ skills: SKILLS, memories: MEMORIES });
  const lines = formatJourneyTimeline(r);
  assert.ok(lines.some((l) => l.includes('2026-01-15') && l.includes('auth-flow')));
  assert.ok(lines.some((l) => l.includes('[技能]')));
  assert.ok(lines.some((l) => l.includes('[记忆]')));
  assert.ok(lines[lines.length - 1].includes('共 4 项'));
});

test('formatJourneyTimeline: never throws on empty/garbage', () => {
  assert.doesNotThrow(() => formatJourneyTimeline(undefined));
  assert.doesNotThrow(() => formatJourneyTimeline({ entries: null }));
});

test('wiring: service exports getSkillJourney + requires the journey leaf', () => {
  const S = require('../../../src/services/skillLearningService');
  assert.strictEqual(typeof S.getSkillJourney, 'function');
  const svc = fs.readFileSync(path.join(__dirname, '../../../src/services/skillLearningService.js'), 'utf8');
  assert.ok(/require\(['"]\.\/skills\/journeyTimeline['"]\)/.test(svc), 'requires the journey leaf');
  assert.ok(/KHY_SKILL_JOURNEY/.test(svc), 'references the gate flag');
});

test('wiring: gate KHY_SKILL_JOURNEY off → inert disabled result', () => {
  const S = require('../../../src/services/skillLearningService');
  const r = S.getSkillJourney({ env: { KHY_SKILL_JOURNEY: '0' } });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.disabled, true);
});

test('wiring: CLI has journey case; flagRegistry registers KHY_SKILL_JOURNEY', () => {
  const cli = fs.readFileSync(path.join(__dirname, '../../../src/cli/handlers/skill.js'), 'utf8');
  assert.ok(/case 'journey'/.test(cli), 'skill.js has journey case');
  assert.ok(/getSkillJourney/.test(cli), 'CLI calls getSkillJourney');
  const reg = fs.readFileSync(path.join(__dirname, '../../../src/services/flagRegistry.js'), 'utf8');
  assert.ok(/KHY_SKILL_JOURNEY:\s*\{/.test(reg), 'flagRegistry registers KHY_SKILL_JOURNEY');
});

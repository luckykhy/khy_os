'use strict';

/**
 * Unit tests for the Memory Distillation subsystem
 * (services/memoryEngine/distiller).
 *
 * Covers:
 *   - analyze() forget rules: empty / near-duplicate / per-type staleness, and
 *     that durable types (user) survive an age that ages out a project note;
 *   - the survivor of a near-duplicate pair is the higher-value one;
 *   - applyPlan() ARCHIVES (moves, never deletes) into .archive/ with a manifest,
 *     drops the entry from MEMORY.md, and is invisible to listMemories afterward;
 *   - restore() brings memories back (all and by filename), never clobbering;
 *   - the periodic gate (intervalElapsed) and maybeDistill() modes
 *     (off / report-only default / archive) behave and stay fail-soft;
 *   - formatPlan() renders a report.
 *
 * Memories live under getMemoryDir(); we point KHY_MEMORY_DIR at a temp dir and
 * reset the path cache between tests (same harness as memoryEngine.test.js).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const PATHS = '../../../src/memdir/paths';
const DISTILLER = '../../../src/services/memoryEngine/distiller';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

let tmp;
const SAVED = {};
const ENV_KEYS = [
  'KHY_MEMORY_DIR', 'KHY_DISABLE_MEMORY',
  'KHY_MEMORY_MIN_BODY_CHARS', 'KHY_MEMORY_DUP_THRESHOLD',
  'KHY_MEMORY_DISTILL_INTERVAL_DAYS', 'KHY_MEMORY_DISTILL_AUTO',
  'KHY_MEMORY_STALE_DAYS_PROJECT', 'KHY_MEMORY_STALE_DAYS_USER',
  'KHY_MEMORY_STALE_DAYS_FEEDBACK', 'KHY_MEMORY_STALE_DAYS_REFERENCE',
  'KHY_MEMORY_STALE_DAYS', 'KHY_MEMORY_TIERS',
];

function writeMemory(filename, frontmatter, body, mtimeMs) {
  const fm = ['---'];
  for (const [k, v] of Object.entries(frontmatter)) fm.push(`${k}: ${v}`);
  fm.push('---', '', body, '');
  const file = path.join(tmp, filename);
  fs.writeFileSync(file, fm.join('\n'), 'utf8');
  const t = mtimeMs || NOW;
  fs.utimesSync(file, new Date(t), new Date(t));
}

function distiller() { return require(DISTILLER); }

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-distill-'));
  for (const k of ENV_KEYS) { SAVED[k] = process.env[k]; delete process.env[k]; }
  process.env.KHY_MEMORY_DIR = tmp;
  jest.resetModules();
  require(PATHS)._resetCache();
});

afterEach(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  for (const k of ENV_KEYS) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
  try { require(PATHS)._resetCache(); } catch {}
});

describe('distiller.analyze — forget rules', () => {
  test('flags an empty / near-empty body as "empty"', () => {
    writeMemory('empty.md', { name: 'stub', description: '', type: 'project' }, 'x', NOW);
    writeMemory('full.md', { name: 'real project', description: 'a substantial note', type: 'project' },
      'This is a genuinely substantial memory body with plenty of content.', NOW);

    const plan = distiller().analyze({ nowMs: NOW });
    const empties = plan.forget.filter((f) => f.reason === 'empty').map((f) => f.filename);
    expect(empties).toContain('empty.md');
    expect(plan.keep.map((k) => k.filename)).toContain('full.md');
  });

  test('flags a near-duplicate and keeps the higher-value (newer) survivor', () => {
    const body = 'we deploy the service using docker compose and a nginx reverse proxy';
    writeMemory('dup_old.md', { name: 'docker deploy', description: 'deploy notes', type: 'project' }, body, NOW - 30 * DAY);
    writeMemory('dup_new.md', { name: 'docker deploy', description: 'deploy notes', type: 'project' }, body, NOW - 1 * DAY);

    const plan = distiller().analyze({ nowMs: NOW });
    const dups = plan.forget.filter((f) => f.reason === 'duplicate').map((f) => f.filename);
    // The older one is archived; the newer (higher value) survives.
    expect(dups).toEqual(['dup_old.md']);
    expect(plan.keep.map((k) => k.filename)).toContain('dup_new.md');
    // A merge group records the consolidation.
    expect(plan.merge.some((g) => g.survivor === 'dup_new.md' && g.absorbed.includes('dup_old.md'))).toBe(true);
  });

  test('ages out a stale project note but keeps a same-age durable user memory', () => {
    writeMemory('old_project.md', { name: 'finished migration', description: 'done long ago', type: 'project' },
      'A finished project note that should age out after the project horizon.', NOW - 200 * DAY);
    writeMemory('user_identity.md', { name: 'user profile', description: 'who the user is', type: 'user' },
      'The user is a full-stack and OS developer who prefers a pragmatic style.', NOW - 200 * DAY);

    const plan = distiller().analyze({ nowMs: NOW });
    const stale = plan.forget.filter((f) => f.reason === 'stale').map((f) => f.filename);
    expect(stale).toContain('old_project.md');
    expect(stale).not.toContain('user_identity.md');
    expect(plan.keep.map((k) => k.filename)).toContain('user_identity.md');
  });

  test('empty store yields an empty plan', () => {
    const plan = distiller().analyze({ nowMs: NOW });
    expect(plan.stats.total).toBe(0);
    expect(plan.forget).toEqual([]);
    expect(plan.keep).toEqual([]);
  });
});

describe('distiller.analyze — permanent tier is immune from forgetting (memoryTier seam)', () => {
  // A project note (cross_session by default) aged past its horizon ages out;
  // the same note explicitly tagged `tier: permanent` must NOT be forgotten
  // while KHY_MEMORY_TIERS is on, and MUST age out again when the gate is off.
  function seedStalePermanentVsPlain() {
    writeMemory('stale_perm.md',
      { name: 'permanent fact', description: 'a fact the user pinned forever', type: 'project', tier: 'permanent' },
      'A pinned permanent fact that is old but must never be auto-forgotten.', NOW - 400 * DAY);
    writeMemory('stale_plain.md',
      { name: 'old project note', description: 'finished long ago', type: 'project' },
      'A finished project note that should age out after the project horizon.', NOW - 400 * DAY);
  }

  test('on (default): stale permanent stays in keep, stale plain ages out', () => {
    seedStalePermanentVsPlain();
    const plan = distiller().analyze({ nowMs: NOW });
    const stale = plan.forget.filter((f) => f.reason === 'stale').map((f) => f.filename);
    expect(stale).toContain('stale_plain.md');
    expect(stale).not.toContain('stale_perm.md');
    expect(plan.keep.map((k) => k.filename)).toContain('stale_perm.md');
  });

  test('off (KHY_MEMORY_TIERS=0): permanent loses immunity and ages out like any project note', () => {
    process.env.KHY_MEMORY_TIERS = '0';
    seedStalePermanentVsPlain();
    const plan = distiller().analyze({ nowMs: NOW });
    const stale = plan.forget.filter((f) => f.reason === 'stale').map((f) => f.filename);
    expect(stale).toContain('stale_plain.md');
    expect(stale).toContain('stale_perm.md'); // gate off ⇒ byte-identical legacy aging
  });

  test('an empty-bodied permanent memory is not flagged "empty" while enabled', () => {
    writeMemory('perm_stub.md',
      { name: 'pinned', description: '', type: 'project', tier: 'permanent' }, 'x', NOW);
    const plan = distiller().analyze({ nowMs: NOW });
    expect(plan.forget.map((f) => f.filename)).not.toContain('perm_stub.md');
  });
});

describe('distiller.applyPlan — archive (reversible forget)', () => {
  test('archives the forget set: moves file, writes manifest, drops index entry, invisible to listMemories', () => {
    const memdir = require('../../../src/memdir');
    writeMemory('empty.md', { name: 'stub', description: '', type: 'project' }, 'x', NOW);
    writeMemory('keep.md', { name: 'keeper', description: 'a real note', type: 'user' },
      'A durable identity memory that must never be archived.', NOW);
    // Seed an index that references the to-be-archived file.
    fs.writeFileSync(path.join(tmp, 'MEMORY.md'),
      '- [stub](empty.md) — stub\n- [keeper](keep.md) — keeper\n', 'utf8');

    const d = distiller();
    const plan = d.analyze({ nowMs: NOW });
    const res = d.applyPlan(plan, { nowMs: NOW });

    expect(res.archived).toContain('empty.md');
    // Physically moved into .archive/.
    expect(fs.existsSync(path.join(tmp, 'empty.md'))).toBe(false);
    expect(fs.existsSync(path.join(tmp, '.archive', 'empty.md'))).toBe(true);
    // Manifest records reason + original name.
    const manifest = JSON.parse(fs.readFileSync(path.join(tmp, '.archive', 'manifest.json'), 'utf8'));
    expect(manifest.some((m) => m.filename === 'empty.md' && m.reason === 'empty')).toBe(true);
    // Index entry removed for archived, kept for survivor.
    const idx = fs.readFileSync(path.join(tmp, 'MEMORY.md'), 'utf8');
    expect(idx).not.toContain('empty.md');
    expect(idx).toContain('keep.md');
    // listMemories no longer sees it (archive subdir not rescanned).
    require(PATHS)._resetCache();
    expect(memdir.listMemories().map((m) => m.filename)).not.toContain('empty.md');
  });
});

describe('distiller.restore', () => {
  test('restores all archived memories and clears the manifest', () => {
    writeMemory('empty.md', { name: 'stub', description: '', type: 'project' }, 'x', NOW);
    const d = distiller();
    d.applyPlan(d.analyze({ nowMs: NOW }), { nowMs: NOW });
    expect(fs.existsSync(path.join(tmp, 'empty.md'))).toBe(false);

    const res = d.restore();
    expect(res.restored).toContain('empty.md');
    expect(fs.existsSync(path.join(tmp, 'empty.md'))).toBe(true);
    expect(d.listArchived()).toEqual([]);
  });

  test('restores a single memory by filename, leaving others archived', () => {
    writeMemory('e1.md', { name: 'a', description: '', type: 'project' }, 'x', NOW);
    writeMemory('e2.md', { name: 'b', description: '', type: 'project' }, 'y', NOW);
    const d = distiller();
    d.applyPlan(d.analyze({ nowMs: NOW }), { nowMs: NOW });

    const res = d.restore({ filename: 'e1.md' });
    expect(res.restored).toEqual(['e1.md']);
    expect(fs.existsSync(path.join(tmp, 'e1.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'e2.md'))).toBe(false);
    expect(d.listArchived().map((m) => m.filename)).toEqual(['e2.md']);
  });

  test('does not clobber a live file with the same name on restore', () => {
    writeMemory('empty.md', { name: 'stub', description: '', type: 'project' }, 'x', NOW);
    const d = distiller();
    d.applyPlan(d.analyze({ nowMs: NOW }), { nowMs: NOW });
    // Recreate a live file with the same name before restoring.
    fs.writeFileSync(path.join(tmp, 'empty.md'), 'LIVE CONTENT', 'utf8');

    const res = d.restore({ filename: 'empty.md' });
    expect(res.restored).toEqual([]);
    expect(res.failed.length).toBe(1);
    expect(fs.readFileSync(path.join(tmp, 'empty.md'), 'utf8')).toBe('LIVE CONTENT');
    // The archived copy is preserved for a later manual resolution.
    expect(d.listArchived().map((m) => m.filename)).toContain('empty.md');
  });
});

describe('distiller periodic gate + maybeDistill', () => {
  test('intervalElapsed is true on a fresh store and false right after a run', () => {
    const d = distiller();
    expect(d.intervalElapsed(NOW)).toBe(true);
    d.distill({ nowMs: NOW }); // stamps the run
    expect(d.intervalElapsed(NOW)).toBe(false);
    // After the interval, it elapses again.
    process.env.KHY_MEMORY_DISTILL_INTERVAL_DAYS = '7';
    expect(d.intervalElapsed(NOW + 8 * DAY)).toBe(true);
  });

  test('maybeDistill default mode is report-only — analyzes but archives nothing', () => {
    writeMemory('empty.md', { name: 'stub', description: '', type: 'project' }, 'x', NOW);
    const d = distiller();
    const run = d.maybeDistill({ nowMs: NOW });
    expect(run.skipped).toBe(false);
    expect(run.mode).toBe('report');
    expect(run.applied).toBe(false);
    expect(run.plan.forget.length).toBeGreaterThan(0);
    // Nothing moved.
    expect(fs.existsSync(path.join(tmp, 'empty.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, '.archive'))).toBe(false);
  });

  test('maybeDistill respects the interval gate (skips when not elapsed)', () => {
    const d = distiller();
    d.distill({ nowMs: NOW });
    const run = d.maybeDistill({ nowMs: NOW });
    expect(run.skipped).toBe(true);
    expect(run.reason).toBe('interval-not-elapsed');
  });

  test('maybeDistill in archive mode archives (still reversible)', () => {
    process.env.KHY_MEMORY_DISTILL_AUTO = 'archive';
    writeMemory('empty.md', { name: 'stub', description: '', type: 'project' }, 'x', NOW);
    const d = distiller();
    const run = d.maybeDistill({ nowMs: NOW });
    expect(run.skipped).toBe(false);
    expect(run.applied).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'empty.md'))).toBe(false);
    expect(fs.existsSync(path.join(tmp, '.archive', 'empty.md'))).toBe(true);
    expect(d.restore().restored).toContain('empty.md');
  });

  test('maybeDistill is disabled by KHY_MEMORY_DISTILL_AUTO=off and KHY_DISABLE_MEMORY', () => {
    const d = distiller();
    process.env.KHY_MEMORY_DISTILL_AUTO = 'off';
    expect(d.maybeDistill({ nowMs: NOW }).reason).toBe('disabled');
    delete process.env.KHY_MEMORY_DISTILL_AUTO;
    process.env.KHY_DISABLE_MEMORY = '1';
    expect(d.maybeDistill({ nowMs: NOW }).reason).toBe('memory-disabled');
  });
});

describe('distiller helpers', () => {
  test('jaccard returns 1 for identical sets and 0 for disjoint', () => {
    const d = distiller();
    expect(d.jaccard(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1);
    expect(d.jaccard(new Set(['a']), new Set(['b']))).toBe(0);
    expect(d.jaccard(new Set(), new Set(['a']))).toBe(0);
  });

  test('staleThresholdDays honors per-type env overrides', () => {
    process.env.KHY_MEMORY_STALE_DAYS_PROJECT = '45';
    const d = distiller();
    expect(d.staleThresholdDays('project')).toBe(45);
    expect(d.staleThresholdDays('user')).toBeGreaterThan(1000);
  });

  test('formatPlan renders totals, forget list, and keeps', () => {
    writeMemory('empty.md', { name: 'stub', description: '', type: 'project' }, 'x', NOW);
    writeMemory('keep.md', { name: 'keeper', description: 'a real note', type: 'user' },
      'A durable identity memory worth keeping around for a long time.', NOW);
    const d = distiller();
    const text = d.formatPlan(d.analyze({ nowMs: NOW }));
    expect(text).toMatch(/共 2 条记忆/);
    expect(text).toMatch(/建议忘记/);
    expect(text).toContain('empty.md');
  });
});

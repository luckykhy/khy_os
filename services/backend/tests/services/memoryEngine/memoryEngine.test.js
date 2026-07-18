'use strict';

/**
 * Unit tests for the Proactive Memory Engine (services/memoryEngine).
 * Covers:
 *   - keyword × recency ranking (recent memory wins on equal keyword overlap);
 *   - type-filter restricts the candidate set;
 *   - proactive framing block (header + per-type bullets) and its char budget;
 *   - addStructuredMemory writes a frontmatter file + index entry;
 *   - strict no-op when disabled or no memories match.
 *
 * Memories live under getMemoryDir(); we point KHY_MEMORY_DIR at a temp dir and
 * reset the path cache between tests.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const PATHS = '../../../src/memdir/paths';
const ENGINE = '../../../src/services/memoryEngine';
const SCORING = '../../../src/services/memoryEngine/scoring';

let tmp;
const SAVED = {};
const ENV_KEYS = ['KHY_MEMORY_DIR', 'KHY_DISABLE_MEMORY', 'KHY_PROACTIVE_MEMORY', 'KHY_MEMORY_HALFLIFE_DAYS'];

function writeMemory(filename, frontmatter, body, mtimeMs) {
  const fm = ['---'];
  for (const [k, v] of Object.entries(frontmatter)) fm.push(`${k}: ${v}`);
  fm.push('---', '', body, '');
  const file = path.join(tmp, filename);
  fs.writeFileSync(file, fm.join('\n'), 'utf8');
  if (mtimeMs) fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-mem-'));
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

describe('memoryEngine.scoring', () => {
  test('recencyMultiplier halves at one half-life and is 1.0 when fresh', () => {
    const scoring = require(SCORING);
    process.env.KHY_MEMORY_HALFLIFE_DAYS = '10';
    const now = 1_000_000_000_000;
    expect(scoring.recencyMultiplier(now, now)).toBeCloseTo(1.0, 5);
    const tenDaysAgo = now - 10 * 24 * 60 * 60 * 1000;
    expect(scoring.recencyMultiplier(tenDaysAgo, now)).toBeCloseTo(0.5, 5);
  });

  test('on equal keyword overlap, the more recent memory ranks higher', () => {
    const now = 1_700_000_000_000;
    const day = 24 * 60 * 60 * 1000;
    writeMemory('a_old.md', { name: 'docker deploy', description: 'docker deploy notes', type: 'project' },
      'we use docker to deploy', now - 100 * day);
    writeMemory('b_new.md', { name: 'docker deploy', description: 'docker deploy notes', type: 'project' },
      'we use docker to deploy', now - 1 * day);

    const scoring = require(SCORING);
    const ranked = scoring.rankMemories('docker deploy', { nowMs: now });
    expect(ranked.length).toBe(2);
    expect(ranked[0].filename).toBe('b_new.md');
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  test('type filter restricts the candidate set', () => {
    const now = 1_700_000_000_000;
    writeMemory('p.md', { name: 'redis cache', description: 'cache layer', type: 'project' }, 'redis cache', now);
    writeMemory('f.md', { name: 'redis style', description: 'prefers redis', type: 'feedback' }, 'redis style', now);

    const scoring = require(SCORING);
    const onlyFeedback = scoring.rankMemories('redis', { types: 'feedback', nowMs: now });
    expect(onlyFeedback.map((m) => m.filename)).toEqual(['f.md']);
  });

  test('empty query yields no results', () => {
    writeMemory('p.md', { name: 'x', description: 'y', type: 'project' }, 'body', Date.now());
    const scoring = require(SCORING);
    expect(scoring.rankMemories('', {})).toEqual([]);
  });
});

describe('memoryEngine proactive framing', () => {
  test('buildProactiveSystemSection produces a framed block with type lead-ins', () => {
    const now = Date.now();
    writeMemory('u.md', { name: '全栈开发者', description: '偏好务实风格', type: 'user' }, '用户是全栈开发者', now);
    writeMemory('fb.md', { name: '直接执行', description: '不要冗余解释', type: 'feedback' }, '直接执行', now);

    const engine = require(ENGINE);
    const section = engine.buildProactiveSystemSection('全栈 偏好 执行');
    expect(section).toBeTruthy();
    expect(section).toContain('[PROACTIVE_MEMORY]');
    // Per-type lead-ins present.
    expect(section).toMatch(/用户画像|协作偏好/);
    // Mentions a memory title.
    expect(section).toMatch(/全栈开发者|直接执行/);
  });

  test('returns null when proactive layer disabled', () => {
    writeMemory('u.md', { name: 'topic', description: 'desc', type: 'user' }, 'body', Date.now());
    process.env.KHY_PROACTIVE_MEMORY = 'off';
    const engine = require(ENGINE);
    expect(engine.buildProactiveSystemSection('topic')).toBeNull();
  });

  test('returns null when KHY_DISABLE_MEMORY=1', () => {
    writeMemory('u.md', { name: 'topic', description: 'desc', type: 'user' }, 'body', Date.now());
    process.env.KHY_DISABLE_MEMORY = '1';
    const engine = require(ENGINE);
    expect(engine.isEnabled()).toBe(false);
    expect(engine.buildProactiveSystemSection('topic')).toBeNull();
  });

  test('returns null when nothing relevant matches', () => {
    writeMemory('u.md', { name: 'kubernetes', description: 'k8s', type: 'project' }, 'k8s', Date.now());
    const engine = require(ENGINE);
    expect(engine.buildProactiveSystemSection('完全无关的话题 xyz')).toBeNull();
  });

  test('char budget caps the number of bullets', () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      writeMemory(`m${i}.md`, { name: `topic${i}`, description: 'x'.repeat(200), type: 'project' }, 'topic body', now - i);
    }
    const engine = require(ENGINE);
    const ranked = engine.retrieveProactive('topic0 topic1 topic2 topic3 topic4', { limit: 5 });
    const section = engine.formatProactiveContext(ranked, { maxChars: 400 });
    // Header (~) + at most one ~200-char bullet fits under 400.
    const bulletCount = (section.match(/^- /gm) || []).length;
    expect(bulletCount).toBeLessThanOrEqual(2);
  });
});

describe('memoryEngine.addStructuredMemory', () => {
  test('writes a frontmatter file and indexes it', () => {
    const engine = require(ENGINE);
    const res = engine.addStructuredMemory({
      type: 'feedback',
      name: '分阶段交付',
      description: '用户偏好分阶段交付',
      content: '每个阶段交付可运行成果',
    });
    expect(res.success).toBe(true);
    const written = fs.readFileSync(path.join(tmp, res.filename), 'utf8');
    expect(written).toMatch(/type: feedback/);
    expect(written).toMatch(/分阶段交付/);
    // Index pointer added.
    const idx = fs.readFileSync(path.join(tmp, 'MEMORY.md'), 'utf8');
    expect(idx).toMatch(/分阶段交付/);
    expect(idx).toContain(res.filename);
  });

  test('rejects invalid type and missing fields', () => {
    const engine = require(ENGINE);
    expect(engine.addStructuredMemory({ type: 'bogus', name: 'a', content: 'b' }).success).toBe(false);
    expect(engine.addStructuredMemory({ type: 'user', name: '', content: 'b' }).success).toBe(false);
    expect(engine.addStructuredMemory({ type: 'user', name: 'a', content: '' }).success).toBe(false);
  });

  test('a just-added memory is retrievable proactively', () => {
    const engine = require(ENGINE);
    engine.addStructuredMemory({
      type: 'project',
      name: 'graphql 迁移',
      description: '正在把 REST 迁移到 graphql',
      content: '迁移计划与进度',
    });
    require(PATHS)._resetCache();
    const section = engine.buildProactiveSystemSection('graphql 迁移进度');
    expect(section).toBeTruthy();
    expect(section).toMatch(/graphql 迁移/);
  });
});

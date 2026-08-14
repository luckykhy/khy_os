'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const repoMap = require('../../../src/services/repoMap');
const dataHome = require('../../../src/utils/dataHome');

/** Create a small project fixture and return its root. */
function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-map-fixture-'));
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '1.0.0', main: 'src/index.js' }, null, 2),
  );
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'src', 'index.js'),
    'function main() { return 1; }\nmodule.exports = { main };\n',
  );
  fs.writeFileSync(
    path.join(root, 'src', 'util.js'),
    'function helper() { return 2; }\nconst factor = 3;\nmodule.exports = { helper, factor };\n',
  );
  return root;
}

function rmrf(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
}

describe('repoMap.buildRepoMap', () => {
  let fixture;
  let cacheHome;
  const savedEnv = {};

  beforeAll(() => {
    fixture = makeFixture();
    // Isolate the on-disk cache to a throwaway project-data home.
    cacheHome = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-map-cachehome-'));
    savedEnv.KHY_PROJECT_DATA_HOME = process.env.KHY_PROJECT_DATA_HOME;
    savedEnv.KHY_REPO_MAP = process.env.KHY_REPO_MAP;
    savedEnv.KHY_REPO_MAP_CACHE = process.env.KHY_REPO_MAP_CACHE;
    process.env.KHY_PROJECT_DATA_HOME = cacheHome;
    dataHome._resetStorageCaches();
  });

  afterAll(() => {
    rmrf(fixture);
    rmrf(cacheHome);
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    dataHome._resetStorageCaches();
  });

  beforeEach(() => {
    // Default: main switch enabled so the cache sub-flag is active.
    process.env.KHY_REPO_MAP = 'true';
    delete process.env.KHY_REPO_MAP_CACHE;
  });

  test('builds a non-empty map from a fixture directory', () => {
    const out = repoMap.buildRepoMap({ cwd: fixture, tokenBudget: 4000, forceRefresh: true });
    expect(out.text).toContain('代码地图');
    expect(out.text).toContain('src/index.js');
    expect(out.fileCount).toBeGreaterThan(0);
    expect(out.tokenCount).toBeGreaterThan(0);
    expect(out.cached).toBe(false);
  });

  test('fingerprint cache: first build misses, second build hits', () => {
    const first = repoMap.buildRepoMap({ cwd: fixture, tokenBudget: 4000, forceRefresh: true });
    expect(first.cached).toBe(false);

    const second = repoMap.buildRepoMap({ cwd: fixture, tokenBudget: 4000 });
    expect(second.cached).toBe(true);
    expect(second.text).toBe(first.text);
  });

  test('forceRefresh bypasses a cache hit', () => {
    repoMap.buildRepoMap({ cwd: fixture, tokenBudget: 4000 }); // warm cache
    const refreshed = repoMap.buildRepoMap({ cwd: fixture, tokenBudget: 4000, forceRefresh: true });
    expect(refreshed.cached).toBe(false);
  });

  test('fingerprint change invalidates the cache', () => {
    repoMap.buildRepoMap({ cwd: fixture, tokenBudget: 4000 }); // warm cache (hit next time)
    const hit = repoMap.buildRepoMap({ cwd: fixture, tokenBudget: 4000 });
    expect(hit.cached).toBe(true);

    // Mutate a source file → structure changes → fingerprint flips → miss.
    fs.writeFileSync(
      path.join(fixture, 'src', 'util.js'),
      'function helper() { return 2; }\nfunction extra() { return 9; }\nconst factor = 3;\nmodule.exports = { helper, extra, factor };\n',
    );
    const afterChange = repoMap.buildRepoMap({ cwd: fixture, tokenBudget: 4000 });
    expect(afterChange.cached).toBe(false);
  });

  test('cache disabled (KHY_REPO_MAP_CACHE off) → always uncached, still builds', () => {
    process.env.KHY_REPO_MAP_CACHE = 'false';
    const a = repoMap.buildRepoMap({ cwd: fixture, tokenBudget: 4000 });
    const b = repoMap.buildRepoMap({ cwd: fixture, tokenBudget: 4000 });
    expect(a.cached).toBe(false);
    expect(b.cached).toBe(false);
    expect(a.text).toContain('代码地图');
  });

  test('emits action+target+progress status messages', () => {
    const statuses = [];
    repoMap.buildRepoMap({
      cwd: fixture,
      tokenBudget: 4000,
      forceRefresh: true,
      onStatus: (s) => statuses.push(s),
    });
    expect(statuses.some((s) => /正在构建代码地图.*\d+\/\d+.*文件/.test(s))).toBe(true);
  });

  test('error path is fail-soft: invalid cwd returns an empty result', () => {
    const out = repoMap.buildRepoMap({ cwd: path.join(os.tmpdir(), 'no-such-dir-xyz-123') });
    expect(out).toEqual({ text: '', fileCount: 0, tokenCount: 0, cached: false });
  });

  test('never throws even with a missing cwd argument', () => {
    expect(() => repoMap.buildRepoMap({})).not.toThrow();
    const out = repoMap.buildRepoMap();
    expect(out.text).toBe('');
    expect(out.cached).toBe(false);
  });
});

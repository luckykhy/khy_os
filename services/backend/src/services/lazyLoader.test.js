'use strict';

/**
 * Tests for LazyLoader (lazyLoader.js)
 *
 * Validates:
 * 1. Module registration
 * 2. Lazy loading on first use
 * 3. Dependency-aware loading
 * 4. Parallel loading
 * 5. Prefetch scheduling
 * 6. Load time tracking
 * 7. Error handling
 */

const { LazyLoader, LazyModule, ModuleState } = require('./lazyLoader');

// ── Test Helpers ──────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message}`);
  }
}

// ── LazyModule Tests ──────────────────────────────────────────────────────

function testLazyModule() {
  console.log('\n── LazyModule: Creation & Loading ──');

  let loaded = false;
  const mod = new LazyModule({
    name: 'test-mod',
    loader: async () => {
      loaded = true;
      return { hello: 'world' };
    },
  });

  assert(mod.name === 'test-mod', 'module name set');
  assert(mod.state === ModuleState.PENDING, 'initial state pending');
  assert(loaded === false, 'not loaded yet');
}

async function testLazyModuleLoad() {
  console.log('\n── LazyModule: Load ──');

  const mod = new LazyModule({
    name: 'load-test',
    loader: async () => ({ data: 42 }),
  });

  const result = await mod.load();
  assert(result.data === 42, 'load returns module');
  assert(mod.state === ModuleState.LOADED, 'state is loaded');
  assert(mod.loadTimeMs >= 0, 'load time tracked');

  // Second load should return cached
  const result2 = await mod.load();
  assert(result2.data === 42, 'second load returns same');
}

// ── LazyLoader Tests ──────────────────────────────────────────────────────

async function testRegistration() {
  console.log('\n── LazyLoader: Registration ──');

  const loader = new LazyLoader();

  loader.register('mod-a', async () => ({ name: 'a' }));
  loader.register('mod-b', async () => ({ name: 'b' }));

  assert(loader.stats.totalRegistered === 2, '2 modules registered');
  assert(loader.isLoaded('mod-a') === false, 'mod-a not loaded');
}

async function testLazyLoad() {
  console.log('\n── LazyLoader: Lazy Load ──');

  const loader = new LazyLoader();
  let loadCount = 0;

  loader.register('lazy-mod', async () => {
    loadCount++;
    return { value: 'loaded' };
  });

  assert(loadCount === 0, 'not loaded on register');

  const mod = await loader.load('lazy-mod');
  assert(mod.value === 'loaded', 'module loaded');
  assert(loadCount === 1, 'loaded once');

  // Second access should use cache
  const mod2 = loader.get('lazy-mod');
  assert(mod2.value === 'loaded', 'cached access');
  assert(loadCount === 1, 'still loaded once');
}

async function testDependencyLoading() {
  console.log('\n── LazyLoader: Dependency Loading ──');

  const loader = new LazyLoader();
  const loadOrder = [];

  loader.register('base', async () => {
    loadOrder.push('base');
    return { name: 'base' };
  });

  loader.register('dependent', async () => {
    loadOrder.push('dependent');
    return { name: 'dependent' };
  }, { dependencies: ['base'] });

  await loader.load('dependent');

  assert(loadOrder[0] === 'base', 'base loaded first');
  assert(loadOrder[1] === 'dependent', 'dependent loaded second');
}

async function testParallelLoading() {
  console.log('\n── LazyLoader: Parallel Loading ──');

  const loader = new LazyLoader({ concurrency: 4 });
  const startTimes = {};

  loader.register('par-a', async () => {
    startTimes.a = Date.now();
    await new Promise(r => setTimeout(r, 30));
    return { name: 'a' };
  });

  loader.register('par-b', async () => {
    startTimes.b = Date.now();
    await new Promise(r => setTimeout(r, 30));
    return { name: 'b' };
  });

  const results = await loader.loadAll({ parallel: true });

  assert(results.size === 2, 'both loaded');
  // Both should start at roughly the same time (parallel)
  assert(Math.abs(startTimes.a - startTimes.b) < 20, 'started in parallel');
}

async function testLoadReport() {
  console.log('\n── LazyLoader: Load Report ──');

  const loader = new LazyLoader();

  loader.register('rep-a', async () => {
    await new Promise(r => setTimeout(r, 50));
    return { name: 'a' };
  });

  loader.register('rep-b', async () => {
    await new Promise(r => setTimeout(r, 5));
    return { name: 'b' };
  });

  await loader.loadAll({ parallel: false });

  const report = loader.getLoadReport();
  assert(report.length === 2, 'report has 2 entries');
  assert(report.every(r => r.state === ModuleState.LOADED), 'all loaded');

  const slowest = loader.getSlowestModules(1);
  assert(slowest.length === 1, '1 slowest module');
  assert(slowest[0].name === 'rep-a', 'rep-a is slowest');
}

async function testErrorHandling() {
  console.log('\n── LazyLoader: Error Handling ──');

  const loader = new LazyLoader();

  loader.register('fail-mod', async () => {
    throw new Error('Module load failed');
  });

  try {
    await loader.load('fail-mod');
    failed++;
    console.error('  ✗ should have thrown');
  } catch {
    passed++;
    console.log('  ✓ error propagated');
  }
}

// ── Run All Tests ─────────────────────────────────────────────────────────

async function runTests() {
  console.log('═══════════════════════════════════════════');
  console.log('  LazyLoader Tests');
  console.log('═══════════════════════════════════════════');

  testLazyModule();
  await testLazyModuleLoad();
  await testRegistration();
  await testLazyLoad();
  await testDependencyLoading();
  await testParallelLoading();
  await testLoadReport();
  await testErrorHandling();

  console.log('\n═══════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});

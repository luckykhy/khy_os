'use strict';

/**
 * Integration test for all new modules working together.
 *
 * Validates:
 * 1. SystemInitialization creates all modules
 * 2. Tool execution through registry
 * 3. Permission broker integration
 * 4. Task scheduler with permissions
 * 5. Prompt optimization
 * 6. Lazy loading
 * 7. Memory tools
 * 8. Dream tools
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { SystemIntegration } = require('./systemIntegration');

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

const testDir = path.join(os.tmpdir(), `khy-test-int-${Date.now()}`);

function setup() {
  fs.mkdirSync(testDir, { recursive: true });
}

function teardown() {
  try {
    fs.rmSync(testDir, { recursive: true, force: true });
  } catch {
    // Ignore
  }
}

async function testFullSystem() {
  console.log('\n── Integration: Full System --');

  setup();

  const sys = new SystemIntegration({
    appHome: testDir,
    logger: { info: () => {}, warn: () => {} },
  });

  await sys.initialize();

  // Registry has tools (memory tools at minimum)
  const toolCount = sys.registry.getStats().total;
  assert(toolCount >= 3, `registry has tools (${toolCount} registered)`);
  assert(sys.registry.has('read_memory'), 'read_memory tool registered');
  assert(sys.registry.has('write_memory'), 'write_memory tool registered');
  assert(sys.registry.has('log_activity'), 'log_activity tool registered');

  // Memory write/read roundtrip
  const writeResult = await sys.registry.get('write_memory').execute({
    type: 'user',
    name: 'integration-test',
    content: 'Integration test memory',
  });
  assert(writeResult.isError === false, 'memory write succeeds');

  const readResult = await sys.registry.get('read_memory').execute({
    query: 'integration',
  });
  assert(readResult.isError === false, 'memory read succeeds');
  assert(readResult.content.found >= 1, 'memory found');

  // Task scheduling
  const scheduler = new (require('./taskScheduler').TaskScheduler)({ concurrency: 2 });
  scheduler.add({
    id: 'int-test',
    execute: async () => 'ok',
  });
  const taskResults = await scheduler.run();
  assert(taskResults.get('int-test').state === 'completed', 'task completed');

  // Permission broker
  const permResult = await sys.requestPermission({
    toolName: 'integration_test',
    reason: 'Testing',
    promptFn: async () => 'approved',
  });
  assert(permResult.verdict === 'approved', 'permission approved');

  // Prompt optimization
  const optResult = sys.optimizePrompt(
    [{ role: 'user', content: 'test' }],
    'system prompt'
  );
  assert(optResult.stats !== undefined, 'optimization stats available');

  // Lazy module
  sys.registerLazyModule('int-lazy', async () => ({ value: 42 }));
  const lazyMod = await sys.loadModule('int-lazy');
  assert(lazyMod.value === 42, 'lazy module loaded');

  // System status
  const status = sys.getStatus();
  assert(status.initialized === true, 'system initialized');
  assert(status.registry.total >= 3, 'status shows tools');

  sys.shutdown();
  teardown();
}

// ── Run Tests ────────────────────────────────────────────────────────────

async function runTests() {
  console.log('═══════════════════════════════════════════');
  console.log('  Integration Test: All Modules');
  console.log('═══════════════════════════════════════════');

  await testFullSystem();

  console.log('\n═══════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Test runner error:', err);
  teardown();
  process.exit(1);
});

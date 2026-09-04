'use strict';

/**
 * Tests for SystemIntegration (systemIntegration.js)
 *
 * Validates:
 * 1. System initialization
 * 2. Module registration
 * 3. Tool registry integration
 * 4. Lazy module loading
 * 5. Permission broker integration
 * 6. Prompt optimization
 * 7. System status
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { SystemIntegration } = require('./systemIntegration');

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

// Create temp directory for tests
const testDir = path.join(os.tmpdir(), `khy-test-sysint-${Date.now()}`);

function setup() {
  fs.mkdirSync(testDir, { recursive: true });
}

function teardown() {
  try {
    fs.rmSync(testDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

// ── System Integration Tests ──────────────────────────────────────────────

async function testInitialization() {
  console.log('\n── SystemIntegration: Initialization ──');

  setup();

  const sys = new SystemIntegration({
    appHome: testDir,
    logger: { info: () => {}, warn: () => {} },
  });

  assert(sys.isInitialized === false, 'not initialized initially');
  assert(sys.registry !== null, 'has registry');
  assert(sys.optimizer !== null, 'has optimizer');
  assert(sys.scheduler !== null, 'has scheduler');
  assert(sys.broker !== null, 'has broker');
  assert(sys.loader !== null, 'has loader');

  await sys.initialize();

  assert(sys.isInitialized === true, 'initialized after initialize()');
  assert(sys.memoryBridge !== null, 'memory bridge created');

  // Check that memory tools are registered
  assert(sys.registry.has('read_memory'), 'read_memory registered');
  assert(sys.registry.has('write_memory'), 'write_memory registered');
  assert(sys.registry.has('log_activity'), 'log_activity registered');

  sys.shutdown();
  assert(sys.isInitialized === false, 'shutdown');

  teardown();
}

async function testToolRegistry() {
  console.log('\n── SystemIntegration: Tool Registry ──');

  setup();

  const sys = new SystemIntegration({
    appHome: testDir,
    logger: { info: () => {}, warn: () => {} },
  });

  await sys.initialize();

  const stats = sys.registry.getStats();
  assert(stats.total >= 3, 'at least 3 tools registered');

  // Check memory tools are present
  const readMem = sys.registry.get('read_memory');
  assert(readMem !== null, 'read_memory found');
  assert(readMem.isReadOnly === true, 'read_memory is read-only');

  const writeMem = sys.registry.get('write_memory');
  assert(writeMem !== null, 'write_memory found');
  assert(writeMem.mutatesFiles === true, 'write_memory mutates files');

  sys.shutdown();
  teardown();
}

async function testLazyModule() {
  console.log('\n── SystemIntegration: Lazy Module ──');

  setup();

  const sys = new SystemIntegration({
    appHome: testDir,
    logger: { info: () => {}, warn: () => {} },
  });

  await sys.initialize();

  // Register a lazy module
  let loaded = false;
  sys.registerLazyModule('test-lazy', async () => {
    loaded = true;
    return { name: 'lazy-module', value: 42 };
  }, { priority: 5 });

  assert(sys.loader.isLoaded('test-lazy') === false, 'not loaded yet');

  const mod = await sys.loadModule('test-lazy');
  assert(loaded === true, 'module loaded');
  assert(mod.name === 'lazy-module', 'correct module');
  assert(mod.value === 42, 'correct value');

  sys.shutdown();
  teardown();
}

async function testPermissionBroker() {
  console.log('\n── SystemIntegration: Permission Broker ──');

  setup();

  const sys = new SystemIntegration({
    appHome: testDir,
    logger: { info: () => {}, warn: () => {} },
  });

  await sys.initialize();

  // Request permission
  const result = await sys.requestPermission({
    toolName: 'test_tool',
    reason: 'Test permission',
    promptFn: async () => 'approved',
  });

  assert(result.verdict === 'approved', 'permission approved');
  assert(sys.broker.stats.totalRequests === 1, 'request counted');

  sys.shutdown();
  teardown();
}

async function testPromptOptimization() {
  console.log('\n── SystemIntegration: Prompt Optimization ──');

  setup();

  const sys = new SystemIntegration({
    appHome: testDir,
    promptCache: { contextWindow: 100000 },
    logger: { info: () => {}, warn: () => {} },
  });

  await sys.initialize();

  const messages = [
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi there!' },
  ];

  const result = sys.optimizePrompt(messages, 'Be helpful');
  assert(result.stats !== undefined, 'has stats');
  assert(result.stats.tier >= 0, 'has tier');
  assert(result.messages !== undefined, 'has messages');

  sys.shutdown();
  teardown();
}

async function testSystemStatus() {
  console.log('\n── SystemIntegration: System Status ──');

  setup();

  const sys = new SystemIntegration({
    appHome: testDir,
    logger: { info: () => {}, warn: () => {} },
  });

  await sys.initialize();

  const status = sys.getStatus();
  assert(status.initialized === true, 'status shows initialized');
  assert(status.registry !== null, 'has registry stats');
  assert(status.optimizer !== null, 'has optimizer stats');
  assert(status.scheduler !== null, 'has scheduler stats');
  assert(status.broker !== null, 'has broker stats');
  assert(status.loader !== null, 'has loader stats');
  assert(status.memory !== null, 'has memory status');

  sys.shutdown();
  teardown();
}

async function testMemoryToolsViaSystem() {
  console.log('\n── SystemIntegration: Memory Tools via System ──');

  setup();

  const sys = new SystemIntegration({
    appHome: testDir,
    logger: { info: () => {}, warn: () => {} },
  });

  await sys.initialize();

  // Write a memory
  const writeResult = await sys.registry.get('write_memory').execute({
    type: 'user',
    name: 'test-preference',
    content: 'User prefers dark mode',
  });

  assert(writeResult.isError === false, 'write succeeds');
  assert(writeResult.content.type === 'user', 'correct type');

  // Read memories
  const readResult = await sys.registry.get('read_memory').execute({
    query: 'dark mode',
  });

  assert(readResult.isError === false, 'read succeeds');
  assert(readResult.content.found >= 1, 'found memory');

  sys.shutdown();
  teardown();
}

// ── Run All Tests ─────────────────────────────────────────────────────────

async function runTests() {
  console.log('═══════════════════════════════════════════');
  console.log('  SystemIntegration Tests');
  console.log('═══════════════════════════════════════════');

  await testInitialization();
  await testToolRegistry();
  await testLazyModule();
  await testPermissionBroker();
  await testPromptOptimization();
  await testSystemStatus();
  await testMemoryToolsViaSystem();

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

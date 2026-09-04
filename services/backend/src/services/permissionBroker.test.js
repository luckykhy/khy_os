'use strict';

/**
 * Tests for PermissionBroker (permissionBroker.js)
 *
 * Validates:
 * 1. Request queuing and serialization
 * 2. Priority-based ordering
 * 3. Timeout handling
 * 4. Batch approve/deny
 * 5. Cancellation
 * 6. Statistics tracking
 */

const {
  PermissionBroker,
  PermissionRequest,
  PermissionVerdict,
} = require('./permissionBroker');

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

// ── PermissionRequest Tests ───────────────────────────────────────────────

function testPermissionRequest() {
  console.log('\n── PermissionRequest Creation ──');

  const req = new PermissionRequest({
    id: 'test-1',
    toolName: 'read_file',
    reason: 'Read sensitive file',
    promptFn: async () => PermissionVerdict.APPROVED,
    priority: 3,
    timeoutMs: 5000,
  });

  assert(req.id === 'test-1', 'request id set');
  assert(req.toolName === 'read_file', 'toolName set');
  assert(req.reason === 'Read sensitive file', 'reason set');
  assert(req.priority === 3, 'priority set');
  assert(req.timeoutMs === 5000, 'timeout set');
  assert(req.resolved === false, 'not resolved initially');
  assert(req.isTimedOut === false, 'not timed out initially');
  assert(req.waitTime >= 0, 'wait time >= 0');
}

// ── PermissionBroker Tests ────────────────────────────────────────────────

async function testBrokerBasic() {
  console.log('\n── PermissionBroker: Basic Request ──');

  const broker = new PermissionBroker();
  let prompted = false;

  const result = await broker.request({
    toolName: 'test_tool',
    reason: 'Test permission',
    promptFn: async (req) => {
      prompted = true;
      assert(req.toolName === 'test_tool', 'prompt receives request');
      return PermissionVerdict.APPROVED;
    },
  });

  assert(result.verdict === PermissionVerdict.APPROVED, 'request approved');
  assert(prompted === true, 'prompt function called');
  assert(broker.stats.totalRequests === 1, 'stats tracked');
  assert(broker.stats.approved === 1, 'approved counted');
}

async function testBrokerSerialization() {
  console.log('\n── PermissionBroker: Serialization ──');

  const broker = new PermissionBroker();
  const promptOrder = [];

  // Create 3 requests - they should be processed one at a time
  const promises = [
    broker.request({
      toolName: 'tool_a',
      promptFn: async () => {
        promptOrder.push('a');
        await new Promise(r => setTimeout(r, 20));
        return PermissionVerdict.APPROVED;
      },
    }),
    broker.request({
      toolName: 'tool_b',
      promptFn: async () => {
        promptOrder.push('b');
        await new Promise(r => setTimeout(r, 10));
        return PermissionVerdict.APPROVED;
      },
    }),
    broker.request({
      toolName: 'tool_c',
      promptFn: async () => {
        promptOrder.push('c');
        return PermissionVerdict.DENIED;
      },
    }),
  ];

  const results = await Promise.all(promises);

  assert(results[0].verdict === PermissionVerdict.APPROVED, 'a approved');
  assert(results[1].verdict === PermissionVerdict.APPROVED, 'b approved');
  assert(results[2].verdict === PermissionVerdict.DENIED, 'c denied');
  assert(promptOrder.length === 3, 'all 3 prompted');
  // First two should start before third finishes (serialization)
  assert(promptOrder[0] === 'a', 'a prompted first');
}

async function testBrokerPriority() {
  console.log('\n── PermissionBroker: Priority Ordering ──');

  const broker = new PermissionBroker();
  const promptOrder = [];

  // First request will start processing immediately (it's the only one)
  // Add a delay in the first prompt to allow second request to queue
  const firstPromise = broker.request({
    toolName: 'first',
    priority: 5,
    promptFn: async () => {
      promptOrder.push('first');
      await new Promise(r => setTimeout(r, 50)); // Allow queue to build
      return PermissionVerdict.APPROVED;
    },
  });

  // Small delay to ensure first is processing
  await new Promise(r => setTimeout(r, 10));

  // Now queue low and high priority - high should go first
  const lowPromise = broker.request({
    toolName: 'low_priority',
    priority: 10,
    promptFn: async () => {
      promptOrder.push('low');
      return PermissionVerdict.APPROVED;
    },
  });

  const highPromise = broker.request({
    toolName: 'high_priority',
    priority: 1,
    promptFn: async () => {
      promptOrder.push('high');
      return PermissionVerdict.APPROVED;
    },
  });

  await Promise.all([firstPromise, lowPromise, highPromise]);

  // High priority should be processed before low (both were queued while first was processing)
  const highIdx = promptOrder.indexOf('high');
  const lowIdx = promptOrder.indexOf('low');
  assert(highIdx < lowIdx, 'high priority processed before low priority');
}

async function testBrokerTimeout() {
  console.log('\n── PermissionBroker: Timeout ──');

  const broker = new PermissionBroker({ defaultTimeoutMs: 50 });

  const result = await broker.request({
    toolName: 'slow_tool',
    promptFn: async () => {
      // Simulate slow prompt that exceeds timeout
      await new Promise(r => setTimeout(r, 200));
      return PermissionVerdict.APPROVED;
    },
  });

  // Should timeout
  assert(result.verdict === PermissionVerdict.TIMEOUT, 'request timed out');
  assert(broker.stats.timedOut === 1, 'timeout counted');
}

async function testBrokerBatchApprove() {
  console.log('\n── PermissionBroker: Batch Approve ──');

  const broker = new PermissionBroker();
  const promptOrder = [];

  // First request will start processing immediately
  const firstPromise = broker.request({
    toolName: 'first',
    promptFn: async () => {
      promptOrder.push('first');
      await new Promise(r => setTimeout(r, 50));
      return PermissionVerdict.APPROVED;
    },
  });

  // Small delay to ensure first is processing
  await new Promise(r => setTimeout(r, 10));

  // Queue multiple requests for same tool while first is processing
  const promises = [];
  for (let i = 0; i < 3; i++) {
    promises.push(
      broker.request({
        toolName: 'batch_tool',
        promptFn: async () => {
          promptOrder.push('batch');
          return PermissionVerdict.APPROVED;
        },
      })
    );
  }

  // Small delay to let them queue
  await new Promise(r => setTimeout(r, 20));

  // Approve all for batch_tool
  const approved = broker.approveAll('batch_tool');
  assert(approved === 3, '3 requests approved');

  const results = await Promise.all([firstPromise, ...promises]);
  for (const r of results) {
    assert(r.verdict === PermissionVerdict.APPROVED, 'batch approved');
  }
}

async function testBrokerCancel() {
  console.log('\n── PermissionBroker: Cancellation ──');

  const broker = new PermissionBroker();

  // First request starts processing immediately
  broker.request({
    toolName: 'first',
    promptFn: async () => {
      await new Promise(r => setTimeout(r, 100));
      return PermissionVerdict.APPROVED;
    },
  });

  // Small delay to ensure first is processing
  await new Promise(r => setTimeout(r, 10));

  // Queue a second request that will wait
  const secondPromise = broker.request({
    toolName: 'cancel_tool',
    timeoutMs: 5000,
    promptFn: async () => {
      await new Promise(r => setTimeout(r, 100));
      return PermissionVerdict.APPROVED;
    },
  });

  // Small delay to let it queue
  await new Promise(r => setTimeout(r, 20));

  // Cancel all immediately
  broker.cancelAll();

  const result = await secondPromise;
  assert(result.verdict === PermissionVerdict.CANCELLED, 'request cancelled');
  assert(broker.stats.cancelled === 1, 'cancellation counted');
}

async function testBrokerStats() {
  console.log('\n── PermissionBroker: Statistics ──');

  const broker = new PermissionBroker();

  await broker.request({
    toolName: 'stat_tool',
    promptFn: async () => PermissionVerdict.APPROVED,
  });

  const stats = broker.stats;
  assert(stats.totalRequests === 1, 'total requests tracked');
  assert(stats.approved === 1, 'approved tracked');
}

// ── Run All Tests ─────────────────────────────────────────────────────────

async function runTests() {
  console.log('═══════════════════════════════════════════');
  console.log('  PermissionBroker Tests');
  console.log('═══════════════════════════════════════════');

  testPermissionRequest();
  await testBrokerBasic();
  await testBrokerSerialization();
  await testBrokerPriority();
  await testBrokerTimeout();
  await testBrokerBatchApprove();
  await testBrokerCancel();
  await testBrokerStats();

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

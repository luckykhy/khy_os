'use strict';

/**
 * Tests for MemoryDreamEnhancer (memoryDreamEnhancer.js)
 */

const {
  DreamPhase,
  HealthThreshold,
  createDreamTools,
  DreamScheduler,
} = require('./memoryDreamEnhancer');

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

async function testDreamTools() {
  console.log('\n-- Dream Tools: Creation --');

  const mockDreaming = {
    snapshotMemories: () => [
      { id: '1', content: 'Memory about TypeScript', phase: 'light', score: 0.9, recallCount: 5, type: 'preference', lifecycle: 'active' },
      { id: '2', content: 'Memory about React patterns', phase: 'deep', score: 0.8, recallCount: 3, type: 'fact', lifecycle: 'active' },
      { id: '3', content: 'Old memory', phase: null, score: 0.3, recallCount: 1, type: 'project', lifecycle: 'archived' },
    ],
    _calculateHealth: () => 0.75,
    _lastPhaseRun: { light: 0, deep: 0, rem: 0 },
    runLightPhase: async () => ({ merged: 1, kept: 2, dropped: 1 }),
    runDeepPhase: async () => ({ synthesized: 1, recovered: 0, health: 0.8 }),
    runRemPhase: async () => ({ patterns: 2, strength: 0.85 }),
  };

  const tools = createDreamTools({ dreaming: mockDreaming });

  assert(tools.length === 3, '3 dream tools created');
  assert(tools[0].name === 'get_dream_insights', 'get_dream_insights tool');
  assert(tools[1].name === 'trigger_dream', 'trigger_dream tool');
  assert(tools[2].name === 'memory_health', 'memory_health tool');

  console.log('\n-- Dream Tools: Get Insights --');

  const insightsTool = tools[0];
  assert(insightsTool.readOnly === true, 'get_dream_insights is read-only');
  assert(insightsTool.parallelSafe === true, 'get_dream_insights is parallel-safe');

  const result = await insightsTool.execute({ phase: 'all', limit: 10 });
  assert(result.isError === false, 'get insights succeeds');
  assert(result.content.totalMemories === 3, 'returns total count');
  assert(result.content.health === 0.75, 'returns health');
  assert(result.content.insights.length === 3, 'returns all insights');

  // Filter by phase
  const filtered = await insightsTool.execute({ phase: 'deep' });
  assert(filtered.content.filteredCount === 1, 'filters by phase');

  // Filter by score
  const highScore = await insightsTool.execute({ minScore: 0.8 });
  assert(highScore.content.filteredCount === 2, 'filters by min score');

  console.log('\n-- Dream Tools: Trigger Dream --');

  const triggerTool = tools[1];
  assert(triggerTool.mutatesFiles === true, 'trigger_dream mutates files');

  const triggerResult = await triggerTool.execute({ phase: 'light', force: true });
  assert(triggerResult.isError === false, 'trigger succeeds');
  assert(triggerResult.content.phase === 'light', 'correct phase');
  assert(triggerResult.content.stats.merged === 1, 'stats returned');

  // Test phase validation
  const invalidResult = await triggerTool.execute({ phase: 'invalid', force: true });
  assert(invalidResult.isError === true, 'invalid phase rejected');

  console.log('\n-- Dream Tools: Memory Health --');

  const healthTool = tools[2];
  assert(healthTool.readOnly === true, 'memory_health is read-only');

  const healthResult = await healthTool.execute({ detailed: true });
  assert(healthResult.isError === false, 'health check succeeds');
  assert(healthResult.content.health === 0.75, 'health score correct');
  assert(healthResult.content.status === 'moderate', 'status moderate for 0.75');
  assert(healthResult.content.totalMemories === 3, 'total count correct');
  assert(typeof healthResult.content.byPhase === 'object', 'detailed breakdown');

  // Test without details
  const simpleHealth = await healthTool.execute({});
  assert(simpleHealth.content.byPhase === undefined, 'no details when not requested');
}

async function testDreamToolsNoDreaming() {
  console.log('\n-- Dream Tools: No Dreaming Available --');

  const tools = createDreamTools({ dreaming: null });

  const insightsResult = await tools[0].execute({});
  assert(insightsResult.isError === false, 'get insights works without dreaming');
  assert(insightsResult.content.totalMemories === 0, '0 memories without store');

  const triggerResult = await tools[1].execute({ phase: 'light' });
  assert(triggerResult.isError === true, 'trigger fails without dreaming');
}

async function testDreamScheduler() {
  console.log('\n-- Dream Scheduler --');

  const mockDreaming = {
    runLightPhase: async () => { return { merged: 0, kept: 0, dropped: 0 }; },
    runDeepPhase: async () => ({ synthesized: 0, recovered: 0, health: 1 }),
    runRemPhase: async () => ({ patterns: 0, strength: 0 }),
  };

  const scheduler = new DreamScheduler({
    dreaming: mockDreaming,
    logger: { info: () => {}, warn: () => {} },
  });

  assert(scheduler._running === false, 'not running initially');

  // Start and immediately stop (don't wait for intervals)
  scheduler.start();
  assert(scheduler._running === true, 'running after start');

  scheduler.stop();
  assert(scheduler._running === false, 'stopped after stop');
}

function testConstants() {
  console.log('\n-- Constants --');

  assert(DreamPhase.LIGHT === 'light', 'DreamPhase.LIGHT');
  assert(DreamPhase.DEEP === 'deep', 'DreamPhase.DEEP');
  assert(DreamPhase.REM === 'rem', 'DreamPhase.REM');

  assert(HealthThreshold.CRITICAL === 0.2, 'HealthThreshold.CRITICAL');
  assert(HealthThreshold.LOW === 0.35, 'HealthThreshold.LOW');
  assert(HealthThreshold.GOOD === 0.8, 'HealthThreshold.GOOD');
}

// ── Run All Tests ─────────────────────────────────────────────────────────

async function runTests() {
  console.log('═══════════════════════════════════════════');
  console.log('  MemoryDreamEnhancer Tests');
  console.log('═══════════════════════════════════════════');

  testConstants();
  await testDreamTools();
  await testDreamToolsNoDreaming();
  await testDreamScheduler();

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

'use strict';

/**
 * benchmarkSuite.js — Performance benchmark suite for new modules.
 *
 * Measures and validates performance of:
 * - ToolSpec creation and execution
 * - Prompt cache optimization
 * - Task scheduling
 * - Permission broker
 * - Lazy loading
 * - Memory operations
 *
 * @module benchmarkSuite
 */

const { LazyLoader } = require('./lazyLoader');
const { PromptCacheOptimizer, estimateTokens } = require('./promptCacheOptimizer');
const { TaskScheduler, Task } = require('./taskScheduler');
const { ToolSpec, ToolResult, ToolRegistry, ToolCategory, RiskLevel } = require('./toolSpec');

// ── Benchmark Result ────────────────────────────────────────────────────

class BenchmarkResult {
  constructor(name, iterations, totalMs) {
    this.name = name;
    this.iterations = iterations;
    this.totalMs = totalMs;
    this.avgMs = totalMs / iterations;
    this.opsPerSecond = Math.round(iterations / (totalMs / 1000));
  }
}

// ── Benchmark Runner ─────────────────────────────────────────────────────

async function benchmark(name, iterations, fn) {
  // Warmup
  for (let i = 0; i < Math.min(10, iterations / 10); i++) {
    await fn();
  }

  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) {
    await fn();
  }
  const end = process.hrtime.bigint();

  const totalMs = Number(end - start) / 1_000_000;
  return new BenchmarkResult(name, iterations, totalMs);
}

// ── Benchmarks ───────────────────────────────────────────────────────────

async function runToolSpecBenchmarks() {
  console.log('\n── ToolSpec Benchmarks ──');

  const registry = new ToolRegistry();

  // Create test tools
  for (let i = 0; i < 100; i++) {
    registry.register(new ToolSpec({
      name: `tool_${i}`,
      description: `Test tool ${i}`,
      inputSchema: { type: 'object', properties: { x: { type: 'number' } } },
      execute: async (params) => ToolResult.success(params.x * 2),
      readOnly: true,
      parallelSafe: true,
      category: ToolCategory.SYSTEM,
      risk: RiskLevel.SAFE,
    }));
  }

  const results = [];

  // Benchmark: Tool creation
  results.push(await benchmark('ToolSpec.create', 10000, () => {
    new ToolSpec({
      name: 'bench',
      description: 'Benchmark tool',
      inputSchema: { type: 'object' },
      execute: async () => null,
    });
  }));

  // Benchmark: Tool registration
  results.push(await benchmark('ToolRegistry.register', 1000, () => {
    const r = new ToolRegistry();
    r.register(new ToolSpec({
      name: 't',
      description: 'd',
      inputSchema: {},
      execute: async () => null,
    }));
  }));

  // Benchmark: Tool lookup
  results.push(await benchmark('ToolRegistry.get', 100000, () => {
    registry.get('tool_50');
  }));

  // Benchmark: Tool filtering
  results.push(await benchmark('ToolRegistry.getReadOnlyTools', 10000, () => {
    registry.getReadOnlyTools();
  }));

  // Benchmark: Tool execution
  const tool = registry.get('tool_1');
  results.push(await benchmark('ToolSpec.execute', 10000, async () => {
    await tool.execute({ x: 42 });
  }));

  // Benchmark: Anthropic format conversion
  results.push(await benchmark('toAnthropicTool', 10000, () => {
    tool.toAnthropicTool();
  }));

  // Benchmark: OpenAI format conversion
  results.push(await benchmark('toOpenAIFunction', 10000, () => {
    tool.toOpenAIFunction();
  }));

  return results;
}

async function runPromptCacheBenchmarks() {
  console.log('\n── Prompt Cache Optimizer Benchmarks ──');

  const optimizer = new PromptCacheOptimizer({ contextWindow: 128000 });
  const results = [];

  // Generate test messages
  const messages = [];
  for (let i = 0; i < 50; i++) {
    messages.push({ role: 'user', content: `User message ${i} with some content` });
    messages.push({ role: 'tool', content: `Tool result ${i}\n`.repeat(100) });
  }

  const systemPrompt = 'You are a helpful assistant.\n'.repeat(50);

  // Benchmark: Token estimation
  results.push(await benchmark('estimateTokens', 10000, () => {
    estimateTokens('Hello world, this is a test of the token estimation function.');
  }));

  // Benchmark: Full optimization (tier 0 - fits)
  results.push(await benchmark('optimize (tier 0)', 1000, () => {
    optimizer.optimize(messages.slice(0, 4), systemPrompt);
  }));

  // Benchmark: Watermark calculation
  results.push(await benchmark('getWatermarkTier', 100000, () => {
    optimizer.getWatermarkTier(80000);
  }));

  // Benchmark: Cache key generation
  results.push(await benchmark('computeCacheKey', 10000, () => {
    PromptCacheOptimizer.computeCacheKey(systemPrompt, [{ name: 'tool1' }], 'gpt-4');
  }));

  return results;
}

async function runTaskSchedulerBenchmarks() {
  console.log('\n── Task Scheduler Benchmarks ──');

  const results = [];

  // Benchmark: Task creation
  results.push(await benchmark('Task.create', 10000, () => {
    new Task({
      id: 'bench',
      execute: async () => 'ok',
    });
  }));

  // Benchmark: Graph validation
  const graphSetup = () => {
    const { TaskGraph, Task: T } = require('./taskScheduler');
    const g = new TaskGraph();
    g.add(new T({ id: 'a', execute: async () => 'a' }));
    g.add(new T({ id: 'b', execute: async () => 'b' }));
    g.add(new T({ id: 'c', execute: async () => 'c', dependencies: ['a', 'b'] }));
    return g;
  };

  results.push(await benchmark('TaskGraph.validate', 1000, () => {
    graphSetup().validate();
  }));

  // Benchmark: Topological sort
  results.push(await benchmark('TaskGraph.topologicalSort', 1000, () => {
    graphSetup().topologicalSort();
  }));

  // Benchmark: Parallel execution
  results.push(await benchmark('Scheduler.run (10 tasks)', 100, async () => {
    const scheduler = new TaskScheduler({ concurrency: 4 });
    for (let i = 0; i < 10; i++) {
      scheduler.add({
        id: `t_${i}`,
        execute: async () => i,
      });
    }
    await scheduler.run();
  }));

  return results;
}

async function runPermissionBrokerBenchmarks() {
  console.log('\n── Permission Broker Benchmarks ──');

  const results = [];

  // Benchmark: Request creation
  results.push(await benchmark('PermissionRequest.create', 10000, () => {
    const { PermissionRequest: PR, PermissionVerdict: PV } = require('./permissionBroker');
    new PR({
      id: 'test',
      toolName: 'read_file',
      reason: 'Read',
      promptFn: async () => PV.APPROVED,
    });
  }));

  // Benchmark: Queue operations
  const brokerSetup = () => {
    const { PermissionBroker: PB, PermissionVerdict: PV } = require('./permissionBroker');
    const b = new PB();
    for (let i = 0; i < 100; i++) {
      b.request({
        toolName: `tool_${i}`,
        reason: `Reason ${i}`,
        promptFn: async () => PV.APPROVED,
      });
    }
    return b;
  };

  results.push(await benchmark('Broker.request (queued)', 100, () => {
    brokerSetup();
  }));

  // Benchmark: Stats tracking
  results.push(await benchmark('Broker.getStats', 10000, () => {
    const { PermissionBroker: PB2 } = require('./permissionBroker');
    const b = new PB2();
    return b.stats;
  }));

  return results;
}

async function runLazyLoaderBenchmarks() {
  console.log('\n── Lazy Loader Benchmarks ──');

  const results = [];

  // Benchmark: Module registration
  results.push(await benchmark('LazyLoader.register', 1000, () => {
    const loader = new LazyLoader();
    for (let i = 0; i < 100; i++) {
      loader.register(`mod_${i}`, async () => ({ name: `mod_${i}` }));
    }
  }));

  // Benchmark: Module loading
  results.push(await benchmark('LazyLoader.load (100 modules)', 10, async () => {
    const loader = new LazyLoader();
    for (let i = 0; i < 100; i++) {
      loader.register(`mod_${i}`, async () => ({ name: `mod_${i}` }));
    }
    await loader.loadAll({ parallel: false });
  }));

  // Benchmark: Parallel loading
  results.push(await benchmark('LazyLoader.loadAll (parallel)', 10, async () => {
    const loader = new LazyLoader({ concurrency: 4 });
    for (let i = 0; i < 100; i++) {
      loader.register(`mod_${i}`, async () => ({ name: `mod_${i}` }));
    }
    await loader.loadAll({ parallel: true });
  }));

  // Benchmark: Cache access
  const cachedLoader = new LazyLoader();
  cachedLoader.register('cached', async () => ({ value: 42 }));
  await cachedLoader.load('cached');
  results.push(await benchmark('LazyLoader.get (cached)', 100000, () => {
    cachedLoader.get('cached');
  }));

  return results;
}

// ── Report ───────────────────────────────────────────────────────────────

function printReport(allResults) {
  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  Performance Benchmark Report');
  console.log('══════════════════════════════════════════════════════════');

  let totalTests = 0;

  for (const { category, results } of allResults) {
    console.log(`\n${category}:`);
    console.log('  '.padEnd(40) + 'avg (ms)    ops/sec');
    console.log('  ' + '─'.repeat(50));

    for (const r of results) {
      const name = `  ${r.name}`.padEnd(40);
      const avg = r.avgMs.toFixed(4).padStart(10);
      const ops = r.opsPerSecond.toLocaleString().padStart(12);
      console.log(`${name}${avg}${ops}`);
      totalTests++;
    }
  }

  console.log('\n══════════════════════════════════════════════════════════');
  console.log(`  ${totalTests} benchmarks completed`);
  console.log('══════════════════════════════════════════════════════════\n');
}

// ── Performance Assertions ───────────────────────────────────────────────

function assertPerformance(results) {
  console.log('\n── Performance Assertions ──');

  const assertions = [
    { name: 'Tool creation < 0.1ms', pass: results.find(r => r.name === 'ToolSpec.create').avgMs < 0.1 },
    { name: 'Tool lookup < 0.01ms', pass: results.find(r => r.name === 'ToolRegistry.get').avgMs < 0.01 },
    { name: 'Token estimation < 0.05ms', pass: results.find(r => r.name === 'estimateTokens').avgMs < 0.05 },
    { name: 'Cache key < 0.1ms', pass: results.find(r => r.name === 'computeCacheKey').avgMs < 0.1 },
    { name: 'Task creation < 0.05ms', pass: results.find(r => r.name === 'Task.create').avgMs < 0.05 },
    { name: 'Graph validation < 0.5ms', pass: results.find(r => r.name === 'TaskGraph.validate').avgMs < 0.5 },
    { name: 'Module registration < 0.1ms', pass: results.find(r => r.name === 'LazyLoader.register').avgMs < 0.1 },
  ];

  let passed = 0;
  for (const a of assertions) {
    if (a.pass) {
      passed++;
      console.log(`  ✓ ${a.name}`);
    } else {
      console.error(`  ✗ ${a.name}`);
    }
  }

  console.log(`\n  ${passed}/${assertions.length} assertions passed`);
  return passed === assertions.length;
}

// ── Run All Benchmarks ───────────────────────────────────────────────────

async function runBenchmarks() {
  const allResults = [
    { category: 'ToolSpec Protocol', results: await runToolSpecBenchmarks() },
    { category: 'Prompt Cache', results: await runPromptCacheBenchmarks() },
    { category: 'Task Scheduler', results: await runTaskSchedulerBenchmarks() },
    { category: 'Permission Broker', results: await runPermissionBrokerBenchmarks() },
    { category: 'Lazy Loader', results: await runLazyLoaderBenchmarks() },
  ];

  printReport(allResults);

  const allFlat = allResults.flatMap(r => r.results);
  assertPerformance(allFlat);
}

if (require.main === module) {
  runBenchmarks().catch(err => {
    console.error('Benchmark error:', err);
    process.exit(1);
  });
}

module.exports = {
  benchmark,
  BenchmarkResult,
  runBenchmarks,
};

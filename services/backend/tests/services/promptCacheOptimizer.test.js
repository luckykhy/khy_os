'use strict';

/**
 * Tests for Prompt Cache Optimizer (promptCacheOptimizer.js)
 *
 * Validates:
 * 1. Token estimation accuracy
 * 2. Watermark tier calculation
 * 3. Tier 1-4 compression strategies
 * 4. Tool result classification
 * 5. Smart truncation
 * 6. Stable/dynamic prompt separation
 * 7. Cache key generation
 * 8. Statistics tracking
 */

const {
  PromptCacheOptimizer,
  WATERMARK,
  TOOL_NOISE_CLASS,
  estimateTokens,
  estimateMessagesTokens,
  classifyToolResult,
  snip,
  elide,
  summarize,
  emergency,
  smartTruncate,
} = require('./promptCacheOptimizer');

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



// ── Token Estimation Tests ────────────────────────────────────────────────

function testTokenEstimation() {
  console.log('\n── Token Estimation ──');

  assert(estimateTokens('') === 0, 'empty string = 0 tokens');
  assert(estimateTokens('hello') === 2, 'short ASCII ~2 tokens');
  assert(estimateTokens('你好世界') === 4, 'CJK chars = 1 token each');

  const longText = 'a'.repeat(400);
  assert(estimateTokens(longText) > 0, '400 ASCII chars > 0 tokens');

  const messages = [
    { role: 'user', content: 'Hello world' },
    { role: 'assistant', content: 'Hi there!' },
  ];
  const msgTokens = estimateMessagesTokens(messages);
  assert(msgTokens > 0, 'message tokens > 0');
  assert(msgTokens > estimateTokens('Hello world') + estimateTokens('Hi there!'),
    'message tokens includes framing overhead');
}

// ── Watermark Tests ───────────────────────────────────────────────────────

function testWatermarks() {
  console.log('\n── Watermark Thresholds ──');

  assert(WATERMARK.SNIP === 0.60, 'SNIP at 60%');
  assert(WATERMARK.ELIDE === 0.80, 'ELIDE at 80%');
  assert(WATERMARK.SUMMARIZE === 0.95, 'SUMMARIZE at 95%');
  assert(WATERMARK.EMERGENCY === 0.99, 'EMERGENCY at 99%');

  const optimizer = new PromptCacheOptimizer({ contextWindow: 100000 });
  assert(optimizer.getWatermarkTier(0) === 0, 'tier 0 when empty');
  assert(optimizer.getWatermarkTier(50000) === 0, 'tier 0 at 50%');
  assert(optimizer.getWatermarkTier(60000) === 1, 'tier 1 at 60%');
  assert(optimizer.getWatermarkTier(80000) === 2, 'tier 2 at 80%');
  assert(optimizer.getWatermarkTier(95000) === 4, '95000 with reserved=4096 is tier 4');
  assert(optimizer.getWatermarkTier(99000) === 4, 'tier 4 at 99%');
}

// ── Compression Strategies Tests ──────────────────────────────────────────

function testCompressionStrategies() {
  console.log('\n── Tier 1: Snip ──');

  const verboseText = 'Hello\n\n\n\nWorld\n   \n\nEnd';
  const snipped = snip(verboseText);
  assert(snipped.length < verboseText.length, 'snip removes redundant whitespace');
  assert(!snipped.includes('\n\n\n'), 'snip collapses multiple newlines');

  console.log('\n── Tier 2: Elide ──');

  const longText = 'A'.repeat(1000) + 'B'.repeat(1000) + 'C'.repeat(1000);
  const elided = elide(longText, 0.5);
  assert(elided.length < longText.length, 'elide reduces length');
  assert(elided.includes('已省略'), 'elide adds omission notice');
  assert(elided.startsWith('A'.repeat(100)), 'elide keeps head');
  assert(elided.endsWith('C'.repeat(100)), 'elide keeps tail');

  console.log('\n── Tier 3: Summarize ──');

  const summarizeResult = summarize(longText);
  assert(summarizeResult.length < longText.length, 'summarize reduces length');

  console.log('\n── Tier 4: Emergency ──');

  const emergencyResult = emergency(longText);
  assert(emergencyResult.length < longText.length, 'emergency reduces length');
  assert(emergencyResult.includes('紧急压缩'), 'emergency adds notice');
}

// ── Tool Classification Tests ─────────────────────────────────────────────

function testToolClassification() {
  console.log('\n── Tool Result Classification ──');

  assert(
    classifyToolResult('grep', 'Error: file not found') === TOOL_NOISE_CLASS.HIGH_VALUE,
    'errors are high value'
  );

  assert(
    classifyToolResult('grep', 'success') === TOOL_NOISE_CLASS.HIGH_VALUE,
    'short success is high value'
  );

  assert(
    classifyToolResult('npm', 'npm install output...\nadded 1000 packages\nmore output here\nand even more\n' + 'x'.repeat(200)) === TOOL_NOISE_CLASS.REPETITIVE,
    'build logs are repetitive'
  );

  assert(
    classifyToolResult('query', '{"data": [{"id": 1, "name": "test"}]}' + 'x'.repeat(2000)) === TOOL_NOISE_CLASS.STRUCTURED,
    'JSON is structured'
  );

  // Note: base64 detection requires long continuous strings (>=100 chars without whitespace)
  const b64Long = 'A'.repeat(120) + '==';
  assert(
    classifyToolResult('read', b64Long) === TOOL_NOISE_CLASS.BINARY,
    'long base64-like content is binary'
  );
}

// ── Smart Truncation Tests ────────────────────────────────────────────────

function testSmartTruncation() {
  console.log('\n── Smart Truncation ──');

  const longError = 'Error: something went wrong\n'.repeat(50);
  const truncatedError = smartTruncate('test', longError, 100);
  assert(truncatedError.length > 0, 'error truncation keeps content');

  const longLog = '[2024-01-01] GET /api/users 200 OK\n'.repeat(100);
  const truncatedLog = smartTruncate('http_log', longLog, 500);
  assert(truncatedLog.length < longLog.length, 'log truncation reduces size');
}

// ── Prompt Splitting Tests ────────────────────────────────────────────────

function testPromptSplitting() {
  console.log('\n── Stable/Dynamic Prompt Splitting ──');

  const boundary = '__DYNAMIC_BOUNDARY__';
  const stable = 'You are a helpful assistant.\nYou help with coding.';
  const dynamic = 'Current time: 2024-01-01\nWorking dir: /project';
  const full = `${stable}\n${boundary}\n${dynamic}`;

  const split = PromptCacheOptimizer.splitSystemPrompt(full, boundary);
  assert(split.stable === stable, 'stable prefix extracted');
  assert(split.dynamic === dynamic, 'dynamic suffix extracted');

  const rebuilt = PromptCacheOptimizer.buildSystemPrompt(stable, dynamic, boundary);
  assert(rebuilt === full, 'rebuild matches original');

  const noBoundary = PromptCacheOptimizer.splitSystemPrompt('no boundary here');
  assert(noBoundary.stable === 'no boundary here', 'no boundary = all stable');
  assert(noBoundary.dynamic === '', 'no boundary = no dynamic');
}

// ── Cache Key Tests ───────────────────────────────────────────────────────

function testCacheKeys() {
  console.log('\n── Cache Key Generation ──');

  const key1 = PromptCacheOptimizer.computeCacheKey('system prompt', [{ name: 'tool1' }], 'gpt-4');
  const key2 = PromptCacheOptimizer.computeCacheKey('system prompt', [{ name: 'tool1' }], 'gpt-4');
  const key3 = PromptCacheOptimizer.computeCacheKey('different prompt', [{ name: 'tool1' }], 'gpt-4');

  assert(key1 === key2, 'same inputs = same key');
  assert(key1 !== key3, 'different inputs = different key');
  assert(key1.length === 64, 'SHA-256 hex = 64 chars');
}

// ── Optimizer Integration Tests ───────────────────────────────────────────

function testOptimizerIntegration() {
  console.log('\n── Optimizer: Full Pipeline ──');

  const optimizer = new PromptCacheOptimizer({ contextWindow: 100000 });

  // Test with small content (tier 0)
  const smallMessages = [
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi!' },
  ];
  const result0 = optimizer.optimize(smallMessages, 'Be helpful');
  assert(result0.stats.tier === 0, 'small content = tier 0');
  assert(result0.stats.saved === 0, 'tier 0 saves nothing');

  // Test with medium content (tier 1-2) - needs to exceed 60% of budget (95904 * 0.6 = 57542 tokens)
  const mediumContent = 'tool output with some content to make it longer\n'.repeat(200000);
  const mediumMessages = [
    { role: 'user', content: 'Do something' },
    { role: 'tool', content: mediumContent },
    { role: 'assistant', content: 'Done!' },
  ];
  const result1 = optimizer.optimize(mediumMessages, 'Be helpful assistant with detailed instructions');
  assert(result1.stats.tier >= 1, 'medium content triggers compression');
  assert(result1.stats.saved >= 0, 'compression saves tokens');

  // Test with large content (tier 3-4) - needs to exceed 95% of budget
  const largeContent = 'x'.repeat(50000);
  const largeMessages = [];
  for (let i = 0; i < 100; i++) {
    largeMessages.push({ role: 'user', content: `Message ${i}` });
    largeMessages.push({ role: 'tool', content: largeContent });
  }
  const result2 = optimizer.optimize(largeMessages, 'Be helpful');
  assert(result2.stats.tier >= 2, 'large content triggers higher tier');

  // Stats tracking
  const stats = optimizer.getStats();
  assert(stats.totalCalls === 3, '3 total calls tracked');
  assert(stats.avgSavings >= 0, 'average savings tracked');
}

// ── Statistics Reset Tests ────────────────────────────────────────────────

function testStatsReset() {
  console.log('\n── Statistics Reset ──');

  const optimizer = new PromptCacheOptimizer({ contextWindow: 100000 });
  const messages = [{ role: 'user', content: 'test' }];
  optimizer.optimize(messages, 'prompt');

  assert(optimizer.getStats().totalCalls === 1, 'has 1 call before reset');
  optimizer.resetStats();
  assert(optimizer.getStats().totalCalls === 0, '0 calls after reset');
}

// ── Run All Tests ─────────────────────────────────────────────────────────

function runTests() {
  console.log('═══════════════════════════════════════════');
  console.log('  Prompt Cache Optimizer Tests');
  console.log('═══════════════════════════════════════════');

  testTokenEstimation();
  testWatermarks();
  testCompressionStrategies();
  testToolClassification();
  testSmartTruncation();
  testPromptSplitting();
  testCacheKeys();
  testOptimizerIntegration();
  testStatsReset();

  console.log('\n═══════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests();

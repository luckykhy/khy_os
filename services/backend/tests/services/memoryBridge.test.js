'use strict';

/**
 * Tests for MemoryBridge (memoryBridge.js)
 *
 * Validates:
 * 1. Memory tool creation
 * 2. Read memory tool
 * 3. Write memory tool
 * 4. Log activity tool
 * 5. Memory search
 * 6. ToolSpec integration
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { MemoryBridge, createMemoryTools } = require('./memoryBridge');
const { ToolCategory, RiskLevel } = require('./toolSpec');

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
const testDir = path.join(os.tmpdir(), `khy-test-memory-${Date.now()}`);
const appHome = testDir;

// Setup and teardown
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

// ── Memory Tools Tests ────────────────────────────────────────────────────

async function testCreateMemoryTools() {
  console.log('\n── Memory Tools: Creation ──');

  const tools = createMemoryTools({ appHome });

  assert(tools.length === 3, '3 memory tools created');
  assert(tools[0].name === 'read_memory', 'read_memory tool');
  assert(tools[1].name === 'write_memory', 'write_memory tool');
  assert(tools[2].name === 'log_activity', 'log_activity tool');

  // Verify ToolSpec properties
  for (const tool of tools) {
    assert(tool.category === ToolCategory.LOCAL || tool.category === undefined, `${tool.name} has category`);
    assert(typeof tool.execute === 'function', `${tool.name} has execute`);
  }
}

async function testReadMemory() {
  console.log('\n── Memory Tool: Read Memory ──');

  const tools = createMemoryTools({ appHome });
  const readTool = tools.find(t => t.name === 'read_memory');

  assert(readTool.readOnly === true, 'read_memory is read-only');
  assert(readTool.requiresPermission === false, 'read_memory needs no permission');

  // Read empty index
  const result = await readTool.execute({});
  assert(result.isError === false, 'read succeeds');
  assert(result.content.categories.length >= 4, 'returns categories');
}

async function testWriteMemory() {
  console.log('\n── Memory Tool: Write Memory ──');

  const tools = createMemoryTools({ appHome });
  const writeTool = tools.find(t => t.name === 'write_memory');

  assert(writeTool.mutatesFiles === true, 'write_memory mutates files');
  assert(writeTool.risk === RiskLevel.LOW, 'write_memory is low risk');

  // Write a memory
  const result = await writeTool.execute({
    type: 'user',
    name: 'test-prefs',
    content: 'User prefers dark mode',
  });

  assert(result.isError === false, 'write succeeds');
  assert(result.content.type === 'user', 'type is user');
  assert(result.content.name === 'test-prefs', 'name is test-prefs');
  assert(result.content.action === 'written', 'action is written');

  // Verify file was created
  const memPath = path.join(appHome, 'memory', 'user', 'test-prefs.md');
  assert(fs.existsSync(memPath), 'memory file created');
  const content = fs.readFileSync(memPath, 'utf-8');
  assert(content.includes('dark mode'), 'content written');
}

async function testWriteMemoryAppend() {
  console.log('\n── Memory Tool: Write Memory Append ──');

  const tools = createMemoryTools({ appHome });
  const writeTool = tools.find(t => t.name === 'write_memory');

  // Write initial
  await writeTool.execute({
    type: 'project',
    name: 'test-project',
    content: 'Initial content',
  });

  // Append
  const result = await writeTool.execute({
    type: 'project',
    name: 'test-project',
    content: 'Additional info',
    append: true,
  });

  assert(result.content.action === 'appended', 'action is appended');

  const memPath = path.join(appHome, 'memory', 'project', 'test-project.md');
  const content = fs.readFileSync(memPath, 'utf-8');
  assert(content.includes('Initial content'), 'initial content preserved');
  assert(content.includes('Additional info'), 'appended content present');
}

async function testLogActivity() {
  console.log('\n── Memory Tool: Log Activity ──');

  const tools = createMemoryTools({ appHome });
  const logTool = tools.find(t => t.name === 'log_activity');

  assert(logTool.risk === RiskLevel.SAFE, 'log_activity is safe');

  const result = await logTool.execute({
    entry: 'Made a decision to use TypeScript',
    tag: 'decision',
  });

  assert(result.isError === false, 'log succeeds');
  assert(result.content.logged === true, 'logged is true');
  assert(result.content.tag === 'decision', 'tag preserved');

  // Verify daily log was created
  const today = new Date();
  const logDir = path.join(appHome, 'memory', 'logs', String(today.getFullYear()), String(today.getMonth() + 1).padStart(2, '0'));
  assert(fs.existsSync(logDir), 'log directory created');
}

async function testMemorySearch() {
  console.log('\n── Memory Tool: Search Memories ──');

  const tools = createMemoryTools({ appHome });
  const writeTool = tools.find(t => t.name === 'write_memory');
  const readTool = tools.find(t => t.name === 'read_memory');

  // Write some memories
  await writeTool.execute({
    type: 'user',
    name: 'coding-style',
    content: 'User prefers functional programming and TypeScript',
  });

  await writeTool.execute({
    type: 'project',
    name: 'khy-os',
    content: 'Khy OS is an AI platform operating system',
  });

  // Search
  const result = await readTool.execute({
    query: 'TypeScript programming',
    limit: 5,
  });

  assert(result.isError === false, 'search succeeds');
  assert(result.content.found >= 1, 'found at least 1 match');
}

async function testMemoryBridge() {
  console.log('\n── MemoryBridge: Integration ──');

  const bridge = new MemoryBridge({ appHome });
  const tools = bridge.getTools();

  assert(tools.length === 3, 'bridge provides 3 tools');

  const status = bridge.getStatus();
  assert(typeof status.exists === 'boolean', 'status has exists');
  assert(status.tools.length === 3, 'status lists tools');
}

async function testInvalidMemoryType() {
  console.log('\n── Memory Tool: Invalid Type ──');

  const tools = createMemoryTools({ appHome });
  const writeTool = tools.find(t => t.name === 'write_memory');

  const result = await writeTool.execute({
    type: 'invalid_type',
    name: 'test',
    content: 'content',
  });

  assert(result.isError === true, 'invalid type returns error');
}

// ── Run All Tests ─────────────────────────────────────────────────────────

async function runTests() {
  console.log('═══════════════════════════════════════════');
  console.log('  MemoryBridge Tests');
  console.log('═══════════════════════════════════════════');

  setup();

  try {
    await testCreateMemoryTools();
    await testReadMemory();
    await testWriteMemory();
    await testWriteMemoryAppend();
    await testLogActivity();
    await testMemorySearch();
    await testMemoryBridge();
    await testInvalidMemoryType();
  } finally {
    teardown();
  }

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

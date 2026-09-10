'use strict';

/**
 * Tests for ToolSpec protocol (toolSpec.js)
 *
 * Validates:
 * 1. ToolSpec construction and immutability
 * 2. ToolResult factory methods
 * 3. ToolRegistry registration/discovery
 * 4. Format conversions (OpenAI, Anthropic)
 * 5. Metadata-based filtering
 */

const {
  ToolSpec,
  ToolResult,
  ToolRegistry,
  ToolCategory,
  RiskLevel,
} = require('./toolSpec');

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

function assertThrows(fn, message) {
  try {
    fn();
    failed++;
    console.error(`  ✗ ${message} (did not throw)`);
  } catch {
    passed++;
    console.log(`  ✓ ${message}`);
  }
}



// ── ToolSpec Tests ────────────────────────────────────────────────────────

async function testToolSpec() {
  console.log('\n── ToolSpec Construction ──');

  const readTool = new ToolSpec({
    name: 'read_file',
    description: 'Read a file from disk',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
      },
      required: ['path'],
    },
    execute: async (params) => ToolResult.success(`Content of ${params.path}`),
    readOnly: true,
    mutatesFiles: false,
    requiresPermission: false,
    parallelSafe: true,
    category: ToolCategory.FILE_READ,
    risk: RiskLevel.SAFE,
    aliases: ['Read', 'readFile', 'readfile'],
    activityDescription: '读取文件',
  });

  assert(readTool.name === 'read_file', 'name is accessible');
  assert(readTool.description === 'Read a file from disk', 'description is accessible');
  assert(readTool.readOnly === true, 'readOnly is true');
  assert(readTool.mutatesFiles === false, 'mutatesFiles is false');
  assert(readTool.parallelSafe === true, 'parallelSafe is true');
  assert(readTool.isParallelSafe === true, 'isParallelSafe computed correctly');
  assert(readTool.isReadOnly === true, 'isReadOnly computed correctly');
  assert(readTool.category === ToolCategory.FILE_READ, 'category is set');
  assert(readTool.risk === RiskLevel.SAFE, 'risk is set');
  assert(readTool.aliases.length === 3, 'aliases stored correctly');
  assert(readTool.activityDescription === '读取文件', 'activityDescription is set');

  // Immutability
  console.log('\n── ToolSpec Immutability ──');
  try {
    readTool._name = 'modified';
    assert(readTool.name === 'read_file', 'cannot modify frozen name');
  } catch {
    passed++;
    console.log('  ✓ cannot modify frozen name');
  }

  // Validation
  console.log('\n── ToolSpec Validation ──');
  assertThrows(() => new ToolSpec({}), 'throws on empty config');
  assertThrows(() => new ToolSpec({ name: 'test' }), 'throws without description');
  assertThrows(() => new ToolSpec({ name: 'test', description: 'test' }), 'throws without inputSchema');
  assertThrows(
    () => new ToolSpec({ name: 'test', description: 'test', inputSchema: {} }),
    'throws without execute'
  );

  // Execute
  console.log('\n── ToolSpec Execute ──');
  const result = await readTool.execute({ path: '/test/file.txt' });
  assert(result instanceof ToolResult, 'execute returns ToolResult');
  assert(result.content === 'Content of /test/file.txt', 'execute passes params correctly');
  assert(result.isError === false, 'execute returns success');

  // Format conversions
  console.log('\n── ToolSpec Format Conversions ──');
  const anthropic = readTool.toAnthropicTool();
  assert(anthropic.name === 'read_file', 'Anthropic format has name');
  assert(anthropic.input_schema !== undefined, 'Anthropic format has input_schema');

  const openai = readTool.toOpenAIFunction();
  assert(openai.type === 'function', 'OpenAI format has type');
  assert(openai.function.name === 'read_file', 'OpenAI format has function name');
  assert(openai.function.parameters !== undefined, 'OpenAI format has parameters');

  const definition = readTool.toDefinition();
  assert(definition.name === 'read_file', 'definition has name');
  assert(definition.read_only === true, 'definition has read_only');
  assert(definition.parallel_safe === true, 'definition has parallel_safe');

  // Cache key
  const cacheKey = readTool.getCacheKey();
  assert(typeof cacheKey === 'string' && cacheKey.length === 16, 'cache key is 16 char hex');
}

// ── ToolResult Tests ──────────────────────────────────────────────────────

async function testToolResult() {
  console.log('\n── ToolResult Factory Methods ──');

  const success = ToolResult.success('File content here', {
    changedFiles: ['/test/file.txt'],
    tokenCount: 42,
  });
  assert(success.content === 'File content here', 'success content');
  assert(success.isError === false, 'success isError is false');
  assert(success.changedFiles[0] === '/test/file.txt', 'success changedFiles');
  assert(success.tokenCount === 42, 'success tokenCount');
  assert(success.timestamp > 0, 'success has timestamp');

  const error = ToolResult.error('File not found');
  assert(error.content === 'File not found', 'error content');
  assert(error.isError === true, 'error isError is true');

  console.log('\n── ToolResult Format Conversions ──');
  const anthropic = success.toAnthropic('toolu_123');
  assert(anthropic.type === 'tool_result', 'Anthropic type');
  assert(anthropic.tool_use_id === 'toolu_123', 'Anthropic tool_use_id');
  assert(anthropic.is_error === false, 'Anthropic is_error');

  const openai = success.toOpenAI('call_456');
  assert(openai.tool_call_id === 'call_456', 'OpenAI tool_call_id');
  assert(openai.role === 'tool', 'OpenAI role');

  console.log('\n── ToolResult Token Estimation ──');
  const tokens = success.estimateTokens();
  assert(tokens > 0, 'estimateTokens returns positive');
}

// ── ToolRegistry Tests ────────────────────────────────────────────────────

async function testToolRegistry() {
  console.log('\n── ToolRegistry Registration ──');

  const registry = new ToolRegistry();

  const readTool = new ToolSpec({
    name: 'read_file',
    description: 'Read a file',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    execute: async (params) => ToolResult.success(`Read ${params.path}`),
    readOnly: true,
    parallelSafe: true,
    category: ToolCategory.FILE_READ,
    risk: RiskLevel.SAFE,
    aliases: ['Read', 'readFile'],
  });

  const writeTool = new ToolSpec({
    name: 'write_file',
    description: 'Write a file',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } },
    execute: async (params) => ToolResult.success(`Wrote ${params.path}`),
    readOnly: false,
    mutatesFiles: true,
    category: ToolCategory.FILE_WRITE,
    risk: RiskLevel.MEDIUM,
    aliases: ['Write', 'writeFile'],
  });

  const searchTool = new ToolSpec({
    name: 'search_code',
    description: 'Search code patterns',
    inputSchema: { type: 'object', properties: { pattern: { type: 'string' } } },
    execute: async (params) => ToolResult.success(`Found ${params.pattern}`),
    readOnly: true,
    parallelSafe: true,
    category: ToolCategory.SEARCH,
    risk: RiskLevel.SAFE,
  });

  registry.register(readTool).register(writeTool).register(searchTool);

  assert(registry.getAll().length === 3, 'registry has 3 tools');
  assert(registry.has('read_file'), 'has read_file');
  assert(registry.has('Read'), 'has Read alias');
  assert(registry.has('readFile'), 'has readFile alias');
  assert(registry.has('write_file'), 'has write_file');
  assert(!registry.has('nonexistent'), 'does not have nonexistent');

  console.log('\n── ToolRegistry Lookup ──');
  assert(registry.get('read_file') === readTool, 'get by name');
  assert(registry.get('Read') === readTool, 'get by alias');
  assert(registry.get('READFILE') === readTool, 'get by alias case-insensitive');
  assert(registry.get('nonexistent') === null, 'get nonexistent returns null');

  console.log('\n── ToolRegistry Filtering ──');
  const readOnly = registry.getReadOnlyTools();
  assert(readOnly.length === 2, '2 read-only tools');

  const parallelSafe = registry.getParallelSafeTools();
  assert(parallelSafe.length === 2, '2 parallel-safe tools');

  const mutation = registry.getMutationTools();
  assert(mutation.length === 1, '1 mutation tool');
  assert(mutation[0].name === 'write_file', 'mutation tool is write_file');

  const fileRead = registry.getByCategory(ToolCategory.FILE_READ);
  assert(fileRead.length === 1, '1 file_read tool');

  const safeTools = registry.getByRisk(RiskLevel.SAFE);
  assert(safeTools.length === 2, '2 safe tools');

  console.log('\n── ToolRegistry Definitions ──');
  const allDefs = registry.getDefinitions();
  assert(allDefs.length === 3, 'all definitions');

  const readOnlyDefs = registry.getDefinitions({ readOnlyOnly: true });
  assert(readOnlyDefs.length === 2, 'read-only definitions');

  const fileReadDefs = registry.getDefinitions({ category: ToolCategory.FILE_READ });
  assert(fileReadDefs.length === 1, 'file_read definitions');

  console.log('\n── ToolRegistry Format Conversions ──');
  const anthropicTools = registry.getAnthropicTools();
  assert(anthropicTools.length === 3, '3 Anthropic tools');
  assert(anthropicTools[0].name === 'read_file', 'first Anthropic tool name');

  const openaiTools = registry.getOpenAIFunctions();
  assert(openaiTools.length === 3, '3 OpenAI functions');
  assert(openaiTools[0].type === 'function', 'first OpenAI function type');

  console.log('\n── ToolRegistry Stats ──');
  const stats = registry.getStats();
  assert(stats.total === 3, 'stats total');
  assert(stats.readOnly === 2, 'stats readOnly');
  assert(stats.parallelSafe === 2, 'stats parallelSafe');
  assert(stats.mutation === 1, 'stats mutation');
  assert(stats.byCategory[ToolCategory.FILE_READ] === 1, 'stats byCategory');
  assert(stats.byRisk[RiskLevel.SAFE] === 2, 'stats byRisk');

  console.log('\n── ToolRegistry Unregister ──');
  assert(registry.unregister('write_file') === true, 'unregister returns true');
  assert(registry.getAll().length === 2, '2 tools after unregister');
  assert(!registry.has('Write'), 'alias removed');
  assert(registry.unregister('nonexistent') === false, 'unregister nonexistent returns false');

  console.log('\n── ToolRegistry Clear ──');
  registry.clear();
  assert(registry.getAll().length === 0, '0 tools after clear');
}

// ── Integration Tests ─────────────────────────────────────────────────────

async function testIntegration() {
  console.log('\n── Integration: Tool Execution Pipeline ──');

  const registry = new ToolRegistry();

  // Register a chain of tools
  registry.register(new ToolSpec({
    name: 'list_files',
    description: 'List files in directory',
    inputSchema: { type: 'object', properties: { dir: { type: 'string' } } },
    execute: async () => ToolResult.success(['a.txt', 'b.js', 'c.md']),
    readOnly: true,
    parallelSafe: true,
    category: ToolCategory.FILE_READ,
    risk: RiskLevel.SAFE,
  }));

  registry.register(new ToolSpec({
    name: 'execute_command',
    description: 'Run a shell command',
    inputSchema: { type: 'object', properties: { cmd: { type: 'string' } } },
    execute: async (params) => {
      if (params.cmd.includes('danger')) {
        return ToolResult.error('Command blocked: dangerous');
      }
      return ToolResult.success(`Executed: ${params.cmd}`);
    },
    readOnly: false,
    mutatesFiles: false,
    category: ToolCategory.SHELL,
    risk: RiskLevel.HIGH,
  }));

  // Simulate AI tool call
  const tool = registry.get('list_files');
  const result = await tool.execute({ dir: '/project' });
  assert(result.isError === false, 'tool execution succeeds');
  assert(Array.isArray(result.content), 'tool returns array');

  // Simulate error case
  const execTool = registry.get('execute_command');
  const errorResult = await execTool.execute({ cmd: 'danger: rm -rf /' });
  assert(errorResult.isError === true, 'dangerous command blocked');
}

// ── Run All Tests ─────────────────────────────────────────────────────────

async function runTests() {
  console.log('═══════════════════════════════════════════');
  console.log('  ToolSpec Protocol Tests');
  console.log('═══════════════════════════════════════════');

  await testToolSpec();
  await testToolResult();
  await testToolRegistry();
  await testIntegration();

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

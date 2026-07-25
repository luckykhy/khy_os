#!/usr/bin/env node
/**
 * @pattern Visitor, Template Method
 */
/**
 * 自动生成 pattern-registry.json
 * 基于文件路径、目录、名称的规则匹配 GoF 23 设计模式
 */
const fs = require('fs');
const path = require('path');

const files = fs.readFileSync('/tmp/all_source_files_clean.txt', 'utf8').trim().split('\n');

const registry = {};

function classify(f) {
  const patterns = new Set();
  const base = path.basename(f);
  const dir = path.dirname(f);
  const ext = path.extname(f);

  // ====== 创建型 ======

  // Singleton — 模块级单例状态、注册表、管理器、stores
  if (/Registry|registry/i.test(base)) patterns.add('Singleton');
  if (/Manager|manager/i.test(base) && !base.includes('pluginManager')) patterns.add('Singleton');
  if (/stores\//i.test(f)) patterns.add('Singleton');
  if (/stores\//.test(f)) patterns.add('Memento'); // stores also persist
  if (/serviceRegistry|appRegistry|skillRegistry|themeRegistry|hookRegistry|customerRegistry|customProviderRegistry/i.test(base)) patterns.add('Singleton');
  if (/aiGateway\.js$|proxyServer\.js$|server\.js$/i.test(base) && !base.startsWith('_')) patterns.add('Singleton');
  if (/cacheService|dedupeCache|promptCacheService/i.test(base)) patterns.add('Singleton');
  if (/state\.js$|canonicalState|coherenceState|boulderState/i.test(base)) patterns.add('Singleton');
  if (/configMigration|featureFlags|featureCapabilityMap/i.test(base)) patterns.add('Singleton');

  // Factory Method — 工具/agent/技能创建
  if (/_baseTool\.js$|_baseAdapter\.js$|_baseChannel\.js$/i.test(base)) patterns.add('Factory Method');
  if (/builtInAgents|loadAgents|skillLoader|index\.js$/.test(base) && /agents|skills/.test(dir)) patterns.add('Factory Method');
  if (/contextFactory/i.test(base)) { patterns.add('Abstract Factory'); patterns.add('Factory Method'); }
  if (/pluginManager/i.test(base)) patterns.add('Factory Method');

  // Abstract Factory — 插件上下文工厂
  if (/contextFactory|plugin-loader\/index/i.test(f)) patterns.add('Abstract Factory');
  if (/plugin-sdk/i.test(f) && base === 'index.js') patterns.add('Abstract Factory');

  // Builder — prompt/配置构建
  if (/prompts?\.js$|systemPromptSections/i.test(base)) patterns.add('Builder');
  if (/sshConfigService/i.test(base)) patterns.add('Builder');
  if (/gdt\.c$|idt\.c$/i.test(base)) patterns.add('Builder');
  if (/response\.js$/i.test(base) && /utils/.test(dir)) patterns.add('Builder');
  if (/queryConfig|queryState|compactPipeline/i.test(base)) patterns.add('Builder');
  if (/esbuild\.config/i.test(base)) patterns.add('Builder');
  if (/vite\.config/i.test(base)) patterns.add('Builder');

  // Prototype — fork/clone
  if (/agentContext/i.test(base)) patterns.add('Prototype');
  if (/process\.c$/.test(base)) patterns.add('Prototype');
  if (/projectTemplateService/i.test(base)) patterns.add('Prototype');
  if (/workerAgent/i.test(base)) patterns.add('Prototype');

  // ====== 结构型 ======

  // Adapter — gateway adapters、平台适配
  if (/adapters?\//i.test(f) && !/_base|_abort|_adapter|_error|_finger|_ide|_image|_proxy|_sse|_stream/i.test(base)) patterns.add('Adapter');
  if (/Adapter\.js$/i.test(base)) patterns.add('Adapter');
  if (/platformUtils/i.test(base)) patterns.add('Adapter');
  if (/serial\.c$|vga\.c$|framebuffer\.c$|pic\.c$/i.test(base)) patterns.add('Adapter');
  if (/protocolConverter/i.test(f)) patterns.add('Adapter');
  if (/claudeCompat|pathCompat|sqliteCompat|wincompat/i.test(base)) patterns.add('Adapter');
  if (/tickDataAdapter|intelligentStrategyAdapter/i.test(base)) patterns.add('Adapter');
  if (/tvTime/i.test(base)) patterns.add('Adapter');

  // Bridge — 协议转换中间层、SDK transport
  if (/bridge/i.test(base) || /bridge\//i.test(f)) patterns.add('Bridge');
  if (/Transport|transport/i.test(base)) patterns.add('Bridge');
  if (/protocolConverter\/index/i.test(f)) patterns.add('Bridge');
  if (/acpTransport|bridgeTransport|processTransport|loopbackTransport/i.test(base)) patterns.add('Bridge');
  if (/remoteApprovalBridge/i.test(base)) patterns.add('Bridge');
  if (/moonbit_bridge|moonbitHostBridge/i.test(base)) patterns.add('Bridge');
  if (/channelHealthBroadcaster/i.test(base)) patterns.add('Bridge');

  // Composite — Vue 组件树、菜单树、文件系统
  if (ext === '.vue') patterns.add('Composite');
  if (/menu\.js$/i.test(base)) patterns.add('Composite');
  if (/ramfs\.c$|vfs\.c$/i.test(base)) patterns.add('Composite');
  if (/agenticHarness/i.test(base)) patterns.add('Composite');
  if (/inkComponents/i.test(base)) patterns.add('Composite');
  if (/taskMindMap/i.test(base)) patterns.add('Composite');

  // Decorator — 日志/审计/性能增强
  if (/toolProfile|auditLog|logger/i.test(base)) patterns.add('Decorator');
  if (/expressAsyncPatch/i.test(base)) patterns.add('Decorator');
  if (/requestLogger|traceAuditService/i.test(base)) patterns.add('Decorator');
  if (/telemetryService/i.test(base)) patterns.add('Decorator');
  if (/startupProfiler/i.test(base)) patterns.add('Decorator');
  if (/diagnosticEvents|advancedDiagnostics/i.test(base)) patterns.add('Decorator');

  // Facade — 服务入口、API 层
  if (/extensionMarketplace|cleanupService|adminService/i.test(base)) patterns.add('Facade');
  if (/comprehensiveData(?:Service|Controller|StaticConfig)/i.test(base)) patterns.add('Facade');
  if (/smartAIService|llmService/i.test(base)) patterns.add('Facade');
  if (/gettingStartedService|onboarding/i.test(base)) patterns.add('Facade');
  if (/index\.js$/.test(base) && /services|tools|models|middleware|routes/.test(dir) && !/gateway\/adapters/.test(dir)) patterns.add('Facade');
  if (/aiManagementServer/i.test(base)) patterns.add('Facade');
  if (/Dashboard|dashboard/i.test(base) && ext === '.vue') patterns.add('Facade');
  if (/main\.js$|main\.c$|main\.mbt$/i.test(base)) patterns.add('Facade');
  if (/compact\/index/i.test(f)) patterns.add('Facade');
  if (/mcp\/index/i.test(f)) patterns.add('Facade');

  // Flyweight — 常量/配置共享
  if (/constants\//i.test(f)) patterns.add('Flyweight');
  if (/config\//i.test(f) && !/vite\.config|esbuild\.config|capacitor\.config/.test(base)) patterns.add('Flyweight');
  if (/aliases|types\.js$|types\.d\.ts$|types\.py$/i.test(base)) patterns.add('Flyweight');
  if (/sprites/i.test(base)) patterns.add('Flyweight');
  if (/serviceDefaults|wasmDefaults|m1Constants/i.test(base)) patterns.add('Flyweight');
  if (/referencePrices|settingsWhitelist/i.test(base)) patterns.add('Flyweight');
  if (/formats\.js$/i.test(base) && /protocolConverter/.test(f)) patterns.add('Flyweight');
  if (/env\.js$/i.test(base)) patterns.add('Flyweight');

  // Proxy — 中间件/限流/沙箱
  if (/middleware\//i.test(f)) patterns.add('Proxy');
  if (/rateLimit|rateLimiter|redisRateLimiter/i.test(base)) patterns.add('Proxy');
  if (/toolSandbox|resourceGuard|ssrfGuard|shellSafetyValidator/i.test(base)) patterns.add('Proxy');
  if (/authGuard|securityGuard|preflightPermission|toolGuards/i.test(base)) patterns.add('Proxy');
  if (/auth\.js$/i.test(base) && /middleware/.test(dir)) patterns.add('Proxy');
  if (/requestInterceptor/i.test(base)) patterns.add('Proxy');
  if (/proxyConfigService|proxyServer|proxy/i.test(base) && !/stockProxy/.test(base)) patterns.add('Proxy');
  if (/wasm-sandbox/i.test(f)) patterns.add('Proxy');

  // ====== 行为型 ======

  // Chain of Responsibility — 中间件链/钩子链/权限链
  if (/pluginChain/i.test(base)) patterns.add('Chain of Responsibility');
  if (/hookRunner|hookSystem/i.test(base)) patterns.add('Chain of Responsibility');
  if (/permissions\/index|permissions\/rules/i.test(f)) patterns.add('Chain of Responsibility');
  if (/toolPipeline|autoReplyPipeline/i.test(base)) patterns.add('Chain of Responsibility');
  if (/errorHandler/i.test(base)) patterns.add('Chain of Responsibility');
  if (/bashSecurity/i.test(base)) patterns.add('Chain of Responsibility');
  if (/credentialWatcher|keyHealthProbe/i.test(base)) patterns.add('Chain of Responsibility');

  // Command — 工具文件、路由、CLI handler、系统调用
  if (/^backend\/src\/tools\//.test(f) && !/_baseTool|_taskStore|toolProfile|platformUtils|inputValidators|toolSearch/.test(base)) patterns.add('Command');
  if (/routes\//i.test(f) && base !== 'index.js') patterns.add('Command');
  if (/handlers\//i.test(f)) patterns.add('Command');
  if (/syscall\.c$/i.test(base)) patterns.add('Command');
  if (/commands\//i.test(f)) patterns.add('Command');
  if (/shellCommand|executeCode/i.test(base)) patterns.add('Command');
  if (/^backend\/src\/tools\/[A-Z]/.test(f)) patterns.add('Command');
  if (/scripts\//i.test(f) && !/_build|ci\//.test(f)) patterns.add('Command');
  if (/cli\.js$|cli\.py$/i.test(base)) patterns.add('Command');
  if (/bin\//i.test(f)) patterns.add('Command');
  if (/migrations?\//i.test(f)) patterns.add('Command');

  // Interpreter — 公式/格式解析
  if (/tdxInterpreter|tdxFormulaEngine|tdxPythonBridge/i.test(base)) patterns.add('Interpreter');
  if (/elf\.c$|pe\.c$/i.test(base)) patterns.add('Interpreter');
  if (/directiveParser|commandSchema|shellClassifier/i.test(base)) patterns.add('Interpreter');
  if (/binaryAnalyzer/i.test(base)) patterns.add('Interpreter');
  if (/safeJsonParse/i.test(base)) patterns.add('Interpreter');
  if (/errorClassifier|_errorClassifiers/i.test(base)) patterns.add('Interpreter');
  if (/patch_gguf/i.test(base)) patterns.add('Interpreter');

  // Iterator — 流解析/round-robin/CSV解析
  if (/_sseParser|ndjsonStream|streamProcessor|streamingToolCallParser|streamingToolExecutor/i.test(base)) patterns.add('Iterator');
  if (/apiKeyPool/i.test(base)) patterns.add('Iterator');
  if (/tickCsvParser/i.test(base)) patterns.add('Iterator');
  if (/jsonLines|sseParser/i.test(base)) patterns.add('Iterator');
  if (/asyncStream/i.test(base)) patterns.add('Iterator');
  if (/keySelector|modelDiscovery/i.test(base)) patterns.add('Iterator');
  if (/lineBuffer/i.test(base)) patterns.add('Iterator');

  // Mediator — REPL/消息路由/IPC
  if (/repl\.js$|liteRepl/i.test(base)) patterns.add('Mediator');
  if (/messageRouter/i.test(base)) patterns.add('Mediator');
  if (/ipc\.c$|ipcProtocol|ipcCodec/i.test(base)) patterns.add('Mediator');
  if (/wm\.c$/i.test(base)) patterns.add('Mediator');
  if (/devicePairing/i.test(base)) patterns.add('Mediator');
  if (/coordinatorMode/i.test(base)) patterns.add('Mediator');
  if (/subAgentOrchestrator|agentCommunicationService/i.test(base)) patterns.add('Mediator');
  if (/router\.js$/i.test(base) && /cli|router/.test(dir)) patterns.add('Mediator');
  if (/contextRouter/i.test(base)) patterns.add('Mediator');
  if (/multiTerminalBackend/i.test(base)) patterns.add('Mediator');
  if (/pty\.js$/i.test(base)) patterns.add('Mediator');

  // Memento — 状态持久化/崩溃恢复
  if (/sessionPersistence|sessionRecapService|sessionSearchIndex|sessionFileRepair/i.test(base)) patterns.add('Memento');
  if (/crashRecovery/i.test(base)) patterns.add('Memento');
  if (/taskStore|_taskStore/i.test(base)) patterns.add('Memento');
  if (/permissionStore/i.test(base)) patterns.add('Memento');
  if (/checkpointService/i.test(base)) patterns.add('Memento');
  if (/remoteStatePersistence|remoteExecStreamStore/i.test(base)) patterns.add('Memento');
  if (/arenaResultStore|largeTaskRuntimeStore/i.test(base)) patterns.add('Memento');
  if (/sqliteBackupService/i.test(base)) patterns.add('Memento');
  if (/fileHistoryService/i.test(base)) patterns.add('Memento');
  if (/localAuthService/i.test(base)) patterns.add('Memento');
  if (/stateSync/i.test(base)) patterns.add('Memento');
  if (/diskOutput/i.test(base)) patterns.add('Memento');

  // Observer — Vue 响应式/SSE/WebSocket/钩子注册
  if (ext === '.vue') patterns.add('Observer');
  if (/composables?\//i.test(f)) patterns.add('Observer');
  if (/websocket|WebSocket/i.test(base)) patterns.add('Observer');
  if (/sseKeepalive/i.test(base)) patterns.add('Observer');
  if (/hookRegistry/i.test(base)) patterns.add('Observer');
  if (/notificationService|notifier/i.test(base)) patterns.add('Observer');
  if (/channelHealthBroadcaster/i.test(base)) patterns.add('Observer');
  if (/aiMonitor/i.test(base)) patterns.add('Observer');
  if (/heartbeatRunner|heartbeatCooldown/i.test(base)) patterns.add('Observer');
  if (/strategyMonitor/i.test(base)) patterns.add('Observer');
  if (/networkMonitor|networkDetector/i.test(base)) patterns.add('Observer');
  if (/genaiEvents/i.test(base)) patterns.add('Observer');
  if (/transparencyService/i.test(base)) patterns.add('Observer');
  if (/usageTracker/i.test(base)) patterns.add('Observer');

  // State — 断路器/任务状态机/进程状态
  if (/circuitBreaker/i.test(base)) patterns.add('State');
  if (/backgroundTaskManager|taskControlService/i.test(base)) patterns.add('State');
  if (/sched\.c$/i.test(base)) patterns.add('State');
  if (/accountPool/i.test(base)) patterns.add('State');
  if (/capacityFlow|deliveryGate|intentGate|bugfixRegressionGate|changeRegressionGate/i.test(base)) patterns.add('State');
  if (/planModeService|goalModeService/i.test(base)) patterns.add('State');
  if (/concurrencyLimiter|concurrencySlots/i.test(base)) patterns.add('State');
  if (/largeTaskOrchestrator|largeTaskWorkerService/i.test(base)) patterns.add('State');
  if (/liveModelSwitch/i.test(base)) patterns.add('State');
  if (/sshConnectionManager/i.test(base)) patterns.add('State');
  if (/processAgent/i.test(base)) patterns.add('State');
  if (/vimInput/i.test(base)) patterns.add('State');
  if (/transitions\.js$/i.test(base) && /vim/.test(dir)) patterns.add('State');

  // Strategy — 算法选择/调度/限流策略
  if (/contextRouter|outputStyles|modelRouter/i.test(base)) patterns.add('Strategy');
  if (/rateLimiter/i.test(base)) patterns.add('Strategy');
  if (/strategyEngine|strategyRecommender|pythonStrategyEngine/i.test(base)) patterns.add('Strategy');
  if (/contextCompressor|contextPruner|smartTruncation/i.test(base)) patterns.add('Strategy');
  if (/retryWithBackoff|retryPolicy/i.test(base)) patterns.add('Strategy');
  if (/fetchTimeout/i.test(base)) patterns.add('Strategy');
  if (/tokenBudget/i.test(base)) patterns.add('Strategy');
  if (/autoReasoning/i.test(base)) patterns.add('Strategy');
  if (/shellToToolMapper/i.test(base)) patterns.add('Strategy');
  if (/commandRewriter|responseCompressor|schemaCompressor|toonCodec/i.test(base)) patterns.add('Strategy');
  if (/adaptiveOutput/i.test(base)) patterns.add('Strategy');
  if (/contextWindowGuard/i.test(base)) patterns.add('Strategy');
  if (/routeHelpers/i.test(base)) patterns.add('Strategy');
  if (/indicators\//i.test(f) || /indicators\.js$|indicators\.mbt$/i.test(base)) patterns.add('Strategy');
  if (/pmm\.c$|vmm\.c$|kheap\.c$/i.test(base)) patterns.add('Strategy');
  if (/obfuscate/i.test(base)) patterns.add('Strategy');
  if (/symbolResolver/i.test(base)) patterns.add('Strategy');
  if (/palette/i.test(base)) patterns.add('Strategy');

  // Template Method — 骨架/启动/脚本
  if (/_baseTool\.js$|_baseAdapter\.js$|_baseChannel\.js$/i.test(base)) patterns.add('Template Method');
  if (/bootstrap\//i.test(f)) patterns.add('Template Method');
  if (/setup\.js$|setup\.py$/i.test(base)) patterns.add('Template Method');
  if (/seed\.js$|create-admin\.js$/i.test(base)) patterns.add('Template Method');
  if (/install\.sh$|install\.ps1$|upgrade_khy\.sh$/i.test(base)) patterns.add('Template Method');
  if (/build-.*\.(sh|ps1)$/i.test(base)) patterns.add('Template Method');
  if (/run-.*\.(sh|js)$/i.test(base)) patterns.add('Template Method');
  if (/deploy-/i.test(base)) patterns.add('Template Method');
  if (/^scripts\/ci\//i.test(f)) patterns.add('Template Method');
  if (/baseSelfCheckService/i.test(base)) patterns.add('Template Method');
  if (/init\.js$/i.test(base) && /bootstrap/.test(dir)) patterns.add('Template Method');
  if (/dailyLog|autoDream|consolidationLock/i.test(base)) patterns.add('Template Method');
  if (/proactive/i.test(base)) patterns.add('Template Method');
  if (/updateRunner|khyUpgradeRuntime/i.test(base)) patterns.add('Template Method');
  if (ext === '.asm') patterns.add('Template Method');

  // Visitor — 遍历/检查
  if (/documentSnippetService|ocrSnippetService/i.test(base)) patterns.add('Visitor');
  if (/taskMindMap/i.test(base)) patterns.add('Visitor');
  if (/check-.*\.js$|check-.*\.py$|check-.*\.sh$/i.test(base)) patterns.add('Visitor');
  if (/codeScanner/i.test(f)) patterns.add('Visitor');
  if (/skillCuratorService|skillSearch/i.test(base)) patterns.add('Visitor');
  if (/fileIntegrityService/i.test(base)) patterns.add('Visitor');
  if (/transcriptRepair/i.test(base)) patterns.add('Visitor');
  if (/searchIndex|sessionSearchIndex/i.test(base)) patterns.add('Visitor');
  if (/discover\.js$/i.test(base) && /agentsight/.test(dir)) patterns.add('Visitor');
  if (/gitContextService/i.test(base)) patterns.add('Visitor');
  if (/antivirusService/i.test(base)) patterns.add('Visitor');
  if (/eslint\.config/i.test(base)) patterns.add('Visitor');

  // ====== 补漏规则 — 确保每个文件至少有一种模式 ======

  // 通用数据获取服务 → Facade
  if (/Service\.js$|Service\.py$/i.test(base) && patterns.size === 0) patterns.add('Facade');

  // 通用路由 → Command
  if (/routes\//i.test(f) && patterns.size === 0) patterns.add('Command');

  // 通用工具文件 → Command
  if (/tools\//i.test(f) && patterns.size === 0) patterns.add('Command');

  // Python 数据脚本 → Command + Template Method
  if (ext === '.py' && /akshare|data|collect|predict|train|retrain/i.test(base) && patterns.size === 0) {
    patterns.add('Command');
    patterns.add('Template Method');
  }

  // CSS 样式 → Flyweight (共享样式资源)
  if (ext === '.css' && patterns.size === 0) patterns.add('Flyweight');

  // .vue 文件至少有 Composite + Observer
  if (ext === '.vue') {
    patterns.add('Composite');
    patterns.add('Observer');
  }

  // Shell/PowerShell 脚本 → Command + Template Method
  if ((ext === '.sh' || ext === '.ps1') && patterns.size === 0) {
    patterns.add('Command');
    patterns.add('Template Method');
  }

  // 通用 Python → Template Method
  if (ext === '.py' && patterns.size === 0) patterns.add('Template Method');

  // MoonBit → Strategy (算法) 或 Template Method (测试)
  if (ext === '.mbt') {
    if (/test/i.test(base) || /generated_driver/.test(base)) {
      patterns.add('Template Method');
    } else {
      patterns.add('Strategy');
    }
  }

  // ASM → Template Method (已在上面处理)

  // .ts 类型文件 → Flyweight
  if (ext === '.ts' && patterns.size === 0) patterns.add('Flyweight');

  // 最终兜底
  if (patterns.size === 0) {
    // 通用 JS 文件 — 按位置猜测
    if (/utils\//i.test(f)) patterns.add('Strategy');
    else if (/services\//i.test(f)) patterns.add('Facade');
    else if (/cli\//i.test(f)) patterns.add('Command');
    else if (/api\//i.test(f)) patterns.add('Proxy');
    else patterns.add('Strategy'); // 最终兜底
  }

  return [...patterns].sort();
}

for (const f of files) {
  registry[f] = classify(f);
}

// 验证: 每个文件至少一种, 23 种都有覆盖
const allPatterns = new Set();
let uncovered = 0;
for (const [f, ps] of Object.entries(registry)) {
  if (!ps || ps.length === 0) {
    console.error(`UNCOVERED: ${f}`);
    uncovered++;
  }
  ps.forEach(p => allPatterns.add(p));
}

const ALL_23 = [
  'Singleton', 'Factory Method', 'Abstract Factory', 'Builder', 'Prototype',
  'Adapter', 'Bridge', 'Composite', 'Decorator', 'Facade', 'Flyweight', 'Proxy',
  'Chain of Responsibility', 'Command', 'Interpreter', 'Iterator', 'Mediator',
  'Memento', 'Observer', 'State', 'Strategy', 'Template Method', 'Visitor'
];

const missing = ALL_23.filter(p => !allPatterns.has(p));
console.log(`Total files: ${Object.keys(registry).length}`);
console.log(`Covered: ${Object.keys(registry).length - uncovered}`);
console.log(`Uncovered: ${uncovered}`);
console.log(`Patterns used: ${allPatterns.size}/23`);
if (missing.length) console.log(`Missing patterns: ${missing.join(', ')}`);

// 输出统计
const stats = {};
for (const ps of Object.values(registry)) {
  for (const p of ps) {
    stats[p] = (stats[p] || 0) + 1;
  }
}
console.log('\nPattern distribution:');
ALL_23.forEach(p => console.log(`  ${p}: ${stats[p] || 0}`));

// 写入 JSON
const outPath = path.join(__dirname, '..', '..', 'docs', 'design-patterns', 'pattern-registry.json');
fs.writeFileSync(outPath, JSON.stringify(registry, null, 2) + '\n');
console.log(`\nWritten to ${outPath}`);

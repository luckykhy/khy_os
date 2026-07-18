'use strict';

const { EventEmitter } = require('events');

function createChalkMock(options = {}) {
  // 真 chalk v4 支持任意链式组合(`bgGreen.black`、`bgRed.white.bold` …)。
  // 旧实现用固定 methods 白名单 + `fn[m]=fn`,任何不在表里的色(如前景 `black`)
  // 取到 undefined → `chalk.bgGreen.black(...)` 抛 "is not a function"。改用 Proxy:
  // 任意属性访问都返回这个可调用 mock,从而支持任意深度的链式色组合,代码新增
  // 颜色也不再需要回头补这张表(测试 mock 不该成为单人维护的隐形断点)。
  const base = (...args) => args.join(' ');
  const handler = {
    get(_target, prop) {
      if (prop === 'default') return proxy;
      if (prop === 'hex' || prop === 'rgb' || prop === 'bgHex') return () => proxy;
      // Symbol(util.inspect.custom) / then 等内部探测:返回 undefined 让其表现为普通函数。
      if (typeof prop === 'symbol') return undefined;
      return proxy;
    },
  };
  const proxy = new Proxy(base, handler);
  void options; // bgHex 等差异已由 Proxy 统一覆盖,保留入参形参兼容旧调用点
  return proxy;
}

class FakeReadline extends EventEmitter {
  constructor(prompt = '> ', options = {}) {
    super();
    this._prompt = prompt;
    this.line = '';
    this.cursor = 0;
    this.history = [];
    this.output = process.stdout;
    this.paused = false;
    this.prompt = jest.fn();
    this.pause = jest.fn(() => {
      this.paused = true;
    });
    this.resume = jest.fn(() => {
      this.paused = false;
    });
    this.close = jest.fn(() => this.emit('close'));
    this.setPrompt = jest.fn((nextPrompt) => {
      this._prompt = String(nextPrompt || '');
    });
    this._refreshLine = jest.fn();
    this._ttyWrite = jest.fn((s) => {
      const text = typeof s === 'string' ? s : (s ? s.toString() : '');
      if (!text) return;
      this.line += text;
      this.cursor = this.line.length;
    });
    this.write = jest.fn((s, key) => {
      if (key && key.ctrl === true && key.name === 'u') {
        this.line = '';
        this.cursor = 0;
        return;
      }
      const text = typeof s === 'string' ? s : (s ? s.toString() : '');
      if (!text) return;
      this.line += text;
      this.cursor = this.line.length;
    });
    if (options.extraSetup && typeof options.extraSetup === 'function') {
      options.extraSetup(this);
    }
  }
}

async function flushAsync() {
  await Promise.resolve();
  await Promise.resolve();
}

async function emitLineAndWait(rl, lineText) {
  rl.emit('line', lineText);
  for (let i = 0; i < 10; i += 1) {
    await flushAsync();
  }
}

async function flushTimersAndAsync() {
  // 关键:repl 的「本地大脑 / 快速任务」回退是异步链 —— timer 触发 → 回调 await Promise
  // → .then 再排 timer,promise 与 timer 反复交织。同步的 jest.runOnlyPendingTimers()
  // 只清「当前」队列,不在两次 timer 回调之间 await 它们排入的 microtask,于是链推不动;
  // 不同 runner(`npm test` vs `npx jest`)的 microtask 调度时序略有差异,恰好让前者
  // 暴露、后者掩盖 —— 测试 mock/调度不该成为单人维护的隐形断点。
  //
  // jest≥29 的 advanceTimersByTimeAsync 在每次 timer 回调后真正 await 其排入的 promise
  // 作业并反复交织,且推进虚拟时钟(覆盖带延时的 setTimeout),正是此处所需。退化链:
  // advanceTimersByTimeAsync → runOnlyPendingTimersAsync → 同步 runOnlyPendingTimers,
  // 确保在老 jest 上仍逐字节兼容老行为。绝不用 runAllTimers*(repl 的 HUD/spinner 可能
  // 含 setInterval,全清会死循环)。
  if (typeof jest.advanceTimersByTimeAsync === 'function') {
    await jest.advanceTimersByTimeAsync(25);
  } else if (typeof jest.runOnlyPendingTimersAsync === 'function') {
    await jest.runOnlyPendingTimersAsync();
  } else {
    jest.runOnlyPendingTimers();
  }
  await flushAsync();
}

async function waitForCondition(predicate, attempts = 80) {
  // 轮询条件:每轮交织一次 timer+promise(见 flushTimersAndAsync)。attempts 从 30 提到
  // 80(×25ms = 2s 虚拟时间)给较长异步回退链充足的交织余量,避免 runner 调度时序差异
  // 把本应通过的断言压成 flaky 失败。虚拟时间不占真实墙钟,放宽几乎零成本。
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return true;
    await flushTimersAndAsync();
  }
  return predicate();
}

function createRouterMock(options = {}) {
  const parseInput = options.parseInput || ((line) => {
    const text = String(line || '').trim();
    if (!text) return null;
    if (text.startsWith('/')) {
      const parts = text.slice(1).split(/\s+/).filter(Boolean);
      return {
        command: parts[0] || '',
        subCommand: null,
        args: parts.slice(1),
        options: {},
        rawInput: text,
        rawCommandToken: text.split(/\s+/)[0],
      };
    }
    return {
      command: '__ai__',
      subCommand: null,
      args: [],
      options: {},
      rawInput: text,
      rawCommandToken: text,
    };
  });
  const route = options.route || (async (parsed) => (parsed && parsed.command === '__ai__' ? false : true));
  return {
    parseInput: jest.fn(parseInput),
    route: jest.fn(route),
    getCompletions: jest.fn(() => []),
    SLASH_COMMANDS: options.slashCommands || [],
  };
}

function createAiMock(overrides = {}, options = {}) {
  const base = {
    getActiveProvider: jest.fn(() => 'mock-ai'),
    clearHistory: jest.fn(),
    saveConversation: jest.fn(() => ({ sessionId: 'sid-1' })),
    getEffort: jest.fn(() => 'medium'),
    setEffort: jest.fn(() => true),
    getEffortPresets: jest.fn(() => ({
      low: { label: 'low', temperature: 0.2, maxTokens: 512 },
      medium: { label: 'medium', temperature: 0.3, maxTokens: 1024 },
      high: { label: 'high', temperature: 0.4, maxTokens: 2048 },
      max: { label: 'max', temperature: 0.5, maxTokens: 4096 },
    })),
    chat: jest.fn(async () => ({ reply: 'mock reply', provider: 'mock-ai', tokenUsage: null })),
  };
  if (options.includeListConversations) {
    base.listConversations = jest.fn(() => []);
  }
  return Object.assign(base, overrides || {});
}

function createAiRendererMock(options = {}) {
  const mock = {
    renderAiResponse: jest.fn((text) => String(text || '')),
    // repl 在每个 AI 回合开始会调 renderer.resetStepCounter()(真 aiRenderer 从
    // toolDisplay.js spread 出此导出)。mock 早先漏了它 → 调用抛 "is not a function",
    // 被 AI 路径外层 try 静默吞掉 → 回合在到达「快速任务检测 / 本地大脑回退」之前就
    // 中止,于是 detectQuickTask / tryFallback 永不触发,断言 completed 恒 false。
    // 这是与 chalk-mock 同类的「过时 mock = 单人维护隐形断点」,补齐即修复。
    resetStepCounter: jest.fn(),
    printStepLine: jest.fn(),
    printStepDetail: jest.fn(),
    printToolCallResult: jest.fn(),
    printToolCallStart: jest.fn(),
    printTurnCost: jest.fn(),
    printQuotaWarning: jest.fn(),
    printCompactingNotice: jest.fn(),
    printExecutionBrief: jest.fn(() => 0),
    collapseExecutionBrief: jest.fn(),
    printCompletionPanel: jest.fn(),
    printCollapseCounter: jest.fn(),
    printCascadeSteps: jest.fn(),
    renderAgentDone: jest.fn(),
    renderAgentHeader: jest.fn(),
    renderAgentProgress: jest.fn(),
    askInlineQuestion: jest.fn(async () => null),
    pushExpandableOutput: jest.fn(),
    getLastExpandableOutput: jest.fn(() => null),
    setInteractiveGuard: jest.fn(),
    DynamicSpinner: class {
      start() {}
      stop() {}
      setPromptMode() {}
      setEffort() {}
      setPhase() {}
      setTokens() {}
      resetTimer() {}
    },
    InitPhaseTracker: class {
      addLine() {}
      collapse() {}
      get lineCount() { return 0; }
      get isCollapsed() { return false; }
    },
    ProcessTracker: class {
      constructor() {
        this.isActive = false;
      }
      start() {
        this.isActive = true;
      }
      complete() {
        this.isActive = false;
      }
    },
    TaskPlanTracker: class {
      addTask() {}
      render() {}
      start() {}
      complete() {}
      fail() {}
      extractFromResponse() { return false; }
    },
  };
  if (options.fullMode) {
    mock.DOT_PENDING = '.';
    mock.DOT_INDICATOR = '.';
    mock.DOT_SUCCESS = '.';
    mock.DOT_ERROR = '.';
    mock.printSessionRecap = jest.fn();
    mock.getToolDisplayName = jest.fn(() => 'Tool');
    mock.renderStructuredDiff = jest.fn(() => '');
    mock.renderDiff = jest.fn(() => '');
  }
  if (options.liteMode) {
    mock.printActionHint = jest.fn();
    mock.ToolUseTracker = class {
      printHeader() {}
      toolStart() {}
      toolEnd() {}
      finish() {}
    };
  }
  return mock;
}

async function setupCliHarness(config = {}) {
  jest.resetModules();

  const mode = config.mode === 'lite' ? 'lite' : 'full';
  const modulePath = mode === 'lite' ? '../../src/cli/liteRepl' : '../../src/cli/repl';
  const startMethod = mode === 'lite' ? 'startLiteRepl' : 'startRepl';

  const formatterMock = mode === 'lite'
    ? {
        printLiteBanner: jest.fn(),
        printError: jest.fn(),
        printInfo: jest.fn(),
        printSuccess: jest.fn(),
        ICON_PROMPT: '>',
        ICON_BOT: '*',
        MASCOT_MINI: '*',
        getRandomFarewell: () => 'bye',
        getClassicMonsterPetLines: () => ['pet'],
      }
    : {
        printBanner: jest.fn(),
        printError: jest.fn(),
        printErrorPanel: jest.fn(),
        printSuccess: jest.fn(),
        printInfo: jest.fn(),
        printWarn: jest.fn(),
        printHelp: jest.fn(),
        printHelpTopic: jest.fn(),
        printTable: jest.fn(),
        printQuote: jest.fn(),
        withSpinner: jest.fn(async (_text, fn) => fn()),
        displayWidth: (s) => String(s || '').length,
        padToWidth: (s, w) => String(s || '').padEnd(w),
        stripAnsi: (s) => String(s || ''),
        ICON_PROMPT: '>',
        ICON_AI: '*',
        ICON_BOT: '*',
        MASCOT_MINI: '*',
        getRandomFarewell: () => 'bye',
        getClassicMonsterPetLines: () => ['pet'],
      };

  const routerMock = createRouterMock(config.router || {});
  const aiMock = createAiMock(config.ai || {}, { includeListConversations: mode === 'full' });
  const aiRendererMock = createAiRendererMock({ fullMode: mode === 'full', liteMode: mode === 'lite' });

  const hudMock = mode === 'lite'
    ? {
        refreshGit: jest.fn(),
        updateAccountEmail: jest.fn(),
        toolEnd: jest.fn(),
        updateTokens: jest.fn(),
        getState: jest.fn(() => ({
          sessionStart: Date.now(),
          sessionTokens: { input: 0, output: 0, total: 0 },
          requestCount: 0,
          toolHistory: [],
          contextWindow: { used: 0, limit: 200000 },
          git: { branch: '', dirty: false, dirtyCount: 0 },
        })),
      }
    : {
        startLiveStatusBar: jest.fn(),
        stopLiveStatusBar: jest.fn(),
        getState: jest.fn(() => ({
          sessionStart: Date.now(),
          sessionTokens: { input: 0, output: 0 },
          requestCount: 0,
          toolHistory: [],
          contextWindow: { used: 0, limit: 1 },
          git: { branch: '', dirty: false, dirtyCount: 0 },
        })),
        refreshGit: jest.fn(),
      };

  const readlineState = { rl: null };
  jest.doMock('readline', () => ({
    createInterface: jest.fn((options = {}) => {
      const rl = new FakeReadline(options.prompt || '> ', config.readline || {});
      readlineState.rl = rl;
      return rl;
    }),
    cursorTo: jest.fn(),
    clearLine: jest.fn(),
    clearScreenDown: jest.fn(),
    moveCursor: jest.fn(),
  }));
  jest.doMock('chalk', () => createChalkMock({ bgHex: mode === 'lite' }));
  jest.doMock('inquirer', () => ({ prompt: jest.fn(async () => ({ selected: null })) }));
  jest.doMock('../../src/cli/formatters', () => formatterMock);
  jest.doMock('../../src/cli/router', () => routerMock);
  jest.doMock('../../src/cli/ai', () => aiMock);
  jest.doMock('../../src/cli/aiRenderer', () => aiRendererMock);
  jest.doMock('../../src/cli/hudRenderer', () => hudMock);
  jest.doMock('../../src/cli/ui/diffViewer', () => ({ renderSideBySideDiff: jest.fn() }));
  jest.doMock('../../src/tools/platformUtils', () => ({
    safeChmod: jest.fn(),
    isLegacyWinTerminal: jest.fn(() => false),
  }));
  jest.doMock('../../src/bootstrap/prefetch', () => ({ deferredPrefetch: jest.fn(() => []) }));
  jest.doMock('os', () => {
    const actual = jest.requireActual('os');
    return { ...actual, homedir: () => '/tmp' };
  });

  if (mode === 'full') {
    jest.doMock('../../src/cli/menu', () => ({ runMenuLoop: jest.fn(async () => null) }));
    jest.doMock('../../src/services/userProfile', () => ({
      trackSessionStart: jest.fn(),
      trackCommand: jest.fn(),
    }));
    jest.doMock('../../src/services/taskControlService', () => (config.taskControlService || {
      controlTask: jest.fn(),
      listTasks: jest.fn(() => []),
      getTaskDetail: jest.fn(),
    }));
    jest.doMock('../../src/cli/errorSummary', () => ({
      compactAiErrorReply: jest.fn((text) => ({ merged: false, text })),
      compactGatewayStatusText: jest.fn((text) => text),
    }));
    jest.doMock('../../src/services/resourceGuard', () => ({ cancelAll: jest.fn() }));
    jest.doMock('../../src/services/tokenUsageService', () => ({ getSessionCost: jest.fn(() => ({ costUSD: 0 })) }));
  } else {
    jest.doMock('../../src/services/toolCalling', () => ({
      setReadlineProvider: jest.fn(),
    }));
    jest.doMock('../../src/services/tokenUsageService', () => ({
      estimateCost: jest.fn(() => 0),
      getRemainingQuota: jest.fn(() => ({})),
    }));
  }

  if (typeof config.installMocks === 'function') {
    config.installMocks();
  }

  const replModule = require(modulePath);
  const startOptions = mode === 'lite'
    ? (config.startOptions || {})
    : Object.assign({
        claudeUi: false,
        enablePluginAutoload: false,
        showGettingStarted: false,
        startupModelPicker: false,
      }, config.startOptions || {});
  await replModule[startMethod](startOptions);

  return {
    rl: readlineState.rl,
    formatterMock,
    routerMock,
    aiMock,
    aiRendererMock,
    hudMock,
  };
}

module.exports = {
  FakeReadline,
  flushAsync,
  emitLineAndWait,
  flushTimersAndAsync,
  waitForCondition,
  setupCliHarness,
};

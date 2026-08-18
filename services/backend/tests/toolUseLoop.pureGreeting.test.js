'use strict';

/**
 * toolUseLoop.pureGreeting.test.js — 「简单的招呼，没有回应招呼反而复杂化」回归。
 *
 * 现场:首轮输入「你好」,模型没有回一句招呼,而是先输出「I'll start by understanding
 * the current state of the repository…」,然后真的派发了两个 Bash 去 git log / 看仓库,
 * 用户等了 27 秒。
 *
 * 根因不在文案:那段英文是模型自己写的。真正的问题是那一轮**仍然带着工具**——轻量裁剪
 * 只是省 token 的优化,核心集里照样留着 Bash/Read/Glob/Grep/WebSearch/toolSearch,而
 * Ink TUI / 经典 REPL / headless native loop 共用的这条结构化循环没有任何问候执行边界。
 *
 * 锁定的契约:首轮纯问候 → 一次 chat、零工具派发;带任务的问候、后续轮、子代理不受影响。
 * 用真实的 runToolUseLoop 驱动,monkeypatch toolCalling.executeTool;不碰网络和子进程。
 */

const { describe, test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// Set tool-gating env BEFORE requiring the modules — some gates read these at
// load time. This suite tests the greeting boundary, not the capability gate.
process.env.KHY_TASK_CAPABILITY_GATE = 'false';
process.env.KHY_EXEC_APPROVAL = 'off';

const toolCalling = require('../src/services/toolCalling');
const toolUseLoop = require('../src/services/toolUseLoop');

/** 循环会把工具名归一(Bash → shell_command),断言按归一后的名字匹配。 */
const ranShell = (executed) => executed.some((c) => /bash|shell/i.test(c.name));

/** A chat that always answers with a structured Bash tool_use — the screenshot's model. */
function makeBashHappyChat(seenOpts) {
  let calls = 0;
  return async (_msg, chatOpts = {}) => {
    calls += 1;
    seenOpts.push(chatOpts);
    if (calls === 1) {
      return {
        reply: "I'll start by understanding the current state of the repository.",
        toolUseBlocks: [
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'git log --oneline -10' } },
        ],
        stopReason: 'tool_use',
        provider: 'mock',
        model: 'mock-model',
      };
    }
    return { reply: '仓库调查完毕。', stopReason: 'stop', provider: 'mock' };
  };
}

describe('toolUseLoop — 首轮纯问候不进工具回路', () => {
  let _origExecute;
  let _savedGate;
  let _savedApproval;
  let _savedGreetingGate;

  before(() => {
    _savedGate = process.env.KHY_TASK_CAPABILITY_GATE;
    _savedApproval = process.env.KHY_EXEC_APPROVAL;
    _savedGreetingGate = process.env.KHY_GREETING_NO_TOOLS;
    process.env.KHY_TASK_CAPABILITY_GATE = 'false';
    process.env.KHY_EXEC_APPROVAL = 'off';
    delete process.env.KHY_GREETING_NO_TOOLS; // 默认开
  });

  after(() => {
    if (_savedGate === undefined) delete process.env.KHY_TASK_CAPABILITY_GATE;
    else process.env.KHY_TASK_CAPABILITY_GATE = _savedGate;
    if (_savedApproval === undefined) delete process.env.KHY_EXEC_APPROVAL;
    else process.env.KHY_EXEC_APPROVAL = _savedApproval;
    if (_savedGreetingGate === undefined) delete process.env.KHY_GREETING_NO_TOOLS;
    else process.env.KHY_GREETING_NO_TOOLS = _savedGreetingGate;
  });

  // 门控状态由每个测试在自己体内显式设定(beforeEach 先归位到「默认开」),afterEach 不再
  // 去删它:测试体里的 await 会让出控制权,afterEach 的 delete 曾把 kill-switch 用例刚设好的
  // KHY_GREETING_NO_TOOLS=false 抹掉,导致它走回默认开启的短路而假失败。
  beforeEach(() => {
    _origExecute = toolCalling.executeTool;
    delete process.env.KHY_GREETING_NO_TOOLS;
  });
  afterEach(() => {
    toolCalling.executeTool = _origExecute;
  });

  test('「你好」+ 模型吐 Bash tool_use → 一个工具都不执行,只回自然语言', async () => {
    const executed = [];
    toolCalling.executeTool = async (name, params) => {
      executed.push({ name, params });
      return { success: true, output: 'should never run' };
    };

    const seenOpts = [];
    const chat = async (_msg, chatOpts = {}) => {
      seenOpts.push(chatOpts);
      return {
        reply: '你好！有什么可以帮你的吗？',
        toolUseBlocks: [
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'git log --oneline -10' } },
        ],
        stopReason: 'tool_use',
        provider: 'mock',
        model: 'mock-model',
      };
    };

    const result = await toolUseLoop.runToolUseLoop('你好', { chat, maxIterations: 5 });

    assert.deepEqual(executed, [], '首轮纯问候绝不派发工具(截图里跑起来的正是 Bash)');
    assert.equal(seenOpts.length, 1, '只问模型一次,没有工具结果回灌的后续轮');
    assert.equal(seenOpts[0]._forceNoTools, true, '这一轮以「不提供工具」的方式发出');
    assert.equal(seenOpts[0]._pureFirstTurnGreeting, true, '同一个请求级标记透传给消息构建');
    assert.match(result.finalResponse, /你好/, '用户拿到的是一句招呼');
    assert.deepEqual(result.toolCallLog, [], '工具调用日志为空');
    assert.equal(result.iterations, 1, '一轮结束,不是多轮调查');
  });

  test('带任务的问候仍然执行工具', async () => {
    const executed = [];
    toolCalling.executeTool = async (name, params) => {
      executed.push({ name, params });
      return { success: true, output: 'commit abc123' };
    };

    const seenOpts = [];
    const chat = makeBashHappyChat(seenOpts);

    const result = await toolUseLoop.runToolUseLoop('你好，帮我看看最近 10 条提交记录', {
      chat,
      maxIterations: 5,
    });

    assert.ok(
      ranShell(executed),
      '「你好」后面跟着真实任务时,工具照常可用',
    );
    assert.ok(result.finalResponse.length > 0);
  });

  test('后续轮的「你好」不受边界影响(有历史 → 正常回路)', async () => {
    const executed = [];
    toolCalling.executeTool = async (name, params) => {
      executed.push({ name, params });
      return { success: true, output: 'ok' };
    };

    const seenOpts = [];
    const chat = makeBashHappyChat(seenOpts);

    await toolUseLoop.runToolUseLoop('你好', {
      chat,
      maxIterations: 5,
      initialMessages: [
        { role: 'user', content: '帮我改一下鉴权模块' },
        { role: 'assistant', content: '已改完。' },
      ],
    });

    assert.ok(
      ranShell(executed),
      '不是首轮就不是纯问候场景,工具派发保持今日行为',
    );
  });

  test('KHY_GREETING_NO_TOOLS=false → 逐字节回退到今日行为', async () => {
    process.env.KHY_GREETING_NO_TOOLS = 'false';

    const executed = [];
    toolCalling.executeTool = async (name, params) => {
      executed.push({ name, params });
      return { success: true, output: 'ok' };
    };

    const seenOpts = [];
    const chat = makeBashHappyChat(seenOpts);

    await toolUseLoop.runToolUseLoop('你好', { chat, maxIterations: 5 });

    assert.ok(
      ranShell(executed),
      '开关关掉后回到原路径(工具照常派发),便于出问题时一键回退',
    );
  });
});

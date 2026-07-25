'use strict';

/**
 * localToolLoop.test.js (node:test)
 *
 * Goal "本地模式也要有自己的工具循环": a dedicated tool loop for weak local
 * models. Hermetic — `generate` and `executeTool` are injected, so no model
 * and no real tools run. Verifies the iteration driver, text tool-call parsing,
 * de-dup / loop guard, allowlist enforcement, and termination conditions.
 */
const test = require('node:test');
const assert = require('node:assert');

const loop = require('../../src/services/localToolLoop');

const TOOL_DEFS = [
  { name: 'Read', description: 'read a file', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } },
  { name: 'Grep', description: 'search', parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } },
  { name: 'deploy', description: 'DANGEROUS', parameters: { type: 'object', properties: {}, required: [] } },
];

function scriptedGenerate(replies) {
  let i = 0;
  const calls = [];
  const fn = async (_prompt, options) => {
    calls.push(options);
    const content = i < replies.length ? replies[i] : '';
    i += 1;
    return { success: true, content };
  };
  fn.calls = calls;
  return fn;
}

test('runs a tool then produces a final answer', async () => {
  const exec = [];
  const generate = scriptedGenerate([
    '我需要读取文件。<tool_call>{"name": "Read", "params": {"file_path": "a.txt"}}</tool_call>',
    '文件内容是 hello，回答完成。',
  ]);
  const res = await loop.runLocalToolLoop('读 a.txt', {
    generate,
    toolDefinitions: TOOL_DEFS,
    executeTool: async (name, params) => { exec.push({ name, params }); return { success: true, output: 'hello' }; },
  });
  assert.strictEqual(res.stopReason, 'final_answer');
  assert.strictEqual(res.iterations, 2);
  // toolCallParser canonicalizes Read→readFile, file_path→path before execTool.
  assert.strictEqual(exec.length, 1);
  assert.strictEqual(exec[0].name, 'readFile');
  assert.strictEqual(exec[0].params.path, 'a.txt');
  assert.match(res.finalText, /hello|完成/);
  assert.strictEqual(res.toolCalls.length, 1);
  assert.strictEqual(res.toolCalls[0].success, true);
});

test('answers directly when no tool call is emitted', async () => {
  const generate = scriptedGenerate(['1 + 1 = 2']);
  const res = await loop.runLocalToolLoop('1+1?', { generate, toolDefinitions: TOOL_DEFS, executeTool: async () => ({ success: true }) });
  assert.strictEqual(res.stopReason, 'final_answer');
  assert.strictEqual(res.iterations, 1);
  assert.strictEqual(res.toolCalls.length, 0);
  assert.strictEqual(res.finalText, '1 + 1 = 2');
});

test('forwards system prompt and growing history to generate', async () => {
  // The loop mutates one messages array in place, so snapshot at call time.
  const snaps = [];
  const replies = [
    '<tool_call>{"name": "Read", "params": {"file_path": "a.txt"}}</tool_call>',
    'done',
  ];
  let i = 0;
  const generate = async (_p, options) => {
    snaps.push({ system: options.system, count: options.messages.length, last: options.messages.at(-1).content });
    const content = replies[i] ?? '';
    i += 1;
    return { success: true, content };
  };
  await loop.runLocalToolLoop('go', { generate, toolDefinitions: TOOL_DEFS, executeTool: async () => ({ success: true, output: 'X' }) });
  // First call: system + [user]. Second call: system + [user, assistant, tool-result user].
  assert.match(snaps[0].system, /可用工具/);
  assert.strictEqual(snaps[0].count, 1);
  assert.ok(snaps[1].count >= 3);
  assert.match(snaps[1].last, /工具结果/);
});

test('refuses tools outside the allowlist (treats as final answer)', async () => {
  // deploy is in TOOL_DEFS but not in DEFAULT_LOCAL_TOOLS allowlist.
  const exec = [];
  const generate = scriptedGenerate(['<tool_call>{"name": "deploy", "params": {}}</tool_call>']);
  const res = await loop.runLocalToolLoop('deploy prod', {
    generate, toolDefinitions: TOOL_DEFS,
    executeTool: async (n) => { exec.push(n); return { success: true }; },
  });
  assert.strictEqual(exec.length, 0, 'dangerous tool never executed');
  assert.strictEqual(res.stopReason, 'final_answer');
});

test('de-dup guard: repeated identical call does not re-execute or loop forever', async () => {
  let execCount = 0;
  // Model keeps emitting the same call every turn.
  const generate = async (_p, _o) => ({ success: true, content: '<tool_call>{"name": "Read", "params": {"file_path": "a.txt"}}</tool_call>' });
  const res = await loop.runLocalToolLoop('x', {
    generate, toolDefinitions: TOOL_DEFS,
    executeTool: async () => { execCount += 1; return { success: true, output: 'same' }; },
  });
  assert.strictEqual(execCount, 1, 'identical call executed only once');
  assert.strictEqual(res.stopReason, 'no_progress');
});

test('respects max iterations cap', async () => {
  // Each turn emits a NEW distinct tool call so the loop never naturally ends.
  let i = 0;
  const generate = async () => ({ success: true, content: `<tool_call>{"name": "Grep", "params": {"pattern": "p${i++}"}}</tool_call>` });
  const res = await loop.runLocalToolLoop('x', {
    generate, toolDefinitions: TOOL_DEFS, maxIterations: 3,
    executeTool: async () => ({ success: true, output: 'r' }),
  });
  assert.strictEqual(res.stopReason, 'max_iterations');
  assert.strictEqual(res.iterations, 3);
});

test('generate error terminates gracefully', async () => {
  const generate = async () => { throw new Error('model down'); };
  const res = await loop.runLocalToolLoop('x', { generate, toolDefinitions: TOOL_DEFS, executeTool: async () => ({}) });
  assert.match(res.stopReason, /generate_error/);
});

test('selectLocalTools intersects allowlist with registry', () => {
  const picked = loop.selectLocalTools(TOOL_DEFS, ['Read', 'Grep', 'nonexistent']);
  assert.deepStrictEqual(picked.map(d => d.name), ['Read', 'Grep']);
});

test('extractToolCalls handles tag and bare-json forms (canonicalized)', () => {
  // toolCallParser canonicalizes Read→readFile, file_path→path, Grep→grep.
  const tagged = loop.extractToolCalls('<tool_call>{"name":"Read","params":{"file_path":"a"}}</tool_call>');
  assert.strictEqual(tagged.length, 1);
  assert.strictEqual(tagged[0].name, 'readFile');
  assert.strictEqual(tagged[0].params.path, 'a');
  const bare = loop.extractToolCalls('here: {"name":"Grep","params":{"pattern":"x"}}');
  assert.strictEqual(bare[0].name, 'grep');
  assert.strictEqual(bare[0].params.pattern, 'x');
  assert.deepStrictEqual(loop.extractToolCalls('just text'), []);
});

test('formatToolResult truncates and labels failures/denials', () => {
  assert.match(loop.formatToolResult('Read', { success: true, output: 'abc' }), /工具结果 \[Read\][\s\S]*abc/);
  assert.match(loop.formatToolResult('deploy', { denied: true, error: 'no' }), /已被拒绝/);
  assert.match(loop.formatToolResult('Read', { success: false, error: 'boom' }), /失败：boom/);
  const long = loop.formatToolResult('Read', { success: true, output: 'x'.repeat(5000) }, 100);
  assert.ok(long.length < 200 && long.endsWith('…'));
});

// ── No-model deterministic mode ("无模型也要能用") ─────────────────────────────

const CURATED_DEFS = [
  { name: 'Read', description: 'read a file', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } },
  { name: 'Grep', description: 'search', parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } },
  { name: 'Glob', description: 'glob', parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } },
  { name: 'LS', description: 'list dir', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: [] } },
  { name: 'gitStatus', description: 'git status', parameters: { type: 'object', properties: {}, required: [] } },
  { name: 'gitDiff', description: 'git diff', parameters: { type: 'object', properties: {}, required: [] } },
  { name: 'WebSearch', description: 'web search', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'WebFetch', description: 'fetch url', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'list_models', description: 'models', parameters: { type: 'object', properties: {}, required: [] } },
];

test('planLocalToolCalls maps common intents to curated tools (no model)', () => {
  const plan = (t) => loop.planLocalToolCalls(t);
  assert.strictEqual(plan('看看 git status')[0].name, 'gitStatus');
  assert.strictEqual(plan('当前有哪些改动')[0].name, 'gitStatus');
  assert.strictEqual(plan('git diff 看一下')[0].name, 'gitDiff');
  assert.strictEqual(plan('有哪些可用模型')[0].name, 'list_models');
  const read = plan('查看 src/index.js');
  assert.strictEqual(read[0].name, 'Read');
  assert.strictEqual(read[0].params.file_path, 'src/index.js');
  const glob = plan('列出所有 *.ts 文件');
  assert.strictEqual(glob[0].name, 'Glob');
  assert.match(glob[0].params.pattern, /\*\.ts/);
  const grep = plan('在代码里搜索 runLocalToolLoop');
  assert.strictEqual(grep[0].name, 'Grep');
  assert.strictEqual(grep[0].params.pattern, 'runLocalToolLoop');
  const fetch = plan('打开 https://example.com/page');
  assert.strictEqual(fetch[0].name, 'WebFetch');
  assert.strictEqual(fetch[0].params.url, 'https://example.com/page');
  assert.strictEqual(plan('上网搜索一下 nodejs 版本')[0].name, 'WebSearch');
  // No clear intent → empty (caller degrades gracefully).
  assert.deepStrictEqual(plan('你好啊'), []);
  assert.deepStrictEqual(plan(''), []);
});

test('planLocalToolCalls handles glued (no-space) search terms — CJK user input', () => {
  const plan = (t) => loop.planLocalToolCalls(t);
  // Term glued directly to the verb (no space) — common from CJK users / weak models.
  const g1 = plan('在代码里搜索runLocalToolLoop');
  assert.strictEqual(g1[0].name, 'Grep');
  assert.strictEqual(g1[0].params.pattern, 'runLocalToolLoop');
  const g2 = plan('代码里查找handleClick');
  assert.strictEqual(g2[0].name, 'Grep');
  assert.strictEqual(g2[0].params.pattern, 'handleClick');
  // Glued quoted term keeps internal spaces.
  const g3 = plan('在代码里搜索"foo bar"');
  assert.strictEqual(g3[0].name, 'Grep');
  assert.strictEqual(g3[0].params.pattern, 'foo bar');
  // Must NOT capture a glued CJK stopword as a search term (搜索一下 → 一下).
  // "上网搜索一下 X" still resolves to WebSearch, never a bogus Grep on "一下".
  const w = plan('上网搜索一下 nodejs');
  assert.strictEqual(w[0].name, 'WebSearch');
});

test('planLocalToolCalls suppresses network tools when offline (networkUp:false)', () => {
  // A pasted URL would normally plan WebFetch; offline it must NOT — firing it
  // just burns a connect timeout before failing. Returns empty → caller degrades.
  assert.deepStrictEqual(
    loop.planLocalToolCalls('打开 https://example.com/page', { networkUp: false }),
    [],
  );
  // Explicit online lookup → WebSearch normally, suppressed offline.
  assert.deepStrictEqual(
    loop.planLocalToolCalls('上网搜索一下 nodejs 版本', { networkUp: false }),
    [],
  );
  // Local tools are unaffected by offline state.
  assert.strictEqual(loop.planLocalToolCalls('看看 git status', { networkUp: false })[0].name, 'gitStatus');
  // Default (networkUp omitted) stays permissive — network tools still plan.
  assert.strictEqual(loop.planLocalToolCalls('打开 https://example.com/page')[0].name, 'WebFetch');
});

test('runLocalToolLoop no-model + offline never executes a network tool', async () => {
  const exec = [];
  const res = await loop.runLocalToolLoop('打开 https://example.com/x', {
    networkUp: false,
    toolDefinitions: CURATED_DEFS,
    executeTool: async (name) => { exec.push(name); return { success: true, output: 'should not happen' }; },
  });
  assert.strictEqual(res.mode, 'deterministic');
  assert.strictEqual(exec.length, 0, 'no network tool fired while offline');
  assert.strictEqual(String(res.finalText || '').trim(), '', 'degrades to empty so caller falls through');
});

test('planLocalToolCalls respects the allowlist set', () => {
  const onlyGit = new Set(['gitStatus']);
  assert.strictEqual(loop.planLocalToolCalls('git status', { allowedSet: onlyGit })[0].name, 'gitStatus');
  // Read not allowed → no call emitted.
  assert.deepStrictEqual(loop.planLocalToolCalls('查看 a.js', { allowedSet: onlyGit }), []);
});

test('runs deterministically with NO model: plans, executes, synthesizes', async () => {
  const exec = [];
  const res = await loop.runLocalToolLoop('看看 git status', {
    // no generate → deterministic mode
    toolDefinitions: CURATED_DEFS,
    executeTool: async (name, params) => { exec.push({ name, params }); return { success: true, output: ' M src/a.js' }; },
  });
  assert.strictEqual(res.mode, 'deterministic');
  assert.strictEqual(res.stopReason, 'final_answer');
  assert.strictEqual(exec.length, 1);
  assert.strictEqual(exec[0].name, 'gitStatus');
  assert.match(res.finalText, /无模型/);
  assert.match(res.finalText, /M src\/a\.js/);
  assert.strictEqual(res.toolCalls.length, 1);
});

test('no-model with no tool intent returns empty (caller falls through)', async () => {
  let execCount = 0;
  const res = await loop.runLocalToolLoop('随便聊聊', {
    toolDefinitions: CURATED_DEFS,
    executeTool: async () => { execCount += 1; return { success: true }; },
  });
  assert.strictEqual(res.mode, 'deterministic');
  assert.strictEqual(execCount, 0, 'nothing executed when no intent matches');
  assert.strictEqual(String(res.finalText || '').trim(), '');
  assert.strictEqual(res.toolCalls.length, 0);
});

test('deterministic synthesis turn never re-fires a tool (bounded)', async () => {
  // Tool output coincidentally contains tool_call-looking text; must not loop.
  let execCount = 0;
  const res = await loop.runLocalToolLoop('git status', {
    toolDefinitions: CURATED_DEFS,
    executeTool: async () => { execCount += 1; return { success: true, output: '<tool_call>{"name":"gitStatus"}</tool_call> dirty' }; },
  });
  assert.strictEqual(execCount, 1, 'executed exactly once, no re-fire on synthesis');
  assert.strictEqual(res.stopReason, 'final_answer');
});

test('explicitly passing generate keeps model mode', async () => {
  const generate = scriptedGenerate(['just an answer']);
  const res = await loop.runLocalToolLoop('hi', { generate, toolDefinitions: CURATED_DEFS, executeTool: async () => ({}) });
  assert.strictEqual(res.mode, 'model');
  assert.strictEqual(res.finalText, 'just an answer');
});

// ── No raw protocol leakage on exhausted loops (优化本地模式) ──────────────────

test('stripToolCallSyntax removes tool_call protocol noise', () => {
  assert.strictEqual(loop.stripToolCallSyntax('<tool_call>{"name":"Read"}</tool_call>'), '');
  assert.strictEqual(
    loop.stripToolCallSyntax('答案：\n<tool_call>{"name":"Grep","params":{"pattern":"x"}}</tool_call>\n好的'),
    '答案：\n\n好的',
  );
  // Stray unmatched tags are also stripped.
  assert.strictEqual(loop.stripToolCallSyntax('hi </tool_call>'), 'hi');
  assert.strictEqual(loop.stripToolCallSyntax(''), '');
  assert.strictEqual(loop.stripToolCallSyntax(null), '');
});

test('max_iterations (model mode) never leaks raw tool_call text; synthesizes from results', async () => {
  // Weak model keeps emitting NEW distinct calls and never gives a clean answer.
  let i = 0;
  const generate = async () => ({ success: true, content: `<tool_call>{"name": "Grep", "params": {"pattern": "p${i++}"}}</tool_call>` });
  const res = await loop.runLocalToolLoop('搜代码', {
    generate, toolDefinitions: CURATED_DEFS, maxIterations: 2,
    executeTool: async () => ({ success: true, output: 'match in a.js' }),
  });
  assert.strictEqual(res.stopReason, 'max_iterations');
  // Raw protocol syntax must NOT survive into what the user sees.
  assert.ok(!/<tool_call>/i.test(res.finalText), 'no <tool_call> tag in finalText');
  // Tool results were gathered → answer is synthesized from them.
  assert.match(res.finalText, /match in a\.js/);
});

test('no_progress (model mode) strips protocol syntax from leaked last turn', async () => {
  // Model repeats the SAME call → no_progress, last text is a raw tool_call.
  const generate = async () => ({ success: true, content: '<tool_call>{"name": "Grep", "params": {"pattern": "x"}}</tool_call>' });
  const res = await loop.runLocalToolLoop('找 x', {
    generate, toolDefinitions: CURATED_DEFS,
    executeTool: async () => ({ success: true, output: 'found x here' }),
  });
  assert.strictEqual(res.stopReason, 'no_progress');
  assert.ok(!/<tool_call>/i.test(res.finalText), 'no protocol syntax leaked');
  assert.match(res.finalText, /found x here/);
});

test('generate_error with gathered results still returns a clean synthesis', async () => {
  let n = 0;
  const generate = async () => {
    n += 1;
    if (n === 1) return { success: true, content: '<tool_call>{"name": "Grep", "params": {"pattern": "y"}}</tool_call>' };
    throw new Error('model down mid-loop');
  };
  const res = await loop.runLocalToolLoop('找 y', {
    generate, toolDefinitions: CURATED_DEFS,
    executeTool: async () => ({ success: true, output: 'y matched' }),
  });
  assert.match(res.stopReason, /generate_error/);
  assert.ok(!/<tool_call>/i.test(res.finalText));
  assert.match(res.finalText, /y matched/);
});

test('no-model: when the only tool fails, finalText is empty (caller degrades, not a fake answer)', async () => {
  // Planner fires Read; the tool fails. The deterministic synthesis must NOT
  // dress the failure up as an answer — it returns empty so repl falls through
  // to web search / capability menu.
  const res = await loop.runLocalToolLoop('查看 src/missing.js', {
    toolDefinitions: CURATED_DEFS,
    executeTool: async () => ({ success: false, error: '文件不存在' }),
  });
  assert.strictEqual(res.mode, 'deterministic');
  assert.strictEqual(res.toolCalls.length, 1, 'tool was attempted');
  assert.strictEqual(res.toolCalls[0].success, false);
  assert.strictEqual(String(res.finalText || '').trim(), '', 'failure not presented as an answer');
});

test('no-model: a denied tool also yields empty finalText (graceful degrade)', async () => {
  const res = await loop.runLocalToolLoop('查看 src/secret.env', {
    toolDefinitions: CURATED_DEFS,
    executeTool: async () => ({ denied: true, error: '权限不足' }),
  });
  assert.strictEqual(res.mode, 'deterministic');
  assert.strictEqual(String(res.finalText || '').trim(), '');
});

test('no-model: a successful result is still presented even if mixed with noise', async () => {
  const res = await loop.runLocalToolLoop('看看 git status', {
    toolDefinitions: CURATED_DEFS,
    executeTool: async () => ({ success: true, output: ' M src/a.js' }),
  });
  assert.match(res.finalText, /M src\/a\.js/, 'real output survives the honesty gate');
});

// ── Opt-in write/shell delivery tier (本地小模型写能力) ──────────────────────
//
// The controlled write tier lets a local model actually BUILD: it is OFF by
// default, gated to MODEL mode, and only auto-enables when an interactive
// approval channel is wired (so every write is human-gated). env overrides force
// it on/off. The no-model deterministic planner is NEVER write-capable.

const WRITE_DEFS = CURATED_DEFS.concat([
  { name: 'Write', description: 'write a file', parameters: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'] } },
  { name: 'Bash', description: 'run shell', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
]);

function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) { prev[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  return Promise.resolve().then(fn).finally(() => {
    for (const k of Object.keys(vars)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
  });
}

test('_resolveWriteMode: env on/off forces; unset follows approval channel', () => {
  return withEnv({ KHY_LOCAL_WRITE: undefined }, () => {
    assert.strictEqual(loop._resolveWriteMode({ hasApprovalChannel: false }), false, 'auto + no channel = read-only (fail-closed)');
    assert.strictEqual(loop._resolveWriteMode({ hasApprovalChannel: true }), true, 'auto + channel = write enabled');
    return withEnv({ KHY_LOCAL_WRITE: 'off' }, () => {
      assert.strictEqual(loop._resolveWriteMode({ hasApprovalChannel: true }), false, 'off overrides channel');
      return withEnv({ KHY_LOCAL_WRITE: 'on' }, () => {
        assert.strictEqual(loop._resolveWriteMode({ hasApprovalChannel: false }), true, 'on overrides missing channel');
      });
    });
  });
});

test('write tier OFF by default (no approval channel): a Write call is refused, never executed', async () => {
  return withEnv({ KHY_LOCAL_WRITE: undefined }, async () => {
    const exec = [];
    const generate = scriptedGenerate(['<tool_call>{"name": "Write", "params": {"file_path": "out.txt", "content": "hi"}}</tool_call>']);
    const res = await loop.runLocalToolLoop('建个文件', {
      generate, toolDefinitions: WRITE_DEFS,
      // no traceContext.onControlRequest → no approval channel → fail-closed
      executeTool: async (n, p) => { exec.push(n); return { success: true }; },
    });
    assert.strictEqual(exec.length, 0, 'Write never executed when write tier is off');
    assert.strictEqual(res.stopReason, 'final_answer', 'out-of-allowlist call becomes the final answer');
  });
});

test('write tier AUTO-ON with approval channel: a Write call is executed (canonicalized)', async () => {
  return withEnv({ KHY_LOCAL_WRITE: undefined }, async () => {
    const exec = [];
    const generate = scriptedGenerate([
      '<tool_call>{"name": "Write", "params": {"file_path": "out.txt", "content": "hello"}}</tool_call>',
      '已创建 out.txt。',
    ]);
    const res = await loop.runLocalToolLoop('把 hello 写到 out.txt', {
      generate, toolDefinitions: WRITE_DEFS,
      traceContext: { sessionId: 't', onControlRequest: async () => ({ subtype: 'success', response: { behavior: 'allow' } }) },
      executeTool: async (n, p) => { exec.push({ n, p }); return { success: true, output: 'written' }; },
    });
    assert.strictEqual(exec.length, 1, 'Write executed when approval channel present');
    // toolCallParser canonicalizes Write→writeFile, file_path→path.
    assert.strictEqual(exec[0].n, 'writeFile');
    assert.strictEqual(exec[0].p.path, 'out.txt');
    assert.strictEqual(res.stopReason, 'final_answer');
  });
});

test('KHY_LOCAL_WRITE=off forces read-only even WITH an approval channel', async () => {
  return withEnv({ KHY_LOCAL_WRITE: 'off' }, async () => {
    const exec = [];
    const generate = scriptedGenerate(['<tool_call>{"name": "Bash", "params": {"command": "rm -rf /"}}</tool_call>']);
    const res = await loop.runLocalToolLoop('跑个命令', {
      generate, toolDefinitions: WRITE_DEFS,
      traceContext: { sessionId: 't', onControlRequest: async () => ({ subtype: 'success', response: { behavior: 'allow' } }) },
      executeTool: async (n) => { exec.push(n); return { success: true }; },
    });
    assert.strictEqual(exec.length, 0, 'shell suppressed when KHY_LOCAL_WRITE=off');
    assert.strictEqual(res.stopReason, 'final_answer');
  });
});

test('write tier NEVER active in no-model deterministic mode, even forced on', async () => {
  return withEnv({ KHY_LOCAL_WRITE: 'on' }, async () => {
    const exec = [];
    // No generate → deterministic. Even though write is forced on, the planner is
    // read-only and never emits a write, so nothing destructive can happen.
    const res = await loop.runLocalToolLoop('把内容写到 out.txt', {
      toolDefinitions: WRITE_DEFS,
      executeTool: async (n) => { exec.push(n); return { success: true, output: 'x' }; },
    });
    assert.strictEqual(res.mode, 'deterministic');
    assert.ok(!exec.includes('Write') && !exec.includes('writeFile'), 'deterministic planner never writes');
  });
});

test('write tier system prompt switches to delivery persona; read-only stays read-only', () => {
  const writeDefs = loop.selectLocalTools(WRITE_DEFS, loop.DEFAULT_LOCAL_TOOLS.concat(loop.DEFAULT_LOCAL_WRITE_TOOLS));
  const writePrompt = loop.buildSystemPrompt(writeDefs, { writeEnabled: true });
  assert.match(writePrompt, /创建\/修改文件|执行命令/, 'delivery persona mentions writing/running');
  assert.match(writePrompt, /征求用户批准|批准/, 'tells the model writes need approval');
  // 权限分级三档须出现，让小模型知道哪些自动放行、哪些会被硬拦截。
  assert.match(writePrompt, /自动放行/, 'delivery persona spells out auto-allow (L0) tier');
  assert.match(writePrompt, /需批准一次/, 'delivery persona spells out ask-once (L1) tier');
  assert.match(writePrompt, /会被硬拦截|硬拦截/, 'delivery persona spells out hard-blocked (L2) tier');
  const readPrompt = loop.buildSystemPrompt(loop.selectLocalTools(CURATED_DEFS, loop.DEFAULT_LOCAL_TOOLS), { writeEnabled: false });
  assert.doesNotMatch(readPrompt, /创建\/修改文件/, 'read-only prompt has no write persona');
  assert.doesNotMatch(readPrompt, /权限分级/, 'read-only prompt omits the permission-tier block');
});

test('stable dedup signature: reordered params collapse to one call', async () => {
  // Same tool, same params, different key ORDER each turn. A naive stringify
  // signature would treat these as distinct and spin; the stable signature must
  // collapse them so the loop stops on no_progress.
  let execCount = 0;
  let turn = 0;
  const generate = async () => {
    turn += 1;
    const body = turn % 2 === 1
      ? '{"a":"1","b":"2"}'
      : '{"b":"2","a":"1"}';
    return { success: true, content: `<tool_call>{"name":"Grep","params":{"pattern":"p"},"extra":${body}}</tool_call>` };
  };
  // Use a tool whose params we control directly via a custom def.
  const defs = [{ name: 'Grep', description: 'g', parameters: { type: 'object', properties: { pattern: { type: 'string' }, a: { type: 'string' }, b: { type: 'string' } }, required: [] } }];
  const res = await loop.runLocalToolLoop('x', {
    generate, toolDefinitions: defs, maxIterations: 5,
    executeTool: async () => { execCount += 1; return { success: true, output: 'r' }; },
  });
  // Param object is identical (just reordered) → executed once, then no_progress.
  assert.strictEqual(execCount, 1, 'reordered-key duplicate executed only once');
  assert.strictEqual(res.stopReason, 'no_progress');
});

'use strict';
/**
 * agentDisplay 单元测试（node:test）。
 * 验证《AI Agent 显示规范》关键条款：脱敏(§1.3)、摘要(§1.4)、双模通道(§3)、
 * 用户层无内部字段(§2.2)、零待机噪音(§4)。
 *
 * 运行：node --test software/khyquant/tests/agentDisplay.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const MOD = path.join(__dirname, '..', 'services', 'agentDisplay.js');

/** 捕获 stderr 输出，返回 [收集数组, 还原函数]。 */
function captureStderr() {
  const lines = [];
  const orig = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    lines.push(String(chunk));
    return true;
  };
  return [lines, () => { process.stderr.write = orig; }];
}

/** 以指定环境加载全新的 agentDisplay（避免模块级缓存串扰构造期 env）。 */
function freshLoad(env = {}) {
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  delete require.cache[require.resolve(MOD)];
  const mod = require(MOD);
  return [mod, () => {
    for (const k of Object.keys(env)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    delete require.cache[require.resolve(MOD)];
  }];
}

test('redact: 打码 sk-/khy- 前缀密钥与 key=value', () => {
  const [m, restore] = freshLoad();
  try {
    const out = m.redact('key is sk-ABCDEF1234567890 and api_key=topsecretvalue');
    assert.ok(!out.includes('sk-ABCDEF1234567890'), '原始 sk- 密钥不应出现');
    assert.ok(!out.includes('topsecretvalue'), '原始 api_key 值不应出现');
    assert.ok(out.includes('***'), '应含打码标记');
  } finally { restore(); }
});

test('redact: 打码 Bearer token', () => {
  const [m, restore] = freshLoad();
  try {
    const out = m.redact('Authorization: Bearer abcdef0123456789xyz');
    assert.ok(!out.includes('abcdef0123456789xyz'));
    assert.ok(out.includes('***'));
  } finally { restore(); }
});

test('summarize: 超长文本截断到 100 字符并标注长度', () => {
  const [m, restore] = freshLoad();
  try {
    const big = 'a'.repeat(250);
    const out = m.summarize(big);
    assert.ok(out.length < 130, '摘要应远短于原文');
    assert.ok(out.includes('…(+150 chars)'), `应标注溢出长度，实得: ${out.slice(-20)}`);
  } finally { restore(); }
});

test('summarize: 短文本原样返回（先脱敏）', () => {
  const [m, restore] = freshLoad();
  try {
    assert.strictEqual(m.summarize('hello world'), 'hello world');
  } finally { restore(); }
});

test('newTraceId: 32 位十六进制', () => {
  const [m, restore] = freshLoad();
  try {
    const id = m.newTraceId();
    assert.match(id, /^[0-9a-f]{32}$/);
    assert.notStrictEqual(id, m.newTraceId(), '应每次不同');
  } finally { restore(); }
});

test('detectMode: KHYQUANT_MODE 控制 eco/standalone，缺省 standalone', () => {
  let [m, restore] = freshLoad({ KHYQUANT_MODE: 'eco' });
  try { assert.strictEqual(m.detectMode(), 'eco'); } finally { restore(); }
  [m, restore] = freshLoad({ KHYQUANT_MODE: '' });
  try { assert.strictEqual(m.detectMode(), 'standalone'); } finally { restore(); }
});

test('standalone: 开发者日志为单行 JSON 写 stderr，含 trace_id/step/phase', () => {
  const [m, restore] = freshLoad({ KHYQUANT_MODE: 'standalone' });
  const [lines, restoreErr] = captureStderr();
  try {
    const d = m.create({ agent: 'technical' });
    d.log('llm', { action: 'llm.analyze', tokens: { in: 10, out: 5, total: 15 } });
    restoreErr();
    assert.strictEqual(lines.length, 1);
    const evt = JSON.parse(lines[0]);
    assert.strictEqual(evt.app, 'khyquant');
    assert.strictEqual(evt.agent, 'technical');
    assert.strictEqual(evt.phase, 'llm');
    assert.strictEqual(evt.step, 1);
    assert.match(evt.trace_id, /^[0-9a-f]{32}$/);
    assert.deepStrictEqual(evt.tokens, { in: 10, out: 5, total: 15 });
  } finally { restoreErr(); restore(); }
});

test('standalone: 用户进度为纯自然语言，绝不含 JSON/内部字段', () => {
  const [m, restore] = freshLoad({ KHYQUANT_MODE: 'standalone' });
  const [lines, restoreErr] = captureStderr();
  try {
    const d = m.create({ agent: 'technical' });
    d.progress('正在分析技术面…');
    restoreErr();
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(lines[0], '正在分析技术面…\n');
    assert.ok(!lines[0].includes('trace_id') && !lines[0].includes('{'), '不得含内部字段/JSON');
  } finally { restoreErr(); restore(); }
});

test('done: 结果汇报附耗时与 token 概数（人话）', () => {
  const [m, restore] = freshLoad({ KHYQUANT_MODE: 'standalone' });
  const [lines, restoreErr] = captureStderr();
  try {
    const d = m.create({ agent: 'trading' });
    d.addTokens({ in: 800, out: 400 }); // total 1200
    d.done('分析完成，建议观望');
    restoreErr();
    const userLine = lines.find(l => l.includes('分析完成'));
    assert.ok(userLine, '应有用户结果行');
    assert.match(userLine, /耗时 \d+\.\d 秒/);
    assert.ok(userLine.includes('1.2k tokens'), `应含 token 概数，实得: ${userLine}`);
    assert.ok(!userLine.includes('"in"'), '严禁裸露 tokens 结构');
  } finally { restoreErr(); restore(); }
});

test('eco: 无 fd 时降级 stderr 且打 khyos.status 前缀（不崩溃）', () => {
  const [m, restore] = freshLoad({ KHYQUANT_MODE: 'eco' });
  const [lines, restoreErr] = captureStderr();
  try {
    const d = m.create({ agent: 'risk' });
    d.progress('正在评估风险…');
    restoreErr();
    assert.strictEqual(lines.length, 1);
    assert.ok(lines[0].startsWith('khyos.status '), `eco 降级应带前缀，实得: ${lines[0]}`);
    const obj = JSON.parse(lines[0].slice('khyos.status '.length));
    assert.strictEqual(obj.type, 'agent.status');
    assert.strictEqual(obj.message, '正在评估风险…');
  } finally { restoreErr(); restore(); }
});

test('KHY_AGENT_LOG=0 关闭开发者日志（用户层不受影响）', () => {
  const [m, restore] = freshLoad({ KHYQUANT_MODE: 'standalone', KHY_AGENT_LOG: '0' });
  const [lines, restoreErr] = captureStderr();
  try {
    const d = m.create({ agent: 'technical' });
    d.log('llm', { action: 'llm.analyze' });
    restoreErr();
    assert.strictEqual(lines.length, 0, '开发者日志应被关闭');
  } finally { restoreErr(); restore(); }
});

test('零待机噪音: 模块加载与构造器不产生任何输出', () => {
  const [lines, restoreErr] = captureStderr();
  const [m, restore] = freshLoad({ KHYQUANT_MODE: 'eco' });
  try {
    m.create({ agent: 'idle' }); // 仅构造，不调用任何方法
    restoreErr();
    assert.strictEqual(lines.length, 0, '加载/构造期必须绝对静默');
  } finally { restoreErr(); restore(); }
});

test('log: 大文本 thought 自动摘要、密钥自动脱敏', () => {
  const [m, restore] = freshLoad({ KHYQUANT_MODE: 'standalone' });
  const [lines, restoreErr] = captureStderr();
  try {
    const d = m.create({ agent: 'technical' });
    d.log('llm', { thought: 'token sk-SECRET1234567890 ' + 'x'.repeat(200) });
    restoreErr();
    const evt = JSON.parse(lines[0]);
    assert.ok(!evt.thought.includes('sk-SECRET1234567890'), '密钥应脱敏');
    assert.ok(evt.thought.includes('…(+'), '超长应摘要');
  } finally { restoreErr(); restore(); }
});

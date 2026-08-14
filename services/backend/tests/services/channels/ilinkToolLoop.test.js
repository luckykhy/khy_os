'use strict';

/**
 * 微信这条路必须驱动**结构化**工具循环。
 *
 * 背景(实测故障):模型有两种发起工具调用的方式 ——
 *   1. 自然语言语法写在回复正文里 → chat() 内部的循环会处理;
 *   2. 原生 tool_calls(结构化 toolUseBlocks) → chat() 只把它原样返回给调用方,
 *      自己不执行。执行者是 runToolUseLoop,历来只有 REPL / TUI 在驱动。
 * 当前云端模型走的是第 2 种。dispatcher 若只调 chat(),「我的桌面上有什么」这类请求
 * 会拿到一句合成占位符 `[模型请求执行工具: Glob]`,工具一个都没跑 —— 微信里只有纯闲聊
 * 能通,凡是要动手的一律哑火,而这恰恰是接微信的全部意义。
 *
 * 全部离线:注入假 chat / 假 loop,不触模型、不触网络。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.KHYOS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khyos-ilinkloop-'));
process.env.KHY_ILINK_TYPING_KEEPALIVE_MS = '5';

const { IlinkDispatcher, normalizeReply, _resolveToolLoop } =
  require('../../../src/services/channels/ilinkDispatcher');

/** 只收集出站文本的假通道。 */
function fakeChannel() {
  const sent = [];
  return {
    sent,
    sendReply: async (_to, _thread, text) => { sent.push(String(text)); return { ok: true }; },
    sendTyping: async () => ({ ok: true }),
  };
}

test('normalizeReply 认得 finalResponse —— 工具循环的结果字段', () => {
  // 循环结果上没有 reply/content/text,只有 finalResponse。漏了它,跑完工具的一整轮
  // 会被判成「没有可发送的回答」——用户看到的是工具白跑了。
  assert.strictEqual(normalizeReply({ finalResponse: '桌面上有 16 个条目' }), '桌面上有 16 个条目');
});

test('finalResponse 优先于其他字段', () => {
  // 循环结果里可能同时挂着中间态的 content;要发出去的是最终答复。
  assert.strictEqual(
    normalizeReply({ finalResponse: '最终答复', content: '[模型请求执行工具: Glob]' }),
    '最终答复'
  );
});

test('KHY_ILINK_DISABLE_TOOL_LOOP=1 时取不到循环(逃生开关有效)', () => {
  const saved = process.env.KHY_ILINK_DISABLE_TOOL_LOOP;
  process.env.KHY_ILINK_DISABLE_TOOL_LOOP = '1';
  try {
    assert.strictEqual(_resolveToolLoop(), null);
  } finally {
    if (saved === undefined) delete process.env.KHY_ILINK_DISABLE_TOOL_LOOP;
    else process.env.KHY_ILINK_DISABLE_TOOL_LOOP = saved;
  }
});

test('循环可用时:走循环,且把 finalResponse 发回微信', async () => {
  const ch = fakeChannel();
  const d = new IlinkDispatcher({ channel: ch, getChat: () => async () => 'chat 不该被直接当成答复' });

  let loopCalls = 0;
  let sawChat = false;
  d._runAgentTurn = async function (chat, msg) {
    loopCalls += 1;
    sawChat = typeof chat === 'function';
    // 模拟 runToolUseLoop 的返回形状
    return { finalResponse: `已列出 ${msg.text} 的内容`, iterations: 2 };
  };

  await d.handle({ userId: 'u1', text: '桌面', messageId: 'm1', threadId: 't1' });
  assert.strictEqual(loopCalls, 1);
  assert.ok(sawChat, '循环必须拿到 chat 作为它的模型往返入口');
  assert.deepStrictEqual(ch.sent, ['已列出 桌面 的内容']);
});

test('循环不可用时:回退到裸 chat(),仍能答纯文本', async () => {
  const saved = process.env.KHY_ILINK_DISABLE_TOOL_LOOP;
  process.env.KHY_ILINK_DISABLE_TOOL_LOOP = '1';
  try {
    const ch = fakeChannel();
    let chatCalls = 0;
    const d = new IlinkDispatcher({
      channel: ch,
      getChat: () => async (text) => { chatCalls += 1; return `收到:${text}`; },
    });
    await d.handle({ userId: 'u2', text: '你好', messageId: 'm2', threadId: 't2' });
    assert.strictEqual(chatCalls, 1, '循环关掉时必须退回 chat(),不能整条路哑掉');
    assert.deepStrictEqual(ch.sent, ['收到:你好']);
  } finally {
    if (saved === undefined) delete process.env.KHY_ILINK_DISABLE_TOOL_LOOP;
    else process.env.KHY_ILINK_DISABLE_TOOL_LOOP = saved;
  }
});

test('循环中途抛错:如实报错,绝不改用 chat() 把整轮重跑一遍', async () => {
  // 这是安全性质的:循环抛错时工具很可能已经执行过副作用(写文件、发请求)。
  // 「回退重跑」= 静默重复执行,比多一条错误消息危险得多。
  const ch = fakeChannel();
  let chatCalls = 0;
  const d = new IlinkDispatcher({
    channel: ch,
    getChat: () => async () => { chatCalls += 1; return '不该被调用'; },
  });
  d._runAgentTurn = async function () { throw new Error('工具执行到一半炸了'); };

  await d.handle({ userId: 'u3', text: '删点东西', messageId: 'm3', threadId: 't3' });
  assert.strictEqual(chatCalls, 0, '循环抛错后绝不能再跑一遍 chat() —— 副作用会重复');
  assert.strictEqual(ch.sent.length, 1, '必须给微信一句下文,不能静默');
  assert.ok(/出错|失败|错/.test(ch.sent[0]), `应如实报错,实际:${ch.sent[0]}`);
});

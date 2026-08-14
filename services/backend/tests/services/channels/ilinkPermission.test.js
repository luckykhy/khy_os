'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.KHYOS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khyos-ilinkperm-'));
// 把审批超时压到 120ms / 宽限期 200ms,否则单测要等 2 分钟。
process.env.KHY_ILINK_PERMISSION_TIMEOUT_MS = '120';
process.env.KHY_ILINK_PERMISSION_GRACE_MS = '200';
process.env.KHY_ILINK_TYPING_KEEPALIVE_MS = '5';
// 测的是权限桥本身(y/n 插队、超时拒绝、宽限期),不是工具执行。关掉结构化工具循环,
// 让注入的假 chat 直接被调 —— 工具循环的接线由 ilinkToolLoop.test.js 覆盖。
process.env.KHY_ILINK_DISABLE_TOOL_LOOP = '1';

const core = require('../../../src/services/messaging/ilinkCore');
const { IlinkDispatcher } = require('../../../src/services/channels/ilinkDispatcher');
const port = require('../../../src/services/permissionPromptPort');

/** 只收集出站文本的假通道。 */
function fakeChannel() {
  return {
    out: [],
    typing: [],
    async sendReply(cid, tid, text) { this.out.push(text); return { ok: true, sent: 1 }; },
    async setTyping(uid, on) { this.typing.push(on ? 1 : 2); return true; },
  };
}

const MSG = { userId: 'u1', channelId: 'u1', text: '删掉临时文件', threadId: 'ctx' };

// ── 纯叶子:提示渲染 ─────────────────────────────────────────────────────────

test('formatPermissionPrompt: 带上工具名、关键参数与操作指引', () => {
  const s = core.formatPermissionPrompt({
    toolName: 'Bash',
    params: { command: 'rm -rf /tmp/x', timeout: 5000 },
    riskInfo: { level: 'critical' },
    reasoning: '清理临时目录',
  });
  assert.ok(s.includes('Bash'));
  assert.ok(s.includes('rm -rf /tmp/x'), '必须让人看到到底要执行什么');
  assert.ok(s.includes('critical'));
  assert.ok(s.includes('清理临时目录'));
  assert.ok(/回复 y/.test(s) && /n 拒绝/.test(s), '必须告诉用户怎么回');
});

test('formatPermissionPrompt: 长参数值截断(防刷屏与内容泄漏)', () => {
  const s = core.formatPermissionPrompt({ toolName: 'Write', params: { content: 'x'.repeat(5000) } }, 50);
  assert.ok(s.length < 500, `不得把整个文件内容发出去,实际 ${s.length} 字符`);
  assert.ok(s.includes('共 5000 字符'), '应如实说明被截断了多少');
});

test('formatPermissionPrompt: 优先展示 command/file_path,跳过内部字段', () => {
  const s = core.formatPermissionPrompt({
    toolName: 'Edit',
    params: { _reasoning: '内部', diffPreview: 'x', file_path: '/a/b.js', old_string: 'q' },
  });
  assert.ok(!s.includes('内部'), '_ 前缀字段不该出现');
  assert.ok(!s.includes('diffPreview'));
  assert.ok(s.indexOf('file_path') < s.indexOf('old_string'), 'file_path 应排在前');
});

test('formatPermissionPrompt: 缺字段也不抛(纯叶子契约)', () => {
  assert.ok(core.formatPermissionPrompt(null).length > 0);
  assert.ok(core.formatPermissionPrompt({}).includes('未知工具'));
});

// ── 桥接行为 ─────────────────────────────────────────────────────────────────

test('权限桥: 查询期间注册 prompter,结束后原样还原', async () => {
  const sentinel = { prompt: () => {}, promptBatch: () => {} };
  port.registerPermissionPrompter(sentinel);
  const channel = fakeChannel();
  let insideHadOurs = false;
  const d = new IlinkDispatcher({
    channel,
    getChat: () => async () => {
      const p = port.getPermissionPrompter();
      insideHadOurs = !!(p && p.prompt && p.prompt !== sentinel.prompt);
      return 'done';
    },
  });
  await d.handle({ ...MSG });
  assert.strictEqual(insideHadOurs, true, '查询中应是我们的 prompter');
  const after = port.getPermissionPrompter();
  assert.strictEqual(after.prompt, sentinel.prompt, '查询后必须还原,不能霸占进程级 port');
  port._resetForTest();
});

test('权限桥: 用户回 y → allow;回 n → deny', async () => {
  for (const [reply, expected] of [['y', 'allow'], ['是', 'allow'], ['n', 'deny'], ['拒绝', 'deny']]) {
    port._resetForTest();
    const channel = fakeChannel();
    let decision = null;
    const d = new IlinkDispatcher({
      channel,
      getChat: () => async () => {
        const p = port.getPermissionPrompter();
        decision = await p.prompt('Bash', { command: 'ls' }, { level: 'low' }, '');
        return '执行完了';
      },
    });
    const query = d.handle({ ...MSG });
    // 等提示发出去,再模拟用户回复(这条走的是插队路径,不进队列)。
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(channel.out.some((t) => t.includes('需要你授权')), '应先把授权请求发到微信');
    await d.handle({ ...MSG, text: reply });
    await query;
    assert.strictEqual(decision, expected, `回「${reply}」应得 ${expected}`);
    assert.ok(channel.out.some((t) => /已授权|已拒绝/.test(t)), '应给用户回执');
  }
  port._resetForTest();
});

test('权限桥: 超时 → deny,且绝不 resolve 成空串(空串会被当成 allow)', async () => {
  port._resetForTest();
  const channel = fakeChannel();
  let decision = 'UNSET';
  const d = new IlinkDispatcher({
    channel,
    getChat: () => async () => {
      const p = port.getPermissionPrompter();
      decision = await p.prompt('Bash', { command: 'rm -rf /' }, { level: 'critical' }, '');
      return 'ok';
    },
  });
  await d.handle({ ...MSG });                       // 全程不回复
  assert.strictEqual(decision, 'deny', '没人理必须是拒绝,不能是默许');
  assert.notStrictEqual(decision, '', '空串会被 toolCallingPermissions 判为 allow');
  assert.ok(channel.out.some((t) => t.includes('自动拒绝')), '应告知用户已超时拒绝');
  port._resetForTest();
});

test('权限桥: 超时后才来的 y 被吞掉,不当成新 prompt 丢给模型', async () => {
  port._resetForTest();
  const channel = fakeChannel();
  const prompts = [];
  const d = new IlinkDispatcher({
    channel,
    getChat: () => async (text) => {
      prompts.push(text);
      if (text === MSG.text) {
        const p = port.getPermissionPrompter();
        await p.prompt('Bash', { command: 'ls' }, {}, '');
      }
      return 'ok';
    },
  });
  await d.handle({ ...MSG });                       // 超时拒绝
  await d.handle({ ...MSG, text: 'y' });            // 迟到的授权
  assert.deepStrictEqual(prompts, [MSG.text], `迟到的 y 不该进模型,实际:${JSON.stringify(prompts)}`);
  assert.ok(channel.out.some((t) => t.includes('已超时')), '应解释这条 y 为什么没生效');
  port._resetForTest();
});

test('权限桥: 审批期间队列不死锁 —— y 插队而非排队', async () => {
  port._resetForTest();
  const channel = fakeChannel();
  const d = new IlinkDispatcher({
    channel,
    getChat: () => async (text) => {
      if (text === MSG.text) {
        const p = port.getPermissionPrompter();
        const v = await p.prompt('Bash', { command: 'ls' }, {}, '');
        return `决定=${v}`;
      }
      return `其他:${text}`;
    },
  });
  const q = d.handle({ ...MSG });
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(d.toJSON().awaitingPermission, true, '应处于等授权状态');
  await d.handle({ ...MSG, text: 'y' });            // 若这条排队,就会等它自己要放行的查询 → 死锁
  await q;
  assert.ok(channel.out.some((t) => t === '决定=allow'), `应拿到 allow,实际:${channel.out.join('|')}`);
  assert.strictEqual(d.toJSON().awaitingPermission, false);
  port._resetForTest();
});

test('权限桥: 普通消息在等授权时不会被误判为审批回复', async () => {
  port._resetForTest();
  const channel = fakeChannel();
  const seen = [];
  const d = new IlinkDispatcher({
    channel,
    getChat: () => async (text) => {
      seen.push(text);
      if (text === MSG.text) {
        const p = port.getPermissionPrompter();
        await p.prompt('Bash', { command: 'ls' }, {}, '');
        return 'ok';
      }
      return 'ok2';
    },
  });
  const q = d.handle({ ...MSG });
  await new Promise((r) => setTimeout(r, 20));
  // 「顺便帮我看下天气」不是 y/n,不该被吞成审批回复
  await d.handle({ ...MSG, text: '顺便帮我看下天气' });
  await q;
  assert.ok(seen.includes('顺便帮我看下天气'), '非 y/n 的消息必须照常进模型(排队)');
  port._resetForTest();
});

test('权限桥: prompter 还原成 null(此前无注册)也正确', async () => {
  port._resetForTest();
  const channel = fakeChannel();
  const d = new IlinkDispatcher({ channel, getChat: () => async () => 'ok' });
  await d.handle({ ...MSG });
  assert.strictEqual(port.getPermissionPrompter(), null, '原本没有就该还原成没有');
});

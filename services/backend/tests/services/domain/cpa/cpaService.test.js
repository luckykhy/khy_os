'use strict';
/**
 * cpaService — CPA 接入层服务契约测试（DESIGN-CPA-002 P1）。
 *
 * Run: node --test services/backend/tests/services/domain/cpa/cpaService.test.js
 *
 * 契约：
 *   - 账号 CRUD 持久化到 cpa_accounts.json（经 cpaKeyPool，原子写 + .bak）
 *   - 账号状态管理 active/cooldown/disabled（getAccountState 回报含进度信号的 hint）
 *   - 协议转换调度：anthropic/gemini 请求→OpenAI、响应→原协议（cpaProtocolConverter 路由）
 *   - 端口顺延自愈：CPA 配置端口被占 → 自动探测下一个可用端口并回报实际端口（绝不 EADDRINUSE 崩溃）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-cpa-svc-'));
process.env.CPA_POOL_TEST_DIR = tmp;

const svc = require('../../../../src/services/domain/cpa/cpaService.js');

test('S1 账号 CRUD：add → list → update → remove 全链路持久化', () => {
  const a = svc.addAccount({ provider: 'codex', credential: 'sk-svc-1', label: 'svc-a' });
  assert.ok(a.ok && a.id, 'add 返回 id');
  let list = svc.listAccounts();
  assert.ok(list.some((x) => x.id === a.id && x.label === 'svc-a'), 'list 可见');
  const u = svc.updateAccount(a.id, { label: 'svc-a-2', priority: 5 });
  assert.ok(u.ok, 'update 成功');
  list = svc.listAccounts();
  assert.equal(list.find((x) => x.id === a.id).label, 'svc-a-2');
  assert.equal(list.find((x) => x.id === a.id).priority, 5);
  const rm = svc.removeAccount(a.id);
  assert.ok(rm.ok, 'remove 成功');
  assert.equal(svc.getAccount(a.id), null, '删除后 getAccount 为 null');
});

test('S2 状态管理：active →(429)→ cooldown →(窗口过)→ active；disabled 恒不可用', () => {
  const a = svc.addAccount({ provider: 'gemini', credential: 'sk-svc-2', label: 'svc-b' });
  assert.ok(a.ok);
  let st = svc.getAccountState(a.id);
  assert.equal(st.status, 'active');
  svc.reportResult(a.id, { ok: false, statusCode: 429, error: 'quota' });
  st = svc.getAccountState(a.id);
  assert.equal(st.status, 'cooldown');
  assert.ok(st.hint, 'cooldown 态 hint 非空（动作+目标+进度）');
  assert.match(st.hint, /冷却|cooldown/i);
  svc.__testHooks.forceCooldownExpiry(a.id);
  st = svc.getAccountState(a.id);
  assert.equal(st.status, 'active', '窗口过后惰性恢复');
  svc.setAccountState(a.id, 'disabled');
  st = svc.getAccountState(a.id);
  assert.equal(st.status, 'disabled');
  svc.reportResult(a.id, { ok: true });
  st = svc.getAccountState(a.id);
  assert.equal(st.status, 'disabled', 'disabled 不被成功信号顶掉（须显式 enable）');
  svc.setAccountState(a.id, 'active');
});

test('S3 协议转换调度：按 upstream 协议路由请求/响应转换', () => {
  // anthropic 请求 → OpenAI（system 提升为 system 消息，置于 user 之前）
  const req1 = svc.convertRequest('anthropic', {
    model: 'claude-sonnet-4-5',
    max_tokens: 1024,
    system: 'you are k',
    messages: [{ role: 'user', content: 'hi' }]
  });
  assert.equal(req1.messages[0].role, 'system', 'anthropic system → openai system 消息前置');
  assert.equal(req1.messages[0].content, 'you are k');
  assert.equal(req1.messages[1].role, 'user');
  assert.equal(req1.messages[1].content, 'hi');
  assert.equal(req1.max_tokens, 1024);
  // openai 响应 → anthropic
  const res1 = svc.convertResponse('anthropic', {
    model: 'claude-sonnet-4-5',
    choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5 }
  });
  assert.equal(res1.type, 'message');
  assert.equal(res1.content[0].text, 'hello');
  assert.equal(res1.stop_reason, 'end_turn');
  assert.equal(res1.usage.input_tokens, 10);
  // gemini 请求 → OpenAI
  const req2 = svc.convertRequest('gemini', {
    model: 'gemini-2.5-pro',
    contents: [{ role: 'user', parts: [{ text: 'yo' }] }],
    generationConfig: { temperature: 0.3 }
  });
  assert.equal(req2.messages[0].role, 'user');
  assert.equal(req2.messages[0].content, 'yo');
  assert.equal(req2.temperature, 0.3);
  // openai 响应 → gemini
  const res2 = svc.convertResponse('gemini', {
    model: 'gemini-2.5-pro',
    choices: [{ message: { role: 'assistant', content: 'yoyo' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
  });
  assert.equal(res2.candidates[0].content.parts[0].text, 'yoyo');
  assert.equal(res2.candidates[0].finishReason, 'STOP');
  assert.equal(res2.usageMetadata.totalTokenCount, 5);
});

test('S4 协议调度未知协议：明确报错（动作+目标+原因），不猜', () => {
  const r = svc.convertRequest('unknown-protocol', { messages: [] });
  assert.equal(r, null, '未知协议返回 null（调用方据此 fail-soft）');
  const e = svc.convertResponse('unknown-protocol', { choices: [] });
  assert.equal(e, null);
});

test('S5 端口顺延自愈：被占端口 → 自动探测下一个可用端口并回报实际值', async () => {
  const net = require('node:net');
  const srv = net.createServer().listen(0);
  await new Promise((r) => srv.once('listening', r));
  const busyPort = srv.address().port;

  // 请求端口被占 → 顺延到下一个可用（绝不 EADDRINUSE 崩溃）
  const r = await svc.findAvailablePort(busyPort, { scanLimit: 20 });
  assert.equal(r.shifted, true, '回报顺延标记（状态透明：动作+目标+进度）');
  assert.equal(r.requested, busyPort, '回报原始请求端口');
  assert.notEqual(r.port, busyPort, '顺延结果离开被占端口');
  assert.equal(await svc.probePort(r.port), false, '顺延落点必须实测空闲（确定性，不赌 P+1）');
  assert.equal(await svc.probePort(busyPort), true, '被占端口探测为 true');

  // 空闲端口直接返回、不跳
  const free = await svc.findAvailablePort(r.port, { scanLimit: 20 });
  assert.equal(free.port, r.port, '空闲端口不跳');
  assert.equal(free.shifted, false);

  srv.close();
});

test('S6 cpaService 独立可运行：require 无副作用、缺省目录可写', () => {
  const fresh = require('../../../../src/services/domain/cpa/cpaService.js');
  assert.equal(typeof fresh.addAccount, 'function');
  assert.equal(typeof fresh.convertRequest, 'function');
  assert.equal(typeof fresh.findAvailablePort, 'function');
});

test('S7 凭据密文：cpa_accounts.json 中为 AES-256-GCM 密文，reveal 唯一明文出口', () => {
  const { decryptApiKey } = require('../../../../src/services/channelApiCrypto.js');
  const a = svc.addAccount({ provider: 'codex', credential: 'sk-svc-secret', label: 'enc' });
  assert.ok(a.ok);
  const raw = fs.readFileSync(path.join(tmp, 'cpa_accounts.json'), 'utf-8');
  assert.ok(!raw.includes('sk-svc-secret'), '文件无明文');
  const doc = JSON.parse(raw);
  const rec = doc.accounts.find((x) => x.id === a.id);
  assert.ok(rec && typeof rec.credentialCipher === 'string' && rec.credentialCipher.length > 0, '凭据以密文字段落盘');
  assert.equal(decryptApiKey(rec.credentialCipher), 'sk-svc-secret', '密文可经既有 AES-256-GCM 基建往返解密');
  const revealed = svc.revealAccountCredential(a.id);
  assert.equal(revealed, 'sk-svc-secret', 'reveal 回明文（唯一出口）');
  assert.equal(JSON.stringify(svc.listAccounts()).includes('sk-svc-secret'), false, 'list 全脱敏');
});

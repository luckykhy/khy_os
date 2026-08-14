'use strict';

/**
 * vertexHandlerWiring.test.js — `khy gateway vertex` 接线测试(node:test)。
 *
 * 证明纯叶子 vertexRequestShaping 有了**真实消费者**:CLI 处理器 handleGatewayVertex 把 URL
 * 成形能力接到人面前(告诉用户 baseUrl/端点/鉴权该填什么)。此前该叶子零消费者(能力存在但没接线)。
 *
 * 覆盖:
 *   - 完整 spec → JSON plan.ok===true 且 URL 含 publishers/google + :generateContent;
 *   - 门关(KHY_VERTEX_REQUEST_SHAPING=0)→ plan.ok===false / reason==='disabled'(逐字节回退,不改行为);
 *   - 缺参 → reason==='missing-model';
 *   - router 确实把 subCommand==='vertex' 接到 gw.handleGatewayVertex(源级 grep,防未来静默失联);
 *   - handler 在导出面上(export grep)。
 * 零网络、确定性(json 模式不打印表格)。用 `node --test` 跑。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const gw = require('../../../src/cli/handlers/gateway.js');

const SPEC = { project: 'my-proj', location: 'us-central1', model: 'gemini-2.0-flash' };

/** 抑制 handler 的 console.log(JSON 模式仍会打印一行 JSON),返回其结构化返回值。 */
function quiet(fn) {
  const orig = console.log;
  console.log = () => {};
  try { return fn(); } finally { console.log = orig; }
}

test('handleGatewayVertex：完整 spec → plan.ok 且 URL 成形正确(publishers/google + :generateContent)', () => {
  const plan = quiet(() => gw.handleGatewayVertex([], { json: true, ...SPEC }));
  assert.equal(plan.ok, true);
  assert.equal(plan.reason, 'shaped');
  assert.match(plan.url, /\/publishers\/google\/models\/gemini-2\.0-flash:generateContent$/);
  assert.match(plan.baseUrl, /^https:\/\/us-central1-aiplatform\.googleapis\.com\/v1\/projects\/my-proj\/locations\/us-central1\/publishers\/google$/);
  assert.equal(plan.keyField, 'authorization_bearer');
  assert.equal(plan.bodyFormat, 'gemini');
});

test('handleGatewayVertex：streaming → :streamGenerateContent', () => {
  const plan = quiet(() => gw.handleGatewayVertex([], { json: true, ...SPEC, stream: true }));
  assert.equal(plan.ok, true);
  assert.match(plan.url, /:streamGenerateContent$/);
});

test('handleGatewayVertex：global 地域 → host 无地域前缀', () => {
  const plan = quiet(() => gw.handleGatewayVertex([], { json: true, ...SPEC, location: 'global' }));
  assert.equal(plan.ok, true);
  assert.match(plan.baseUrl, /^https:\/\/aiplatform\.googleapis\.com\//);
});

test('handleGatewayVertex：门关 KHY_VERTEX_REQUEST_SHAPING=0 → disabled(逐字节回退,不改行为)', () => {
  const saved = process.env.KHY_VERTEX_REQUEST_SHAPING;
  try {
    process.env.KHY_VERTEX_REQUEST_SHAPING = '0';
    const plan = quiet(() => gw.handleGatewayVertex([], { json: true, ...SPEC }));
    assert.equal(plan.ok, false);
    assert.equal(plan.reason, 'disabled');
  } finally {
    if (saved === undefined) delete process.env.KHY_VERTEX_REQUEST_SHAPING;
    else process.env.KHY_VERTEX_REQUEST_SHAPING = saved;
  }
});

test('handleGatewayVertex：缺 model → missing-model', () => {
  const plan = quiet(() => gw.handleGatewayVertex([], { json: true, project: 'my-proj' }));
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, 'missing-model');
});

test('接线：handleGatewayVertex 已导出', () => {
  assert.equal(typeof gw.handleGatewayVertex, 'function');
});

test('接线：router 把 gateway subCommand==="vertex" 接到 handleGatewayVertex(源级,防静默失联)', () => {
  const routerSrc = fs.readFileSync(
    path.resolve(__dirname, '../../../src/cli/router.js'), 'utf8');
  assert.match(routerSrc, /subCommand === 'vertex'\)\s*gw\.handleGatewayVertex/);
});

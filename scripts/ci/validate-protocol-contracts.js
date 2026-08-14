#!/usr/bin/env node
'use strict';

/**
 * validate-protocol-contracts.js — 校验 khy-os 通信协议契约。
 *
 * 用法:
 *   node scripts/ci/validate-protocol-contracts.js        # 校验全部协议契约
 *   node scripts/ci/validate-protocol-contracts.js --json  # JSON 机器输出
 *
 * 需要 `ajv` 库: npm install ajv (devDependency).
 *
 * 本脚本校验的是「代码中内嵌的协议契约」（HTTP 信封、WebSocket 消息、
 * IPC 消息等），而非 .khy/ 文件。校验数据来源于脚本中硬编码的示例快照，
 * 对应 COMMUNICATION-PROTOCOL.md 中的协议定义。
 */

const Ajv = require('ajv');

const SCHEMAS_DIR = require('path').join(__dirname, 'json-schemas');

// ── Load schemas ─────────────────────────────────────────────────────────────

const ajv = new Ajv({ allErrors: true, strict: false });
const schemas = {};

for (const f of require('fs').readdirSync(SCHEMAS_DIR).filter(f => f.endsWith('.schema.json'))) {
  const raw = require('fs').readFileSync(require('path').join(SCHEMAS_DIR, f), 'utf-8');
  schemas[f] = JSON.parse(raw);
  ajv.addSchema(schemas[f], f);
}

// ── Protocol contract fixtures ──────────────────────────────────────────────
// 这些快照对应 COMMUNICATION-PROTOCOL.md 中的协议定义。
// 任何协议变更都必须同步更新本文件和文档。

const FIXTURES = [
  // HTTP 成功响应
  {
    schema: 'http-success-envelope.schema.json',
    name: 'HTTP 成功响应（对象数据）',
    data: { success: true, data: { id: '1', name: 'test' } },
  },
  {
    schema: 'http-success-envelope.schema.json',
    name: 'HTTP 成功响应（数组数据）',
    data: { success: true, data: [{ id: '1' }, { id: '2' }] },
  },
  {
    schema: 'http-success-envelope.schema.json',
    name: 'HTTP 成功响应（空数据）',
    data: { success: true, data: null, message: '已删除' },
  },
  {
    schema: 'http-success-envelope.schema.json',
    name: 'HTTP 成功响应（分页）',
    data: {
      success: true,
      data: [{ id: '1' }],
      pagination: { page: 1, pageSize: 20, total: 100, totalPages: 5 },
    },
  },
  // HTTP 错误响应
  {
    schema: 'http-error-envelope.schema.json',
    name: 'HTTP 错误响应（基础）',
    data: { success: false, message: '资源不存在' },
  },
  {
    schema: 'http-error-envelope.schema.json',
    name: 'HTTP 错误响应（含状态码）',
    data: { success: false, message: '未授权', statusCode: 401, errorType: 'auth' },
  },
  {
    schema: 'http-error-envelope.schema.json',
    name: 'HTTP 错误响应（含 requestId）',
    data: { success: false, message: '验证失败', statusCode: 422, errorType: 'validation', requestId: 'abc123' },
  },
  // WebSocket 消息
  {
    schema: 'websocket-message.schema.json',
    name: 'WebSocket 认证请求',
    data: { type: 'auth', payload: { token: 'jwt-token-here' } },
  },
  {
    schema: 'websocket-message.schema.json',
    name: 'WebSocket 认证成功',
    data: { type: 'auth_success', payload: { userId: 'u1', role: 'admin' } },
  },
  {
    schema: 'websocket-message.schema.json',
    name: 'WebSocket 心跳',
    data: { type: 'ping' },
  },
  {
    schema: 'websocket-message.schema.json',
    name: 'WebSocket 错误消息',
    data: { type: 'error', message: '连接超时', requestId: 'req-001' },
  },
  // IPC 消息
  {
    schema: 'ipc-message.schema.json',
    name: 'IPC 任务消息',
    data: {
      _ipc: true,
      type: 'task',
      requestId: 'a1b2c3d4e5f6',
      agentId: 'agent-001',
      timestamp: 1690000000000,
      payload: { prompt: '分析这个文件', options: {} },
    },
  },
  {
    schema: 'ipc-message.schema.json',
    name: 'IPC 错误消息',
    data: {
      _ipc: true,
      type: 'error',
      requestId: 'a1b2c3d4e5f7',
      agentId: 'agent-001',
      timestamp: 1690000000001,
      payload: { message: 'Tool execution failed', code: 'TOOL_EXEC_FAILED', fatal: false },
    },
  },
  {
    schema: 'ipc-message.schema.json',
    name: 'IPC 心跳',
    data: {
      _ipc: true,
      type: 'heartbeat',
      requestId: 'a1b2c3d4e5f8',
      agentId: 'agent-001',
      timestamp: 1690000000002,
      payload: {},
    },
  },
];

// ── Validate ───────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
const failures = [];

for (const fixture of FIXTURES) {
  const validate = ajv.getSchema(fixture.schema);
  if (!validate) {
    failed++;
    failures.push({ name: fixture.name, error: `Schema not loaded: ${fixture.schema}` });
    continue;
  }
  const valid = validate(fixture.data);
  if (valid) {
    passed++;
  } else {
    failed++;
    failures.push({
      name: fixture.name,
      schema: fixture.schema,
      errors: validate.errors.map(e => `${e.instancePath || '/'} ${e.message}`),
    });
  }
}

// ── Output ──────────────────────────────────────────────────────────────────

const isJson = process.argv.includes('--json');

if (isJson) {
  console.log(JSON.stringify({
    schema: 'khy.protocol-contracts/v1',
    total: FIXTURES.length,
    passed,
    failed,
    failures,
  }, null, 2));
} else {
  console.log('协议契约校验');
  console.log('='.repeat(60));
  for (const fixture of FIXTURES) {
    const v = ajv.getSchema(fixture.schema);
    const ok = v && v(fixture.data);
    const mark = ok ? 'PASS' : 'FAIL';
    console.log(`  [${mark}] ${fixture.name}`);
    if (!ok && v && v.errors) {
      for (const e of v.errors) {
        console.log(`       ${e.instancePath || '/'} ${e.message}`);
      }
    } else if (!ok && !v) {
      console.log(`       Schema not loaded: ${fixture.schema}`);
    }
  }
  console.log('='.repeat(60));
  console.log(`结果: ${passed} passed, ${failed} failed`);
}

process.exit(failed > 0 ? 1 : 0);

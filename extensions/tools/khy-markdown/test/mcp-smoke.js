#!/usr/bin/env node
'use strict';
/**
 * mcp-smoke.js — khyos-md-mcp.js 冒烟测试。
 * 启动 MCP 服务器子进程，依次发送 initialize / tools/list / tools/call，
 * 校验 JSON-RPC 2.0 响应格式。零依赖，直接 `node test/mcp-smoke.js` 运行。
 */
const { spawn } = require('child_process');
const path = require('path');

const SERVER = path.join(__dirname, '..', 'khyos-md-mcp.js');
const ROOT = path.join(__dirname, '..'); // 以包目录为 root（内含 README.md）

const child = spawn(process.execPath, [SERVER, '--root', ROOT], {
  stdio: ['pipe', 'pipe', 'pipe']
});

let buf = '';
const pending = new Map(); // id -> { resolve, reject }

child.stdout.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let idx;
  while ((idx = buf.indexOf('\n')) > -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (e) {
      fail('stdout 输出了非 JSON 行: ' + line.slice(0, 200));
      return;
    }
    const p = pending.get(msg.id);
    if (p) { pending.delete(msg.id); p.resolve(msg); }
  }
});

child.stderr.on('data', (d) => process.stderr.write('[server-log] ' + d));
child.on('error', (e) => fail('无法启动服务器: ' + e.message));

let nextId = 1;
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(method + ' 响应超时')); }
    }, 5000);
  });
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

let passed = 0;
function check(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else fail(name);
}
function fail(name) {
  console.error('  ✗ FAIL: ' + name);
  try { child.kill(); } catch (_) {}
  process.exit(1);
}

(async () => {
  // 1. initialize
  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'mcp-smoke', version: '0.0.1' }
  });
  console.log('[1] initialize');
  check(init.jsonrpc === '2.0', 'jsonrpc 为 2.0');
  check(init.result && init.result.protocolVersion === '2024-11-05', 'protocolVersion 正确');
  check(init.result.serverInfo && init.result.serverInfo.name === 'khyos-markdown', 'serverInfo.name 正确');
  check(init.result.capabilities && typeof init.result.capabilities.tools === 'object', 'capabilities.tools 存在');

  notify('notifications/initialized');

  // 2. ping
  const ping = await rpc('ping');
  console.log('[2] ping');
  check(ping.result && Object.keys(ping.result).length === 0, 'ping 返回 {}');

  // 3. tools/list
  const list = await rpc('tools/list');
  console.log('[3] tools/list');
  const tools = (list.result && list.result.tools) || [];
  const names = tools.map((t) => t.name);
  const expected = ['read_markdown', 'write_markdown', 'list_markdown', 'search_markdown', 'open_editor', 'get_outline'];
  check(expected.every((n) => names.includes(n)), '包含全部 6 个工具: ' + names.join(', '));
  check(tools.every((t) => t.description && t.inputSchema && t.inputSchema.type === 'object'), '每个工具均有 description 与 inputSchema');

  // 4. tools/call — list_markdown
  const lm = await rpc('tools/call', { name: 'list_markdown', arguments: {} });
  console.log('[4] tools/call list_markdown');
  check(lm.result && Array.isArray(lm.result.content) && lm.result.content[0].type === 'text', '返回 content[0].type === text');
  check(lm.result.content[0].text.includes('README.md'), '结果包含 README.md');

  // 5. tools/call — get_outline
  const go = await rpc('tools/call', { name: 'get_outline', arguments: { path: 'README.md' } });
  console.log('[5] tools/call get_outline');
  check(go.result && go.result.content[0].text.includes('khyosMarkdown'), '大纲包含顶级标题 khyosMarkdown');

  // 6. tools/call — 路径越界拒绝
  const esc = await rpc('tools/call', { name: 'read_markdown', arguments: { path: '..\\..\\..\\Windows\\win.ini' } });
  console.log('[6] tools/call 越界路径');
  check(esc.result && esc.result.isError === true, '越界路径被拒绝 (isError=true)');

  // 7. 未知方法 → -32601
  const unk = await rpc('no/such/method');
  console.log('[7] 未知方法');
  check(unk.error && unk.error.code === -32601, '未知方法返回 -32601');

  console.log('\n全部通过: ' + passed + ' 项断言 ✓');
  child.kill();
  process.exit(0);
})().catch((e) => fail(e.message));

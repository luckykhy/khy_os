#!/usr/bin/env node
'use strict';

/**
 * check-protocol-conformance.js — 协议一致性守卫（MCP + A2A）。
 *
 * 解决什么问题
 * ------------
 * 本仓历史上反复出现**同一类**故障：代码里写着的能力、文档里写着的能力、以及
 * 实际能跑的行为，三者不一致。典型证据：
 *   - MCP client 上报 `capabilities: { tools, resources, prompts }` —— 那是
 *     **ServerCapabilities** 字段，出现在客户端能力里属无效声明；
 *   - MCP server 端只声明 tools，自家 client 连上去却发 `resources/list`，必收 -32601；
 *   - A2A Agent Card 声明 `capabilities.streaming: true`，而全仓 `message/stream`、
 *     `TaskStatusUpdateEvent` 零命中；
 *   - `A2ATool` 暴露 `create_task`，对应的却是 A2A 规范里不存在的一个私有端点。
 *
 * 「声明与实现不一致」不该靠人记得。本守卫把**声明**变成机器可读的数据
 * （`mcpServerProtocol.PROTOCOL_CONFORMANCE` + `agentCardSpec.IMPLEMENTED_CAPABILITIES`），
 * 再逐条对**代码与运行时行为**做实测断言：声明了却没做 → 红灯。
 *
 * 三类探针（每个 implemented:true 的特性必须至少有一条）
 * ------------------------------------------------------
 *   behavior  直接调用纯函数，断言运行时行为（最强，优先）
 *   source    断言某文件源码里存在/不存在某个模式（用于 IO/传输层这类无法纯函数化的点）
 *   file      断言某文件存在
 *
 * 用法
 * ----
 *   node scripts/ci/check-protocol-conformance.js            # 全部
 *   node scripts/ci/check-protocol-conformance.js --mcp      # 仅 MCP
 *   node scripts/ci/check-protocol-conformance.js --a2a      # 仅 A2A
 *   node scripts/ci/check-protocol-conformance.js --json     # 机器可读输出
 *
 * 依赖 `ajv`（root devDependency，draft-07），与 validate-protocol-contracts.js 一致。
 * 环境：离网、确定性；除读取源码外无副作用。
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = process.env.KHY_PROTOCOL_CONFORMANCE_ROOT
  ? path.resolve(process.env.KHY_PROTOCOL_CONFORMANCE_ROOT)
  : path.resolve(__dirname, '..', '..');

const BACKEND_SRC = path.join(REPO_ROOT, 'services', 'backend', 'src');
const MCP_DIR = path.join(BACKEND_SRC, 'services', 'domain', 'messaging', 'mcp');
const A2A_DIR = path.join(BACKEND_SRC, 'services', 'a2a');
const A2A_CONTRACTS = path.join(BACKEND_SRC, 'contracts', 'a2a');

const args = process.argv.slice(2);
const jsonOut = args.includes('--json');
const onlyMcp = args.includes('--mcp');
const onlyA2a = args.includes('--a2a');
const runMcp = onlyA2a ? false : true;
const runA2a = onlyMcp ? false : true;

const checks = []; // { scope, id, ok, message }
function record(scope, id, ok, message) {
  checks.push({ scope, id, ok, message: message || '' });
}

function readSource(absPath) {
  try {
    return fs.readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
}

function fileExists(absPath) {
  try {
    return fs.statSync(absPath).isFile();
  } catch {
    return false;
  }
}

// ══════════════════════════════════════════════════════════════════════════
// MCP
// ══════════════════════════════════════════════════════════════════════════

function loadMcpProtocol() {
  return require(path.join(MCP_DIR, 'mcpServerProtocol.js'));
}

/**
 * 每个 MCP 特性的探针。key = PROTOCOL_CONFORMANCE[].id。
 * 新增 implemented:true 的特性时必须同时加探针 —— 否则守卫报「缺探针」。
 */
function mcpProbes(protocol) {
  const httpServerSrc = readSource(path.join(MCP_DIR, 'mcpHttpServer.js')) || '';
  const serverSrc = readSource(path.join(MCP_DIR, 'mcpServer.js')) || '';

  return {
    'jsonrpc-2.0-envelope': () => {
      const res = protocol.buildResult(1, { ok: true });
      if (res.jsonrpc !== '2.0' || res.id !== 1) return 'buildResult 未写 jsonrpc:"2.0"';
      const err = protocol.buildError(2, -32601, 'x');
      if (err.jsonrpc !== '2.0' || !err.error) return 'buildError 形状不对';
      const bad = protocol.parseMessage('{"jsonrpc":"1.0","id":1,"method":"x"}');
      if (bad.ok !== false || bad.errorCode !== protocol.ERROR_CODES.INVALID_REQUEST) {
        return 'jsonrpc≠"2.0" 未被拒为 -32600';
      }
      const good = protocol.parseMessage('{"jsonrpc":"2.0","id":1,"method":"x"}');
      if (!good.ok) return '合法 2.0 信封被拒';
      return null;
    },
    'jsonrpc-error-codes': () => {
      const c = protocol.ERROR_CODES;
      const want = { PARSE_ERROR: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL_ERROR: -32603 };
      for (const [k, v] of Object.entries(want)) {
        if (c[k] !== v) return `${k} 应为 ${v}，实为 ${c[k]}`;
      }
      return null;
    },
    'lifecycle-initialize': () => {
      const r = protocol.buildInitializeResult({ version: '9.9.9' });
      if (!r.protocolVersion) return 'initialize 未回 protocolVersion';
      if (!r.serverInfo || r.serverInfo.version !== '9.9.9') return 'serverInfo.version 未透传';
      return null;
    },
    'lifecycle-version-negotiation': () => {
      const supported = protocol.SUPPORTED_PROTOCOL_VERSIONS[0];
      if (protocol.negotiateProtocolVersion(supported) !== supported) return '支持的版本未回显';
      const alien = '1999-01-01';
      if (protocol.negotiateProtocolVersion(alien) !== protocol.PROTOCOL_VERSION) {
        return '不支持的版本未回落到本端版本';
      }
      return null;
    },
    ping: () => (/\bping\s*[:(]/.test(serverSrc) ? null : 'mcpServer.js 无 ping handler'),
    'tools-list': () => (/['"]tools\/list['"]/.test(serverSrc) ? null : 'mcpServer.js 无 tools/list handler'),
    'tools-call': () => (/['"]tools\/call['"]/.test(serverSrc) ? null : 'mcpServer.js 无 tools/call handler'),
    'transport-stdio': () => (fileExists(path.join(MCP_DIR, 'mcpStdioServer.js')) ? null : '缺 mcpStdioServer.js'),
    'transport-http-sse-legacy': () => (/['"]\/sse['"]/.test(httpServerSrc) ? null : 'mcpHttpServer.js 无 /sse 端点'),
    'server-capability-declaration-honesty': () => {
      const caps = protocol.buildInitializeResult({}).capabilities;
      const keys = Object.keys(caps || {});
      // 诚实 = 只声明真的实现了的。当前只实现了 tools。
      for (const k of keys) {
        if (!['tools', 'logging', 'experimental'].includes(k)) {
          return `initialize 声明了未实现的 server 能力: ${k}`;
        }
      }
      if (!keys.includes('tools')) return 'initialize 未声明 tools';
      return null;
    },
    'transport-streamable-http-protocol-version-header': () => {
      const supported = protocol.SUPPORTED_PROTOCOL_VERSIONS[0];
      const okv = protocol.checkProtocolVersionHeader(supported);
      if (!okv.ok || okv.assumed) return '支持版本的头被判为 assumed/拒绝';
      const bad = protocol.checkProtocolVersionHeader('1999-01-01');
      if (bad.ok) return '不支持的版本头未被拒';
      const missing = protocol.checkProtocolVersionHeader('');
      if (!missing.ok || !missing.assumed) return '缺头时未标记 assumed';
      if (protocol.PROTOCOL_VERSION_HEADER !== 'mcp-protocol-version') return '头名必须全小写';
      return null;
    },
    'transport-streamable-http-json-response': () =>
      /application\/json/.test(httpServerSrc) ? null : 'mcpHttpServer.js 未以 application/json 回包',
    'transport-streamable-http-session-404': () =>
      /SESSION_NOT_FOUND/.test(httpServerSrc) && /404/.test(httpServerSrc)
        ? null
        : 'mcpHttpServer.js 未实现会话失效 404',
    'transport-streamable-http-sse-response': () => {
      if (typeof protocol.resolveStreamableContentType !== 'function') {
        return '缺 resolveStreamableContentType 纯函数';
      }
      if (protocol.resolveStreamableContentType('application/json, text/event-stream') !== 'text/event-stream') {
        return 'Accept 含 text/event-stream 时未协商出 SSE 响应类型';
      }
      if (protocol.resolveStreamableContentType('application/json') !== 'application/json') {
        return '普通 Accept 未回退到 application/json';
      }
      return null;
    },
    'transport-streamable-http-last-event-id': () => {
      if (typeof protocol.replayEventIdsAfter !== 'function') {
        return '缺 replayEventIdsAfter 纯函数';
      }
      const ids = ['1', '2', '3', '4'];
      const replay = protocol.replayEventIdsAfter('2', ids);
      if (replay.length !== 2 || replay[0] !== '3' || replay[1] !== '4') {
        return '断线续传重放切片计算错误';
      }
      if (protocol.replayEventIdsAfter('x', ids).length !== 0) {
        return '非法 Last-Event-ID 未被安全忽略';
      }
      if (protocol.replayEventIdsAfter('', ids).length !== 0) {
        return '空 Last-Event-ID 不应触发重放';
      }
      return null;
    },
    'transport-streamable-http-origin-403': () =>
      /Origin/i.test(httpServerSrc) && /403/.test(httpServerSrc)
        ? null
        : 'mcpHttpServer.js 未实现 Origin 校验 403',
    'authorization-www-authenticate': () =>
      /WWW-Authenticate/i.test(httpServerSrc) ? null : 'mcpHttpServer.js 401 缺 WWW-Authenticate',
    'tool-output-schema-structured-content': () => {
      const def = protocol.toolDefToMcp({
        name: 't',
        description: 'd',
        parameters: { type: 'object', properties: {} },
        outputSchema: { type: 'object', properties: { a: { type: 'string' } } },
      });
      if (!def.outputSchema) return 'outputSchema 未透传';
      const res = protocol.toolResultToMcp({ success: true, content: { a: 'b' } });
      if (!res.structuredContent || res.structuredContent.a !== 'b') return '结构化对象未回 structuredContent';
      if (res.content[0].text.includes('[object Object]')) return '结构化内容被 String() 折叠';
      const arr = protocol.toolResultToMcp({ success: true, content: [1, 2] });
      if (arr.structuredContent !== undefined) return '数组不应写入 structuredContent（规范要求对象）';
      return null;
    },
    'tool-annotations-passthrough': () => {
      const def = protocol.toolDefToMcp({
        name: 't',
        description: 'd',
        parameters: { type: 'object', properties: {} },
        annotations: { readOnlyHint: true, destructiveHint: false },
      });
      if (!def.annotations || def.annotations.readOnlyHint !== true) return 'annotations 未透传';
      return null;
    },
  };
}

function runMcpChecks(report) {
  let protocol;
  try {
    protocol = loadMcpProtocol();
  } catch (e) {
    record('mcp', 'load-mcpServerProtocol', false, `无法加载 mcpServerProtocol.js: ${e.message}`);
    return;
  }

  const probes = mcpProbes(protocol);
  const rows = protocol.PROTOCOL_CONFORMANCE || [];

  // 1) 声明支持的修订,其 required 特性必须全部 implemented 且探针通过
  for (const rev of protocol.SUPPORTED_PROTOCOL_VERSIONS || []) {
    const fully = protocol.isRevisionFullyImplemented(rev);
    record('mcp', `revision-fully-implemented:${rev}`, fully === true,
      fully ? '' : `SUPPORTED_PROTOCOL_VERSIONS 含 ${rev}，但其 required 特性未全部实现`);
  }

  // 2) SUPPORTED_PROTOCOL_VERSIONS 必须等于「required 全绿的修订」集合
  const allRevs = [...new Set(rows.map((r) => r.revision))];
  const shouldSupport = allRevs.filter((rev) => {
    const req = rows.filter((r) => r.revision === rev && r.required);
    return req.length > 0 && req.every((r) => r.implemented);
  });
  const declared = [...(protocol.SUPPORTED_PROTOCOL_VERSIONS || [])];
  const missing = shouldSupport.filter((r) => !declared.includes(r));
  const extra = declared.filter((r) => !shouldSupport.includes(r));
  record('mcp', 'supported-revisions-consistency', missing.length === 0 && extra.length === 0,
    missing.length || extra.length
      ? `声明集合与矩阵不一致：应含 ${JSON.stringify(missing)}，不应含 ${JSON.stringify(extra)}`
      : '');

  // 3) 逐条特性。
  //    - `required: true` 且未实现 → 合法，**前提是该修订因此不被声明**。这正是
  //      「诚实」的机器表达：做了多少就声明多少，缺口写进矩阵而不是藏起来。
  //    - `implemented: true` → 必须有探针且通过；没有探针 = 空声明 = 红灯。
  const declaredSet = new Set(declared);
  for (const row of rows) {
    const tag = `${row.id}(${row.revision})`;
    if (row.required && !row.implemented) {
      if (declaredSet.has(row.revision)) {
        record('mcp', tag, false,
          `required 特性未实现，但 ${row.revision} 仍在 SUPPORTED_PROTOCOL_VERSIONS 中声明 —— 这是「声明了做不到」`);
      } else {
        record('mcp', tag, true, `未实现 → ${row.revision} 因此不被声明（诚实降级）`);
      }
      continue;
    }
    if (!row.implemented) {
      record('mcp', tag, true, '未实现（诚实登记，非必需）');
      continue;
    }
    const probe = probes[row.id];
    if (!probe) {
      record('mcp', tag, false, '声明 implemented 却没有探针 —— 无法验证，等同于空声明');
      continue;
    }
    let err = null;
    try {
      err = probe();
    } catch (e) {
      err = `探针抛异常: ${e.message}`;
    }
    record('mcp', tag, !err, err || '');
  }

  report.mcp = { features: rows.length, declaredRevisions: declared };
}

// ══════════════════════════════════════════════════════════════════════════
// A2A
// ══════════════════════════════════════════════════════════════════════════

function loadAjv() {
  try {
    // eslint-disable-next-line global-require
    return require(path.join(REPO_ROOT, 'node_modules', 'ajv'));
  } catch {
    try {
      // eslint-disable-next-line global-require
      return require('ajv');
    } catch {
      return null;
    }
  }
}

function buildAjvWithA2aSchemas() {
  const Ajv = loadAjv();
  if (!Ajv) return null;
  const ajv = new Ajv({ allErrors: true, strict: false });
  const files = ['agent-card.schema.json', 'message.schema.json', 'task.schema.json'];
  for (const f of files) {
    const abs = path.join(A2A_CONTRACTS, f);
    const raw = readSource(abs);
    if (raw === null) return { missing: f };
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return { parseError: `${f}: ${e.message}` };
    }
    ajv.addSchema(parsed, f);
  }
  return { ajv };
}

function validateAgainst(ajv, schemaKey, data) {
  const validate = ajv.getSchema(schemaKey);
  if (!validate) return `schema 未加载: ${schemaKey}`;
  if (validate(data)) return null;
  return (validate.errors || []).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ');
}

function runA2aChecks(report) {
  const agentCardSpec = require(path.join(A2A_DIR, 'agentCardSpec.js'));
  const taskStateSpec = require(path.join(A2A_DIR, 'taskStateSpec.js'));
  const manifest = require(path.join(A2A_DIR, 'builtinAgentManifest.js'));
  const routeSrc = readSource(path.join(BACKEND_SRC, 'routes', 'wellKnown.js'));
  const serverSrc = readSource(path.join(REPO_ROOT, 'services', 'backend', 'server.js')) || '';

  // ── 1) Agent Card 契约 ────────────────────────────────────────────────
  const built = agentCardSpec.buildAgentCard({
    baseUrl: 'http://127.0.0.1:3000',
    version: '1.2.3',
    name: 'khy-os',
    description: 'test',
    skills: manifest.toSkillSeeds(),
    provider: { organization: 'khy-os' },
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
    security: [{ bearer: [] }],
  });
  const shape = agentCardSpec.validateCardShape(built.card);
  record('a2a', 'agent-card-shape', shape.ok, shape.ok ? '' : shape.errors.join('; '));

  const ajvBundle = buildAjvWithA2aSchemas();
  if (!ajvBundle || ajvBundle.missing || ajvBundle.parseError) {
    record('a2a', 'a2a-schemas-loaded', false,
      ajvBundle && ajvBundle.missing
        ? `缺契约 schema: ${ajvBundle.missing}`
        : ajvBundle && ajvBundle.parseError
          ? ajvBundle.parseError
          : 'ajv 不可用 —— 运行 npm install ajv');
  } else {
    record('a2a', 'a2a-schemas-loaded', true, '');
    const { ajv } = ajvBundle;
    const cardErr = validateAgainst(ajv, 'agent-card.schema.json', built.card);
    record('a2a', 'agent-card-schema', !cardErr, cardErr || '');

    // 反面断言：缺 protocolVersion 的卡片必须被 schema 拒（防 schema 被放宽成空壳）
    const { protocolVersion, ...noProto } = built.card;
    void protocolVersion;
    const noProtoErr = validateAgainst(ajv, 'agent-card.schema.json', noProto);
    record('a2a', 'agent-card-schema-rejects-missing-protocolVersion', !!noProtoErr,
      noProtoErr ? '' : 'schema 过宽：缺 protocolVersion 也通过了');

    // Message / Part 契约
    const validMsg = {
      kind: 'message',
      role: 'user',
      messageId: 'msg-1',
      parts: [{ kind: 'text', text: 'hello' }],
    };
    const msgErr = validateAgainst(ajv, 'message.schema.json', validMsg);
    record('a2a', 'message-schema:valid-text', !msgErr, msgErr || '');

    // 回归锁：缺 `kind` 的 Part 必须被拒（a2a/index.js 早期真实缺陷）
    const badPart = {
      kind: 'message',
      role: 'user',
      messageId: 'msg-2',
      parts: [{ text: 'hello' }],
    };
    const badPartErr = validateAgainst(ajv, 'message.schema.json', badPart);
    record('a2a', 'message-schema:rejects-part-without-kind', !!badPartErr,
      badPartErr ? '' : 'schema 未拦住缺 kind 的 Part —— 这正是历史缺陷');

    for (const part of [
      { kind: 'file', file: { name: 'a.txt', mimeType: 'text/plain', bytes: 'AAAA' } },
      { kind: 'file', file: { uri: 'https://example.invalid/a.txt' } },
      { kind: 'data', data: { a: 1 } },
    ]) {
      const e = validateAgainst(ajv, 'message.schema.json',
        { kind: 'message', role: 'agent', messageId: 'm', parts: [part] });
      record('a2a', `message-schema:valid-${part.kind}`, !e, e || '');
    }

    // Task 契约：每个规范状态都必须被接受
    for (const state of taskStateSpec.A2A_TASK_STATES) {
      const e = validateAgainst(ajv, 'task.schema.json', {
        kind: 'task',
        id: 't1',
        contextId: 'c1',
        status: { state, timestamp: '2026-09-15T00:00:00.000Z' },
      });
      record('a2a', `task-schema:accepts-state:${state}`, !e, e || '');
    }
    // 反面断言：私有状态集里的词必须被拒（证明状态集确实是封闭的）
    const privateErr = validateAgainst(ajv, 'task.schema.json', {
      kind: 'task', id: 't1', contextId: 'c1', status: { state: 'spawning' },
    });
    record('a2a', 'task-schema:rejects-private-state:spawning', !!privateErr,
      privateErr ? '' : 'schema 接受了私有状态 spawning —— 状态集被放大');
  }

  // ── 2) TaskState 映射完备性 ───────────────────────────────────────────
  const unmapped = taskStateSpec.unmappedKnownStates();
  record('a2a', 'task-state-mapping-complete', unmapped.length === 0,
    unmapped.length ? `内部状态未映射: ${unmapped.join(', ')}` : '');
  const badTargets = taskStateSpec.invalidMappingTargets();
  record('a2a', 'task-state-mapping-targets-valid', badTargets.length === 0,
    badTargets.length ? `映射目标非法: ${JSON.stringify(badTargets)}` : '');

  // 状态集必须与 schema enum 完全一致
  const taskSchema = JSON.parse(readSource(path.join(A2A_CONTRACTS, 'task.schema.json')) || '{}');
  const schemaStates = (taskSchema.definitions && taskSchema.definitions.TaskState
    && taskSchema.definitions.TaskState.enum) || [];
  const same =
    schemaStates.length === taskStateSpec.A2A_TASK_STATES.length &&
    schemaStates.every((s, i) => s === taskStateSpec.A2A_TASK_STATES[i]);
  record('a2a', 'task-state-set-matches-schema', same,
    same ? '' : `代码状态集 ${JSON.stringify(taskStateSpec.A2A_TASK_STATES)} != schema ${JSON.stringify(schemaStates)}`);

  // 终态不得有出边
  for (const t of taskStateSpec.TERMINAL_TASK_STATES) {
    const out = taskStateSpec.ALLOWED_TRANSITIONS[t] || [];
    record('a2a', `terminal-no-outgoing:${t}`, out.length === 0,
      out.length ? `${t} 有出边 ${JSON.stringify(out)}` : '');
    record('a2a', `terminal-rejects-transition:${t}->working`, taskStateSpec.canTransition(t, 'working') === false,
      taskStateSpec.canTransition(t, 'working') ? `${t} 允许迁到 working` : '');
  }
  record('a2a', 'same-state-idempotent', taskStateSpec.canTransition('working', 'working') === true, '');
  record('a2a', 'unknown-state-rejected', taskStateSpec.canTransition('nope', 'working') === false, '');

  // ── 3) 能力诚实性（卡片声明的每个 true 都必须在代码里确有其事）──────────
  const caps = agentCardSpec.IMPLEMENTED_CAPABILITIES;
  const streamingEvidence = /TaskStatusUpdateEvent|TaskArtifactUpdateEvent/.test(
    readSource(path.join(A2A_DIR, 'index.js')) || ''
  );
  record('a2a', 'capability-honesty:streaming', caps.streaming === streamingEvidence,
    caps.streaming === streamingEvidence
      ? ''
      : `capabilities.streaming=${caps.streaming}，但代码中${streamingEvidence ? '有' : '无'}流式事件实现`);
  record('a2a', 'capability-honesty:pushNotifications', caps.pushNotifications === false,
    caps.pushNotifications ? '声明了 pushNotifications 但无 tasks/pushNotificationConfig 实现' : '');
  record('a2a', 'capability-honesty:stateTransitionHistory', caps.stateTransitionHistory === false,
    caps.stateTransitionHistory ? '声明了 stateTransitionHistory 但 tasks/get 未回历史' : '');

  // ── 4) 服务端发现端点 ─────────────────────────────────────────────────
  record('a2a', 'agent-card-route-exists', routeSrc !== null, routeSrc === null ? '缺 routes/wellKnown.js' : '');
  record('a2a', 'agent-card-route-path',
    !!routeSrc && /agent-card\.json/.test(routeSrc),
    routeSrc && /agent-card\.json/.test(routeSrc) ? '' : '路由未挂 /.well-known/agent-card.json');
  record('a2a', 'agent-card-route-mounted',
    /\.well-known/.test(serverSrc) && /wellKnown/.test(serverSrc),
    /\.well-known/.test(serverSrc) ? '' : 'server.js 未挂载 /.well-known 路由');
  record('a2a', 'legacy-agent-json-default-off',
    !!routeSrc && /KHY_A2A_LEGACY_AGENT_JSON/.test(routeSrc),
    routeSrc && /KHY_A2A_LEGACY_AGENT_JSON/.test(routeSrc) ? '' : '历史 agent.json 未做显式开关');

  // ── 5) 标准方法集完整性（对照 A2A v0.3.0 最低要求）────────────────────
  const a2aModule = require(path.join(A2A_DIR, 'index.js'));
  for (const fn of ['getAgentCard', 'sendMessage', 'getTask', 'cancelTask']) {
    record('a2a', `client-op:${fn}`, typeof a2aModule[fn] === 'function',
      typeof a2aModule[fn] === 'function' ? '' : `services/a2a/index.js 未导出 ${fn}`);
  }
  const indexSrc = readSource(path.join(A2A_DIR, 'index.js')) || '';
  record('a2a', 'part-carries-kind', /kind:\s*'text'/.test(indexSrc),
    /kind:\s*'text'/.test(indexSrc) ? '' : 'sendMessage 的 Part 缺 kind 判别字段');
  record('a2a', 'cancel-uses-spec-path', /:cancel/.test(indexSrc),
    /:cancel/.test(indexSrc) ? '' : 'cancelTask 未使用 tasks/{id}:cancel 路径');
  record('a2a', 'no-nonstandard-tasks-post', !/'\/v1\/tasks',\s*'POST'/.test(indexSrc),
    /'\/v1\/tasks',\s*'POST'/.test(indexSrc) ? '仍存在非标准的 POST /v1/tasks 私有扩展' : '');

  // ── 5.5) 服务端任务面(S3:message/send、tasks/get、tasks/cancel)──────────
  const a2aServerSrc = readSource(path.join(A2A_DIR, 'serverMethods.js')) || '';
  const a2aRouteSrc = readSource(path.join(BACKEND_SRC, 'routes', 'a2a.js')) || '';
  record('a2a', 'a2a-server-methods-exist',
    /messageSend/.test(a2aServerSrc) && /tasksGet/.test(a2aServerSrc) && /tasksCancel/.test(a2aServerSrc),
    /messageSend/.test(a2aServerSrc)
      ? ''
      : 'services/a2a/serverMethods.js 未导出 messageSend/tasksGet/tasksCancel');
  record('a2a', 'a2a-server-routes-exist',
    /message:send/.test(a2aRouteSrc) && /tasks\//.test(a2aRouteSrc) && /:cancel/.test(a2aRouteSrc),
    /message:send/.test(a2aRouteSrc)
      ? ''
      : 'routes/a2a.js 未挂载标准 REST 绑定(message:send / tasks/:id / :cancel)');
  record('a2a', 'a2a-server-mounted',
    /\/v1/.test(serverSrc) && /routes\/a2a/.test(serverSrc),
    /\/v1/.test(serverSrc) ? '' : 'server.js 未挂载 A2A 服务端任务面路由(/v1)');

  // ── 6) 内置 agent 清单一致性 ──────────────────────────────────────────
  const manifestIssues = manifest.validateManifest();
  record('a2a', 'builtin-agent-manifest-valid', manifestIssues.length === 0, manifestIssues.join('; '));
  const facadeSrc = readSource(path.join(BACKEND_SRC, 'services', 'a2aFacade.js')) || '';
  record('a2a', 'facade-uses-manifest-single-source',
    /require\('\.\/a2a\/builtinAgentManifest'\)/.test(facadeSrc) && !/const builtinAgents = \[/.test(facadeSrc),
    'a2aFacade.js 仍内联自己的 agent 清单（两份会漂移）');

  report.a2a = {
    taskStates: taskStateSpec.A2A_TASK_STATES.length,
    capabilities: caps,
    skills: manifest.toSkillSeeds().length,
  };
}

// ══════════════════════════════════════════════════════════════════════════
// main
// ══════════════════════════════════════════════════════════════════════════

const report = {};

try {
  if (runMcp) runMcpChecks(report);
  if (runA2a) runA2aChecks(report);
} catch (e) {
  record('guard', 'uncaught', false, `守卫自身异常: ${e && e.stack ? e.stack : e}`);
}

const failed = checks.filter((c) => !c.ok);

if (jsonOut) {
  console.log(JSON.stringify({
    schema: 'khy.protocol-conformance/v1',
    total: checks.length,
    passed: checks.length - failed.length,
    failed: failed.length,
    failures: failed,
    report,
  }, null, 2));
} else {
  console.log('协议一致性校验（MCP + A2A）');
  console.log('='.repeat(72));
  let currentScope = null;
  for (const c of checks) {
    if (c.scope !== currentScope) {
      currentScope = c.scope;
      console.log(`\n[${currentScope.toUpperCase()}]`);
    }
    const mark = c.ok ? 'PASS' : 'FAIL';
    console.log(`  [${mark}] ${c.id}${c.ok || !c.message ? '' : `\n         ${c.message}`}`);
  }
  console.log('\n' + '='.repeat(72));
  console.log(`结果: ${checks.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length) {
    console.log('\n失败项（声明与实现不一致）：');
    for (const c of failed) console.log(`  - [${c.scope}] ${c.id}: ${c.message}`);
  }
}

process.exit(failed.length > 0 ? 1 : 0);

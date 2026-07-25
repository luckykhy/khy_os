'use strict';

/**
 * mcpServer.js — 薄 IO:传输无关的 khy MCP server 引擎。
 *
 * 职责:把「一条已收到的 message(字符串或已解析对象)」变成「一条 response(或 null=无回包)」,
 * 与传输(stdio / HTTP / SSE)完全解耦。协议构形与派发全走纯叶子 mcpServerProtocol;暴露策略走
 * 纯叶子 mcpServeToolPolicy;工具枚举/执行走既有 tools/index(getEnabled + 权限门控 execute)。
 *
 * 为什么不是纯叶子:它 require registry 且经 execute 触发真实副作用(工具执行),故**不进** leaf
 * 守卫。但它极薄——所有可确定性验证的逻辑(解析/构形/派发/策略)都在两个纯叶子里,本文件只做
 * 「注入 handlers + try/catch 兜底」,可用假 registry 注入驱动单测(见 mcpServer.test.js)。
 *
 * 安全红线:tools/call 走 tools/index.execute → toolCalling.executeTool 的**同一条**权限门控
 * (--allowedTools / 风险闸),MCP 客户端与本地模型调工具无差别,不开后门。
 */

const protocol = require('./mcpServerProtocol');
const policy = require('./mcpServeToolPolicy');

/**
 * 创建一个传输无关的 server 核心。
 *
 * @param {object} [opts]
 * @param {string} [opts.version] - 注入 serverInfo 的版本号(调用方从 package.json 读)。
 * @param {object} [opts.env] - 门控/策略读取的环境(缺省 process.env)。
 * @param {object} [opts.registry] - 工具源(测试可注入假 registry);缺省 require('../../tools')。
 *                                   需实现 loadTools()、getEnabled():Map、execute(name,params,ctx)。
 * @param {object} [opts.context] - tools/call 透传给 execute 的执行上下文。
 * @returns {{ handleMessage(line: string|object): Promise<object|null> }}
 */
function createServerCore(opts = {}) {
  const version = opts.version;
  const env = opts.env || process.env;
  const context = opts.context || {};
  // 延迟 require,避免 registry 在纯逻辑测试里被强制加载。
  const registry = opts.registry || require('../../tools');

  /**
   * 当前暴露的工具数组(每次调用实时枚举 → 尊重工具的 isEnabled 动态门控)。
   * @returns {Array<object>}
   */
  function exposedTools() {
    if (typeof registry.loadTools === 'function') registry.loadTools();
    const enabled = typeof registry.getEnabled === 'function' ? registry.getEnabled() : new Map();
    const arr = enabled instanceof Map ? [...enabled.values()] : (Array.isArray(enabled) ? enabled : []);
    return policy.selectExposedTools(arr, policy.resolveExposeMode(env));
  }

  // ── handlers 表:method → async fn(params) → result(注入给 protocol.dispatch)──
  const handlers = {
    async initialize() {
      return protocol.buildInitializeResult({ version });
    },
    async ping() {
      return {};
    },
    'tools/list': async function toolsList() {
      const tools = exposedTools().map((t) => protocol.toolDefToMcp(t.toFunctionDef()));
      return { tools };
    },
    'tools/call': async function toolsCall(params) {
      const p = params && typeof params === 'object' ? params : {};
      const name = typeof p.name === 'string' ? p.name : '';
      const args = p.arguments && typeof p.arguments === 'object' ? p.arguments : {};
      // 只允许调用当前暴露集内的工具(不在集内 → 视为不存在,不泄露隐藏工具)。
      const exposed = exposedTools();
      const found = exposed.some((t) => t && t.name === name);
      if (!found) {
        // 抛给 dispatch 外层的 handleMessage 兜底会变 -32603;这里主动返回 invalid-params 更贴切。
        const err = new Error(`tool not exposed: ${name}`);
        err.__mcpCode = protocol.ERROR_CODES.INVALID_PARAMS;
        throw err;
      }
      // 走权限门控派发器(与本地模型调工具同一条闸)。
      const result = await registry.execute(name, args, context);
      return protocol.toolResultToMcp(result);
    },
  };

  /**
   * 处理一条入站消息:解析 → 派发 → 回包。全程绝不因单条坏消息崩。
   * @param {string|object} line - 原始文本行,或已解析的消息对象(HTTP body)。
   * @returns {Promise<object|null>} 回包对象;通知 → null。
   */
  async function handleMessage(line) {
    let parsed;
    if (line && typeof line === 'object') {
      // HTTP body 已是对象 → 借 parseMessage 归一(经 JSON.stringify 往返以复用同一套语义)。
      parsed = protocol.parseMessage(JSON.stringify(line));
    } else {
      parsed = protocol.parseMessage(line);
    }
    if (!parsed.ok) {
      return protocol.buildError(null, protocol.ERROR_CODES.PARSE_ERROR, parsed.error);
    }
    try {
      return await protocol.dispatch(parsed, handlers);
    } catch (err) {
      const code = err && err.__mcpCode !== undefined ? err.__mcpCode : protocol.ERROR_CODES.INTERNAL_ERROR;
      const message = err && err.message ? err.message : 'internal error';
      return protocol.buildError(parsed.id, code, message);
    }
  }

  return { handleMessage, exposedTools };
}

module.exports = { createServerCore };

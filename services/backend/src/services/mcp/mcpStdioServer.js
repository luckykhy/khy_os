'use strict';

/**
 * mcpStdioServer.js — 薄 IO:stdio 传输的 khy MCP server。
 *
 * 镜像 client 侧 stdio 框架(services/mcp/index.js:349 读行、:749 写行 `+'\n'`),方向反过来:
 * 从 **stdin** 逐行读入站 JSON-RPC,经 mcpServer 引擎处理,把回包 `JSON.stringify(resp)+'\n'` 写到
 * **stdout**。这是 Claude Desktop / CC 注册 `{ "command":"khy", "args":["mcp","serve"] }` 时用的形态。
 *
 * stdout 红线:MCP 客户端把 stdout 当纯 JSON-RPC 流,任何杂质(日志/横幅/print)都会破坏协议。
 * 故:①设哨兵 process.env.KHY_MCP_SERVE_STDIO='1'(下游若尊重可自我静默);②所有诊断/横幅一律
 * process.stderr.write,绝不用 console.log / formatters。
 */

const readline = require('readline');
const { createServerCore } = require('./mcpServer');
const policy = require('./mcpServeToolPolicy');

/**
 * 启动 stdio server(常驻,直到 stdin 关闭)。
 * @param {object} [opts]
 * @param {string} [opts.version]
 * @param {object} [opts.env]
 * @param {NodeJS.ReadableStream} [opts.input] - 测试可注入;缺省 process.stdin。
 * @param {NodeJS.WritableStream} [opts.output] - 测试可注入;缺省 process.stdout。
 * @param {NodeJS.WritableStream} [opts.errOutput] - 缺省 process.stderr。
 * @returns {{ core: object, rl: readline.Interface, close: Function }}
 */
function startStdioServer(opts = {}) {
  const env = opts.env || process.env;
  const input = opts.input || process.stdin;
  const output = opts.output || process.stdout;
  const errOutput = opts.errOutput || process.stderr;

  // stdout 净化哨兵:告知下游「此进程 stdout 专供 JSON-RPC」。
  try { env.KHY_MCP_SERVE_STDIO = '1'; } catch { /* 只读 env → 忽略 */ }

  const core = createServerCore({ version: opts.version, env, context: opts.context });

  // 启动横幅 → stderr(绝不污染 stdout)。
  try {
    const summary = policy.summarizeExposure(core.exposedTools());
    errOutput.write(
      `khy MCP server (stdio) ready — 暴露 ${summary.total} 个工具(含破坏性: ${summary.hasDestructive ? 'yes' : 'no'})\n`,
    );
  } catch { /* 横幅是 best-effort,绝不因它中断启动 */ }

  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  rl.on('line', async (line) => {
    const trimmed = String(line == null ? '' : line).trim();
    if (!trimmed) return; // 空行忽略
    let resp;
    try {
      resp = await core.handleMessage(trimmed);
    } catch (err) {
      // handleMessage 已内部兜底,这里是双保险;绝不让单条消息杀死循环。
      try { errOutput.write(`khy MCP server: 处理消息出错: ${err && err.message}\n`); } catch { /* ignore */ }
      return;
    }
    if (resp) {
      try { output.write(`${JSON.stringify(resp)}\n`); } catch { /* stdout 关 → 无处可写,忽略 */ }
    }
  });

  const close = () => {
    try { rl.close(); } catch { /* ignore */ }
  };
  rl.on('close', () => {
    try { errOutput.write('khy MCP server (stdio) closed\n'); } catch { /* ignore */ }
  });

  return { core, rl, close };
}

module.exports = { startStdioServer };

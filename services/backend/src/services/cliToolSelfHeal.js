'use strict';

/**
 * cliToolSelfHeal.js — 外部 CLI 工具自愈包装(借鉴 openhands RuntimeClient)。
 *
 * 背景:cliToolAdapter.js 调用外部 CLI 命令(commandcode/opencode/codex/aider 等)
 * 时的失败,当前直接抛裸 Error → 上层(aiGateway)只能「记录 + 降级到下一个适配器」。
 * 实际上,大部分失败有可识别的「环境/工具」病因(ENAMETOOLONG / ENOENT / EACCES /
 * 端口占用 / Python 缺),应该给上层 LLM 一个**可操作的提示**,让它在下一轮
 * 自我修正(commandcode 已用 stdin 时,改为更短 prompt;commandcode 未启用,改用
 * codex;Python 缺,跑 `khy doctor`)。
 *
 * 这个模块提供 classify() 和 buildHealHint() 两个纯函数,**不**修改 cliToolAdapter.js
 * 的执行路径(避免 side effect),而是在 aiGateway 拿到错误后调它增强错误消息。
 *
 * 设计原则:
 *   - 零 IO / 零副作用 / 绝不抛
 *   - 不改原 Error 对象,只返回 {kind, hint, recovery, ...} 描述
 *   - 与 selfHeal/diagnosisDictionary 同源词典,但只覆盖 CLI 工具特有场景
 *   - KHY_CLI_TOOL_SELF_HEAL 默认开(0/false/off/no 关 → 逐字节回退无增强)
 */

const OFF_VALUES = new Set(['0', 'false', 'off', 'no', 'disable', 'disabled']);

/** 门控 */
function isCliToolSelfHealEnabled(env = process.env) {
  try {
    const e = env || process.env;
    const v = e && e.KHY_CLI_TOOL_SELF_HEAL;
    if (v === undefined || v === null || v === '') {
      return true;
    }
    return !OFF_VALUES.has(String(v).trim().toLowerCase());
  } catch {
    return true;
  }
}

/**
 * 错误信息抽取。兼容 Error / plain object / string。
 * @param {*} e
 * @returns {string}
 */
function _extractText(e) {
  if (!e) return '';
  if (typeof e === 'string') return e;
  if (e.message) return String(e.message);
  if (e.error) return String(e.error);
  if (e.stderr) return String(e.stderr);
  try {
    return String(e);
  } catch {
    return '';
  }
}

/**
 * 错误码抽取(优先 errno / code, 退到 statusCode)。
 */
function _extractCode(e) {
  if (!e) return null;
  if (e.code) return String(e.code);
  if (e.errno) return String(e.errno);
  if (e.statusCode) return Number(e.statusCode);
  return null;
}

/**
 * 命中的「环境/工具」病因诊断条目。形如:
 *   {
 *     id,                  稳定标识
 *     kind,                'env' | 'tool' | 'encoding' | 'permission' | 'unknown'
 *     test(text, code, ctx),  命中判定
 *     recover,             恢复建议(给 LLM 看的中文短句)
 *     runnable,            LLM 应当立即跑的修复命令(来自受控表,防注入)
 *   }
 */
const CLI_TOOL_ENTRIES = [
  // ── env:环境缺失 ──────────────────────────────────────────────
  {
    id: 'cmdline-too-long',
    kind: 'env',
    test: (t) => /command line is too long|ENAMETOOLONG/i.test(t),
    recover:
      '当前命令行的总长度超过 Windows 上限(~32KB)。请改用更短的系统提示,或拆分为多轮调用。',
    runnable: 'khy ai --short-prompt "..."',
  },
  {
    id: 'python-not-found',
    kind: 'env',
    test: (t) => /python.*not found|'\bpython\b'.*not recognized|cannot find.*python/i.test(t),
    recover: 'Python 解释器不可用。如需 Python 工具,请安装 Python 3.8+ 或使用 khy 内置的 Node.js 工具替代。',
    runnable: 'khy doctor --check python',
  },
  {
    id: 'node-not-found',
    kind: 'env',
    test: (t) => /node.*not found|'\bnode\b'.*not recognized|cannot find module 'node:'/i.test(t),
    recover: 'Node.js 不可用。khy 的 CLI 启动器已探测但 PATH 找不到;请设置 KHY_NODE_PATH 或安装 Node 20+。',
    runnable: 'khy doctor --check node',
  },
  {
    id: 'git-not-found',
    kind: 'env',
    test: (t) => /git.*not found|'\bgit\b'.*not recognized|fatal: not a git repository/i.test(t),
    recover: 'git 不可用或当前目录不是 git 仓库。涉及 git 历史/commit/push 的工具将失败。',
    runnable: 'khy doctor --check git',
  },
  {
    id: 'ripgrep-not-found',
    kind: 'env',
    test: (t) => /\brg\b.*not found|ripgrep.*not.*available/i.test(t),
    recover: 'ripgrep 不可用。grep 工具会自动降级到 Node.js 内置搜索(慢但可用)。',
    runnable: null,
  },

  // ── tool:工具失败 / 不可用 ─────────────────────────────────────
  {
    id: 'cli-not-installed',
    kind: 'tool',
    test: (t, code) =>
      code === 'ENOENT' ||
      /\b(claude|codex|aider|cmdc|cmdcode|opencode|openclaw)\b.*(not found|not recognized)/i.test(t) ||
      /'\b(cmds?)\b' is not recognized/i.test(t),
    recover:
      '外部 CLI 工具不可用。请检查 PATH 或运行 `khy gateway status` 确认已安装并加入 PATH。',
    runnable: 'khy gateway status',
  },
  {
    id: 'cli-auth-missing',
    kind: 'tool',
    test: (t) => /\b(api key|api_key|apikey|auth.?token|authorization)\b.*(missing|not set|empty|invalid|expired)/i.test(t) ||
      /401|403/.test(t),
    recover: '外部工具的 API key 缺失或失效。检查 .env / khyquant/config.json 中的 key 配置。',
    runnable: 'khy config show',
  },
  {
    id: 'cli-econnrefused',
    kind: 'tool',
    test: (t, code) => code === 'ECONNREFUSED' || /econnrefused|connect ECONNREFUSED/i.test(t),
    recover: '本地服务拒绝连接。检查 localhost 上是否有服务在跑(端口是否被占用或服务未启动)。',
    runnable: 'netstat -an | findstr :PORT',
  },
  {
    id: 'cli-port-in-use',
    kind: 'tool',
    test: (t) => /EADDRINUSE|port.*already in use|listening.*already/i.test(t),
    recover: '目标端口已被占用。改用 KHY_BACKEND_PORT=<其他端口> 重启,或在系统设置中关闭占用的进程。',
    runnable: null,
  },
  {
    id: 'cli-permission-denied',
    kind: 'tool',
    test: (t, code) => code === 'EACCES' || /EACCES|permission denied|operation not permitted/i.test(t),
    recover: '权限被拒。检查文件/目录的所有权与权限,或以管理员身份运行。',
    runnable: null,
  },

  // ── encoding:编码错误 ──────────────────────────────────────────
  {
    id: 'cli-utf8-decode',
    kind: 'encoding',
    test: (t) => /invalid utf-8|unexpected.*byte|encoding.*invalid/i.test(t),
    recover: '输出含非 UTF-8 字节。khy 会自动回退到 latin1 解码,但若有中文/Emoji 错误信息请告知。',
    runnable: null,
  },
  {
    id: 'cli-json-parse',
    kind: 'encoding',
    test: (t) => /JSON\.parse|syntaxerror|unexpected.*token.*in json/i.test(t),
    recover: '上游返回了非 JSON 格式内容。可能是流被截断或模型输出未完整。',
    runnable: null,
  },
  {
    id: 'cli-idle-timeout',
    kind: 'encoding',
    test: (t) => /idle timeout.*without.*output|idle timeout.*without subprocess output/i.test(t),
    recover:
      '子进程超过空闲超时无输出。可能上游响应慢或网络抖动。可用 GATEWAY_CLI_TOOL_IDLE_TIMEOUT_MS 调高,或换用其他通道。',
    runnable: 'khy gateway status',
  },
  {
    id: 'cli-hard-timeout',
    kind: 'encoding',
    test: (t) => /hard timeout.*\(\d+ms\)/i.test(t),
    recover:
      '网关级硬超时。已触达任务规模保守上界。短任务可等冷却;长任务用 KHY_GATEWAY_HARD_TIMEOUT_MS 显式调大。',
    runnable: 'khy gateway status',
  },
];

/**
 * 分类 CLI 工具失败。返回首个命中;不命中返回 {kind: 'unknown'}。
 * @param {Error|object|string} e
 * @returns {{
 *   id: string,
 *   kind: 'env' | 'tool' | 'encoding' | 'permission' | 'unknown',
 *   text: string,
 *   code: string|null,
 *   recover: string,
 *   runnable: string|null,
 * }}
 */
function classify(e) {
  try {
    const text = _extractText(e);
    const code = _extractCode(e);
    for (const entry of CLI_TOOL_ENTRIES) {
      try {
        if (entry.test(text, code, e)) {
          return {
            id: entry.id,
            kind: entry.kind,
            text,
            code,
            recover: entry.recover,
            runnable: entry.runnable,
          };
        }
      } catch {
        /* 单条 test 失败 → 跳过 */
      }
    }
    return { id: 'unknown', kind: 'unknown', text, code, recover: '', runnable: null };
  } catch {
    return { id: 'unknown', kind: 'unknown', text: '', code: null, recover: '', runnable: null };
  }
}

/**
 * 给 LLM 自检输入的格式化诊断行。注入到工具结果 error 字段前,
 * 让下一轮 chat() 知道具体病因。
 * @param {Error|object|string} e
 * @param {object} [opts]
 * @param {string} [opts.toolName] 工具名(给 LLM 上下文)
 * @returns {string} 多行诊断(空字符串 = 关闭 / 不识别)
 */
function buildHealHint(e, opts = {}) {
  try {
    if (!isCliToolSelfHealEnabled()) return '';
    const c = classify(e);
    if (c.kind === 'unknown') return '';
    const lines = [
      `[自愈提示:khy 识别到 ${opts.toolName || '外部工具'} 调用失败属于「${_kindToChinese(c.kind)}」类]`,
      `病因:${c.recover}`,
    ];
    if (c.runnable) {
      lines.push(`建议执行:${c.runnable}`);
    }
    return lines.join('\n');
  } catch {
    return '';
  }
}

function _kindToChinese(kind) {
  switch (kind) {
    case 'env':
      return '环境缺失';
    case 'tool':
      return '工具不可用';
    case 'encoding':
      return '编码/超时';
    case 'permission':
      return '权限拒绝';
    default:
      return '未识别';
  }
}

/** 列出所有诊断条目 id(可观测) */
function listDiagnoses() {
  return CLI_TOOL_ENTRIES.map((e) => ({ id: e.id, kind: e.kind }));
}

module.exports = {
  isCliToolSelfHealEnabled,
  classify,
  buildHealHint,
  listDiagnoses,
  // 测试用
  _extractText,
  _extractCode,
};

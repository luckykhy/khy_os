'use strict';

/**
 * Tool call parsing — 7 format parser for extracting tool calls
 * from AI response text.
 *
 * Extracted from toolUseLoop.js (lines 89-509) as part of the
 * industrial-grade modularization (Phase 1G).
 *
 * Dependencies: claudeCompat.normalizeToolCall, gateway/safeJsonParse.
 */

const { normalizeToolCall } = require('../claudeCompat');

// ── Constants ────────────────────────────────────────────────────────

const NATURAL_ACTION_TO_TOOL = {
  搜索: 'web_search',
  search: 'web_search',
  websearch: 'web_search',
  web_search: 'web_search',
  查找: 'search',
  行情: 'quote',
  quote: 'quote',
  报价: 'quote',
  价格: 'quote',
  回测: 'backtest',
  backtest: 'backtest',
  构建: 'build_project',
  build: 'build_project',
  编译: 'build_project',
  测试: 'run_tests',
  test: 'run_tests',
  lint: 'lint_code',
  检查: 'lint_code',
  代码检查: 'lint_code',
  验证: 'verify_artifact',
  verify: 'verify_artifact',
  交付验证: 'verify_artifact',
  k线: 'data_fetch',
  K线: 'data_fetch',
  kline: 'data_fetch',
  k线查询: 'data_fetch',
  策略列表: 'strategy_list',
  strategylist: 'strategy_list',
  strategy_list: 'strategy_list',
  读取文件: 'read_file',
  读文件: 'read_file',
  readfile: 'read_file',
  read_file: 'read_file',
  写入文件: 'write_file',
  writefile: 'write_file',
  write_file: 'write_file',
  创建项目: 'scaffoldFiles',
  项目脚手架: 'scaffoldFiles',
  脚手架: 'scaffoldFiles',
  目录结构: 'scaffoldFiles',
  批量创建: 'scaffoldFiles',
  并行写入: 'scaffoldFiles',
  scaffold: 'scaffoldFiles',
  scaffold_files: 'scaffoldFiles',
  project_scaffold: 'scaffoldFiles',
  命令: 'shell_command',
  shell: 'shell_command',
  bash: 'shell_command',
  shellcommand: 'shell_command',
  shell_command: 'shell_command',
  打开应用: 'open_app',
  启动应用: 'open_app',
  打开程序: 'open_app',
  openapp: 'open_app',
  open_app: 'open_app',
  应用: 'open_app',
  浏览器: 'open_app',
  git状态: 'git_status',
  gitstatus: 'git_status',
  git_status: 'git_status',
  git差异: 'git_diff',
  gitdiff: 'git_diff',
  git_diff: 'git_diff',
  文件搜索: 'glob',
  glob: 'glob',
  find: 'glob',
  find_files: 'glob',
  内容搜索: 'grep',
  grep: 'grep',
  rg: 'grep',
  search_content: 'grep',
  编辑: 'editFile',
  edit: 'editFile',
  修改文件: 'editFile',
  edit_file: 'editFile',
  replace: 'editFile',
  网页还原: 'image2web',
  图转网页: 'image2web',
  截图还原: 'image2web',
  截图转网页: 'image2web',
  image2web: 'image2web',
  image_to_web: 'image2web',
  screenshot_to_html: 'image2web',
};

// ── Helpers ──────────────────────────────────────────────────────────

// 收敛到 utils/normalizeAlnumKey 单一真源(逐字节委托,调用点不变)
const normalizeToolKey = require('../../utils/normalizeAlnumKey');

function expandToolNameVariants(name = '') {
  const raw = String(name || '').trim();
  if (!raw) {
    return [];
  }
  const variants = new Set();
  const push = (value) => {
    const text = String(value || '').trim();
    if (!text) {
      return;
    }
    variants.add(text);
    variants.add(text.toLowerCase());
    variants.add(normalizeToolKey(text));
  };

  push(raw);
  push(raw.replace(/[\s-]+/g, '_'));
  push(raw.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase());
  push(raw.replace(/_([a-z])/g, (_, c) => c.toUpperCase()));

  try {
    const normalized = normalizeToolCall(raw, {});
    if (normalized?.name) {
      push(normalized.name);
    }
  } catch {
    /* best effort */
  }

  return [...variants].filter(Boolean);
}

function canonicalizeToolCall(call) {
  if (!call || call.legacy) {
    return call;
  }
  try {
    let rawName = String(call.name || '');
    let rawParams = call.params || {};
    const fnLike = rawName.match(/^([A-Za-z_][\w-]*)\s*\(([\s\S]*)\)$/);
    if (fnLike) {
      rawName = fnLike[1];
      const inlineArg = String(fnLike[2] || '').trim();
      if (inlineArg && Object.keys(rawParams).length === 0) {
        if (/^(shell_command|shellCommand|bash|powershell|cmd|pwsh|sh)$/i.test(rawName)) {
          rawParams = { command: inlineArg };
        } else if (/^(open_app|openApp)$/i.test(rawName)) {
          rawParams = { name: inlineArg };
        }
      }
    }
    const normalized = normalizeToolCall(rawName, rawParams);
    if (normalized && normalized.name) {
      return { ...call, name: normalized.name, params: normalized.params || {} };
    }
  } catch {
    /* keep original call */
  }
  return call;
}

function coerceValue(str) {
  if (str === 'true') {
    return true;
  }
  if (str === 'false') {
    return false;
  }
  if (str === 'null') {
    return null;
  }
  const num = Number(str);
  if (!isNaN(num) && str !== '') {
    return num;
  }
  return str;
}

function cleanParams(obj = {}) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== '')
  );
}

function parseLooseKv(argText = '') {
  const out = {};
  const s = String(argText || '').trim();
  if (!s) {
    return out;
  }
  const parts = s.split(/[\s,，]+/).filter(Boolean);
  for (const p of parts) {
    const m = p.match(/^([a-zA-Z_]+)=(.+)$/);
    if (m) {
      out[m[1]] = m[2];
    }
  }
  return out;
}

/**
 * Scan a balanced `{…}` object substring starting at the first `{` at/after
 * `from`, respecting string literals and escapes so braces inside strings do
 * not mislead the depth counter. Returns the exact `{…}` span (so callers can
 * both parse it and know how much text it consumed), or null if no balanced
 * object is present (e.g. truncated output).
 * @param {string} str
 * @param {number} [from]
 * @returns {string|null}
 */
function scanBalancedObject(str, from = 0) {
  const s = String(str || '');
  const start = s.indexOf('{', from);
  if (start < 0) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return s.slice(start, i + 1);
      }
    }
  }
  return null; // unbalanced / truncated
}

/**
 * Scan a balanced `(`…`)` span starting at the first `(` at/after `from`,
 * respecting string literals and escapes so parens inside JSON string values
 * do not mislead the depth counter. Returns the inner content (between the
 * parens, both exclusive) or null when no balanced pair is present (truncated
 * marker). Sibling of scanBalancedObject — used by Format 2e to take a
 * multi-line JSON argument body that the lazy `[^\s\S]` regex truncates at
 * the first `)`.
 * @param {string} str
 * @param {number} [from]
 * @returns {string|null}
 */
function _balancedParenSpan(str, from = 0) {
  const s = String(str || '');
  const start = s.indexOf('(', from);
  if (start < 0) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0) {
        return s.slice(start + 1, i);
      }
    }
  }
  return null; // unbalanced / truncated
}

// ── Function args parsing ────────────────────────────────────────────

function parseFunctionArgs(toolName, argsStr) {
  if (!argsStr) {
    return {};
  }

  try {
    if (argsStr.startsWith('{')) {
      return JSON.parse(argsStr);
    }
  } catch {
    /* fall through */
  }

  // 门控 KHY_TOOLCALL_COLON_KV_ANCHOR(默认开):冒号 KV 键锚定到字段边界(串首/逗号后),
  // 避免值里的 `https:`/`+%H:`/`"fix:` 被误当 KV 键而丢掉真正的 `key=value`/command。门关/异常
  // → 回退 legacy 未锚定正则(逐字节等价)。捕获组编号两者一致,下方解析循环无需改动。
  let kvColonRe;
  try {
    kvColonRe =
      require('./toolCallColonKvAnchor').anchoredColonKvRegex(process.env) ||
      /(\w+)\s*:\s*(?:"([^"]*?)"|'([^']*?)'|([^,)]+))/g;
  } catch {
    kvColonRe = /(\w+)\s*:\s*(?:"([^"]*?)"|'([^']*?)'|([^,)]+))/g;
  }
  let kvMatch;
  const colonParams = {};
  let hasColonPairs = false;
  while ((kvMatch = kvColonRe.exec(argsStr)) !== null) {
    hasColonPairs = true;
    if (kvMatch[2] !== undefined) {
      colonParams[kvMatch[1]] = kvMatch[2];
    } else if (kvMatch[3] !== undefined) {
      colonParams[kvMatch[1]] = kvMatch[3];
    } else {
      colonParams[kvMatch[1]] = coerceValue((kvMatch[4] ?? '').trim());
    }
  }
  if (hasColonPairs) {
    return colonParams;
  }

  // 门控 KHY_TOOLCALL_EQ_KV_GUARD(默认开):`=` 分支只在首个 `=` 左侧是裸标识符键时才进,
  // 避免含 `=` 的裸命令(PowerShell `$x = ...`、`export FOO=bar`、命令里的 `--opt=val`)被误当
  // key=value 切碎、丢掉 command 字段(→ shellCommand 校验 `command is required` → Invalid tool
  // parameters)。门关/异常 → 回退 legacy `argsStr.includes('=')` 判定(逐字节等价)。
  let _enterKvBranch = argsStr.includes('=');
  try {
    const _kv = require('./toolCallEqualsKvGuard').shouldParseAsKvArgs(argsStr, process.env);
    if (_kv === false) {
      _enterKvBranch = false;
    }
  } catch {
    /* fail-soft → legacy includes('=') 判定 */
  }
  if (_enterKvBranch) {
    const params = {};
    // 门控 KHY_TOOLCALL_EQ_KV_SPLIT(默认开):只在「逗号后紧跟 `<key>=`」处切分,值内合法逗号
    // (awk -F,、format:%h,%s、含逗号内容)不再截断参数。门关/异常 → 回退 legacy 全逗号切分(逐字节等价)。
    let pairs;
    try {
      pairs =
        require('./toolCallEqualsKvSplit').splitEqualsKvPairs(argsStr, process.env) ||
        argsStr.split(',').map((s) => s.trim());
    } catch {
      pairs = argsStr.split(',').map((s) => s.trim());
    }
    for (const pair of pairs) {
      const [key, ...rest] = pair.split('=');
      const value = rest
        .join('=')
        .trim()
        .replace(/^["']|["']$/g, '');
      params[key.trim()] = coerceValue(value);
    }
    return params;
  }

  try {
    const toolRegistry = require('../../tools');
    const normalized = normalizeToolCall(toolName, {}).name || toolName;
    const tool = toolRegistry.get(normalized);
    if (tool && tool.inputSchema) {
      const firstRequired = Object.entries(tool.inputSchema).find(([, rule]) => rule.required);
      if (firstRequired) {
        return { [firstRequired[0]]: argsStr.replace(/^["']|["']$/g, '') };
      }
    }
  } catch {
    /* registry not available */
  }

  return { command: argsStr.replace(/^["']|["']$/g, '') };
}

// ── Natural language tool call parsing ────────────────────────────────

function mapNaturalActionToTool(action) {
  const raw = String(action || '').trim();
  if (!raw) {
    return null;
  }
  const key = raw.toLowerCase().replace(/\s+/g, '');
  if (NATURAL_ACTION_TO_TOOL[key]) {
    return NATURAL_ACTION_TO_TOOL[key];
  }
  if (NATURAL_ACTION_TO_TOOL[raw]) {
    return NATURAL_ACTION_TO_TOOL[raw];
  }

  if (/(回测|backtest)/i.test(raw)) {
    return 'backtest';
  }
  if (/(k线|kline|日线|周线|月线|分钟线)/i.test(raw)) {
    return 'data_fetch';
  }
  if (/(策略|strategy)/i.test(raw)) {
    return 'strategy_list';
  }
  if (/(行情|报价|价格|quote|price)/i.test(raw)) {
    return 'quote';
  }
  if (/(搜索|search|web)/i.test(raw)) {
    return 'web_search';
  }
  if (/(读取|read)/i.test(raw)) {
    return 'read_file';
  }
  if (/(写入|write)/i.test(raw)) {
    return 'write_file';
  }
  if (/(脚手架|scaffold|创建项目|项目结构|目录结构|批量创建|并行写入)/i.test(raw)) {
    return 'scaffoldFiles';
  }
  if (/(命令|shell|bash|terminal|cmd)/i.test(raw)) {
    return 'shell_command';
  }
  if (/(打开|启动|运行|应用|程序|浏览器|open|launch|run)/i.test(raw)) {
    return 'open_app';
  }
  if (/(git状态|gitstatus)/i.test(raw)) {
    return 'git_status';
  }
  if (/(git差异|gitdiff)/i.test(raw)) {
    return 'git_diff';
  }
  return null;
}

function buildNaturalToolParams(toolName, argText) {
  const raw = String(argText || '').trim();
  const kv = parseLooseKv(raw);

  if (toolName === 'strategy_list' || toolName === 'git_status') {
    return {};
  }
  if (toolName === 'quote') {
    return cleanParams({ symbol: kv.symbol || kv.code || raw });
  }
  if (toolName === 'backtest') {
    const firstToken = raw.split(/\s+/).filter(Boolean)[0];
    return cleanParams({
      symbol: kv.symbol || kv.code || firstToken || '000300',
      strategy: kv.strategy,
      start: kv.start,
      end: kv.end,
      capital: kv.capital !== undefined ? coerceValue(String(kv.capital)) : undefined,
    });
  }
  if (toolName === 'data_fetch') {
    const parts = raw.split(/\s+/).filter(Boolean);
    return cleanParams({
      symbol: kv.symbol || kv.code || parts[0] || '000001',
      period: kv.period || parts[1],
    });
  }
  if (toolName === 'search') {
    return cleanParams({ keyword: kv.keyword || raw });
  }
  if (toolName === 'web_search') {
    return cleanParams({ query: kv.query || kv.keyword || raw || '最新市场信息' });
  }
  if (toolName === 'read_file') {
    return cleanParams({ path: raw.replace(/^\/+/, '') });
  }
  if (toolName === 'write_file') {
    const [filePath, ...rest] = raw.split('|');
    return cleanParams({ path: (filePath || '').trim(), content: rest.join('|').trim() });
  }
  if (toolName === 'shell_command') {
    return cleanParams({ command: raw });
  }
  if (toolName === 'open_app') {
    return cleanParams({ name: raw || kv.name || kv.app || kv.application });
  }
  if (toolName === 'git_diff') {
    return raw ? cleanParams({ file: raw }) : {};
  }
  return {};
}

function parseNaturalToolCalls(text) {
  if (!text) {
    return [];
  }
  const out = [];
  const src = String(text);

  const matches = [
    ...src.matchAll(/【\s*调用\s*([^：:\]】\n]{1,32})\s*(?:[：:]\s*([^】]*?))?\s*】/g),
  ];
  for (const m of matches) {
    const inCodeBlock = /```/.test(src.slice(Math.max(0, (m.index || 0) - 500), m.index));
    if (inCodeBlock) {
      continue;
    }

    const rawAction = String(m[1] || '').trim();
    const rawArg = String(m[2] || '').trim();
    const toolName = mapNaturalActionToTool(rawAction);
    if (!toolName) {
      continue;
    }

    const endIdx = (m.index || 0) + m[0].length;
    const tail = src.slice(endIdx).split('\n')[0].trim();
    const allowTailForActionTool =
      toolName === 'open_app' ||
      toolName === 'shell_command' ||
      toolName === 'write_file' ||
      toolName === 'read_file' ||
      toolName === 'editFile';
    if (!allowTailForActionTool && tail.length > 15 && !/^[，,。.!！?？:：;；\s]*$/.test(tail)) {
      continue;
    }

    const params = buildNaturalToolParams(toolName, rawArg);
    out.push({ name: toolName, params, natural: true, rawAction, rawArg });
  }

  return out;
}

// ── Main parser ──────────────────────────────────────────────────────

/**
 * Parse tool calls from AI response text.
 * Supports: JSON tags, <tool_call>fn(args)</tool_call>, the
 * <function=NAME>BODY</function> dialect (Format 2b, always scanned),
 * natural language, truncated JSON, UI-prefixed, bare tool calls,
 * and truncated bare calls.
 * @param {string} text
 * @param {{disableNaturalLanguage?: boolean}} [opts] disableNaturalLanguage:跳过 Format 3
 *   自然语言档,只认**显式调用语法**(带标签/参数的方言与 wire marker)。供
 *   hasExplicitToolCallSyntax 复用同一条解析路径,避免能力探测另写一套正则而与方言漂移。
 */
function parseToolCalls(text, opts = {}) {
  if (!text) {
    return [];
  }

  const calls = [];
  const { stripExecutionPlan } = require('../deliveryFormatter');

  const _isFakeToolCall = (matchIndex) => {
    const before = text.slice(Math.max(0, matchIndex - 600), matchIndex);
    const backtickCount = (before.match(/```/g) || []).length;
    if (backtickCount % 2 === 1) {
      return true;
    }
    const linePrefix = before.split('\n').pop() || '';
    const inlineBackticks = (linePrefix.match(/`/g) || []).length;
    if (inlineBackticks % 2 === 1) {
      return true;
    }
    if (
      /(?:例如|比如|for example|like|the format|such as|示例|样例)\s*[:：]?\s*$/i.test(linePrefix)
    ) {
      return true;
    }
    return false;
  };

  // Format 1: JSON-style
  const jsonMatches = [...text.matchAll(/<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g)];
  for (const match of jsonMatches) {
    if (_isFakeToolCall(match.index)) {
      continue;
    }
    try {
      const { safeJsonParse } = require('../gateway/safeJsonParse');
      const parsed = safeJsonParse(match[1], null);
      if (parsed && parsed.name) {
        const normalized = normalizeToolCall(parsed.name, parsed.params || parsed.arguments || {});
        // Avoid only true duplicates (same tool + same params) — 与 Format 2/2b 对称。
        // 弱模型在单次 completion 里把整段输出重复两遍(A+A)时,若含 <tool_call>{JSON}</tool_call>
        // 会产生两个逐字相同的调用,落入同一并行批次双双执行(如 local_knowledge 同 query 失败两遍)
        // → 用户看到「搜索过程重复两次」。Format 2/2b 早有此去重,Format 1 缺失属不对称遗漏,此处补齐。
        const sameCallExists = calls.some(
          (c) =>
            c.name === normalized.name &&
            JSON.stringify(c.params || {}) === JSON.stringify(normalized.params || {})
        );
        if (!sameCallExists) {
          calls.push({ name: normalized.name, params: normalized.params });
        }
      }
    } catch {
      /* skip malformed JSON */
    }
  }

  // Format 2: function-call-style
  const funcMatches = [
    ...text.matchAll(/<tool_call>\s*([\w_]+)\s*\(([\s\S]*?)\)\s*<\/tool_call>/g),
  ];
  for (const match of funcMatches) {
    if (_isFakeToolCall(match.index)) {
      continue;
    }
    const rawName = match[1];
    const argsStr = match[2].trim();
    const params = parseFunctionArgs(rawName, argsStr);
    const normalized = normalizeToolCall(rawName, params);
    const sameCallExists = calls.some(
      (c) =>
        c.name === normalized.name &&
        JSON.stringify(c.params || {}) === JSON.stringify(normalized.params || {})
    );
    if (sameCallExists) {
      continue;
    }
    calls.push({ name: normalized.name, params: normalized.params });
  }

  // Format 2b: <function=NAME>BODY</function> dialect (open-model / harmony text channel).
  // Primary format — always scanned (not gated behind calls.length===0). The leaf is the SSOT
  // for locating/splitting these; arg parsing + normalization + fence guard reuse the logic above.
  try {
    const _fnTag = require('../functionTagToolCall');
    for (const tag of _fnTag.extractFunctionTags(text, process.env)) {
      if (_isFakeToolCall(tag.index)) {
        continue;
      }
      // Nested `<parameter=NAME>VALUE</parameter>` dialect first (harmony / open-model),
      // else fall back to parseFunctionArgs for JSON / key:value / bare bodies. Without
      // this, parseFunctionArgs mis-splits `<parameter=pattern>` into a bogus key and
      // leaks the literal tag → `Invalid tool parameters` (goal 2026-07-11 transcript).
      const paramTags = _fnTag.parseParameterTags(tag.argsText);
      const params = paramTags || parseFunctionArgs(tag.name, tag.argsText);
      const normalized = normalizeToolCall(tag.name, params);
      const dup = calls.some(
        (c) =>
          c.name === normalized.name &&
          JSON.stringify(c.params || {}) === JSON.stringify(normalized.params || {})
      );
      if (!dup) {
        calls.push({ name: normalized.name, params: normalized.params });
      }
    }
  } catch {
    /* leaf missing or gate off → byte-revert (dialect simply unparsed) */
  }

  // Format 2d: Claude/Codex 风格 XML 工具方言。
  //    <tool_call>
  //   <Read>
  //   <args>
  //   <file_path>C:\...\x.html</file_path>
  //   </args>
  //   </Read>
  //   [</tool_call>]            ← 缺省外层闭合也认(实测模型直接以 </ToolName> 收尾)
  // 弱模型(实测 sensenova-6.8-flash-lite)按 Claude 语料把工具调用写成嵌套 XML,而不是
  // 被教的 <tool_call>{json}</tool_call>。此前这种调用是惰性文本——Write/Read 从未执行,
  // 只漏出整块裸标签。此处按块解析:参数名=标签名,值=标签内容(保留换行,Write 的 content
  // 是整段 HTML),coerceValue 把 <timeoutMs>5000</timeoutMs> 之类转成数字。围栏教学示例
  // (```html 里讲解格式)由 _isFakeToolCall 排除。始终扫描(主档位,与 Format 1/2/2b 对称)。
  {
    const _xmlToolRe =
      /<tool_call\s*>\s*<([A-Za-z_][\w-]*)\s*>\s*<args\s*>([\s\S]*?)<\/args\s*>\s*<\/\1\s*>(?:\s*<\/tool_call\s*>)?/gi;
    let xm;
    while ((xm = _xmlToolRe.exec(text)) !== null) {
      if (_isFakeToolCall(xm.index)) {
        continue;
      }
      const rawName = xm[1];
      const argsXml = xm[2];
      if (!/<[A-Za-z_][\w-]*\s*>/i.test(argsXml)) {
        continue;
      } // 无参数标签 → 不是工具调用
      const params = {};
      const _paramRe = /<([A-Za-z_][\w-]*)\s*>([\s\S]*?)<\/\1\s*>/gi;
      let pm;
      while ((pm = _paramRe.exec(argsXml)) !== null) {
        params[pm[1]] = coerceValue(String(pm[2] == null ? '' : pm[2]).trim());
      }
      if (Object.keys(params).length === 0) {
        continue;
      }
      const normalized = normalizeToolCall(rawName, params);
      if (!normalized || !normalized.name) {
        continue;
      }
      const dup = calls.some(
        (c) =>
          c.name === normalized.name &&
          JSON.stringify(c.params || {}) === JSON.stringify(normalized.params || {})
      );
      if (!dup) {
        calls.push({ name: normalized.name, params: normalized.params });
      }
    }
  }

  // Format 2e: bracketed wire-marker 工具调用 `[Tool Call: name(args)]`。
  // 网关「剥离 tools 降级为纯文本」的 wire converter(_toolSchemaConverter 的
  // hasTools=false 分支)把历史 tool_use 块内联成 `[Tool Call: name(JSON)]`、
  // tool_result 块内联成 `[Tool Result: id]\n…`。这些 marker 随会话历史回灌给模型后,
  // 文本协议模型会把它当成「工具调用方言」在正文里逐字回显(现场:
  // `[Tool Call: shell_command({})]` 裸露多遍,既没被解析执行、也没被渲染成工具行)。
  // 两个对称动作:
  //   1. 本处把它解析成可执行调用(name 归一 + args JSON/KV 解析),text-protocol 循环
  //      即可真正执行(修「工具没渲染成行」);
  //   2. 渲染漏斗 cli/toolCallNoise 的 `[Tool Call …]` / `[Tool Result …]` 整行剥离
  //      (修「裸露在正文」)。
  // 参数括号体经 _balancedParenSpan 定位(支持多行 JSON 体;`{}` 空参是真实信号——
  // 无参工具确实如此,与 name-JSON 档位的「空对象跳过」不同,那里 header 白名单会误
  // 触发,而 marker 是 converter 的确定性形状)。围栏/示例由 _isFakeToolCall 排除,
  // 与其余主档位对称。始终扫描。
  {
    const _bracketRe = /\[Tool\s+Call:\s*([A-Za-z_][\w.-]{0,40})\s*\(([\s\S]*?)\)\s*\]/gi;
    let bm;
    while ((bm = _bracketRe.exec(text)) !== null) {
      if (_isFakeToolCall(bm.index)) {
        continue;
      }
      const rawName = bm[1];
      const argsStr = String(bm[2] || '').trim();
      let params = {};
      if (argsStr.startsWith('{')) {
        // Multi-line JSON bodies: the regex's lazy `([\s\S]*?)` stops at the FIRST
        // `)`, but a JSON string value can legally contain `)` — take the balanced
        // paren span from the marker's `(` instead.
        const parenStart = _balancedParenSpan(text, bm.index + bm[0].indexOf('('));
        const body =
          parenStart != null ? String(parenStart || '').trim() : argsStr;
        if (body) {
          try {
            const { safeJsonParse } = require('../gateway/safeJsonParse');
            const parsed = safeJsonParse(body, null);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              params = parsed;
            }
          } catch {
            params = parseFunctionArgs(rawName, body);
          }
        }
      } else if (argsStr) {
        params = parseFunctionArgs(rawName, argsStr);
      }
      const normalized = normalizeToolCall(rawName, params);
      if (!normalized || !normalized.name) {
        continue;
      }
      const dup = calls.some(
        (c) =>
          c.name === normalized.name &&
          JSON.stringify(c.params || {}) === JSON.stringify(normalized.params || {})
      );
      if (!dup) {
        calls.push({ name: normalized.name, params: normalized.params });
      }
    }
  }

  // Format 2c: Claude-Code-style "ToolName\n{json args}" dialect.
  // Weak models fine-tuned on Claude Code transcripts emit tool calls as a bare
  // tool-name header line followed by a JSON args object — e.g.
  //     Bash
  //     {"command": "dir C:\\", "timeoutMs": 15000}
  // instead of the taught <tool_call>{...}</tool_call> syntax. None of the other
  // formats catch this (they need <tool_call> tags or ToolName(args) parens), so the
  // call rendered as inert text and never executed. Gated to the calls.length===0
  // fallback tier (only when no tagged/native call was found) + an exact known-tool
  // whitelist + a successful JSON.parse of a balanced object, so prose/examples do
  // not false-trigger. Fence-guarded via _isFakeToolCall (fenced ```Bash blocks and
  // language-less fenced examples are both excluded). Collects every such block.
  if (calls.length === 0) {
    const _HEADER_TOOL =
      /^(bash|shell|shellcommand|shell_command|read|readfile|read_file|write|writefile|write_file|edit|editfile|edit_file|multiedit|grep|glob|ls|websearch|web_search|webfetch|web_fetch|task|notebookedit)$/i;
    const lines = text.split('\n');
    const lineOffsets = [];
    {
      let acc = 0;
      for (const ln of lines) {
        lineOffsets.push(acc);
        acc += ln.length + 1;
      }
    }
    for (let li = 0; li < lines.length - 1; li++) {
      const header = lines[li]
        .replace(/^\s*[>│┃├└╰❯▸›•*#-]+\s*/u, '')
        .replace(/[`*:：\s]+$/u, '')
        .trim();
      if (!_HEADER_TOOL.test(header)) {
        continue;
      }
      // Next non-empty line must open a JSON object.
      let ji = li + 1;
      while (ji < lines.length && lines[ji].trim() === '') {
        ji++;
      }
      if (ji >= lines.length) {
        break;
      }
      const jsonLead = lines[ji].replace(/^\s*[>│┃├└╰❯▸›•]+\s*/u, '').trim();
      if (!jsonLead.startsWith('{')) {
        continue;
      }
      if (_isFakeToolCall(lineOffsets[li])) {
        continue;
      }
      const objStr = scanBalancedObject(lines.slice(ji).join('\n'));
      if (!objStr) {
        continue;
      }
      let parsed;
      try {
        const { safeJsonParse } = require('../gateway/safeJsonParse');
        parsed = safeJsonParse(objStr, null);
      } catch {
        parsed = null;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        continue;
      }
      if (Object.keys(parsed).length === 0) {
        continue;
      }
      const normalized = normalizeToolCall(header, parsed);
      const dup = calls.some(
        (c) =>
          c.name === normalized.name &&
          JSON.stringify(c.params || {}) === JSON.stringify(normalized.params || {})
      );
      if (!dup) {
        calls.push({ name: normalized.name, params: normalized.params });
      }
      // Advance past the consumed JSON block so its interior lines are not rescanned.
      li = ji + objStr.split('\n').length - 1;
    }
  }

  // Format 3: natural-language
  if (calls.length === 0 && !(opts && opts.disableNaturalLanguage)) {
    const naturalSource = stripExecutionPlan(String(text || ''));
    const naturalCalls = parseNaturalToolCalls(naturalSource);
    if (naturalCalls.length > 0) {
      return naturalCalls.map((call) => {
        const normalized = normalizeToolCall(call.name, call.params || {});
        return { ...call, name: normalized.name, params: normalized.params };
      });
    }
  }

  // Format 4: truncated JSON tool_call
  if (calls.length === 0) {
    const truncM = text.match(/<tool_call>\s*(\{[\s\S]*)$/);
    if (truncM && !_isFakeToolCall(truncM.index)) {
      const fragment = truncM[1].trim();
      if (fragment.length > 15 && /"name"\s*:\s*"/.test(fragment)) {
        try {
          const { safeJsonParse } = require('../gateway/safeJsonParse');
          const repaired = safeJsonParse(fragment, null);
          if (repaired && repaired.name) {
            const norm = normalizeToolCall(
              repaired.name,
              repaired.params || repaired.arguments || {}
            );
            calls.push({ name: norm.name, params: norm.params, _repaired: true });
            console.warn('[toolCallParser] Recovered truncated tool call: %s', norm.name);
          }
        } catch {
          /* repair failed */
        }
      }
    }
  }

  // Format 5: UI-prefixed ToolName(args)
  if (calls.length === 0) {
    const prefixedMatches = [...text.matchAll(/[▶⌕◆⏺⎿]\s*([\w_]+)\s*\(([^)]*)\)/g)];
    for (const m of prefixedMatches) {
      if (_isFakeToolCall(m.index)) {
        continue;
      }
      const rawName = m[1];
      const argsStr = m[2].trim();
      const params = argsStr ? parseFunctionArgs(rawName, argsStr) : {};
      const normalized = normalizeToolCall(rawName, params);
      const dup = calls.some(
        (c) =>
          c.name === normalized.name &&
          JSON.stringify(c.params || {}) === JSON.stringify(normalized.params || {})
      );
      if (!dup) {
        calls.push({ name: normalized.name, params: normalized.params });
      }
    }
  }

  // Format 6: bare ToolName(args) on its own line
  if (calls.length === 0) {
    const _KNOWN_BARE_TOOLS =
      /^(bash|shell|sh|command|read|readfile|write|writefile|edit|editfile|grep|rg|glob|find|ls|websearch|webfetch|search|agent|task)$/i;
    const lines = text.split('\n');
    for (let li = 0; li < lines.length; li++) {
      const stripped = lines[li].replace(/^\s*[>│┃├└╰❯▸›•*-]+\s*/u, '').trim();
      if (!stripped) {
        continue;
      }
      const bm = stripped.match(/^([A-Za-z][A-Za-z0-9_]{0,24})\s*\(([\s\S]*)\)\s*$/);
      if (!bm) {
        continue;
      }
      const rawName = bm[1];
      const rawArgs = bm[2].trim();
      if (!_KNOWN_BARE_TOOLS.test(rawName)) {
        continue;
      }
      const textBefore = lines.slice(0, li).join('\n');
      if ((textBefore.match(/```/g) || []).length % 2 === 1) {
        continue;
      }
      const params = rawArgs ? parseFunctionArgs(rawName, rawArgs) : {};
      const normalized = normalizeToolCall(rawName, params);
      const dup = calls.some(
        (c) =>
          c.name === normalized.name &&
          JSON.stringify(c.params || {}) === JSON.stringify(normalized.params || {})
      );
      if (!dup) {
        calls.push({ name: normalized.name, params: normalized.params });
      }
    }
  }

  // Format 7: truncated bare tool call
  if (calls.length === 0) {
    const _KNOWN_TRUNC =
      /^(bash|shell|read|readfile|write|writefile|edit|editfile|grep|glob|find|ls|websearch|webfetch|search)$/i;
    const lastLines = text.split('\n').slice(-5);
    for (const line of lastLines) {
      const stripped = line.replace(/^\s*[>│┃├└╰❯▸›•*-]+\s*/u, '').trim();
      const tm = stripped.match(/^([A-Za-z][A-Za-z0-9_]{0,24})\s*\(([^)]*?)$/);
      if (!tm) {
        continue;
      }
      const rawName = tm[1];
      if (!_KNOWN_TRUNC.test(rawName)) {
        continue;
      }
      const textBefore = text.slice(0, text.lastIndexOf(line));
      if ((textBefore.match(/```/g) || []).length % 2 === 1) {
        continue;
      }
      const argsStr = tm[2].trim();
      const params = argsStr ? parseFunctionArgs(rawName, argsStr) : {};
      const normalized = normalizeToolCall(rawName, params);
      calls.push({ name: normalized.name, params: normalized.params, _repaired: true });
      console.warn('[toolCallParser] Recovered truncated bare tool call: %s', normalized.name);
      break;
    }
  }

  return calls;
}

/**
 * 文本里是否存在**显式调用语法**——模型确实在试图发出一次工具调用,只是走了文本通道。
 *
 * 与 parseToolCalls 的区别只有一个:关掉 Format 3(自然语言)。这条线是为能力探测划的。
 * 探测要回答的问题是「模型会不会发结构化调用」,而一个错误的负面裁决代价很高(该模型的
 * 原生 tools 会被从每个后续请求里删掉,且删掉之后再也观察不到原生调用,判错就锁死)。
 * 所以负向证据的门槛必须高:
 *   - 带标签/括号/JSON 体的方言(Format 1/2/2b/2c/2d/2e/4/7)= 无歧义的调用尝试 → 认;
 *   - 自然语言("我先用 WebSearch 搜一下")= 意图,不是调用尝试。仓库自己就把这层当作
 *     概率检测(见 syntheticToolLayer 的置信度分档),拿它当粘性能力裁决的判据是类别错误。
 * @param {string} text
 * @returns {boolean}
 */
function hasExplicitToolCallSyntax(text) {
  try {
    return parseToolCalls(text, { disableNaturalLanguage: true }).length > 0;
  } catch {
    return false; // 解析器内部异常 → 不下结论(宁可漏认,不可误判)
  }
}

module.exports = {
  parseToolCalls,
  hasExplicitToolCallSyntax,
  parseNaturalToolCalls,
  parseFunctionArgs,
  canonicalizeToolCall,
  normalizeToolKey,
  expandToolNameVariants,
  scanBalancedObject,
  _balancedParenSpan,
  NATURAL_ACTION_TO_TOOL,
};

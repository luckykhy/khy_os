// Context budget for sliding window. Cloud models (Claude, GPT) support 128K+,
// so 64K is a reasonable default.  Local/Ollama models with small context can
// override via KHY_CONTEXT_TOKEN_LIMIT env var.
const CONTEXT_TOKEN_LIMIT = Number(process.env.KHY_CONTEXT_TOKEN_LIMIT) || 131072;
const SUMMARY_MAX_LEN = 400;

const HARDCORE_SYSTEM_PROMPT = `
<Agent id="khy-v5">
You are KHY OS core AI assistant. Respond in Chinese, be concise and direct.
When the user sends a greeting (e.g. "你好"), respond naturally as a friendly assistant and ask how you can help. Do NOT assume the user wants to calculate or perform any specific action.
Current model: {{MODEL_ID}} (via {{ADAPTER}}).
Platform: {{PLATFORM}}.
User home: {{HOME_DIR}}.
Working directory: {{CWD}}.

# Identity and Behavior

You are an expert-level assistant embedded in KHY OS. You help users with:
- Software engineering (code reading, writing, debugging, refactoring)
- System operations (file management, app launching, shell commands)
- General knowledge and reasoning
- Financial data analysis (quotes, K-lines, backtesting, strategies) — only when explicitly requested

## Core Rules
1. Give answers or take actions directly. No filler like "let me help you" or "ok".
2. Think before acting: understand intent → pick right tool → execute → summarize in 1-3 sentences.
3. Same tool + same params = call only once. Answer based on result directly.
4. When unsure, say "not sure, needs verification". Never fabricate information.
5. When asked what model you are, truthfully report {{MODEL_ID}}.
6. On error: diagnose root cause first, then try alternatives. Never repeat the same failing call.
7. When user asks about code, files, or project structure, ALWAYS use Read/Glob/Grep tools first. Never guess file contents or code behavior.
8. Keep answers SHORT and focused: 3-5 sentences for simple questions, at most 10 for complex ones. Use bullet points, not tables. Match Claude Code output style.
9. When user asks you to CREATE a file, you MUST call the Write tool. Reading source code alone is not enough — complete the action.
10. If a Glob/Grep returns 0 results, try a different pattern or broader search before giving up. Never return empty results as a final answer.
11. When user asks you to MODIFY/EDIT a file, you MUST call Read first, then call Edit with exact old_string. Do NOT stop after Read — the modification is the goal.
12. For large files (>500 lines), use Grep to search specific patterns or shellCommand with "wc -l" to count lines. Do NOT Read the entire file — the result will be truncated and you will miss content.
13. To find a specific function/class definition, use Grep with output_mode "content" — NOT Glob (Glob searches file NAMES, not content). Example: to find "normalizeToolResult", use Grep with pattern "function normalizeToolResult" and output_mode "content".
14. When the user explicitly names a tool (e.g., "用 Grep 搜索..."), you MUST use that exact tool. Do NOT substitute with a different tool.
15. To search for text INSIDE files, use Grep. Do NOT Glob then Read each file — that wastes tool calls. Grep is the single right tool for content search.

# Tool Calling

You have access to tools listed in the {{TOOL_LIST}} section below. When you need to use a tool,
output exactly ONE tool call per line in this format:

<tool_call>{"name": "ToolName", "params": {"key": "value"}}</tool_call>

## Tool Call Rules
- Use the EXACT tool names listed in {{TOOL_LIST}} (PascalCase: Read, Write, Edit, Glob, Grep, etc.).
- Output the tool call on its own line, with no text before or after it on that line.
- Wait for the tool result before continuing. Do NOT guess what the result might be.
- NEVER call the same tool with the same parameters twice in one conversation turn.
- You can call multiple different tools in sequence if needed.
- After receiving a tool result, summarize it concisely for the user in 2-5 sentences.
- For executable user requests (read/search/edit/run/test/build/check), you MUST call tools first instead of answering from assumptions.
- NEVER include raw <tool_call> tags in your final answer to the user. Tool calls are for execution only.
- Tool results appear as [Tool:name] prefix in follow-up messages. Use that content to formulate your answer.
- Keep answers SHORT — 3-8 sentences max. Users prefer concise results over verbose explanations.

## Tool Call Examples

Read a file (use "file_path" parameter with absolute path based on {{CWD}}):
<tool_call>{"name": "Read", "params": {"file_path": "{{CWD}}/config.json"}}</tool_call>

Search for files by pattern:
<tool_call>{"name": "Glob", "params": {"pattern": "**/*.js", "path": "{{CWD}}"}}</tool_call>

Search file contents:
<tool_call>{"name": "Grep", "params": {"pattern": "function main", "path": "{{CWD}}/src"}}</tool_call>

Write a new file:
<tool_call>{"name": "Write", "params": {"file_path": "{{CWD}}/hello.txt", "content": "Hello World"}}</tool_call>

Edit an existing file (MUST Read the file first to get exact old_string):
<tool_call>{"name": "Edit", "params": {"file_path": "{{CWD}}/src/app.js", "old_string": "const x = 1;", "new_string": "const x = 2;"}}</tool_call>

Run a shell command:
<tool_call>{"name": "shellCommand", "params": {"command": "ls -la"}}</tool_call>

Open an application:
<tool_call>{"name": "openApp", "params": {"name": "firefox"}}</tool_call>

Get a stock quote:
<tool_call>{"name": "quote", "params": {"symbol": "600519"}}</tool_call>

Fetch K-line data:
<tool_call>{"name": "dataFetch", "params": {"symbol": "000001", "period": "daily"}}</tool_call>

Run a backtest:
<tool_call>{"name": "backtest", "params": {"symbol": "000300", "strategy": "ma_cross"}}</tool_call>

Knowledge question (e.g., "what is MACD"):
→ Answer directly. No tool needed.

## Edit Tool — Critical Rules
The Edit tool performs EXACT string replacement. Follow these rules strictly:
1. **ALWAYS Read the file first** before calling Edit. You need the exact file content.
2. **old_string must be copied VERBATIM** from the Read result — exact same characters, whitespace, indentation, and line breaks. Do not retype or paraphrase.
3. **Include enough context** in old_string to make it unique. If the string appears multiple times, include surrounding lines until it is unique.
4. **Never include line numbers** in old_string — Read output shows "N\\t<content>", the old_string should only contain the <content> part.
5. **Preserve indentation exactly** — tabs vs spaces matter. Copy from Read output precisely.
6. If you need to replace multiple occurrences of the same string, use "replace_all": true.

Example workflow:
Step 1 - Read the file:
<tool_call>{"name": "Read", "params": {"file_path": "{{CWD}}/src/app.js"}}</tool_call>
Step 2 - After seeing the content, edit with exact old_string:
<tool_call>{"name": "Edit", "params": {"file_path": "{{CWD}}/src/app.js", "old_string": "function hello() {\\n  return 'world';\\n}", "new_string": "function hello() {\\n  return 'universe';\\n}"}}</tool_call>

# Tool Result Format

After you output a tool call, the system executes it and returns the result in this format:
[Tool:ToolName] <result content>

For example:
[Tool:Read] const x = 1;\nconst y = 2;\n...
[Tool:Glob] file1.js, file2.js, file3.js
[Tool:Grep] src/app.js:10: function main() {

Use the tool result to formulate a CONCISE answer to the user. Do not repeat the entire tool result — extract the relevant information and summarize.

CRITICAL: After receiving a tool result, you MUST answer the user's question based on that result.
Do NOT call another tool unless the result is genuinely insufficient.
Do NOT repeat the same tool call — the system will stop you if you do.
Maximum 5 tool calls per conversation turn. After that, you MUST give your final answer.

# Error Recovery

When a tool call fails:
1. Read the error message carefully.
2. Diagnose the root cause (wrong path? missing app? permission denied?).
3. Try an alternative approach:
   - Wrong app name → search for the correct executable name
   - File not found → check if path is correct, try alternate locations
   - Permission denied → suggest the user run with appropriate permissions
   - Command not found → suggest installing the required package
   - Edit old_string not found → Re-Read the file, copy the exact text again
4. If no alternative works, explain the error clearly and suggest next steps.
5. NEVER retry the exact same failing call.

# Work Lifecycle (Plan → Progress → Summary)

You MUST follow this lifecycle for any task that involves tool calls:

## 1. Plan (before tool calls)
Before your FIRST tool call, output a brief plan on a single line starting with [Plan]:
[Plan] 1) Read the file 2) Find the target function 3) Report results

Rules:
- Keep it to ONE line, 3-8 steps max, numbered.
- For simple tasks (single tool call), still output a short plan: [Plan] Read the config file
- The [Plan] line must come BEFORE any <tool_call> tag.

## 2. Progress (during tool calls)
The system reports tool execution automatically, but you should still keep the user oriented.

Allowed progress behavior:
- Before an important tool transition, you MAY add one short execution sentence in natural language.
- After a meaningful tool result, you MAY add one short follow-up sentence saying what changed and where you will go next.
- Good moments: starting investigation, switching from inspection to modification, switching from modification to verification.
- Sound like a steady pair-programming partner working alongside the user, not a status bot.
- Keep it short, natural, and tied to the next action. Example: "I'll inspect the prompt renderer first, then patch the resize path."
- Prefer first-person transition lines that feel like live collaboration, not formal reporting.
- When you give a reason, make it decision-shaping: the reason should help choose the next move, not just decorate the sentence.
- On failure, name the likely blocker briefly and immediately hint at the next adjustment.

Rules:
- Keep each progress sentence to ONE sentence.
- Do NOT reveal hidden reasoning, chain-of-thought, or long deliberation.
- Do NOT output a standalone progress-only reply. If work is still in progress, include the tool call(s) in the same assistant message.
- Do NOT narrate every tiny step. Prefer a few high-value transitions over constant chatter.
- Do NOT over-explain. Keep the tone light and teammate-like.

## 3. Summary (after tool calls)
After ALL tool calls are complete, your response MUST contain two parts:
1. **Main answer** — the detailed response to the user's question (3-8 sentences, with specific data from tool results).
2. **[Summary] line** — a 1-sentence recap as the LAST line.

Example response after tool calls:
  "backend/src/utils/ 下有 10 个工具函数文件：logger.js, sleep.js, retry.js 等。
   sleep.js 接受两个参数：ms（毫秒数，必填）和 options（可选，控制 unref）。
   [Summary] 共 10 个工具文件，sleep.js 接受 ms 和 options 两个参数。"

Rules:
- The main answer must NOT repeat the [Plan] — it should contain actual results and data.
- [Summary] is always the LAST line. Keep it to 1 sentence.
- Include: what you did, what you found/changed, and the outcome.
- NEVER output only [Plan] steps as your final answer.

For simple questions that need no tools (knowledge, explanation):
→ Skip the lifecycle. Answer directly.

# Path Handling
- ALWAYS use absolute paths based on the working directory {{CWD}}.
- For project files, prefix with {{CWD}}/ (e.g., {{CWD}}/src/app.js).
- On Windows: use actual paths like {{DESKTOP_DIR}}, never %USERNAME% or unexpanded vars.
- On Linux: use direct command names for apps (firefox, not "open firefox").
- On macOS: use "open -a AppName" or direct command names.
- NEVER construct paths using only {{HOME_DIR}} for project files — always use {{CWD}}.

# Output Format (align with Claude Code style)
- Respond in Chinese, be clear and concise. Lead with the answer, not the reasoning.
- Keep responses SHORT: simple answers in 1-3 sentences, complex in 5-8 sentences max.
- Simple questions: answer directly without unnecessary headings. Complex tasks: use short headings and flat bullet lists only when they improve scanability.
- Use bullet points, not tables. Tables are for data, not for explanations.
- Code in markdown code blocks (with language identifier).
- For code changes, summarize what changed, why, and how it was verified. Do not dump full files unless the user asked or exact text matters.
- When using external web information, end with a "Sources:" section containing markdown links.
- Progress updates must mention a concrete milestone, current step, or blocker/next step — not vague status text.
- Lists start with -, no more than 2 levels of nesting.
- Quote numbers and data precisely, no rounding.
- Avoid over-formatting: do not restate the user's request, do not bold every keyword, and do not force tables when a short list or paragraph is clearer.
- Never output <think> tags or internal reasoning.

# Software Engineering Standards

## Code Quality
- Prioritize correctness, security, performance, readability, and maintainability.
- Use clear, descriptive English identifiers following language-specific naming conventions.
- Don't add features, refactor code, or make "improvements" beyond what was asked.
- Be careful not to introduce security vulnerabilities (XSS, SQL injection, command injection).
- Don't add error handling for scenarios that can't happen. Only validate at system boundaries.

## Scope Minimization
- Define the completion condition before broad exploration so you know what will count as done.
- Prefer the smallest sufficient scope: one file over many, one function over a module-wide refactor, one targeted edit over a rewrite.
- Read the smallest useful context first and widen only when evidence shows the narrow slice is insufficient.
- Do not mix requested work with unrelated cleanup, renaming, abstraction, or polishing.
- Verify with the narrowest convincing check, then stop when the acceptance condition is met.

## File Operations
- Read files before modifying them. Never modify code you haven't read.
- Prefer editing existing files over creating new ones.
- Don't create documentation files unless explicitly requested.
- When editing: use precise replacements, not full file rewrites.

## Git Operations
- Never push to remote unless explicitly asked.
- Never use destructive git commands (push --force, reset --hard, checkout .) without confirmation.
- Never skip hooks (--no-verify).
- Create new commits rather than amending existing ones.
- Stage specific files rather than "git add -A".
- Write concise commit messages focusing on "why" not "what".

## Action Safety
- For destructive or hard-to-reverse actions, confirm with the user first.
- For actions visible to others (push, PR, deploy), ask before proceeding.
- Don't delete files, branches, or data without confirmation.
- Investigate before overwriting — it may be the user's in-progress work.

## Security & Permission Boundaries
- Follow least privilege: use only the permissions, tools, files, and external access necessary for the task.
- For read-only tasks, stay read-only. Do not mutate files or state unless the task clearly requires it.
- Treat .env files, credentials, tokens, private keys, and connection strings as sensitive. Never print secret values in full.
- Before irreversible or high-blast-radius actions, get explicit confirmation unless the user already requested that exact action.
- Generate code with secure defaults: validate untrusted input, prefer parameterized queries, and avoid command injection patterns.
- Before staging, committing, exporting, or uploading content, check for secrets or sensitive artifacts that should stay local or be redacted.

# Parallel Tool Execution
When multiple independent tools need to run and don't depend on each other's results,
you may call them in the same turn. Sequential calls should be used when later calls
depend on earlier results.

# Context Management
- You have a limited context window. Be concise in your responses.
- For large files, read specific sections rather than the entire file.
- Summarize tool results before adding them to the conversation.
- When context gets large, focus on the most relevant information.
- Preserve durable context: the current goal, user constraints, key decisions with rationale, active files, blockers, and the next concrete step.
- Do not carry forward raw transcripts or noisy logs when a concise summary will do.
- If context must be compacted or handed off, respond with plain text only as an <analysis> block followed by a <summary> block, and do not call tools while generating that summary.
</Agent>
`;

function _stripLegacySection(text = '', heading = '', nextHeading = '') {
  const source = String(text || '');
  const start = String(heading || '').trim();
  const end = String(nextHeading || '').trim();
  if (!source || !start || !end) return source;
  const escapedStart = start.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedEnd = end.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return source.replace(
    new RegExp(`\\n${escapedStart}[\\s\\S]*?(?=\\n${escapedEnd})`, 'm'),
    '\n',
  );
}

// Prompt-capsule modes that trigger stripping legacy managed sections and
// appending on-demand capsules. Hoisted to module scope (Ch2「不要每轮重建可复用
//结构」): makeSystemPrompt formerly built this literal Set inline on every
// prompt-cache miss. Consumed read-only via `.has`; never mutated/returned.
const _ON_DEMAND_CAPSULE_MODES = new Set([
  'on_demand', 'on_demand_omit', 'continuation_fallback', 'short_request_fallback',
]);

function _stripLegacyManagedPromptSections(prompt = '') {
  let next = String(prompt || '');
  next = _stripLegacySection(next, '# Error Recovery', '# Work Lifecycle (Plan → Progress → Summary)');
  next = _stripLegacySection(next, '# Output Format (align with Claude Code style)', '# Software Engineering Standards');
  next = _stripLegacySection(next, '## Scope Minimization', '## File Operations');
  next = _stripLegacySection(next, '## File Operations', '## Git Operations');
  next = _stripLegacySection(next, '## Git Operations', '## Action Safety');
  next = _stripLegacySection(next, '## Action Safety', '## Security & Permission Boundaries');
  next = _stripLegacySection(next, '## Security & Permission Boundaries', '# Parallel Tool Execution');
  return next.replace(/\n{3,}/g, '\n\n');
}

// estimateTokens 已下沉为零依赖叶子 textHeuristics（DESIGN-ARCH-051 §6.9）；
// 此处转引保留同名导出，行为逐字不变。
function estimateTokens(text) {
  return require('./textHeuristics').estimateTokens(text);
}

function normalizeWs(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function summarizeText(text, maxLen = SUMMARY_MAX_LEN) {
  const oneLine = normalizeWs(text).replace(/\|/g, '/');
  if (oneLine.length <= maxLen) return oneLine;
  return `${oneLine.slice(0, Math.max(40, maxLen - 3))}...`;
}

// ── Unified greeting detection ──
// 已下沉为零依赖叶子 textHeuristics（单一真源，DESIGN-ARCH-051 §6.9）。
// 此处转引保留同名局部绑定与导出，行为逐字不变。覆盖：
// claudeAdapter.looksLikeSimpleGreeting、inputPurify filler 路径、
// inputPreprocessor._inferIntent、routes/ai.js 硬编码检查。
const _isGreeting = (input) => require('./textHeuristics').isGreeting(input);

function detectIntent(text) {
  const s = String(text || '');
  if (_isGreeting(s)) return '问候';
  if (/(回测|backtest|策略测试|模拟交易|strategy)/i.test(s)) return '回测';
  if (/(行情|报价|价格|股价|多少钱|quote|price|涨跌)/i.test(s)) return '行情查询';
  if (/(k线|K线|kline|日线|周线|月线|分钟线)/i.test(s)) return 'K线查询';
  if (/(搜索|查|新闻|资讯|最新|动态|search|web)/i.test(s)) return '信息搜索';
  if (/(计算|复利|收益率|\d+\s*[+\-*/^%])/i.test(s)) return '计算';
  if (/(模型|model|gguf|safetensors|导入模型|ollama|下载模型|导出模型)/i.test(s)) return '模型管理';
  if (/(pdf.*word|pdf.*docx|转.*word|转.*docx|pdf转换)/i.test(s)) return 'PDF转Word';
  if (/(ocr|识别.*文字|图片.*文字|图.*识别|文字提取|图片.*识别)/i.test(s)) return '图片识别';
  if (/(读取|查看|文件|read|cat|打开.*文件|\.json|\.js|\.md|\.py)/i.test(s)) return '读取文件';
  if (/(写入|修改|重构|更新|新增|删除|edit|patch|refactor|write)/i.test(s)) return '代码修改';
  if (/(命令|执行|运行|shell|bash|terminal|cmd)/i.test(s)) return '命令执行';
  if (/(解释|什么是|定义|原理|怎么理解)/i.test(s)) return '概念解释';
  return '通用咨询';
}

function inputPurify(userMessage, opts = {}) {
  const raw = String(userMessage || '');
  // Greetings bypass filler stripping — return as-is with explicit '问候' intent
  if (_isGreeting(raw)) {
    return { purified: raw, intent: '问候', question: raw.slice(0, 1400) };
  }

  // Cloud models (with native tool use) don't need filler stripping — they
  // handle conversational phrasing natively.  Aggressive regex-based stripping
  // risks destroying meaningful content (e.g. “请求体” → “求体”, “网吧” → “网”).
  // Only detect intent for internal routing; pass user text through unchanged.
  if (opts.skipFillerStrip) {
    const intent = detectIntent(raw);
    const question = raw.slice(0, 1400);
    return { purified: question, intent, question };
  }

  // Minimal filler stripping — preserve all semantic punctuation, quotes, and
  // intent-carrying words. Only strip pure decoration (emoji, repeated symbols)
  // and courtesy phrases that add no task information.
  const fillerPatterns = [
    /[\u{1F300}-\u{1FAFF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}]/gu,           // emoji
    /[…~～]{2,}/g,                                                           // repeated decorative symbols
    /(请问一下|请教一下|麻烦你|麻烦帮我|帮我看下|帮我看一下|帮我查下|帮我查一下|麻烦看下)/gi,
    /(谢谢你|谢谢哈|辛苦了|拜托了|求你了|劳烦)/gi,
    /(你好|您好|哈喽|hello|hi|hey|早上好|下午好|晚上好|在吗|有人吗)/gi,
  ];

  let stripped = raw;
  for (const p of fillerPatterns) stripped = stripped.replace(p, ' ');

  stripped = stripped
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // If nothing remains after filler stripping, the input is a pure greeting
  // or pleasantry — pass through raw text without intent tags so the model
  // responds naturally instead of routing through the intent framework.
  if (!stripped) {
    return { purified: raw, intent: '通用咨询', question: raw.slice(0, 1400) };
  }

  const intent = detectIntent(stripped);
  const question = (stripped || raw).slice(0, 1400);

  // 不再向用户消息注入 [意图]/[问题] 标签 —— 这对云端大模型是纯噪音。
  // intent 仍通过返回值传递给 intentGate 做内部路由，但 purified 只含清理后原文。
  return { purified: question, intent, question };
}

function _trimIntentFragment(text = '', maxLen = 180) {
  const normalized = String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[,，。；;:："“”"'`《》「」『』【】()（）\-\s]+/, '')
    .replace(/[,，。；;:："“”"'`《》「」『』【】()（）\-\s]+$/, '');
  if (!normalized) return '';
  if (normalized.length <= maxLen) return normalized;
  return `${normalized.slice(0, Math.max(16, maxLen - 1))}…`;
}

function _dedupeIntentItems(items = [], limit = 8) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const normalized = _trimIntentFragment(item, 160);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

function _splitIntentClauses(text = '') {
  return (String(text || '').match(/[^。！？!?；;\n]+/g) || [])
    .map(part => _trimIntentFragment(part, 220))
    .filter(Boolean);
}

function _extractQuotedIntentAnchors(text = '') {
  const matches = String(text || '').match(/["'`“”‘’《》「」『』][^"'`“”‘’《》「」『』\n]{2,80}["'`“”‘’《》「」『』]/g) || [];
  return matches
    .map(item => _trimIntentFragment(item.replace(/^["'`“”‘’《》「」『』]|["'`“”‘’《》「」『』]$/g, ''), 80))
    .filter(Boolean);
}

function _extractLiteralIntentAnchors(text = '') {
  const raw = String(text || '');
  const hits = [];
  const patterns = [
    /https?:\/\/[^\s)]+/g,
    /(?:^|[\s(])(?:sh|sz)\d{6}(?=$|[\s),.，。])/gi,
    /\b\d{4}-\d{1,2}-\d{1,2}\b/g,
    /\b\d+(?:\.\d+)?%/g,
    /`[^`\n]{1,120}`/g,
  ];
  for (const pattern of patterns) {
    const matches = raw.match(pattern) || [];
    for (const match of matches) {
      hits.push(_trimIntentFragment(String(match).replace(/^`|`$/g, ''), 120));
    }
  }
  return hits.filter(Boolean);
}

function _extractPathIntentAnchors(text = '') {
  const raw = String(text || '');
  const hits = [];
  const pathPattern = /(?:[A-Za-z]:\\|\/)?(?:[\w.@-]+[\\/]){1,8}[\w.@-]+\.(?:js|cjs|mjs|ts|tsx|jsx|py|vue|json|md|yaml|yml|toml|ini|env|sh|bash|sql|go|rs|java|kt|rb|php|css|scss|less|html)/g;
  const matches = raw.match(pathPattern) || [];
  for (const match of matches) {
    hits.push(_trimIntentFragment(match, 140));
  }
  return hits.filter(Boolean);
}

const _INTENT_KEYWORD_STOPWORDS = new Set([
  '帮我', '请', '请问', '麻烦', '一下', '看看', '看下', '查下', '查一下', '分析下', '分析一下',
  '你好', '您好', '在吗', '有人吗', '谢谢', '辛苦了', '拜托了', '问题', '情况', '内容', '东西',
  '帮我看看', '另外保留',
  'search', 'find', 'help', 'please', 'thanks', 'thank', 'look', 'check', 'question', 'issue',
]);

function _extractKeywordIntentAnchors(text = '') {
  const tokens = String(text || '').match(/[\u4e00-\u9fa5]{2,16}|[A-Za-z][A-Za-z0-9_.+#-]{2,31}/g) || [];
  const ranked = [];
  for (const token of tokens) {
    const value = _trimIntentFragment(token, 48);
    const low = value.toLowerCase();
    if (!value || _INTENT_KEYWORD_STOPWORDS.has(low)) continue;
    if (/^(这个|那个|这里|那里|可以|怎么|如何|为什么|是否|如果|然后|还有|另外|同时)$/.test(value)) continue;
    let score = value.length;
    if (/[\\/]/.test(value) || /\./.test(value)) score += 10;
    if (/\d/.test(value)) score += 8;
    if (/^[A-Z0-9_.+#-]+$/.test(value)) score += 5;
    ranked.push({ value, score });
  }
  ranked.sort((a, b) => b.score - a.score || b.value.length - a.value.length);
  return _dedupeIntentItems(ranked.map(item => item.value), 8);
}

function _extractConstraintIntentClauses(text = '') {
  const raw = String(text || '');
  const matches = raw.match(/(?:不要|别|禁止|不能|务必|必须|需要|记得|保留|优先|仅|只|避免|必须先|不要忘|必须保留)[^，。；;\n]{0,80}|(?:must|do not|don't|never|without|only|prefer|avoid|keep|preserve|required)[^,.;\n]{0,80}/gi) || [];
  return _dedupeIntentItems(matches, 5);
}

function _extractTailDetailClauses(text = '') {
  const raw = String(text || '');
  const matches = raw.match(/(?:另外|还有|同时|并且|但是|不过|尤其|特别是|顺便|别忘了|再补充|补充一下|还有一点|also|but|except|plus|one more thing)[^。！？!?；;\n]{0,120}/gi) || [];
  return _dedupeIntentItems(matches, 4);
}

function _pickPrimaryObjective(text = '') {
  const clauses = _splitIntentClauses(text);
  const actionRe = /(修复|实现|修改|分析|解释|总结|搜索|查|读取|查看|创建|新增|删除|设计|比较|排查|review|fix|implement|modify|analy[sz]e|explain|summari[sz]e|search|read|inspect|create|add|remove|design|compare|debug)/i;
  const intentLeadRe = /(帮我|请|我要|我想|我需要|希望|如何|怎么|请你|能否|可以|需要)/i;
  let best = '';
  let bestScore = -Infinity;
  for (const clause of clauses) {
    const normalized = _trimIntentFragment(clause, 160);
    if (!normalized) continue;
    let score = Math.min(normalized.length, 80);
    if (actionRe.test(normalized)) score += 40;
    if (intentLeadRe.test(normalized)) score += 18;
    if (/(不要|必须|优先|保留|别忘了|另外|同时|但是)/.test(normalized)) score += 6;
    if (normalized.length < 6) score -= 20;
    if (/^(你好|您好|谢谢|辛苦了|在吗|hello|hi|hey|thanks)/i.test(normalized)) score -= 30;
    if (score > bestScore) {
      best = normalized;
      bestScore = score;
    }
  }
  if (best) return best;
  return _trimIntentFragment(text, 160);
}

// 读取 KHY_INTENT_ASSURANCE 开关，默认开启；0/false/off/no/n 视为关闭。
function _intentAssuranceEnabled() {
  const raw = process.env.KHY_INTENT_ASSURANCE;
  if (raw === undefined || raw === null || String(raw).trim() === '') return true;
  return !['0', 'false', 'off', 'no', 'n'].includes(String(raw).trim().toLowerCase());
}

function buildIntentAssuranceDirective(userMessage, opts = {}) {
  const raw = String(userMessage || '').trim();
  // 开关 KHY_INTENT_ASSURANCE（默认开）：置 0/false/off 可整体关闭
  // “## INTENT ASSURANCE” 意图重写框注入，避免把用户原话改写成
  // primary/secondary objective 模板。关闭时按未触发处理。
  if (!_intentAssuranceEnabled() || !raw) {
    return {
      shouldInject: false,
      directive: '',
      requestClass: '',
      primaryObjective: '',
      constraints: [],
      detailAnchors: [],
      tailDetails: [],
      summary: null,
      detailCount: 0,
      constraintCount: 0,
      tailDetailCount: 0,
    };
  }

  const purifiedQuestion = _trimIntentFragment(
    opts.purifiedQuestion || inputPurify(raw, { skipFillerStrip: false }).question || raw,
    1400,
  );
  const hasFilePathAnchor = _extractPathIntentAnchors(raw).length > 0;
  const likelyCodeOrFileTask = hasFilePathAnchor
    && /(修复|实现|修改|排查|查看|逻辑|接口|文件|代码|read|edit|fix|file|code|debug|review)/i.test(raw);
  const intent = likelyCodeOrFileTask
    ? '代码/文件任务'
    : _trimIntentFragment(opts.intent || detectIntent(purifiedQuestion) || '通用咨询', 40);
  const primaryObjective = _pickPrimaryObjective(purifiedQuestion || raw);
  const constraints = _extractConstraintIntentClauses(raw);
  const pathAnchors = _extractPathIntentAnchors(raw);
  const pathSegments = new Set(
    pathAnchors
      .flatMap(item => String(item || '').split(/[\\/]/g))
      .map(item => String(item || '').trim().toLowerCase())
      .filter(Boolean),
  );
  const keywordAnchors = _extractKeywordIntentAnchors(purifiedQuestion || raw)
    .filter((item) => {
      const normalized = String(item || '').trim().toLowerCase();
      if (!normalized) return false;
      if (normalized.includes('.')) return true;
      if (normalized.length > 8) return true;
      return !pathSegments.has(normalized);
    });
  const detailAnchors = _dedupeIntentItems([
    ..._extractQuotedIntentAnchors(raw),
    ..._extractLiteralIntentAnchors(raw),
    ...pathAnchors,
    ...keywordAnchors,
  ], 8);
  const tailDetails = _extractTailDetailClauses(raw);
  const clauseCount = _splitIntentClauses(raw).length;
  const fillerHits = (raw.match(/(请问一下|请教一下|麻烦你|麻烦帮我|帮我看下|帮我看一下|谢谢你|辛苦了|拜托了|你好|您好|哈喽|hello|hi|hey|在吗|有人吗)/gi) || []).length;

  const shouldInject = raw.length >= 60
    || clauseCount >= 3
    || fillerHits >= 2
    || constraints.length > 0
    || tailDetails.length > 0
    || detailAnchors.length >= 3;

  if (!shouldInject) {
    return {
      shouldInject: false,
      directive: '',
      requestClass: intent || '通用咨询',
      primaryObjective: primaryObjective || purifiedQuestion || raw,
      constraints,
      detailAnchors,
      tailDetails,
      summary: primaryObjective || purifiedQuestion || raw,
      detailCount: detailAnchors.length,
      constraintCount: constraints.length,
      tailDetailCount: tailDetails.length,
    };
  }

  const lines = [
    '## INTENT ASSURANCE — high-priority request reading frame.',
    `Request class: ${intent || '通用咨询'}.`,
    `Primary objective: ${primaryObjective || purifiedQuestion || _trimIntentFragment(raw, 160)}`,
  ];

  if (constraints.length > 0) {
    lines.push('Explicit constraints to obey:');
    constraints.forEach((item, idx) => lines.push(`${idx + 1}. ${item}`));
  }

  if (detailAnchors.length > 0) {
    lines.push('Must-keep detail anchors:');
    detailAnchors.forEach((item, idx) => lines.push(`${idx + 1}. ${item}`));
  }

  if (tailDetails.length > 0) {
    lines.push('Secondary details that still matter:');
    tailDetails.forEach((item, idx) => lines.push(`${idx + 1}. ${item}`));
  }

  lines.push('Interpretation rules:');
  lines.push('1. Execute or answer for the primary objective first.');
  lines.push('2. Preserve quoted phrases, file paths, commands, codes, dates, numbers, and model names exactly.');
  lines.push('3. If this summary conflicts with the raw user message, trust the raw user message.');
  lines.push('4. Tail clauses introduced by words such as "另外/同时/但是/还有/also/but/except" are details to retain, not noise.');
  lines.push('5. If multiple goals compete and priority is unclear, ask one focused clarification instead of guessing.');

  return {
    shouldInject: true,
    directive: lines.join('\n'),
    requestClass: intent || '通用咨询',
    primaryObjective: primaryObjective || purifiedQuestion || _trimIntentFragment(raw, 160),
    constraints,
    detailAnchors,
    tailDetails,
    summary: primaryObjective || purifiedQuestion || _trimIntentFragment(raw, 160),
    detailCount: detailAnchors.length,
    constraintCount: constraints.length,
    tailDetailCount: tailDetails.length,
  };
}

// ── Fallback context summary (Phase 3 Level 3: manual extraction) ──
function _fallbackContextSummary(droppedMessages) {
  const dropped = Array.isArray(droppedMessages) ? droppedMessages : [];
  if (!dropped.length) return '[上下文摘要] 无历史上下文。';

  const users = dropped.filter(m => m.role === 'user').map(m => String(m.content || ''));
  const assistants = dropped.filter(m => m.role === 'assistant').map(m => String(m.content || ''));
  const tools = dropped.filter(m => m.role === 'tool').map(m => String(m.content || ''));

  // Extract key points directly from raw text (no [意图]/[问题] tags since they're no longer injected)
  const questions = users.map(u => summarizeText(u, 80)).filter(Boolean).slice(-5);
  const conclusions = assistants.map(x => summarizeText(x, 90)).slice(-4);
  const toolFacts = tools.map(x => summarizeText(x, 90)).slice(-4);

  const parts = [];
  if (questions.length) parts.push(`历史问题=${questions.join(' ; ')}`);
  if (toolFacts.length) parts.push(`已得工具结果=${toolFacts.join(' ; ')}`);
  if (conclusions.length) parts.push(`历史结论=${conclusions.join(' ; ')}`);

  return summarizeText(
    `[上下文摘要] 已压缩 ${dropped.length} 条历史消息。${parts.join(' | ') || '早期对话已省略。'}`,
    950
  );
}

// ── AI Summarization prompt (Phase 3, ported from OpenClaw MERGE_SUMMARIES) ──
const SUMMARIZE_INSTRUCTION = `将以下对话历史压缩为简洁摘要。
必须保留：
- 当前活跃任务和进度
- 用户最后一个请求
- 做出的决策及原因
- 待办事项和约束
- 所有路径、ID、代码等标识符原样保留
优先保留近期内容。不超过800字。`;

/**
 * Split messages into chunks respecting tool_call/result boundaries.
 * OpenClaw: BASE_CHUNK_RATIO = 0.4
 */
function _splitByToolBoundary(messages, chunkTokenBudget) {
  const chunks = [];
  let current = [];
  let currentTokens = 0;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const tokens = estimateTokens(msg.content);

    // If adding this message exceeds budget and current chunk is non-empty
    if (currentTokens + tokens > chunkTokenBudget && current.length > 0) {
      // Don't split between assistant+tool_call and its tool result
      if (msg.role === 'tool' && current.length > 0) {
        current.push(msg);
        currentTokens += tokens;
        continue;
      }
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }

    current.push(msg);
    currentTokens += tokens;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * AI-driven context summary with 3-level fallback.
 * Level 1: AI semantic summarization (best quality)
 * Level 2: AI retry without oversized messages
 * Level 3: Manual string extraction (current fallback)
 *
 * @param {Array} droppedMessages
 * @param {object} [opts]
 * @param {number} [opts.maxTokens] - Token budget for summary
 * @returns {Promise<string>}
 */
async function buildContextSummary(droppedMessages, opts = {}) {
  const dropped = Array.isArray(droppedMessages) ? droppedMessages : [];
  if (!dropped.length) return '[上下文摘要] 无历史上下文。';

  // Try AI summarization (Level 1)
  let gateway;
  try {
    gateway = require('./gateway/aiGateway');
  } catch {
    return _fallbackContextSummary(dropped);
  }

  // Sanitize tool results (truncate large outputs)
  const sanitized = dropped.map(m => ({
    role: m.role,
    content: m.role === 'tool' ? summarizeText(m.content, 500) : String(m.content || ''),
  }));

  // Split into chunks respecting boundaries
  const chunkBudget = Math.max(2000, (opts.maxTokens || CONTEXT_TOKEN_LIMIT) * 0.4);
  const chunks = _splitByToolBoundary(sanitized, chunkBudget);

  let summary = '';
  try {
    for (const chunk of chunks) {
      const chunkText = chunk.map(m =>
        `${m.role === 'user' ? 'USER' : m.role === 'assistant' ? 'AI' : 'TOOL'}: ${m.content}`
      ).join('\n');

      const prompt = summary
        ? `${SUMMARIZE_INSTRUCTION}\n\n[已有摘要]\n${summary}\n\n[新增对话]\n${chunkText}`
        : `${SUMMARIZE_INSTRUCTION}\n\n[对话历史]\n${chunkText}`;

      const result = await gateway.generate(prompt, {
        maxTokens: 800,
        temperature: 0.1,
      });

      if (result.success) {
        summary = result.content;
      } else {
        throw new Error('AI summarization failed');
      }
    }
    return `[上下文摘要] ${summary}`;
  } catch {
    // Level 2: retry without oversized messages
    try {
      const filtered = sanitized.filter(m => estimateTokens(m.content) < 1000);
      if (filtered.length > 0 && filtered.length < sanitized.length) {
        const compactText = filtered.map(m =>
          `${m.role === 'user' ? 'USER' : m.role === 'assistant' ? 'AI' : 'TOOL'}: ${m.content}`
        ).join('\n');

        const result = await gateway.generate(
          `${SUMMARIZE_INSTRUCTION}\n\n[对话历史]\n${compactText}`,
          { maxTokens: 600, temperature: 0.1 }
        );

        if (result.success) {
          return `[上下文摘要] ${result.content}`;
        }
      }
    } catch { /* Level 2 also failed */ }

    // Level 3: manual extraction fallback
    return _fallbackContextSummary(dropped);
  }
}

async function buildSlidingWindow(messages, tokenLimit = CONTEXT_TOKEN_LIMIT, options = {}) {
  let arr = Array.isArray(messages) ? messages.slice() : [];
  if (arr.length === 0) return [];

  // Optional progress callback so the TUI can render a compaction progress bar.
  // Fired at the real compression milestones (prune → guard → AI summary).
  // Best-effort: never let a UI callback break compaction.
  const onPhase = typeof options.onPhase === 'function' ? options.onPhase : null;
  const emitPhase = (stage, pct) => {
    if (!onPhase) return;
    try { onPhase({ stage, pct }); } catch { /* ignore UI callback errors */ }
  };

  // Repair tool_call/result pairing before compression
  try {
    const { repairTranscript, ensureCompletePairs } = require('./transcriptRepair');
    arr = ensureCompletePairs(repairTranscript(arr));
  } catch { /* transcriptRepair not available, continue with raw messages */ }

  // ── Coordinated multi-layer compression ──
  // Track pre-compression message count to detect if prior layers already pruned,
  // so contextCompressor can adjust its preserve ratio accordingly.
  const preCompressionCount = arr.length;

  emitPhase('pruning', 15);

  // Layer 1: CJK-aware context pruning — soft trim + hard clear old tool results
  try {
    const { pruneContext } = require('./contextPruner');
    arr = pruneContext(arr, {
      contextWindowTokens: tokenLimit,
      isToolPrunable: (toolName) => toolName !== 'read_file' && toolName !== 'readFile',
    });
  } catch { /* contextPruner not available */ }

  // Layer 2: Context window guard — emergency prune if approaching limit
  let guardAlreadyPruned = false;
  try {
    const { evaluateGuard, pruneMessages, formatWarning } = require('./contextWindowGuard');
    const totalTokens = arr.reduce((sum, m) => sum + estimateTokens(m.content), 0);
    const guard = evaluateGuard({ usedTokens: totalTokens, contextWindowTokens: tokenLimit });
    if (guard.shouldBlock) {
      const { pruned, removedCount } = pruneMessages(arr, {
        targetTokens: tokenLimit * 0.8,
        estimateTokens: text => estimateTokens(text),
      });
      if (removedCount > 0) {
        arr = pruned;
        guardAlreadyPruned = true;
      }
    } else if (guard.shouldWarn) {
      const logger = require('../utils/logger');
      logger.warn(formatWarning(guard));
    }
  } catch { /* contextWindowGuard not available */ }

  emitPhase('guarding', 30);

  const maxTokens = Math.max(1200, Number(tokenLimit) || CONTEXT_TOKEN_LIMIT);

  // Layer 3: AI-powered compression — adjust preserve ratio if prior layers already reduced
  // Coordination: if guard pruned to 80%, compressor should preserve more (50% instead of 30%)
  // to avoid compound over-compression (0.8 × 0.3 = 24% → effectively losing 76% of context)
  const priorLayersPruned = arr.length < preCompressionCount;
  // The AI summary is the long pole (a model round-trip); signal it before the
  // call so the bar can ease forward while the request is in flight.
  emitPhase('summarizing', 45);
  try {
    const { compress } = require('./contextCompressor');
    const compressResult = await compress(arr, {
      estimateTokensFn: (text) => estimateTokens(text),
      callModelFn: (text, callOpts) => buildContextSummary(
        [{ role: 'user', content: text }],
        { maxTokens, ...callOpts }
      ),
      contextWindowTokens: maxTokens,
      // If prior layers already pruned, increase preserve ratio to avoid over-compression
      preserveRatioOverride: guardAlreadyPruned ? 0.50 : undefined,
    });
    if (compressResult.summaryGenerated) {
      emitPhase('done', 100);
      return compressResult.compressed;
    }
  } catch { /* contextCompressor not available, fall through to legacy */ }

  // Legacy fallback: tail-greedy cutoff
  const reserveForSummary = 220;
  const usableBudget = Math.max(600, maxTokens - reserveForSummary);

  let used = 0;
  let cutoff = arr.length;
  for (let i = arr.length - 1; i >= 0; i--) {
    const t = estimateTokens(arr[i].content);
    if (used + t > usableBudget) break;
    used += t;
    cutoff = i;
  }

  let kept = arr.slice(cutoff);
  if (kept.length === 0) kept = [arr[arr.length - 1]];

  const dropped = arr.slice(0, cutoff);
  if (dropped.length > 0) {
    const summary = await buildContextSummary(dropped, { maxTokens });
    kept = [{ role: 'system', content: summary }, ...kept];
  }

  while (estimateTokens(kept.map(m => m.content).join('\n')) > maxTokens && kept.length > 1) {
    if (kept[0].role === 'system') {
      kept[0] = { role: 'system', content: summarizeText(kept[0].content, 480) };
      if (estimateTokens(kept.map(m => m.content).join('\n')) <= maxTokens) break;
    }
    kept.splice(1, 1);
  }

  emitPhase('done', 100);
  return kept;
}

function mapToolToNaturalAction(name) {
  const n = String(name || '');
  // Use snake_case names to match actual tool registry names
  if (n === 'web_search' || n === 'webSearch' || n === 'search' || n === 'WebSearch') return { action: '搜索', arg: '关键词', desc: '搜索网页信息' };
  if (n === 'quote') return { action: '行情', arg: '股票代码', desc: '查实时价格与涨跌' };
  if (n === 'backtest') return { action: '回测', arg: 'symbol strategy', desc: '跑策略回测' };
  if (n === 'data_fetch') return { action: 'K线', arg: 'symbol period', desc: '取K线数据' };
  if (n === 'read_file' || n === 'readFile' || n === 'Read') return { action: '读取文件', arg: '文件路径', desc: '读取本地文件' };
  if (n === 'write_file' || n === 'writeFile' || n === 'Write') return { action: '写入文件', arg: '路径 内容', desc: '写文件' };
  if (n === 'editFile' || n === 'Edit' || n === 'multiEdit' || n === 'MultiEdit') return { action: '编辑文件', arg: 'file_path old_string new_string', desc: '精确修改文件内容' };
  if (n === 'shell_command' || n === 'shellCommand' || n === 'Bash') return { action: '命令', arg: '命令文本', desc: '执行shell命令' };
  if (n === 'ls' || n === 'LS' || n === 'glob' || n === 'Glob') return { action: '文件搜索', arg: 'pattern/path', desc: '查找文件和目录' };
  if (n === 'grep' || n === 'Grep') return { action: '内容搜索', arg: 'pattern/path', desc: '按正则搜索内容' };
  if (n === 'open_app') return { action: '打开应用', arg: '应用名称', desc: '打开应用（支持模糊匹配和中文名）' };
  if (n === 'agent' || n === 'Task') return { action: '子任务', arg: 'prompt role', desc: '调用子代理并行处理' };
  if (n === 'import_model') return { action: '导入模型', arg: '路径或URL', desc: '导入本地模型' };
  if (n === 'download_model') return { action: '下载模型', arg: 'URL', desc: '下载并导入模型' };
  if (n === 'list_models') return { action: '模型列表', arg: '', desc: '查看所有模型' };
  if (n === 'export_ollama_model') return { action: '导出模型', arg: 'Ollama模型名', desc: '从Ollama导出模型' };
  if (n === 'strategy_list') return { action: '策略列表', arg: 'all', desc: '列出可用策略' };
  if (n === 'git_status') return { action: 'Git状态', arg: '.', desc: '查看工作区状态' };
  if (n === 'git_diff') return { action: 'Git差异', arg: '文件路径', desc: '查看代码差异' };
  if (n === 'pdf_to_word') return { action: 'PDF转Word', arg: 'PDF文件路径', desc: '把PDF转成Word' };
  if (n === 'image_ocr') return { action: '图片识别', arg: '图片路径', desc: '识别图片中的文字' };
  if (n === 'execute_code') return { action: '执行代码', arg: '代码文本', desc: '执行代码片段' };
  return null;
}

/**
 * Build tool guide in JSON tool_call format for system prompt injection.
 * Returns a structured tool list that tells the AI exactly what tools are available.
 */
function buildNaturalToolGuide() {
  const tools = [];
  try {
    const toolModule = require('../tools');
    for (const t of toolModule.getEnabled().values()) {
      const m = mapToolToNaturalAction(t.name);
      if (m) {
        tools.push(`- ${t.name}: ${m.desc}  →  <tool_call>{"name": "${t.name}", "params": {${m.arg ? `"${_guessParamKey(t.name)}": "${m.arg}"` : ''}}}</tool_call>`);
      }
    }
    // Include Claude-compatible aliases in tool guide to increase tool-call hit rate.
    try {
      const { getClaudeCompatToolList } = require('./claudeCompat');
      for (const compat of getClaudeCompatToolList()) {
        const m = mapToolToNaturalAction(compat.name);
        if (!m) continue;
        tools.push(`- ${compat.name}: ${m.desc}  →  <tool_call>{"name": "${compat.name}", "params": {${m.arg ? `"${_guessParamKey(compat.name)}": "${m.arg}"` : ''}}}</tool_call>`);
      }
    } catch { /* best effort */ }
  } catch {
    // Fallback: minimal static list using PascalCase names matching the registry
    tools.push(
      '- Read: Read a file  →  <tool_call>{"name": "Read", "params": {"file_path": "/absolute/path/to/file"}}</tool_call>',
      '- Write: Write/create a file  →  <tool_call>{"name": "Write", "params": {"file_path": "/absolute/path", "content": "..."}}</tool_call>',
      '- Edit: Edit a file (exact string replacement)  →  <tool_call>{"name": "Edit", "params": {"file_path": "/absolute/path", "old_string": "exact old text", "new_string": "new text"}}</tool_call>',
      '- Glob: Find files by pattern  →  <tool_call>{"name": "Glob", "params": {"pattern": "**/*.js"}}</tool_call>',
      '- Grep: Search file contents  →  <tool_call>{"name": "Grep", "params": {"pattern": "keyword", "path": "/dir"}}</tool_call>',
      '- shellCommand: Run a shell command  →  <tool_call>{"name": "shellCommand", "params": {"command": "ls -la"}}</tool_call>',
      '- webSearch: Web search  →  <tool_call>{"name": "webSearch", "params": {"query": "keyword"}}</tool_call>',
      '- quote: Stock quote  →  <tool_call>{"name": "quote", "params": {"symbol": "600519"}}</tool_call>',
      '- openApp: Open application  →  <tool_call>{"name": "openApp", "params": {"name": "firefox"}}</tool_call>',
      '- backtest: Run backtest  →  <tool_call>{"name": "backtest", "params": {"symbol": "000300", "strategy": "ma_cross"}}</tool_call>',
    );
  }

  if (!tools.length) return '';
  return `\n{{TOOL_LIST}}\n## Available Tools\n${[...new Set(tools)].join('\n')}\n{{/TOOL_LIST}}`;
}

/**
 * Guess the primary parameter key for a tool to use in examples.
 */
function _guessParamKey(toolName) {
  const map = {
    web_search: 'query', search: 'query', quote: 'symbol', backtest: 'symbol',
    data_fetch: 'symbol', read_file: 'path', write_file: 'path',
    shell_command: 'command', open_app: 'name', git_status: 'path',
    git_diff: 'file', import_model: 'source', list_models: '',
    export_ollama_model: 'model', pdf_to_word: 'inputPath',
    image_ocr: 'imagePath', strategy_list: '', execute_code: 'code',
    webSearch: 'query', Bash: 'command', Read: 'path', Write: 'path',
    Edit: 'file_path', MultiEdit: 'file_path', LS: 'path', Grep: 'pattern',
    Glob: 'pattern', Task: 'prompt',
  };
  return map[toolName] || 'input';
}

const NATURAL_ACTION_ALIASES = {
  '搜索': '搜索',
  'search': '搜索',
  'websearch': '搜索',
  '查找': '搜索',

  '计算器': '计算器',
  '计算': '计算器',
  'calculator': '计算器',

  '读取文件': '读取文件',
  '读文件': '读取文件',
  'readfile': '读取文件',

  '写入文件': '写入文件',
  'writefile': '写入文件',

  '命令': '命令',
  'shell': '命令',
  'bash': '命令',

  '打开应用': '打开应用',
  '打开': '打开应用',
  '启动': '打开应用',
  'open': '打开应用',
  'openapp': '打开应用',
  'launch': '打开应用',

  '行情': '行情',
  'quote': '行情',
  '报价': '行情',

  '回测': '回测',
  'backtest': '回测',

  'k线': 'K线',
  'kline': 'K线',
  'K线': 'K线',

  '策略列表': '策略列表',
  'strategylist': '策略列表',

  'git状态': 'Git状态',
  'gitstatus': 'Git状态',

  'git差异': 'Git差异',
  'gitdiff': 'Git差异',

  '导入模型': '导入模型',
  '下载模型': '导入模型',
  'importmodel': '导入模型',
  'downloadmodel': '导入模型',

  '模型列表': '模型列表',
  '查看模型': '模型列表',
  'listmodels': '模型列表',
  '所有模型': '模型列表',

  '导出模型': '导出模型',
  'exportmodel': '导出模型',

  'pdf转word': 'PDF转Word',
  'pdf转换': 'PDF转Word',
  'pdf2word': 'PDF转Word',
  '转word': 'PDF转Word',
  '转docx': 'PDF转Word',

  '图片识别': '图片识别',
  '识别文字': '图片识别',
  'ocr': '图片识别',
  '文字识别': '图片识别',
  '图文识别': '图片识别',
};

function extractNaturalToolCall(text) {
  const s = String(text || '');

  // Format 1: <tool_call>{"name": "xxx", "params": {...}}</tool_call>  (XML/JSON)
  const xmlMatch = s.match(/<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/);
  if (xmlMatch) {
    try {
      const parsed = JSON.parse(xmlMatch[1]);
      const name = String(parsed.name || '').trim();
      if (name) {
        return { action: name, arg: parsed.params || {}, _format: 'xml_json' };
      }
    } catch { /* malformed JSON, fall through */ }
  }

  // Format 2: 【调用 xxx：yyy】  (Chinese brackets)
  const strict = s.match(/【\s*调用\s*([^：:\]】\n]{1,24})\s*[：:]\s*([\s\S]*?)\s*】/);
  if (strict) {
    const rawAction = strict[1].trim();
    const key = rawAction.toLowerCase();
    const action = NATURAL_ACTION_ALIASES[key] || NATURAL_ACTION_ALIASES[rawAction] || rawAction;
    return { action, arg: (strict[2] || '').trim() };
  }

  const noArg = s.match(/【\s*调用\s*([^】\n]{1,24})\s*】/);
  if (noArg) {
    const rawAction = noArg[1].trim();
    const key = rawAction.toLowerCase();
    const action = NATURAL_ACTION_ALIASES[key] || NATURAL_ACTION_ALIASES[rawAction] || rawAction;
    return { action, arg: '' };
  }

  return null;
}

function safeEvalExpression(expr) {
  const src = String(expr || '').trim();
  if (!/^[0-9+\-*/().%^\s]+$/.test(src)) {
    throw new Error('Expression contains unsupported characters');
  }
  // eslint-disable-next-line no-new-func
  const fn = new Function(`return (${src});`);
  const out = fn();
  if (!Number.isFinite(Number(out))) throw new Error('Expression result is not finite');
  return String(out);
}

function parseKVArg(argText) {
  const out = {};
  const s = String(argText || '').trim();
  if (!s) return out;
  const parts = s.split(/\s+/);
  for (const p of parts) {
    const m = p.match(/^([a-zA-Z_]+)=(.+)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function normalizeToolResult(r, maxLen = 2200) {
  if (!r) return { success: false, text: 'No result' };
  if (r.success) {
    // Priority chain: known string fields → file list → message → JSON fallback
    let body = r.output || r.content || r.result || r.data;
    if (body === undefined || body === null) {
      // Handle special return shapes (Grep→files, Glob→files, etc.)
      if (Array.isArray(r.files)) {
        body = r.files.join('\n');
        if (r.count !== undefined) body = `Found ${r.count} result(s):\n${body}`;
      } else if (r.message) {
        body = r.message;
      } else {
        body = JSON.stringify(r, null, 2);
      }
    } else if (typeof body === 'object') {
      body = Array.isArray(body) ? body.join('\n') : JSON.stringify(body, null, 2);
    } else {
      body = String(body);
    }
    return { success: true, text: summarizeText(body, maxLen) };
  }
  // Error case: also handle object errors
  let errText = r.error;
  if (typeof errText === 'object') errText = JSON.stringify(errText);
  return { success: false, text: String(errText || r.message || 'Tool failed') };
}

async function runNaturalToolCall(call, context = {}) {
  if (!call) return null;
  const tools = require('../tools');
  const { rewriteWindowsDesktopPath } = require('../utils/pathCompat');

  // Handle XML/JSON format tool calls from <tool_call> extraction
  if (call._format === 'xml_json' && typeof call.arg === 'object') {
    const name = call.action;
    const rawParams = call.arg;
    // Map model tool names to registered tool names (PascalCase for new registry)
    const TOOL_NAME_MAP = {
      'Write': 'Write', 'write': 'Write', 'write_file': 'Write', 'writeFile': 'Write',
      'Read': 'Read', 'read': 'Read', 'read_file': 'Read', 'readFile': 'Read',
      'Edit': 'Edit', 'edit': 'Edit', 'edit_file': 'Edit', 'editFile': 'Edit',
      'Glob': 'Glob', 'glob': 'Glob',
      'Grep': 'Grep', 'grep': 'Grep',
      'Bash': 'shellCommand', 'bash': 'shellCommand', 'shell_command': 'shellCommand', 'shellCommand': 'shellCommand',
      'webSearch': 'webSearch', 'WebSearch': 'webSearch', 'web_search': 'webSearch',
      'WebFetch': 'WebFetch', 'webFetch': 'WebFetch', 'web_fetch': 'WebFetch',
      'quote': 'quote',
      'gitStatus': 'gitStatus', 'git_status': 'gitStatus',
      'gitDiff': 'gitDiff', 'git_diff': 'gitDiff',
      'gitCommit': 'gitCommit', 'git_commit': 'gitCommit',
      'data_fetch': 'data_fetch', 'dataFetch': 'data_fetch',
    };
    let toolName = TOOL_NAME_MAP[name] || name;

    // Normalize params: model may use various key names for file path
    const params = { ...rawParams };
    const pathValue = params.file_path || params.path || params.input || params.file || params.filepath;
    if (pathValue) {
      // New registry tools expect "file_path"; legacy tools expect "path"
      params.file_path = pathValue;
      params.path = pathValue;
      // Clean up duplicate keys
      delete params.input; delete params.file; delete params.filepath;
    }

    // Resolve paths against CWD
    const pathMod = require('path');
    const fsMod = require('fs');
    const cwd = process.env.KHYQUANT_CWD || process.cwd();
    const pathKey = params.file_path ? 'file_path' : 'path';
    if (params[pathKey]) {
      let resolved = rewriteWindowsDesktopPath(String(params[pathKey]));
      if (!pathMod.isAbsolute(resolved)) {
        // Relative path → resolve against CWD
        resolved = pathMod.resolve(cwd, resolved);
      } else if (!fsMod.existsSync(resolved)) {
        // Absolute path that doesn't exist — model may have used wrong base dir.
        // Try extracting the relative portion after home dir and resolving against CWD.
        const home = require('os').homedir();
        if (resolved.startsWith(home + pathMod.sep)) {
          const relPart = resolved.slice(home.length + 1);
          const cwdCandidate = pathMod.resolve(cwd, relPart);
          if (fsMod.existsSync(cwdCandidate)) {
            resolved = cwdCandidate;
          }
        }
      }
      params.file_path = rewriteWindowsDesktopPath(resolved);
      params.path = rewriteWindowsDesktopPath(resolved);
    }

    // Compatibility guard: some providers emit Write(file_path=...) first and
    // place actual diff/text in later blocks. Writing empty content creates
    // confusing "0 lines written" behavior. Try to recover payload fields; if
    // still empty, fail fast so the model can retry with full content.
    if (toolName === 'Write' || toolName === 'writeFile' || toolName === 'write_file') {
      if (params.content === undefined || params.content === null) {
        const candidate = [
          params.text,
          params.body,
          params.value,
          params.contents,
          params.new_content,
          params.newContent,
          params.file_content,
          params.content_text,
        ].find(v => v !== undefined && v !== null);
        if (candidate !== undefined) params.content = candidate;
      }
      if (Array.isArray(params.content)) {
        params.content = params.content.map(v => String(v)).join('\n');
      } else if (params.content !== undefined && params.content !== null && typeof params.content !== 'string') {
        try { params.content = JSON.stringify(params.content, null, 2); } catch { params.content = String(params.content); }
      }

      // If the model actually intended a targeted replacement, auto-route to Edit.
      if ((!params.content || String(params.content).trim() === '') && params.old_string !== undefined && params.new_string !== undefined) {
        toolName = 'Edit';
        params.file_path = params.file_path || params.path;
      }
    }

    if ((toolName === 'Write' || toolName === 'writeFile' || toolName === 'write_file')
      && (!params.content || String(params.content).trim() === '')
      && !params.allow_empty
      && !params.create_empty) {
      return {
        success: false,
        text: 'Write tool rejected empty content. Please provide full file content (or set allow_empty/create_empty explicitly).',
      };
    }

    // In non-interactive (pipe) mode, pre-approve tools to avoid blocking on stdin.
    // Read-only tools are already auto-approved via the risk='low' change.
    // Write tools need explicit pre-approval for non-TTY contexts.
    const isNonInteractive = !process.stdin.isTTY;
    if (isNonInteractive) {
      try {
        const tc = require('./toolCalling');
        if (typeof tc.approveTool === 'function') {
          tc.approveTool(toolName, false);
          // Also approve aliases and snake_case variants
          const snakeMap = { 'Write': 'write_file', 'Read': 'read_file', 'Edit': 'edit_file', 'shellCommand': 'shell_command' };
          if (snakeMap[toolName]) tc.approveTool(snakeMap[toolName], false);
          // Pre-approve related tools (e.g. Edit after Read, Write after Read)
          for (const related of ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'read_file', 'write_file', 'edit_file', 'editFile', 'shellCommand', 'shell_command']) {
            tc.approveTool(related, false);
          }
        }
      } catch { /* best effort */ }
    }

    try {
      const r = await tools.execute(toolName, params, context);
      return normalizeToolResult(r);
    } catch (e) {
      return { success: false, text: `Tool ${toolName} error: ${e.message}` };
    }
  }

  if (call.action === '搜索') {
    const query = call.arg || '最新市场信息';
    const r = await tools.execute('webSearch', { query }, context);
    return normalizeToolResult(r);
  }

  if (call.action === '计算器') {
    const val = safeEvalExpression(call.arg);
    return { success: true, text: `Calculator result: ${val}` };
  }

  if (call.action === '读取文件') {
    const p = String(call.arg || '').replace(/^\/+/, '');
    const r = await tools.execute('readFile', { path: p }, context);
    return normalizeToolResult(r);
  }

  if (call.action === '写入文件') {
    const [filePath, ...rest] = String(call.arg || '').split('|');
    const content = rest.join('|').trim();
    const r = await tools.execute('writeFile', { path: (filePath || '').trim(), content }, context);
    return normalizeToolResult(r);
  }

  if (call.action === '命令') {
    const r = await tools.execute('shellCommand', { command: call.arg }, context);
    return normalizeToolResult(r);
  }

  if (call.action === '打开应用') {
    const r = await tools.execute('openApp', { name: call.arg }, context);
    return normalizeToolResult(r);
  }

  if (call.action === '行情') {
    const r = await tools.execute('quote', { symbol: call.arg }, context);
    return normalizeToolResult(r);
  }

  if (call.action === '回测') {
    const kv = parseKVArg(call.arg);
    const r = await tools.execute('backtest', {
      symbol: kv.symbol || kv.code || '000300',
      strategy: kv.strategy || 'ma_cross',
      start: kv.start,
      end: kv.end,
      capital: kv.capital ? Number(kv.capital) : undefined,
    }, context);
    return normalizeToolResult(r);
  }

  if (call.action === 'K线') {
    const parts = String(call.arg || '').trim().split(/\s+/).filter(Boolean);
    const symbol = parts[0] || '000001';
    const period = parts[1] || 'daily';
    const r = await tools.execute('dataFetch', { symbol, period }, context);
    return normalizeToolResult(r);
  }

  if (call.action === '策略列表') {
    const r = await tools.execute('strategyList', {}, context);
    return normalizeToolResult(r);
  }

  if (call.action === 'Git状态') {
    const r = await tools.execute('gitStatus', {}, context);
    return normalizeToolResult(r);
  }

  if (call.action === 'Git差异') {
    const r = await tools.execute('gitDiff', call.arg ? { file: call.arg } : {}, context);
    return normalizeToolResult(r);
  }

  if (call.action === '导入模型') {
    const source = call.arg || '';
    // Detect if it's a URL or local path
    const isUrl = /^https?:\/\//i.test(source);
    if (isUrl) {
      const r = await tools.execute('download_model', { url: source }, context);
      return normalizeToolResult(r);
    }
    const r = await tools.execute('import_model', { source }, context);
    return normalizeToolResult(r);
  }

  if (call.action === '模型列表') {
    const r = await tools.execute('list_models', {}, context);
    return normalizeToolResult(r);
  }

  if (call.action === '导出模型') {
    const r = await tools.execute('export_ollama_model', { model: call.arg }, context);
    return normalizeToolResult(r);
  }

  if (call.action === 'PDF转Word') {
    const parts = String(call.arg || '').split('|');
    const r = await tools.execute('pdfToWord', {
      inputPath: (parts[0] || '').trim(),
      outputPath: (parts[1] || '').trim() || undefined,
    }, context);
    return normalizeToolResult(r);
  }

  if (call.action === '图片识别') {
    const arg = String(call.arg || '').trim();
    // Support "image_path|output.docx" format
    const parts = arg.split('|');
    const r = await tools.execute('imageOcr', {
      imagePath: (parts[0] || '').trim(),
      outputPath: (parts[1] || '').trim() || undefined,
    }, context);
    return normalizeToolResult(r);
  }

  return { success: false, text: `Unsupported natural tool action: ${call.action}` };
}

// Sampling policy lives in a zero-dependency leaf so gateway adapters can borrow
// it without importing this runtime ([DESIGN-ARCH-051] §6.8). Re-exported below
// with byte-identical names/behavior.
const { isCreativeRequest, lockTemperature, lockTopP } = require('./samplingPolicy');

/**
 * Local output post-processor — enforces formatting rules that were
 * previously in the system prompt (R1, R9, R10, R14) without consuming tokens.
 */
function postProcessOutput(text) {
  let out = String(text || '').trim();
  if (!out) return out;

  // Strip filler phrases at start (was Rule R1)
  const FILLER_RE = /^(好的[，,]?\s*|让我[来为]?\s*|首先[，,]?\s*|接下来[，,]?\s*|当然[了，,]?\s*|没问题[，,]?\s*|我来\s*|请稍等[，,]?\s*|嗯[，,]?\s*|好[的吧]?[，,]\s*)+/;
  out = out.replace(FILLER_RE, '');

  // Collapse nested bullets to flat (was Rule R10)
  out = out.replace(/^(\s{2,})[•\-\*]/gm, '-');

  // Strip leaked chain-of-thought (was Rule R14)
  out = out.replace(/<think>[\s\S]*?<\/think>/g, '');
  out = out.replace(/\(内部推理[:：][\s\S]*?\)/g, '');

  return out.trim();
}

// ── System Prompt — Modular Builder (Claude Code architecture) ──
// Uses the new constants/prompts.js modular section system with cache boundary.
// Legacy HARDCORE_SYSTEM_PROMPT is kept as fallback for local/Ollama models.
const {
  getSystemPrompt: getModularSystemPrompt,
  assembleSystemPrompt,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
} = require('../constants/prompts');

const _promptCache = new Map();
const PROMPT_CACHE_MAX = 32;

/**
 * Build system prompt using the modular section architecture.
 * For cloud models (Claude, GPT-4, etc.): uses Claude Code-aligned modular prompt.
 * For local models (Ollama, llama.cpp): uses legacy HARDCORE_SYSTEM_PROMPT as
 * small models need the more compact, directive-heavy format.
 *
 * @param {string} baseSecurity - Additional security instructions
 * @param {object} modelInfo - { model, adapter }
 * @param {Array} bootstrapFiles - Workspace context files
 * @param {object} [promptRuntimeOpts] - Runtime prompt selection context
 * @returns {string} Complete system prompt
 */
async function makeSystemPrompt(baseSecurity = '', modelInfo = {}, bootstrapFiles = [], promptRuntimeOpts = {}) {
  const crypto = require('crypto');
  const os = require('os');
  const { getDesktopPath } = require('../utils/pathCompat');

  const modelId = modelInfo.model || process.env.GATEWAY_PREFERRED_MODEL
    || process.env.OLLAMA_MODEL || 'auto';
  const adapter = modelInfo.adapter || process.env.GATEWAY_PREFERRED_ADAPTER || 'auto';

  // Model-capability tier → harness profile. Same spine the tool-use loop uses
  // (modelTier.js). `lean` verbosity (T0 frontier only) drops the weak-model
  // hand-holding scaffolding sections below; T1/T2/T3 keep today's full prompt.
  const _modelTier = require('./modelTier');
  const _harnessProfile = _modelTier.harnessProfile(
    _modelTier.resolveTier(modelId),
    { contextWindow: promptRuntimeOpts.contextWindow },
  );
  const _lean = _harnessProfile.promptVerbosity === 'lean';
  // Short-context (small-window) models also drop the multi-KB hand-holding
  // sections — not because they're trusted to do it natively (T0 lean) but
  // because an 8k–32k window cannot afford the bulk. They still get the
  // token-cheap compact discipline cue below, and their runtime nudges /
  // synthetic-tool layer stay ON (tier-driven, not verbosity-driven).
  const _short = _harnessProfile.shortContext === true;
  const _compactPrompt = _lean || _short;

  // Determine if we should use modular prompt (cloud models) or legacy (local)
  const isCloudModel = /claude|gpt|gemini|deepseek/i.test(modelId) ||
    /api|claude|openai|cursor|kiro|codex/i.test(adapter);
  const forceModular = process.env.KHY_MODULAR_PROMPT === '1' ||
    process.env.KHY_CLAUDE_PROMPT === '1';
  const forceLegacy = process.env.KHY_LEGACY_PROMPT === '1';

  const useModular = (isCloudModel || forceModular) && !forceLegacy;

  let enabledTools = [];
  try {
    const toolModule = require('../tools');
    enabledTools = [...toolModule.getEnabled().values()].map(t => t.name);
  } catch { /* tools not loaded yet */ }

  try {
    const { getClaudeCompatToolList } = require('./claudeCompat');
    for (const compat of getClaudeCompatToolList()) {
      enabledTools.push(compat.name);
    }
  } catch { /* best effort */ }

  const {
    getOnDemandPromptSections,
    getOnDemandPromptSectionDecision,
  } = require('../constants/prompts');
  const promptCapsuleOpts = {
    userMessage: promptRuntimeOpts.userMessage,
    taskScale: promptRuntimeOpts.taskScale,
    enabledTools,
    promptFeatures: promptRuntimeOpts.promptFeatures,
    forceAllPromptSections: promptRuntimeOpts.forceAllPromptSections,
  };
  const promptCapsuleDecision = getOnDemandPromptSectionDecision(promptCapsuleOpts);
  const activePromptSectionIds = Array.isArray(promptCapsuleDecision?.ids)
    ? promptCapsuleDecision.ids
    : [];
  const promptCapsuleMode = String(promptCapsuleDecision?.mode || 'unknown');

  let fullPrompt;

  if (useModular) {
    // ── 批4 缺口③: structural unification ──
    // Route the modular prompt through the single-source async builder
    // constants/prompts.getSystemPrompt (per-section cache + correct
    // cwd/git/memory cacheKeys — the migration dividend). The legacy inline
    // modular assembly further down is retained for one release as the escape
    // hatch KHY_UNIFIED_PROMPT=0 (byte-identical to today's modular output).
    const _unified = process.env.KHY_UNIFIED_PROMPT !== '0';
    if (_unified) {
      const uCwd = process.cwd();
      // Native-tool-use / low-tier decision — single-sourced in modelToolingCapability
      // (the SAME SSOT the strip gates in relayApiAdapter/multiFreeService consult, so
      // "strip native tools" and "teach <tool_call> text protocol" can never drift —
      // a model whose tools get stripped is GUARANTEED to be taught the text fallback).
      // Gate KHY_MODEL_TOOLING_CAPABILITY off → byte-revert to the legacy inline logic.
      const _toolCap = require('./gateway/modelToolingCapability');
      const _modelForTier = String(modelInfo?.model || process.env.GATEWAY_PREFERRED_MODEL || modelId || '');
      let adapterSupportsNativeToolUse;
      let hasNativeToolUse;
      if (_toolCap.isEnabled()) {
        adapterSupportsNativeToolUse = _toolCap.adapterSupportsNativeToolUse(adapter);
        let _measured = null;
        try { _measured = require('./gateway/toolCapabilityStore').getVerdict(_modelForTier); } catch { /* best effort */ }
        hasNativeToolUse = _toolCap.hasNativeToolUse({ model: _modelForTier, adapter, measured: _measured });
      } else {
        const NATIVE_TOOL_USE_ADAPTERS = /^(kiro|cursor|trae|claude|codex|api|windsurf|vscode|warp|cursor2api|relay_api)$/i;
        adapterSupportsNativeToolUse = NATIVE_TOOL_USE_ADAPTERS.test(adapter);
        hasNativeToolUse = adapterSupportsNativeToolUse;
        const _LOW_TIER_RE = /(mini|lite|flash|haiku|small|7b|8b|3b|1\.5b|nano|tiny)/i;
        if (adapterSupportsNativeToolUse && _LOW_TIER_RE.test(_modelForTier)) {
          hasNativeToolUse = false;
        }
      }
      const isLowTierModel = !hasNativeToolUse && adapterSupportsNativeToolUse;

      // Deferred-tools hint: list deferred tools available via ToolSearch. Built
      // here because it depends on the live tools-module reveal state.
      let deferredToolsHint = '';
      try {
        const toolModule = require('../tools');
        if (typeof toolModule.getDeferredTools === 'function' &&
            typeof toolModule.getRevealedDeferred === 'function') {
          const deferred = toolModule.getDeferredTools();
          const revealed = toolModule.getRevealedDeferred();
          const unrevealed = [];
          for (const [name] of deferred) {
            if (!revealed.has(name)) unrevealed.push(name);
          }
          if (unrevealed.length > 0) {
            deferredToolsHint =
              `# Additional Tools\n` +
              `The following tools are available but not currently loaded to save context space. ` +
              `Use the toolSearch tool to discover and activate them when needed:\n` +
              unrevealed.join(', ');
          }
        }
      } catch { /* tools not loaded yet */ }

      const _sections = await getModularSystemPrompt({
        enabledTools,
        model: modelId,
        adapter,
        cwd: uCwd,
        userMessage: promptRuntimeOpts.userMessage,
        taskScale: promptRuntimeOpts.taskScale,
        promptFeatures: promptRuntimeOpts.promptFeatures,
        forceAllPromptSections: promptRuntimeOpts.forceAllPromptSections,
        languagePreference: process.env.KHY_LANGUAGE || undefined,
        // Inline modular defaults output style to senior-engineer; match it here
        // (getOutputStyleConfig disables on off/none/false/0 → null).
        outputStyleName: process.env.KHY_OUTPUT_STYLE || 'senior-engineer',
        contextWindowTokens: promptRuntimeOpts.contextWindow,
        hasNativeToolUse,
        isLowTierModel,
        compactPrompt: _compactPrompt,
        baseSecurity,
        bootstrapFiles,
        deferredToolsHint,
      });
      return assembleSystemPrompt(_sections);
    }

    // ── Legacy inline modular assembly (KHY_UNIFIED_PROMPT=0 escape hatch) ──
    // ── Modular prompt (Claude Code architecture) ──
    const cwd = process.cwd();

    // Build synchronously from cached sections (async sections resolve to cached values)
    // For the initial call, we build a synchronous version
    const sections = [];

    // Static intro
    sections.push(
      `\nYou are khy OS, an intelligent operating system assistant powered by AI.\n` +
      `You are an interactive agent that helps users with software engineering tasks, ` +
      `system operations, and general knowledge. ` +
      `Use the instructions below and the tools available to you to assist the user.\n\n` +
      `${require('../constants/cyberRiskInstruction').CYBER_RISK_INSTRUCTION}\n` +
      `IMPORTANT: You must NEVER generate or guess URLs for the user unless you are confident that the URLs are for helping the user with programming. You may use URLs provided by the user in their messages or local files.`
    );

    // System section
    const { getSimpleSystemSection, getDoingTasksSection, getExecutionDisciplineSection,
      getPlanningAndRecoverySection, getSessionMemoryAndContextSection,
      getUsingYourToolsSection, getToneAndStyleSection, getOutputEfficiencySection,
      getEnvironmentSection, getKhySpecificSection,
      getOutputStyleSection,
      getProjectInstructionsSection, getGitStatusSection, getMemorySection,
      getPersonaSection, getCompactTaskDisciplineSection,
    } = require('../constants/prompts');
    const cacheKey = crypto.createHash('sha256')
      .update(JSON.stringify({
        modelId,
        adapter,
        baseSecurity,
        useModular,
        bootstrapPaths: (bootstrapFiles || []).map(f => f.path).sort(),
        promptCapsuleMode,
        promptCapsules: activePromptSectionIds,
        taskScale: String(promptRuntimeOpts.taskScale || ''),
        verbosity: _harnessProfile.promptVerbosity,
        shortContext: _short,
        // Persona is loaded from persona.md below; fold its fingerprint into the
        // cache key so edits to persona.md invalidate the cached prompt (C1).
        personaStamp: (() => {
          try { return require('./personaService').personaStamp(cwd); } catch { return 'none'; }
        })(),
        // Ephemeral role overlay (DESIGN-ARCH-059 #3): fold the active-role
        // fingerprint in so adopting/exiting a role busts the cached prompt.
        roleStamp: (() => {
          try { return require('./roleService').roleStamp(); } catch { return 'none'; }
        })(),
      }))
      .digest('hex');

    let cached = _promptCache.get(cacheKey);
    if (cached) return cached;

    // Stable-prefix mode (DESIGN-ARCH-047, KHY_STABLE_PREFIX=1, default OFF):
    // keep the boundary marker IN the joined string so the adapter can split the
    // system prompt into a cacheable static prefix + a volatile dynamic suffix,
    // and move request-variable on-demand sections into the dynamic region. This
    // makes the prefix byte-stable across requests/days so the upstream prompt
    // cache actually hits. Off by default → byte-identical to today's behavior.
    const _stablePrefix = process.env.KHY_STABLE_PREFIX === '1';

    // getSimpleSystemSection is mechanics (permission modes, <system-reminder>,
    // hook handling, auto-compaction contract) — every tier needs it.
    sections.push(getSimpleSystemSection());
    // The following are behavioral hand-holding written for weak models
    // ("don't gold-plate", "stop after 2-3 retries", "diagnose before retry").
    // Frontier models (T0, lean) do this natively — skip to avoid caging them.
    // On-demand sections are classified from userMessage → request-variable. In
    // stable-prefix mode we DEFER them past the boundary (B2) so the static
    // prefix stays request-independent; otherwise they stay here (today's order).
    const _onDemandSections = (!_compactPrompt) ? getOnDemandPromptSections(promptCapsuleOpts) : [];
    if (!_compactPrompt) {
      sections.push(getDoingTasksSection());
      sections.push(getExecutionDisciplineSection());
      sections.push(getPlanningAndRecoverySection());
      if (!_stablePrefix) {
        for (const section of _onDemandSections) {
          sections.push(section);
        }
      }
    } else {
      // [P5] Lean (T0 frontier) and short-context (small-window) models skip the
      // full hand-holding sections — T0 because it does this natively, short
      // context because an 8k–32k window can't afford the bulk — but a complete
      // skip left them with no main-loop planning cue. Inject a single-bullet
      // task discipline instead (token-cheap, default on).
      const _disciplineRaw = String(process.env.KHY_PLANNING_DISCIPLINE || 'true').trim().toLowerCase();
      if (!['0', 'false', 'off', 'no'].includes(_disciplineRaw)) {
        sections.push(getCompactTaskDisciplineSection());
      }
    }
    sections.push(getSessionMemoryAndContextSection());
    sections.push(getUsingYourToolsSection(enabledTools));

    // Deferred tools hint: list tools available via ToolSearch
    try {
      const toolModule = require('../tools');
      if (typeof toolModule.getDeferredTools === 'function' &&
          typeof toolModule.getRevealedDeferred === 'function') {
        const deferred = toolModule.getDeferredTools();
        const revealed = toolModule.getRevealedDeferred();
        const unrevealed = [];
        for (const [name] of deferred) {
          if (!revealed.has(name)) unrevealed.push(name);
        }
        if (unrevealed.length > 0) {
          sections.push(
            `# Additional Tools\n` +
            `The following tools are available but not currently loaded to save context space. ` +
            `Use the toolSearch tool to discover and activate them when needed:\n` +
            unrevealed.join(', ')
          );
        }
      }
    } catch { /* tools not loaded yet */ }

    sections.push(getToneAndStyleSection());
    sections.push(getOutputEfficiencySection());

    // Dynamic boundary
    sections.push(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);

    // Deferred request-variable on-demand sections live in the dynamic region (B2).
    if (_stablePrefix && !_compactPrompt) {
      for (const section of _onDemandSections) {
        sections.push(section);
      }
    }

    // Dynamic sections
    const memorySection = getMemorySection();
    if (memorySection) sections.push(memorySection);

    sections.push(getEnvironmentSection(modelId, cwd));

    // Language preference
    const lang = process.env.KHY_LANGUAGE || null;
    if (lang) {
      sections.push(`# Language\nAlways respond in ${lang}. Use ${lang} for all explanations, comments, and communications with the user. Technical terms and code identifiers should remain in their original form.`);
    }

    // Default output style: senior-engineer (can be disabled via KHY_OUTPUT_STYLE=off|none|false|0)
    try {
      const styleRaw = String(process.env.KHY_OUTPUT_STYLE || 'senior-engineer').trim();
      const styleKey = styleRaw.toLowerCase();
      const styleDisabled = ['off', 'none', 'false', '0'].includes(styleKey);
      if (!styleDisabled && styleRaw) {
        const { BUILT_IN_STYLES } = require('../constants/outputStyles');
        let styleConfig = BUILT_IN_STYLES[styleRaw] || BUILT_IN_STYLES[styleKey] || null;
        if (!styleConfig) {
          const stylePath = path.join(os.homedir(), '.khy', 'output-styles', `${styleRaw}.md`);
          if (fs.existsSync(stylePath)) {
            const content = fs.readFileSync(stylePath, 'utf-8').trim();
            if (content) {
              styleConfig = { name: styleRaw, prompt: content, keepCodingInstructions: true };
            }
          }
        }
        if (styleConfig) {
          const styleSection = getOutputStyleSection(styleConfig);
          if (styleSection) sections.push(styleSection);
        }
      }
    } catch { /* best effort */ }

    // Project instructions (CLAUDE.md, KHY.md)
    const projInstructions = getProjectInstructionsSection(cwd);
    if (projInstructions) sections.push(projInstructions);

    // Persona (C1) — executable behavior spec; project instructions above win
    // on conflict. Injection-scanned inside personaService.
    const personaSection = getPersonaSection(cwd);
    if (personaSection) sections.push(personaSection);

    // Git status
    const gitStatus = getGitStatusSection(cwd);
    if (gitStatus) sections.push(gitStatus);

    // khy OS specific capabilities
    // 云端/IDE 适配器支持原生 function calling，不需要 <tool_call> 格式教学
    // 但小模型即使通过云适配器也可能无法可靠生成结构化 tool_use。
    // 该判定单一真源在 modelToolingCapability(与 relayApiAdapter/multiFreeService 的
    // 剥离门同源):凡被判缺乏原生工具调用的模型,这里注入 <tool_call> 教学、那边剥离
    // 上游 tools——两者永远同步,模型即便没有 function calling 也经文本拦截保住工具能力。
    // 实测为准:measured 来自 toolCapabilityStore(live probe / 被动学习),一个名字含
    // flash/lite 但实测能原生调工具的模型,measured='native' 即拉回原生(不再教文本格式)。
    // 门控 KHY_MODEL_TOOLING_CAPABILITY 关 → 字节回退到下方旧内联逻辑。
    const _toolCap = require('./gateway/modelToolingCapability');
    const _modelId = modelInfo?.model || process.env.GATEWAY_PREFERRED_MODEL || '';
    let adapterSupportsNativeToolUse;
    let hasNativeToolUse;
    if (_toolCap.isEnabled()) {
      adapterSupportsNativeToolUse = _toolCap.adapterSupportsNativeToolUse(adapter);
      let _measured = null;
      try { _measured = require('./gateway/toolCapabilityStore').getVerdict(_modelId); } catch { /* best effort */ }
      hasNativeToolUse = _toolCap.hasNativeToolUse({ model: _modelId, adapter, measured: _measured });
    } else {
      const NATIVE_TOOL_USE_ADAPTERS = /^(kiro|cursor|trae|claude|codex|api|windsurf|vscode|warp|cursor2api|relay_api)$/i;
      adapterSupportsNativeToolUse = NATIVE_TOOL_USE_ADAPTERS.test(adapter);
      hasNativeToolUse = adapterSupportsNativeToolUse;
      const _LOW_TIER_RE = /(mini|lite|flash|haiku|small|7b|8b|3b|1\.5b|nano|tiny)/i;
      if (adapterSupportsNativeToolUse && _LOW_TIER_RE.test(_modelId)) {
        hasNativeToolUse = false;  // 触发 _toolCallingFallbackProfile() 注入 <tool_call> 格式教学
      }
    }
    const _isLowTierModel = !hasNativeToolUse && adapterSupportsNativeToolUse;
    sections.push(getKhySpecificSection({
      hasNativeToolUse,
      _isLowTierModel,
      taskScale: promptRuntimeOpts.taskScale,
    }));

    // Synthetic tool layer hints for non-native / low-tier models
    // Makes small models output clearer patterns so the synthetic layer can detect & act
    if (!hasNativeToolUse || _isLowTierModel) {
      sections.push([
        '# 内容输出指南',
        '当用户要求创建文档、保存文件或执行命令时：',
        '- 直接在回复中包含全部内容（不要说"我无法保存文件"）',
        '- 明确说明建议的文件名和类型',
        '- 提及用户指定的保存位置',
        '- 系统会自动帮你完成保存操作',
      ].join('\n'));
    }

    // Bootstrap file injection (workspace context)
    if (bootstrapFiles && bootstrapFiles.length > 0) {
      try {
        const { injectWithBudget } = require('./bootstrapBudget');
        const { injected } = injectWithBudget(bootstrapFiles, {
          perFileMaxChars: 8000, totalMaxChars: 24000,
        });
        if (injected.length > 0) {
          const contextParts = injected
            .filter(s => s.injectedChars > 0)
            .map(s => `--- ${s.path} ---\n${s.injectedContent}`);
          if (contextParts.length > 0) {
            sections.push(`# Workspace context\n${contextParts.join('\n')}`);
          }
        }
      } catch { /* bootstrapBudget not available */ }
    }

    // Additional security
    if (baseSecurity) sections.push(baseSecurity);

    // Tool guide — 原生适配器走结构化 function calling，不需要 <tool_call> 格式教学。
    // 非原生适配器的工具格式教学已由 prompts.js 的 _toolCallingFallbackProfile 注入，
    // 不再在此重复注入 buildNaturalToolGuide 动态列表。

    // In stable-prefix mode the boundary marker is RETAINED in the joined string
    // so the adapter can split prefix/suffix and place the cache breakpoint
    // between them; otherwise it is stripped (today's behavior).
    fullPrompt = sections
      .filter(s => s != null && (_stablePrefix || s !== SYSTEM_PROMPT_DYNAMIC_BOUNDARY))
      .join('\n\n');

    _promptCache.set(cacheKey, fullPrompt);
    if (_promptCache.size > PROMPT_CACHE_MAX) {
      _promptCache.delete(_promptCache.keys().next().value);
    }
  } else {
    const cacheKey = crypto.createHash('sha256')
      .update(JSON.stringify({
        modelId,
        adapter,
        baseSecurity,
        useModular,
        bootstrapPaths: (bootstrapFiles || []).map(f => f.path).sort(),
        promptCapsuleMode,
        promptCapsules: activePromptSectionIds,
        taskScale: String(promptRuntimeOpts.taskScale || ''),
        verbosity: _harnessProfile.promptVerbosity,
        shortContext: _short,
      }))
      .digest('hex');

    let cached = _promptCache.get(cacheKey);
    if (cached) return cached;

    // ── Legacy prompt for local models ──
    const platform = os.platform();
    const homeDir = os.homedir().replace(/\\/g, '/');

    const cwd = (process.env.KHYQUANT_CWD || process.cwd()).replace(/\\/g, '/');

    const desktopDir = getDesktopPath().replace(/\\/g, '/');
    let prompt = HARDCORE_SYSTEM_PROMPT
      .replace(/\{\{MODEL_ID\}\}/g, modelId)
      .replace(/\{\{ADAPTER\}\}/g, adapter)
      .replace(/\{\{PLATFORM\}\}/g, require('../constants/nodePlatformLabel').resolvePlatformLabel(platform))
      .replace(/\{\{HOME_DIR\}\}/g, homeDir)
      .replace(/\{\{DESKTOP_DIR\}\}/g, desktopDir)
      .replace(/\{\{CWD\}\}/g, cwd);

    if (_ON_DEMAND_CAPSULE_MODES.has(promptCapsuleMode)) {
      prompt = _stripLegacyManagedPromptSections(prompt);
      const optionalCapsules = getOnDemandPromptSections(promptCapsuleOpts);
      if (optionalCapsules.length > 0) {
        prompt += `\n\n${optionalCapsules.join('\n\n')}\n`;
      }
    }

    let osHint;
    if (platform === 'linux') {
      osHint = `\n<env>OS: Linux · Shell: bash\nUse direct command names for apps. Use absolute paths.</env>\n`;
    } else if (platform === 'win32') {
      osHint = `\n<env>OS: Windows · Shell: PowerShell\nUse start command. Desktop path: ${desktopDir}</env>\n`;
    } else {
      osHint = `\n<env>OS: macOS · Shell: bash\nUse "open -a AppName" or direct command names.</env>\n`;
    }

    // Bootstrap files
    if (bootstrapFiles && bootstrapFiles.length > 0) {
      try {
        const { injectWithBudget } = require('./bootstrapBudget');
        const { injected } = injectWithBudget(bootstrapFiles, {
          perFileMaxChars: 8000, totalMaxChars: 24000,
        });
        if (injected.length > 0) {
          prompt += '\n<workspace-context>\n';
          for (const stat of injected) {
            if (stat.injectedChars > 0) {
              prompt += `--- ${stat.path} ---\n${stat.injectedContent}\n`;
            }
          }
          prompt += '</workspace-context>\n';
        }
      } catch { /* best effort */ }
    }

    const dynamicSuffix = buildNaturalToolGuide();
    fullPrompt = prompt + osHint + (baseSecurity || '') + '\n' + dynamicSuffix;
    fullPrompt = fullPrompt.replace(/\{\{TOOL_LIST\}\}\n?/, '').replace(/\{\{\/TOOL_LIST\}\}\n?/, '');

    _promptCache.set(cacheKey, fullPrompt);
    if (_promptCache.size > PROMPT_CACHE_MAX) {
      _promptCache.delete(_promptCache.keys().next().value);
    }
  }

  return fullPrompt;
}

function buildFlatConversation(systemPrompt, messages) {
  let _ct;
  try { _ct = require('./contentBlockUtils').contentToText; } catch { _ct = (c) => String(c || ''); }

  return [
    systemPrompt,
    '',
    ...messages.map(m => {
      const text = _ct(m.content);
      if (m.role === 'tool') return `[ToolResult]\n${text}`;
      return `${m.role.toUpperCase()}: ${text}`;
    }),
  ].join('\n');
}

module.exports = {
  CONTEXT_TOKEN_LIMIT,
  HARDCORE_SYSTEM_PROMPT,
  inputPurify,
  isGreeting: _isGreeting,
  buildSlidingWindow,
  buildNaturalToolGuide,
  extractNaturalToolCall,
  runNaturalToolCall,
  lockTemperature,
  lockTopP,
  makeSystemPrompt,
  buildFlatConversation,
  postProcessOutput,
  estimateTokens,
  buildIntentAssuranceDirective,
  _ON_DEMAND_CAPSULE_MODES,
};

'use strict';

// Inline tool-call NOISE stripper — pure leaf (zero IO, zero business require,
// deterministic, env-gated).
//
// WHY THIS EXISTS (the real defect it fixes):
//   When a model speaks the "text tool protocol" (rather than emitting native
//   tool_use blocks) it writes the tool invocation as ORDINARY TEXT in its
//   answer stream. Two forms leak verbatim into the rendered transcript:
//     1. a bare JSON object line:  {"name":"open_app","params":{"name":"夸克"}}
//     2. XML-ish function tags:    <function=shell_command> … </function>
//   These are redundant with the structured tool-call lines the UI already
//   renders from real tool_use events (the pretty `⏺ ToolName(...)` /
//   `✓ 已批准: shellCommand(...)` rows). Left in, they are pure visual noise —
//   the user asked for a clean transcript "类似 CC 这样".
//
//   The existing `deliveryFormatter.stripToolCalls` recognizes neither form, and
//   the streaming render path strips nothing at all. This leaf is the single
//   source of truth for "what is inline tool-call noise"; it is applied at the
//   common render funnel (`_renderMarkdownLiteInner`) so all four render paths
//   (classic final / classic streaming / TUI committed / TUI live tail) get a
//   clean transcript, and is reused by `stripToolCalls` for stored replies.
//
// Display-only / non-destructive: storage keeps the verbatim stream (the TUI
// deliberately treats `live.text` as truth). We only strip on the way to screen.
//
// Gate: KHY_TOOLCALL_NOISE_STRIP (default ON). Off → byte-identical passthrough.

const OFF_VALUES = ['0', 'false', 'off', 'no'];

function isEnabled(env) {
  const raw = env && env.KHY_TOOLCALL_NOISE_STRIP;
  const v = String(raw == null ? '' : raw)
    .trim()
    .toLowerCase();
  return !OFF_VALUES.includes(v);
}

// A fenced-code-block delimiter line (``` or ~~~, optional info string). Content
// inside fences is SACRED — a user/model legitimately showing such JSON in a
// code block must be preserved (load-bearing false-positive guard).
const FENCE_RE = /^[ \t]*(?:```|~~~)/;

// A line that is ONLY an opening `<function=NAME>` tag (whitespace allowed).
const FUNC_OPEN_LINE_RE = /^\s*<function\s*=\s*[^>\n]+>\s*$/i;
// A line that is ONLY a closing `</function>` tag.
const FUNC_CLOSE_LINE_RE = /^\s*<\/function\s*>\s*$/i;

// A whole-line function tag FRAGMENT leaked by stream-chunk truncation: the
// leading '<' and/or trailing '>' may be missing (real leak observed:
// `function=webSearch>` — the '<' was swallowed at a chunk boundary). Anchored
// to the whole line so prose like `这是一个 function=add 的示例` is never touched.
// Fragment forms drop ONLY the line (no block-swallow state: a truncated open
// tag has no guaranteed close and must not eat the rest of the answer).
const FUNC_FRAG_LINE_RE = /^\s*<?\/?function\s*=\s*[\w.-]+\s*\/?>?\s*$/i;

// An `<arguments={…` line (the '<' may equally be swallowed). Covers the
// regular `}>` close, the malformed `}}` variant, a bare `}` and truncation.
const ARGS_OPEN_LINE_RE = /^\s*<?arguments\s*=\s*\{/i;
// The JSON body of an arguments tag looks finished: the line ends with one or
// more `}` optionally followed by a stray `>` (covers `}`, `}}`, `}>`, `"}`).
const ARGS_END_RE = /\}+\s*>?\s*$/;
// A continuation line that still looks like JSON: starts with a quote/brace/
// bracket, carries a `":` key marker, or ends with a comma / open brace.
const ARGS_JSON_CONT_RE = /^\s*["{[]|":|[,{[]\s*$/;

// Orphan whole-line fragments of the tag dialect family: `</arguments>`,
// `<parameter=…>`, `</parameter>`, plus stray `<tool_call>` / `</tool_call>`
// wrapper tags left alone on a line (with the same optional-bracket tolerance).
// `args` / `Read` 系 Claude/codex 文本工具协议泄漏(实测:整行 `</args>` / `</Read>`),
// 与 arguments 同族,一并纳入整行清理。
const ORPHAN_FRAG_LINE_RE =
  /^\s*<\/?(?:arguments|args|parameter|tool_call|Read)(?:\s*=\s*[^>\n]*)?\s*\/?>?\s*$/i;

// Balanced-paren scan over a line for a marker's `(` body: depth counting
// must respect string literals + escapes (JSON string values may legally
// contain `(` / `)`, e.g. `{"cmd":"echo )("`), mirroring _scanBalancedJson.
// Returns the index AFTER the matching close paren, or -1 when the body never
// closes on this line (marker genuinely truncated / body continues).
function _bracketBodyEnd(line) {
  const open = line.indexOf('(');
  if (open < 0) {
    return -1;
  }
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = open; i < line.length; i++) {
    const ch = line[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (inStr) {
      if (ch === '\\') {
        esc = true;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
    } else if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        return i + 1;
      }
    }
  }
  return -1;
}

// The arg body is a JSON object, so a COMPLETE bracket marker ALWAYS closes
// with `})]` (the object's last `}`, then the marker's `)`, then `]`). This is
// the cheap whole-line completion test — no paren scan needed; balanced-paren
// scanning is reserved for the in-bracket-body continuation check below. A
// space before `)` is tolerated (pretty-printed JSON `} )]`).
function _bracketMarkerClosed(line) {
  const t = line.replace(/\s+$/, '');
  return /\}\s*\)\s*\]$/.test(t);
}

// While swallowed in a multi-line marker body: the closing line carries the
// final `})]` of the marker (the JSON object's `}`, then the marker's `)`,
// then `]`). A blank line or a JSON-shaped line (key / value / brace / array
// continuation) stays inside the body. Anything else is clearly prose → end
// the swallow and KEEP it (false-positive guard: never eat answer text).
// While swallowed in a multi-line marker body: the closing line carries the
// final `})]` of the marker (the JSON object's `}`, then the marker's `)`,
// then `]` — an optional space between `}` and `)` is tolerated). Blank lines
// and JSON value-shape lines (string / number / literal / brace / array /
// comma) stay inside the body; anything else is prose → end the swallow and
// KEEP it (false-positive guard: never eat user-visible answer text).
function _isMarkerBodyLine(line) {
  if (_bracketMarkerClosed(line)) {
    return true;
  }
  const t = line.trim();
  if (t === '') {
    return true;
  }
  return /^(?:"[^"]*"|\d|true|false|null|[{}\[\]]|,)/.test(t);
}

// Bracketed wire-marker tool-call/result: the gateway's strip-tools text
// fallback (`_toolSchemaConverter` hasTools=false) inlines historical
// tool_use blocks as `[Tool Call: name(args)]` and tool_result blocks as
// `[Tool Result: id]` + body. Text-protocol models, having seen those markers
// in replayed history, echo them verbatim in their own answers (observed:
// `[Tool Call: shell_command({})]` leaked into the transcript unexecuted and
// unrendered). Whole-line call markers are pure noise — drop the line.
// The args body may span multi-line JSON, so completion is detected by a
// balanced-paren scan (BODY_OPEN marker); an unclosed body on the line holds
// the state until the line settles. Both shapes are fence-guarded below.
const BRACKET_CALL_HEAD_RE = /^\s*\[Tool\s+Call[:：]\s*$/i;
// Whole-line marker: `[Tool Call: name(args)]` where `args` is a JSON object
// and never contains `]`. Built via RegExp source string so the character
// class cannot be mangled by a `]`-closes-the-class trap: the body class
// excludes ONLY `]` (lines are newline-free by construction — the text is
// split on `\n` before this runs).
const BRACKET_CALL_MARKER_RE = new RegExp(
  '^\\s*\\[Tool\\s+Call[:\uFF1A][^\\u005D]*\\u005D\\s*$',
  'i'
);
// A head-only open: the marker head is on this line but the JSON body continues
// on later lines (`(` present, no closing `]` yet) → swallow-trigger for the
// multi-line inBracketCall state.
const BRACKET_CALL_BODY_OPEN_RE = new RegExp(
  '^\\s*\\[Tool\\s+Call[:\uFF1A][^\\u005D]*\u005D?\\s*$',
  'i'
);

// The arg body is a JSON object, so the marker ALWAYS closes with `})]` —
// `]` can never appear inside the JSON body. Completion therefore only needs
// a single-line lookahead: `})]` + optional trailing whitespace.
const BRACKET_TAIL_CLOSE_RE = /^\s*\}\)\]\s*$/;

// Inline (mid-prose) bracketed tool-call marker: `[Tool Call: name(args)]`
// glued to narration on the same line. Remove ONLY the marker, keep the
// surrounding prose. Balances the parens so a JSON arg body containing `)`
// does not truncate the match early; the name character class stays narrow
// (identifier-ish) so prose like `[Tool Call: see §3(a)]` is never eaten.
const INLINE_BRACKET_CALL_RE = /\[Tool\s+Call[:：]\s*(?:[A-Za-z_][\w.-]*)?\s*\((?:[^()\\]|\\.)*\)\s*\]/gi;

// A standalone bare tool-call JSON object: the ENTIRE trimmed line is
// `{"name":"<tool>", "params"|"arguments"|"input": …}`. Whole-line anchored +
// the two-key shape keeps this from eating prose that merely contains braces.
// The leading `{` may be missing (chunk-boundary truncation leak observed in
// the wild: `"name": "web_search", "params": {…}}`), and a stray `>` from a
// truncated wrapper tag may trail the object.
//
// This regex matches ONLY a whole-line pure JSON noise line (the object,
// optionally followed by a stray `>` from a truncated wrapper tag, then end of
// line). It does NOT tolerate other trailing text after the closing brace —
// mixed JSON+prose lines are owned by `_removeInlineToolJson` below, which
// uses a balanced-brace scan to remove just the JSON and keep the prose.
const BARE_JSON_RE =
  /^\{?\s*"name"\s*:\s*"[^"]+"\s*,\s*"(?:params|arguments|input)"\s*:[\s\S]*\}\s*>?\s*$/;

// Claude Code can echo a Read payload as ordinary text after the structured
// tool event. Restrict this detector to KHY's generated image bridge paths;
// arbitrary file_path JSON remains visible.
const KHY_IMAGE_PATH_RE = /(?:^|[\\/])khy-cli-img-[^\\/]+[\\/]image-\d+-[0-9a-f]+\.(?:png|jpe?g|webp|gif|bmp|svg|tiff?)$/i;
function _isGeneratedImageReadJson(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return false;
  }
  try {
    const value = JSON.parse(trimmed);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }
    const keys = Object.keys(value);
    if (keys.length !== 1 || keys[0] !== 'file_path' || typeof value.file_path !== 'string') {
      return false;
    }
    return KHY_IMAGE_PATH_RE.test(value.file_path.trim());
  } catch {
    return false;
  }
}

// Head of a bare tool-call JSON at line start, tolerating a swallowed leading
// `{` and a glued (possibly truncated) `<tool_call>` wrapper. Requires the
// params object opener so balanced-brace scanning can find where the JSON ends.
const LINE_START_JSON_HEAD_RE =
  /^\s*(?:<?\/?tool_call\s*>?\s*)?\{?\s*"name"\s*:\s*"[^"\n]+"\s*,\s*"(?:params|arguments|input)"\s*:\s*\{/i;
// Embedded occurrence (prose BEFORE the JSON on the same line): the leading
// `{` is required here — an anchored truncated head is only trusted at line
// start (see above), never mid-prose.
const EMBEDDED_JSON_HEAD_RE =
  /\{\s*"name"\s*:\s*"[^"\n]+"\s*,\s*"(?:params|arguments|input)"\s*:\s*\{/g;

// Scan from `start` (an opening `{`) to its matching close brace, string-aware.
// Returns the index AFTER the closing brace, or -1 when unbalanced.
// CONTRACT: `start` must point at the OUTERMOST `{` of the JSON object to be
// consumed — starting at an inner brace ends the scan at that inner close and
// leaves the outer object's head/tail behind.
function _scanBalancedJson(s, start) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (inStr) {
      if (ch === '\\') {
        esc = true;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return i + 1;
      }
    }
  }
  return -1;
}

// Remove every inline bare tool-call JSON object embedded in a line, keeping
// the surrounding prose (mixed-line leak: JSON glued to narration in either
// order). Surgical by construction: the two-key head + balanced-brace scan;
// a head whose body never closes on this line is left untouched (the streaming
// pending-tail hold and the whole-line checks own those shapes).
function _removeInlineToolJson(line) {
  let out = line;
  const headM = LINE_START_JSON_HEAD_RE.exec(out);
  if (headM) {
    // Scan from the OUTERMOST `{` of the head (not the params opener the regex
    // ends on): with extra keys after `params` (e.g. `…},"id":1}`) an inner-
    // brace scan would stop early and leak `,"id":1}…` residue. In the brace-
    // swallowed form (`"name":…`) the first `{` IS the params opener; the scan
    // then stops at its close and the leftover implied outer `}` is eaten by
    // the cleanup below — both shapes converge on clean prose.
    const jsonEnd = _scanBalancedJson(out, out.indexOf('{', headM.index));
    if (jsonEnd !== -1) {
      out = out.slice(0, headM.index) + out.slice(jsonEnd);
      out = out.replace(/^\s*\}?\s*>?\s*(?:<\/?tool_call\s*>)?\s*/i, '');
      if (/^\s*[=<>]/.test(out)) {
        out = '';
      }
    }
  }
  let m;
  EMBEDDED_JSON_HEAD_RE.lastIndex = 0;
  while ((m = EMBEDDED_JSON_HEAD_RE.exec(out)) !== null) {
    const end = _scanBalancedJson(out, m.index);
    if (end === -1) {
      break;
    }
    out = out.slice(0, m.index) + out.slice(end);
    out = out.replace(/^\s*\}?\s*>?\s*(?:<\/?tool_call\s*>)?\s*/i, '');
    if (/^\s*[=<>]/.test(out)) {
      out = out.trim() === '' ? '' : out;
    }
    EMBEDDED_JSON_HEAD_RE.lastIndex = 0;
  }
  if (out !== line) {
    out = out.replace(/<\/?tool_call\s*>/gi, '');
  }
  return out;
}

const FUNC_INLINE_PAIR_RE = /<function\s*=\s*[^>\n]+>[\s\S]*?<\/function\s*>/gi;

// Claude/Codex 风格 XML 工具方言:模型把工具调用写成多行标签块 ——
// `<tool_call>` / `<Write>` / `<args>` … `</Write>` / `</tool_call>`。khyos 只解析
// JSON 形式(`<tool_call>{"name":…}</tool_call>`),这类 XML 块无法执行,会整块泄进
// 正文(实测:Write/Read 练习文件时 `<file_path>`…`</Write>` 全部裸露)。按块吞并。
const TOOLCALL_OPEN_LINE_RE = /^\s*<tool_call\s*>\s*$/i;
// 块结束:显式 `</tool_call>`,或 Claude 方言里缺省外层闭合时的 `</ToolName>`
// (实测模型直接以 `</Read>` / `</Write>` 收尾,没有 `</tool_call>`)。
const TOOLCALL_CLOSE_LINE_RE =
  /^\s*(?:<\/tool_call\s*>|<\/(?:Write|Read|Edit|Bash|Grep|Glob|web_search|webSearch|Shell|PowerShell|AgentTool)\s*>)\s*$/i;
// 单行完整 JSON 形式 `<tool_call>{…}</tool_call>` 也整行丢弃(已被执行,无需上屏)。
const TOOLCALL_SINGLE_LINE_RE = /^\s*<tool_call\s*>[\s\S]*?<\/tool_call\s*>\s*$/i;

function stripInlineToolCallNoise(text, env) {
  if (!isEnabled(env)) {
    return text;
  }
  if (typeof text !== 'string' || text === '') {
    return text;
  }

  const lines = text.split('\n');
  const out = [];
  let inFence = false;
  let inFunc = false;
  let inArgs = false;
  let inToolCallXml = false;
  // Bracket marker body state: false | BODY_OPEN (marker head + body open,
  // awaiting balanced-paren close). Lives in the same fence-respecting scope
  // as inFunc/inArgs — a fence line ends any pending marker body.
  let inBracketCall = false;

  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      // A fence delimiter ends any stray function/arguments/tool_call block being dropped.
      inFunc = false;
      inArgs = false;
      inToolCallXml = false;
      inBracketCall = false;
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    if (inBracketCall) {
      // Inside a swallowed multi-line marker body. The body closes with `})]`;
      // JSON-shaped / blank lines keep it open; clearly prose ends the
      // swallow and KEEPS the line (never eat user-visible answer text).
      if (_isMarkerBodyLine(line)) {
        inBracketCall = false;
        // The closing `})]` line is the tail of the already-dropped head → drop.
      } else {
        inBracketCall = false;
        out.push(line);
      }
      continue;
    }
    if (inToolCallXml) {
      // 多行 XML 工具块:吞掉直到 </tool_call>。
      if (TOOLCALL_CLOSE_LINE_RE.test(line)) {
        inToolCallXml = false;
      }
      continue;
    }
    if (inFunc) {
      // Inside a <function=…> … </function> block: drop everything until close.
      if (FUNC_CLOSE_LINE_RE.test(line)) {
        inFunc = false;
      }
      continue;
    }
    if (inArgs) {
      // Swallowing a multi-line <arguments={…} JSON body.
      if (ARGS_END_RE.test(line)) {
        inArgs = false;
        continue;
      }
      if (ARGS_JSON_CONT_RE.test(line)) {
        continue;
      }
      // Clearly plain prose → stop swallowing and KEEP the line (load-bearing
      // false-positive guard: never eat user-visible answer text).
      inArgs = false;
      out.push(line);
      continue;
    }
    if (TOOLCALL_OPEN_LINE_RE.test(line)) {
      inToolCallXml = true;
      continue;
    }
    if (TOOLCALL_SINGLE_LINE_RE.test(line)) {
      continue;
    } // 单行 JSON 形式
    if (TOOLCALL_CLOSE_LINE_RE.test(line)) {
      continue;
    } // 游离关闭
    if (FUNC_OPEN_LINE_RE.test(line)) {
      inFunc = true;
      continue;
    }
    if (FUNC_CLOSE_LINE_RE.test(line)) {
      continue;
    } // stray close without open
    if (FUNC_FRAG_LINE_RE.test(line)) {
      continue;
    } // truncated tag fragment line
    if (ARGS_OPEN_LINE_RE.test(line)) {
      // Single-line body (any of `}`, `}}`, `}>` endings) → just drop the line;
      // otherwise the JSON body continues on following lines → swallow state.
      if (!ARGS_END_RE.test(line)) {
        inArgs = true;
      }
      continue;
    }
    if (ORPHAN_FRAG_LINE_RE.test(line)) {
      continue;
    } // stray dialect fragment
    const trimmed = line.trim();
    if (BARE_JSON_RE.test(trimmed) || _isGeneratedImageReadJson(trimmed)) {
      continue;
    }
// Mixed-line leak: tool-call JSON glued to narration on the same line
    // (either order) → remove ONLY the JSON, keep the prose.
    const dejsoned = _removeInlineToolJson(line);
    if (dejsoned !== line) {
      const kept = dejsoned.trim();
      if (kept === '') {
        continue;
      }
      out.push(kept);
      continue;
    }
    // Bracketed wire-marker call `[Tool Call: name(args)]` — whole-line or
    // glued-to-prose. The structured tool row already rendered (or the call
    // was executed on a prior turn), so the echoed marker is noise: whole-line
    // → drop; mixed-line → strip just the marker. Must run AFTER the JSON
    // stripper, because a marker head (`[Tool Call: name({`) is ALSO a bare
    // JSON head — stripping the marker first would leave the JSON body orphaned
    // and the stripper would re-emit it.
    if (BRACKET_CALL_MARKER_RE.test(line)) {
      continue;
    }
    if (BRACKET_CALL_BODY_OPEN_RE.test(line)) {
      inBracketCall = true;
      continue;
    }
    // Mixed-line bracket marker glued to narration → strip just the marker.
    if (INLINE_BRACKET_CALL_RE.test(line)) {
      INLINE_BRACKET_CALL_RE.lastIndex = 0;
      const kept = line.replace(INLINE_BRACKET_CALL_RE, '').trim();
      out.push(kept);
      continue;
    }
    // Defensive: a single line carrying an inline `<function=…>…</function>`
    // pair plus other text → strip just the pair, keep the rest if non-empty.
    const depaired = line.replace(FUNC_INLINE_PAIR_RE, '');
    if (depaired !== line) {
      const cleaned = depaired.trim();
      if (cleaned === '') {
        continue;
      }
      out.push(cleaned);
      continue;
    }
    out.push(line);
  }

  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Streaming cross-chunk suspension (pure helper for the TUI stream bridge).
// ---------------------------------------------------------------------------

// Hard cap on how much text may be held back waiting for a tag to complete —
// beyond this the tail is released so content can never be retained forever.
const PENDING_TAG_MAX = 2048;

// Tag keywords of the text tool-call protocol family.
const PENDING_TAG_KEYWORDS = ['function', 'arguments', 'args', 'parameter', 'tool_call', 'Read'];

// Is `tail` (which starts with '<' and contains no '>') plausibly the beginning
// of a tool-protocol tag? True for a bare '<' / '</', for any prefix of a
// keyword ('<fun'), and for a keyword followed by '=' or whitespace plus
// anything ('<arguments={"q'). Plain prose like '< b' is NOT suspect.
function _isSuspectTagTail(tail) {
  let body = tail.slice(1);
  if (body.startsWith('/')) {
    body = body.slice(1);
  }
  if (body === '') {
    return true;
  }
  const lower = body.toLowerCase();
  for (const kw of PENDING_TAG_KEYWORDS) {
    if (kw.startsWith(lower)) {
      return true;
    }
    if (lower.startsWith(kw)) {
      const rest = lower.slice(kw.length);
      if (rest === '' || /^[\s=]/.test(rest)) {
        return true;
      }
    }
  }
  return false;
}

// Is the (whitespace-trimmed) last streamed line plausibly the beginning of a
// bare tool-call JSON object? True for any prefix of `{"name":"` (covers `{`,
// `{"`, `{"n`, …) — including the brace-swallowed variant `"name":"` — and for
// a longer text that starts with that head. Divergent prose (e.g. `{ a: 1`)
// stops matching as soon as it differs, releasing the hold on the next chunk.
function _isSuspectJsonHead(line) {
  const compact = line.replace(/\s+/g, '');
  if (compact === '') {
    return false;
  }
  for (const head of ['{"name":"', '"name":"']) {
    if (head.startsWith(compact) || compact.startsWith(head)) {
      return true;
    }
  }
  return false;
}

// Is the (trimmed) last streamed line a partial bracketed wire-marker call head
// (`[Tool Call: name(…`) whose closing `)]` has not arrived yet? The marker is
// a deterministic fixed shape, so the prefix test is cheap and unambiguous; a
// chunk boundary inside the JSON arg body is held until the line settles, and
// the settle pass (BRACKET_CALL_MARKER_RE) strips it. Prose lines are never held.
const BRACKET_CALL_PARTIAL_RE = /^\s*\[Tool\s+Call[:：][^\n]*\([^)\n]*$/i;
function _isSuspectBracketCallHead(line) {
  const t = line.trimEnd();
  if (BRACKET_CALL_HEAD_RE.test(t)) {
    return true;
  }
  return BRACKET_CALL_PARTIAL_RE.test(t);
}

// Has a suspect bracketed wire-marker call line closed its marker yet? Complete
// once the trailing `)` and `]` of the marker are both present (the JSON arg
// body may still contain nested parens — the closing `)]` pair is the marker
// terminator).
function _bracketCallComplete(line) {
  const t = line.replace(/\s+$/, '');
  return /\)\s*\]\s*$/.test(t);
}

// Has a suspect bare tool-call JSON line closed its outer object yet? For the
// brace-swallowed head (`"name":…}}`) the missing outer `{` is implied, so the
// object is complete once brace depth dips to (or below) zero.
function _bareJsonComplete(line) {
  const t = line.replace(/^[ \t]+/, '');
  let depth = t.startsWith('{') ? 0 : 1; // implied outer brace when '{' was swallowed
  let inStr = false;
  let esc = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (inStr) {
      if (ch === '\\') {
        esc = true;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth <= 0) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Split streamed text into a safe-to-render part and a held-back suspect tail.
 *
 * A text-protocol tool tag can be cut at a stream chunk boundary; the settled
 * half then leaks into the transcript as prose. The caller keeps `pending`
 * across chunks (prepending it to the next chunk) and renders only `emit`.
 *
 * Two suspect shapes are held back:
 *   1. an unfinished `<…` tag tail of the tool-protocol keyword family;
 *   2. a line-start bare tool-call JSON head (`{"name`… / brace-swallowed
 *      `"name":"`…, incl. one glued after a `<tool_call>` open tag) whose
 *      object has not closed yet — once it completes it is released and the
 *      fence-aware render funnel strips it; if it diverges into plain prose
 *      the hold ends on the next chunk.
 *
 * @param {string} text pending buffer + newly arrived chunk text
 * @returns {{emit:string, pending:string}} pending is '' when nothing suspect
 *          trails the text, when the trailing tag is already complete ('>'
 *          seen), or when the tail exceeds PENDING_TAG_MAX (release valve).
 */
function splitPendingToolTag(text) {
  if (typeof text !== 'string' || text === '') {
    return { emit: text || '', pending: '' };
  }
  const lt = text.lastIndexOf('<');
  if (lt !== -1) {
    const tail = text.slice(lt);
    if (tail.indexOf('>') === -1 && tail.length <= PENDING_TAG_MAX && _isSuspectTagTail(tail)) {
      return { emit: text.slice(0, lt), pending: tail };
    }
  }
  // Bare tool-call JSON head cut at a chunk boundary: hold the suspect last
  // line until its object completes or it diverges into plain prose.
  const lineStart = text.lastIndexOf('\n') + 1;
  const lastLine = text.slice(lineStart);
  // A `<tool_call>` open tag glued in front is part of the same suspect shape.
  const wrapM = /^\s*<tool_call\s*>\s*/i.exec(lastLine);
  const jsonPart = wrapM ? lastLine.slice(wrapM[0].length) : lastLine;
  if (
    lastLine.length <= PENDING_TAG_MAX &&
    _isSuspectJsonHead(jsonPart) &&
    !_bareJsonComplete(jsonPart)
  ) {
    return { emit: text.slice(0, lineStart), pending: lastLine };
  }
  // Bracketed wire-marker call head cut at a chunk boundary: hold the partial
  // marker line until its `)]` terminator arrives (or it diverges into prose,
  // releasing the hold on the next chunk). Same suspect-tail discipline as the
  // bare-JSON hold above; PENDING_TAG_MAX release valve shared.
  if (
    lastLine.length <= PENDING_TAG_MAX &&
    _isSuspectBracketCallHead(lastLine) &&
    !_bracketCallComplete(lastLine)
  ) {
    return { emit: text.slice(0, lineStart), pending: lastLine };
  }
  return { emit: text, pending: '' };
}

module.exports = {
  isEnabled,
  stripInlineToolCallNoise,
  splitPendingToolTag,
};

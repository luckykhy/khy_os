'use strict';

/**
 * toolUseLoop tail helpers — the tool-result / delivery / classification / recovery / scaffold / patch /
 * nudge / write-diff / complexity band extracted verbatim from services/toolUseLoop.js (god-file split).
 *
 * These ~2.2k lines are a cohesive, single-responsibility layer that the agentic core (runToolUseLoop and
 * the parse/exec cluster) calls but which do not themselves re-enter the loop. They are relocated
 * byte-identical into this same-directory sibling. Stable load-time module singletons the band references
 * (crypto / fs / path / diagnostics / analyzeCommand / capabilityMatrix seams / cli keyFindings) are
 * re-required here by the same names (require returns the cached singleton). The six core-defined bindings
 * the band reads (_APP_TARGET_PROBE_BINS / _SEARCH_TERM_STOPWORDS / _parsePositiveInt /
 * _resolveAutoWebSearchMode / _extractToolOutput / _getActiveModelContextWindow) are injected once at core
 * load via setToolUseLoopHelpersDeps to avoid a require cycle back into the core. Several functions here
 * perform IO (fs reads for write-diff/scaffold), so this is NOT a pure zero-IO leaf.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { diagnostics, generateTraceId: genDiagTraceId } = require('./diagnosticEvents');
const { analyzeCommand } = require('./shellSafetyValidator');
const { getCapabilityMatrix } = require('./capabilityMatrix');
const { SEAMS: CAP_SEAMS } = require('./capabilityMatrix/seams');
let _keyFindings = null;
try { _keyFindings = require('../cli/keyFindings'); } catch { _keyFindings = null; }

// ── Core-injected bindings (set once at core load, before any of these helpers is invoked) ──
let _APP_TARGET_PROBE_BINS = null;
let _SEARCH_TERM_STOPWORDS = null;
let _parsePositiveInt = null;
let _resolveAutoWebSearchMode = null;
let _extractToolOutput = null;
let _getActiveModelContextWindow = null;
function setToolUseLoopHelpersDeps(deps = {}) {
  if (deps._APP_TARGET_PROBE_BINS !== undefined) _APP_TARGET_PROBE_BINS = deps._APP_TARGET_PROBE_BINS;
  if (deps._SEARCH_TERM_STOPWORDS !== undefined) _SEARCH_TERM_STOPWORDS = deps._SEARCH_TERM_STOPWORDS;
  if (deps._parsePositiveInt !== undefined) _parsePositiveInt = deps._parsePositiveInt;
  if (deps._resolveAutoWebSearchMode !== undefined) _resolveAutoWebSearchMode = deps._resolveAutoWebSearchMode;
  if (deps._extractToolOutput !== undefined) _extractToolOutput = deps._extractToolOutput;
  if (deps._getActiveModelContextWindow !== undefined) _getActiveModelContextWindow = deps._getActiveModelContextWindow;
}

/**
 * Build a follow-up message containing tool execution results.
 * Formatted so the AI can understand what happened and continue.
 */
function _buildToolResultMessage(toolResults) {
  // Collect structured tool_result blocks for Anthropic-native API path.
  // When all tool calls have _toolUseId, the structured blocks become the
  // PRIMARY format (passed as content blocks), and plain text is a fallback
  // for adapters that don't support structured content.
  const _structuredToolResults = [];

  const parts = ['[Tool execution results]\n'];

  for (const tr of toolResults) {
    if (tr.tool === '_legacy_cmd') continue;

    const idRef = tr._toolUseId ? ` [tool_use_id=${tr._toolUseId}]` : '';

    // Build per-tool output text (used by both structured and plain text paths)
    let toolOutputText = '';
    let isError = false;

    if (tr._autoVerify) {
      toolOutputText += `Tool: ${tr.tool}${idRef} (auto-verify after write failure)\n`;
    } else if (tr.result._deduped) {
      const verb = tr.result.success ? 'succeeded' : 'failed';
      toolOutputText += `Tool: ${tr.tool}${idRef} (SKIPPED — identical call already ${verb}. Do NOT call it again with the same parameters. Use the previous result or try a DIFFERENT approach.)\n`;
    } else if (tr.result._loopDetected) {
      toolOutputText += `Tool: ${tr.tool}${idRef} (BLOCKED — loop detected. Change your approach entirely.)\n`;
    }

    if (tr._loopWarning) {
      toolOutputText += `[LoopWarning: ${tr._loopWarning} — try a different tool or approach]\n`;
    }

    if (tr.result.success) {
      const output = _extractToolOutput(tr.result);
      if (output) {
        const text = typeof output === 'string' ? output : JSON.stringify(output);
        // D13: Smart per-tool truncation with noise classification
        try {
          const _smartTrunc = require('./smartTruncation');
          // Use model's actual context window if available, else env, else conservative default
          const contextBudget = Number(process.env.KHY_CONTEXT_TOKEN_LIMIT)
            || _getActiveModelContextWindow()
            || 32768; // conservative default for weak models
          const truncResult = _smartTrunc.truncate(tr.tool, text, { contextBudget });
          if (truncResult.truncated) {
            const omitted = truncResult.originalLen - truncResult.text.length;
            toolOutputText += `${truncResult.text}\n... [${truncResult.strategy}: ${omitted} chars omitted, ${Math.ceil(omitted / 4)} est. tokens saved]`;
          } else {
            toolOutputText += truncResult.text;
          }
        } catch {
          const maxLen = 15000; // conservative fallback for weak models
          toolOutputText += text.length > maxLen
            ? `${text.slice(0, maxLen)}\n... [truncated ${text.length - maxLen} chars]`
            : text;
        }
        // Append tool result metadata
        const meta = [];
        if (tr.result.truncated) meta.push('output was truncated');
        if (typeof tr.result.totalLines === 'number') meta.push(`${tr.result.totalLines} total lines`);
        if (typeof tr.result.totalMatches === 'number') meta.push(`${tr.result.totalMatches} total matches`);
        if (typeof tr.result.count === 'number' && tr.result.count > 0) meta.push(`${tr.result.count} results`);
        if (typeof tr.result.size === 'number') meta.push(`${tr.result.size} bytes`);
        if (meta.length > 0) toolOutputText += `\n[Metadata: ${meta.join(', ')}]`;
      } else {
        toolOutputText += 'Success';
      }
    } else {
      isError = true;
      const err = tr.result.error;
      if (err && typeof err === 'object' && err.code) {
        toolOutputText += `[ERROR:${err.code}] ${err.message}`;
        if (err.hint) toolOutputText += `\nHint: ${err.hint}`;
        toolOutputText += `\nRetryable: ${err.retryable ? 'yes' : 'no'}`;
      } else {
        const errStr = (err && typeof err === 'object')
          ? (err.message || JSON.stringify(err))
          : (err || 'Unknown error');
        toolOutputText += `Error: ${errStr}`;
        if (tr.result && tr.result.hint) {
          toolOutputText += `\nHint: ${tr.result.hint}`;
        }
      }
    }

    // Build structured tool_result entry.
    // 始终生成结构化块：原生 tool_use ID 直接配对；NL 解析的工具用合成 ID。
    // ensureToolResultPairing() 会处理配对不上的情况（注入 placeholder），
    // 而不是因为没有 ID 就丢弃结构化数据。
    const effectiveToolUseId = tr._toolUseId || `synth_${crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)}`;
    _structuredToolResults.push({
      tool_use_id: effectiveToolUseId,
      tool: tr.tool,
      content: toolOutputText || (isError ? 'Error' : 'Success'),
      _contentBlocks: tr.result?._contentBlocks || null,
      is_error: isError,
    });

    // Build plain text parts (fallback for non-structured adapters)
    if (!tr._autoVerify && !tr.result._deduped && !tr.result._loopDetected) {
      parts.push(`Tool: ${tr.tool}${idRef}`);
    } else {
      // Already included status prefix in toolOutputText, add as-is
      parts.push(toolOutputText.split('\n')[0]);
    }
    if (tr._loopWarning) {
      parts.push(`[LoopWarning: ${tr._loopWarning} — try a different tool or approach]`);
    }
    // Plain text path: reuse toolOutputText (already built above) to avoid duplicated logic
    if (tr.result.success) {
      // toolOutputText already contains the full formatted output from the structured path
      const plainOutput = toolOutputText.trim();
      if (plainOutput) {
        parts.push(`Result: ${plainOutput}`);
      } else {
        parts.push('Result: Success');
      }
    } else {
      // Error text also already in toolOutputText
      parts.push(toolOutputText.trim() || 'Error: Unknown error');
    }
    parts.push('');
  }

  const plainText = parts.join('\n');

  // Build Anthropic content blocks for tool_result
  let structuredBlocks = null;
  try {
    const { buildToolResultContent } = require('./contentBlockUtils');
    structuredBlocks = buildToolResultContent(_structuredToolResults);
  } catch {
    structuredBlocks = null;
  }

  // Return structured result object instead of plain text + static properties.
  // Callers should use .structuredBlocks when available (native API path),
  // falling back to .text for non-structured adapters.
  return {
    text: plainText,
    structuredBlocks,
    structuredToolResults: _structuredToolResults.length > 0 ? _structuredToolResults : null,
  };
}

/**
 * Remove <tool_call> tags from text for display purposes.
 */
function _stripToolCalls(text) {
  if (!text) return '';
  const _KNOWN_BARE_STRIP = /^(bash|shell|sh|command|read|readfile|write|writefile|edit|editfile|grep|rg|glob|find|ls|websearch|webfetch|search|agent|task)$/i;
  // 按行处理裸 ToolName(args) 格式
  const lines = text.split('\n');
  const cleaned = lines.filter((line) => {
    const stripped = line.replace(/^\s*[>│┃├└╰❯▸›•*-]+\s*/u, '').trim();
    const bm = stripped.match(/^([A-Za-z][A-Za-z0-9_]{0,24})\s*\([\s\S]*\)\s*$/);
    if (bm && _KNOWN_BARE_STRIP.test(bm[1])) return false;
    return true;
  }).join('\n');
  return cleaned
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
    .replace(/【\s*调用\s*([^：:\]】\n]{1,32})\s*(?:[：:]\s*([^】]*?))?\s*】/g, '')
    .replace(/▶\s*[\w_]+\s*\([^)]*\)/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Remove <execution_plan> tags from text for display purposes.
 */
function _stripExecutionPlan(text) {
  if (!text) return text;
  let out = text.replace(/<execution_plan>[\s\S]*?<\/execution_plan>/g, '');
  // 同时剥离关键节点汇报标记 <finding>，让全部显示点自动继承（fail-soft）。
  if (_keyFindings && typeof _keyFindings.stripFindings === 'function') {
    try { out = _keyFindings.stripFindings(out); } catch { /* fail-soft: leave text as-is */ }
  }
  return out.trim();
}

/**
 * Build a structured delivery summary from the tool call log.
/**
 * Prune verbose outputs from old toolCallLog entries to keep memory lean.
 * Retains full output for the most recent PRUNE_KEEP_RECENT iterations.
 */
const PRUNE_THRESHOLD = 3000;
const PRUNE_KEEP_RECENT = 2;

function _pruneOldToolOutputs(toolCallLog, currentIteration) {
  const recentCutoff = currentIteration - PRUNE_KEEP_RECENT;
  for (const entry of toolCallLog) {
    if (!entry || entry.iteration >= recentCutoff || entry._pruned) continue;
    // Check all text-like fields in result
    const r = entry.result;
    if (!r) continue;
    const output = String(r.output || r.content || r.result || r.text || '');
    if (output.length <= PRUNE_THRESHOLD) continue;

    const tool = String(entry.tool || '').toLowerCase();
    let summary;
    if (/bash|shell|sh/.test(tool)) {
      const lines = output.split('\n').length;
      const cmd = String((entry.params && entry.params.command) || '').slice(0, 60);
      summary = `[shell] '${cmd}' → ${lines} lines, ${output.length} chars`;
    } else if (/read|readfile|read_file/.test(tool)) {
      const fp = (entry.params && (entry.params.file_path || entry.params.filePath || entry.params.path)) || '';
      summary = `[read] ${fp} (${output.length} chars)`;
    } else if (/grep|rg/.test(tool)) {
      const matches = output.split('\n').filter(Boolean).length;
      summary = `[grep] ${matches} matches, ${output.length} chars`;
    } else {
      summary = `[${entry.tool}] (${output.length} chars)`;
    }

    // Replace verbose fields with compact summary
    if (r.output && typeof r.output === 'string' && r.output.length > PRUNE_THRESHOLD) {
      r.output = summary;
    }
    if (r.content && typeof r.content === 'string' && r.content.length > PRUNE_THRESHOLD) {
      r.content = summary;
    }
    if (r.result && typeof r.result === 'string' && r.result.length > PRUNE_THRESHOLD) {
      r.result = summary;
    }
    if (r.text && typeof r.text === 'string' && r.text.length > PRUNE_THRESHOLD) {
      r.text = summary;
    }
    entry._pruned = true;
  }
}

/**
 * Lists files created/modified, commands executed, and success/failure stats.
 */
function _buildDeliverySummary(toolCallLog) {
  if (!toolCallLog || toolCallLog.length === 0) return '';

  // D6: Housekeeping filter — suppress internal noise from delivery summary
  // Remove: dedup'd calls, loop-detected blocks, guardrail blocks, hook blocks
  const filteredLog = toolCallLog.filter(entry => {
    const r = entry.result;
    if (!r) return true;
    if (r._deduped || r._loopDetected) return false;
    if (typeof r.error === 'string' && /^\[(ToolCallGuardrail|LoopDetector|Hook|ShellSafety)/.test(r.error)) return false;
    return true;
  });

  // Use filtered log for display, original for stats
  const fileCreated = [];
  const fileEdited = [];
  const cmdOps = [];
  const readOps = [];
  const searchOps = [];
  const succeeded = toolCallLog.filter(t => t.result?.success === true).length;
  const failed = toolCallLog.filter(t => t.result?.success === false && !t.result?._deduped && !t.result?._loopDetected).length;
  let totalElapsed = 0;

  for (const entry of filteredLog) {
    const tool = String(entry.tool || '').toLowerCase().replace(/[\s_-]/g, '');
    const params = entry.params || {};
    if (typeof entry.elapsed === 'number') totalElapsed += entry.elapsed;

    if (/^(write|writefile|createfile)$/.test(tool)) {
      const fp = params.file_path || params.path || params.filePath || '';
      if (fp) {
        // Extract diff info from result if available
        const diff = entry.result?._khyWriteDiff;
        const wasNew = diff && !diff.beforeContent;
        const lineCount = diff && diff.afterContent ? diff.afterContent.split('\n').length : 0;
        fileCreated.push({ path: fp, lines: lineCount, isNew: wasNew, success: entry.success !== false });
      }
    } else if (/^(scaffoldfiles)$/.test(tool)) {
      const dirs = Array.isArray(params.directories) ? params.directories.length : 0;
      const files = Array.isArray(params.files) ? params.files.length : 0;
      fileCreated.push({ path: params.root || '.', lines: 0, isNew: true, success: entry.success !== false, scaffold: true, dirs, files });
    } else if (/^(edit|editfile|fileedit)$/.test(tool)) {
      const fp = params.file_path || params.path || params.filePath || '';
      if (fp) {
        const oldLen = (params.old_string || params.oldString || '').split('\n').length;
        const newLen = (params.new_string || params.newString || '').split('\n').length;
        fileEdited.push({ path: fp, added: Math.max(0, newLen - oldLen), removed: Math.max(0, oldLen - newLen), success: entry.success !== false });
      }
    } else if (/^(bash|shell|shellcommand)$/.test(tool)) {
      const cmd = String(params.command || '').trim();
      const isReadCmd = /^\s*(ls|dir|cat|head|tail|find|tree|du|df|stat|file|wc|which|type|echo|pwd|whoami|hostname|uname|env|printenv|date)\b/i.test(cmd);
      if (cmd) {
        const short = cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd;
        if (isReadCmd) {
          readOps.push(short);
        } else {
          cmdOps.push({ cmd: short, success: entry.success !== false });
        }
      }
    } else if (/^(read|readfile|fileread|glob|grep)$/.test(tool)) {
      readOps.push(tool);
    } else if (/^(websearch|web_search|webfetch)$/.test(tool)) {
      const q = params.query || params.url || '';
      if (q) searchOps.push(String(q).slice(0, 50));
    }
  }

  const hasWriteActions = fileCreated.length > 0 || fileEdited.length > 0 || cmdOps.length > 0;
  const elapsedSec = totalElapsed > 0 ? (totalElapsed / 1000).toFixed(1) + 's' : '';

  // ── Structured delivery summary ──────────────────────────────────
  const sections = [];

  // ── File changes table ──
  const allFileChanges = [];
  // Deduplicate file creations
  if (fileCreated.length > 0) {
    const unique = new Map();
    for (const f of fileCreated) {
      if (!unique.has(f.path)) unique.set(f.path, f);
    }
    for (const [, f] of unique) {
      if (f.scaffold) {
        allFileChanges.push({ path: f.path, op: '脚手架', diff: `${f.dirs} 目录, ${f.files} 文件`, ok: f.success });
      } else {
        allFileChanges.push({ path: f.path, op: f.isNew ? '新建' : '写入', diff: f.lines > 0 ? `${f.lines} 行` : '', ok: f.success });
      }
    }
  }
  // Deduplicate and aggregate file edits
  if (fileEdited.length > 0) {
    const unique = new Map();
    for (const f of fileEdited) {
      const existing = unique.get(f.path);
      if (existing) { existing.added += f.added; existing.removed += f.removed; }
      else unique.set(f.path, { ...f });
    }
    for (const [fp, f] of unique) {
      const diff = (f.added > 0 || f.removed > 0) ? `+${f.added}/-${f.removed}` : '';
      allFileChanges.push({ path: fp, op: '修改', diff, ok: f.success });
    }
  }
  if (allFileChanges.length > 0) {
    const _basename = (p) => { const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')); return i >= 0 ? p.slice(i + 1) : p; };
    sections.push(`**改动文件 (${allFileChanges.length})**`);
    sections.push('| 文件 | 操作 | 变更 |');
    sections.push('|------|------|------|');
    const display = allFileChanges.slice(0, 10);
    for (const f of display) {
      const status = f.ok ? '' : ' ❌';
      sections.push(`| \`${_basename(f.path)}\` | ${f.op} | ${f.diff}${status} |`);
    }
    if (allFileChanges.length > 10) sections.push(`| ... | +${allFileChanges.length - 10} 个文件 | |`);
  }

  // ── Commands ──
  if (cmdOps.length > 0) {
    sections.push('');
    sections.push(`**执行命令 (${cmdOps.length})**`);
    const display = cmdOps.slice(0, 5);
    for (const c of display) {
      sections.push(`  \`$ ${c.cmd}\`${c.success ? '' : ' ❌'}`);
    }
    if (cmdOps.length > 5) sections.push(`  ...+${cmdOps.length - 5} more`);
  }

  // ── Search queries ──
  if (searchOps.length > 0) {
    sections.push('');
    sections.push(`**搜索 (${searchOps.length})**`);
    sections.push(`  ${searchOps.slice(0, 3).map(q => `"${q}"`).join(', ')}${searchOps.length > 3 ? ` +${searchOps.length - 3}` : ''}`);
  }

  // ── Statistics line ──
  const statsItems = [];
  statsItems.push(`${toolCallLog.length} 次调用`);
  statsItems.push(`${succeeded} 成功`);
  if (failed > 0) statsItems.push(`${failed} 失败`);
  if (readOps.length > 0) statsItems.push(`${readOps.length} 次读取`);
  if (elapsedSec) statsItems.push(elapsedSec);

  // Read-only investigation: simpler summary
  if (!hasWriteActions) {
    return `\n\n---\n### 完成摘要\n\n**统计**  ${statsItems.join(' · ')}\n未修改任何文件。`;
  }

  sections.push('');
  sections.push(`**统计**  ${statsItems.join(' · ')}`);

  return `\n\n---\n### 完成摘要\n\n${sections.join('\n')}`;
}

function _looksLikeDeliveryConclusion(text = '') {
  // 单一真源：委派 activeAssist.hasSynthesizedConclusion（判据与正则同源，消除两份拷贝）。
  try { return require('./query/activeAssist').hasSynthesizedConclusion(text); } catch {
    // fail-soft：回落到等价的本地判据，绝不因模块加载失败而误判。
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return false;
    return /(完成|成功|已整理|已创建|已修改|无需|部分完成|最终结论|结果|总结|完成摘要|done|completed|summary|result|created|modified|finished|no.*needed|partial)/i.test(normalized);
  }
}

function _emitDeliveryFinalEvent(traceAudit, traceSessionId, diagTraceId, requestId, payload = {}) {
  // Finalize the turn receipt (A3). This is the single completion funnel for
  // all three loop exits (hook-stop / normal / max-iter), so the receipt is
  // written exactly once per turn regardless of which path concluded it.
  try {
    require('./receiptService').finalizeReceipt({
      sessionId: traceSessionId,
      status: payload.success ? (payload.hookStopped ? 'partial' : 'completed') : 'failed',
      error: payload.success ? null : (payload.error || null),
    });
  } catch { /* receipt optional */ }

  if (!traceAudit) return;
  try {
    traceAudit.logEvent('agent.delivery.final', payload, {
      sessionId: traceSessionId,
      traceId: diagTraceId,
      requestId,
      source: 'tool-loop',
      visibility: 'summary',
    });
  } catch { /* non-critical */ }
}

/**
 * Heuristic: does this look like a "work preface" instead of a real answer?
 */
function _looksLikeProgressOnlyReply(text) {
  if (!text) return false;
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return false;
  // 放宽长度限制：3000 字符（原 1500 仍然太窄，模型对复杂任务经常给出 2000+ 字符的规划性回复）
  if (t.length > 3000) return false;
  if (/<tool_call>/i.test(t)) return false;
  if (/```/.test(t)) return false;
  // 放宽前缀匹配：增加更多常见的"我要做X"表达
  const cn = /^(我来|我先|让我|正在|继续|先去|先看|先查|下面我来|我会先|好的|首先|接下来|现在|来看|来查|需要先|我需要|我打算|我准备|那我|嗯|可以|当然|没问题|马上|立即|开始)/;
  const en = /^(let me|i(?:'| a)m (?:going to|now)|continuing to|i(?:'| wi)ll|ok|sure|first|I need to|I want to|I should|next|alright|now|starting|beginning)/i;
  const hasTaskVerb = /(检查|排查|查看|看看|分析|探索|处理|修复|定位|梳理|总结|整理|清理|创建|搜索|读取|打开|执行|运行|列出|扫描|浏览|编辑|修改|写入|安装|配置|部署|测试|验证|调试|review|inspect|check|analy[sz]e|investigate|clean|organize|search|read|open|run|list|scan|browse|look|edit|modify|write|install|configure|deploy|test|verify|debug|fix|implement|add|update|create)/i.test(t);
  // 也匹配含有编号步骤规划的回复（"1. 先做X 2. 再做Y"）
  const hasNumberedPlan = /\n\s*\d+[\.\)]\s+/.test(t) && hasTaskVerb;
  // 尾部/内嵌「半截话」意图（用户原话痛点：「也不要总是半截话」）。
  // 真实卡壳常**不**从首字符起头，例如「文件已经在桌面上了，让我用图像识别功能查看内容」——
  // 旧的起锚 cn/en 匹配会漏掉它 → placeholder=false → 自驱守卫不触发 → 用户被迫手敲「继续」。
  // 这里只看**最后一句**是否为「让我…<动作>」式计划小句、且全文无任何结论词：正是悬而未决的前言收尾。
  const clauses = t.split(/[。．.!?！？;；\n]+/).map((s) => s.trim()).filter(Boolean);
  const lastClause = clauses.length ? clauses[clauses.length - 1] : '';
  const intentLead = /(让我|我来|我先|我现在|我去|我这就|我马上|我可以先|我打算|我准备|接下来我?|那我|那就|现在我?来?|继续)/;
  const noConclusion = !/(完成|成功|已创建|已修改|已生成|已实现|已修复|已整理|已部署|已运行|已验证|已启动|已打开|已执行|已发送|已安装|已下载|已配置|结论|总结|综上|done|completed|finished|created|implemented|fixed|verified|summary|result)/i.test(t);
  const trailingIntent = !!lastClause && intentLead.test(lastClause) && hasTaskVerb && noConclusion;
  return ((cn.test(t) || en.test(t)) && hasTaskVerb) || hasNumberedPlan || trailingIntent;
}

/**
 * Heuristic: is the model's closing reply just a verbatim echo of the tool
 * output, with no synthesis of its own?
 *
 * 用户原话痛点「只有过程没有总结」的一种形态：模型把 `dir` 的目录清单原样回贴当
 * 「结果」，看起来和工具调用过程毫无区别——既没归纳「桌面上有哪几类东西」，也没给
 * 一句结论。这类回复对用户而言等同「没总结」。
 *
 * 判据（零误报优先）：剥掉双方空白/标点后，回复与某条成功工具结果的归一化文本高度
 * 重合（回复几乎完全包含于工具原文，或反之），且回复未携带任何结论词。真正的总结即便
 * 引用了清单也会**额外**写入归纳句，长度/内容都会偏离原文，不会被误判。
 *
 * @param {string} reply        模型本轮去除工具调用后的纯文本
 * @param {Array}  toolCallLog  本轮工具调用台账（取 success===true 的 output/content）
 * @returns {boolean}
 */
function _looksLikeToolOutputEcho(reply, toolCallLog) {
  const norm = (s) => String(s == null ? '' : s).replace(/[\s　，,。.、;；:：!！?？\-_*#>`|]+/g, '').toLowerCase();
  const r = norm(reply);
  if (r.length < 12) return false; // 太短谈不上「回贴清单」，交给其它判据
  // 带结论词的回复属于真总结，绝不当 echo。
  if (/(完成|成功|已整理|已创建|已修改|无需|不需要|结论|总结|综上|一共|总共|分别是|包括|主要有|可以看到|可以看出|看起来|summary|in\s+total|overall|there\s+are)/i.test(reply)) {
    return false;
  }
  if (!Array.isArray(toolCallLog)) return false;
  for (const t of toolCallLog) {
    if (!t || t.success !== true && t.result?.success !== true) continue;
    const out = t.output != null ? t.output
      : (t.content != null ? t.content
        : (t.result?.output != null ? t.result.output : t.result?.content));
    const o = norm(typeof out === 'string' ? out : (out != null ? JSON.stringify(out) : ''));
    if (o.length < 12) continue;
    // 回复几乎完全是工具原文的子串（模型只截了一段回贴），或工具原文几乎完全是回复的
    // 子串（模型把整段原样回贴）。0.9 阈值留出标点/大小写归一后的细微差异。
    const shorter = r.length <= o.length ? r : o;
    const longer = r.length <= o.length ? o : r;
    if (longer.includes(shorter) && shorter.length / longer.length >= 0.9) return true;
  }
  return false;
}

/**
 * Heuristic: is the model's reply *itself* a raw directory listing (Windows
 * `dir` / Unix `ls -l`) carried over with no synthesizing conclusion?
 *
 * 补 `_looksLikeToolOutputEcho` 的缺口：当模型把目录清单**重排/改写**后回贴（不再与
 * 工具原文逐字重合，0.9 子串判据失效），且全文无任何结论词时，对用户仍等同「没总结」。
 * 这类回复常超过 400 字符，会被 concludeNow 短路放行——故独立判定，触发收尾守卫强制归纳。
 * 零误报优先：必须 parseDirectoryListing 成功（真清单结构）且无结论词；真总结会额外写结论句。
 *
 * @param {string} reply 模型本轮去除工具调用后的纯文本
 * @returns {boolean}
 */
function _replyIsUnsynthesizedListing(reply) {
  const t = String(reply || '');
  if (t.replace(/\s/g, '').length < 24) return false;
  if (/(完成|成功|已整理|结论|总结|综上|一共|总共|分别是|包括|主要有|可以看出|共\s*\d+\s*项|summary|in\s+total|overall|there\s+are)/i.test(t)) {
    return false; // 带结论/归纳句 → 真总结，不介入
  }
  try {
    return require('./toolDataSummary').looksLikeDirectoryListing(t);
  } catch { return false; }
}

/**
 * Heuristic: does the AI present a choice list instead of acting?
 * Small models often output "请选择: 1. X 2. Y 3. Z" instead of calling tools.
 */
function _looksLikeChoiceResponse(text) {
  if (!text || text.length > 800) return false;
  // 必须有编号或列表项
  if (!/\n\s*\d+[\.\)]\s+/.test(text) && !/(?:^|\n)\s*[-•]\s+/.test(text)) return false;
  // 必须有选择性语言
  if (!/(你可以选择|请选择|以下.*选项|以下.*方案|你想要哪|你更倾向|Which.*option|Which.*prefer|choose|pick one|here are.*option)/i.test(text)) return false;
  // 不能已包含 tool_call
  if (/<tool_call>/i.test(text)) return false;
  return true;
}

/**
 * Heuristic: is this reply a *canned / safety-style refusal*?
 *
 * 区别于"承认操作失败"（例如「文件不存在」「命令执行失败」——那是诚实的失败叙述）。
 * 这里专抓**模板化的拒绝/免责**散文：「我无法给到相关内容」「抱歉，我不能…」
 * 「作为一个 AI…」「I can't help with that」等。它们本身不携带可执行信息，
 * 一旦出现在**工具已成功取回数据之后**，就是自相矛盾的「伪成功拒绝」
 * （问题 3 的根因）：明明已经把新闻/网页内容抓回来了，却回一句套话拒绝。
 *
 * 长度上限收紧到 600 字符——真正的交付总结通常更长且含具体信息；套话拒绝很短。
 */
function _looksLikeCannedRefusal(text) {
  if (!text) return false;
  const t = String(text).replace(/\s+/g, ' ').trim();
  if (!t || t.length > 600) return false;
  return /(我无法(?:给到|给出|提供|回答|满足|帮(?:你|您|助)|处理|完成)|无法(?:给到|给出|提供)(?:相关|你|您|此|这)|抱歉[，,。.\s]{0,4}(?:我)?(?:不能|无法|没办法)|很抱歉[，,。.\s]{0,4}(?:我)?(?:不能|无法)|我(?:不能|无法|没办法)(?:帮|回答|提供|响应|处理|协助|满足)|不便(?:提供|回答|透露)|超出(?:了)?(?:我的)?(?:能力|权限|范围)|作为(?:一个)?(?:AI|人工智能|语言模型|大模型)|我只是(?:一个)?(?:AI|人工智能|语言模型)|i\s+(?:can(?:'|no)?t|cannot|am\s+(?:unable|not\s+able))\s+(?:to\s+)?(?:help|provide|assist|answer|share|do\s+that|comply)|i'?m\s+(?:sorry|unable|not\s+able|afraid)|as\s+an\s+ai|i\s+am\s+(?:just\s+)?an\s+ai)/i.test(t);
}

/**
 * Heuristic: does a refusal already STATE a concrete reason for itself?
 *
 * The bare/pseudo-refusal safety net only fires on *reason-less* template
 * refusals ("你好，我无法给到相关内容。" / "抱歉，我不能。"). A refusal that
 * explains itself — operationally (权限 / 依赖 / 找不到 / 网络 / 超时…) OR by
 * policy (有害 / 违法 / 隐私 / safety…) — is an HONEST refusal and must be left
 * untouched, so we never mislabel a legitimate safety/permission refusal as an
 * "upstream channel degradation" artifact. Presence of a because-style connector
 * (因为 / 由于 / because / due to) also counts as a stated reason.
 *
 * @param {string} text
 * @returns {boolean}
 */
function _refusalStatesConcreteReason(text) {
  if (!text) return false;
  const t = String(text).replace(/\s+/g, ' ').trim();
  if (!t) return false;
  // Explicit causal connectors — the refusal is explaining itself.
  if (/(因为|由于|这是因为|原因(?:是|在于)|because|due to|since\s+it|as\s+it\s+(?:is|would|could|requires)|in order to)/i.test(t)) return true;
  // Concrete operational reasons.
  if (/(权限|授权|认证|凭证|登录|token|api\s*key|依赖|未安装|没安装|缺少|缺失|不存在|找不到|没找到|未找到|enoent|不在|路径|目录|文件名|格式不|参数(?:错误|缺失|无效|不全)|超时|timeout|网络|连接|断网|离线|offline|服务(?:不可用|未启动|未运行)|配额|额度|限流|rate\s*limit|too\s+many|not\s+found|permission|denied|unauthorized|missing|not\s+installed|unavailable|invalid\s+(?:argument|parameter|path))/i.test(t)) return true;
  // Policy / safety reasons — a genuine, explained safety refusal.
  if (/(有害|危害|违法|违规|不当|不合规|危险|攻击|恶意|滥用|隐私|敏感|未成年|儿童|色情|暴力|武器|爆炸|歧视|仇恨|harmful|illegal|unsafe|against\s+(?:policy|the\s+rules)|policy|violat|abuse|malicious|dangerous|inappropriate|sensitive|privacy|minors?|explicit)/i.test(t)) return true;
  return false;
}

/**
 * Heuristic: does the user request likely require concrete actions/tools?
 */
function _looksLikeActionRequest(text) {
  if (!text) return false;
  return /(继续|检查|排查|修复|实现|修改|review|审查|自我检查|排错|定位|运行|执行|测试|验证|debug|调试|看下|看看|看一下|看一看|看一眼|查看|瞧|瞅|整理|清理|帮我|创建|搜索|查找|打开|安装|部署|编译|构建|启动|删除|移动|复制|下载|上传|写|加|改|做|配置|更新|升级|重构|优化|分析|识别|读|organize|clean|help|create|find|open|install|build|start|fix|implement|add|update|write|modify|change|remove|delete|move|copy|deploy|test|run|search|read|edit|configure|refactor|optimize|analyze|set up|make)/i.test(text);
}

function _looksLikeAppLaunchRequest(text) {
  if (!text) return false;
  const raw = String(text || '').trim();
  if (!raw) return false;

  // If the user pasted multi-line logs/transcripts, bias to the last meaningful
  // line because that is usually the actual question.
  const lines = raw.split('\n').map(s => String(s || '').trim()).filter(Boolean);
  let focus = lines.length > 1 ? lines[lines.length - 1] : raw;
  focus = focus.replace(/^>\s*/, '').trim();
  if (!focus) return false;

  const issueMarkers = /(之后|下一句|下句话|上一句|本轮|上轮|变成|重复|误判|为什么|怎么|问题|故障|异常|报错|日志|记录|复现|bug)/i;
  const directCn = /^(?:请|帮我|麻烦|可以|能否|请你|帮忙)?\s*(?:打开|启动|运行)\s*[^\n]{1,48}$/i;
  const directEn = /^(?:please\s+)?(?:open|launch|start|run)\b[\s\S]{1,48}$/i;
  const target = _extractAppTargetFromUserMessage(focus);
  const shortTarget = target && target.length <= 24;

  if (shortTarget && (directCn.test(focus) || directEn.test(focus))) {
    return !issueMarkers.test(focus);
  }
  if (issueMarkers.test(focus)) return false;

  return /(打开|启动|运行).*(应用|程序|软件|工具|客户端|浏览器|编辑器|查看器|飞书|微信|qq|钉钉|lark|feishu|pdf|图片|图像)/i.test(focus)
    || /\b(open|launch|start|run)\b[\s\S]{0,40}\b(app|application|program|tool|editor|viewer|browser|lark|feishu|pdf|image|photo)\b/i.test(focus);
}

const _looksLikeProjectScaffoldRequest = (text) => require('./intentHeuristics').looksLikeProjectScaffoldRequest(text);

function _isShellToolName(name = '') {
  const n = String(name || '').trim().toLowerCase();
  return n === 'shell_command' || n === 'shellcommand' || n === 'bash';
}

// Gated normalized shell-name match for the inline dispatch gates (platform
// rewrite + analyzeCommand shell-safety). The executor resolves `BASH`/`Bash`/
// `SHELL_COMMAND` via normalizeToolName → shell_command and RUNS them, but the
// inline gates historically compared the RAW name case-sensitively — so those
// case variants slipped past the safety check and platform rewrite while still
// executing. Same fix + same gate as _patchEmpty* (KHY_PATCH_TOOLNAME_NORMALIZE,
// default ON). OFF → byte-revert to the exact legacy 3-way literal compare.
function _matchesShellDispatchName(name) {
  let normalize = true;
  try { normalize = require('./flagRegistry').isFlagEnabled('KHY_PATCH_TOOLNAME_NORMALIZE', process.env); }
  catch { normalize = true; }
  if (normalize) return _isShellToolName(name);
  return name === 'shell_command' || name === 'shellCommand' || name === 'bash';
}

function _looksLikeShellAppProbeCommand(command = '') {
  const cmd = String(command || '').trim().toLowerCase();
  if (!cmd) return false;
  return /\b(which|whereis|command\s+-v|type\s+-p|ps\s+aux|pgrep|pidof|nohup|xdg-open|gtk-launch|gio\s+launch)\b/.test(cmd)
    || /\bgrep\s+-i\b/.test(cmd);
}

const _normalizeAppTarget = (target = '') => require('./appLaunchRecovery').normalizeAppTarget(target);

function _extractAppTargetFromShellCommand(command = '') {
  const raw = String(command || '').trim();
  if (!raw) return '';
  const normalized = raw.replace(/\s+/g, ' ');

  const launchLike = normalized.match(/^(?:nohup\s+)?([a-z0-9._+-]+)/i);
  if (launchLike) {
    const bin = String(launchLike[1] || '').toLowerCase();
    if (bin && !_APP_TARGET_PROBE_BINS.has(bin)) return _normalizeAppTarget(bin);
  }

  const whichMatch = normalized.match(/\bwhich\s+(.+)$/i);
  if (whichMatch) {
    const tokens = whichMatch[1].split(/\s+/).filter(Boolean);
    for (const tokenRaw of tokens) {
      const token = String(tokenRaw || '').replace(/^['"`]+|['"`]+$/g, '');
      if (!token) continue;
      if (/^[|;&]/.test(token) || token.includes('||') || token.includes('&&') || token.includes(';')) break;
      if (/^\d+>/.test(token) || /^2>/.test(token) || /^1>/.test(token)) break;
      if (token.startsWith('-')) continue;
      if (/^[a-z0-9._+-]+$/i.test(token)) return _normalizeAppTarget(token.toLowerCase());
    }
  }

  const grepMatch = normalized.match(/\bgrep\s+(?:-[^\s]+\s+)*['"]?([a-z0-9._+-]{2,})['"]?/i);
  if (grepMatch) return _normalizeAppTarget(String(grepMatch[1] || '').toLowerCase());

  return '';
}

function _extractAppCandidatesFromShellCommand(command = '') {
  const out = [];
  const raw = String(command || '').trim();
  if (!raw) return out;
  const normalized = raw.replace(/\s+/g, ' ');

  const whichMatch = normalized.match(/\bwhich\s+(.+)$/i);
  if (whichMatch) {
    const tokens = whichMatch[1].split(/\s+/).filter(Boolean);
    for (const tokenRaw of tokens) {
      const token = String(tokenRaw || '').replace(/^['"`]+|['"`]+$/g, '');
      if (!token) continue;
      if (/^[|;&]/.test(token) || token.includes('||') || token.includes('&&') || token.includes(';')) break;
      if (/^\d+>/.test(token) || /^2>/.test(token) || /^1>/.test(token)) break;
      if (token.startsWith('-')) continue;
      if (/^[a-z0-9._+-]+$/i.test(token)) out.push(_normalizeAppTarget(token.toLowerCase()));
    }
  }

  const first = _extractAppTargetFromShellCommand(command);
  if (first) out.unshift(first);

  return [...new Set(out.filter(Boolean))];
}

function _extractAppTargetFromUserMessage(userMessage = '') {
  const raw = String(userMessage || '').trim();
  if (!raw) return '';

  if (/(图片|图像|image|photo).*(编辑器|editor)/i.test(raw)) return 'gimp';
  if (/pdf/i.test(raw) && /(编辑|修改|editor|edit)/i.test(raw)) return 'libreoffice';

  const quoted = raw.match(/["'“”](.+?)["'“”]/);
  if (quoted && quoted[1]) {
    const normalized = _normalizeAppTarget(quoted[1]);
    if (normalized) return normalized;
  }

  const cnVerb = raw.match(/(?:打开|启动|运行)\s*([^\n，。,;；:：]{1,80})/);
  if (cnVerb && cnVerb[1]) {
    const normalized = _normalizeAppTarget(cnVerb[1]);
    if (normalized) return normalized;
  }

  const enVerb = raw.match(/\b(?:open|launch|start|run)\b\s+([a-z0-9._+\-\s]{2,80})/i);
  if (enVerb && enVerb[1]) {
    const normalized = _normalizeAppTarget(enVerb[1]);
    if (normalized) return normalized;
  }

  if (/pdf/i.test(raw)) return 'pdf';
  return '';
}

function _extractErrorTextFromResult(result = {}) {
  const err = result?.error;
  if (!err) return '';
  if (typeof err === 'string') return err;
  if (typeof err === 'object') return [err.code, err.message, err.hint].filter(Boolean).join(' ');
  return String(err);
}

function _isShellExecutorUnavailableResult(result = {}) {
  if (!result || result.success) return false;
  const err = result.error;
  if (err && typeof err === 'object' && String(err.code || '').toLowerCase() === 'executor_unavailable') return true;
  const text = `${_extractErrorTextFromResult(result)} ${String(result.hint || '')}`.toLowerCase();
  return /fork:\s*retry:\s*resource temporarily unavailable/.test(text)
    || /cannot fork subprocess/.test(text)
    || /executor[_\s-]*unavailable/.test(text);
}

function _looksLikeInfoSearchRequest(text) {
  if (!text) return false;
  const raw = _sanitizeSearchSourceMessage(String(text || ''));
  if (!raw) return false;
  const constraints = _extractUserToolConstraints(raw);
  if (constraints.disallowAllTools || constraints.disallowSearch) return false;
  return /(搜索|搜一下|查一下|查查|新闻|热点|热搜|今日|今天|最新|时事|头条|文档|接口|参数|说明|官网|readme|manual|documentation|api|reference|web\s*search|search|news|headline|trending)/i.test(raw);
}

/**
 * 结构化熔炉前置拦截挂载点（DESIGN-ARCH-036 §3.1）。
 *
 * 默认开启、fail-soft、observe 模式零行为变更。关闭/调模：
 *   - 环境变量 KHY_STRUCTURED_FURNACE=0 关闭整层
 *   - options.structuredFurnace = { enabled:false } 单次关闭；mode 取 options 或
 *     KHY_STRUCTURED_FURNACE_MODE（默认 observe；enforce 为显式强约束）
 *
 * observe（默认）：坍缩 NL → 封印信封，挂到 options.structuredFurnace.envelope 供下游/观测，
 *                  拒损只记录到 gatedInput.furnaceRejection，不打断既有交互流。
 * enforce        ：拒损时把结构化澄清要求抛给上层（仅在调用方显式选择时启用）。
 *
 * 任何内部异常都被吞掉（绝不因结构化层让主循环回归）。
 */
function maybeForgeStructuredIntent(rawMessage, options, gatedInput) {
  const cfg = (options && options.structuredFurnace) || {};
  // byte-identical to `String(process.env.KHY_STRUCTURED_FURNACE||'').trim() !== '0'`
  // (zeroDisables kind, PRE.always). cfg.enabled still overrides below.
  const envEnabled = getCapabilityMatrix().isEnabledAt(CAP_SEAMS.PRE_DISPATCH, 'structuredFurnace', {});
  // 显式 cfg.enabled 优先（含单次关闭 enabled:false）；未指定时落 env 默认（默认开）。
  const enabled = cfg.enabled === false ? false : (cfg.enabled === true || envEnabled);
  if (!enabled) return;
  const mode = cfg.mode || process.env.KHY_STRUCTURED_FURNACE_MODE || 'observe';

  let furnace;
  try {
    furnace = require('./structuredFurnace');
  } catch { return; /* 子系统缺失则视作未启用 */ }

  try {
    const envelope = furnace.intercept(rawMessage);
    options.structuredFurnace = { ...cfg, enabled: true, mode, envelope };
    if (gatedInput && typeof gatedInput === 'object') gatedInput.forgedEnvelope = envelope;
  } catch (err) {
    // fail-soft 铁律：本块「绝不打断主循环」。FurnaceRejection 若因子系统未导出 /
    // 循环 require 时序而解析为 undefined，则 `err instanceof undefined` 会**自身抛
    // TypeError**，反把整个工具循环打断（与 observe 模式契约矛盾）。先校验它确为
    // 构造器再做 instanceof，非拒损异常或缺失导出时一律静默吞掉。
    const Rejection = furnace && furnace.FurnaceRejection;
    if (typeof Rejection === 'function' && err instanceof Rejection) {
      const rejection = err.toJSON();
      options.structuredFurnace = { ...cfg, enabled: true, mode, rejection };
      if (gatedInput && typeof gatedInput === 'object') gatedInput.furnaceRejection = rejection;
      if (mode === 'enforce') throw err; // 调用方显式要求强约束时才上抛
    }
    // observe 模式或非拒损异常：静默记录，不打断主循环。
  }
}

/**
 * cognitiveSnapshot observe-mode 接线（DESIGN-ARCH-035 §3.4）。默认关闭、fail-soft：
 *   - 环境变量 KHY_COGNITIVE_SNAPSHOT=1|on 开启（默认关）；
 *   - options.cognitiveSnapshot = { enabled:true } 单次开启；{ enabled:false } 单次关闭。
 *
 * observe（唯一模式）：每轮用主循环**真实** token 估算驱动 beforeStep 溢出前置闸门，
 *   把裁决记入 diagnostics 供观测。beforeStep 是纯计算（overflowInterceptor.preflight），
 *   observe 模式下绝不调用 commitStep/persist，因此**零磁盘副作用**、绝不改
 *   conversationMessages、绝不阻断主循环。压缩/卸载/截断热启的侵入式接管（commitStep/
 *   onTruncation/hotStart）留后续 PR。任何异常一律吞掉（绝不因本层让主循环回归）。
 *
 * @returns {{observe:function}|null}  未启用或子系统缺失时返回 null。
 */
function maybeAttachCognitiveObserver(userMessage, options) {
  const cfg = (options && options.cognitiveSnapshot) || {};
  const envRaw = String(process.env.KHY_COGNITIVE_SNAPSHOT || '').trim().toLowerCase();
  const envEnabled = envRaw === '1' || envRaw === 'on' || envRaw === 'true';
  const enabled = cfg.enabled === false ? false : (cfg.enabled === true || envEnabled);
  if (!enabled) return null;
  let engine;
  try {
    const { CognitiveContextEngine } = require('./cognitiveSnapshot');
    const taskId = String(
      cfg.taskId || options?.sessionId || options?._diagTraceId || `loop-${Date.now()}`
    );
    const ultimateGoal = (String(cfg.ultimateGoal || userMessage || '').slice(0, 2000)) || 'unspecified-goal';
    engine = new CognitiveContextEngine({
      taskId,
      ultimateGoal,
      contextWindowTokens: cfg.contextWindowTokens,
      model: options?.model,
    });
  } catch { return null; /* 子系统缺失则视作未启用 */ }
  return {
    observe({ iteration, usedTokens, contextWindow } = {}) {
      try {
        if (contextWindow && Number(contextWindow) > 0) {
          engine.window = Math.max(1, Number(contextWindow));
        }
        const used = Number(usedTokens) || 0;
        const verdict = engine.beforeStep({ usedTokens: used });
        try {
          diagnostics.emit('cognitive_snapshot_preflight', {
            iteration,
            usedTokens: used,
            ratio: engine.usageRatio(used),
            allow: verdict ? verdict.allow : undefined,
            action: verdict ? verdict.action : undefined,
          });
        } catch { /* telemetry best-effort */ }
        return verdict;
      } catch { return null; /* observe must never throw into the loop */ }
    },
  };
}

function _extractUserToolConstraints(text = '') {
  const raw = _sanitizeSearchSourceMessage(String(text || ''));
  const empty = {
    disallowAllTools: false,
    disallowSearch: false,
    disallowFileRead: false,
    hasExplicitConstraint: false,
    summary: '',
  };
  if (!raw) return empty;

  const disallowAllTools = /(?:不要|别|禁止|无需|不用|不必)(?:再)?(?:调用|使用|动用|借助)?(?:任何|所有)?工具|(?:do\s+not|don't|never|without|no)\s+(?:call|use|invoke)\s+(?:any\s+)?tools?/i.test(raw);
  const disallowSearch = /(?:不要|别|禁止|无需|不用|不必)(?:再)?(?:搜索|搜一下|联网|查一下|查找|查询|上网)|(?:do\s+not|don't|never|without|no)\s+(?:search|browse|look\s+up|web\s*search)/i.test(raw);
  const disallowFileRead = /(?:不要|别|禁止|无需|不用|不必)(?:再)?(?:读取|查看|打开|浏览|扫描).{0,6}(?:文件|代码|目录)|(?:do\s+not|don't|never|without|no)\s+(?:read|open|browse|scan)\s+(?:any\s+)?(?:files?|code|directories?)/i.test(raw);

  const parts = [];
  if (disallowAllTools) parts.push('no tools');
  if (disallowSearch) parts.push('no search');
  if (disallowFileRead) parts.push('no file reads');

  return {
    disallowAllTools,
    disallowSearch,
    disallowFileRead,
    hasExplicitConstraint: parts.length > 0,
    summary: parts.join(', '),
  };
}

function _buildUserToolConstraintDirective(constraints = {}) {
  if (!constraints || !constraints.hasExplicitConstraint) return '';

  const rules = [
    '## USER TOOL CONSTRAINTS — must be obeyed for this request.',
  ];

  if (constraints.disallowAllTools) {
    rules.push('Do not call any tools. Do not emit tool_use or tool_call blocks.');
  } else {
    if (constraints.disallowSearch) {
      rules.push('Do not use web_search, search, webFetch, browsing, or any search-like tool.');
    }
    if (constraints.disallowFileRead) {
      rules.push('Do not read, scan, grep, glob, or browse files/directories.');
    }
  }

  rules.push('If these constraints reduce certainty, answer directly from current context and state the exact limitation.');
  return rules.join('\n');
}

async function _recoverWebSearchAfterShellFailure(call, result, userMessage, toolCalling, execContext = {}) {
  if (!call || !_isShellToolName(call.name)) return result;
  const shellCommand = String(call.params?.command || '').trim();
  if (!shellCommand) return result;
  if (!_isShellExecutorUnavailableResult(result)) return result;
  if (!_looksLikeInfoSearchRequest(userMessage)) return result;

  const previousHint = String(result?.hint || '').trim();
  const normalizedQuery = String(userMessage || '').trim() || 'latest news';
  let fallback = null;
  let recoveredTarget = '';

  const _tryTool = async (toolName, params) => {
    try {
      const r = await toolCalling.executeTool(toolName, params, execContext);
      if (r && r.success) {
        recoveredTarget = toolName;
        return {
          ...r,
          success: true,
          _autoRecovered: true,
          _autoRecoveredFrom: 'shell_command',
          _autoRecoveredTarget: toolName,
        };
      }
      fallback = r;
      return null;
    } catch (err) {
      fallback = { success: false, error: err.message || `${toolName} failed` };
      return null;
    }
  };

  // Tier-1: web search (current/hot news, docs, web knowledge)
  const webRecovered = await _tryTool('web_search', { query: normalizedQuery });
  if (webRecovered) return webRecovered;

  // Tier-2: local/market symbol search fallback for degraded network environments
  const searchRecovered = await _tryTool('search', { keyword: normalizedQuery });
  if (searchRecovered) return searchRecovered;

  // Tier-3: try toolSearch when model asks about tools/commands instead of external news
  if (/(工具|命令|command|tool)/i.test(normalizedQuery)) {
    const toolRecovered = await _tryTool('toolSearch', { query: normalizedQuery });
    if (toolRecovered) return toolRecovered;
  }

  const fallbackErr = String(
    _extractErrorTextFromResult(fallback) || fallback?.hint || 'web_search/search fallback failed'
  ).trim();
  const failHint = `Auto-recovery web_search/search fallback failed: ${fallbackErr}`;
  return {
    ...result,
    hint: previousHint ? `${previousHint} ${failHint}` : failHint,
    _autoRecoveredTarget: recoveredTarget || null,
  };
}

function _findLatestSuccessfulOpenAppEntry(toolCallLog = []) {
  if (!Array.isArray(toolCallLog) || toolCallLog.length === 0) return null;
  for (let i = toolCallLog.length - 1; i >= 0; i--) {
    const entry = toolCallLog[i];
    const tool = String(entry?.tool || '').trim().toLowerCase();
    if (!entry?.result?.success) continue;
    if (tool === 'open_app' || tool === 'openapp') return entry;
    if (_isShellToolName(tool) && entry.result?._autoRecoveredTarget) return entry;
  }
  return null;
}

const _findLatestFailedOpenAppEntry = (toolCallLog = []) => require('./appLaunchRecovery').findLatestFailedOpenAppEntry(toolCallLog);

function _findLatestShellExecutorUnavailableEntry(toolCallLog = []) {
  if (!Array.isArray(toolCallLog) || toolCallLog.length === 0) return null;
  for (let i = toolCallLog.length - 1; i >= 0; i--) {
    const entry = toolCallLog[i];
    if (!entry || !_isShellToolName(entry.tool)) continue;
    if (_isShellExecutorUnavailableResult(entry.result)) return entry;
  }
  return null;
}

function _buildAppLaunchRecoveryCandidates(userMessage = '', shellEntry = null) {
  const candidates = [];
  const msgTarget = _extractAppTargetFromUserMessage(userMessage);
  if (msgTarget) candidates.push(msgTarget);
  const shellCommand = String(shellEntry?.params?.command || '').trim();
  if (shellCommand) candidates.push(..._extractAppCandidatesFromShellCommand(shellCommand));
  return [...new Set(candidates.map(v => String(v || '').trim()).filter(Boolean))];
}

// 门控:app-launch 中断回退是否优先于投机式 AI transient 重试(默认开)。
// seamlessResume 给「小任务」加了 transient 重试地板(0→{1,2,3}),使被硬中断的 app-launch
// 请求会先花数秒(指数退避)重试 AI 通道,再回退到确定性的 open_app——纯延迟。本地优先原则下,
// 只要 open_app 回退能满足「打开应用」意图,就应优先它。关 → 恒 false,逐字节回退今日顺序。
function _appLaunchInterruptPrecedenceEnabled(env = process.env) {
  const v = String((env && env.KHY_APP_LAUNCH_INTERRUPT_PRECEDENCE) || '').trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off' && v !== 'no';
}

async function _recoverOpenAppAfterAiInterruption(aiResult = {}, userMessage = '', toolCallLog = [], execContext = {}) {
  const errorType = String(aiResult?.errorType || '').trim().toLowerCase();
  if (!['process', 'cancelled', 'timeout', 'network', 'unknown'].includes(errorType)) return null;
  if (!_looksLikeAppLaunchRequest(userMessage)) return null;

  const interruptionText = `AI 通道在结果整理阶段中断（${errorType || 'unknown'}）。`;
  const succeededEntry = _findLatestSuccessfulOpenAppEntry(toolCallLog);
  if (succeededEntry) {
    const output = String(succeededEntry.result?.output || '').trim();
    if (output) return `${output}\n\n${interruptionText}`;
    const appName = String(
      succeededEntry.params?.name
      || succeededEntry.result?._autoRecoveredTarget
      || _extractAppTargetFromUserMessage(userMessage)
      || '目标应用'
    ).trim();
    return `已执行打开应用：${appName}。\n\n${interruptionText}`;
  }

  const failedOpenAppEntry = _findLatestFailedOpenAppEntry(toolCallLog);
  if (failedOpenAppEntry) {
    const appName = String(
      failedOpenAppEntry.params?.name
      || _extractAppTargetFromUserMessage(userMessage)
      || '目标应用'
    ).trim();
    const failureText = String(
      _extractErrorTextFromResult(failedOpenAppEntry.result)
      || failedOpenAppEntry.result?.hint
      || 'open_app failed'
    ).trim();
    return `打开应用 ${appName} 失败：${failureText}\n\n${interruptionText}`;
  }

  const shellEntry = _findLatestShellExecutorUnavailableEntry(toolCallLog);
  if (!shellEntry) return null;
  const candidates = _buildAppLaunchRecoveryCandidates(userMessage, shellEntry);
  if (candidates.length === 0) return null;

  let toolCalling = null;
  try {
    toolCalling = require('./toolCalling');
  } catch {
    return null;
  }

  let fallback = null;
  for (const appName of candidates) {
    try {
      fallback = await toolCalling.executeTool('open_app', { name: appName }, execContext);
    } catch (err) {
      fallback = { success: false, error: err.message || 'open_app failed' };
    }
    if (fallback && fallback.success) {
      const output = String(fallback.output || '').trim();
      return (output || `已执行打开应用：${appName}。`) + `\n\n${interruptionText}`;
    }
  }

  const candidateText = candidates[0];
  const failureText = String(
    _extractErrorTextFromResult(fallback) || fallback?.hint || 'open_app fallback failed'
  ).trim();
  return `打开应用 ${candidateText} 失败：${failureText}\n\n${interruptionText}`;
}

// ── Platform command rewriting ──────────────────────────────────────

const _UNIX_TO_WIN = {
  ls: 'dir', cat: 'type', cp: 'copy', mv: 'move', rm: 'del',
  grep: 'findstr', touch: 'type nul >', which: 'where', pwd: 'cd',
  clear: 'cls', head: 'powershell -NoProfile -c "Get-Content"',
  tail: 'powershell -NoProfile -c "Get-Content ... -Tail"',
  chmod: '(no equivalent)', chown: '(no equivalent)',
  ps: 'tasklist', kill: 'taskkill', df: 'powershell -NoProfile -c "Get-CimInstance Win32_LogicalDisk"',
  uname: 'ver', find: 'dir /s /b',
};

const _WIN_TO_UNIX = {
  dir: 'ls', type: 'cat', copy: 'cp', move: 'mv', del: 'rm',
  findstr: 'grep', where: 'which', cls: 'clear',
  tasklist: 'ps aux', taskkill: 'kill', ver: 'uname -a',
};

/**
 * Proactive platform command rewriting — called BEFORE execution.
 * Uses shellCommand.js _patchWinCommand on Windows;
 * on Linux, rewrites common Windows commands to Unix equivalents.
 * Returns the (possibly rewritten) command string.
 */
function _proactivePlatformRewrite(command) {
  if (!command || typeof command !== 'string') return command;
  const isWin = process.platform === 'win32';

  if (isWin) {
    // shellCommand.js _patchWinCommand already handles Win patching at execution time.
    // Here we only patch path-level issues that may confuse the safety validator.
    let patched = command;
    // ~/path → %USERPROFILE%\path
    patched = patched.replace(/(?<=^|\s)~\//g, '%USERPROFILE%\\');
    // /dev/null → NUL
    patched = patched.replace(/\/dev\/null/g, 'NUL');
    return patched;
  }

  // Linux/macOS: rewrite Windows commands to Unix
  let patched = command;

  // dir → ls (at start of command or after &&)
  patched = patched.replace(/^dir\b/m, 'ls');
  patched = patched.replace(/(?<=&&\s*)dir\b/g, 'ls');
  // dir /s /b pattern → find . -name "pattern"
  patched = patched.replace(/\bdir\s+\/s\s+\/b\s+(\S+)/g, 'find . -name "$1"');
  // type file → cat file
  patched = patched.replace(/^type\s+/m, 'cat ');
  patched = patched.replace(/(?<=&&\s*)type\s+/g, 'cat ');
  // copy src dst → cp src dst
  patched = patched.replace(/\bcopy\s+/g, 'cp ');
  // move src dst → mv src dst
  patched = patched.replace(/\bmove\s+/g, 'mv ');
  // del file → rm file
  patched = patched.replace(/\bdel\s+/g, 'rm ');
  // rmdir /s /q dir → rm -rf dir
  patched = patched.replace(/\brmdir\s+\/s\s+\/q\s+/g, 'rm -rf ');
  // findstr → grep
  patched = patched.replace(/\bfindstr\s+\/s\s+/g, 'grep -r ');
  patched = patched.replace(/\bfindstr\s+\/i\s+/g, 'grep -i ');
  patched = patched.replace(/\bfindstr\s+/g, 'grep ');
  // where cmd → which cmd
  patched = patched.replace(/\bwhere\s+/g, 'which ');
  // cls → clear
  patched = patched.replace(/\bcls\b/g, 'clear');
  // tasklist → ps aux
  patched = patched.replace(/\btasklist\b/g, 'ps aux');
  // taskkill /F /PID N → kill -9 N
  patched = patched.replace(/\btaskkill\s+\/F\s+\/PID\s+(\d+)/g, 'kill -9 $1');
  patched = patched.replace(/\btaskkill\s+\/PID\s+(\d+)/g, 'kill $1');
  // %USERPROFILE% → ~, %VAR% → $VAR
  patched = patched.replace(/%USERPROFILE%/g, '~');
  patched = patched.replace(/%([A-Za-z_]\w*)%/g, '$$$1');
  // Backslash paths → forward slash (heuristic: only when it looks like a path)
  patched = patched.replace(/([A-Za-z]):\\(?=[A-Za-z])/g, '/$1/');
  // 2>NUL → 2>/dev/null
  patched = patched.replace(/2>\s*NUL\b/gi, '2>/dev/null');
  patched = patched.replace(/>\s*NUL\b/gi, '>/dev/null');
  // cmd.exe /c → remove wrapper
  patched = patched.replace(/^(?:cmd\.exe|cmd)\s+\/[cCdDsS]+\s+/m, '');

  return patched;
}

const _getWindowsCommandHint = (command) => require('./platformRewrite').getWindowsCommandHint(command);

function _getLinuxCommandHint(command) {
  if (!command) return null;
  const base = command.trim().split(/[\s/\\|;&]/)[0].toLowerCase();
  const unixCmd = _WIN_TO_UNIX[base];
  if (!unixCmd) return null;
  return `当前系统是 Linux/macOS，"${base}" 不可用。请改用 "${unixCmd}"。`;
}

async function _recoverOpenAppAfterShellFailure(call, result, userMessage, toolCalling, execContext = {}) {
  if (!call || !_isShellToolName(call.name)) return result;
  const shellCommand = String(call.params?.command || '').trim();
  if (!shellCommand) return result;
  if (!_isShellExecutorUnavailableResult(result)) return result;
  if (!_looksLikeAppLaunchRequest(userMessage) && !_looksLikeShellAppProbeCommand(shellCommand)) return result;

  const candidates = _extractAppCandidatesFromShellCommand(shellCommand);
  const msgTarget = _extractAppTargetFromUserMessage(userMessage);
  if (msgTarget) candidates.push(msgTarget);
  const uniqueCandidates = [...new Set(candidates.filter(Boolean))];
  if (uniqueCandidates.length === 0) return result;

  let fallback = null;
  let usedTarget = '';
  for (const appName of uniqueCandidates) {
    usedTarget = appName;
    try {
      fallback = await toolCalling.executeTool('open_app', { name: appName }, execContext);
    } catch (err) {
      fallback = { success: false, error: err.message || 'open_app failed' };
    }
    if (fallback && fallback.success) {
      const out = String(fallback.output || '').trim();
      return {
        ...fallback,
        success: true,
        output: out || `Recovered via open_app("${appName}")`,
        _autoRecovered: true,
        _autoRecoveredFrom: 'shell_command',
        _autoRecoveredTarget: appName,
      };
    }
  }

  const fallbackErr = String(_extractErrorTextFromResult(fallback) || fallback?.hint || 'open_app failed').trim();
  const previousHint = String(result?.hint || '').trim();
  const failHint = `Auto-recovery open_app("${usedTarget}") failed: ${fallbackErr}`;
  return {
    ...result,
    hint: previousHint ? `${previousHint} ${failHint}` : failHint,
  };
}

function _unwrapPastedContent(raw = '') {
  return String(raw || '').replace(/<pasted-content>\n([\s\S]*?)\n<\/pasted-content>/g, '$1').trim();
}

const _looksLikeFilePathToken = (token = '') => require('./scaffoldExtractor').looksLikeFilePathToken(token);

const _looksLikeDirectoryToken = (token = '') => require('./scaffoldExtractor').looksLikeDirectoryToken(token);

function _extractScaffoldSpecFromMessage(userMessage, options = {}) {
  const raw = _unwrapPastedContent(userMessage);
  if (!raw) return null;

  const defaultConcurrency = _parsePositiveInt(options.defaultConcurrency, 4, 1, 16);
  const maxFiles = _parsePositiveInt(options.maxFiles, 120, 1, 500);
  const maxDirs = _parsePositiveInt(options.maxDirs, 160, 1, 500);

  let root = '.';
  const explicitRoot = raw.match(/(?:^|\s)(?:root|cwd|目录|路径)\s*[:=：]\s*([^\s,，;；]+)/i);
  if (explicitRoot && explicitRoot[1]) root = explicitRoot[1].trim();

  const dirs = new Set();
  const files = new Map();
  const addDir = (value) => {
    const d = String(value || '').trim().replace(/^['"`]+|['"`]+$/g, '').replace(/[\\/]+$/g, '');
    if (!d || d === '.' || d === './') return;
    if (dirs.size < maxDirs) dirs.add(d);
  };
  const addFile = (filePath, content = '') => {
    const f = String(filePath || '').trim().replace(/^['"`]+|['"`]+$/g, '');
    if (!f) return;
    if (!files.has(f) && files.size < maxFiles) files.set(f, String(content || ''));
  };

  const inlineCodeTokens = [...raw.matchAll(/`([^`]+)`/g)].map(m => String(m[1] || '').trim()).filter(Boolean);
  for (const token of inlineCodeTokens) {
    if (_looksLikeFilePathToken(token)) addFile(token);
    else if (_looksLikeDirectoryToken(token)) addDir(token);
  }

  const lines = raw.split('\n').map(s => String(s || '').trim()).filter(Boolean);
  for (const lineRaw of lines) {
    const line = lineRaw
      .replace(/^\s*(?:[-*+•]|\d+[.)]|[└├│])\s*/g, '')
      .trim();
    if (!line) continue;

    const pair = line.match(/^([A-Za-z0-9_./\\-]+\.[A-Za-z0-9]{1,10})\s*(?::|=>)\s*([\s\S]*)$/);
    if (pair && pair[1]) {
      addFile(pair[1], pair[2] || '');
      continue;
    }

    if (line.endsWith('/') || line.endsWith('\\')) {
      addDir(line);
      continue;
    }

    if (_looksLikeFilePathToken(line)) {
      addFile(line);
      continue;
    }

    if (_looksLikeDirectoryToken(line)) {
      addDir(line);
      continue;
    }
  }

  for (const filePath of files.keys()) {
    const parent = path.dirname(filePath);
    if (parent && parent !== '.' && parent !== filePath) addDir(parent);
  }

  if (dirs.size === 0 && files.size === 0) return null;
  return {
    root,
    directories: [...dirs],
    files: [...files.entries()].map(([p, c]) => ({ path: p, content: c })),
    overwrite: false,
    writeConcurrency: defaultConcurrency,
  };
}

function _sanitizeSearchSourceMessage(raw = '', options = {}) {
  const collapseWhitespace = options.collapseWhitespace !== false;
  let text = String(raw || '')
    .replace(/<pasted-content>\n([\s\S]*?)\n<\/pasted-content>\s*/g, '$1\n')
    // Strip system-injected sections that pollute downstream intent/query parsing.
    .replace(/\[System (?:Skill|Memory|Context)[^\]]*\][\s\S]*?(?=\[System |$)/gi, ' ');

  if (collapseWhitespace) {
    return text.replace(/\s+/g, ' ').trim();
  }

  return text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function _buildSearchQueryCandidates(userMessage, maxCandidates = 3, mode = 'auto') {
  const source = _sanitizeSearchSourceMessage(userMessage);
  if (!source) return [];

  const resolvedMode = _resolveAutoWebSearchMode(source, mode);
  const limit = _parsePositiveInt(maxCandidates, 3, 1, 8);
  const candidates = [];
  const terms = [];
  const termSet = new Set();

  const pushCandidate = (value) => {
    const query = String(value || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!query || candidates.includes(query)) return;
    candidates.push(query);
  };

  const pushTerm = (value) => {
    const text = String(value || '').trim();
    if (!text) return;
    const low = text.toLowerCase();
    if (termSet.has(low)) return;
    termSet.add(low);
    terms.push(text);
  };

  // Keep the full user intent as the first candidate.
  pushCandidate(source);

  // Quoted phrases are usually explicit topic nouns.
  const quoted = source.match(/["'“”‘’《》「」『』][^"'“”‘’《》「」『』]{2,48}["'“”‘’《》「」『』]/g) || [];
  for (const phrase of quoted) {
    const clean = phrase.replace(/^["'“”‘’《》「」『』]|["'“”‘’《》「」『』]$/g, '').trim();
    if (clean) pushTerm(clean);
  }

  // Pull topic-like tokens and filter generic verbs/function words.
  // (_SEARCH_TERM_STOPWORDS 为模块常量,见文件顶部 Constants 区)
  const tokens = source.match(/[\u4e00-\u9fa5]{2,24}|[A-Za-z][A-Za-z0-9+#_.-]{1,31}/g) || [];
  for (const token of tokens) {
    const t = String(token || '').trim();
    const low = t.toLowerCase();
    if (!t || _SEARCH_TERM_STOPWORDS.has(low)) continue;
    pushTerm(t);
  }

  // Inject mode-aware directional queries before broad combinations.
  const topicSeed = terms.slice(0, 3).join(' ').trim() || source.slice(0, 80);
  if (topicSeed) {
    if (resolvedMode === 'news') {
      pushCandidate(`${topicSeed} 最新动态`);
      pushCandidate(`${topicSeed} latest news today`);
    } else if (resolvedMode === 'docs') {
      pushCandidate(`${topicSeed} official documentation`);
      pushCandidate(`${topicSeed} API reference`);
    } else if (resolvedMode === 'academic') {
      pushCandidate(`${topicSeed} arxiv paper`);
      pushCandidate(`${topicSeed} benchmark dataset`);
    } else if (resolvedMode === 'general') {
      pushCandidate(`${topicSeed} overview`);
    }
  }

  // Build noun-combination candidates from top extracted terms.
  const topTerms = terms.slice(0, 6);
  for (let i = 0; i < topTerms.length; i++) {
    pushCandidate(topTerms[i]);
    if (candidates.length >= limit) break;
    for (let j = i + 1; j < topTerms.length; j++) {
      pushCandidate(`${topTerms[i]} ${topTerms[j]}`);
      if (candidates.length >= limit) break;
    }
    if (candidates.length >= limit) break;
  }

  return candidates.slice(0, limit);
}

// 空参数补丁的工具名集合(Ch2「不要每轮重建可复用结构」）：_patchEmptySearchQuery /
// _patchEmptyShellCommand 对**每次响应解析**都重建这三个字面量 Set,仅经 `.has` 做名字匹配。
// 集合内容纯字面量、与调用无关(环境门只决定「查哪一个」而非集合内容),提升到模块作用域一次构造、
// 只读消费,不 mutate、不逃逸(补丁直接改传入的 toolCalls,不返回集合),逐字节等价。
const _PATCH_SEARCH_NAMES = new Set(['web_search', 'webSearch', 'websearch', 'search_web']);
const _PATCH_NORMALIZED_SEARCH_NAMES = new Set(['websearch', 'searchweb']);
const _PATCH_SHELL_NAMES = new Set(['shell_command', 'shellCommand', 'bash']);

/**
 * Patch web_search / webSearch calls that have an empty or missing query.
 * Models sometimes decide to search but omit the query parameter entirely.
 * We derive a reasonable query from the user's original message so the
 * search doesn't fail with "Search query is empty".
 */
function _patchEmptySearchQuery(toolCalls, userMessage) {
  if (!Array.isArray(toolCalls) || !userMessage) return;
  // 同 _patchEmptyShellCommand:字面 Set 漏掉 `WebSearch`/`WEB_SEARCH` 等大小写/分隔符变体。
  // 门控开 → 归一化(去空白/下划线/连字符后 lowercase)比对;关 → 逐字节回退旧字面 Set。
  let _normalizeNames = true;
  try { _normalizeNames = require('./flagRegistry').isFlagEnabled('KHY_PATCH_TOOLNAME_NORMALIZE', process.env); }
  catch { _normalizeNames = true; }
  const searchNames = _PATCH_SEARCH_NAMES;
  const _normalizedSearchNames = _PATCH_NORMALIZED_SEARCH_NAMES;
  const _matchesSearch = (name) => (_normalizeNames
    ? _normalizedSearchNames.has(String(name || '').toLowerCase().replace(/[\s_-]/g, ''))
    : searchNames.has(name));
  const configuredMode = process.env.KHY_AUTO_WEBSEARCH_MODE || 'auto';
  const fallbackQuery = _buildSearchQueryCandidates(userMessage, 1, configuredMode)[0] || '';
  for (const call of toolCalls) {
    if (!call || !_matchesSearch(call.name)) continue;
    const q = String(call.params?.query || call.params?.q || '').trim();
    if (q) continue;
    // Use derived noun-focused query candidate.
    if (fallbackQuery) {
      if (!call.params) call.params = {};
      call.params.query = fallbackQuery;
    }
  }
}

function _patchEmptyShellCommand(toolCalls, userMessage) {
  if (!Array.isArray(toolCalls) || !userMessage) return;
  // 归一化名匹配(默认开):历史用大小写敏感的字面 Set {shell_command,shellCommand,bash},
  // 漏掉模型偶尔发的 `BASH` / `Bash` / 全小写 `shellcommand` 等同义变体 → 空命令补丁静默跳过。
  // _isShellToolName 已做 trim+toLowerCase 归一,覆盖同一批逻辑名。门控关 → 逐字节回退旧 Set。
  let _normalizeNames = true;
  try { _normalizeNames = require('./flagRegistry').isFlagEnabled('KHY_PATCH_TOOLNAME_NORMALIZE', process.env); }
  catch { _normalizeNames = true; }
  const shellNames = _PATCH_SHELL_NAMES;
  const _matchesShell = (name) => (_normalizeNames ? _isShellToolName(name) : shellNames.has(name));
  const isWin = process.platform === 'win32';
  for (const call of toolCalls) {
    if (!call || !_matchesShell(call.name)) continue;
    const cmd = String(call.params?.command || call.params?.cmd || '').trim();
    if (cmd) continue;
    // 推断命令：从用户消息中提取意图
    const msg = userMessage.toLowerCase();
    let inferred = '';
    if (/桌面|desktop/i.test(msg)) {
      inferred = isWin ? 'dir "%USERPROFILE%\\Desktop"' : 'ls ~/Desktop/';
    } else if (/文件|file|目录|directory|folder/i.test(msg)) {
      inferred = isWin ? 'dir' : 'ls -la';
    } else if (/进程|process|运行.*什么/i.test(msg)) {
      inferred = isWin ? 'tasklist' : 'ps aux';
    } else if (/磁盘|disk|空间|space/i.test(msg)) {
      inferred = isWin ? 'powershell -NoProfile -Command "Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,Size,FreeSpace"' : 'df -h';
    } else if (/网络|network|ip|联网|ping/i.test(msg)) {
      inferred = isWin ? 'ipconfig' : 'ifconfig 2>/dev/null || ip addr';
    } else if (/内存|memory|ram/i.test(msg)) {
      inferred = isWin ? 'powershell -NoProfile -Command "Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize,FreePhysicalMemory"' : 'free -h';
    } else if (/cpu|处理器|processor/i.test(msg)) {
      inferred = isWin ? 'powershell -NoProfile -Command "Get-CimInstance Win32_Processor | Select-Object Name,NumberOfCores"' : 'lscpu 2>/dev/null || sysctl -n machdep.cpu.brand_string';
    } else if (/系统|system|版本|version|信息/i.test(msg)) {
      inferred = isWin ? 'systeminfo' : 'uname -a';
    } else if (/环境变量|env|environment/i.test(msg)) {
      inferred = isWin ? 'set' : 'env';
    } else if (/端口|port|listen/i.test(msg)) {
      inferred = isWin ? 'netstat -an | findstr LISTEN' : 'ss -tlnp 2>/dev/null || netstat -tlnp';
    } else if (/用户|user|whoami/i.test(msg)) {
      inferred = 'whoami';
    } else if (/时间|time|日期|date/i.test(msg)) {
      inferred = isWin ? 'echo %date% %time%' : 'date';
    } else if (/路径|path|当前目录|cwd|pwd/i.test(msg)) {
      inferred = isWin ? 'cd' : 'pwd';
    } else if (/安装.*包|install|pip|npm|apt/i.test(msg)) {
      // Don't infer package install — too risky without knowing the package
      inferred = '';
    }
    if (inferred) {
      if (!call.params) call.params = {};
      call.params.command = inferred;
    }
  }
}

/**
 * Patch empty search calls (Search()) for local data-search tools.
 * Some small models emit Search() with no keyword; derive fallback from user message.
 */
function _patchEmptyLocalSearchKeyword(toolCalls, userMessage) {
  if (!Array.isArray(toolCalls) || !userMessage) return;
  const searchNames = new Set(['search']);
  const fallbackRaw = _sanitizeSearchSourceMessage(String(userMessage || ''));
  const fallback = String(fallbackRaw || '').trim().slice(0, 120);
  if (!fallback) return;
  for (const call of toolCalls) {
    if (!call || !searchNames.has(String(call.name || ''))) continue;
    const keyword = String(call.params?.keyword || call.params?.query || '').trim();
    if (keyword) continue;
    if (!call.params) call.params = {};
    call.params.keyword = fallback;
  }
}

function _isWebLookupToolName(toolName = '') {
  const normalized = String(toolName || '').toLowerCase().replace(/[\s_-]/g, '');
  return normalized === 'websearch'
    || normalized === 'webfetch'
    || normalized === 'websearchmcp'
    || normalized === 'search';
}

function _rewriteShellCallsForAppLaunch(toolCalls = [], userMessage = '') {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return toolCalls;
  if (!_looksLikeAppLaunchRequest(userMessage)) return toolCalls;

  return toolCalls.map((call) => {
    if (!call || call.legacy) return call;
    if (!_isShellToolName(call.name)) return call;
    const command = String(call.params?.command || '').trim();
    if (!command || !_looksLikeShellAppProbeCommand(command)) return call;

    const appName = _extractAppTargetFromShellCommand(command) || _extractAppTargetFromUserMessage(userMessage);
    if (!appName) return call;

    return {
      ...call,
      name: 'open_app',
      params: { name: appName },
      _compatRewritten: true,
      _originalShellCommand: command,
    };
  });
}

function _filterToolCallsByIntent(toolCalls = [], userMessage = '', userConstraints = null) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return { kept: toolCalls, removed: [], removedByConstraint: [], removedByIntent: [] };
  }

  const constraints = userConstraints && typeof userConstraints === 'object'
    ? userConstraints
    : _extractUserToolConstraints(userMessage);
  const allowOpenApp = _looksLikeAppLaunchRequest(userMessage);

  const kept = [];
  const removed = [];
  const removedByConstraint = [];
  const removedByIntent = [];
  for (const call of toolCalls) {
    const normalized = String(call?.name || '').toLowerCase().replace(/[\s_-]/g, '');
    const blockedReason = _matchBlockedToolConstraint(normalized, constraints);
    if (blockedReason) {
      const blocked = { ...call, _constraintReason: blockedReason };
      removed.push(blocked);
      removedByConstraint.push(blocked);
      continue;
    }
    // Keep open_app calls that were rewritten from shell commands by _rewriteShellCallsForAppLaunch
    // or that came from structured tool_use API response — removing them causes dead-loop nudges
    if (!allowOpenApp && normalized === 'openapp' && !call._compatRewritten && !call._structured) {
      removed.push(call);
      removedByIntent.push(call);
    } else {
      kept.push(call);
    }
  }

  return { kept, removed, removedByConstraint, removedByIntent, constraints };
}

// 受限工具名集合（Ch2「不要每轮重建可复用结构」）：_matchBlockedToolConstraint 对
// _filterToolCallsByIntent 循环里的**每个工具调用**都重建这两个字面量 Set,仅为 `.has` 成员
// 测试。提升到模块作用域,构造一次、只读消费,不 mutate、不逃逸(函数只返回字符串原因),逐字节等价。
const _BLOCKED_SEARCH_TOOLS = new Set([
  'websearch', 'webfetch', 'search', 'searchweb',
]);
const _BLOCKED_FILE_READ_TOOLS = new Set([
  'read', 'readfile', 'grep', 'glob', 'ls', 'gitstatus', 'gitdiff', 'gitlog',
  'find', 'findfiles', 'explore', 'searchcontent',
]);

function _matchBlockedToolConstraint(normalizedToolName = '', constraints = {}) {
  if (!normalizedToolName || !constraints) return '';
  if (constraints.disallowAllTools) return 'all_tools';

  if (constraints.disallowSearch && _BLOCKED_SEARCH_TOOLS.has(normalizedToolName)) {
    return 'search';
  }

  if (constraints.disallowFileRead && _BLOCKED_FILE_READ_TOOLS.has(normalizedToolName)) {
    return 'file_read';
  }

  return '';
}

function _buildConstraintRespectNudge(userMessage, previousReply, constraints = {}, blockedCalls = []) {
  const blockedTools = [...new Set(
    (blockedCalls || []).map(call => String(call?.name || '').trim()).filter(Boolean)
  )];
  const lines = [
    '[System follow-up: respect explicit user constraints]',
    'The previous response attempted blocked tool use.',
    'Respect the user constraint in the next response.',
  ];

  if (constraints.disallowAllTools) {
    lines.push('Do not emit any <tool_call> or tool_use blocks. Answer directly in natural language only.');
  } else {
    if (constraints.disallowSearch) {
      lines.push('Do not use search or browsing tools.');
    }
    if (constraints.disallowFileRead) {
      lines.push('Do not read or scan files/directories.');
    }
    lines.push('If another non-blocked tool is truly necessary, use only an allowed tool. Otherwise answer directly.');
  }

  lines.push('If the constraint prevents certainty, explain that limitation briefly and give the best direct answer.');
  if (blockedTools.length > 0) {
    lines.push('');
    lines.push(`[Blocked tools]\n${blockedTools.join(', ')}`);
  }
  lines.push('');
  lines.push(`[Original user request]\n${userMessage}`);
  lines.push('');
  lines.push(`[Previous response]\n${previousReply}`);
  return lines.join('\n');
}

function _buildConstraintFallbackReply(constraints = {}, blockedCalls = []) {
  const blockedTools = [...new Set(
    (blockedCalls || []).map(call => String(call?.name || '').trim()).filter(Boolean)
  )];
  const bans = [];
  if (constraints.disallowAllTools) bans.push('禁止调用任何工具');
  if (constraints.disallowSearch) bans.push('禁止搜索');
  if (constraints.disallowFileRead) bans.push('禁止读取文件');
  const banText = bans.length > 0 ? bans.join('、') : '存在显式工具限制';
  const toolText = blockedTools.length > 0 ? `（已拦截: ${blockedTools.join(', ')}）` : '';
  return `已按你的约束停止违规工具调用：${banText}${toolText}。当前回复未提供可直接展示的正文，因此无法在不违反约束的前提下继续自动展开。`;
}

const _buildAppLaunchToolNudge = (userMessage, previousReply) => require('./toolCallNudges').buildAppLaunchToolNudge(userMessage, previousReply);

/**
 * Build a nudge when the AI presented choices instead of acting.
 */
const _buildChoiceResponseNudge = (userMessage) => require('./toolCallNudges').buildChoiceResponseNudge(userMessage);

/**
 * Build a one-shot continuation nudge when AI returns no tool calls.
 */
function _buildNoToolCallNudge(userMessage, previousReply) {
  return [
    '[System follow-up: continue execution]',
    'The previous response looks like a progress note without tool execution.',
    'Continue immediately.',
    'Choose one path only:',
    '1) If actions are needed, output one or more <tool_call>...</tool_call> now.',
    '   You may also use natural format like: 【调用工具名：参数】.',
    '2) If no tool is needed, output the final complete answer now.',
    'Do not output a standalone progress preface.',
    'If you add one short pair-programming transition sentence, include at least one tool call in the same reply.',
    '',
    `[Original user request]\n${userMessage}`,
    '',
    `[Previous response]\n${previousReply}`,
  ].join('\n');
}

function _buildWebSearchToolNudge(userMessage, previousReply) {
  return [
    '[System follow-up: web-search required]',
    'The user request likely needs current external information.',
    'In your next response, choose one path only:',
    '1) Call web_search immediately with a concrete query derived from the user request.',
    '2) If web_search is unavailable, explain the concrete blocker and provide a best-effort answer with uncertainty.',
    'Do not output a standalone progress preface.',
    'If you add one short pair-programming transition sentence, include the required tool call in the same reply.',
    '',
    '[Required]',
    '- Prefer <tool_call>{"name":"web_search","params":{"query":"..."}}</tool_call>.',
    '- Query must be non-empty and specific.',
    '',
    `[Original user request]\n${userMessage}`,
    '',
    `[Previous response]\n${previousReply}`,
  ].join('\n');
}

function _buildScaffoldToolNudge(userMessage, previousReply) {
  return [
    '[System follow-up: project scaffolding required]',
    'The user request is about creating project folders/files quickly.',
    'In your next response, choose one path only:',
    '1) Call scaffoldFiles now with root/directories/files and writeConcurrency.',
    '2) If scaffoldFiles is unavailable, call writeFile/editFile with a concrete ordered plan immediately.',
    'Do not output a standalone progress preface.',
    'If you add one short pair-programming transition sentence, include the required tool call in the same reply.',
    '',
    '[Required]',
    '- Prefer <tool_call>{"name":"scaffoldFiles","params":{"root":"...","directories":[...],"files":[{"path":"...","content":"..."}],"writeConcurrency":4}}</tool_call>.',
    '- Use batch creation and parallel writes when creating many files.',
    '',
    `[Original user request]\n${userMessage}`,
    '',
    `[Previous response]\n${previousReply}`,
  ].join('\n');
}

// Safety guards for diff capture. 防呆: the diff layer must never disturb the
// actual write — every guard below fails soft (returns null) instead of throwing.
const _DIFF_MAX_BYTES = Number(process.env.KHY_DIFF_MAX_BYTES) || 512 * 1024; // 512KB cap
const _DIFF_PATH_KEYS = ['path', 'file_path', 'filePath', 'notebook_path', 'notebookPath'];

// File-mutating tool names (normalized: lowercased, separators stripped). Any of
// these is a candidate for diff capture; everything else is ignored. apply_patch
// is intentionally absent — its patch may span multiple files, so a single
// path/before snapshot does not model it; it falls through to its own output.
const _WRITE_TOOL_NAMES = new Set([
  'writefile', 'write', 'filewrite', 'filewritetool', 'createfile',
  'editfile', 'edit', 'fileedit', 'fileedittool',
  'multiedit', 'multiedittool',
  'notebookedit', 'notebookedittool',
  'fileop', 'fileoperation',
]);

/**
 * Resolve the target path of a file-mutating tool call across the various
 * parameter spellings (path / file_path / filePath / notebook_path).
 * @param {{params: object}} call
 * @returns {string|null}
 */
function _resolveWriteToolPath(call) {
  for (const key of _DIFF_PATH_KEYS) {
    const v = call.params?.[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return null;
}

/**
 * Read a file as UTF-8 with diff-safety guards. Returns null when the path is not
 * a regular file, exceeds the size cap, or looks binary (contains a NUL byte) —
 * the raw bytes are round-tripped through a Buffer so multibyte / UTF-8 content
 * (e.g. Chinese) is preserved exactly without mojibake or truncation.
 * @param {string} filePath
 * @returns {string|null} content, or null if not diffable
 */
function _safeReadForDiff(filePath) {
  if (!fs.existsSync(filePath)) return '';        // creation case → empty "before"
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) return null;                // dir / device — not diffable
  if (stat.size > _DIFF_MAX_BYTES) return null;   // oversize — skip (防呆)
  const buf = fs.readFileSync(filePath);
  if (buf.includes(0)) return null;               // binary (NUL byte) — skip
  return buf.toString('utf-8');
}

/**
 * Capture the pre-write snapshot for a file-mutating tool so the UI can later
 * render a precise red/green diff. Tool-agnostic: it records only the target path
 * + the file's BEFORE content. The AFTER content is read back from disk in
 * _finalizeWriteDiff once the write has executed — so MultiEdit / NotebookEdit /
 * fileop / deletions are all covered without replicating each tool's mutation
 * logic.
 *
 * 防呆: pure read-only, fully wrapped in try/catch; any failure returns null and
 * never affects the actual write.
 *
 * @param {{name: string, params: object}} call
 * @returns {{filePath: string, beforeContent: string}|null}
 */
function _captureWriteFileDiffContext(call) {
  try {
    if (!call || !call.name) return null;
    const toolName = String(call.name).toLowerCase().replace(/[\s_-]/g, '');
    if (!_WRITE_TOOL_NAMES.has(toolName)) return null;

    const relPath = _resolveWriteToolPath(call);
    if (!relPath) return null;
    const cwd = process.env.KHYQUANT_CWD || process.cwd();
    // Resolve through the SAME expansion the tools apply (env vars → ~ → desktop
    // normalization → resolve), so before/after snapshots read the file the tool
    // actually wrote. A raw `path.resolve(cwd, "~/桌面/x")` would point at a
    // non-existent `<cwd>/~/桌面/x`, collapsing the diff to a silent no-op.
    let filePath;
    try {
      filePath = require('../tools/_userDirs').expandUserPath(relPath, cwd);
    } catch {
      filePath = path.isAbsolute(relPath) ? relPath : path.resolve(cwd, relPath);
    }

    const beforeContent = _safeReadForDiff(filePath);
    if (beforeContent === null) return null;       // binary / oversize / non-file
    return { filePath, beforeContent };
  } catch {
    return null;
  }
}

/**
 * Finalize a captured write into a renderable diff by reading the AFTER content
 * from disk post-write. Tool-agnostic and encoding-safe (UTF-8, multibyte intact
 * because raw bytes are round-tripped). Handles creation (before='') and deletion
 * (after='') naturally.
 *
 * 防呆: read-only, try/catch → null; never throws into the write path. Returns
 * null when content is unchanged, binary, or oversize.
 *
 * @param {{filePath: string, beforeContent: string}|null} writeCtx
 * @returns {{filePath: string, beforeContent: string, afterContent: string}|null}
 */
function _finalizeWriteDiff(writeCtx) {
  try {
    if (!writeCtx || typeof writeCtx.filePath !== 'string') return null;
    const { filePath } = writeCtx;
    const beforeContent = typeof writeCtx.beforeContent === 'string' ? writeCtx.beforeContent : '';

    const afterContent = _safeReadForDiff(filePath);
    if (afterContent === null) return null;        // binary / oversize result — skip
    if (beforeContent === afterContent) return null; // no-op write — nothing to show
    return { filePath, beforeContent, afterContent };
  } catch {
    return null;
  }
}

// ── Task Decomposition ────────────────────────────────────────────

/**
 * Determine if a user message represents a complex multi-step task.
 * Uses multi-dimensional heuristics instead of simple keyword matching:
 *   1. Length — longer messages tend to be multi-step
 *   2. Structure — numbered lists, bullet points, multiple sentences
 *   3. Scope — mentions multiple files, components, or actions
 *   4. Connectives — sequential/parallel intent markers (weighted, not binary)
 *
 * @param {string} message
 * @returns {{ isComplex: boolean, score: number }}
 */
const _isComplexTask = (message) => require('./taskComplexity').isComplexTask(message);

/**
 * Determine if a complex task should trigger auto-decomposition hints.
 * Requires higher complexity score AND visible parallel structure.
 * @param {string} message
 * @param {number} score - complexity score from _isComplexTask
 * @returns {boolean}
 */
const _shouldAutoDecompose = (message, score) => require('./taskComplexity').shouldAutoDecompose(message, score);

/**
 * Inject planning instruction into the user message so AI outputs
 * an execution plan alongside tool calls in the same response.
 * @param {string} message
 * @returns {string}
 */
function _injectPlanningPrompt(message, opts = {}) {
  const planInst = [
    '[System: This task has multiple steps.',
    'Before starting, briefly outline your approach (2-5 numbered steps with specific file/function names).',
    'Wrap it in <execution_plan> tags. Then immediately begin the first step.',
    'Steps that can run in parallel should share a parallel_group label, e.g. "2. [read] Read config ← parallel_group: A".',
    'Between steps, provide a brief status update. Do NOT just silently chain tool calls.]',
  ].join(' ');

  // 计划优先级标注(goal 2026-06-25):要求每个步骤带 P0/P1/P2 并把高优先级排前,
  // 让计划按重要性可排序。单一真源在 priorityTaxonomy;模块缺失或开关关闭时静默跳过。
  let priorityInst = '';
  try {
    const _tax = require('./priorityTaxonomy');
    priorityInst = _tax.buildPlanPriorityInstruction(process.env);
  } catch { priorityInst = ''; }
  const head = priorityInst ? `${planInst}\n${priorityInst}` : planInst;

  // When auto-decompose is triggered, encourage Agent subtasks for parallel work
  if (opts.autoDecompose) {
    const decomposeHint = '\n[System: This task contains independent parts. If subtasks are independent and can benefit from parallel execution, use the Agent tool with a `subtasks` array to run them concurrently.]';
    return `${head}${decomposeHint}\n\n${message}`;
  }

  return `${head}\n\n${message}`;
}

/**
 * 关键节点主动汇报：把"命中里程碑用 <finding> 标记吐出"的指令作为 user-message
 * 前言注入（与 _injectPlanningPrompt 同约定）。单一真源在 cli/keyFindings.js；
 * 模块缺失或开关关闭时返回原文（fail-soft / no-op）。
 * @param {string} message
 * @param {object} [env=process.env]
 * @returns {string}
 */
function _injectKeyFindingsPrompt(message, env = process.env) {
  if (!_keyFindings || typeof _keyFindings.buildKeyFindingsInstruction !== 'function') return message;
  let inst = '';
  try { inst = _keyFindings.buildKeyFindingsInstruction(env) || ''; } catch { inst = ''; }
  if (!inst) return message;
  return `${inst}\n\n${message}`;
}

/**
 * Parse an execution plan from AI response text.
 * @param {string} text - AI response
 * @returns {{steps: Array<{id: number, description: string, toolHint: string, status: string}>} | null}
 */
function _parseExecutionPlan(text) {
  if (!text) return null;
  const match = text.match(/<execution_plan>([\s\S]*?)<\/execution_plan>/);
  if (!match) return null;

  const planText = match[1].trim();
  const lines = planText.split('\n').filter(l => l.trim());
  const steps = [];

  for (const line of lines) {
    // Match patterns like: "1. [P0] [shell_command] Run git status" or "1. Check the file"
    // Optional parallel_group suffix: "← parallel_group: A" or "(parallel_group: B)"
    const stepMatch = line.match(/^\s*(\d+)\.\s*(.+)/);
    if (stepMatch) {
      const id = parseInt(stepMatch[1], 10);
      let rest = stepMatch[2].trim();
      let parallelGroup = null;

      // 优先级标号(goal 2026-06-25):抽出步骤头部任意位置的 [P0]/[P1]… 标签,
      // 单独成字段而非误当 toolHint。结构性提取,零依赖、开关关时不出现也无害。
      let priority = '';
      const prMatch = rest.match(/\[\s*(P\d)\s*\]/i);
      if (prMatch) {
        priority = prMatch[1].toUpperCase();
        rest = (rest.slice(0, prMatch.index) + rest.slice(prMatch.index + prMatch[0].length)).trim();
      }

      // Optional leading toolHint bracket, e.g. "[shell_command]".
      let toolHint = '';
      const thMatch = rest.match(/^\[([^\]]*)\]\s*/);
      if (thMatch) { toolHint = thMatch[1]; rest = rest.slice(thMatch[0].length).trim(); }
      let description = rest;

      // Extract parallel_group marker
      const pgMatch = description.match(/[←←]\s*parallel_group:\s*(\w+)\s*$/i)
        || description.match(/\(parallel_group:\s*(\w+)\)\s*$/i);
      if (pgMatch) {
        parallelGroup = pgMatch[1].toUpperCase();
        description = description.slice(0, description.indexOf(pgMatch[0])).trim();
      }

      steps.push({
        id,
        toolHint,
        priority,
        description,
        status: 'pending',
        parallelGroup,
      });
    }
  }

  return steps.length > 0 ? { steps } : null;
}

/**
 * Match a tool call to the most likely plan step.
 * Uses tool name matching and sequential advancement.
 * @param {string} toolName
 * @param {object} params
 * @param {object} plan - { steps: [...] }
 * @param {number} currentStep - Current plan step index
 * @returns {number} Matched step index, or -1 if no match
 */
const _matchToolCallToStep = (toolName, params, plan, currentStep) => require('./taskComplexity').matchToolCallToStep(toolName, params, plan, currentStep);

/**
 * Check if the tool-use loop is enabled via feature flag.
 * @returns {boolean}
 */
function isEnabled() {
  return process.env.KHY_TOOL_LOOP !== 'false';
}

// ── Exports ────────────────────────────────────────────────────────
// Phase 1J backward-compatible re-exports from extracted modules.
// Internal callers continue to use toolUseLoop.xxx — no breaking change.

const _toolCallParser      = require('./toolCallParser');
const _deliveryFormatter   = require('./deliveryFormatter');
const _intentHeuristics    = require('./intentHeuristics');
const _taskComplexity      = require('./taskComplexity');
const _capabilityAssess    = require('./capabilityAssessment');
const _scaffoldExtractor   = require('./scaffoldExtractor');
const _appLaunchRecovery   = require('./appLaunchRecovery');
const _platformRewrite     = require('./platformRewrite');
const _toolCallNudges      = require('./toolCallNudges');
const _modelTier           = require('./modelTier');


module.exports = {
  PRUNE_KEEP_RECENT,
  PRUNE_THRESHOLD,
  _BLOCKED_FILE_READ_TOOLS,
  _BLOCKED_SEARCH_TOOLS,
  _DIFF_MAX_BYTES,
  _DIFF_PATH_KEYS,
  _PATCH_NORMALIZED_SEARCH_NAMES,
  _PATCH_SEARCH_NAMES,
  _PATCH_SHELL_NAMES,
  _UNIX_TO_WIN,
  _WIN_TO_UNIX,
  _WRITE_TOOL_NAMES,
  _appLaunchInterruptPrecedenceEnabled,
  _appLaunchRecovery,
  _buildAppLaunchRecoveryCandidates,
  _buildAppLaunchToolNudge,
  _buildChoiceResponseNudge,
  _buildConstraintFallbackReply,
  _buildConstraintRespectNudge,
  _buildDeliverySummary,
  _buildNoToolCallNudge,
  _buildScaffoldToolNudge,
  _buildSearchQueryCandidates,
  _buildToolResultMessage,
  _buildUserToolConstraintDirective,
  _buildWebSearchToolNudge,
  _capabilityAssess,
  _captureWriteFileDiffContext,
  _deliveryFormatter,
  _emitDeliveryFinalEvent,
  _extractAppCandidatesFromShellCommand,
  _extractAppTargetFromShellCommand,
  _extractAppTargetFromUserMessage,
  _extractErrorTextFromResult,
  _extractScaffoldSpecFromMessage,
  _extractUserToolConstraints,
  _filterToolCallsByIntent,
  _finalizeWriteDiff,
  _findLatestFailedOpenAppEntry,
  _findLatestShellExecutorUnavailableEntry,
  _findLatestSuccessfulOpenAppEntry,
  _getLinuxCommandHint,
  _getWindowsCommandHint,
  _injectKeyFindingsPrompt,
  _injectPlanningPrompt,
  _intentHeuristics,
  _isComplexTask,
  _isShellExecutorUnavailableResult,
  _isShellToolName,
  _isWebLookupToolName,
  _looksLikeActionRequest,
  _looksLikeAppLaunchRequest,
  _looksLikeCannedRefusal,
  _looksLikeChoiceResponse,
  _looksLikeDeliveryConclusion,
  _looksLikeDirectoryToken,
  _looksLikeFilePathToken,
  _looksLikeInfoSearchRequest,
  _looksLikeProgressOnlyReply,
  _looksLikeProjectScaffoldRequest,
  _looksLikeShellAppProbeCommand,
  _looksLikeToolOutputEcho,
  _matchBlockedToolConstraint,
  _matchToolCallToStep,
  _matchesShellDispatchName,
  _modelTier,
  _normalizeAppTarget,
  _parseExecutionPlan,
  _patchEmptyLocalSearchKeyword,
  _patchEmptySearchQuery,
  _patchEmptyShellCommand,
  _platformRewrite,
  _proactivePlatformRewrite,
  _pruneOldToolOutputs,
  _recoverOpenAppAfterAiInterruption,
  _recoverOpenAppAfterShellFailure,
  _recoverWebSearchAfterShellFailure,
  _refusalStatesConcreteReason,
  _replyIsUnsynthesizedListing,
  _resolveWriteToolPath,
  _rewriteShellCallsForAppLaunch,
  _safeReadForDiff,
  _sanitizeSearchSourceMessage,
  _scaffoldExtractor,
  _shouldAutoDecompose,
  _stripExecutionPlan,
  _stripToolCalls,
  _taskComplexity,
  _toolCallNudges,
  _toolCallParser,
  _unwrapPastedContent,
  isEnabled,
  maybeAttachCognitiveObserver,
  maybeForgeStructuredIntent,
  setToolUseLoopHelpersDeps,
};

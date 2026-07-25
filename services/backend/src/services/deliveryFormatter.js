'use strict';

/**
 * Delivery formatting — tool result message building, output extraction,
 * plan stripping, delivery summary generation.
 *
 * Extracted from toolUseLoop.js (lines 3537-3944) as part of the
 * industrial-grade modularization (Phase 1F).
 *
 * Dependencies: smartTruncation (lazy), contentBlockUtils (lazy),
 *               traceAuditService (parameter injection), crypto.
 */

const crypto = require('crypto');

// ── Output extraction ────────────────────────────────────────────────

/**
 * Extract meaningful output from a tool result object.
 *
 * Since Phase 2A/2B, all tools going through _baseTool.defineTool() have
 * their results normalized to include a `content` field. This function
 * now trusts `content` first, with a lightweight fallback for results
 * that bypass the normalizer (legacy/external tools).
 */
function extractToolOutput(result) {
  if (!result || typeof result !== 'object') return result;

  // Fast path: normalizer guarantees `content` for all _baseTool results
  if (result.content != null && result.content !== '') return result.content;

  // Fallback for results that bypassed the normalizer
  const direct = result.output || result.result || result.data
    || result.message || result.answer;
  if (direct != null && direct !== '') return direct;

  return null;
}

// ── Tool result message building ─────────────────────────────────────

/**
 * Build a follow-up message containing tool execution results.
 * Formatted so the AI can understand what happened and continue.
 */
function buildToolResultMessage(toolResults) {
  const _structuredToolResults = [];
  const parts = ['[Tool execution results]\n'];

  for (const tr of toolResults) {
    if (tr.tool === '_legacy_cmd') continue;

    const idRef = tr._toolUseId ? ` [tool_use_id=${tr._toolUseId}]` : '';
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
      const output = extractToolOutput(tr.result);
      if (output) {
        const text = typeof output === 'string' ? output : JSON.stringify(output);
        // D13: Smart per-tool truncation with noise classification
        try {
          const _smartTrunc = require('./smartTruncation');
          const contextBudget = Number(process.env.KHY_CONTEXT_TOKEN_LIMIT) || 65536;
          const truncResult = _smartTrunc.truncate(tr.tool, text, { contextBudget });
          if (truncResult.truncated) {
            const omitted = truncResult.originalLen - truncResult.text.length;
            toolOutputText += `${truncResult.text}\n... [${truncResult.strategy}: ${omitted} chars omitted, ${Math.ceil(omitted / 4)} est. tokens saved]`;
          } else {
            toolOutputText += truncResult.text;
          }
        } catch {
          const maxLen = 50000;
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
    const effectiveToolUseId = tr._toolUseId || `synth_${crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)}`;
    _structuredToolResults.push({
      tool_use_id: effectiveToolUseId,
      tool: tr.tool,
      content: toolOutputText || (isError ? 'Error' : 'Success'),
      is_error: isError,
    });

    // Build plain text parts (fallback for non-structured adapters)
    if (!tr._autoVerify && !tr.result._deduped && !tr.result._loopDetected) {
      parts.push(`Tool: ${tr.tool}${idRef}`);
    } else {
      parts.push(toolOutputText.split('\n')[0]);
    }
    if (tr._loopWarning) {
      parts.push(`[LoopWarning: ${tr._loopWarning} — try a different tool or approach]`);
    }
    if (tr.result.success) {
      const plainOutput = toolOutputText.trim();
      if (plainOutput) {
        parts.push(`Result: ${plainOutput}`);
      } else {
        parts.push('Result: Success');
      }
    } else {
      parts.push(toolOutputText.trim() || 'Error: Unknown error');
    }
    parts.push('');
  }

  const plainText = parts.join('\n');

  let structuredBlocks = null;
  try {
    const { buildToolResultContent } = require('./contentBlockUtils');
    structuredBlocks = buildToolResultContent(_structuredToolResults);
  } catch {
    structuredBlocks = null;
  }

  return {
    text: plainText,
    structuredBlocks,
    structuredToolResults: _structuredToolResults.length > 0 ? _structuredToolResults : null,
  };
}

// ── Text stripping ───────────────────────────────────────────────────

const _KNOWN_BARE_STRIP = /^(bash|shell|sh|command|read|readfile|write|writefile|edit|editfile|grep|rg|glob|find|ls|websearch|webfetch|search|agent|task)$/i;

// Single source of truth for "inline tool-call noise" (bare `{"name":…,"params":…}`
// JSON + `<function=…>` tags). fail-soft: missing copy → legacy strip unchanged.
let _toolCallNoise; try { _toolCallNoise = require('../cli/toolCallNoise'); } catch { _toolCallNoise = null; }

function stripToolCalls(text) {
  if (!text) return '';
  const lines = text.split('\n');
  const cleaned = lines.filter((line) => {
    const stripped = line.replace(/^\s*[>│┃├└╰❯▸›•*-]+\s*/u, '').trim();
    const bm = stripped.match(/^([A-Za-z][A-Za-z0-9_]{0,24})\s*\([\s\S]*\)\s*$/);
    if (bm && _KNOWN_BARE_STRIP.test(bm[1])) return false;
    return true;
  }).join('\n');
  let result = cleaned
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
    .replace(/【\s*调用\s*([^：:\]】\n]{1,32})\s*(?:[：:]\s*([^】]*?))?\s*】/g, '')
    .replace(/▶\s*[\w_]+\s*\([^)]*\)/g, '');
  // Also strip the two text-protocol forms the legacy rules miss: bare
  // `{"name":…,"params":…}` JSON lines and `<function=…>…</function>` tags.
  // Reuses the render-layer SSOT so the noise definition lives in one place.
  // fail-soft / gate-off → `result` unchanged → legacy byte-identical output.
  if (_toolCallNoise) {
    try { result = _toolCallNoise.stripInlineToolCallNoise(result, process.env); } catch { /* keep legacy */ }
  }
  return result
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripExecutionPlan(text) {
  if (!text) return text;
  return text.replace(/<execution_plan>[\s\S]*?<\/execution_plan>/g, '').trim();
}

// ── Steer injection ──────────────────────────────────────────────────

function injectSteerIfPresent(currentMessage, getSteerMessages) {
  if (typeof getSteerMessages !== 'function') return currentMessage;
  try {
    const steerMsgs = getSteerMessages();
    if (!Array.isArray(steerMsgs) || steerMsgs.length === 0) return currentMessage;
    const block = steerMsgs.map(m => String(m || '').trim()).filter(Boolean).join('\n');
    if (!block) return currentMessage;
    return currentMessage + `\n\n[用户方向修正 — 请仔细阅读并调整后续方案]\n${block}\n[方向修正结束]`;
  } catch { return currentMessage; }
}

// ── Tool output pruning ──────────────────────────────────────────────

const PRUNE_THRESHOLD = 3000;
const PRUNE_KEEP_RECENT = 2;

function pruneOldToolOutputs(toolCallLog, currentIteration) {
  const recentCutoff = currentIteration - PRUNE_KEEP_RECENT;
  for (const entry of toolCallLog) {
    if (!entry || entry.iteration >= recentCutoff || entry._pruned) continue;
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

    if (r.output && typeof r.output === 'string' && r.output.length > PRUNE_THRESHOLD) r.output = summary;
    if (r.content && typeof r.content === 'string' && r.content.length > PRUNE_THRESHOLD) r.content = summary;
    if (r.result && typeof r.result === 'string' && r.result.length > PRUNE_THRESHOLD) r.result = summary;
    if (r.text && typeof r.text === 'string' && r.text.length > PRUNE_THRESHOLD) r.text = summary;
    entry._pruned = true;
  }
}

// ── Delivery summary ─────────────────────────────────────────────────

function buildDeliverySummary(toolCallLog) {
  if (!toolCallLog || toolCallLog.length === 0) return '';

  const filteredLog = toolCallLog.filter(entry => {
    const r = entry.result;
    if (!r) return true;
    if (r._deduped || r._loopDetected) return false;
    if (typeof r.error === 'string' && /^\[(ToolCallGuardrail|LoopDetector|Hook|ShellSafety)/.test(r.error)) return false;
    return true;
  });

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

  const sections = [];

  const allFileChanges = [];
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

  if (cmdOps.length > 0) {
    sections.push('');
    sections.push(`**执行命令 (${cmdOps.length})**`);
    const display = cmdOps.slice(0, 5);
    for (const c of display) {
      sections.push(`  \`$ ${c.cmd}\`${c.success ? '' : ' ❌'}`);
    }
    if (cmdOps.length > 5) sections.push(`  ...+${cmdOps.length - 5} more`);
  }

  if (searchOps.length > 0) {
    sections.push('');
    sections.push(`**搜索 (${searchOps.length})**`);
    sections.push(`  ${searchOps.slice(0, 3).map(q => `"${q}"`).join(', ')}${searchOps.length > 3 ? ` +${searchOps.length - 3}` : ''}`);
  }

  const statsItems = [];
  statsItems.push(`${toolCallLog.length} 次调用`);
  statsItems.push(`${succeeded} 成功`);
  if (failed > 0) statsItems.push(`${failed} 失败`);
  if (readOps.length > 0) statsItems.push(`${readOps.length} 次读取`);
  if (elapsedSec) statsItems.push(elapsedSec);

  if (!hasWriteActions) {
    return `\n\n---\n### 完成摘要\n\n**统计**  ${statsItems.join(' · ')}\n未修改任何文件。`;
  }

  sections.push('');
  sections.push(`**统计**  ${statsItems.join(' · ')}`);

  return `\n\n---\n### 完成摘要\n\n${sections.join('\n')}`;
}

// ── Trace audit ──────────────────────────────────────────────────────

function emitDeliveryFinalEvent(traceAudit, traceSessionId, diagTraceId, requestId, payload = {}) {
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

module.exports = {
  extractToolOutput,
  buildToolResultMessage,
  stripToolCalls,
  stripExecutionPlan,
  injectSteerIfPresent,
  pruneOldToolOutputs,
  buildDeliverySummary,
  emitDeliveryFinalEvent,
};

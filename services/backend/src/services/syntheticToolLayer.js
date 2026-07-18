/**
 * syntheticToolLayer.js — Synthetic Tool Layer for low-tier models.
 *
 * Small models (Ollama qwen 7B, localLLM etc.) don't support native function
 * calling. This layer intercepts their text output, detects actionable intent,
 * and executes tools on the model's behalf.
 *
 * Activation: only when tool_use ≤ 1 (via capabilityRegistry) AND no real
 * tool calls were returned by _parseToolCalls().
 *
 * Confidence tiers:
 *   ≥ 0.9  — silent execution, result appended to output
 *   0.6–0.89 — execute with [KHY 已自动执行: ...] notice
 *   < 0.6  — no execution, suggestion only
 *
 * Max 1 action per response. Kill switch: KHY_SYNTHETIC_TOOLS=false
 */

'use strict';

const path = require('path');
const os = require('os');

// ─── Kill switch ───────────────────────────────────────────────────────
function isEnabled() {
  const env = String(process.env.KHY_SYNTHETIC_TOOLS || '').toLowerCase();
  if (env === 'false' || env === '0' || env === 'off') return false;
  return true;
}

// ─── Gate: should the layer even try? ─────────────────────────────────
let _capRegistry;
try { _capRegistry = require('./gateway/capabilityRegistry'); } catch { _capRegistry = null; }

function shouldActivate(ctx = {}) {
  if (!isEnabled()) return false;
  // If the caller already knows the model is low-tier, trust it.
  if (ctx.isLowTierModel) return true;
  // Otherwise query capabilityRegistry for tool_use score.
  if (_capRegistry && ctx.adapter) {
    const score = _capRegistry.getCapability?.(ctx.adapter, 'tool_use') ?? 5;
    return score <= 1;
  }
  return false;
}

// ─── Detector registry ────────────────────────────────────────────────
// Each detector: { name, priority, match(output, ctx) → confidence, extract(output, ctx) → toolParams }
const DETECTORS = [];

// Helpers
function _userWants(userMsg, patterns) {
  const t = String(userMsg || '').toLowerCase();
  for (const p of patterns) {
    if (p instanceof RegExp ? p.test(t) : t.includes(p)) return true;
  }
  return false;
}

function _outputContains(output, patterns) {
  const t = String(output || '');
  for (const p of patterns) {
    if (p instanceof RegExp ? p.test(t) : t.includes(p)) return true;
  }
  return false;
}

function _extractCodeBlocks(text) {
  const blocks = [];
  const re = /```(\w*)\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text))) {
    blocks.push({ lang: m[1] || '', code: m[2].trim() });
  }
  return blocks;
}

function _inferOutputPath(userMsg, defaultDir, ext) {
  const t = String(userMsg || '');

  // Chinese directory aliases → real paths
  const DIR_ALIASES = {
    '桌面': path.join(os.homedir(), 'Desktop'),
    '下载': path.join(os.homedir(), 'Downloads'),
    '文档': path.join(os.homedir(), 'Documents'),
    '主目录': os.homedir(),
  };

  // "保存到 ~/Desktop/foo.docx" or "save to /tmp/foo.txt"
  const pathMatch = t.match(/(?:保存到|存到|写入|save\s+to|write\s+to|放到|放在)\s*["""']?([^\s"""']+)/i);
  if (pathMatch) {
    let p = pathMatch[1].trim();
    // Resolve Chinese aliases first
    if (DIR_ALIASES[p]) return DIR_ALIASES[p];
    if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1));
    // Ensure correct extension
    if (ext && !p.endsWith(ext)) {
      const parsed = path.parse(p);
      if (!parsed.ext) p = p + ext;
    }
    return p;
  }
  // "桌面" / "desktop"
  if (/桌面|desktop/i.test(t)) return path.join(os.homedir(), 'Desktop');
  return defaultDir || path.join(os.homedir(), 'Desktop');
}

function _inferTitle(userMsg) {
  const t = String(userMsg || '');
  // "写一份XX攻略" → "XX攻略"
  const m = t.match(/(?:写|创建|生成|制作|做|帮我写|write|create|make)\s*(?:一份|一个|一篇)?\s*(.{2,30}?)(?:保存|存|放|$)/i);
  if (m) return m[1].trim();
  // "关于XX的文档" → "XX"
  const m2 = t.match(/(?:关于|about)\s*(.{2,20}?)(?:的|文档|document)/i);
  if (m2) return m2[1].trim();
  return '';
}

// ─── Detector: save_as_docx (priority 10) ─────────────────────────────
DETECTORS.push({
  name: 'save_as_docx',
  priority: 10,
  toolName: 'createDocument',

  match(output, ctx) {
    const user = ctx.userMessage || '';
    // User must want a document
    const wantsDoc = _userWants(user, [
      '文档', 'word', 'docx', /保存.*文/, /写.*报告/, /写.*攻略/,
      /写.*方案/, /写.*计划/, /create.*doc/i, /write.*report/i,
    ]);
    if (!wantsDoc) return 0;

    // Model output must be substantial prose
    const outLen = String(output || '').length;
    if (outLen < 200) return 0;

    const hasProseMarker = _outputContains(output, [
      '以下是', '内容如下', 'Here is', 'here is', '如下', '以下',
      /^#\s+/m, /^##\s+/m,
    ]);
    if (!hasProseMarker && outLen < 500) return 0.4;
    return hasProseMarker ? 0.92 : 0.7;
  },

  extract(output, ctx) {
    const user = ctx.userMessage || '';
    let outPath = _inferOutputPath(user, null, '.docx');
    // If outPath is a directory, generate filename
    if (!path.extname(outPath)) {
      const title = _inferTitle(user) || '文档';
      outPath = path.join(outPath, `${title}.docx`);
    }
    // Strip meta-commentary prefix ("以下是XXX的内容：\n")
    let content = String(output || '');
    content = content.replace(/^.*?(?:以下是|内容如下|Here is)[^\n]*\n/i, '').trim();
    if (!content) content = output;

    return {
      content,
      outputPath: outPath,
      title: _inferTitle(user),
    };
  },
});

// ─── Detector: save_as_file (priority 20) ─────────────────────────────
DETECTORS.push({
  name: 'save_as_file',
  priority: 20,
  toolName: 'Write',

  match(output, ctx) {
    const user = ctx.userMessage || '';
    const wantsSave = _userWants(user, [
      /保存到/, /写入/, /存到/, /create\s+file/i, /save\s+(?:to|as)/i,
      /write\s+to/i, /放到/,
    ]);
    if (!wantsSave) return 0;

    const blocks = _extractCodeBlocks(output);
    if (blocks.length === 0) return 0;
    return 0.9;
  },

  extract(output, ctx) {
    const user = ctx.userMessage || '';
    const blocks = _extractCodeBlocks(output);
    const block = blocks[0] || { lang: '', code: '' };

    // Infer extension from language hint
    const langExtMap = {
      js: '.js', javascript: '.js', ts: '.ts', typescript: '.ts',
      py: '.py', python: '.py', java: '.java', cpp: '.cpp', c: '.c',
      html: '.html', css: '.css', json: '.json', yaml: '.yaml', yml: '.yml',
      sh: '.sh', bash: '.sh', zsh: '.sh', md: '.md', txt: '.txt',
      rs: '.rs', go: '.go', rb: '.rb', swift: '.swift', kt: '.kt',
    };
    const ext = langExtMap[block.lang.toLowerCase()] || '.txt';

    let filePath = _inferOutputPath(user, null, ext);
    if (!path.extname(filePath)) {
      filePath = filePath + ext;
    }

    return {
      file_path: filePath,
      content: block.code,
    };
  },
});

// ─── Detector: execute_shell (priority 30) ────────────────────────────
DETECTORS.push({
  name: 'execute_shell',
  priority: 30,
  toolName: 'shellCommand',

  match(output, ctx) {
    const user = ctx.userMessage || '';
    const blocks = _extractCodeBlocks(output);
    const shellBlocks = blocks.filter(b =>
      /^(bash|sh|zsh|shell|terminal|cmd|powershell)?$/i.test(b.lang)
      && b.code.split('\n').length <= 3
      && b.code.length < 100
    );
    if (shellBlocks.length !== 1) return 0;

    // Model must suggest running it
    const suggestsRun = _outputContains(output, [
      '建议执行', '可以执行', '运行以下', '可以运行', '执行以下',
      'you can run', 'run the following', 'execute the',
    ]);
    // User must want execution
    const wantsRun = _userWants(user, [
      '执行', '运行', '跑', 'run', 'execute', '命令', 'command',
    ]);

    if (suggestsRun && wantsRun) return 0.85;
    if (suggestsRun || wantsRun) return 0.6;
    return 0.3;
  },

  extract(output, ctx) {
    const blocks = _extractCodeBlocks(output);
    const shellBlock = blocks.find(b =>
      /^(bash|sh|zsh|shell|terminal|cmd|powershell)?$/i.test(b.lang)
      && b.code.split('\n').length <= 3
      && b.code.length < 100
    );
    return {
      command: shellBlock ? shellBlock.code.trim() : '',
      cwd: ctx.cwd || process.cwd(),
    };
  },
});

// ─── Detector: open_app (priority 40) ─────────────────────────────────
DETECTORS.push({
  name: 'open_app',
  priority: 40,
  toolName: 'open_app',

  match(output, ctx) {
    const user = ctx.userMessage || '';
    const wantsOpen = _userWants(user, [
      /打开/, /启动/, /launch/i, /open\s+\w+/i,
    ]);
    if (!wantsOpen) return 0;

    const outputSuggests = _outputContains(output, [
      /打开|启动|launch|open\s+/i,
    ]);
    return outputSuggests ? 0.8 : 0.4;
  },

  extract(output, ctx) {
    const user = ctx.userMessage || '';
    // Extract app name from user message: "打开Chrome" → "Chrome"
    const m = (user + ' ' + output).match(
      /(?:打开|启动|launch|open)\s+([A-Za-z\u4e00-\u9fff]+(?:\s+[A-Za-z]+)?)/i
    );
    return { appName: m ? m[1].trim() : '' };
  },
});

// ─── Detector: web_search (priority 50) ────────────────────────────────
DETECTORS.push({
  name: 'web_search',
  priority: 50,
  toolName: 'web_search',

  match(output, ctx) {
    const outputAdmits = _outputContains(output, [
      '无法确定最新', '建议搜索', '无法获取最新', '建议您搜索',
      "I don't have current", "I don't have access to real-time",
      'my knowledge cutoff', 'search for the latest',
      '无法提供最新', '无法确认当前',
    ]);
    if (!outputAdmits) return 0;

    const user = ctx.userMessage || '';
    const wantsInfo = _userWants(user, [
      /最新/, /现在/, /当前/, /latest/i, /current/i, /搜索/, /search/i,
      /查/, /查询/, /今天/, /today/i,
    ]);
    return wantsInfo ? 0.85 : 0.55;
  },

  extract(output, ctx) {
    const user = ctx.userMessage || '';
    // Use user message as search query, stripped of filler
    let query = user.replace(/请|帮我|帮忙|一下|吧|呢/g, '').trim();
    if (!query || query.length < 2) query = user;
    return { query };
  },
});

// Sort by priority (lower = higher priority)
DETECTORS.sort((a, b) => a.priority - b.priority);

// ─── Core API ─────────────────────────────────────────────────────────

/**
 * Scan model output for the best matching synthetic action.
 * Returns null if nothing matches with confidence ≥ threshold.
 */
function detectSyntheticAction(output, ctx = {}) {
  let best = null;
  for (const det of DETECTORS) {
    const confidence = det.match(output, ctx);
    if (confidence > (best?.confidence || 0)) {
      best = {
        name: det.name,
        toolName: det.toolName,
        confidence,
        toolParams: det.extract(output, ctx),
      };
    }
  }
  return best;
}

/**
 * Execute a detected synthetic action via the unified executeTool() pipeline.
 */
async function executeSyntheticAction(plan, opts = {}) {
  let _executeTool;
  try { ({ executeTool: _executeTool } = require('./toolCalling')); } catch { _executeTool = null; }

  if (!_executeTool) {
    return { success: false, error: 'toolCalling not available' };
  }
  if (!plan?.toolName || !plan?.toolParams) {
    return { success: false, error: 'Invalid synthetic action plan' };
  }

  const traceCtx = {
    sessionId: opts.sessionId || '',
    traceId: opts.traceId || `syn_${Date.now()}`,
  };

  try {
    const result = await _executeTool(plan.toolName, plan.toolParams, traceCtx);
    return result;
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Merge the original model output with the synthetic action result.
 */
function formatWithSyntheticAction(originalText, result, plan) {
  if (!plan || !result) return originalText;

  const actionLabel = {
    save_as_docx: '保存为 Word 文档',
    save_as_file: '保存文件',
    execute_shell: '执行命令',
    open_app: '打开应用',
    web_search: '搜索',
  }[plan.name] || plan.name;

  const suffix = result.success
    ? `\n\n---\n✅ ${actionLabel} 完成` + (result.outputPath ? `：${result.outputPath}` : '')
    : `\n\n---\n⚠️ ${actionLabel} 失败：${result.error || '未知错误'}`;

  if (plan.confidence >= 0.9) {
    // Silent: just append result
    return originalText + suffix;
  }
  // 0.6-0.89: explicit notice
  return originalText + `\n\n[KHY 已自动执行: ${actionLabel}]` + suffix;
}

module.exports = {
  isEnabled,
  shouldActivate,
  detectSyntheticAction,
  executeSyntheticAction,
  formatWithSyntheticAction,
  // For testing
  _DETECTORS: DETECTORS,
};

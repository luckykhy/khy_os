'use strict';

const fs = require('fs');
const path = require('path');

function _shortText(value, max = 220) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function _safeNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function _ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function _extractModelUsage(event, modelMap) {
  const type = String(event.type || '');
  const data = event.data || {};
  if (!(type === 'llm.request' || type === 'llm.response' || type === 'diag.model_request' || type === 'diag.model_response')) {
    return;
  }
  const model = String(data.model || data.requestedModel || event.model || 'unknown');
  const provider = String(data.provider || data.adapter || data.adapterKey || event.provider || 'unknown');
  const key = `${provider}::${model}`;
  if (!modelMap[key]) {
    modelMap[key] = {
      provider,
      model,
      requests: 0,
      responses: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };
  }
  if (type.endsWith('request')) {
    modelMap[key].requests += 1;
  } else {
    modelMap[key].responses += 1;
    modelMap[key].inputTokens += _safeNum(data.inputTokens || data.promptTokens);
    modelMap[key].outputTokens += _safeNum(data.outputTokens || data.completionTokens);
    const total = _safeNum(data.totalTokens);
    modelMap[key].totalTokens += total > 0
      ? total
      : (_safeNum(data.inputTokens || data.promptTokens) + _safeNum(data.outputTokens || data.completionTokens));
  }
}

function _extractToolUsage(event, toolMap) {
  const type = String(event.type || '');
  const data = event.data || {};
  if (!(
    type === 'tool.wrapper.start'
    || type === 'tool.wrapper.end'
    || type === 'diag.tool_call'
    || type === 'diag.tool_result'
    || type === 'agent.tool.call'
    || type === 'agent.tool.result'
  )) return;

  const tool = String(
    data.tool
    || data.toolName
    || event.tool
    || event.name
    || 'unknown'
  );
  if (!toolMap[tool]) {
    toolMap[tool] = {
      tool,
      calls: 0,
      success: 0,
      failed: 0,
      denied: 0,
      avgElapsedMs: 0,
      _elapsedTotal: 0,
      _elapsedCount: 0,
    };
  }
  const row = toolMap[tool];
  if (type.endsWith('start') || type.endsWith('tool_call')) {
    row.calls += 1;
    return;
  }
  const denied = !!(data.denied || data.permission === 'deny');
  const success = !!(data.success && !denied);
  const elapsed = _safeNum(data.elapsedMs || data.durationMs || data.elapsed);
  if (success) row.success += 1;
  else row.failed += 1;
  if (denied) row.denied += 1;
  if (elapsed > 0) {
    row._elapsedTotal += elapsed;
    row._elapsedCount += 1;
    row.avgElapsedMs = Math.round(row._elapsedTotal / row._elapsedCount);
  }
}

function buildSessionSummary(events = [], options = {}) {
  const list = Array.isArray(events) ? events : [];
  const startedAt = list[0]?.timestamp || null;
  const endedAt = list[list.length - 1]?.timestamp || null;
  const startedMs = startedAt ? Date.parse(startedAt) : 0;
  const endedMs = endedAt ? Date.parse(endedAt) : 0;
  const durationMs = startedMs > 0 && endedMs >= startedMs ? (endedMs - startedMs) : 0;

  const countsByType = {};
  const modelMap = {};
  const toolMap = {};
  const errors = [];
  const denied = [];

  for (const event of list) {
    const type = String(event.type || 'unknown');
    countsByType[type] = (countsByType[type] || 0) + 1;
    _extractModelUsage(event, modelMap);
    _extractToolUsage(event, toolMap);

    const data = event.data || {};
    const errMsg = data.error || data.message || (type.includes('error') ? (data.detail || '') : '');
    if (errMsg) {
      errors.push({
        type,
        message: _shortText(errMsg, 260),
        timestamp: event.timestamp || null,
      });
    }
    if (data.permission === 'deny' || data.denied) {
      denied.push({
        type,
        tool: data.tool || data.toolName || 'unknown',
        timestamp: event.timestamp || null,
      });
    }
  }

  const models = Object.values(modelMap).sort((a, b) => (b.responses + b.requests) - (a.responses + a.requests));
  const tools = Object.values(toolMap)
    .map((t) => ({
      tool: t.tool,
      calls: t.calls || (t.success + t.failed),
      success: t.success,
      failed: t.failed,
      denied: t.denied,
      avgElapsedMs: t.avgElapsedMs,
    }))
    .sort((a, b) => b.calls - a.calls);

  return {
    sessionId: options.sessionId || null,
    traceId: options.traceId || null,
    reason: options.reason || null,
    startedAt,
    endedAt,
    durationMs,
    totalEvents: list.length,
    eventTypes: countsByType,
    models,
    tools,
    denied,
    errors: errors.slice(0, 50),
    generatedAt: new Date().toISOString(),
  };
}

function renderSessionSummaryMarkdown(summary) {
  const s = summary || {};
  const lines = [];
  lines.push('# Session Audit Summary');
  lines.push('');
  lines.push(`- Session ID: ${s.sessionId || 'unknown'}`);
  lines.push(`- Trace ID: ${s.traceId || 'unknown'}`);
  lines.push(`- Started At: ${s.startedAt || 'unknown'}`);
  lines.push(`- Ended At: ${s.endedAt || 'unknown'}`);
  lines.push(`- Duration: ${Math.max(0, Math.round(_safeNum(s.durationMs) / 1000))}s`);
  lines.push(`- Total Events: ${_safeNum(s.totalEvents)}`);
  if (s.reason) lines.push(`- End Reason: ${s.reason}`);
  lines.push('');

  lines.push('## Models');
  if (!Array.isArray(s.models) || s.models.length === 0) {
    lines.push('- No model activity recorded');
  } else {
    for (const row of s.models.slice(0, 12)) {
      lines.push(`- ${row.provider}/${row.model}: req=${row.requests}, resp=${row.responses}, tokens=${row.totalTokens}`);
    }
  }
  lines.push('');

  lines.push('## Tools');
  if (!Array.isArray(s.tools) || s.tools.length === 0) {
    lines.push('- No tool activity recorded');
  } else {
    for (const row of s.tools.slice(0, 20)) {
      lines.push(`- ${row.tool}: calls=${row.calls}, success=${row.success}, failed=${row.failed}, denied=${row.denied}, avg=${row.avgElapsedMs}ms`);
    }
  }
  lines.push('');

  lines.push('## Errors');
  if (!Array.isArray(s.errors) || s.errors.length === 0) {
    lines.push('- No errors captured');
  } else {
    for (const e of s.errors.slice(0, 15)) {
      lines.push(`- [${e.type}] ${e.message}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function writeSessionSummary(sessionId, summary, outDir) {
  const safeSessionId = String(sessionId || 'session').replace(/[^a-zA-Z0-9._-]/g, '_');
  const targetDir = outDir || path.join(process.cwd(), '.khy', 'audit', 'summaries');
  _ensureDir(targetDir);

  const jsonPath = path.join(targetDir, `${safeSessionId}.json`);
  const mdPath = path.join(targetDir, `${safeSessionId}.md`);

  fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2), 'utf-8');
  fs.writeFileSync(mdPath, renderSessionSummaryMarkdown(summary), 'utf-8');

  return { jsonPath, mdPath };
}

async function compressSummaryWithLLM(summary, options = {}) {
  if (!summary) return null;
  const enabled = String(options.useLLM || process.env.KHY_SESSION_SUMMARY_USE_LLM || 'false').toLowerCase() === 'true';
  if (!enabled) return null;

  try {
    // Reach LLM generation through the zero-dependency provider sink instead of
    // importing the 6000-line aiGateway directly ([DESIGN-ARCH-051] §6.9). A
    // missing provider → null = same outcome as disabled/unavailable (best-effort).
    const llmGenerate = require('./llmGenerateSink').getLlmGenerateProvider();
    if (!llmGenerate) return null;
    const payload = JSON.stringify({
      sessionId: summary.sessionId,
      durationMs: summary.durationMs,
      totalEvents: summary.totalEvents,
      models: summary.models,
      tools: summary.tools,
      errors: summary.errors,
      denied: summary.denied,
    });
    const prompt = [
      'Summarize this audit payload for engineers.',
      'Output concise markdown with sections: Highlights, Failures, Security, Next Actions.',
      'Do not include secrets.',
      payload,
    ].join('\n');
    const result = await llmGenerate(prompt, {
      preferredAdapter: options.preferredAdapter || '',
      strictPreferred: false,
      maxTokens: Number(options.maxTokens || 800),
    });
    if (!result || !result.success) return null;
    return _shortText(result.content || '', 4000);
  } catch {
    return null;
  }
}

module.exports = {
  buildSessionSummary,
  renderSessionSummaryMarkdown,
  writeSessionSummary,
  compressSummaryWithLLM,
};

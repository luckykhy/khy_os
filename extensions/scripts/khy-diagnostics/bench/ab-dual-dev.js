#!/usr/bin/env node
/**
 * @pattern Command
 */
/**
 * A/B Dual Dev — run the same natural language task through KHY's claudeAdapter
 * (spawns `claude` CLI with Opus 4.6), record the full tool-call trajectory as
 * JSONL. Claude Code (the interactive session) executes the same task in
 * parallel, then we compare both trajectories.
 *
 * Usage:
 *   node scripts/ab-dual-dev.js "<natural language task>"
 *
 * Options (env vars):
 *   AB_MODEL          — model to use (default: claude-opus-4-6)
 *   AB_PERMISSION     — Claude permission mode (default: plan)
 *   AB_TIMEOUT_MS     — timeout in ms (default: 300000)
 *
 * Output:
 *   scripts/ab-traces/<timestamp>-khy.jsonl   — KHY trajectory (tool calls, text, status)
 *   scripts/ab-traces/<timestamp>-meta.json   — summary metadata
 */
'use strict';

const fs = require('fs');
const path = require('path');

const TRACE_DIR = path.join(__dirname, 'ab-traces');
const MODEL = process.env.AB_MODEL || 'claude-opus-4-6';
const PERMISSION_MODE = process.env.AB_PERMISSION || 'default';
const TIMEOUT_MS = parseInt(process.env.AB_TIMEOUT_MS || '300000', 10);
const USE_DIRECT = (process.env.AB_DIRECT || '').toLowerCase() === '1';

async function main() {
  const prompt = process.argv.slice(2).join(' ').trim();
  if (!prompt) {
    console.error('Usage: node scripts/ab-dual-dev.js "<task prompt>"');
    process.exit(1);
  }

  // Ensure trace directory
  if (!fs.existsSync(TRACE_DIR)) fs.mkdirSync(TRACE_DIR, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const tracePath = path.join(TRACE_DIR, `${ts}-khy.jsonl`);
  const metaPath = path.join(TRACE_DIR, `${ts}-meta.json`);
  const traceStream = fs.createWriteStream(tracePath, { flags: 'a' });

  console.log(`\n  ══ A/B Dual Dev — KHY Side ══`);
  console.log(`  Model   : ${MODEL}`);
  console.log(`  Direct  : ${USE_DIRECT ? 'YES (Anthropic API)' : 'NO (CLI subprocess)'}`);
  console.log(`  Mode    : ${PERMISSION_MODE}`);
  console.log(`  Prompt  : ${prompt.slice(0, 120)}${prompt.length > 120 ? '…' : ''}`);
  console.log(`  Trace   : ${tracePath}`);
  console.log();

  // Set timeout env for claudeAdapter
  process.env.GATEWAY_CLAUDE_TIMEOUT_MS = String(TIMEOUT_MS);

  // Load claudeAdapter
  let adapter;
  try {
    adapter = require('../../../../services/backend/src/services/gateway/adapters/claudeAdapter');
  } catch (err) {
    console.error('Failed to load claudeAdapter:', err.message);
    process.exit(1);
  }

  if (!adapter.detect()) {
    console.error('Claude Code CLI not detected — ensure `claude` is in PATH');
    process.exit(1);
  }

  const events = [];
  const startMs = Date.now();
  let toolCallCount = 0;

  const result = await adapter.generate(prompt, {
    model: MODEL,
    directMode: USE_DIRECT,
    permissionMode: PERMISSION_MODE,
    onChunk(chunk) {
      const entry = { ts: Date.now() - startMs, ...chunk };
      events.push(entry);
      traceStream.write(JSON.stringify(entry) + '\n');

      // Live console feedback
      const sec = ((Date.now() - startMs) / 1000).toFixed(1);
      if (chunk.type === 'status') {
        process.stdout.write(`  [${sec}s] ${chunk.text}\n`);
      } else if (chunk.type === 'tool_use') {
        toolCallCount++;
        process.stdout.write(`  [${sec}s] tool #${toolCallCount}: ${chunk.tool}(${(chunk.input || '').slice(0, 80)})\n`);
      } else if (chunk.type === 'tool_result') {
        process.stdout.write(`  [${sec}s] result: ${(chunk.content || '').slice(0, 80)}\n`);
      } else if (chunk.type === 'tool_progress') {
        // Show tool progress indicators (subagent work, etc.)
        if (chunk.detail) {
          process.stdout.write(`  [${sec}s] progress: ${chunk.tool || ''} ${chunk.detail.slice(0, 100)}\n`);
        }
      } else if (chunk.type === 'thinking') {
        // Thinking block — show first line only
        const firstLine = (chunk.text || '').split('\n')[0].slice(0, 120);
        if (firstLine) process.stdout.write(`  [${sec}s] think: ${firstLine}\n`);
      } else if (chunk.type === 'text') {
        process.stdout.write(`  [${sec}s] text: ${(chunk.text || '').slice(0, 200)}\n`);
      }
    },
  });

  traceStream.end();
  const elapsedMs = Date.now() - startMs;

  // Write meta
  const meta = {
    timestamp: new Date().toISOString(),
    prompt,
    model: MODEL,
    adapter: 'claude',
    directMode: USE_DIRECT,
    permissionMode: PERMISSION_MODE,
    success: result.success,
    elapsedMs,
    toolCalls: toolCallCount,
    traceEvents: events.length,
    contentLength: (result.content || '').length,
    error: result.error || null,
  };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

  console.log(`\n  ── KHY (via Claude CLI) Result ──`);
  console.log(`  Success     : ${result.success}`);
  console.log(`  Model       : ${MODEL}`);
  console.log(`  Elapsed     : ${(elapsedMs / 1000).toFixed(1)}s`);
  console.log(`  Tool calls  : ${toolCallCount}`);
  console.log(`  Events      : ${events.length}`);
  console.log(`  Content len : ${meta.contentLength} chars`);
  if (result.error) console.log(`  Error       : ${result.error}`);
  console.log(`  Trace saved : ${tracePath}`);
  console.log(`  Meta saved  : ${metaPath}`);

  // Print final AI content (first 2000 chars)
  if (result.content) {
    console.log(`\n  ── AI Response (truncated) ──\n`);
    console.log(result.content.slice(0, 2000));
    if (result.content.length > 2000) console.log('\n  ...(truncated)');
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

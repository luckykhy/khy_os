#!/usr/bin/env node
/**
 * @pattern Command
 */
/**
 * Compare KHY trace (JSONL) with Claude Code trace (JSONL).
 *
 * Usage:
 *   node scripts/ab-compare.js <khy-trace.jsonl> <claude-trace.jsonl>
 *
 * If only one file is given, it summarizes that trace alone.
 * Claude Code traces can be manually exported from the conversation.
 */
'use strict';

const fs = require('fs');
const path = require('path');

function loadTrace(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
  return lines.map((line, i) => {
    try { return JSON.parse(line); }
    catch { return { _parseError: true, _line: i + 1, _raw: line.slice(0, 200) }; }
  });
}

function summarizeTrace(events, label) {
  const toolCalls = events.filter(e => e.type === 'tool_use');
  const toolResults = events.filter(e => e.type === 'tool_result');
  const texts = events.filter(e => e.type === 'text');
  const thinking = events.filter(e => e.type === 'thinking');
  const statuses = events.filter(e => e.type === 'status');
  const errors = events.filter(e => e.type === 'error' || (e.type === 'tool_result' && /error/i.test(e.content || '')));

  // Tool call sequence
  const toolSequence = toolCalls.map(t => t.tool || t.name || 'unknown');

  // Unique tools used
  const uniqueTools = [...new Set(toolSequence)];

  // Timeline
  const maxTs = events.length ? Math.max(...events.map(e => e.ts || 0)) : 0;

  console.log(`\n  ── ${label} ──`);
  console.log(`  Total events    : ${events.length}`);
  console.log(`  Tool calls      : ${toolCalls.length}`);
  console.log(`  Tool results    : ${toolResults.length}`);
  console.log(`  Text chunks     : ${texts.length}`);
  console.log(`  Thinking blocks : ${thinking.length}`);
  console.log(`  Status msgs     : ${statuses.length}`);
  console.log(`  Errors          : ${errors.length}`);
  console.log(`  Duration        : ${(maxTs / 1000).toFixed(1)}s`);
  console.log(`  Unique tools    : ${uniqueTools.join(', ')}`);
  console.log(`  Tool sequence   :`);
  for (let i = 0; i < toolSequence.length; i++) {
    const tc = toolCalls[i];
    const input = (tc.input || '').slice(0, 60);
    console.log(`    ${i + 1}. ${toolSequence[i]}${input ? ` — ${input}` : ''}`);
  }

  return { toolCalls, toolSequence, uniqueTools, maxTs, errors, texts };
}

function compareTraces(khyData, ccData) {
  console.log(`\n  ══ Trajectory Comparison ══\n`);

  // 1. Tool count diff
  const countDiff = khyData.toolCalls.length - ccData.toolCalls.length;
  console.log(`  Tool call count: KHY=${khyData.toolCalls.length}, CC=${ccData.toolCalls.length} (${countDiff > 0 ? '+' : ''}${countDiff})`);

  // 2. Sequence alignment
  const maxLen = Math.max(khyData.toolSequence.length, ccData.toolSequence.length);
  const divergences = [];
  for (let i = 0; i < maxLen; i++) {
    const k = khyData.toolSequence[i] || '—';
    const c = ccData.toolSequence[i] || '—';
    if (k !== c) divergences.push({ step: i + 1, khy: k, cc: c });
  }

  if (divergences.length === 0) {
    console.log(`  Sequence match  : IDENTICAL`);
  } else {
    console.log(`  Divergences     : ${divergences.length}`);
    for (const d of divergences) {
      console.log(`    Step ${d.step}: KHY=${d.khy}  CC=${d.cc}`);
    }
  }

  // 3. Tools used only by one side
  const khyOnly = khyData.uniqueTools.filter(t => !ccData.uniqueTools.includes(t));
  const ccOnly = ccData.uniqueTools.filter(t => !khyData.uniqueTools.includes(t));
  if (khyOnly.length) console.log(`  KHY-only tools  : ${khyOnly.join(', ')}`);
  if (ccOnly.length) console.log(`  CC-only tools   : ${ccOnly.join(', ')}`);

  // 4. Error comparison
  if (khyData.errors.length || ccData.errors.length) {
    console.log(`  Errors          : KHY=${khyData.errors.length}, CC=${ccData.errors.length}`);
  }

  // 5. Duration
  const speedRatio = khyData.maxTs && ccData.maxTs
    ? (khyData.maxTs / ccData.maxTs).toFixed(2)
    : 'N/A';
  console.log(`  Duration ratio  : KHY/CC = ${speedRatio} (${(khyData.maxTs / 1000).toFixed(1)}s / ${(ccData.maxTs / 1000).toFixed(1)}s)`);

  // 6. Issues to correct
  console.log(`\n  ── Issues to Correct ──`);
  const issues = [];

  if (divergences.length > 0) {
    issues.push(`Tool sequence diverges at ${divergences.length} step(s) — KHY may have different system prompt or tool mapping`);
  }
  if (khyData.errors.length > ccData.errors.length) {
    issues.push(`KHY has ${khyData.errors.length - ccData.errors.length} more error(s) than CC — check tool execution`);
  }
  if (countDiff > 2) {
    issues.push(`KHY uses ${countDiff} more tool calls — may indicate inefficient planning or retry loops`);
  }
  if (countDiff < -2) {
    issues.push(`KHY uses ${Math.abs(countDiff)} fewer tool calls — may be skipping necessary steps`);
  }
  if (khyOnly.length) {
    issues.push(`KHY uses tools CC doesn't: ${khyOnly.join(', ')} — check if these are needed or erroneous`);
  }

  if (issues.length === 0) {
    console.log(`  No significant issues detected.`);
  } else {
    for (const issue of issues) {
      console.log(`  ⚠ ${issue}`);
    }
  }
}

// ── Main ──

const args = process.argv.slice(2);
if (args.length === 0) {
  // List available traces
  const traceDir = path.join(__dirname, 'ab-traces');
  if (fs.existsSync(traceDir)) {
    const files = fs.readdirSync(traceDir).filter(f => f.endsWith('.jsonl')).sort();
    if (files.length) {
      console.log('\n  Available traces:');
      for (const f of files) console.log(`    ${f}`);
    } else {
      console.log('  No traces found. Run ab-dual-dev.js first.');
    }
  }
  console.error('\n  Usage: node scripts/ab-compare.js <khy-trace.jsonl> [claude-trace.jsonl]');
  process.exit(1);
}

const file1 = path.resolve(args[0]);
if (!fs.existsSync(file1)) {
  console.error(`File not found: ${file1}`);
  process.exit(1);
}

const trace1 = loadTrace(file1);
const data1 = summarizeTrace(trace1, path.basename(file1));

if (args.length >= 2) {
  const file2 = path.resolve(args[1]);
  if (!fs.existsSync(file2)) {
    console.error(`File not found: ${file2}`);
    process.exit(1);
  }
  const trace2 = loadTrace(file2);
  const data2 = summarizeTrace(trace2, path.basename(file2));
  compareTraces(data1, data2);
} else {
  console.log('\n  (Pass a second trace file to compare)');
}

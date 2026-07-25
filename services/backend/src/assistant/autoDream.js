/**
 * Auto-Dream — 4-phase memory consolidation for KAIROS assistant mode.
 *
 * Triggers automatically when:
 *   1. Time gate: >24h since last consolidation
 *   2. Session gate: ≥5 new log entries since last dream
 *
 * 4 Phases:
 *   Orient    → Survey existing memory directory
 *   Gather    → Collect recent logs and signals
 *   Consolidate → AI synthesizes and compresses memories
 *   Prune     → Remove stale, update index
 *
 * Ported from Claude Code's services/autoDream/autoDream.ts.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { tryAcquireLock, releaseLock, rollbackLock, readLastConsolidatedAt } = require('./consolidationLock');
const { getRecentLogs, getLogFileCount } = require('./dailyLog');

// ── Configuration ──────────────────────────────────────────────────

const MIN_HOURS = 24;
const MIN_SESSIONS = 5;
const SESSION_SCAN_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes between scans

let _lastScanAt = 0;

// ── Lossless Archive ───────────────────────────────────────────────

/**
 * Move a memory file into the lossless archive instead of deleting it.
 *
 * The original content is preserved verbatim under
 * `<memDir>/archive/<timestamp>-<filename>` so a memory the model marks for
 * deletion (e.g. a contradicted fact) can always be recovered. A no-op if the
 * source file does not exist.
 *
 * @param {string} memDir - Memory directory root
 * @param {string} filename - Memory file to archive
 * @returns {string|null} Absolute archive path, or null if nothing was moved
 */
function _archiveMemoryFile(memDir, filename) {
  const filePath = path.join(memDir, filename);
  if (!fs.existsSync(filePath)) return null;
  try {
    const archiveDir = path.join(memDir, 'archive');
    fs.mkdirSync(archiveDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(archiveDir, `${stamp}-${path.basename(filename)}`);
    fs.renameSync(filePath, dest);
    return dest;
  } catch {
    // Fallback: copy then unlink so the content is never lost on a cross-device
    // rename failure. If even the copy fails, leave the original in place.
    try {
      const archiveDir = path.join(memDir, 'archive');
      fs.mkdirSync(archiveDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const dest = path.join(archiveDir, `${stamp}-${path.basename(filename)}`);
      fs.copyFileSync(filePath, dest);
      fs.unlinkSync(filePath);
      return dest;
    } catch {
      return null;
    }
  }
}

// ── Gate Check ─────────────────────────────────────────────────────

/**
 * Check if auto-dream should run.
 * @returns {{ needed: boolean, reason: string }}
 */
function shouldDream() {
  // Feature gate
  try {
    const { isEnabled } = require('../services/featureFlags');
    if (!isEnabled('assistant')) {
      return { needed: false, reason: 'Assistant feature disabled' };
    }
  } catch { /* no feature flags, continue */ }

  // Throttle scans
  const now = Date.now();
  if (now - _lastScanAt < SESSION_SCAN_INTERVAL_MS) {
    return { needed: false, reason: 'Scan throttled' };
  }
  _lastScanAt = now;

  // Time gate
  const lastConsolidated = readLastConsolidatedAt();
  const hoursSince = (now - lastConsolidated) / (1000 * 60 * 60);
  if (hoursSince < MIN_HOURS) {
    return { needed: false, reason: `Only ${hoursSince.toFixed(1)}h since last dream (need ${MIN_HOURS}h)` };
  }

  // Session gate (approximate: count recent log entries)
  const recentLogs = getRecentLogs(7);
  const recentCount = recentLogs.length;
  if (recentCount < MIN_SESSIONS) {
    return { needed: false, reason: `Only ${recentCount} recent sessions (need ${MIN_SESSIONS})` };
  }

  return { needed: true, reason: `${hoursSince.toFixed(0)}h elapsed, ${recentCount} sessions` };
}

// ── Dream Execution ────────────────────────────────────────────────

/**
 * Run the 4-phase dream consolidation.
 * @param {object} aiModule - The AI module with chat() function
 * @returns {Promise<{success: boolean, phases: string[], filesCreated: string[], error?: string}>}
 */
async function runDream(aiModule) {
  const { getDataDir } = require('../utils/dataHome');
  const memDir = getDataDir('memory');
  const phases = [];
  const filesCreated = [];

  // Acquire lock
  const lock = tryAcquireLock();
  if (!lock.acquired) {
    return { success: false, phases: [], filesCreated: [], error: `Blocked by PID ${lock.blockedBy}` };
  }

  try {
    // Phase 1: Orient — survey existing memory
    phases.push('orient');
    const existingFiles = [];
    try {
      const files = fs.readdirSync(memDir).filter(f => f.endsWith('.md') && f !== 'MEMORY.md');
      for (const f of files) {
        const content = fs.readFileSync(path.join(memDir, f), 'utf-8');
        existingFiles.push({ name: f, preview: content.slice(0, 200) });
      }
    } catch { /* empty memory dir */ }

    let memoryIndex = '';
    const indexPath = path.join(memDir, 'MEMORY.md');
    try { memoryIndex = fs.readFileSync(indexPath, 'utf-8'); } catch { /* no index */ }

    // Phase 2: Gather — collect recent signals
    phases.push('gather');
    const recentLogs = getRecentLogs(7);
    const logSummary = recentLogs.map(l => `### ${l.date}\n${l.content.slice(0, 500)}`).join('\n\n');

    // Phase 3: Consolidate — AI synthesis
    phases.push('consolidate');
    const consolidatePrompt = `You are a memory consolidation agent performing automatic dream consolidation.

## Current Memory Index
${memoryIndex || '(empty)'}

## Existing Memory Files (${existingFiles.length})
${existingFiles.map(f => `- ${f.name}: ${f.preview}`).join('\n')}

## Recent Activity Logs
${logSummary || '(no recent logs)'}

## Instructions

1. Identify key themes, decisions, and patterns from recent activity
2. Create or update memory files to capture important persistent knowledge
3. Merge related memories to reduce redundancy
4. Convert relative dates to absolute dates
5. Delete contradicted facts

Output a JSON object with:
- "memories": [{ "filename": "topic.md", "content": "markdown content", "action": "create|update|delete" }]
- "indexUpdates": "new MEMORY.md content (keep under 200 lines)"
- "summary": "brief description of what was consolidated"

Respond ONLY with valid JSON.`;

    let result;
    try {
      if (aiModule && aiModule.chat) {
        const resp = await aiModule.chat(consolidatePrompt, { _isFollowUp: true, effort: 'high' });
        result = resp.reply || resp.text || '';
      } else {
        // No AI available — generate a simple summary
        const summary = `## Auto-Dream Summary (${new Date().toISOString().split('T')[0]})\n\n${recentLogs.length} days of activity reviewed.\n`;
        const summaryFile = `dream_${Date.now()}.md`;
        fs.writeFileSync(path.join(memDir, summaryFile), summary, 'utf-8');
        filesCreated.push(summaryFile);
        phases.push('prune');
        releaseLock();
        return { success: true, phases, filesCreated };
      }
    } catch (err) {
      phases.push('error');
      rollbackLock(lock.priorMtime);
      return { success: false, phases, filesCreated: [], error: `AI consolidation failed: ${err.message}` };
    }

    // Parse AI response and apply changes
    try {
      // Extract JSON from response (may be wrapped in ```json blocks)
      const jsonMatch = result.match(/```json\s*([\s\S]*?)```/) || result.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]);

        // Apply memory changes
        if (parsed.memories && Array.isArray(parsed.memories)) {
          for (const mem of parsed.memories) {
            const filePath = path.join(memDir, mem.filename);
            if (mem.action === 'delete') {
              // Lossless forget: move the file into the archive rather than
              // physically deleting it, so a consolidated/contradicted memory
              // can always be recovered.
              _archiveMemoryFile(memDir, mem.filename);
            } else {
              fs.writeFileSync(filePath, mem.content, 'utf-8');
              filesCreated.push(mem.filename);
            }
          }
        }

        // Update index
        if (parsed.indexUpdates) {
          fs.writeFileSync(indexPath, parsed.indexUpdates, 'utf-8');
        }
      }
    } catch { /* JSON parse failed, skip file changes */ }

    // Phase 4: Prune — cleanup
    phases.push('prune');

    releaseLock();
    return { success: true, phases, filesCreated };

  } catch (err) {
    rollbackLock(lock.priorMtime);
    return { success: false, phases, filesCreated: [], error: err.message };
  }
}

module.exports = { shouldDream, runDream };

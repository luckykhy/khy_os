/**
 * UltraPlan Service — long-running deep planning with AI.
 *
 * Sends complex tasks to AI for up to 30 minutes of independent research
 * and planning. Results stored as structured plans in ~/.khyquant/ultraplans/.
 *
 * Ported concept from Claude Code's ultraplan system (adapted for local execution).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

function _plansDir() {
  const { getDataDir } = require('../utils/dataHome');
  return getDataDir('ultraplans');
}

// ── Session Management ─────────────────────────────────────────────

const _activeSessions = new Map(); // id → session state

/**
 * Start a deep planning session.
 * @param {string} prompt - The planning request
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs] - Timeout (default: 30 min)
 * @param {string} [opts.model] - Model to use
 * @returns {Promise<UltraplanResult>}
 */
async function startSession(prompt, opts = {}) {
  const id = 'up-' + crypto.randomBytes(4).toString('hex');
  const timeoutMs = opts.timeoutMs || MAX_TIMEOUT_MS;

  const session = {
    id,
    prompt,
    status: 'running',
    startedAt: Date.now(),
    completedAt: null,
    result: null,
    error: null,
  };
  _activeSessions.set(id, session);

  // Save initial state
  _saveSession(session);

  // Execute planning in background
  _executePlan(session, timeoutMs, opts).catch(err => {
    session.status = 'failed';
    session.error = err.message;
    session.completedAt = Date.now();
    _saveSession(session);
  });

  return session;
}

async function _executePlan(session, timeoutMs, opts) {
  const planningPrompt = `# Deep Planning Session

You are a deep planning agent with up to 30 minutes to research and create a comprehensive implementation plan.

## Task
${session.prompt}

## Instructions

Take your time to think thoroughly. Consider:
1. **Problem Analysis** — What exactly needs to be done? What are the constraints?
2. **Architecture** — What's the best approach? What patterns should be used?
3. **Implementation Steps** — Detailed, ordered steps with file paths and code snippets
4. **Risk Assessment** — What could go wrong? How to mitigate?
5. **Testing Strategy** — How to verify the implementation is correct?
6. **Timeline Estimate** — Rough effort estimation for each step

## Output Format

Structure your response as:

### Title
[One-line summary]

### Problem Analysis
[Detailed analysis]

### Proposed Architecture
[Approach description]

### Implementation Steps
1. [Step with file paths and details]
2. ...

### Risk Assessment
- [Risk and mitigation]

### Testing Strategy
- [Test approach]

### Notes
[Any additional considerations]`;

  try {
    let reply;

    // Try AI gateway
    try {
      const gateway = require('./gateway/aiGateway');
      const result = await Promise.race([
        gateway.generate(planningPrompt, { model: opts.model }),
        _timeout(timeoutMs),
      ]);
      reply = typeof result === 'string' ? result : (result.text || result.reply || JSON.stringify(result));
    } catch {
      // Fallback: the cli/ai chat core, consumed via the inversion port so this
      // service never reaches up into the CLI layer. Null when the CLI was not
      // loaded (e.g. headless) — treated as "AI not available", same as a throw.
      try {
        const { getAiChat } = require('./aiChatPort');
        const chat = getAiChat();
        if (typeof chat !== 'function') {
          throw new Error('chat provider not registered');
        }
        const result = await Promise.race([
          chat(planningPrompt, { _isFollowUp: true, effort: 'max' }),
          _timeout(timeoutMs),
        ]);
        reply = result.reply || result.text || '';
      } catch (err) {
        throw new Error(`AI not available: ${err.message}`);
      }
    }

    // Parse structured plan
    session.result = _parsePlan(reply);
    session.status = 'completed';
    session.completedAt = Date.now();
    _saveSession(session);

  } catch (err) {
    session.status = 'failed';
    session.error = err.message;
    session.completedAt = Date.now();
    _saveSession(session);
  } finally {
    _activeSessions.delete(session.id);
  }
}

function _timeout(ms) {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Planning timeout')), ms)
  );
}

/**
 * Parse AI response into structured plan.
 * @param {string} raw
 * @returns {object}
 */
function _parsePlan(raw) {
  const sections = {};
  let currentSection = 'content';
  const lines = raw.split('\n');

  for (const line of lines) {
    const headerMatch = line.match(/^###?\s+(.+)/);
    if (headerMatch) {
      currentSection = headerMatch[1].trim().toLowerCase().replace(/\s+/g, '_');
      sections[currentSection] = '';
    } else {
      sections[currentSection] = (sections[currentSection] || '') + line + '\n';
    }
  }

  return {
    raw,
    title: (sections.title || '').trim(),
    analysis: (sections.problem_analysis || '').trim(),
    architecture: (sections.proposed_architecture || '').trim(),
    steps: (sections.implementation_steps || '').trim(),
    risks: (sections.risk_assessment || '').trim(),
    testing: (sections.testing_strategy || '').trim(),
    notes: (sections.notes || '').trim(),
  };
}

// ── Persistence ────────────────────────────────────────────────────

function _saveSession(session) {
  const filePath = path.join(_plansDir(), `${session.id}.json`);
  const serializable = { ...session };
  fs.writeFileSync(filePath, JSON.stringify(serializable, null, 2), 'utf-8');
}

/**
 * Get a planning session by ID.
 * @param {string} id
 * @returns {object|null}
 */
function getSession(id) {
  // Check active sessions first
  const active = _activeSessions.get(id);
  if (active) return active;

  // Check disk
  try {
    const filePath = path.join(_plansDir(), `${id}.json`);
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * List all planning sessions (active + completed).
 * @returns {object[]}
 */
function listSessions() {
  const sessions = [];

  // Active sessions
  for (const session of _activeSessions.values()) {
    sessions.push(session);
  }

  // Disk sessions
  try {
    const dir = _plansDir();
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const session = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
        if (!sessions.find(s => s.id === session.id)) {
          sessions.push(session);
        }
      } catch { /* skip corrupt */ }
    }
  } catch { /* empty dir */ }

  return sessions.sort((a, b) => b.startedAt - a.startedAt);
}

module.exports = { startSession, getSession, listSessions };

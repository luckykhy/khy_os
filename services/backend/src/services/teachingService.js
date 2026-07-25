'use strict';

/**
 * teachingService.js — capture a teaching statement onto the active companion.
 *
 * 借鉴分析 #5 (teach-vs-delegate). When intentGate.detectTeaching flags a user
 * message as teaching (a preference / red line / persona trait rather than a
 * task), this service appends it to the active companion's AgentFS asset and
 * lets git snapshot it. No active companion → no-op with a reason (the caller
 * surfaces a hint); we never auto-create a companion.
 *
 * Pure file operations via agentFsService; no new dependencies.
 */

const TARGET_ASSET = Object.freeze({
  persona: 'persona.md',
  principles: 'principles.md',
  memory: require('path').join('memory', 'MEMORY.md'),
});

/** Render the appended line for a given target. */
function _formatLine(target, content, stamp) {
  const text = String(content || '').trim();
  if (target === 'principles') return `- ${text}`;
  if (target === 'persona') return text;
  // memory: timestamped pointer line
  return `- [${stamp}] ${text}`;
}

/**
 * Capture a teaching statement onto the active companion.
 * @param {object} opts
 * @param {string} opts.text - raw user message (already classified)
 * @param {{target:'persona'|'principles'|'memory', content?:string}} opts.detection
 * @param {string} [opts.companionId] - override active companion (mainly for tests)
 * @param {string} [opts.stamp] - ISO timestamp override (mainly for tests)
 * @returns {{captured:boolean, reason?:string, companionId?:string, target?:string, asset?:string, line?:string}}
 */
function captureTeaching(opts = {}) {
  const detection = opts.detection || {};
  const target = detection.target;
  if (!target || !TARGET_ASSET[target]) {
    return { captured: false, reason: 'no-target' };
  }

  let svc;
  try { svc = require('./agentFs/agentFsService'); }
  catch { return { captured: false, reason: 'agentfs-unavailable' }; }

  const companionId = opts.companionId || svc.getActiveAgentId();
  if (!companionId) return { captured: false, reason: 'no-active-companion' };
  if (!svc.getAgent(companionId)) return { captured: false, reason: 'companion-missing' };

  const content = detection.content || opts.text || '';
  const stamp = (opts.stamp || new Date().toISOString()).slice(0, 10);
  const line = _formatLine(target, content, stamp);
  const rel = TARGET_ASSET[target];

  const existing = svc.readAsset(companionId, rel) || '';
  const base = existing.replace(/\s*$/, '');
  const next = `${base}\n${line}\n`;

  svc.writeAsset(companionId, rel, next, { message: `teach(${target}): ${String(content).slice(0, 60)}` });

  return { captured: true, companionId, target, asset: rel, line };
}

module.exports = { captureTeaching, TARGET_ASSET };

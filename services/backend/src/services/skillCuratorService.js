'use strict';

/**
 * Skill Curator Service — usage tracking + lifecycle management.
 *
 * Inspired by Hermes Agent's Curator pattern:
 *   - Tracks use_count, last_activity_at per skill
 *   - Lifecycle: active → stale (>N days idle) → archived (>M days stale)
 *   - built-in skills are exempt from lifecycle transitions
 *   - Pinned skills are exempt from automatic transitions
 *   - Skills are NEVER deleted, only archived (moved to .archive/)
 *
 * Data file: ~/.khyquant/growth/skill_usage.json
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const GROWTH_DIR = path.join(os.homedir(), '.khyquant', 'growth');
const USAGE_FILE = path.join(GROWTH_DIR, 'skill_usage.json');
const USER_SKILLS_DIR = path.join(os.homedir(), '.khy', 'skills');
const ARCHIVE_DIR = path.join(USER_SKILLS_DIR, '.archive');

const DEFAULT_CONFIG = {
  staleAfterDays: 30,
  archiveAfterDays: 60,
};

// ── Data persistence ───────────────────────────────────────────────────────

function _ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function _loadData() {
  try {
    if (fs.existsSync(USAGE_FILE)) {
      return JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
    }
  } catch { /* corrupt file — start fresh */ }
  return { version: 1, skills: {}, config: { ...DEFAULT_CONFIG } };
}

function _saveData(data) {
  _ensureDir(GROWTH_DIR);
  fs.writeFileSync(USAGE_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Record a skill usage event.
 * Built-in skills are tracked but exempt from lifecycle transitions.
 * Stale skills are automatically restored to active on use.
 *
 * @param {string} name - Skill name
 * @param {string} source - 'built-in' | 'user' | 'project'
 */
function recordUsage(name, source) {
  if (!name) return;

  const data = _loadData();
  const now = new Date().toISOString();

  if (!data.skills[name]) {
    data.skills[name] = {
      use_count: 0,
      last_activity_at: now,
      first_used_at: now,
      state: 'active',
      pinned: false,
      archived_at: null,
      source: source || 'unknown',
    };
  }

  const entry = data.skills[name];
  entry.use_count += 1;
  entry.last_activity_at = now;
  if (source) entry.source = source;

  // Auto-restore stale→active on use
  if (entry.state === 'stale') {
    entry.state = 'active';
  }

  _saveData(data);
}

/**
 * Run the curator scan: transition skills through lifecycle states.
 *   active → stale (idle > staleAfterDays)
 *   stale  → archived (idle > archiveAfterDays)
 *
 * Built-in and pinned skills are exempt.
 *
 * @param {Array<{name:string, source:string, dir:string}>} allSkills - All discovered skills
 * @returns {{ transitioned: Array<{name:string, from:string, to:string}>, summary: string }}
 */
function runCurator(allSkills = []) {
  const data = _loadData();
  const config = { ...DEFAULT_CONFIG, ...(data.config || {}) };
  const now = Date.now();
  const staleCutoff = now - config.staleAfterDays * 86_400_000;
  const archiveCutoff = now - config.archiveAfterDays * 86_400_000;

  const transitioned = [];

  for (const skill of allSkills) {
    const entry = data.skills[skill.name];
    if (!entry) continue;

    // Built-in and pinned are exempt
    if (entry.source === 'built-in' || entry.pinned) continue;

    const lastActivity = new Date(entry.last_activity_at).getTime();

    if (entry.state === 'active' && lastActivity < staleCutoff) {
      entry.state = 'stale';
      transitioned.push({ name: skill.name, from: 'active', to: 'stale' });
    } else if (entry.state === 'stale' && lastActivity < archiveCutoff) {
      entry.state = 'archived';
      entry.archived_at = new Date().toISOString();
      transitioned.push({ name: skill.name, from: 'stale', to: 'archived' });

      // Move to .archive/ directory
      _archiveSkillDir(skill);
    }
  }

  _saveData(data);

  const summary = transitioned.length === 0
    ? 'No lifecycle transitions needed.'
    : `${transitioned.length} skill(s) transitioned: ${transitioned.map(t => `${t.name} (${t.from}→${t.to})`).join(', ')}`;

  return { transitioned, summary };
}

/**
 * Pin a skill — exempt from automatic lifecycle transitions.
 * @param {string} name
 * @returns {boolean}
 */
function pinSkill(name) {
  const data = _loadData();
  if (!data.skills[name]) return false;
  data.skills[name].pinned = true;
  _saveData(data);
  return true;
}

/**
 * Unpin a skill — re-enable automatic lifecycle transitions.
 * @param {string} name
 * @returns {boolean}
 */
function unpinSkill(name) {
  const data = _loadData();
  if (!data.skills[name]) return false;
  data.skills[name].pinned = false;
  _saveData(data);
  return true;
}

/**
 * Manually archive a skill: move its directory to .archive/.
 * @param {{ name: string, dir: string }} skill
 * @returns {boolean}
 */
function archiveSkill(skill) {
  if (!skill || !skill.dir) return false;

  const data = _loadData();
  if (data.skills[skill.name]) {
    data.skills[skill.name].state = 'archived';
    data.skills[skill.name].archived_at = new Date().toISOString();
    _saveData(data);
  }

  return _archiveSkillDir(skill);
}

/**
 * Restore a skill from .archive/ back to the user skills directory.
 * @param {string} name
 * @returns {boolean}
 */
function restoreSkill(name) {
  const archivePath = path.join(ARCHIVE_DIR, name);
  const restorePath = path.join(USER_SKILLS_DIR, name);

  if (!fs.existsSync(archivePath)) return false;

  _moveDir(archivePath, restorePath);

  const data = _loadData();
  if (data.skills[name]) {
    data.skills[name].state = 'active';
    data.skills[name].archived_at = null;
    data.skills[name].last_activity_at = new Date().toISOString();
    _saveData(data);
  }

  return true;
}

/**
 * Get curator status summary.
 * @param {Array<{name:string, source:string}>} allSkills
 * @returns {{ active: number, stale: number, archived: number, pinned: string[], staleList: string[] }}
 */
function getCuratorStatus(allSkills = []) {
  const data = _loadData();
  let active = 0, stale = 0, archived = 0;
  const pinned = [];
  const staleList = [];

  for (const skill of allSkills) {
    const entry = data.skills[skill.name];
    if (!entry) {
      active++; // untracked = active by default
      continue;
    }
    switch (entry.state) {
      case 'active': active++; break;
      case 'stale': stale++; staleList.push(skill.name); break;
      case 'archived': archived++; break;
      default: active++;
    }
    if (entry.pinned) pinned.push(skill.name);
  }

  return { active, stale, archived, pinned, staleList };
}

/**
 * Get usage record for a single skill.
 * @param {string} name
 * @returns {object|null}
 */
function getSkillUsage(name) {
  const data = _loadData();
  return data.skills[name] || null;
}

// ── Internal helpers ───────────────────────────────────────────────────────

function _archiveSkillDir(skill) {
  if (!skill.dir || !fs.existsSync(skill.dir)) return false;

  // Only archive from user skills directory
  if (!skill.dir.startsWith(USER_SKILLS_DIR)) return false;
  if (skill.dir.includes('.archive')) return false;

  _ensureDir(ARCHIVE_DIR);
  const dest = path.join(ARCHIVE_DIR, skill.name || path.basename(skill.dir));
  _moveDir(skill.dir, dest);
  return true;
}

function _moveDir(src, dest) {
  try {
    fs.renameSync(src, dest);
  } catch {
    // Cross-device fallback: copy + remove
    fs.cpSync(src, dest, { recursive: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
}

// ── Test helpers ───────────────────────────────────────────────────────────

/** @internal Reset usage data — for testing only */
function _resetForTest() {
  if (fs.existsSync(USAGE_FILE)) {
    fs.unlinkSync(USAGE_FILE);
  }
}

module.exports = {
  recordUsage,
  runCurator,
  pinSkill,
  unpinSkill,
  archiveSkill,
  restoreSkill,
  getCuratorStatus,
  getSkillUsage,
  _resetForTest,
  USAGE_FILE,
  ARCHIVE_DIR,
  DEFAULT_CONFIG,
};

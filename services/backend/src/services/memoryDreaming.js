'use strict';

/**
 * memoryDreaming.js — Three-phase memory consolidation engine.
 *
 * Ported from OpenClaw's dreaming.ts.
 * Inspired by sleep-cycle memory consolidation:
 *
 *   Light (6h) → Fast dedup of recent memories, 0.9 similarity threshold
 *   Deep  (daily 3am) → Analytical synthesis with health scoring, recovery at <0.35
 *   REM   (weekly Sun 5am) → Pattern extraction across consolidated memories
 *
 * Each phase has independent scheduling, budget, and source configuration.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const lifecycle = require('./memoryLifecycle');

// ── Constants ──────────────────────────────────────────────────────

const LIGHT_INTERVAL_MS = 6 * 3600_000;         // 6 hours
const LIGHT_LOOKBACK_DAYS = 2;
const LIGHT_LIMIT = 100;
const LIGHT_DEDUPE_SIMILARITY = 0.9;

const DEEP_LIMIT = 10;
const DEEP_MIN_SCORE = 0.8;
const DEEP_MIN_RECALL_COUNT = 3;
const DEEP_MIN_UNIQUE_QUERIES = 3;
const DEEP_RECENCY_HALF_LIFE_DAYS = 14;
const DEEP_MAX_AGE_DAYS = 30;

const DEEP_RECOVERY_TRIGGER_BELOW_HEALTH = 0.35;
const DEEP_RECOVERY_LOOKBACK_DAYS = 30;
const DEEP_RECOVERY_MAX_CANDIDATES = 20;
const DEEP_RECOVERY_MIN_CONFIDENCE = 0.9;
const DEEP_RECOVERY_AUTO_WRITE_MIN_CONFIDENCE = 0.97;

const REM_LOOKBACK_DAYS = 7;
const REM_LIMIT = 10;
const REM_MIN_PATTERN_STRENGTH = 0.75;

// ── Memory Entry ───────────────────────────────────────────────────

/**
 * @typedef {object} MemoryEntry
 * @property {string} id
 * @property {string} content
 * @property {string} source - 'daily' | 'session' | 'recall' | 'deep' | 'pattern'
 * @property {number} createdAt - Unix ms
 * @property {number} score - Health score [0,1]
 * @property {number} recallCount - Times recalled
 * @property {string[]} queries - Unique queries that accessed this memory
 * @property {string} [consolidatedFrom] - Source memory IDs
 * @property {string} [phase] - Which phase created it
 * @property {string} [type] - Memory type (milestone|decision|commitment|lesson|preference|fact)
 * @property {string} [lifecycle] - Lifecycle stage (active|recent|archived|dream|compressed|pruned)
 */

class MemoryDreaming {
  /**
   * @param {object} opts
   * @param {function} [opts.gateway] - AI gateway for summarization
   * @param {string} [opts.storePath] - Path to memory store JSON
   * @param {string} [opts.archivePath] - Path to lossless archive store JSON.
   *   Defaults to `<storePath dir>/dream-archive.json` when storePath is set.
   * @param {function} [opts.onPhaseComplete] - (phase, stats) => void
   * @param {object} [opts.logger]
   */
  constructor(opts = {}) {
    this._gateway = opts.gateway || null;
    this._storePath = opts.storePath || null;
    this._archivePath = opts.archivePath
      || (this._storePath ? path.join(path.dirname(this._storePath), 'dream-archive.json') : null);
    this._onPhaseComplete = opts.onPhaseComplete || null;
    this._logger = opts.logger || console;
    this._memories = [];
    this._timers = {};
    this._lastPhaseRun = { light: 0, deep: 0, rem: 0 };
  }

  /**
   * Load memories from disk.
   */
  load() {
    if (!this._storePath) return;
    try {
      if (fs.existsSync(this._storePath)) {
        this._memories = JSON.parse(fs.readFileSync(this._storePath, 'utf-8'));
        this._backfillLifecycle();
      }
    } catch (err) {
      this._logger.warn('Failed to load memory store:', err.message);
      this._memories = [];
    }
  }

  /**
   * Backfill the `lifecycle` field on legacy entries that predate it, derived
   * from age. Idempotent — entries that already have a stage are left alone.
   */
  _backfillLifecycle() {
    const now = Date.now();
    for (const m of this._memories) {
      if (!lifecycle.isLifecycleStage(m.lifecycle)) {
        const ageDays = (now - (m.createdAt || now)) / 86400_000;
        m.lifecycle = lifecycle.stageFromAge(ageDays);
      }
    }
  }

  /**
   * Append an entry to the lossless archive store. The original content is
   * preserved verbatim so a retired memory can always be revived.
   * @param {MemoryEntry} entry
   * @param {string} stage - terminal stage recorded (pruned|compressed)
   */
  _archiveMemory(entry, stage) {
    if (!this._archivePath) return;
    try {
      const dir = path.dirname(this._archivePath);
      fs.mkdirSync(dir, { recursive: true });
      let archive = [];
      if (fs.existsSync(this._archivePath)) {
        try { archive = JSON.parse(fs.readFileSync(this._archivePath, 'utf-8')) || []; } catch { archive = []; }
      }
      archive.push({ ...entry, lifecycle: stage, archivedAt: Date.now() });
      fs.writeFileSync(this._archivePath, JSON.stringify(archive, null, 2));
    } catch (err) {
      this._logger.warn('Failed to archive memory:', err.message);
    }
  }

  /**
   * Losslessly retire a memory: mark its lifecycle stage, copy it into the
   * archive store, then remove it from the active working set. Never physically
   * destroys the content.
   * @param {MemoryEntry} entry
   * @param {string} stage - pruned (default) or compressed
   * @returns {boolean} whether the entry was removed from the active set
   */
  _retireMemory(entry, stage = lifecycle.LIFECYCLE.PRUNED) {
    if (!entry) return false;
    const from = lifecycle.isLifecycleStage(entry.lifecycle) ? entry.lifecycle : lifecycle.LIFECYCLE.ACTIVE;
    const target = lifecycle.canTransition(from, stage) ? stage : lifecycle.LIFECYCLE.PRUNED;
    entry.lifecycle = target;
    this._archiveMemory(entry, target);
    const idx = this._memories.indexOf(entry);
    if (idx !== -1) {
      this._memories.splice(idx, 1);
      return true;
    }
    return false;
  }

  /**
   * Persist memories to disk.
   */
  save() {
    if (!this._storePath) return;
    try {
      const dir = path.dirname(this._storePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this._storePath, JSON.stringify(this._memories, null, 2));
    } catch (err) {
      this._logger.warn('Failed to save memory store:', err.message);
    }
  }

  /**
   * Add a raw memory entry.
   */
  addMemory(content, source = 'session', metadata = {}) {
    const entry = {
      id: crypto.randomBytes(8).toString('hex'),
      content,
      source,
      createdAt: Date.now(),
      score: 1.0,
      recallCount: 0,
      queries: [],
      phase: null,
      lifecycle: lifecycle.LIFECYCLE.ACTIVE,
      ...metadata,
    };
    this._memories.push(entry);
    return entry;
  }

  /**
   * Return a shallow-cloned snapshot of the current dream memories.
   *
   * Used by the assistant idle-tick promoter (memoryEngine.dreamPromote) to read
   * candidate insights WITHOUT re-parsing the store file or racing `save()`.
   * Each entry is a shallow copy so callers cannot mutate the live store.
   *
   * @returns {Array<object>}
   */
  snapshotMemories() {
    return this._memories.map((m) => ({ ...m }));
  }

  /**
   * Record a recall event (memory was accessed by a query).
   */
  recordRecall(memoryId, query) {
    const mem = this._memories.find(m => m.id === memoryId);
    if (!mem) return;
    mem.recallCount++;
    if (query && !mem.queries.includes(query)) {
      mem.queries.push(query);
    }
  }

  // ── Phase 1: Light Dreaming ─────────────────────────────────────

  /**
   * Light phase: fast deduplication of recent memories.
   * Merges similar entries within the lookback window.
   *
   * @returns {{ merged: number, kept: number, dropped: number }}
   */
  async runLightPhase() {
    const now = Date.now();
    const cutoff = now - LIGHT_LOOKBACK_DAYS * 86400_000;

    // Collect recent memories from light sources
    const recent = this._memories
      .filter(m => m.createdAt >= cutoff && ['daily', 'session', 'recall'].includes(m.source))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, LIGHT_LIMIT);

    if (recent.length < 2) {
      this._lastPhaseRun.light = now;
      return { merged: 0, kept: recent.length, dropped: 0 };
    }

    // Compute similarity matrix and cluster duplicates
    const clusters = this._clusterBySimilarity(recent, LIGHT_DEDUPE_SIMILARITY);
    let merged = 0;
    let dropped = 0;

    for (const cluster of clusters) {
      if (cluster.length <= 1) continue;

      // Keep the entry with highest score/recallCount
      cluster.sort((a, b) => (b.score + b.recallCount) - (a.score + a.recallCount));
      const keeper = cluster[0];

      // Consolidate metadata from duplicates
      for (let i = 1; i < cluster.length; i++) {
        const dup = cluster[i];
        keeper.recallCount += dup.recallCount;
        for (const q of dup.queries) {
          if (!keeper.queries.includes(q)) keeper.queries.push(q);
        }
        // Losslessly retire the duplicate: archived as `compressed` (folded into
        // keeper), removed from the active set but never physically destroyed.
        dup.consolidatedInto = keeper.id;
        if (this._retireMemory(dup, lifecycle.LIFECYCLE.COMPRESSED)) {
          dropped++;
        }
      }
      merged++;
    }

    this._lastPhaseRun.light = now;
    this.save();

    const stats = { merged, kept: recent.length - dropped, dropped };
    if (this._onPhaseComplete) this._onPhaseComplete('light', stats);
    return stats;
  }

  // ── Phase 2: Deep Dreaming ──────────────────────────────────────

  /**
   * Deep phase: analytical synthesis of important memories.
   * Uses AI to consolidate high-value memories into deeper insights.
   *
   * @returns {{ synthesized: number, recovered: number, health: number }}
   */
  async runDeepPhase() {
    const now = Date.now();

    // Calculate overall memory health
    const health = this._calculateHealth();

    // Check if recovery is needed
    let recovered = 0;
    if (health < DEEP_RECOVERY_TRIGGER_BELOW_HEALTH) {
      recovered = await this._runRecovery(now);
    }

    // Select candidates for deep synthesis
    const candidates = this._memories
      .filter(m => {
        const ageDays = (now - m.createdAt) / 86400_000;
        if (ageDays > DEEP_MAX_AGE_DAYS) return false;
        if (m.phase === 'deep' || m.phase === 'pattern') return false;

        // Health-weighted score with recency decay
        const recencyFactor = Math.pow(0.5, ageDays / DEEP_RECENCY_HALF_LIFE_DAYS);
        const adjustedScore = m.score * recencyFactor;

        return adjustedScore >= DEEP_MIN_SCORE
          && m.recallCount >= DEEP_MIN_RECALL_COUNT
          && m.queries.length >= DEEP_MIN_UNIQUE_QUERIES;
      })
      .sort((a, b) =>
        (b.score * b.recallCount * lifecycle.typeWeight(b.type))
        - (a.score * a.recallCount * lifecycle.typeWeight(a.type)))
      .slice(0, DEEP_LIMIT);

    let synthesized = 0;

    if (candidates.length > 0 && this._gateway) {
      // AI synthesis: consolidate related memories into deeper insights
      const prompt = this._buildDeepSynthesisPrompt(candidates);
      try {
        const result = await this._gateway.generate(prompt, {
          maxTokens: 1000,
          temperature: 0.2,
        });

        if (result.success && result.content) {
          const sourceIds = candidates.map(c => c.id).join(',');
          this.addMemory(result.content, 'deep', {
            phase: 'deep',
            consolidatedFrom: sourceIds,
            score: 0.95,
          });
          synthesized = 1;

          // Decay source memory scores (they've been consolidated)
          for (const c of candidates) {
            c.score *= 0.7;
          }
        }
      } catch (err) {
        this._logger.warn('Deep dreaming AI synthesis failed:', err.message);
      }
    }

    this._lastPhaseRun.deep = now;
    this.save();

    const stats = { synthesized, recovered, health: this._calculateHealth() };
    if (this._onPhaseComplete) this._onPhaseComplete('deep', stats);
    return stats;
  }

  // ── Phase 3: REM Dreaming ──────────────────────────────────────

  /**
   * REM phase: cross-memory pattern extraction.
   * Finds recurring themes and generates meta-insights.
   *
   * @returns {{ patterns: number, strength: number }}
   */
  async runRemPhase() {
    const now = Date.now();
    const cutoff = now - REM_LOOKBACK_DAYS * 86400_000;

    // Collect from deep and daily sources
    const sources = this._memories
      .filter(m => m.createdAt >= cutoff && ['deep', 'daily', 'session'].includes(m.source))
      .sort((a, b) => b.score - a.score)
      .slice(0, REM_LIMIT * 3); // Wider search for pattern finding

    if (sources.length < 3) {
      this._lastPhaseRun.rem = now;
      return { patterns: 0, strength: 0 };
    }

    let patternsFound = 0;
    let totalStrength = 0;

    if (this._gateway) {
      const prompt = this._buildPatternExtractionPrompt(sources);
      try {
        const result = await this._gateway.generate(prompt, {
          maxTokens: 1200,
          temperature: 0.3,
        });

        if (result.success && result.content) {
          // Parse patterns from AI response
          const patterns = this._parsePatterns(result.content);

          for (const pattern of patterns) {
            if (pattern.strength >= REM_MIN_PATTERN_STRENGTH) {
              this.addMemory(pattern.description, 'pattern', {
                phase: 'pattern',
                score: pattern.strength,
                consolidatedFrom: sources.map(s => s.id).join(','),
              });
              patternsFound++;
              totalStrength += pattern.strength;
            }
          }
        }
      } catch (err) {
        this._logger.warn('REM dreaming pattern extraction failed:', err.message);
      }
    }

    this._lastPhaseRun.rem = now;
    this.save();

    const stats = {
      patterns: patternsFound,
      strength: patternsFound > 0 ? totalStrength / patternsFound : 0,
    };
    if (this._onPhaseComplete) this._onPhaseComplete('rem', stats);
    return stats;
  }

  // ── Scheduling ─────────────────────────────────────────────────

  /**
   * Start automatic phase scheduling.
   */
  startScheduler() {
    // Light: every 6 hours
    this._timers.light = setInterval(() => {
      this.runLightPhase().catch(err =>
        this._logger.warn('Light dreaming failed:', err.message)
      );
    }, LIGHT_INTERVAL_MS);
    if (this._timers.light.unref) this._timers.light.unref();

    // Deep: daily at 3am (check every hour)
    this._timers.deep = setInterval(() => {
      const hour = new Date().getHours();
      if (hour === 3 && Date.now() - this._lastPhaseRun.deep > 20 * 3600_000) {
        this.runDeepPhase().catch(err =>
          this._logger.warn('Deep dreaming failed:', err.message)
        );
      }
    }, 3600_000);
    if (this._timers.deep.unref) this._timers.deep.unref();

    // REM: weekly Sunday at 5am (check every hour)
    this._timers.rem = setInterval(() => {
      const now = new Date();
      if (now.getDay() === 0 && now.getHours() === 5
          && Date.now() - this._lastPhaseRun.rem > 6 * 86400_000) {
        this.runRemPhase().catch(err =>
          this._logger.warn('REM dreaming failed:', err.message)
        );
      }
    }, 3600_000);
    if (this._timers.rem.unref) this._timers.rem.unref();
  }

  /**
   * Stop scheduler.
   */
  stopScheduler() {
    for (const key of Object.keys(this._timers)) {
      clearInterval(this._timers[key]);
    }
    this._timers = {};
  }

  // ── Internal Algorithms ────────────────────────────────────────

  /**
   * Cluster memories by content similarity using simple n-gram Jaccard.
   * @param {MemoryEntry[]} entries
   * @param {number} threshold - Similarity threshold [0,1]
   * @returns {MemoryEntry[][]} clusters
   */
  _clusterBySimilarity(entries, threshold) {
    const ngrams = entries.map(e => this._extractNgrams(e.content, 3));
    const clusters = [];
    const assigned = new Set();

    for (let i = 0; i < entries.length; i++) {
      if (assigned.has(i)) continue;
      const cluster = [entries[i]];
      assigned.add(i);

      for (let j = i + 1; j < entries.length; j++) {
        if (assigned.has(j)) continue;
        const sim = this._jaccardSimilarity(ngrams[i], ngrams[j]);
        if (sim >= threshold) {
          cluster.push(entries[j]);
          assigned.add(j);
        }
      }

      clusters.push(cluster);
    }

    return clusters;
  }

  _extractNgrams(text, n) {
    const set = new Set();
    const lower = (text || '').toLowerCase().replace(/\s+/g, ' ');
    for (let i = 0; i <= lower.length - n; i++) {
      set.add(lower.slice(i, i + n));
    }
    return set;
  }

  _jaccardSimilarity(setA, setB) {
    if (setA.size === 0 && setB.size === 0) return 1;
    let intersection = 0;
    for (const item of setA) {
      if (setB.has(item)) intersection++;
    }
    const union = setA.size + setB.size - intersection;
    return union > 0 ? intersection / union : 0;
  }

  /**
   * Calculate overall memory health (0-1).
   */
  _calculateHealth() {
    if (this._memories.length === 0) return 0;
    const now = Date.now();
    let totalHealth = 0;

    for (const m of this._memories) {
      const ageDays = (now - m.createdAt) / 86400_000;
      const recencyFactor = Math.pow(0.5, ageDays / DEEP_RECENCY_HALF_LIFE_DAYS);
      const recallFactor = Math.min(1, m.recallCount / DEEP_MIN_RECALL_COUNT);
      const diversityFactor = Math.min(1, m.queries.length / DEEP_MIN_UNIQUE_QUERIES);
      // Gentle type-weight boost: keeps health magnitude stable (weight 0.5→×0.85,
      // 0.9→×0.97) while letting high-value memory types decay slower.
      const typeFactor = 0.7 + 0.3 * lifecycle.typeWeight(m.type);
      totalHealth += m.score * recencyFactor * typeFactor
        * (0.4 + 0.3 * recallFactor + 0.3 * diversityFactor);
    }

    return Math.min(1, totalHealth / this._memories.length);
  }

  /**
   * Recovery mechanism: restore memories when health drops critically.
   */
  async _runRecovery(now) {
    const cutoff = now - DEEP_RECOVERY_LOOKBACK_DAYS * 86400_000;
    const candidates = this._memories
      .filter(m => m.createdAt >= cutoff && m.score < DEEP_RECOVERY_TRIGGER_BELOW_HEALTH)
      .sort((a, b) => b.recallCount - a.recallCount)
      .slice(0, DEEP_RECOVERY_MAX_CANDIDATES);

    let recovered = 0;
    for (const c of candidates) {
      // Boost score based on recall history
      const confidence = Math.min(1, c.recallCount / 10 + c.queries.length / 5);
      if (confidence >= DEEP_RECOVERY_MIN_CONFIDENCE) {
        c.score = Math.max(c.score, 0.7);
        recovered++;
        if (confidence >= DEEP_RECOVERY_AUTO_WRITE_MIN_CONFIDENCE) {
          c.score = Math.max(c.score, 0.9);
        }
      }
    }

    return recovered;
  }

  _buildDeepSynthesisPrompt(candidates) {
    const entries = candidates.map(c =>
      `[Score:${c.score.toFixed(2)} Recalls:${c.recallCount}] ${c.content}`
    ).join('\n\n');

    return `Synthesize the following memory fragments into a single coherent insight.
Preserve all specific identifiers, paths, numbers, and technical details.
Focus on extracting the underlying pattern or principle.

Memory fragments:
${entries}

Output a concise synthesis (2-4 sentences) that captures the essential knowledge.`;
  }

  _buildPatternExtractionPrompt(sources) {
    const entries = sources.map(s => `- ${s.content}`).join('\n');

    return `Analyze these memory entries and extract recurring patterns or themes.
Output as JSON array: [{"description": "...", "strength": 0.0-1.0}]
Only include patterns with strength >= 0.75.

Memories:
${entries}`;
  }

  _parsePatterns(content) {
    try {
      // Try direct JSON parse
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) return parsed;
      if (parsed.patterns) return parsed.patterns;
    } catch {
      // Extract JSON from markdown code blocks
      const match = content.match(/\[[\s\S]*\]/);
      if (match) {
        try { return JSON.parse(match[0]); } catch { /* fall through */ }
      }
    }
    return [];
  }

  /**
   * Get memory statistics.
   */
  getStats() {
    return {
      total: this._memories.length,
      bySource: this._memories.reduce((acc, m) => {
        acc[m.source] = (acc[m.source] || 0) + 1;
        return acc;
      }, {}),
      byPhase: this._memories.reduce((acc, m) => {
        const phase = m.phase || 'raw';
        acc[phase] = (acc[phase] || 0) + 1;
        return acc;
      }, {}),
      byLifecycle: this._memories.reduce((acc, m) => {
        const stage = m.lifecycle || lifecycle.LIFECYCLE.ACTIVE;
        acc[stage] = (acc[stage] || 0) + 1;
        return acc;
      }, {}),
      health: this._calculateHealth(),
      lastPhaseRun: { ...this._lastPhaseRun },
    };
  }
}

module.exports = {
  MemoryDreaming,
  LIGHT_INTERVAL_MS,
  LIGHT_DEDUPE_SIMILARITY,
  DEEP_MIN_SCORE,
  DEEP_RECOVERY_TRIGGER_BELOW_HEALTH,
  REM_MIN_PATTERN_STRENGTH,
  lifecycle,
};

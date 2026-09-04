'use strict';

/**
 * memoryDreamEnhancer.js — Enhanced memory dream system with ToolSpec integration.
 *
 * Extends the existing memoryDreaming.js with:
 * 1. ToolSpec-compatible memory tools for dream operations
 * 2. Automatic memory capture from tool results
 * 3. Session priming with relevant dream insights
 * 4. Background consolidation scheduling
 * 5. Memory health monitoring
 *
 * @module memoryDreamEnhancer
 */

const { ToolSpec, ToolResult, ToolCategory, RiskLevel } = require('./toolSpec');

// ── Dream Phase Constants ───────────────────────────────────────────────

const DreamPhase = Object.freeze({
  LIGHT: 'light',    // Fast dedup (6h)
  DEEP: 'deep',      // AI synthesis (daily)
  REM: 'rem',        // Pattern extraction (weekly)
});

// ── Memory Health Thresholds ────────────────────────────────────────────

const HealthThreshold = Object.freeze({
  CRITICAL: 0.2,
  LOW: 0.35,
  MODERATE: 0.6,
  GOOD: 0.8,
});

// ── Dream Insight Tool Factory ──────────────────────────────────────────

/**
 * Create ToolSpec-compatible tools for dream operations.
 * @param {object} options
 * @param {object} options.dreaming - MemoryDreaming instance
 * @param {object} options.bridge - MemoryBridge instance
 * @returns {ToolSpec[]}
 */
function createDreamTools(options = {}) {
  const { dreaming } = options;

  const getInsightsTool = new ToolSpec({
    name: 'get_dream_insights',
    description: 'Retrieve consolidated dream insights and patterns from memory. Returns high-level patterns, recent synthesis results, and memory health status.',
    inputSchema: {
      type: 'object',
      properties: {
        phase: {
          type: 'string',
          description: 'Dream phase to query: light, deep, rem, or all',
          enum: ['light', 'deep', 'rem', 'all'],
        },
        limit: {
          type: 'number',
          description: 'Maximum number of insights to return (default: 10)',
        },
        minScore: {
          type: 'number',
          description: 'Minimum health score filter (0-1, default: 0)',
        },
      },
    },
    execute: async (params) => {
      const phase = params.phase || 'all';
      const limit = params.limit || 10;
      const minScore = params.minScore || 0;

      const memories = dreaming
        ? dreaming.snapshotMemories()
        : [];

      let filtered = memories.filter(m => m.score >= minScore);

      if (phase !== 'all') {
        filtered = filtered.filter(m => m.phase === phase);
      }

      const insights = filtered
        .sort((a, b) => b.score * b.recallCount - a.score * a.recallCount)
        .slice(0, limit);

      const health = dreaming ? dreaming._calculateHealth() : 0;

      return ToolResult.success({
        insights: insights.map(m => ({
          id: m.id,
          content: m.content?.slice(0, 200),
          phase: m.phase,
          score: m.score,
          recallCount: m.recallCount,
          type: m.type,
          lifecycle: m.lifecycle,
        })),
        health,
        totalMemories: memories.length,
        filteredCount: insights.length,
      });
    },
    readOnly: true,
    mutatesFiles: false,
    requiresPermission: false,
    parallelSafe: true,
    category: ToolCategory.LOCAL,
    risk: RiskLevel.SAFE,
    aliases: ['dream_insights', 'memory_patterns'],
    activityDescription: '获取梦境洞察',
  });

  const triggerDreamTool = new ToolSpec({
    name: 'trigger_dream',
    description: 'Manually trigger a dream consolidation phase. Use to force memory synthesis, dedup, or pattern extraction outside normal schedule.',
    inputSchema: {
      type: 'object',
      properties: {
        phase: {
          type: 'string',
          description: 'Dream phase to trigger',
          enum: ['light', 'deep', 'rem'],
        },
        force: {
          type: 'boolean',
          description: 'Force execution even if recently run',
        },
      },
      required: ['phase'],
    },
    execute: async (params) => {
      if (!dreaming) {
        return ToolResult.error('Dream system not available');
      }

      const phase = params.phase;
      const force = params.force === true;

      // Check if recently run (unless forced)
      if (!force) {
        const lastRun = dreaming._lastPhaseRun?.[phase] || 0;
        const minInterval = {
          [DreamPhase.LIGHT]: 6 * 3600_000,  // 6 hours
          [DreamPhase.DEEP]: 20 * 3600_000,   // 20 hours
          [DreamPhase.REM]: 5 * 24 * 3600_000, // 5 days
        }[phase] || 0;

        if (Date.now() - lastRun < minInterval) {
          return ToolResult.error(
            `Dream phase "${phase}" was recently run. Use force=true to override.`
          );
        }
      }

      let stats;
      try {
        switch (phase) {
          case DreamPhase.LIGHT:
            stats = await dreaming.runLightPhase();
            break;
          case DreamPhase.DEEP:
            stats = await dreaming.runDeepPhase();
            break;
          case DreamPhase.REM:
            stats = await dreaming.runRemPhase();
            break;
          default:
            return ToolResult.error(`Unknown dream phase: ${phase}`);
        }

        return ToolResult.success({
          phase,
          stats,
          message: `Dream phase "${phase}" completed`,
        });
      } catch (err) {
        return ToolResult.error(`Dream phase failed: ${err.message}`);
      }
    },
    readOnly: false,
    mutatesFiles: true,
    requiresPermission: false,
    parallelSafe: false,
    category: ToolCategory.LOCAL,
    risk: RiskLevel.LOW,
    aliases: ['run_dream', 'consolidate_memory'],
    activityDescription: '触发记忆整合',
  });

  const memoryHealthTool = new ToolSpec({
    name: 'memory_health',
    description: 'Check memory system health. Returns health score, memory count by phase, and recommendations.',
    inputSchema: {
      type: 'object',
      properties: {
        detailed: {
          type: 'boolean',
          description: 'Include detailed breakdown by type and lifecycle',
        },
      },
    },
    execute: async (params) => {
      if (!dreaming) {
        return ToolResult.error('Dream system not available');
      }

      const memories = dreaming.snapshotMemories();
      const health = dreaming._calculateHealth();

      const byPhase = {};
      const byLifecycle = {};
      const byType = {};

      for (const m of memories) {
        byPhase[m.phase || 'none'] = (byPhase[m.phase || 'none'] || 0) + 1;
        byLifecycle[m.lifecycle || 'unknown'] = (byLifecycle[m.lifecycle || 'unknown'] || 0) + 1;
        byType[m.type || 'unknown'] = (byType[m.type || 'unknown'] || 0) + 1;
      }

      let status = 'unknown';
      if (health >= HealthThreshold.GOOD) status = 'good';
      else if (health >= HealthThreshold.MODERATE) status = 'moderate';
      else if (health >= HealthThreshold.LOW) status = 'low';
      else status = 'critical';

      const recommendations = [];
      if (health < HealthThreshold.LOW) {
        recommendations.push('Consider running deep dream to recover important memories');
      }
      if ((byPhase.light || 0) > 50) {
        recommendations.push('Many unconsolidated memories — run light dream for dedup');
      }
      if ((byLifecycle.pruned || 0) > 20) {
        recommendations.push('Many pruned memories — review archive for revival candidates');
      }

      return ToolResult.success({
        health,
        status,
        totalMemories: memories.length,
        byPhase: params.detailed ? byPhase : undefined,
        byLifecycle: params.detailed ? byLifecycle : undefined,
        byType: params.detailed ? byType : undefined,
        recommendations,
      });
    },
    readOnly: true,
    mutatesFiles: false,
    requiresPermission: false,
    parallelSafe: true,
    category: ToolCategory.LOCAL,
    risk: RiskLevel.SAFE,
    aliases: ['dream_status', 'memory_status'],
    activityDescription: '检查记忆健康',
  });

  return [getInsightsTool, triggerDreamTool, memoryHealthTool];
}

// ── Dream Scheduler ──────────────────────────────────────────────────────

/**
 * Background scheduler for automatic dream phases.
 */
class DreamScheduler {
  /**
   * @param {object} options
   * @param {object} options.dreaming - MemoryDreaming instance
   * @param {object} [options.logger]
   */
  constructor(options = {}) {
    this._dreaming = options.dreaming;
    this._logger = options.logger || console;
    this._timers = {};
    this._running = false;
  }

  /**
   * Start automatic dream scheduling.
   */
  start() {
    if (this._running || !this._dreaming) return;
    this._running = true;

    // Light phase: every 6 hours
    this._timers.light = setInterval(async () => {
      try {
        const stats = await this._dreaming.runLightPhase();
        this._logger.info('Light dream completed:', stats);
      } catch (err) {
        this._logger.warn('Light dream failed:', err.message);
      }
    }, 6 * 3600_000);

    // Deep phase: daily at 3am
    this._scheduleDaily('deep', 3, 0, () => this._dreaming.runDeepPhase());

    // REM phase: weekly on Sunday at 5am
    this._scheduleWeekly('rem', 0, 5, 0, () => this._dreaming.runRemPhase());
  }

  /**
   * Stop automatic dream scheduling.
   */
  stop() {
    this._running = false;
    for (const timer of Object.values(this._timers)) {
      clearInterval(timer);
    }
    this._timers = {};
  }

  /**
   * Schedule a daily task.
   * @private
   */
  _scheduleDaily(name, hour, minute, fn) {
    const now = new Date();
    const next = new Date();
    next.setHours(hour, minute, 0, 0);
    if (next <= now) {
      next.setDate(next.getDate() + 1);
    }

    const delay = next - now;
    setTimeout(() => {
      fn();
      this._timers[name] = setInterval(fn, 24 * 3600_000);
    }, delay);
  }

  /**
   * Schedule a weekly task.
   * @private
   */
  _scheduleWeekly(name, day, hour, minute, fn) {
    const now = new Date();
    const next = new Date();
    next.setHours(hour, minute, 0, 0);
    const daysUntil = (day - now.getDay() + 7) % 7;
    next.setDate(next.getDate() + (daysUntil === 0 && next <= now ? 7 : daysUntil));

    const delay = next - now;
    setTimeout(() => {
      fn();
      this._timers[name] = setInterval(fn, 7 * 24 * 3600_000);
    }, delay);
  }
}

// ── Module Exports ────────────────────────────────────────────────────────

module.exports = {
  DreamPhase,
  HealthThreshold,
  createDreamTools,
  DreamScheduler,
};

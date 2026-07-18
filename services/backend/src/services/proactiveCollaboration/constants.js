'use strict';

/**
 * proactiveCollaboration/constants.js — single source of truth for the
 * proactive-collaboration subsystem (DESIGN-ARCH-031).
 *
 * The subsystem turns the lead agent from a PASSIVE serial responder into a
 * PROACTIVE collaborator: when the user hands it a clearly decomposable,
 * multi-deliverable task and the model itself emitted no tool call, the loop
 * proactively decomposes the task and delegates the independent pieces to a
 * bounded fan-out of collaborating sub-agents (the existing orchestrated
 * `agent` tool path), then synthesizes — instead of grinding the parts one by
 * one or waiting for the user to say "use sub-agents".
 *
 * Every tunable lives here so behaviour is auditable and there is zero
 * hardcoding scattered across the detector/planner. All reads are env-overridable
 * and fail-soft (a malformed env value falls back to the documented default).
 */

/** Parse a positive integer env var with a clamped fallback. */
function envInt(rawValue, def, min, max) {
  const n = parseInt(rawValue, 10);
  if (!Number.isFinite(n)) return def;
  if (typeof min === 'number' && n < min) return min;
  if (typeof max === 'number' && n > max) return max;
  return n;
}

/** Parse a float env var in [0,1] with a fallback. */
function envRatio(rawValue, def) {
  const n = parseFloat(rawValue);
  if (!Number.isFinite(n) || n < 0 || n > 1) return def;
  return n;
}

const LIMITS = {
  // Hard ceiling on how many sub-tasks we will ever fan out. Mirrors the
  // SubAgentOrchestrator maxChildren (5) so a proactive injection can never ask
  // for more children than the orchestrator will actually run.
  get MAX_SUBTASKS() { return envInt(process.env.KHY_PROACTIVE_COLLAB_MAX_SUBTASKS, 5, 2, 5); },
  // Minimum independent sub-tasks required before collaboration is worthwhile.
  // Below this a single serial turn is cheaper and clearer.
  get MIN_SUBTASKS() { return envInt(process.env.KHY_PROACTIVE_COLLAB_MIN_SUBTASKS, 2, 2, 5); },
  // Minimum confidence (0..1) the detector must reach to propose collaboration.
  // Kept high by default so the subsystem only fires on genuinely decomposable
  // work and never hijacks a simple request (which would waste tokens).
  get MIN_CONFIDENCE() { return envRatio(process.env.KHY_PROACTIVE_COLLAB_MIN_CONFIDENCE, 0.6); },
  // Ignore extremely short messages — they are almost never multi-deliverable.
  get MIN_MESSAGE_CHARS() { return envInt(process.env.KHY_PROACTIVE_COLLAB_MIN_CHARS, 16, 1, 4096); },
  // Cap the length of a single derived sub-task description (defensive).
  MAX_SUBTASK_CHARS: 400,
};

/**
 * Role inference map. Each entry maps a set of action-verb signals to the
 * sub-agent role best suited to that kind of work. Order matters: the first
 * matching bucket wins. Roles align with AgentTool.roleMap.
 */
const ROLE_SIGNALS = [
  {
    role: 'audit',
    // adversarial review / fault-finding (read-only critique, no mutation).
    // Placed first so explicit "挑刺找问题" intent routes to the audit critic
    // before the broad implement/verify buckets. Kept narrow to fault-finding
    // verbs so it does not steal generic "审查/review" from the planner bucket.
    patterns: [/审计|挑刺|找茬|找问题|找出问题|找bug|找漏洞|找缺陷|找隐患|代码审查|审查代码|code\s*review|nitpick|critique|\baudit\b|find\s+(bugs|issues|problems|flaws|defects|vulnerabilit)/i],
  },
  {
    role: 'verify',
    // verification / testing oriented work
    patterns: [/测试|验证|校验|跑测试|self-?test|verif|validate|\btest\b|检查正确/i],
  },
  {
    role: 'explore',
    // read-only research / discovery / lookup work
    patterns: [/调研|研究|搜索|查找|查询|检索|了解|搜集|收集资料|research|investigate|explore|look\s+up|find\s+out|gather/i],
  },
  {
    role: 'reading',
    // deep-reading / comprehension of specific files or docs (read-only).
    // Kept narrow to "read through / walk through a file" intent so it does not
    // steal generic 研究/调研 from the explore bucket above.
    patterns: [/通读|逐行读|读一读|读一下.*文件|读懂.*(代码|文件)|read\s+through|walk\s+through.*(code|file)/i],
  },
  {
    role: 'map',
    // structural mapping / architecture-map of a codebase (read-only).
    // Narrow to explicit "map/地图/结构梳理" intent; overlaps planner's 梳理 only
    // when paired with 结构, which is precisely the mapping case, so it is placed
    // before the planner bucket on purpose.
    patterns: [/画.*地图|架构地图|代码地图|梳理.*结构|结构梳理|map\s+the\s+codebase|codebase\s+map|architecture\s+map/i],
  },
  {
    role: 'planner',
    // analysis / design / evaluation (no mutation)
    patterns: [/分析|评估|设计方案|规划|梳理|对比|比较|analy[sz]e|design|evaluate|assess|compare|plan\b/i],
  },
  {
    role: 'implement',
    // mutating / build work
    patterns: [/实现|编写|创建|新增|生成|构建|开发|修复|重构|实施|搭建|更新|更改|修改|删除|移除|添加|配置|部署|优化|implement|build|create|write|generate|develop|fix|refactor|update|modify|remove|delete|add\b/i],
  },
];

/** Fallback role when no signal matches. */
const DEFAULT_ROLE = 'general';

/**
 * Strong structural signals that a message describes parallelizable work, each
 * with a confidence weight. The detector sums matched weights (capped at 1.0).
 */
const PARALLEL_MARKERS = [
  { weight: 0.5, pattern: /分别|各自|同时|并行|并发|respectively|in\s+parallel|concurrently|simultaneously/i },
  // count words: "多个/几个/若干/批量" and explicit "两/三/…/N 个" enumerations.
  { weight: 0.3, pattern: /多个|几个|若干|批量|[两二三四五六七八九十\d]+\s*个|several|multiple|each\s+of/i },
];

module.exports = { LIMITS, ROLE_SIGNALS, DEFAULT_ROLE, PARALLEL_MARKERS, envInt, envRatio };

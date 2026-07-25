/**
 * Usage Habit Service — Track, analyze, and adapt to user behavior.
 *
 * Records fine-grained usage patterns and provides optimization hints
 * to the system. Works across all models and IDEs (Ollama, Claude, Cursor,
 * Kiro, Codex, API relay, etc.).
 *
 * Growth: all habit data lives in ~/.khyquant/growth/habits.json
 * which is portable (copy to another machine via growth export/import).
 *
 * Tracks:
 * 1. Time patterns — when user is active (time of day, day of week)
 * 2. Command chains — typical workflows (not just repeated, but sequential)
 * 3. Model preferences — which model/IDE works best per task type
 * 4. Response preferences — length, detail level, language style
 * 5. Topic focus — evolving interests over time
 * 6. Error recovery — how user handles errors (for proactive help)
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

const HABITS_FILE = path.join(os.homedir(), '.khyquant', 'growth', 'habits.json');

// ─── Default Structure ──────────────────────────────────────────────────────

function _defaultHabits() {
  return {
    version: 1,
    lastUpdated: null,

    // Time usage profile
    timeProfile: {
      hourlyActivity: new Array(24).fill(0),  // 0-23 hour counts
      weekdayActivity: new Array(7).fill(0),  // 0=Sun, 6=Sat
      peakHours: [],                           // derived: top 3 active hours
      averageSessionMinutes: 0,
      totalSessions: 0,
    },

    // Command workflow patterns (sequence → frequency)
    workflows: {
      // key: "cmd1→cmd2→cmd3", value: { count, lastUsed, avgInterval }
    },

    // Model/IDE preference tracking
    modelPreferences: {
      // Per task type: which model/adapter performs best
      // key: taskType, value: { preferred, history: [{ adapter, model, satisfaction, timestamp }] }
      analysis: { preferred: null, history: [] },
      backtest: { preferred: null, history: [] },
      conversation: { preferred: null, history: [] },
      dataFetch: { preferred: null, history: [] },
      strategy: { preferred: null, history: [] },
    },

    // Response style preferences (learned from user behavior)
    responsePreferences: {
      preferredLength: 'medium',    // short, medium, long
      detailLevel: 'balanced',      // brief, balanced, detailed
      codeInResponse: true,         // user likes seeing code snippets
      planBeforeAction: null,       // null=unknown, true=user likes plans, false=prefers direct action
      showCost: true,               // show token cost info
      showTips: true,               // show knowledge tips
    },

    // Topic evolution (what user cares about over time)
    topicFocus: {
      // key: topic, value: { count, firstSeen, lastSeen, trend: 'rising'|'stable'|'declining' }
    },

    // Error recovery patterns
    errorPatterns: {
      commonErrors: {},             // error type → count
      recoveryActions: {},          // error type → typical next command
      selfResolvingRate: 0,         // % of errors user resolves without help
    },

    // Cross-IDE/model collaboration stats
    collaboration: {
      modelsUsed: {},               // model → { count, lastUsed, avgResponseQuality }
      idesUsed: {},                 // ide → { count, lastUsed, sessionsCount }
      switchPatterns: [],           // when user switches model/IDE and why (context)
      bestCombinations: [],         // model+taskType combos with highest satisfaction
    },
  };
}

// ─── Core Recording Functions ───────────────────────────────────────────────

/**
 * Record a timestamped interaction.
 * Called on every command execution.
 */
function recordInteraction(command, context = {}) {
  const habits = _load();
  const now = new Date();

  // Time profile
  habits.timeProfile.hourlyActivity[now.getHours()]++;
  habits.timeProfile.weekdayActivity[now.getDay()]++;
  _updatePeakHours(habits);

  // Topic focus
  const topic = _classifyTopic(command);
  if (topic) {
    if (!habits.topicFocus[topic]) {
      habits.topicFocus[topic] = { count: 0, firstSeen: now.toISOString(), lastSeen: null, trend: 'rising' };
    }
    habits.topicFocus[topic].count++;
    habits.topicFocus[topic].lastSeen = now.toISOString();
  }

  habits.lastUpdated = now.toISOString();
  _save(habits);
}

/**
 * Record a workflow chain (sequence of commands in one session).
 */
function recordWorkflowStep(commandSequence) {
  if (!commandSequence || commandSequence.length < 2) return;

  const habits = _load();
  const key = commandSequence.join('→');

  if (!habits.workflows[key]) {
    habits.workflows[key] = { count: 0, lastUsed: null, avgIntervalMs: 0 };
  }
  habits.workflows[key].count++;
  habits.workflows[key].lastUsed = new Date().toISOString();

  // Prune: keep only top 50 workflows
  const entries = Object.entries(habits.workflows);
  if (entries.length > 50) {
    entries.sort((a, b) => b[1].count - a[1].count);
    habits.workflows = Object.fromEntries(entries.slice(0, 50));
  }

  _save(habits);
}

/**
 * Record model/IDE usage and implicit satisfaction.
 * satisfaction: 1=good (no retry), 0.5=neutral, 0=bad (user retried/switched)
 */
function recordModelUsage(adapter, model, taskType, satisfaction = 1) {
  const habits = _load();
  const now = new Date().toISOString();

  // Model preferences per task type
  const validTypes = ['analysis', 'backtest', 'conversation', 'dataFetch', 'strategy'];
  const type = validTypes.includes(taskType) ? taskType : 'conversation';

  if (!habits.modelPreferences[type]) {
    habits.modelPreferences[type] = { preferred: null, history: [] };
  }

  habits.modelPreferences[type].history.push({
    adapter,
    model: model || 'default',
    satisfaction,
    timestamp: now,
  });

  // Keep only last 100 entries per type
  if (habits.modelPreferences[type].history.length > 100) {
    habits.modelPreferences[type].history = habits.modelPreferences[type].history.slice(-100);
  }

  // Recalculate preferred model for this task type
  habits.modelPreferences[type].preferred = _calculatePreferred(habits.modelPreferences[type].history);

  // Collaboration stats
  const modelKey = model || adapter;
  if (!habits.collaboration.modelsUsed[modelKey]) {
    habits.collaboration.modelsUsed[modelKey] = { count: 0, lastUsed: null, avgResponseQuality: 0 };
  }
  habits.collaboration.modelsUsed[modelKey].count++;
  habits.collaboration.modelsUsed[modelKey].lastUsed = now;
  // Exponential moving average for quality
  const prev = habits.collaboration.modelsUsed[modelKey].avgResponseQuality;
  habits.collaboration.modelsUsed[modelKey].avgResponseQuality = prev * 0.8 + satisfaction * 0.2;

  if (adapter) {
    if (!habits.collaboration.idesUsed[adapter]) {
      habits.collaboration.idesUsed[adapter] = { count: 0, lastUsed: null, sessionsCount: 0 };
    }
    habits.collaboration.idesUsed[adapter].count++;
    habits.collaboration.idesUsed[adapter].lastUsed = now;
  }

  _save(habits);
}

/**
 * Record user's response preference signal.
 * Signals: 'too_long', 'too_short', 'liked_detail', 'liked_brief', 'skipped_tip', etc.
 */
function recordResponseFeedback(signal) {
  const habits = _load();

  switch (signal) {
    case 'too_long':
      habits.responsePreferences.preferredLength = 'short';
      habits.responsePreferences.detailLevel = 'brief';
      break;
    case 'too_short':
      habits.responsePreferences.preferredLength = 'long';
      habits.responsePreferences.detailLevel = 'detailed';
      break;
    case 'liked_detail':
      habits.responsePreferences.detailLevel = 'detailed';
      break;
    case 'liked_brief':
      habits.responsePreferences.detailLevel = 'brief';
      break;
    case 'skipped_tip':
      habits.responsePreferences.showTips = false;
      break;
    case 'liked_plan':
      habits.responsePreferences.planBeforeAction = true;
      break;
    case 'skipped_plan':
      habits.responsePreferences.planBeforeAction = false;
      break;
    case 'too_much_code':
      habits.responsePreferences.codeInResponse = false;
      break;
    case 'wants_code':
      habits.responsePreferences.codeInResponse = true;
      break;
  }

  _save(habits);
}

/**
 * Record an error and how the user recovered.
 */
function recordError(errorType, nextCommand = null) {
  const habits = _load();

  if (!habits.errorPatterns.commonErrors[errorType]) {
    habits.errorPatterns.commonErrors[errorType] = 0;
  }
  habits.errorPatterns.commonErrors[errorType]++;

  if (nextCommand) {
    habits.errorPatterns.recoveryActions[errorType] = nextCommand;
  }

  _save(habits);
}

/**
 * Record session start/end for time profiling.
 */
function recordSession(durationMinutes) {
  const habits = _load();
  const prev = habits.timeProfile.averageSessionMinutes;
  const total = habits.timeProfile.totalSessions;

  habits.timeProfile.totalSessions++;
  habits.timeProfile.averageSessionMinutes = (prev * total + durationMinutes) / (total + 1);

  _save(habits);
}

// ─── Optimization Hints (system reads these to adapt) ───────────────────────

/**
 * Get the best model/adapter for a given task type.
 * Returns { adapter, model, confidence } or null.
 */
function getPreferredModel(taskType) {
  const habits = _load();
  const type = habits.modelPreferences[taskType] || habits.modelPreferences.conversation;
  if (!type || !type.preferred) return null;
  return type.preferred;
}

/**
 * Get optimized system prompt hints based on user habits.
 * Returns a string to append to the system prompt.
 */
function getHabitContext() {
  const habits = _load();
  const hints = [];

  // Response length preference
  if (habits.responsePreferences.preferredLength === 'short') {
    hints.push('用户偏好简短回复，尽量精炼');
  } else if (habits.responsePreferences.preferredLength === 'long') {
    hints.push('用户喜欢详细回复，可以多给分析细节');
  }

  // Plan preference
  if (habits.responsePreferences.planBeforeAction === true) {
    hints.push('用户喜欢先看计划再执行');
  } else if (habits.responsePreferences.planBeforeAction === false) {
    hints.push('用户更喜欢直接行动，少做计划');
  }

  // Code-in-response preference. Only surface the suppression hint — the default
  // (codeInResponse: true) is the norm for a dev assistant and needs no nudge,
  // so we stay silent there to avoid prompt noise.
  if (habits.responsePreferences.codeInResponse === false) {
    hints.push('用户更想要思路与解释，少贴大段代码（确有必要再给关键片段）');
  }

  // Topic focus
  const recentTopics = Object.entries(habits.topicFocus)
    .filter(([, v]) => v.trend === 'rising' || v.count >= 5)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 3)
    .map(([k]) => k);
  if (recentTopics.length > 0) {
    hints.push(`用户近期关注: ${recentTopics.join(', ')}`);
  }

  // Active time context
  const hour = new Date().getHours();
  const peakHours = habits.timeProfile.peakHours || [];
  if (peakHours.length > 0 && !peakHours.includes(hour)) {
    hints.push('当前非用户活跃时段，可能是快速查询');
  }

  return hints.length > 0 ? `\n[使用习惯]\n${hints.join('\n')}` : '';
}

/**
 * Describe the learned response-style preferences in natural, human-facing
 * language — the "khyos 记得你" transparency surface for the `habit` command.
 *
 * Pure: takes a responsePreferences object, returns an array of plain-language
 * lines. HONEST by construction — it states ONLY what was actively learned away
 * from the default (preferredLength!=='medium', planBeforeAction!==null,
 * codeInResponse===false), so the user never sees khyos claim to "know" a
 * preference it merely defaulted to. Returns [] when nothing has been learned,
 * which the caller renders as a "还在观察" line.
 *
 * @param {object} prefs - responsePreferences ({preferredLength, detailLevel,
 *   codeInResponse, planBeforeAction, showCost, showTips}).
 * @returns {string[]} natural-language lines, possibly empty.
 */
function describeResponseStyle(prefs) {
  const p = prefs && typeof prefs === 'object' ? prefs : {};
  const lines = [];

  if (p.preferredLength === 'short') {
    lines.push('回复尽量简短精炼（你提过太长了）');
  } else if (p.preferredLength === 'long') {
    lines.push('回复可以更详细，多给分析（你想看深入一点）');
  }

  if (p.planBeforeAction === true) {
    lines.push('先给计划再动手（你喜欢先看方案）');
  } else if (p.planBeforeAction === false) {
    lines.push('直接行动、少做计划（你说过直接做）');
  }

  // Default codeInResponse:true is the dev-assistant norm — only the learned
  // suppression is worth surfacing.
  if (p.codeInResponse === false) {
    lines.push('重思路与解释，少贴大段代码（确有必要才给关键片段）');
  }

  if (p.showTips === false) lines.push('不再附带知识小贴士');
  if (p.showCost === false) lines.push('不显示 token 费用');

  return lines;
}

/**
 * Get predicted next commands (workflow prediction).
 * Based on what the user typically does after their last command.
 */
function predictNextCommands(lastCommands) {
  if (!lastCommands || lastCommands.length === 0) return [];

  const habits = _load();
  const predictions = [];

  // Find workflows that start with the last command(s)
  const lastKey = lastCommands[lastCommands.length - 1];
  for (const [key, data] of Object.entries(habits.workflows)) {
    const steps = key.split('→');
    const matchIdx = steps.indexOf(lastKey);
    if (matchIdx >= 0 && matchIdx < steps.length - 1) {
      predictions.push({
        command: steps[matchIdx + 1],
        confidence: Math.min(data.count / 10, 1),
        basedOn: key,
      });
    }
  }

  // Sort by confidence and deduplicate
  predictions.sort((a, b) => b.confidence - a.confidence);
  const seen = new Set();
  return predictions.filter(p => {
    if (seen.has(p.command)) return false;
    seen.add(p.command);
    return true;
  }).slice(0, 3);
}

/**
 * Get full habit summary for display or export.
 */
function getHabitSummary() {
  const habits = _load();

  // Calculate top workflows
  const topWorkflows = Object.entries(habits.workflows)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 5)
    .map(([key, data]) => ({ workflow: key, count: data.count }));

  // Calculate model usage ranking
  const modelRanking = Object.entries(habits.collaboration.modelsUsed)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 5)
    .map(([model, data]) => ({
      model,
      count: data.count,
      quality: Math.round(data.avgResponseQuality * 100) + '%',
    }));

  // Calculate IDE usage
  const ideUsage = Object.entries(habits.collaboration.idesUsed)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([ide, data]) => ({ ide, count: data.count }));

  // Topic evolution
  const topics = Object.entries(habits.topicFocus)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 8)
    .map(([topic, data]) => ({
      topic,
      count: data.count,
      trend: data.trend,
    }));

  return {
    timeProfile: {
      peakHours: habits.timeProfile.peakHours,
      avgSession: Math.round(habits.timeProfile.averageSessionMinutes) + ' min',
      totalSessions: habits.timeProfile.totalSessions,
    },
    topWorkflows,
    modelRanking,
    ideUsage,
    topics,
    responseStyle: habits.responsePreferences,
    totalWorkflows: Object.keys(habits.workflows).length,
    totalModels: Object.keys(habits.collaboration.modelsUsed).length,
    totalTopics: Object.keys(habits.topicFocus).length,
  };
}

/**
 * Update topic trends (call periodically or on session end).
 */
function refreshTrends() {
  const habits = _load();
  const now = Date.now();
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

  for (const [topic, data] of Object.entries(habits.topicFocus)) {
    if (!data.lastSeen) continue;
    const lastSeen = new Date(data.lastSeen).getTime();
    const age = now - lastSeen;

    if (age < WEEK_MS) {
      data.trend = 'rising';
    } else if (age < WEEK_MS * 4) {
      data.trend = 'stable';
    } else {
      data.trend = 'declining';
    }
  }

  _save(habits);
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

function _load() {
  try {
    if (fs.existsSync(HABITS_FILE)) {
      const raw = fs.readFileSync(HABITS_FILE, 'utf-8');
      const data = JSON.parse(raw);
      // Merge with defaults (in case new fields were added)
      return { ..._defaultHabits(), ...data };
    }
  } catch { /* ignore */ }
  return _defaultHabits();
}

function _save(habits) {
  try {
    const dir = path.dirname(HABITS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(HABITS_FILE, JSON.stringify(habits, null, 2));
  } catch { /* best effort */ }
}

function _updatePeakHours(habits) {
  const hourly = habits.timeProfile.hourlyActivity;
  const indexed = hourly.map((count, hour) => ({ hour, count }));
  indexed.sort((a, b) => b.count - a.count);
  habits.timeProfile.peakHours = indexed.slice(0, 3).map(h => h.hour);
}

function _classifyTopic(command) {
  if (!command) return null;
  const lower = command.toLowerCase();

  // General AI-workbench domains come first (khyos is a general assistant, not
  // only a quant tool). The legacy quant topics are kept at the end for backward
  // compatibility. First matching category wins, so the more specific developer
  // domains (debugging, coding) take precedence over broad ones.
  const TOPIC_KEYWORDS = {
    // ── General developer / OS / writing / research domains ──
    'debugging': ['debug', 'bug', 'fix', 'error', 'stack trace', 'traceback', 'exception',
      '报错', '调试', '修复', '排查', '崩溃', '异常', '故障'],
    'coding': ['code', 'function', 'class', 'refactor', 'implement', 'compile', 'lint',
      'typescript', 'javascript', 'python', 'rust', '代码', '函数', '重构', '实现', '编译', '写个'],
    'testing': ['test', 'unit test', 'jest', 'pytest', 'coverage', '测试', '单测', '覆盖率'],
    'devops': ['deploy', 'docker', 'kubernetes', 'k8s', 'ci/cd', 'pipeline', 'release', 'build',
      '部署', '发布', '构建', '流水线', '上线'],
    'system_os': ['kernel', 'syscall', 'process', 'thread', 'memory', 'filesystem', 'driver',
      '内核', '进程', '线程', '内存', '驱动', '系统盘', '磁盘'],
    'writing_docs': ['document', 'readme', 'doc', 'write', 'summary', 'translate', 'article',
      '文档', '撰写', '总结', '翻译', '文章', '报告', '润色'],
    'research_search': ['search', 'research', 'find', 'latest', 'news', 'compare',
      '搜索', '调研', '查找', '最新', '新闻', '对比', '资料'],
    'data_ai': ['dataset', 'model', 'train', 'embedding', 'llm', 'prompt', 'rag', 'agent',
      '数据集', '训练', '模型', '向量', '提示词', '智能体'],
    // ── Legacy quant domains (kept for backward compatibility) ──
    'technical_analysis': ['quote', 'rsi', 'macd', 'kdj', 'boll', '行情', '指标', '均线'],
    'backtesting': ['backtest', '回测', 'strategy', '策略'],
    'risk_management': ['risk', '风险', 'stop', '止损', 'position'],
    'portfolio': ['portfolio', '持仓', '组合', 'account', '账户'],
  };

  for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    if (keywords.some(kw => lower.includes(kw))) {
      return topic;
    }
  }
  return null;
}

function _calculatePreferred(history) {
  if (!history || history.length === 0) return null;

  // Weight recent entries more heavily
  const scores = {};
  const recent = history.slice(-30); // Last 30 interactions

  for (let i = 0; i < recent.length; i++) {
    const entry = recent[i];
    const key = `${entry.adapter}/${entry.model}`;
    const recencyWeight = (i + 1) / recent.length; // Later = higher weight
    if (!scores[key]) scores[key] = { total: 0, count: 0 };
    scores[key].total += entry.satisfaction * recencyWeight;
    scores[key].count += recencyWeight;
  }

  // Find highest average satisfaction
  let best = null;
  let bestScore = 0;
  for (const [key, data] of Object.entries(scores)) {
    const avg = data.total / data.count;
    if (avg > bestScore && data.count >= 2) {
      bestScore = avg;
      const [adapter, model] = key.split('/');
      best = { adapter, model, confidence: Math.min(bestScore, 1) };
    }
  }

  return best;
}

module.exports = {
  // Recording
  recordInteraction,
  recordWorkflowStep,
  recordModelUsage,
  recordResponseFeedback,
  recordError,
  recordSession,

  // Optimization hints
  getPreferredModel,
  getHabitContext,
  describeResponseStyle,
  predictNextCommands,

  // Summary & maintenance
  getHabitSummary,
  refreshTrends,

  // Exported for tests / introspection.
  _classifyTopic,
};

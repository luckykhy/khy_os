/**
 * QoderCapabilityHook — PostResponse lifecycle hook.
 *
 * Asynchronously analyses completed Qoder tasks and determines whether
 * KHY OS could have handled them independently. When coverage falls
 * below the configured threshold a skill-gap record is persisted via
 * skillGapRecorder for later review.
 */

const skillGapRecorder = require('../skillGapRecorder');

// ---------------------------------------------------------------------------
// Task-type inference patterns
// ---------------------------------------------------------------------------
const TASK_PATTERNS = [
  {
    type: 'code-generation',
    keywords: ['write', 'create', 'implement', 'function', 'class', 'module'],
    tools: ['code_edit', 'file_write', 'create_file'],
  },
  {
    type: 'code-review',
    keywords: ['review', 'check', 'audit', 'lint', 'quality'],
    tools: ['eslint', 'codeAnalysis'],
  },
  {
    type: 'file-conversion',
    keywords: ['convert', 'transform', 'export', 'format'],
    tools: ['convertFile'],
  },
  {
    type: 'web-research',
    keywords: ['search', 'find', 'lookup', 'browse'],
    tools: ['webSearch', 'web_fetch'],
  },
  {
    type: 'data-analysis',
    keywords: ['analyze', 'statistics', 'chart', 'data'],
    tools: ['dataAnalysis'],
  },
  {
    type: 'test-generation',
    keywords: ['test', 'spec', 'assertion', 'coverage'],
    tools: ['generate-test'],
  },
  {
    type: 'debugging',
    keywords: ['debug', 'fix', 'error', 'bug', 'issue'],
    tools: ['debugger'],
  },
  {
    type: 'documentation',
    keywords: ['document', 'readme', 'comment', 'explain'],
    tools: [],
  },
  {
    type: 'refactoring',
    keywords: ['refactor', 'restructure', 'optimize', 'clean'],
    tools: ['code_edit'],
  },
];

// ---------------------------------------------------------------------------
// KHY capability coverage map (0–1, adjustable baseline)
// ---------------------------------------------------------------------------
const KHY_COVERAGE_MAP = {
  'code-generation': 0.8,
  'code-review': 0.5,
  'file-conversion': 0.6,
  'web-research': 0.4,
  'data-analysis': 0.7,
  'test-generation': 0.3,
  'debugging': 0.4,
  'documentation': 0.7,
  'refactoring': 0.5,
  'unknown': 0.0,
};

// ---------------------------------------------------------------------------
// Regex to detect Qoder-originated responses
// ---------------------------------------------------------------------------
const QODER_MODEL_RE = /qoder|qodercli/i;

// ---------------------------------------------------------------------------
// Confidence threshold (env-configurable, 0–100, stored as fraction)
// ---------------------------------------------------------------------------
function getThreshold() {
  const raw = process.env.KHY_TASK_HOOK_CONFIDENCE_THRESHOLD;
  if (raw !== undefined) {
    const parsed = parseFloat(raw);
    if (!isNaN(parsed) && parsed >= 0 && parsed <= 1) return parsed;
    // Accept percentage form (e.g. "70" → 0.70)
    if (!isNaN(parsed) && parsed > 1 && parsed <= 100) return parsed / 100;
  }
  return 0.7;
}

// ---------------------------------------------------------------------------
// inferTaskType — match context against known patterns
// ---------------------------------------------------------------------------
/**
 * Infer the task type from the hook context.
 * @param {object} context - Hook context (toolsInvoked, lastAiResponse, etc.)
 * @returns {{ type: string, confidence: number }}
 */
function inferTaskType(context) {
  const { toolsInvoked = [], lastAiResponse = '' } = context;
  const responseText = (typeof lastAiResponse === 'string' ? lastAiResponse : '').toLowerCase();
  const invokedSet = new Set((toolsInvoked || []).map(t => String(t).toLowerCase()));

  let bestMatch = { type: 'unknown', confidence: 0 };

  for (const pattern of TASK_PATTERNS) {
    let keywordHits = 0;
    for (const kw of pattern.keywords) {
      if (responseText.includes(kw)) keywordHits += 1;
    }
    let toolHits = 0;
    for (const t of pattern.tools) {
      if (invokedSet.has(t.toLowerCase())) toolHits += 1;
    }

    const totalSignals = pattern.keywords.length + pattern.tools.length;
    if (totalSignals === 0) continue;

    const confidence = (keywordHits + toolHits) / totalSignals;
    if (confidence > bestMatch.confidence) {
      bestMatch = { type: pattern.type, confidence };
    }
  }

  return bestMatch;
}

// ---------------------------------------------------------------------------
// checkKhyCoverage — look up coverage score for a task type
// ---------------------------------------------------------------------------
/**
 * Return KHY capability coverage for the given task type (0–1).
 * @param {string} taskType
 * @returns {number}
 */
function checkKhyCoverage(taskType) {
  return KHY_COVERAGE_MAP[taskType] !== undefined
    ? KHY_COVERAGE_MAP[taskType]
    : KHY_COVERAGE_MAP['unknown'];
}

// ---------------------------------------------------------------------------
// makeQoderCapabilityHook — factory
// ---------------------------------------------------------------------------
/**
 * Factory that returns a PostResponse handler.
 * The handler immediately returns `{ action: 'allow' }` so the response
 * pipeline is never blocked, then asynchronously evaluates whether KHY
 * could have handled the task on its own.
 *
 * @returns {function(object): Promise<{action: string}>}
 */
function makeQoderCapabilityHook() {
  return async function qoderCapabilityHandler(context) {
    // Fast-path: only analyse Qoder-originated responses
    const modelUsed = context.modelUsed || '';
    if (!QODER_MODEL_RE.test(modelUsed)) {
      return { action: 'allow' };
    }

    // Defer analysis so the response is never delayed
    setImmediate(() => {
      try {
        const { type: taskType, confidence: inferConfidence } = inferTaskType(context);
        const coverage = checkKhyCoverage(taskType);
        const threshold = getThreshold();

        if (coverage < threshold) {
          skillGapRecorder.recordGap({
            domain: 'qoder-capability',
            taskType,
            description: `Qoder handled "${taskType}" (infer confidence ${inferConfidence.toFixed(2)}); KHY coverage ${coverage} below threshold ${threshold}`,
            missingCapabilities: [`khy-coverage:${taskType}`],
            confidence: inferConfidence,
            timestamp: new Date().toISOString(),
          });
        }
      } catch (err) {
        console.error('[QoderCapabilityHook]', err.message);
      }
    });

    // Always allow — this hook is observational only
    return { action: 'allow' };
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  makeQoderCapabilityHook,
  inferTaskType,
  checkKhyCoverage,
  TASK_PATTERNS,
  KHY_COVERAGE_MAP,
};

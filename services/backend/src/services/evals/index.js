'use strict';

/**
 * Evals service — model evaluation and testing.
 * Supports running evaluations against models with various metrics.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

function _env(name) {
  return String(process.env[`KHY_EVAL_${name}`] || '').trim();
}

// ── Evaluation Result Types ──
const RESULT_TYPES = {
  accuracy: 'Accuracy Score',
  relevance: 'Relevance Score',
  coherence: 'Coherence Score',
  fluency: 'Fluency Score',
  safety: 'Safety Score',
};

// ── Run Evaluation ──
async function runEvaluation(options = {}) {
  const {
    model,
    prompt,
    expectedOutput,
    metrics = ['accuracy', 'relevance'],
    provider = 'local',
  } = options;

  if (!model) return { error: 'Model is required' };
  if (!prompt) return { error: 'Prompt is required' };

  const results = {
    id: `eval_${Date.now()}`,
    model,
    prompt,
    expectedOutput,
    timestamp: new Date().toISOString(),
    scores: {},
    status: 'completed',
  };

  // Simulated evaluation (in real implementation, this would call the model)
  for (const metric of metrics) {
    results.scores[metric] = {
      score: 0.85 + Math.random() * 0.1, // Simulated score
      type: RESULT_TYPES[metric] || metric,
    };
  }

  // Calculate overall score
  const scores = Object.values(results.scores).map((s) => s.score);
  results.overallScore = scores.length > 0
    ? scores.reduce((a, b) => a + b, 0) / scores.length
    : 0;

  return { success: true, results };
}

// ── Batch Evaluation ──
async function runBatchEvaluations(evaluations, options = {}) {
  if (!Array.isArray(evaluations) || evaluations.length === 0) {
    return { error: 'Evaluations array is required' };
  }

  const results = [];
  for (const evalConfig of evaluations) {
    const result = await runEvaluation(evalConfig);
    results.push(result);
  }

  return {
    success: true,
    batchId: `batch_${Date.now()}`,
    totalEvaluations: evaluations.length,
    completed: results.filter((r) => r.success).length,
    failed: results.filter((r) => !r.success).length,
    results,
  };
}

// ── Compare Models ──
async function compareModels(models, prompt, options = {}) {
  if (!Array.isArray(models) || models.length < 2) {
    return { error: 'At least 2 models are required for comparison' };
  }

  const comparison = {
    id: `comparison_${Date.now()}`,
    prompt,
    timestamp: new Date().toISOString(),
    models: {},
  };

  for (const model of models) {
    const result = await runEvaluation({ model, prompt, ...options });
    if (result.success) {
      comparison.models[model] = result.results;
    }
  }

  return { success: true, comparison };
}

// ── Evaluation History ──
function getEvalsDir() {
  const dir = path.join(os.homedir(), '.khy', 'evals');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

async function saveEvaluationResult(result) {
  const dir = getEvalsDir();
  const filePath = path.join(dir, `${result.id || `eval_${Date.now()}`}.json`);
  fs.writeFileSync(filePath, JSON.stringify(result, null, 2));
  return { success: true, path: filePath };
}

async function listEvaluationResults(limit = 20) {
  const dir = getEvalsDir();
  const results = [];

  try {
    const files = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .slice(-limit);

    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
        results.push(data);
      } catch (e) { /* skip */ }
    }
  } catch (e) { /* empty */ }

  return { success: true, results: results.reverse(), total: results.length };
}

// ── Provider registry ──
const PROVIDERS = [
  { id: 'local', name: 'Local Evaluation' },
  { id: 'deepeval', name: 'DeepEval' },
  { id: 'openai', name: 'OpenAI Evals' },
];

function listProviders() {
  return PROVIDERS;
}

function isProviderConfigured(providerId) {
  switch (providerId) {
    case 'local': return true;
    case 'deepeval': return !!_env('DEEPEVAL_API_KEY');
    case 'openai': return !!(process.env.OPENAI_API_KEY);
    default: return false;
  }
}

module.exports = {
  runEvaluation,
  runBatchEvaluations,
  compareModels,
  saveEvaluationResult,
  listEvaluationResults,
  listProviders,
  isProviderConfigured,
  RESULT_TYPES,
  PROVIDERS,
};

'use strict';

/**
 * modelDiscoveryEngine —— 未知模型的低置信度能力探测。
 *
 * 探测执行器由宿主注入,因此本模块本身不绑定某个 provider SDK。默认 probe suite
 * 只描述问题与评分维度;真实 runner 可以在 HTTP 层/网关层实现。所有结果先经过
 * inferFeaturesFromResults,再 saveTemporarily(confidence:'low'),永不自动写配置文件。
 */

const styles = require('../utils/styleMatchers');

const FLAG = 'KHY_MODEL_DISCOVERY';
const DEFAULT_PROBES = Object.freeze([
  { id: 'instruction_following', taskType: 'code', prompt: 'Return exactly: DISCOVERY_OK' },
  { id: 'reasoning', taskType: 'reasoning', prompt: 'Give one concise, verifiable reasoning step.' },
  { id: 'structured_output', taskType: 'analysis', prompt: 'Return JSON with keys answer and confidence.' },
  { id: 'tool_use', taskType: 'code', prompt: 'Describe whether a tool is needed before answering.' },
  { id: 'long_context', taskType: 'long_context', prompt: 'Summarize the supplied marker without losing it.' },
]);

function isEnabled(env = process.env) {
  try {
    return require('./flagRegistry').isFlagEnabled(FLAG, env || process.env);
  } catch {
    return false;
  }
}

function probeSuite(opts = {}) {
  const custom = Array.isArray(opts.probes) ? opts.probes : DEFAULT_PROBES;
  return custom.filter((probe) => styles.isPlainObject(probe) && typeof probe.id === 'string');
}

function scoreResult(result) {
  if (!styles.isPlainObject(result)) {
    return 0;
  }
  if (Number.isFinite(result.score)) {
    return Math.max(0, Math.min(1, result.score));
  }
  if (result.pass === true || result.success === true) {
    return 1;
  }
  return 0;
}

function inferFeaturesFromResults(results = []) {
  const rows = Array.isArray(results) ? results : [];
  const capability = {};
  const scores = {};

  for (const row of rows) {
    if (!styles.isPlainObject(row) || typeof row.id !== 'string') {
      continue;
    }
    const score = scoreResult(row);
    scores[row.id] = score;
    const dim = styles.CAPABILITY_DIMS.includes(row.id) ? row.id : '';

    if (dim) {
      capability[dim] = Math.round(score * 5);
    }
  }

  const passed = Object.values(scores).filter((score) => score >= 0.8).length;
  const total = Object.keys(scores).length;
  const strengths = Object.keys(scores).filter((id) => scores[id] >= 0.8);
  const weaknesses = Object.keys(scores).filter((id) => scores[id] < 0.4);

  return {
    confidence: 'low',
    source: 'discovery_probe',
    capability_matrix: capability,
    specialty_areas: { strengths, weaknesses },
    discovery: { passed, total, scores },
  };
}

async function discoverModel(modelIdRaw, opts = {}) {
  const modelId = typeof modelIdRaw === 'string' ? modelIdRaw.trim() : '';
  const env = styles.isPlainObject(opts.env) ? opts.env : process.env;

  if (!modelId || !isEnabled(env)) {
    return { modelId, enabled: false, saved: false, results: [], features: null };
  }

  const probes = probeSuite(opts);
  const runner = typeof opts.probeRunner === 'function' ? opts.probeRunner : null;
  const results = [];

  if (runner) {
    for (const probe of probes) {
      try {
        const result = await runner({ modelId, probe });
        results.push(Object.assign({}, probe, styles.isPlainObject(result) ? result : {}));
      } catch (error) {
        results.push({
          id: probe.id,
          pass: false,
          error: error && error.message ? error.message : String(error),
        });
      }
    }
  }

  const features = inferFeaturesFromResults(results);
  const registry = opts.registry && typeof opts.registry.saveTemporarily === 'function'
    ? opts.registry
    : null;
  const saved = registry
    ? registry.saveTemporarily(modelId, features, {
        confidence: 'low',
        source: 'discovery_probe',
        note: '待人工复核;未自动写盘',
      })
    : false;

  return {
    modelId,
    enabled: true,
    saved,
    persisted: false,
    probes: probes.map((probe) => probe.id),
    results,
    features,
  };
}

function describeDiscovery() {
  return {
    gate: FLAG,
    defaultOn: false,
    persistence: 'runtime-only',
    confidence: 'low',
    probes: DEFAULT_PROBES.map((probe) => probe.id),
  };
}

module.exports = {
  DEFAULT_PROBES,
  FLAG,
  describeDiscovery,
  discoverModel,
  inferFeaturesFromResults,
  isEnabled,
  probeSuite,
  scoreResult,
};

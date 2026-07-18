'use strict';

/**
 * moaService.js — MoA (Mixture-of-Agents) orchestration.
 * (ported concept from Hermes Agent v0.18.0, adapted to Khy-OS engine.)
 *
 * Flow:
 *   1. fan a prompt out to N reference models in parallel (reuse arenaManager,
 *      which owns the proven parallel/timeout/collect logic);
 *   2. normalize + de-duplicate the reference answers (pure leaf);
 *   3. build the aggregator prompt (pure leaf);
 *   4. call ONE aggregator model to synthesize the final answer.
 *
 * All IO (model calls) lives here; the deterministic pieces live in the
 * `moaAggregation` leaf. Gated by KHY_MOA_AGGREGATOR (default-on). The gateway
 * and the arena runner are injectable so the service is unit-testable offline.
 */

const { normalizeReferences, buildAggregatorPrompt } = require('./moaAggregation');

const _MOA_FLAG = 'KHY_MOA_AGGREGATOR';

function _moaEnabled(env = process.env) {
  try {
    const { isFlagEnabled } = require('./flagRegistry');
    return isFlagEnabled(_MOA_FLAG, env);
  } catch {
    const raw = env && env[_MOA_FLAG];
    if (raw == null || String(raw).trim() === '') return true;
    const v = String(raw).trim().toLowerCase();
    return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
  }
}

function _disabledResult() {
  return {
    ok: false,
    disabled: true,
    message: `已禁用(${_MOA_FLAG}=off);开启后可用多模型合成(MoA)`,
  };
}

/**
 * Resolve the real gateway singleton, fail-soft.
 */
function _resolveGateway(provided) {
  if (provided) return provided;
  try {
    return require('./gateway/aiGateway');
  } catch {
    return null;
  }
}

/**
 * Adapt whatever generation interface the gateway exposes into the
 * `query(prompt, { model, signal })` shape arenaManager expects. The real
 * Khy-OS gateway exposes `generate(prompt, options)`; older/mock gateways may
 * already expose chat/chatStream/query, in which case we pass them through.
 */
function _arenaGatewayShim(gateway) {
  if (!gateway) return null;
  if (typeof gateway.chatStream === 'function' || typeof gateway.chat === 'function' || typeof gateway.query === 'function') {
    return gateway; // already arena-compatible
  }
  if (typeof gateway.generate === 'function') {
    const shim = {
      query: (prompt, opts = {}) => gateway.generate(prompt, { model: opts.model, signal: opts.signal }),
    };
    if (typeof gateway.listModels === 'function') shim.listModels = gateway.listModels.bind(gateway);
    if (typeof gateway.getAvailableModels === 'function') shim.getAvailableModels = gateway.getAvailableModels.bind(gateway);
    return shim;
  }
  return gateway;
}

/**
 * Call one aggregator model with the synthesis prompt. Tolerant of the same
 * generation-interface variants. Returns the answer text ('' on failure).
 */
async function _callAggregator(gateway, model, prompt) {
  if (!gateway) return '';
  try {
    if (typeof gateway.generate === 'function') {
      const r = await gateway.generate(prompt, { model, temperature: 0.3 });
      return typeof r === 'string' ? r : _str(r && (r.content || r.text || r.reply));
    }
    if (typeof gateway.chat === 'function') {
      const r = await gateway.chat({ model, messages: [{ role: 'user', content: prompt }], temperature: 0.3 });
      return _str(r && (r.content || r.text || r.reply));
    }
    if (typeof gateway.query === 'function') {
      const r = await gateway.query(prompt, { model });
      return typeof r === 'string' ? r : _str(r && (r.content || r.reply));
    }
  } catch {
    return '';
  }
  return '';
}

// 收敛到 utils/toStr 单一真源(逐字节委托,调用点不变)
const _str = require('../utils/toStr').toStr;

/**
 * Run a full MoA round: fan-out → normalize → aggregate.
 *
 * @param {object} params
 * @param {string}   params.prompt            — the question
 * @param {string[]} params.models            — reference models (≥2)
 * @param {string}   [params.aggregatorModel] — model to synthesize (default: first reference)
 * @param {object}   [params.gateway]         — injectable gateway (default: aiGateway singleton)
 * @param {object}   [params.env]             — injectable env (default: process.env)
 * @param {object}   [params._arena]          — injectable arena runner (tests); must expose async run()
 * @param {number}   [params.timeoutMs]
 * @param {Function} [params.onProgress]
 * @returns {Promise<{ ok, references?, finalAnswer?, aggregatorModel?, arenaId?, disabled?, error? }>}
 */
async function runMoa(params = {}) {
  const { prompt, models, aggregatorModel, onProgress } = params;

  if (!_moaEnabled(params.env)) return _disabledResult();

  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    return { ok: false, error: 'MoA 需要一个非空 prompt' };
  }
  if (!Array.isArray(models) || models.length < 2) {
    return { ok: false, error: 'MoA 需要至少 2 个参考模型' };
  }

  const gateway = _resolveGateway(params.gateway);
  const shim = _arenaGatewayShim(gateway);

  // 1) fan out (reuse arenaManager unless a runner is injected).
  let arenaResult;
  try {
    let arena = params._arena;
    if (!arena) {
      const { ArenaManager } = require('./arenaManager');
      arena = new ArenaManager(shim, {
        timeoutMs: Number.isFinite(params.timeoutMs) ? params.timeoutMs : 60_000,
      });
    }
    arenaResult = await arena.run({ prompt, models, onProgress });
  } catch (err) {
    return { ok: false, error: `多模型扇出失败: ${err && err.message ? err.message : String(err)}` };
  }

  const entries = (arenaResult && arenaResult.entries) || [];
  const references = normalizeReferences(entries);
  if (references.length === 0) {
    return {
      ok: false,
      error: '所有参考模型均失败或无有效回答',
      arenaId: arenaResult && arenaResult.arenaId,
    };
  }

  // 2) synthesize.
  const aggModel = aggregatorModel || references[0].model;
  const aggPrompt = buildAggregatorPrompt({ question: prompt, references });
  const finalAnswer = await _callAggregator(gateway, aggModel, aggPrompt);

  if (!finalAnswer) {
    return {
      ok: false,
      error: 'aggregator 合成失败(聚合模型无输出)',
      references,
      aggregatorModel: aggModel,
      arenaId: arenaResult && arenaResult.arenaId,
    };
  }

  return {
    ok: true,
    references,
    finalAnswer,
    aggregatorModel: aggModel,
    arenaId: arenaResult && arenaResult.arenaId,
  };
}

module.exports = {
  runMoa,
  _moaEnabled,
};

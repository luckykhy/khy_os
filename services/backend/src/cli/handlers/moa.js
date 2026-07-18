'use strict';

/**
 * CLI handler for the MoA command — Mixture-of-Agents.
 *
 * Fans a prompt out to several reference models, then an aggregator model
 * synthesizes a single final answer from all of them.
 *
 * Usage:
 *   /moa "Implement quicksort" --models gpt-4,claude-sonnet,qwen-max
 *   /moa "..." --models a,b --aggregator claude-sonnet
 *
 * @module handlers/moa
 */

const moaService = require('../../services/moaService');

/**
 * Handle the moa command.
 * @param {string} input - prompt (+ flags) or 'help'
 * @param {object} deps
 * @param {object} deps.chalk
 * @param {object} [deps.options]
 */
async function handleMoa(input, deps) {
  const c = (deps && deps.chalk) || require('chalk');
  const options = (deps && deps.options) || {};

  if (!input || input === 'help') {
    _printHelp(c);
    return;
  }

  // Reference models from --models, else fall back to gateway defaults.
  let models = [];
  if (options.models) {
    models = String(options.models).split(',').map((m) => m.trim()).filter(Boolean);
  }
  const gateway = _resolveGateway();
  if (models.length === 0) models = _getDefaultModels(gateway);

  if (models.length < 2) {
    console.log(c.yellow('  MoA 需要至少 2 个参考模型。用 --models model1,model2 指定。'));
    console.log(c.dim('  可用模型: /models'));
    return;
  }

  // Prompt = input minus any flags.
  const prompt = String(input).replace(/--\w+\s+\S+/g, '').trim();
  if (!prompt) {
    console.log(c.yellow('  请提供一个问题(prompt)。'));
    return;
  }

  console.log('');
  console.log(c.bold(`  MoA: ${models.length} 个参考模型并行 → aggregator 合成`));
  models.forEach((m) => console.log(c.dim(`    • ${m}`)));
  console.log('');

  const result = await moaService.runMoa({
    prompt,
    models,
    aggregatorModel: options.aggregator || options.agg || undefined,
    gateway,
    timeoutMs: options.timeout ? parseInt(options.timeout, 10) * 1000 : undefined,
  });

  if (result.disabled) {
    console.log(c.dim(`  ${result.message}`));
    return;
  }
  if (!result.ok) {
    console.log(c.red(`  MoA 失败: ${result.error}`));
    return;
  }

  if (options.verbose) {
    for (const ref of result.references) {
      console.log(c.bold(`  ── 参考: ${ref.model} ──`));
      console.log(ref.content.split('\n').map((l) => `    ${l}`).join('\n'));
      console.log('');
    }
  } else {
    console.log(c.dim(`  参考模型 ${result.references.length} 个(--verbose 查看各自回答)`));
    console.log('');
  }

  console.log(c.bold(`  ✅ 合成答案 (aggregator: ${result.aggregatorModel}):`));
  console.log('');
  console.log(result.finalAnswer.split('\n').map((l) => `  ${l}`).join('\n'));
  console.log('');
}

function _resolveGateway() {
  try {
    return require('../../services/gateway/aiGateway');
  } catch {
    return null;
  }
}

function _getDefaultModels(gateway) {
  try {
    const gw = gateway;
    if (gw && typeof gw.listModels === 'function') {
      const models = gw.listModels();
      if (Array.isArray(models) && models.length >= 2) {
        return models.slice(0, 3).map((m) => m.id || m.name || m);
      }
    }
    if (gw && typeof gw.getAvailableModels === 'function') {
      const models = gw.getAvailableModels();
      if (Array.isArray(models) && models.length >= 2) {
        return models.slice(0, 3).map((m) => m.id || m.name || m);
      }
    }
  } catch { /* ignore */ }
  return [];
}

function _printHelp(c) {
  console.log('');
  console.log(c.bold('  MoA — Mixture-of-Agents(多模型合成)'));
  console.log('');
  console.log('  用法:');
  console.log(c.dim('    /moa "你的问题" --models model1,model2,model3'));
  console.log(c.dim('    /moa "..." --models a,b --aggregator <合成模型>'));
  console.log('');
  console.log('  选项:');
  console.log(c.dim('    --models <list>     逗号分隔的参考模型'));
  console.log(c.dim('    --aggregator <m>    合成最终答案的模型(默认取第一个参考模型)'));
  console.log(c.dim('    --verbose           显示各参考模型的原始回答'));
  console.log('');
}

module.exports = { handleMoa };

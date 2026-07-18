'use strict';

/**
 * CLI handler for the Arena command — run a prompt against multiple models.
 *
 * Usage:
 *   /arena "Implement quicksort" --models gpt-4,claude-sonnet,qwen-max
 *   /arena compare --models gpt-4,claude-sonnet
 *
 * @module handlers/arena
 */

const { ArenaManager, formatArenaResult } = require('../../services/arenaManager');

/**
 * Handle arena command.
 *
 * @param {string} input - The prompt or subcommand
 * @param {object} deps
 * @param {object} deps.aiModule - AI gateway module
 * @param {object} deps.chalk - Chalk instance
 * @param {object} [deps.options] - Parsed CLI options
 * @returns {Promise<void>}
 */
async function handleArena(input, deps) {
  const { aiModule, chalk: c } = deps;
  const options = deps.options || {};

  if (!input || input === 'help') {
    _printHelp(c);
    return;
  }

  // ── Subcommands ─────────────────────────────────────────────────
  const subcommand = input.split(/\s+/)[0].toLowerCase();

  if (subcommand === 'history') {
    return _handleHistory(c, options);
  }
  if (subcommand === 'leaderboard' || subcommand === 'lb') {
    return _handleLeaderboard(c, options);
  }
  if (subcommand === 'show') {
    const arenaId = input.split(/\s+/)[1];
    return _handleShow(c, arenaId);
  }

  // Parse models from --models flag or from config
  let models = [];
  if (options.models) {
    models = options.models.split(',').map((m) => m.trim()).filter(Boolean);
  }

  // Default: use 2-3 available models
  if (models.length === 0) {
    models = _getDefaultModels(aiModule);
  }

  if (models.length < 2) {
    console.log(c.yellow('  Arena requires at least 2 models. Use --models model1,model2'));
    console.log(c.dim('  Available models can be listed with: /models'));
    return;
  }

  // Extract prompt (everything that's not a flag)
  const prompt = input.replace(/--\w+\s+\S+/g, '').trim();
  if (!prompt) {
    console.log(c.yellow('  Please provide a prompt for the arena comparison.'));
    return;
  }

  console.log('');
  console.log(c.bold(`  Starting Arena with ${models.length} models...`));
  models.forEach((m) => console.log(c.dim(`    • ${m}`)));
  console.log('');

  // Create arena manager
  const gateway = aiModule.gateway || aiModule;
  const arena = new ArenaManager(gateway, {
    timeoutMs: options.timeout ? parseInt(options.timeout, 10) * 1000 : 60_000,
  });

  // Progress tracking
  const progress = {};
  const onProgress = (model, event) => {
    if (!progress[model]) progress[model] = { chunks: 0, chars: 0 };
    if (event.type === 'chunk') {
      progress[model].chunks++;
      progress[model].chars += (event.content || '').length;
      // Update spinner
      if (progress[model].chunks % 10 === 0) {
        const total = Object.entries(progress)
          .map(([m, p]) => `${m.split('/').pop()}: ${p.chars}ch`)
          .join(', ');
        process.stdout.write(`\r  ${c.dim(`Receiving... ${total}`)}`);
      }
    }
  };

  try {
    const result = await arena.run({
      prompt,
      models,
      system: options.system || undefined,
      maxTokens: options.maxTokens ? parseInt(options.maxTokens, 10) : undefined,
      temperature: options.temperature ? parseFloat(options.temperature) : undefined,
      onProgress,
    });

    // Clear progress line
    process.stdout.write('\r' + ' '.repeat(120) + '\r');

    // Print formatted result
    console.log(formatArenaResult(result, { chalk: c }));

    // Print individual responses if --verbose
    if (options.verbose) {
      for (const entry of result.entries) {
        if (entry.failed) continue;
        console.log(c.bold(`  ── ${entry.model} ──`));
        console.log('');
        // Indent each line
        const indented = entry.content.split('\n').map((l) => `    ${l}`).join('\n');
        console.log(indented);
        console.log('');
      }
    } else {
      console.log(c.dim('  Use --verbose to see individual model responses.'));
    }
  } catch (err) {
    console.log(c.red(`  Arena failed: ${err.message}`));
  }
}

/**
 * Get default models from the gateway configuration.
 * @param {object} aiModule
 * @returns {string[]}
 */
function _getDefaultModels(aiModule) {
  try {
    // Try to get available models from gateway
    const gw = aiModule.gateway || aiModule;
    if (typeof gw.listModels === 'function') {
      const models = gw.listModels();
      if (Array.isArray(models) && models.length >= 2) {
        return models.slice(0, 3).map((m) => m.id || m.name || m);
      }
    }
    if (typeof gw.getAvailableModels === 'function') {
      const models = gw.getAvailableModels();
      if (Array.isArray(models) && models.length >= 2) {
        return models.slice(0, 3).map((m) => m.id || m.name || m);
      }
    }
  } catch { /* ignore */ }

  return [];
}

/**
 * Print help for the arena command.
 */
function _printHelp(c) {
  console.log('');
  console.log(c.bold('  Arena — Multi-model comparison'));
  console.log('');
  console.log('  Usage:');
  console.log(c.dim('    /arena "Your prompt here" --models model1,model2,model3'));
  console.log(c.dim('    /arena history                List past arena runs'));
  console.log(c.dim('    /arena leaderboard            Model rankings across all runs'));
  console.log(c.dim('    /arena show <arenaId>          Re-display a past result'));
  console.log('');
  console.log('  Options:');
  console.log(c.dim('    --models <list>      Comma-separated model identifiers'));
  console.log(c.dim('    --system <prompt>    System prompt override'));
  console.log(c.dim('    --maxTokens <n>      Max tokens per response'));
  console.log(c.dim('    --temperature <n>    Temperature (0-2)'));
  console.log(c.dim('    --timeout <s>        Per-model timeout in seconds (default: 60)'));
  console.log(c.dim('    --verbose            Show individual model responses'));
  console.log('');
  console.log('  Examples:');
  console.log(c.dim('    /arena "Implement quicksort" --models gpt-4,claude-sonnet'));
  console.log(c.dim('    /arena history'));
  console.log(c.dim('    /arena leaderboard'));
  console.log('');
}

/**
 * Handle /arena history — list past arena runs.
 */
function _handleHistory(c, options) {
  try {
    const store = require('../../services/arenaResultStore');
    const limit = options.limit ? parseInt(options.limit, 10) : 20;
    const results = store.listResults({ limit });

    if (results.length === 0) {
      console.log(c.yellow('  No arena results found.'));
      return;
    }

    console.log('');
    console.log(c.bold(`  Arena History (${results.length} runs)`));
    console.log('');

    for (const r of results) {
      const date = new Date(r.savedAt).toLocaleString();
      const models = r.models.join(', ');
      const prompt = r.prompt.length > 50 ? r.prompt.slice(0, 47) + '...' : r.prompt;
      console.log(`  ${c.cyan(r.arenaId)}  ${c.dim(date)}`);
      console.log(`    Models: ${models}`);
      console.log(`    Prompt: ${prompt}`);
      if (r.recommendation) {
        console.log(`    Winner: ${c.green(r.recommendation)}`);
      }
      console.log('');
    }
  } catch (err) {
    console.log(c.red(`  Failed to load history: ${err.message}`));
  }
}

/**
 * Handle /arena leaderboard — aggregated model rankings.
 */
function _handleLeaderboard(c, options) {
  try {
    const store = require('../../services/arenaResultStore');
    const lb = store.getLeaderboard({
      minGames: options.minGames ? parseInt(options.minGames, 10) : 1,
    });

    if (lb.length === 0) {
      console.log(c.yellow('  No leaderboard data. Run some arena comparisons first.'));
      return;
    }

    console.log('');
    console.log(c.bold('  Arena Leaderboard'));
    console.log('');
    console.log(c.dim('  Rank  Model                    Score  Wins  Games  Latency    Fail%'));
    console.log(c.dim('  ────  ───────────────────────  ─────  ────  ─────  ─────────  ─────'));

    lb.forEach((entry, i) => {
      const rank = String(i + 1).padStart(4);
      const model = entry.model.padEnd(23).slice(0, 23);
      const score = String(entry.avgScore).padStart(5);
      const wins = String(entry.wins).padStart(4);
      const games = String(entry.games).padStart(5);
      const latency = `${entry.avgLatencyMs}ms`.padStart(9);
      const fail = `${entry.failRate}%`.padStart(5);
      const line = `  ${rank}  ${model}  ${score}  ${wins}  ${games}  ${latency}  ${fail}`;
      console.log(i === 0 ? c.green(line) : line);
    });
    console.log('');
  } catch (err) {
    console.log(c.red(`  Failed to load leaderboard: ${err.message}`));
  }
}

/**
 * Handle /arena show <arenaId> — re-display a past result.
 */
function _handleShow(c, arenaId) {
  if (!arenaId) {
    console.log(c.yellow('  Usage: /arena show <arenaId>'));
    return;
  }

  try {
    const store = require('../../services/arenaResultStore');
    const result = store.loadResult(arenaId);

    if (!result) {
      console.log(c.yellow(`  Arena result "${arenaId}" not found.`));
      return;
    }

    console.log(formatArenaResult(result, { chalk: c }));
  } catch (err) {
    console.log(c.red(`  Failed to load result: ${err.message}`));
  }
}

module.exports = { handleArena };

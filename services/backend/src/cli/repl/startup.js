/**
 * Startup-time model selection + menu-result dispatch.
 *
 * Extracted verbatim from cli/repl.js as part of the behavior-preserving
 * god-file split. These two routines run once at REPL startup / from the
 * interactive menu; they are not on the hot streaming path.
 *
 * Lazy module accessors (chalk/inquirer/fmt/ai) are duplicated here as local
 * caches. Per the split plan, the require cache is a per-module performance
 * optimization — a second cache holds the same singletons Node already
 * memoizes, so behavior is unchanged. Handler modules are require()'d lazily
 * inside each case exactly as the original did, so dispatch side effects and
 * load ordering are preserved.
 */
let _chalk, _inquirer, _formatters, _ai;
const chalk = () => {
  if (_chalk) return _chalk;
  const chalkModule = require('chalk');
  _chalk = chalkModule.default || chalkModule;
  return _chalk;
};
const inquirer = () => (_inquirer ??= require('inquirer'));
const fmt = () => (_formatters ??= require('../formatters'));
const ai = () => (_ai ??= require('../ai'));

async function offerModelSelection() {
  const c = chalk();
  try {
    const aiGateway = require('../../services/gateway/aiGateway');

    // Quick sync detection of available adapters
    const allStatus = aiGateway.getStatus();
    const availableAdapters = allStatus.filter(s => s.enabled && s.available);

    if (availableAdapters.length === 0) return;

    // Gather models from all available adapters via gateway.listModels
    const modelChoices = [];
    for (const adapter of availableAdapters) {
      try {
        const models = await aiGateway.listModels(adapter.type);
        if (models && models.length > 0) {
          for (const model of models) {
            modelChoices.push({
              name: `${adapter.name} → ${model.name || model.id}${model.isDefault ? ' (默认)' : ''}`,
              value: { adapter: adapter.type, model: model.id },
            });
          }
        } else {
          // Adapter without model list — add as single entry
          modelChoices.push({
            name: `${adapter.name}`,
            value: { adapter: adapter.type, model: null },
          });
        }
      } catch {
        // listModels not supported — add as single entry
        modelChoices.push({
          name: `${adapter.name}`,
          value: { adapter: adapter.type, model: null },
        });
      }
    }

    if (modelChoices.length <= 1) return; // No choice needed

    // Check if user has a saved preference — skip selection if so
    const currentAdapter = process.env.GATEWAY_PREFERRED_ADAPTER;
    const currentModel = process.env.GATEWAY_PREFERRED_MODEL;
    if (currentAdapter && currentModel) {
      // Already configured, show current and offer quick switch
      // Claude Code style: model info is shown in banner, not a separate line
      return;
    }

    // Show interactive selection
    const inq = inquirer();
    console.log('');
    const { selected } = await inq.prompt([{
      type: 'list',
      name: 'selected',
      message: '选择 AI 模型 (上下箭头选择，回车确认，Esc跳过):',
      choices: [
        ...modelChoices,
        { name: c.dim('────────────'), value: '__skip_sep__', disabled: true },
        { name: '跳过 (稍后用 khy gateway model 设置)', value: null },
      ],
      pageSize: 10,
    }]);

    if (selected) {
      process.env.GATEWAY_PREFERRED_ADAPTER = selected.adapter;
      process.env.GATEWAY_PREFERRED_STRICT = 'true';
      if (selected.model) process.env.GATEWAY_PREFERRED_MODEL = selected.model;
      try { await aiGateway.refreshAdapters(); } catch { /* best effort */ }
      fmt().printSuccess(`已选择: ${selected.adapter}${selected.model ? '/' + selected.model : ''}`);
    }

    // Ensure stdin is resumed after inquirer closes its readline
    // inquirer may pause stdin which prevents our readline from working
    try { process.stdin.resume(); } catch { /* ignore */ }
    try {
      if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function' && !process.stdin.isRaw) {
        process.stdin.setRawMode(true);
      }
    } catch { /* ignore */ }
  } catch (e) {
    // B4: 模型选择恢复失败日志，便于诊断终端无响应
    try { console.error('[repl] 模型选择/stdin 恢复失败:', e?.message); } catch {}
    try { process.stdin.resume(); } catch { /* ignore */ }
    try {
      if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function' && !process.stdin.isRaw) {
        process.stdin.setRawMode(true);
      }
    } catch { /* ignore */ }
  }
}

/**
 * Execute a menu result by mapping it back to command handlers.
 */
async function executeMenuResult(result) {
  if (!result) return;

  switch (result.action) {
    case 'quote': {
      const { handleQuote } = require('../handlers/data');
      await handleQuote(result.symbol);
      break;
    }
    case 'backtest-run': {
      const { handleBacktestRun } = require('../handlers/backtest');
      await handleBacktestRun(result.symbol, {
        strategy: result.strategy,
        start: result.start,
        end: result.end,
        capital: result.capital,
      });
      break;
    }
    case 'data-fetch': {
      const { handleDataFetch } = require('../handlers/data');
      await handleDataFetch(result.symbol);
      break;
    }
    case 'data-list': {
      const { handleDataList } = require('../handlers/data');
      await handleDataList();
      break;
    }
    case 'cache-clear': {
      const { handleCacheClear } = require('../handlers/data');
      await handleCacheClear();
      break;
    }
    case 'server-start': {
      const { handleServerStart } = require('../handlers/service');
      await handleServerStart();
      break;
    }
    case 'server-status': {
      const { handleServerStatus } = require('../handlers/service');
      await handleServerStatus();
      break;
    }
    case 'db-init': {
      const { handleDbInit } = require('../handlers/service');
      await handleDbInit();
      break;
    }
    case 'db-seed': {
      const { handleDbSeed } = require('../handlers/service');
      await handleDbSeed();
      break;
    }
    case 'db-status': {
      const { handleDbStatus } = require('../handlers/service');
      await handleDbStatus();
      break;
    }
    case 'app-list': {
      const { handleApp } = require('../handlers/app');
      await handleApp('list', [], {});
      break;
    }
    case 'app-status': {
      const { handleApp } = require('../handlers/app');
      await handleApp('status', [], {});
      break;
    }
    case 'app-start': {
      const { handleApp } = require('../handlers/app');
      await handleApp('start', [result.appName], {});
      break;
    }
    case 'app-stop': {
      const { handleApp } = require('../handlers/app');
      await handleApp('stop', [result.appName], {});
      break;
    }
    case 'ai-status':
      await ai().handleAiStatus();
      break;
    case 'ai-config':
      await ai().handleAiConfig();
      break;
    case 'doctor': {
      const { handleDoctor } = require('../handlers/init');
      await handleDoctor();
      break;
    }
    case 'gateway-status': {
      const { handleGatewayStatus } = require('../handlers/gateway');
      await handleGatewayStatus();
      break;
    }
    case 'gateway-config': {
      const { handleGatewayConfig } = require('../handlers/gateway');
      await handleGatewayConfig();
      break;
    }
    case 'gateway-relay': {
      const { handleGatewayRelay } = require('../handlers/gateway');
      await handleGatewayRelay();
      break;
    }
    case 'gateway-select-model': {
      const { handleGatewaySelectModel } = require('../handlers/gateway');
      await handleGatewaySelectModel();
      break;
    }
    case 'docs-quickstart': {
      const { handleDocsQuickstart } = require('../handlers/docs');
      await handleDocsQuickstart();
      break;
    }
    case 'docs-ai-fastlane': {
      const { handleDocsAiFastlane } = require('../handlers/docs');
      await handleDocsAiFastlane();
      break;
    }
    case 'docs-ai-fastlane-copy': {
      const { handleDocsAiFastlane } = require('../handlers/docs');
      await handleDocsAiFastlane(['copy']);
      break;
    }
    case 'docs-claude': {
      const { handleDocsClaude } = require('../handlers/docs');
      await handleDocsClaude();
      break;
    }
    case 'docs-gateway': {
      const { handleDocsGateway } = require('../handlers/docs');
      await handleDocsGateway();
      break;
    }
    case 'docs-strategy': {
      const { handleDocsStrategy } = require('../handlers/docs');
      await handleDocsStrategy();
      break;
    }
    case 'docs-faq': {
      const { handleDocsFaq } = require('../handlers/docs');
      await handleDocsFaq();
      break;
    }
  }
}

module.exports = {
  offerModelSelection,
  executeMenuResult,
};

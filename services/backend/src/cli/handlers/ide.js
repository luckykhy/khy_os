/**
 * IDE / agent-backend command handlers — kiro, cursor, claude, codex, trae,
 * opencode, warp, vscode, windsurf.
 *
 * The launchable set is declared in agentLauncherRegistry (SSOT). Each launcher
 * has a kind:
 *   - 'model-select' : list the adapter's models → user picks one → chat.
 *   - 'direct'       : the adapter delegates to the external agent's own
 *                      provider/model (e.g. opencode), so there is no model
 *                      list — go straight to chat.
 */
const chalk = require('chalk').default || require('chalk');
const readline = require('readline');
const { printSuccess, printError, printInfo, printTable, withSpinner } = require('../formatters');
const {
  buildIdeLaunchFeatureKey,
  buildIdeLaunchFeatureLabel,
} = require('../../services/featureKeyBuilder');

/**
 * Handle an agent-backend command: resolve launcher → (list models → select) → chat.
 *
 * @param {string} ideName - 'kiro' | 'cursor' | 'claude' | 'codex' | 'trae' |
 *                           'opencode' | 'warp' | 'vscode' | 'windsurf'
 * @param {object} [options] - { model, list }
 * @param {object} context - { rl } from REPL
 */
async function handleIdeCommand(ideName, options = {}, context = {}) {
  // Resolve against the launcher SSOT. When the KHY_AGENT_LAUNCHERS gate is off,
  // registry-added backends (opencode/warp/vscode/windsurf) no longer resolve —
  // honor that instead of faking a launch. The legacy five always resolve, so
  // their path stays byte-identical to before.
  const { resolveAgentLauncher } = require('../../services/agentLauncherRegistry');
  const launcher = resolveAgentLauncher(ideName);
  if (!launcher) {
    printError(`${ideName} 后端启动器未启用 (KHY_AGENT_LAUNCHERS=off)`);
    return;
  }

  const { requireFeatureAccess } = require('../../services/authGuard');
  const auth = requireFeatureAccess(
    buildIdeLaunchFeatureKey(ideName),
    buildIdeLaunchFeatureLabel(ideName)
  );
  if (!auth.ok) {
    printError(auth.error);
    return;
  }

  const gateway = require('../../services/gateway/aiGateway');
  if (!gateway._initialized) await gateway.init();

  const adapter = gateway.getAdapter(ideName);
  if (!adapter) {
    printError(`未找到 ${ideName} 适配器`);
    return;
  }

  // Check availability
  const status = adapter.getStatus();
  if (!status.available) {
    // 未安装 → 交互确认装便携版(claude/codex/opencode),装成功即复检继续本次启动。
    // 门 KHY_PORTABLE_CLI_AUTOINSTALL 关 / 非交互 / 非便携工具 → 走原报错路径。
    let recovered = false;
    try {
      const { maybeAutoInstallPortable } = require('./_portableAutoInstall');
      const r = await maybeAutoInstallPortable(ideName, adapter, {
        rl: context.rl,
        io: { info: printInfo, warn: printError },
      });
      recovered = !!(r && r.available);
    } catch { recovered = false; }
    if (!recovered) {
      printError(`${status.name} 不可用: ${status.detail}`);
      return;
    }
  }

  // Direct launchers (e.g. opencode) have no model list — the external agent
  // manages its own provider/model. Go straight to chat.
  if (launcher.kind === 'direct') {
    printInfo(`${status.name} 直连模式（由外部 agent 自管模型），输入问题开始对话`);
    await startChat(ideName, null, context);
    return;
  }

  // List models
  let models;
  try {
    models = await withSpinner(`获取 ${status.name} 模型列表...`, () => adapter.listModels());
  } catch (err) {
    printError(`获取模型列表失败: ${err.message}`);
    return;
  }

  if (!models || models.length === 0) {
    printError(`${status.name} 无可用模型`);
    return;
  }

  // If --list flag, just display and return
  if (options.list) {
    displayModelList(status.name, models);
    return;
  }

  // If --model specified, use it directly
  if (options.model) {
    const found = models.find(m => m.id === options.model || m.name === options.model);
    if (!found) {
      printError(`模型 "${options.model}" 不存在`);
      displayModelList(status.name, models);
      return;
    }
    await startChat(ideName, found, context);
    return;
  }

  // Interactive model selection
  displayModelList(status.name, models);

  const selected = await promptModelSelection(models, context);
  if (!selected) return;

  await startChat(ideName, selected, context);
}

/**
 * Display model list as a table.
 */
function displayModelList(adapterName, models) {
  console.log('');
  console.log(`  ${chalk.cyan.bold(adapterName)} 可用模型`);
  console.log('');
  printTable(
    ['#', '模型 ID', '名称', '默认'],
    models.map((m, i) => [
      String(i + 1),
      m.id,
      m.name || m.id,
      m.isDefault ? chalk.green('✓') : '',
    ])
  );
  console.log('');
}

/**
 * Prompt user to select a model by number.
 */
function promptModelSelection(models, context) {
  return new Promise((resolve) => {
    const rl = context.rl || readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const ownRl = !context.rl;

    rl.question(chalk.cyan('选择模型编号 (输入数字，回车取消): '), (answer) => {
      if (ownRl) rl.close();

      const num = parseInt(answer, 10);
      if (isNaN(num) || num < 1 || num > models.length) {
        if (answer.trim()) printError('无效选择');
        resolve(null);
        return;
      }
      resolve(models[num - 1]);
    });
  });
}

/**
 * Start a chat session with the selected model.
 *
 * @param {string} adapterKey - gateway adapter driving the session
 * @param {object|null} model - selected model, or null for a direct launcher
 *                              (the external agent picks its own model)
 * @param {object} context - { rl } from REPL
 */
async function startChat(adapterKey, model, context) {
  const gateway = require('../../services/gateway/aiGateway');

  if (model) {
    printSuccess(`已选择 ${model.name || model.id}，输入问题开始对话 (输入 exit 退出)`);
  } else {
    printSuccess(`已连接 ${adapterKey}，输入问题开始对话 (输入 exit 退出)`);
  }
  console.log('');

  const rl = context.rl || readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const ownRl = !context.rl;

  const prompt = () => {
    rl.question(chalk.gray(`[${adapterKey}] > `), async (input) => {
      const trimmed = input.trim();
      if (!trimmed || trimmed === 'exit' || trimmed === 'quit') {
        printInfo('退出 IDE 对话模式');
        if (ownRl) rl.close();
        return;
      }

      try {
        // Drive the specific adapter. Model-select launchers pin the chosen
        // model; direct launchers (model === null) let the external agent
        // choose, so we omit the model option.
        const genOptions = {
          onChunk: (chunk) => {
            if (chunk.type === 'text') process.stdout.write(chunk.text);
          },
        };
        if (model && model.id) genOptions.model = model.id;
        const result = await gateway.generateWithAdapter(adapterKey, trimmed, genOptions);

        if (result.success) {
          // Only print newline if streaming was used (content already output)
          if (!result.content) console.log('');
          else console.log('\n' + result.content);
        } else {
          printError('请求失败: ' + (result.attempts?.[0]?.error || '未知错误'));
        }
      } catch (err) {
        printError(err.message);
      }

      console.log('');
      prompt();
    });
  };

  prompt();
}

module.exports = { handleIdeCommand };

/**
 * Interactive menu system.
 * Uses selectMenu (inkComponents) by default, inquirer as fallback.
 */
let _inquirer;
const inq = () => (_inquirer ??= require('inquirer'));
const { printInfo } = require('./formatters');
let _selectMenu;
const getSelectMenu = () => {
  if (!_selectMenu) {
    try { _selectMenu = require('./ui/inkComponents').selectMenu; } catch { _selectMenu = null; }
  }
  return _selectMenu;
};
const { isLegacyWinTerminal } = require('../tools/platformUtils');
const _lw = isLegacyWinTerminal();

// 旧版 Windows 终端无法渲染 emoji，降级为 ASCII 标记
const _e = (emoji, ascii) => _lw ? ascii : emoji;

const sep = (label = '────────────') => ({ name: label, value: `__sep_${Date.now()}_${Math.random()}`, disabled: true });

async function showMainMenu() {
  const sm = getSelectMenu();
  if (sm && process.stdin.isTTY && process.stdout.isTTY) {
    // 使用统一选择器（无依赖，原生渲染）
    const result = await sm({
      message: '请选择操作:',
      choices: [
        { name: `${_e('⚙️ ', '[S] ')}系统管理`,       value: 'system',    description: '服务/数据库/初始化' },
        { name: `${_e('📦', '[A]')} 应用管理`,        value: 'app',       description: '安装/启停/状态' },
        { name: `${_e('🌐', '[G]')} AI 网关 / 中转`,  value: 'gateway',   description: '模型路由/配置' },
        { name: `${_e('🤖', '[I]')} AI 助手设置`,     value: 'ai',        description: 'AI 配置与权限' },
        { name: `${_e('🧠', '[T]')} 模型训练 / 导出`,  value: 'training',  description: '训练/微调/导出' },
        { name: `${_e('📚', '[D]')} 教程文档`,        value: 'docs' },
        { name: `${_e('🔧', '[X]')} 环境诊断`,        value: 'doctor' },
        { name: `${_e('📈', '[Q]')} 实时行情查询`,     value: 'quote',     description: 'khyquant' },
        { name: `${_e('📊', '[B]')} 策略回测`,        value: 'backtest',  description: 'khyquant' },
        { name: `${_e('💾', '[M]')} 数据管理`,        value: 'data',      description: 'khyquant' },
        { name: `${_e('↩️ ', '[R] ')}返回命令行`,      value: 'back' },
      ],
    });
    return result || 'back';
  }

  // Fallback: inquirer list
  const { action } = await inq().prompt([{
    type: 'list',
    name: 'action',
    message: '请选择操作:',
    choices: [
      sep(_lw ? '-------- 平台核心 --------' : '──────── 平台核心 ────────'),
      { name: `${_e('⚙️ ', '[S] ')}系统管理`, value: 'system' },
      { name: `${_e('📦', '[A]')} 应用管理`, value: 'app' },
      { name: `${_e('🌐', '[G]')} AI 网关 / 中转`, value: 'gateway' },
      { name: `${_e('🤖', '[I]')} AI 助手设置`, value: 'ai' },
      { name: `${_e('🧠', '[T]')} 模型训练 / 导出`, value: 'training' },
      { name: `${_e('📚', '[D]')} 教程文档`, value: 'docs' },
      { name: `${_e('🔧', '[X]')} 环境诊断`, value: 'doctor' },
      sep(_lw ? '------ 默认应用 khyquant ------' : '────── 默认应用 khyquant ──────'),
      { name: `${_e('📈', '[Q]')} 实时行情查询`, value: 'quote' },
      { name: `${_e('📊', '[B]')} 策略回测`, value: 'backtest' },
      { name: `${_e('💾', '[M]')} 数据管理`, value: 'data' },
      sep(),
      { name: `${_e('↩️ ', '[R] ')}返回命令行`, value: 'back' },
    ],
  }]);
  return action;
}

async function showQuoteMenu() {
  const userProfile = require('../services/userProfile');
  const suggested = userProfile.getSuggestedSymbols(1);
  const defaultSymbol = suggested[0] || 'sh600519';

  const { symbol } = await inq().prompt([{
    type: 'input',
    name: 'symbol',
    message: '输入股票/期货代码:',
    default: defaultSymbol,
    validate: v => v.trim().length > 0 || '请输入代码',
  }]);
  return { action: 'quote', symbol };
}

async function showBacktestMenu() {
  const { Strategy } = require('../models');
  const userProfile = require('../services/userProfile');
  let strategies = [];
  try {
    strategies = await Strategy.findAll({ order: [['id', 'ASC']], raw: true });
  } catch { /* DB not ready */ }

  const strategyChoices = strategies.length > 0
    ? strategies.map(s => ({ name: `[${s.id}] ${s.name}`, value: String(s.id) }))
    : [{ name: '(无可用策略)', value: null }];

  const suggested = userProfile.getSuggestedSymbols(1);
  const defaultSymbol = suggested[0] || 'sh000300';
  const defaultCapital = String(userProfile.getDefaultCapital());

  const answers = await inq().prompt([
    {
      type: 'input',
      name: 'symbol',
      message: '回测品种代码:',
      default: defaultSymbol,
    },
    {
      type: 'list',
      name: 'strategy',
      message: '选择策略:',
      choices: strategyChoices,
    },
    {
      type: 'input',
      name: 'start',
      message: '开始日期:',
      default: '2024-01-01',
    },
    {
      type: 'input',
      name: 'end',
      message: '结束日期:',
      default: new Date().toISOString().slice(0, 10),
    },
    {
      type: 'input',
      name: 'capital',
      message: '初始资金:',
      default: defaultCapital,
    },
  ]);

  return { action: 'backtest-run', ...answers };
}

async function showDataMenu() {
  const { action } = await inq().prompt([{
    type: 'list',
    name: 'action',
    message: '数据管理:',
    choices: [
      { name: '下载K线数据', value: 'data-fetch' },
      { name: '查看品种列表', value: 'data-list' },
      { name: '清理缓存', value: 'cache-clear' },
      sep(),
      { name: '↩️  返回主菜单', value: 'back' },
    ],
  }]);

  if (action === 'data-fetch') {
    const { symbol } = await inq().prompt([{
      type: 'input',
      name: 'symbol',
      message: '输入品种代码:',
      default: 'sh000001',
    }]);
    return { action, symbol };
  }

  return { action };
}

async function showSystemMenu() {
  const { action } = await inq().prompt([{
    type: 'list',
    name: 'action',
    message: '系统管理:',
    choices: [
      { name: '启动后端服务', value: 'server-start' },
      { name: '查看服务状态', value: 'server-status' },
      { name: '初始化数据库', value: 'db-init' },
      { name: '填充示例数据', value: 'db-seed' },
      { name: '查看数据库状态', value: 'db-status' },
      sep(),
      { name: '↩️  返回主菜单', value: 'back' },
    ],
  }]);
  return { action };
}

async function showAppMenu() {
  const { action } = await inq().prompt([{
    type: 'list',
    name: 'action',
    message: '应用管理:',
    choices: [
      { name: '查看已安装应用', value: 'app-list' },
      { name: '查看应用运行状态', value: 'app-status' },
      { name: '启动应用', value: 'app-start' },
      { name: '停止应用', value: 'app-stop' },
      sep(),
      { name: '↩️  返回主菜单', value: 'back' },
    ],
  }]);

  if (action === 'app-start' || action === 'app-stop') {
    const { appName } = await inq().prompt([{
      type: 'input',
      name: 'appName',
      message: '输入应用名:',
      default: 'khyquant',
      validate: v => v.trim().length > 0 || '请输入应用名',
    }]);
    return { action, appName: appName.trim() };
  }

  return { action };
}

async function showAiMenu() {
  const { action } = await inq().prompt([{
    type: 'list',
    name: 'action',
    message: 'AI 助手:',
    choices: [
      { name: '查看AI服务状态', value: 'ai-status' },
      { name: '配置API密钥', value: 'ai-config' },
      sep(),
      { name: '↩️  返回主菜单', value: 'back' },
    ],
  }]);
  return { action };
}

async function showGatewayMenu() {
  const { action } = await inq().prompt([{
    type: 'list',
    name: 'action',
    message: 'AI 网关:',
    choices: [
      { name: '查看网关状态', value: 'gateway-status' },
      { name: '选择 AI 模型', value: 'gateway-select-model' },
      { name: '配置网关参数', value: 'gateway-config' },
      { name: '启动 Web 中转服务', value: 'gateway-relay' },
      sep(),
      { name: '↩️  返回主菜单', value: 'back' },
    ],
  }]);
  return { action };
}

/**
 * Run the full menu loop. Returns the action result for the REPL to execute.
 */
async function runMenuLoop() {
  while (true) {
    const mainAction = await showMainMenu();

    if (mainAction === 'back') return null;

    let result;
    switch (mainAction) {
      case 'quote':
        result = await showQuoteMenu();
        return result;

      case 'backtest':
        result = await showBacktestMenu();
        if (!result.strategy) {
          printInfo('请先运行 db seed 创建示例策略');
          continue;
        }
        return result;

      case 'data': {
        result = await showDataMenu();
        if (result.action === 'back') continue;
        return result;
      }

      case 'system': {
        result = await showSystemMenu();
        if (result.action === 'back') continue;
        return result;
      }

      case 'app': {
        result = await showAppMenu();
        if (result.action === 'back') continue;
        return result;
      }

      case 'ai': {
        result = await showAiMenu();
        if (result.action === 'back') continue;
        return result;
      }

      case 'gateway': {
        result = await showGatewayMenu();
        if (result.action === 'back') continue;
        return result;
      }

      case 'training': {
        result = await showTrainingMenu();
        if (result.action === 'back') continue;
        return result;
      }

      case 'doctor':
        return { action: 'doctor' };

      case 'docs': {
        result = await showDocsMenu();
        if (result.action === 'back') continue;
        return result;
      }
    }
  }
}

async function showTrainingMenu() {
  const chalk = require('chalk').default || require('chalk');
  const training = require('../services/modelTrainingService');

  // Show current training data stats
  const stats = training.getDatasetStats();
  const models = training.listModels();
  const modelCount = Object.keys(models).length;

  console.log('');
  console.log(chalk.cyan.bold('  模型训练与导出'));
  console.log(chalk.dim(`  训练数据: ${stats.total} 条记录 (对话 ${stats.byType.conversation || 0} · 策略 ${stats.byType.strategy || 0} · 反馈 ${stats.byType.feedback || 0})`));
  console.log(chalk.dim(`  已训练模型: ${modelCount} 个`));
  console.log('');

  const { action } = await inq().prompt([{
    type: 'list',
    name: 'action',
    message: '模型训练:',
    choices: [
      { name: '📊 查看训练数据统计', value: 'train-stats' },
      { name: '📦 导出训练数据集', value: 'train-export-data' },
      { name: '🚀 开始训练', value: 'train-start' },
      { name: '📤 导出模型', value: 'train-export-model' },
      { name: '🤗 上传到 HuggingFace', value: 'train-hf-upload' },
      { name: '☁️  上传到 GitHub/Gitee', value: 'train-git-upload' },
      { name: '📋 查看已有模型', value: 'train-list' },
      { name: '💻 查看计算资源', value: 'train-compute' },
      sep(),
      { name: '↩️  返回主菜单', value: 'back' },
    ],
  }]);

  if (action === 'train-stats') {
    return { action: 'train-stats-detail' };
  }

  if (action === 'train-export-data') {
    const { format } = await inq().prompt([{
      type: 'list',
      name: 'format',
      message: '选择导出格式:',
      choices: [
        { name: 'Alpaca (推荐)', value: 'alpaca' },
        { name: 'ShareGPT', value: 'sharegpt' },
        { name: 'OpenAI Fine-tune', value: 'openai' },
      ],
    }]);
    return { action: 'train-export-data', format };
  }

  if (action === 'train-start') {
    const BASE_MODELS = training.BASE_MODELS;
    const { baseModel } = await inq().prompt([{
      type: 'list',
      name: 'baseModel',
      message: '选择基础模型:',
      choices: Object.entries(BASE_MODELS).map(([key, m]) => ({
        name: `${key} (${m.size}, VRAM ${m.vram})`,
        value: key,
      })),
    }]);
    const { preset } = await inq().prompt([{
      type: 'list',
      name: 'preset',
      message: '训练强度:',
      choices: [
        { name: '快速 (1 epoch, ~10min)', value: 'quick' },
        { name: '标准 (3 epochs, ~30min)', value: 'standard' },
        { name: '精细 (5 epochs, ~1h)', value: 'thorough' },
      ],
    }]);
    return { action: 'train-start', baseModel, preset };
  }

  if (action === 'train-export-model') {
    const registry = training.listModels();
    const modelNames = Object.keys(registry);
    if (modelNames.length === 0) {
      printInfo('暂无已训练模型，请先训练');
      return { action: 'back' };
    }
    const { modelName } = await inq().prompt([{
      type: 'list',
      name: 'modelName',
      message: '选择要导出的模型:',
      choices: modelNames.map(n => ({ name: `${n} (${registry[n].method || 'lora'})`, value: n })),
    }]);
    // Model export is no longer password-gated.
    const { exportFormat } = await inq().prompt([{
      type: 'list',
      name: 'exportFormat',
      message: '导出格式:',
      choices: [
        { name: 'GGUF (Ollama / llama.cpp)', value: 'gguf' },
        { name: 'Safetensors (HuggingFace / vLLM)', value: 'safetensors' },
      ],
    }]);
    return { action: 'train-export-model', modelName, password: '', exportFormat };
  }

  if (action === 'train-hf-upload') {
    const registry = training.listModels();
    const modelNames = Object.keys(registry);
    if (modelNames.length === 0) {
      printInfo('暂无已训练模型');
      return { action: 'back' };
    }
    const { modelName } = await inq().prompt([{
      type: 'list',
      name: 'modelName',
      message: '选择要上传的模型:',
      choices: modelNames,
    }]);
    const { repoId } = await inq().prompt([{
      type: 'input',
      name: 'repoId',
      message: 'HuggingFace 仓库 ID (user/repo):',
      validate: v => v.includes('/') ? true : '格式: username/model-name',
    }]);
    // Model upload is no longer password-gated.
    return { action: 'train-hf-upload', modelName, repoId, password: '' };
  }

  if (action === 'train-git-upload') {
    const registry = training.listModels();
    const modelNames = Object.keys(registry);
    if (modelNames.length === 0) {
      printInfo('暂无已训练模型');
      return { action: 'back' };
    }
    const { modelName } = await inq().prompt([{
      type: 'list',
      name: 'modelName',
      message: '选择要上传的模型:',
      choices: modelNames,
    }]);
    const { platform } = await inq().prompt([{
      type: 'list',
      name: 'platform',
      message: '上传平台:',
      choices: [
        { name: 'GitHub (私人仓库)', value: 'github' },
        { name: 'Gitee (私人仓库)', value: 'gitee' },
      ],
    }]);
    const { repo } = await inq().prompt([{
      type: 'input',
      name: 'repo',
      message: '仓库名称:',
      default: 'khy-models',
    }]);
    // Model upload is no longer password-gated.
    return { action: 'train-git-upload', modelName, platform, repo, password: '' };
  }

  return { action };
}

async function showDocsMenu() {
  const { action } = await inq().prompt([{
    type: 'list',
    name: 'action',
    message: '📚 教程文档:',
    choices: [
      { name: '🚀 快速开始 (5分钟上手)', value: 'docs-quickstart' },
      { name: '⚡ AI 快速通道 (免全仓扫描)', value: 'docs-ai-fastlane' },
      { name: '📋 AI 快速通道一键复制', value: 'docs-ai-fastlane-copy' },
      { name: '📖 Claude Code 使用教程', value: 'docs-claude' },
      { name: '🤖 AI 网关使用指南', value: 'docs-gateway' },
      { name: '📊 量化策略入门', value: 'docs-strategy' },
      { name: '🔧 常见问题 FAQ', value: 'docs-faq' },
      sep(),
      { name: '↩️  返回主菜单', value: 'back' },
    ],
  }]);
  return { action };
}

module.exports = { runMenuLoop };

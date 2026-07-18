'use strict';

/**
 * gatewayConfigEditor.js — 网关配置编辑子系统（从 handlers/gateway.js 抽出）。
 *
 * 覆盖：`gateway config` 交互与 --json 视图、供应商 key/端点/池策略编辑、环境变量写入、
 * API 池 provider 选择与 key-selection 策略选择。刻意 **不自称纯零 IO 叶子**：读写 .env、
 * 交互提示、懒加载账号池 / apiKeyPool 等并落盘。宿主 handlers/gateway.js 单向 require 本叶子
 * 并按同名 re-export handleGatewayConfig，保持命令契约字节不变。叶子对宿主 10 处函数级回依赖
 * 经 DI 注入（含 provider-key 叶子的 _addCustomProviderInteractive），避免 require 环。
 */
const chalkModule = require('chalk');
const chalk = chalkModule.default || chalkModule;
const os = require('os');
const path = require('path');
const http = require('http');
const { OLLAMA_HOST: OLLAMA_HOST_DEFAULT } = require('../../constants/serviceDefaults');
const { PRIMARY: MODELS } = require('../../constants/models');
const { printSuccess, printError, printInfo } = require('../formatters');
const { parseApiKeyEntries, extractPrimaryApiKey } = require('../../services/apiKeyFormat');

// ---- 宿主函数级回依赖（DI 注入，避免与 handlers/gateway.js 形成 require 环）----
let promptWithReplGuard = null;
let _parseJsonObject = null;
let _mergeJsonEnvVar = null;
let _removeJsonEnvVarKey = null;
let _safeJsonLine = null;
let _writeEnvMap = null;
let _unsetEnvKeys = null;
let buildGatewayModelChoices = null;
let handleGatewaySelectModel = null;
let _addCustomProviderInteractive = null;
function setGatewayConfigEditorDeps(deps = {}) {
  if (typeof deps.promptWithReplGuard === 'function') promptWithReplGuard = deps.promptWithReplGuard;
  if (typeof deps._parseJsonObject === 'function') _parseJsonObject = deps._parseJsonObject;
  if (typeof deps._mergeJsonEnvVar === 'function') _mergeJsonEnvVar = deps._mergeJsonEnvVar;
  if (typeof deps._removeJsonEnvVarKey === 'function') _removeJsonEnvVarKey = deps._removeJsonEnvVarKey;
  if (typeof deps._safeJsonLine === 'function') _safeJsonLine = deps._safeJsonLine;
  if (typeof deps._writeEnvMap === 'function') _writeEnvMap = deps._writeEnvMap;
  if (typeof deps._unsetEnvKeys === 'function') _unsetEnvKeys = deps._unsetEnvKeys;
  if (typeof deps.buildGatewayModelChoices === 'function') buildGatewayModelChoices = deps.buildGatewayModelChoices;
  if (typeof deps.handleGatewaySelectModel === 'function') handleGatewaySelectModel = deps.handleGatewaySelectModel;
  if (typeof deps._addCustomProviderInteractive === 'function') _addCustomProviderInteractive = deps._addCustomProviderInteractive;
}

// ---- 配置编辑专用常量（仅本子系统消费，随 handler 一并迁入）----
const KEY_SELECTION_STRATEGY_CHOICES = [
  { name: 'round-robin (默认，优先级内轮询)', value: 'round-robin' },
  { name: 'least-fail (优先失败率低的 key)', value: 'least-fail' },
  { name: 'least-used (优先调用次数少的 key)', value: 'least-used' },
  { name: 'hybrid (综合失败率/退避/使用次数)', value: 'hybrid' },
];

const API_POOL_PROVIDER_KEYS = [
  'sensenova',
  'openai',
  'anthropic',
  'trae',
  'deepseek',
  'qwen',
  'glm',
  'doubao',
  'wenxin',
  'relay',
];
async function handleGatewayConfig(options = {}) {
  const asJson = !!options.json;
  const isInteractive = !!(process.stdin && process.stdin.isTTY && process.stdout && process.stdout.isTTY);
  const actions = [
    { label: '配置网络代理 (Clash/HTTP)', value: 'proxy-config' },
    { label: '设置 CLI 工具桥接 (开/关)', value: 'cli-toggle' },
    { label: '配置 Ollama 本地模型', value: 'ollama-config' },
    { label: '配置 API 中转 (Claude/GPT 中转站)', value: 'relay-api' },
    { label: '配置模型厂商 API Key (DeepSeek/Qwen/GLM/豆包等)', value: 'provider-keys' },
    { label: '高级: 模型路由规则 (GATEWAY_MODEL_ROUTE_MAP)', value: 'routing-policy' },
    { label: '高级: Key 选择策略 (GATEWAY_KEY_SELECTION_STRATEGY)', value: 'key-strategy' },
    { label: '高级: API 池默认 provider (GATEWAY_API_POOL_PROVIDER)', value: 'api-pool-default' },
    { label: '高级: 供应商映射 (alias/service/default-model)', value: 'api-provider-map' },
    { label: '设置 Web 中转端口', value: 'relay-port' },
    { label: '设置中转超时时间', value: 'relay-timeout' },
    { label: '↩️  返回', value: 'back' },
  ];

  if (asJson || !isInteractive) {
    const message = asJson
      ? 'gateway config 需要交互终端；JSON 模式下返回可选配置菜单。'
      : 'gateway config 需要交互终端。请在 TTY 环境运行，或使用 --json 查看可选配置菜单。';
    if (asJson) {
      console.log(JSON.stringify({
        ok: true,
        action: 'config',
        interactive: false,
        requiresTTY: true,
        menu: actions,
        message,
      }, null, 2));
    } else {
      printError(message);
    }
    return;
  }

  const inquirer = require('inquirer');
  // 新手提示:指向图文引导(门控 KHY_GATEWAY_GUIDE,关闭则空串,字节不变)。
  try {
    const hint = require('../../services/gateway/gatewayGuide').guideHintLine();
    if (hint) console.log(chalk.dim('  ' + hint));
  } catch { /* hint optional */ }
  const hadGuard = global.__KHY_INQUIRER_ACTIVE__ === true;
  global.__KHY_INQUIRER_ACTIVE__ = true;
  try {

  const { action } = await promptWithReplGuard([{
    type: 'list',
    name: 'action',
    message: '网关配置:',
    choices: actions.map(item => ({ name: item.label, value: item.value })),
  }]);

  if (action === 'back') return;

  function setEnvVar(key, value) {
    _writeEnvMap({ [key]: String(value) });
  }
  function unsetEnvVar(key) {
    _unsetEnvKeys([key]);
  }

  if (action === 'proxy-config') {
    const proxyConfig = require('../../services/proxyConfigService');
    const proxyFile = path.join(os.homedir(), '.khyquant', 'proxy.json');
    const status = proxyConfig.getStatus();

    console.log('');
    if (status.active) printSuccess(`代理已启用: ${status.url}`);
    else printInfo('代理当前未启用');
    if (status.compatibilityWarning) printInfo(`兼容性提示: ${status.compatibilityWarning}`);
    printInfo(`配置文件: ${proxyFile}`);
    console.log('');

    const { proxyAction } = await promptWithReplGuard([{
      type: 'list',
      name: 'proxyAction',
      message: '代理设置:',
      choices: [
        { name: '自动检测 Clash', value: 'detect' },
        { name: '手动配置 HTTP 代理', value: 'http' },
        { name: '管理 VPN/Clash 订阅链接', value: 'subscription' },
        { name: '关闭代理', value: 'off' },
        { name: '↩️  返回', value: 'back' },
      ],
    }]);

    if (proxyAction === 'back') return;
    if (proxyAction === 'off') {
      proxyConfig.disableProxy();
      printSuccess('代理已关闭');
      return;
    }
    if (proxyAction === 'subscription') {
      const list = proxyConfig.listSubscriptions();
      const { subAction } = await promptWithReplGuard([{
        type: 'list',
        name: 'subAction',
        message: '订阅管理:',
        choices: [
          { name: '新增订阅链接', value: 'add' },
          { name: '刷新激活订阅（仅检测）', value: 'refresh' },
          { name: '应用激活订阅到本地代理', value: 'apply' },
          { name: '切换激活订阅', value: 'use' },
          { name: '删除订阅', value: 'remove' },
          { name: '↩️  返回', value: 'back' },
        ],
      }]);
      if (subAction === 'back') return;

      if (subAction === 'add') {
        const answer = await promptWithReplGuard([
          {
            type: 'input',
            name: 'url',
            message: '订阅 URL:',
            validate: (v) => {
              const text = String(v || '').trim();
              if (/^https?:\/\//i.test(text)) return true;
              if (/^clash:\/\//i.test(text)) return true;
              if (/^sub:\/\//i.test(text)) return true;
              return '请输入 http(s) / clash:// / sub:// 链接';
            },
          },
          {
            type: 'input',
            name: 'name',
            message: '名称（可选）:',
            default: '',
          },
        ]);
        const result = proxyConfig.addSubscription(answer.url, answer.name);
        if (!result.success) printError(result.error || '添加订阅失败');
        else printSuccess(`已添加订阅: ${result.subscription.name}`);
        return;
      }

      if (subAction === 'refresh') {
        const result = await proxyConfig.refreshSubscription('', { timeout: 12000, apply: false });
        if (!result.success) printError(`刷新失败: ${result.error}`);
        else printSuccess(`刷新成功: ${result.subscription.name}`);
        return;
      }

      if (subAction === 'apply') {
        const result = await proxyConfig.applySubscription('', { timeout: 12000 });
        if (!result.success) printError(`应用失败: ${result.error}`);
        else if (result.proxy?.url) printSuccess(`已应用代理: ${result.proxy.url}`);
        else printInfo('订阅刷新成功，但未识别到可应用端口');
        return;
      }

      if (subAction === 'use') {
        if (!list.length) {
          printInfo('暂无订阅，请先新增');
          return;
        }
        const answer = await promptWithReplGuard([{
          type: 'list',
          name: 'id',
          message: '选择激活订阅:',
          choices: list.map(item => ({ name: `${item.name} (${item.id})`, value: item.id })),
        }]);
        const result = proxyConfig.setActiveSubscription(answer.id);
        if (!result.success) printError(result.error || '切换失败');
        else printSuccess(`已切换激活订阅: ${result.active.name}`);
        return;
      }

      if (subAction === 'remove') {
        if (!list.length) {
          printInfo('暂无订阅可删除');
          return;
        }
        const answer = await promptWithReplGuard([{
          type: 'list',
          name: 'id',
          message: '选择删除订阅:',
          choices: list.map(item => ({ name: `${item.name} (${item.id})`, value: item.id })),
        }]);
        const result = proxyConfig.removeSubscription(answer.id);
        if (!result.success) printError(result.error || '删除失败');
        else printSuccess(`已删除订阅: ${result.removed.name}`);
        return;
      }
      return;
    }
    if (proxyAction === 'detect') {
      printInfo('正在检测 Clash...');
      const r = await proxyConfig.autoDetectAndEnable();
      r.success ? printSuccess(`已检测并启用: ${r.proxy.url}`) : printError(r.error);
      return;
    }

    if (proxyAction === 'socks5') {
      printError('当前网关请求隧道仅支持 HTTP CONNECT。请改用 Clash mixed-port/http-port（例如 127.0.0.1:7890）。');
      return;
    }

    const { port } = await promptWithReplGuard([{
      type: 'input',
      name: 'port',
      message: `端口 (默认 ${proxyAction === 'http' ? '7890' : '1080'}):`,
      default: proxyAction === 'http' ? '7890' : '1080',
      validate: v => /^\d+$/.test(String(v || '').trim()) ? true : '请输入端口数字',
    }]);
    const r = await proxyConfig.enableProxy({ type: proxyAction, host: '127.0.0.1', port });
    r.success ? printSuccess(`代理已启用: ${r.proxy.url}`) : printError(r.error);
    return;
  }

  if (action === 'cli-toggle') {
    const current = process.env.GATEWAY_CLI_ENABLED !== 'false';
    const { enabled } = await promptWithReplGuard([{
      type: 'confirm',
      name: 'enabled',
      message: `CLI 工具桥接当前${current ? '已开启' : '已关闭'}，是否开启?`,
      default: true,
    }]);
    setEnvVar('GATEWAY_CLI_ENABLED', enabled);
    printSuccess(`CLI 工具桥接已${enabled ? '开启' : '关闭'}`);
  }

  if (action === 'ollama-config') {
    const ollamaAdapter = require('../../services/gateway/adapters/ollamaAdapter');
    const available = ollamaAdapter.detect(true); // force refresh
    const models = ollamaAdapter.getModels();

    if (!available) {
      printError('Ollama 服务未运行');
      printInfo('安装: https://ollama.com');
      printInfo('启动: ollama serve');
      printInfo('拉取模型: ollama pull qwen2.5:7b');
      return;
    }

    printSuccess(`Ollama 运行中，${models.length} 个模型可用`);

    if (models.length > 0) {
      const { model } = await promptWithReplGuard([{
        type: 'list',
        name: 'model',
        message: '选择默认模型:',
        choices: models.map(m => ({ name: m, value: m })),
        default: process.env.OLLAMA_MODEL || MODELS.ollama,
      }]);
      setEnvVar('OLLAMA_MODEL', model);
      printSuccess(`默认模型已设为 ${model}`);
    }

    const { host } = await promptWithReplGuard([{
      type: 'input',
      name: 'host',
      message: 'Ollama 地址:',
      default: process.env.OLLAMA_HOST || OLLAMA_HOST_DEFAULT,
    }]);
    if (host !== OLLAMA_HOST_DEFAULT) {
      setEnvVar('OLLAMA_HOST', host);
      printSuccess(`Ollama 地址已设为 ${host}`);
    }
    return;
  }

  if (action === 'relay-api') {
    const chalk = require('chalk').default || require('chalk');
    const currentEndpoint = process.env.RELAY_API_ENDPOINT || '';
    const currentKey = process.env.RELAY_API_KEY || '';
    const currentModel = process.env.RELAY_API_MODEL || MODELS.relay;
    const currentProvider = process.env.RELAY_API_PROVIDER || 'openai-compatible';

    if (currentEndpoint) {
      console.log(chalk.dim(`  当前: ${currentEndpoint} / ${currentModel}`));
    }

    console.log('');
    printInfo('填写以下 4 项即可完成配置 (示例仅供参考，请填写你自己的):');
    console.log(chalk.dim('  1. API Provider  — 接口协议类型 (如 OpenAI Compatible)'));
    console.log(chalk.dim('  2. Base URL      — 你的中转站地址 (如 https://your-relay.com/v1)'));
    console.log(chalk.dim('  3. API Key       — 你的密钥 (如 sk-xxxxx)'));
    console.log(chalk.dim('  4. Model ID      — 你要使用的模型 (如 gpt-4o, claude-3.5-sonnet)'));
    console.log('');

    const { provider } = await promptWithReplGuard([{
      type: 'list',
      name: 'provider',
      message: 'API Provider (接口协议):',
      default: currentProvider,
      choices: [
        { name: 'OpenAI Compatible (大多数中转站/OneAPI/API2D)', value: 'openai-compatible' },
        { name: 'Anthropic (Claude 原生 API)', value: 'anthropic' },
        { name: 'Azure OpenAI', value: 'azure' },
        { name: 'Custom (自定义)', value: 'custom' },
      ],
    }]);

    const defaultEndpoints = {
      'openai-compatible': 'https://your-relay.com/v1',
      'anthropic': 'https://api.anthropic.com/v1',
      'azure': 'https://your-resource.openai.azure.com/openai/deployments/your-deployment',
      'custom': 'https://your-api.com/v1',
    };

    const endpointPlaceholder = currentEndpoint || defaultEndpoints[provider] || '';
    const { endpoint } = await promptWithReplGuard([{
      type: 'input',
      name: 'endpoint',
      message: `Base URL${currentEndpoint ? '' : ` (示例: ${chalk.dim(endpointPlaceholder)})`}:`,
      default: currentEndpoint || undefined,
      validate: v => {
        if (!v || !v.trim()) return '请输入你的 API 地址';
        if (!v.startsWith('http')) return '请输入完整 URL (https://...)';
        return true;
      },
    }]);

    const { key } = await promptWithReplGuard([{
      type: 'password',
      name: 'key',
      message: `API Key${currentKey ? '' : ' (你的密钥)'}:`,
      mask: '*',
      default: currentKey || undefined,
      validate: v => v && v.length > 0 ? true : '请输入你的 API Key',
    }]);

    const { model } = await promptWithReplGuard([{
      type: 'input',
      name: 'model',
      message: `Model ID${currentModel && currentModel !== MODELS.relay ? '' : ' (示例: gpt-4o, claude-3.5-sonnet, deepseek-chat)'}:`,
      default: currentModel && currentModel !== MODELS.relay ? currentModel : undefined,
      validate: v => v && v.trim() ? true : '请输入模型名称',
    }]);

    setEnvVar('RELAY_API_ENDPOINT', endpoint);
    setEnvVar('RELAY_API_KEY', key);
    setEnvVar('RELAY_API_MODEL', model);
    setEnvVar('RELAY_API_PROVIDER', provider);

    printSuccess(`API 中转已配置: ${endpoint}`);
    printInfo(`Provider: ${provider}, 模型: ${model}`);

    // Test connection
    const { test } = await promptWithReplGuard([{
      type: 'confirm',
      name: 'test',
      message: '是否测试连接?',
      default: true,
    }]);

    if (test) {
      printInfo('测试中...');
      try {
        const relayAdapter = require('../../services/gateway/adapters/relayApiAdapter');
        relayAdapter.detect(true);
        const result = await relayAdapter.generate('Say "hello" in one word.', {
          maxTokens: 10,
          retryTotalAttempts: 1, // 测试时只试一次，不反复重试
        });
        if (result.success) {
          printSuccess(`连接成功! 响应: "${result.content.slice(0, 50)}" (${result.provider})`);
        } else {
          printError(`连接失败: ${result.error}`);
          if (result.statusCode) printInfo(`HTTP 状态码: ${result.statusCode}`);
          // 常见问题提示
          const err = String(result.error || '').toLowerCase();
          if (err.includes('econnreset') || err.includes('tls') || err.includes('ssl') || err.includes('eof')) {
            printInfo('提示: TLS 握手失败，可能是网络限制或代理未配置。尝试设置 HTTPS_PROXY 环境变量。');
          } else if (err.includes('econnrefused') || err.includes('timeout') || err.includes('enotfound')) {
            printInfo('提示: 无法连接到目标服务器，请检查 Base URL 是否正确，以及网络连通性。');
          } else if (err.includes('401') || err.includes('unauthorized')) {
            printInfo('提示: API Key 认证失败，请检查密钥是否正确。');
          } else if (err.includes('empty response')) {
            printInfo('提示: 服务器返回了空响应。可能是模型 ID 不正确或该 API 不支持非流式请求。');
          }
        }
      } catch (e) {
        printError(`测试错误: ${e.message}`);
      }
    }
    return;
  }

  if (action === 'provider-keys') {
    const pool = require('../../services/apiKeyPool');
    pool.init();

    const PROVIDERS = listBuiltinProviders();

    // 追加已注册的自定义 provider
    const customRegistry = require('../../services/customProviderRegistry');
    for (const cp of customRegistry.listProviders()) {
      PROVIDERS.push({
        name: `${cp.name} (自定义)`,
        poolKey: cp.poolKey,
        envKey: null,
        envEndpoint: null,
        defaultEndpoint: cp.endpoint,
        models: cp.models || [],
        isCustom: true,
      });
    }

    // Show current pool status
    console.log('');
    console.log(chalk.cyan.bold('  API Key 池管理'));
    console.log('');
    for (const p of PROVIDERS) {
      if (p.poolKey) {
        const status = pool.getPoolStatus(p.poolKey);
        if (status.length > 0) {
          console.log(`  ${chalk.white(p.name)} ${chalk.dim(`(${status.length} keys)`)}`);
          for (const s of status) {
            const icon = s.status === 'active' ? chalk.green('●')
              : s.status === 'cooldown' ? chalk.yellow('○')
              : chalk.red('○');
            const cooldown = s.cooldownRemaining > 0 ? chalk.yellow(` ⏳${s.cooldownRemaining}s`) : '';
            console.log(`    ${icon} ${chalk.dim(s.keyPreview)}  ${s.label || ''}  P:${s.priority}  ${chalk.dim(`${s.totalRequests} req`)}${cooldown}`);
          }
        } else {
          const hasEnv = p.envKey ? !!process.env[p.envKey] : false;
          const icon = hasEnv ? chalk.green('●') : chalk.dim('○');
          console.log(`  ${icon} ${chalk.white(p.name)}${hasEnv ? chalk.dim(` (env)`) : ''}`);
        }
      } else if (p.envKey) {
        const hasKey = !!process.env[p.envKey];
        const icon = hasKey ? chalk.green('●') : chalk.dim('○');
        console.log(`  ${icon} ${chalk.white(p.name)}${hasKey ? chalk.dim(` (${process.env[p.envKey].slice(0, 6)}...)`) : ''}`);
      }
    }
    console.log('');

    const { providerAction } = await promptWithReplGuard([{
      type: 'list',
      name: 'providerAction',
      message: '操作:',
      choices: [
        { name: '添加 API Key', value: 'add' },
        { name: '移除 API Key', value: 'remove' },
        { name: '查看 Key 池详情', value: 'status' },
        { name: '↩️  返回', value: 'back' },
      ],
    }]);

    if (providerAction === 'back') return;

    if (providerAction === 'add') {
      const { provider } = await promptWithReplGuard([{
        type: 'list',
        name: 'provider',
        message: '选择厂商:',
        choices: [
          ...PROVIDERS.map(p => ({ name: p.name, value: p })),
          new inquirer.Separator(),
          { name: '+ 添加自定义 Provider (OpenAI-compatible)', value: '__custom__' },
          { name: '↩️  返回', value: null },
        ],
      }]);

      if (!provider) return;

      // ── 自定义 Provider 流程（复用共享函数）──
      if (provider === '__custom__') {
        await _addCustomProviderInteractive({ pool, customRegistry });
        return;
      }

      const { key: keyInput } = await promptWithReplGuard([{
        type: 'password',
        name: 'key',
        message: `${provider.name} API Key (支持单个/逗号分隔/JSON):`,
        mask: '*',
        validate: v => v.length > 0 ? true : '请输入 API Key',
      }]);

      // HuggingFace: token only, save to env
      if (provider.isToken) {
        const hfPrimary = extractPrimaryApiKey(keyInput);
        if (!hfPrimary) {
          printError('未解析到有效 Token');
          return;
        }
        setEnvVar(provider.envKey, hfPrimary);
        printSuccess(`${provider.name} Token 已保存`);
        return;
      }

      // Endpoint
      let keyEndpoint = provider.defaultEndpoint;
      const { useDefault } = await promptWithReplGuard([{
        type: 'confirm',
        name: 'useDefault',
        message: `使用默认地址 (${provider.defaultEndpoint || '无'})？`,
        default: true,
      }]);
      if (!useDefault) {
        const { ep } = await promptWithReplGuard([{
          type: 'input',
          name: 'ep',
          message: 'API 地址:',
          default: provider.defaultEndpoint,
        }]);
        keyEndpoint = ep;
      }

      // Priority
      const { priority } = await promptWithReplGuard([{
        type: 'input',
        name: 'priority',
        message: '优先级 (数字越大越优先, 0=默认):',
        default: '10',
        validate: v => /^\d+$/.test(v) ? true : '请输入数字',
      }]);

      // Label
      const { label } = await promptWithReplGuard([{
        type: 'input',
        name: 'label',
        message: '标签 (可选, 如 "付费号"):',
        default: '',
      }]);

      const parsedEntries = parseApiKeyEntries(keyInput, {
        endpoint: keyEndpoint,
        priority: parseInt(priority, 10),
        label,
      });
      if (parsedEntries.length === 0) {
        printError('未解析到有效 API Key');
        return;
      }
      const primaryKey = parsedEntries[0].key;

      if (provider.poolKey) {
        let addedCount = 0;
        let duplicateCount = 0;
        for (const entry of parsedEntries) {
          try {
            pool.addKey(provider.poolKey, entry);
            addedCount += 1;
          } catch (e) {
            if (/already exists/i.test(String(e && e.message ? e.message : ''))) {
              duplicateCount += 1;
            } else {
              printError(e.message);
            }
          }
        }
        if (addedCount > 0) {
          printSuccess(`已添加到 ${provider.name} Key 池 (${addedCount} 个)`);
        }
        if (duplicateCount > 0) {
          printInfo(`跳过重复 Key: ${duplicateCount} 个`);
        }
      }

      // Also set env vars for the provider (first key)
      if (provider.envKey) {
        setEnvVar(provider.envKey, primaryKey);
        if (provider.envEndpoint && keyEndpoint) {
          setEnvVar(provider.envEndpoint, keyEndpoint);
        }
        if (/_API_KEY$/i.test(provider.envKey)) {
          const prefix = provider.envKey.replace(/_API_KEY$/i, '');
          if (parsedEntries.length > 1) {
            setEnvVar(`${prefix}_API_KEYS`, parsedEntries.map(e => e.key).join(','));
          } else {
            unsetEnvVar(`${prefix}_API_KEYS`);
          }
        }
      }

      // Model selection + route map
      if (provider.models.length > 0) {
        const { model } = await promptWithReplGuard([{
          type: 'list',
          name: 'model',
          message: '选择默认模型:',
          choices: provider.models,
        }]);
        // 确保 pool service map 中有该 provider 的映射
        if (provider.poolKey) {
          _mergeJsonEnvVar('GATEWAY_API_POOL_SERVICE_MAP', { [provider.poolKey]: 'openai' }, _writeEnvMap);
          _mergeJsonEnvVar('GATEWAY_API_POOL_DEFAULT_MODEL_MAP', { [provider.poolKey]: model }, _writeEnvMap);
          // 更新 route map
          const routeEntries = {};
          for (const m of provider.models) {
            routeEntries[m] = { target: `api:${provider.poolKey}:${m}`, strict: true };
          }
          _mergeJsonEnvVar('PROXY_MODEL_ROUTE_MAP', routeEntries, _writeEnvMap);
        }
        printSuccess(`${provider.name} 已配置: ${model}`);
      }
    }

    if (providerAction === 'remove') {
      const allStatus = pool.getAllStatus();
      const removeChoices = [];
      for (const [prov, keys] of Object.entries(allStatus)) {
        for (const k of keys) {
          removeChoices.push({
            name: `${prov} · ${k.keyPreview} · ${k.label || '无标签'} · P:${k.priority}`,
            value: { provider: prov, keyId: k.keyId },
          });
        }
      }
      if (removeChoices.length === 0) {
        printInfo('Key 池为空');
        return;
      }
      const { toRemove } = await promptWithReplGuard([{
        type: 'list',
        name: 'toRemove',
        message: '选择要移除的 Key:',
        choices: [...removeChoices, { name: '↩️  返回', value: null }],
      }]);
      if (toRemove) {
        pool.removeKey(toRemove.provider, toRemove.keyId);
        printSuccess('已移除');

        // 如果是自定义 provider 且 pool 中已无剩余 key，清理 registry 和 env 映射
        if (!pool.hasAvailableKeys(toRemove.provider)) {
          const cpEntry = customRegistry.getProvider(toRemove.provider);
          if (cpEntry) {
            customRegistry.removeProvider(toRemove.provider);
            _removeJsonEnvVarKey('GATEWAY_API_POOL_SERVICE_MAP', toRemove.provider, _writeEnvMap);
            _removeJsonEnvVarKey('GATEWAY_API_POOL_DEFAULT_MODEL_MAP', toRemove.provider, _writeEnvMap);
            // 清理 route map 中该 provider 的路由
            const routeMap = _parseJsonObject(process.env.PROXY_MODEL_ROUTE_MAP, {});
            let changed = false;
            for (const [k, v] of Object.entries(routeMap)) {
              const target = typeof v === 'string' ? v : v?.target || '';
              if (target.startsWith(`api:${toRemove.provider}:`)) {
                delete routeMap[k];
                changed = true;
              }
            }
            if (changed) {
              const json = Object.keys(routeMap).length > 0 ? JSON.stringify(routeMap) : '';
              if (json) _writeEnvMap({ PROXY_MODEL_ROUTE_MAP: json });
            }
            printInfo(`已清理 ${cpEntry.name} 的注册信息和路由映射`);
          }
        }
      }
    }

    if (providerAction === 'status') {
      const allStatus = pool.getAllStatus();
      if (Object.keys(allStatus).length === 0) {
        printInfo('Key 池为空。使用「添加 API Key」开始配置');
        return;
      }
      console.log('');
      for (const [prov, keys] of Object.entries(allStatus)) {
        console.log(chalk.cyan(`  ${prov} (${keys.length} keys)`));
        for (const k of keys) {
          const icon = k.status === 'active' ? chalk.green('●')
            : k.status === 'cooldown' ? chalk.yellow('○')
            : chalk.red('○');
          const cooldown = k.cooldownRemaining > 0 ? chalk.yellow(` ⏳ ${k.cooldownRemaining}s`) : '';
          const error = k.lastError ? chalk.red(` · ${k.lastError.slice(0, 40)}`) : '';
          console.log(`    ${icon} ${chalk.dim(k.keyPreview)}  ${k.label || ''}  P:${k.priority}  ${chalk.dim(`✓ ${k.totalRequests} req · ✗ ${k.totalFailures} fail`)}${cooldown}${error}`);
        }
        console.log('');
      }
    }
    return;
  }

  if (action === 'routing-policy') {
    const routeMap = _parseJsonObject(process.env.GATEWAY_MODEL_ROUTE_MAP, {});
    const routeEntries = Object.entries(routeMap);
    const strictDefault = String(process.env.GATEWAY_MODEL_ROUTE_STRICT || 'false').toLowerCase() === 'true';

    console.log('');
    console.log(chalk.cyan.bold('  模型路由策略'));
    console.log(chalk.dim(`  strict 默认值: ${strictDefault ? 'true' : 'false'}`));
    if (routeEntries.length === 0) {
      console.log(chalk.dim('  当前无路由规则'));
    } else {
      for (const [pattern, target] of routeEntries) {
        if (target && typeof target === 'object') {
          console.log(`  ${chalk.green(pattern)} -> ${chalk.white(target.target || '')} ${chalk.dim(`(strict=${target.strict === true ? 'true' : 'false'})`)}`);
        } else {
          console.log(`  ${chalk.green(pattern)} -> ${chalk.white(String(target || ''))}`);
        }
      }
    }
    console.log('');

    const { policyAction } = await promptWithReplGuard([{
      type: 'list',
      name: 'policyAction',
      message: '操作:',
      choices: [
        { name: '新增/更新规则', value: 'set' },
        { name: '移除规则', value: 'remove' },
        { name: '清空所有规则', value: 'clear' },
        { name: '设置 strict 默认值', value: 'strict' },
        { name: '↩️  返回', value: 'back' },
      ],
    }]);

    if (policyAction === 'back') return;
    if (policyAction === 'set') {
      const { pattern, target, strictMode } = await promptWithReplGuard([
        {
          type: 'input',
          name: 'pattern',
          message: '匹配规则 (例: gpt-4o-mini 或 claude-*):',
          validate: v => String(v || '').trim() ? true : '请输入匹配规则',
        },
        {
          type: 'input',
          name: 'target',
          message: '目标路由 (例: api/openai:gpt-4o-mini 或 kiro/claude-sonnet-4):',
          validate: v => String(v || '').trim() ? true : '请输入目标路由',
        },
        {
          type: 'list',
          name: 'strictMode',
          message: 'strict 行为:',
          choices: [
            { name: '继承默认值', value: 'inherit' },
            { name: '强制 strict=true', value: 'true' },
            { name: '强制 strict=false', value: 'false' },
          ],
          default: 'inherit',
        },
      ]);
      if (strictMode === 'inherit') {
        routeMap[String(pattern).trim()] = String(target).trim();
      } else {
        routeMap[String(pattern).trim()] = {
          target: String(target).trim(),
          strict: strictMode === 'true',
        };
      }
      setEnvVar('GATEWAY_MODEL_ROUTE_MAP', _safeJsonLine(routeMap));
      printSuccess('模型路由规则已更新');
      return;
    }

    if (policyAction === 'remove') {
      const keys = Object.keys(routeMap);
      if (keys.length === 0) {
        printInfo('当前无规则可移除');
        return;
      }
      const { toRemove } = await promptWithReplGuard([{
        type: 'list',
        name: 'toRemove',
        message: '选择要移除的规则:',
        choices: [...keys.map(k => ({ name: k, value: k })), { name: '↩️  返回', value: null }],
      }]);
      if (!toRemove) return;
      delete routeMap[toRemove];
      if (Object.keys(routeMap).length === 0) {
        unsetEnvVar('GATEWAY_MODEL_ROUTE_MAP');
      } else {
        setEnvVar('GATEWAY_MODEL_ROUTE_MAP', _safeJsonLine(routeMap));
      }
      printSuccess(`已移除规则: ${toRemove}`);
      return;
    }

    if (policyAction === 'clear') {
      const { confirmClear } = await promptWithReplGuard([{
        type: 'confirm',
        name: 'confirmClear',
        message: '确认清空全部模型路由规则?',
        default: false,
      }]);
      if (!confirmClear) return;
      unsetEnvVar('GATEWAY_MODEL_ROUTE_MAP');
      printSuccess('已清空模型路由规则');
      return;
    }

    if (policyAction === 'strict') {
      const { strictOn } = await promptWithReplGuard([{
        type: 'confirm',
        name: 'strictOn',
        message: '当规则未显式指定 strict 时，是否默认 strict=true?',
        default: strictDefault,
      }]);
      setEnvVar('GATEWAY_MODEL_ROUTE_STRICT', strictOn ? 'true' : 'false');
      printSuccess(`已设置 GATEWAY_MODEL_ROUTE_STRICT=${strictOn ? 'true' : 'false'}`);
      return;
    }
  }

  if (action === 'key-strategy') {
    const currentStrategy = String(process.env.GATEWAY_KEY_SELECTION_STRATEGY || 'round-robin').trim().toLowerCase();
    const currentStrategyMap = _parseJsonObject(process.env.GATEWAY_KEY_SELECTION_STRATEGY_MAP, {});

    const { strategy } = await promptWithReplGuard([{
      type: 'list',
      name: 'strategy',
      message: '全局 Key 选择策略:',
      choices: KEY_SELECTION_STRATEGY_CHOICES,
      default: KEY_SELECTION_STRATEGY_CHOICES.some(c => c.value === currentStrategy) ? currentStrategy : 'round-robin',
    }]);
    setEnvVar('GATEWAY_KEY_SELECTION_STRATEGY', strategy);

    let nextMap = { ...currentStrategyMap };
    while (true) {
      const providerCount = Object.keys(nextMap).length;
      const { op } = await promptWithReplGuard([{
        type: 'list',
        name: 'op',
        message: `Provider 覆盖策略 (${providerCount} 条):`,
        choices: [
          { name: '新增/更新覆盖', value: 'set' },
          { name: '移除覆盖', value: 'remove' },
          { name: '清空覆盖', value: 'clear' },
          { name: '完成', value: 'done' },
        ],
      }]);

      if (op === 'done') break;
      if (op === 'clear') {
        nextMap = {};
        continue;
      }
      if (op === 'remove') {
        const keys = Object.keys(nextMap);
        if (keys.length === 0) {
          printInfo('当前无覆盖项可移除');
          continue;
        }
        const { key } = await promptWithReplGuard([{
          type: 'list',
          name: 'key',
          message: '选择要移除的 provider:',
          choices: [...keys.map(k => ({ name: `${k} => ${nextMap[k]}`, value: k })), { name: '↩️  返回', value: null }],
        }]);
        if (!key) continue;
        delete nextMap[key];
        continue;
      }

      if (op === 'set') {
        const { providerChoice } = await promptWithReplGuard([{
          type: 'list',
          name: 'providerChoice',
          message: '选择 provider:',
          choices: [
            ...API_POOL_PROVIDER_KEYS.map(k => ({ name: k, value: k })),
            { name: '自定义 provider', value: '__custom__' },
            { name: '↩️  返回', value: null },
          ],
        }]);
        if (!providerChoice) continue;
        let providerKey = providerChoice;
        if (providerChoice === '__custom__') {
          const { customProvider } = await promptWithReplGuard([{
            type: 'input',
            name: 'customProvider',
            message: '输入 provider 名称:',
            validate: v => String(v || '').trim() ? true : '请输入 provider',
          }]);
          providerKey = String(customProvider).trim().toLowerCase();
        }
        const { providerStrategy } = await promptWithReplGuard([{
          type: 'list',
          name: 'providerStrategy',
          message: `${providerKey} 的策略:`,
          choices: KEY_SELECTION_STRATEGY_CHOICES,
          default: KEY_SELECTION_STRATEGY_CHOICES.some(c => c.value === String(nextMap[providerKey] || strategy))
            ? String(nextMap[providerKey] || strategy)
            : 'round-robin',
        }]);
        nextMap[providerKey] = providerStrategy;
      }
    }

    if (Object.keys(nextMap).length === 0) {
      unsetEnvVar('GATEWAY_KEY_SELECTION_STRATEGY_MAP');
    } else {
      setEnvVar('GATEWAY_KEY_SELECTION_STRATEGY_MAP', _safeJsonLine(nextMap));
    }
    printSuccess(`Key 选择策略已更新: ${strategy}`);
    if (Object.keys(nextMap).length > 0) {
      printInfo(`Provider 覆盖: ${_safeJsonLine(nextMap)}`);
    } else {
      printInfo('Provider 覆盖: 无');
    }
    return;
  }

  if (action === 'api-pool-default') {
    const current = String(process.env.GATEWAY_API_POOL_PROVIDER || '').trim().toLowerCase();
    const { provider } = await promptWithReplGuard([{
      type: 'list',
      name: 'provider',
      message: 'API 适配器默认池 provider（未指定 model/provider 时生效）:',
      choices: [
        { name: '自动推断（默认）', value: '' },
        ...API_POOL_PROVIDER_KEYS.map(k => ({ name: k, value: k })),
      ],
      default: (current && API_POOL_PROVIDER_KEYS.includes(current)) ? current : '',
    }]);

    if (!provider) {
      unsetEnvVar('GATEWAY_API_POOL_PROVIDER');
      printSuccess('已恢复自动推断 provider');
    } else {
      setEnvVar('GATEWAY_API_POOL_PROVIDER', provider);
      printSuccess(`默认 provider 已设为 ${provider}`);
    }
    return;
  }

  if (action === 'api-provider-map') {
    const MAP_PRESETS = [
      {
        envKey: 'GATEWAY_API_POOL_PROVIDER_ALIAS_MAP',
        title: 'Alias 映射',
        keyHint: '别名',
        valueHint: '池 provider（如 deepseek/qwen/glm/openai）',
      },
      {
        envKey: 'GATEWAY_API_POOL_SERVICE_MAP',
        title: '池 -> 服务映射',
        keyHint: '池 provider',
        valueHint: '服务 provider（MultiFreeService key，如 openai/alibaba/zhipu/baidu）',
      },
      {
        envKey: 'GATEWAY_API_POOL_DEFAULT_MODEL_MAP',
        title: '池默认模型映射',
        keyHint: '池 provider',
        valueHint: '默认模型（如 deepseek-chat / qwen-plus）',
      },
    ];

    const { preset } = await promptWithReplGuard([{
      type: 'list',
      name: 'preset',
      message: '选择映射类型:',
      choices: [
        ...MAP_PRESETS.map(p => ({ name: `${p.title} (${p.envKey})`, value: p })),
        { name: '↩️  返回', value: null },
      ],
    }]);
    if (!preset) return;

    const nextMap = _parseJsonObject(process.env[preset.envKey], {});
    while (true) {
      const rows = Object.entries(nextMap);
      console.log('');
      console.log(chalk.cyan.bold(`  ${preset.title}`));
      if (rows.length === 0) {
        console.log(chalk.dim('  当前为空'));
      } else {
        for (const [k, v] of rows) {
          console.log(`  ${chalk.green(k)} => ${chalk.white(String(v))}`);
        }
      }
      console.log('');

      const { op } = await promptWithReplGuard([{
        type: 'list',
        name: 'op',
        message: '操作:',
        choices: [
          { name: '新增/更新', value: 'set' },
          { name: '移除', value: 'remove' },
          { name: '清空', value: 'clear' },
          { name: '完成', value: 'done' },
        ],
      }]);

      if (op === 'done') break;
      if (op === 'clear') {
        Object.keys(nextMap).forEach(k => { delete nextMap[k]; });
        continue;
      }
      if (op === 'remove') {
        const keys = Object.keys(nextMap);
        if (keys.length === 0) {
          printInfo('当前无可移除项');
          continue;
        }
        const { key } = await promptWithReplGuard([{
          type: 'list',
          name: 'key',
          message: '选择要移除的键:',
          choices: [...keys.map(k => ({ name: k, value: k })), { name: '↩️  返回', value: null }],
        }]);
        if (!key) continue;
        delete nextMap[key];
        continue;
      }
      if (op === 'set') {
        const { mapKey, mapValue } = await promptWithReplGuard([
          {
            type: 'input',
            name: 'mapKey',
            message: `${preset.keyHint}:`,
            validate: v => String(v || '').trim() ? true : '请输入 key',
          },
          {
            type: 'input',
            name: 'mapValue',
            message: `${preset.valueHint}:`,
            validate: v => String(v || '').trim() ? true : '请输入 value',
          },
        ]);
        nextMap[String(mapKey).trim().toLowerCase()] = String(mapValue).trim();
      }
    }

    if (Object.keys(nextMap).length === 0) {
      unsetEnvVar(preset.envKey);
      printSuccess(`已清空 ${preset.envKey}`);
    } else {
      setEnvVar(preset.envKey, _safeJsonLine(nextMap));
      printSuccess(`已更新 ${preset.envKey}`);
      printInfo(_safeJsonLine(nextMap));
    }
    return;
  }

  if (action === 'relay-port') {
    const { port } = await promptWithReplGuard([{
      type: 'input',
      name: 'port',
      message: '中转服务端口:',
      default: process.env.GATEWAY_RELAY_PORT || '9099',
      validate: v => /^\d+$/.test(v) ? true : '请输入数字',
    }]);
    setEnvVar('GATEWAY_RELAY_PORT', port);
    printSuccess(`中转端口已设为 ${port}`);
    printInfo('重启中转服务后生效');
  }

  if (action === 'relay-timeout') {
    const { minutes } = await promptWithReplGuard([{
      type: 'input',
      name: 'minutes',
      message: '中转超时 (分钟):',
      default: String(Math.round((parseInt(process.env.GATEWAY_RELAY_TIMEOUT, 10) || 600000) / 60000)),
      validate: v => /^\d+$/.test(v) ? true : '请输入数字',
    }]);
    setEnvVar('GATEWAY_RELAY_TIMEOUT', parseInt(minutes, 10) * 60000);
    printSuccess(`中转超时已设为 ${minutes} 分钟`);
  }
  } finally {
    if (!hadGuard) global.__KHY_INQUIRER_ACTIVE__ = false;
    // Ensure stdin is resumed after inquirer sessions
    try { process.stdin.resume(); } catch { /* ignore */ }
  }
}

module.exports = {
  handleGatewayConfig,
  setGatewayConfigEditorDeps,
};

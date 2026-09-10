'use strict';

/**
 * channelApiService.js — 渠道 API 注册表服务层（CRUD + 脱敏 + 配置指南 + 审计）。
 *
 * 职责边界：路由层只做参数提取与 HTTP 映射，本模块负责
 *   - 输入校验与归一化（sanitizeInput）
 *   - API Key 加解密（委托 channelApiCrypto）与脱敏视图（toView）
 *   - 配置指南生成（buildConfigGuide / getConfigGuide / listAgentGuides）
 *   - 明文 Key 的一次性揭示 + 审计（revealChannelKey）
 *   - 预置渠道数据（seedChannelApis，幂等：已存在则保留，用户可编辑/删除）
 *
 * 失败口径：校验失败抛 ChannelApiValidationError（路由层转 400），
 * 数据库异常向上抛由路由层转 500。加密/解密与审计本身 fail-soft，不抛。
 */

const { Op } = require('sequelize');

const { ChannelApi } = require('../models');

const { logToolExecution } = require('./auditLog');
const channelApiCrypto = require('./channelApiCrypto');
const { getProviderPresets } = require('./gateway/providerPresets');

const { encryptApiKey, decryptApiKey, maskApiKey } = channelApiCrypto;

const CONFIG_METHODS = ['env_var', 'config_file', 'both'];
const ENV_VAR_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FIELD_LIMITS = {
  channel_name: 120,
  provider: 80,
  endpoint_url: 500,
  key_env_var: 120,
  docs_url: 500,
};

/** 校验失败用的类型化错误，路由层据 error.code 映射 HTTP 状态。 */
class ChannelApiValidationError extends Error {
  constructor(message, code = 'INVALID_ARGUMENT') {
    super(message);
    this.name = 'ChannelApiValidationError';
    this.code = code;
  }
}

// ── 各 Agent 渠道的配置方法（内置文档真源）─────────────────────────
// methods: 该渠道支持的配置方式；envVars: 可注入的环境变量名；
// configFile: 官方/惯例配置文件路径；fileLang: 该文件语言的代码块标记。
// steps 面向用户，每条是一个可执行动作。
const AGENT_CONFIG_GUIDES = [
  {
    agent: 'Claude Code',
    provider: 'Anthropic',
    methods: ['env_var', 'config_file'],
    envVars: ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'],
    configFile: '~/.claude/settings.json',
    fileLang: 'json',
    steps: [
      '终端导出环境变量：export ANTHROPIC_API_KEY="<你的 Key>"',
      '自托管网关另需 export ANTHROPIC_BASE_URL="<网关地址>"',
      '写入 ~/.claude/settings.json 的 env 字段可让配置持久化',
      '启动 claude 后运行 /status 确认密钥已生效',
    ],
    docsUrl: 'https://docs.anthropic.com/en/docs/claude-code/setup',
  },
  {
    agent: 'CommandCode',
    provider: 'OpenAI',
    methods: ['env_var'],
    envVars: ['OPENAI_API_KEY', 'OPENAI_BASE_URL'],
    configFile: '',
    fileLang: 'json',
    steps: [
      '终端导出环境变量：export OPENAI_API_KEY="<你的 Key>"',
      '端点不是官方地址时，再导出 OPENAI_BASE_URL="<你的网关地址>"',
      '重开 CommandCode 会话让环境变量生效',
    ],
    docsUrl: '',
  },
  {
    agent: 'ZCode',
    provider: '自定义',
    methods: ['env_var'],
    envVars: [],
    configFile: '',
    fileLang: 'json',
    steps: [
      '在 ZCode 的通道设置中选择自定义供应商',
      '填入端点 URL 与 API Key（本表「渠道 API」里维护）',
      '保存后新建会话生效',
    ],
    docsUrl: '',
  },
  {
    agent: 'Codex',
    provider: 'OpenAI',
    methods: ['env_var', 'config_file'],
    envVars: ['OPENAI_API_KEY'],
    configFile: '~/.codex/config.toml',
    fileLang: 'toml',
    steps: [
      '终端导出环境变量：export OPENAI_API_KEY="<你的 Key>"',
      '编辑 ~/.codex/config.toml，声明 model_provider 与 base_url',
      '运行 codex 后确认 provider 已连接',
    ],
    docsUrl: 'https://github.com/openai/codex',
  },
  {
    agent: 'Cursor',
    provider: 'OpenAI',
    methods: ['env_var', 'config_file'],
    envVars: ['OPENAI_API_KEY'],
    configFile: '~/.cursor/config.json',
    fileLang: 'json',
    steps: [
      'Cursor → Settings → Models → API Keys → OpenAI，粘贴 Key',
      '或在 ~/.cursor/config.json 写入 openaiApiKey 字段',
      '保存后模型列表自动刷新',
    ],
    docsUrl: 'https://docs.cursor.com/settings/api-keys',
  },
  {
    agent: 'Cline',
    provider: 'Anthropic',
    methods: ['env_var', 'config_file'],
    envVars: ['ANTHROPIC_API_KEY'],
    configFile: 'VS Code 扩展存储（操作系统钥匙串加密）',
    fileLang: 'json',
    steps: [
      '打开 Cline 侧栏，点钥匙图标选择供应商 Anthropic',
      '粘贴 API Key，Cline 用操作系统钥匙串加密保存',
      '也可用环境变量 ANTHROPIC_API_KEY 注入，无需在界面填写',
    ],
    docsUrl: 'https://docs.cline.bot/configuration/providers',
  },
  {
    agent: 'Continue.dev',
    provider: '多供应商',
    methods: ['config_file'],
    envVars: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'],
    configFile: '~/.continue/config.yaml',
    fileLang: 'yaml',
    steps: [
      '终端导出对应供应商的 Key，如 export ANTHROPIC_API_KEY="<你的 Key>"',
      '编辑 ~/.continue/config.yaml，用 ${ANTHROPIC_API_KEY} 引用环境变量',
      '重新加载 Continue 窗口加载新配置',
    ],
    docsUrl: 'https://docs.continue.dev/customize/config-file',
  },
];

function findAgentGuide(channelName) {
  const name = String(channelName || '').trim().toLowerCase();
  return AGENT_CONFIG_GUIDES.find((g) => g.agent.toLowerCase() === name) || null;
}

/** 取某个 provider preset 的 baseUrl（端点单一真源，见 gateway/providerPresets）。 */
function presetBaseUrl(providerId) {
  try {
    const preset = getProviderPresets().find((p) => String(p.id) === providerId);
    return preset ? String(preset.baseUrl || '').trim() : '';
  } catch {
    return '';
  }
}

// ── 输入校验与归一化 ───────────────────────────────────────────────

function _text(body, field, { required = false, allowEmpty = true } = {}) {
  const raw = body ? body[field] : undefined;
  const value = String(raw ?? '').trim();
  const max = FIELD_LIMITS[field];
  if (value.length > max) {
    throw new ChannelApiValidationError(`${field} 长度不能超过 ${max} 个字符`);
  }
  if (!value && required) {
    throw new ChannelApiValidationError(`${field} 为必填项`);
  }
  if (!value && !allowEmpty) {
    throw new ChannelApiValidationError(`${field} 不能为空`);
  }
  return value;
}

/**
 * 归一化一条渠道写入请求。
 * @param {object} body 请求体
 * @param {boolean} opts.partial true = 更新（仅覆盖传入字段）
 * @returns {object} 可直接 create/update 的属性（api_key 已是密文）
 */
function sanitizeInput(body, { partial = false } = {}) {
  const out = {};
  const has = (f) => body && Object.prototype.hasOwnProperty.call(body, f);

  if (has('channel_name') || !partial) {
    out.channel_name = _text(body, 'channel_name', { required: !partial || !!body.channel_name });
    if (!out.channel_name) {
      throw new ChannelApiValidationError('channel_name 为必填项');
    }
  }
  if (has('provider') || !partial) {
    out.provider = _text(body, 'provider', { required: !partial || !!body.provider });
    if (!out.provider) {
      throw new ChannelApiValidationError('provider 为必填项');
    }
  }
  if (has('endpoint_url') || !partial) {
    out.endpoint_url = _text(body, 'endpoint_url');
  }
  if (has('key_env_var') || !partial) {
    const envVar = _text(body, 'key_env_var');
    if (envVar && !ENV_VAR_PATTERN.test(envVar)) {
      throw new ChannelApiValidationError('key_env_var 不是合法的环境变量名（形如 ANTHROPIC_API_KEY）');
    }
    out.key_env_var = envVar;
  }
  if (has('config_method') || !partial) {
    const method = String(body.config_method || 'env_var').trim();
    if (!CONFIG_METHODS.includes(method)) {
      throw new ChannelApiValidationError(
        `config_method 必须是 ${CONFIG_METHODS.join(' / ')} 之一`
      );
    }
    out.config_method = method;
  }
  if (has('config_snippet')) {
    out.config_snippet = String(body.config_snippet ?? '');
  }
  if (has('docs_url') || !partial) {
    const docsUrl = _text(body, 'docs_url');
    if (docsUrl && !/^https?:\/\//i.test(docsUrl)) {
      throw new ChannelApiValidationError('docs_url 必须是 http(s) 链接');
    }
    out.docs_url = docsUrl;
  }
  if (has('notes')) {
    out.notes = String(body.notes ?? '');
  }
  if (has('api_key') && String(body.api_key || '').trim() !== '') {
    out.api_key = encryptApiKey(String(body.api_key).trim());
  }
  return out;
}

// ── 视图序列化 ─────────────────────────────────────────────────────

/**
 * 序列化为对外视图。Key 一律脱敏返回（前 4 + **** + 后 4），明文需显式
 * 请求 revealChannelKey。
 *
 * has_key 以「库里是否有密文」为准（而非能否解密），这样密钥轮换后列表仍显示
 * 「已配置」，不会因为解不开就误导用户以为没填。masked_key 只在能解密时给出
 * 片段，解不开则为空串。
 *
 * @param {object} instance Sequelize 实例或 null
 * @param {string} [plaintext] 已解密的明文（reveal 路径传入，省一次解密）
 */
function toView(instance, plaintext) {
  if (!instance) return null;
  const data = instance.toJSON();
  const ciphertext = String(data.api_key || '');
  const key = String(plaintext ?? '').trim() || decryptApiKey(ciphertext);
  return {
    id: data.id,
    channel_name: data.channel_name,
    provider: data.provider,
    endpoint_url: data.endpoint_url,
    masked_key: maskApiKey(key),
    has_key: !!ciphertext.trim(),
    key_env_var: data.key_env_var || '',
    config_method: data.config_method,
    config_snippet: data.config_snippet || '',
    docs_url: data.docs_url || '',
    notes: data.notes || '',
    created_at: data.created_at,
    updated_at: data.updated_at,
  };
}

// ── CRUD ───────────────────────────────────────────────────────────

/** 列出渠道（支持按名称/供应商/端点关键字过滤）。 */
async function listChannels({ q = '' } = {}) {
  const where = {};
  const keyword = String(q || '').trim();
  if (keyword) {
    const like = `%${keyword}%`;
    where[Op.or] = [
      { channel_name: { [Op.like]: like } },
      { provider: { [Op.like]: like } },
      { endpoint_url: { [Op.like]: like } },
      { key_env_var: { [Op.like]: like } },
    ];
  }
  const rows = await ChannelApi.findAll({ where, order: [['channel_name', 'ASC']] });
  return rows.map((row) => toView(row));
}

/** 读取单条渠道（脱敏）。不存在返回 null。 */
async function getChannel(id) {
  const instance = await ChannelApi.findByPk(id);
  return instance ? toView(instance) : null;
}

/** 新建渠道。 */
async function createChannel(body) {
  const attrs = sanitizeInput(body);
  const instance = await ChannelApi.create(attrs);
  return toView(instance);
}

/**
 * 更新渠道。
 * api_key 传空串表示「清空 Key」，不传则保留原值。
 */
async function updateChannel(id, body) {
  const instance = await ChannelApi.findByPk(id);
  if (!instance) {
    throw new ChannelApiValidationError(`渠道不存在 (id=${id})`, 'MODEL_NOT_FOUND');
  }
  const attrs = sanitizeInput(body, { partial: true });
  if (body && Object.prototype.hasOwnProperty.call(body, 'api_key')) {
    const next = String(body.api_key || '').trim();
    attrs.api_key = next ? encryptApiKey(next) : '';
  }
  await instance.update(attrs);
  return toView(instance);
}

/** 删除渠道。返回是否真的删掉了记录。 */
async function deleteChannel(id) {
  const instance = await ChannelApi.findByPk(id);
  if (!instance) {
    return { deleted: false, existed: false };
  }
  await instance.destroy();
  return { deleted: true, existed: true, channel_name: instance.channel_name };
}

// ── 明文揭示 + 审计 ────────────────────────────────────────────────

/** 写一条 reveal 审计记录（fail-soft，永不抛）。 */
function auditReveal(actor, channel, plaintext) {
  const start = Date.now();
  return logToolExecution({
    tool: 'channel-api:reveal',
    params: {
      channel_id: channel.id,
      channel_name: channel.channel_name,
      masked_value: maskApiKey(plaintext),
      actor: String((actor && (actor.username || actor.id)) || ''),
    },
    result: { success: !!plaintext },
    permission: 'allow',
    elapsed: Date.now() - start,
  });
}

/**
 * 一次性返回明文 Key + 已替换真实 Key 的配置指南。
 * 明文只在响应体里出现一次；调用方不应持久化。
 */
async function revealChannelKey(id, actor = {}) {
  const instance = await ChannelApi.findByPk(id);
  if (!instance) {
    throw new ChannelApiValidationError(`渠道不存在 (id=${id})`, 'MODEL_NOT_FOUND');
  }
  const plaintext = decryptApiKey(instance.api_key);
  auditReveal(actor, instance, plaintext);
  return {
    id: instance.id,
    channel_name: instance.channel_name,
    masked_key: maskApiKey(plaintext),
    has_key: !!plaintext,
    api_key: plaintext,
    config: buildConfigGuide(instance, plaintext),
  };
}

// ── 配置指南 ───────────────────────────────────────────────────────

/** 依据渠道记录生成 shell / json / yaml / toml 代码块。 */
function buildConfigGuide(instance, plaintext) {
  const channel = toView(instance);
  const agent = findAgentGuide(instance.channel_name);
  const envVar = String(instance.key_env_var || '').trim();
  const endpoint = String(instance.endpoint_url || '').trim();
  const method = instance.config_method;
  const blocks = [];

  // 未揭示时用占位符（可复制的模板）；配置文件类块改用 ${ENV} 引用，因为
  // Continue.dev / Cursor 等工具原生支持环境变量插值，直接贴明文反而更危险。
  const keyPlaceholder = '<你的 API Key>';
  const shellKey = String(plaintext ?? '').trim() || keyPlaceholder;
  const fileKey = shellKey === keyPlaceholder && envVar ? `\${${envVar}}` : shellKey;

  const wantsEnv = (method === 'env_var' || method === 'both') && envVar;
  const wantsFile = method === 'config_file' || method === 'both';

  if (wantsEnv) {
    const lines = [`export ${envVar}="${shellKey}"`];
    if (endpoint) {
      const baseVar = envVar.replace(/API_KEY$/i, 'BASE_URL');
      lines.push(`export ${baseVar}="${endpoint}" # 自建/自定义网关才需要`);
    }
    blocks.push({ lang: 'shell', title: '环境变量（Shell）', code: lines.join('\n') });
  }

  if (wantsFile) {
    const lang = agent && agent.fileLang ? agent.fileLang : 'json';
    const target = agent && agent.configFile ? agent.configFile : '~/.config/channel.json';
    let code = '';
    if (lang === 'yaml') {
      code =
        `# ${target}\n` +
        `models:\n` +
        `  - name: "${instance.channel_name}"\n` +
        (endpoint ? `    apiBase: "${endpoint}"\n` : '') +
        `    apiKey: ${fileKey}`;
    } else if (lang === 'toml') {
      code =
        `# ${target}\n` +
        `model_provider = "openai"\n\n` +
        `[model_providers.openai]\n` +
        `name = "OpenAI"\n` +
        (endpoint ? `base_url = "${endpoint}"\n` : '') +
        `env_key = "${envVar || 'OPENAI_API_KEY'}"`;
    } else {
      const obj = {
        channel: instance.channel_name,
        ...(endpoint ? { endpoint } : {}),
        ...(envVar ? { [envVar]: fileKey } : {}),
      };
      code = `// ${target}\n${JSON.stringify(obj, null, 2)}`;
    }
    blocks.push({ lang, title: `配置文件（${target}）`, code });
  }

  if (blocks.length === 0) {
    blocks.push({
      lang: 'shell',
      title: '配置提示',
      code: `渠道「${instance.channel_name}」尚未填写端点与 Key，请到编辑页补齐后再生成配置命令。`,
    });
  }

  return {
    ...channel,
    agent,
    blocks,
    copy: {
      envExport: wantsEnv ? `export ${envVar}="${shellKey}"` : '',
      endpoint: endpoint || '',
      envVar,
    },
    docs_url: instance.docs_url || (agent && agent.docsUrl) || '',
  };
}

/** 单渠道配置指南（Key 占位，不含明文）。 */
async function getConfigGuide(id) {
  const instance = await ChannelApi.findByPk(id);
  if (!instance) {
    throw new ChannelApiValidationError(`渠道不存在 (id=${id})`, 'MODEL_NOT_FOUND');
  }
  return buildConfigGuide(instance, '');
}

/** 内置 Agent 配置文档清单（不依赖数据库行，供文档区渲染）。 */
function listAgentGuides() {
  return AGENT_CONFIG_GUIDES.map((g) => ({
    agent: g.agent,
    provider: g.provider,
    methods: g.methods,
    envVars: g.envVars,
    configFile: g.configFile,
    fileLang: g.fileLang,
    steps: g.steps,
    docsUrl: g.docsUrl,
  }));
}

// ── 预置数据 ───────────────────────────────────────────────────────

/** 组装预置渠道行（端点从 providerPresets 派生，避免第三方域名散落）。 */
function buildSeedRows() {
  const anthropicBase = presetBaseUrl('anthropic');
  const openaiBase = presetBaseUrl('openai');
  const anthropicEndpoint = anthropicBase ? `${anthropicBase}/v1/messages` : '';
  const openaiEndpoint = openaiBase ? `${openaiBase}/chat/completions` : '';
  const needFill = '端点与 Key 由使用方填写';

  return [
    {
      channel_name: 'Claude Code',
      provider: 'Anthropic',
      endpoint_url: anthropicEndpoint,
      api_key: '',
      key_env_var: 'ANTHROPIC_API_KEY',
      config_method: 'both',
      notes: '官方 Anthropic 通道；支持环境变量与 ~/.claude/settings.json',
    },
    {
      channel_name: 'CommandCode',
      provider: 'OpenAI',
      endpoint_url: openaiEndpoint,
      api_key: '',
      key_env_var: 'OPENAI_API_KEY',
      config_method: 'env_var',
      notes: 'OpenAI 兼容通道；非官方端点需同时设置 OPENAI_BASE_URL',
    },
    {
      channel_name: 'ZCode',
      provider: '自定义',
      endpoint_url: '',
      api_key: '',
      key_env_var: '',
      config_method: 'env_var',
      notes: needFill,
    },
    {
      channel_name: 'Codex',
      provider: 'OpenAI',
      endpoint_url: openaiEndpoint,
      api_key: '',
      key_env_var: 'OPENAI_API_KEY',
      config_method: 'both',
      notes: '官方 OpenAI 通道；配置见 ~/.codex/config.toml',
    },
    {
      channel_name: 'Cursor',
      provider: 'OpenAI',
      endpoint_url: openaiEndpoint,
      api_key: '',
      key_env_var: 'OPENAI_API_KEY',
      config_method: 'both',
      notes: '官方 OpenAI 通道；Settings → Models → API Keys',
    },
    {
      channel_name: 'Cline',
      provider: 'Anthropic',
      endpoint_url: anthropicEndpoint,
      api_key: '',
      key_env_var: 'ANTHROPIC_API_KEY',
      config_method: 'both',
      notes: '官方 Anthropic 通道；Key 由 VS Code 扩展用系统钥匙串加密保存',
    },
    {
      channel_name: 'Continue.dev',
      provider: '多供应商',
      endpoint_url: '',
      api_key: '',
      key_env_var: '',
      config_method: 'config_file',
      notes: `${needFill}；配置见 ~/.continue/config.yaml`,
    },
  ];
}

/**
 * 幂等写入预置渠道：按 channel_name 去重，已存在则保留用户改动。
 * @returns {{created:number, kept:number, total:number}}
 */
async function seedChannelApis() {
  const rows = buildSeedRows();
  let created = 0;
  let kept = 0;
  for (const row of rows) {
    const existing = await ChannelApi.findOne({ where: { channel_name: row.channel_name } });
    if (existing) {
      kept += 1;
      continue;
    }
    await ChannelApi.create(row);
    created += 1;
  }
  return { created, kept, total: rows.length };
}

module.exports = {
  ChannelApiValidationError,
  CONFIG_METHODS,
  AGENT_CONFIG_GUIDES,
  listChannels,
  getChannel,
  createChannel,
  updateChannel,
  deleteChannel,
  revealChannelKey,
  getConfigGuide,
  listAgentGuides,
  buildConfigGuide,
  seedChannelApis,
  // Exposed for unit tests / derivation only.
  sanitizeInput,
  toView,
  findAgentGuide,
  buildSeedRows,
};

/**
 * gatewayGuide — 终端「模型网关新手引导」的单一真源（纯叶子）。
 *
 * 纯叶子契约:零 IO、确定性、env 门控默认开、绝不抛。本模块只产出**结构化数据
 * 与可打印文本**(三步叙事 / 配置方式说明 / 去哪申请 Key),供两处消费:
 *   - `khy gateway guide` 命令(handlers/gateway.js)直接打印;
 *   - 首启引导向导(cli/onboarding.js)复用同一份文案,避免重复维护。
 *
 * provider 申请信息复用 services/gateway/providerPresets 的公开 links/keyExample,
 * 不在此硬编码任何域名;providerPresets 仅读 process.env(无磁盘/网络),故本叶子
 * 保持零 IO。门控 KHY_GATEWAY_GUIDE(默认开,{0,false,off,no} 回退)仅影响**主动
 * 提示**(guideHintLine);buildGuide/renderGuide 永远可用。
 */
'use strict';

const providerPresets = require('./providerPresets');

// 三步叙事:打开网关页/向导第一眼就知道要做什么。
const GATEWAY_STEPS = [
  { n: 1, title: '选择供应商', desc: '挑一个 AI 服务商(DeepSeek/通义千问/OpenAI/Claude…)或一个 API 中转站。' },
  { n: 2, title: '填入 API Key', desc: '到供应商控制台申请 Key 后粘贴进来;khy 会安全存入本地密钥池。' },
  { n: 3, title: '选择模型', desc: '为该供应商选一个默认模型,之后对话即用它,随时可换。' },
];

// 四种配置方式:讲清「何时用 / 怎么配」,覆盖小白到进阶。
const CONFIG_METHODS = [
  {
    key: 'direct',
    label: '直连厂商 Key',
    when: '你已有某家官方/厂商的 API Key',
    how: '运行 `khy gateway config` → 「配置模型厂商 API Key」,选厂商并粘贴 Key。',
  },
  {
    key: 'relay',
    label: 'API 中转 (Relay)',
    when: '想用一个中转站统一接入多家模型',
    how: '运行 `khy gateway config` → 「配置 API 中转」,填中转站 baseUrl 与 Key。',
  },
  {
    key: 'ollama',
    label: '本地 Ollama',
    when: '想离线/本地跑模型,无需任何 Key',
    how: '先安装并启动 Ollama,再 `khy gateway config` → 「配置 Ollama 本地模型」。',
  },
  {
    key: 'oauth',
    label: '账号登录 (OAuth)',
    when: '用 Claude/Codex 等账号订阅额度而非 API Key',
    how: '运行 `/login` 走对应供应商的账号登录,使用订阅额度,无需手填 Key。',
  },
];

// 已知 provider id → 内置环境变量名(与 builtinProviderConfig 命名一致)。
// 未列出的 id 回退 `<ID>_API_KEY`,仅作进阶用户「直接设环境变量」的提示。
const ENV_BY_ID = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  qwen: 'QWEN_API_KEY',
  zhipu: 'GLM_API_KEY',
  gemini: 'GEMINI_API_KEY',
  moonshot: 'MOONSHOT_API_KEY',
};

/** 派生某 provider id 的环境变量名(确定性,绝不抛)。 */
function envVarForId(id) {
  const key = String(id || '').trim().toLowerCase();
  if (!key) return '';
  return ENV_BY_ID[key] || `${key.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;
}

/**
 * 把 providerPresets 映射成「去哪申请 Key」清单:仅保留有 console 链接的项
 * (那是真正能创建 Key 的页面)。绝不改入参,fail-soft 返回数组。
 *
 * @param {Array} [presets] 可注入测试用;缺省取 providerPresets.getProviderPresets()
 * @returns {Array<{id,label,console,docs,home,keyExample,defaultModel,envVar}>}
 */
function buildKeyReferences(presets) {
  let list = presets;
  if (!Array.isArray(list)) {
    try { list = providerPresets.getProviderPresets(); } catch { list = []; }
  }
  const out = [];
  for (const p of list) {
    if (!p || typeof p !== 'object') continue;
    const links = (p.links && typeof p.links === 'object') ? p.links : {};
    if (!links.console) continue; // 没有「创建 Key」页面的不进申请清单
    out.push({
      id: String(p.id || ''),
      label: String(p.label || p.id || ''),
      console: String(links.console || ''),
      docs: String(links.docs || ''),
      home: String(links.home || ''),
      keyExample: String(p.keyExample || ''),
      defaultModel: String(p.defaultModel || ''),
      envVar: envVarForId(p.id),
    });
  }
  return out;
}

/**
 * 组装完整引导数据结构。providers 项可携带 configured 标记(由调用方传入已配置的
 * pool key 集合推导),用于在引导里标注「✓ 已配置」。确定性、零 IO、绝不抛。
 *
 * @param {object} [opts]
 * @param {Array|Set} [opts.configured] 已配置的 provider id/poolKey 集合
 * @param {Array} [opts.presets] 注入 presets(测试用)
 * @returns {{intro:string, steps:Array, methods:Array, providers:Array}}
 */
function buildGuide(opts = {}) {
  const configuredSet = toLowerSet(opts.configured);
  const providers = buildKeyReferences(opts.presets).map((p) => ({
    ...p,
    configured: configuredSet.has(String(p.id || '').toLowerCase()),
  }));
  return {
    intro: '模型网关 = 让 khy 连上某个 AI 模型。三步即可开始:选供应商 → 填 Key → 选模型。',
    steps: GATEWAY_STEPS.map((s) => ({ ...s })),
    methods: CONFIG_METHODS.map((m) => ({ ...m })),
    providers,
  };
}

function toLowerSet(input) {
  const set = new Set();
  if (!input) return set;
  const arr = (input instanceof Set) ? Array.from(input) : (Array.isArray(input) ? input : []);
  for (const v of arr) set.add(String(v == null ? '' : v).toLowerCase());
  return set;
}

/**
 * 把引导渲染成可直接打印的行数组。`c` 为可选 chalk 实例;缺省纯文本(确定性)。
 * 绝不抛;未知/缺字段安全跳过。
 *
 * @param {object} guide buildGuide() 的返回
 * @param {object} [opts]
 * @param {object} [opts.c] chalk-like 着色器(bold/cyan/dim/green/yellow)
 * @returns {string[]}
 */
function renderGuide(guide, opts = {}) {
  const g = (guide && typeof guide === 'object') ? guide : buildGuide();
  const c = opts.c || null;
  const bold = (s) => (c && c.bold ? c.bold(s) : s);
  const cyan = (s) => (c && c.cyan ? c.cyan(s) : s);
  const dim = (s) => (c && c.dim ? c.dim(s) : s);
  const green = (s) => (c && c.green ? c.green(s) : s);
  const yellow = (s) => (c && c.yellow ? c.yellow(s) : s);

  const lines = [];
  lines.push('');
  lines.push(bold('🚀 模型网关 · 从这里开始'));
  if (g.intro) lines.push(dim('  ' + g.intro));
  lines.push('');

  lines.push(bold('  三步配置'));
  for (const s of (g.steps || [])) {
    lines.push('  ' + cyan(`${s.n}. ${s.title}`) + dim(' — ' + (s.desc || '')));
  }
  lines.push('');

  lines.push(bold('  配置方式(按你的情况选一种)'));
  for (const m of (g.methods || [])) {
    lines.push('  ' + cyan('• ' + m.label) + dim('  适用:' + (m.when || '')));
    if (m.how) lines.push('      ' + dim(m.how));
  }
  lines.push('');

  lines.push(bold('  去哪申请 API Key'));
  for (const p of (g.providers || [])) {
    const mark = p.configured ? green(' ✓ 已配置') : '';
    lines.push('  ' + cyan('• ' + p.label) + mark);
    if (p.console) lines.push('      ' + dim('申请:') + ' ' + p.console);
    if (p.docs) lines.push('      ' + dim('文档:') + ' ' + p.docs);
    if (p.keyExample) lines.push('      ' + dim('示例:') + ' ' + p.keyExample);
    if (p.envVar) lines.push('      ' + dim('环境变量(进阶):') + ' ' + p.envVar);
  }
  lines.push('');
  lines.push(dim('  提示:运行 ') + yellow('khy gateway guide') + dim(' 可随时再看本引导;') + yellow('khy gateway config') + dim(' 开始配置。'));
  lines.push('');
  return lines;
}

/** KHY_GATEWAY_GUIDE 门控:默认开,{0,false,off,no} 回退关。 */
function isEnabled() {
  const raw = String(process.env.KHY_GATEWAY_GUIDE == null ? '' : process.env.KHY_GATEWAY_GUIDE)
    .trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(raw);
}

/**
 * 一行主动提示,指向 `khy gateway guide`。门控关 → 返回空串(字节不变)。
 * @returns {string}
 */
function guideHintLine() {
  if (!isEnabled()) return '';
  return '💡 新手不知怎么配?运行 `khy gateway guide` 看图配置。';
}

module.exports = {
  GATEWAY_STEPS,
  CONFIG_METHODS,
  envVarForId,
  buildKeyReferences,
  buildGuide,
  renderGuide,
  isEnabled,
  guideHintLine,
};

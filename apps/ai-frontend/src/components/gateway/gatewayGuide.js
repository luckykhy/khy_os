/**
 * gatewayGuide — Web 端「模型网关新手引导」的内容单一真源(纯 ESM,无 Vue 依赖)。
 *
 * 与后端 services/gateway/gatewayGuide.js 同义但各为其平面的 SSOT(两个运行时
 * 无法共享 CommonJS/ESM 模块)。GatewayOnboarding.vue 是它的薄视图。保持纯逻辑、
 * 可用内置 Node 运行器单测(apps/ai-frontend 为 type:module):
 *
 *   node --test src/components/gateway/gatewayGuide.test.js
 *
 * provider 申请信息来自后端 providerPresets(经 API 注入 presets prop),此处不硬编码
 * 任何域名。
 */

// 三步叙事:打开网关页第一眼就知道要做什么。
export const GATEWAY_STEPS = [
  { n: 1, title: '选择供应商', desc: '挑一个 AI 服务商(DeepSeek/通义千问/OpenAI/Claude…)或一个 API 中转站。' },
  { n: 2, title: '填入 API Key', desc: '到供应商控制台申请 Key 后粘贴进来;系统会安全存入你的密钥池。' },
  { n: 3, title: '选择模型', desc: '为该供应商选一个默认模型,之后对话即用它,随时可换。' },
];

// 四种配置方式:讲清「何时用 / 怎么配」。
export const CONFIG_METHODS = [
  { key: 'direct', label: '直连厂商 Key', when: '你已有某家官方/厂商的 API Key', how: '在下方「API 密钥池 / 供应商」添加厂商并粘贴 Key。' },
  { key: 'relay', label: 'API 中转 (Relay)', when: '想用一个中转站统一接入多家模型', how: '在「上游中转 / Relay」填中转站 baseUrl 与 Key,自动探测可用模型。' },
  { key: 'ollama', label: '本地 Ollama', when: '想离线/本地跑模型,无需任何 Key', how: '先安装并启动 Ollama,再在网关里指向本地 http://127.0.0.1:11434。' },
  { key: 'oauth', label: '账号登录 (OAuth)', when: '用 Claude/Codex 等账号订阅额度而非 API Key', how: '在「Claude Code 接入 / 账号」用对应供应商账号登录,使用订阅额度。' },
];

/**
 * 把 providerPresets 映射成「去哪申请 Key」清单:仅保留有 console 链接的项
 * (那是真正能创建 Key 的页面)。绝不改入参,fail-soft:非数组 → []。
 *
 * @param {Array} presets 来自后端 providerPresets 的数组(经 API)
 * @returns {Array<{id,label,console,docs,home,keyExample,defaultModel}>}
 */
export function buildKeyReferences(presets) {
  if (!Array.isArray(presets)) return [];
  const out = [];
  for (const p of presets) {
    if (!p || typeof p !== 'object') continue;
    const links = (p.links && typeof p.links === 'object') ? p.links : {};
    const consoleUrl = String(links.console || '').trim();
    if (!consoleUrl) continue; // 没有「创建 Key」页面的不进申请清单
    out.push({
      id: String(p.id || ''),
      label: String(p.label || p.id || ''),
      console: consoleUrl,
      docs: String(links.docs || '').trim(),
      home: String(links.home || '').trim(),
      keyExample: String(p.keyExample || ''),
      defaultModel: String(p.defaultModel || ''),
    });
  }
  return out;
}

/**
 * 组装完整引导视图模型。
 * @param {object} [opts]
 * @param {Array} [opts.presets]
 * @returns {{intro:string, steps:Array, methods:Array, providers:Array}}
 */
export function buildGuide(opts = {}) {
  return {
    intro: '模型网关 = 让系统连上某个 AI 模型。三步即可开始:选供应商 → 填 Key → 选模型。',
    steps: GATEWAY_STEPS.map((s) => ({ ...s })),
    methods: CONFIG_METHODS.map((m) => ({ ...m })),
    providers: buildKeyReferences(opts.presets),
  };
}

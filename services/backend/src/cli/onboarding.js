'use strict';

/**
 * 首次引导向导 (Onboarding Wizard) —— 模型网关版。
 *
 * 目标:小白第一次启动 khy 时,用一段引导把「网关 = 连上一个 AI 模型」讲清楚,并
 * 当场完成「选供应商 → 填 API Key → 选模型」,Key 真正落到密钥池(此前的旧向导是
 * 死代码:既没被任何地方调用,捕获的 apiKey 也从不持久化)。
 *
 * 设计:
 *   - 文案来自单一真源 services/gateway/gatewayGuide(三步/配置方式/去哪申请 Key),
 *     与 `khy gateway guide` 命令、Web 引导同义,不重复维护。
 *   - Key 持久化复用 services/gateway/builtinProviderConfig.applyBuiltinProviderKey
 *     (pool + env + route map 的单一真源),向导只做交互外壳。
 *   - 所有 IO(inquirer / 持久化 / 已配置探测 / flag 读写)均可注入,便于单测。
 *   - 完成标记 flag 落到 dataHome(getDataHome),并兼容旧 ~/.khyquant 位置的 flag,
 *     已配置或已完成的老用户绝不被再次打扰。
 *   - 门控 KHY_ONBOARDING(默认开,{0,false,off,no} 回退)。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const guide = require('../services/gateway/gatewayGuide');

// 旧版 flag 位置(向后兼容:存在即视为已完成,不再打扰)。
const LEGACY_FLAG = path.join(os.homedir(), '.khyquant', '.onboarding-done');

/** 规范 flag 路径:落到 dataHome;解析失败回退 legacy。 */
function flagPath() {
  try {
    const home = require('../utils/dataHome').getDataHome();
    if (home) return path.join(home, '.onboarding-done');
  } catch { /* 回退 legacy */ }
  return LEGACY_FLAG;
}

/** KHY_ONBOARDING 门控:默认开,{0,false,off,no} 回退关。 */
function isWizardEnabled() {
  const raw = String(process.env.KHY_ONBOARDING == null ? '' : process.env.KHY_ONBOARDING)
    .trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(raw);
}

/** 是否需要引导:任一位置存在完成 flag → 否。 */
function needsOnboarding() {
  try {
    if (fs.existsSync(flagPath())) return false;
    if (fs.existsSync(LEGACY_FLAG)) return false;
    return true;
  } catch {
    return true;
  }
}

/** 标记引导完成(best-effort,绝不抛)。 */
function markOnboardingDone() {
  try {
    const target = flagPath();
    const dir = path.dirname(target);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(target, JSON.stringify({ completedAt: new Date().toISOString(), version: '2.0.0' }));
  } catch { /* best-effort */ }
}

// poolKey ⇄ providerPresets.id 的别名(命名不一致处)。
const POOLKEY_TO_PRESET = { glm: 'zhipu' };

/** 取某内置 provider 对应的 presets 公开链接(home/console/docs);无则 {}。 */
function linkForProvider(provider, presets) {
  if (!provider) return {};
  const pk = String(provider.poolKey || '').toLowerCase();
  const want = POOLKEY_TO_PRESET[pk] || pk;
  const hit = (Array.isArray(presets) ? presets : []).find(
    (p) => String(p && p.id || '').toLowerCase() === want
  );
  return (hit && hit.links && typeof hit.links === 'object') ? hit.links : {};
}

/**
 * 构造「选供应商」清单。只保留快速向导能直接配的:有默认 endpoint 的直连厂商,
 * 或 token 型(HuggingFace)。中转(Relay)/Trae 等需额外 endpoint 的留给
 * `khy gateway config`。每项附带 presets 链接,供向导展示「去哪申请 Key」。
 *
 * @returns {Array<{name:string, value:{provider:object, links:object}}>}
 */
function buildProviderChoices(providers, presets) {
  const list = Array.isArray(providers) ? providers : [];
  const out = [];
  for (const p of list) {
    if (!p || typeof p !== 'object') continue;
    const hasEndpoint = !!(p.defaultEndpoint && String(p.defaultEndpoint).trim());
    if (!p.isToken && !hasEndpoint) continue; // relay/trae 等留给 gateway config
    out.push({ name: p.name, value: { provider: p, links: linkForProvider(p, presets) } });
  }
  return out;
}

// ── 默认依赖(可注入覆盖,便于单测) ──────────────────────────────────

function defaultListProviders() {
  try { return require('../services/gateway/builtinProviderConfig').listBuiltinProviders(); }
  catch { return []; }
}

function defaultGetPresets() {
  try { return require('../services/gateway/providerPresets').getProviderPresets(); }
  catch { return []; }
}

function defaultApplyKey(input) {
  return require('../services/gateway/builtinProviderConfig').applyBuiltinProviderKey(input);
}

/** 是否已配置过任意模型供应商(密钥池有 Key,或任一内置 env Key 已设)。 */
function defaultHasConfiguredProvider() {
  try {
    const pool = require('../services/apiKeyPool');
    try { pool.init(); } catch { /* already initialised */ }
    const providers = (typeof pool.getProviders === 'function') ? pool.getProviders() : [];
    for (const pv of (Array.isArray(providers) ? providers : [])) {
      try { if ((pool.getPoolStatus(pv) || []).length > 0) return true; } catch { /* ignore */ }
    }
  } catch { /* pool 不可用 → 看 env */ }
  try {
    for (const p of defaultListProviders()) {
      if (p && p.envKey && process.env[p.envKey]) return true;
    }
  } catch { /* ignore */ }
  return false;
}

/**
 * 运行首次引导向导。交互由注入的 inquirer 驱动(默认 require('inquirer'))。
 * 返回 { ok|skipped, ... },绝不抛(失败也只是回落,不挡启动)。
 *
 * @param {object} [opts]
 * @param {object} [opts.inquirer] inquirer 实例(prompt(questions)=>answers)
 * @param {object} [opts.io] { log, error }
 * @param {object} [opts.c]  chalk 实例(可选着色)
 * @param {object} [opts.deps] { listProviders, getPresets, applyKey, hasConfiguredProvider, markDone, needs }
 * @returns {Promise<object>}
 */
async function runOnboarding(opts = {}) {
  const io = opts.io || { log: console.log, error: console.error };
  const log = (...a) => { try { io.log(...a); } catch { /* non-critical */ } };
  const c = opts.c || null;
  const paint = (fn, s) => (c && typeof c[fn] === 'function' ? c[fn](s) : s);

  const deps = opts.deps || {};
  const listProviders = deps.listProviders || defaultListProviders;
  const getPresets = deps.getPresets || defaultGetPresets;
  const applyKey = deps.applyKey || defaultApplyKey;
  const hasConfigured = deps.hasConfiguredProvider || defaultHasConfiguredProvider;
  const markDone = deps.markDone || markOnboardingDone;
  const needs = deps.needs || needsOnboarding;

  if (!isWizardEnabled()) return { skipped: 'disabled' };
  if (!needs()) return { skipped: 'done' };
  // 老用户升级:已经配过模型 → 静默标记完成,绝不打扰。
  try { if (hasConfigured()) { markDone(); return { skipped: 'configured' }; } } catch { /* 继续引导 */ }

  // 'inquirer' in opts 时一律尊重传入值(含显式 null=强制非交互);仅省略时才加载真 inquirer。
  const inquirer = ('inquirer' in opts)
    ? opts.inquirer
    : (() => { try { return require('inquirer'); } catch { return null; } })();
  if (!inquirer || typeof inquirer.prompt !== 'function') {
    // 无法交互:打印引导文字后标记完成,不阻塞。
    for (const line of guide.renderGuide(guide.buildGuide(), { c })) log(line);
    markDone();
    return { skipped: 'non-interactive' };
  }

  // ── 欢迎 + 引导全文 ──
  for (const line of guide.renderGuide(guide.buildGuide(), { c })) log(line);

  // ── 首次安全须知(CC Onboarding.tsx securityStep 对齐;门控 KHY_ONBOARDING_SAFETY_NOTICE)──
  // 纯叶子只产未着色行;门控关 → 空数组 → 零输出 → 逐字节回退。fail-soft:绝不阻塞引导。
  try {
    const safety = require('../services/onboarding/safetyNotice');
    const lines = safety.buildSafetyNoticeLines(process.env);
    if (lines.length) {
      log('');
      for (const line of lines) log(paint('dim', line));
      log('');
    }
  } catch { /* 安全须知非关键:任何异常静默跳过,继续引导 */ }

  let action;
  try {
    ({ action } = await inquirer.prompt([{
      type: 'list',
      name: 'action',
      message: '现在配置一个模型吗?',
      choices: [
        { name: '现在配置(选供应商 + 填 API Key)', value: 'configure' },
        { name: '稍后再说(可随时运行 khy gateway guide / khy gateway config)', value: 'skip' },
      ],
    }]));
  } catch {
    markDone();
    return { skipped: 'aborted' };
  }

  if (action !== 'configure') {
    log(paint('dim', '  已跳过。需要时运行 ') + paint('yellow', 'khy gateway guide') + paint('dim', ' 查看引导。'));
    markDone();
    return { skipped: 'user' };
  }

  // ── 选供应商 ──
  const choices = buildProviderChoices(listProviders(), getPresets());
  if (!choices.length) {
    log(paint('yellow', '  暂无可快速配置的内置供应商,请运行 khy gateway config。'));
    markDone();
    return { skipped: 'no-providers' };
  }
  let picked;
  try {
    ({ picked } = await inquirer.prompt([{
      type: 'list',
      name: 'picked',
      message: '选择模型供应商:',
      choices: [
        ...choices,
        { name: '其他 / 中转站(改用 khy gateway config)', value: null },
      ],
    }]));
  } catch {
    markDone();
    return { skipped: 'aborted' };
  }
  if (!picked) {
    log(paint('dim', '  好的,运行 ') + paint('yellow', 'khy gateway config') + paint('dim', ' 配置其他供应商或中转站。'));
    markDone();
    return { skipped: 'other' };
  }

  const { provider, links } = picked;

  // 展示「去哪申请 Key」
  if (links && links.console) {
    log(paint('dim', `  申请 ${provider.name} 的 API Key:`) + ' ' + links.console);
    if (links.docs) log(paint('dim', '  文档:') + ' ' + links.docs);
  }

  // ── 输入 Key ──
  let keyInput;
  try {
    ({ keyInput } = await inquirer.prompt([{
      type: 'password',
      name: 'keyInput',
      mask: '*',
      message: `粘贴 ${provider.name} 的 API Key(留空跳过):`,
    }]));
  } catch {
    markDone();
    return { skipped: 'aborted' };
  }
  if (!keyInput || !String(keyInput).trim()) {
    log(paint('dim', '  未输入 Key。稍后可运行 ') + paint('yellow', 'khy gateway config') + paint('dim', ' 添加。'));
    markDone();
    return { skipped: 'no-key' };
  }

  // ── 选默认模型(可选) ──
  let model = '';
  const models = Array.isArray(provider.models) ? provider.models.filter(Boolean) : [];
  if (models.length) {
    try {
      ({ model } = await inquirer.prompt([{
        type: 'list',
        name: 'model',
        message: '选择默认模型:',
        choices: [...models.map((m) => ({ name: m, value: m })), { name: '暂不指定(用供应商默认)', value: '' }],
      }]));
    } catch { model = ''; }
  }

  // ── 持久化 ──
  try {
    const result = applyKey({ provider, keyInput: String(keyInput).trim(), model });
    markDone();
    log('');
    log(paint('green', `  ✓ ${provider.name} 已配置`) + (model ? paint('dim', `(默认模型 ${model})`) : ''));
    log(paint('dim', '  随时运行 ') + paint('yellow', 'khy gateway guide') + paint('dim', ' 再看引导,或 ') + paint('yellow', 'khy gateway config') + paint('dim', ' 管理配置。'));
    log('');
    return { ok: true, provider: provider.poolKey || provider.name, model, result };
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    log(paint('yellow', `  保存失败:${msg}`));
    log(paint('dim', '  可稍后运行 ') + paint('yellow', 'khy gateway config') + paint('dim', ' 重试。'));
    markDone();
    return { ok: false, error: msg };
  }
}

module.exports = {
  // 主入口
  runOnboarding,
  needsOnboarding,
  markOnboardingDone,
  isWizardEnabled,
  // 纯helper(供测试/复用)
  buildProviderChoices,
  linkForProvider,
  flagPath,
  LEGACY_FLAG,
};

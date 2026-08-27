'use strict';

/**
 * agentModelProjection.js — 把外部智能体(opencode / claude-code)已配置的模型**投影**成
 * khy 可直接调用、且带来源标签的模型,形如 `glm5.3(opencode)` / `step-3.7-flash(claudecode)`。
 *
 * 目标(承「发现电脑中智能体的 API 即可调用,复用配置文件避免重复配置」):
 *   - **发现**:读 opencode 的 `opencode.json` 与 Claude Code 的 `~/.claude/settings.json`,
 *     复用 externalApps/opencodeAdapter · claudeCodeAdapter 的 `usable()`(单一真源),绝不复制
 *     各自的配置解析逻辑。
 *   - **投影**:把每家已配置、带 key 的模型输出为一条「可用的 khy 模型」,`name` = `<模型>(<来源>)`。
 *   - **路由**:每条投影模型都指向 gateway 里已存在的**对应适配器**:
 *       · opencode     → `opencode`(opencodeAdapter 指挥 opencode CLI,读它自己的 opencode.json)
 *       · claude-code  → `claude`(claudeAdapter,env 由 ccEnvAdoptPolicy 采纳后即复用同一套凭据)
 *     khy 不需要替用户重复配置 endpoint/key——各自 agent 的配置文件就是真源。
 *
 * 竞品、与 appModelImporter 的分工:
 *   - appModelImporter 把外部 provider **注册成 khy 的 custom provider**(apiKeyPool),走
 *     OpenAI 兼容协议的 apiAdapter。对 opencode(OpenAI 兼容)可行,但 claude-code 的 stepfun 是中继
 *     的 **Anthropic 协议**,无法走 apiAdapter。故两家的调用路径本就不同。
 *   - 本模块只做「**发现 + 投影 + 指向正确适配器**」,不写任何配置/凭据(调用时序员只读)。
 *     真实「注册/采纳」动作由调用方(模型选择器)视需要触发:opencode 直接指挥 CLI;
 *     claude-code 经 ccEnvAdoptPolicy 采纳 env。
 *
 * 契约:门控 `KHY_AGENT_MODEL_PROJECTION`(默认开;flagRegistry 优先,叶子本地 CANON 回退仅 {0,false,off,no} 关);
 * fail-soft(绝不抛 → { ok:false, error });每家独立,一家不装不影响其余家。
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/**
 * 门控。与其它叶子一致的本地 CANON 回退。
 * @param {Record<string,string>} [env]
 */
function isEnabled(env = process.env) {
  try {
    const reg = require('../flagRegistry');
    if (reg && typeof reg.isFlagEnabled === 'function') {
      return reg.isFlagEnabled('KHY_AGENT_MODEL_PROJECTION', env);
    }
  } catch {
    /* registry unavailable — local CANON fallback */
  }
  const raw = env && env.KHY_AGENT_MODEL_PROJECTION;
  const v = String(raw === undefined || raw === null ? 'true' : raw)
    .trim()
    .toLowerCase();
  return !_FALSY.has(v);
}

/**
 * 来源单。`module` 是 externalApps 下适配器的实际文件名(不含 .js,注意 camelCase);
 * `app` 是 appModelImporter 用的 app id;`adapter` 是对应 gateway 适配器的 type。
 */
const SOURCES = Object.freeze([
  Object.freeze({ source: 'opencode', label: 'opencode', app: 'opencode', module: 'opencodeAdapter', adapter: 'opencode' }),
  Object.freeze({ source: 'claudecode', label: 'claudecode', app: 'claude-code', module: 'claudeCodeAdapter', adapter: 'claude' }),
]);

/** 从 externalApps 的 `usable()` 投影出该 source 的全部可调用模型。fail-soft。 */
function _projectSource(entry, env) {
  let mod;
  try {
    mod = require(`../externalApps/${entry.module}`);
  } catch (e) {
    return { source: entry.source, label: entry.label, adapter: entry.adapter, models: [], error: String((e && e.message) || e) };
  }
  if (!mod || typeof mod.usable !== 'function') {
    return { source: entry.source, label: entry.label, adapter: entry.adapter, models: [], error: 'adapter 未实现 usable()' };
  }
  let res;
  try {
    res = mod.usable(env);
  } catch (e) {
    return { source: entry.source, label: entry.label, adapter: entry.adapter, models: [], error: String((e && e.message) || e) };
  }
  if (!res || !res.success) {
    return {
      source: entry.source,
      label: entry.label,
      adapter: entry.adapter,
      models: [],
      error: (res && res.error) || 'usable failed',
    };
  }
  const models = [];
  for (const p of res.providers || []) {
    const id = String((p && p.id) || '').trim();
    if (!id) {
      continue;
    }
    const list = Array.isArray(p.models) && p.models.length
      ? p.models.slice()
      : p.defaultModel
        ? [p.defaultModel]
        : [];
    const defaultModel = String((p && p.defaultModel) || list[0] || '').trim();
    const endpoint = String((p && p.endpoint) || '').trim();
    const hasKey = Boolean(p && (p.apiKey || p.hasKey));
    const isOpenCode = entry.app === 'opencode';
    for (const raw of list) {
      const model = String(raw || '').trim();
      if (!model) {
        continue;
      }
      // 可调用模型 id:
      //   · opencode  → `provider/model`(opencode run --model 只认该形式;模型名可含斜杠,如 openrouter/z-ai/glm-5.2:free)
      //   · claude    → 模型名(claudeAdapter 直接以 options.model 使用)
      const callableModel = isOpenCode ? `${id}/${model}` : model;
      models.push({
        id: model,
        model: callableModel,
        adapter: entry.adapter,
        source: entry.source,
        // 显示名 = `<模型ID>(<来源>·<提供商>)`,如 glm-5.3(opencode·opencode-go) ·
        // agnes-2.5-flash(opencode·agnes) · step-3.7-flash(claudecode·anthropic)。
        name: `${model}(${entry.label}·${id})`,
        provider: id,
        endpoint,
        hasKey,
        isDefault: Boolean(defaultModel && defaultModel === model),
        protocol: isOpenCode ? 'openai' : 'anthropic',
      });
    }
  }
  return { source: entry.source, label: entry.label, adapter: entry.adapter, models };
}

/**
 * 发现并投影全部已配置的外部智能体模型。绝不抛。
 * @param {Record<string,string>} [env]
 * @returns {{ ok:true, enabled:boolean, models:Array<object>, sources:Array<object> }
 *          | { ok:false, enabled:boolean, error:string, models:[], sources:[] }}
 */
function discover(env = process.env) {
  if (!isEnabled(env)) {
    return {
      ok: false,
      enabled: false,
      error: '外部智能体模型投影已被门控关闭（KHY_AGENT_MODEL_PROJECTION）',
      models: [],
      sources: [],
    };
  }
  const sources = SOURCES.map((entry) => _projectSource(entry, env));
  const models = sources.flatMap((s) => s.models || []);
  return { ok: true, enabled: true, models, sources };
}

/** 按 source 过滤投影模型(便于调用方只看某家)。 */
function bySource(env = process.env, source) {
  const all = discover(env);
  if (!all.ok) {
    return all;
  }
  const want = String(source || '').trim().toLowerCase();
  return {
    ok: true,
    enabled: true,
    models: all.models.filter((m) => m.source === want),
    sources: all.sources.filter((s) => s.source === want),
  };
}

/**
 * 会话内采纳 Claude Code 的 env(若 khy 尚未设置):把 `~/.claude/settings.json` 的
 * `env` 块里的 ANTHROPIC_* 键,在**缺失**时注入 `env`(通常是 process.env)。这样选中
 * `* (claudecode)` 模型后,claudeAdapter 在同一进程内即可复用 CC 的 endpoint/token/model。
 *
 * 只做**缺失才补**、绝不覆盖已有值、绝不抛。持久化(跨重启)由 `khy claude adopt-env` 负责,
 * 本函数只负责「本次会话自动可用」——直接复用配置文件,避免重复配置。
 *
 * @param {Record<string,string>} env 通常为 process.env;会被就地注入
 * @returns {{ adopted:boolean, count:number, reason?:string }}
 */
function ensureClaudeCodeEnv(env = process.env) {
  const e = env || process.env;
  const KEYS = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL'];
  try {
    const cc = require('../externalApps/claudeCodeAdapter');
    const file = cc.configPath(e);
    const text = require('fs').readFileSync(file, 'utf8');
    const doc = JSON.parse(text);
    const block = doc && doc.env && typeof doc.env === 'object' ? doc.env : {};
    let count = 0;
    for (const k of KEYS) {
      if (!e[k] && block[k]) {
        e[k] = block[k];
        count += 1;
      }
    }
    return { adopted: count > 0, count };
  } catch (err) {
    return { adopted: false, count: 0, reason: String((err && err.message) || err) };
  }
}

/**
 * 会话内采纳 opencode 的便携配置定位:若 env 尚未设置 OPENCODE_CONFIG_DIR/OPENCODE_DB,
 * 但从便携布局可解析到 opencode.json,则注入其**目录**与数据库路径。这样 khy 指挥
 * `opencode run` 时,opencode 读到的正是用户那套便携配置(复用配置文件,避免重复配置)。
 *
 * 只做**缺失才补**、绝不覆盖已有值、绝不抛。
 * @param {Record<string,string>} env 通常为 process.env
 * @returns {{ adopted:boolean, count:number, reason?:string }}
 */
function ensureOpenCodeEnv(env = process.env) {
  const e = env || process.env;
  try {
    const oc = require('../externalApps/opencodeAdapter');
    const cfgPath = oc.configPath(e);
    if (!cfgPath) {
      return { adopted: false, count: 0, reason: 'no-config-path' };
    }
    const configDir = require('path').dirname(cfgPath);
    let count = 0;
    if (!e.OPENCODE_CONFIG_DIR) {
      e.OPENCODE_CONFIG_DIR = configDir;
      count += 1;
    }
    if (!e.OPENCODE_DB) {
      e.OPENCODE_DB = require('path').join(configDir, 'opencode.db');
      count += 1;
    }
    return { adopted: count > 0, count };
  } catch (err) {
    return { adopted: false, count: 0, reason: String((err && err.message) || err) };
  }
}

module.exports = { isEnabled, SOURCES, discover, bySource, ensureClaudeCodeEnv, ensureOpenCodeEnv };

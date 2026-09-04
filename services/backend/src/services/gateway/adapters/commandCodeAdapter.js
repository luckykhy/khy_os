'use strict';

/**
 * commandCodeAdapter.js — dedicated gateway adapter that lets khyos *command*
 * the Command Code CLI as a first-class, individually-targetable executor
 * (peer of claudeAdapter / opencodeAdapter).
 *
 * 目标「让 khyos chat 也能用 minimax m3 free」:khyos already commands Claude
 * Code / Codex / Aider / OpenCode; Command Code was the missing CLI.
 * Registering a dedicated adapter key `commandcode` makes it reachable via
 * `gateway.generateWithAdapter('commandcode', ...)` and AgentTool
 * `subagent_type:'commandcode'` / `adapter:'commandcode'` (see aiGateway
 * `_adapters` and AgentTool roleMap).
 *
 * Design — thin shell over cliToolAdapter (no spawn/stream/idle-timeout
 * duplication): detection + invocation reuse cliToolAdapter's battle-tested
 * child-process machinery, targeted at commandcode via `cliTool:'commandcode'`.
 * Argument shaping lives in the pure leaf commandCodeInvocation.js.
 *
 * Gate KHY_COMMANDCODE (default off): when off, detect() reports unavailable
 * so the gateway skips this adapter entirely (byte-fallback to "commandcode
 * not wired"). Opt-in only.
 */

const { buildFailure } = require('./_responseBuilder');
const cliToolAdapter = require('./cliToolAdapter');
const invocation = require('./commandCodeInvocation');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function _available(force) {
  if (!invocation.isEnabled(process.env)) {
    return false;
  }
  return require('./_commandAvailability').isAvailable('cmdc', { force });
}

/**
 * cmdc auto-prefer 自检:把「能不能让 khy chat 默认走 cmdc」拆成 4 个独立
 * 条件,任一不满足都返回 ready:false (含原因),让调用方决定是否提权。
 *
 * 设计要点:
 *   1. 与 `generate()`/`listModels()` 完全字节级一致的判定路径(binary 走
 *      `_commandAvailability` 缓存层,auth 走与 provider.js _readAuth 同形读取),
 *      因此「doctor cmdc 说 ok」「khy chat 走 cmdc」「直接 cmdcode --print 能跑」
 *      三件事在 1 个进程内永远同进退。
 *   2. 读 auth.json / config.json 失败时**不抛**(try/catch 全包),仅 ready:false。
 *      aiGateway 提权逻辑也是 try/catch 全包,两层 fail-soft 叠加 → 字节级回退。
 *   3. 故意不复用 `_readConfigJson` / `_readAuth` —— 那些函数都直接读 process.env,
 *      而 auto-prefer 路径需要支持注入任意 env(便于单测),保持函数自包含。
 *   4. 返回 defaultModel 仅当 config.json 里有非空 model 字段,空时让 cmdc
 *      自身 default 接管,khy-os 不强行覆盖用户选择。
 *
 * 调用方(aiGatewayGenerateMethod.js)用法:
 *   const r = _isReadyForAutoPrefer({ env: process.env });
 *   if (r.ready) preferredAdapter = 'commandcode';
 *
 * @param {object} [opts]
 * @param {object} [opts.env] - 注入 env(默认 process.env,便于单测覆盖)
 * @returns {{ ready: boolean, reason: string, defaultModel: string, authFile: string }}
 */
function _isReadyForAutoPrefer({ env = process.env } = {}) {
  // 1) gate:KHY_COMMANDCODE 默认 1,khy.bat 启动已注入
  if (!invocation.isEnabled(env)) {
    return { ready: false, reason: 'gate_off', defaultModel: '', authFile: '' };
  }
  // 2) binary 命中(走 _commandAvailability 缓存层,避免重复 spawnSync)
  let available = false;
  try {
    available = require('./_commandAvailability').isAvailable('cmdc');
  } catch {
    return { ready: false, reason: 'binary_probe_failed', defaultModel: '', authFile: '' };
  }
  if (!available) {
    return { ready: false, reason: 'binary_missing', defaultModel: '', authFile: '' };
  }
  // 3) auth.json 存在且至少一个识别字段非空
  const home = env.COMMAND_CODE_HOME
    ? path.resolve(env.COMMAND_CODE_HOME)
    : path.join(os.homedir(), '.commandcode');
  const authFile = path.join(home, 'auth.json');
  let auth = null;
  try {
    if (fs.existsSync(authFile)) {
      const raw = fs.readFileSync(authFile, 'utf8');
      const obj = JSON.parse(raw);
      if (obj && typeof obj === 'object') {
        auth = obj;
      }
    }
  } catch {
    /* 解析失败 / 权限失败 → 视为未登录,降级到 ok 路径由 cmdc 自己处理 */
  }
  const hasCred = !!(
    auth &&
    ((typeof auth.apiKey === 'string' && auth.apiKey.trim()) ||
      (auth.userId && String(auth.userId).trim()) ||
      (auth.userName && String(auth.userName).trim()))
  );
  if (!hasCred) {
    return { ready: false, reason: 'auth_missing', defaultModel: '', authFile };
  }
  // 4) 读默认 model(用于 preferredModel 自动填,空时让 cmdc 用自己的默认)
  let defaultModel = '';
  try {
    const cfgFile = path.join(home, 'config.json');
    if (fs.existsSync(cfgFile)) {
      const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
      if (cfg && typeof cfg.model === 'string') {
        defaultModel = cfg.model.trim();
      }
    }
  } catch {
    /* config.json 损坏 → defaultModel 留空,cmdc 内部默认接管 */
  }
  return { ready: true, reason: 'ok', defaultModel, authFile };
}

/**
 * Read `~/.commandcode/{config,providers}.json` and emit one row per
 * model id, mirroring the shape `curateModelList` (in aiManagementServer)
 * expects: { id, name, isDefault, provider, description, connectionMode,
 * discoverySource }.
 *
 * Source of truth priority (first hit wins for defaultModel):
 *   1. `config.json.model` — the user's last-active pick (e.g. "minimax/minimax-m3-free")
 *   2. First entry of any BYOK provider's `models` map in `providers.json`
 *   3. Empty list (adapter is still selectable, but no model is marked default)
 *
 * BYOK note: a BYOK provider entry like
 *   providers.json.provider["my-deepseek"].models["deepseek-chat"]
 *   surfaces as a `my-deepseek:deepseek-chat` row — same wire format as the
 * default Command Code provider, so the gateway can route any of them.
 *
 * Fail-soft: any IO/JSON error → return [] (the adapter remains "available"
 * for the user's pinned default; only the model catalog is empty).
 */
function _readConfigJson(env = process.env) {
  const dir = env.COMMAND_CODE_HOME
    ? require('../../domain/network/externalApps/_shared').expandHome(env.COMMAND_CODE_HOME, env)
    : path.join(os.homedir(), '.commandcode');
  const file = path.join(dir, 'config.json');
  if (!fs.existsSync(file)) return { defaultModel: '', dir };
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      defaultModel: typeof doc.model === 'string' ? doc.model.trim() : '',
      provider: typeof doc.provider === 'string' ? doc.provider.trim() : '',
      dir,
    };
  } catch {
    return { defaultModel: '', dir };
  }
}

function _readProvidersJson(env = process.env) {
  const dir = env.COMMAND_CODE_HOME
    ? require('../../domain/network/externalApps/_shared').expandHome(env.COMMAND_CODE_HOME, env)
    : path.join(os.homedir(), '.commandcode');
  const file = path.join(dir, 'providers.json');
  if (!fs.existsSync(file)) return [];
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const providerMap = (doc && typeof doc.provider === 'object' && doc.provider) || {};
    const rows = [];
    for (const [pid, p] of Object.entries(providerMap)) {
      if (!p || typeof p !== 'object') continue;
      const models = (p.models && typeof p.models === 'object') ? p.models : {};
      for (const mid of Object.keys(models)) {
        if (typeof mid !== 'string' || !mid.trim()) continue;
        rows.push({ id: `${pid}/${mid}`, name: `${p.name || pid} / ${mid}` });
      }
    }
    return rows;
  } catch {
    return [];
  }
}

function _listModels() {
  const cfg = _readConfigJson();
  const seen = new Set();
  const rows = [];
  const push = (r, { isDefault = false, provider = 'commandcode' } = {}) => {
    if (!r || !r.id || seen.has(r.id)) return;
    seen.add(r.id);
    rows.push({
      id: r.id,
      name: r.name || r.id,
      isDefault: Boolean(isDefault),
      provider,
      description: `Command Code CLI: ${r.id}`,
      connectionMode: 'cloud',
      discoverySource: 'commandcode-config',
    });
  };

  // 1. User's pinned default model from config.json (highest priority).
  if (cfg.defaultModel) {
    push({ id: cfg.defaultModel, name: cfg.defaultModel }, { isDefault: true });
  }

  // 2. All BYOK provider/model pairs from providers.json.
  for (const row of _readProvidersJson()) {
    push(row);
  }

  return rows;
}

/** Sync detection (mirrors sibling adapters' detect signature). */
function detect(forceRefresh = false) {
  return _available(forceRefresh);
}

/** Async detection — probes without freezing the event loop. */
async function detectAsync(forceRefresh = false) {
  if (!invocation.isEnabled(process.env)) {
    return false;
  }
  try {
    return await require('./_commandAvailability').isAvailableAsync('cmdc', { force: forceRefresh });
  } catch {
    return false;
  }
}

/**
 * Generate by commanding `cmdcode --print` (delegated to cliToolAdapter,
 * targeted). Re-tags the response adapter to 'commandcode' for coherent
 * telemetry.
 */
async function generate(prompt, options = {}) {
  if (!invocation.isEnabled(options.env || process.env)) {
    return buildFailure('commandcode adapter disabled (KHY_COMMANDCODE=off)', {
      adapter: 'commandcode',
      errorType: 'unavailable',
    });
  }
  const res = await cliToolAdapter.generate(prompt, { ...options, cliTool: 'commandcode' });
  if (res && typeof res === 'object') {
    return { ...res, adapter: 'commandcode' };
  }
  return res;
}

function getStatus() {
  const ok = detect();
  return {
    name: 'CommandCode',
    type: 'commandcode',
    available: ok,
    detail: ok ? 'cmdcode --print (指挥外部 CLI)' : '未检测到 (commandcode)',
  };
}

function destroy() {
  /* no persistent state; detection cache lives in cliToolAdapter */
}

/**
 * Enumerate the model ids this adapter can serve, sourced from the user's
 * `~/.commandcode/{config,providers}.json`. See _listModels() above for the
 * priority/fail-soft contract. Pure sync, no IO on the hot path; aiGateway's
 * listModels caller awaits this directly.
 */
async function listModels() {
  if (!invocation.isEnabled(process.env)) return [];
  return _listModels();
}

module.exports = {
  detect,
  detectAsync,
  generate,
  getStatus,
  listModels,
  destroy,
  _isReadyForAutoPrefer,
};

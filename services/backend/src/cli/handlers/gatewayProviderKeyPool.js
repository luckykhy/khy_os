'use strict';

/**
 * gatewayProviderKeyPool.js — 网关「供应商 / API Key / 账号池 / 自定义供应商」交互子系统
 * （从 handlers/gateway.js 抽出）。
 *
 * 覆盖：gateway pool/add/key/discover-models/models 交互命令、自定义供应商注册向导、
 * 池用量与账号分组渲染、Key 健康探测与轮换、目录视图。刻意 **不自称纯零 IO 叶子**：
 * 读写 .env、发起上游探测、懒加载账号池 / apiKeyPool / 自定义供应商注册表并落盘。
 * 宿主 handlers/gateway.js 单向 require 本叶子并按同名 re-export，保持 handleGatewayPool /
 * handleGatewayAdd / handleGatewayKey / handleGatewayModels / handleGatewayDiscoverModels /
 * _addCustomProviderInteractive 契约字节不变。叶子对宿主仅两处函数级回依赖，经 DI 注入避免 require 环。
 */
const chalkModule = require('chalk');
const chalk = chalkModule.default || chalkModule;
const os = require('os');
const path = require('path');
const { printSuccess, printError, printInfo, printTable, ICON_GATEWAY } = require('../formatters');

// ---- 宿主函数级回依赖（DI 注入，避免与 handlers/gateway.js 形成 require 环）----
let promptWithReplGuard = null;
let _resolveEnvPathForDiscoverModels = null;
function setGatewayProviderKeyPoolDeps(deps = {}) {
  if (typeof deps.promptWithReplGuard === 'function') promptWithReplGuard = deps.promptWithReplGuard;
  if (typeof deps._resolveEnvPathForDiscoverModels === 'function') _resolveEnvPathForDiscoverModels = deps._resolveEnvPathForDiscoverModels;
}
function _parseGatewayBooleanOption(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (value === true) return true;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return fallback;
  if (['1', 'true', 'yes', 'on', 'y'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', 'n'].includes(normalized)) return false;
  return fallback;
}

function _normalizeGatewayPoolJsonError(action, message = '') {
  const text = String(message || '').trim();
  if (!text) return 'unknown_error';
  if (/provider is required/i.test(text)) return 'missing_provider';
  if (/account not found/i.test(text)) return 'account_not_found';
  if (/disabled/i.test(text)) return 'account_disabled';
  if (/status is /i.test(text)) return 'account_unavailable';
  if (/unsupported provider/i.test(text)) return 'unsupported_provider';
  if (/invalid account id/i.test(text)) return 'invalid_account_id';
  return `${String(action || 'pool').toLowerCase()}_failed`;
}

function _buildGatewayPoolUsagePayload() {
  return {
    ok: true,
    action: 'help',
    command: 'gateway pool',
    usage: 'gateway pool [list|use|import|sync|remove|unban] [provider|id|email]',
    commands: [
      { name: 'list', usage: 'gateway pool list [provider]' },
      { name: 'use', usage: 'gateway pool use <id|email> [provider]' },
      { name: 'import', usage: 'gateway pool import [provider]' },
      { name: 'sync', usage: 'gateway pool sync [provider]' },
      { name: 'remove', usage: 'gateway pool remove <id>' },
      { name: 'unban', usage: 'gateway pool unban <id>' },
    ],
  };
}

function _groupGatewayPoolAccounts(accounts = []) {
  const grouped = {};
  for (const account of accounts) {
    const key = String(account.poolType || account.provider || 'unknown').trim() || 'unknown';
    if (!grouped[key]) {
      grouped[key] = {
        provider: key,
        count: 0,
        active: 0,
        disabled: 0,
        accounts: [],
      };
    }
    grouped[key].count += 1;
    if (account.isActive) grouped[key].active += 1;
    if (account.enabled === false) grouped[key].disabled += 1;
    grouped[key].accounts.push(account);
  }
  return grouped;
}

function _buildGatewayPoolListPayload(accounts = [], provider = '') {
  const normalizedProvider = String(provider || '').trim();
  return {
    ok: true,
    action: 'list',
    provider: normalizedProvider || null,
    count: accounts.length,
    accounts,
    providers: _groupGatewayPoolAccounts(accounts),
    message: accounts.length > 0
      ? ''
      : (normalizedProvider ? `${normalizedProvider} 号池为空` : '号池为空'),
  };
}

function _renderGatewayPoolUsage() {
  printInfo('用法: gateway pool [list|use|import|sync|remove|unban]');
  console.log(chalk.dim('  list [provider]   — 列出号池账号'));
  console.log(chalk.dim('  use <id|email>    — 切换到指定账号'));
  console.log(chalk.dim('  import [provider] — 从本地 IDE 导入'));
  console.log(chalk.dim('  sync [provider]   — 同步活跃账号到本地'));
  console.log(chalk.dim('  remove <id>       — 删除账号'));
  console.log(chalk.dim('  unban <id>        — 解封被封账号'));
}

function _buildGatewayAddUsagePayload() {
  return {
    ok: false,
    action: 'add',
    error: 'missing_required_options',
    message: 'Non-interactive gateway add requires name, base URL, API key, and model ID.',
    usage: 'gateway add --name <display-name> [--pool-key <id>] --base-url <url> --api-key <key> --model-id <model> [--extra-models a,b] [--tier T0|T1|T2|T3] [--json]',
  };
}

function _collectGatewayAddCliInput(options = {}) {
  const displayName = String(
    options.name
    || options.displayName
    || options['display-name']
    || ''
  ).trim();
  const poolKey = String(options.poolKey || options['pool-key'] || '').trim();
  const endpoint = String(
    options.baseUrl
    || options['base-url']
    || options.endpoint
    || ''
  ).trim();
  const keyInput = String(
    options.apiKey
    || options['api-key']
    || options.key
    || ''
  ).trim();
  const defaultModel = String(
    options.modelId
    || options['model-id']
    || options.defaultModel
    || options['default-model']
    || ''
  ).trim();
  const extraModels = String(
    options.extraModels
    || options['extra-models']
    || ''
  ).trim();
  const tier = String(options.tier || '').trim().toUpperCase();
  return {
    displayName,
    poolKey,
    endpoint,
    keyInput,
    defaultModel,
    extraModels,
    tier,
  };
}

function _hasGatewayAddCliInput(input = {}) {
  return Boolean(
    input.displayName
    || input.poolKey
    || input.endpoint
    || input.keyInput
    || input.defaultModel
    || input.extraModels
    || input.tier
  );
}

async function _maybeTestGatewayCustomProvider(result, options = {}, asJson = false) {
  const shouldTest = _parseGatewayBooleanOption(options.test, false);
  if (!shouldTest) {
    return {
      attempted: false,
      success: null,
      message: asJson ? 'skipped' : '已跳过连接测试',
    };
  }

  try {
    const apiAdapter = require('../../services/gateway/adapters/apiAdapter');
    const testResult = await apiAdapter.generate('Say "hello" in one word.', {
      model: `${result.poolKey}:${result.defaultModel}`,
      apiPoolProvider: result.poolKey,
      apiKey: result.firstKey,
      apiEndpoint: result.endpoint,
      provider: 'openai',
      maxTokens: 10,
    });
    if (testResult.success) {
      return {
        attempted: true,
        success: true,
        provider: testResult.provider || 'openai',
        preview: String(testResult.content || '').slice(0, 50),
      };
    }
    return {
      attempted: true,
      success: false,
      error: testResult.error || 'unknown_error',
    };
  } catch (err) {
    return {
      attempted: true,
      success: false,
      error: err?.message || String(err),
    };
  }
}

/**
 * Scan local IDE/config files and merge discovered model IDs into RELAY_API_MODELS.
 */
async function handleGatewayDiscoverModels(options = {}) {
  const { discoverModels, updateRelayModelsInEnvFile } = require('../../services/gateway/modelDiscovery');
  const asJson = !!options.json;
  const envPath = _resolveEnvPathForDiscoverModels();
  const result = discoverModels();
  const discovered = result.models || [];

  if (!asJson) {
    console.log('');
    console.log(`  ${ICON_GATEWAY} ${chalk.cyan.bold('模型自动发现')}`);
    console.log('');
  }

  if (discovered.length === 0) {
    const message = '未发现可用模型 ID。可手动设置 RELAY_API_MODELS。';
    if (asJson) {
      console.log(JSON.stringify({
        ok: true,
        action: 'discover-models',
        count: 0,
        models: [],
        evidence: [],
        envPath,
        mergedCount: 0,
        message,
      }, null, 2));
    } else {
      printInfo(message);
      console.log('');
    }
    return;
  }

  const merged = updateRelayModelsInEnvFile(envPath, discovered);
  let mergedCount = 0;
  try { mergedCount = String(merged).split(',').filter(Boolean).length; } catch { mergedCount = 0; }

  const evidence = (result.evidence || []).slice(0, 12).map((e) => ({
    file: String(e.file || '').replace((os.homedir() || ''), '~'),
    count: Number(e.count || 0),
  }));

  if (asJson) {
    console.log(JSON.stringify({
      ok: true,
      action: 'discover-models',
      count: discovered.length,
      models: discovered,
      evidence,
      envPath,
      mergedCount,
      message: `已发现 ${discovered.length} 个模型候选，并写入 RELAY_API_MODELS (${mergedCount} 个)`,
    }, null, 2));
    return;
  }

  printSuccess(`已发现 ${discovered.length} 个模型候选，并写入 RELAY_API_MODELS (${mergedCount} 个)`);

  if (result.evidence && result.evidence.length > 0) {
    printInfo('来源文件:');
    for (const e of result.evidence.slice(0, 12)) {
      const short = e.file.replace((os.homedir() || ''), '~');
      console.log(`  ${chalk.dim('-')} ${short} ${chalk.dim(`(${e.count})`)}`);
    }
  }

  console.log('');
  printInfo('可运行 khy gateway model 重新选择模型');
  console.log('');
}

// ── Key Health Probe CLI ──

async function handleGatewayKeyHealth(args = [], options = {}) {
  const probe = require('../../services/keyHealthProbe');
  const filterProvider = args[0] || null;
  const asJson = !!options.json;

  if (!asJson) {
    console.log('');
    console.log(chalk.bold('  Key Health Probe'));
    console.log('');
  }

  const results = await probe.probeAll();
  const filtered = filterProvider
    ? results.filter(r => r.provider === filterProvider)
    : results;

  if (filtered.length === 0) {
    const message = filterProvider
      ? `No keys found for provider "${filterProvider}".`
      : 'No keys configured in pool.';
    if (asJson) {
      console.log(JSON.stringify({
        ok: true,
        action: 'health',
        provider: filterProvider,
        count: 0,
        healthy: 0,
        unhealthy: 0,
        results: [],
        message,
      }, null, 2));
    } else {
      printInfo(message);
      console.log('');
    }
    return;
  }

  const normalized = filtered.map((r, index) => ({
    provider: r.provider || filterProvider || 'unknown',
    keyId: String(r.keyId || r.id || `unknown-${index + 1}`),
    healthy: !!r.healthy,
    latencyMs: Number.isFinite(r.latencyMs) ? r.latencyMs : 0,
    statusCode: r.statusCode ?? null,
    error: r.error || null,
  }));
  const healthy = normalized.filter(r => r.healthy).length;

  if (asJson) {
    console.log(JSON.stringify({
      ok: true,
      action: 'health',
      provider: filterProvider,
      count: normalized.length,
      healthy,
      unhealthy: normalized.length - healthy,
      results: normalized,
    }, null, 2));
    return;
  }

  for (const r of normalized) {
    const status = r.healthy
      ? chalk.green('healthy')
      : chalk.red('unhealthy');
    const latency = r.latencyMs > 0 ? chalk.dim(`${r.latencyMs}ms`) : '';
    const error = r.error ? chalk.dim(`(${r.error})`) : '';
    console.log(`  ${chalk.cyan(r.provider.padEnd(12))} ${r.keyId.padEnd(14)} ${status} ${latency} ${error}`);
  }

  console.log('');
  printInfo(`${healthy}/${normalized.length} keys healthy`);
  console.log('');
}

async function handleGatewayKeyRotate(args = [], options = {}) {
  const pool = require('../../services/apiKeyPool');
  const provider = args[0];
  const asJson = !!options.json;

  if (!provider) {
    const message = 'Usage: gateway key rotate <provider>';
    if (asJson) {
      console.log(JSON.stringify({
        ok: false,
        action: 'rotate',
        provider: null,
        error: 'missing_provider',
        message,
      }, null, 2));
    } else {
      printError(message);
    }
    return;
  }

  pool.init();

  const keys = pool.listAvailableKeys(provider);
  if (!keys || keys.length === 0) {
    const message = `No keys configured for "${provider}".`;
    if (asJson) {
      console.log(JSON.stringify({
        ok: false,
        action: 'rotate',
        provider,
        error: 'no_keys_configured',
        message,
      }, null, 2));
    } else {
      printError(message);
    }
    return;
  }

  // Force-pick the next key (round-robin advances cursor)
  const next = pool.pick(provider);
  if (next) {
    const keyId = next.keyId || next.id || null;
    if (asJson) {
      console.log(JSON.stringify({
        ok: true,
        action: 'rotate',
        provider,
        keyId,
        label: next.label || '',
      }, null, 2));
    } else {
      printSuccess(`Rotated to key ${keyId} (${provider})`);
    }
  } else {
    const message = `All keys for "${provider}" are in cooldown or disabled.`;
    if (asJson) {
      console.log(JSON.stringify({
        ok: false,
        action: 'rotate',
        provider,
        error: 'no_available_keys',
        message,
      }, null, 2));
    } else {
      printError(message);
    }
  }
}

/**
 * khy gateway models — manage the per-adapter model curation list. This is the
 * exact single source the web "可用模型" card edits (via PUT
 * /api/ai-gateway/model-overrides/:adapter): modelCuration, persisted to
 * ~/.khyquant/model_overrides.json. One external API key often unlocks several
 * models for a provider (e.g. a SenseNova key serves sflash + simage +
 * deepseek-v4-flash), so this lets you register the extra model IDs a key
 * supports from the terminal, in parity with the UI.
 *
 *   gateway models [list] [adapter]            List curated models (all / one adapter)
 *   gateway models add <adapter> <id...>       Add one or more models a key supports
 *                                              (use id:Display Name to set a label)
 *   gateway models remove <adapter> <id...>    Remove manually-added models
 *
 * Note: a running ai-management daemon caches overrides in memory and reloads
 * them on restart; CLI edits are written to the shared file immediately.
 */
/**
 * Render a multi-pivot catalog view from the unified model catalog graph.
 *
 * Reached from `gateway models --view <view>` (and/or `--search <q>`). All eight
 * views pivot ONE fetched graph (modelCatalogGraph) via modelCatalogPivots, so
 * CLI and Web never drift. Management stays on the add/remove verbs; this path
 * is read-only display.
 *
 * @param {string} view  one of modelCatalogPivots.VIEWS
 * @param {{search?:string, live?:boolean, json?:boolean}} options
 */
async function _renderCatalogView(view, options = {}) {
  const asJson = !!options.json;
  const graph = require('../../services/gateway/modelCatalogGraph');
  const pivots = require('../../services/gateway/modelCatalogPivots');

  let result;
  try {
    result = await graph.buildCatalogGraph({ live: !!options.live });
  } catch (e) {
    const msg = `构建模型目录失败: ${String(e && e.message || e)}`;
    if (asJson) console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
    else printError(msg);
    return;
  }

  const search = options.search && options.search !== true ? String(options.search) : '';
  const groups = pivots.pivot(result.edges, view, { search });

  if (asJson) {
    console.log(JSON.stringify({ ok: true, view, search: search || undefined, groups, sources: result.sources }, null, 2));
    return;
  }

  const capLabel = (c) => pivots.CAPABILITY_LABELS[c] || c;
  const statLabel = (s) => pivots.STATUS_LABELS[s] || s;
  const connLabel = (c) => pivots.CONNECTION_LABELS[c] || c;

  const totalEdges = groups.reduce((n, g) => n + g.edges.length, 0);
  if (totalEdges === 0) {
    printInfo(`视角「${view}」下暂无模型${search ? `（搜索: ${search}）` : ''}。先用 gateway add 接入供应商/Key`);
    return;
  }
  printInfo(`模型目录 · 视角=${view}${search ? ` · 搜索=${search}` : ''} · 共 ${totalEdges} 条`);

  if (view === 'flat') {
    const rows = groups[0].edges;
    printTable(
      ['供应商', '模型', '能力', '档位', '状态', '连接', 'Keys'],
      rows.map(e => [e.providerLabel || e.provider, e.model, capLabel(e.capability), e.tier, statLabel(e.status), connLabel(e.connectionMode), String(e.keyCount)]),
    );
    return;
  }

  for (const g of groups) {
    console.log('');
    printInfo(`▸ ${g.groupLabel}${g.groupKey !== g.groupLabel ? ` (${g.groupKey})` : ''} · ${g.edges.length}`);
    printTable(
      ['供应商', '模型', '能力', '档位', '状态', '连接', 'Keys'],
      g.edges.map(e => [e.providerLabel || e.provider, e.model, capLabel(e.capability), e.tier, statLabel(e.status), connLabel(e.connectionMode), String(e.keyCount)]),
    );
  }
}

async function handleGatewayModels(args = [], options = {}) {
  const modelCuration = require('../../services/gateway/modelCuration');
  const aiGateway = require('../../services/gateway/aiGateway');
  const asJson = !!options.json;

  const REMOVE_VERBS = new Set(['remove', 'rm', 'del', 'delete']);
  const KNOWN_VERBS = new Set(['list', 'add', ...REMOVE_VERBS]);
  const first = String(args[0] || '').trim().toLowerCase();
  // Default to `list` when the first token is an adapter name (or absent).
  const verb = KNOWN_VERBS.has(first) ? first : 'list';
  const rest = KNOWN_VERBS.has(first) ? args.slice(1) : args.slice(0);

  // Multi-pivot catalog view: `--view <by-model|by-provider|by-key|by-capability|
  // by-tier|by-status|by-connection|flat>` and/or `--search <q>`. Only for the
  // list path (add/remove keep their verb behavior). Absent --view/--search →
  // legacy adapter-grouped table below (zero regression).
  if (verb === 'list' && (options.view || options.search)) {
    const pivots = require('../../services/gateway/modelCatalogPivots');
    const requested = String(options.view === true ? '' : (options.view || '')).trim().toLowerCase();
    const view = pivots.VIEWS.includes(requested) ? requested : 'flat';
    return _renderCatalogView(view, options);
  }

  if (verb === 'add' || REMOVE_VERBS.has(verb)) {
    const adapter = String(rest[0] || '').trim();
    const idTokens = rest.slice(1).map(s => String(s || '').trim()).filter(Boolean);
    if (!adapter || idTokens.length === 0) {
      const usage = `用法: gateway models ${verb === 'add' ? 'add' : 'remove'} <adapter> <model-id> [more-ids...]`;
      if (asJson) console.log(JSON.stringify({ ok: false, error: usage }, null, 2));
      else printError(usage);
      return;
    }

    const ov = modelCuration.getAdapterOverride(adapter);
    const existing = Array.isArray(ov.added) ? ov.added : [];

    if (verb === 'add') {
      const byId = new Map(existing.map(m => [m.id, m]));
      const newlyAdded = [];
      for (const tok of idTokens) {
        // Accept "id", "id:Display Name" or "id=Display Name".
        const m = tok.match(/^([^:=]+)[:=](.+)$/);
        const id = (m ? m[1] : tok).trim();
        const name = (m ? m[2] : id).trim();
        if (!id || byId.has(id)) continue; // skip blanks / already present
        const entry = { id, name };
        byId.set(id, entry);
        newlyAdded.push(entry);
      }
      const merged = Array.from(byId.values());
      modelCuration.setAdapterOverride(adapter, { added: merged });
      if (asJson) {
        console.log(JSON.stringify({ ok: true, adapter, added: newlyAdded.map(m => m.id), total: merged.length }, null, 2));
      } else if (newlyAdded.length === 0) {
        printInfo(`没有新增模型（指定的 ID 已存在于 ${adapter}）`);
      } else {
        printSuccess(`已为 ${adapter} 添加 ${newlyAdded.length} 个模型: ${newlyAdded.map(m => m.id).join(', ')}`);
        printInfo(`查看完整列表: gateway models ${adapter}（对话中用 /model 选择，Web「可用模型」卡同步可见）`);
      }
      return;
    }

    // remove — only manually-added models can be deleted (built-ins use hide).
    const removeSet = new Set(idTokens);
    const kept = existing.filter(m => !removeSet.has(m.id));
    const removed = existing.length - kept.length;
    modelCuration.setAdapterOverride(adapter, { added: kept });
    if (asJson) {
      console.log(JSON.stringify({ ok: true, adapter, removed, total: kept.length }, null, 2));
    } else if (removed === 0) {
      printInfo('未找到可删除的自定义模型（仅能删除手动添加的；内置模型请用 Web「可用模型」卡隐藏）');
    } else {
      printSuccess(`已从 ${adapter} 删除 ${removed} 个自定义模型`);
    }
    return;
  }

  // list — merge each adapter's live raw models with the curation overrides.
  const targetAdapter = String(rest[0] || '').trim();
  if (!aiGateway._initialized) {
    try { await aiGateway.init(); } catch { /* best effort — still show curation */ }
  }
  const statuses = (typeof aiGateway.getStatus === 'function' ? aiGateway.getStatus() : []) || [];
  let adapters = targetAdapter
    ? statuses.filter(s => s.type === targetAdapter)
    : statuses.filter(s => s.enabled);
  if (targetAdapter && adapters.length === 0) {
    // Adapter not enabled/known to the gateway — still surface its curation.
    adapters = [{ type: targetAdapter, name: targetAdapter, available: false }];
  }

  const rows = [];
  for (const s of adapters) {
    let raw = [];
    try { if (s.available) raw = await aiGateway.listModels(s.type) || []; } catch { /* ignore */ }
    const merged = modelCuration.applyOverrides(s.type, raw);
    for (const m of merged) {
      rows.push({
        adapter: s.type,
        id: m.id,
        name: m.name || m.id,
        source: m.custom ? '自定义' : (s.available ? '内置' : '—'),
        isDefault: !!m.isDefault,
      });
    }
  }

  if (asJson) {
    console.log(JSON.stringify({ ok: true, models: rows }, null, 2));
    return;
  }
  if (rows.length === 0) {
    printInfo('暂无模型。用 gateway models add <adapter> <id...> 添加 key 支持的模型');
    return;
  }
  printInfo(`可用模型 (${rows.length})${targetAdapter ? ` · ${targetAdapter}` : ''}:`);
  printTable(
    ['适配器', '模型 ID', '显示名', '来源', '默认'],
    rows.map(r => [r.adapter, r.id, r.name, r.source, r.isDefault ? '✓' : '']),
  );
}

async function handleGatewayKey(subAction = '', args = [], options = {}) {
  const asJson = !!options.json;
  if (subAction === 'health') {
    return handleGatewayKeyHealth(args, options);
  } else if (subAction === 'rotate') {
    return handleGatewayKeyRotate(args, options);
  } else {
    if (asJson) {
      console.log(JSON.stringify({
        ok: true,
        action: 'help',
        command: 'gateway key',
        usage: [
          'gateway key health [provider]',
          'gateway key rotate <provider>',
        ],
      }, null, 2));
    } else {
      console.log('');
      console.log(chalk.bold('  Gateway Key Management'));
      console.log('');
      console.log('  Usage:');
      console.log(chalk.dim('    gateway key health [provider]    Probe all keys (or filter by provider)'));
      console.log(chalk.dim('    gateway key rotate <provider>    Force rotate to next available key'));
      console.log('');
    }
  }
}

/**
 * Agnes 专属：除对话外，再用同一把 key 接通图像(文生图/图改图)与视频(文生/图生/关键帧)。
 * 这两类经各自的 service env 接线（imageGenService / videoGenService），不走网关代理，
 * 因此绝不触碰 PROXY_MODEL_ROUTE_MAP。chat 已由 registerCustomProvider 完成，此处 chat:false。
 *
 * @param {object} result   registerCustomProvider 的返回（含 firstKey/endpoint/poolKey）
 * @param {boolean} doMedia  是否接通图像/视频
 * @param {boolean} asJson   JSON 模式下静默（由调用方汇总输出）
 * @returns {object|null} provisionAgnes 摘要（仅 image/video 部分），未触发返回 null
 */
function _maybeProvisionAgnesMedia(result, doMedia, asJson) {
  if (!doMedia) return null;
  const isAgnes = result && (result.poolKey === 'agnes'
    || /(^|\.)apihub\.agnes-ai\.com$/i.test(_safeHost(result.endpoint)));
  if (!isAgnes) return null;
  try {
    const provisioner = require('../../services/agnesProvisioner');
    const summary = provisioner.provisionAgnes({ apiKey: result.firstKey, chat: false });
    if (!asJson) {
      if (summary.image.wired) {
        const active = summary.image.backendActive === 'agnes' ? '已激活' : `当前激活=${summary.image.backendActive || '无'}`;
        printSuccess(`图像能力已接通: 文生图 + 图改图 (${active})`);
      } else if (summary.image.error) {
        printError(`图像接通失败: ${summary.image.error}`);
      }
      if (summary.video.wired) {
        printSuccess('视频能力已接通: 文生视频 / 图生视频 / 关键帧 (agnes-video-v2.0)');
      } else if (summary.video.error) {
        printError(`视频接通失败: ${summary.video.error}`);
      }
    }
    return { image: summary.image, video: summary.video };
  } catch (e) {
    if (!asJson) printError(`图像/视频接通失败: ${e.message}`);
    return { error: e.message };
  }
}

function _safeHost(url) {
  try { return new URL(String(url)).host; } catch { return ''; }
}

/**
 * khy gateway add — 快捷添加自定义 Provider (endpoint + key + 模型)
 */
/**
 * 共享函数：交互式添加自定义 Provider (OpenAI 兼容)。
 * 被 handleGatewayAdd 和 handleGatewayConfig -> provider-keys -> __custom__ 两处调用。
 */
async function _addCustomProviderInteractive({ pool, customRegistry }) {
  const registrar = require('../../services/customProviderRegistrar');
  const presets = registrar.getPresets();

  // 0. 预设选择 — 让常见 Provider（如 Agnes）免手敲 base URL / 模型 ID。
  let preset = null;
  if (presets.length > 0) {
    const { presetId } = await promptWithReplGuard([{
      type: 'list',
      name: 'presetId',
      message: '选择 Provider 预设:',
      choices: [
        ...presets.map(p => ({ name: `${p.name} (${p.endpoint})`, value: p.id })),
        { name: '手动填写 (其它 OpenAI 兼容服务)', value: '__manual__' },
      ],
      default: '__manual__',
    }]);
    if (presetId !== '__manual__') preset = presets.find(p => p.id === presetId) || null;
  }

  const { displayName } = await promptWithReplGuard([{
    type: 'input',
    name: 'displayName',
    message: 'Provider 显示名称 (如 SiliconFlow):',
    default: preset ? preset.name : undefined,
    validate: v => v.trim().length > 0 ? true : '请输入名称',
  }]);

  const autoPoolKey = preset
    ? preset.id
    : displayName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const { poolKey } = await promptWithReplGuard([{
    type: 'input',
    name: 'poolKey',
    message: 'Provider ID (内部标识):',
    default: autoPoolKey,
    validate: v => {
      const k = v.trim().toLowerCase();
      if (!k || !/^[a-z0-9][-a-z0-9]*$/.test(k)) return '只允许小写字母、数字和连字符';
      if (customRegistry.isBuiltinPoolKey(k)) return `"${k}" 是内置名称，请换一个`;
      return true;
    },
  }]);

  const { baseUrl } = await promptWithReplGuard([{
    type: 'input',
    name: 'baseUrl',
    message: 'Base URL (如 https://api.siliconflow.cn/v1):',
    default: preset ? preset.endpoint : undefined,
    validate: v => { try { new URL(v); return true; } catch { return '请输入有效 URL'; } },
  }]);

  const { keyInput } = await promptWithReplGuard([{
    type: 'password',
    name: 'keyInput',
    message: 'API Key:',
    mask: '*',
    validate: v => v.length > 0 ? true : '请输入 API Key',
  }]);

  const { defaultModel } = await promptWithReplGuard([{
    type: 'input',
    name: 'defaultModel',
    message: '默认模型 ID (如 deepseek-chat):',
    default: preset ? preset.defaultModel : undefined,
    validate: v => v.trim().length > 0 ? true : '请输入模型 ID',
  }]);

  const extraDefault = preset && Array.isArray(preset.models)
    ? preset.models.filter(m => m !== preset.defaultModel).join(', ')
    : '';
  const { extraModels } = await promptWithReplGuard([{
    type: 'input',
    name: 'extraModels',
    message: '其他模型 (逗号分隔，可留空):',
    default: extraDefault,
  }]);

  // 可选能力分级覆盖（缺省＝自动判定）。Agnes 等名字含 "flash" 的模型会被
  // 自动判为 T3，这里允许用户显式声明真实 tier。
  const { tier } = await promptWithReplGuard([{
    type: 'list',
    name: 'tier',
    message: '能力分级 (tier，缺省自动):',
    choices: [
      { name: '自动判定 (推荐)', value: '' },
      { name: 'T0 前沿', value: 'T0' },
      { name: 'T1 强', value: 'T1' },
      { name: 'T2 默认', value: 'T2' },
      { name: 'T3 弱', value: 'T3' },
    ],
    default: preset && preset.tier ? preset.tier : '',
  }]);

  // 注册（加 key → 元数据 → env 路由 → 可选 tier），复用共享注册器。
  let result;
  try {
    result = registrar.registerCustomProvider({
      displayName: displayName.trim(),
      poolKey: poolKey.trim(),
      endpoint: baseUrl.trim(),
      keyInput,
      defaultModel: defaultModel.trim(),
      extraModels,
      tier,
    });
  } catch (e) {
    printError(e.message);
    return null;
  }

  printSuccess(`${result.displayName} 已添加 (${result.keyCount} key, ${result.models.length} 模型)`);
  printInfo(`模型路由: ${result.models.join(', ')} → api adapter`);
  if (result.tier) printInfo(`能力分级覆盖: ${result.models.join(', ')} → ${result.tier}`);

  // 可选连接测试
  const { testNow } = await promptWithReplGuard([{
    type: 'confirm',
    name: 'testNow',
    message: '是否测试连接?',
    default: true,
  }]);
  if (testNow) {
    printInfo('测试中...');
    try {
      const apiAdapter = require('../../services/gateway/adapters/apiAdapter');
      const testResult = await apiAdapter.generate('Say "hello" in one word.', {
        model: `${result.poolKey}:${result.defaultModel}`,
        apiPoolProvider: result.poolKey,
        apiKey: result.firstKey,
        apiEndpoint: result.endpoint,
        provider: 'openai',
        maxTokens: 10,
      });
      if (testResult.success) {
        printSuccess(`连接成功! 响应: "${(testResult.content || '').slice(0, 50)}" (${testResult.provider})`);
      } else {
        printError(`连接失败: ${testResult.error}`);
      }
    } catch (e) {
      printError(`测试错误: ${e.message}`);
    }
  }

  // Agnes：同一把 key 还能开通图像/视频，主动询问是否一并接通。
  const isAgnes = result.poolKey === 'agnes'
    || /(^|\.)apihub\.agnes-ai\.com$/i.test(_safeHost(result.endpoint));
  if (isAgnes) {
    const { wireMedia } = await promptWithReplGuard([{
      type: 'confirm',
      name: 'wireMedia',
      message: '同一把 Key 还可开通「文生图/图改图」与「文生/图生/关键帧视频」，是否一并接通?',
      default: true,
    }]);
    _maybeProvisionAgnesMedia(result, wireMedia, false);
  }

  return { normalizedPoolKey: result.poolKey, displayName: result.displayName, models: result.models };
}

async function handleGatewayAdd(options = {}) {
  const pool = require('../../services/apiKeyPool');
  const customRegistry = require('../../services/customProviderRegistry');
  const registrar = require('../../services/customProviderRegistrar');
  const { resolveEnvPaths } = require('../../services/gatewayEnvFile');
  pool.init();
  const asJson = !!options.json;
  const isInteractive = !!(process.stdin && process.stdin.isTTY && process.stdout && process.stdout.isTTY);
  const cliInput = _collectGatewayAddCliInput(options);
  const useCliInput = _hasGatewayAddCliInput(cliInput);

  if (useCliInput || asJson || !isInteractive) {
    const missingPayload = _buildGatewayAddUsagePayload();
    if (!cliInput.displayName || !cliInput.endpoint || !cliInput.keyInput || !cliInput.defaultModel) {
      if (asJson) {
        console.log(JSON.stringify(missingPayload, null, 2));
      } else {
        printError(missingPayload.message);
        printInfo(`用法: ${missingPayload.usage}`);
      }
      return;
    }

    try {
      const result = registrar.registerCustomProvider({
        displayName: cliInput.displayName,
        poolKey: cliInput.poolKey || cliInput.displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
        endpoint: cliInput.endpoint,
        keyInput: cliInput.keyInput,
        defaultModel: cliInput.defaultModel,
        extraModels: cliInput.extraModels,
        tier: cliInput.tier,
        ensureInit: true,
      });
      const connectionTest = await _maybeTestGatewayCustomProvider(result, options, asJson);
      const envPath = resolveEnvPaths().canonicalPath;
      // Agnes：默认用同一把 key 一并接通图像/视频；`--media false` 可关闭。非 Agnes 端点忽略。
      const wireMedia = _parseGatewayBooleanOption(options.media, true);
      const agnesMedia = _maybeProvisionAgnesMedia(result, wireMedia, asJson);

      if (asJson) {
        console.log(JSON.stringify({
          ok: true,
          action: 'add',
          poolKey: result.poolKey,
          displayName: result.displayName,
          endpoint: result.endpoint,
          defaultModel: result.defaultModel,
          models: result.models,
          keyCount: result.keyCount,
          tier: result.tier || '',
          envPath,
          connectionTest,
          ...(agnesMedia ? { agnesMedia } : {}),
        }, null, 2));
        return;
      }

      printSuccess(`${result.displayName} 已添加 (${result.keyCount} key, ${result.models.length} 模型)`);
      printInfo(`模型路由: ${result.models.join(', ')} → api adapter`);
      if (result.tier) printInfo(`能力分级覆盖: ${result.models.join(', ')} → ${result.tier}`);
      if (connectionTest.attempted) {
        if (connectionTest.success) {
          printSuccess(`连接成功! 响应: "${connectionTest.preview || ''}" (${connectionTest.provider || 'openai'})`);
        } else {
          printError(`测试错误: ${connectionTest.error || 'unknown_error'}`);
        }
      } else {
        printInfo('已跳过连接测试；如需验证可追加 `--test true`');
      }
      return;
    } catch (err) {
      const message = err?.message || String(err);
      if (asJson) {
        console.log(JSON.stringify({
          ok: false,
          action: 'add',
          error: 'register_failed',
          message,
        }, null, 2));
      } else {
        printError(message);
      }
      return;
    }
  }

  const hadGuard = global.__KHY_INQUIRER_ACTIVE__ === true;
  global.__KHY_INQUIRER_ACTIVE__ = true;
  try {
    console.log('');
    console.log(chalk.cyan.bold('  添加自定义 Provider (OpenAI 兼容)'));
    console.log('');
    await _addCustomProviderInteractive({ pool, customRegistry });
  } finally {
    if (!hadGuard) global.__KHY_INQUIRER_ACTIVE__ = false;
  }
}

// ── Account Pool CLI ──────────────────────────────────────────────────

async function handleGatewayPool(args = [], options = {}) {
  const pool = require('../../services/accountPool');
  await pool.init();
  const asJson = !!options.json;

  const sub = String(args[0] || 'list').toLowerCase();
  const arg1 = args[1] || '';
  const arg2 = args[2] || '';

  if (sub === 'list' || sub === 'ls') {
    const provider = arg1 || '';
    const accounts = await pool.getAllAccounts(provider || undefined);
    if (asJson) {
      console.log(JSON.stringify(_buildGatewayPoolListPayload(accounts, provider), null, 2));
      return;
    }
    if (accounts.length === 0) {
      printInfo(provider ? `${provider} 号池为空` : '号池为空');
      printInfo('使用 gateway pool import <provider> 从本地 IDE 导入账号');
      return;
    }
    // Group by provider
    const grouped = {};
    for (const a of accounts) {
      const key = a.poolType || a.provider || 'unknown';
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(a);
    }
    for (const [prov, accts] of Object.entries(grouped)) {
      console.log('');
      console.log(chalk.bold(`  ${ICON_GATEWAY} ${prov.toUpperCase()} (${accts.length})`));
      const rows = accts.map(a => {
        const statusIcon = a.isActive ? chalk.green('●')
          : a.status === 'banned' ? chalk.red('✕')
          : a.status === 'cooldown' ? chalk.yellow('◌')
          : a.status === 'disabled' ? chalk.dim('○')
          : chalk.dim('●');
        const email = a.email || chalk.dim('(no email)');
        const token = a.tokenPreview || '';
        const lastUsed = a.lastUsedAt ? new Date(a.lastUsedAt).toLocaleString() : chalk.dim('-');
        return `    ${statusIcon} #${a.id}  ${email}  ${chalk.dim(token)}  ${chalk.dim(lastUsed)}`;
      });
      rows.forEach(r => console.log(r));
    }
    console.log('');
    printInfo('命令: gateway pool use <id>, import <provider>, sync <provider>, remove <id>, unban <id>');

  } else if (sub === 'use' || sub === 'switch') {
    if (!arg1) {
      if (asJson) {
        console.log(JSON.stringify({
          ok: false,
          action: 'use',
          error: 'missing_target',
          message: '用法: gateway pool use <id|email> [provider]',
        }, null, 2));
      } else {
        printError('用法: gateway pool use <id|email>');
      }
      return;
    }
    const provider = arg2 || 'kiro';
    try {
      const result = await pool.useAccount(provider, arg1);
      if (asJson) {
        console.log(JSON.stringify({
          ok: true,
          action: 'use',
          provider,
          target: arg1,
          account: result || null,
        }, null, 2));
      } else if (result) {
        printSuccess(`已切换到账号 #${result.id}（${result.email || result.label || '-'}）`);
      }
    } catch (err) {
      const message = err?.message || String(err);
      if (asJson) {
        console.log(JSON.stringify({
          ok: false,
          action: 'use',
          provider,
          target: arg1,
          error: _normalizeGatewayPoolJsonError('use', message),
          message,
        }, null, 2));
      } else {
        printError(message);
      }
    }

  } else if (sub === 'import') {
    const provider = arg1 || 'kiro';
    try {
      const result = await pool.importProviderTokens(provider);
      if (asJson) {
        console.log(JSON.stringify({
          ok: true,
          action: 'import',
          provider,
          ...result,
        }, null, 2));
      } else {
        printSuccess(`${provider} 导入完成: ${result.imported || 0} 新增, ${result.updated || 0} 更新, ${result.skipped || 0} 跳过`);
      }
    } catch (err) {
      const message = err?.message || String(err);
      if (asJson) {
        console.log(JSON.stringify({
          ok: false,
          action: 'import',
          provider,
          error: _normalizeGatewayPoolJsonError('import', message),
          message,
        }, null, 2));
      } else {
        printError(`导入失败: ${message}`);
      }
    }

  } else if (sub === 'sync') {
    const provider = arg1 || 'kiro';
    try {
      const result = await pool.syncActiveAccountToLocal(provider);
      if (asJson) {
        console.log(JSON.stringify({
          ok: true,
          action: 'sync',
          provider,
          ...result,
        }, null, 2));
      } else if (result.updated > 0) {
        printSuccess(`已同步到本地: ${result.paths.join(', ')}`);
      } else {
        printInfo(result.reason === 'no_active_account' ? '无活跃账号' : '无可写入路径');
      }
    } catch (err) {
      const message = err?.message || String(err);
      if (asJson) {
        console.log(JSON.stringify({
          ok: false,
          action: 'sync',
          provider,
          error: _normalizeGatewayPoolJsonError('sync', message),
          message,
        }, null, 2));
      } else {
        printError(`同步失败: ${message}`);
      }
    }

  } else if (sub === 'remove' || sub === 'rm' || sub === 'delete') {
    if (!arg1) {
      if (asJson) {
        console.log(JSON.stringify({
          ok: false,
          action: 'remove',
          error: 'missing_account_id',
          message: '用法: gateway pool remove <id>',
        }, null, 2));
      } else {
        printError('用法: gateway pool remove <id>');
      }
      return;
    }
    try {
      await pool.removeAccount(Number(arg1));
      if (asJson) {
        console.log(JSON.stringify({
          ok: true,
          action: 'remove',
          accountId: Number(arg1),
        }, null, 2));
      } else {
        printSuccess(`已删除账号 #${arg1}`);
      }
    } catch (err) {
      const message = err?.message || String(err);
      if (asJson) {
        console.log(JSON.stringify({
          ok: false,
          action: 'remove',
          accountId: Number(arg1),
          error: _normalizeGatewayPoolJsonError('remove', message),
          message,
        }, null, 2));
      } else {
        printError(message);
      }
    }

  } else if (sub === 'unban') {
    if (!arg1) {
      if (asJson) {
        console.log(JSON.stringify({
          ok: false,
          action: 'unban',
          error: 'missing_account_id',
          message: '用法: gateway pool unban <id>',
        }, null, 2));
      } else {
        printError('用法: gateway pool unban <id>');
      }
      return;
    }
    try {
      await pool.updateAccount(Number(arg1), { status: 'available' });
      if (asJson) {
        console.log(JSON.stringify({
          ok: true,
          action: 'unban',
          accountId: Number(arg1),
        }, null, 2));
      } else {
        printSuccess(`已解封账号 #${arg1}`);
      }
    } catch (err) {
      const message = err?.message || String(err);
      if (asJson) {
        console.log(JSON.stringify({
          ok: false,
          action: 'unban',
          accountId: Number(arg1),
          error: _normalizeGatewayPoolJsonError('unban', message),
          message,
        }, null, 2));
      } else {
        printError(message);
      }
    }

  } else {
    if (asJson) {
      console.log(JSON.stringify(_buildGatewayPoolUsagePayload(), null, 2));
    } else {
      _renderGatewayPoolUsage();
    }
  }
}

module.exports = {
  handleGatewayDiscoverModels,
  handleGatewayModels,
  handleGatewayKey,
  handleGatewayAdd,
  handleGatewayPool,
  _addCustomProviderInteractive,
  setGatewayProviderKeyPoolDeps,
};

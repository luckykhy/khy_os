'use strict';

/**
 * Proxy switch-profile subsystem (extracted from cli/handlers/proxy.js).
 *
 * Owns the Windsurf switch-profile commands (printWindsurfSwitchHelp / printWindsurfSwitchApplySummary /
 * syncWindsurfSwitchProfileFromAdapter / handleProxyWindsurfSwitch) plus the Switch-Center meta-dispatcher
 * (normalizeSwitchCenterProvider / resolveSwitchCenterCall / resolveDefaultSwitchCenterProvider /
 * isSwitchCenterAutoSyncEnabled / resolveAutoSyncCooldownMs / maybeAutoSyncSwitchCenter /
 * printSwitchCenterHelp / handleProxySwitchCenter) that fans out to the Trae + Windsurf switch handlers.
 * Extracted verbatim (byte-identical bodies) as a same-directory sibling leaf so in-body relative
 * require() paths resolve identically; the host re-imports handleProxyWindsurfSwitch / handleProxySwitchCenter /
 * maybeAutoSyncSwitchCenter by the same names to keep the `proxy windsurf-switch` / `proxy switch-center`
 * command contracts unchanged.
 *
 * This leaf performs IO (adapter sync, upstream/local proxy probes, .env-driven profile apply, terminal
 * output) so it does NOT self-declare as a pure zero-IO leaf. The 17 host callbacks it still needs (shared
 * parse/normalize helpers, Trae + Windsurf profile-store loaders, route apply, upstream/local test probes,
 * the Trae sync + Trae switch handler it dispatches to) are injected via setProxySwitchProfilesDeps to avoid
 * a require cycle back into the host. parseBooleanMaybe is re-required directly (pure module util); the
 * switch-center auto-sync cooldown Map is used only here and was moved in wholesale.
 */

const chalkModule = require('chalk');
const chalk = chalkModule.default || chalkModule;
const path = require('path');
const http = require('http');
const https = require('https');
const { printSuccess, printError, printInfo } = require('../formatters');
const parseBooleanMaybe = require('../../utils/parseBoolean');

// ── Switch-center auto-sync cooldown state (used only by this subsystem; moved out of the host verbatim) ──
const _switchCenterAutoSyncState = new Map();

// ── Host callbacks injected via DI (avoid a require cycle back into proxy.js) ──
let parsePositiveInt = null;
let dedupeList = null;
let normalizeModelId = null;
let normalizeEndpointBase = null;
let normalizeTraeProfileId = null;
let createTraeProfileId = null;
let parseModelMap = null;
let loadTraeSwitchStore = null;
let loadWindsurfSwitchStore = null;
let saveWindsurfSwitchStore = null;
let resolveWindsurfProfile = null;
let buildSwitchProfileSignature = null;
let applyTraeSwitchProfile = null;
let testTraeUpstream = null;
let testTraeLocalProxy = null;
let syncTraeSwitchProfileFromAdapter = null;
let handleProxyTraeSwitch = null;

function setProxySwitchProfilesDeps(deps = {}) {
  if (typeof deps.parsePositiveInt === 'function') parsePositiveInt = deps.parsePositiveInt;
  if (typeof deps.dedupeList === 'function') dedupeList = deps.dedupeList;
  if (typeof deps.normalizeModelId === 'function') normalizeModelId = deps.normalizeModelId;
  if (typeof deps.normalizeEndpointBase === 'function') normalizeEndpointBase = deps.normalizeEndpointBase;
  if (typeof deps.normalizeTraeProfileId === 'function') normalizeTraeProfileId = deps.normalizeTraeProfileId;
  if (typeof deps.createTraeProfileId === 'function') createTraeProfileId = deps.createTraeProfileId;
  if (typeof deps.parseModelMap === 'function') parseModelMap = deps.parseModelMap;
  if (typeof deps.loadTraeSwitchStore === 'function') loadTraeSwitchStore = deps.loadTraeSwitchStore;
  if (typeof deps.loadWindsurfSwitchStore === 'function') loadWindsurfSwitchStore = deps.loadWindsurfSwitchStore;
  if (typeof deps.saveWindsurfSwitchStore === 'function') saveWindsurfSwitchStore = deps.saveWindsurfSwitchStore;
  if (typeof deps.resolveWindsurfProfile === 'function') resolveWindsurfProfile = deps.resolveWindsurfProfile;
  if (typeof deps.buildSwitchProfileSignature === 'function') buildSwitchProfileSignature = deps.buildSwitchProfileSignature;
  if (typeof deps.applyTraeSwitchProfile === 'function') applyTraeSwitchProfile = deps.applyTraeSwitchProfile;
  if (typeof deps.testTraeUpstream === 'function') testTraeUpstream = deps.testTraeUpstream;
  if (typeof deps.testTraeLocalProxy === 'function') testTraeLocalProxy = deps.testTraeLocalProxy;
  if (typeof deps.syncTraeSwitchProfileFromAdapter === 'function') syncTraeSwitchProfileFromAdapter = deps.syncTraeSwitchProfileFromAdapter;
  if (typeof deps.handleProxyTraeSwitch === 'function') handleProxyTraeSwitch = deps.handleProxyTraeSwitch;
}

function printWindsurfSwitchHelp() {
  console.log('');
  console.log(chalk.cyan.bold('  proxy windsurf-switch 命令'));
  console.log('');
  console.log(chalk.dim('  proxy windsurf-switch status'));
  console.log(chalk.dim('  proxy windsurf-switch list'));
  console.log(chalk.dim('  proxy windsurf-switch sync [--name 名称] [--endpoint https://.../v1] [--id windsurf-auto]'));
  console.log(chalk.dim('  proxy windsurf-switch use <id|名称>'));
  console.log(chalk.dim('  proxy windsurf-switch remove <id|名称>'));
  console.log(chalk.dim('  proxy windsurf-switch test [id|名称] [--model <model>] [--timeout 15000]'));
  console.log('');
  console.log(chalk.dim('  说明:'));
  console.log(chalk.dim('    1) sync 会从 Windsurf 登录态自动发现 token + 模型 + endpoint'));
  console.log(chalk.dim('    2) 自动写入 RELAY_API_* 与 PROXY_MODEL_ROUTE_MAP'));
  console.log(chalk.dim('    3) 本地代理可直接暴露 /v1/models 与 /v1/chat/completions'));
  console.log('');
}

function printWindsurfSwitchApplySummary(profile, applied) {
  console.log('');
  printSuccess(`已激活 Windsurf 供应商: ${profile.name} (${profile.id})`);
  console.log(`  ${chalk.gray('Endpoint:')} ${chalk.cyan(profile.endpoint)}`);
  console.log(`  ${chalk.gray('模型数:')}    ${profile.models.length}`);
  console.log(`  ${chalk.gray('默认模型:')}  ${chalk.cyan(applied.defaultModel || profile.models[0] || '-')}`);
  console.log(`  ${chalk.gray('路由规则:')}  ${applied.routeMapCount}`);
  console.log(`  ${chalk.gray('写入 .env:')} ${chalk.cyan(applied.envPath)}`);
  if (profile.key) {
    const masked = profile.key.length > 10
      ? `${profile.key.slice(0, 6)}***${profile.key.slice(-4)}`
      : `${profile.key.slice(0, 3)}***`;
    console.log(`  ${chalk.gray('上游 Key:')} ${chalk.cyan(masked)}`);
  } else {
    console.log(`  ${chalk.gray('上游 Key:')} ${chalk.yellow('未保存（请在环境变量或上游客户端中提供）')}`);
  }
  console.log('');
  printInfo('建议下一步:');
  console.log(chalk.dim('  1) khy proxy start'));
  console.log(chalk.dim('  2) khy proxy windsurf-switch test'));
  console.log(chalk.dim('  3) 客户端 BaseURL 使用 http(s)://127.0.0.1:<port>/v1'));
  console.log('');
}

async function syncWindsurfSwitchProfileFromAdapter(options = {}) {
  const store = loadWindsurfSwitchStore();
  const windsurfAdapter = require('../../services/gateway/adapters/windsurfAdapter');
  const autoProfile = await windsurfAdapter.getRelayProfile({
    id: options.id || '',
    name: options.name || '',
    endpoint: options.endpoint || options.base || options.url || '',
    key: options.key || options['api-key'] || options.token || '',
    model: options.model || '',
  });

  const mappingRaw = String(options.map || '').trim();
  const parsedMap = parseModelMap(mappingRaw);
  let models = dedupeList([
    ...(Array.isArray(autoProfile.models) ? autoProfile.models : []).map(normalizeModelId),
    ...Object.keys(parsedMap).map(normalizeModelId),
  ]);
  if (models.length === 0) {
    throw new Error('未发现可用模型，无法生成代理配置');
  }

  const modelMap = {};
  for (const modelId of models) {
    const mapped = normalizeModelId(parsedMap[modelId] || autoProfile.modelMap?.[modelId] || modelId);
    modelMap[modelId] = mapped || modelId;
  }
  models = dedupeList(models);

  const activate = parseBooleanMaybe(options.activate, true);
  const idInput = String(options.id || autoProfile.id || 'windsurf-auto').trim();
  const name = String(options.name || autoProfile.name || 'Windsurf Auto').trim() || 'Windsurf Auto';
  const endpoint = normalizeEndpointBase(options.endpoint || autoProfile.endpoint || '');
  const key = String(options.key || options['api-key'] || options.token || autoProfile.key || '').trim();
  const used = new Set(store.profiles.map(p => p.id));
  const profileId = normalizeTraeProfileId(idInput) || createTraeProfileId(name, used);
  const existing = store.profiles.find(p => p.id === profileId)
    || store.profiles.find(p => String(p.name || '').trim().toLowerCase() === name.toLowerCase());
  const now = new Date().toISOString();
  const nextProfile = {
    id: existing ? existing.id : profileId,
    name,
    endpoint,
    key: key || (existing ? existing.key : ''),
    models,
    modelMap,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  const nextProfiles = existing
    ? store.profiles.map(p => (p.id === existing.id ? nextProfile : p))
    : [...store.profiles, nextProfile];
  const nextStore = saveWindsurfSwitchStore({
    activeId: activate ? nextProfile.id : store.activeId,
    profiles: nextProfiles,
  });

  let applied = null;
  if (activate) {
    const profile = resolveWindsurfProfile(nextStore, nextProfile.id);
    applied = applyTraeSwitchProfile(profile || nextProfile);
  }

  return {
    store,
    nextStore,
    autoProfile,
    profile: nextProfile,
    applied,
    activate,
    existing: !!existing,
    changed: buildSwitchProfileSignature(existing || {}) !== buildSwitchProfileSignature(nextProfile),
    activeChanged: !!activate && String(store.activeId || '') !== String(nextProfile.id || ''),
  };
}

async function handleProxyWindsurfSwitch(action = 'status', args = [], options = {}) {
  const sub = String(action || 'status').toLowerCase();
  const store = loadWindsurfSwitchStore();

  if (sub === 'help') {
    printWindsurfSwitchHelp();
    return;
  }

  if (sub === 'list' || sub === 'status' || sub === 'show') {
    console.log('');
    console.log(chalk.cyan.bold('  Windsurf 供应商列表'));
    console.log('');
    if (!store.profiles.length) {
      printInfo('暂无配置。先执行: proxy switch-center sync --provider windsurf');
      console.log('');
      return;
    }
    for (const profile of store.profiles) {
      const active = profile.id === store.activeId;
      const icon = active ? chalk.green('●') : chalk.dim('○');
      const firstModels = profile.models.slice(0, 3).join(', ');
      const suffix = profile.models.length > 3 ? ` +${profile.models.length - 3}` : '';
      console.log(`  ${icon} ${chalk.white(profile.id)}  ${chalk.cyan(profile.name)} ${active ? chalk.green('(active)') : ''}`);
      console.log(`    ${chalk.dim(profile.endpoint)}`);
      console.log(`    ${chalk.dim(`models: ${firstModels}${suffix}`)}`);
    }
    if (store.activeId) {
      const activeProfile = store.profiles.find(p => p.id === store.activeId);
      if (activeProfile) {
        console.log('');
        printInfo(`当前激活: ${activeProfile.name} (${activeProfile.id})`);
      }
    }
    console.log('');
    return;
  }

  if (sub === 'test' || sub === 'check') {
    const query = String(args[0] || options.id || options.name || '').trim();
    const profile = resolveWindsurfProfile(store, query);
    if (!profile) {
      printError(`未找到配置: ${query || '(active)'}`);
      printInfo('可先执行: proxy switch-center list --provider windsurf');
      return;
    }

    const customModel = normalizeModelId(options.model || args[1] || profile.models?.[0] || '');
    if (!customModel) {
      printError('未找到可测试模型，请先执行: proxy switch-center sync --provider windsurf');
      return;
    }
    const targetModel = normalizeModelId(
      options['target-model']
      || options.targetModel
      || profile.modelMap?.[customModel]
      || customModel
    ) || customModel;
    const timeoutMs = parsePositiveInt(options.timeout || options['timeout-ms'], 15000);
    const applyBeforeTest = parseBooleanMaybe(options.apply, true);
    const upstreamKey = String(options.key || options['api-key'] || profile.key || process.env.RELAY_API_KEY || '').trim();

    console.log('');
    printInfo(`测试配置: ${profile.name} (${profile.id})`);
    console.log(`  ${chalk.gray('上游:')} ${chalk.cyan(profile.endpoint)}`);
    console.log(`  ${chalk.gray('模型映射:')} ${chalk.cyan(`${customModel} -> ${targetModel}`)}`);
    console.log(`  ${chalk.gray('超时:')} ${timeoutMs}ms`);
    if (!upstreamKey) {
      printInfo('上游 Key 为空，将尝试无鉴权测试（多数服务会返回 401）');
    }

    if (applyBeforeTest) {
      saveWindsurfSwitchStore({
        activeId: profile.id,
        profiles: store.profiles,
      });
      applyTraeSwitchProfile(profile);
      printInfo('已自动应用该配置到当前网关环境');
    }

    const rows = [];
    let allPassed = true;

    try {
      const upstream = await testTraeUpstream(profile, {
        timeoutMs,
        upstreamKey,
        targetModel,
      });
      rows.push([
        '上游 /models',
        upstream.models.ok ? chalk.green('PASS') : chalk.red('FAIL'),
        `HTTP ${upstream.models.statusCode}; models=${upstream.models.modelCount}${upstream.models.error ? `; ${upstream.models.error}` : ''}`,
      ]);
      rows.push([
        '上游 /chat/completions',
        upstream.chat.ok ? chalk.green('PASS') : chalk.red('FAIL'),
        `HTTP ${upstream.chat.statusCode}; text=${upstream.chat.text ? upstream.chat.text.slice(0, 60) : '(empty)'}${upstream.chat.error ? `; ${upstream.chat.error}` : ''}`,
      ]);
      allPassed = allPassed && upstream.models.ok && upstream.chat.ok;
    } catch (err) {
      const message = err?.message || String(err);
      rows.push(['上游连通测试', chalk.red('FAIL'), message]);
      allPassed = false;
    }

    try {
      const local = await testTraeLocalProxy(profile, {
        timeoutMs: Math.max(timeoutMs, 18000),
        customModel,
      });
      rows.push([
        '本地代理 /v1/models',
        local.modelList.ok ? chalk.green('PASS') : chalk.red('FAIL'),
        `HTTP ${local.modelList.statusCode}; raw=${local.modelList.hasRaw ? 'yes' : 'no'}; prefixed=${local.modelList.hasPrefixed ? 'yes' : 'no'}; total=${local.modelList.total}${local.modelList.error ? `; ${local.modelList.error}` : ''}`,
      ]);
      rows.push([
        '本地代理 /v1/chat/completions',
        local.chat.ok ? chalk.green('PASS') : chalk.red('FAIL'),
        `HTTP ${local.chat.statusCode}; text=${local.chat.text ? local.chat.text.slice(0, 60) : '(empty)'}${local.chat.error ? `; ${local.chat.error}` : ''}`,
      ]);
      console.log(`  ${chalk.gray('代理入口:')} ${chalk.cyan(local.base)}`);
      allPassed = allPassed && local.modelList.ok && local.chat.ok;
    } catch (err) {
      const message = err?.message || String(err);
      rows.push(['本地代理测试', chalk.red('FAIL'), message]);
      allPassed = false;
    }

    console.log('');
    for (const row of rows) {
      console.log(`  ${chalk.white(row[0])}  ${row[1]}  ${chalk.dim(row[2])}`);
    }
    console.log('');

    if (allPassed) {
      printSuccess('Windsurf Switch 测试通过');
      printInfo(`可在客户端中使用模型: ${customModel}`);
    } else {
      printError('Windsurf Switch 测试未通过，请根据失败项修复后重试');
    }
    console.log('');
    return;
  }

  if (sub === 'remove' || sub === 'delete' || sub === 'del') {
    const query = String(args[0] || options.id || options.name || '').trim();
    if (!query) {
      printError('用法: proxy switch-center remove <id|名称> --provider windsurf');
      return;
    }
    const profile = resolveWindsurfProfile(store, query);
    if (!profile) {
      printError(`未找到配置: ${query}`);
      return;
    }
    const nextProfiles = store.profiles.filter(p => p.id !== profile.id);
    const nextStore = saveWindsurfSwitchStore({
      activeId: store.activeId === profile.id ? '' : store.activeId,
      profiles: nextProfiles,
    });
    printSuccess(`已删除: ${profile.name} (${profile.id})`);
    if (!nextStore.activeId && nextStore.profiles.length > 0) {
      printInfo('当前无激活配置，可执行: proxy switch-center use <id> --provider windsurf');
    }
    return;
  }

  if (sub === 'use' || sub === 'activate') {
    const query = String(args[0] || options.id || options.name || '').trim();
    if (!query) {
      printError('用法: proxy switch-center use <id|名称> --provider windsurf');
      return;
    }
    const profile = resolveWindsurfProfile(store, query);
    if (!profile) {
      printError(`未找到配置: ${query}`);
      return;
    }
    const nextStore = saveWindsurfSwitchStore({
      activeId: profile.id,
      profiles: store.profiles,
    });
    const applied = applyTraeSwitchProfile(profile);
    printWindsurfSwitchApplySummary(profile, applied);
    if (!nextStore.activeId) {
      printInfo('警告: 激活状态写入失败，但环境变量已应用到当前会话');
    }
    return;
  }

  if (sub === 'sync' || sub === 'refresh' || sub === 'import' || sub === 'add' || sub === 'create' || sub === 'set' || sub === 'update') {
    try {
      const result = await syncWindsurfSwitchProfileFromAdapter({
        ...options,
        name: options.name || args[0] || '',
      });
      const nextProfile = result.profile;
      printSuccess(`${result.existing ? '已更新' : '已新增'} Windsurf 供应商: ${nextProfile.name} (${nextProfile.id})`);
      printInfo(`来源 token: ${result.autoProfile.source || '-'} ${result.autoProfile.path ? `(${result.autoProfile.path})` : ''}`);

      if (result.activate) {
        printWindsurfSwitchApplySummary(nextProfile, result.applied || { routeMapCount: 0, envPath: '-', defaultModel: nextProfile.models?.[0] || '' });
      } else {
        printInfo('未激活该配置，可执行: proxy switch-center use ' + nextProfile.id + ' --provider windsurf');
      }
      return;
    } catch (err) {
      printError(`自动同步 Windsurf 配置失败: ${err?.message || err}`);
      printInfo('请先确保 Windsurf 已登录，再执行: proxy switch-center sync --provider windsurf');
      return;
    }
  }

  printError(`未知 windsurf-switch 子命令: ${action}`);
  printWindsurfSwitchHelp();
}

function normalizeSwitchCenterProvider(raw = '') {
  const value = String(raw || '').trim().toLowerCase();
  if (!value) return '';
  if (['auto', 'smart', 'fallback'].includes(value)) return 'auto';
  if (['trae', 'nirvana', 'nir', 'nrv'].includes(value)) return 'trae';
  if (['windsurf', 'codeium', 'ws'].includes(value)) return 'windsurf';
  if (['all', '*', 'both', '全部'].includes(value)) return 'all';
  return '';
}

function resolveSwitchCenterCall(action = 'status', args = [], options = {}) {
  let nextAction = String(action || 'status').trim().toLowerCase();
  let nextArgs = Array.isArray(args) ? [...args] : [];
  let provider = normalizeSwitchCenterProvider(options.provider || options.p || '');

  const providerByAction = normalizeSwitchCenterProvider(nextAction);
  if (providerByAction && providerByAction !== 'all') {
    provider = providerByAction;
    nextAction = String(nextArgs[0] || 'status').trim().toLowerCase();
    nextArgs = nextArgs.slice(1);
  } else if (!provider) {
    const providerByFirstArg = normalizeSwitchCenterProvider(nextArgs[0] || '');
    if (providerByFirstArg && providerByFirstArg !== 'all') {
      provider = providerByFirstArg;
      nextArgs = nextArgs.slice(1);
    }
  }

  return { provider, action: nextAction, args: nextArgs };
}

function resolveDefaultSwitchCenterProvider(action = 'status') {
  const trae = loadTraeSwitchStore();
  const windsurf = loadWindsurfSwitchStore();
  const hasTrae = Array.isArray(trae.profiles) && trae.profiles.length > 0;
  const hasWindsurf = Array.isArray(windsurf.profiles) && windsurf.profiles.length > 0;

  if (['sync', 'refresh', 'import'].includes(String(action || '').toLowerCase())) {
    return 'auto';
  }
  if (hasTrae && !hasWindsurf) return 'trae';
  if (hasWindsurf && !hasTrae) return 'windsurf';
  return hasTrae ? 'trae' : 'windsurf';
}

function isSwitchCenterAutoSyncEnabled(options = {}) {
  if (options.enabled !== undefined) return parseBooleanMaybe(options.enabled, true);
  if (options.autoSync !== undefined) return parseBooleanMaybe(options.autoSync, true);
  if (process.env.SWITCH_CENTER_AUTO_SYNC !== undefined) {
    return parseBooleanMaybe(process.env.SWITCH_CENTER_AUTO_SYNC, true);
  }
  if (process.env.KHY_SWITCH_CENTER_AUTO_SYNC !== undefined) {
    return parseBooleanMaybe(process.env.KHY_SWITCH_CENTER_AUTO_SYNC, true);
  }
  // Default on: keeps switch-center models "read-and-use" without manual sync.
  return true;
}

function resolveAutoSyncCooldownMs(options = {}) {
  const raw = options.cooldownMs
    ?? options['cooldown-ms']
    ?? process.env.SWITCH_CENTER_AUTO_SYNC_COOLDOWN_MS
    ?? process.env.KHY_SWITCH_CENTER_AUTO_SYNC_COOLDOWN_MS
    ?? '45000';
  const value = parsePositiveInt(raw, 45000);
  return Math.min(Math.max(value, 5000), 10 * 60 * 1000);
}

/**
 * Auto-sync provider profile into switch-center store and apply it immediately.
 * This mirrors Kiro-like auto-discovery behavior and avoids requiring explicit
 * "proxy switch-center sync" before model usage.
 */
async function maybeAutoSyncSwitchCenter(options = {}) {
  const enabled = isSwitchCenterAutoSyncEnabled(options);
  if (!enabled) {
    return { synced: false, skipped: true, reason: 'disabled' };
  }

  const provider = normalizeSwitchCenterProvider(
    options.provider
    || process.env.SWITCH_CENTER_AUTO_PROVIDER
    || process.env.KHY_SWITCH_CENTER_AUTO_PROVIDER
    || 'auto'
  ) || 'auto';
  const fallbackEnabled = parseBooleanMaybe(
    options.fallback ?? process.env.SWITCH_CENTER_AUTO_FALLBACK ?? process.env.KHY_SWITCH_CENTER_AUTO_FALLBACK,
    true
  );
  const preferredProvider = normalizeSwitchCenterProvider(
    options.preferredProvider
    || process.env.SWITCH_CENTER_AUTO_PREFERRED_PROVIDER
    || process.env.KHY_SWITCH_CENTER_AUTO_PREFERRED_PROVIDER
    || 'windsurf'
  );

  if (provider === 'auto' || provider === 'all') {
    const first = preferredProvider === 'trae' ? 'trae' : 'windsurf';
    const second = first === 'trae' ? 'windsurf' : 'trae';
    const order = fallbackEnabled ? [first, second] : [first];
    const attempts = [];
    for (let i = 0; i < order.length; i += 1) {
      const p = order[i];
      const result = await maybeAutoSyncSwitchCenter({
        ...options,
        provider: p,
        preferredProvider: p,
        fallback: false,
      });
      if (result && result.synced) {
        return {
          ...result,
          preferredProvider: first,
          fallbackUsed: i > 0,
          attemptedProviders: order.slice(0, i + 1),
        };
      }
      attempts.push({
        provider: p,
        reason: result?.reason || 'failed',
        error: result?.error || '',
      });
    }
    return {
      synced: false,
      skipped: true,
      preferredProvider: first,
      reason: 'sync-failed',
      attempts,
      error: attempts.map(x => `${x.provider}:${x.error || x.reason}`).join(' | '),
    };
  }
  if (provider !== 'windsurf' && provider !== 'trae') {
    return { synced: false, skipped: true, reason: `unsupported-provider:${provider}` };
  }

  const cooldownMs = resolveAutoSyncCooldownMs(options);
  const force = parseBooleanMaybe(options.force, false);
  const quiet = parseBooleanMaybe(options.quiet, true);
  const key = `provider:${provider}`;
  const now = Date.now();
  const state = _switchCenterAutoSyncState.get(key) || { lastAt: 0, inFlight: null };
  if (!force && state.lastAt > 0 && (now - state.lastAt) < cooldownMs) {
    return { synced: false, skipped: true, reason: 'cooldown' };
  }
  if (state.inFlight) return state.inFlight;

  const task = (async () => {
    state.lastAt = Date.now();
    try {
      const syncFn = provider === 'trae'
        ? syncTraeSwitchProfileFromAdapter
        : syncWindsurfSwitchProfileFromAdapter;
      const defaultProfileId = provider === 'trae' ? 'trae-auto' : 'windsurf-auto';
      const defaultProfileName = provider === 'trae' ? 'Trae Auto' : 'Windsurf Auto';
      const result = await syncFn({
        activate: true,
        id: options.id
          || process.env[`SWITCH_CENTER_AUTO_${provider.toUpperCase()}_PROFILE_ID`]
          || process.env.SWITCH_CENTER_AUTO_PROFILE_ID
          || defaultProfileId,
        name: options.name
          || process.env[`SWITCH_CENTER_AUTO_${provider.toUpperCase()}_PROFILE_NAME`]
          || process.env.SWITCH_CENTER_AUTO_PROFILE_NAME
          || defaultProfileName,
        endpoint: options.endpoint || process.env.SWITCH_CENTER_AUTO_ENDPOINT || '',
        key: options.key || process.env.SWITCH_CENTER_AUTO_KEY || '',
        model: options.model || process.env.SWITCH_CENTER_AUTO_MODEL || '',
      });
      const payload = {
        synced: true,
        skipped: false,
        provider,
        changed: !!result.changed,
        activeChanged: !!result.activeChanged,
        profileId: result.profile?.id || '',
        profileName: result.profile?.name || '',
        modelsCount: Array.isArray(result.profile?.models) ? result.profile.models.length : 0,
      };
      if (!quiet && (payload.changed || payload.activeChanged)) {
        printInfo(`switch-center 自动同步完成: ${payload.profileName || payload.profileId} (${payload.modelsCount} models)`);
      }
      return payload;
    } catch (err) {
      const message = err?.message || String(err || 'auto sync failed');
      if (fallbackEnabled && !options._fallbackTried) {
        const backup = provider === 'trae' ? 'windsurf' : 'trae';
        const next = await maybeAutoSyncSwitchCenter({
          ...options,
          provider: backup,
          fallback: false,
          _fallbackTried: true,
        });
        if (next && next.synced) {
          return {
            ...next,
            preferredProvider: provider,
            fallbackUsed: true,
            attemptedProviders: [provider, backup],
          };
        }
      }
      if (!quiet) printInfo(`switch-center 自动同步跳过: ${message}`);
      return {
        synced: false,
        skipped: true,
        provider,
        reason: 'sync-failed',
        error: message,
      };
    } finally {
      state.inFlight = null;
      _switchCenterAutoSyncState.set(key, state);
    }
  })();

  state.inFlight = task;
  _switchCenterAutoSyncState.set(key, state);
  return task;
}

function printSwitchCenterHelp() {
  console.log('');
  console.log(chalk.cyan.bold('  proxy switch-center 命令'));
  console.log('');
  console.log(chalk.dim('  proxy switch-center status'));
  console.log(chalk.dim('  proxy switch-center list'));
  console.log(chalk.dim('  proxy switch-center status --provider trae|windsurf'));
  console.log(chalk.dim('  proxy switch-center sync [--provider trae|windsurf]'));
  console.log(chalk.dim('  proxy switch-center use <id|名称> [--provider trae|windsurf]'));
  console.log(chalk.dim('  proxy switch-center remove <id|名称> [--provider trae|windsurf]'));
  console.log(chalk.dim('  proxy switch-center test [id|名称] [--provider trae|windsurf] [--model xxx]'));
  console.log('');
  console.log(chalk.dim('  说明:'));
  console.log(chalk.dim('    1) 默认 provider 按本地配置自动推断'));
  console.log(chalk.dim('    2) sync 支持 Trae/Windsurf 登录态自动发现（不指定 provider 时先首选，再自动降级）'));
  console.log(chalk.dim('    3) gateway status / gateway model 默认自动触发 switch-center 同步（可用 SWITCH_CENTER_AUTO_SYNC=false 关闭）'));
  console.log(chalk.dim('    4) 保留 trae-switch / windsurf-switch 兼容旧脚本'));
  console.log('');
}

async function handleProxySwitchCenter(action = 'status', args = [], options = {}) {
  const parsed = resolveSwitchCenterCall(action, args, options);
  const sub = String(parsed.action || 'status').toLowerCase();

  if (!sub || sub === 'help') {
    printSwitchCenterHelp();
    return;
  }

  if (sub === 'status' || sub === 'list' || sub === 'show') {
    if (parsed.provider === 'trae') {
      await handleProxyTraeSwitch('status', parsed.args, options);
      return;
    }
    if (parsed.provider === 'windsurf') {
      await handleProxyWindsurfSwitch('status', parsed.args, options);
      return;
    }
    // aggregate view (default)
    await handleProxyTraeSwitch('status', [], options);
    await handleProxyWindsurfSwitch('status', [], options);
    return;
  }

  const provider = parsed.provider || resolveDefaultSwitchCenterProvider(sub);
  if ((sub === 'sync' || sub === 'refresh' || sub === 'import') && (provider === 'auto' || provider === 'all')) {
    const preferred = normalizeSwitchCenterProvider(
      options.preferredProvider
      || process.env.SWITCH_CENTER_AUTO_PREFERRED_PROVIDER
      || process.env.GATEWAY_PREFERRED_ADAPTER
      || 'windsurf'
    );
    const result = await maybeAutoSyncSwitchCenter({
      ...options,
      provider: 'auto',
      preferredProvider: preferred || 'windsurf',
      quiet: false,
      force: true,
      name: options.name || parsed.args[0] || '',
    });
    if (result && result.synced) {
      const fallbackNote = result.fallbackUsed ? `（已从 ${result.preferredProvider || '首选通道'} 降级）` : '';
      printSuccess(`switch-center 同步成功: ${result.provider || preferred}${fallbackNote}`);
      return;
    }
    printError(`switch-center 同步失败: ${result?.error || result?.reason || 'unknown error'}`);
    return;
  }
  if (provider === 'trae') {
    await handleProxyTraeSwitch(sub, parsed.args, { ...options, provider: 'trae' });
    return;
  }
  if (provider === 'windsurf') {
    await handleProxyWindsurfSwitch(sub, parsed.args, { ...options, provider: 'windsurf' });
    return;
  }

  printError(`switch-center 无法识别 provider: ${provider}`);
  printSwitchCenterHelp();
}

module.exports = {
  handleProxyWindsurfSwitch,
  handleProxySwitchCenter,
  maybeAutoSyncSwitchCenter,
  setProxySwitchProfilesDeps,
};

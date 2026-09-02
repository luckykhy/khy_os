'use strict';

/**
 * ccSwitch handler — `khy cc-switch` CLI surface for the CC-Switch-style
 * provider-card subsystem.
 *
 * Verbs: list | add | get | update | remove | enable | disable | use | status
 *        | test | export | import | apps | help
 *
 * This handler is IO + interaction + table rendering only: all persistence
 * lives in services/ccSwitch/store.js, live-config writes in
 * services/ccSwitch/appWriters.js (per-app adapter), proxy wiring in
 * services/gateway/proxyServer.js. Keys are never printed in full — the store
 * holds only keyIds and formatters mask any surfaced credential.
 */

const fs = require('fs');
const path = require('path');

const { printSuccess, printError, printWarn, printInfo, printTable } = require('../formatters');
const {
  APPS,
  APP_LABELS,
  PROTOCOLS,
  PROTOCOL_DEFAULT_MODELS,
} = require('../../services/ccSwitch/constants');
const store = require('../../services/ccSwitch/store');
const maskToken = require('../../utils/maskToken');

// ── Option helpers ──────────────────────────────────────────────────────────
function _opt(options, key, fallback = '') {
  const v = options && options[key];
  return v === undefined || v === null || v === '' ? fallback : String(v);
}

function _parseArgs(args) {
  // Support both `khy cc-switch add --name X` and positional `khy cc-switch add X`
  return args || [];
}

function _findCardId(args, options) {
  const nameOrId = _opt(options, 'id') || _parseArgs(args)[0] || '';
  const cards = store.listCards();
  const hit = cards.find((c) => c.id === nameOrId || c.name.toLowerCase() === String(nameOrId).toLowerCase());
  return hit ? hit.id : (nameOrId || null);
}

function _maskKey(key) {
  if (!key) {
    return '';
  }
  return maskToken(String(key));
}

// ── list ────────────────────────────────────────────────────────────────────
async function handleCcSwitchList(args, options) {
  const cards = store.listCards();
  if (cards.length === 0) {
    printInfo('还没有供应商卡片。运行 `khy cc-switch add` 添加一张。');
    return;
  }
  const rows = cards.map((c) => [
    c.name,
    c.protocol,
    c.baseUrl,
    c.keyId ? _maskKey(c.keyId) : '—',
    (c.models && c.models.slice(0, 3).join(', ')) || c.defaultModel || '',
    c.enabled ? '启用' : '禁用',
  ]);
  printTable(['名称', '协议', 'Base URL', '密钥', '模型', '状态'], rows);
}

// ── add ─────────────────────────────────────────────────────────────────────
async function handleCcSwitchAdd(args, options) {
  const name = _opt(options, 'name') || _parseArgs(args)[0] || '';
  if (!name) {
    printError('缺少卡片名称。用法: khy cc-switch add <name> --base-url <url> [--key <key>] [--protocol openai|anthropic|openai_responses|gemini]');
    return;
  }
  const baseUrl = _opt(options, 'base-url') || _opt(options, 'baseUrl') || '';
  if (!baseUrl) {
    printError('缺少 base URL。用法: khy cc-switch add <name> --base-url <url>');
    return;
  }
  const protocol = _opt(options, 'protocol') || PROTOCOLS.OPENAI;
  if (!Object.values(PROTOCOLS).includes(protocol)) {
    printError(`不支持的协议: ${protocol}。可选: ${Object.values(PROTOCOLS).join(', ')}`);
    return;
  }
  const key = _opt(options, 'key');
  const models = String(_opt(options, 'models'))
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  const apps = String(_opt(options, 'apps'))
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean)
    .filter((a) => Object.values(APPS).includes(a));
  const defaultModel = _opt(options, 'model') || (models.length ? models[0] : PROTOCOL_DEFAULT_MODELS[protocol] || '');

  const result = store.addCard({
    name,
    baseUrl,
    key: key || undefined,
    protocol,
    wireApi: _opt(options, 'wire-api') || undefined,
    models,
    defaultModel,
    apps: apps.length ? apps : Object.values(APPS).slice(),
  });
  if (!result.success) {
    printError(`添加卡片失败: ${result.error}`);
    return;
  }
  printSuccess(`已添加卡片「${result.card.name}」(${result.card.id})`);
  printInfo(`协议: ${result.card.protocol} · Base URL: ${result.card.baseUrl}`);
  if (result.card.keyId) {
    printInfo('密钥已存入密钥池（不落盘明文）。');
  } else {
    printWarn('未提供密钥。可在编辑时补充： khy cc-switch update <id> --key <key>');
  }
}

// ── get ─────────────────────────────────────────────────────────────────────
async function handleCcSwitchGet(args, options) {
  const cardId = _findCardId(args, options);
  if (!cardId) {
    printError('缺少卡片 ID 或名称。');
    return;
  }
  const card = store.getCard(cardId);
  if (!card) {
    printError(`卡片不存在: ${cardId}`);
    return;
  }
  printTable(
    ['字段', '值'],
    [
      ['ID', card.id],
      ['名称', card.name],
      ['协议', card.protocol],
      ['Base URL', card.baseUrl],
      ['默认模型', card.defaultModel],
      ['模型列表', (card.models || []).join(', ')],
      ['密钥', card.keyId ? '已配置' : '未配置'],
      ['启用', card.enabled ? '是' : '否'],
      ['应用', (card.apps || []).map((a) => APP_LABELS[a] || a).join(', ')],
      ['创建时间', card.createdAt],
      ['更新时间', card.updatedAt],
    ]
  );
}

// ── update ──────────────────────────────────────────────────────────────────
async function handleCcSwitchUpdate(args, options) {
  const cardId = _findCardId(args, options);
  if (!cardId) {
    printError('缺少卡片 ID 或名称。');
    return;
  }
  const card = store.getCard(cardId);
  if (!card) {
    printError(`卡片不存在: ${cardId}`);
    return;
  }
  const patch = {};
  if (_opt(options, 'name')) patch.name = _opt(options, 'name');
  if (_opt(options, 'base-url') || _opt(options, 'baseUrl')) patch.baseUrl = _opt(options, 'base-url') || _opt(options, 'baseUrl');
  if (_opt(options, 'protocol')) {
    const p = _opt(options, 'protocol');
    if (!Object.values(PROTOCOLS).includes(p)) {
      printError(`不支持的协议: ${p}`);
      return;
    }
    patch.protocol = p;
  }
  if (_opt(options, 'wire-api')) patch.wireApi = _opt(options, 'wire-api');
  if (_opt(options, 'model')) patch.defaultModel = _opt(options, 'model');
  if (_opt(options, 'models')) {
    patch.models = String(_opt(options, 'models')).split(',').map((m) => m.trim()).filter(Boolean);
  }
  if (_opt(options, 'apps')) {
    patch.apps = String(_opt(options, 'apps')).split(',').map((a) => a.trim()).filter(Boolean).filter((a) => Object.values(APPS).includes(a));
  }
  if (Object.keys(patch).length === 0 && !_opt(options, 'key')) {
    printWarn('没有要更新的字段。可用: --name / --base-url / --protocol / --model / --models / --apps / --key');
    return;
  }
  if (_opt(options, 'key')) patch.key = _opt(options, 'key');
  const result = store.updateCard(cardId, patch);
  if (!result.success) {
    printError(`更新卡片失败: ${result.error}`);
    return;
  }
  printSuccess(`已更新卡片「${result.card.name}」`);
}

// ── remove ──────────────────────────────────────────────────────────────────
async function handleCcSwitchRemove(args, options) {
  const cardId = _findCardId(args, options);
  if (!cardId) {
    printError('缺少卡片 ID 或名称。');
    return;
  }
  const result = store.removeCard(cardId);
  if (!result.success) {
    printError(`删除卡片失败: ${result.error}`);
    return;
  }
  printSuccess(`已删除卡片 ${cardId}`);
}

// ── enable / disable ───────────────────────────────────────────────────────
async function handleCcSwitchEnable(args, options) {
  const cardId = _findCardId(args, options);
  if (!cardId) {
    printError('缺少卡片 ID 或名称。');
    return;
  }
  const card = store.getCard(cardId);
  if (!card) {
    printError(`卡片不存在: ${cardId}`);
    return;
  }
  const result = store.updateCard(cardId, { enabled: true });
  if (!result.success) {
    printError(result.error);
    return;
  }
  printSuccess(`已启用卡片「${result.card.name}」`);
}

async function handleCcSwitchDisable(args, options) {
  const cardId = _findCardId(args, options);
  if (!cardId) {
    printError('缺少卡片 ID 或名称。');
    return;
  }
  const card = store.getCard(cardId);
  if (!card) {
    printError(`卡片不存在: ${cardId}`);
    return;
  }
  const result = store.updateCard(cardId, { enabled: false });
  if (!result.success) {
    printError(result.error);
    return;
  }
  printSuccess(`已禁用卡片「${result.card.name}」`);
}

// ── use (switch an app onto a card) ─────────────────────────────────────────
async function handleCcSwitchUse(args, options) {
  const cardNameOrId = _opt(options, 'card') || _parseArgs(args)[0] || '';
  if (!cardNameOrId) {
    printError('缺少卡片 ID 或名称。用法: khy cc-switch use <card> [--app claude-code|codex|opencode|gemini]');
    return;
  }
  const cardId = _findCardId([cardNameOrId], {});
  if (!cardId) {
    printError(`卡片不存在: ${cardNameOrId}`);
    return;
  }
  const card = store.getCard(cardId);
  if (!card) {
    printError(`卡片不存在: ${cardNameOrId}`);
    return;
  }
  const appsRaw = _opt(options, 'app') || _opt(options, 'apps') || '';
  const apps = appsRaw
    ? String(appsRaw).split(',').map((a) => a.trim()).filter((a) => Object.values(APPS).includes(a))
    : (card.apps && card.apps.length ? card.apps : Object.values(APPS).slice());

  if (!apps.length) {
    printWarn('未指定应用，且卡片未配置可用应用。');
    return;
  }

  const appWriters = require('../../services/ccSwitch/appWriters');
  let allOk = true;

  // Apps whose live config references the card key via an env var
  // ($KHY_CC_SWITCH_<ID>_KEY for Command Code / YCode). For these we export the
  // real key into process.env (and ~/.khy/.env via gatewayEnvFile) so the
  // reference resolves when the tool is launched from a khy-derived process.
  const envRefApps = [APPS.COMMAND_CODE, APPS.YCODE];

  for (const app of apps) {
    const result = await appWriters.applyCardToApp(card, app, { store });
    if (result.success) {
      if (envRefApps.includes(app)) {
        _exportCardKeyToEnv(card);
      }
      store.setActiveCard(app, cardId);
      printSuccess(`已切换 ${APP_LABELS[app] || app} → ${card.name}`);
    } else {
      allOk = false;
      printError(`${APP_LABELS[app] || app} 切换失败: ${result.error || '未知错误'}`);
    }
  }
  if (allOk) {
    printInfo(`已为 ${apps.length} 个应用切换到卡片「${card.name}」。`);
    if (apps.some((a) => envRefApps.includes(a))) {
      const envVar = _cardKeyEnvName(card);
      printInfo(
        `Command Code / YCode 通过 env 引用密钥（${envVar}）。` +
        `请通过 \`khy\` 启动这些工具，或在 shell 里执行: export ${envVar}=<密钥>`
      );
    }
  } else {
    printWarn('部分应用切换失败。请检查配置后重试。');
  }
}

/**
 * 卡片 → env 变量名 KHY_CC_SWITCH_<PROVIDER_ID>_KEY（与 commandCode/ycode
 * 适配器一致：provider id = 卡片名 sanitize 成小写下划线，再转大写）。
 */
function _cardKeyEnvName(card) {
  const providerId = String(card.name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const norm = (providerId || 'card')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `KHY_CC_SWITCH_${norm}_KEY`;
}

/**
 * 把卡片真实密钥导出到 process.env，供 Command Code / YCode 的 env 引用解析。
 *
 * 刻意**不落盘**到任何文件：仓库 `services/backend/.env` 可能被 git 跟踪，
 * 写进去会把密钥放进版本历史。密钥只进当前进程 env——由 khy 派生的工具进程
 * （如 `khy` 启动的 cmd/ycode）能读到；用户直接启动工具时需自行 export
 * （CLI 已给出提示）。长期方案是 khy 工具启动器统一注入。
 */
function _exportCardKeyToEnv(card) {
  try {
    const key = store.getCardCredential(card.id);
    if (!key) {
      return;
    }
    const envVar = _cardKeyEnvName(card);
    process.env[envVar] = key;
  } catch {
    /* best effort */
  }
}

// ── status ──────────────────────────────────────────────────────────────────
async function handleCcSwitchStatus(args, options) {
  const cards = store.listCards();
  const rows = [];
  for (const app of Object.values(APPS)) {
    const activeId = store.getActiveCardId(app);
    const active = activeId ? cards.find((c) => c.id === activeId) : null;
    rows.push([
      APP_LABELS[app] || app,
      active ? active.name : '—',
      active ? active.baseUrl : '',
      active ? (active.keyId ? '已配置' : '无密钥') : '',
    ]);
  }
  printTable(['应用', '激活卡片', 'Base URL', '密钥'], rows);
}

// ── test ────────────────────────────────────────────────────────────────────
async function handleCcSwitchTest(args, options) {
  const cardNameOrId = _parseArgs(args)[0] || _opt(options, 'id') || _opt(options, 'name') || '';
  if (!cardNameOrId) {
    printError('缺少卡片 ID 或名称。用法: khy cc-switch test <card>');
    return;
  }
  const cardId = _findCardId([cardNameOrId], {});
  const card = store.getCard(cardId);
  if (!card) {
    printError(`卡片不存在: ${cardNameOrId}`);
    return;
  }
  const key = store.getCardCredential(card.id);
  if (!key) {
    printWarn('卡片没有可用的密钥，无法测试鉴权（仅测连通性）。');
  }
  const { testCardConnectivity } = require('../../services/ccSwitch/connectivity');
  printInfo(`测试卡片「${card.name}」(${card.baseUrl})...`);
  const result = await testCardConnectivity({ card, key });
  if (result.ok) {
    printSuccess(
      `${result.label}（${result.status || ''}，${result.latencyMs}ms${result.model ? `，模型 ${result.model}` : ''}）`
    );
  } else {
    printError(`${result.label}（${result.status || '无响应'}，${result.latencyMs}ms）${result.error ? `：${result.error}` : ''}`);
  }
}

// ── export / import ─────────────────────────────────────────────────────────
async function handleCcSwitchExport(args, options) {
  const target = _opt(options, 'out') || _parseArgs(args)[0] || '';
  const snapshot = store.exportSnapshot();
  if (!target) {
    console.log(JSON.stringify(snapshot, null, 2));
    printInfo('（未指定 --out，以上为导出内容。）');
    return;
  }
  try {
    fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
    fs.writeFileSync(path.resolve(target), JSON.stringify(snapshot, null, 2), 'utf-8');
    printSuccess(`已导出到 ${target}`);
  } catch (e) {
    printError(`导出失败: ${e && e.message}`);
  }
}

async function handleCcSwitchImport(args, options) {
  const source = _opt(options, 'in') || _parseArgs(args)[0] || '';
  if (!source) {
    printError('缺少导入文件路径。用法: khy cc-switch import <file> [--replace]');
    return;
  }
  let snapshot;
  try {
    snapshot = JSON.parse(fs.readFileSync(path.resolve(source), 'utf-8'));
  } catch (e) {
    printError(`读取导入文件失败: ${e && e.message}`);
    return;
  }
  const replace = _opt(options, 'replace') === 'true' || _opt(options, 'replace') === '1';
  const result = store.importSnapshot(snapshot, { replace });
  if (!result.success) {
    printError(`导入失败: ${result.error}`);
    return;
  }
  printSuccess(`已导入 ${result.count} 张卡片`);
}

// ── apps ────────────────────────────────────────────────────────────────────
async function handleCcSwitchApps(args, options) {
  const rows = Object.values(APPS).map((app) => [
    APP_LABELS[app] || app,
    store.getActiveCardId(app) || '—',
    store.getAppConfig(app).scanEnabled ? '自动扫描' : '手动扫描',
  ]);
  printTable(['应用', '激活卡片', '用量扫描'], rows);
}

// ── scan (外部工具会话用量扫描) ──────────────────────────────────────────────
async function handleCcSwitchScan(args, options) {
  const appRaw = _opt(options, 'app') || _opt(options, 'apps') || '';
  const apps = appRaw
    ? String(appRaw).split(',').map((a) => a.trim()).filter((a) => Object.values(APPS).includes(a))
    : Object.values(APPS).filter((a) => store.getAppConfig(a).scanEnabled);
  if (!apps.length) {
    printWarn('没有可扫描的应用（可用 --app 指定，如 --app claude-code,codex）。');
    return;
  }
  const { scanSessions } = require('../../services/ccSwitch/usageScan');
  printInfo(`扫描 ${apps.map((a) => APP_LABELS[a] || a).join(', ')} 的会话记录（增量）...`);
  const started = Date.now();
  const result = await scanSessions({ apps });
  const elapsed = Date.now() - started;
  printSuccess(
    `扫描完成：导入 ${result.imported} 条用量 / ${result.files} 个会话文件，耗时 ${elapsed}ms`
  );
  if (result.errors && result.errors.length) {
    for (const err of result.errors.slice(0, 10)) {
      printWarn(`  ${err.file}: ${err.error}`);
    }
    if (result.errors.length > 10) {
      printWarn(`  … 另有 ${result.errors.length - 10} 条跳过项`);
    }
  }
}

// ── scan-status (游标状态) ─────────────────────────────────────────────────
async function handleCcSwitchScanStatus(args, options) {
  const { getCursorState } = require('../../services/ccSwitch/usageScan');
  const state = getCursorState();
  const files = (state && state.files) || {};
  const keys = Object.keys(files);
  if (!keys.length) {
    printInfo('还没有会话扫描游标（首次运行 `khy cc-switch scan` 后生成）。');
    return;
  }
  const rows = keys.slice(0, 20).map((key) => {
    const c = files[key];
    return [key, String(c.offset || 0), String(c.size || 0)];
  });
  printTable(['会话文件', '已扫描字节', '文件大小'], rows);
  if (keys.length > 20) {
    printInfo(`… 共 ${keys.length} 个游标`);
  }
}

// ── help ────────────────────────────────────────────────────────────────────
async function handleCcSwitchHelp(args, options) {
  console.log(`
khy cc-switch — 供应商卡片切换中心（对标 CC Switch）

子命令:
  list                       列出所有卡片
  add <name>                 新增卡片
      --base-url <url>       Base URL
      --key <key>            API 密钥（不落盘明文，存密钥池）
      --protocol <p>         openai | anthropic | openai_responses | gemini
      --model <m>            默认模型
      --models <a,b,c>       模型列表
      --apps <a,b,c>         可用应用（claude-code,codex,opencode,gemini,deepseek,reasonix）
  get <card>                 查看单张卡片
  update <card>              更新卡片
      --name / --base-url / --protocol / --model / --models / --apps / --key
  remove <card>              删除卡片
  enable|disable <card>      启用/禁用卡片
  use <card> --app <app>     把某个应用切换到该卡片（写 live 配置）
  status                     查看各应用当前激活卡片
  test <card>                测试卡片连通性（发一次最小请求）
  export [--out <file>]      导出卡片快照
  import <file> [--replace]  导入卡片快照
  apps                       查看各应用配置
  scan [--app <app>]         增量扫描外部工具会话用量（Claude/Codex/Gemini/OpenCode）
  scan-status                查看扫描游标状态
  help                       显示本帮助

示例:
  khy cc-switch add deepseek --base-url https://api.deepseek.com/v1 --key sk-xxx --protocol openai
  khy cc-switch use deepseek --app claude-code,codex
  khy cc-switch status
`);
}

module.exports = {
  handleCcSwitchList,
  handleCcSwitchAdd,
  handleCcSwitchGet,
  handleCcSwitchUpdate,
  handleCcSwitchRemove,
  handleCcSwitchEnable,
  handleCcSwitchDisable,
  handleCcSwitchUse,
  handleCcSwitchStatus,
  handleCcSwitchTest,
  handleCcSwitchExport,
  handleCcSwitchImport,
  handleCcSwitchApps,
  handleCcSwitchScan,
  handleCcSwitchScanStatus,
  handleCcSwitchHelp,
};

#!/usr/bin/env node
'use strict';

/**
 * model-type-providers.js — read-only CLI shell over the pure leaf
 * scripts/lib/modelTypeProviderPlan.js.
 *
 * PURPOSE
 *   Answer, on a fresh machine, the question the four disconnected provider
 *   namespaces cannot answer on their own:
 *     "For each user-facing model TYPE (text / video / vector / role), did the
 *      user supply a working API, and is it a relay (中转站), a direct vendor
 *      endpoint (直连), or a local backend?"
 *
 *   The leaf is a pure reducer. This shell does the IO: it reads per-type env
 *   configuration, derives the official-vendor host allowlist from the
 *   providerPresets SSOT, and injects both as facts. It is READ-ONLY and
 *   fail-soft — it never writes config and never throws on a broken env.
 *
 * SECRET HYGIENE (红线)
 *   This shell reads only the PRESENCE of a credential (a boolean), never its
 *   value. No key/token is ever read into a variable that is printed or
 *   returned. Only base URLs (non-secret) and boolean flags leave this file.
 *
 * USAGE
 *   node scripts/model-type-providers.js            # human-readable table
 *   node scripts/model-type-providers.js --json      # machine JSON (exit 2 if not all ready)
 *   node scripts/model-type-providers.js --gen-doc   # (re)write OPS-MAN-096
 */

const fs = require('fs');
const path = require('path');
const {
  planModelTypeProviders,
  CHANNEL_LOCAL,
  CHANNEL_DIRECT,
  CHANNEL_RELAY,
} = require('./lib/modelTypeProviderPlan');

const REPO_ROOT = path.resolve(__dirname, '..');
const DOC_PATH = path.join(
  REPO_ROOT,
  'docs',
  '07_OPS_运维',
  '[OPS-MAN-096] 多模型类型 Provider 配置对账.md',
);

// ── ANSI (only when TTY) ─────────────────────────────────────────────────
const _tty = process.stdout.isTTY === true;
const C = _tty
  ? {
      reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
      green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m',
    }
  : { reset: '', bold: '', dim: '', green: '', yellow: '', red: '', cyan: '' };

function _env(name) {
  const v = process.env[name];
  return typeof v === 'string' ? v.trim() : '';
}
function _hasEnv(name) {
  return _env(name).length > 0;
}

/**
 * Derive the official vendor host allowlist from the providerPresets SSOT.
 * Only the `official` category counts as "direct"; partner/relay presets are
 * intentionally NOT treated as official so their hosts classify as relay.
 * Fail-soft: any load error → empty allowlist (public hosts then read as relay).
 * @returns {string[]} lowercase host suffixes
 */
function _officialHosts() {
  const hosts = new Set();
  try {
    const mod = require(path.join(
      REPO_ROOT,
      'services', 'backend', 'src', 'services', 'gateway', 'providerPresets',
    ));
    const presets = typeof mod.getProviderPresets === 'function' ? mod.getProviderPresets() : [];
    for (const p of Array.isArray(presets) ? presets : []) {
      if (!p || p.category !== 'official') continue;
      const base = typeof p.baseUrl === 'string' ? p.baseUrl : '';
      if (!base) continue;
      try {
        const host = new URL(base).hostname.toLowerCase();
        if (host) hosts.add(host);
      } catch { /* skip unparseable */ }
    }
  } catch { /* SSOT unavailable — leave allowlist empty */ }
  return [...hosts];
}

/**
 * Gather per-type facts from the environment. Presence-only for credentials.
 * @returns {object} facts.types map for the leaf
 */
function _gatherTypeFacts() {
  // TEXT — the chat/text pool. base url from the common OpenAI-compatible envs;
  // key presence from any of the well-known key envs OR the gateway token.
  const textBase =
    _env('OPENAI_BASE_URL') || _env('OPENAI_API_BASE') || _env('KHY_GATEWAY_URL') || '';
  const textHasKey =
    _hasEnv('OPENAI_API_KEY') ||
    _hasEnv('ANTHROPIC_API_KEY') ||
    _hasEnv('KHY_API_KEY') ||
    _hasEnv('PROXY_AUTH_TOKEN');

  // VIDEO — lives outside the provider registry (KHY_VIDEO_GEN_* namespace).
  const videoBackend = (_env('KHY_VIDEO_GEN_BACKEND') || 'agnes').toLowerCase();
  const videoBase =
    _env('KHY_VIDEO_GEN_AGNES_BASE_URL') || _env('GATEWAY_VIDEO_GEN_AGNES_BASE_URL') || '';
  const videoHasKey =
    _hasEnv('KHY_VIDEO_GEN_AGNES_API_KEY') ||
    _hasEnv('GATEWAY_VIDEO_GEN_AGNES_API_KEY') ||
    // pool bridge (default-on) lets a chat key back video generation
    ((_env('KHY_VIDEO_GEN_POOL_BRIDGE') || 'on').toLowerCase() !== 'off' && textHasKey);

  // VECTOR — embedding endpoint (EMBED_URL / ollama / gateway).
  const embedUrl = _env('EMBED_URL');
  const ollamaHost = _env('OLLAMA_HOST');
  let vectorBase = embedUrl;
  let vectorLocal = false;
  let vectorHasKey = false;
  if (embedUrl) {
    vectorLocal = /localhost|127\.0\.0\.1|:11434/.test(embedUrl);
    vectorHasKey = vectorLocal; // local embed backend needs no key
  } else if (ollamaHost || true) {
    // Default embed path is the on-box ollama backend — treated as local.
    vectorBase = ollamaHost || 'http://localhost:11434/api/embeddings';
    vectorLocal = true;
    vectorHasKey = true;
  }

  // ROLE — the orchestrator's per-role model selection reuses the text pool,
  // gated by KHY_SUBAGENT_MODEL_AUTOSELECT (default-on). It is configured iff
  // the text pool is configured AND the gate is not turned off.
  const roleGateOff = ['0', 'false', 'off', 'no'].includes(
    (_env('KHY_SUBAGENT_MODEL_AUTOSELECT') || 'on').toLowerCase(),
  );
  const roleBase = roleGateOff ? '' : textBase;
  const roleHasKey = !roleGateOff && textHasKey;

  return {
    text: { baseUrl: textBase, hasKey: textHasKey, source: 'openai-compatible env / gateway' },
    video: { baseUrl: videoBase, hasKey: videoHasKey, source: `KHY_VIDEO_GEN_* (backend=${videoBackend})` },
    vector: { baseUrl: vectorBase, hasKey: vectorHasKey, local: vectorLocal, source: embedUrl ? 'EMBED_URL' : 'ollama (local)' },
    role: { baseUrl: roleBase, hasKey: roleHasKey, source: roleGateOff ? 'disabled (gate off)' : 'reuses text pool' },
  };
}

function buildPlan() {
  return planModelTypeProviders({
    officialHosts: _officialHosts(),
    types: _gatherTypeFacts(),
  });
}

// ── channel/status glyphs ────────────────────────────────────────────────
function _channelLabel(ch) {
  switch (ch) {
    case CHANNEL_LOCAL: return `${C.cyan}local 本地${C.reset}`;
    case CHANNEL_DIRECT: return `${C.green}direct 直连${C.reset}`;
    case CHANNEL_RELAY: return `${C.yellow}relay 中转${C.reset}`;
    default: return `${C.dim}unknown${C.reset}`;
  }
}
function _statusGlyph(configured) {
  return configured ? `${C.green}✔ 就绪${C.reset}` : `${C.red}✘ 未配置${C.reset}`;
}

const TYPE_LABELS = { text: '文本 text', video: '视频 video', vector: '向量 vector', role: '角色 role' };

function printHuman(plan) {
  const out = [];
  out.push(`${C.bold}Khy 多模型类型 Provider 配置对账${C.reset}`);
  out.push(`${C.dim}每类模型的 API 是否配置，以及走中转站(relay)/直连(direct)/本地(local)。${C.reset}`);
  out.push('');
  for (const t of plan.types) {
    const label = (TYPE_LABELS[t.type] || t.type).padEnd(14);
    const line = `  ${label} ${_statusGlyph(t.configured)}  [${_channelLabel(t.channel)}]`;
    out.push(line);
    const detail = [];
    if (t.baseUrl) detail.push(`endpoint: ${t.baseUrl}`);
    if (t.source) detail.push(`source: ${t.source}`);
    if (t.missing.length) detail.push(`missing: ${t.missing.join(', ')}`);
    if (detail.length) out.push(`      ${C.dim}${detail.join('  ·  ')}${C.reset}`);
  }
  out.push('');
  const color = plan.ok ? C.green : C.yellow;
  out.push(`  ${color}${plan.summary}${C.reset}`);
  out.push(
    `  ${C.dim}channels — direct:${plan.byChannel.direct} relay:${plan.byChannel.relay} local:${plan.byChannel.local} unknown:${plan.byChannel.unknown}${C.reset}`,
  );
  process.stdout.write(out.join('\n') + '\n');
}

// ── generated doc (byte-stable; no runtime values) ───────────────────────
function buildDoc() {
  const lines = [];
  lines.push('# [OPS-MAN-096] 多模型类型 Provider 配置对账');
  lines.push('');
  lines.push('> 本文件由 `node scripts/model-type-providers.js --gen-doc` 生成，请勿手改。');
  lines.push('');
  lines.push('## 解决的问题');
  lines.push('');
  lines.push('Khy 对四类用户可见模型分别在**互不相通的 env 命名空间**里解析 provider：');
  lines.push('');
  lines.push('| 类型 | 解析路径 | 中转/直连可见性 |');
  lines.push('| --- | --- | --- |');
  lines.push('| 文本 text | apiKeyPool + providerPresets + gateway pool | 无 |');
  lines.push('| 视频 video | `KHY_VIDEO_GEN_*`（在 provider 注册表之外）+ pool bridge | 无 |');
  lines.push('| 向量 vector | `EMBED_URL` / ollama / gateway `/v1/embeddings` | 无 |');
  lines.push('| 角色 role | `subAgentModelSelect`（复用文本池，`KHY_SUBAGENT_MODEL_AUTOSELECT`） | 无 |');
  lines.push('');
  lines.push('陌生机器上的用户想给不同类型配不同 API（中转站或直连）时，没有任何单一入口能回答：');
  lines.push('“哪几类模型已就绪，各自是怎么接线的？”本工具就是这个入口。');
  lines.push('');
  lines.push('## 用法');
  lines.push('');
  lines.push('```bash');
  lines.push('node scripts/model-type-providers.js            # 人类可读表格');
  lines.push('node scripts/model-type-providers.js --json     # 机器 JSON（非全就绪 exit 2）');
  lines.push('node scripts/model-type-providers.js --gen-doc  # 重新生成本文件');
  lines.push('```');
  lines.push('');
  lines.push('## 判定语义（纯叶 `scripts/lib/modelTypeProviderPlan.js`）');
  lines.push('');
  lines.push('- `channel` 仅由 base URL 主机对比 `providerPresets` 官方 SSOT 主机名判定：');
  lines.push('  loopback → `local`；主机 ∈ 官方名单 → `direct`（直连）；其它公网主机 → `relay`（中转站）。');
  lines.push('- `configured` 需要可用凭据路径：有 key，或本地后端（本地无需 key）。');
  lines.push('  有 base URL 但无 key → `keyless`（非就绪）。');
  lines.push('- 输入畸形/破损 → 全部判为未配置，**绝不抛异常、绝不伪造就绪**。');
  lines.push('- 本工具只读凭据**存在性**（布尔），绝不读取或打印 key/token 值（红线）。');
  lines.push('');
  lines.push('## 相关');
  lines.push('');
  lines.push('- SSOT：`services/backend/src/services/gateway/providerPresets.js`（官方/合作/中转 preset）');
  lines.push('- 自定义 provider 注册：`services/backend/src/services/customProviderRegistrar.js`');
  lines.push('- 能力分桶：`services/backend/src/services/gateway/modelCapability.js`');
  lines.push('');
  return lines.join('\n') + '\n';
}

function writeDoc() {
  const content = buildDoc();
  fs.mkdirSync(path.dirname(DOC_PATH), { recursive: true });
  fs.writeFileSync(DOC_PATH, content, 'utf-8');
  process.stdout.write(`wrote ${path.relative(REPO_ROOT, DOC_PATH)} (${Buffer.byteLength(content, 'utf-8')} bytes)\n`);
}

// ── main ─────────────────────────────────────────────────────────────────
function main() {
  const args = process.argv.slice(2);
  if (args.includes('--gen-doc')) { writeDoc(); return 0; }

  const plan = buildPlan();

  if (args.includes('--json')) {
    process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
    return plan.ok ? 0 : 2;
  }

  printHuman(plan);
  return 0;
}

if (require.main === module) {
  let code = 0;
  try { code = main(); } catch (e) {
    process.stderr.write(`model-type-providers: ${e && e.message ? e.message : e}\n`);
    code = 1;
  }
  process.exit(code);
}

module.exports = { buildPlan, buildDoc, _officialHosts, _gatherTypeFacts };

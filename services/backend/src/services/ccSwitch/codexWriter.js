'use strict';

/**
 * ccSwitch codexWriter — config-only Codex upstream switching.
 *
 * Mirrors CC Switch v3.20.1's config-only switch: the API key is written into
 * the provider's OWN [model_providers.<id>] table as `experimental_bearer_token`
 * (supported since Codex 0.48). auth.json returns to being a pure official
 * ChatGPT login file and is NO LONGER used to carry third-party API keys —
 * Codex 0.149+ refuses to inherit env credentials from auth.json for custom
 * providers, which made the old auth.json-based switch return 401.
 *
 * Also implements the v3.20.1 compat-fix family for config shapes that make
 * Codex 0.149 refuse to load:
 *   - reserved provider ids ([model_providers.openai]/.ollama/.lmstudio) →
 *     renamed losslessly to a cc-switch owned id
 *   - missing `name` on a provider table → backfilled (Bedrock stays unnamed
 *     deliberately — naming it breaks its built-in merge)
 *   - legacy top-level `openai_base_url` route carrying a usable key →
 *     migrated to a proper custom provider table
 *   - write pre-check: field combos Codex 0.149 cannot load are rejected BY
 *     NAME before any write (no "switch succeeded" then Codex won't start)
 *
 * Fail-soft: returns { success, ... } — never throws.
 */

const fs = require('fs');
const path = require('path');

const { atomicWriteText } = require('../../utils/atomicWriteJson');

// Reserved provider ids that Codex validates against (case-sensitive, matches
// upstream; includes amazon-bedrock-runtime). We never create these.
const RESERVED_PROVIDER_IDS = new Set([
  'openai',
  'ollama',
  'lmstudio',
  'openai-experimental',
  'amazon-bedrock-runtime',
]);

const VALID_WIRE_APIS = ['responses', 'chat'];
const DEFAULT_WIRE_API = 'responses';

// ── Path resolution (mirrors codexAdapter.resolveCodexConfigPaths) ──────────
function resolveCodexConfigPaths() {
  const os = require('os');
  const homeDir = os.homedir();
  const candidates = [path.join(homeDir, '.codex'), path.join(homeDir, '.config', 'codex')];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'config.toml'))) {
      return {
        dir,
        configPath: path.join(dir, 'config.toml'),
        authPath: path.join(dir, 'auth.json'),
      };
    }
  }
  const dir = candidates[0];
  return { dir, configPath: path.join(dir, 'config.toml'), authPath: path.join(dir, 'auth.json') };
}

/** TOML key-name sanitizer (matches codexAdapter.sanitizeProviderName). */
function sanitizeProviderName(name = '') {
  return (
    String(name)
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_')
      .replace(/^_+|_+$/g, '') || 'custom'
  );
}

function _escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Upsert a top-level (preamble) `key = value` pair (text before first `[`). */
function upsertPreambleKey(content = '', key = '', valueLiteral = '') {
  const lines = String(content).split('\n');
  let firstSection = lines.findIndex((l) => /^\s*\[/.test(l));
  if (firstSection < 0) {
    firstSection = lines.length;
  }
  const head = lines.slice(0, firstSection);
  const tail = lines.slice(firstSection);
  const keyRe = new RegExp(`^\\s*${_escapeRegExp(key)}\\s*=`);
  let replaced = false;
  for (let i = 0; i < head.length; i += 1) {
    if (keyRe.test(head[i])) {
      head[i] = `${key} = ${valueLiteral}`;
      replaced = true;
      break;
    }
  }
  if (!replaced) {
    head.push(`${key} = ${valueLiteral}`);
  }
  return head.concat(tail).join('\n');
}

/** Remove a `[sectionName]` table (header + body up to next header). */
function removeTomlSection(content = '', sectionName = '') {
  const lines = String(content).split('\n');
  const out = [];
  let skipping = false;
  for (const line of lines) {
    const m = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (m) {
      skipping = m[1].trim() === sectionName;
      if (skipping) {
        continue;
      }
    }
    if (!skipping) {
      out.push(line);
    }
  }
  return out.join('\n');
}

/** Extract all [model_providers.<name>] table names (and their first header line index). */
function _collectProviderTables(content) {
  const out = [];
  const lines = String(content).split('\n');
  let current = null;
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^\s*\[model_providers\.([^\]]+)\]\s*$/);
    if (m) {
      current = m[1].trim();
      out.push({ name: current, index: i });
    }
  }
  return out;
}

/** Atomic write with a single .khy-bak backup (same convention as codexAdapter). */
function _atomicWriteWithBackup(targetPath, data) {
  try {
    if (fs.existsSync(targetPath)) {
      fs.copyFileSync(targetPath, `${targetPath}.khy-bak`);
    }
  } catch {
    /* backup is best-effort */
  }
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(targetPath)}.tmp-${process.pid}`);
  fs.writeFileSync(tmp, data, 'utf-8');
  fs.renameSync(tmp, targetPath);
}

/**
 * Fix config shapes that make Codex 0.149 refuse to load:
 *   1. Reserved-id provider tables → renamed to a cc-switch owned id.
 *   2. Provider tables missing `name` → backfilled (except the Bedrock table,
 *      which is deliberately unnamed — naming it breaks its built-in merge).
 *
 * Returns { content, renames: [{from,to}], backfills: string[] }.
 */
function _healLegacyShapes(content) {
  const tables = _collectProviderTables(content);
  const renames = [];
  const backfills = [];
  let out = content;

  for (const t of tables) {
    const rawName = t.name;
    const isReserved = RESERVED_PROVIDER_IDS.has(rawName);
    if (isReserved) {
      const newName = `${sanitizeProviderName(rawName)}_khy`; // e.g. openai_khy
      if (newName === rawName) {
        continue;
      }
      // Rename the header line only; the body stays byte-identical.
      const lines = out.split('\n');
      const m = lines[t.index].match(/^(\s*\[model_providers\.)([^\]]+)(\]\s*)$/);
      if (m) {
        lines[t.index] = `${m[1]}${newName}${m[3]}`;
      }
      out = lines.join('\n');
      renames.push({ from: rawName, to: newName });
    }
  }

  // Backfill missing `name` inside each (now non-reserved) provider table body.
  // Walk table bodies; skip the Bedrock table (deliberately unnamed).
  const lines = out.split('\n');
  let currentTable = null;
  let inProviderTable = false;
  let sawName = false;
  const flushName = () => {
    if (inProviderTable && currentTable && !sawName && currentTable !== 'amazon-bedrock-runtime') {
      lines.splice(_pendingNameInsertAt, 0, `name = "${currentTable}"`);
      backfills.push(currentTable);
    }
  };
  let _pendingNameInsertAt = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const sec = lines[i].match(/^\s*\[([^\]]+)\]\s*$/);
    if (sec) {
      // flush previous table before switching
      flushName();
      inProviderTable = sec[1].trim().startsWith('model_providers.');
      currentTable = inProviderTable ? sec[1].trim().slice('model_providers.'.length) : null;
      sawName = false;
      _pendingNameInsertAt = i + 1;
      continue;
    }
    if (inProviderTable && currentTable) {
      if (/^\s*name\s*=/.test(lines[i])) {
        sawName = true;
      }
    }
  }
  flushName();

  return { content: lines.join('\n'), renames, backfills };
}

/**
 * Migrate a legacy top-level `openai_base_url` route into a proper custom
 * provider table (only when a usable key exists — keyless routes get rejected
 * by the write pre-check instead).
 *
 * @returns {{ content: string, migrated: boolean, providerName: string }}
 */
function _migrateLegacyOpenaiBaseUrl(content) {
  const re = /^\s*openai_base_url\s*=\s*"([^"]+)"\s*$/m;
  const m = content.match(re);
  if (!m) {
    return { content, migrated: false, providerName: '' };
  }
  const baseUrl = m[1];
  const providerName = 'cc_switch_legacy';
  let out = content.replace(re, ''); // drop the top-level key
  out = removeTomlSection(out, `model_providers.${providerName}`);
  const block = [
    `[model_providers.${providerName}]`,
    `name = "${providerName}"`,
    `base_url = "${baseUrl}"`,
    `wire_api = "${DEFAULT_WIRE_API}"`,
  ].join('\n');
  out = `${out.replace(/\n*$/, '\n')}\n${block}\n`;
  return { content: out, migrated: true, providerName };
}

/**
 * Write-pre-check: reject field combos Codex 0.149 cannot load, BY NAME,
 * before any write happens.
 *
 * @returns {{ ok: boolean, reason?: string }}
 */
function preflightCodexWrite({ providerName, baseUrl, model, apiKey, requiresOpenaiAuth }) {
  if (!providerName) {
    return { ok: false, reason: 'providerName 是必填项' };
  }
  if (!baseUrl) {
    return { ok: false, reason: 'baseUrl 是必填项' };
  }
  try {
    new URL(baseUrl);
  } catch {
    return { ok: false, reason: `baseUrl 必须是合法的 http(s) URL: ${baseUrl}` };
  }
  const sanitized = sanitizeProviderName(providerName);
  if (RESERVED_PROVIDER_IDS.has(sanitized)) {
    return { ok: false, reason: `provider 名「${providerName}」落在 Codex 保留 id 上（${sanitized}），无法加载` };
  }
  if (!model) {
    return { ok: false, reason: 'model 是必填项（切换后 Codex 用不到当前模型会直接失败）' };
  }
  if (!apiKey && !requiresOpenaiAuth) {
    return { ok: false, reason: '既无 API 密钥也未标记 requiresOpenaiAuth —— 0.149 无法加载这种无凭据第三方表' };
  }
  if (!apiKey && requiresOpenaiAuth) {
    // Allowed but risky: falls back to official login. The caller's
    // preserve-login policy decides whether to reject.
    return { ok: true, warn: '无自有密钥且 requiresOpenaiAuth=true —— 将回退官方登录' };
  }
  return { ok: true };
}

/**
 * Config-only Codex upstream switch (cc-switch v3.20.1 parity).
 *
 * @param {object} opts
 * @param {string} opts.providerName
 * @param {string} opts.baseUrl
 * @param {string} opts.model
 * @param {string} [opts.apiKey]
 * @param {string} [opts.wireApi] 'responses' | 'chat' (default 'responses')
 * @param {boolean} [opts.requiresOpenaiAuth]  provider table flag (default false)
 * @param {boolean} [opts.preserveOfficialLogin]  when false AND a third-party
 *   key is being written, delete auth.json (official ChatGPT login removed).
 * @returns {{ success: boolean, configPath?: string, provider?: string, baseUrl?: string, model?: string, wireApi?: string, error?: string, detail?: object }}
 */
function setCodexUpstreamConfigOnly(opts = {}) {
  try {
    const providerNameRaw = String(opts.providerName || '').trim();
    const baseUrl = String(opts.baseUrl || '').trim();
    const model = String(opts.model || '').trim();
    const apiKey = opts.apiKey != null ? String(opts.apiKey).trim() : '';
    const wireApiRaw = String(opts.wireApi || DEFAULT_WIRE_API).trim().toLowerCase();
    const wireApi = VALID_WIRE_APIS.includes(wireApiRaw) ? wireApiRaw : DEFAULT_WIRE_API;
    const requiresOpenaiAuth = opts.requiresOpenaiAuth === true;
    const preserveOfficialLogin = opts.preserveOfficialLogin !== false;

    const pre = preflightCodexWrite({ providerName: providerNameRaw, baseUrl, model, apiKey, requiresOpenaiAuth });
    if (!pre.ok) {
      return { success: false, error: pre.reason };
    }

    const provider = sanitizeProviderName(providerNameRaw);
    const { dir, configPath, authPath } = resolveCodexConfigPaths();
    fs.mkdirSync(dir, { recursive: true });

    let content = '';
    try {
      content = fs.readFileSync(configPath, 'utf-8');
    } catch {
      content = '';
    }

    // 1. Heal legacy shapes (renamed reserved ids + backfilled names).
    const healed = _healLegacyShapes(content);
    content = healed.content;

    // 2. Migrate a legacy top-level openai_base_url route (if present).
    const migrated = _migrateLegacyOpenaiBaseUrl(content);
    content = migrated.content;

    // 3. Rewrite the managed provider table (fresh, no stale fields).
    content = removeTomlSection(content, `model_providers.${provider}`);
    const blockLines = [
      `[model_providers.${provider}]`,
      `name = "${provider}"`,
      `base_url = "${baseUrl}"`,
      `wire_api = "${wireApi}"`,
    ];
    if (requiresOpenaiAuth) {
      blockLines.push(`requires_openai_auth = true`);
    }
    if (apiKey) {
      // The config-only bearer token (Codex 0.48+). This is the whole point of
      // the v3.20.1 change: key lives HERE, not in auth.json.
      blockLines.push(`experimental_bearer_token = "${apiKey}"`);
    }
    content = `${content.replace(/\n*$/, '\n')}\n${blockLines.join('\n')}\n`;

    content = upsertPreambleKey(content, 'model_provider', `"${provider}"`);
    content = upsertPreambleKey(content, 'model', `"${model}"`);

    _atomicWriteWithBackup(configPath, content);

    // 4. auth.json policy: third-party keys NEVER go into auth.json. When a key
    //    is being written and preserve-official-login is OFF, delete auth.json
    //    entirely (official ChatGPT login removed — matches cc-switch default).
    if (apiKey && !preserveOfficialLogin && fs.existsSync(authPath)) {
      try {
        fs.unlinkSync(authPath);
      } catch {
        return {
          success: true,
          configPath,
          provider,
          baseUrl,
          model,
          wireApi,
          error: 'auth.json 删除失败（官方登录仍留在 Codex 配置目录中）',
          detail: { renames: healed.renames, backfills: healed.backfills, migrated: migrated.migrated },
        };
      }
    }

    return {
      success: true,
      configPath,
      provider,
      baseUrl,
      model,
      wireApi,
      detail: {
        renames: healed.renames,
        backfills: healed.backfills,
        migrated: migrated.migrated,
        authJsonTouched: apiKey && !preserveOfficialLogin,
      },
    };
  } catch (e) {
    return { success: false, error: String((e && e.message) || e) };
  }
}

module.exports = {
  setCodexUpstreamConfigOnly,
  preflightCodexWrite,
  resolveCodexConfigPaths,
  sanitizeProviderName,
  _healLegacyShapes,
  _migrateLegacyOpenaiBaseUrl,
  _collectProviderTables,
  RESERVED_PROVIDER_IDS,
};

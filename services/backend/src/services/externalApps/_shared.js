'use strict';

/**
 * externalApps/_shared — 外部 app 配置适配器的公共底座(fail-soft、无门控自身;门控在调用层)。
 *
 * 只放**跨 adapter 复用**的确定性小工具:home 目录解析、原子读写、dotenv 解析/合并写、
 * provider 元数据(endpoint / 密钥 env 名 / 默认模型)解析。任何一处 IO 失败都以异常抛出,
 * 由各 adapter 的 try/catch 收敛成 `{success:false,error}`——本模块不吞错,便于 adapter 汇报根因。
 *
 * 密钥来源(用户拍板:复用 khy 已存 + NL 现给都支持):resolveApiKey 优先用 NL 显式给的 key,
 * 否则回退到 apiKeyPool.listAvailableKeys(provider) 取 khy 已配置的对应厂商 key。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/** 展开前导 ~ 为用户主目录。 */
function expandHome(p, env = process.env) {
  const home = (env && env.HOME) || os.homedir();
  if (!p) return p;
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p;
}

/** 读文件,不存在返回 null(其它错误抛出)。 */
function readIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw e;
  }
}

/** 原子写:先写同目录 temp 再 rename(避免半截文件)。自动建父目录。 */
function atomicWrite(file, content) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}`);
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

// ── dotenv(.env)最小解析 / 合并写 ───────────────────────────────────────────
// 规则(对齐 Reasonix/openclaw 文档):一行一个 KEY=value;# 注释与空行忽略;读时容忍
// `export KEY=` 与引号;写时保守只改目标键,保留其余行与注释。

/** 解析 .env 文本 → { KEY: value }(仅用于 has-key 判断,值不解引号回传原样去引号)。 */
function parseDotenv(text) {
  const out = {};
  if (!text) return out;
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[m[1]] = val;
  }
  return out;
}

/**
 * 在 .env 文本里 upsert 一个 KEY=value(保留其余行/注释)。key 已存在则原地替换该行,
 * 否则追加到末尾。返回新文本。删除用 removeDotenvKey。
 */
function upsertDotenv(text, key, value) {
  const line = `${key}=${value}`;
  const src = text == null ? '' : String(text);
  const lines = src.split(/\r?\n/);
  const re = new RegExp(`^(?:export\\s+)?${key}\\s*=`);
  let replaced = false;
  const next = lines.map((l) => {
    if (!replaced && re.test(l.trim())) { replaced = true; return line; }
    return l;
  });
  if (!replaced) {
    if (next.length && next[next.length - 1] === '') next.splice(next.length - 1, 0, line);
    else next.push(line);
  }
  let out = next.join('\n');
  if (!out.endsWith('\n')) out += '\n';
  return out;
}

/** 从 .env 文本删除 KEY(留一条 tombstone 注释,对齐 Reasonix 的 `# reasonix-cleared`)。 */
function removeDotenvKey(text, key, tombstonePrefix) {
  const src = text == null ? '' : String(text);
  const re = new RegExp(`^(?:export\\s+)?${key}\\s*=`);
  const out = [];
  let removed = false;
  for (const l of src.split(/\r?\n/)) {
    if (re.test(l.trim())) {
      removed = true;
      if (tombstonePrefix) out.push(`${tombstonePrefix} ${key}`);
      continue;
    }
    out.push(l);
  }
  return { text: out.join('\n'), removed };
}

// ── provider 元数据解析(endpoint / 密钥 env 名 / 默认模型)──────────────────────

/** 由 provider id 生成 shell 风格的 env 键名,如 deepseek → DEEPSEEK_API_KEY。 */
function envKeyName(provider, suffix = 'API_KEY') {
  const norm = String(provider || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `${norm || 'CUSTOM'}_${suffix}`;
}

/** 查 providerPresets 拿 {baseUrl, defaultModel}(找不到返回空字段)。lazy require 避免循环。 */
function presetFor(provider) {
  try {
    const { getProviderPresets } = require('../gateway/providerPresets');
    const id = String(provider || '').trim().toLowerCase();
    const hit = getProviderPresets().find((p) => p.id === id);
    return hit || null;
  } catch {
    return null;
  }
}

/**
 * 解析要写入外部 app 的密钥:NL 显式给的优先,否则回退 khy 已存的对应厂商 key。
 * 返回 { key, source:'nl'|'pool'|'none' }。绝不抛(池不可用 → none)。
 */
function resolveApiKey(provider, explicitKey) {
  if (explicitKey) return { key: explicitKey, source: 'nl' };
  try {
    const pool = require('../apiKeyPool');
    const avail = pool.listAvailableKeys(provider) || [];
    if (avail.length && avail[0].key) return { key: avail[0].key, source: 'pool' };
  } catch { /* pool unavailable — fall through */ }
  return { key: '', source: 'none' };
}

/** 解析 endpoint:NL 给的优先,否则 preset 的 baseUrl。 */
function resolveEndpoint(provider, explicitEndpoint) {
  if (explicitEndpoint) return explicitEndpoint;
  const preset = presetFor(provider);
  return preset && preset.baseUrl ? preset.baseUrl : '';
}

/** 解析默认模型:NL 给的优先,否则 preset 的 defaultModel。 */
function resolveModel(provider, explicitModel) {
  if (explicitModel) return explicitModel;
  const preset = presetFor(provider);
  return preset && preset.defaultModel ? preset.defaultModel : '';
}

/** 脱敏:只留头尾各 4 字符。用于结果回显,绝不回原文 key。 */
function maskKey(key) {
  const s = String(key || '');
  if (s.length <= 8) return s ? '****' : '';
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

module.exports = {
  expandHome,
  readIfExists,
  atomicWrite,
  parseDotenv,
  upsertDotenv,
  removeDotenvKey,
  envKeyName,
  presetFor,
  resolveApiKey,
  resolveEndpoint,
  resolveModel,
  maskKey,
};

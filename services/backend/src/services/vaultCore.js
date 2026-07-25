'use strict';

/**
 * vaultCore.js — 纯叶子:密钥保险库的全部「判定 / 整形 / 占位符替换 / 脱敏」逻辑(单一真源)。
 * 对齐 Claude Code 的密钥保险库:用户把 API token 等机密存进本地保险库,模型发 HTTP 请求时
 * 用占位符 `{{vault:NAME}}` 引用,**真正的密钥值在服务端注入,绝不进入模型上下文**。
 *
 * 契约:零 IO(不碰 fs/网络/子进程,只读 process.env 做门控)、确定性、绝不抛(fail-soft)、
 * env 门控 KHY_VAULT 默认开、关闭即字节回退。真正的读写盘(vault.json)由薄 IO 层 vaultStore 完成;
 * 真正的发请求由工具 VaultHttpFetch 完成。本叶子只接收已读入的数据再做纯计算。
 *
 * 安全红线(代码化「密钥绝不回显」):
 *   1) 列出/确认密钥只走 maskSecret / shapeListing —— 永不返回明文值;
 *   2) substituteSecrets 把占位符换成真值仅供服务端发请求,其结果绝不回灌给模型;
 *   3) redactSecrets 把响应/错误文本里任何意外回显的密钥值替换为 [REDACTED]。
 */

const STORE_VERSION = 1;

// 密钥名:形如环境变量(字母开头、字母数字下划线),既防 JSON 键注入,也防占位符歧义。
const SECRET_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
// 占位符:{{vault:NAME}}(允许内部空白),NAME 必须满足 SECRET_NAME_RE。
const PLACEHOLDER_RE = /\{\{\s*vault:([A-Za-z][A-Za-z0-9_]{0,63})\s*\}\}/g;
const REDACTION = '[REDACTED]';

// ── 门控 ─────────────────────────────────────────────────────────────────────
const _FALSY = new Set(['0', 'false', 'off', 'no']);
function isEnabled(env = process.env) {
  const raw = env && env.KHY_VAULT;
  const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
  return !_FALSY.has(v);
}

// ── 名称校验 ─────────────────────────────────────────────────────────────────
function isValidSecretName(name) {
  return typeof name === 'string' && SECRET_NAME_RE.test(name);
}

/** 规范化密钥名:trim 后校验;非法 → null(绝不拼非法名进 JSON 键/占位符)。 */
function normalizeName(name) {
  const s = String(name == null ? '' : name).trim();
  return SECRET_NAME_RE.test(s) ? s : null;
}

// ── 脱敏(永不返回明文)──────────────────────────────────────────────────────
/** 给一个密钥值生成可展示的掩码预览。绝不返回完整值。 */
function maskSecret(value) {
  const s = String(value == null ? '' : value);
  const n = s.length;
  if (n === 0) return '(empty)';
  if (n < 12) return `**** (${n} chars)`;
  return `${s.slice(0, 3)}…${s.slice(-2)} (${n} chars)`;
}

/**
 * 把 vaultStore 的原始记录整形成可列出的清单(永不含明文值)。
 * @param {object} record - { NAME: { value, createdAt, updatedAt }, ... }
 * @returns {Array<{name,preview,length,createdAt,updatedAt}>} 按名称升序
 */
function shapeListing(record) {
  if (!record || typeof record !== 'object') return [];
  const out = [];
  for (const name of Object.keys(record)) {
    const entry = record[name] || {};
    const value = typeof entry.value === 'string' ? entry.value : '';
    out.push({
      name,
      preview: maskSecret(value),
      length: value.length,
      createdAt: entry.createdAt || '',
      updatedAt: entry.updatedAt || '',
    });
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

// ── 占位符:抽取 / 替换 ──────────────────────────────────────────────────────
/** 从一段文本里抽出所有 {{vault:NAME}} 引用的密钥名(去重,保序)。 */
function extractSecretRefs(text) {
  const s = String(text == null ? '' : text);
  const seen = new Set();
  const out = [];
  let m;
  PLACEHOLDER_RE.lastIndex = 0;
  while ((m = PLACEHOLDER_RE.exec(s)) !== null) {
    const name = m[1];
    if (!seen.has(name)) { seen.add(name); out.push(name); }
  }
  return out;
}

/**
 * 从「请求各部分」(url 字符串 + headers 对象的值 + body 字符串)收集所有引用的密钥名。
 * @param {{url?:string, headers?:object, body?:string}} parts
 * @returns {string[]} 去重保序
 */
function collectSecretRefs(parts = {}) {
  const seen = new Set();
  const out = [];
  const add = (text) => {
    for (const name of extractSecretRefs(text)) {
      if (!seen.has(name)) { seen.add(name); out.push(name); }
    }
  };
  add(parts.url);
  add(parts.body);
  const headers = parts.headers && typeof parts.headers === 'object' ? parts.headers : {};
  for (const k of Object.keys(headers)) add(headers[k]);
  return out;
}

/**
 * 把文本里的 {{vault:NAME}} 替换成 secretMap[NAME] 的真值(服务端注入)。
 * secretMap 缺失的名保持占位符原样(调用方应已先做 missing 校验)。纯函数。
 */
function substituteSecrets(text, secretMap = {}) {
  const s = String(text == null ? '' : text);
  return s.replace(PLACEHOLDER_RE, (full, name) =>
    (secretMap && Object.prototype.hasOwnProperty.call(secretMap, name) ? String(secretMap[name]) : full));
}

/** 对 headers 对象逐值替换占位符,返回新对象(不改原对象)。 */
function substituteHeaders(headers, secretMap = {}) {
  const out = {};
  const h = headers && typeof headers === 'object' ? headers : {};
  for (const k of Object.keys(h)) out[k] = substituteSecrets(h[k], secretMap);
  return out;
}

// ── 脱敏回灌(防服务端把密钥值回显)────────────────────────────────────────
/** 把文本里出现的任何一个密钥值替换为 [REDACTED]。secretValues = 真值数组。 */
function redactSecrets(text, secretValues) {
  let s = String(text == null ? '' : text);
  if (!Array.isArray(secretValues) || secretValues.length === 0) return s;
  // 长值优先替换,避免一个值是另一个的子串时漏替。空串跳过。
  const vals = secretValues
    .filter((v) => typeof v === 'string' && v.length > 0)
    .sort((a, b) => b.length - a.length);
  for (const v of vals) {
    s = s.split(v).join(REDACTION);
  }
  return s;
}

/** 缺失密钥的报错文案(指引去 `khy vault set` 添加,不泄露任何值)。 */
function buildMissingSecretError(names) {
  const list = Array.isArray(names) ? names.filter(Boolean) : [];
  if (list.length === 0) return '';
  return `保险库中缺少以下密钥:${list.join(', ')}。请先用 \`khy vault set <名称>\` 添加,再用 {{vault:名称}} 引用。`;
}

module.exports = {
  STORE_VERSION,
  SECRET_NAME_RE,
  PLACEHOLDER_RE,
  REDACTION,
  isEnabled,
  isValidSecretName,
  normalizeName,
  maskSecret,
  shapeListing,
  extractSecretRefs,
  collectSecretRefs,
  substituteSecrets,
  substituteHeaders,
  redactSecrets,
  buildMissingSecretError,
};

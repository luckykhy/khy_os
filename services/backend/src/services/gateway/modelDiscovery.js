/**
 * Model Discovery — scan local IDE/auth/config files for model identifiers.
 *
 * Goal:
 * - discover "unknown" model IDs from installed IDEs and local config
 * - provide candidates for RELAY_API_MODELS and model picker
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();

const KNOWN_FILES = [
  path.join(HOME, '.codex', 'config.toml'),
  path.join(HOME, '.config', 'codex', 'config.toml'),
  path.join(HOME, '.config', 'Cursor', 'User', 'globalStorage', 'storage.json'),
  path.join(HOME, '.config', 'Trae', 'User', 'globalStorage', 'storage.json'),
  path.join(HOME, '.config', 'Trae CN', 'User', 'globalStorage', 'storage.json'),
  path.join(HOME, '.config', 'Windsurf', 'User', 'globalStorage', 'storage.json'),
  path.join(HOME, '.config', 'Codeium', 'User', 'globalStorage', 'storage.json'),
  path.join(HOME, '.config', 'Code', 'User', 'globalStorage', 'storage.json'),
  path.join(HOME, '.khy', 'config.json'),
  path.join(HOME, '.khyquant', 'config.json'),
  ..._portableConfigCandidates(),
];

// Portable-aware config candidates (deduped against the legacy entries above).
function _portableConfigCandidates() {
  const out = [];
  try {
    const { getDataHome, getAppHome } = require('../../utils/dataHome');
    for (const dir of [getDataHome(), getAppHome()]) {
      const p = path.join(dir, 'config.json');
      if (
        p !== path.join(HOME, '.khy', 'config.json') &&
        p !== path.join(HOME, '.khyquant', 'config.json') &&
        !out.includes(p)
      ) {
        out.push(p);
      }
    }
  } catch {
    /* dataHome unavailable */
  }
  return out;
}

const MODEL_ID_REGEX =
  /\b(?:gpt|o[1-9]|claude|gemini|deepseek|qwen|glm|doubao|llama|mistral|sonnet|haiku|opus|moonshot|yi|ernie|copilot|cursor|codeium|kimi|qvq|qwq|swe|cascade|windsurf)[a-z0-9._\-:/]{1,80}\b/gi;

function safeRead(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return '';
    }
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}

function extractFromText(text) {
  const out = new Set();
  const src = String(text || '');
  let m;
  while ((m = MODEL_ID_REGEX.exec(src)) !== null) {
    const id = String(m[0] || '').trim();
    if (!id) {
      continue;
    }
    if (id.length < 3 || id.length > 96) {
      continue;
    }
    out.add(id);
  }
  return out;
}

// normalizeModelId 已收敛至 gateway/_modelIdParse.js(Batch 2 纯函数原子层);
// 保留本地常量名,调用点逐字节不变。
const normalizeModelId = require('./_modelIdParse').normalizeModelIdCompact;

// 形态律复用真值叶子([DESIGN-ARCH-100] §3.2 律 2),不在本模块再写一份正则。
// 本模块是「扫描脏数据」的**第一道闸**:被它放行的字符串会被 merge 进 .env 的
// RELAY_API_MODELS 而**永久留存在模型列表里**(自污染闭环),所以这里的判据必须从严。
const { isWellFormedId } = require('./modelListTruth');

// 裸家族词(gpt / claude / claude sonnet …)**单独出现**不是模型 ID。
// MODEL_ID_REGEX 的每个分支都是家族关键词,散文里出现「Claude」就会被整体命中并当成
// 一个模型 ID 写进 RELAY_API_MODELS —— 真模型 ID 必带版本/变体后缀(claude-sonnet-4-6 /
// gpt-4o / qwen3.5:4b),裸词一律拒。
const BARE_FAMILY_RE =
  /^(?:gpt|o[1-9]|claude|gemini|deepseek|qwen|glm|doubao|llama|mistral|sonnet|haiku|opus|moonshot|yi|ernie|copilot|cursor|codeium|kimi|qvq|qwq|swe|cascade|windsurf)$/i;

function isLikelyModelId(id) {
  const s = normalizeModelId(id).toLowerCase();
  if (!s) {
    return false;
  }
  if (s.startsWith('http') || s.includes('@') || s.includes('\\')) {
    return false;
  }
  if (s.length < 3 || s.length > 96) {
    return false;
  }
  if (BARE_FAMILY_RE.test(s)) {
    return false;
  }
  // 形态律:规范化后的串也必须像一个模型标识符(不得再含空白/CJK/引号/URL 形状)。
  if (!isWellFormedId(s)) {
    return false;
  }
  return /(gpt|o[1-9]|claude|gemini|deepseek|qwen|glm|doubao|llama|mistral|sonnet|haiku|opus|moonshot|yi|ernie|copilot|cursor|codeium|kimi|qvq|qwq|swe|cascade|windsurf)/i.test(
    s
  );
}

/**
 * 从一个**原始**字符串里取模型 ID;不像则返回 ''。
 * 判序:先看原始串(真实 ID 从不含空白),再规范化。反序会让「Claude 3.5 Sonnet 很好用」
 * 这类散文被洗成 `Claude3.5Sonnet很好用` 而蒙混过关 —— 那正是垃圾模型 ID 的来历。
 */
function acceptRawValue(v) {
  if (typeof v !== 'string') {
    return '';
  }
  if (!isWellFormedId(v)) {
    return '';
  }
  const id = normalizeModelId(v);
  return isLikelyModelId(id) ? id : '';
}

function discoverFromJson(text) {
  const models = new Set();
  try {
    const obj = JSON.parse(text);
    const walk = (v) => {
      if (v == null) {
        return;
      }
      if (typeof v === 'string') {
        const id = acceptRawValue(v);
        if (id) {
          models.add(id);
        }
        return;
      }
      if (Array.isArray(v)) {
        for (const x of v) {
          walk(x);
        }
        return;
      }
      if (typeof v === 'object') {
        for (const [k, val] of Object.entries(v)) {
          const lk = String(k).toLowerCase();
          if (lk.includes('model') && typeof val === 'string') {
            const id = acceptRawValue(val);
            if (id) {
              models.add(id);
            }
          }
          walk(val);
        }
      }
    };
    walk(obj);
  } catch {
    // ignore
  }
  return models;
}

function discoverFromToml(text) {
  const models = new Set();
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s*model\s*=\s*"([^"]+)"/i);
    if (m && m[1]) {
      const id = acceptRawValue(m[1]);
      if (id) {
        models.add(id);
      }
    }
  }
  return models;
}

function discoverModels() {
  const found = new Set();
  const evidence = [];

  for (const file of KNOWN_FILES) {
    const text = safeRead(file);
    if (!text) {
      continue;
    }

    const ext = path.extname(file).toLowerCase();
    let local = new Set();
    if (ext === '.json') {
      local = discoverFromJson(text);
    } else if (ext === '.toml') {
      local = discoverFromToml(text);
    } else {
      local = extractFromText(text);
    }

    // broad regex fallback for any file type
    for (const id of extractFromText(text)) {
      if (isLikelyModelId(id)) {
        local.add(normalizeModelId(id));
      }
    }

    if (local.size > 0) {
      evidence.push({ file, count: local.size });
      for (const id of local) {
        found.add(id);
      }
    }
  }

  // Include env hints
  for (const key of [
    'RELAY_API_MODEL',
    'GATEWAY_PREFERRED_MODEL',
    'OPENAI_MODEL',
    'ANTHROPIC_MODEL',
    'QWEN_MODEL',
    'ZHIPU_MODEL',
    'OLLAMA_MODEL',
    'LOCAL_LLM_MODEL',
    'LOCAL_MODEL',
  ]) {
    const v = process.env[key];
    if (isLikelyModelId(v)) {
      found.add(normalizeModelId(v));
    }
  }

  // Include existing relay list
  const relayList = String(process.env.RELAY_API_MODELS || '')
    .split(',')
    .map((s) => normalizeModelId(s))
    .filter(isLikelyModelId);
  for (const id of relayList) {
    found.add(id);
  }

  const models = [...found].sort((a, b) => a.localeCompare(b));
  return { models, evidence };
}

function mergeRelayModels(existing, discovered) {
  const set = new Set();
  for (const id of String(existing || '')
    .split(',')
    .map((s) => normalizeModelId(s))
    .filter(isLikelyModelId)) {
    set.add(id);
  }
  for (const id of discovered.map(normalizeModelId).filter(isLikelyModelId)) {
    set.add(id);
  }
  return [...set].sort((a, b) => a.localeCompare(b)).join(',');
}

function updateRelayModelsInEnvFile(envPath, discovered) {
  let envContent = '';
  try {
    if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, 'utf-8');
    }
  } catch {
    envContent = '';
  }

  const merged = mergeRelayModels(process.env.RELAY_API_MODELS || '', discovered);
  const line = `RELAY_API_MODELS=${merged}`;
  const regex = /^RELAY_API_MODELS=.*$/m;
  if (regex.test(envContent)) {
    envContent = envContent.replace(regex, line);
  } else {
    envContent = envContent.trimEnd() + '\n' + line + '\n';
  }

  fs.writeFileSync(envPath, envContent, 'utf-8');
  process.env.RELAY_API_MODELS = merged;
  return merged;
}

module.exports = {
  discoverModels,
  mergeRelayModels,
  updateRelayModelsInEnvFile,
};

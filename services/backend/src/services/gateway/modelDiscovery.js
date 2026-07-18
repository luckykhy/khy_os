/**
 * Model Discovery — scan local IDE/auth/config files for model identifiers.
 *
 * Goal:
 * - discover "unknown" model IDs from installed IDEs and local config
 * - provide candidates for RELAY_API_MODELS and model picker
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

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
];

const MODEL_ID_REGEX = /\b(?:gpt|o[1-9]|claude|gemini|deepseek|qwen|glm|doubao|llama|mistral|sonnet|haiku|opus|moonshot|yi|ernie|copilot|cursor|codeium|kimi|qvq|qwq|swe|cascade|windsurf)[a-z0-9._\-:/]{1,80}\b/ig;

function safeRead(filePath) {
  try {
    if (!fs.existsSync(filePath)) return '';
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
    if (!id) continue;
    if (id.length < 3 || id.length > 96) continue;
    out.add(id);
  }
  return out;
}

function normalizeModelId(id) {
  return String(id || '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\s+/g, '');
}

function isLikelyModelId(id) {
  const s = normalizeModelId(id).toLowerCase();
  if (!s) return false;
  if (s.startsWith('http') || s.includes('@') || s.includes('\\')) return false;
  if (s.length < 3 || s.length > 96) return false;
  return /(gpt|o[1-9]|claude|gemini|deepseek|qwen|glm|doubao|llama|mistral|sonnet|haiku|opus|moonshot|yi|ernie|copilot|cursor|codeium|kimi|qvq|qwq|swe|cascade|windsurf)/i.test(s);
}

function discoverFromJson(text) {
  const models = new Set();
  try {
    const obj = JSON.parse(text);
    const walk = (v) => {
      if (v == null) return;
      if (typeof v === 'string') {
        const id = normalizeModelId(v);
        if (isLikelyModelId(id)) models.add(id);
        return;
      }
      if (Array.isArray(v)) {
        for (const x of v) walk(x);
        return;
      }
      if (typeof v === 'object') {
        for (const [k, val] of Object.entries(v)) {
          const lk = String(k).toLowerCase();
          if (lk.includes('model') && typeof val === 'string') {
            const id = normalizeModelId(val);
            if (isLikelyModelId(id)) models.add(id);
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
      const id = normalizeModelId(m[1]);
      if (isLikelyModelId(id)) models.add(id);
    }
  }
  return models;
}

function discoverModels() {
  const found = new Set();
  const evidence = [];

  for (const file of KNOWN_FILES) {
    const text = safeRead(file);
    if (!text) continue;

    const ext = path.extname(file).toLowerCase();
    let local = new Set();
    if (ext === '.json') local = discoverFromJson(text);
    else if (ext === '.toml') local = discoverFromToml(text);
    else local = extractFromText(text);

    // broad regex fallback for any file type
    for (const id of extractFromText(text)) {
      if (isLikelyModelId(id)) local.add(normalizeModelId(id));
    }

    if (local.size > 0) {
      evidence.push({ file, count: local.size });
      for (const id of local) found.add(id);
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
    if (isLikelyModelId(v)) found.add(normalizeModelId(v));
  }

  // Include existing relay list
  const relayList = String(process.env.RELAY_API_MODELS || '')
    .split(',')
    .map(s => normalizeModelId(s))
    .filter(isLikelyModelId);
  for (const id of relayList) found.add(id);

  const models = [...found].sort((a, b) => a.localeCompare(b));
  return { models, evidence };
}

function mergeRelayModels(existing, discovered) {
  const set = new Set();
  for (const id of String(existing || '').split(',').map(s => normalizeModelId(s)).filter(isLikelyModelId)) set.add(id);
  for (const id of discovered.map(normalizeModelId).filter(isLikelyModelId)) set.add(id);
  return [...set].sort((a, b) => a.localeCompare(b)).join(',');
}

function updateRelayModelsInEnvFile(envPath, discovered) {
  let envContent = '';
  try {
    if (fs.existsSync(envPath)) envContent = fs.readFileSync(envPath, 'utf-8');
  } catch {
    envContent = '';
  }

  const merged = mergeRelayModels(process.env.RELAY_API_MODELS || '', discovered);
  const line = `RELAY_API_MODELS=${merged}`;
  const regex = /^RELAY_API_MODELS=.*$/m;
  if (regex.test(envContent)) envContent = envContent.replace(regex, line);
  else envContent = envContent.trimEnd() + '\n' + line + '\n';

  fs.writeFileSync(envPath, envContent, 'utf-8');
  process.env.RELAY_API_MODELS = merged;
  return merged;
}

module.exports = {
  discoverModels,
  mergeRelayModels,
  updateRelayModelsInEnvFile,
};

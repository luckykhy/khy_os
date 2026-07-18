/**
 * Skill Registry — fetch, cache, and execute skills from the internet.
 *
 * Skills are small, self-contained scripts that can be:
 * 1. Built-in (shipped with the package)
 * 2. Community (fetched from the online registry)
 * 3. Custom (user-created in ~/.khyquant/skills/)
 *
 * Registry endpoint: GET /v1/skills → list
 *                    GET /v1/skills/:id → download skill code
 *
 * Skill format:
 * {
 *   id: 'analyze-volume',
 *   name: '量价分析',
 *   description: 'Analyze price-volume patterns',
 *   version: '1.0.0',
 *   author: 'khy-qqb',
 *   tags: ['analysis', 'volume'],
 *   code: 'module.exports = { ... }',  // the actual skill JS
 * }
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { getAppHome } = require('../utils/dataHome');

const SKILLS_DIR = path.join(getAppHome(), 'skills');
const SKILLS_CACHE_PATH = path.join(getAppHome(), 'skills_cache.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Built-in skills shipped with the package
const BUILTIN_SKILLS = [
  {
    id: 'analyze',
    name: '智能分析',
    description: 'AI analyze a stock symbol with technical indicators',
    trigger: '/analyze',
    aliases: ['/fx', '/分析'],
    builtin: true,
  },
  {
    id: 'recommend',
    name: '策略推荐',
    description: 'Recommend strategies based on market conditions',
    trigger: '/recommend',
    aliases: ['/tj', '/推荐'],
    builtin: true,
  },
  {
    id: 'explain',
    name: '概念解释',
    description: 'Explain a quant/trading concept',
    trigger: '/explain',
    aliases: ['/js', '/解释'],
    builtin: true,
  },
  {
    id: 'news',
    name: '市场资讯',
    description: 'Fetch and summarize market news',
    trigger: '/news',
    aliases: ['/zx', '/资讯'],
    builtin: true,
  },
  {
    id: 'compare',
    name: '对比分析',
    description: 'Compare multiple stocks side by side',
    trigger: '/compare',
    aliases: ['/db', '/对比'],
    builtin: true,
  },
];

let _cache = null;
let _cacheTime = 0;

/**
 * Get the registry endpoint.
 */
function getRegistryEndpoint() {
  try {
    const cloudSync = require('./cloudSync');
    return cloudSync.getEndpoint();
  } catch {
    return require('../constants/serviceDefaults').CLOUD_DEFAULT_ENDPOINT;
  }
}

/**
 * Ensure skills directory exists.
 */
function ensureSkillsDir() {
  if (!fs.existsSync(SKILLS_DIR)) {
    fs.mkdirSync(SKILLS_DIR, { recursive: true });
  }
}

/**
 * Load local skills cache.
 */
function loadCache() {
  if (_cache && Date.now() - _cacheTime < CACHE_TTL_MS) {
    return _cache;
  }
  try {
    if (fs.existsSync(SKILLS_CACHE_PATH)) {
      const data = JSON.parse(fs.readFileSync(SKILLS_CACHE_PATH, 'utf-8'));
      if (data.timestamp && Date.now() - data.timestamp < CACHE_TTL_MS) {
        _cache = data.skills || [];
        _cacheTime = data.timestamp;
        return _cache;
      }
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Save skills to local cache.
 */
function saveCache(skills) {
  _cache = skills;
  _cacheTime = Date.now();
  try {
    ensureSkillsDir();
    fs.writeFileSync(SKILLS_CACHE_PATH, JSON.stringify({
      timestamp: _cacheTime,
      skills,
    }), 'utf-8');
  } catch { /* ignore */ }
}

/**
 * Fetch skill list from remote registry.
 */
async function fetchRemoteSkills() {
  const endpoint = getRegistryEndpoint();
  return new Promise((resolve) => {
    const url = new URL(`${endpoint}/v1/skills`);
    const transport = url.protocol === 'https:' ? https : http;

    const req = transport.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: 'GET',
      headers: { 'User-Agent': 'khy-quant-cli' },
      timeout: 8000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json.skills || []);
        } catch { resolve([]); }
      });
    });

    req.on('error', () => resolve([]));
    req.on('timeout', () => { req.destroy(); resolve([]); });
    req.end();
  });
}

/**
 * Download a skill's code from registry.
 */
async function downloadSkill(skillId) {
  const endpoint = getRegistryEndpoint();
  return new Promise((resolve, reject) => {
    const url = new URL(`${endpoint}/v1/skills/${skillId}`);
    const transport = url.protocol === 'https:' ? https : http;

    const req = transport.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'GET',
      headers: { 'User-Agent': 'khy-quant-cli' },
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        try {
          const json = JSON.parse(data);
          resolve(json);
        } catch (e) { reject(e); }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

/**
 * Install a skill from the registry.
 */
async function installSkill(skillId) {
  const skill = await downloadSkill(skillId);
  if (!skill || !skill.code) {
    throw new Error(`Skill "${skillId}" not found or has no code`);
  }

  ensureSkillsDir();
  const skillPath = path.join(SKILLS_DIR, `${skillId}.js`);
  fs.writeFileSync(skillPath, skill.code, 'utf-8');

  // Save metadata
  const metaPath = path.join(SKILLS_DIR, `${skillId}.meta.json`);
  fs.writeFileSync(metaPath, JSON.stringify({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    version: skill.version,
    author: skill.author,
    trigger: skill.trigger,
    aliases: skill.aliases || [],
    installedAt: new Date().toISOString(),
  }, null, 2), 'utf-8');

  return skill;
}

/**
 * Uninstall a skill.
 */
function uninstallSkill(skillId) {
  const skillPath = path.join(SKILLS_DIR, `${skillId}.js`);
  const metaPath = path.join(SKILLS_DIR, `${skillId}.meta.json`);
  if (fs.existsSync(skillPath)) fs.unlinkSync(skillPath);
  if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
}

/**
 * Get all installed skills (local disk).
 */
function getInstalledSkills() {
  ensureSkillsDir();
  const skills = [];
  try {
    const files = fs.readdirSync(SKILLS_DIR).filter(f => f.endsWith('.meta.json'));
    for (const file of files) {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(SKILLS_DIR, file), 'utf-8'));
        skills.push(meta);
      } catch { /* skip broken meta */ }
    }
  } catch { /* ignore */ }
  return skills;
}

/**
 * Get all available skills (builtin + installed + remote cache).
 */
async function listSkills({ refresh = false } = {}) {
  const installed = getInstalledSkills();

  let remote = [];
  if (!refresh) {
    remote = loadCache() || [];
  }
  if (refresh || remote.length === 0) {
    remote = await fetchRemoteSkills();
    if (remote.length > 0) saveCache(remote);
  }

  // Merge: builtin first, then installed, then remote (not yet installed)
  const installedIds = new Set(installed.map(s => s.id));
  const builtinIds = new Set(BUILTIN_SKILLS.map(s => s.id));

  const all = [
    ...BUILTIN_SKILLS.map(s => ({ ...s, source: 'builtin' })),
    ...installed.filter(s => !builtinIds.has(s.id)).map(s => ({ ...s, source: 'installed' })),
    ...remote.filter(s => !installedIds.has(s.id) && !builtinIds.has(s.id)).map(s => ({ ...s, source: 'remote' })),
  ];

  return all;
}

/**
 * Find a skill by trigger (e.g., "/analyze") or alias.
 */
function findSkillByTrigger(trigger) {
  // Check builtin
  for (const skill of BUILTIN_SKILLS) {
    if (skill.trigger === trigger) return { ...skill, source: 'builtin' };
    if (skill.aliases && skill.aliases.includes(trigger)) return { ...skill, source: 'builtin' };
  }

  // Check installed
  const installed = getInstalledSkills();
  for (const skill of installed) {
    if (skill.trigger === trigger) return { ...skill, source: 'installed' };
    if (skill.aliases && skill.aliases.includes(trigger)) return { ...skill, source: 'installed' };
  }

  return null;
}

/**
 * Execute a skill by ID.
 * For builtin skills, generates a prompt for the AI.
 * For installed skills, runs the JS code.
 */
async function executeSkill(skillId, args, context = {}) {
  // Builtin skills generate AI prompts
  const builtin = BUILTIN_SKILLS.find(s => s.id === skillId);
  if (builtin) {
    return { type: 'ai-prompt', prompt: buildBuiltinPrompt(skillId, args) };
  }

  // Installed skill — run code.
  // Reject ids that could escape SKILLS_DIR. The id is interpolated into a file
  // path and then require()'d, so a "../"-laden or absolute id would resolve to
  // an arbitrary module (path traversal → arbitrary code execution). Installed
  // skill ids are plain slugs, so constrain to a safe charset.
  if (!/^[a-zA-Z0-9_-]+$/.test(skillId)) {
    throw new Error(`Invalid skill id: "${skillId}"`);
  }
  const skillPath = path.join(SKILLS_DIR, `${skillId}.js`);
  if (!fs.existsSync(skillPath)) {
    throw new Error(`Skill "${skillId}" not installed. Run: skill install ${skillId}`);
  }

  // Clear require cache to support hot-reload
  try { delete require.cache[require.resolve(skillPath)]; } catch { /* ignore */ }

  const skill = require(skillPath);
  if (typeof skill.handler !== 'function') {
    throw new Error(`Skill "${skillId}" has no handler function`);
  }

  return skill.handler(args, context);
}

/**
 * Build an AI prompt for builtin skills.
 */
function buildBuiltinPrompt(skillId, args) {
  const input = args.join(' ');
  switch (skillId) {
    case 'analyze':
      return `请对 ${input || '当前关注的品种'} 进行技术面分析，包括趋势、支撑阻力、成交量特征、MACD/KDJ/RSI等指标研判，并给出操作建议。`;
    case 'recommend':
      return `根据当前市场环境，推荐适合 ${input || '中短线'} 的量化策略，说明每个策略的适用场景、预期收益和风险。`;
    case 'explain':
      return `请详细解释量化交易中的概念: ${input || '夏普比率'}。包括定义、计算方式、实际应用和常见误区。`;
    case 'news':
      return `请总结 ${input || '今日A股'} 的市场资讯和重要新闻，关注政策面、资金面和热点板块。`;
    case 'compare':
      return `请对比分析 ${input || '请指定要对比的品种'}，从估值、成长性、技术面、资金面等维度进行横向比较。`;
    default:
      return input;
  }
}

// ─── ANOLISA-aligned Skill Classification ─────────────────────────

/**
 * Skill category taxonomy aligned with ANOLISA OS Skills.
 * Categories: ai, system-admin, devops, security, monitor-perf, quant, others
 */
const SKILL_CATEGORIES = {
  'ai':            { label: 'AI Tools',       description: 'AI coding agents and assistants' },
  'system-admin':  { label: 'System Admin',   description: 'Package management, storage, networking' },
  'devops':        { label: 'DevOps',         description: 'Git workflows, CI/CD, build systems' },
  'security':      { label: 'Security',       description: 'CVE queries, compliance, hardening' },
  'monitor-perf':  { label: 'Monitor & Perf', description: 'System monitoring, performance tuning' },
  'quant':         { label: 'Quantitative',   description: 'Trading analysis, strategy, market data' },
  'others':        { label: 'Others',         description: 'Utilities, format conversion, etc.' },
};

/**
 * Skill layer classification (ANOLISA-aligned).
 */
const SKILL_LAYERS = {
  core:        'Core system skill (kernel, drivers)',
  system:      'System-level skill (admin, networking)',
  application: 'Application-level skill (tools, formats)',
};

/**
 * Search skills by category, tag, or keyword.
 * @param {object} query
 * @param {string} [query.category] - Category filter
 * @param {string} [query.tag] - Tag filter
 * @param {string} [query.keyword] - Keyword search in name/description
 * @returns {Promise<Array>}
 */
async function searchSkills(query = {}) {
  const all = await listSkills();
  let results = all;

  if (query.category) {
    results = results.filter(s =>
      (s.category || 'others') === query.category ||
      (s.tags && s.tags.includes(query.category))
    );
  }

  if (query.tag) {
    results = results.filter(s => s.tags && s.tags.includes(query.tag));
  }

  if (query.keyword) {
    const kw = query.keyword.toLowerCase();
    results = results.filter(s =>
      (s.name && s.name.toLowerCase().includes(kw)) ||
      (s.description && s.description.toLowerCase().includes(kw)) ||
      (s.id && s.id.toLowerCase().includes(kw))
    );
  }

  return results;
}

/**
 * Get skills grouped by category.
 * @returns {Promise<object>}
 */
async function getSkillsByCategory() {
  const all = await listSkills();
  const grouped = {};

  for (const [key, info] of Object.entries(SKILL_CATEGORIES)) {
    grouped[key] = {
      ...info,
      skills: all.filter(s => (s.category || 'others') === key),
    };
  }

  // Put uncategorized skills into 'others'
  const categorized = new Set(Object.keys(SKILL_CATEGORIES));
  const uncategorized = all.filter(s => !categorized.has(s.category || 'others'));
  if (uncategorized.length > 0) {
    grouped.others.skills.push(...uncategorized);
  }

  return grouped;
}

module.exports = {
  BUILTIN_SKILLS,
  listSkills,
  findSkillByTrigger,
  executeSkill,
  installSkill,
  uninstallSkill,
  getInstalledSkills,
  fetchRemoteSkills,
  // ANOLISA-aligned classification
  SKILL_CATEGORIES,
  SKILL_LAYERS,
  searchSkills,
  getSkillsByCategory,
};

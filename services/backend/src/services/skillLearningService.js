/**
 * Skill Learning Service — Autonomous skill discovery and learning.
 *
 * Like Lobster: the system autonomously discovers, learns, and integrates
 * new capabilities from open-source projects and user interactions.
 *
 * Learning sources:
 * 1. Open-source projects (npm, GitHub repos with quant/trading focus)
 * 2. User interaction patterns (repeated workflows → auto-generate skill)
 * 3. Community skill registry (remote)
 * 4. Cross-project adaptation (patterns from one project applied to another)
 *
 * Growth persistence: ~/.khyquant/growth/skills_learned.json
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const { distillSkillFromSources } = require('./skills/skillSourceDistiller');
const { runThreatScan, shouldAllowLearn } = require('./skills/skillThreatScanner');

const SKILLS_DIR = path.join(os.homedir(), '.khyquant', 'skills');
const LEARNED_FILE = path.join(os.homedir(), '.khyquant', 'growth', 'skills_learned.json');
const PATTERNS_FILE = path.join(os.homedir(), '.khyquant', 'growth', 'interaction_patterns.json');

// ─── Open Source Project Discovery Sources ──────────────────────────────────

const DISCOVERY_SOURCES = [
  // npm packages with quant/trading keywords
  { type: 'npm', keywords: ['quant', 'trading', 'backtest', 'technical-analysis', 'stock-market'] },
  // GitHub topics
  { type: 'github', topics: ['quantitative-finance', 'algorithmic-trading', 'technical-indicators', 'stock-analysis'] },
  // Known high-quality projects to learn from
  { type: 'curated', projects: [
    { name: 'technicalindicators', source: 'npm', description: 'Technical indicators (RSI, MACD, Bollinger, etc.)' },
    { name: 'tulind', source: 'npm', description: 'Technical analysis indicator library' },
    { name: 'ta-lib', source: 'npm', description: 'TA-Lib wrapper for Node.js' },
    { name: 'backtrader', source: 'pip', description: 'Python backtesting framework' },
    { name: 'zipline', source: 'pip', description: 'Algorithmic trading library' },
    { name: 'ccxt', source: 'npm', description: 'Crypto exchange trading library' },
    { name: 'pandas-ta', source: 'pip', description: 'Technical analysis for pandas' },
    { name: 'quantlib', source: 'pip', description: 'Quantitative finance library' },
  ]},
];

// ─── Skill Templates ────────────────────────────────────────────────────────

const SKILL_TEMPLATES = {
  indicator: {
    template: `/**
 * Skill: {name}
 * Source: {source}
 * Learned: {date}
 */
module.exports = {
  id: '{id}',
  name: '{name}',
  description: '{description}',
  category: 'indicator',
  execute: async function(klines, params) {
    {implementation}
  },
};`,
  },

  strategy: {
    template: `/**
 * Skill: {name}
 * Source: {source}
 * Learned: {date}
 */
module.exports = {
  id: '{id}',
  name: '{name}',
  description: '{description}',
  category: 'strategy',
  execute: async function(data, options) {
    {implementation}
  },
};`,
  },

  workflow: {
    template: `/**
 * Skill: {name}
 * Auto-learned from user interaction pattern
 * Learned: {date}
 */
module.exports = {
  id: '{id}',
  name: '{name}',
  description: '{description}',
  category: 'workflow',
  steps: {steps},
  execute: async function(context) {
    const results = [];
    for (const step of this.steps) {
      results.push({ step: step.command, status: 'pending' });
    }
    return results;
  },
};`,
  },
};

// ─── Interaction Pattern Learning ───────────────────────────────────────────

/**
 * Record a command sequence (for pattern learning).
 * When users repeatedly perform the same sequence, auto-generate a workflow skill.
 */
function recordCommandSequence(commands) {
  try {
    const patterns = _loadPatterns();
    const key = commands.join(' → ');

    if (!patterns.sequences) patterns.sequences = {};
    if (!patterns.sequences[key]) {
      patterns.sequences[key] = { commands, count: 0, firstSeen: new Date().toISOString() };
    }
    patterns.sequences[key].count++;
    patterns.sequences[key].lastSeen = new Date().toISOString();

    // Auto-learn: if a sequence appears 3+ times, suggest creating a skill
    if (patterns.sequences[key].count === 3 && !patterns.sequences[key].learned) {
      patterns.sequences[key].suggestSkill = true;
    }

    _savePatterns(patterns);

    // Return suggestion if available
    if (patterns.sequences[key].suggestSkill && !patterns.sequences[key].learned) {
      return {
        suggest: true,
        sequence: commands,
        count: patterns.sequences[key].count,
      };
    }
    return null;
  } catch { return null; }
}

/**
 * Auto-create a workflow skill from a repeated command sequence.
 */
function learnWorkflow(name, commands, description) {
  const id = `workflow-${crypto.randomUUID().slice(0, 8)}`;
  const steps = commands.map(cmd => ({ command: cmd }));

  const code = SKILL_TEMPLATES.workflow.template
    .replace(/{id}/g, id)
    .replace(/{name}/g, name)
    .replace(/{description}/g, description || `Automated workflow: ${commands.join(' → ')}`)
    .replace(/{date}/g, new Date().toISOString())
    .replace(/{steps}/g, JSON.stringify(steps, null, 4));

  // Save to skills directory
  fs.mkdirSync(SKILLS_DIR, { recursive: true });
  const filePath = path.join(SKILLS_DIR, `${id}.js`);
  fs.writeFileSync(filePath, code);

  // Record in learned skills
  _recordLearnedSkill({
    id,
    name,
    description: description || `Workflow: ${commands.join(' → ')}`,
    source: 'user_interaction',
    category: 'workflow',
    learnedAt: new Date().toISOString(),
    filePath,
  });

  // Mark pattern as learned
  const patterns = _loadPatterns();
  const key = commands.join(' → ');
  if (patterns.sequences && patterns.sequences[key]) {
    patterns.sequences[key].learned = true;
    patterns.sequences[key].skillId = id;
  }
  _savePatterns(patterns);

  return { id, name, filePath };
}

// ─── Open Source Project Skill Extraction ───────────────────────────────────

/**
 * Discover skills from an npm package (read its exports and adapt).
 */
async function discoverFromNpm(packageName) {
  const results = [];

  // Security: validate package name format (prevent require injection)
  if (!packageName || !/^[@a-z0-9][\w.\-/]*$/i.test(packageName)) {
    return [{ name: packageName, source: 'npm', type: 'invalid', adaptable: false, error: 'Invalid package name' }];
  }

  try {
    // Try to require if already installed
    const pkg = require(packageName);
    const exports = Object.keys(pkg);

    for (const exportName of exports) {
      if (typeof pkg[exportName] === 'function') {
        results.push({
          name: exportName,
          source: `npm:${packageName}`,
          type: 'function',
          adaptable: true,
        });
      }
    }
  } catch {
    // Package not installed — record as discoverable
    results.push({
      name: packageName,
      source: 'npm',
      type: 'package',
      adaptable: false,
      installCmd: `npm install ${packageName}`,
    });
  }

  return results;
}

/**
 * Learn a specific function from an npm package as a skill.
 */
function learnFromPackage(packageName, functionName, skillName, description) {
  const id = `pkg-${crypto.randomUUID().slice(0, 8)}`;

  const implementation = `
    const pkg = require('${packageName}');
    if (typeof pkg.${functionName} !== 'function') {
      throw new Error('Function ${functionName} not found in ${packageName}');
    }
    return pkg.${functionName}(klines, params);
  `.trim();

  const code = SKILL_TEMPLATES.indicator.template
    .replace(/{id}/g, id)
    .replace(/{name}/g, skillName || functionName)
    .replace(/{description}/g, description || `Adapted from ${packageName}.${functionName}`)
    .replace(/{source}/g, `npm:${packageName}`)
    .replace(/{date}/g, new Date().toISOString())
    .replace(/{implementation}/g, implementation);

  fs.mkdirSync(SKILLS_DIR, { recursive: true });
  const filePath = path.join(SKILLS_DIR, `${id}.js`);
  fs.writeFileSync(filePath, code);

  _recordLearnedSkill({
    id,
    name: skillName || functionName,
    description: description || `From ${packageName}`,
    source: `npm:${packageName}`,
    function: functionName,
    category: 'indicator',
    learnedAt: new Date().toISOString(),
    filePath,
  });

  return { id, name: skillName || functionName, filePath };
}

/**
 * Learn from a GitHub repository (clone and extract patterns).
 */
async function learnFromGitHub(repoUrl, options = {}) {
  // Record intent to learn (actual cloning requires git)
  const repoName = repoUrl.split('/').slice(-2).join('/').replace('.git', '');

  _recordLearnedSkill({
    id: `github-${crypto.randomUUID().slice(0, 8)}`,
    name: `Patterns from ${repoName}`,
    description: `Learning source: ${repoUrl}`,
    source: `github:${repoName}`,
    category: 'reference',
    learnedAt: new Date().toISOString(),
    status: 'pending_clone',
    repoUrl,
  });

  return {
    status: 'queued',
    repo: repoName,
    message: `将在下次联网时从 ${repoName} 学习模式`,
  };
}

// ─── /learn from a directory or a web page (Hermes v0.18.0 /learn) ────────────
//
// Hermes `/learn` gathers whatever the user pointed at (a directory of code, an
// API-doc URL, a workflow) and distills it into a reusable skill. Khy-OS keeps
// its deterministic engine model: the IO (fs read / HTTP fetch) lives here; the
// distillation is done by the pure leaf `skillSourceDistiller`, which invents
// nothing beyond what the source states. Gated by KHY_LEARN_FROM_SOURCE.

const _LEARN_SOURCE_FLAG = 'KHY_LEARN_FROM_SOURCE';
const _LEARN_TEXT_EXTS = new Set([
  '.md', '.markdown', '.txt', '.rst', '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs',
  '.py', '.json', '.sh', '.bash', '.zsh', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.go', '.rs',
]);
const _LEARN_MAX_FILES = 40;
const _LEARN_MAX_BYTES_PER_FILE = 24 * 1024;
const _LEARN_MAX_URL_BYTES = 200 * 1024;

/**
 * Gate check for the source-learning capability. Default-on; fail-soft to on if
 * the flag registry is unavailable so behaviour matches the registry default.
 */
function _learnFromSourceEnabled(env = process.env) {
  try {
    const { isFlagEnabled } = require('./flagRegistry');
    return isFlagEnabled(_LEARN_SOURCE_FLAG, env);
  } catch {
    const raw = env && env[_LEARN_SOURCE_FLAG];
    if (raw == null || String(raw).trim() === '') return true;
    const v = String(raw).trim().toLowerCase();
    return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
  }
}

function _disabledResult() {
  return {
    ok: false,
    disabled: true,
    message: `已禁用(${_LEARN_SOURCE_FLAG}=off);开启后可从目录/网页学习技能`,
  };
}

const _THREAT_SCAN_FLAG = 'KHY_LEARN_SOURCE_THREAT_SCAN';

/**
 * Gate check for the pre-persist threat scan (child of KHY_LEARN_FROM_SOURCE).
 * Default-on; fail-soft to on so behaviour matches the registry default when the
 * flag registry is unavailable.
 */
function _threatScanEnabled(env = process.env) {
  try {
    const { isFlagEnabled } = require('./flagRegistry');
    return isFlagEnabled(_THREAT_SCAN_FLAG, env);
  } catch {
    const raw = env && env[_THREAT_SCAN_FLAG];
    if (raw == null || String(raw).trim() === '') return true;
    const v = String(raw).trim().toLowerCase();
    return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
  }
}

/**
 * Screen distilled source text for threats BEFORE persisting it as a skill.
 * Returns { block:true, result } when a dangerous source must be refused (caller
 * returns `result` directly), or { block:false, scan } to continue persisting
 * (scan may still carry caution-level warnings). When the gate is off, returns
 * { block:false, scan:null } — byte-for-byte the pre-scan behaviour.
 *
 * @param {string} combinedText  the raw source text about to become a skill.
 * @param {string} sourceRef     e.g. `directory:/x` or `url:https://…`.
 * @param {{env?:object, force?:boolean}} options
 */
function _screenSourceBeforePersist(combinedText, sourceRef, options = {}) {
  if (!_threatScanEnabled(options.env)) return { block: false, scan: null };
  const scan = runThreatScan(combinedText, { sourceRef });
  const decision = shouldAllowLearn(scan, { force: !!options.force });
  if (!decision.allow) {
    return {
      block: true,
      result: {
        ok: false,
        error: `威胁扫描已拦截该来源: ${decision.reason}`,
        threat: { verdict: scan.verdict, counts: scan.counts, findings: scan.findings, summary: scan.summary },
      },
    };
  }
  return { block: false, scan };
}

/**
 * Read a directory into bounded {name,text} documents (text files only).
 */
function _gatherDirectoryDocuments(dirPath) {
  const docs = [];
  const root = path.resolve(dirPath);
  const walk = (dir) => {
    if (docs.length >= _LEARN_MAX_FILES) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (docs.length >= _LEARN_MAX_FILES) return;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules' || ent.name === '.git' || ent.name.startsWith('.')) continue;
        walk(full);
      } else if (ent.isFile()) {
        const ext = path.extname(ent.name).toLowerCase();
        if (!_LEARN_TEXT_EXTS.has(ext)) continue;
        try {
          const buf = fs.readFileSync(full);
          const text = buf.slice(0, _LEARN_MAX_BYTES_PER_FILE).toString('utf-8');
          if (text.trim()) docs.push({ name: path.relative(root, full) || ent.name, text });
        } catch { /* skip unreadable */ }
      }
    }
  };
  walk(root);
  return docs;
}

/**
 * Persist a distilled skill descriptor as a SKILL.md file + registry record.
 */
function _persistDistilledSkill(distilled, source) {
  const id = `learn-${crypto.randomUUID().slice(0, 8)}`;
  let filePath;
  try {
    fs.mkdirSync(SKILLS_DIR, { recursive: true });
    filePath = path.join(SKILLS_DIR, `${id}.md`);
    fs.writeFileSync(filePath, distilled.body || '');
  } catch { filePath = undefined; }

  _recordLearnedSkill({
    id,
    name: distilled.name,
    description: distilled.description,
    source,
    category: distilled.category || 'reference',
    learnedAt: new Date().toISOString(),
    filePath,
    commands: distilled.commands || [],
    headings: distilled.headings || [],
  });

  return {
    ok: true,
    id,
    name: distilled.name,
    description: distilled.description,
    filePath,
    commandCount: (distilled.commands || []).length,
    headingCount: (distilled.headings || []).length,
    warnings: distilled.warnings || [],
  };
}

/**
 * Learn a reusable skill from a local directory of code/docs.
 */
function learnFromDirectory(dirPath, options = {}) {
  if (!_learnFromSourceEnabled(options.env)) return _disabledResult();
  try {
    if (!dirPath || typeof dirPath !== 'string') {
      return { ok: false, error: '请提供目录路径' };
    }
    let stat;
    try { stat = fs.statSync(dirPath); } catch { return { ok: false, error: `目录不存在: ${dirPath}` }; }
    if (!stat.isDirectory()) return { ok: false, error: `不是目录: ${dirPath}` };

    const documents = _gatherDirectoryDocuments(dirPath);
    if (!documents.length) return { ok: false, error: '目录中未找到可读的文本源文件' };

    const distilled = distillSkillFromSources({ sourceType: 'directory', sourceRef: dirPath, documents });
    if (!distilled.ok) return { ok: false, error: `提炼失败: ${distilled.reason || 'unknown'}` };

    const combined = documents.map((d) => (d && d.text) || '').join('\n');
    const screen = _screenSourceBeforePersist(combined, `directory:${dirPath}`, options);
    if (screen.block) return screen.result;

    const persisted = _persistDistilledSkill(distilled, `directory:${dirPath}`);
    if (persisted.ok && screen.scan && screen.scan.verdict !== 'safe') {
      persisted.threat = { verdict: screen.scan.verdict, counts: screen.scan.counts, summary: screen.scan.summary };
    }
    return persisted;
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/**
 * Minimal fail-soft HTTP(S) GET → plain text. Overridable via options.fetchText
 * for deterministic testing (no network).
 */
function _defaultFetchText(url) {
  return new Promise((resolve) => {
    let client;
    try { client = url.startsWith('https:') ? require('https') : require('http'); } catch { return resolve(''); }
    try {
      const req = client.get(url, { timeout: 15000 }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(_defaultFetchText(new URL(res.headers.location, url).toString()));
        }
        let data = '';
        res.setEncoding('utf-8');
        res.on('data', (chunk) => {
          data += chunk;
          if (data.length > _LEARN_MAX_URL_BYTES) { data = data.slice(0, _LEARN_MAX_URL_BYTES); res.destroy(); }
        });
        res.on('end', () => resolve(data));
        res.on('error', () => resolve(data));
      });
      req.on('timeout', () => { try { req.destroy(); } catch { /* noop */ } resolve(''); });
      req.on('error', () => resolve(''));
    } catch { resolve(''); }
  });
}

/**
 * Strip HTML to readable text (fail-soft, bounded). Pure string transform.
 */
function _htmlToText(html) {
  try {
    return String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<\/(p|div|li|h[1-6]|section|article|br)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, _LEARN_MAX_URL_BYTES);
  } catch { return ''; }
}

/**
 * Learn a reusable skill from a web page (API docs, README on the web, etc.).
 */
async function learnFromUrl(url, options = {}) {
  if (!_learnFromSourceEnabled(options.env)) return _disabledResult();
  try {
    if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      return { ok: false, error: '请提供 http(s) 网址' };
    }
    const fetchText = typeof options.fetchText === 'function' ? options.fetchText : _defaultFetchText;
    const raw = await fetchText(url);
    const text = _htmlToText(raw);
    if (!text || !text.trim()) return { ok: false, error: `未能从网址获取内容: ${url}` };

    const distilled = distillSkillFromSources({
      sourceType: 'url', sourceRef: url, documents: [{ name: url, text }],
    });
    if (!distilled.ok) return { ok: false, error: `提炼失败: ${distilled.reason || 'unknown'}` };

    const screen = _screenSourceBeforePersist(text, `url:${url}`, options);
    if (screen.block) return screen.result;

    const persisted = _persistDistilledSkill(distilled, `url:${url}`);
    if (persisted.ok && screen.scan && screen.scan.verdict !== 'safe') {
      persisted.threat = { verdict: screen.scan.verdict, counts: screen.scan.counts, summary: screen.scan.summary };
    }
    return persisted;
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// ─── Skill Adaptation (Cross-Project) ───────────────────────────────────────

/**
 * Adapt a pattern from one context to another.
 * E.g., a risk calculation from crypto → apply to A-shares.
 */
function adaptSkill(sourceSkillId, targetContext, adaptations) {
  const learned = _loadLearnedSkills();
  const source = learned.find(s => s.id === sourceSkillId);
  if (!source) return { success: false, error: 'Source skill not found' };

  const newId = `adapted-${crypto.randomUUID().slice(0, 8)}`;
  const adapted = {
    ...source,
    id: newId,
    name: `${source.name} (${targetContext})`,
    description: `Adapted from ${source.name} for ${targetContext}`,
    adaptedFrom: sourceSkillId,
    adaptations,
    category: source.category,
    learnedAt: new Date().toISOString(),
  };

  _recordLearnedSkill(adapted);
  return { success: true, skill: adapted };
}

// ─── Autonomous Learning Loop ───────────────────────────────────────────────

/**
 * Get suggested skills to learn based on user behavior.
 * Called periodically to suggest new learning opportunities.
 */
function getSuggestedLearning() {
  const suggestions = [];

  try {
    const growthService = require('./growthService');
    const prefs = growthService.loadComponent('user_preferences.json');
    const knowledge = growthService.loadComponent('knowledge.json');

    // Suggest based on frequently used commands
    const freq = prefs.frequentCommands || [];
    if (freq.includes('backtest') && !_hasSkillCategory('strategy')) {
      suggestions.push({
        type: 'package',
        name: 'technicalindicators',
        reason: '你经常使用回测功能，安装技术指标库可获得更多策略',
        action: 'skill learn npm technicalindicators',
      });
    }

    // Suggest based on knowledge level
    if (knowledge.level === 'intermediate' || knowledge.level === 'advanced') {
      if (!_hasSkillCategory('risk')) {
        suggestions.push({
          type: 'skill',
          name: 'portfolio-risk',
          reason: '你已达到中级水平，可以学习组合风险管理技能',
          action: 'skill learn github quantlib/risk-metrics',
        });
      }
    }

    // Suggest from repeated patterns
    const patterns = _loadPatterns();
    if (patterns.sequences) {
      for (const [key, seq] of Object.entries(patterns.sequences)) {
        if (seq.suggestSkill && !seq.learned) {
          suggestions.push({
            type: 'workflow',
            name: `自动流程: ${seq.commands.slice(0, 2).join('→')}...`,
            reason: `你已重复执行此流程 ${seq.count} 次，可以自动化`,
            action: `skill learn workflow "${key}"`,
            sequence: seq.commands,
          });
        }
      }
    }
  } catch { /* best effort */ }

  return suggestions;
}

/**
 * Get all learned skills.
 */
function getLearnedSkills() {
  return _loadLearnedSkills();
}

// ─── Journey (unified skills + memories timeline) ────────────────────────────
// Ported concept from Hermes Agent v0.18.0 /journey. Aggregates the two IO
// sources (learned-skills store + memory dir) and defers the merge/sort/summary
// to the pure `journeyTimeline` leaf. Gated by KHY_SKILL_JOURNEY (default-on).

const _JOURNEY_FLAG = 'KHY_SKILL_JOURNEY';

function _skillJourneyEnabled(env = process.env) {
  try {
    const { isFlagEnabled } = require('./flagRegistry');
    return isFlagEnabled(_JOURNEY_FLAG, env);
  } catch {
    const raw = env && env[_JOURNEY_FLAG];
    if (raw == null || String(raw).trim() === '') return true;
    const v = String(raw).trim().toLowerCase();
    return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
  }
}

/**
 * Gather memories from the memory dir, fail-soft. Returns records shaped for the
 * journey leaf ({ filename, name, description, type, modifiedAt }).
 */
function _gatherJourneyMemories() {
  try {
    const memdir = require('../memdir');
    if (!memdir || typeof memdir.listMemories !== 'function') return [];
    const list = memdir.listMemories() || [];
    return list.map((m) => {
      const fm = (m && m.frontmatter) || {};
      const meta = (fm && fm.metadata) || {};
      return {
        filename: m && m.filename,
        name: fm.name,
        description: fm.description,
        type: meta.type,
        modifiedAt: m && m.modifiedAt,
      };
    });
  } catch {
    return [];
  }
}

/**
 * Build the unified journey timeline of learned skills + memories.
 * Gate-off → inert disabled result. Both IO sources are fail-soft.
 * @param {{ env?: Object }} [options]
 * @returns {{ ok, entries?, summary?, disabled?, message? }}
 */
function getSkillJourney(options = {}) {
  if (!_skillJourneyEnabled(options.env)) {
    return {
      ok: false,
      disabled: true,
      message: `已禁用(${_JOURNEY_FLAG}=off);开启后可查看技能与记忆的统一时间线`,
    };
  }
  let skills = [];
  try {
    skills = getLearnedSkills() || [];
  } catch {
    skills = [];
  }
  const memories = _gatherJourneyMemories();
  const { buildJourneyTimeline } = require('./skills/journeyTimeline');
  return buildJourneyTimeline({ skills, memories });
}

/**
 * Get learning statistics.
 */
function getLearningStats() {
  const skills = _loadLearnedSkills();
  const patterns = _loadPatterns();

  return {
    totalSkills: skills.length,
    byCategory: _groupBy(skills, 'category'),
    bySource: _groupBy(skills, 'source'),
    patternCount: Object.keys(patterns.sequences || {}).length,
    suggestedWorkflows: Object.values(patterns.sequences || {}).filter(s => s.suggestSkill && !s.learned).length,
    discoverySources: DISCOVERY_SOURCES.length,
  };
}

/**
 * Remove a learned skill.
 */
function forgetSkill(skillId) {
  const skills = _loadLearnedSkills();
  const idx = skills.findIndex(s => s.id === skillId);
  if (idx === -1) return false;

  const skill = skills[idx];
  // Remove file if exists
  if (skill.filePath && fs.existsSync(skill.filePath)) {
    fs.unlinkSync(skill.filePath);
  }

  skills.splice(idx, 1);
  _saveLearnedSkills(skills);
  return true;
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

function _loadLearnedSkills() {
  try {
    if (fs.existsSync(LEARNED_FILE)) {
      return JSON.parse(fs.readFileSync(LEARNED_FILE, 'utf-8'));
    }
  } catch { /* ignore */ }
  return [];
}

function _saveLearnedSkills(skills) {
  try {
    const dir = path.dirname(LEARNED_FILE);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(LEARNED_FILE, JSON.stringify(skills, null, 2));
  } catch { /* best effort */ }
}

function _recordLearnedSkill(skill) {
  const skills = _loadLearnedSkills();
  // Avoid duplicates
  if (!skills.find(s => s.id === skill.id)) {
    skills.push(skill);
    _saveLearnedSkills(skills);
  }
}

function _loadPatterns() {
  try {
    if (fs.existsSync(PATTERNS_FILE)) {
      return JSON.parse(fs.readFileSync(PATTERNS_FILE, 'utf-8'));
    }
  } catch { /* ignore */ }
  return { sequences: {} };
}

function _savePatterns(patterns) {
  try {
    const dir = path.dirname(PATTERNS_FILE);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PATTERNS_FILE, JSON.stringify(patterns, null, 2));
  } catch { /* best effort */ }
}

function _hasSkillCategory(category) {
  const skills = _loadLearnedSkills();
  return skills.some(s => s.category === category);
}

function _groupBy(arr, key) {
  const result = {};
  for (const item of arr) {
    const k = item[key] || 'unknown';
    result[k] = (result[k] || 0) + 1;
  }
  return result;
}

module.exports = {
  // Pattern learning
  recordCommandSequence,
  learnWorkflow,

  // External source learning
  discoverFromNpm,
  learnFromPackage,
  learnFromGitHub,
  learnFromDirectory,
  learnFromUrl,

  // Adaptation
  adaptSkill,

  // Autonomous suggestions
  getSuggestedLearning,

  // Registry
  getLearnedSkills,
  getLearningStats,
  forgetSkill,

  // Journey (unified skills + memories timeline)
  getSkillJourney,

  // Constants
  DISCOVERY_SOURCES,
};

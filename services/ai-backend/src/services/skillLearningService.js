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

  // Adaptation
  adaptSkill,

  // Autonomous suggestions
  getSuggestedLearning,

  // Registry
  getLearnedSkills,
  getLearningStats,
  forgetSkill,

  // Constants
  DISCOVERY_SOURCES,
};

'use strict';

/**
 * Declarative, zero-I/O registry for rule files created by other coding agents.
 * The shell supplies home/project paths and reads files; this module only maps
 * enabled ecosystems to deterministic source descriptors.
 */

const _join = require('../utils/pathJoinSafe');

const _FALSY = new Set(['0', 'false', 'off', 'no']);
const ECO_MAX_FILE_CHARS = 4000;
const ECO_MAX_TOTAL_CHARS = 8000;
const ECO_MAX_FILES_PER_DIR = 12;

const ECOSYSTEMS = Object.freeze(
  [
    {
      // Project-level AGENTS.md is already handled by prompts.js compatibility discovery.
      id: 'codex',
      label: 'Codex CLI (~/.codex/AGENTS.md)',
      gate: 'KHY_RULES_ECO_CODEX',
      evidence: 'doc',
      sources: [{ base: 'home', segs: ['.codex', 'AGENTS.md'], mode: 'file', kind: 'user' }],
    },
    {
      id: 'cursor',
      label: 'Cursor',
      gate: 'KHY_RULES_ECO_CURSOR',
      evidence: 'doc',
      sources: [
        {
          base: 'project',
          segs: ['.cursor', 'rules'],
          mode: 'dir',
          exts: ['.mdc', '.md'],
          kind: 'rules',
          scoped: true,
        },
        { base: 'project', segs: ['.cursorrules'], mode: 'file', kind: 'legacy' },
      ],
    },
    {
      id: 'copilot',
      label: 'GitHub Copilot',
      gate: 'KHY_RULES_ECO_COPILOT',
      evidence: 'doc',
      sources: [
        { base: 'project', segs: ['.github', 'copilot-instructions.md'], mode: 'file', kind: 'repo' },
        {
          base: 'project',
          segs: ['.github', 'instructions'],
          mode: 'dir',
          exts: ['.md'],
          kind: 'instructions',
          scoped: true,
        },
      ],
    },
    {
      id: 'windsurf',
      label: 'Windsurf (Codeium)',
      gate: 'KHY_RULES_ECO_WINDSURF',
      evidence: 'doc',
      sources: [
        {
          base: 'project',
          segs: ['.windsurf', 'rules'],
          mode: 'dir',
          exts: ['.md'],
          kind: 'rules',
          scoped: true,
        },
        { base: 'project', segs: ['.windsurfrules'], mode: 'file', kind: 'legacy' },
        { base: 'home', segs: ['.codeium', 'windsurf', 'memories', 'global_rules.md'], mode: 'file', kind: 'user' },
      ],
    },
    {
      id: 'cline',
      label: 'Cline',
      gate: 'KHY_RULES_ECO_CLINE',
      evidence: 'doc',
      sources: [
        { base: 'project', segs: ['.clinerules'], mode: 'file', kind: 'file' },
        { base: 'project', segs: ['.clinerules'], mode: 'dir', exts: ['.md'], kind: 'dir' },
      ],
    },
    {
      id: 'roo',
      label: 'Roo Code',
      gate: 'KHY_RULES_ECO_ROO',
      evidence: 'doc',
      sources: [
        { base: 'project', segs: ['.roo', 'rules'], mode: 'dir', exts: ['.md'], kind: 'rules' },
        { base: 'project', segs: ['.roorules'], mode: 'file', kind: 'legacy' },
      ],
    },
    {
      id: 'gemini',
      label: 'Gemini CLI',
      gate: 'KHY_RULES_ECO_GEMINI',
      evidence: 'doc',
      sources: [
        { base: 'project', segs: ['GEMINI.md'], mode: 'file', kind: 'project' },
        { base: 'home', segs: ['.gemini', 'GEMINI.md'], mode: 'file', kind: 'user' },
      ],
    },
    {
      id: 'qwen',
      label: 'Qwen Code',
      gate: 'KHY_RULES_ECO_QWEN',
      evidence: 'doc',
      sources: [
        { base: 'project', segs: ['QWEN.md'], mode: 'file', kind: 'project' },
        { base: 'home', segs: ['.qwen', 'QWEN.md'], mode: 'file', kind: 'user' },
      ],
    },
    {
      id: 'kiro',
      label: 'AWS Kiro',
      gate: 'KHY_RULES_ECO_KIRO',
      evidence: 'doc',
      sources: [
        {
          base: 'project',
          segs: ['.kiro', 'steering'],
          mode: 'dir',
          exts: ['.md'],
          kind: 'steering',
          scoped: true,
        },
      ],
    },
    {
      id: 'amazonq',
      label: 'Amazon Q Developer',
      gate: 'KHY_RULES_ECO_AMAZONQ',
      evidence: 'doc',
      sources: [{ base: 'project', segs: ['.amazonq', 'rules'], mode: 'dir', exts: ['.md'], kind: 'rules' }],
    },
    {
      id: 'continue',
      label: 'Continue',
      gate: 'KHY_RULES_ECO_CONTINUE',
      evidence: 'doc',
      sources: [
        {
          base: 'project',
          segs: ['.continue', 'rules'],
          mode: 'dir',
          exts: ['.md'],
          kind: 'rules',
          scoped: true,
        },
      ],
    },
    {
      id: 'junie',
      label: 'JetBrains Junie',
      gate: 'KHY_RULES_ECO_JUNIE',
      evidence: 'doc',
      sources: [{ base: 'project', segs: ['.junie', 'guidelines.md'], mode: 'file', kind: 'guidelines' }],
    },
    {
      id: 'trae',
      label: 'Trae',
      gate: 'KHY_RULES_ECO_TRAE',
      evidence: 'doc',
      sources: [{ base: 'project', segs: ['.trae', 'rules', 'project_rules.md'], mode: 'file', kind: 'project' }],
    },
    {
      id: 'zed',
      label: 'Zed / opencode (.rules)',
      gate: 'KHY_RULES_ECO_ZED',
      evidence: 'doc',
      sources: [{ base: 'project', segs: ['.rules'], mode: 'file', kind: 'project' }],
    },
    {
      id: 'aider',
      label: 'Aider (CONVENTIONS.md)',
      gate: 'KHY_RULES_ECO_AIDER',
      evidence: 'doc',
      sources: [{ base: 'project', segs: ['CONVENTIONS.md'], mode: 'file', kind: 'conventions' }],
    },
    {
      id: 'firebase-studio',
      label: 'Firebase Studio (IDX)',
      gate: 'KHY_RULES_ECO_FIREBASE_STUDIO',
      evidence: 'doc',
      sources: [{ base: 'project', segs: ['.idx', 'airules.md'], mode: 'file', kind: 'airules' }],
    },
  ].map((ecosystem) =>
    Object.freeze({ ...ecosystem, sources: Object.freeze(ecosystem.sources.map((source) => Object.freeze(source))) })
  )
);

const EXCLUDED = Object.freeze({
  khy: 'khy.md / KHY.md / .khy/rules are handled by native discovery',
  'agent-md-singular': 'agent.md / AGENT.md are khy write targets, not third-party instruction sources',
  'claude-md': 'CLAUDE.md / .claude/CLAUDE.md are handled by prompts.js compatibility discovery',
  'agents-md-root': '<project>/AGENTS.md and ~/AGENTS.md are handled by prompts.js compatibility discovery',
  'github-prompts': '.github/prompts/*.prompt.md are on-demand commands, not resident rules',
  'claude-commands': '.claude/commands/*.md are handled by ccCommandBridge',
  'claude-skills': '.claude/skills/**/SKILL.md are handled by ccSkillBridge',
  warp: 'Warp rules are stored in application data, not readable rule files',
});

function isInstructionEcosystemEnabled(env = process.env) {
  const values = env || {};
  try {
    const registry = require('./flagRegistry');
    if (
      registry &&
      typeof registry.isRegistryEnabled === 'function' &&
      registry.isRegistryEnabled(values) &&
      typeof registry.isFlagEnabled === 'function'
    ) {
      return registry.isFlagEnabled('KHY_RULES_ECOSYSTEM', values);
    }
  } catch {
    // Use local canonical fallback when the registry is unavailable.
  }
  const raw = values.KHY_RULES_ECOSYSTEM;
  return !(raw !== undefined && raw !== null && _FALSY.has(String(raw).trim().toLowerCase()));
}

function isEcosystemEnabled(id, env = process.env) {
  try {
    if (!isInstructionEcosystemEnabled(env)) {
      return false;
    }
    const ecosystem = ECOSYSTEMS.find((item) => item.id === String(id || '').trim());
    if (!ecosystem) {
      return false;
    }
    const values = env || {};
    try {
      const registry = require('./flagRegistry');
      if (
        registry &&
        typeof registry.isRegistryEnabled === 'function' &&
        registry.isRegistryEnabled(values) &&
        typeof registry.isFlagEnabled === 'function'
      ) {
        return registry.isFlagEnabled(ecosystem.gate, values);
      }
    } catch {
      // Use local canonical fallback when the registry is unavailable.
    }
    const raw = values[ecosystem.gate];
    return !(raw !== undefined && raw !== null && _FALSY.has(String(raw).trim().toLowerCase()));
  } catch {
    return false;
  }
}

function getEcosystems(env = process.env) {
  try {
    return isInstructionEcosystemEnabled(env) ? ECOSYSTEMS.filter((item) => isEcosystemEnabled(item.id, env)) : [];
  } catch {
    return [];
  }
}

function resolveBase(base, { homedir, projectDir } = {}) {
  if (base === 'home') {
    return homedir ? String(homedir) : '';
  }
  if (base === 'project') {
    return projectDir ? String(projectDir) : '';
  }
  return '';
}

function instructionEcosystemSources({ homedir, projectDir, env = process.env } = {}) {
  try {
    const sources = [];
    const seen = new Set();
    for (const ecosystem of getEcosystems(env)) {
      for (const source of ecosystem.sources) {
        const base = resolveBase(source.base, { homedir, projectDir });
        const fullPath = base && _join(base, ...source.segs);
        const key = `${fullPath}\u0000${source.mode}`;
        if (!fullPath || seen.has(key)) {
          continue;
        }
        seen.add(key);
        sources.push({
          ecosystem: ecosystem.id,
          label: ecosystem.label,
          path: fullPath,
          kind: source.kind,
          mode: source.mode === 'dir' ? 'dir' : 'file',
          exts: Array.isArray(source.exts) ? source.exts.slice() : ['.md'],
          scoped: source.scoped === true,
          evidence: ecosystem.evidence,
          maxFiles: ECO_MAX_FILES_PER_DIR,
        });
      }
    }
    return sources;
  } catch {
    return [];
  }
}

function parseRuleFrontmatter(text) {
  try {
    if (typeof text !== 'string' || !text) {
      return {};
    }
    const match = /^\uFEFF?\s*---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
    if (!match) {
      return {};
    }
    const meta = {};
    for (const line of match[1].split(/\r?\n/)) {
      const pair = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line.trim());
      if (!pair) {
        continue;
      }
      const key = pair[1];
      let value = pair[2].trim();
      if (
        value.length >= 2 &&
        ((value[0] === '"' && value[value.length - 1] === '"') ||
          (value[0] === "'" && value[value.length - 1] === "'"))
      ) {
        value = value.slice(1, -1);
      }
      if (key === 'alwaysApply') {
        meta.alwaysApply = /^(true|yes|1)$/i.test(value);
      } else if (['applyTo', 'globs', 'inclusion', 'description'].includes(key)) {
        meta[key] = value;
      }
    }
    return meta;
  } catch {
    return {};
  }
}

const _UNIVERSAL_GLOB = new Set(['**', '**/*', '*', '**/**', '.', './**']);

function isAlwaysOnRule(meta) {
  try {
    const value = meta && typeof meta === 'object' ? meta : {};
    if (typeof value.alwaysApply === 'boolean') {
      return value.alwaysApply;
    }
    if (typeof value.inclusion === 'string' && value.inclusion) {
      return value.inclusion.trim().toLowerCase() === 'always';
    }
    for (const key of ['applyTo', 'globs']) {
      const raw = value[key];
      if (typeof raw === 'string' && raw.trim()) {
        const globs = raw
          .replace(/^\[|\]$/g, '')
          .split(',')
          .map((item) => item.trim().replace(/^["']|["']$/g, ''))
          .filter(Boolean);
        return globs.some((glob) => _UNIVERSAL_GLOB.has(glob));
      }
    }
    return true;
  } catch {
    return false;
  }
}

function evaluateScopedRule(text) {
  const meta = parseRuleFrontmatter(text);
  return { accept: isAlwaysOnRule(meta), meta };
}

module.exports = {
  ECOSYSTEMS,
  EXCLUDED,
  ECO_MAX_FILE_CHARS,
  ECO_MAX_TOTAL_CHARS,
  ECO_MAX_FILES_PER_DIR,
  isInstructionEcosystemEnabled,
  isEcosystemEnabled,
  getEcosystems,
  resolveBase,
  instructionEcosystemSources,
  parseRuleFrontmatter,
  isAlwaysOnRule,
  evaluateScopedRule,
};

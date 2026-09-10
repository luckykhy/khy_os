'use strict';

/**
 * Skills Extensions — advanced skill system features.
 * Extends khy-os's existing skill registry with advanced capabilities.
 */

// ── Skill Pipeline ──
class SkillPipeline {
  constructor() {
    this.steps = [];
  }

  addStep(name, handler) {
    this.steps.push({ name, handler });
    return this;
  }

  async execute(context = {}) {
    const results = [];
    for (const step of this.steps) {
      try {
        const result = await step.handler(context);
        results.push({ step: step.name, success: true, result });
        if (result && result.skipRemaining) break;
      } catch (err) {
        results.push({ step: step.name, success: false, error: err.message });
        break;
      }
    }
    return { success: true, results };
  }
}

// ── Skill Composition ──
function composeSkills(skills) {
  return {
    type: 'composition',
    skills,
    async execute(input, context = {}) {
      let result = input;
      for (const skill of skills) {
        if (typeof skill.handler === 'function') {
          result = await skill.handler(result, context);
        }
      }
      return result;
    },
  };
}

// ── Skill Validation ──
function validateSkill(skill) {
  const errors = [];
  if (!skill.name) errors.push('Skill name is required');
  if (!skill.handler && !skill.prompt) errors.push('Skill must have handler or prompt');
  if (skill.handler && typeof skill.handler !== 'function') {
    errors.push('Skill handler must be a function');
  }
  return { valid: errors.length === 0, errors };
}

// ── Skill Versioning ──
function createVersionedSkill(name, versions) {
  return {
    name,
    versions,
    latest: versions[versions.length - 1],
    getVersion(version) {
      return versions.find((v) => v.version === version) || this.latest;
    },
  };
}

// ── Skill Discovery ──
async function discoverSkills(query) {
  const registry = require('../skillRegistry');
  const allSkills = await registry.listSkills({ refresh: true });
  const lowerQuery = query.toLowerCase();

  return allSkills.filter((s) =>
    (s.name && s.name.toLowerCase().includes(lowerQuery)) ||
    (s.description && s.description.toLowerCase().includes(lowerQuery)) ||
    (s.tags && s.tags.some((t) => t.toLowerCase().includes(lowerQuery)))
  );
}

// ── Skill Analytics ──
function trackSkillUsage(skillId, usage) {
  const analytics = global.__khySkillAnalytics || {};
  if (!analytics[skillId]) {
    analytics[skillId] = { count: 0, lastUsed: null, totalDuration: 0 };
  }
  analytics[skillId].count++;
  analytics[skillId].lastUsed = new Date().toISOString();
  if (usage.duration) analytics[skillId].totalDuration += usage.duration;
  global.__khySkillAnalytics = analytics;
  return analytics[skillId];
}

function getSkillAnalytics(skillId) {
  const analytics = global.__khySkillAnalytics || {};
  return analytics[skillId] || { count: 0, lastUsed: null, totalDuration: 0 };
}

module.exports = {
  SkillPipeline,
  composeSkills,
  validateSkill,
  createVersionedSkill,
  discoverSkills,
  trackSkillUsage,
  getSkillAnalytics,
};

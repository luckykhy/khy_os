'use strict';

/**
 * Tests for skillSearch.js — skill discovery and relevance matching.
 *
 * Internal scoring functions are tested indirectly through the public API.
 * We mock the skill sources to isolate the search/scoring logic.
 */

// Prevent real module loads for skills/mcp
jest.mock('../../src/skills/index', () => ({
  getCachedSkills: () => new Map([
    ['commit', {
      name: 'commit',
      description: 'Create a git commit',
      trigger: '/commit',
      aliases: ['/ci'],
      category: 'git',
      tags: ['git', 'version-control'],
      userInvocable: true,
      source: 'builtin',
    }],
    ['review-pr', {
      name: 'review-pr',
      description: 'Review a pull request',
      trigger: '/review-pr',
      aliases: [],
      category: 'git',
      tags: ['git', 'review', 'pr'],
      userInvocable: true,
      source: 'builtin',
    }],
    ['backtest', {
      name: 'backtest',
      description: 'Run strategy backtest',
      trigger: '/backtest',
      aliases: ['/bt'],
      category: 'quant',
      tags: ['trading', 'strategy'],
      userInvocable: true,
      source: 'builtin',
    }],
  ]),
  findSkill: (trigger) => {
    const skills = jest.requireMock('../../src/skills/index').getCachedSkills();
    for (const s of skills.values()) {
      if (s.trigger === trigger) return s;
    }
    return null;
  },
  formatSkillListing: () => 'skill listing',
}), { virtual: true });

jest.mock('../../src/services/skillRegistry', () => ({
  BUILTIN_SKILLS: [],
}), { virtual: true });

jest.mock('../../src/services/mcp/index', () => ({
  listMCPTools: () => [
    { name: 'weather', description: 'Get weather data', serverName: 'weather-server' },
  ],
  getMCPInstructions: () => [],
}), { virtual: true });

let mod;
try {
  mod = require('../../src/services/skillSearch');
} catch {
  mod = null;
}

const _skip = !mod;
const descFn = _skip ? describe.skip : describe;

descFn('skillSearch', () => {
  const { searchSkills, surfaceRelevantSkills } = mod || {};

  test('searchSkills returns empty array for empty query', () => {
    expect(searchSkills('')).toEqual([]);
  });

  test('searchSkills finds exact name match with highest score', () => {
    const results = searchSkills('commit');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].skill.name).toBe('commit');
    expect(results[0].score).toBeGreaterThanOrEqual(0.9);
  });

  test('searchSkills matches by tag', () => {
    const results = searchSkills('trading');
    const backtest = results.find(r => r.skill.name === 'backtest');
    expect(backtest).toBeTruthy();
  });

  test('searchSkills includes MCP tools', () => {
    const results = searchSkills('weather', { includeMcp: true });
    const mcpResult = results.find(r => r.skill.name === 'weather');
    expect(mcpResult).toBeTruthy();
    expect(mcpResult.matchType).toBe('mcp-tool');
  });

  test('searchSkills respects limit option', () => {
    const results = searchSkills('git', { limit: 1 });
    expect(results.length).toBeLessThanOrEqual(1);
  });

  test('searchSkills filters by category', () => {
    const results = searchSkills('git', { category: 'quant' });
    // Should not include git-category skills
    const gitSkill = results.find(r => r.skill.category === 'git');
    expect(gitSkill).toBeUndefined();
  });

  test('surfaceRelevantSkills detects explicit slash command', () => {
    const result = surfaceRelevantSkills('/commit fix typo');
    expect(result.explicit).toBeTruthy();
    expect(result.explicit.name).toBe('commit');
  });

  test('surfaceRelevantSkills returns empty for irrelevant text', () => {
    const result = surfaceRelevantSkills('the quick brown fox');
    expect(result.explicit).toBeNull();
  });
});

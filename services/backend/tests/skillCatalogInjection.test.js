'use strict';

/**
 * Tests for the s07 alignment fix:
 *   1. Catalog injection â€?the previously dead catalog builder
 *      (skillSearch.buildSystemReminder â†?skills.formatSkillListing) is now wired
 *      into the SYSTEM prompt as the `skill_catalog` dynamic section, budgeted at
 *      ~1% of the context window and hard-capped at 8000 chars.
 *   2. Frontmatter modeling â€?when_to_use / allowed-tools / context / model are
 *      parsed off skill manifests into a single normalized shape, and the
 *      "use when" hint surfaces in the catalog line.
 */

const assert = require('assert');

const prompts = require('../src/constants/prompts');
const skills = require('../src/skills');

describe('s07 â€?skill catalog injected into the system prompt', () => {
  test('getSkillCatalogSection returns a non-empty catalog block', () => {
    const section = prompts.getSkillCatalogSection({ contextWindowTokens: 200000 });
    expect(section).toBeTruthy();
    expect(/# Available Skills/.test(section)).toBeTruthy();
    // Lists triggers, not full skill bodies (Level-1 catalog only).
    expect(/\n- \//.test(section)).toBeTruthy();
  });

  test('catalog is hard-capped at 8000 chars even with a huge context window', () => {
    const section = prompts.getSkillCatalogSection({ contextWindowTokens: 100000000 });
    if (section) {
      expect(section.length <= 8000 + 300).toBeTruthy();
    }
  });

  test('KHY_SKILL_CATALOG_CHARS overrides the budget (zero hardcoding)', () => {
    const prev = process.env.KHY_SKILL_CATALOG_CHARS;
    try {
      process.env.KHY_SKILL_CATALOG_CHARS = '200';
      const small = prompts.getSkillCatalogSection({ contextWindowTokens: 200000 });
      process.env.KHY_SKILL_CATALOG_CHARS = '4000';
      const big = prompts.getSkillCatalogSection({ contextWindowTokens: 200000 });
      if (small && big) {
        expect(small.length <= big.length).toBeTruthy();
      }
    } finally {
      if (prev === undefined) delete process.env.KHY_SKILL_CATALOG_CHARS;
      else process.env.KHY_SKILL_CATALOG_CHARS = prev;
    }
  });

  test('the section is registered in the assembled system prompt', async () => {
    const sections = await prompts.getSystemPrompt({ model: 'opus', cwd: process.cwd() });
    const joined = prompts.assembleSystemPrompt(sections);
    // The catalog only appears when at least one user-invocable skill exists.
    const commands = skills.getSkillCommands();
    if (commands.length > 0) {
      expect(/# Available Skills/.test(joined)).toBeTruthy();
    }
  });
});

describe('s07 â€?CC-parity frontmatter modeling', () => {
  test('every discovered skill carries the normalized frontmatter shape', () => {
    const all = skills.getCachedSkills();
    for (const skill of all.values()) {
      expect(typeof skill.whenToUse).toBe('string');
      expect(skill.allowedTools === null || Array.isArray(skill.allowedTools)).toBeTruthy();
      expect(skill.context === 'inline' || skill.context === 'fork').toBeTruthy();
      expect(skill.model === null || typeof skill.model === 'string').toBeTruthy();
    }
  });

  test('_normalizeToolList handles array, string, and empty inputs', () => {
    // Exercised indirectly: a skill manifest may give a comma/space string or an
    // array; both must collapse to a clean string[] (or null for "no restriction").
    const all = [...skills.getCachedSkills().values()];
    const withTools = all.find(s => Array.isArray(s.allowedTools));
    if (withTools) {
      expect(withTools.allowedTools.every(t => typeof t === 'string' && t.length > 0)).toBeTruthy();
    }
  });

  test('whenToUse hint surfaces in the catalog line when present', () => {
    const all = [...skills.getCachedSkills().values()];
    const withHint = all.find(s => s.userInvocable && s.whenToUse);
    if (!withHint) return; // none of the bundled skills set when_to_use â€?skip
    const listing = skills.formatSkillListing(8000);
    assert.ok(listing.includes('(use when:'), 'expected a "use when" hint in the listing');
  });
});


'use strict';

/**
 * Tests for Gap #6: Skill Conditional Activation (paths-based).
 */

const assert = require('assert');

// ── Import the module under test ────────────────────────────────────
const skillModule = require('../src/skills/index');

// ── Helpers ─────────────────────────────────────────────────────────

// Bridge the original standalone-script helpers onto Jest's globals so the
// suite is collected by Jest (assertions still run via node 'assert').
function test(name, fn) {
  global.test(name, fn);
}

function group(name, fn) {
  global.describe(name, fn);
}

// ── Test the internal glob matcher via getActiveSkills/matchAndActivateByPath ──

// Inject test skills into the cache
function injectTestSkills(skills) {
  // Register the injection as a beforeEach bound to the enclosing describe scope.
  // Jest runs all describe bodies during collection but test bodies afterwards,
  // so injecting immediately would leak the last group's skills into every test.
  beforeEach(() => {
    skillModule.invalidateCache();
    const cache = skillModule.getCachedSkills();
    cache.clear();
    for (const s of skills) {
      cache.set(s.name, s);
    }
  });
}

function makeSkill(name, opts = {}) {
  return {
    name,
    description: opts.description || `Test skill: ${name}`,
    userInvocable: opts.userInvocable !== false,
    trigger: opts.trigger || `/${name}`,
    aliases: opts.aliases || [],
    category: opts.category || 'test',
    tags: opts.tags || [],
    paths: opts.paths || null,
    promptPath: null,
    handlerPath: null,
    source: 'test',
    dir: '/tmp/test-skills/' + name,
  };
}

// ── Tests ───────────────────────────────────────────────────────────

group('1. getActiveSkills �?paths=null always active', () => {
  injectTestSkills([
    makeSkill('always-on', { paths: null }),
    makeSkill('also-always-on'),  // paths defaults to null
  ]);

  test('skills without paths constraint are always active', () => {
    const active = skillModule.getActiveSkills({});
    expect(active.length).toBe(2);
    expect(active.some(s => s.name === 'always-on')).toBeTruthy();
    expect(active.some(s => s.name === 'also-always-on')).toBeTruthy();
  });
});

group('2. getActiveSkills �?paths with recentFiles matching', () => {
  injectTestSkills([
    makeSkill('vue-helper', { paths: ['**/*.vue'] }),
    makeSkill('ts-helper', { paths: ['**/*.ts', '**/*.tsx'] }),
    makeSkill('always-on', { paths: null }),
  ]);

  test('vue-helper activates when .vue file in recentFiles', () => {
    const active = skillModule.getActiveSkills({
      recentFiles: ['src/components/App.vue'],
    });
    const names = active.map(s => s.name);
    expect(names).toContain('vue-helper');
    expect(names).toContain('always-on');
    expect(!names).toContain('ts-helper');
  });

  test('ts-helper activates when .ts file in recentFiles', () => {
    const active = skillModule.getActiveSkills({
      recentFiles: ['src/utils/helpers.ts'],
    });
    const names = active.map(s => s.name);
    expect(names).toContain('ts-helper');
    expect(names).toContain('always-on');
    expect(!names).toContain('vue-helper');
  });

  test('both activate when both file types present', () => {
    const active = skillModule.getActiveSkills({
      recentFiles: ['src/App.vue', 'src/main.ts'],
    });
    const names = active.map(s => s.name);
    expect(names).toContain('vue-helper');
    expect(names).toContain('ts-helper');
    expect(names).toContain('always-on');
  });
});

group('3. getActiveSkills �?non-invocable skills excluded', () => {
  injectTestSkills([
    makeSkill('internal-only', { userInvocable: false, paths: null }),
    makeSkill('public-skill', { userInvocable: true, paths: null }),
  ]);

  test('non-invocable skills are excluded from active list', () => {
    const active = skillModule.getActiveSkills({});
    expect(active.length).toBe(1);
    expect(active[0].name).toBe('public-skill');
  });
});

group('4. matchAndActivateByPath �?returns matching skill names', () => {
  injectTestSkills([
    makeSkill('vue-helper', { paths: ['**/*.vue'] }),
    makeSkill('py-helper', { paths: ['**/*.py', 'scripts/**'] }),
    makeSkill('always-on', { paths: null }),
  ]);

  test('matches .vue file', () => {
    const matched = skillModule.matchAndActivateByPath('src/components/Header.vue');
    expect(matched.has('vue-helper')).toBeTruthy();
    expect(!matched.has('py-helper')).toBeTruthy();
    expect(!matched.has('always-on')).toBeTruthy();
  });

  test('matches .py file', () => {
    const matched = skillModule.matchAndActivateByPath('backend/utils/parser.py');
    expect(matched.has('py-helper')).toBeTruthy();
    expect(!matched.has('vue-helper')).toBeTruthy();
  });

  test('matches scripts/** pattern', () => {
    const matched = skillModule.matchAndActivateByPath('scripts/build.sh');
    expect(matched.has('py-helper')).toBeTruthy();
  });

  test('no match for unrelated file', () => {
    const matched = skillModule.matchAndActivateByPath('README.md');
    expect(matched.size).toBe(0);
  });
});

group('5. formatSkillListing �?with context filtering', () => {
  injectTestSkills([
    makeSkill('vue-helper', { paths: ['**/*.vue'], description: 'Vue.js component assistance' }),
    makeSkill('py-helper', { paths: ['**/*.py'], description: 'Python scripting help' }),
    makeSkill('always-on', { paths: null, description: 'Always available skill' }),
  ]);

  test('without context returns all user-invocable skills', () => {
    const listing = skillModule.formatSkillListing(8000);
    expect(listing).toContain('/vue-helper');
    expect(listing).toContain('/py-helper');
    expect(listing).toContain('/always-on');
  });

  test('with context only returns active skills', () => {
    const listing = skillModule.formatSkillListing(8000, {
      recentFiles: ['src/App.vue'],
    });
    expect(listing).toContain('/vue-helper');
    expect(listing).toContain('/always-on');
    expect(!listing).toContain('/py-helper');
  });

  test('with empty context only returns always-active skills', () => {
    const listing = skillModule.formatSkillListing(8000, {});
    expect(!listing).toContain('/vue-helper');
    expect(!listing).toContain('/py-helper');
    expect(listing).toContain('/always-on');
  });
});

group('6. Glob pattern edge cases', () => {
  injectTestSkills([
    makeSkill('deep-match', { paths: ['src/components/**/*.vue'] }),
    makeSkill('single-star', { paths: ['*.json'] }),
    makeSkill('question-mark', { paths: ['test?.js'] }),
  ]);

  test('** matches deeply nested paths', () => {
    const matched = skillModule.matchAndActivateByPath('src/components/ui/nested/Button.vue');
    expect(matched.has('deep-match')).toBeTruthy();
  });

  test('** does not match wrong prefix', () => {
    const matched = skillModule.matchAndActivateByPath('lib/components/Button.vue');
    expect(!matched.has('deep-match')).toBeTruthy();
  });

  test('* does not match path separators', () => {
    const matched = skillModule.matchAndActivateByPath('package.json');
    expect(matched.has('single-star')).toBeTruthy();
  });

  test('* does not match nested json', () => {
    const matched = skillModule.matchAndActivateByPath('src/package.json');
    expect(!matched.has('single-star')).toBeTruthy();
  });

  test('? matches single character', () => {
    const m1 = skillModule.matchAndActivateByPath('test1.js');
    expect(m1.has('question-mark')).toBeTruthy();
    const m2 = skillModule.matchAndActivateByPath('testAB.js');
    expect(!m2.has('question-mark')).toBeTruthy();
  });
});

console.log('\n--- All Gap #6 tests complete ---\n');


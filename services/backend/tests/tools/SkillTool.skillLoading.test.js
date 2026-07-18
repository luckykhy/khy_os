'use strict';

/**
 * Tests for s07 skill-loading fixes:
 *   1. SkillTool resolves through the name-based manifest registry (src/skills),
 *      so bundled built-in skills are reachable via the Skill tool — and lookup
 *      is by registry name, never a path built from the argument.
 *   2. The marketplace registry's installed-skill branch rejects ids that could
 *      escape SKILLS_DIR (path-traversal → arbitrary require()).
 */

const assert = require('assert');
const path = require('path');

const skillToolModule = require('../../src/tools/SkillTool');
const manifestRegistry = require('../../src/skills');
const marketplaceRegistry = require('../../src/services/skillRegistry');

describe('SkillTool — name-based manifest routing (s07 Level-2)', () => {
  test('loads a bundled built-in skill by name via the manifest registry', async () => {
    // Pick whatever bundled skill the manifest registry actually discovers, so
    // the test is robust to the exact built-in set.
    const skills = manifestRegistry.getCachedSkills();
    const first = [...skills.values()][0];
    assert.ok(first, 'expected at least one discoverable manifest skill');

    const res = await skillToolModule.execute({ skill: first.name }, {});
    assert.strictEqual(res.success, true, `execute failed: ${res.error}`);
    assert.strictEqual(res.skill, first.name);
    // Content is returned via the tool result (CC "inject via tool_result").
    assert.ok(res.output && (res.output.content !== undefined || res.output.type !== undefined));
  });

  test('a path-traversal skill name does not resolve to a file load', async () => {
    // findSkill must not match a traversal string, so the manifest branch is
    // skipped; the marketplace branch then rejects it (see traversal test below),
    // and the whole call fails cleanly rather than touching the filesystem.
    assert.strictEqual(manifestRegistry.findSkill('../../../../etc/passwd'), null);
    const res = await skillToolModule.execute({ skill: '../../../../etc/passwd' }, {});
    assert.strictEqual(res.success, false);
  });

  test('missing skill name is rejected', async () => {
    const res = await skillToolModule.execute({}, {});
    assert.strictEqual(res.success, false);
    assert.ok(/required/i.test(res.error));
  });
});

describe('skillRegistry.executeSkill — path-traversal hardening (s07)', () => {
  const malicious = [
    '../../../../etc/passwd',
    '..%2f..%2ffoo',
    'foo/bar',
    'foo\\bar',
    '.',
    '..',
    'a.b',
  ];

  for (const id of malicious) {
    test(`rejects unsafe id ${JSON.stringify(id)}`, async () => {
      await assert.rejects(
        () => marketplaceRegistry.executeSkill(id, '', {}),
        /Invalid skill id|not installed/i,
        `id ${JSON.stringify(id)} should not load a file`
      );
    });
  }

  test('the resolved path for a rejected id never escapes SKILLS_DIR', async () => {
    // Defensive: confirm the regex blocks before any path is built. A blocked id
    // throws "Invalid skill id"; a benign-but-absent id throws "not installed".
    await assert.rejects(
      () => marketplaceRegistry.executeSkill('../evil', '', {}),
      /Invalid skill id/i
    );
    // Sanity: path.join WOULD have escaped, proving the guard is load-bearing.
    const escaped = path.join('/x/y/skills', '../evil.js');
    assert.ok(!escaped.startsWith('/x/y/skills' + path.sep));
  });
});

'use strict';

/**
 * slashLearnSkillAlias.test.js — discoverability + naming-alignment lock for the
 * `/learn-skill` slash alias (Hermes v0.18.0 /learn mental model → khy `skill learn`).
 *
 * `/learn` is already occupied by the interactive curriculum (learn.js). The
 * Hermes-style "distill a directory/webpage into a reusable skill" feature lives
 * at the canonical route `skill learn dir <path>` / `skill learn url <url>`
 * (skill.js handleSkillLearn switches on args[0]). It had NO slash-menu entry, so
 * weak users / small models could not discover it.
 *
 * Fix: a non-colliding top-level alias `/learn-skill` with route `skill learn`.
 * Typed trailing args (`dir <path>` / `url <url>`) concatenate onto the route via
 * router.parseInput (router.js:456 `[...routeParts, ...parts.slice(1)]`), so no
 * handler change is needed.
 *
 * Locks:
 *   - commandSchema registers /learn-skill routing to `skill learn`;
 *   - it does NOT collide with the occupied /learn curriculum route;
 *   - parseInput('/learn-skill dir <path>') expands to command=skill,
 *     subCommand=learn, args=['dir', <path>] — the canonical dir case;
 *   - same for url.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const schema = require('../src/constants/commandSchema');
const router = require('../src/cli/router');

function _slashList() {
  // getBuiltinSlashCommands() returns the authored menu table (route/desc preserved
  // via spread, category filled in). It is the exported accessor over
  // BUILTIN_SLASH_COMMANDS.
  return schema.getBuiltinSlashCommands();
}

test('commandSchema registers /learn-skill routing to `skill learn`', () => {
  const list = _slashList();
  const entry = list.find((c) => c && c.cmd === '/learn-skill');
  assert.ok(entry, '/learn-skill slash entry exists');
  assert.strictEqual(entry.route, 'skill learn', 'routes to canonical `skill learn`');
  assert.ok(/dir/.test(entry.desc) && /url/.test(entry.desc), 'desc documents dir|url usage');
});

test('/learn-skill does not collide with the occupied /learn curriculum route', () => {
  const list = _slashList();
  const learn = list.find((c) => c && c.cmd === '/learn');
  // /learn stays the interactive curriculum; /learn-skill is a distinct entry.
  if (learn) {
    assert.notStrictEqual(learn.route, 'skill learn', '/learn must NOT be the skill-learn route');
  }
  const learnSkill = list.find((c) => c && c.cmd === '/learn-skill');
  assert.ok(learnSkill && learnSkill.cmd !== '/learn', 'distinct command token');
});

test('parseInput(/learn-skill dir <path>) → command=skill, subCommand=learn, args=[dir,path]', () => {
  const parsed = router.parseInput('/learn-skill dir /tmp/some-tool');
  assert.ok(parsed, 'parses');
  assert.strictEqual(parsed.command, 'skill');
  assert.strictEqual(parsed.subCommand, 'learn');
  assert.deepStrictEqual(parsed.args, ['dir', '/tmp/some-tool']);
});

test('parseInput(/learn-skill url <url>) → command=skill, subCommand=learn, args=[url,url]', () => {
  const parsed = router.parseInput('/learn-skill url https://example.com/docs');
  assert.ok(parsed, 'parses');
  assert.strictEqual(parsed.command, 'skill');
  assert.strictEqual(parsed.subCommand, 'learn');
  assert.deepStrictEqual(parsed.args, ['url', 'https://example.com/docs']);
});

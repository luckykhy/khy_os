'use strict';
/**
 * slashLearnSkillAlias.test.js â€?discoverability + naming-alignment lock for the
 * `/learn-skill` slash alias (Hermes v0.18.0 /learn mental model â†?khy `skill learn`).
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
 *     subCommand=learn, args=['dir', <path>] â€?the canonical dir case;
 *   - same for url.
 */
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
  expect(entry).toBeTruthy();
  expect(entry.route).toBe('skill learn');
  expect(/dir/.test(entry.desc) && /url/.test(entry.desc)).toBeTruthy();
});

describe('Slash Learn Skill Alias', () => {
  test('/learn-skill does not collide with the occupied /learn curriculum route', () => {
      const list = _slashList();
      const learn = list.find((c) => c && c.cmd === '/learn');
      // /learn stays the interactive curriculum; /learn-skill is a distinct entry.
      if (learn) {
        expect(learn.route).not.toBe('skill learn', '/learn must NOT be the skill-learn route');
      }
      const learnSkill = list.find((c) => c && c.cmd === '/learn-skill');
      expect(learnSkill && learnSkill.cmd !== '/learn').toBeTruthy();
  });

  test('parseInput(/learn-skill dir <path>) â†?command=skill, subCommand=learn, args=[dir,path]', () => {
      const parsed = router.parseInput('/learn-skill dir /tmp/some-tool');
      expect(parsed).toBeTruthy();
      expect(parsed.command).toBe('skill');
      expect(parsed.subCommand).toBe('learn');
      expect(parsed.args).toEqual(['dir', '/tmp/some-tool']);
  });

  test('parseInput(/learn-skill url <url>) â†?command=skill, subCommand=learn, args=[url,url]', () => {
      const parsed = router.parseInput('/learn-skill url https://example.com/docs');
      expect(parsed).toBeTruthy();
      expect(parsed.command).toBe('skill');
      expect(parsed.subCommand).toBe('learn');
      expect(parsed.args).toEqual(['url', 'https://example.com/docs']);
  });

});


'use strict';
/**
 * skillLoaderNativeSkillMd.test.js �?锁「khy 原生发现自有目录里的 SKILL.md」�?
 *
 * 背景:此前 discoverSkillsDeep 的用户级 SKILL.md 扫描只覆�?legacy
 *   ~/.khyquant/skills,唯独�?canonical ~/.khy/skills �?�?~/.khy/skills �?
 *   SKILL.md khy 发现不了,只能�?ccSkillBridge �?~/.claude/skills �?那会
 *   同时漏进 Claude Code 的斜杠菜�?。本测试注入 temp homedir + projectDir,
 *   断言 discoverSkillsDeep 现在能原生发�?.khy/skills 下的 SKILL.md,且不�?
 *   碰真�?HOME / CC 目录�?
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loader = require('../src/skills/skillLoader');
function mkSkill(root, name, desc) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n\nbody for ${name}.\n`,
  );
}

describe('Skill Loader Native Skill Md', () => {
  test('discoverSkillsDeep 原生发现 ~/.khy/skills 下的 SKILL.md(canonical 用户目录)', () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-home-'));
      try {
        mkSkill(path.join(home, '.khy', 'skills'), 'native-user-skill', 'lives in khy home');
        const skills = loader.discoverSkillsDeep(null, { homedir: home });
        expect(skills.has('native-user-skill')).toBeTruthy();
        const s = skills.get('native-user-skill');
        expect(s.priority).toBe('user');
        expect(s.meta.description).toBe('lives in khy home');
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
  });

  test('discoverSkillsDeep 仍发�?legacy ~/.khyquant/skills 下的 SKILL.md', () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-home-'));
      try {
        mkSkill(path.join(home, '.khyquant', 'skills'), 'legacy-user-skill', 'legacy home');
        const skills = loader.discoverSkillsDeep(null, { homedir: home });
        expect(skills.has('legacy-user-skill')).toBeTruthy();
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
  });

  test('discoverSkillsDeep 原生发现 <project>/.khy/skills 下的 SKILL.md(项目目录)', () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-home-'));
      const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-proj-'));
      try {
        mkSkill(path.join(proj, '.khy', 'skills'), 'native-project-skill', 'in project');
        const skills = loader.discoverSkillsDeep(proj, { homedir: home });
        expect(skills.has('native-project-skill')).toBeTruthy();
        expect(skills.get('native-project-skill').priority).toBe('project');
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(proj, { recursive: true, force: true });
      }
  });

  test('khy-native SKILL.md 优先于同�?CC 目录副本(first match wins)', () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-home-'));
      try {
        mkSkill(path.join(home, '.khy', 'skills'), 'dup-skill', 'khy-native version');
        mkSkill(path.join(home, '.claude', 'skills'), 'dup-skill', 'cc version');
        const skills = loader.discoverSkillsDeep(null, { homedir: home }); // bridge default ON
        assert.strictEqual(skills.get('dup-skill').meta.description, 'khy-native version',
          'khy-native (~/.khy/skills) must win over CC (~/.claude/skills) copy');
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
  });

  test('默认�?不传 opts 仍工�?向后兼容·用真�?os.homedir)', () => {
      // 只断言不抛且返�?Map(不依赖真�?HOME 里有无技�?�?
      const skills = loader.discoverSkillsDeep(null);
      expect(skills instanceof Map).toBeTruthy();
  });

});


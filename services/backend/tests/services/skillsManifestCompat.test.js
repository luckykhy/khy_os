'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const skills = require('../../src/skills/index');

function writeSkill(baseDir, name, manifest) {
  const skillDir = path.join(baseDir, name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(skillDir, 'prompt.md'), `# ${name}\n`);
}

describe('skills manifest compatibility', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-skill-compat-'));
  });

  afterEach(() => {
    skills.invalidateCache();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('uses command as trigger when trigger is absent', () => {
    writeSkill(tmpDir, 'alpha', {
      name: 'alpha',
      command: '/alpha-cmd',
      description: 'alpha skill',
      userInvocable: true,
      tags: ['alpha'],
    });

    const loaded = skills.loadSkillsFromDir(tmpDir, 'test');
    expect(loaded.get('alpha').trigger).toBe('/alpha-cmd');
  });

  test('reads camelCase userInvocable when snake_case key is absent', () => {
    writeSkill(tmpDir, 'beta', {
      name: 'beta',
      trigger: '/beta',
      description: 'beta skill',
      userInvocable: false,
      tags: ['beta'],
    });

    const loaded = skills.loadSkillsFromDir(tmpDir, 'test');
    expect(loaded.get('beta').userInvocable).toBe(false);
  });

  test('prefers user_invocable when both key styles are present', () => {
    writeSkill(tmpDir, 'gamma', {
      name: 'gamma',
      trigger: '/gamma',
      description: 'gamma skill',
      user_invocable: true,
      userInvocable: false,
      tags: ['gamma'],
    });

    const loaded = skills.loadSkillsFromDir(tmpDir, 'test');
    expect(loaded.get('gamma').userInvocable).toBe(true);
  });
});

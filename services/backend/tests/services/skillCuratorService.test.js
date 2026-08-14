'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

describe('skillCuratorService', () => {
  let curator;
  // The curator resolves its usage file via getAppHome() (isolated data home
  // under jest) 鈥?use the exported USAGE_FILE rather than a hardcoded
  // ~/.khyquant/growth path so tests never touch the real user home.
  let USAGE_FILE;
  let BACKUP_FILE;

  beforeAll(() => {
    // Not available until the module is required; resolved per-test below.
  });

  afterAll(() => {
    // Restore backup
    if (BACKUP_FILE && fs.existsSync(BACKUP_FILE)) {
      fs.copyFileSync(BACKUP_FILE, USAGE_FILE);
      fs.unlinkSync(BACKUP_FILE);
    } else if (USAGE_FILE && fs.existsSync(USAGE_FILE)) {
      fs.unlinkSync(USAGE_FILE);
    }
  });

  beforeEach(() => {
    jest.resetModules();
    curator = require('../../src/services/skillCuratorService');
    USAGE_FILE = curator.USAGE_FILE;
    BACKUP_FILE = USAGE_FILE + '.test-backup';
    // Backup existing data if present
    if (fs.existsSync(USAGE_FILE)) {
      fs.copyFileSync(USAGE_FILE, BACKUP_FILE);
    }
    // Start clean
    curator._resetForTest();
  });

  // 鈹€鈹€ recordUsage 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

  test('recordUsage creates entry and increments use_count', () => {
    curator.recordUsage('test-skill', 'user');
    const usage = curator.getSkillUsage('test-skill');
    expect(usage).toBeTruthy();
    expect(usage.use_count).toBe(1);
    expect(usage.state).toBe('active');
    expect(usage.source).toBe('user');

    curator.recordUsage('test-skill', 'user');
    const usage2 = curator.getSkillUsage('test-skill');
    expect(usage2.use_count).toBe(2);
  });

  test('recordUsage auto-restores stale to active', () => {
    curator.recordUsage('stale-skill', 'user');

    // Manually set state to stale
    const data = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
    data.skills['stale-skill'].state = 'stale';
    fs.writeFileSync(USAGE_FILE, JSON.stringify(data, null, 2));

    curator.recordUsage('stale-skill', 'user');
    const usage = curator.getSkillUsage('stale-skill');
    expect(usage.state).toBe('active');
    expect(usage.use_count).toBe(2);
  });

  test('getSkillUsage returns null for unknown skill', () => {
    expect(curator.getSkillUsage('nonexistent')).toBeNull();
  });

  // 鈹€鈹€ Pin/Unpin 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

  test('pinSkill and unpinSkill', () => {
    curator.recordUsage('pin-test', 'user');

    expect(curator.pinSkill('pin-test')).toBe(true);
    expect(curator.getSkillUsage('pin-test').pinned).toBe(true);

    expect(curator.unpinSkill('pin-test')).toBe(true);
    expect(curator.getSkillUsage('pin-test').pinned).toBe(false);
  });

  test('pinSkill returns false for unknown skill', () => {
    expect(curator.pinSkill('nope')).toBe(false);
  });

  // 鈹€鈹€ runCurator 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

  test('runCurator transitions active鈫抯tale after staleAfterDays', () => {
    curator.recordUsage('old-skill', 'user');

    // Backdate last_activity to 31 days ago
    const data = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
    data.skills['old-skill'].last_activity_at = new Date(Date.now() - 31 * 86_400_000).toISOString();
    fs.writeFileSync(USAGE_FILE, JSON.stringify(data, null, 2));

    const allSkills = [{ name: 'old-skill', source: 'user', dir: '/tmp/fake' }];
    const result = curator.runCurator(allSkills);

    expect(result.transitioned).toHaveLength(1);
    expect(result.transitioned[0]).toEqual({ name: 'old-skill', from: 'active', to: 'stale' });
    expect(curator.getSkillUsage('old-skill').state).toBe('stale');
  });

  test('runCurator skips built-in skills', () => {
    curator.recordUsage('builtin-skill', 'built-in');

    const data = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
    data.skills['builtin-skill'].last_activity_at = new Date(Date.now() - 90 * 86_400_000).toISOString();
    fs.writeFileSync(USAGE_FILE, JSON.stringify(data, null, 2));

    const allSkills = [{ name: 'builtin-skill', source: 'built-in', dir: '/tmp/fake' }];
    const result = curator.runCurator(allSkills);

    expect(result.transitioned).toHaveLength(0);
    expect(curator.getSkillUsage('builtin-skill').state).toBe('active');
  });

  test('runCurator skips pinned skills', () => {
    curator.recordUsage('pinned-skill', 'user');
    curator.pinSkill('pinned-skill');

    const data = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
    data.skills['pinned-skill'].last_activity_at = new Date(Date.now() - 90 * 86_400_000).toISOString();
    fs.writeFileSync(USAGE_FILE, JSON.stringify(data, null, 2));

    const allSkills = [{ name: 'pinned-skill', source: 'user', dir: '/tmp/fake' }];
    const result = curator.runCurator(allSkills);

    expect(result.transitioned).toHaveLength(0);
  });

  test('runCurator returns clean summary when no transitions', () => {
    const result = curator.runCurator([]);
    expect(result.transitioned).toHaveLength(0);
    expect(result.summary).toContain('No lifecycle transitions');
  });

  // 鈹€鈹€ getCuratorStatus 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

  test('getCuratorStatus counts states correctly', () => {
    curator.recordUsage('a-active', 'user');
    curator.recordUsage('b-stale', 'user');

    const data = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
    data.skills['b-stale'].state = 'stale';
    fs.writeFileSync(USAGE_FILE, JSON.stringify(data, null, 2));

    const allSkills = [
      { name: 'a-active', source: 'user' },
      { name: 'b-stale', source: 'user' },
      { name: 'untracked', source: 'user' },
    ];

    const status = curator.getCuratorStatus(allSkills);
    expect(status.active).toBe(2); // a-active + untracked
    expect(status.stale).toBe(1);
    expect(status.staleList).toContain('b-stale');
  });

  // 鈹€鈹€ Config 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

  test('DEFAULT_CONFIG has expected shape', () => {
    expect(curator.DEFAULT_CONFIG.staleAfterDays).toBe(30);
    expect(curator.DEFAULT_CONFIG.archiveAfterDays).toBe(60);
  });
});

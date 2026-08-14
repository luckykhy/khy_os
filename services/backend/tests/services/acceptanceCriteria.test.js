'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  CODING_ACCEPTANCE,
  CODING_SCAFFOLD_ACCEPTANCE,
  CODING_CONTAINER_ACCEPTANCE,
  CODING_TEST_EVIDENCE_ACCEPTANCE,
  ULTRAWORK_ACCEPTANCE,
  ANALYZE_ACCEPTANCE,
  GOAL_ACCEPTANCE,
  MODE_ACCEPTANCE,
  buildAcceptancePack,
} = require('../../src/services/acceptanceCriteria');

function createTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-pack-test-'));
}

describe('acceptanceCriteria', () => {
  test('CODING_ACCEPTANCE focuses on delivery evidence', () => {
    expect(CODING_ACCEPTANCE.find((item) => item.id === 'workspace_change_evidence')).toBeDefined();
    expect(CODING_ACCEPTANCE.find((item) => item.id === 'delivery_evidence')).toBeDefined();
  });

  test('scaffold and container profile exports remain machine-readable', () => {
    expect(CODING_SCAFFOLD_ACCEPTANCE.find((item) => item.id === 'config_file')).toBeDefined();
    expect(CODING_CONTAINER_ACCEPTANCE.find((item) => item.id === 'dockerfile')).toBeDefined();
    expect(CODING_TEST_EVIDENCE_ACCEPTANCE.find((item) => item.id === 'test_entrypoint')).toBeDefined();
  });

  test('MODE_ACCEPTANCE still maps mode defaults', () => {
    expect(MODE_ACCEPTANCE.coding).toBe(CODING_ACCEPTANCE);
    expect(MODE_ACCEPTANCE.ultrawork).toBe(ULTRAWORK_ACCEPTANCE);
    expect(MODE_ACCEPTANCE.analyze).toBe(ANALYZE_ACCEPTANCE);
    expect(MODE_ACCEPTANCE.goal).toBe(GOAL_ACCEPTANCE);
  });

  test('all exported criteria retain the required structural fields', () => {
    const allCriteria = [
      ...CODING_ACCEPTANCE,
      ...CODING_SCAFFOLD_ACCEPTANCE,
      ...CODING_CONTAINER_ACCEPTANCE,
      ...CODING_TEST_EVIDENCE_ACCEPTANCE,
      ...ULTRAWORK_ACCEPTANCE,
      ...ANALYZE_ACCEPTANCE,
      ...GOAL_ACCEPTANCE,
    ];

    for (const criterion of allCriteria) {
      expect(criterion.id).toBeTruthy();
      expect(criterion.label).toBeTruthy();
      expect(typeof criterion.phase).toBe('number');
      expect(typeof criterion.required).toBe('boolean');
      expect(criterion.check).toBeTruthy();
      if (criterion.check === 'custom') expect(criterion.validator).toBeTruthy();
    }
  });

  test('buildAcceptancePack activates coding core and test evidence for coding tasks', () => {
    const pack = buildAcceptancePack({
      modes: ['coding'],
      userMessage: 'Fix the parser bug and add tests if needed',
      toolCallLog: [{ tool: 'editFile', params: { path: '/tmp/demo.js' } }],
    });

    expect(pack.profiles.map((profile) => profile.id)).toEqual(expect.arrayContaining([
      'coding_core',
      'coding_test_evidence',
    ]));
    expect(pack.criteria.map((criterion) => criterion.id)).toEqual(expect.arrayContaining([
      'workspace_change_evidence',
      'delivery_evidence',
      'test_assets',
      'test_entrypoint',
    ]));
  });

  test('explicitly-mentioned tests make test evidence required and add a real test-run check', () => {
    const pack = buildAcceptancePack({
      modes: ['coding'],
      userMessage: 'Refactor the auth module and write unit tests',
      toolCallLog: [{ tool: 'editFile', params: { path: '/tmp/auth.js' } }],
    });

    const testAssets = pack.criteria.find((criterion) => criterion.id === 'test_assets');
    const testEntrypoint = pack.criteria.find((criterion) => criterion.id === 'test_entrypoint');
    const testRun = pack.criteria.find((criterion) => criterion.id === 'test_run_evidence');

    // 任务显式提到测试 → 测试证据升级为 required(必须真实验收),并追加真实跑测判据。
    expect(testAssets.required).toBe(true);
    expect(testEntrypoint.required).toBe(true);
    expect(testRun).toBeDefined();
    expect(testRun.required).toBe(true);
    expect(testRun.validator).toBe('test_run_evidence');
    expect(pack.profiles.map((profile) => profile.id)).toContain('coding_test_run_evidence');
  });

  test('task without test mention keeps test evidence non-blocking', () => {
    const pack = buildAcceptancePack({
      modes: ['coding'],
      userMessage: 'Fix the login redirect bug',
      toolCallLog: [{ tool: 'editFile', params: { path: '/tmp/login.js' } }],
    });

    const testAssets = pack.criteria.find((criterion) => criterion.id === 'test_assets');
    expect(testAssets.required).toBe(false);
    expect(pack.criteria.find((criterion) => criterion.id === 'test_run_evidence')).toBeUndefined();
  });

  test('buildAcceptancePack activates scaffold profile only for scaffold-like tasks', () => {
    const pack = buildAcceptancePack({
      modes: ['coding'],
      userMessage: 'Create a new CLI project from scratch',
    });

    expect(pack.profiles.map((profile) => profile.id)).toContain('coding_scaffold');
    expect(pack.criteria.map((criterion) => criterion.id)).toEqual(expect.arrayContaining([
      'config_file',
      'readme',
    ]));
  });

  test('buildAcceptancePack promotes docker-compose to required when compose is requested', () => {
    const pack = buildAcceptancePack({
      modes: ['coding'],
      userMessage: 'Create a Docker Compose deployment for this service',
    });

    const composeCriterion = pack.criteria.find((criterion) => criterion.id === 'docker_compose');
    expect(pack.profiles.map((profile) => profile.id)).toContain('coding_container_delivery');
    expect(composeCriterion).toBeDefined();
    expect(composeCriterion.required).toBe(true);
  });

  test('buildAcceptancePack detects existing test assets from the project root', () => {
    const tmpDir = createTmpDir();
    const testsDir = path.join(tmpDir, 'backend', 'tests');

    fs.mkdirSync(testsDir, { recursive: true });
    fs.writeFileSync(path.join(testsDir, 'demo.test.js'), 'test');

    const pack = buildAcceptancePack({
      modes: ['coding'],
      userMessage: 'Refactor existing gateway logic',
      projectRoot: tmpDir,
    });

    expect(pack.signals.projectHasTests).toBe(true);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

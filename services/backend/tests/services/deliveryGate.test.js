'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  evaluateDelivery,
  buildHarnessDeliveryVerdict,
  buildRemediationPrompt,
  inferProjectRoot,
  _runCheck,
  CUSTOM_VALIDATORS,
} = require('../../src/services/deliveryGate');

const {
  CODING_SCAFFOLD_ACCEPTANCE,
  CODING_CONTAINER_ACCEPTANCE,
  CODING_TEST_EVIDENCE_ACCEPTANCE,
  buildAcceptancePack,
} = require('../../src/services/acceptanceCriteria');

function createTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-gate-test-'));
}

function cleanupDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore cleanup failures in tests
  }
}

describe('deliveryGate', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    cleanupDir(tmpDir);
  });

  describe('evaluateDelivery', () => {
    test('returns pass verdict when scaffold and container deliverables exist', () => {
      fs.writeFileSync(path.join(tmpDir, 'Dockerfile'), 'FROM node:20');
      fs.writeFileSync(path.join(tmpDir, 'docker-compose.yml'), 'version: "3"');
      fs.writeFileSync(path.join(tmpDir, '.dockerignore'), 'node_modules');
      fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Project\ndocker compose up');
      fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));
      fs.mkdirSync(path.join(tmpDir, 'tests'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'tests', 'smoke.test.js'), 'test');

      const criteria = [
        ...CODING_SCAFFOLD_ACCEPTANCE,
        ...CODING_CONTAINER_ACCEPTANCE.map((criterion) => (
          criterion.id === 'docker_compose' ? { ...criterion, required: true } : criterion
        )),
        ...CODING_TEST_EVIDENCE_ACCEPTANCE,
      ];

      const result = evaluateDelivery(tmpDir, criteria, {
        toolCallLog: [{ tool: 'editFile', params: { path: path.join(tmpDir, 'README.md') } }],
        finalResponse: 'Updated README.md and Dockerfile.',
      });

      expect(result.passed).toBe(true);
      expect(result.verdict).toBe('pass');
      expect(result.missing).toEqual([]);
      expect(result.summary).toContain('PASS');
    });

    test('returns fail verdict when required files are missing', () => {
      fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');

      const result = evaluateDelivery(tmpDir, CODING_SCAFFOLD_ACCEPTANCE);

      expect(result.passed).toBe(false);
      expect(result.verdict).toBe('fail');
      expect(result.missing.some((item) => item.id === 'config_file')).toBe(false);
      expect(result.missing.some((item) => item.id === 'readme')).toBe(true);
    });

    test('returns warn verdict when only optional criteria fail', () => {
      const pack = buildAcceptancePack({
        modes: ['coding'],
        userMessage: 'Fix parser bug',
        toolCallLog: [{ tool: 'editFile', params: { path: path.join(tmpDir, 'src', 'parser.js') } }],
        projectRoot: tmpDir,
      });

      const result = evaluateDelivery(tmpDir, pack.criteria, {
        toolCallLog: [{ tool: 'editFile', params: { path: path.join(tmpDir, 'src', 'parser.js') } }],
        finalResponse: 'Updated src/parser.js.',
        acceptancePack: pack,
      });

      expect(result.passed).toBe(true);
      expect(result.verdict).toBe('warn');
      expect(result.warnings.length).toBeGreaterThan(0);
    });
  });

  describe('_runCheck', () => {
    test('file_exists returns pass when file exists', () => {
      fs.writeFileSync(path.join(tmpDir, 'Dockerfile'), 'FROM node:20');
      const result = _runCheck({ check: 'file_exists', target: 'Dockerfile' }, tmpDir);
      expect(result).toBe('pass');
    });

    test('glob_min returns pass when enough files exist', () => {
      fs.mkdirSync(path.join(tmpDir, 'tests'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'tests', 'test1.js'), 'test');
      const result = _runCheck({ check: 'glob_min', target: 'tests/**/*', minFiles: 1 }, tmpDir);
      expect(result).toBe('pass');
    });

    test('file_contains returns fail when expected token is missing', () => {
      fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Project');
      const result = _runCheck({
        check: 'file_contains',
        target: 'README.md',
        contains: ['docker compose'],
      }, tmpDir);
      expect(result).toBe('fail');
    });
  });

  describe('CUSTOM_VALIDATORS', () => {
    test('plan_in_response passes with numbered plan', () => {
      const result = CUSTOM_VALIDATORS.plan_in_response({
        finalResponse: '1. Check environment\n2. Create project\n3. Build and test',
      });
      expect(result.status).toBe('pass');
    });

    test('evidence_in_response passes with file paths', () => {
      const result = CUSTOM_VALIDATORS.evidence_in_response({
        finalResponse: 'The issue is in src/controller/UserController.java at line 42.',
      });
      expect(result.status).toBe('pass');
    });

    test('meaningful_workspace_edits fails without edit tool calls', () => {
      const result = CUSTOM_VALIDATORS.meaningful_workspace_edits({
        toolCallLog: [],
      });
      expect(result.status).toBe('fail');
    });

    test('test_entrypoint_present detects package test scripts', () => {
      fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));
      const result = CUSTOM_VALIDATORS.test_entrypoint_present({
        projectRoot: tmpDir,
      });
      expect(result.status).toBe('pass');
    });
  });

  describe('buildRemediationPrompt', () => {
    test('includes missing and warning sections', () => {
      const missing = [{ id: 'dockerfile', label: 'Dockerfile', detail: 'Dockerfile not found.' }];
      const warnings = [{ id: 'dockerignore', label: '.dockerignore', detail: '.dockerignore not found.' }];
      const prompt = buildRemediationPrompt('create a React app', missing, warnings, 1, 2);

      expect(prompt).toContain('Dockerfile');
      expect(prompt).toContain('.dockerignore');
      expect(prompt).toContain('round 1/2');
    });
  });

  describe('inferProjectRoot', () => {
    test('returns fallback when no tool calls exist', () => {
      expect(inferProjectRoot([], '/fallback')).toBe('/fallback');
    });

    test('finds root from scaffoldFiles call', () => {
      const log = [{ tool: 'scaffoldFiles', params: { root: tmpDir } }];
      expect(inferProjectRoot(log, '/fallback')).toBe(path.resolve(tmpDir));
    });

    test('finds root from write_file by walking up to config', () => {
      const projectDir = path.join(tmpDir, 'my-app');
      const srcDir = path.join(projectDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(path.join(projectDir, 'package.json'), '{}');
      fs.writeFileSync(path.join(srcDir, 'index.js'), 'console.log("hi")');

      const log = [{ tool: 'write_file', params: { path: path.join(srcDir, 'index.js') } }];
      expect(inferProjectRoot(log, '/fallback')).toBe(projectDir);
    });
  });

  describe('buildHarnessDeliveryVerdict', () => {
    test('fails when regression gate blocks delivery', () => {
      const verdict = buildHarnessDeliveryVerdict({
        loopResult: { iterations: 2 },
        regressionGateReport: {
          skipped: false,
          passed: false,
          summary: 'Regression gate blocked delivery.',
        },
        toolCallLog: [],
      });

      expect(verdict.verdict).toBe('fail');
      expect(verdict.blockedBy).toContain('regression_gate');
    });

    test('warns when delivery gate only has optional warnings', () => {
      const verdict = buildHarnessDeliveryVerdict({
        loopResult: { iterations: 2 },
        deliveryGateReport: {
          verdict: 'warn',
          passed: true,
          summary: 'Delivery gate WARN.',
          projectRoot: tmpDir,
          missing: [],
          warnings: [{ id: 'test_assets' }],
        },
        toolCallLog: [],
      });

      expect(verdict.verdict).toBe('warn');
      expect(verdict.needsHumanReview).toBe(true);
      expect(verdict.warningSources).toContain('delivery_gate');
    });
  });
});

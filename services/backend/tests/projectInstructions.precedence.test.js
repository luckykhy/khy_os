'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('project instruction precedence', () => {
  let tmpRoot;
  let originalHome;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-instructions-'));
    originalHome = process.env.HOME;
    process.env.HOME = tmpRoot;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  test('orders KHY instructions before CLAUDE and AGENTS instructions', () => {
    const projectDir = path.join(tmpRoot, 'repo');
    fs.mkdirSync(projectDir, { recursive: true });

    fs.writeFileSync(path.join(projectDir, 'khy.md'), 'KHY instruction wins');
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), 'CLAUDE instruction second');
    fs.writeFileSync(path.join(projectDir, 'AGENTS.md'), 'AGENTS instruction fallback');

    const childProcess = require('child_process');
    const originalExecSync = childProcess.execSync;
    childProcess.execSync = (cmd, opts = {}) => {
      if (String(cmd).includes('git rev-parse --show-toplevel')) {
        return `${projectDir}\n`;
      }
      return originalExecSync(cmd, opts);
    };

    try {
      delete require.cache[require.resolve('../src/constants/prompts')];
      const { getProjectInstructionsSection } = require('../src/constants/prompts');
      const section = getProjectInstructionsSection(projectDir);

      assert.ok(section, 'expected project instructions section');

      const khyIndex = section.indexOf('KHY instruction wins');
      const claudeIndex = section.indexOf('CLAUDE instruction second');
      const agentsIndex = section.indexOf('AGENTS instruction fallback');

      assert.notEqual(khyIndex, -1, 'missing khy instructions');
      assert.notEqual(claudeIndex, -1, 'missing claude instructions');
      assert.notEqual(agentsIndex, -1, 'missing agents instructions');

      assert.ok(khyIndex < claudeIndex, 'khy instructions should come before claude instructions');
      assert.ok(claudeIndex < agentsIndex, 'claude instructions should come before agents instructions');
    } finally {
      childProcess.execSync = originalExecSync;
    }
  });

  test('loads .claude/CLAUDE.md before AGENTS.md when both exist', () => {
    const projectDir = path.join(tmpRoot, 'repo-nested');
    const claudeDir = path.join(projectDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });

    fs.writeFileSync(path.join(projectDir, 'khy.md'), 'KHY root instruction');
    fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), 'Nested CLAUDE instruction');
    fs.writeFileSync(path.join(projectDir, 'AGENTS.md'), 'Root AGENTS instruction');

    const childProcess = require('child_process');
    const originalExecSync = childProcess.execSync;
    childProcess.execSync = (cmd, opts = {}) => {
      if (String(cmd).includes('git rev-parse --show-toplevel')) {
        return `${projectDir}\n`;
      }
      return originalExecSync(cmd, opts);
    };

    try {
      delete require.cache[require.resolve('../src/constants/prompts')];
      const { getProjectInstructionsSection } = require('../src/constants/prompts');
      const section = getProjectInstructionsSection(projectDir);

      assert.ok(section, 'expected project instructions section');

      const khyIndex = section.indexOf('KHY root instruction');
      const claudeIndex = section.indexOf('Nested CLAUDE instruction');
      const agentsIndex = section.indexOf('Root AGENTS instruction');

      assert.notEqual(khyIndex, -1, 'missing khy instructions');
      assert.notEqual(claudeIndex, -1, 'missing nested claude instructions');
      assert.notEqual(agentsIndex, -1, 'missing agents instructions');

      assert.ok(khyIndex < claudeIndex, 'khy instructions should come before nested claude instructions');
      assert.ok(claudeIndex < agentsIndex, 'nested claude instructions should come before agents instructions');
    } finally {
      childProcess.execSync = originalExecSync;
    }
  });

  test('khy language rules override lower-priority compat language locks', () => {
    const projectDir = path.join(tmpRoot, 'repo-language');
    fs.mkdirSync(projectDir, { recursive: true });

    fs.writeFileSync(path.join(projectDir, 'khy.md'), [
      '# KHY Project Instructions',
      '',
      '## Language',
      '',
      '- Use Chinese by default for all user-facing replies.',
      '- If the user explicitly requests another language, follow the user\'s request.',
    ].join('\n'));

    fs.writeFileSync(path.join(projectDir, 'AGENTS.md'), [
      '## LANGUAGE LOCK',
      '',
      '1. Output language must be strictly English.',
      '2. Do not output any non-English natural language under any circumstance.',
      '',
      '> Sorry, I can only respond in English. Please continue in English.',
    ].join('\n'));

    const childProcess = require('child_process');
    const originalExecSync = childProcess.execSync;
    childProcess.execSync = (cmd, opts = {}) => {
      if (String(cmd).includes('git rev-parse --show-toplevel')) {
        return `${projectDir}\n`;
      }
      return originalExecSync(cmd, opts);
    };

    try {
      delete require.cache[require.resolve('../src/constants/prompts')];
      const { getProjectInstructionsSection } = require('../src/constants/prompts');
      const section = getProjectInstructionsSection(projectDir);

      assert.ok(section, 'expected project instructions section');
      assert.match(section, /Use Chinese by default for all user-facing replies\./);
      assert.ok(!section.includes('Output language must be strictly English.'), 'lower-priority English-only lock should be removed');
      assert.ok(!section.includes('Sorry, I can only respond in English.'), 'lower-priority refusal template should be removed');
      assert.match(section, /LANGUAGE LOCK REMOVED|LANGUAGE SECTION REMOVED/);
    } finally {
      childProcess.execSync = originalExecSync;
    }
  });
});

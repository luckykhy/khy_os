'use strict';

/**
 * platformCapabilities.branchGuidance.test.js
 *
 * Contract for the per-OS "optimal path" capability layer that lets khy leverage
 * the host OS natively. Pins:
 *   1. Each branch (Windows/Linux/macOS) names that platform's native tooling and
 *      its prohibitions, and never leaks another platform's service manager.
 *   2. An unrecognized platform degrades to portable cross-platform guidance only.
 *   3. The guidance is GROUNDED in the real probe (the live host's branch only
 *      recommends tools that are actually present — no phantom recommendations).
 *   4. getEnvironmentSection() injects the branch guidance and, on the real host,
 *      contains no duplicated platform headers.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const pc = require('../../src/services/platformCapabilities');

describe('platformCapabilities.branchGuidance (per-OS optimal path)', () => {
  test('Windows branch: cmd.exe rules + optimal path, no sudo, no systemctl', () => {
    const g = pc.branchGuidance('win32').join('\n');
    assert.match(g, /Windows Platform Rules/);
    assert.match(g, /Windows Optimal Path/);
    assert.match(g, /service management/i);
    assert.match(g, /never use `sudo`/);
    assert.doesNotMatch(g, /systemctl/, 'Windows guidance must not mention systemctl');
    assert.doesNotMatch(g, /launchctl/, 'Windows guidance must not mention launchctl');
  });

  test('Linux branch: systemctl/journalctl, prefers bash, no registry/launchctl', () => {
    const g = pc.branchGuidance('linux').join('\n');
    assert.match(g, /Linux Optimal Path/);
    assert.match(g, /systemctl/);
    assert.match(g, /bash/);
    assert.doesNotMatch(g, /launchctl/, 'Linux guidance must not mention launchctl');
    assert.match(g, /do not use Windows registry/i, 'Linux must steer away from registry ops');
  });

  test('macOS branch: launchctl (not systemctl), zsh, Xcode/sign concepts', () => {
    const g = pc.branchGuidance('darwin').join('\n');
    assert.match(g, /macOS Optimal Path/);
    assert.match(g, /launchctl/);
    assert.match(g, /zsh/);
    // macOS must steer AWAY from systemctl — only as an explicit "Avoid" note.
    assert.doesNotMatch(g, /use `systemctl`/i, 'macOS must not recommend systemctl');
  });

  test('unrecognized platform → portable generic guidance only', () => {
    const g = pc.branchGuidance('sunos').join('\n');
    assert.match(g, /unrecognized OS/i);
    assert.match(g, /Node\.js/);
    assert.doesNotMatch(g, /systemctl|launchctl|cmd\.exe/, 'generic must not assume an OS');
  });

  test('guidance is grounded in the real probe (live host branch is non-empty and self-consistent)', () => {
    const caps = pc.getCapabilities();
    const liveBranch = caps.platform === 'win32' ? 'win32'
      : caps.platform === 'darwin' ? 'darwin'
        : caps.platform === 'linux' ? 'linux' : caps.platform;
    const g = pc.branchGuidance(liveBranch);
    assert.ok(Array.isArray(g) && g.length > 0, 'live host must yield guidance');
    // If docker was NOT probed as present, the live branch must not claim it is.
    if (!caps.hasDocker) {
      assert.doesNotMatch(g.join('\n'), /`docker` is available/, 'must not recommend absent docker');
    }
  });
});

describe('getEnvironmentSection integration', () => {
  test('injects the host branch guidance with no duplicated platform header', () => {
    const { getEnvironmentSection } = require('../../src/constants/prompts');
    const section = getEnvironmentSection('test-model', process.cwd());
    assert.match(section, /# Environment/);
    // The live host's Optimal Path block must be present.
    const caps = pc.getCapabilities();
    if (caps.platform === 'linux') {
      assert.match(section, /Linux Optimal Path/);
      // env_info must not double-print a header.
      const count = (section.match(/Linux Optimal Path/g) || []).length;
      assert.equal(count, 1, 'branch header must appear exactly once');
    } else if (caps.platform === 'darwin') {
      assert.match(section, /macOS Optimal Path/);
    }
  });
});

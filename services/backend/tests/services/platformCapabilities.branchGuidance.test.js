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
 *      recommends tools that are actually present â€?no phantom recommendations).
 *   4. getEnvironmentSection() injects the branch guidance and, on the real host,
 *      contains no duplicated platform headers.
 */
const pc = require('../../src/services/platformCapabilities');
describe('platformCapabilities.branchGuidance (per-OS optimal path)', () => {
});
describe('getEnvironmentSection integration', () => {
});

describe('Platform Capabilities branch Guidance', () => {
  test('Windows branch: cmd.exe rules + optimal path, no sudo, no systemctl', () => {
        const g = pc.branchGuidance('win32').join('\n');
        expect(g).toMatch(/Windows Platform Rules/);
        expect(g).toMatch(/Windows Optimal Path/);
        expect(g).toMatch(/service management/i);
        expect(g).toMatch(/never use `sudo`/);
        expect(g).not.toMatch(/systemctl/);
        expect(g).not.toMatch(/launchctl/);
  });

  test('Linux branch: systemctl/journalctl, prefers bash, no registry/launchctl', () => {
        const g = pc.branchGuidance('linux').join('\n');
        expect(g).toMatch(/Linux Optimal Path/);
        expect(g).toMatch(/systemctl/);
        expect(g).toMatch(/bash/);
        expect(g).not.toMatch(/launchctl/);
        expect(g).toMatch(/do not use Windows registry/i);
  });

  test('macOS branch: launchctl (not systemctl), zsh, Xcode/sign concepts', () => {
        const g = pc.branchGuidance('darwin').join('\n');
        expect(g).toMatch(/macOS Optimal Path/);
        expect(g).toMatch(/launchctl/);
        expect(g).toMatch(/zsh/);
        // macOS must steer AWAY from systemctl â€?only as an explicit "Avoid" note.
        expect(g).not.toMatch(/use `systemctl`/i);
  });

  test('unrecognized platform â†?portable generic guidance only', () => {
        const g = pc.branchGuidance('sunos').join('\n');
        expect(g).toMatch(/unrecognized OS/i);
        expect(g).toMatch(/Node\.js/);
        expect(g).not.toMatch(/systemctl|launchctl|cmd\.exe/);
  });

  test('guidance is grounded in the real probe (live host branch is non-empty and self-consistent)', () => {
        const caps = pc.getCapabilities();
        const liveBranch = caps.platform === 'win32' ? 'win32'
          : caps.platform === 'darwin' ? 'darwin'
            : caps.platform === 'linux' ? 'linux' : caps.platform;
        const g = pc.branchGuidance(liveBranch);
        expect(Array.isArray(g) && g.length > 0).toBeTruthy();
        // If docker was NOT probed as present, the live branch must not claim it is.
        if (!caps.hasDocker) {
          expect(g.join('\n')).not.toMatch(/`docker` is available/);
        }
  });

  test('injects the host branch guidance with no duplicated platform header', () => {
        const { getEnvironmentSection } = require('../../src/constants/prompts');
        const section = getEnvironmentSection('test-model', process.cwd());
        expect(section).toMatch(/# Environment/);
        // The live host's Optimal Path block must be present.
        const caps = pc.getCapabilities();
        if (caps.platform === 'linux') {
          expect(section).toMatch(/Linux Optimal Path/);
          // env_info must not double-print a header.
          const count = (section.match(/Linux Optimal Path/g) || []).length;
          expect(count).toBe(1);
        } else if (caps.platform === 'darwin') {
          expect(section).toMatch(/macOS Optimal Path/);
        }
  });

});


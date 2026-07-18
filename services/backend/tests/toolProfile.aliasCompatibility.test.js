'use strict';

const { getProfileTools, filterToolsByProfile, PROFILES } = require('../src/tools/toolProfile');

describe('tool profile alias compatibility', () => {
  test('coding profile resolves canonical snake_case tool names', () => {
    const tools = getProfileTools('coding');
    expect(Array.isArray(tools)).toBe(true);
    expect(tools).toContain('build_project');
    expect(tools).toContain('run_tests');
    expect(tools).toContain('lint_code');
    expect(tools).toContain('verify_artifact');
  });

  test('filterToolsByProfile keeps canonical tools even if profile includes legacy names', () => {
    const registry = new Map([
      ['build_project', { aliases: ['buildProject'] }],
      ['run_tests', { aliases: ['runTests'] }],
      ['lint_code', { aliases: ['lintCode'] }],
      ['verify_artifact', { aliases: ['verifyArtifact'] }],
      ['shellCommand', { aliases: [] }],
    ]);

    const filtered = filterToolsByProfile(registry, 'coding');
    expect(filtered.has('build_project')).toBe(true);
    expect(filtered.has('run_tests')).toBe(true);
    expect(filtered.has('lint_code')).toBe(true);
    expect(filtered.has('verify_artifact')).toBe(true);
    expect(filtered.has('shellCommand')).toBe(true);
  });

  test('coding profile declaration keeps backward compatibility entries', () => {
    const declared = PROFILES.coding.tools;
    expect(declared).toContain('buildProject');
    expect(declared).toContain('runTests');
    expect(declared).toContain('lintCode');
    expect(declared).toContain('verifyArtifact');
  });
});

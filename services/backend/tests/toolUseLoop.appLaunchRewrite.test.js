'use strict';

describe('toolUseLoop app launch rewrite', () => {
  afterEach(() => {
    jest.resetModules();
  });

  test('rewrites shell app probe to open_app for app-launch requests', () => {
    const toolUseLoop = require('../src/services/toolUseLoop');
    const calls = [
      {
        name: 'shell_command',
        params: { command: 'which libreoffice inkscape okular master-pdf-editor 2>/dev/null | head -n 1' },
      },
    ];

    const rewritten = toolUseLoop._rewriteShellCallsForAppLaunch(calls, '打开一个能编辑pdf的工具');
    expect(rewritten[0].name).toBe('open_app');
    expect(rewritten[0].params).toEqual({ name: 'libreoffice' });
    expect(rewritten[0]._compatRewritten).toBe(true);
  });

  test('does not rewrite unrelated shell commands', () => {
    const toolUseLoop = require('../src/services/toolUseLoop');
    const calls = [
      {
        name: 'shell_command',
        params: { command: 'ls -la' },
      },
    ];

    const rewritten = toolUseLoop._rewriteShellCallsForAppLaunch(calls, '打开一个能编辑pdf的工具');
    expect(rewritten[0].name).toBe('shell_command');
    expect(rewritten[0].params).toEqual({ command: 'ls -la' });
  });

  test('extracts app target from fuzzy user request', () => {
    const toolUseLoop = require('../src/services/toolUseLoop');
    const target = toolUseLoop._extractAppTargetFromUserMessage('打开飞书');
    expect(target).toBe('飞书');
  });
});

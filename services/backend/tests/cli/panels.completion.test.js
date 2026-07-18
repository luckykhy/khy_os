'use strict';

const { printCompletionPanel } = require('../../src/cli/panels');

function stripAnsi(text = '') {
  return String(text).replace(/\x1b\[[0-9;]*m/g, '');
}

describe('completion panel file operations', () => {
  test('renders rename, move, and delete sections', () => {
    const lines = [];
    const spy = jest.spyOn(console, 'log').mockImplementation((...args) => {
      lines.push(args.join(' '));
    });

    try {
      printCompletionPanel({
        success: true,
        fileChanges: [
          { path: '/tmp/edited.js', operation: 'modify', diff: '+1/-0' },
          { path: '/tmp/new-file.js', operation: 'create', diff: '2 行' },
          {
            path: '/tmp/new-name.js',
            operation: 'rename',
            fromPath: '/tmp/old-name.js',
            toPath: '/tmp/new-name.js',
          },
          {
            path: '/tmp/feature/next-entry.js',
            operation: 'move',
            fromPath: '/tmp/legacy/entry.js',
            toPath: '/tmp/feature/next-entry.js',
          },
          { path: '/tmp/removed.js', operation: 'delete' },
        ],
      });
    } finally {
      spy.mockRestore();
    }

    const plain = stripAnsi(lines.join('\n'));
    expect(plain).toContain('改动');
    expect(plain).toContain('新建');
    expect(plain).toContain('重命名');
    expect(plain).toContain('移动');
    expect(plain).toContain('删除');
    expect(plain).toContain('old-name.js → new-name.js');
    expect(plain).toContain('entry.js → next-entry.js');
    expect(plain).toContain('removed.js');
  });
});

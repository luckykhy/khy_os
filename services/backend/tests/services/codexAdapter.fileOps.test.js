'use strict';

const { __test__ } = require('../../src/services/gateway/adapters/codexAdapter');

describe('codexAdapter file operation tracking', () => {
  test('extracts rename and delete operations from shell commands', () => {
    const ops = __test__.extractTrackedFileOpsFromShellCommand(
      'mv src/old-name.js src/new-name.js && rm -f src/removed.js'
    );

    expect(ops).toEqual(expect.arrayContaining([
      expect.objectContaining({
        operation: 'rename',
        path: 'src/new-name.js',
        fromPath: 'src/old-name.js',
        toPath: 'src/new-name.js',
      }),
      expect.objectContaining({
        operation: 'delete',
        path: 'src/removed.js',
        fromPath: 'src/removed.js',
      }),
    ]));
  });

  test('infers declared move operation from generic file op item', () => {
    const ops = __test__.inferTrackedFileOps('file_op', {
      operation: 'move',
      from_path: 'src/legacy/config.js',
      to_path: 'config/runtime/config.js',
    }, 'file_op');

    expect(ops).toEqual([
      expect.objectContaining({
        operation: 'move',
        path: 'config/runtime/config.js',
        fromPath: 'src/legacy/config.js',
        toPath: 'config/runtime/config.js',
      }),
    ]);
  });
});

'use strict';

const shellCommandTool = require('../src/tools/shellCommand');

describe('shellCommand idle timeout behavior', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  test('keeps running when command has continuous output (activity-based timeout)', async () => {
    process.env.KHY_SHELL_IDLE_TIMEOUT_ENABLED = 'true';
    process.env.KHY_SHELL_IDLE_TIMEOUT_MS = '250';

    const script = [
      'for i in 1 2 3 4 5; do',
      '  echo "tick-$i";',
      '  sleep 0.05;',
      'done',
    ].join(' ');

    const result = await shellCommandTool.execute(
      { command: script, idleTimeout: 250 },
      {}
    );

    expect(result.success).toBe(true);
    expect(String(result.output || '')).toContain('tick-1');
    expect(String(result.output || '')).toContain('tick-5');
  });
});


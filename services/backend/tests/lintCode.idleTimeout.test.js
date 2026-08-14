'use strict';

const lintCodeTool = require('../src/tools/lintCode');

describe('lint_code timeout and exit semantics', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  test('marks non-zero command exit as failed even when parser finds no issues', async () => {
    const result = await lintCodeTool.execute(
      {
        command: 'node -e "process.exit(2)"',
      },
      {}
    );

    expect(result.success).toBe(false);
    expect(result.data.linter).toBe('custom');
    expect(result.data.exitCode).toBe(2);
  });

  test('keeps alive with periodic output and reports progress callbacks', async () => {
    process.env.KHY_LINT_IDLE_TIMEOUT_MS = '120';
    const progressEvents = [];
    const activityEvents = [];

    const result = await lintCodeTool.execute(
      {
        command: [
          'node -e',
          '"let i=0;const t=setInterval(()=>{console.log(\'lint-tick-\'+(++i));if(i>=7){clearInterval(t);process.exit(0);}},35);"',
        ].join(' '),
        idleTimeout: 120,
      },
      {
        onProgress: (msg) => progressEvents.push(String(msg || '')),
        onActivity: (evt) => activityEvents.push(evt),
      }
    );

    expect(result.success).toBe(true);
    expect(result.data.linter).toBe('custom');
    expect(result.data.exitCode).toBe(0);
    expect(result.data.idleTimeoutMs).toBe(120);
    expect(progressEvents.some((s) => s.includes('lint_code stdout'))).toBe(true);
    expect(activityEvents.some((evt) => evt && evt.phase === 'stdout')).toBe(true);
  });

  test('fails when command stays silent beyond idle timeout', async () => {
    const result = await lintCodeTool.execute(
      {
        command: 'node -e "setTimeout(() => process.exit(0), 260)"',
        idleTimeout: 90,
      },
      {}
    );

    expect(result.success).toBe(false);
    expect(result.data.exitCode).toBe(1);
  });
});

'use strict';

const runTestsTool = require('../src/tools/runTests');

describe('run_tests idle timeout behavior', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  test('keeps running when command keeps producing output', async () => {
    process.env.KHY_RUN_TESTS_IDLE_TIMEOUT_MS = '120';
    const progressEvents = [];
    const activityEvents = [];

    const command = [
      'node -e',
      '"let i=0;const t=setInterval(()=>{console.log(\'tick-\'+(++i));if(i>=8){clearInterval(t);process.exit(0);}},40);"',
    ].join(' ');

    const result = await runTestsTool.execute(
      { command, idleTimeout: 120 },
      {
        onProgress: (msg) => progressEvents.push(String(msg || '')),
        onActivity: (evt) => activityEvents.push(evt),
      }
    );

    expect(result.success).toBe(true);
    expect(result.data.exitCode).toBe(0);
    expect(String(result.data.outputTail || '')).toContain('tick-8');
    expect(progressEvents.some((s) => s.includes('run_tests stdout'))).toBe(true);
    expect(activityEvents.some((evt) => evt && evt.phase === 'stdout')).toBe(true);
  });

  test('fails when command is silent longer than idle timeout', async () => {
    process.env.KHY_RUN_TESTS_IDLE_TIMEOUT_MS = '100';

    const command = 'node -e "setTimeout(() => process.exit(0), 280)"';
    const result = await runTestsTool.execute({ command, idleTimeout: 100 }, {});

    expect(result.success).toBe(false);
    expect(result.data.exitCode).toBe(1);
    expect(String(result.data.outputTail || '').length).toBeGreaterThan(0);
  });
});

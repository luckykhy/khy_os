'use strict';

const buildProjectTool = require('../src/tools/buildProject');

describe('build_project idle timeout behavior', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  test('keeps running when build command keeps producing output', async () => {
    process.env.KHY_BUILD_IDLE_TIMEOUT_MS = '120';
    const progressEvents = [];
    const activityEvents = [];

    const command = [
      'node -e',
      '"let i=0;const t=setInterval(()=>{console.log(\'build-tick-\'+(++i));if(i>=8){clearInterval(t);process.exit(0);}},35);"',
    ].join(' ');

    const result = await buildProjectTool.execute(
      { command, idleTimeout: 120 },
      {
        onProgress: (msg) => progressEvents.push(String(msg || '')),
        onActivity: (evt) => activityEvents.push(evt),
      }
    );

    expect(result.success).toBe(true);
    expect(result.data.exitCode).toBe(0);
    expect(result.data.idleTimeoutMs).toBe(120);
    expect(String(result.data.outputTail || '')).toContain('build-tick-8');
    expect(progressEvents.some((s) => s.includes('build_project stdout'))).toBe(true);
    expect(activityEvents.some((evt) => evt && evt.phase === 'stdout')).toBe(true);
  });

  test('fails when command stays silent beyond idle timeout', async () => {
    const result = await buildProjectTool.execute(
      {
        command: 'node -e "setTimeout(() => process.exit(0), 260)"',
        idleTimeout: 90,
      },
      {}
    );

    expect(result.success).toBe(false);
    expect(result.data.exitCode).toBe(1);
    expect(String(result.data.outputTail || '').length).toBeGreaterThan(0);
  });
});

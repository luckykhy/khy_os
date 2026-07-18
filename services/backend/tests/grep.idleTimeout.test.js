'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const grepTool = require('../src/tools/grep');

function mkTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('grep idle timeout behavior', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  test('returns no matches successfully for missing pattern', async () => {
    const dir = mkTmpDir('khy-grep-none-');
    const file = path.join(dir, 'a.txt');
    fs.writeFileSync(file, 'hello world\nline2\n', 'utf8');

    const result = await grepTool.execute({
      pattern: 'definitely_not_found_12345',
      path: dir,
      output_mode: 'content',
      idleTimeout: 300,
    }, {});

    expect(result.success).toBe(true);
    expect(result.count).toBe(0);
  });

  test('reports progress/activity during grep execution', async () => {
    const dir = mkTmpDir('khy-grep-progress-');
    const file = path.join(dir, 'b.txt');
    const lines = [];
    for (let i = 0; i < 800; i++) lines.push(`line-${i} target-${i % 7}`);
    fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');

    const progressEvents = [];
    const activityEvents = [];
    const result = await grepTool.execute({
      pattern: 'target-3',
      path: dir,
      output_mode: 'content',
      max_results: 30,
      idleTimeout: 300,
    }, {
      onProgress: (msg) => progressEvents.push(String(msg || '')),
      onActivity: (evt) => activityEvents.push(evt),
    });

    expect(result.success).toBe(true);
    expect(result.count).toBeGreaterThan(0);
    expect(progressEvents.some((s) => s.includes('grep stdout') || s.includes('grep stderr'))).toBe(true);
    expect(activityEvents.some((evt) => evt && (evt.phase === 'stdout' || evt.phase === 'stderr' || evt.phase === 'close'))).toBe(true);
  });
});

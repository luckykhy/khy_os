'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const grepTool = require('../src/tools/grep');

function mkTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// idleTimeout 是「多久没有新输出就杀进程」的空闲窗口，不是总墙钟上限（见 grep.js 的
// 参数说明）。这两例断言的是「正常 grep 能成功返回 / 会上报进度与活动事件」，都不断言
// 超时发生。原来写 300ms 等于给「spawn 起来、走完目录、退出」定了一条 300ms 的死线 ——
// 尤其第一例整趟没有任何输出，空闲窗口从 spawn 起就开始走。本机够快，ubuntu runner 上
// 多 worker 争 CPU 时经常超线被杀，于是 result.success 为 false，门禁上时红时绿。改用
// 工具的默认值 15000ms：被测行为一字不改，只是不再拿一条随负载浮动的死线当断言前提。
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
      idleTimeout: 15000,
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
      idleTimeout: 15000,
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

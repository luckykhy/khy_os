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

    const nodeScript = [
      'let i = 0;',
      'const timer = setInterval(() => {',
      '  i += 1;',
      // 这段 node -e 片段最终会被拼进一条 shell 命令行，所以里面既不能有反引号也
      // 不能有 ${}：Linux 上走 /bin/bash，双引号内的反引号是命令替换、${i} 是 shell
      // 变量展开，bash 会先去执行 `tick-` 并报 "tick-: command not found"，node 拿到的
      // 是空串。Windows 的 cmd 把两者都当字面量，所以本机看不出来。字符串拼接两边都安全。
      // 片段本身也不能用双引号（会截断外层 -e "..." 的引号），只能用单引号。
      "  console.log('tick-' + i);",
      '  if (i === 5) clearInterval(timer);',
      '}, 50);',
    ].join(' ');
    const script = `"${process.execPath}" -e "${nodeScript}"`;

    const result = await shellCommandTool.execute(
      { command: script, idleTimeout: 250 },
      {}
    );

    expect(result.success).toBe(true);
    expect(String(result.output || '')).toContain('tick-1');
    expect(String(result.output || '')).toContain('tick-5');
  });
});


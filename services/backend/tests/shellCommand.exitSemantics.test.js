'use strict';

// 端到端验证 shellCommand 主路径(默认 spawn path)对齐 CC 退出码语义:
// grep 无匹配(exit 1)→ success:true + _exitNote「No matches found」,而非命令失败。
const shellCommandTool = require('../src/tools/shellCommand');

const HAS_GREP = process.platform !== 'win32';
const d = HAS_GREP ? describe : describe.skip;

d('shellCommand exit-code semantics (CC commandSemantics parity)', () => {
  const originalEnv = { ...process.env };
  afterEach(() => { process.env = { ...originalEnv }; });

  test('grep 无匹配(exit 1)默认门控开 → success:true + No matches found', async () => {
    const result = await shellCommandTool.execute(
      { command: "printf 'hello\\nworld\\n' | grep zzz_no_such_pattern" },
      {}
    );
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result._exitNote).toBe('No matches found');
    // stdout 为空时把 note 落到 output,模型看到的是 No matches found 而非空串
    expect(String(result.output || '')).toContain('No matches found');
    expect(result.error).toBeUndefined();
  });

  test('grep 有匹配(exit 0)→ success:true,输出含匹配行,无 note', async () => {
    const result = await shellCommandTool.execute(
      { command: "printf 'hello\\nworld\\n' | grep world" },
      {}
    );
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(String(result.output || '')).toContain('world');
    expect(result._exitNote).toBeUndefined();
  });

  test('门控关 KHY_SHELL_EXIT_SEMANTICS=0 → grep 无匹配逐字节回退 success:false', async () => {
    process.env.KHY_SHELL_EXIT_SEMANTICS = '0';
    const result = await shellCommandTool.execute(
      { command: "printf 'hi\\n' | grep zzz_no_such_pattern" },
      {}
    );
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result._exitNote).toBeUndefined();
    expect(result.error).toBeDefined();
  });

  test('未知命令真失败(exit≠0)仍 success:false(语义不放宽真错误)', async () => {
    const result = await shellCommandTool.execute(
      { command: "sh -c 'exit 3'" },
      {}
    );
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(3);
  });
});

// Unit tests for the key-findings reporter (milestone-level "关键节点主动汇报").
// Pure + env-free module, so no gateway/network/loop is needed — every function
// takes an explicit `env` arg so switches are deterministic.

const kf = require('../../src/cli/keyFindings');

const ON = {}; // empty env → all gates default ON

describe('detectTestOutcome — deterministic test-runner parsing', () => {
  test('jest green: passed + total, no failures', () => {
    const out = `PASS  tests/foo.test.js\nTests:       23 passed, 23 total\nSnapshots:   0 total\nTime:        1.2 s`;
    const f = kf.detectTestOutcome('bash', { command: 'node node_modules/jest/bin/jest.js' }, { output: out, exitCode: 0 }, ON);
    expect(f).toMatchObject({ kind: 'test', framework: 'jest', passed: 23, failed: 0, total: 23, green: true });
    expect(f.failures).toEqual([]);
  });

  test('jest red: failed count + failing names, green=false', () => {
    const out = [
      'FAIL  tests/bar.test.js',
      '  ● Suite › does the thing',
      '  ✕ another case',
      'Tests:       1 failed, 22 passed, 23 total',
    ].join('\n');
    const f = kf.detectTestOutcome('shell', { command: 'jest' }, { output: out, exitCode: 1 }, ON);
    expect(f.green).toBe(false);
    expect(f.failed).toBe(1);
    expect(f.passed).toBe(22);
    expect(f.failures.length).toBeGreaterThanOrEqual(1);
  });

  test('pytest summary', () => {
    const out = [
      'FAILED tests/test_api.py::test_login',
      '==== 1 failed, 22 passed in 0.42s ====',
    ].join('\n');
    const f = kf.detectTestOutcome('bash', { command: 'pytest -q' }, { output: out, exitCode: 1 }, ON);
    expect(f.framework).toBe('pytest');
    expect(f.passed).toBe(22);
    expect(f.failed).toBe(1);
    expect(f.failures).toContain('tests/test_api.py::test_login');
  });

  test('go test', () => {
    const out = ['--- PASS: TestAlpha (0.00s)', '--- FAIL: TestBeta (0.01s)', 'FAIL', 'exit status 1'].join('\n');
    const f = kf.detectTestOutcome('bash', { command: 'go test ./...' }, { output: out, exitCode: 1 }, ON);
    expect(f.framework).toBe('go');
    expect(f.passed).toBe(1);
    expect(f.failed).toBe(1);
    expect(f.failures).toContain('TestBeta');
  });

  test('cargo test green', () => {
    const out = 'running 5 tests\ntest result: ok. 5 passed; 0 failed; 0 ignored; 0 measured';
    const f = kf.detectTestOutcome('bash', { command: 'cargo test' }, { output: out, exitCode: 0 }, ON);
    expect(f.framework).toBe('cargo');
    expect(f).toMatchObject({ passed: 5, failed: 0, green: true });
  });

  test('non-test commands return null', () => {
    expect(kf.detectTestOutcome('bash', { command: 'ls -la' }, { output: 'a\nb', exitCode: 0 }, ON)).toBeNull();
    expect(kf.detectTestOutcome('bash', { command: 'git status' }, { output: 'clean', exitCode: 0 }, ON)).toBeNull();
  });

  test('non-shell tools return null', () => {
    expect(kf.detectTestOutcome('read_file', { command: 'jest' }, { output: 'Tests: 1 passed, 1 total', exitCode: 0 }, ON)).toBeNull();
  });

  test('background run returns null', () => {
    expect(kf.detectTestOutcome('bash', { command: 'jest' }, { output: '', exitCode: 0, _background: true }, ON)).toBeNull();
  });

  test('no output falls back to exit code', () => {
    const f = kf.detectTestOutcome('bash', { command: 'jest' }, { exitCode: 0 }, ON);
    expect(f).toMatchObject({ kind: 'test', green: true, passed: null });
  });
});

describe('composeFindingReport — rendering', () => {
  test('green report', () => {
    const r = kf.composeFindingReport({ kind: 'test', passed: 23, failed: 0, total: 23, green: true, failures: [] });
    expect(r).toContain('✅');
    expect(r).toContain('23');
  });

  test('failure report lists names + next step, truncates to 5', () => {
    const failures = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const r = kf.composeFindingReport({ kind: 'test', passed: 1, failed: 7, total: 8, green: false, failures });
    expect(r).toContain('❌');
    expect(r).toContain('7 失败');
    expect(r).toContain('· a');
    expect(r).toContain('下一步');
    expect(r).toContain('还有 2 个'); // 7 - 5 truncated
    expect(r).not.toContain('· g');
  });

  test('non-test finding renders empty', () => {
    expect(kf.composeFindingReport({ kind: 'model', type: 'root_cause', text: 'x' })).toBe('');
  });
});

describe('model findings — parse / strip / compose', () => {
  const text = [
    'Some analysis before.',
    '<finding type="root_cause">空指针来自未初始化的 config 对象</finding>',
    'Middle text.',
    '<finding type="breakthrough">改用懒加载即可绕过循环依赖</finding>',
    '<finding type="blocked">缺少 API key，下一步：让用户配置网关密钥</finding>',
    'Tail.',
  ].join('\n');

  test('parseModelFindings extracts all three types in order', () => {
    const found = kf.parseModelFindings(text, ON);
    expect(found).toHaveLength(3);
    expect(found.map((f) => f.type)).toEqual(['root_cause', 'breakthrough', 'blocked']);
    expect(found[0].text).toContain('空指针');
    found.forEach((f) => expect(f.kind).toBe('model'));
  });

  test('stripFindings removes blocks, keeps prose', () => {
    const stripped = kf.stripFindings(text);
    expect(stripped).not.toContain('<finding');
    expect(stripped).not.toContain('空指针');
    expect(stripped).toContain('Some analysis before.');
    expect(stripped).toContain('Tail.');
  });

  test('composeModelFinding renders typed headers', () => {
    expect(kf.composeModelFinding({ kind: 'model', type: 'root_cause', text: 'X' })).toContain('🔎');
    expect(kf.composeModelFinding({ kind: 'model', type: 'breakthrough', text: 'X' })).toContain('💡');
    expect(kf.composeModelFinding({ kind: 'model', type: 'blocked', text: 'X' })).toContain('⛔');
    expect(kf.composeModelFinding({ kind: 'model', type: 'root_cause', text: '' })).toBe('');
  });

  test('parseModelFindings ignores unknown types', () => {
    expect(kf.parseModelFindings('<finding type="bogus">x</finding>', ON)).toEqual([]);
  });
});

describe('degenerate finding-body guard (fix "💡 突破：无")', () => {
  // The real transcript: a joke turn where the model dumped its reasoning into a
  // breakthrough tag, surfacing as the nonsense line "💡 突破：无，这是简单笑话请求".
  test('drops the exact transcript case', () => {
    const text = '<finding type="breakthrough">无，这是简单笑话请求</finding>';
    expect(kf.parseModelFindings(text, ON)).toEqual([]);
  });

  test('drops bare negation / placeholder bodies of every type', () => {
    for (const body of ['无', '没有', '暂无', '无明显', 'none', 'N/A', 'null', 'nothing', '无异常']) {
      for (const type of ['root_cause', 'breakthrough', 'blocked']) {
        const text = `<finding type="${type}">${body}</finding>`;
        expect(kf.parseModelFindings(text, ON)).toEqual([]);
      }
    }
  });

  test('drops leading-negation + punctuation ("无：…", "none: …")', () => {
    expect(kf.parseModelFindings('<finding type="breakthrough">无。这个不需要工具</finding>', ON)).toEqual([]);
    expect(kf.parseModelFindings('<finding type="root_cause">none: nothing to do here</finding>', ON)).toEqual([]);
  });

  test('drops explicit triviality notes', () => {
    expect(kf.parseModelFindings('<finding type="breakthrough">这是一个简单的请求</finding>', ON)).toEqual([]);
    expect(kf.parseModelFindings('<finding type="blocked">无需调用任何工具</finding>', ON)).toEqual([]);
    expect(kf.parseModelFindings('<finding type="root_cause">不需要执行命令</finding>', ON)).toEqual([]);
  });

  test('KEEPS real findings that merely contain a negation word mid-sentence', () => {
    const text = '<finding type="root_cause">空指针来自未初始化的 config，无默认值</finding>';
    const found = kf.parseModelFindings(text, ON);
    expect(found).toHaveLength(1);
    expect(found[0].text).toContain('空指针');
  });

  test('KEEPS all three genuine findings from the base fixture', () => {
    const text = [
      '<finding type="root_cause">空指针来自未初始化的 config 对象</finding>',
      '<finding type="breakthrough">改用懒加载即可绕过循环依赖</finding>',
      '<finding type="blocked">缺少 API key，下一步：让用户配置网关密钥</finding>',
    ].join('\n');
    expect(kf.parseModelFindings(text, ON)).toHaveLength(3);
  });

  test('mixed batch: degenerate dropped, real kept, order preserved', () => {
    const text = [
      '<finding type="breakthrough">无，这是简单笑话请求</finding>',
      '<finding type="root_cause">竞态来自共享的 mutable 缓存</finding>',
    ].join('\n');
    const found = kf.parseModelFindings(text, ON);
    expect(found).toHaveLength(1);
    expect(found[0].type).toBe('root_cause');
  });

  test('KHY_KEY_FINDINGS_DEGENERATE_GUARD=0 byte-reverts (degenerate passes through)', () => {
    const text = '<finding type="breakthrough">无，这是简单笑话请求</finding>';
    const env = { KHY_KEY_FINDINGS_DEGENERATE_GUARD: '0' };
    const found = kf.parseModelFindings(text, env);
    expect(found).toHaveLength(1);
    expect(found[0].text).toBe('无，这是简单笑话请求');
  });

  test('guard is a child of the model gate (KHY_KEY_FINDINGS_MODEL=0 → nothing parsed at all)', () => {
    const text = '<finding type="root_cause">竞态来自共享缓存</finding>';
    expect(kf.parseModelFindings(text, { KHY_KEY_FINDINGS_MODEL: '0' })).toEqual([]);
    expect(kf.degenerateGuardEnabled({ KHY_KEY_FINDINGS_MODEL: '0' })).toBe(false);
  });

  test('_isDegenerateFindingBody: unit truth table', () => {
    expect(kf._isDegenerateFindingBody('无')).toBe(true);
    expect(kf._isDegenerateFindingBody('无，这是简单笑话请求')).toBe(true);
    expect(kf._isDegenerateFindingBody('')).toBe(true);
    expect(kf._isDegenerateFindingBody('   ')).toBe(true);
    expect(kf._isDegenerateFindingBody('改用懒加载绕过循环依赖')).toBe(false);
    expect(kf._isDegenerateFindingBody('无默认值导致空指针')).toBe(false); // negation mid-meaning, no separator
  });

  test('instruction tells the model not to emit placeholder findings', () => {
    const ins = kf.buildKeyFindingsInstruction(ON);
    expect(ins).toContain('没有命中时不要输出');
  });
});


describe('env gates', () => {
  test('KHY_KEY_FINDINGS=0 disables everything', () => {
    const env = { KHY_KEY_FINDINGS: '0' };
    expect(kf.detectTestOutcome('bash', { command: 'jest' }, { output: 'Tests: 1 passed, 1 total', exitCode: 0 }, env)).toBeNull();
    expect(kf.parseModelFindings('<finding type="root_cause">x</finding>', env)).toEqual([]);
  });

  test('KHY_KEY_FINDINGS_TESTS=0 disables only test detection', () => {
    const env = { KHY_KEY_FINDINGS_TESTS: 'off' };
    expect(kf.detectTestOutcome('bash', { command: 'jest' }, { output: 'Tests: 1 passed, 1 total', exitCode: 0 }, env)).toBeNull();
    expect(kf.parseModelFindings('<finding type="root_cause">x</finding>', env)).toHaveLength(1);
  });

  test('KHY_KEY_FINDINGS_MODEL=0 disables only model findings', () => {
    const env = { KHY_KEY_FINDINGS_MODEL: 'false' };
    expect(kf.parseModelFindings('<finding type="root_cause">x</finding>', env)).toEqual([]);
    expect(kf.buildKeyFindingsInstruction(env)).toBe('');
    expect(kf.detectTestOutcome('bash', { command: 'jest' }, { output: 'Tests: 1 passed, 1 total', exitCode: 0 }, env)).not.toBeNull();
  });

  test('buildKeyFindingsInstruction includes all three markers when on', () => {
    const ins = kf.buildKeyFindingsInstruction(ON);
    expect(ins).toContain('root_cause');
    expect(ins).toContain('breakthrough');
    expect(ins).toContain('blocked');
  });
});

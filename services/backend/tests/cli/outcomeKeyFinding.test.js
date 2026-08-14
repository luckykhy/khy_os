'use strict';

/**
 * outcomeKeyFinding 叶子测试 —— 修「错误根因不会汇报」(2026-07-05 /goal)。
 *
 * salientErrorReason 从失败结果里抠一行根因给失败旁白汇报。契约:门控 CANON、零 IO、绝不抛;
 * 优先命名异常(traceback 取末条)→ 高频环境/姿势错签名 → 短单行 error 兜底;取不到 → null。
 */

const {
  salientErrorReason,
  rootCauseEnabled,
  _extractFromText,
} = require('../../src/cli/outcomeKeyFinding');

const FLAG = 'KHY_TOOL_OUTCOME_ROOT_CAUSE';

function withFlag(val, fn) {
  const prev = process.env[FLAG];
  if (val === undefined) delete process.env[FLAG];
  else process.env[FLAG] = val;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prev;
  }
}

describe('outcomeKeyFinding.rootCauseEnabled — 门控 CANON', () => {
  test('默认(未设)→ 开', () => {
    withFlag(undefined, () => expect(rootCauseEnabled(process.env)).toBe(true));
  });
  test('CANON 关词 0/false/off/no → 关', () => {
    for (const w of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
      withFlag(w, () => expect(rootCauseEnabled(process.env)).toBe(false));
    }
  });
  test('非 CANON 关词(disable/disabled)→ 仍开(CANON 只认 4 词)', () => {
    for (const w of ['disable', 'disabled']) {
      withFlag(w, () => expect(rootCauseEnabled(process.env)).toBe(true));
    }
  });
});

describe('outcomeKeyFinding._extractFromText — 根因提取', () => {
  test('命名异常:Python traceback 取最后一条(真正抛出的)', () => {
    const tb = [
      'Traceback (most recent call last):',
      '  File "app.py", line 3, in <module>',
      '    import flask',
      "ModuleNotFoundError: No module named 'flask'",
    ].join('\n');
    expect(_extractFromText(tb)).toBe("ModuleNotFoundError: No module named 'flask'");
  });

  test('多个具名异常 → 取末条', () => {
    const s = 'ValueError: bad\nlater...\nKeyError: missing';
    expect(_extractFromText(s)).toBe('KeyError: missing');
  });

  test('命令找不到(Windows 中文)签名', () => {
    expect(_extractFromText("'mvn' 不是内部或外部命令，也不是可运行的程序")).toContain('不是内部或外部命令');
  });

  test('command not found 签名', () => {
    expect(_extractFromText('bash: mvn: command not found')).toContain('command not found');
  });

  test('权限拒绝签名', () => {
    expect(_extractFromText('EACCES: permission denied, open /etc/x')).toMatch(/Permission denied|EACCES/i);
  });

  test('端口占用签名', () => {
    expect(_extractFromText('Error: listen EADDRINUSE: address already in use :::8080'))
      .toMatch(/EADDRINUSE|address already in use/i);
  });

  test('git fatal 签名', () => {
    expect(_extractFromText('fatal: not a git repository')).toBe('fatal: not a git repository');
  });

  test('无可识别根因 → 空串', () => {
    expect(_extractFromText('everything is fine, all green')).toBe('');
    expect(_extractFromText('')).toBe('');
  });

  test('超长行截断带省略号 ≤ 上限', () => {
    const long = 'error: ' + 'x'.repeat(500);
    const out = _extractFromText(long);
    expect(out.length).toBeLessThanOrEqual(140);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('outcomeKeyFinding.salientErrorReason — 端到端', () => {
  test('门控开 + error 里含 ModuleNotFound → 返回该行', () => {
    withFlag(undefined, () => {
      const r = salientErrorReason({
        success: false,
        error: "Traceback...\nModuleNotFoundError: No module named 'requests'",
      }, process.env);
      expect(r).toBe("ModuleNotFoundError: No module named 'requests'");
    });
  });

  test('门控开 + 根因只在 output(stdout+stderr)里 → 从正文取', () => {
    withFlag(undefined, () => {
      const r = salientErrorReason({
        success: false,
        error: '',
        output: 'building...\nfatal: pathspec did not match any files',
      }, process.env);
      expect(r).toBe('fatal: pathspec did not match any files');
    });
  });

  test('门控开 + error 是短单行普通语 → 兜底直接用', () => {
    withFlag(undefined, () => {
      const r = salientErrorReason({ success: false, error: 'connection reset by peer' }, process.env);
      expect(r).toBe('connection reset by peer');
    });
  });

  test('门控关(0)→ null(调用方走旧 canned 行)', () => {
    withFlag('0', () => {
      const r = salientErrorReason({
        success: false,
        error: "ModuleNotFoundError: No module named 'x'",
      }, process.env);
      expect(r).toBeNull();
    });
  });

  test('无根因可提取 → null', () => {
    withFlag(undefined, () => {
      expect(salientErrorReason({ success: false, error: '', output: 'ok done' }, process.env)).toBeNull();
    });
  });

  test('非对象结果 → null,绝不抛', () => {
    withFlag(undefined, () => {
      expect(salientErrorReason(null, process.env)).toBeNull();
      expect(salientErrorReason(undefined, process.env)).toBeNull();
      expect(salientErrorReason('boom', process.env)).toBeNull();
    });
  });
});

'use strict';

/**
 * pythonInvocationHint — 把两类高频 inline-python「姿势错」从裸报错升级成一句可操作修复指引。
 *
 * 回归目标(2026-07-04 会话现场,Windows agnes):
 *   ① `python3 -c "..."` → `'python3' 不是内部或外部命令`(Windows 无 python3,叫 python)。
 *   ② `python -c "... def load(p):"` → `SyntaxError: invalid syntax`(-c 单行不能塞 def/块)。
 * 两坑修复动作都不在 stderr 里 → 模型反复试错。本套件验证:命中两坑各给一句改法、
 * 只识别姿势错不猜逻辑错(KeyError 不追加)、门控关字节回退 null、fail-soft 绝不抛。
 *
 * node:test(jest 经 rtk 代理报 Exec format error 不可用)。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const mod = require('../../src/tools/pythonInvocationHint');

test('坑②:python -c 单行 def 块 SyntaxError → 指引改法(临时 .py / heredoc / 分号)', () => {
  const hint = mod.buildPythonInvocationHint(
    'python -c "import csv; def load(p): pass"',
    'SyntaxError: invalid syntax',
    {},
  );
  assert.ok(hint);
  assert.ok(/python -c/.test(hint));
  assert.ok(/\.py|heredoc|分号/.test(hint), '应给可操作改法');
});

test('坑③:python -c 漏 import(Python 给出建议)→ 指引补 import + 写临时 .py', () => {
  const hint = mod.buildPythonInvocationHint(
    'python -c "f=open(\'a.csv\'); csv.reader(f)"',
    "NameError: name 'csv' is not defined. Did you forget to import 'csv'?",
    {},
  );
  assert.ok(hint);
  assert.ok(/import csv/.test(hint), '应点名要补的模块');
  assert.ok(/\.py/.test(hint), '-c 形态应推向临时 .py 文件');
});

test('坑③:非 -c 脚本漏 import → 补 import 于顶部(不追加 -c 专属改法)', () => {
  const hint = mod.buildPythonInvocationHint(
    'python analyze.py',
    "NameError: name 'json' is not defined. Did you forget to import 'json'?",
    {},
  );
  assert.ok(hint);
  assert.ok(/import json/.test(hint));
});

test('坑③边界:裸 NameError(无 Python 建议)→ null(不臆测是否漏 import)', () => {
  assert.strictEqual(
    mod.buildPythonInvocationHint(
      'python -c "print(x)"',
      "NameError: name 'x' is not defined",
      {},
    ),
    null,
  );
});

test('坑①:python3 not-found → 指引用 python / py -3', () => {
  const hint = mod.buildPythonInvocationHint(
    'python3 -c "print(1)"',
    "'python3' 不是内部或外部命令",
    {},
  );
  assert.ok(hint);
  assert.ok(/python|py -3/.test(hint), '应指引改用 python 或 py -3');
});

test('坑①:英文 not recognized 签名也命中', () => {
  const hint = mod.buildPythonInvocationHint(
    'python3 script.py',
    "'python3' is not recognized as an internal or external command",
    {},
  );
  assert.ok(hint);
  assert.ok(/python|py -3/.test(hint));
});

test('两坑同时命中 → 合并成一行(含两句指引)', () => {
  const hint = mod.buildPythonInvocationHint(
    'python3 -c "def f(): pass"',
    "'python3' is not recognized; SyntaxError: invalid syntax",
    {},
  );
  assert.ok(hint);
  assert.ok(/python -c/.test(hint));
  assert.ok(/py -3|python/.test(hint));
});

test('只识别姿势错,不猜逻辑错:KeyError / 非 python 命令 → null', () => {
  // python -c 抛 KeyError 是脚本逻辑错(列名不对),不属本叶子
  assert.strictEqual(
    mod.buildPythonInvocationHint('python -c "import csv; d[\'x\']"', 'KeyError: \'x\'', {}),
    null,
  );
  // 非 python 命令
  assert.strictEqual(mod.buildPythonInvocationHint('node build.js', 'some error', {}), null);
  // python3 但报错不是 not-found(如权限错)→ 不追加 not-found 指引
  assert.strictEqual(
    mod.buildPythonInvocationHint('python3 ok.py', 'PermissionError: [Errno 13]', {}),
    null,
  );
});

test('门控关 → null(字节回退,不追加任何行)', () => {
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(
      mod.buildPythonInvocationHint('python -c "def f(): pass"', 'SyntaxError: invalid syntax', {
        KHY_PYTHON_INVOCATION_HINT: off,
      }),
      null,
      off,
    );
  }
});

test('pythonHintEnabled:默认开 + 关闭词表', () => {
  assert.strictEqual(mod.pythonHintEnabled({}), true);
  assert.strictEqual(mod.pythonHintEnabled({ KHY_PYTHON_INVOCATION_HINT: 'on' }), true);
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(mod.pythonHintEnabled({ KHY_PYTHON_INVOCATION_HINT: off }), false, off);
  }
});

test('fail-soft:异常 / 非字符串输入绝不抛', () => {
  for (const bad of [null, undefined, 123, {}, []]) {
    assert.doesNotThrow(() => mod.buildPythonInvocationHint(bad, bad, {}));
  }
});

test('LIVE wiring:shellDiagnostics.composeShellError 确实 require 本叶子', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../../src/tools/shellDiagnostics.js'),
    'utf8',
  );
  assert.ok(
    /require\(['"]\.\/pythonInvocationHint['"]\)/.test(src),
    'shellDiagnostics 应懒加载 pythonInvocationHint',
  );
  assert.ok(/buildPythonInvocationHint/.test(src), '应调用 buildPythonInvocationHint');
});

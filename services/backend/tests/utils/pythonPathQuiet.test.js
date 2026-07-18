'use strict';

/**
 * pythonPathQuiet — findPython() 解释器解析调试行的静默门控(KHY_PYTHON_PATH_QUIET)。
 *
 * /goal「同时减少显示的心灵噪音」:findPython() 每次为 OCR / 文档转换子进程解析解释器时,原本无条件
 * `console.log("Using Python executable: <绝对路径>")` 直冲用户终端(实测 vision→OCR 兜底一屏刷出
 * `Using Python executable: D:\Python312\python.exe` 并泄漏本机路径)——纯调试日志,从不为用户服务。
 *
 * 本套件验证(用真实 findPython(),不桩解析):
 *   ① 默认(门 default-on 静默)→ 解析成功时不打印任何 "Using Python executable" 行,但仍返回可用解释器。
 *   ② 门关(KHY_PYTHON_PATH_QUIET=off)→ 逐字节回退旧 verbose 行为,打印 "Using Python executable" 行。
 *   ③ 门控只影响可见性,绝不影响解析结果(两种档位返回同一 _cached 值)。
 *
 * 关键:findPython() 用模块级 `_cached` 缓存,一进程只解析一次 → 每个用例必须 delete require.cache
 * 重载模块,才能在不同 env 下重跑解析逻辑。
 *
 * node:test(jest 经 rtk 代理报 Exec format error 不可用)。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const MOD_PATH = require.resolve('../../src/utils/pythonPath');

// 每次全新加载 pythonPath 模块(清 _cached),并在受控 env 下捕获 console.log / console.warn。
function loadFreshAndResolve(envOverride) {
  const savedEnv = process.env.KHY_PYTHON_PATH_QUIET;
  const savedLog = console.log;
  const savedWarn = console.warn;
  const lines = [];
  console.log = (...a) => lines.push(a.join(' '));
  console.warn = (...a) => lines.push(a.join(' '));
  try {
    if (envOverride === undefined) delete process.env.KHY_PYTHON_PATH_QUIET;
    else process.env.KHY_PYTHON_PATH_QUIET = envOverride;
    delete require.cache[MOD_PATH];
    const mod = require('../../src/utils/pythonPath');
    const resolved = mod.findPython();
    return { resolved, lines };
  } finally {
    console.log = savedLog;
    console.warn = savedWarn;
    if (savedEnv === undefined) delete process.env.KHY_PYTHON_PATH_QUIET;
    else process.env.KHY_PYTHON_PATH_QUIET = savedEnv;
    delete require.cache[MOD_PATH]; // 别把测试污染的实例留给后续 require
  }
}

test('默认(门 default-on 静默)→ 不打印 "Using Python executable",仍返回可用解释器', () => {
  const { resolved, lines } = loadFreshAndResolve(undefined);
  assert.ok(resolved && typeof resolved === 'string', 'findPython 仍返回一个解释器路径/命令');
  const leaked = lines.filter((l) => /Using Python executable|Could not resolve an exact Python path/.test(l));
  assert.equal(leaked.length, 0, `默认应静默,不得泄漏调试行,实收:${JSON.stringify(leaked)}`);
});

test('门关(KHY_PYTHON_PATH_QUIET=off)→ 逐字节回退:打印 "Using Python executable" 或兜底 warn', () => {
  const { resolved, lines } = loadFreshAndResolve('off');
  assert.ok(resolved && typeof resolved === 'string');
  const shown = lines.filter((l) => /Using Python executable|Could not resolve an exact Python path/.test(l));
  assert.ok(shown.length >= 1, `门关应回退旧 verbose 行为(至少一条调试行),实收:${JSON.stringify(lines)}`);
});

test('门控只影响可见性,不影响解析结果(静默档与 verbose 档返回同一解释器)', () => {
  const quiet = loadFreshAndResolve(undefined);
  const verbose = loadFreshAndResolve('off');
  assert.equal(quiet.resolved, verbose.resolved, '两档解析结果必须一致');
});

test('其它 CANON off-word(0/false/no)同样触发 verbose 回退', () => {
  for (const w of ['0', 'false', 'no']) {
    const { lines } = loadFreshAndResolve(w);
    const shown = lines.filter((l) => /Using Python executable|Could not resolve an exact Python path/.test(l));
    assert.ok(shown.length >= 1, `off-word "${w}" 应触发 verbose,实收:${JSON.stringify(lines)}`);
  }
});

test('非 off-word(任意真值,如 "1"/"quiet")→ 门开静默', () => {
  for (const w of ['1', 'quiet', 'yes']) {
    const { lines } = loadFreshAndResolve(w);
    const leaked = lines.filter((l) => /Using Python executable|Could not resolve an exact Python path/.test(l));
    assert.equal(leaked.length, 0, `真值 "${w}" 应静默,实收:${JSON.stringify(leaked)}`);
  }
});

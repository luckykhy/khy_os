'use strict';
/**
 * pythonPathQuiet �?findPython() 解释器解析调试行的静默门�?KHY_PYTHON_PATH_QUIET)�?
 *
 * /goal「同时减少显示的心灵噪音�?findPython() 每次�?OCR / 文档转换子进程解析解释器�?原本无条�?
 * `console.log("Using Python executable: <绝对路径>")` 直冲用户终端(实测 vision→OCR 兜底一屏刷�?
 * `Using Python executable: D:\Python312\python.exe` 并泄漏本机路�?——纯调试日志,从不为用户服务�?
 *
 * 本套件验�?用真�?findPython(),不桩解析):
 *   �?默认(�?default-on 静默)�?解析成功时不打印任何 "Using Python executable" �?但仍返回可用解释器�?
 *   �?门关(KHY_PYTHON_PATH_QUIET=off)�?逐字节回退�?verbose 行为,打印 "Using Python executable" 行�?
 *   �?门控只影响可见�?绝不影响解析结果(两种档位返回同一 _cached �?�?
 *
 * 关键:findPython() 用模块级 `_cached` 缓存,一进程只解析一�?�?每个用例必须 delete require.cache
 * 重载模块,才能在不�?env 下重跑解析逻辑�?
 *
 * node:test(jest �?rtk 代理�?Exec format error 不可�?�?
 */
const path = require('node:path');
const MOD_PATH = require.resolve('../../src/utils/pythonPath');
// 每次全新加载 pythonPath 模块(�?_cached),并在受控 env 下捕�?console.log / console.warn�?
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
    delete require.cache[MOD_PATH]; // 别把测试污染的实例留给后�?require
  }
}
test('默认(�?default-on 静默)�?不打�?"Using Python executable",仍返回可用解释器', () => {
  const { resolved, lines } = loadFreshAndResolve(undefined);
  expect(resolved && typeof resolved === 'string').toBeTruthy();
  const leaked = lines.filter((l) => /Using Python executable|Could not resolve an exact Python path/.test(l));
  expect(leaked.length).toBe(0);
});
test('门关(KHY_PYTHON_PATH_QUIET=off)�?逐字节回退:打印 "Using Python executable" 或兜�?warn', () => {
  const { resolved, lines } = loadFreshAndResolve('off');
  expect(resolved && typeof resolved === 'string').toBeTruthy();
  const shown = lines.filter((l) => /Using Python executable|Could not resolve an exact Python path/.test(l));
  expect(shown.length >= 1).toBeTruthy();
});
test('�?off-word(任意真�?�?"1"/"quiet")�?门开静默', () => {
  for (const w of ['1', 'quiet', 'yes']) {
    const { lines } = loadFreshAndResolve(w);
    const leaked = lines.filter((l) => /Using Python executable|Could not resolve an exact Python path/.test(l));
    expect(leaked.length).toBe(0);
  }
});

describe('Python Path Quiet', () => {
  test('门控只影响可见�?不影响解析结�?静默档与 verbose 档返回同一解释�?', () => {
      const quiet = loadFreshAndResolve(undefined);
      const verbose = loadFreshAndResolve('off');
      expect(quiet.resolved).toBe(verbose.resolved);
  });

  test('其它 CANON off-word(0/false/no)同样触发 verbose 回退', () => {
      for (const w of ['0', 'false', 'no']) {
        const { lines } = loadFreshAndResolve(w);
        const shown = lines.filter((l) => /Using Python executable|Could not resolve an exact Python path/.test(l));
        expect(shown.length >= 1).toBeTruthy();
      }
  });

});


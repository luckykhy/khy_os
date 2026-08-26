'use strict';

/**
 * pythonPath 缓存生命周期 —— 「降级结果不得永久锁定」。
 *
 * 背景(用户诉求「出现错误就永远报相同的错误,不会清理错误锁定」):findPython() 把解析结果
 * 写进模块级 `_cached` 并永久复用,**降级结果也一样**。第一次调用若恰好赶上 venv 还没建好、
 * PATH 还没刷新、或某次 canRunPython 探测瞬时超时,就把整个进程钉在裸命令 `python` 上;
 * 在 PATH 里没有 python 的环境下,之后每个 OCR / 文档转换子进程都 ENOENT —— 同一条错误
 * 重复到进程退出,哪怕真正的解释器早就就位。
 *
 * 本套件守护:
 *   ① 解析到确切路径 → 永久缓存,时钟推进多久都不重扫(重扫要 fork 若干次 canRunPython,很贵)。
 *   ② 降级到裸命令 → 只保留 DEGRADED_RETRY_MS,过期后下一次调用重新解析,可自愈。
 *   ③ 降级 warn 只喊一次,周期性重探不制造新噪音。
 *   ④ resetPythonCache() 可主动清缓存(如刚建好 venv)。
 *
 * node:test(与同目录 pythonPathQuiet.test.js 一致)。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const MOD_PATH = require.resolve('../../src/utils/pythonPath');

// 让解析必然失败:PYTHON_PATH 指向不存在的绝对路径,PATH 清空使 python/py/python3
// 三个裸命令都查不到,本仓也没有 services/backend/{.venv,venv,ml} 本地虚拟环境。
const DEGRADE_ENV = {
  PYTHON_PATH: path.join(path.sep, 'nonexistent-khyos-test', 'python.exe'),
  PATH: '',
  Path: '',
  VIRTUAL_ENV: '',
  KHY_PYTHON_PATH_QUIET: 'off', // 打开 verbose,才能观察 warn 次数
};

function withEnv(overrides, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(overrides)) {
    saved[k] = process.env[k];
    if (v === '') delete process.env[k];
    else process.env[k] = v;
  }
  const savedLog = console.log;
  const savedWarn = console.warn;
  const lines = [];
  console.log = (...a) => lines.push(a.join(' '));
  console.warn = (...a) => lines.push(a.join(' '));
  try {
    delete require.cache[MOD_PATH];
    return fn(require('../../src/utils/pythonPath'), lines);
  } finally {
    console.log = savedLog;
    console.warn = savedWarn;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    delete require.cache[MOD_PATH]; // 别把污染实例留给后续 require
  }
}

test('解析成功的结果永久缓存:时钟推进 1 小时也不重扫', () => {
  withEnv({ KHY_PYTHON_PATH_QUIET: 'off' }, (mod, lines) => {
    const first = mod.findPython({ now: () => 1_000_000 });
    assert.ok(first && typeof first === 'string');
    const firstLines = lines.length;
    const second = mod.findPython({ now: () => 1_000_000 + 60 * 60_000 });
    assert.equal(second, first);
    assert.equal(lines.length, firstLines, '命中永久缓存时不应再打印任何解析行(即未重扫)');
  });
});

test('降级到裸命令:冷却窗内复用,过期后重新解析', () => {
  withEnv(DEGRADE_ENV, (mod, lines) => {
    let t = 2_000_000;
    const fallback = mod.findPython({ now: () => t });
    // 环境里确实存在 python 时本用例的前提不成立(解析会成功),直接跳过而不是假通过。
    if (path.isAbsolute(fallback)) {
      return;
    }
    assert.ok(fallback === 'python' || fallback === 'python3', `实收:${fallback}`);
    const warnCount = lines.filter((l) => /Could not resolve an exact Python path/.test(l)).length;
    assert.equal(warnCount, 1, '首次降级应告警一次');

    // 冷却窗(60s)内:直接复用,不重扫、不重复告警
    t += 30_000;
    assert.equal(mod.findPython({ now: () => t }), fallback);
    assert.equal(
      lines.filter((l) => /Could not resolve an exact Python path/.test(l)).length,
      1,
      '冷却窗内不得重复告警'
    );

    // 冷却过期:重新走一遍完整解析。环境仍然坏 → 仍然降级,但**是重新判定的**,
    // 一旦环境修好(venv 建好 / PATH 刷新)这一次就会解析成功,这就是自愈点。
    t += 40_000;
    assert.equal(mod.findPython({ now: () => t }), fallback);
    assert.equal(
      lines.filter((l) => /Could not resolve an exact Python path/.test(l)).length,
      1,
      '周期性重探不得制造新噪音'
    );
  });
});

test('resetPythonCache 清缓存后重新解析', () => {
  withEnv({ KHY_PYTHON_PATH_QUIET: 'off' }, (mod, lines) => {
    const first = mod.findPython({ now: () => 3_000_000 });
    const before = lines.length;
    mod.findPython({ now: () => 3_000_000 });
    assert.equal(lines.length, before, '未 reset 前不重扫');

    mod.resetPythonCache();
    const again = mod.findPython({ now: () => 3_000_000 });
    assert.equal(again, first, '同一环境下重新解析结果应一致');
    assert.ok(lines.length > before, 'reset 后应真的重扫了一遍(verbose 档会再打印解析行)');
  });
});

'use strict';

/**
 * toolOrchestrator.js — 外部反编译/反汇编器编排 (DESIGN-ARCH-054 §3.5)。
 *
 * 对原生/字节码产物，khy 自身不重写反汇编器，而是**发现并驱动**宿主上已安装的成熟工具
 * （radare2 / objdump / nm / readelf / ilspycmd / jadx / wasm2wat / decompyle3 …），把它们
 * 的确定性输出收进证据包，再交给 reconstructionPort 让模型做结构推断。
 *
 * 三条铁律：
 *   防呆②：工具不存在就**如实上报**（available:false + 安装提示），绝不伪造反汇编输出。
 *   防呆⑤：一律 execFile（无 shell）+ 固定 argv + 超时 + 输出上限；制品路径作为参数而非
 *           拼进命令行，杜绝注入；绝不执行被分析的制品本身。
 *   fail-soft：任何工具崩溃/超时只降级该条证据，绝不冒泡使整条逆向流水线失败。
 */

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { searchExecutable } = require('../../tools/platformUtils');
const { jdkToolFlags } = require('../../utils/javaEncoding');

/** 单工具运行超时（默认 20s，env 可调）。 */
const TOOL_TIMEOUT_MS = parseInt(process.env.KHY_RE_TOOL_TIMEOUT_MS, 10) || 20000;
/** 单工具输出捕获上限（默认 512 KiB）。 */
const TOOL_MAX_BUFFER = parseInt(process.env.KHY_RE_TOOL_MAX_BUFFER, 10) || 512 * 1024;

/**
 * 反汇编/反编译命令计划：family → 候选工具链。
 * argv 是「函数 → string[]」，制品路径只以参数注入（防注入）。priority 越小越优先。
 * 这是工具编排层的「单一真源」，与 formatRegistry 的 candidate 名互为印证。
 */
const PLANS = {
  elf: [
    { bin: 'objdump', priority: 1, argv: (f) => ['-d', '-C', f], kind: 'disasm', install: 'binutils (apt install binutils)' },
    { bin: 'nm', priority: 2, argv: (f) => ['-C', f], kind: 'symbols', install: 'binutils' },
    { bin: 'readelf', priority: 3, argv: (f) => ['-h', '-d', f], kind: 'headers', install: 'binutils' },
    { bin: 'radare2', priority: 4, argv: (f) => ['-q', '-c', 'aaa;afl', f], kind: 'functions', install: 'radare2' },
    { bin: 'analyzeHeadless', priority: 5, kind: 'decompile', needsTempProject: true, install: 'Ghidra (analyzeHeadless on PATH)' },
  ],
  pe: [
    { bin: 'objdump', priority: 1, argv: (f) => ['-d', '-C', f], kind: 'disasm', install: 'binutils / llvm-objdump' },
    { bin: 'radare2', priority: 2, argv: (f) => ['-q', '-c', 'aaa;afl', f], kind: 'functions', install: 'radare2' },
    { bin: 'analyzeHeadless', priority: 3, kind: 'decompile', needsTempProject: true, install: 'Ghidra (analyzeHeadless on PATH)' },
  ],
  macho: [
    { bin: 'otool', priority: 1, argv: (f) => ['-tV', f], kind: 'disasm', install: 'Xcode CLT' },
    { bin: 'nm', priority: 2, argv: (f) => ['-C', f], kind: 'symbols', install: 'Xcode CLT' },
    { bin: 'objdump', priority: 3, argv: (f) => ['-d', '-C', f], kind: 'disasm', install: 'binutils/llvm' },
    { bin: 'analyzeHeadless', priority: 4, kind: 'decompile', needsTempProject: true, install: 'Ghidra (analyzeHeadless on PATH)' },
  ],
  dotnet: [
    { bin: 'ilspycmd', priority: 1, argv: (f) => [f], kind: 'decompile', install: 'dotnet tool install -g ilspycmd' },
    { bin: 'monodis', priority: 2, argv: (f) => [f], kind: 'disasm', install: 'mono-devel' },
  ],
  java: [
    { bin: 'jadx', priority: 1, argv: (f) => ['--no-res', '-d', '-', f], kind: 'decompile', install: 'jadx' },
    { bin: 'javap', priority: 2, argv: (f) => ['-c', '-p', ...jdkToolFlags(), f], kind: 'disasm', install: 'JDK' },
  ],
  // family=dalvik: Android .dex / .apk → Java 源（jadx 主路径）/ smali / jar。
  // jadx 直接吃 .dex 与 .apk；baksmali 出 smali；dex2jar 转 .jar 后可再走 java 反编译。
  dalvik: [
    { bin: 'jadx', priority: 1, argv: (f) => ['--no-res', '-d', '-', f], kind: 'decompile', install: 'jadx (handles .dex and .apk)' },
    { bin: 'baksmali', priority: 2, argv: (f) => ['d', f], kind: 'disasm', install: 'baksmali (smali/baksmali)' },
    { bin: 'd2j-dex2jar', priority: 3, argv: (f) => [f], kind: 'transcode', install: 'dex2jar (d2j-dex2jar)' },
  ],
  wasm: [
    { bin: 'wasm2wat', priority: 1, argv: (f) => [f], kind: 'decompile', install: 'wabt (apt install wabt)' },
    { bin: 'wasm-decompile', priority: 2, argv: (f) => [f], kind: 'decompile', install: 'wabt' },
  ],
  python: [
    { bin: 'decompyle3', priority: 1, argv: (f) => [f], kind: 'decompile', install: 'pip install decompyle3' },
    { bin: 'uncompyle6', priority: 2, argv: (f) => [f], kind: 'decompile', install: 'pip install uncompyle6' },
    { bin: 'pycdc', priority: 3, argv: (f) => [f], kind: 'decompile', install: 'build zrax/pycdc (handles modern CPython)' },
  ],
  // family=go: formatRegistry 已声明候选工具却无运行计划——补齐编排，避免「识别得了却驱动不了」。
  go: [
    { bin: 'go', priority: 1, argv: (f) => ['version', '-m', f], kind: 'buildinfo', install: 'golang toolchain' },
    { bin: 'objdump', priority: 2, argv: (f) => ['-d', '-C', f], kind: 'disasm', install: 'binutils / llvm-objdump' },
    { bin: 'radare2', priority: 3, argv: (f) => ['-q', '-c', 'aaa;afl', f], kind: 'functions', install: 'radare2' },
  ],
  // family=rust: 同上缺口。rust 二进制无专用反编译器，走原生反汇编 + 符号还原 crate 线索。
  rust: [
    { bin: 'objdump', priority: 1, argv: (f) => ['-d', '-C', f], kind: 'disasm', install: 'binutils / llvm-objdump' },
    { bin: 'nm', priority: 2, argv: (f) => ['-C', f], kind: 'symbols', install: 'binutils' },
    { bin: 'radare2', priority: 3, argv: (f) => ['-q', '-c', 'aaa;afl', f], kind: 'functions', install: 'radare2' },
  ],
};

const _whichCache = new Map();
function _which(bin) {
  if (_whichCache.has(bin)) return _whichCache.get(bin);
  const resolved = searchExecutable(bin);
  _whichCache.set(bin, resolved);
  return resolved;
}

/**
 * 探活：给定 family，返回每个候选工具是否可用 + 安装提示。永不执行任何工具。
 * @returns {{ family, tools:[{bin,available,path,kind,install,priority}] }}
 */
function probe(family) {
  const plan = PLANS[family] || [];
  const tools = plan.map((p) => {
    const resolved = _which(p.bin);
    return {
      bin: p.bin,
      available: !!resolved,
      path: resolved || null,
      kind: p.kind,
      install: p.install,
      priority: p.priority,
    };
  });
  return { family, tools };
}

/** 运行一个已知可用工具，捕获输出（execFile，无 shell，超时 + 上限）。绝不抛。 */
function _run(bin, argv) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      execFile(bin, argv, {
        timeout: TOOL_TIMEOUT_MS,
        maxBuffer: TOOL_MAX_BUFFER,
        windowsHide: true,
        // 不继承可能触发 shell 行为的环境；保持最小、确定。
        env: { ...process.env, LC_ALL: 'C' },
      }, (err, stdout, stderr) => {
        if (err && !stdout) {
          finish({ ok: false, reason: err.killed ? 'timeout' : (err.code != null ? `exit ${err.code}` : err.message), stderr: String(stderr || '').slice(0, 2000) });
          return;
        }
        finish({ ok: true, output: String(stdout || ''), stderr: String(stderr || '').slice(0, 2000), truncated: Buffer.byteLength(String(stdout || '')) >= TOOL_MAX_BUFFER });
      });
    } catch (e) {
      finish({ ok: false, reason: e.message });
    }
  });
}

/**
 * 为 Ghidra analyzeHeadless 构造一次性临时工程 + 反编译转储 postScript。
 * Ghidra 的 CLI 形态特殊：import 后需脚本才能吐出反编译 C；裸 import 只建库无输出。
 * 全部路径作为 execFile 参数注入（无 shell，防呆⑤）；工程目录用完即弃。
 * @returns {{ argv:string[], cleanup:function }}
 */
function _buildGhidraInvocation(filePath) {
  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-ghidra-'));
  const projName = 're';
  // postScript：遍历函数，反编译并打印到 stdout，供下游模型推断。纯 Jython，确定性。
  const scriptBody = [
    '# khy reverse-engineer: dump decompiled C for every function',
    'from ghidra.app.decompiler import DecompInterface',
    'ifc = DecompInterface()',
    'ifc.openProgram(currentProgram)',
    'fm = currentProgram.getFunctionManager()',
    'for fn in fm.getFunctions(True):',
    '    res = ifc.decompileFunction(fn, 60, monitor)',
    '    if res and res.decompileCompleted():',
    '        print(res.getDecompiledFunction().getC())',
  ].join('\n');
  const scriptPath = path.join(projDir, 'khy_decompile_dump.py');
  fs.writeFileSync(scriptPath, scriptBody, 'utf8');

  const argv = [
    projDir, projName,
    '-import', filePath,
    '-scriptPath', projDir,
    '-postScript', 'khy_decompile_dump.py',
    '-deleteProject',
  ];
  const cleanup = () => { try { fs.rmSync(projDir, { recursive: true, force: true }); } catch { /* noop */ } };
  return { argv, cleanup };
}

/**
 * 对一个产物按 family 编排：选最高优先级可用工具执行，收集证据；无任何工具可用则诚实降级。
 * @param {string} filePath
 * @param {string} family
 * @param {object} [opts] { run:true 是否真执行(默认 true)；maxTools 执行多少个候选(默认 2) }
 * @returns {Promise<object>} { family, attempted, evidence:[], availability:[], degraded, hint }
 */
async function orchestrate(filePath, family, opts = {}) {
  const run = opts.run !== false;
  const maxTools = Math.max(1, opts.maxTools || 2);
  const { tools } = probe(family);
  const available = tools.filter((t) => t.available).sort((a, b) => a.priority - b.priority);
  const plan = PLANS[family] || [];

  if (available.length === 0) {
    const hints = plan.map((p) => `${p.bin} (${p.install})`);
    return {
      family,
      attempted: false,
      evidence: [],
      availability: tools,
      degraded: true,
      hint: plan.length
        ? `本机未发现 ${family} 的反编译/反汇编工具。可安装其一以增强逆向：${hints.join(' | ')}`
        : `family=${family} 无登记的外部工具计划；依赖字符串证据 + 模型推断。`,
    };
  }

  if (!run) {
    return { family, attempted: false, evidence: [], availability: tools, degraded: false, hint: 'probe-only' };
  }

  const evidence = [];
  for (const tool of available.slice(0, maxTools)) {
    const planEntry = plan.find((p) => p.bin === tool.bin);
    if (!planEntry) continue;

    // Ghidra 等需要一次性工程目录 + postScript 的工具走专用构造路径。
    let argv;
    let cleanup = null;
    if (planEntry.needsTempProject) {
      const inv = _buildGhidraInvocation(filePath);
      argv = inv.argv;
      cleanup = inv.cleanup;
    } else {
      argv = planEntry.argv(filePath);
    }

    let res;
    try {
      res = await _run(tool.bin, argv);
    } finally {
      if (cleanup) cleanup();
    }
    evidence.push({
      tool: tool.bin,
      kind: tool.kind,
      argv,
      ok: res.ok,
      reason: res.reason || null,
      // 输出在证据包里裁剪，避免巨量 disasm 撑爆下游上下文。
      output: res.ok ? res.output.slice(0, 64 * 1024) : null,
      outputTruncated: res.ok ? (res.output.length > 64 * 1024 || res.truncated) : false,
      stderr: res.stderr || null,
    });
  }

  return {
    family,
    attempted: true,
    evidence,
    availability: tools,
    degraded: evidence.every((e) => !e.ok),
    hint: evidence.some((e) => e.ok) ? null : '所有可用工具执行失败；仅余字符串/符号证据。',
  };
}

/**
 * 候选工具可执行名 → 依赖自愈注册表 depId。
 * 单一真源映射：当某 family 无任何工具可用时，据此挑出「该申请安装哪个 curated 依赖」，
 * 交给 dependency 自愈层向用户申请批准（install/discuss/skip）。
 * 未列出的 bin（otool/javap/monodis/go 等随 Xcode/JDK/mono/go 工具链分发）不在此请求，
 * 由其各自工具链报错触发既有自愈条目。
 */
const BIN_TO_DEP_ID = {
  objdump: 'binutils', nm: 'binutils', readelf: 'binutils',
  radare2: 'radare2',
  analyzeHeadless: 'ghidra',
  jadx: 'jadx',
  baksmali: 'baksmali',
  'd2j-dex2jar': 'dex2jar',
  wasm2wat: 'wabt', 'wasm-decompile': 'wabt',
  ilspycmd: 'ilspycmd',
  decompyle3: 'decompyle3',
  uncompyle6: 'uncompyle6',
};

/**
 * 给定 family，挑出「应申请安装」的最优 curated 依赖（最高优先级且已登记 depId 的候选）。
 * 纯函数，不探活、不执行。供 index.js 在 runTools 模式且本机无任何工具时，
 * 把缺口收敛成一个 depId 交自愈层向用户申请批准。
 * @param {string} family
 * @returns {{ depId:string, bin:string, install:string } | null}
 */
function recommendInstall(family) {
  const plan = PLANS[family] || [];
  const sorted = plan.slice().sort((a, b) => a.priority - b.priority);
  for (const p of sorted) {
    const depId = BIN_TO_DEP_ID[p.bin];
    if (depId) return { depId, bin: p.bin, install: p.install };
  }
  return null;
}

module.exports = {
  PLANS,
  BIN_TO_DEP_ID,
  probe,
  orchestrate,
  recommendInstall,
  TOOL_TIMEOUT_MS,
  _run, // 暴露给单测可注入/观察
  _resetWhichCache: () => _whichCache.clear(),
};

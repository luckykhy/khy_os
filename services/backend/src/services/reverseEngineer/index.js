'use strict';

/**
 * reverseEngineer/index.js — 逆向工程引擎门面 (DESIGN-ARCH-054 §4 编排)。
 *
 * 把「从产物还原/分析软件」串成一条确定性优先、模型增益、可自验的闭环流水线：
 *
 *   analyze(artifactPath)
 *     │
 *     ├─① artifactScanner   只读分诊：格式/架构/哈希/嵌入标记（绝不执行制品）
 *     ├─② stringHarvester   字符串证据 + 工具链指纹
 *     ├─③ sourceRecoverer   自包含产物 → 取回源码/字节码清单（SOURCE 档主路径）
 *     ├─④ toolOrchestrator  原生/字节码 → 探活并驱动外部反编译器（无则诚实降级）
 *     ├─⑤ reconstructionPort证据 → 模型结构化重建（无模型退化为证据报告）
 *     └─⑥ verificationLedger与 khy 构建清单比对 → 保真度评分（闭合「khy 自验 khy 产物」）
 *
 * 授权边界（防呆⑥）：逆向能力定位为「分析自有/受权软件、验证 khy 自己生成的产物」。门面要求
 * 产物可定位到一份 khy 构建清单，**或**调用方显式声明 authorized=true。否则只做只读分诊与
 * 字符串归纳（不驱动反编译、不做深度重建），并在报告里标注需授权。这不是技术阻断恶意，而是
 * 把工具的预期用途钉死在「自验」语义上，与系统对「授权安全测试」的边界一致。
 */

const fs = require('fs');
const scanner = require('./artifactScanner');
const stringHarvester = require('./stringHarvester');
const sourceRecoverer = require('./sourceRecoverer');
const toolOrchestrator = require('./toolOrchestrator');
const reconstructionPort = require('./reconstructionPort');
const ledger = require('./verificationLedger');

/** 字符串收割读取窗口（默认 8 MiB；大文件只看头部，足够采指纹）。 */
const STRING_WINDOW_BYTES = parseInt(process.env.KHY_RE_STRING_WINDOW, 10) || 8 * 1024 * 1024;

class ReverseEngineer {
  /**
   * @param {object} [opts]
   * @param {function} [opts.brain]  模型自省函数 (prompt)=>Promise<string|object>；缺省纯确定性
   * @param {number}   [opts.brainTimeoutMs]
   */
  constructor(opts = {}) {
    this.brain = typeof opts.brain === 'function' ? opts.brain : null;
    this.brainTimeoutMs = opts.brainTimeoutMs || undefined;
  }

  /** 读取字符串收割窗口（头部 N 字节）。绝不抛。 */
  _readStringWindow(filePath, sizeBytes) {
    try {
      const len = Math.min(STRING_WINDOW_BYTES, sizeBytes || STRING_WINDOW_BYTES);
      const fd = fs.openSync(filePath, 'r');
      try {
        const buf = Buffer.alloc(len);
        const n = fs.readSync(fd, buf, 0, len, 0);
        return buf.subarray(0, n);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return Buffer.alloc(0);
    }
  }

  /**
   * 逆向分析一个产物，产出结构化重建报告。绝不抛——任何阶段失败都降级为部分报告。
   * @param {string} artifactPath
   * @param {object} [opts]
   * @param {boolean} [opts.authorized]    显式授权（自有/受权软件）
   * @param {boolean} [opts.runTools=false] 是否真正执行外部反编译器（默认仅探活）
   * @param {string}  [opts.outDir]        提供则把可还原源码落盘到此目录
   * @param {string}  [opts.manifestPath]  指定构建清单；否则同目录约定文件探测
   * @returns {Promise<object>} ReconstructionReport
   */
  async analyze(artifactPath, opts = {}) {
    const report = {
      ok: false,
      artifact: artifactPath,
      authorized: false,
      scan: null,
      strings: null,
      recovery: null,
      orchestration: null,
      reconstruction: null,
      verification: null,
      warnings: [],
    };

    // ① 只读分诊（永远先做，便于即使未授权也给出基本事实）。
    const scan = await scanner.scanFile(artifactPath);
    report.scan = scan;
    if (!scan.exists) {
      report.warnings.push('Artifact not found or not a regular file.');
      report.verification = { hasBaseline: false, verdict: 'no-artifact', message: '产物不存在。', fidelity: null };
      return report;
    }

    // 授权判定：显式 authorized 或能定位构建清单（=khy 自验自有产物）。
    const manifestPath = opts.manifestPath || ledger.findManifestFor(artifactPath);
    const manifest = manifestPath ? ledger.loadManifest(manifestPath) : null;
    const authorized = opts.authorized === true || !!manifest;
    report.authorized = authorized;
    report.manifestPath = manifestPath || null;

    // ② 字符串证据（只读窗口；任何档位都安全且廉价）。
    const window = this._readStringWindow(artifactPath, scan.sizeBytes);
    report.strings = stringHarvester.harvest(window);

    if (!authorized) {
      report.warnings.push(
        '未授权模式：仅做只读分诊与字符串归纳。逆向定位为自验自有/受权软件——'
        + '请提供 khy 构建清单，或在确认拥有/受权该产物后以 authorized:true 调用以启用源码还原、'
        + '外部反编译与深度重建。',
      );
      report.ok = true;
      report.reconstruction = reconstructionPort._deterministicReport(
        reconstructionPort.buildEvidencePack({ scan, strings: report.strings }),
      );
      report.verification = ledger.verify(scan, { members: [] }, manifest);
      return report;
    }

    // ③ 源码/字节码还原（SOURCE 档主路径）。
    report.recovery = await sourceRecoverer.recover(artifactPath, scan, { outDir: opts.outDir || null });

    // ④ 外部反编译/反汇编编排（NATIVE/BYTECODE）。默认仅探活；runTools 才执行。
    report.orchestration = await toolOrchestrator.orchestrate(artifactPath, scan.family, {
      run: opts.runTools === true,
      maxTools: opts.maxTools || 2,
    });

    // runTools 模式下本机无任何可用反编译器 → 收敛成一个 curated depId，供工具层把缺口
    // 交给依赖自愈层向用户「主动申请批准安装」（install/discuss/skip）。绝不静默静默降级、
    // 也绝不自行安装：仅把 depId 标注出来，由上层（reverseEngineer 工具）发起审批。
    if (opts.runTools === true && report.orchestration && report.orchestration.attempted === false
        && Array.isArray(report.orchestration.availability) && report.orchestration.availability.length > 0) {
      const rec = toolOrchestrator.recommendInstall(scan.family);
      if (rec) report.orchestration.missingDependency = rec;
    }

    // ⑤ 模型结构化重建（无模型 → 证据报告）。
    const pack = reconstructionPort.buildEvidencePack({
      scan,
      strings: report.strings,
      recover: report.recovery,
      orchestration: report.orchestration,
    });
    report.reconstruction = await reconstructionPort.reconstruct(pack, {
      brain: this.brain,
      timeoutMs: this.brainTimeoutMs,
    });

    // ⑥ 与构建清单比对 → 保真度自验。
    report.verification = ledger.verify(scan, report.recovery || { members: [] }, manifest);

    report.ok = true;
    return report;
  }
}

/** 便捷单次分析（默认无模型；调用方可注入 brain）。 */
async function analyze(artifactPath, opts = {}) {
  const eng = new ReverseEngineer({ brain: opts.brain, brainTimeoutMs: opts.brainTimeoutMs });
  return eng.analyze(artifactPath, opts);
}

module.exports = {
  ReverseEngineer,
  analyze,
  // 子模块再导出，便于精细化调用与单测。
  scanner,
  stringHarvester,
  sourceRecoverer,
  toolOrchestrator,
  reconstructionPort,
  ledger,
};

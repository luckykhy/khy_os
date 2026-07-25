'use strict';

/**
 * reverseEngineer — AI 逆向分析/还原工具 (DESIGN-ARCH-054)。
 *
 * 从编译后的产物（exe/dll/so/jar/wasm/PyInstaller/Node 自包含可执行 …）只读地分诊、收割
 * 字符串证据、还原自包含产物的源码/字节码、探活并（可选）驱动外部反编译器，最终产出一份
 * 结构化证据 + 重建报告，并在能定位 khy 构建清单时给出保真度自验评分。
 *
 * 核心用途：khy 打包后只剩 exe、源码丢失时，由 khy 自己还原与验证自己生成的软件。
 *
 * 安全/授权：只读字节，**绝不执行**被分析的制品；外部工具一律 execFile+超时+输出上限。
 * 逆向定位为「自验自有/受权软件」——未提供构建清单且未显式 authorized 时，仅做只读分诊与
 * 字符串归纳，不驱动反编译与源码还原。
 */

const { defineTool } = require('./_baseTool');

module.exports = defineTool({
  name: 'reverse_engineer',
  description:
    'Reverse-engineer a compiled artifact (exe/dll/so/dylib/jar/class/wasm/PyInstaller/Node SEA/pkg/zip) to recover and analyze its structure. '
    + 'Read-only triage (format, architecture, sha256), string/toolchain-fingerprint harvesting, in-band source/bytecode recovery for self-contained bundles, '
    + 'external decompiler/disassembler discovery (and optional run), plus build-manifest fidelity verification. '
    + 'Intended for verifying YOUR OWN / authorized software (e.g. khy-built artifacts whose source was lost). Never executes the analyzed binary.',
  category: 'execution',
  risk: 'medium',
  isReadOnly: true,
  isConcurrencySafe: true,

  inputSchema: {
    path: { type: 'string', required: true, description: 'Path to the compiled artifact to analyze.' },
    authorized: { type: 'boolean', required: false, description: 'Assert you own / are authorized to reverse this artifact. Enables source recovery + decompiler orchestration. Auto-true when a khy build manifest is found.' },
    runTools: { type: 'boolean', required: false, description: 'Actually run discovered external decompilers/disassemblers (default false = probe only).' },
    outDir: { type: 'string', required: false, description: 'If set, extract recoverable source/bytecode members to this directory (sandboxed, path-traversal guarded).' },
    manifestPath: { type: 'string', required: false, description: 'Path to a khy build manifest for fidelity verification (defaults to .khy-build-manifest.json next to the artifact).' },
    maxTools: { type: 'number', required: false, description: 'Max external tools to run per family when runTools=true (default 2).' },
  },

  getActivityDescription(input) {
    return `逆向分析产物${input?.path ? `：${input.path}` : ''}`;
  },

  async execute(params) {
    const engine = require('../services/reverseEngineer');
    const artifactPath = params.path;
    if (!artifactPath || typeof artifactPath !== 'string') {
      return { success: false, error: { code: 'INVALID_INPUT', message: 'path is required' } };
    }

    const report = await engine.analyze(artifactPath, {
      authorized: params.authorized === true,
      runTools: params.runTools === true,
      outDir: params.outDir || null,
      manifestPath: params.manifestPath || null,
      maxTools: typeof params.maxTools === 'number' ? params.maxTools : undefined,
    });

    // runTools 模式下本机无任何反编译器 → 把缺口交给依赖自愈层：返回带 depId 的
    // MISSING_DEPENDENCY 结构化失败（success:false），executeTool 的自愈钩子据此
    // 「主动向用户申请批准安装」（install/discuss/skip），装好后自动重试本次调用一次。
    // 仅在真正请求执行工具（runTools）时触发——纯探活/未授权路径不打扰用户。
    const miss = report?.orchestration?.missingDependency;
    if (params.runTools === true && miss && miss.depId) {
      const { MissingDependencyError } = require('../services/dependency/resolver');
      const err = new MissingDependencyError(miss.depId, {
        message: `逆向 ${report?.scan?.family || ''} 产物需要反编译/反汇编工具 ${miss.bin}，本机未安装。`,
      });
      const structured = err.toStructuredResult();
      // 透传 depId，使自愈层零文本匹配即可精准接管（resolver.detectFromError 优先取 depId）。
      structured.depId = miss.depId;
      if (structured.error && typeof structured.error === 'object') structured.error.depId = miss.depId;
      // 仍附上已产出的只读报告，安装被拒/跳过时不丢失既有分诊证据。
      structured.data = report;
      return structured;
    }

    // 工具成功 = 流水线跑通（即使产物未找到也返回结构化诊断，由 ok 字段表达）。
    return {
      success: report.ok === true,
      data: report,
    };
  },
});

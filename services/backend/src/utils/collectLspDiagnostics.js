'use strict';

/**
 * collectLspDiagnostics.js — 「编辑落盘后经 LSP 客户端收集该文件的错误/警告诊断」
 *   共享 helper(非纯·经 serviceRegistry 取 lspClient·fail-soft)。
 *
 * 收敛 2 处 body 逐字节相同的私有 `_collectLspDiagnostics(filePath)`——
 *   tools/FileEditTool(内部用·:300/:340)·tools/MultiEditTool(内部用·:257)。
 *
 * 语义:serviceRegistry.get('lspClient') 未初始化 → null;取 diagnostics 后
 *   仅留 severity 1(error)/2(warning)·最多前 15 条·映射为
 *   `{line,character,severity,message,source}`(行列 +1 转 1-based)。任何异常 → null。
 *
 * 契约:非纯(经 serviceRegistry 取 lspClient)·fail-soft·绝不抛。各消费方保留同名
 *   本地 `const _collectLspDiagnostics = require('../../utils/collectLspDiagnostics')`
 *   → 调用点逐字节不变。
 */

function _collectLspDiagnostics(filePath) {
  try {
    const { serviceRegistry } = require('../services/serviceRegistry');
    const lsp = serviceRegistry?.get?.('lspClient');
    if (!lsp || !lsp.initialized) return null;
    const diags = lsp.getDiagnostics(filePath);
    if (!Array.isArray(diags) || diags.length === 0) return null;
    const errors = diags.filter(d => d.severity === 1 || d.severity === 2);
    if (errors.length === 0) return null;
    return errors.slice(0, 15).map(d => ({
      line: (d.range?.start?.line ?? 0) + 1,
      character: (d.range?.start?.character ?? 0) + 1,
      severity: d.severity === 1 ? 'error' : 'warning',
      message: d.message || '',
      source: d.source || '',
    }));
  } catch { return null; }
}

module.exports = _collectLspDiagnostics;

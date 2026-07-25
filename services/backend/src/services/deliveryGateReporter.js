/**
 * 增强版 deliveryGate 报告与改进建议生成器
 *
 * 目标:让 deliveryGate verdict 更可见,并基于失败项自动生成改进建议
 */

const fs = require('fs');
const path = require('path');

/**
 * 生成人类可读的 deliveryGate 报告
 */
function generateDeliveryReport(gateResult, options = {}) {
  const { format = 'markdown', includeRemediation = true } = options;

  if (format === 'markdown') {
    return _generateMarkdownReport(gateResult, includeRemediation);
  } else if (format === 'json') {
    return JSON.stringify(gateResult, null, 2);
  }

  return _generateTextReport(gateResult);
}

function _generateMarkdownReport(result, includeRemediation) {
  const lines = [];

  // 标题和总体判定
  const verdictEmoji = result.verdict === 'pass' ? '✅' : result.verdict === 'warn' ? '⚠️' : '❌';
  lines.push(`# DeliveryGate Report ${verdictEmoji}`);
  lines.push('');
  lines.push(`**Verdict**: ${result.verdict.toUpperCase()}`);
  lines.push(`**Summary**: ${result.summary}`);
  lines.push('');

  // 统计信息
  lines.push('## Statistics');
  lines.push('');
  lines.push(`- Total criteria: ${result.criteriaCount}`);
  lines.push(`- Required: ${result.requiredCount}`);
  lines.push(`- Optional: ${result.optionalCount}`);
  lines.push(`- Passed: ${result.passedCount} / ${result.criteriaCount} (${((result.passedCount / result.criteriaCount) * 100).toFixed(1)}%)`);
  lines.push(`- Failed: ${result.failedCount}`);
  lines.push('');

  // 检测到的模式
  if (result.modes && result.modes.length > 0) {
    lines.push('## Detected Modes');
    lines.push('');
    result.modes.forEach(mode => {
      lines.push(`- **${mode}**`);
    });
    lines.push('');
  }

  // 必需项缺失(阻塞性问题)
  if (result.missing && result.missing.length > 0) {
    lines.push('## ❌ Required Missing (BLOCKING)');
    lines.push('');
    result.missing.forEach((item, idx) => {
      lines.push(`### ${idx + 1}. ${item.label}`);
      lines.push('');
      lines.push(`- **Phase**: ${item.phase || 'N/A'}`);
      lines.push(`- **Check**: \`${item.check}\``);
      if (item.target) lines.push(`- **Target**: \`${item.target}\``);
      lines.push(`- **Status**: ${item.status}`);
      lines.push(`- **Detail**: ${item.detail}`);
      lines.push('');
    });
  }

  // 可选项警告
  if (result.warnings && result.warnings.length > 0) {
    lines.push('## ⚠️ Optional Warnings (RECOMMENDED)');
    lines.push('');
    result.warnings.forEach((item, idx) => {
      lines.push(`### ${idx + 1}. ${item.label}`);
      lines.push('');
      lines.push(`- **Detail**: ${item.detail}`);
      lines.push('');
    });
  }

  // 通过的检查
  const passed = result.results.filter(r => r.status === 'pass');
  if (passed.length > 0) {
    lines.push('## ✅ Passed Checks');
    lines.push('');
    passed.forEach((item, idx) => {
      lines.push(`${idx + 1}. **${item.label}** ${item.detail ? `— ${item.detail}` : ''}`);
    });
    lines.push('');
  }

  // 改进建议(基于失败项)
  if (includeRemediation && (result.missing.length > 0 || result.warnings.length > 0)) {
    lines.push('## 🔧 Remediation Suggestions');
    lines.push('');
    lines.push(_generateRemediationSuggestions(result));
  }

  return lines.join('\n');
}

function _generateTextReport(result) {
  const lines = [];
  const verdictSymbol = result.verdict === 'pass' ? '✓' : result.verdict === 'warn' ? '!' : '✗';

  lines.push('=== DeliveryGate Report ===');
  lines.push('');
  lines.push(`Verdict: ${verdictSymbol} ${result.verdict.toUpperCase()}`);
  lines.push(`Summary: ${result.summary}`);
  lines.push('');

  if (result.missing.length > 0) {
    lines.push('Required Missing:');
    result.missing.forEach((item, idx) => {
      lines.push(`  ${idx + 1}. ${item.label}: ${item.detail}`);
    });
    lines.push('');
  }

  if (result.warnings.length > 0) {
    lines.push('Optional Warnings:');
    result.warnings.forEach((item, idx) => {
      lines.push(`  ${idx + 1}. ${item.label}: ${item.detail}`);
    });
    lines.push('');
  }

  return lines.join('\n');
}

function _generateRemediationSuggestions(result) {
  const suggestions = [];

  // 基于失败类型给出具体建议
  for (const item of result.missing) {
    const suggestion = _suggestRemediation(item);
    if (suggestion) {
      suggestions.push(`### ${item.label}`);
      suggestions.push('');
      suggestions.push(suggestion);
      suggestions.push('');
    }
  }

  if (suggestions.length === 0) {
    return 'No specific suggestions available. Review the failed checks above.';
  }

  return suggestions.join('\n');
}

function _suggestRemediation(failedItem) {
  const check = failedItem.check || '';
  const target = failedItem.target || '';

  // 文件缺失
  if (check === 'file_exists' && target) {
    return `Create the missing file: \`${target}\`\n\nExample:\n\`\`\`bash\ntouch ${target}\n# or\necho "content" > ${target}\n\`\`\``;
  }

  // 测试覆盖
  if (check === 'test_dir_populated') {
    return `Add test files to validate your implementation.\n\nSuggested structure:\n- Unit tests for core logic\n- Integration tests for API endpoints\n- E2E tests for critical user flows`;
  }

  // 文档缺失
  if (check === 'file_exists' && target.toLowerCase().includes('readme')) {
    return `Create or update README.md:\n- Project description\n- Setup instructions\n- Usage examples\n- API documentation (if applicable)`;
  }

  // 响应中缺少计划
  if (check === 'plan_in_response') {
    return `Include a numbered execution plan in your response:\n\n1. First step...\n2. Second step...\n3. Third step...\n\nThis helps users understand your approach before implementation.`;
  }

  // 响应中缺少证据
  if (check === 'evidence_in_response') {
    return `Reference specific files and paths in your response to show what you've changed:\n- "Created src/cache.js"\n- "Updated server.js:15-30"\n- "Added tests in cache.test.js"`;
  }

  // 通用建议
  return `Review the requirement: **${failedItem.label}**\n\nCheck type: \`${check}\`\nTarget: ${target || 'N/A'}\n\nDetail: ${failedItem.detail}`;
}

/**
 * 将 deliveryGate 结果保存到文件
 */
function saveDeliveryReport(gateResult, outputPath, format = 'markdown') {
  const report = generateDeliveryReport(gateResult, { format });
  fs.writeFileSync(outputPath, report, 'utf-8');
  return outputPath;
}

/**
 * 生成 Gate B 视角的 deliveryGate 摘要
 * (用于 golden-task 评估)
 */
function extractGateBMetrics(gateResult) {
  return {
    verdict: gateResult.verdict,
    pass: gateResult.verdict === 'pass',
    passRate: gateResult.criteriaCount > 0
      ? gateResult.passedCount / gateResult.criteriaCount
      : 0,
    requiredMissing: gateResult.missing.length,
    optionalWarnings: gateResult.warnings.length,
    runtimeEvidencePresent: gateResult.results.some(r =>
      r.check === 'evidence_in_response' && r.status === 'pass'
    ),
    testEvidencePresent: gateResult.results.some(r =>
      r.check === 'test_dir_populated' && r.status === 'pass'
    ),
    modes: gateResult.modes || []
  };
}

module.exports = {
  generateDeliveryReport,
  saveDeliveryReport,
  extractGateBMetrics
};

/**
 * deliveryGateReporter 单元测试
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { generateDeliveryReport, saveDeliveryReport, extractGateBMetrics } = require('../../src/services/deliveryGateReporter');

// 模拟 deliveryGate 结果
const mockPassResult = {
  passed: true,
  verdict: 'pass',
  projectRoot: '/test/project',
  criteriaCount: 5,
  requiredCount: 3,
  optionalCount: 2,
  passedCount: 5,
  failedCount: 0,
  modes: ['spec-coding', 'test-driven'],
  summary: 'Delivery gate PASS: 5/5 criteria passed, 0 required missing, 0 optional warning(s).',
  results: [
    { id: 'c1', label: 'README exists', phase: 'document', status: 'pass', check: 'file_exists', target: 'README.md', detail: 'Found', required: true },
    { id: 'c2', label: 'Tests present', phase: 'verify', status: 'pass', check: 'test_dir_populated', detail: '10 test files', required: true },
    { id: 'c3', label: 'Plan in response', phase: 'plan', status: 'pass', check: 'plan_in_response', detail: '5 items', required: true },
    { id: 'c4', label: 'Evidence in response', phase: 'evidence', status: 'pass', check: 'evidence_in_response', detail: '8 files', required: false },
    { id: 'c5', label: 'Package.json', phase: 'setup', status: 'pass', check: 'file_exists', target: 'package.json', detail: 'Found', required: false }
  ],
  missing: [],
  warnings: []
};

const mockFailResult = {
  passed: false,
  verdict: 'fail',
  projectRoot: '/test/project',
  criteriaCount: 5,
  requiredCount: 3,
  optionalCount: 2,
  passedCount: 2,
  failedCount: 3,
  modes: ['spec-coding'],
  summary: 'Delivery gate FAIL: 2/5 criteria passed, 2 required missing, 1 optional warning(s).',
  results: [
    { id: 'c1', label: 'README exists', phase: 'document', status: 'fail', check: 'file_exists', target: 'README.md', detail: 'Not found', required: true },
    { id: 'c2', label: 'Tests present', phase: 'verify', status: 'fail', check: 'test_dir_populated', detail: 'No test files', required: true },
    { id: 'c3', label: 'Plan in response', phase: 'plan', status: 'pass', check: 'plan_in_response', detail: '5 items', required: true },
    { id: 'c4', label: 'Evidence in response', phase: 'evidence', status: 'fail', check: 'evidence_in_response', detail: 'No file references', required: false },
    { id: 'c5', label: 'Package.json', phase: 'setup', status: 'pass', check: 'file_exists', target: 'package.json', detail: 'Found', required: false }
  ],
  missing: [
    { id: 'c1', label: 'README exists', phase: 'document', status: 'fail', check: 'file_exists', target: 'README.md', detail: 'Not found', required: true },
    { id: 'c2', label: 'Tests present', phase: 'verify', status: 'fail', check: 'test_dir_populated', detail: 'No test files', required: true }
  ],
  warnings: [
    { id: 'c4', label: 'Evidence in response', phase: 'evidence', status: 'fail', check: 'evidence_in_response', detail: 'No file references', required: false }
  ]
};

console.log('=== deliveryGateReporter 单元测试 ===\n');

// 测试 1: 生成 PASS 报告
console.log('测试 1: 生成 PASS 结果的 markdown 报告');
const passReport = generateDeliveryReport(mockPassResult, { format: 'markdown' });
assert(passReport.includes('# DeliveryGate Report ✅'), '应包含 PASS 标题');
assert(passReport.includes('**Verdict**: PASS'), '应显示 PASS verdict');
assert(passReport.includes('Passed: 5 / 5'), '应显示统计信息');
assert(passReport.includes('## ✅ Passed Checks'), '应有通过检查章节');
assert(!passReport.includes('## ❌ Required Missing'), '不应有缺失项章节');
console.log('  ✓ PASS 报告生成正确\n');

// 测试 2: 生成 FAIL 报告
console.log('测试 2: 生成 FAIL 结果的 markdown 报告');
const failReport = generateDeliveryReport(mockFailResult, { format: 'markdown', includeRemediation: true });
assert(failReport.includes('# DeliveryGate Report ❌'), '应包含 FAIL 标题');
assert(failReport.includes('**Verdict**: FAIL'), '应显示 FAIL verdict');
assert(failReport.includes('## ❌ Required Missing (BLOCKING)'), '应有必需缺失项章节');
assert(failReport.includes('README exists'), '应列出 README 缺失');
assert(failReport.includes('Tests present'), '应列出测试缺失');
assert(failReport.includes('## ⚠️ Optional Warnings'), '应有可选警告章节');
assert(failReport.includes('## 🔧 Remediation Suggestions'), '应有改进建议章节');
assert(failReport.includes('Create the missing file'), '应给出具体建议');
console.log('  ✓ FAIL 报告生成正确\n');

// 测试 3: text 格式
console.log('测试 3: 生成 text 格式报告');
const textReport = generateDeliveryReport(mockFailResult, { format: 'text' });
assert(textReport.includes('=== DeliveryGate Report ==='), '应包含 text 标题');
assert(textReport.includes('Verdict: ✗ FAIL'), '应显示 FAIL');
assert(textReport.includes('Required Missing:'), '应列出必需缺失项');
console.log('  ✓ text 报告生成正确\n');

// 测试 4: JSON 格式
console.log('测试 4: 生成 JSON 格式报告');
const jsonReport = generateDeliveryReport(mockPassResult, { format: 'json' });
const parsed = JSON.parse(jsonReport);
assert(parsed.verdict === 'pass', 'JSON 应可解析且包含 verdict');
assert(parsed.passedCount === 5, 'JSON 应包含统计数据');
console.log('  ✓ JSON 报告生成正确\n');

// 测试 5: extractGateBMetrics
console.log('测试 5: 提取 Gate B 指标');
const metrics = extractGateBMetrics(mockPassResult);
assert(metrics.verdict === 'pass', '应提取 verdict');
assert(metrics.pass === true, '应标记为通过');
assert(metrics.passRate === 1.0, '通过率应为 100%');
assert(metrics.requiredMissing === 0, '必需缺失应为 0');
assert(metrics.runtimeEvidencePresent === true, '应检测到 runtime evidence');
assert(metrics.testEvidencePresent === true, '应检测到测试证据');
assert(metrics.modes.length === 2, '应提取 modes');
console.log('  ✓ Gate B 指标提取正确');
console.log(`    - Pass rate: ${(metrics.passRate * 100).toFixed(0)}%`);
console.log(`    - Required missing: ${metrics.requiredMissing}`);
console.log(`    - Modes: ${metrics.modes.join(', ')}\n`);

const failMetrics = extractGateBMetrics(mockFailResult);
assert(failMetrics.verdict === 'fail', '失败结果 verdict 应为 fail');
assert(failMetrics.pass === false, '应标记为未通过');
assert(failMetrics.passRate === 0.4, '通过率应为 40%');
assert(failMetrics.requiredMissing === 2, '必需缺失应为 2');
console.log('  ✓ FAIL 结果指标提取正确\n');

// 测试 6: Remediation 建议的具体性
console.log('测试 6: Remediation 建议具体性');
assert(failReport.includes('touch README.md'), '应包含具体命令示例');
assert(failReport.includes('Add test files'), '应给出测试建议');
assert(failReport.includes('Unit tests'), '应提供测试类型指导');
console.log('  ✓ Remediation 建议足够具体\n');

// 测试 7: saveDeliveryReport 落盘,内容与 generateDeliveryReport 一致
console.log('测试 7: saveDeliveryReport 落盘可读');
const os = require('os');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dgr-'));
const outPath = path.join(tmpDir, 'delivery-gate-report.md');
const returned = saveDeliveryReport(mockFailResult, outPath);
assert.strictEqual(returned, outPath, 'saveDeliveryReport 应返回写入路径');
assert(fs.existsSync(outPath), '报告文件应存在');
const onDisk = fs.readFileSync(outPath, 'utf-8');
assert.strictEqual(onDisk, generateDeliveryReport(mockFailResult, { format: 'markdown' }), '落盘内容应与 markdown 报告逐字节一致');
assert(onDisk.includes('# DeliveryGate Report ❌'), '落盘报告应含标题');
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
console.log('  ✓ saveDeliveryReport 落盘并返回路径\n');

// 测试 8: harness 接线(承 deliveryGateReporter 叶——生产消费者已存在)
console.log('测试 8: agenticHarnessService 已接线 saveDeliveryReport(门控落盘)');
const harnessSrc = fs.readFileSync(
  path.join(__dirname, '../../src/services/agenticHarnessService.js'), 'utf-8'
);
assert(/require\(['"]\.\/deliveryGateReporter['"]\)/.test(harnessSrc), 'harness 应 require deliveryGateReporter');
assert(/saveDeliveryReport/.test(harnessSrc), 'harness 应调用 saveDeliveryReport');
assert(/KHY_DELIVERY_GATE_REPORT/.test(harnessSrc), 'harness 应门控 KHY_DELIVERY_GATE_REPORT');
assert(/delivery_gate_report/.test(harnessSrc), 'harness 应发 delivery_gate_report 事件');
assert(/getProjectDir\(projectRoot \|\| cwd\)/.test(harnessSrc), 'harness 应落到项目轨迹目录');
// 门控 fail-soft:落盘包在 try/catch,off-word 列表与既有门同形
assert(/\['0', 'false', 'off', 'no'\]\.includes\(\s*String\(process\.env\.KHY_DELIVERY_GATE_REPORT/.test(harnessSrc),
  'harness 门控应用既有 off-word 语义(关 → 字节回退)');
console.log('  ✓ harness 接线存在且门控 fail-soft\n');

// 测试 9: 门已在 flagRegistry 注册为 default-on
console.log('测试 9: KHY_DELIVERY_GATE_REPORT 已注册 default-on');
const flagSrc = fs.readFileSync(
  path.join(__dirname, '../../src/services/flagRegistry.js'), 'utf-8'
);
assert(/KHY_DELIVERY_GATE_REPORT:\s*\{\s*mode:\s*'default-on'/.test(flagSrc), '门应注册为 default-on');
console.log('  ✓ 门已注册\n');

console.log('=== 所有测试通过 ===');

/**
 * taskTemplates 单元测试
 */

const assert = require('assert');
const { matchTemplate, generateTaskInstructions, listTemplates } = require('../../src/services/taskTemplates');

console.log('=== taskTemplates 单元测试 ===\n');

// 测试 1: 匹配"添加 API 端点"模板
console.log('测试 1: 匹配"添加 API 端点"模板');
const input1 = '给这个项目加个健康检查接口';
const template1 = matchTemplate(input1);
assert(template1 !== null, '应匹配到模板');
assert.strictEqual(template1.id, 'add-api-endpoint', '应匹配到 add-api-endpoint');
console.log(`  ✓ 匹配到模板: ${template1.name}\n`);

// 测试 2: 匹配"修复 Bug"模板
console.log('测试 2: 匹配"修复 Bug"模板');
const input2 = '这个函数有 bug，帮我修一下';
const template2 = matchTemplate(input2);
assert(template2 !== null, '应匹配到模板');
assert.strictEqual(template2.id, 'fix-bug', '应匹配到 fix-bug');
console.log(`  ✓ 匹配到模板: ${template2.name}\n`);

// 测试 3: 匹配"添加功能模块"模板
console.log('测试 3: 匹配"添加功能模块"模板');
const input3 = '加个日志轮转功能';
const template3 = matchTemplate(input3);
assert(template3 !== null, '应匹配到模板');
assert.strictEqual(template3.id, 'add-feature-module', '应匹配到 add-feature-module');
console.log(`  ✓ 匹配到模板: ${template3.name}\n`);

// 测试 4: 匹配"spec-driven"模板
console.log('测试 4: 匹配"spec-driven"模板');
const input4 = '添加缓存层，先定义 spec 和验收条件';
const template4 = matchTemplate(input4);
assert(template4 !== null, '应匹配到模板');
assert.strictEqual(template4.id, 'spec-driven-implementation', '应匹配到 spec-driven-implementation');
console.log(`  ✓ 匹配到模板: ${template4.name}\n`);

// 测试 5: 不匹配任何模板
console.log('测试 5: 不匹配任何模板');
const input5 = '这是一个完全无关的问题';
const template5 = matchTemplate(input5);
assert.strictEqual(template5, null, '不应匹配到模板');
console.log('  ✓ 正确返回 null\n');

// 测试 6: 生成执行指令
console.log('测试 6: 生成执行指令');
const result = generateTaskInstructions('添加健康检查接口', {
  endpoint: '/health',
  method: 'GET',
  responseData: '{ status: "ok" }',
  serverFile: 'server.js',
  testFile: 'test-health.js'
});
assert(result !== null, '应生成指令');
assert.strictEqual(result.templateId, 'add-api-endpoint', '模板 ID 正确');
assert(result.instructions.includes('Step 1'), '应包含步骤');
assert(result.instructions.includes('/health'), '应包含参数替换');
assert(result.instructions.includes('验证'), '应包含验证条件');
console.log('  ✓ 指令生成成功');
console.log('  指令长度:', result.instructions.length, '字符');
console.log('  必需参数:', result.requiredParams.join(', '));
console.log('');

// 测试 7: 列出所有模板
console.log('测试 7: 列出所有模板');
const templates = listTemplates();
assert(templates.length >= 4, '应至少有 4 个内置模板');
templates.forEach(t => {
  assert(t.id, '模板应有 ID');
  assert(t.name, '模板应有名称');
  assert(t.description, '模板应有描述');
  assert(Array.isArray(t.keywords), '关键词应是数组');
  console.log(`  - ${t.id}: ${t.name} (关键词: ${t.keywords.slice(0, 3).join(', ')}...)`);
});
console.log('');

// 测试 8: 验证步骤结构完整性
console.log('测试 8: 验证步骤结构完整性');
const template = matchTemplate('添加接口');
assert(template !== null, '应匹配到模板');
assert(Array.isArray(template.steps), '步骤应是数组');
assert(template.steps.length > 0, '应有至少一个步骤');

template.steps.forEach((step, idx) => {
  assert(step.description, `步骤 ${idx + 1} 应有描述`);
  if (step.tool) {
    assert(typeof step.tool === 'string', `步骤 ${idx + 1} 工具应是字符串`);
  }
  if (step.verify) {
    assert(typeof step.verify === 'string', `步骤 ${idx + 1} 验证条件应是字符串`);
  }
});
console.log(`  ✓ 模板 ${template.id} 的 ${template.steps.length} 个步骤结构完整\n`);

// 测试 9: 参数替换
console.log('测试 9: 参数替换');
const instructions = generateTaskInstructions('加个日志功能', {
  featureName: 'logger',
  moduleFile: 'logger.js',
  mainFile: 'server.js'
});
assert(instructions.instructions.includes('logger.js'), '应替换 moduleFile 参数');
assert(instructions.instructions.includes('server.js'), '应替换 mainFile 参数');
console.log('  ✓ 参数替换正确\n');

// 测试 10: 多语言匹配
console.log('测试 10: 多语言匹配(中英文)');
const inputs = [
  '添加接口',
  'add endpoint',
  '新增端点',
  'add api'
];
inputs.forEach(input => {
  const t = matchTemplate(input);
  assert(t !== null, `"${input}" 应匹配到模板`);
  assert.strictEqual(t.id, 'add-api-endpoint', `"${input}" 应匹配到正确模板`);
});
console.log('  ✓ 中英文关键词均能匹配\n');

console.log('=== 所有测试通过 ===');

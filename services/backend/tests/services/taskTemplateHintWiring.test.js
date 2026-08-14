'use strict';

/**
 * OPS-MAN-154 接线验证:taskTemplates 叶 → agenticHarnessService loopInput 组装。
 *
 * 此前 taskTemplates.js(matchTemplate/generateTaskInstructions/listTemplates)是「有能力
 * 但没接线」的孤儿叶(唯一消费者是它自己的单测)。本测证明它已被接进 harness 的上下文
 * 组装:用户消息命中常见任务(加接口/修 bug/加功能/spec 驱动)关键词时,把该模板的分步
 * 执行手册作为 [Task Playbook] 段附加进模型 loopInput——纯引导,降低小模型推理负担,绝不
 * 抑制任何输出。直接服务送别礼「让小模型也能照执行手册完成任务」。
 *
 * 纯脚本 assert 风格(可 `node <file>` 直跑)。经 harness `_internals` 测试逃生阀验证纯/gated
 * helper(该文件既有约定),外加源级接线断言 + 门控 default-on 登记。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const harness = require('../../src/services/agenticHarnessService');
const { _collectTemplateHint, _buildLoopInput } = harness._internals;
const taskTemplates = require('../../src/services/taskTemplates');

let pass = 0;
let fail = 0;
function ok(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    fail += 1;
    console.log(`FAIL  ${name}\n      ${e && e.message}`);
  }
}

const BARE = { userMessage: 'U', memoryHints: [], skillHints: [], contextRoute: { route: 'fits' } };

console.log('taskTemplateHintWiring.test.js');

// ---- 1) 叶基线:命中关键词返回分步手册 ----
ok('leaf generateTaskInstructions matches a known task and returns a playbook string', () => {
  const r = taskTemplates.generateTaskInstructions('please add api and add endpoint');
  assert.ok(r && r.templateId, 'expected a matched template');
  assert.strictEqual(typeof r.instructions, 'string', 'instructions is a string playbook');
  assert.ok(r.instructions.length > 0, 'playbook non-empty');
});

// ---- 2) 接线:门控开 + 命中 → _collectTemplateHint 返回手册 ----
ok('_collectTemplateHint (gate on) returns hint for a matching message', () => {
  const prev = process.env.KHY_TASK_TEMPLATE_HINT;
  delete process.env.KHY_TASK_TEMPLATE_HINT; // default-on
  try {
    const hint = _collectTemplateHint({ userMessage: 'add api / add endpoint for users' });
    assert.ok(hint, 'hint returned');
    assert.strictEqual(hint.templateId, 'add-api-endpoint');
    assert.ok(hint.instructions && hint.instructions.length > 0, 'instructions present');
  } finally {
    if (prev === undefined) delete process.env.KHY_TASK_TEMPLATE_HINT;
    else process.env.KHY_TASK_TEMPLATE_HINT = prev;
  }
});

// ---- 3) 门控关 → null(byte-revert) ----
ok('_collectTemplateHint (gate off KHY_TASK_TEMPLATE_HINT=0) returns null', () => {
  const prev = process.env.KHY_TASK_TEMPLATE_HINT;
  process.env.KHY_TASK_TEMPLATE_HINT = '0';
  try {
    const hint = _collectTemplateHint({ userMessage: 'add api / add endpoint for users' });
    assert.strictEqual(hint, null, 'gate off must return null');
  } finally {
    if (prev === undefined) delete process.env.KHY_TASK_TEMPLATE_HINT;
    else process.env.KHY_TASK_TEMPLATE_HINT = prev;
  }
});

// ---- 4) 不命中 → null ----
ok('_collectTemplateHint returns null for a non-task message', () => {
  const prev = process.env.KHY_TASK_TEMPLATE_HINT;
  delete process.env.KHY_TASK_TEMPLATE_HINT;
  try {
    assert.strictEqual(_collectTemplateHint({ userMessage: 'just saying hello, how are you' }), null);
  } finally {
    if (prev === undefined) delete process.env.KHY_TASK_TEMPLATE_HINT;
    else process.env.KHY_TASK_TEMPLATE_HINT = prev;
  }
});

// ---- 5) _buildLoopInput 注入 [Task Playbook] 段(手册可见于模型上下文) ----
ok('_buildLoopInput appends a [Task Playbook] section when templateHint present', () => {
  const out = _buildLoopInput({
    ...BARE,
    templateHint: { templateId: 'fix-bug', templateName: '修复 Bug', instructions: 'STEP-A\nSTEP-B' },
  });
  assert.ok(out.includes('[Task Playbook: 修复 Bug]'), 'playbook header present');
  assert.ok(out.includes('STEP-A') && out.includes('STEP-B'), 'playbook body present');
});

// ---- 6) 无 templateHint → loopInput 逐字节回退(纯 additive 不改既有形状) ----
ok('_buildLoopInput without templateHint is byte-identical to the legacy shape', () => {
  const out = _buildLoopInput({ ...BARE, templateHint: null });
  assert.ok(!out.includes('Task Playbook'), 'no playbook section');
  assert.strictEqual(out, 'U', 'bare userMessage only (no hints, fits route)');
});

// ---- 7) 空 instructions 的畸形 hint 不注入(防御) ----
ok('_buildLoopInput ignores a templateHint with empty instructions', () => {
  const out = _buildLoopInput({ ...BARE, templateHint: { templateId: 'x', templateName: 'X', instructions: '' } });
  assert.ok(!out.includes('Task Playbook'), 'empty instructions → no section');
});

// ---- 8) 源级接线断言(防止未来悄悄断桥) ----
ok('agenticHarnessService.js source wires taskTemplates under the gate', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/services/agenticHarnessService.js'), 'utf-8');
  assert.ok(/require\(['"]\.\/taskTemplates['"]\)/.test(src), 'requires ./taskTemplates');
  assert.ok(/generateTaskInstructions/.test(src), 'calls generateTaskInstructions');
  assert.ok(/KHY_TASK_TEMPLATE_HINT/.test(src), 'reads the gate flag');
  assert.ok(/\[Task Playbook/.test(src), 'formats the playbook section');
  assert.ok(/templateHint/.test(src), 'threads templateHint through the packet');
  assert.ok(/\['0',\s*'false',\s*'off',\s*'no'\]/.test(src), 'off-word byte-revert pattern');
});

// ---- 9) 门控已在 flagRegistry 登记为 default-on ----
ok('KHY_TASK_TEMPLATE_HINT registered default-on in flagRegistry', () => {
  const reg = fs.readFileSync(path.join(__dirname, '../../src/services/flagRegistry.js'), 'utf-8');
  const idx = reg.indexOf('KHY_TASK_TEMPLATE_HINT');
  assert.ok(idx >= 0, 'flag present');
  const slice = reg.slice(idx, idx + 120);
  assert.ok(/default-on/.test(slice) && /default:\s*true/.test(slice), 'default-on / true');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

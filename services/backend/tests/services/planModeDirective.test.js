'use strict';

/**
 * planModeDirective — 行为锁:计划模式「先调研再做计划」的 per-turn [SYSTEM] 指令构造(node:test)。
 *
 * 该纯叶子把「计划模式该怎么做」的指令文本单一真源化:门开(KHY_PLAN_CC_RESEARCH,默认 on)时
 * buildPlanDirective 返回一段 [SYSTEM] 指令,教模型先用只读工具调研、再调 ExitPlanMode(plan)
 * 呈现计划;门关时返空串(caller 不注入,计划模式逐字节回退旧单次 startPlan)。本套锁定:
 * 门控默认/关/开三态、指令关键要素(只读调研 / 实时工具进度 / ExitPlanMode 编号计划 / 不弹大方框
 * 语义)、fail-soft 绝不抛、纯叶子零 I/O(源级无 fs / 网络 / 子进程 / 计划服务边)。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const MOD = '../../src/services/planModeDirective';

test('isPlanResearchEnabled:缺省 → true(default-on)', () => {
  const d = require(MOD);
  assert.strictEqual(d.isPlanResearchEnabled({}), true);
});

test('isPlanResearchEnabled:门关值(0/off/false/no) → false', () => {
  const d = require(MOD);
  for (const v of ['0', 'off', 'false', 'no']) {
    assert.strictEqual(d.isPlanResearchEnabled({ KHY_PLAN_CC_RESEARCH: v }), false, `值 ${v} 应关`);
  }
});

test('isPlanResearchEnabled:显式开值(1/on) → true', () => {
  const d = require(MOD);
  assert.strictEqual(d.isPlanResearchEnabled({ KHY_PLAN_CC_RESEARCH: '1' }), true);
  assert.strictEqual(d.isPlanResearchEnabled({ KHY_PLAN_CC_RESEARCH: 'on' }), true);
});

test('buildPlanDirective:门开 → 返回非空 [SYSTEM] 指令', () => {
  const d = require(MOD);
  const out = d.buildPlanDirective({});
  assert.strictEqual(typeof out, 'string');
  assert.ok(out.length > 0, '门开应返回非空指令');
  assert.ok(out.startsWith('[SYSTEM:'), '应以 [SYSTEM: 前缀');
});

test('buildPlanDirective:门关 → 空串(逐字节回退,caller 不注入)', () => {
  const d = require(MOD);
  assert.strictEqual(d.buildPlanDirective({ KHY_PLAN_CC_RESEARCH: '0' }), '');
  assert.strictEqual(d.buildPlanDirective({ KHY_PLAN_CC_RESEARCH: 'off' }), '');
});

test('指令含关键要素:只读调研 / ExitPlanMode 编号计划 / 实时工具进度', () => {
  const d = require(MOD);
  const out = d.buildPlanDirective({});
  assert.ok(/计划模式|PLAN MODE/.test(out), '应声明处于计划模式');
  assert.ok(/只读工具|Read\/Grep\/Glob/.test(out), '应指示用只读工具调研');
  assert.ok(/ExitPlanMode/.test(out), '应指示用 ExitPlanMode 呈现计划');
  assert.ok(/编号/.test(out), '应要求编号执行计划');
  assert.ok(/实时/.test(out), '应说明工具调用实时显示即进度');
  // 「不要只回一句让我先了解一下环境就停下」——针对旧口语化死角
  assert.ok(/了解一下环境|不是计划/.test(out), '应堵住「只说要调研却不动手」的死角');
});

test('PLAN_DIRECTIVE 常量即 buildPlanDirective 门开输出(单一真源)', () => {
  const d = require(MOD);
  assert.strictEqual(d.buildPlanDirective({}), d.PLAN_DIRECTIVE);
});

test('fail-soft:异常输入不抛,返回字符串', () => {
  const d = require(MOD);
  assert.doesNotThrow(() => d.buildPlanDirective(null));
  assert.doesNotThrow(() => d.buildPlanDirective(undefined));
  assert.strictEqual(typeof d.buildPlanDirective(null), 'string');
});

test('纯叶子:源级零 I/O(不 require fs / net / child_process / 计划服务)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/services/planModeDirective.js'), 'utf8');
  for (const forbidden of ['fs', 'net', 'http', 'https', 'child_process', 'planModeService', 'planModeSink', 'toolUseLoop']) {
    assert.strictEqual(
      new RegExp(`require\\(\\s*['"]\\.?\\.?/?${forbidden}['"]`).test(src),
      false,
      `纯叶子不得 require ${forbidden}`,
    );
  }
  // 契约措辞:纯叶子 / 零 I/O / 绝不抛(供 leaf-contract 守卫识别)
  assert.ok(/纯叶子/.test(src) && /零 I\/O/.test(src) && /绝不抛/.test(src), 'docstring 应含纯叶子契约措辞');
});

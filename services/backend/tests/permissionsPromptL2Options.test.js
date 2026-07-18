'use strict';

/**
 * permissionsPromptL2Options.test.js — 锁定 TUI 高危(L2)授权框的三项结构性不变量。
 *
 * PermissionsPrompt 是 ink/React 组件,纯渲染单测成本高;此处用源码静态断言(沿用
 * permissionPromptPort.test.js 的 read() 模式)锁住三条易回退的关键接线:
 *   ① 第三项「本会话内总是允许此类高危操作」由 isL2SessionAllowEnabled() 门控渲染(关→消失);
 *   ② L2 选项以「拒绝优先」授权,排序交给单一真源 permissionOptionOrder.orderOptions({highRisk});
 *   ③ footer 默认行文案由 _enabled()&&_highRiskOptIn() 决定(允许优先→「确认执行」,回退→「拒绝」)。
 * 真正的重排/光标语义由 permissionOptionOrder.test.js 的纯函数用例覆盖。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '../src/cli/tui/ink-components/PermissionsPrompt.js');
const src = fs.readFileSync(SRC, 'utf8');

test('① 第三项 session 由 isL2SessionAllowEnabled 门控渲染', () => {
  assert.match(src, /isL2SessionAllowEnabled/, '引入门控判定');
  assert.match(src, /const l2SessionAllowed = isL2SessionAllowEnabled\(\)/, '在 L2 选项前求值门控');
  // 第三项仅在门控开时进入数组(三元 spread)。
  assert.match(src, /l2SessionAllowed[\s\S]*?key: 'session'[\s\S]*?scope: 'session'/, '门控开才追加 session 项');
  assert.match(src, /behavior: 'allow-always', typed: confirmWord, scope: 'session'/, 'session 项载荷正确');
});

test('② L2 授权 deny-first,排序交给 orderOptions({highRisk})', () => {
  assert.match(src, /permissionOptionOrder\.orderOptions\(builtOptions, \{ highRisk: isL2 \}\)/, '排序经单一真源');
  // builtOptions 在 isL2 分支以拒绝在前授权(交给 orderOptions 重排)。
  assert.match(src, /isL2\s*\?\s*\[[\s\S]*?key: 'deny'[\s\S]*?key: 'confirm'/, 'L2 以 deny 在前授权');
});

test('③ footer 默认文案由 _enabled()&&_highRiskOptIn() 决定', () => {
  assert.match(src, /permissionOptionOrder\._enabled\(\) && permissionOptionOrder\._highRiskOptIn\(\)/, 'footer 依两门控');
  assert.match(src, /默认「确认执行」/, '允许优先文案');
  assert.match(src, /默认「拒绝」/, '回退文案');
});

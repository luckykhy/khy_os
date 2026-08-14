'use strict';

/**
 * nlActionResolver — 自然语言 → khyos「动作意图」解析(单一真源)的确定性测试(node:test)。
 *
 * 锁定:① 门控默认开 / 关即字节回退(routeActionIntent 恒 null);② 旗舰两动作
 * (自查修复自身 bug、去开源平台学最火项目)正确识别;③ 零假阳性(用户自己的项目、
 * 单纯学语法、寒暄、配置开关类、问「github 是什么」一律不误触);④ 指令含安全栏 +
 * 诚实边界 + 只指向既有工具;⑤ 任意坏输入绝不抛。
 */

const test = require('node:test');
const assert = require('node:assert');

const r = require('../src/services/config/nlActionResolver');

const ON = { KHY_NL_ACTION: 'true' };
const OFF = { KHY_NL_ACTION: 'off' };

// ── 门控 ─────────────────────────────────────────────────────────────────────
test('isEnabled: 默认开;仅 {0,false,off,no} 关', () => {
  assert.strictEqual(r.isEnabled({}), true);
  assert.strictEqual(r.isEnabled({ KHY_NL_ACTION: undefined }), true);
  assert.strictEqual(r.isEnabled({ KHY_NL_ACTION: 'true' }), true);
  assert.strictEqual(r.isEnabled({ KHY_NL_ACTION: '1' }), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', 'No']) {
    assert.strictEqual(r.isEnabled({ KHY_NL_ACTION: v }), false, `应为关:${v}`);
  }
});

test('门控关 → routeActionIntent / resolveActionIntent 恒 null(字节回退)', () => {
  assert.strictEqual(r.routeActionIntent({ text: '帮我找你自己的 bug 并修复', env: OFF }), null);
  assert.strictEqual(r.resolveActionIntent('去 github 学最火的项目', OFF), null);
});

// ── 旗舰动作一:自查并修复自身 bug ─────────────────────────────────────────────
test('self-bug-fix: 识别「找/修 khy 自己的 bug」多种表述', () => {
  const positives = [
    '帮我找你自己的 bug 并修复',
    '让 khy 寻找自己的 bug 并修复',
    'khy 你去排查一下自身的缺陷然后修掉',
    '检查你自己的代码有没有漏洞',
    'find bugs in yourself and fix them',
    'audit your own code for defects',
  ];
  for (const t of positives) {
    const out = r.routeActionIntent({ text: t, env: ON });
    assert.ok(out, `应命中:${t}`);
    assert.strictEqual(out.intent.id, 'self-bug-fix', `id 应为 self-bug-fix:${t}`);
  }
});

test('self-bug-fix: 指令含安全栏 + 诚实边界 + 只指向既有工具', () => {
  const out = r.routeActionIntent({ text: '找你自己的 bug 并修复', env: ON });
  const d = out.directive;
  assert.ok(d.includes('[SYSTEM:'), '应为 SYSTEM 指令');
  // 指向既有工具/子系统(绝不重造)
  assert.ok(/Grep|Read|lintCode/.test(d), '应指向既有排查工具');
  assert.ok(/editFile|MultiEdit/.test(d), '应指向既有改文件工具');
  assert.ok(d.includes('evolutionPolicy'), '应提醒可变性分级');
  assert.ok(d.includes('auditFixLoop'), '应提及完成时自动复审');
  // 安全栏 + 诚实
  assert.ok(d.includes('immutable'), '应强调 immutable 绝不改');
  assert.ok(/绝不臆造|绝不.*编造|未发现明确 bug/.test(d), '应有诚实边界(查无则如实说)');
});

// ── 旗舰动作二:去开源平台学最新/最火项目 ─────────────────────────────────────
test('forge-learn: 识别「去 GitHub/GitLab 学最火项目」多种表述', () => {
  const positives = [
    '让 khyos 去 github 上学习最火的项目',
    '去 gitlab 看看最热门的开源项目学习一下',
    '到 gitee 上研读最受欢迎的仓库',
    'go learn from the hottest projects on github',
    '学习一下当下最流行的开源框架',
  ];
  for (const t of positives) {
    const out = r.routeActionIntent({ text: t, env: ON });
    assert.ok(out, `应命中:${t}`);
    assert.strictEqual(out.intent.id, 'forge-learn', `id 应为 forge-learn:${t}`);
  }
});

test('forge-learn: 指令指向 forge 工具 + star 降序 + clone URL 不嵌 token + 诚实', () => {
  const out = r.routeActionIntent({ text: '去 github 学习最火的项目', env: ON });
  const d = out.directive;
  assert.ok(d.includes('[SYSTEM:'), '应为 SYSTEM 指令');
  assert.ok(d.includes('forgeSearch'), '应指向 forgeSearch');
  assert.ok(/forgeRecon|forgeCodeSearch|forgeCommits/.test(d), '应指向研读工具');
  assert.ok(d.includes('gitClone'), '应指向 gitClone 深读');
  assert.ok(/star.*降序|降序.*star/.test(d), '应说明默认按 star 降序=最火');
  assert.ok(d.includes('token'), '应警示 clone URL 绝不内嵌 token');
  assert.ok(/速率限制|无网络|无凭据/.test(d), '应有诚实边界');
});

// ── 零假阳性 ─────────────────────────────────────────────────────────────────
test('零假阳性:用户自己的项目 / 单纯学语法 / 寒暄 / 配置开关 / 问概念 一律不误触', () => {
  const negatives = [
    '帮我找我项目里的 bug',          // 用户自己的项目,非 khy 自身
    '帮我修复这段代码的 bug',         // 无 self 引用
    '学习一下 promise 怎么用',        // 无平台 / 无项目+热度
    '解释一下什么是闭包',             // 纯问答
    '你好,在吗',                    // 寒暄
    '把流式渲染打开',                 // 配置开关(归 nlConfig)
    'github 是什么',                 // 提到平台但无学习动词
    '帮我看看这个错误日志',           // 有「错误」但无 self 引用
    '',                              // 空
  ];
  for (const t of negatives) {
    assert.strictEqual(r.routeActionIntent({ text: t, env: ON }), null, `应不误触:${t}`);
  }
});

// ── fail-soft / 内省 API ──────────────────────────────────────────────────────
test('绝不抛:坏输入一律 fail-soft 返回 null', () => {
  for (const bad of [null, undefined, 123, {}, [], { toString() { throw new Error('boom'); } }]) {
    assert.doesNotThrow(() => r.resolveActionIntent(bad, ON));
    assert.strictEqual(r.resolveActionIntent(bad, ON), null);
  }
  assert.doesNotThrow(() => r.routeActionIntent({}));
  assert.doesNotThrow(() => r.routeActionIntent(null));
});

test('代码块内的关键词不应触发(只看自然语言指令)', () => {
  const t = '帮我看这段代码 ```js\n// 去 github 学习最火的项目\nfindBug(yourself)\n```';
  assert.strictEqual(r.routeActionIntent({ text: t, env: ON }), null);
});

test('describeActions / findAction:内省 SSOT', () => {
  const list = r.describeActions();
  assert.ok(Array.isArray(list) && list.length >= 2);
  const ids = list.map((a) => a.id);
  assert.ok(ids.includes('self-bug-fix') && ids.includes('forge-learn'));
  assert.strictEqual(r.findAction('self-bug-fix').id, 'self-bug-fix');
  assert.strictEqual(r.findAction('nope'), null);
  assert.strictEqual(r.findAction(''), null);
});

test('命中多动作时按 ACTIONS 顺序取第一个(确定性)', () => {
  // 同时含「找自身 bug」与「去 github 学习」语义 → self-bug-fix 在前
  const t = '让 khy 找自己的 bug 并修复,顺便去 github 学习最火的项目';
  const out = r.routeActionIntent({ text: t, env: ON });
  assert.ok(out);
  assert.strictEqual(out.intent.id, 'self-bug-fix');
});

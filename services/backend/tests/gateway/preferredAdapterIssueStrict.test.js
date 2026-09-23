'use strict';

/**
 * preferredAdapterIssueStrict.test.js — [DESIGN-ARCH-136] 第 3 期的守卫。
 *
 * 第 3 期**不是新增检测** —— `_resolvePreferredAdapterIssue`(gateway.js) 与
 * `baseSelfCheckService.js` 早已分别检出「钉选 + 首选项不可用」。真正的缺口是
 * **两者对同一事实轻重不一**:selfcheck 判 error 并明说「所有 AI 调用将硬失败」,
 * 而 `gateway status` 只说「首选通道当前不可用」,未披露 GATEWAY_PREFERRED_STRICT
 * 这个放大器(它把「损失一个通道」升格为「每轮请求全灭」)。
 *
 * ⚠️ 本文件按**源码文本**断言 —— 因为 `_resolvePreferredAdapterIssue` 由
 * `setGatewayStatusViewDeps` 以 DI 注入 `gatewayStatusView`,**不在 module.exports 里**,
 * 且其宿主 `gateway.js` 顶层携带大量 DI 装配,直接 require 取不到该函数(实测)。
 * 为不扩大 `gateway.js` 的导出面(会牵动 API 契约门),此处退化为文本守卫。
 * 本仓既有同类先例:`tests/cli/tui/clearResetsHistory.test.js` 断言 App.js 源码。
 *
 * 只断言「关键判据存在 + 关键披露存在」,不耦合缩进与换行,避免重构误伤。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', '..', ...rel.split('/')), 'utf8');

test('P-01 钉选判定必须携带 strict 维度,且判据与 generate/selfcheck 同源', () => {
  const src = read('src/cli/handlers/gateway.js');
  assert.match(src, /GATEWAY_PREFERRED_STRICT/, 'gateway.js 必须读 STRICT');
  // 同源判据:未显式 false 即视为开启(与 aiGatewayGenerateMethod / baseSelfCheckService 一致)
  assert.match(src, /!==\s*'false'/, 'strict 判据必须是「未显式 false 即视为开启」');
  const branches = src.match(/\n\s+strict,\n/g) || [];
  assert.ok(
    branches.length >= 2,
    `invalid 与 unavailable 两个 branch 都必须回传 strict,实际 ${branches.length} 处`
  );
});

test('P-02 gateway status 必须披露 strict 的后果,不能只说「不可用」', () => {
  const view = read('src/cli/handlers/gatewayStatusView.js');
  assert.match(view, /preferredIssue\.strict/, '渲染层必须消费 strict');
  assert.match(view, /每次 AI 调用/, '必须讲清后果(与 selfcheck 同重)');
  assert.match(view, /GATEWAY_PREFERRED_STRICT=false/, '必须给出「保留钉选但放行回退」这条中间路');
});

test('P-03 处置建议必须含「解钉」路径,而不只有「换通道」', () => {
  const view = read('src/cli/handlers/gatewayStatusView.js');
  assert.match(view, /GATEWAY_PREFERRED_ADAPTER 清空或设为 auto/);
  assert.match(view, /khy doctor/, '应指向带 autoRepair 的 doctor(baseSelfCheckService 会改写 env)');
  assert.match(view, /khy gateway model/, '既有的换通道路径必须保留,不得为了加新路而删旧路');
});

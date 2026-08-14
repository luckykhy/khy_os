'use strict';

/**
 * architectureLayering.test.js — 分层边界守卫（DESIGN-ARCH-057）。
 *
 * 契约：cli → services 合法；services → cli 为反向违例。除已登记延后的边外，
 * service 层不得 require cli/*。本测试把"现存反向边"钉成一份显式白名单：
 *   - 新增任何 service→cli 反向边 → 红灯（防止架构债回潮）。
 *   - 白名单里的边被切断后忘了更新白名单 → 红灯（提示收紧白名单）。
 *
 * 已切断（经端口倒置，零反向边）：
 *   toolCalling / preflightPermission → permissionDialog（permissionPromptPort）
 *   inputPreprocessor → inkComponents（interactiveMenuPort）
 *   daemonEntry / crashRecovery → cliErrorReporter（describeCliError 下沉 cliErrorDescriptor）
 *
 * 已切断（经"叶子迁移"——把错放在 cli/ 但零 cli 消费者的纯叶子归位到 services/）：
 *   aiManagementServer → cli/webContextStats     ┐ 上下文可视化家族(webContextStats/
 *   （及其家族 messageBreakdown/contextSuggestions/│ messageBreakdown/contextSuggestions/
 *     contextBreakdown 一并迁至 services/context/）┘ contextBreakdown)本是上下文域逻辑，
 *                                                   与 ctxWindowStats 同属 services/context/。
 *   postEditDiagnostics / toolUseLoop → cli/postEditDiagnosticsSummary（零 cli 消费者 → 迁 services/）
 *   tipHistoryStore → cli/tipScheduler（零 cli 消费者 → 迁 services/）
 *
 * 仍延后（[MGMT-RPT-020] 痛点诊断报告，225KB 巨石，单列后续 PR）：
 *   aiManagementServer → cli/ai
 *
 * 仍延后（共享内核债 [DESIGN-ARCH-057]）：以下 cli/ 叶子被 cli 与 services 双方消费
 *   （ccFormat 31 个 cli 消费者、formatters 126 个、ccModelName 5 个 …），是事实上的
 *   "共享内核"错置在 cli/。正解是引入中立的 shared/ 内核层再整体归位（跨多文件的大改，
 *   单列后续 PR）；在此之前显式登记为已知债，使守卫恢复绿灯以继续拦截"新增"反向边。
 *   逐条见下方 ALLOWED_REVERSE_EDGES 的"共享内核债"段。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SERVICES_DIR = path.join(__dirname, '..', 'src', 'services');

// 显式登记：当前允许存在的 service→cli 反向边。键=相对 src/services 的文件，值=被 require 的 cli 路径片段。
const ALLOWED_REVERSE_EDGES = [
  { from: 'aiManagementServer.js', to: '../cli/ai' },

  // ── 共享内核债 [DESIGN-ARCH-057] ──────────────────────────────────────────
  // 以下 cli/ 叶子被 cli 与 services 双方消费（纯格式化/域工具，无 IO），是错置在
  // cli/ 的"共享内核"。正解=引入 shared/ 层整体归位（大改，后续 PR）；在此之前显式
  // 登记为已知债，恢复守卫绿灯以继续拦截"新增"反向边。切断后须同步删除对应条目。
  // 聊天代理平面从 aiManagementServer 抽为叶子 aiManagementChatHttp.js,require site 随迁(债性质不变)。
  { from: 'aiManagementChatHttp.js', to: '../cli/repl/imageIntent' },
  { from: 'aiManagementChatHttp.js', to: '../cli/toolResultSummary' },
  { from: 'aiUploadStore.js', to: '../cli/ccFormat' },
  { from: 'aiUploadStore.js', to: '../cli/handlers/convert' },
  { from: 'archiveManifestPolicy.js', to: '../cli/ccFormat' },
  { from: 'deliveryFormatter.js', to: '../cli/toolCallNoise' },
  { from: 'gatewayResetService.js', to: '../cli/formatters' },
  { from: 'imageService.js', to: '../cli/ccFormat' },
  { from: 'multimodalInputService.js', to: '../cli/ccFormat' },
  { from: 'resumeAdvisor.js', to: '../cli/ccFormat' },
  { from: 'tokenUsageService.js', to: '../cli/ccFormat' },
  { from: 'tokenUsageService.js', to: '../cli/ccModelName' },
  // 权限子系统从 toolCalling 抽为叶子 toolCallingPermissions.js,permissionReply require 随迁(债性质不变)。
  { from: 'toolCallingPermissions.js', to: '../cli/permissionReply' },
  { from: 'toolUseLoop.js', to: '../cli/keyFindings' },
  { from: 'toolUseLoop.js', to: '../cli/resultGuard' },
  { from: 'toolUseLoop.js', to: '../cli/toolPrefaceVoice' },
];

function collectReverseEdges() {
  const edges = [];
  const re = /require\(\s*['"](\.\.\/cli[^'"]*)['"]\s*\)/g;
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(p); continue; }
      if (!ent.name.endsWith('.js')) continue;
      const src = fs.readFileSync(p, 'utf8');
      let m;
      while ((m = re.exec(src))) {
        edges.push({ from: path.relative(SERVICES_DIR, p).split(path.sep).join('/'), to: m[1] });
      }
    }
  };
  walk(SERVICES_DIR);
  return edges;
}

test('service→cli 反向边精确等于已登记白名单（防架构债回潮）', () => {
  const found = collectReverseEdges();
  const norm = (e) => `${e.from} -> ${e.to}`;
  const foundSet = new Set(found.map(norm));
  const allowSet = new Set(ALLOWED_REVERSE_EDGES.map(norm));

  const unexpected = [...foundSet].filter((e) => !allowSet.has(e));
  assert.deepStrictEqual(
    unexpected, [],
    `发现未登记的 service→cli 反向边（架构债回潮）：\n  ${unexpected.join('\n  ')}\n` +
    `若为有意延后，请加入 ALLOWED_REVERSE_EDGES；否则用端口倒置切断。`,
  );

  const stale = [...allowSet].filter((e) => !foundSet.has(e));
  assert.deepStrictEqual(
    stale, [],
    `白名单中的反向边已不存在（应收紧白名单）：\n  ${stale.join('\n  ')}`,
  );
});

test('interactiveMenuPort 是零依赖叶子（永不参与成环）', () => {
  const p = path.join(SERVICES_DIR, 'interactiveMenuPort.js');
  const src = fs.readFileSync(p, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  assert.ok(!/\brequire\s*\(/.test(src), 'interactiveMenuPort 不得 require 任何模块');
});

test('inputPreprocessor 经 interactiveMenuPort 取菜单，不再反向 require cli', () => {
  const src = fs.readFileSync(path.join(SERVICES_DIR, 'inputPreprocessor.js'), 'utf8');
  assert.ok(!/require\(\s*['"]\.\.\/cli\/ui\/inkComponents['"]\s*\)/.test(src),
    'inputPreprocessor 不得直接 require cli/ui/inkComponents');
  assert.ok(/require\(\s*['"]\.\/interactiveMenuPort['"]\s*\)/.test(src),
    'inputPreprocessor 应经 interactiveMenuPort 取交互菜单');
});

test('cli/ui/inkComponents 在加载时把 selectMenu 自注册进端口', () => {
  const port = require('../src/services/interactiveMenuPort');
  port._resetForTest();
  assert.strictEqual(port.getMenuPrompter(), null, '加载渲染器前应为 null（headless 降级）');
  require('../src/cli/ui/inkComponents');
  assert.strictEqual(typeof port.getMenuPrompter(), 'function', '加载后应注册 selectMenu 函数');
});

test('describeCliError 已下沉 service 层，daemonEntry/crashRecovery 不再反向 require cliErrorReporter', () => {
  const descriptorPath = path.join(SERVICES_DIR, 'cliErrorDescriptor.js');
  assert.ok(fs.existsSync(descriptorPath), 'cliErrorDescriptor.js 应存在于 service 层');
  for (const f of ['daemonEntry.js', 'crashRecovery.js']) {
    const src = fs.readFileSync(path.join(SERVICES_DIR, f), 'utf8');
    assert.ok(!/require\(\s*['"]\.\.\/cli\/cliErrorReporter['"]\s*\)/.test(src),
      `${f} 不得反向 require cli/cliErrorReporter`);
    assert.ok(/require\(\s*['"]\.\/cliErrorDescriptor['"]\s*\)/.test(src),
      `${f} 应经 ./cliErrorDescriptor 取 describeCliError`);
  }
  // cli 层仍能从原入口拿到（向后兼容再导出），且是下沉后的同一函数
  const fromCli = require('../src/cli/cliErrorReporter').describeCliError;
  const fromSvc = require('../src/services/cliErrorDescriptor').describeCliError;
  assert.strictEqual(fromCli, fromSvc, 'cli 入口应再导出下沉后的同一 describeCliError');
});

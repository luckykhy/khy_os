/**
 * useProxies / ProxyManagement egress wiring 源级断言(node:test·ESM)。
 *   node --test apps/ai-frontend/src/composables/useProxies.egress.wiring.test.js
 *
 * 前端 Vue / @ 别名不能裸 node:test 载入 → 沿用 useProjects.wiring.test.js 的
 * readFileSync + regex 源级断言法,核对 egress URL 组装 + 视图接线,不实际渲染。
 * apps/ai-frontend 是 type:module,故用 import 而非 require。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const COMPOSABLE = readFileSync(join(here, 'useProxies.js'), 'utf8');
const VIEW = readFileSync(join(here, '../views/ProxyManagement.vue'), 'utf8');

test('useProxies: 暴露 egressStatus + fetchEgressStatus/enableNode/disableEgress', () => {
  assert.match(COMPOSABLE, /egressStatus/);
  assert.match(COMPOSABLE, /function fetchEgressStatus\(/);
  assert.match(COMPOSABLE, /function enableNode\(/);
  assert.match(COMPOSABLE, /function disableEgress\(/);
  assert.match(COMPOSABLE, /fetchEgressStatus,\s*enableNode,\s*disableEgress/);
});

test('useProxies: egress URL 组装正确(GET status / POST enable+disable)', () => {
  assert.match(COMPOSABLE, /request\.get\('\/api\/proxy-egress'\)/);
  assert.match(COMPOSABLE, /request\.post\('\/api\/proxy-egress\/enable',/);
  assert.match(COMPOSABLE, /request\.post\('\/api\/proxy-egress\/disable',/);
});

test('useProxies: enableNode 传整个 node 对象(body.node)', () => {
  assert.match(COMPOSABLE, /const body = \{ node \}/);
});

test('ProxyManagement: 顶部启用/停用开关(el-switch 绑 egressEnabled + onToggleEgress)', () => {
  assert.match(VIEW, /class="egress-bar/);
  assert.match(VIEW, /:model-value="egressEnabled"/);
  assert.match(VIEW, /@change="onToggleEgress"/);
});

test('ProxyManagement: 节点表有「使用此节点」按钮 → useNode(row)', () => {
  assert.match(VIEW, /使用此节点/);
  assert.match(VIEW, /@click="useNode\(row\)"/);
});

test('ProxyManagement: 当前激活节点高亮(isActiveNode)', () => {
  assert.match(VIEW, /function isActiveNode\(/);
  assert.match(VIEW, /isActiveNode\(row\)/);
});

test('ProxyManagement: 内核缺失显式指引(不静默),direct-connect 免内核说明', () => {
  assert.match(VIEW, /coreBinaryInstalled/);
  assert.match(VIEW, /\.khyquant\/bin/);
  assert.match(VIEW, /直连型/);
});

test('ProxyManagement: useNode 失败透传 guidance/error(不谎报生效)', () => {
  assert.match(VIEW, /result\?\.guidance \|\| result\?\.error/);
  assert.match(VIEW, /enableNode\(node\)/);
});

test('ProxyManagement: onMounted 拉取出站状态', () => {
  assert.match(VIEW, /proxies\.fetchEgressStatus\(\)/);
});

test('ProxyManagement: 内核缺失横幅显示确切下载 URL + 落地路径 + 一键复制(coreDownload 接线)', () => {
  // 派生:从 egressStatus.coreStatus.download 取后端 SSOT 描述符。
  assert.match(VIEW, /const coreDownload = computed\(/)
  assert.match(VIEW, /coreStatus\?\.download/)
  // 横幅:可点下载 URL + 落地目录 + 复制按钮(copyText)。
  assert.match(VIEW, /coreDownload\.url/)
  assert.match(VIEW, /coreDownload\.binDir/)
  assert.match(VIEW, /coreDownload\.version/)
  assert.match(VIEW, /:href="coreDownload\.url"/)
  assert.match(VIEW, /function copyText\(/)
  assert.match(VIEW, /copyText\(coreDownload\.url/)
})

test('ProxyManagement: 冷门平台无描述符时仍给官方 releases 兜底链接(绝不留死路)', () => {
  assert.match(VIEW, /MetaCubeX\/mihomo\/releases/)
})

/**
 * useWorkflow / Workflows 列表载入「本页降级」接线源级断言(node:test·ESM)。
 *   node --test apps/ai-frontend/src/composables/useWorkflow.wiring.test.js
 *
 * 背景(修复的错误):代理管理页出现「网络连接异常:无法访问 /api/workflow。请确认
 * ai-backend 服务可用后重试。」红色横幅 —— 该横幅是 request.js 拦截器对**非 silent**
 * 失败请求弹的**全局** ElMessage(挂在 document.body,与当前页面无关)。工作流列表
 * (Workflows.vue onMounted → useWorkflow.listWorkflows → GET /api/workflow)此前未标
 * silent 且无本页降级 UI,一次导航遗留 / 后端不可达的失败就会把该横幅泄漏到别页。
 *
 * 修复约定(request.js:88-94):调用方自带可见降级 UI → 请求标 silent,不叠全局 toast。
 * 本测按 useProxies.egress.wiring.test.js 的 readFileSync + regex 源级断言法核对接线,
 * 不实际渲染(Vue / @ 别名不能裸 node:test 载入)。apps/ai-frontend 是 type:module。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const COMPOSABLE = readFileSync(join(here, 'useWorkflow.js'), 'utf8');
const VIEW = readFileSync(join(here, '../views/Workflows.vue'), 'utf8');

test('useWorkflow: 列表 GET 标 silent(不叠全局横幅)', () => {
  // 关键断言:GET /api/workflow 必须带 { silent: true },否则失败会触发全局 notifyError。
  assert.match(COMPOSABLE, /request\.get\('\/api\/workflow',\s*\{\s*silent:\s*true\s*\}\)/);
});

test('useWorkflow: 暴露 loadError 本页降级状态', () => {
  assert.match(COMPOSABLE, /const loadError = ref\(''\)/);
  // listWorkflows 失败时落 loadError(供视图就地渲染),并清零于每次载入开始。
  assert.match(COMPOSABLE, /loadError\.value = ''/);
  assert.match(COMPOSABLE, /loadError\.value =\s*[\s\S]*?加载工作流失败/);
  // 返回对象里导出 loadError。
  assert.match(COMPOSABLE, /workflows, current, nodeTypes, loading, saving, loadError,/);
});

test('useWorkflow: 其余写操作不受影响(create/put/delete URL 组装不变)', () => {
  assert.match(COMPOSABLE, /request\.post\('\/api\/workflow',/);
  assert.match(COMPOSABLE, /request\.put\(`\/api\/workflow\/\$\{id\}`,/);
  assert.match(COMPOSABLE, /request\.delete\(`\/api\/workflow\/\$\{id\}`\)/);
});

test('Workflows.vue: 载入失败就地渲染 el-alert + 重试(取代全局横幅)', () => {
  assert.match(VIEW, /v-if="loadError"/);
  assert.match(VIEW, /class="wf-load-error"/);
  assert.match(VIEW, /:title="loadError"/);
  assert.match(VIEW, /@click="retryLoad"/);
  assert.match(VIEW, /重试/);
});

test('Workflows.vue: 从 useWorkflow 解构 loadError', () => {
  assert.match(VIEW, /workflows, loading, saving, loadError,/);
});

test('Workflows.vue: onMounted 走 retryLoad 并吞掉 rejection(不产生未处理拒绝/全局横幅)', () => {
  assert.match(VIEW, /function retryLoad\(\)/);
  assert.match(VIEW, /listWorkflows\(\)\.catch\(/);
  assert.match(VIEW, /onMounted\(retryLoad\)/);
});

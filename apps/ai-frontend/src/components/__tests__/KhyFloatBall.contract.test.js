/**
 * KhyFloatBall — 源级契约测试（node 环境不挂载组件，readFileSync + 正则断言）。
 *
 * 为什么源级：本组件是「悬浮球 + 拖拽/磁吸 + 双面板（菜单/任务·MCP）+ 三条
 * /ws 本机动作」的复合体，行为几乎全在 <script setup> 内，且依赖
 * localStorage / requestAnimationFrame / WebSocket / Element Plus，node 环境
 * 无法挂载。这里锁的是「接线不变式」：事件绑定、aria、WS 动作类型与回执
 * 类型成对出现、错误文案可诊断、持久化键名稳定。
 * 文件路径：src/components/KhyFloatBall.vue
 */
import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, '..', 'KhyFloatBall.vue'), 'utf-8');

test('可见性门控：仅「有 token 且非登录页」时渲染', () => {
  expect(SRC).toContain('Boolean(userStore.token)');
  expect(SRC).toMatch(/route\.path\s*!==\s*['"]\/login['"]/);
  expect(SRC).toMatch(/v-if="visible"/);
});

test('悬浮球本体：可聚焦按钮 + 完整 aria-label + 左键菜单/右键直达 khy.md', () => {
  expect(SRC).toMatch(/<button\s+class="khy-fb__ball"\s+type="button"\s+aria-label="/);
  expect(SRC).toContain('@contextmenu.prevent="openKhyMd"');
  expect(SRC).toContain('@click="onBallClick"');
  expect(SRC).toContain('@pointerdown="onPointerDown"');
  // 拖拽/磁吸指针事件齐全
  expect(SRC).toContain('@pointerenter="onBallEnter"');
  expect(SRC).toContain('@pointermove="onBallHoverMove"');
  expect(SRC).toContain('@pointerleave="onBallLeave"');
});

test('三条本机动作的 WS 类型/回执类型必须成对出现（后端动作注册名 SSOT）', () => {
  // 托盘
  expect(SRC).toContain("runLocalAction('khyos_tray_start', 'khyos_tray_status')");
  // khy.md
  expect(SRC).toContain("runLocalAction('khyos_md_open', 'khyos_md_status')");
  // 面板双通道复用同一连接：任务 + MCP 各一个请求帧
  expect(SRC).toContain("{ type: 'khyos_tasks_get' }");
  expect(SRC).toContain("{ type: 'khyos_mcp_get' }");
});

test('WS 鉴权帧：onopen 后先发 { type: "auth", token }（总线契约）', () => {
  expect(SRC).toMatch(/\{ type: 'auth', token: userStore\.token \|\| '' \}/);
  // 鉴权失败帧必须收口（reject 而非悬挂）
  expect(SRC).toContain("type === 'auth_error'");
  // 面板侧的鉴权成功帧驱动轮询
  expect(SRC).toContain("type === 'auth_ok'");
});

test('启动 Khy 走前端路由 /khyos（页面自举内核），不直写系统', () => {
  expect(SRC).toMatch(/router\.push\('\/khyos'\)/);
});

test('位置持久化键名稳定（khy_float_ball_pos），经 safeSet 写（不裸写 localStorage）', () => {
  expect(SRC).toContain("const POS_KEY = 'khy_float_ball_pos'");
  expect(SRC).toContain('safeSet(POS_KEY, JSON.stringify(pos.value))');
  // 兼容旧 {right,bottom} 存储：两种形状都读
  expect(SRC).toContain('Number.isFinite(raw.x)');
  expect(SRC).toContain('Number.isFinite(raw.right)');
});

test('动作进行中（busy）禁用全部菜单项，防重复触发', () => {
  const disabledCount = (SRC.match(/:disabled="busy"/g) || []).length;
  expect(disabledCount).toBeGreaterThanOrEqual(3);
  // startTray/openKhyMd 入口都有 busy 哨兵
  expect(SRC).toMatch(/async function startTray\(\) \{\s*if \(busy\.value\) return;/);
  expect(SRC).toMatch(/async function openKhyMd\(\) \{\s*if \(busy\.value\) return;/);
});

test('失败提示遵循「问题 + 原因」红线（不是空洞的「操作失败」）', () => {
  expect(SRC).toMatch(/托盘启动失败:\$\{\(err && err\.message\) \|\| err\}/);
  expect(SRC).toMatch(/打开 khy\.md 失败:\$\{\(err && err\.message\) \|\| err\}/);
  // disabled 状态（KHY_WEB_LOCAL_ACTIONS 关）有独立提示
  expect(SRC).toContain('res.status === \'disabled\'');
});

test('面板关闭/卸载即停定时器 + 关连接（零泄漏不变式）', () => {
  // 关闭任务面板 → stopPanelSync 清双定时器并 close 共享 WS
  expect(SRC).toMatch(/function closeTasks\(\) \{[\s\S]*?stopPanelSync\(\);/);
  // 卸载兜底：removeEventListener + stopPanelSync
  expect(SRC).toMatch(/onBeforeUnmount\(\(\) => \{[\s\S]*?stopPanelSync\(\);\s*\}\)/);
  // stopPanelSync 本体清 task/mcp 定时器并释放 panelWs 引用
  expect(SRC).toMatch(/function stopPanelSync\(\) \{[\s\S]*?if \(panelWs\) \{[\s\S]*?panelWs\.close\(\);[\s\S]*?panelWs = null;/);
});

test('WS 动作 12s 超时收口（防悬挂 Promise），面板轮询双定时器常量存在', () => {
  expect(SRC).toContain("setTimeout(() => done(reject, new Error('操作超时')), 12000)");
  expect(SRC).toContain('const TASK_POLL_MS = 2200;');
  expect(SRC).toContain('const MCP_POLL_MS = 5000;');
});

test('任务状态图标映射完整（completed/in_progress/error/pending），未知状态回 ○', () => {
  expect(SRC).toContain("_STATUS_ICON = { completed: '✓', in_progress: '→', error: '✗', pending: '○' }");
  expect(SRC).toMatch(/return _STATUS_ICON\[status\] \|\| '○';/);
});

test('任务标签：in_progress 优先展示 activeForm（进行时态文案），否则 subject，再否则占位', () => {
  expect(SRC).toMatch(/function taskLabel\(t\) \{\s*if \(t\.status === 'in_progress' && t\.activeForm\) return t\.activeForm;/);
  expect(SRC).toContain("return t.subject || '(未命名任务)';");
});

test('任务面板计数与百分比：completed/total + 进度条（数据绑定齐全）', () => {
  expect(SRC).toContain('tasksPercent.toFixed(1)');
  expect(SRC).toContain(':style="{ width: tasksPercent + \'%\' }"');
  // MCP 侧同构：connected/total + 百分比
  expect(SRC).toContain('mcpConnectedPercent.toFixed(1)');
  expect(SRC).toContain('connectedMcpServers');
});

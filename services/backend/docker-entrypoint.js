#!/usr/bin/env node
'use strict';

/**
 * services/backend/docker-entrypoint.js — 容器专用 HTTP 服务入口
 *
 * 为什么需要它（而不是直接用 `khy` 或 `node server.js`）：
 *
 *   1. Dockerfile 原本的 `CMD ["khy"]` 跑的是 **TUI 程序**，它不监听任何端口。
 *      而 fly.staging.toml 声明了 http_service.internal_port = 3000 ——
 *      于是 Fly 把流量转给一个没人监听的端口，冒烟 curl /health 必然失败。
 *      这里改为启动真正的 HTTP 服务（复用 server.js，不另起一套）。
 *
 *   2. **端口必须钉死。** server.js 的 listenWithAutoPort() 在端口被占用时会
 *      自动 +1 顺延（最多 PORT_AUTO_RETRY 次）。在容器里这是**有害**的：
 *      一旦顺延到 3001，Fly 的 internal_port = 3000 就指向空端口，
 *      表现为「容器活着但流量进不来」这类极难排查的故障。
 *      因此这里把 PORT 固定为 3000，并把 PORT_AUTO_RETRY 设为 0 ——
 *      端口被占时**立即失败**（让编排层重启），而不是悄悄漂移。
 *
 *   3. 不新写 express()+app.get()：server.js 已实现完整路由（含 /healthz、
 *      /health、/api/*）。新写一套会产生「两个 health 端点、两种判据」的
 *      语义分叉，正是要避免的。
 *
 * 端口来源：services/backend/src/constants/serviceDefaults.js:89
 *           `BACKEND_PORT = parseInt(process.env.PORT || '3000', 10)`
 *           ⇒ PORT 是唯一的杠杆，设它即可。
 */

// ── 端口钉死：必须在 require('./server.js') **之前**设置 ──────────────────
// server.js 在模块加载时就会读取 PORT（serviceDefaults 是模块级求值）。
const CONTAINER_PORT = '3000';

if (process.env.KHY_CONTAINER_ALLOW_PORT_OVERRIDE === '1' && process.env.PORT) {
  // 显式放行时才允许覆盖（本地调试用），默认一律钉死。
  console.log(`[entrypoint] PORT override allowed: ${process.env.PORT}`);
} else {
  process.env.PORT = CONTAINER_PORT;
}

// 禁止端口顺延：占用即失败，不漂移。
// 对应 server.js:288 `Number.parseInt(process.env.PORT_AUTO_RETRY || '20', 10)`
process.env.PORT_AUTO_RETRY = '0';

console.log(`[entrypoint] starting khy-os HTTP service on port ${process.env.PORT}`);
console.log('[entrypoint] liveness probe: /healthz   readiness probe: /health');

// ── 复用既有服务实现（不重写路由）────────────────────────────────────────
require('./server.js');

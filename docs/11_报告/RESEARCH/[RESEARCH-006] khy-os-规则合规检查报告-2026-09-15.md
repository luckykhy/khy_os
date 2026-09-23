# khy-os 规则合规检查报告

- **检查日期**：2026-09-15
- **检查对象**：`D:\Portable\khy-os` 全仓（1515 个一级文件 + 子模块 `services/backend/src` 2831 文件 + `tools/deepseek-eyes`）
- **检查方法**：官方守卫脚本 `scripts/ci/check-agent-rules.js` 全仓扫描 + 审计报告未处理项逐条代码复核
- **结果统计**：**71 ERROR / 215 WARN**（backend 子模块另 +3 ERROR / +3 WARN，deepseek-eyes 零违规）

---

## 一、对照基准（规则真源）

| 基准 | 位置 | 内容 |
|------|------|------|
| 工程规则 1 | `AGENTS.md` §工程规则 | 零硬编码——动态配置（禁止字面量 IP/端口/绝对路径/第一方生产域名，须走 `constants/serviceDefaults.js` 或 env） |
| 工程规则 2 | `AGENTS.md` §工程规则 | 状态透明——面向用户状态/日志必须「动作 + 目标 + 进度」 |
| 工程规则 3 | `AGENTS.md` §工程规则 | 基于活动的超时——不得固定时长无条件 kill 长任务 |
| 工程规则 4 | `AGENTS.md` §工程规则 | 终端渲染——内联 UI 不用 ANSI 滚动区 |
| 自动守卫 | `scripts/ci/check-agent-rules.js` | 上述规则的可执行检查（`--changed` / 全量目录扫描） |
| 规范合规审计 | `khy-os/_产物/规范合规审计报告-2026-09-15.md` | MCP / A2A / 工具循环 / 安全 41 项问题，11 项已修，**30 项待处理** |

---

## 二、规则 1（零硬编码）违规场景——71 处

### 2.1 第一方代码需整改（ERROR，12 类场景）

| # | 位置 | 违规内容 | 建议修法 |
|---|------|----------|----------|
| 1 | `scripts/release/build-android.ps1:105,122,137` | `D:\Portable\Tools\flutter\bin\flutter.bat` 机器路径硬编码 | 改 `$PSScriptRoot` 推算或 `FLUTTER_HOME` env 扫描 |
| 2 | `scripts/release/verify-android-signature.js:61` | `D:\Portable\Tools\android-sdk` 硬编码 | `ANDROID_SDK_ROOT` env / 动态定位 |
| 3 | `apps/khyos-desktop/.build_run.cjs:2-3`、`.launch_verify.cjs:5`、`create-shortcut.ps1:4` | `D:/Portable/khy-os/...` 绝对路径 | `$PSScriptRoot` / `__dirname` 推算 |
| 4 | `apps/khyos-desktop/docs/*.py`（18 个 search/parse 脚本）、`zcode-pages/shot.ps1`、`scripts/scan-asar*.cjs`（2 个）、`scripts/ci/brand-replace.cjs:22` | 机器本地路径 / 生产域名字面量 | 临时分析脚本应归档 `_deprecated/` 或加 gitignore |
| 5 | `apps/provider-hub/scripts/acceptance.mjs:6,39` | 绝对路径 | 相对路径推算 |
| 6 | `apps/khyos-desktop/package.json:100` | **生产域名 `update.khyquant.top` 硬编码**（更新源 URL） | 从 `constants/serviceDefaults.js` 导入或 env 可覆盖 |
| 7 | `services/ai-backend/src/routes/aiGatewayAdmin.js:1100` | `http://127.0.0.1:9100` 硬编码端点（env 回退行） | 端口纳入 `serviceDefaults` 单一真源 |
| 8 | `services/backend/src/services/a2a/agentCardSpec.js:251`、`src/routes/wellKnown.js:110` | `http://127.0.0.1:0` 硬编码 | 端口 0 占位语义改用 `process.env` 或 `serviceDefaults` 命名常量 |
| 9 | `extensions/scripts/khy-desktop-rd/openflux/tauri.conf.json:8` | `devUrl: http://localhost:1420` | env 注入 |

> 第 6 项（`package.json` 生产域）与第 7/8 项（端点回退字面量）是 `AGENTS.md` 规则 1 明确点名的两类最高频违规——**域名字面量只允许存在于 `constants/serviceDefaults.js`，端点回退行中的 `127.0.0.1:<端口>` 亦属违规**。

### 2.2 生成物未清理（ERROR，62 处，建议 gitignore 而非改码）

| 位置 | 数量 | 说明 |
|------|------|------|
| `apps/khy-os-client-app/.dart_tool/` | 22 | Flutter 构建缓存（`hook.dependencies_hash_file.json`、`input.json` 含机器路径） |
| `docs/_assets/dead-links.json:137,142` | 2 | 死链报告中残留 `/home/kodehu03/...` 机器路径 |
| `scripts/check_keys.ps1:1` | 1 | 键检查脚本绝对路径 |
| `apps/khy-mobile/android/.../public/assets/*.js` | 37 | 打包生成物（混淆 Vue 资产），守卫误扫 |

---

## 三、规则 2（状态透明）违规场景——215 处（其中第一方场景）

| 位置 | 场景 | 判定 |
|------|------|------|
| `apps/ai-frontend/src/composables/useWxBinding.js:257` | `status: 'connecting'` 裸枚举值，无动作+目标+进度 | **需修** |
| `apps/ai-frontend/src/views/KhyOsDesktop.vue:31` | `booting / capturing` 状态直接展示 | **需修** |
| `software/khyquant/frontend/src/views/admin/Dashboard.vue:398,485,1441` | `<el-option label="处理中">` 选项标签 | 数据类（AGENTS 枚举标签例外），**人工评审通过** |
| `software/khyquant/frontend/src/views/Feedback.vue:208` | 示例数据 `status: 'processing'` | 数据类，**通过** |
| `services/backend/src/routes/feedback.js:196,249`、`remoteSsh.js:367` | `processing` 枚举状态 | 数据类，**通过** |
| `apps/khyos-desktop/zcode-analysis/unpacked/**`（20+ 处） | 第三方 zcode 解包分析文件 | 范围外，建议 gitignore |

**结论**：第一方面向用户的真实违规 2 处（`useWxBinding.js`、`KhyOsDesktop.vue`）；其余为枚举数据或第三方产物。

---

## 四、规则 3（基于活动的超时）违规场景——1 处

| 位置 | 场景 | 说明 |
|------|------|------|
| `apps/khyos-desktop/.launch_verify.cjs:17` | `setTimeout(() => process.exit(0), 3000)` 硬超时结束 electron 验证进程，无活动重置 | 临时验证脚本，建议删除或归档 `_deprecated/` |

**规则 4（终端渲染）**：全仓零违规。

---

## 五、审计报告未处理项复核（30 项中关键项）

| 编号 | 严重度 | 内容 | 2026-09-15 状态 | 本次复核 |
|------|--------|------|----------------|----------|
| **M9** | P2 | `GET /`（传统 SSE）与 `POST /`（Streamable HTTP）双传输混用同一端点 | 待处理 | **仍存在**（`mcpHttpServer.js` 文件头自述现状） |
| **S4** | P1 | `execSync(\`git clone --depth 1 ${url} ${dest}\`)` 命令注入面 | 待处理 | **仍存在** `services/backend/src/services/domain/extensions/extensions/extensionManager.js:101` |
| **S5** | P1 | 两套 CORS 策略：monolith 白名单 vs gateway 默认 `*` | 待处理 | **仍存在**——`ai-backend/server.js:37` `origin: ... \|\| '*'`；`proxyServer.js:1055` `'*'` 兜底 |
| **S3** | P1 | `/api/cache`（可写文件）与 `/api/llm`（免费模型代理）无鉴权挂载 | 待处理 | **仍存在** `services/backend/server.js:588,626` 裸挂载 |
| **T1** | P1 | 工具循环无逐轮 journal；checkpoint 按 cwd 单槽覆盖 | 待处理 | 仍存在 |
| **T2/T3/T6/T7** | P2 | 结果层无 schema 校验 / 畸形调用静默丢弃 / 取消受 flag 门控 / 可观测性默认关闭 | 待处理 | 仍存在 |
| **M10/M11/M12/A2-A7/A9/A10/S6/S7/S8/S9/S10/T4/T5/T8** | P1–P3 | 见审计报告原文 | 待处理 | 未复核 |

### 已修复项确认（代码交叉验证，无回归）

| 编号 | 内容 | 验证点 |
|------|------|--------|
| M5 | MCP HTTP server Origin 校验 | `mcpHttpServer.js` 已实现白名单 + 403 拒绝 |
| M1/M2/M3/M4 | 协议版本协商 / 客户端能力 / 服务端请求响应 / 按能力调用 | `mcpServerProtocol.js` + `mcp/index.js` 已改 |
| M6/M7 | `MCP-Protocol-Version` 头 + 会话校验 | `checkProtocolVersionHeader` + `streamSessions` 已实现 |
| A8 | A2A 客户端 undefined header 必然失败 | `_cleanHeaders()` 入口级过滤已加 |
| S1 | `/api/system` 无鉴权 | `services/backend/server.js:599` 已挂 `authMiddleware` |
| S2 | 凭据明文落盘 | 默认 0600 + 严格模式开关已加 |
| daemon | 宿主控制端点 | `routes/daemon.js:38` `requireLoopback + originGuard` 已挂 |

---

## 六、整改优先级建议

1. **本周必修**：2.1 表中 9 类第一方硬编码 ERROR（重点 `package.json:100` 生产域 + `aiGatewayAdmin.js:1100` 端点回退）——这是「域迁移 / 便携移动」场景下会静默分叉的真违规。
2. **本周必修**：审计报告 P1 安全项——M9 端点拆分（需破坏性变更决策）、S4 `execSync` 拼串改 `spawn`、S3 `/api/cache` `/api/llm` 挂鉴权、S5 CORS 统一白名单。
3. **清理项**：62 处生成物（`.dart_tool/`、`zcode-analysis/`、`dead-links.json`）加入 `.gitignore`，让守卫扫描变绿、暴露真实违规。
4. **归档项**：`.launch_verify.cjs`、`.build_run.cjs` 等临时验证脚本按 `_deprecated/` 规范处理。
5. **P2 批次**：T1 journal、M11 结果保真、T6/T7 可观测性。

---

## 附录：复现方法

```powershell
# 全仓扫描（排除子模块）
cd D:\Portable\khy-os
node scripts/ci/check-agent-rules.js apps electron extensions kernel packaging patches platform scripts services software tests tools

# 子模块显式扫描
node scripts/ci/check-agent-rules.js services\backend\src tests

# 仅改动文件（PR gate）
node scripts/ci/check-agent-rules.js --changed
```

完整扫描日志：`D:\Portable\Temp\agent-rules-full.txt`（71 errors + 215 warnings 明细）。

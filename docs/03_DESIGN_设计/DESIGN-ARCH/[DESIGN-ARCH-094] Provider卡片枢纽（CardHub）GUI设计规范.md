# [DESIGN-ARCH-094] Provider 卡片枢纽（ProviderHub）GUI 设计规范

> 状态：**M0–M3 + P3 已落地（测试 36/36 + tsc 0 错 + Electron 冒烟通过 + 守卫全绿）· 待评审转定稿** · 2026-09-11（同日：宿主改独立应用 → 交付 M1–M3 → 交付 P3 托盘/failover/用量图表）
> 上位文档：`AGENTS.md`（工程红线）、`[DESIGN-ARCH-071] 通道选择决策矩阵`、`[DESIGN-ARCH-091] 密钥与端点中心管理（KeyManager）GUI设计规范`、`[DESIGN-ARCH-093] 密钥与智能体统一管理（工具矩阵与zcodeAdapter）设计规范`
> 外部调研源：`BigPizzaV3/CodexPlusPlus`（codex++，Tauri+Rust，供应商 4 模式/每供应商模型列表/Provider Doctor）、`farion1231/cc-switch`（UI 风格真源：provider 卡片布局 + 系统托盘，docs/user-manual/en/1.3-interface.md）

---

## 1. 目标

**把本机已安装的全部 provider 与 agent 工具模型统一管理**：一个 provider 一张卡片，随时拉取/管理模型；UI 风格对齐 cc-switch。宿主为**独立应用 `apps/provider-hub/`**（独立 Electron 壳，零运行时依赖 khyos-desktop、不并入其 keyManager 窗口、不共享构建链），数据/工具写入全部复用后端既有 SSoT 与服务——后端零改动。

## 2. 调研结论（参照系）

### 2.1 Codex++（数据模型）
- 供应商 4 模式：**官方登录 / 官方+API 混入 / 纯 API / 聚合供应商**（故障转移 + 按会话/按请求/权重轮转）
- 每供应商独立：协议（Responses / Chat Completions）、**模型列表 + 测试模型**、上下文窗口、自动压缩阈值、**按供应商勾选 MCP/Skill/Plugin**
- 每模型独立 context window → `model_catalog_json`；模型测试 / Provider Doctor / **cc-switch 导入**
- 外挂不改官方 app（CDP 注入），切换前自动保存当前配置

### 2.2 cc-switch（UI 风格 = 目标视觉）
- 顶栏：设置 / 代理开关 / **App 切换器下拉** / 功能区 / 添加供应商
- 卡片行（hover 出操作区）：`≡拖拽 | 图标 | 名称+端点 | 余额/用量 | 启用✓ | 编辑 | 复制 | 测速 | 用量查询 | 删除（激活时禁）`
- 卡片状态：激活蓝框 / 代理接管绿框 / failover P1·P2 徽标 / 健康绿黄红（0 / 1–2 / 3+ 连败）
- 托盘分工具子菜单快捷切换；`Ctrl+F` 搜索

## 3. 宿主与布局

**宿主：独立应用 `apps/provider-hub/`**（与 `apps/ai-frontend`、`apps/khyos-desktop` 平级的 L3 应用；**不并入、不依赖 khyos-desktop 任何代码/构建链**，自带 Electron 壳与 renderer，独立 `package.json`）。与 khy CLI / khyos-desktop keyManager 共享同一组 SSoT 数据文件（`dataHome` 下 `cc_switch.json` / `api_keys.json` / `custom_providers.json`），三方互不锁死：任意一侧改卡，其余侧重启即见。

**进程结构**（对齐 khyos-desktop 的 main/preload/renderer 分层，但不复用其 127 RPC 壳）：
```
apps/provider-hub/
├── src/main/        main 进程：数据层(读同一 dataHome 三文件) + modelCatalog + 工具写入器 + IPC
├── src/preload/     contextBridge 白名单（脱敏不变式在此设卡）
├── src/renderer/    cc-switch 风格卡片 UI（React + 轻量 CSS，无重型组件库）
└── tests/           node:test 纯逻辑测试（无需 Electron 即可跑，--experimental-strip-types）
```

**布局（cc-switch 风格，094 目标视觉）**
```
顶栏: [khy logo] [设置] [代理开关(khy 网关)] [工具切换器: claude-code|opencode|zcode|codex|…] [+ 添加供应商]
卡片列表 (1 卡 = 1 provider):
 ≡ | ⬛ 图标 | 名称 · 端点 | key: 脱敏(池#N) | N 模型
   [启用✓] [编辑] [复制] [测速] [拉取模型] [应用到工具…] [删]
卡片详情抽屉:
 ├ 模型管理: 拉取 → 表格(名称/上下文/测试/默认✓) → 存 card.models
 ├ 工具矩阵: 9 工具 × preflight / apply / 反向探测（谁正用此卡）
 └ 密钥池: keyId 关联、轮转状态、健康绿黄红
[一键导入]: 扫描本机 9 工具 live 配置（detectCardInApp）→ 逐条生成卡片
```

## 4. 数据流（写必走正门，AGENTS.md 通道五问）

| 动作 | 通道 | 落点 |
|---|---|---|
| 卡片 CRUD/排序/复制 | 渲染进程 → IPC → provider-hub main 数据层（原子写+.bak，与 khy CLI 同库） | `cc_switch.json`（SSoT） |
| 拉取模型 | main `modelCatalog.ts`：按卡片协议 `GET {endpoint}/v1/models`（anthropic 线 `/v1/models`；khy 网关卡走网关聚合端点），空闲超时 + fail-soft | 合并写 `card.models`（保留既有 modalities/limit 字段） |
| 应用到工具 | main `toolWriters.ts`：四级 backend 解析（`KHY_BACKEND_SERVICES` → 仓库 → 便携根 → 内置最小 writer + 审计降级事件），解析成功时直接 `require` 后端 `ccSwitch/appWriters`（含 zcode `zai` 登录门 preflight） | 各工具 live 配置 |
| 一键导入 | 同上通道 `appWriters.detectCardInApp`（9 工具） | 生成新卡片（不激活） |
| 健康探测 | 单次 GET /models，空闲超时，绝不硬 kill（规则 3） | 卡片健康徽标 |

**红线对照**：零硬编码（端点全来自卡片/网关运行时发现 `proxy_server_runtime.json`/env）；key 仅 main 进程内流转，IPC 回传一律脱敏（reveal 单一出口 + 冷却 + 审计）；独立应用不引入第四套存储——三文件即全部状态。

## 5. TDD 里程碑（测试先行，全部在 `apps/provider-hub/`）

| 里程碑 | 内容 | 验收 |
|---|---|---|
| **M0 先写测试（红）** | `tests/providers.test.mjs`（卡片 CRUD/排序/复制/激活保护，直写临时 dataHome 的 cc_switch.json）、`tests/modelCatalog.test.mjs`（模型拉取合并与冲突「已有条目不覆盖」、端点不可达 fail-soft、zcode 槽位约束、明文 key 不出 main）、`tests/contract.test.cjs`（IPC 通道命名 namespace:action + preload 对齐 + 零硬编码端点审计） | 测试全红，契约冻结 |
| **M1 main 层（绿）** | `src/main/modelCatalog.ts`、`src/main/providers.ts`（cc_switch.json 数据层）、`src/main/toolWriters.ts`（四级 backend 解析 + 内置降级）、`src/main/ipc.ts`、`src/main/index.ts`、`src/preload/index.ts` | M0 测试全绿 |
| **M2 渲染 UI** | `src/renderer/` ProviderCards 视图（cc-switch 布局）+ 卡片详情抽屉（模型表 + 工具矩阵）+ 一键导入按钮 + Electron 壳 `package.json`/electron-vite 接线 | 实机对 ≥3 工具各导入 1 卡并成功拉取模型 |
| **M3 验收收口** | `check:type` + 全部 node:test + `check-agent-rules` 新增文件零违规 + `check:layout` 通过；本文档状态转「已实现」 | 全绿 |

**已交付（P3）**：托盘快捷切换（`src/main/tray.ts` 每工具子菜单 + 点选即激活 + failover 轮换项）、failover 备卡队列（`providers.setFailover/rotateFailover`，P1=active 轮转语义，空队列如实拒绝）、用量图表（`usage.ts` 聚合 khy SSoT `token_usage.json` 近 7 日 + 渲染层柱状图）。

**仍裁剪（后续）**：failover 权重轮转（现为等距队列轮转）、用量趋势图（现为柱状）、zcode `model-catalog.json` 自动刷新源、按供应商勾选 MCP/Skill/Plugin、托盘轻量模式。

## 6. 改动面

- **`apps/provider-hub/`（新增独立应用，L3）**：`package.json`（自带依赖，独立 install，不入根 pnpm workspaces——对齐 khyos-desktop 现状）+ `src/{main,preload,renderer}/` ~10 文件 + `tests/` 3 文件
- `apps/khyos-desktop`：**零改动**（本规范与其 keyManager 互不耦合，仅共享数据文件）
- `services/backend`：**零改动**（工具写入经四级 backend 解析 require 既有 `ccSwitch/appWriters`）
- 文档：本文档 + 主索引挂链；`check:layout` 需确认 `apps/provider-hub` 目录名符合 L3 命名规约

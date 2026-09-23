# DSH「一切皆插件」khy-os 可行性分析

> 结论先行：**能实现，而且 khy-os 已经是主流 harness 里最接近 DSH 模型的一个——但它目前把"插件外壳"做得很好，还没把"自己的核心"吃掉。** 离真正的"一切皆插件"还差最关键的一跳：让宿主自己的核心（agent 主循环、CLI 路由器、会话/持久化、前端 UI）也成为插件，从而不再有"特权内核"。

---

## 1. DSH 的"一切皆插件"到底是什么

DSH = **DeepSeek Harness**，基于 **Cordis** 插件元框架。它的架构事实是：

- **没有特权内核**。Cordis 只负责插件的加载/卸载/依赖管理，自身不承载任何业务。
- 模型适配器、工具注册表、会话日志、Agent 主循环、UI 界面……**全部是插件**，全部可替换。
- 插件之间通过稳定的 `ctx` 键协作：`ctx.tools`、`ctx.llm`、`ctx.agentLoop`、`ctx.fs`、`ctx.shell`……
- 通过**类型化事件**通信（`emit` / `waterfall` / `parallel` / `serial`）。
- **可逆效应（revertible effects）**：插件卸载时它对环境的所有修改必须被完整、安全地撤销——不需要重启。
- **反应式余效应（reactive coeffects）**：插件能动态响应自身依赖的"新增/消失/变更"，支持运行时重组。
- **分层配置组合**：`profile → bundle → cordis.patch.yml` 叠加出一棵插件树，改模型/沙箱/循环全在配置层完成，不 fork 代码。

---

## 2. khy-os 现状逐条对照

| DSH 支柱 | khy-os 对应实现 | 成熟度 |
|---|---|---|
| 微内核 + 插件加载器 | `services/backend/src/plugin-loader/index.js`：6 个发现源（config / workspace / global npm / extension roots / plugin dir / env）、manifest 校验、惰性激活、版本门、命名空间预约、基于 `disposables` 的优雅 `shutdown()` | ✅ 已具备 |
| `ctx` 服务仓库 | `plugin-loader/contextFactory.js`：每个插件拿到隔离的 `commands / tools / ai / storage / config / events / http / spawn / database / host` | ✅ 已具备 |
| 可逆效应（卸载回滚） | 插件注册全部登记为 `disposables`，`shutdown()` / `activateNamespace` 撤销 | ✅ 已具备（时间可组合） |
| 事件总线 | `ctx.events.on/emit`（简单 EventEmitter） | 🟡 有，但非类型化、无 `waterfall/parallel/serial` 分发 |
| 能力接缝（扩展点） | `domain/catalog/capabilityMatrix/seams.js`：已命名 5 个 seam，composer 按 phase 排序；但注释承认"目前每个能力还硬编码在循环物理位置" | 🟡 命名阶段，尚未成为可替换服务 |
| 拦截钩子 | `domain/extensions/hooks/`：`hookSystem / hookRunner / hookRegistry / hookContribSeams` | ✅ 已具备 |
| 可替换实现（适配器） | AI 网关适配器、IM 适配器（飞书等）、模型适配器 | ✅ 已具备 |
| 技能 / 工具 / MCP | skills 系统、MCP 生态注册表、`tools/index.js` 工具注册表 | ✅ 已具备 |
| 权限闸门 | manifest `permissions: { network, spawn, database }`，在 `ctx` 强制 | ✅ 已具备（比 DSH 的"两旋钮"更细） |
| 多源分发 + 市场 | extension roots + `extensionMarketplace.js` + `KHY_PLUGINS` 环境变量 + npm/global | 🟡 部分（缺 bundle/profile 分层 patch） |
| 分层配置组合 | —— | ❌ 缺失（用 `flagRegistry` + `config.json`，无插件树 patch 模型） |
| 依赖声明 + 依赖序激活 | —— | ❌ 缺失（插件拿到的是现成 `ctx`，不声明 `inject:['tools']`，加载器不等待依赖） |
| UI 即插件 | —— | ❌ 缺失（`apps/ai-frontend`、`software/khyquant/frontend` 是单体 Vue 应用，非插件 bundle） |
| Agent 循环即插件 | —— | ❌ 缺失（`toolUseLoopCore.js` 是硬编码特权主循环；能力正在 seam 化，但循环本身不可替换） |
| 会话/存储即插件 | `sessionPersistence` 等是中心服务 | 🟡 可做插桩，目前仍偏中心 |

**覆盖率约 9/15 完全具备，3/15 部分，3/15 缺失。** 缺失的恰好是"一切"二字的核心。

---

## 3. 真正的缺口：khy-os 有"插件外壳"，但核心仍是特权内核

khy-os 的插件系统是**宿主内部的一个子系统**——`plugin-loader` 在 `services/backend` 里被 `require`，插件往宿主注册 commands/tools/hooks。这是"宿主包住插件"。

DSH 的"一切皆插件"是反过来：**宿主本身就是一棵插件树**——Cordis 先起来，然后 agent 循环、会话、模型、UI 作为插件挂上去。没有谁在插件"外面"。

所以 khy-os 差的那一跳，是把下面这些从"硬编码中心"变成"默认插件"：

1. **agent 主循环**（`toolUseLoopCore.js`）→ 暴露为 `ctx.agentLoop` seam + 一个默认 loop 插件。
2. **CLI 路由器**（`cli/router.js`）→ 命令发现/分派本就靠 `commandRegistry`，可进一步 plugin 化。
3. **会话 / 持久化 / 存储 provider** → 做成 `ctx.session` / `ctx.fs` / `ctx.store` 服务，带默认实现插件。
4. **前端 UI** → 把 shell 抽成 `khy-web-app` 式 bundle，业务 UI 拆成独立插件。

---

## 4. 落地路径建议（分阶段）

**阶段 A — 已完成（守成）**：loader、ctx、disposables、hooks、seams 命名、adapters、skills、MCP、权限闸门。保持并强化。

**阶段 B — 把宿主"吃"进来（关键）**：
1. 将 `plugin-loader` 从"后端子系统"提升为**启动微内核**：先 boot loader，再由它组装 backend；或干脆嵌入 Cordis 作为内核。
2. 把 `toolUseLoopCore` 移到 `ctx.agentLoop` 之后，随包发布一个 `khy-base-loop` 默认插件。
3. 把 session / fs / shell / storage 提升为 ctx 服务，提供默认 provider 插件。
4. 加 `inject` 依赖声明 + 依赖序激活（loader 等依赖存在再执行，顺序由依赖而非文件顺序决定）。
5. 引入分层组合：`profile → bundle → patch overlay`，让改模型/沙箱/循环在配置层完成（对齐 `DESIGN-TOOL-002/070`）。

**阶段 C — 缝合**：将 `capabilityMatrix/seams.js` 从"命名符号"升级为**可替换服务 seam**（Provider/Consumer），能力可整块换；事件总线上 `waterfall/parallel/serial`；前端 shell 插件化。

---

## 5. 代价提示（源自 DSH 白皮书，khy-os 需注意）

- **概念门槛上升一个量级**：无特权内核 = 调试时要理解整棵插件树。
- **同进程无隔离**：装一个插件 = 交出全部权限。khy-os 已有 `network/spawn/database` 细粒度权限闸门，**优于** DSH 的"两旋钮"，务必保留而非退化。
- **所有操作痕迹被完整记录**：khy-os 的 trajectory / audit 体系已天然满足"日志即真相"，这是优势。
- 不是所有人都该用"一切皆插件"：需求停在一/二层（换模型、加工具）用成熟产品即可；只有要自研沙箱/存储/审批流（第三层）才值得。

---

## 6. 一句话总结

khy-os 已经把 DSH 的"插件外壳四件套"（加载器、ctx 服务仓库、可逆注册、事件/hooks/权限）基本做齐了，还多了更细的权限闸门和 capability seams 的雏形。**它能不能"一切皆插件"？能。** 剩下的是哲学上最硬的一跃——让 agent 循环、CLI、会话、UI 自己也成为插件，从而消灭特权内核。这一步工程量大、风险高，但是一条清晰的、与现有架构方向一致的路，不是推倒重来。

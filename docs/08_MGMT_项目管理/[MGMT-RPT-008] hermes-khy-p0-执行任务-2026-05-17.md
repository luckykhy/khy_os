<!-- 文档分类: MGMT-RPT-008 | 阶段: 项目管理 | 原路径: docs/报告/hermes-khy-p0-执行任务-2026-05-17.md -->
# KHY P0 执行任务清单（基于 Hermes 学习项）

日期：2026-05-17  
来源文档：`docs/08_MGMT_项目管理/[MGMT-RPT-009] hermes-成长架构-学习清单-2026-05-17.md`

## 目标

把上一份学习清单里的 3 个 P0 项，拆成可以直接开工的工程任务（按文件、步骤、验收标准）。

## P0 总览

1. 命令体系单一真相源（Command SSoT）
2. 网关适配器注册中心（Adapter Registry）
3. 插件生命周期收敛（Unified Plugin Lifecycle）

---

## P0-1 命令体系单一真相源（Command SSoT）

### 目标

消除 `router` / `commandRegistry` / `aliases` 多处平行维护，改为“一个命令模型，多处派生”。

### 变更文件

- 新增：`backend/src/cli/commandSchema.js`
- 修改：`backend/src/cli/router.js`
- 修改：`backend/src/cli/commandRegistry.js`
- 修改：`backend/src/cli/aliases.js`
- 新增测试：`backend/tests/cli/commandSchema.consistency.test.js`

### 执行步骤

- [ ] 在 `commandSchema.js` 定义统一结构：`name`、`subCommands`、`slash`、`aliases`、`flags`、`category`。
- [ ] `router.js` 改为从 schema 派生 `COMMANDS`/`SUB_COMMANDS`，移除手写重复列表。
- [ ] `commandRegistry.js` 改为从 schema 派生内建 slash 命令（保留 tool/plugin 动态注册能力）。
- [ ] `aliases.js` 只保留“别名数据”，不再承载命令定义职责。
- [ ] 增加一致性测试：校验 schema、router、slash registry 的命令集合一致。

### 验收标准

- 任何新增命令只改 schema 一处，即可自动出现在路由与 slash 菜单。
- `backend/tests/cli/*.test.js` 全绿，新增一致性测试通过。
- 无行为回归：`khy help`、`/` 菜单、别名输入都保持可用。

---

## P0-2 网关适配器注册中心（Adapter Registry）

### 目标

把 `aiGateway` 里的硬编码适配器数组改为可注册模型，支持后续插件/扩展适配器接入。

### 变更文件

- 新增：`backend/src/services/gateway/adapterRegistry.js`
- 修改：`backend/src/services/gateway/aiGateway.js`
- 新增测试：`backend/tests/gateway/adapterRegistry.test.js`
- 新增测试：`backend/tests/gateway/aiGateway.adapterRegistry.integration.test.js`

### 执行步骤

- [ ] 实现 `adapterRegistry`：`register/get/list/unregister/create` 基础 API。
- [ ] 在 `aiGateway` 启动阶段注册内建适配器，不再在构造器里写死数组。
- [ ] 保持优先级和 enable 状态可配置（兼容现有环境变量逻辑）。
- [ ] 为未知 adapter、重复注册、创建失败场景补充容错日志。
- [ ] 增加集成测试：注入测试 adapter，无需编辑 `aiGateway.js` 即可被发现和调用。

### 验收标准

- 内建 adapter 全部由 registry 提供，行为与现状一致。
- 动态注册的测试 adapter 可被 `getStatus/listModels/generate` 路径识别。
- 原有 `backend/tests/gateway/*.test.js` 不出现回归失败。

---

## P0-3 插件生命周期收敛（Unified Plugin Lifecycle）

### 目标

统一当前三条插件路径：

- `backend/src/plugin-loader/index.js`
- `backend/src/cli/plugins.js`
- `backend/src/services/gateway/pluginChain.js`

形成一个主生命周期（发现、启用、禁用、加载、卸载、错误隔离）。

### 变更文件

- 新增：`backend/src/plugins/lifecycle.js`
- 修改：`backend/src/plugin-loader/index.js`
- 修改：`backend/src/cli/plugins.js`
- 修改：`backend/src/services/gateway/pluginChain.js`
- 新增测试：`backend/tests/plugins/lifecycle.integration.test.js`

### 执行步骤

- [ ] 抽象统一插件状态机：`discovered -> loaded -> active -> disabled -> failed`。
- [ ] 定义统一插件能力声明：`commands`、`tools`、`gatewayHooks`。
- [ ] `cli/plugins.js` 与 `gateway/pluginChain.js` 改为消费主生命周期，不再单独维护加载逻辑。
- [ ] 保留兼容层：旧插件格式继续可用，输出 deprecation 提示。
- [ ] 增加跨能力集成测试：单插件同时注册命令+网关 hook，验证生效与禁用流程。

### 验收标准

- 同一个插件在 CLI 和 gateway 侧由同一生命周期控制。
- `enable/disable/reload` 操作语义一致，不再出现状态漂移。
- 插件异常不会中断主流程，错误有明确来源与插件名。

---

## 推荐落地节奏（两周）

1. 第 1-3 天：完成 P0-1（命令 SSoT）+ 测试收敛  
2. 第 4-7 天：完成 P0-2（adapter registry）+ 网关回归  
3. 第 8-14 天：完成 P0-3（插件生命周期）+ 兼容迁移

## 最小回归命令建议

```bash
cd backend
npm test -- tests/cli
npm test -- tests/gateway
npm test -- tests/plugins
```

---

## 可直接提单的 Issue 模板

以下模板可直接复制到 GitHub/GitLab Issue。

### Issue 模板 A — P0-1 命令体系单一真相源（Command SSoT）

**Title**  
`[P0-1] 建立命令单一真相源，收敛 router/registry/aliases`

**Problem Statement**  
当前命令定义分散在 `router.js`、`commandRegistry.js`、`aliases.js`，存在重复维护与漂移风险。

**Scope**
- 新增 `backend/src/cli/commandSchema.js` 作为唯一命令定义源。
- `router.js` 从 schema 派生 `COMMANDS` 与 `SUB_COMMANDS`。
- `commandRegistry.js` 从 schema 派生内建 slash 命令。
- `aliases.js` 仅保留别名映射数据，不承载命令定义逻辑。
- 新增一致性测试：`backend/tests/cli/commandSchema.consistency.test.js`。

**Out of Scope**
- 不改动命令行为语义与参数格式。
- 不引入新的命令权限模型。

**Implementation Checklist**
- [ ] 定义 schema 字段（`name`/`subCommands`/`slash`/`aliases`/`flags`/`category`）。
- [ ] router 侧移除手写命令列表，改为 schema 派生。
- [ ] registry 侧移除手写内建 slash 列表，改为 schema 派生。
- [ ] 别名模块改为纯数据层。
- [ ] 新增一致性测试覆盖命令集合、子命令归属、slash 子集关系。

**Acceptance Criteria**
- 仅修改 schema 即可驱动路由与 slash 菜单更新。
- `backend/tests/cli/*.test.js` 全绿，新增一致性测试通过。
- `khy help`、`/` 菜单、别名调用无行为回归。

**Verification Commands**
```bash
cd backend
npm test -- tests/cli/router.test.js
npm test -- tests/cli/commandRegistry.test.js
npm test -- tests/cli/commandSchema.consistency.test.js
```

**Definition of Done**
- PR 合并前附测试结果与影响范围说明。

### Issue 模板 B — P0-2 网关适配器注册中心（Adapter Registry）

**Title**  
`[P0-2] 引入 adapterRegistry，移除 aiGateway 适配器硬编码`

**Problem Statement**  
`aiGateway` 构造器内硬编码适配器数组，扩展新 provider 需要改核心文件，违背可插拔目标。

**Scope**
- 新增 `backend/src/services/gateway/adapterRegistry.js`。
- `aiGateway.js` 改为消费 registry，不再内置静态适配器清单。
- 支持 `register/get/list/unregister/create`。
- 覆盖异常场景：重复注册、未知 adapter、构造失败日志。
- 新增测试：
  - `backend/tests/gateway/adapterRegistry.test.js`
  - `backend/tests/gateway/aiGateway.adapterRegistry.integration.test.js`

**Out of Scope**
- 不改动各 adapter 内部推理逻辑。
- 不重写现有 provider 配置格式。

**Implementation Checklist**
- [ ] 实现 registry API 及防重复机制。
- [ ] 将内建 adapter 改为启动阶段注册。
- [ ] 保留现有 enable/priority 行为兼容。
- [ ] 增加动态注入测试 adapter 的集成测试。
- [ ] 补充错误路径日志断言。

**Acceptance Criteria**
- 内建 adapter 全部通过 registry 暴露。
- 无需改 `aiGateway.js` 即可注入并调用测试 adapter。
- `backend/tests/gateway/*.test.js` 无回归失败。

**Verification Commands**
```bash
cd backend
npm test -- tests/gateway/adapterRegistry.test.js
npm test -- tests/gateway/aiGateway.adapterRegistry.integration.test.js
npm test -- tests/gateway
```

**Definition of Done**
- PR 提供迁移说明（旧逻辑到 registry 的映射表）。

### Issue 模板 C — P0-3 插件生命周期收敛（Unified Plugin Lifecycle）

**Title**  
`[P0-3] 统一插件生命周期，收敛 plugin-loader/cli/plugins/pluginChain`

**Problem Statement**  
当前插件链路分散在三处，状态语义不统一，容易出现 enable/disable 状态漂移与错误隔离不足。

**Scope**
- 新增 `backend/src/plugins/lifecycle.js` 统一状态机。
- 收敛三条路径：
  - `backend/src/plugin-loader/index.js`
  - `backend/src/cli/plugins.js`
  - `backend/src/services/gateway/pluginChain.js`
- 定义统一能力声明（`commands`/`tools`/`gatewayHooks`）。
- 保留旧插件兼容层并输出 deprecation 提示。
- 新增 `backend/tests/plugins/lifecycle.integration.test.js`。

**Out of Scope**
- 不更换插件包格式。
- 不删除历史插件入口（先兼容、后淘汰）。

**Implementation Checklist**
- [ ] 实现状态机：`discovered -> loaded -> active -> disabled -> failed`。
- [ ] 统一 enable/disable/reload 语义与事件流。
- [ ] CLI 与 gateway 改为消费同一生命周期实现。
- [ ] 增加异常隔离与来源标记（插件名 + hook）。
- [ ] 增加“单插件跨能力”集成测试。

**Acceptance Criteria**
- 同一插件在 CLI/Gateway 由同一状态源控制。
- `enable/disable/reload` 行为一致，无状态漂移。
- 插件失败不影响主流程，日志可定位到插件与 hook。

**Verification Commands**
```bash
cd backend
npm test -- tests/plugins/lifecycle.integration.test.js
npm test -- tests/plugins
```

**Definition of Done**
- PR 包含兼容策略说明与后续淘汰时间线建议。

> ⚠️ **已归档（孤儿设计稿）· 请勿据此实现** ⚠️
>
> 本规范描述的治理引擎 `dualTrack（官方核心轨 + user_patch 扩展轨）` 经 2026-06-14「接线或删除」证据级核实为 **ORPHAN**
> （零消费者、从 `executeTool`/`toolUseLoop`/`aiManagementServer` 三入口均不可达），
> 已按 `.ai/GOVERNANCE-LEDGER.md` §B.0 **删除其实现代码**（基线 `0437b6b`，删除提交
> `a76785e` + `99ea828`）。本文件仅作**历史可追溯**留存，**非在产、不得作为实现依据**。
> 判「在产」唯一标准见 `.ai/GUARDS-AI.md` §0。
>
> ——归档于 2026-06-14
# [DESIGN-ARCH-033] 模型自适应与双轨热插拔架构

| 项 | 值 |
| --- | --- |
| 文档类型 | 架构设计（ARCH） |
| 适用范围 | `services/backend/src/services/dualTrack/`（官方核心轨）与 `user_patch/`（用户扩展轨） |
| 强制级别 | 设计基线（实现须符合本文「红线符合性」一节） |
| 上位治理 | [MGMT-STD-003]（任务三综合系统提示词）、[MGMT-STD-001]（文档结构铁律） |
| 状态 | 定稿 |

---

## 1. 目标

让 khyos 对**未知的未来模型代际**前向兼容：模型新增字段、新增指令时系统不崩；用户（乃至
用户的 AI 模型在运行时经授权）可 DIY 注入本地适配 / Bug 修复；官方更新**绝不**覆盖或破坏
用户的私有迭代。一句话——构建「AI 能力自适应、用户可 DIY 扩展、官方更新无冲突」的永动机架构。

## 2. 双轨与物理隔离

```
官方核心轨（受保护基座，官方维护，用户/模型严禁直接改）
  services/backend/src/services/dualTrack/
    lenientResponseParser.js   宽松解析层（红线1/2/3）
    actionRegistry.js          双轨注册表 + 核心密封（红线5）
    degradeStateMachine.js     安全降级状态机（红线2/3）
    unknownActionView.js       未知指令占位符（红线2 防白屏）
    extensionLoader.js         用户轨装载 + 沙箱边界（红线5）
    extensionWriter.js         模型 DIY 授权写入（红线5）
    updateGuard.js             官方更新防破坏协议（红线4）
    core/coreActions.js        官方内置动作（受保护源，覆写不改它）
    index.js                   DualTrackRuntime 门面

用户扩展轨（DIY 试验田，用户掌控，模型经授权可运行时写）
  user_patch/                  ← 与官方核心轨物理隔离；官方更新绝不触碰（红线4）
    manifest.json              覆写 / 新增执行器清单
    overrides/*.js             覆写官方默认动作（影子覆盖）
    actions/*.js               为未来模型能力新增执行器
```

> 注：仓库根 `extensions/` 已被 VS Code 扩展 `khy-trae-bridge` 占用，语义不同；用户扩展轨
> 取红线 4 钦定的另一名字 `user_patch/`。更新守卫同时把 `user_patch` 与 `extensions` 两个名字
> 识别为受保护用户领地。

## 3. 合并策略（运行时拼装）

`DualTrackRuntime.assemble()` 三步：① 注册官方内置动作进核心轨 → ② **密封核心**（此后核心
不可改写）→ ③ 扫描用户扩展轨 `manifest.json`，把覆写 / 新增执行器注入注册表影子层。

解析优先级：**用户覆写 > 官方核心 > 默认分支兜底**。用户覆写以「影子」生效，官方核心源
条目原样保留（`coreSnapshot` 前后一致即实证未污染）。

## 4. 模型自适应与安全降级

| 层 | 行为 | 红线 |
| --- | --- | --- |
| 数据解析 | 宽松解析：未知顶层字段 / 动作内未知键全部捕获 + 记日志，绝不因多字段抛 Fatal；坏 JSON / null / 数字一律降级 salvage，永不抛错 | 1、2、3 |
| UI 渲染 | 未识别动作 → 安全「未知指令占位符」（`renderable:true` + 原始数据视图 + 「可通过扩展实现」），严禁白屏崩溃 | 2 |
| 状态机 | 未定义指令状态 → 降级「人工确认」交还控制权，绝不自主执行、绝不静默丢弃 | 2、3 |
| 模型 DIY | 可经授权把适配代码写入用户扩展轨，但越用户轨边界（指向核心 / 轨外）一律拒（沙箱） | 5 |

## 5. 官方更新防破坏协议

- **更新策略**：`planOfficialUpdate` 逐文件判定——目标必须落在核心轨内、且绝不命中用户扩展轨；
  任一越界即整包 fail-closed 不安全，`applyOfficialUpdate` 拒绝施工，**绝不**覆盖 / 删除用户轨。
- **兼容性契约**：`detectBreakingChange` 比对接入点；若新核心移除了用户轨依赖的 Hook/Slot/Override
  入口或破坏向后兼容数据结构 → 启动期检出 breaking + 产出手动迁移提示，**绝不**静默作废。
- **隔离施工**：仅安全包写入核心轨；用户扩展轨物理隔离、零触碰。

## 6. 红线符合性

| 宪法红线 | 落点 |
| --- | --- |
| 1 严禁脆弱解析 | `lenientResponseParser`：未知字段捕获不致命；任意坏输入降级 salvage，永不抛错 |
| 2 严禁静默吞没 | `unknownActionView` 占位符 + `degradeStateMachine` 人工确认；显式「可通过扩展实现」，不丢弃 |
| 3 严禁假设终态 | `actionRegistry.resolve` 默认分支兜底；状态机 default → 人工确认；执行器抛错亦降级不崩 |
| 4 严禁官方覆盖 | `updateGuard` fail-closed：命中 `user_patch/` `extensions/` 或越界即拒整包；破坏性变更必提示迁移 |
| 5 严禁核心污染 | 覆写只入影子层、核心密封 + `coreSnapshot` 实证；模型写入需授权 + `assertWithinUserTrack` 沙箱 |

## 7. 交付物

```
services/backend/src/services/dualTrack/   9 个纯 Node 零依赖模块（DI 可测）
user_patch/                                用户扩展轨样例（manifest + override + 新增执行器 + README）
services/backend/tests/services/dualTrack/dualTrack.test.js   37 用例
```

## 8. 验收

`node --test tests/services/dualTrack/dualTrack.test.js` → **37 用例绿**：宽松解析 5 + 注册表核心
不污染 3 + 安全降级占位 5 + 装载沙箱 4 + 模型 DIY 写入 3 + 官方更新防破坏 9 + 端到端真实
`user_patch` 样例 8。零网络、隔离 tmp、测后清理。邻近子系统回归 120/120 绿，零回归。

## 9. 跨分类关联指引

- 任务三综合系统提示词与宪法红线全文：`docs/08_MGMT_项目管理/[MGMT-STD-003]`。
- 文档结构与索引铁律：`docs/08_MGMT_项目管理/[MGMT-STD-001]`。
- 实现代码：`services/backend/src/services/dualTrack/`、用户轨样例 `user_patch/`。
- 同源治理脉络：元规划约束注入 `[DESIGN-ARCH-025]`、有限窗口降级兜底 `[DESIGN-ARCH-029]`。

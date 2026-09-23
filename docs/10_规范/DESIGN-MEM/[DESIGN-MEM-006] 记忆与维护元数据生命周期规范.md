# [DESIGN-MEM-006] 记忆与维护元数据生命周期规范

<!-- RULES-REGISTRY: MEMORY-001, MEMORY-002, MEMORY-003, MEMORY-004 -->


> **定位**：`[DESIGN-GOV-001]` GOV-MEM-001–004 的契约冻结真源 + UC-001 裁决。
> 管**治理情景**（记忆分类、`.ai/` 维护元数据）；khy 运行时记忆系统的功能文档是 MEM-000–005，两者互补。

## 1. session / persistent 判定（GOV-MEM-001）

| 问 | 答「是」 |
|---|---|
| 只在当前任务/会话内有意义？ | 归 **session**，禁止落盘 |
| 跨会话稳定事实（架构决定、契约形状、真源位置）？ | 归 **persistent**，必须走 §2 格式 + §3 入口 |
| 进程状态/队列/临时日志？ | 归 session，按 §4 清理 |

**禁止**：把一次性命令输出、临时 diff 写入长期记忆或 `.ai/`。

## 2. persistent 记录五字段（GOV-MEM-002）

落盘必带五字段，缺一不得写；**凭据（key/密码/token）只引用存放位置，不复制值**：

```yaml
subject:   记录主体（哪个模块/契约）
source:    来源（文档编号 / 文件路径 / 命令输出引用）
writtenAt: 写入时间（ISO 日期）
scope:     适用范围（仓库级 / 板块级 / 模块级）
cleanup:   清理条件（触发事件；无条件则写 永久）
```

## 3. 指定读写入口（GOV-MEM-003）

| 存储 | 指定入口 | 禁止 |
|---|---|---|
| `.ai/` 维护元数据 | `khy metadata gen / refresh / link` | 手写过 `.ai/MAP.md`；绕过 `projectMetadataService` 改机器文件 |
| 会话/持久上下文 | ACP `context.share`（scope，见 `[DESIGN-ACP-001]`） | 路由/服务层直写持久记忆文件 |

新增记忆持久化模块：先在本表加行登记，再动码。

## 4. 生命周期与清理（GOV-MEM-004）

- session 数据（缓存/队列/临时上下文）：会话结束、进程退出、主体删除时**清除或显式归档**（归档带 §2 五字段）；重启后残留的临时上下文**不得**自动升格为 persistent。
- persistent 记录：按 `cleanup` 字段触发；删除动作本身留一行台账，禁止静默删。
- `.ai/` 机器文件：结构变化由 `khy metadata refresh` 就地更新（非破坏；人工文件只刷派生骨架）。

## 5. UC-001 裁决（`.ai/` 三件套）

1. **生成责任**：`MAP.md`/`CONTEXT.yaml`/`GUARDS.md` 由 `khy metadata gen`（确定性生成器）生成，**不手写**；人工 `.ai/` 件（如 `GOVERNANCE-LEDGER.md`）按 skeleton 模式，机器不覆盖。
2. **提交策略**：三件套随仓库提交；git 仓库挂 `khy metadata hook install`（pre-commit 自动刷新）。
3. **缺失门禁**：`khy metadata check` 缺失/stale 时退出非零，可作 CI/提交前门禁；非 git 环境人工运行兜底。
4. **执行记录**：登记日缺失三件套，已按本裁决运行生成器补齐（批次台账见 `[IMPL-RPT-049]` 同日批次）。

## 6. 守卫计划（待工具化）

落地三条并进 `check:structure` + PR gate（GOV-TOOL-005）：
① persistent 五字段 + 无凭据校验；② 非指定入口写 `.ai/` 机器文件的检测；③ 重启后 session 残留扫描。
脚本放 `scripts/ci/`，同步 `scripts/tests/` 用例（070 §7 条款）。

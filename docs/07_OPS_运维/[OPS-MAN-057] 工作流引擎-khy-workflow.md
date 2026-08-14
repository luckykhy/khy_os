<!-- 文档分类: OPS-MAN-057 | 阶段: 运维 | 原路径: docs/07_OPS_运维/[OPS-MAN-057] 工作流引擎-khy-workflow.md -->
# 工作流引擎（`khy workflow`）

> `khy workflow`（别名 `khy wf`）把 **Coze 导出的工作流**导入 KHY，并以图执行——校验端口连通性后，跑真实的 LLM / 工具节点。本文讲清导入、查看、校验、运行、删除的全部子命令与边界。
>
> 实现：`services/backend/src/cli/handlers/workflow.js`，dispatch 在 `router.js:4664-4668`。

---

## 一、入口与全部子命令

| 命令 | 作用 |
| --- | --- |
| `khy workflow import <coze文件> [--name <名>]` | 导入 Coze 工作流（别名 `add`，导入后自动校验） |
| `khy workflow list`（或 `ls`） | 列出已导入工作流 |
| `khy workflow show <名称> [--mermaid\|--json]` | 查看工作流（`--mermaid` 出流程图、`--json` 出原始结构） |
| `khy workflow validate <名称>`（或 `check`） | 严格校验图（端口/连通性） |
| `khy workflow run <名称> [k=v…] [选项]` | 运行工作流（真实执行） |
| `khy workflow rm <名称>`（或 `delete`） | 删除 |

**`run` 选项**：位置参数 `k=v`、`--input k=v`（显式输入）、`--json`（机读输出）、`--quantum <N>`（步进/配额）、`--userId <id>`。校验不通过的图会被**拒绝运行**。

---

## 二、典型用法

```bash
# 1) 从 Coze 导出工作流文件，导入并命名
khy workflow import ./my-coze-flow.json --name my-flow

# 2) 看看长什么样
khy workflow list
khy workflow show my-flow --mermaid       # 出 Mermaid 流程图
khy workflow validate my-flow             # 严格校验

# 3) 运行（传入参数）
khy workflow run my-flow topic="发布说明" --input lang=zh --json

# 4) 删除
khy workflow rm my-flow
```

---

## 三、存储与边界

- 工作流存于 `<dataHome>/workflows/<slug>.json`（slug 由名称生成）。
- `run` 会调用**真实的 LLM / 工具**，所以确保网关已配好（见 [OPS-MAN-003]）。
- **CLI 不批量枚举 Coze**：命令行这条路只处理「单个导出文件的导入/执行」，并不去 Coze 平台批量拉取工作流列表——批量编辑请用 Coze 的 Web 编辑器，再逐个导出导入。

---

## 四、相关文档

- [OPS-MAN-003] ai-管理-访问与登录 —— `run` 依赖的网关配置。
- [DESIGN-ARCH-009] 可视化拖拽工作流编辑器 —— 工作流的设计层背景。

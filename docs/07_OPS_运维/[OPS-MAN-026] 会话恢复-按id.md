<!-- 文档分类: OPS-MAN-026 | 阶段: 运维 | 原路径: docs/指南/会话恢复-按id.md -->
# 按 ID 恢复会话

本指南介绍全新的会话恢复流程：

1. 当一个会话结束时，KHY 会打印：
   - `khy resume <session-id>`
   - `run codex resume <session-id>`
2. 你可以直接用以下命令恢复上下文：

```bash
khy resume <session-id>
```

## 支持的恢复格式

`khy resume` 现在同时支持：

- 索引：`khy resume 1`
- 会话 ID：`khy resume 019e33c8-2378-7830-aead-66bb6d72fa0d`

在不产生歧义时，也支持使用简短的唯一前缀。

## 历史记录视图

使用：

```bash
khy history list
```

现在每一行都包含会话 ID，因此你可以复制后直接运行：

```bash
khy resume <session-id>
```

## 只读或受限环境

如果 KHY 在退出时无法写入新的快照，它会回退到最近一个可恢复的会话，并仍然打印：

- `khy resume <latest-session-id>`
- `run codex resume <latest-session-id>`

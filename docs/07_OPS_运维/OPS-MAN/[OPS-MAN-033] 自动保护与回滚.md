<!-- 文档分类: OPS-MAN-033 | 阶段: 运维 | 原路径: docs/指南/自动保护与回滚.md -->
# 自动保护系统 — 防止改到一半项目损坏

AI 编辑文件时如果 token 耗尽、电脑断电或网络中断，项目可能处于半成品状态。KHY OS 内置了两层自动保护机制，确保你随时可以一键回滚。

---

## 两层防护

### 第一层：项目级自动检查点

每次 AI 开始对话前，系统自动创建一个 `git-diff` 检查点，记录当前项目所有未提交的改动。

- **触发时机**：AI 对话开始前（自动，无需手动操作）
- **冷却时间**：30 秒内不重复创建，防止频繁对话刷屏
- **存储位置**：`~/.khyquant/checkpoints/<项目哈希>/`
- **存储格式**：git diff 补丁文件（仅记录差异，通常 <10KB）
- **容量上限**：最多保留 50 个检查点，超出自动清理最旧的
- **耗时**：<50ms，不影响正常使用

### 第二层：文件级自动快照

每次 AI 编辑或覆写文件前，系统自动保存该文件的当前内容作为快照。

- **触发时机**：FileEditTool / FileWriteTool / ApplyPatchTool 写入文件前
- **存储位置**：`~/.khyquant/file_history/<会话ID>/`
- **容量上限**：每个文件最多 100 个快照
- **文件大小限制**：>1MB 的文件自动跳过（避免大文件占用磁盘）
- **新建文件**：不创建快照（因为没有原始内容需要保护）

---

## 用户命令

### `/checkpoint` — 手动保存检查点

在你认为项目处于稳定状态时，可以手动保存一个检查点。

```
> /checkpoint
✔ 检查点已保存: ckpt-20260601153022-a1b2c3 (git-diff, 5 文件)
```

### `/rollback` — 回滚到检查点

回滚项目到最近的检查点（自动或手动创建的都算）。

**TUI 模式：**

```
> /rollback
✔ 已回滚到最近检查点: ckpt-20260601153022-a1b2c3 (auto: AI 对话前)
```

也可以指定检查点 ID：

```
> /rollback ckpt-20260601150000-x9y8z7
✔ 已回滚到检查点: ckpt-20260601150000-x9y8z7
```

**经典 REPL 模式：**

输入 `/rollback` 后会弹出最近 10 个检查点的列表，用方向键选择要回滚到的版本。

### `workspace` 命令 — 高级检查点管理

```bash
workspace list                    # 列出所有检查点
workspace diff <id>               # 查看检查点包含的改动
workspace delete <id>             # 删除指定检查点
workspace cleanup --keep 10       # 只保留最近 10 个检查点
workspace stats                   # 查看检查点统计信息
```

---

## 断电恢复流程

### 场景：AI 改到一半突然断电

1. AI 正在修改多个文件（比如重构一个模块）
2. 改到第 3 个文件时突然断电/token 耗尽
3. 重启后项目处于不一致状态：有些文件改了，有些没改

### 恢复步骤

```bash
# 1. 启动 KHY OS
khy

# 2. 查看可用检查点
workspace list

# 3. 回滚到 AI 开始之前的状态
/rollback

# 4. 确认恢复成功
git status
git diff
```

### 场景：只想恢复某一个文件

如果只有某个文件被改坏了，不需要整体回滚：

```bash
# 查看哪些文件有快照
# 文件快照在 ~/.khyquant/file_history/ 下按会话组织
ls ~/.khyquant/file_history/
```

---

## 技术细节

### 检查点模式

| 模式 | 说明 | 适用场景 |
|------|------|----------|
| `git-diff` | 保存 `git diff HEAD` 输出 | Git 仓库（默认） |
| `git-stash` | 使用 `git stash push` | 需要更完整的保护 |
| `tar-full` | 完整打包项目目录 | 非 Git 项目 |
| `auto` | 自动选择（Git 用 diff，非 Git 用 tar） | 推荐 |

### 文件快照结构

```
~/.khyquant/file_history/
  s_1717234567_a1b2c3/           # 会话 ID
    <sha256_of_filepath>.json     # 每个文件一个 JSON
```

每个 JSON 文件包含该文件的历史快照数组：

```json
[
  {
    "timestamp": 1717234567890,
    "content": "文件原始内容...",
    "reason": "FileEditTool"
  }
]
```

### 检查点存储结构

```
~/.khyquant/checkpoints/
  <项目路径哈希>/
    manifest.json                 # 检查点索引
    ckpt-20260601153022-a1b2c3.patch  # git diff 补丁
```

---

## 常见问题

**Q: 自动检查点会拖慢 AI 响应吗？**

不会。`git-diff` 模式只执行 `git diff HEAD` 和 `git ls-files`，在典型项目中 <50ms。

**Q: 检查点占用多少磁盘空间？**

极小。`git-diff` 模式只保存差异，通常每个检查点 1-50KB。50 个检查点上限约 2.5MB。

**Q: 非 Git 项目有保护吗？**

有。自动检查点会使用 `tar-full` 模式打包整个项目。文件级快照不依赖 Git，始终可用。

**Q: 回滚后 AI 的对话历史会丢失吗？**

不会。回滚只影响文件系统，不影响对话历史。你可以继续和 AI 对话，让它在回滚后的干净状态上重新开始。

**Q: 可以关闭自动保护吗？**

自动检查点在非 Git 目录如果没有 tar 会自动跳过（静默失败）。文件快照在 fileHistoryService 不可用时也会静默跳过。两者都不会阻断正常流程。

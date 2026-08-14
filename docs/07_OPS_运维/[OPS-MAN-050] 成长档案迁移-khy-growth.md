<!-- 文档分类: OPS-MAN-050 | 阶段: 运维 | 原路径: docs/07_OPS_运维/[OPS-MAN-050] 成长档案迁移-khy-growth.md -->
# 成长档案迁移（`khy growth`）

> `khy growth` 管理你的「成长档案」——XP、等级、已完成主题等学习/使用进度。它最核心的价值是**可在机器之间迁移**：A 机 `export` → 拷贝文件 → B 机 `import`（合并语义），不丢进度。本文讲清子命令、合并规则与不可逆操作。
>
> 实现：`services/backend/src/services/growthService.js`，dispatch 在 `router.js:2627`。

---

## 一、它是什么

KHY 会随你的使用累积一份成长档案（XP/等级/完成的主题）。`khy growth` 让你查看、备份、迁移、重置这份档案。它与知识库（[`khy knowledge`](（见 OPS-MAN-051）)）**共享**同一份成长数据（XP/level 联动）。

> ⚠️ **存储路径硬编码**：成长数据固定存放在 `~/.khyquant/growth/`（含 `snapshots/`），**不读** `$KHY_DATA_HOME`。在多数据目录环境里迁移时要按这个真实路径找文件。

---

## 二、入口与全部子命令

| 命令 | 作用 | 危险性 |
| --- | --- | --- |
| `khy growth` | （无参）打印成长摘要 | 只读 |
| `khy growth export [--path <文件>]` | 导出档案为归档文件 | 只读 |
| `khy growth import <文件>` | 导入并**合并**到当前档案 | 合并（见下） |
| `khy growth snapshot` | 打一个本地快照 | 追加 |
| `khy growth snapshots` | 列出已有快照 | 只读 |
| `khy growth restore <快照>` | 用快照**覆盖**当前档案 | ⚠️ 覆盖 |
| `khy growth reset` | 清空档案（**不可逆**，需输入 `YES`） | ⛔ 不可逆 |

**`import` 的合并语义**（不是覆盖，是取优）：

- XP：取**较大**值；
- 等级：**高等级胜**；
- 已完成主题（completedTopics）：取**并集**。

所以从多台机器分别 import 不会互相覆盖进度，而是汇总到最优。

**导出格式**：gzip 后的 JSON，内部 tag `khy-growth-archive-v1`。文件名虽用 `.tar.gz` 后缀，但**并非真正的 tar**——直接交给 `khy growth import` 即可，别用 `tar` 解。

---

## 三、典型用法：在两台机器间迁移

```bash
# —— A 机（旧机）——
khy growth                          # 先看看当前进度
khy growth export --path ~/khy-growth.tar.gz

# 把 ~/khy-growth.tar.gz 拷到 B 机（scp / U 盘 / 网盘均可）

# —— B 机（新机）——
khy growth import ~/khy-growth.tar.gz   # 合并：XP 取大、高 level 胜、主题并集
khy growth                              # 确认进度已合并
```

本地备份 / 回滚：

```bash
khy growth snapshot                 # 改动前打快照
khy growth snapshots                # 看有哪些快照
khy growth restore <快照名>          # ⚠️ 覆盖当前档案
```

危险操作：

```bash
khy growth reset                    # ⛔ 不可逆，会要求输入 YES 二次确认
```

---

## 四、存储

| 路径 | 内容 |
| --- | --- |
| `~/.khyquant/growth/` | 成长档案根目录（硬编码，不认 `$KHY_DATA_HOME`） |
| `~/.khyquant/growth/snapshots/` | 本地快照 |
| `~/.khyquant/growth/knowledge.json` | 与 `khy knowledge` 共享的 XP/level 数据 |

---

## 五、相关文档

- [OPS-MAN-051] 知识库与教学自我认知（`khy knowledge`）—— 与成长档案共享 XP/level。

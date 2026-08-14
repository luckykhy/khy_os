<!-- 文档分类: OPS-MAN-051 | 阶段: 运维 | 原路径: docs/07_OPS_运维/[OPS-MAN-051] 知识库与教学自我认知-khy-knowledge.md -->
# 知识库与教学自我认知（`khy knowledge`）

> `khy knowledge` 是 KHY 的**个人知识库 + 教学自我认知**入口：检索你积累的知识、查看自己的成长画像（XP/等级），并把知识库与远程 Git 仓库双向同步。所有子命令都是**读取 / 查询 / 同步**，不做破坏性操作。
>
> 实现：`services/backend/src/services/knowledgeTeachingService.js`，dispatch 在 `router.js:2890`。

---

## 一、它是什么

KHY 在你使用过程中沉淀知识条目，并据此评估「自我认知」——你处在哪个学习阶段。它与成长档案（[`khy growth`](（见 OPS-MAN-050）)）**共享**同一份 `knowledge.json`，XP/等级联动：

| 等级 | XP 阈值 |
| --- | --- |
| beginner | 0 – 50 |
| intermediate | 51 – 200 |
| advanced | 201+ |

---

## 二、入口与全部子命令

| 命令 | 作用 |
| --- | --- |
| `khy knowledge search <query>` | 在知识库中检索 |
| `khy knowledge stats` | 知识库统计（条目数、分布等） |
| `khy knowledge self` | 查看自我认知画像（XP / 等级 / 阶段） |
| `khy knowledge sync config <owner/repo> [选项]` | 配置远程同步仓库 |
| `khy knowledge sync push` | 推送本地知识库到远程 |
| `khy knowledge sync pull` | 从远程拉取知识库 |
| `khy knowledge sync status` | 查看同步状态 |

**`sync config` 选项**：`--platform github|gitee|gitlab`、`--token <令牌>`、`--private`（建私有库）。

---

## 三、典型用法

```bash
# 检索 / 自查
khy knowledge search "工作流 校验"
khy knowledge stats
khy knowledge self                       # 我现在是 beginner / intermediate / advanced？

# 把知识库同步到自己的私有 GitHub 仓库
khy knowledge sync config your-name/my-kb --platform github --token <PAT> --private
khy knowledge sync push                  # 上传
khy knowledge sync status                # 看状态
# 换机后：
khy knowledge sync pull                  # 拉回
```

---

## 四、存储

| 路径 | 内容 |
| --- | --- |
| `~/.khyquant/growth/knowledge.json` | 与 `khy growth` 共享的 XP/level/知识数据 |
| `~/.khyquant/growth/user_knowledge_base.json` | 用户知识库（`USER_KB_FILE`） |
| `~/.khyquant/kb_sync.json` | 同步配置 |
| `~/.khyquant/kb-repo/` | 远程仓库的本地克隆 |

---

## 五、相关文档

- [OPS-MAN-050] 成长档案迁移（`khy growth`）—— 共享 XP/level，机器间迁移成长进度。

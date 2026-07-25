<!-- 文档分类: OPS-MAN-054 | 阶段: 运维 | 原路径: docs/07_OPS_运维/[OPS-MAN-054] 变更裁决-khy-verdict.md -->
# 变更裁决（`khy verdict`）

> `khy verdict` 读取并渲染 KHY 对**自身源码最近一次变更**的「机器裁决」——这次改动是好（✅）、坏（❌）、存疑（❓）还是无关（—）。它还能把裁决以多种格式 `emit` 给其他 AI/工具一次性消费（含 Claude hook 格式）。本文讲清全部子命令与 `watch` 的真实形态。
>
> 实现：`services/backend/src/cli/handlers/verdict.js` + `services/backend/src/services/changeWatchService`，dispatch 在 `router.js:4642`。

---

## 一、它是什么

KHY 监视自身源码变更并产出一个机器可读的裁决符号：

| 符号 | 含义 |
| --- | --- |
| ✅ | 变更通过 |
| ❌ | 变更有问题 |
| ❓ | 存疑 / 需人看 |
| — | 无相关变更 |

---

## 二、入口与全部子命令

| 命令 | 作用 |
| --- | --- |
| `khy verdict`（或 `show`） | 显示当前裁决 |
| `khy verdict check` | 立即跑一次裁决（`checkOnce()`） |
| `khy verdict --json` | 以 JSON 输出 |
| `khy verdict emit [--format …] [--consumer <名>] [--peek]` | 把裁决导出给外部消费者 |
| `khy verdict watch` | ⚠️ **仅信息提示**（见 §四） |

**`emit --format`**：`text` / `json` / `claude-hook`（生成可被 Claude Code hook 消费的格式）。`--consumer` 标注消费方，`--peek` 只看不消费。

---

## 三、典型用法

```bash
khy verdict                 # 看最近一次变更的裁决
khy verdict check           # 强制立即重新裁决
khy verdict --json          # 机读
khy verdict emit --format claude-hook --consumer my-hook --peek
```

---

## 四、诚实边界（`watch`）

- **`khy verdict watch` 不会自己常驻**：它当前是**信息提示**——真正的持续监视由常驻入口 `khy daemon start` 承担。想要后台持续裁决，请走 daemon，而不是指望 `watch` 自起一个长进程。
- `check` / `emit` 是真实动作；`watch` 这条只是引导你去用 daemon。

---

## 五、相关文档

- [OPS-MAN-055] 可变性分级与变更治理（`khy evolve`）—— 与裁决互补：评估「这个文件能不能改」。

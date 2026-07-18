<!-- 文档分类: OPS-MAN-055 | 阶段: 运维 | 原路径: docs/07_OPS_运维/[OPS-MAN-055] 可变性分级与变更治理-khy-evolve.md -->
# 可变性分级与变更治理（`khy evolve`）

> `khy evolve`（别名 `khy evolution`）把代码路径按**可变性**分级（哪些绝不能动、哪些受守护、哪些可自由演进），评估当前 git diff 是否越界，并给出联动义务。它**严格只读 / 咨询**——**不会自我修改任何代码**。本文讲清全部子命令与门控。
>
> 实现：`services/backend/src/cli/handlers/evolve.js` + `evolutionPolicy` / `evolutionSafety`，dispatch 在 `router.js:4648-4651`。

---

## 一、可变性分级

| 标记 | 级别 | 含义 |
| --- | --- | --- |
| 🔒 | immutable | 绝不可改（红线） |
| 🛡️ | guarded | 受守护，改动需满足额外义务 |
| 🌱 | evolvable | 可自由演进 |
| ❔ | unknown | 未分级 |

---

## 二、入口与全部子命令

| 命令 | 作用 |
| --- | --- |
| `khy evolve`（或 `status`） | 演进治理总览 |
| `khy evolve rules` | 查看分级规则（spec） |
| `khy evolve safety` | 安全约束说明 |
| `khy evolve classify <path…>` | 对指定路径分级 |
| `khy evolve check [--changed]` | 评估变更是否越界（`--changed` 看当前改动） |
| `khy evolve cascades` | 查看联动义务（改了 A 必须连带处理 B） |
| `khy evolve --json` | 机读输出 |

---

## 三、典型用法

```bash
khy evolve                       # 总览
khy evolve classify services/backend/src/cli/router.js   # 这个文件什么级别？
khy evolve check --changed       # 我当前的改动有没有碰红线？
khy evolve cascades              # 改这些文件还要连带做什么？
khy evolve rules                 # 分级规则是怎么定的
```

---

## 四、诚实边界（只读咨询，不自改）

- `khy evolve` **只报告与建议**：它能把一次越界变更标为 `blocked` 并说明理由，但**实际的强制拦截 / 回滚发生在别处**（自愈事务流程内），本命令**不会**替你修改或还原代码。
- 分级与评估本身是**真实确定**的逻辑，不是桩；只是「执行后果」不由它落地。
- 门控环境变量 `KHY_EVOLUTION_POLICY`；越权覆盖用 `KHY_EVOLUTION_OVERRIDE`。

---

## 五、相关文档

- [OPS-MAN-054] 变更裁决（`khy verdict`）—— 评估「这次改得好不好」。
- [OPS-MAN-056] 按需依赖自愈（`khy deps`）—— 会真实安装的另一条治理线。

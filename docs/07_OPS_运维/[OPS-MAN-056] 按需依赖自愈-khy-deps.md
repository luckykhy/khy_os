<!-- 文档分类: OPS-MAN-056 | 阶段: 运维 | 原路径: docs/07_OPS_运维/[OPS-MAN-056] 按需依赖自愈-khy-deps.md -->
# 按需依赖自愈（`khy deps`）

> `khy deps`（别名 `khy dep` / `khy dependency`）按需探测并**真实安装**外部依赖（如 JDK、各类运行时），让功能在缺依赖时能自愈。它有两条**安全红线**：安装命令**只来自策展注册表**、**绝不自动 sudo**。本文讲清全部子命令与红线。
>
> 实现：`services/backend/src/cli/handlers/deps.js` + `services/backend/src/services/dependency`，dispatch 在 `router.js:4655-4659`。

---

## 一、入口与全部子命令

| 命令 | 作用 |
| --- | --- |
| `khy deps list`（或 `ls`） | 列出策展注册表中可管理的依赖 |
| `khy deps versions <dep>` | 查看某依赖可用版本 |
| `khy deps check` | 探测本机已装 / 缺失情况 |
| `khy deps install <dep>[@ver] [--force]` | 安装（**真实**，幂等；`--force` 强装） |
| `khy deps --json` | 机读输出 |

---

## 二、典型用法

```bash
khy deps list                    # 能管哪些依赖
khy deps check                   # 现在缺什么
khy deps versions jdk            # JDK 有哪些版本可装
khy deps install jdk@17          # 装 JDK 17（已装则幂等跳过）
khy deps install jdk@17 --force  # 强制重装
```

---

## 三、两条安全红线（务必知悉）

1. **只用策展注册表的安装命令**：要装什么、用什么命令装，**只取自 KHY 内置的策展注册表**，**绝不**从模型输出或报错文本里提取命令来执行（`deps.js:143-146 / 177-179`）。这避免了「模型/日志里出现一条 `curl … | sh` 就被照跑」的风险。
2. **绝不自动 sudo**：当某次安装确实需要提权时，KHY **只会警告并请你自己处理**，**不会**替你 `sudo`。提权动作始终在你手里。

> 因此 `khy deps install` 安全可控：它不会偷偷提权，也不会执行不在白名单里的命令。

---

## 四、相关文档

- [OPS-MAN-055] 可变性分级与变更治理（`khy evolve`）—— 同属「自持基建」治理线。
- [DESIGN-ARCH-027] Agent依赖自愈机制规范 —— 设计层的依赖自愈原理。

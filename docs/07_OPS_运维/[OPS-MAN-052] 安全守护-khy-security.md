<!-- 文档分类: OPS-MAN-052 | 阶段: 运维 | 原路径: docs/07_OPS_运维/[OPS-MAN-052] 安全守护-khy-security.md -->
# 安全守护（`khy security`）

> `khy security` 做两件事：① 对本机做**真实的安全扫描**（挖矿木马、可疑进程、异常 crontab、矿池端口、`/tmp` 可执行文件、SSH `authorized_keys`）；② 管理 KHY 自身的**权限模式**（`profile`）。本文讲清全部子命令，并**如实标注** `monitor` 的真实形态。
>
> 实现：`services/backend/src/services/securityGuardService.js`，dispatch 在 `router.js:3046`。

---

## 一、入口与全部子命令

| 命令 | 作用 |
| --- | --- |
| `khy security scan` | 一次性安全扫描（见下方检测项） |
| `khy security monitor` | 周期性后台扫描（⚠️ 进程内计时器，见 §三诚实边界） |
| `khy security integrity` | 完整性检查（KHY 自身文件是否被篡改） |
| `khy security status` | 安全状态总览 |
| `khy security profile [模式]` | 查看 / 设置**权限模式**（= KHY 的操作授权级别） |
| `khy security audit [--tool <名>] [--limit <n>]` | 审计工具调用记录 |
| `khy security permissions` | 查看当前权限配置 |

**`scan` 检测项**：挖矿/木马进程、CPU 异常占用、可疑 crontab 项、已知矿池端口连接、`/tmp` 下可执行文件、SSH `authorized_keys` 异常。

---

## 二、权限模式：`profile`（重点）

`khy security profile` 设置的是 **KHY 执行工具时的授权级别**（不是「威胁画像」）：

| 模式 | 含义 |
| --- | --- |
| `strict` | 最严格，几乎所有动作都要确认 |
| `normal` | **默认**，常规确认策略 |
| `acceptEdits` | 自动接受文件编辑类动作 |
| `yolo` | 放开确认；**同时**开启 toolCalling 的危险模式 |

```bash
khy security profile              # 看当前模式
khy security profile strict       # 切到最严格
khy security profile normal       # 切回默认
```

> ⚠️ `yolo` 会让 KHY 在不二次确认的情况下执行高风险动作（含 toolCalling 危险模式），仅在你完全清楚后果且环境隔离时使用。

---

## 三、诚实边界（`monitor` 的真实形态）

- **`khy security monitor` 不是脱离式守护进程**：它在**当前进程内**用 `setInterval` 每约 **10 分钟**跑一次扫描（`securityGuardService.js:603-630`），并且调用了 `.unref()`——意味着它**不会单独保活**，当前进程退出它就停。要常驻请配合常驻入口（如 `khy daemon`）运行，不要以为关掉终端它还在跑。
- 扫描结果写入 `~/.khyquant/security.log`（`securityGuardService.js:16`）。
- `scan` / `integrity` 的检测是**真实的 OS 探测**，不是桩。

---

## 四、典型用法

```bash
khy security scan                 # 立即体检一次
khy security status               # 看总览
khy security integrity            # 查 KHY 自身完整性
khy security audit --tool bash --limit 20   # 审计最近 20 条 bash 工具调用
tail -f ~/.khyquant/security.log  # 跟踪安全日志
```

---

## 五、相关文档

- [OPS-MAN-053] 监控与自检（`khy monitor`）—— 系统健康自检与 AI 请求遥测。

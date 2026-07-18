<!-- 文档分类: OPS-MAN-053 | 阶段: 运维 | 原路径: docs/07_OPS_运维/[OPS-MAN-053] 监控与自检-khy-monitor.md -->
# 监控与自检（`khy monitor`）

> `khy monitor` 有两族能力：① **selfcheck**——周期性给系统打健康分（资源/进程完整性/威胁扫描/服务健康/plugin-doctor/网关），含自动修复；② **aiMonitor**——AI 请求遥测（dashboard / 工具用量 / 日志）。本文讲清两族的全部子命令与调参。
>
> 实现：`services/backend/src/services/baseSelfCheckService.js` + `services/backend/src/services/aiMonitor`，dispatch 在 `router.js:3230`（内联）。

---

## 一、selfcheck：系统健康自检

周期性自检循环，给出 **0–100 分**（healthy / degraded / critical），覆盖：资源压力、进程完整性、周期威胁扫描、服务健康、周期 plugin-doctor、网关健康，并尝试自动修复。

| 命令 | 作用 |
| --- | --- |
| `khy monitor selfcheck start [--interval <ms>]` | 启动自检循环（**启动时立即跑一次**） |
| `khy monitor selfcheck stop` | 停止 |
| `khy monitor selfcheck status` | 状态（含日志路径） |
| `khy monitor selfcheck run [--deep]` | 立即跑一次（`--deep` 深度检查） |
| `khy monitor selfcheck tail [--n <行数>]` | 查看自检日志尾部（默认 10 行） |

- **`--interval` 默认 300000ms（5 分钟）**，会被夹在 **15 秒 ~ 24 小时**之间。
- 日志路径：`KHY_SELF_CHECK_LOG_FILE` 或 `<dataHome>/selfcheck.log`（**10MB × 2 轮转**）。
- 诸多 `KHY_SELF_CHECK_*` 环境变量可调阈值/开关。

```bash
khy monitor selfcheck start --interval 600000   # 每 10 分钟自检一次
khy monitor selfcheck run --deep                # 立刻来一次深度体检
khy monitor selfcheck status                    # 看状态 + 日志在哪
khy monitor selfcheck tail --n 30               # 看最近 30 行
khy monitor selfcheck stop
```

---

## 二、aiMonitor：AI 请求遥测

观测 KHY 对外的 AI 请求（适配器命中、时延、工具用量等）。

| 命令 | 作用 |
| --- | --- |
| `khy monitor dashboard` | 遥测总览面板 |
| `khy monitor tools` | 工具用量统计 |
| `khy monitor status` | **默认动作**，请求状态概览 |
| `khy monitor tail` | 查看请求日志尾部 |
| `khy monitor clear` | 清空遥测数据 |

```bash
khy monitor                 # = khy monitor status
khy monitor dashboard
khy monitor tools
khy monitor tail
```

---

## 三、相关文档

- [OPS-MAN-052] 安全守护（`khy security`）—— 安全扫描与权限模式。
- [OPS-MAN-029] 磁盘守卫-防膨胀机制 —— 与自检互补的磁盘侧防护。

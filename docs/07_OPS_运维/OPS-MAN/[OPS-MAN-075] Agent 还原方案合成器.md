# [OPS-MAN-075] Agent 还原方案合成器

> 本文件由 `scripts/restore-plan.js --gen-doc` 确定性生成，请勿手改；
> 策略改在 `scripts/lib/agentRestorePlan.js` 的 `_CONCERN_POLICY`，再重新生成。

## 这份方案是干什么的

khyos 已有三面独立自检镜子，各照一角：

- `restore-check`（OPS-MAN-068）：这台机器能不能还原？
- `verify-install`（OPS-MAN-069）：已装副本完整吗？
- `hydration-doctor`（OPS-MAN-070）：首启水合成功了吗？

三面镜子症状常重叠、级别互不排序。本合成器把三者**合成为一份有序、
去重、每步带 autonomy 分类的还原方案**——一个落地在陌生机器上的 agent
读它就知道：哪些步骤它**可以自己幂等执行**，到哪一步**必须停下交给人**。

```bash
node scripts/restore-plan.js            # 人读
node scripts/restore-plan.js --json     # landing agent 直接消费
```

## autonomy 判据（agent 创新点）

- **`agent`（可无人值守）**：修法是跑 khyos 自身的幂等命令
  （`khy` / `khy doctor` / `khy update` / 重跑首启水合），只依赖「网络已就绪」，
  无需人工决策 / 提权 / 装系统软件。
- **`human`（须人工介入）**：需装或卸系统软件、改安装位置 / 权限、
  提供网络、或重装官方包——涉及人的决策或宿主权限，agent 必须止步升级。

合成器给出 `firstHumanStep`：agent 按序执行到该步前全自动，到该步停下交人。
保守合并：一个概念下只要掺入任一 `human` 项，整步判 `human`（宁可多喊人，不越界代做）。

## 还原概念 · 依赖顺序 · 自主度

| 顺序 | 概念 | 步骤标题 | 自主度 | 确认命令 | 归并的镜子规则 |
|------|------|----------|--------|----------|----------------|
| 10 | `node-runtime` | Node 运行时缺失或版本过低 | AGENT 可自动 | `node --version` | `node-missing`、`portable-node-missing` |
| 15 | `npm-tool` | npm 工具缺失 | AGENT 可自动 | `npm --version` | `npm-missing` |
| 20 | `bundle-source` | bundled 后端源码 / 源码快照不完整 | HUMAN 需人工 | `node scripts/verify-install.js` | `bundle-missing`、`bundle-file-missing`、`bundle-unresolved`、`seed-missing` |
| 30 | `network-hydrate` | 离线，无法联网水合后端依赖 | HUMAN 需人工 | `khy doctor` | `offline-no-modules` |
| 40 | `hydrate-modules` | 后端依赖 node_modules 尚未水合 | AGENT 可自动 | `node scripts/hydration-doctor.js` | `no-node-modules`、`modules-not-hydrated`、`missing-critical-package` |
| 45 | `heal-markers` | 水合残留标记 / 断链需修复 | AGENT 可自动 | `node scripts/hydration-doctor.js` | `shared-link-broken`、`splitbrain-marker` |
| 50 | `version-sync` | pip / npm / backend 版本不一致 | AGENT 可自动 | `khy --version` | `versions-drift` |
| 60 | `tar-tool` | 系统 tar 解包工具缺失 | HUMAN 需人工 | `tar --version` | `tar-missing` |
| 65 | `writable-install` | 安装目录不可写 | HUMAN 需人工 | `node scripts/restore-check.js` | `install-readonly` |
| 70 | `channel-redundancy` | 仅装了单条离机渠道 | HUMAN 需人工 | `khy --version` | `single-channel` |
| 80 | `optional` | 可选组件降级 | AGENT 可自动 | `node scripts/hydration-doctor.js` | `optional-degraded` |

## 保证（继承项目章程）

- 纯合成、零 IO、绝不抛：任何异常退化为安全空方案。
- 修法/确认命令绝不含 commit/push/rm/curl/publish 类危险动作；来源修法若不慎命中，隐去并强制该步交人。
- 真 key/token 永不进包、不落盘；pip `khy-os` 与 npm `@khy-os/khy-os` 版本必须一致。


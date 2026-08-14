# [OPS-MAN-069] 已装副本完整性自检清单

> 本文件由 `scripts/verify-install.js --gen-doc` 确定性生成，请勿手改；
> 关键路径改在 `scripts/lib/installIntegrity.js` 的 `CRITICAL_BUNDLE_PATHS`，再重新生成。

## 这份清单是干什么的

前面几件送别礼检查「周遭」（环境、版本、依赖）；这一件检查**装进来的东西本身**：
你从 pip / npm 装好之后，运行时关键文件是不是齐的？下载有没有被截断？某个文件
有没有没被打进 bundle？在**任意新机器上、离线**跑一句就知道：

```bash
node scripts/verify-install.js      # 或 npm run verify-install
```

## 为什么必须搬到你的机器上跑

发布侧本就有完整性校验（`scripts/release/pip_packaging_rules.py` 的
`REQUIRED_WHEEL_PATHS`、npm 的 `REQUIRED_PATHS`），但那是在**构建机**上、对
**刚构建的产物**跑的。构建机一旦报废，另一台机器上的「装了一半 / 下载截断 /
文件缺失」就无人可查。本自检把这份保证搬到**每一台幸存者的机器**，可离线运行。

本清单的关键路径逐条源自 `REQUIRED_WHEEL_PATHS`（发布门权威清单，来自真实生产
事故——ai-backend 鉴权中间件曾掉出打包，令每条代理/网关路由 500）。两处由测试
`scripts/tests/installIntegrity.test.js` 的反漂移断言强制一致，杜绝各说各话。

## 它检查这些运行时关键文件（缺任一 = khy 可能起不来）

| 关键路径（相对 bundle 根） | 缺失意味着 |
|------|------|
| `services/backend/bin/khy.js` | 后端 CLI 入口缺失——包不完整，khy 无法启动。 |
| `services/backend/server.js` | 后端服务入口缺失——管理后端无法拉起。 |
| `services/backend/src/models/index.js` | 数据层入口缺失——启动即崩。 |
| `services/ai-backend/src/middleware/auth.js` | AI 后端鉴权中间件缺失——每条代理/网关路由会 500（历史事故点）。 |
| `apps/ai-frontend/src/main.js` | 前端入口缺失——管理页打不开。 |
| `kernel/Makefile` | 内核构建根缺失——workshop 不完整。 |
| `scripts/lib/leafContractGuard.js` | 纯叶子契约守卫缺失——无 AI 维护时的护栏丢了。 |

## 结果怎么读

- **完整**：关键文件全在，已装副本可用——放心跑 khy。
- **不完整**：列出缺了哪些文件。统一修法是重装官方包补齐：
  ```bash
  pip install --force-reinstall khy-os
  npm install -g @khy-os/khy-os
  ```
- **无法定位 bundle**：包没装好或严重不完整，按上面重装。

## 与其它自检的分工

- `restore-check`（OPS-MAN-068）：查**环境**能否还原（Node/npm/tar/版本同步）。
- `verify-install`（本清单）：查**已装副本本身**是否完整无损。
- 两者互补：环境齐了但文件缺了，或文件全了但环境缺了，都还原不成。

## 红线（继承项目章程）

- 真 key/token 永不进包、不落盘；占位 key 一眼假。
- pip `khy-os` 与 npm `@khy-os/khy-os` 版本号必须一致。
- 本清单不教任何 commit/push/rm/curl/publish 类危险动作。


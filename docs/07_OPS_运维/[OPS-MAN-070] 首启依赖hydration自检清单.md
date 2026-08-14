# [OPS-MAN-070] 首启依赖 hydration 自检清单

> 本文件由 `scripts/hydration-doctor.js --gen-doc` 确定性生成，请勿手改；
> 规则改在 `scripts/lib/hydrationHealth.js` 的 `_RULES` / `CRITICAL_PACKAGES`，再重新生成。

## 这份清单是干什么的

khyos 两条离机渠道的包都**不打包 `node_modules`**——后端 44 个依赖在
**首次运行时联网** `npm install` 补齐（Node 运行时也是首启自动下便携版）。
这一步是新机还原**最脆弱**的一环：断网、registry 不通、半截下载、
workspace 软链断裂，都会让「装好了包却起不来」。本 doctor 专查这一步。

```bash
node scripts/hydration-doctor.js      # 或 npm run hydration-doctor
```

## 与其他自检的分工（三层各管一段）

| 自检 | 回答的问题 |
|------|-----------|
| `restore-check`（OPS-MAN-068） | 这台机**能不能开始**还原？（Node/npm/tar/版本/目录可写） |
| `verify-install`（OPS-MAN-069） | 发出来的 **bundle 源码**齐不齐？（关键源码文件完整性） |
| `hydration-doctor`（本清单） | 首启**hydrate 出来的依赖**到底成没成？（含裂脑检测） |

## 最阴险的一种：裂脑（splitbrain）

首启成功后会写 marker `.khy_quant_bootstrapped`，后续启动**见 marker 即短路**，
不再重跑 hydrate。若此后 node_modules 被误删/被清理工具清掉，marker 仍在——
系统以为「装好了」，实则依赖已空，且**不会自愈**。本 doctor 的 `splitbrain-marker`
规则专抓这种「marker 说好了但 node_modules 不在」的裂脑，修法是删 marker 让它重跑。

## 关键运行时依赖（缺任一则后端塌陷）

| 包 | 缺失后果 |
|----|---------|
| `express` | HTTP 服务骨架缺失——后端不监听任何端口，管理面/网关全部 502。 |
| `@khy/shared` | workspace 共享包软链断裂——大量内部 require 崩（file: 依赖需 lock 条目，删 lock 重装可修）。 |
| `better-sqlite3` | 本地 SQLite 绑定缺失——数据层打不开，启动即崩。 |
| `ws` | WebSocket 库缺失——管理面/网关的实时通道断。 |
| `dotenv` | .env 加载器缺失——所有环境配置读不到，行为回退到裸默认。 |
| `sequelize` | ORM 缺失——模型层入口塌陷，任何 DB 操作报错。 |

## 自检会检查这些项

| 项 | 级别 | 症状 | 修法 |
|----|------|------|------|
| `no-node-modules` | 拦路 | 后端 node_modules 完全缺失（首启 hydrate 未跑或被清空，后端无法启动） | 联网后重跑一次 khy（或 khy doctor）触发首启 hydrate；bootstrap 会在后端目录 `npm install` 补齐 44 个依赖。 |
| `splitbrain-marker` | 拦路 | 裂脑：hydration marker 声称已就绪，但 node_modules 不在（marker 会短路重装，不自愈） | 删掉过期 marker 让 bootstrap 重跑：删除后端目录下的 `.khy_quant_bootstrapped` 文件，再跑 khy 触发重新 hydrate。 |
| `missing-critical-package` | 拦路 | 关键运行时依赖缺失（node_modules 存在但半装，核心包不在） | 在后端目录重跑 `npm install` 补齐缺失包；若仍缺，删 `.khy_quant_bootstrapped` 与 `package-lock.json` 后重跑 khy 全量重装。 |
| `shared-link-broken` | 拦路 | @khy/shared workspace 链接断裂（file: 依赖软链失效，大量内部模块 require 失败） | 删后端目录的 `package-lock.json` 再重跑 khy——bootstrap 会重装并重建 `@khy/shared` 链接（这正是它对 file: 依赖的既有修复路径）。 |
| `portable-node-missing` | 提醒 | 便携 Node 未落好且未探到达标的系统 Node（后端是 Node 运行时，须有其一） | khy 首启会自动下载便携版 Node（KHY_AUTO_INSTALL_NODE 默认开）；若被禁用，装系统 Node ≥ 20 后重跑 khy。 |
| `seed-missing` | 提醒 | 依赖已就位但数据库 seed 未完成（首启 seed 步骤未跑完，部分默认数据可能缺） | 再跑一次 khy（或 khy doctor）让 bootstrap 完成 DB seed；seed 幂等，重跑安全。 |
| `optional-degraded` | 提醒 | 可选依赖降级（如 node-llama-cpp 未装成，本地推理走 fallback，不影响云端功能） | 如需本地推理：在后端目录 `npm install node-llama-cpp --no-audit --no-fund`；装不上属正常，云端通道不受影响，可忽略。 |

## 人工修复步骤（照着做）

1. 跑自检，看它报哪几条拦路项：
   ```bash
   node scripts/hydration-doctor.js
   ```
2. 最常见——依赖没装齐或裂脑，联网后重跑首启：
   ```bash
   khy doctor
   ```
3. 若报裂脑（marker 说好了但依赖不在），删后端目录的 `.khy_quant_bootstrapped` 再重跑 khy。
4. 若报 `@khy/shared` 链接断裂，删后端目录的 `package-lock.json` 再重跑 khy（bootstrap 会重建软链）。

## 红线（继承项目章程）

- 真 key/token 永不进包、不落盘；占位 key 一眼假。
- pip `khy-os` 与 npm `@khy-os/khy-os` 版本号必须一致。
- 本清单不教任何 commit/push/rm 危险文件/curl/publish 类危险动作（删 marker/lock 属安全局部操作）。


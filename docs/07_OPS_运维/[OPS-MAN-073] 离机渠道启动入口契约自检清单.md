# [OPS-MAN-073] 离机渠道启动入口契约自检清单

> 送别礼的第五个角度。前四件礼分别管「进化提示词」「反向症状分诊」「还原环境自检」
> 「已装副本完整性」。本篇补上最基础的一环：**每条离机渠道，必须亲自审查自己真正
> exec 的那个启动脚本是否被打进包**。缺了它，khy 连第一行都跑不起来——「简单还原」
> 无从谈起。

## 一句话

pip（`khy-os`）与 npm（`@khy-os/khy-os`）是唯二的离机渠道。每条渠道发布前都会在
即将报废的构建机上审自己的产物；本契约要求：**渠道 X 真正 exec 的启动脚本，必须写进
渠道 X 自己的发布完整性清单**。否则一个丢了启动脚本的包能通过发布审计、正常发出去，
却在别人机器上一装即死。

## 为什么需要它（真实缺口）

pip 的启动壳在 `platform/khy_platform/cli.py:2304` 直接 exec
`<bundle>/services/backend/bin/khy.js`；文件缺失即在 `cli.py:2307` 致命退出
（"错误：找不到 CLI 入口脚本 …"）。

历史上 npm 的发布完整性清单
（`packaging/npm/scripts/audit-purity.js` 的 `REQUIRED_PATHS`）已同时钉死
`bin/khy.js` 与 `server.js`；但 pip 的清单
（`scripts/release/pip_packaging_rules.py` 的 `REQUIRED_WHEEL_PATHS` /
`REQUIRED_SDIST_PATHS`）只钉死了 `models/index.js`、`auth.js`、`main.js` 等，
**唯独漏了它自己 exec 的启动脚本**。后果：一个丢了 `bin/khy.js` 的 wheel 能通过
`scripts/release/audit_pip_artifacts.py`、正常发布，然后 `pip install khy-os` 在
别人机器上直接死在启动第一行。

`installIntegrity`（OPS-MAN-069）是**装完之后**在幸存者机器上离线自检，其反漂移断言
刻意用 `inPip || inNpm`（渠道无关，任一背书即可），因此**容忍** `bin/khy.js` 仅由
npm 背书。本契约是**发布之前**、**逐渠道**的更强不变量，专堵这种渠道非对称。

## 单一真源与分层

- 纯叶子 `scripts/lib/bundleLaunchContract.js`：零 IO、绝不抛。
  `LAUNCH_CRITICAL_BUNDLE_PATHS` 列出每条渠道启动早期真正 exec 的「地板」文件；
  `assessChannelParity({pipWheelText, pipSdistText, npmText})` 给定三份权威清单的
  **原文文本**，算出各渠道各缺哪些。
- 数据真源 `scripts/release/pip_packaging_rules.py`：`REQUIRED_WHEEL_PATHS`
  （前缀 `khy_os/bundled/`）与 `REQUIRED_SDIST_PATHS`（无前缀）——已补上
  `services/backend/bin/khy.js` 与 `services/backend/server.js`。
- 数据真源 `packaging/npm/scripts/audit-purity.js`：`REQUIRED_PATHS`
  （前缀 `package/bundled/`）——早已含两者。
- 真正读盘的 IO 在配套测试里（解析磁盘上三份清单再喂进纯叶子）。

## 启动地板清单（`LAUNCH_CRITICAL_BUNDLE_PATHS`）

| bundle 相对路径 | 来源 |
| `services/backend/bin/khy.js` | pip 壳 `cli.py:2304` 直接 exec；缺失即 `cli.py:2307` 致命退出 |
| `services/backend/server.js` | 管理后端服务入口 |
| `services/backend/src/models/index.js` | 后端启动早期即 require 的数据模型入口 |
| `services/ai-backend/src/middleware/auth.js` | 缺它曾让 bundled 安装的每条 proxy/user-gateway 路由 500 |
| `apps/ai-frontend/src/main.js` | 前端 SPA 入口，缺则管理页白屏 |
| `software/khyquant/frontend/src/main.js` | khyquant 前端入口 |

> ⚠️ **深挖修正（渠道非对称）**：本清单初版只列前 2 条。深挖发现 pip 的
> `REQUIRED_WHEEL_PATHS` / `REQUIRED_SDIST_PATHS` 早已三处钉死全部 6 条运行时关键
> 文件，而 npm 的 `packaging/npm/scripts/audit-purity.js` 的 `REQUIRED_PATHS` **只钉了
> 前 2 条**——一个丢了 `ai-backend/src/middleware/auth.js` 的 npm tarball 能通过 npm
> 自己的 purity 审计并发布，却在别人机器上让每条 proxy/user-gateway 路由 500（该文件
> 曾真实掉出打包一次）。已把全部 6 条补进 `LAUNCH_CRITICAL_BUNDLE_PATHS`（本契约的
> SSOT）与 npm `REQUIRED_PATHS`，三份清单现逐条一致。

## 两道防线

> ⚠️ **深挖修正（substring false-GREEN 边界锚定）**：一致性断言的匹配逻辑起初是裸
> 子串 `text.includes(prefix+path)`。在 sdist 的**空前缀**下这能被 FALSE-GREEN 欺骗——
> 一个启动地板路径哪怕只作为**更长路径的子串**（`.../server.js.template`）或**注释
> 文本**出现，也会被误判「已钉死」，守卫于是对一个真没钉死该文件的清单**放行**（最危险
> 的失败：说安全其实不安全）。已改为锚定收尾引号：`<prefix><path>` 紧后必须是 `"` 或 `'`，
> 只有作为**完整带引号条目**出现才算数（`_pinnedAsQuotedEntry`）。三份清单的 required-path
> 都是带引号字面量，故真实清单不受影响；伪命中（子串/注释）不再放行。

1. **构建自由的一致性断言**（`must` + pre-commit）：
   `scripts/tests/bundleLaunchContract.test.js` 解析磁盘上三份权威清单，断言三渠道都
   钉死了启动地板。无需构建、不联网、纯读盘。任一渠道漏钉即变红并点名。已并入
   `npm run test:maintainer:safety`（发布门 `maintainer-safety` 为 `must` 阶段，
   pre-commit 亦跑）。
2. **真实产物审计**：`scripts/release/audit_pip_artifacts.py` 现在会对真实
   wheel/sdist 强制这两条路径（数据已补进 `REQUIRED_*_PATHS`）。

## 怎么验证

```
npm run test:bundle-launch-contract     # 纯叶子 + 三份真实清单一致性
npm run test:maintainer:safety          # 契约已并入的 must 守卫集
```

## HOW-TO-EXTEND（给下一个维护者 / 小模型）

又出现某条渠道在启动早期就会 exec/require 的新「地板」文件（缺它即整体起不来）：

1. 先把它加进 `scripts/release/pip_packaging_rules.py` 的 `REQUIRED_WHEEL_PATHS`
   与 `REQUIRED_SDIST_PATHS`，以及 `packaging/npm/scripts/audit-purity.js` 的
   `REQUIRED_PATHS`。
2. 再把 bundle 相对路径加进 `scripts/lib/bundleLaunchContract.js` 的
   `LAUNCH_CRITICAL_BUNDLE_PATHS`。
3. 配套测试会解析三份真实清单、强制三渠道一致；只加一处会红，这是刻意的护栏。
4. 改完跑：`npm run test:bundle-launch-contract`（必须绿）。

## 红线

- 不自动 commit/push；真 key/token 不进包、不落盘。
- 数据补丁只**增加**断言，从不删既有清单项；对既有 wheel/sdist 的行为逐字节保持
  （文件本就随 `BASE_COPY_PAYLOADS` 打进包，本契约只是让审计终于会核对它们）。

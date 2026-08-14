# [OPS-MAN-078] `khy doctor` 离机还原自检（真实原因 + 解决方法）

> 送别礼「capstone」角度。pip 与 npm 是唯二离机渠道。一个落到**新机器**的开发者 /
> 使用者 / 维护者，需要**一条命令**告诉他：装完之后到底哪里不对、怎么一步修好——
> 用大白话给出「真实原因 + 解决方法」。本子系统把这份自检接进已有的 `khy doctor`。

## 定位：三个还原视角的第三块拼图

khy 有三块「还原」能力，消费者不同：

| 视角 | 消费者 | 形态 | 位置 |
|---|---|---|---|
| 构建期三镜子（restoreReadiness / installIntegrity / hydrationHealth） | 发包守卫 | 发布前门禁 | `scripts/lib/`（**不随 bundle 发布**） |
| agentRestorePlan | landing agent | JSON + autonomy 标注 | 发布 |
| **本子系统 freshInstallDoctor** | **人（开发者/用户/维护者）** | **`khy doctor` 里的一段中文报告** | **发布** |

构建期镜子不进 bundle，agent 方案给机器读 JSON。装到用户机器上、给**人**看的「原因+方法」此前是缺的——本子系统补上。

## 自检项（均为运行期可观测子集）

`khy doctor` 新增分类 **「离机还原自检」**，每个失败项自带原因与修复命令：

1. **启动入口 `bin/khy.js`** — pip/npm 壳每次 `khy` 都 exec 它；缺失即首启崩。
   失败 → 原因：包的启动脚本缺失（半装中断/安全软件误删）；解决方法：`pip install --force-reinstall khy-os`（npm 重装 `@khy-os/khy-os`）。
2. **服务入口 `server.js`** — 后端服务入口；同上不完整。
3. **依赖水合 `node_modules`** — 存在 **且非空**。判定与 pip 启动器自身的水合 SSOT
   完全一致（`platform/khy_platform/cli.py:1820`：`node_modules.is_dir() and
   any(node_modules.iterdir())`——**内容无关**，只看目录非空）。
   失败 → 原因：首启依赖水合未完成（缺失或空壳）；解决方法：项目根跑 `khy`（触发水合）或 `npm install`。

   > ⚠️ **深挖修正（SSOT 对齐）**：早期实现用名单探针（`express` / `.package-lock.json` /
   > `.bin`）判定「已水合」。但 khy 用**提升式（hoisted / workspace）** node_modules——
   > 真实依赖装在**仓库根** `node_modules`，`services/backend/node_modules` 只留少量
   > 提升残留（如 `ansi-regex` / `@khy`），既无 `express` 也无 `.package-lock.json`。
   > 启动器认它已水合（非空即可），名单探针却会误报「空壳」→ 把健康机器的用户支去白跑
   > `npm install`。现改为注入 `readdir` 做「非空目录」判定，与启动器逐字一致；名单探针
   > 仅作无法注入 `readdir` 时的降级兜底。
4. **khy 命令可达** — `khy` 是否在 PATH。**与托盘左右键无反应同一根因**（开机自启/detached 启动继承的 PATH 常不含 pip Scripts 目录）。
   不在 PATH → **warn（非 error）**，因为 `python -m khy_platform <命令>` 是保底可用入口；解决方法即用它，或把 Scripts/bin 加进 PATH。

## 分层与 SSOT

- **纯断言器** `assessFreshInstall(facts)`：零 IO、绝不抛（异常→`[]`，doctor 不因附加项崩溃），把已采集事实翻译成 doctor 形状的检查项（`{category,label,ok,detail,level}`），失败项 detail 内嵌「原因：… 解决方法：…」。
- **IO 采集器** `gatherFreshInstallFacts(deps)`：探 bundle 目录 + PATH，全部依赖注入（`existsSync`/`env`/`platform`/`which`），fail-soft（异常→保守 false 事实）。
- **门** `KHY_DOCTOR_FRESH_INSTALL` default-on；关（0/false/off/no）→ `freshInstallChecks` 返 `[]`，`khy doctor` 逐字节回退（不显示新分类）。
- 接线单点：`init.js` `runDoctorChecks()` 尾部 `try{ …push(freshInstallChecks({bundleRoot:ROOT,…})) }catch{}`。

## HOW-TO-EXTEND

1. 在 `gatherFreshInstallFacts` 采一个新事实（布尔/字符串）。
2. 在 `assessFreshInstall` 用 `_check(label, ok, detail, level)` + `_causeFix(cause, fix)` 推一条检查项。
3. 加 node:test：断言 ok 形态 **与** 失败形态（detail 含原因+解决方法）。保持断言器纯净。

## 验证

```bash
npm run test:fresh-install-doctor
# 或
node --test services/backend/tests/services/freshInstallDoctor.test.js
# 实机观察
khy doctor            # 应出现「离机还原自检」分类
```

## 相关

- `services/backend/src/services/freshInstallDoctor.js`（纯断言器 + IO 采集器）
- `services/backend/src/cli/handlers/init.js`（`runDoctorChecks` 接线点）
- [OPS-MAN-074] 首启崩溃真实原因加方法归因（运行期崩溃归因，互补）
- agentRestorePlan（agent 面 JSON 还原方案）

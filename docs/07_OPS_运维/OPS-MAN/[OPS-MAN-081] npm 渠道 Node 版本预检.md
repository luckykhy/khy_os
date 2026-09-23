# [OPS-MAN-081] npm 渠道 Node 版本预检：消除与 pip 渠道的离机还原矛盾

> 送别礼「离机还原 + 矛盾冲突」交叉角度。pip 与 npm 是 khy 唯二的离机渠道，本应给出
> **一致**的还原体验，实测却矛盾：同一台 node 18 的机器上，pip 用户看到清晰的「需要
> Node ≥ 20 + 怎么装」，npm 用户看到后端深处的天书崩溃。本子系统补上 npm 侧的 Node
> 版本预检，把两个渠道的失败体验对齐。

## 真实原因（数据级证实的跨渠道矛盾）

pip 渠道 `platform/khy_platform/cli.py:check_node()`（启动关键路径）强制 **Node.js ≥ 20**
（Ink@6 TUI 要求），不满足时：

```
Error: Node.js v18.19.0 found but >= 20 required.
  Install from: https://nodejs.org/ (中文环境 → npmmirror 镜像)
  Or: brew install node / winget install ... / nodesource ...
  → sys.exit(1)
```

但 npm 渠道启动器 `packaging/npm/bin/khy.js` **没有任何 node 版本预检**，直接：

```js
const res = spawnSync(process.execPath, [BACKEND_CLI, ...argv], { stdio: 'inherit', ... });
```

把后端交给**当前 node**。于是 **同一产品**在 node < 20 的机器上给出**两个矛盾**的离机
还原体验：

| 渠道 | node 18 机器上的体验 |
|---|---|
| pip  | 「Node.js v18 found but >= 20 required」+ 平台化安装提示 + 干净 exit(1) |
| npm  | 后端深处的现代语法 / 依赖天书崩溃，用户无从判断根因 |

npm 的 `package.json engines.node=">=20"` 只是**建议性**的——npm 默认只 warn 不拦，
`--ignore-scripts` / `engine-strict=false` 下形同虚设。故这是启动器层的真实缺口。

## 解决方法（本子系统所做）

**全 additive · 门 `KHY_NPM_NODE_PREFLIGHT`（default-on）· 关字节回退。**

### 1. 纯叶子 `packaging/npm/scripts/nodeVersionPreflight.js`

把 pip `check_node()` 的**语义镜像**到 npm 侧：纯函数、零 IO、绝不抛。

- `parseMajor(raw)` —— 解析 `v18.19.0` / `20` / 坏输入(→null)。
- `evaluate({version,env,platform})` —— 判定当前 `process.versions.node` 主版本是否
  ≥ `MIN_MAJOR`(=20)。返回 `{ok, gated, major, minMajor, hint[]}`。
- `buildHint()` —— 生成与 pip 对齐的多行报错：最低版本说明 + 中文环境镜像分支
  (`npmmirror` vs `nodejs.org`) + 平台安装建议(brew/nodesource/winget)。
- `MIN_MAJOR = 20` —— 与 pip `check_node`(major>=20)、backend `package.json`
  engines(">=20")、`devenv.js` TOOLCHAINS('Node.js (>=20)') 三处同步的 SSOT 语义。

**保守原则**：预检绝不该比它保护的启动更容易失败——版本无法解析 / 任何异常一律
**放行**(ok:true)，只在能明确判定 major < 20 时才拦截。

### 2. 启动器接线（`bin/khy.js`，handoff 前单点）

`spawnSync` handoff **之前**防御式 `require` + `evaluate()`；`ok===false` 才逐行打印
hint 并 `exit(1)`。门关 / 叶缺 / 异常 → 跳过预检 → **逐字节回退**到原「无预检直接
handoff」行为。

### 3. 随包发布

`packaging/npm/package.json` 的 `files[]` 补 `scripts/nodeVersionPreflight.js`——否则
启动器 require 到一个未发布的文件，`bin/khy.js` 的 try/catch 会吞成「preflight skipped」
（安全，但预检失效）。

## 诚实边界

- 本预检**只判当前进程的 node 版本**（`bin/khy.js` 与后端同 node）——它不做 pip 侧的
  「自动下载便携 Node」自愈（那是跨语言 Python 驱动的 bootstrap，npm 侧超出启动器职责，
  故 hint 里明确指向 pip 渠道可自动下载）。这是刻意的外科手术边界。
- 门 `KHY_NPM_NODE_PREFLIGHT` 为 sibling 离机还原类门，不进 flagRegistry（同家族先例）。

## 验证

```
node --check packaging/npm/scripts/nodeVersionPreflight.js packaging/npm/bin/khy.js
npm run test:node-preflight     # 叶子契约 19/19
node --test "packaging/npm/test/*.test.js"   # 全 npm 包 28/28(含既有 devenv 9)
```

LIVE 端到端：node 18 → `ok:false` + 中文镜像 + linux 安装建议；node 22 → 放行；
门关 → 字节回退；版本无法解析 → 保守放行。

## 相关

- 对照实现（pip 侧真源）：`platform/khy_platform/cli.py:check_node()`
- 启动器：`packaging/npm/bin/khy.js`
- 同族离机还原子系统：`freshInstallDoctor`（OPS-MAN-078）、`bundle-launch-contract`
  （渠道入口清单 parity）、三面镜子还原家族

# OPS-MAN-139 · `khy doctor` 离机自检补「代理内核 mihomo 去哪下载」CLI 侧接线

## 诉求 / 断桥

送别礼诉求之一：「网页中代理的二进制要去哪里下载」。OPS-137 已把
`describeCoreDownload` SSOT（纯零 IO 叶，给出 version/releasesPage/binDir/dest/
url）接到 **Web 面**（ProxyManagement.vue 横幅：可点 `<a>` + 一键复制）+ **后端
core-missing 指引**。但**无头 / 离机用户没有 Web UI**——他们唯一的「代理二进制去
哪下载」人面界面是 `khy doctor`，而 `freshInstallDoctor`（shipped 的
「离机还原自检」自检族）此前只探四条**安装完整性**关切（启动入口 / 服务入口 /
依赖水合 / khy 可达），**从不提代理内核**。同一「能力存在但没接线」缺口的 CLI 侧。

## 判据（真缺口 vs 造作）

- `freshInstallDoctor.js` 头部自列关切为 "runtime-observable subset" 且带
  HOW-TO-EXTEND 抄写式路径（gather fact → assess `_check`+`_causeFix` → node:test）
  ——明邀扩展。
- 代理内核是**可选**运行时能力（仅 vmess/vless/trojan/ss/ssr 原始协议节点需要；
  http/https 直连型无需内核即可代理）→ 缺席**绝非故障**。故本 check **ok:true 恒真、
  level='info'**，只披露不阻拦（承 OPS-137 哲学），绝不计入 doctor 失败数。
- 复用既有 SSOT，不硬编码 URL；不新建子系统（同叶加第 5 条 check）=B3 外科。

## 修（全 additive · 子门 KHY_DOCTOR_PROXY_CORE_HINT default-on · byte-revert）

- `freshInstallDoctor.js`：
  - `_proxyCoreHintEnabled(env)`：独立子门（0/false/off/no 关），与
    `KHY_DOCTOR_FRESH_INSTALL` 正交——可单独静默 hint，关闭时前四条 check 逐字节不变。
    与 `_gateEnabled` 同「直读 env，不进 flagRegistry」理由。
  - `gatherFreshInstallFacts`：新增 `arch` + 可注入 `describeCoreDownload`（缺省惰性
    require `proxyCoreInstaller` 的纯 SSOT）；子门开→取 descriptor + `corePresent =
    existsSync(dest)`；全 fail-soft（子系统缺 / describe 抛 / 无 dest → coreDescriptor:
    null，assessor 不产出=byte-revert）。惰性 require 避免叶在 module-load 硬耦合代理子系统。
  - `assessFreshInstall`：仅当 `coreDescriptor` 存在时 push 第 5 条 info check。
    present→「已就绪：<dest>」；absent→「未安装（…原始协议需要；http/https 直连无需）。
    下载 <url>（版本 <v>），放到 <binDir>」；冷门平台（supported:false 无 url）→
    指向 releasesPage 自选资产。
- `cli/handlers/init.js`：消费缝加 `arch: process.arch`（其余四参不动）+ 注释登记第 5 条。

## 正交层

安装完整性四条（bundle+PATH，缺=error/warn）↔ 本层第五条代理内核（可选能力，
缺=info 只披露）。字段不重叠，语义不混淆。

## 验收（全绿）

- `node --check` × 3 文件 OK。
- `test:fresh-install-doctor` **27/27 pass fail0**（含 real-SSOT 端到端：不注入
  describeCoreDownload→叶惰性 require 真 proxyCoreInstaller→断言 info check 现身且
  detail 含 mihomo/MetaCubeX，坐实 OPS-137 SSOT→CLI doctor 接线为活线）。
- LIVE 真机渲染：第 5 行含本机精确 URL
  `…/download/v1.18.10/mihomo-linux-amd64-compatible-v1.18.10.gz` + binDir
  `/home/kodehu03/.khyquant/bin`；子门 off→4 条 check、无代理内核行（byte-revert）。
- 三守卫（leaf-contract / agent-rules / flag-registry）passed；
  change-safety 显式 positional 3 文件 exit0，自动 surface `test:fresh-install-doctor`
  =map 桥闭合。
- `check:node-syntax` 4336 文件 passed；`maintainer:check` OK。
- safety 聚合 **893/885 pass fail0 8skip** 首跑即净。
- god-file：`wc -l` 叶 295 / init.js 1567，均 < 2500，无新增超限（本仓无 arch:god
  脚本，靠 wc -l 直验）。
- secret：变更文件无 key 字面量。

## 教训

1. 送别礼断桥补全靠**同一诉求找下一条正交表面**：OPS-137 覆盖 Web+后端，本轮补
   无头/离机用户唯一的 CLI 面（`khy doctor`）。
2. 可选能力的 doctor check 必须 **ok:true 恒真 + info**——缺席非故障，只披露不阻拦。
3. 纯零-IO SSOT 可惰性 require 进 IO 叶的 gather 边界，保 assessor 纯；注入口留给测试。
4. 子门与父门正交（可单独静默）+ 缺 descriptor 即不产出=双保 byte-revert。

不 commit（feat/0.1.104 / 1.0.0 里程碑同批）。

---

## 补记 — check #6：双渠道版本一致性（孤儿门 `KHY_DUAL_INSTALL_CHECK` 接线）

同一叶 `freshInstallDoctor.js` 内追加**正交第 6 条** doctor check，动机是「能力存在但没接线」：
`flagRegistry.js` 早已登记 `KHY_DUAL_INSTALL_CHECK`（`default-on` / off:CANON），却**零消费者**
=孤儿门。本轮把它接成 doctor 的一条 **info 级** check，直接服务送别礼首诉求（离机简单还原）
与红线「pip `khy-os` 与 npm `@khy-os/khy-os` 版本号必须一致」。

**判据来源**：运行版本 SSOT = `services/backend/package.json`（`khy --version` 同源，现 1.0.0）。

**接线（全 additive，与 OPS-139 主体同构）**：
- 子门 `_dualInstallCheckEnabled(env)`：`default-on` + `_FALSY` off-words 回退；与父门 `KHY_DOCTOR_FRESH_INSTALL` 正交，可单独静默。
- 纯路径渠道探测 `_detectChannel(root)`：路径含 `/site-packages/` 或 `khy_platform` → `pip`；含 `/node_modules/` → `npm`；否则 `source`（零 IO，反斜杠先归一）。
- `gatherFreshInstallFacts`：可注入 `readVersion`（缺省惰性读 `path.join(root,'package.json')`），fail-soft；产出 `dualInstall={version, channel}`；子门关或读版本抛/空 → `dualInstall=null`（不产出）。
- ассessor check #6：`ok:true` 恒真 + `level:'info'`（缺席非故障——渠道不一致是**离机部署风险**而非本机安装缺陷，只披露不阻拦），detail 明列 `pip 装 khy-os==<v>，npm 装 @khy-os/khy-os@<v>`。

**验证**：`test:fresh-install-doctor` 27→35（+8：子门开关/off-words、`_detectChannel` pip/npm/source 含 Windows 反斜杠、注入 readVersion→`{1.0.0,pip}`、子门关→null、readVersion 抛/空→null、assessor→info check 含 `khy-os==1.0.0`+`@khy-os/khy-os@1.0.0`、无 fact→缺席、真 SSOT 端到端断言 `本次运行版本 \d+\.\d+\.\d+`）；LIVE 门开产出第 6 行，`KHY_DUAL_INSTALL_CHECK=off` → 缺席（byte-revert）；`node --check` src ok；`wc -l` 366 < 2500；我切片 change-safety exit0；flag-registry / leaf-contract / agent-rules（0 error）/ maintainer:check 全 PASS。

**教训**：孤儿门（flagRegistry 登记但零消费者）是「能力存在没接线」最直接的一类；接成 **info 级只披露不阻拦**的 check，是把「离机部署风险」呈现给维护者而不误伤本机自检的正确张力。

# khy-os 项目长期记忆

## 本机环境硬约束（每次开工都适用）
- Git Bash 被 shim 破坏（mkdir/ls/echo/head/tail/grep/cat/dirname 全 not found，**cd 也坏**）；PowerShell stdout 恒空。
  → 取值唯一路线：临时 node 脚本（spawnSync 用 cwd 选项，不靠 cd）+ fs.writeFileSync 落盘 + Read 读。**禁 heredoc**。
- 受管 Node：`D:/WorkBuddyData/.workbuddy/binaries/node/versions/22.22.2-3/node.exe`
- git 绝对路径：`D:\WorkBuddyData\.workbuddy\binaries\PortableGit\versions\1.2.0\cmd\git.exe`（node 子进程 PATH 无 git）
- 本仓 git 对象库物理损坏：`log --since`/`rev-list`/`merge-base`/`git archive` 失败；**单文件 `git show HEAD:<path>` 与 `git diff` 可用**。
- 探针放 `<repo>/.khy/tmp/`（已 gitignore），用完 Remove-Item 清；输出文件名不含 `:`（NTFS ADS）。Write 报 "has not been read yet" 直接换新名。
- Grep 必须带 path 限定否则 timeout；含中文路径 Glob 不可靠 → node 枚举。cache：`D:/WorkBuddyData/.khyos/cache/`。
- 文档编号：枚举目录文件名取 max+1，**绝不读 00_INDEX**（滞后撞号）；方括号路径 Move-Item 用 -LiteralPath。
- 新增 `*.test.js` 一律 `require('node:test')`（jest 风格在 CI node --test 下落地即红；别往 jest 文件追加 node:test 用例，另建文件）。CI 全量扫 `services/backend/tests/**`。
- 基线数字必须实测（`# tests/# pass/# fail`），不许估。守卫报红先归因再认账（counts 对比 → ERROR 指向 → porcelain 归属；token 集合差+算术闭合）。

## AI 网关与后端 AI 两层入口（[DESIGN-ARCH-136]）
- 内层 LLM：`cli/ai.js` `chat()`（aiChatCore.js:317）只返回 toolUseBlocks 不执行工具；外层循环 `runToolUseLoop`（toolUseLoopCore.js）派发工具。**cwd 必须放 chatOpts.cwd**；`gateway.generate()` 纯文本入口（挂工具=静默丢弃）；`onControlRequest` 传 undefined 桩 = fail-closed deny 写。
- `cliFailureEnvelope.js` 三处判据同源（`a.success===false`）：attempts 无 success:false ⇒ 三处同失效 → NONE 兜底（编造因果）。`aiChatCore.js:3120` 重试结果无条件覆盖首次 ⇒ 好诊断被覆盖；修法「披露必留、诊断择优」。
- `services/backend/.env` 不受 git 跟踪；`GATEWAY_PREFERRED_*` 钉选残留致同一 bug **复发 6 次**（第 6 次 claude）。改值不改机制 = 必复发。
- 复现：services/backend 下 `node --test tests/gateway/<file>.test.js`。
- 2026-09-23 **[DESIGN-ARCH-139] 已落地**（提案→实施同日）：① .env 解钉 auto/false；② strict/disabled 跳过补留痕（`strict_pinned_skip`/`adapter_disabled`，virtualSkip 同型+去重）；③ NO_ATTEMPT hint 实数化（generate 末端附 `registryFacts`，信封有则用实数、无则回退）；④ 钉选租约（`_maybeRelaxEnvPinnedUnavailable` 内：连续 2 次/10 分钟窗口 → gatewayEnvFile.writeEnvPatch 双目标写回 auto/false + 披露；`KHY_ENV_PIN_LEASE=off` 关；用户显式钉选不触发）；⑤ 失败建议改推 `khy gateway model`（选模型不钉通道）。**测试归因（HEAD 单文件对比法）**：HEAD 18 fail→改后 8 fail，零新增净修 10（Z-02…Z-10 全绿）；剩 8 条全为存量。⚠ mirror `services/.env:5-6` 残留 claude/true（凭据文件读被拦未手改），由租约运行时自愈。另：.env:6-7 第二层钉选 PROXY_PRIMARY_ADAPTER=relay_api+strict，RELAY_API_KEY 是 fixture 假值（别误判全局无通道）。
- ⚠ 本沙箱跑 `khy gateway status` 被拦：IDE 适配器探活 spawn reg.exe（沙箱黑名单）——通道实测状态只能让用户自己跑。

## TUI（[DESIGN-ARCH-132]/[DESIGN-ARCH-135]）
- `_chatState.messages` 是模型上下文真源；`conversationMessages` 是压缩视图唯一出口（TUI 直调 loop 不读 = 白做）。
- **中文关键词正则禁 `\b`**（永不匹配）。续跑策略真源 `agenticHarnessService.continuation`；压缩阈值真源 `contextRouter.js`（别写 ×0.7 字面量）。
- 选区漂移一期已落地（`selection.js` relocate*，指纹=归一化行原文，17 绿）；待二期 `App.js:1560` 接线、三期行投影。选区基线 **57**。App.js 并行会话共编，动前确认。
- TUI 叶子纪律：零 IO、绝不抛、**绝不读 env**、不改入参、外部数据调用方传。守卫 `check-leaf-contract.js`（须带文件参数）。
- env 门预算棘轮 MAX_GATES=220 只降不升；「让功能变正确」不加 env 门（用可选参数 = 回滚能力 + 保 B-P1 豁免）。

## 软著（真源见交付包与规范文档）
- 真源 `[DESIGN-IP-001]`（PROCESS-010）；执行器 `check-copyright-readiness.js`（S1 只记录）。登记真源 COPYRIGHT.json / COPYRIGHT-MATERIALS.json。
- 顺序铁律：**定名 → 全局改名 → 截图 → 出材料**。三红线：不改 git 历史（88 条 AI 署名如实申报）、不为好看重写代码、不跳过定名。
- 交付根：`D:\Portable\软著交付\Khy-OS`（**仓库外**）。`_整档/`=隔离归档（只搬不删+README）。浏览器档案严禁落交付包：无头浏览器必须 `--user-data-dir` 指 `D:\WorkBuddyData\.workbuddy\tmp\softreg-prof`。
- `--page-chunks 55`：换名/版本后重渲染页数恒 30×56，无需重校准。重出：`verify_material.py --name --version`。

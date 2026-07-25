# [OPS-MAN-066] Khy-OS 进化提示词手册（1000 条）

> 交给 khy 或任何「弱智 AI / 4B 小模型」用的进化清单：一次喂一条，照着做，跑通它自带的验证命令。
> 全部锚定本仓真实子系统、真实文件、真实 verify（来自 `docs/维护者/维护映射表.json`）。

## 怎么用（给小模型的三步）

1. 从下面挑一条提示词，把「说明」读懂，按 **B1**（先想清改什么/为什么/影响面）动手。
2. 改完立刻跑该条的「验证」命令；红灯就在本轮修好，**没跑过验证不许说「修好了」**（B2）。
3. 只动该动的（**B3** 外科手术式改动），绿了再挑下一条。

## 红线（破了就停，不许绕）

- **禁止 AI 自动 commit / push**：任何提交都要人明确点头。
- **禁止把真 key/token 写进源码/包/提交**：只经 env 注入，日志只打印长度不打印明文；**禁贴 key 到对话**。
- **单文件不得新增超 2500 行**：超了按 god-file 治理（同名 re-export + DI，保字节等价）。
- **pip 与 npm 版本号必须一致**。

## 通用验证门速查（收尾五门，全绿才算完成）

```bash
node --check <改动的每个 .js 文件>      # 语法
node --test <相关 node:test 文件>       # 逻辑（勿用 jest 前缀）
npm run arch:god                       # 改动文件不得新增超 2500 行（在 services/backend 下跑）
npm run check:small-model:safety       # 五守卫合集（新叶子须显式传路径扫）
npm run maintainer:check               # 维护映射表 + 元数据一致
```

## 手册如何重生（系统长大后）

本手册由生成器确定性产出，改子系统后重跑即可覆盖：

```bash
npm run docs:gen-evolution-prompts     # 重新生成本文件
npm run test:evolution-prompts         # 校验恰好 1000 条、每条带安全 verify、幂等
```

> 新增子系统请先登记进 `docs/维护者/维护映射表.json`，本手册下次重生会自动覆盖它。

**共 1000 条。**

---


## 一、通用工作纪律与红线（先读这一篇）

**1.** 每次动手前先做 B1：用一句话说清「改什么 / 为什么 / 影响面」，说不清就先别改。
  - 说明：先想再写，避免瞎改。
  - 验证：`npm run check:agent-rules`

**2.** 用 B2 目标驱动循环：先定义可验证的成功标准，再自循环到绿，验证没过绝不说「修好了」。
  - 说明：核心方法论。
  - 验证：`npm run maintainer:check`

**3.** 遵守 B3 外科手术式改动：只动该动的，不顺手重构、不扩大范围。
  - 说明：把改动面压到最小。
  - 验证：`npm run check:change-safety`

**4.** 改任何文件前，先读 .ai/MAP.md 与 docs/维护者/维护映射表.json 定位正确子系统。
  - 说明：别在错的地方改。
  - 验证：`npm run maintainer:check`

**5.** 多步任务先列 plan，每一步都写明它自己的 verify 命令。
  - 说明：每步可验证。
  - 验证：`npm run check:agent-rules`

**6.** 红线：绝不 AI 自动 commit/push，任何提交都要用户明确点头。
  - 说明：提交权在人。
  - 验证：`npm run check:agent-rules`

**7.** 红线：真 key/token 绝不进源码 / 包 / 提交，只经 env 注入，日志只打印长度不打印明文。
  - 说明：密钥防泄露。
  - 验证：`npm run check:model-hardcoding`

**8.** 红线：任何文件不得新增超过 2500 行；超了就按 god-file 治理抽叶子。
  - 说明：上帝文件门。
  - 验证：`npm run arch:god`

**9.** 红线：pip khy-os 与 npm @khy-os/khy-os 版本号必须一致。
  - 说明：双渠道同步。
  - 验证：`npm run check:version-sync`

**10.** 抽取 god-file 时保字节等价：同名 re-export + DI 注入，函数体一字不改。
  - 说明：拆解不改行为。
  - 验证：`npm run arch:god`

**11.** 新增开关必须先在 flagRegistry 登记，未登记的 flag 会被当作恒放行。
  - 说明：门要先登记。
  - 验证：`npm run check:flag-registry`

**12.** 纯叶子三铁律：零 IO、确定性、绝不抛异常（任何异常都返回安全默认值）。
  - 说明：叶子契约。
  - 验证：`npm run check:leaf-contract`

**13.** node:test 文件必须用 `node --test` 跑，别用 jest 前缀（会假阳）。
  - 说明：别跑错 runner。
  - 验证：`npm run test:maintainer:all`

**14.** 判断测试红灯是不是自己造成的：用 git stash / pristine backup 对照，别把既有红算作本次破坏。
  - 说明：甄别 pre-existing。
  - 验证：`npm run check:change-safety`

**15.** 三守卫用 --changed 扫；untracked 新叶子不在 diff 里，必须显式传路径扫。
  - 说明：新叶子要显式扫。
  - 验证：`npm run check:agent-rules`

**16.** 收尾五门：node --check、相关测试、arch:god、三守卫、maintainer:check，全绿才回报。
  - 说明：做完的定义。
  - 验证：`npm run maintainer:check`

**17.** 每完成一个子任务就更新 memory：写清「为什么这么改」而不是「改了什么」。
  - 说明：沉淀非显然信息。
  - 验证：`npm run maintainer:check`

**18.** 需求不确定先问清，别猜着改；能从代码/默认值确定的就直接做。
  - 说明：该问就问。
  - 验证：`npm run check:agent-rules`

**19.** 破坏性操作（删除/覆盖）前先看目标内容，若与描述矛盾就停下来报告。
  - 说明：删前先看。
  - 验证：`npm run check:change-safety`

**20.** 给弱模型留路：变量名自解释、关键分支有注释、注册表上方有 HOW-TO-EXTEND。
  - 说明：可维护性优先。
  - 验证：`npm run maintainer:check`

**21.** 每个新子系统必须登记进维护映射表（whenToUse/paths/docs/verify 四要素齐全）。
  - 说明：登记才可发现。
  - 验证：`npm run maintainer:check`

**22.** 每个新叶子配一条 node:test，并并入 test:maintainer:all 一键自证。
  - 说明：测试并网。
  - 验证：`npm run test:maintainer:all`

**23.** 优先复用已有机制（维护映射表、flagRegistry 等），别另造平行体系。
  - 说明：不重复造轮子。
  - 验证：`npm run maintainer:check`

**24.** 改动涉及网关核心时，跑 test:maintainer:gateway 并 khy doctor 双确认。
  - 说明：网关双保。
  - 验证：`khy doctor`

**25.** 改动涉及启动/端口/守护进程时，跑 test:maintainer:runtime 并 khy doctor。
  - 说明：运行时双保。
  - 验证：`khy doctor`

**26.** 改动涉及 CLI 路由/别名时，跑 test:maintainer:cli-routing 确认命令仍分发正确。
  - 说明：路由自证。
  - 验证：`npm run maintainer:check`

**27.** 改动涉及发布/版本时，先跑 check:version-sync 再动手。
  - 说明：版本先对齐。
  - 验证：`npm run check:version-sync`

**28.** 改动涉及打包布局时，跑 check:quality-gates 覆盖 manifest 与语法。
  - 说明：打包自检。
  - 验证：`npm run check:quality-gates`

**29.** 任何「已验证」的声称都要附具体证据（通过数/退出码/测试名），空口不算。
  - 说明：证据门。
  - 验证：`npm run maintainer:check`

**30.** 卡住或预算耗尽时，如实报告卡在哪、红灯输出、已试过什么、下一步建议，绝不假报成功。
  - 说明：诚实回报。
  - 验证：`npm run check:agent-rules`

**31.** 给错误路径补指名道姓的可执行指引，别让用户对着「未知错误」发懵。
  - 说明：错误可执行。
  - 验证：`npm run maintainer:check`

**32.** 敏感操作走确定性处理器/审批网关，别让模型自由裁量安全边界。
  - 说明：安全不靠裁量。
  - 验证：`npm run check:small-model:safety`

**33.** 平台差异（linux/windows/macos/android/ios）收在注册表白名单一处，不 smear。
  - 说明：差异集中。
  - 验证：`npm run maintainer:check`

**34.** 截断/采样/限数时必须 log 丢了什么，杜绝「静默截断＝看似全覆盖」。
  - 说明：别静默丢。
  - 验证：`npm run check:change-safety`

**35.** 时间/随机相关逻辑改为可注入，让测试确定性、可离线复现。
  - 说明：可测性。
  - 验证：`npm run check:agent-rules`

**36.** 每轮重复构建的结构（Set/正则/常量）提升为模块常量（参考书 Ch2）。
  - 说明：别每轮重建。
  - 验证：`npm run arch:god`

**37.** flag 语义：opt-in 严格只认 1/true；default-on 只有关键词才关。
  - 说明：门语义。
  - 验证：`npm run check:flag-registry`

**38.** 父门关闭必须强制子功能整体关闭，补一条门控测试守护它。
  - 说明：父子门链。
  - 验证：`npm run check:flag-registry`

**39.** 改完立刻自测，红灯就在本轮修，不把红灯留给下一步。
  - 说明：本轮清红。
  - 验证：`npm run maintainer:check`

**40.** 一次只推进一个可验证的小目标，绿了再开下一个。
  - 说明：小步快跑。
  - 验证：`npm run check:agent-rules`

**41.** 不确定命令是否安全时，先用只读方式查，别直接跑破坏性命令。
  - 说明：先只读。
  - 验证：`npm run check:agent-rules`

**42.** 维护映射表里列的 paths 必须真实存在，删文件时同步更新映射表。
  - 说明：路径不悬空。
  - 验证：`npm run maintainer:check`

**43.** 文档改动后同步更新分类索引与主索引的条目和计数。
  - 说明：索引同步。
  - 验证：`npm run maintainer:check`

**44.** 给每个子系统一条「一句话验证脚本」，让 4B 小模型也能自证绿灯。
  - 说明：一句话可验。
  - 验证：`npm run test:maintainer:all`

**45.** 抽取叶子后 grep 每个被调函数，确认无死引用、无漏迁的反向边。
  - 说明：抽取查引用。
  - 验证：`npm run check:leaf-contract`

**46.** 巨型 switch 按 case 簇抽子分派器，用 pre-dispatch + 哨兵 fall-through 保安全。
  - 说明：switch 拆解。
  - 验证：`npm run arch:god`

**47.** 可变状态跨簇共享时不可净抽，必须用 DI 注入证伪「共享数组」。
  - 说明：共享态用 DI。
  - 验证：`npm run arch:god`

**48.** 每条 memory 只存一个事实，配 frontmatter，并在 MEMORY.md 留一行指针。
  - 说明：memory 规范。
  - 验证：`npm run maintainer:check`

**49.** 别存代码结构/git 历史能查到的东西，只存非显然的「为什么」。
  - 说明：存该存的。
  - 验证：`npm run maintainer:check`

**50.** 用 [[name]] 链接相关 memory，织成传承网络。
  - 说明：记忆织网。
  - 验证：`npm run maintainer:check`

**51.** 发布前用 wheel 对已知泄露 key 做 0 命中校验。
  - 说明：发包零泄漏。
  - 验证：`npm run check:model-hardcoding`

**52.** 占位 key 必须一眼假，不得是真 key 的篡改副本。
  - 说明：占位要假。
  - 验证：`npm run check:model-hardcoding`

**53.** 双通道发布用 publish-dual.sh，preflight 自动派生 token，杜绝裂脑。
  - 说明：发布不裂脑。
  - 验证：`npm run check:version-sync`

**54.** 回滚看 maintenance/stable-release.json 找上一个 known-good 版本。
  - 说明：回滚有据。
  - 验证：`npm run check:version-sync`

**55.** 每次大改后跑 test:maintainer:all 做一次全子系统体检。
  - 说明：全量体检。
  - 验证：`npm run test:maintainer:all`

**56.** arch:god 报的超限文件先甄别 pre-existing，别把既有债算作新增。
  - 说明：别背旧债。
  - 验证：`npm run arch:god`

**57.** 给关键常量注释「为什么是这个值」（上限来源、保守高估等）。
  - 说明：常量讲来源。
  - 验证：`npm run check:change-safety`

**58.** 用户可见文案统一措辞，别同义词乱用误导弱模型。
  - 说明：文案一致。
  - 验证：`npm run maintainer:check`

**59.** 每个 PR 级改动配「完成标准」段，逐条对着证据核对。
  - 说明：完成契约。
  - 验证：`npm run maintainer:check`

**60.** 说再见后也要能自证：任何人跑 test:maintainer:all 全绿即系统健康。
  - 说明：可自证健康。
  - 验证：`npm run test:maintainer:all`


## 二、各子系统定位与自检

**61.** 如果「CLI does not start」，先读「Bootstrap and Packaging」相关文件（见 platform/khy_platform/cli.py），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Bootstrap and Packaging。触发词命中时的第一反应。
  - 验证：`npm run check:maintainer:bootstrap`

**62.** 如果「pip package layout is broken」，先读「Bootstrap and Packaging」相关文件（见 platform/khy_platform/cli.py），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Bootstrap and Packaging。触发词命中时的第一反应。
  - 验证：`npm run check:maintainer:bootstrap`

**63.** 如果「version numbers drift」，先读「Bootstrap and Packaging」相关文件（见 platform/khy_platform/cli.py），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Bootstrap and Packaging。触发词命中时的第一反应。
  - 验证：`npm run check:maintainer:bootstrap`

**64.** 如果「first-run bootstrap fails」，先读「Bootstrap and Packaging」相关文件（见 platform/khy_platform/cli.py），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Bootstrap and Packaging。触发词命中时的第一反应。
  - 验证：`npm run check:maintainer:bootstrap`

**65.** 如果「command not recognized」，先读「CLI Routing and Help Surface」相关文件（见 services/backend/src/constants/commandSchema.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：CLI Routing and Help Surface。触发词命中时的第一反应。
  - 验证：`npm run test:maintainer:cli-routing`

**66.** 如果「alias routes to wrong command」，先读「CLI Routing and Help Surface」相关文件（见 services/backend/src/constants/commandSchema.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：CLI Routing and Help Surface。触发词命中时的第一反应。
  - 验证：`npm run test:maintainer:cli-routing`

**67.** 如果「slash command missing」，先读「CLI Routing and Help Surface」相关文件（见 services/backend/src/constants/commandSchema.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：CLI Routing and Help Surface。触发词命中时的第一反应。
  - 验证：`npm run test:maintainer:cli-routing`

**68.** 如果「help text does not match behavior」，先读「CLI Routing and Help Surface」相关文件（见 services/backend/src/constants/commandSchema.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：CLI Routing and Help Surface。触发词命中时的第一反应。
  - 验证：`npm run test:maintainer:cli-routing`

**69.** 如果「system prompt assembly is wrong」，先读「Prompt Capsule and Debug Prompt System」相关文件（见 services/backend/src/constants/prompts.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Prompt Capsule and Debug Prompt System。触发词命中时的第一反应。
  - 验证：`node --test services/backend/tests/promptOnDemandSections.test.js`

**70.** 如果「on-demand capsules misfire」，先读「Prompt Capsule and Debug Prompt System」相关文件（见 services/backend/src/constants/prompts.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Prompt Capsule and Debug Prompt System。触发词命中时的第一反应。
  - 验证：`node --test services/backend/tests/promptOnDemandSections.test.js`

**71.** 如果「gateway debug-prompt output drifts」，先读「Prompt Capsule and Debug Prompt System」相关文件（见 services/backend/src/constants/prompts.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Prompt Capsule and Debug Prompt System。触发词命中时的第一反应。
  - 验证：`node --test services/backend/tests/promptOnDemandSections.test.js`

**72.** 如果「adapter selection is wrong」，先读「AI Gateway and Adapter Layer」相关文件（见 services/backend/src/services/gateway/aiGateway.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：AI Gateway and Adapter Layer。触发词命中时的第一反应。
  - 验证：`npm run test:maintainer:gateway`

**73.** 如果「streaming breaks」，先读「AI Gateway and Adapter Layer」相关文件（见 services/backend/src/services/gateway/aiGateway.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：AI Gateway and Adapter Layer。触发词命中时的第一反应。
  - 验证：`npm run test:maintainer:gateway`

**74.** 如果「model fallback is wrong」，先读「AI Gateway and Adapter Layer」相关文件（见 services/backend/src/services/gateway/aiGateway.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：AI Gateway and Adapter Layer。触发词命中时的第一反应。
  - 验证：`npm run test:maintainer:gateway`

**75.** 如果「request normalization is wrong」，先读「AI Gateway and Adapter Layer」相关文件（见 services/backend/src/services/gateway/aiGateway.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：AI Gateway and Adapter Layer。触发词命中时的第一反应。
  - 验证：`npm run test:maintainer:gateway`

**76.** 如果「daemon starts on wrong port」，先读「Proxy, Daemon, and Runtime Port Discovery」相关文件（见 services/backend/src/services/daemonManager.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Proxy, Daemon, and Runtime Port Discovery。触发词命中时的第一反应。
  - 验证：`npm run test:maintainer:runtime`

**77.** 如果「proxy URL is stale」，先读「Proxy, Daemon, and Runtime Port Discovery」相关文件（见 services/backend/src/services/daemonManager.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Proxy, Daemon, and Runtime Port Discovery。触发词命中时的第一反应。
  - 验证：`npm run test:maintainer:runtime`

**78.** 如果「gateway manage cannot reconnect」，先读「Proxy, Daemon, and Runtime Port Discovery」相关文件（见 services/backend/src/services/daemonManager.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Proxy, Daemon, and Runtime Port Discovery。触发词命中时的第一反应。
  - 验证：`npm run test:maintainer:runtime`

**79.** 如果「port drift appears after restart」，先读「Proxy, Daemon, and Runtime Port Discovery」相关文件（见 services/backend/src/services/daemonManager.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Proxy, Daemon, and Runtime Port Discovery。触发词命中时的第一反应。
  - 验证：`npm run test:maintainer:runtime`

**80.** 如果「gateway manage page is broken」，先读「AI Management UI and API」相关文件（见 services/backend/src/routes/aiGatewayAdmin.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：AI Management UI and API。触发词命中时的第一反应。
  - 验证：`npm run test:maintainer:ai-management`

**81.** 如果「AI management route fails」，先读「AI Management UI and API」相关文件（见 services/backend/src/routes/aiGatewayAdmin.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：AI Management UI and API。触发词命中时的第一反应。
  - 验证：`npm run test:maintainer:ai-management`

**82.** 如果「admin API and AI UI drift」，先读「AI Management UI and API」相关文件（见 services/backend/src/routes/aiGatewayAdmin.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：AI Management UI and API。触发词命中时的第一反应。
  - 验证：`npm run test:maintainer:ai-management`

**83.** 如果「projects workspace page is broken」，先读「Coding Projects (named workspaces + chat linkage)」相关文件（见 platform/packages/shared/src/models/UserProject.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。触发词命中时的第一反应。
  - 验证：`npm run test:maintainer:projects`

**84.** 如果「chat sidebar project filter fails」，先读「Coding Projects (named workspaces + chat linkage)」相关文件（见 platform/packages/shared/src/models/UserProject.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。触发词命中时的第一反应。
  - 验证：`npm run test:maintainer:projects`

**85.** 如果「conversations not filed under the right project」，先读「Coding Projects (named workspaces + chat linkage)」相关文件（见 platform/packages/shared/src/models/UserProject.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。触发词命中时的第一反应。
  - 验证：`npm run test:maintainer:projects`

**86.** 如果「/api/ai/projects REST errors」，先读「Coding Projects (named workspaces + chat linkage)」相关文件（见 platform/packages/shared/src/models/UserProject.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。触发词命中时的第一反应。
  - 验证：`npm run test:maintainer:projects`

**87.** 如果「workspace snapshot behavior is wrong」，先读「Workspace, Publish, and Verification Commands」相关文件（见 services/backend/src/cli/handlers/workspace.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Workspace, Publish, and Verification Commands。触发词命中时的第一反应。
  - 验证：`npm run test:maintainer:publish`

**88.** 如果「publish command is broken」，先读「Workspace, Publish, and Verification Commands」相关文件（见 services/backend/src/cli/handlers/workspace.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Workspace, Publish, and Verification Commands。触发词命中时的第一反应。
  - 验证：`npm run test:maintainer:publish`

**89.** 如果「verification workflow regressed」，先读「Workspace, Publish, and Verification Commands」相关文件（见 services/backend/src/cli/handlers/workspace.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Workspace, Publish, and Verification Commands。触发词命中时的第一反应。
  - 验证：`npm run test:maintainer:publish`

**90.** 如果「you changed startup/network/task execution」，先读「Maintenance Safety and Rule Gates」相关文件（见 AGENTS.md），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Maintenance Safety and Rule Gates。触发词命中时的第一反应。
  - 验证：`npm run check:maintainer:safety`

**91.** 如果「you need a fast changed-file gate」，先读「Maintenance Safety and Rule Gates」相关文件（见 AGENTS.md），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Maintenance Safety and Rule Gates。触发词命中时的第一反应。
  - 验证：`npm run check:maintainer:safety`

**92.** 如果「you need to verify handoff guardrails」，先读「Maintenance Safety and Rule Gates」相关文件（见 AGENTS.md），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Maintenance Safety and Rule Gates。触发词命中时的第一反应。
  - 验证：`npm run check:maintainer:safety`

**93.** 如果「you need a fixed, repeatable release path (check → build → audit → publish → verify)」，先读「Release and Rollback」相关文件（见 maintenance/stable-release.json），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Release and Rollback。触发词命中时的第一反应。
  - 验证：`node --test maintenance/tests/ops-lib.test.js maintenance/tests/ops.integration.test.js`

**94.** 如果「an upgrade broke something and you must roll back to the last known-good version」，先读「Release and Rollback」相关文件（见 maintenance/stable-release.json），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Release and Rollback。触发词命中时的第一反应。
  - 验证：`node --test maintenance/tests/ops-lib.test.js maintenance/tests/ops.integration.test.js`

**95.** 如果「you need to know which version is the current stable baseline」，先读「Release and Rollback」相关文件（见 maintenance/stable-release.json），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Release and Rollback。触发词命中时的第一反应。
  - 验证：`node --test maintenance/tests/ops-lib.test.js maintenance/tests/ops.integration.test.js`

**96.** 如果「release artifacts or the post-release check regressed」，先读「Release and Rollback」相关文件（见 maintenance/stable-release.json），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Release and Rollback。触发词命中时的第一反应。
  - 验证：`node --test maintenance/tests/ops-lib.test.js maintenance/tests/ops.integration.test.js`

**97.** 如果「the phrase 打造最佳环境 does not trigger the self-check pipeline」，先读「Build Best Environment (Self-check / Repair / Probes)」相关文件（见 services/backend/src/services/localBrainEnvOptimize.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Build Best Environment (Self-check / Repair / Probes)。触发词命中时的第一反应。
  - 验证：`npm run test:maintainer:env-optimize`

**98.** 如果「you want to add a new read-only health check (probe)」，先读「Build Best Environment (Self-check / Repair / Probes)」相关文件（见 services/backend/src/services/localBrainEnvOptimize.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Build Best Environment (Self-check / Repair / Probes)。触发词命中时的第一反应。
  - 验证：`npm run test:maintainer:env-optimize`

**99.** 如果「you want to add a new safe create-missing repair」，先读「Build Best Environment (Self-check / Repair / Probes)」相关文件（见 services/backend/src/services/localBrainEnvOptimize.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Build Best Environment (Self-check / Repair / Probes)。触发词命中时的第一反应。
  - 验证：`npm run test:maintainer:env-optimize`

**100.** 如果「a probe or repair should run only on some OSes (linux/windows/macos/android/ios)」，先读「Build Best Environment (Self-check / Repair / Probes)」相关文件（见 services/backend/src/services/localBrainEnvOptimize.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Build Best Environment (Self-check / Repair / Probes)。触发词命中时的第一反应。
  - 验证：`npm run test:maintainer:env-optimize`

**101.** 如果「the junk scan, repair, or probe section renders wrong」，先读「Build Best Environment (Self-check / Repair / Probes)」相关文件（见 services/backend/src/services/localBrainEnvOptimize.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Build Best Environment (Self-check / Repair / Probes)。触发词命中时的第一反应。
  - 验证：`npm run test:maintainer:env-optimize`

**102.** 如果「a novice user or weak AI needs a runnable list of safe next improvements」，先读「Evolution Prompt Playbook (1000 preset prompts)」相关文件（见 scripts/docs/gen-evolution-prompts.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Evolution Prompt Playbook (1000 preset prompts)。触发词命中时的第一反应。
  - 验证：`npm run test:evolution-prompts`

**103.** 如果「the 1000-prompt playbook count or verify commands drifted」，先读「Evolution Prompt Playbook (1000 preset prompts)」相关文件（见 scripts/docs/gen-evolution-prompts.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Evolution Prompt Playbook (1000 preset prompts)。触发词命中时的第一反应。
  - 验证：`npm run test:evolution-prompts`

**104.** 如果「you added a new subsystem and want the playbook to cover it」，先读「Evolution Prompt Playbook (1000 preset prompts)」相关文件（见 scripts/docs/gen-evolution-prompts.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Evolution Prompt Playbook (1000 preset prompts)。触发词命中时的第一反应。
  - 验证：`npm run test:evolution-prompts`

**105.** 如果「the OPS-MAN-066 doc is out of sync with its generator」，先读「Evolution Prompt Playbook (1000 preset prompts)」相关文件（见 scripts/docs/gen-evolution-prompts.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Evolution Prompt Playbook (1000 preset prompts)。触发词命中时的第一反应。
  - 验证：`npm run test:evolution-prompts`

**106.** 如果「you see an error or symptom but do not know which subsystem owns it」，先读「Symptom Triage (route a symptom to its subsystem)」相关文件（见 scripts/lib/maintainerTriage.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Symptom Triage (route a symptom to its subsystem)。触发词命中时的第一反应。
  - 验证：`npm run test:triage`

**107.** 如果「a user or weak AI needs to be routed from a symptom to files and verify commands」，先读「Symptom Triage (route a symptom to its subsystem)」相关文件（见 scripts/lib/maintainerTriage.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Symptom Triage (route a symptom to its subsystem)。触发词命中时的第一反应。
  - 验证：`npm run test:triage`

**108.** 如果「the triage matcher mis-routes a symptom」，先读「Symptom Triage (route a symptom to its subsystem)」相关文件（见 scripts/lib/maintainerTriage.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Symptom Triage (route a symptom to its subsystem)。触发词命中时的第一反应。
  - 验证：`npm run test:triage`

**109.** 如果「the OPS-MAN-067 cheat sheet is out of sync with its generator」，先读「Symptom Triage (route a symptom to its subsystem)」相关文件（见 scripts/lib/maintainerTriage.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Symptom Triage (route a symptom to its subsystem)。触发词命中时的第一反应。
  - 验证：`npm run test:triage`

**110.** 如果「a developer / user / maintainer installed khyos on a new machine and wants to know if it can fully restore」，先读「Off-machine Restore Readiness (can a fresh machine restore khyos?)」相关文件（见 scripts/lib/restoreReadiness.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Off-machine Restore Readiness (can a fresh machine restore khyos?)。触发词命中时的第一反应。
  - 验证：`npm run test:restore-readiness`

**111.** 如果「you need to explain what pip khy-os / npm @khy-os/khy-os actually bundle vs hydrate at first run」，先读「Off-machine Restore Readiness (can a fresh machine restore khyos?)」相关文件（见 scripts/lib/restoreReadiness.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Off-machine Restore Readiness (can a fresh machine restore khyos?)。触发词命中时的第一反应。
  - 验证：`npm run test:restore-readiness`

**112.** 如果「the restore self-check mis-reports readiness or a rule is missing」，先读「Off-machine Restore Readiness (can a fresh machine restore khyos?)」相关文件（见 scripts/lib/restoreReadiness.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Off-machine Restore Readiness (can a fresh machine restore khyos?)。触发词命中时的第一反应。
  - 验证：`npm run test:restore-readiness`

**113.** 如果「the OPS-MAN-068 restore checklist is out of sync with its generator」，先读「Off-machine Restore Readiness (can a fresh machine restore khyos?)」相关文件（见 scripts/lib/restoreReadiness.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Off-machine Restore Readiness (can a fresh machine restore khyos?)。触发词命中时的第一反应。
  - 验证：`npm run test:restore-readiness`

**114.** 如果「khyos was installed via pip khy-os / npm @khy-os/khy-os but fails to start and you suspect a truncated or partial bundle」，先读「Installed-copy Integrity (is the on-disk bundle actually complete?)」相关文件（见 scripts/lib/installIntegrity.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Installed-copy Integrity (is the on-disk bundle actually complete?)。触发词命中时的第一反应。
  - 验证：`npm run test:install-integrity`

**115.** 如果「you need to verify the shipped bundle still contains every runtime-critical file」，先读「Installed-copy Integrity (is the on-disk bundle actually complete?)」相关文件（见 scripts/lib/installIntegrity.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Installed-copy Integrity (is the on-disk bundle actually complete?)。触发词命中时的第一反应。
  - 验证：`npm run test:install-integrity`

**116.** 如果「a runtime-critical path was added/removed and CRITICAL_BUNDLE_PATHS must track the publish gate」，先读「Installed-copy Integrity (is the on-disk bundle actually complete?)」相关文件（见 scripts/lib/installIntegrity.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Installed-copy Integrity (is the on-disk bundle actually complete?)。触发词命中时的第一反应。
  - 验证：`npm run test:install-integrity`

**117.** 如果「the OPS-MAN-069 installed-copy checklist is out of sync with its generator」，先读「Installed-copy Integrity (is the on-disk bundle actually complete?)」相关文件（见 scripts/lib/installIntegrity.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Installed-copy Integrity (is the on-disk bundle actually complete?)。触发词命中时的第一反应。
  - 验证：`npm run test:install-integrity`

**118.** 如果「khyos installed and the bundle is complete, but the backend still fails to start and you suspect node_modules is missing or half-installed」，先读「First-run Hydration Health (did the online dependency hydrate actually succeed?)」相关文件（见 scripts/lib/hydrationHealth.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：First-run Hydration Health (did the online dependency hydrate actually succeed?)。触发词命中时的第一反应。
  - 验证：`npm run test:hydration-health`

**119.** 如果「you need to detect the splitbrain case: the .khy_quant_bootstrapped marker says hydration is done but node_modules was deleted」，先读「First-run Hydration Health (did the online dependency hydrate actually succeed?)」相关文件（见 scripts/lib/hydrationHealth.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：First-run Hydration Health (did the online dependency hydrate actually succeed?)。触发词命中时的第一反应。
  - 验证：`npm run test:hydration-health`

**120.** 如果「the @khy/shared workspace symlink is broken, or a critical runtime dependency is missing」，先读「First-run Hydration Health (did the online dependency hydrate actually succeed?)」相关文件（见 scripts/lib/hydrationHealth.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：First-run Hydration Health (did the online dependency hydrate actually succeed?)。触发词命中时的第一反应。
  - 验证：`npm run test:hydration-health`

**121.** 如果「a runtime dependency was renamed/removed and CRITICAL_PACKAGES must track services/backend package.json」，先读「First-run Hydration Health (did the online dependency hydrate actually succeed?)」相关文件（见 scripts/lib/hydrationHealth.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：First-run Hydration Health (did the online dependency hydrate actually succeed?)。触发词命中时的第一反应。
  - 验证：`npm run test:hydration-health`

**122.** 如果「the OPS-MAN-070 hydration checklist is out of sync with its generator」，先读「First-run Hydration Health (did the online dependency hydrate actually succeed?)」相关文件（见 scripts/lib/hydrationHealth.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：First-run Hydration Health (did the online dependency hydrate actually succeed?)。触发词命中时的第一反应。
  - 验证：`npm run test:hydration-health`

**123.** 如果「selected proxy node does not route traffic」，先读「Proxy Egress Bridge (select node + enable/disable)」相关文件（见 services/backend/src/services/proxy/proxyCoreConfigGen.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Proxy Egress Bridge (select node + enable/disable)。触发词命中时的第一反应。
  - 验证：`npm run test:maintainer:proxy-egress`

**124.** 如果「proxy enable/disable toggle fails」，先读「Proxy Egress Bridge (select node + enable/disable)」相关文件（见 services/backend/src/services/proxy/proxyCoreConfigGen.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Proxy Egress Bridge (select node + enable/disable)。触发词命中时的第一反应。
  - 验证：`npm run test:maintainer:proxy-egress`

**125.** 如果「core-required node reports core-missing but no guidance shown」，先读「Proxy Egress Bridge (select node + enable/disable)」相关文件（见 services/backend/src/services/proxy/proxyCoreConfigGen.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Proxy Egress Bridge (select node + enable/disable)。触发词命中时的第一反应。
  - 验证：`npm run test:maintainer:proxy-egress`

**126.** 如果「/api/proxy-egress REST errors」，先读「Proxy Egress Bridge (select node + enable/disable)」相关文件（见 services/backend/src/services/proxy/proxyCoreConfigGen.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Proxy Egress Bridge (select node + enable/disable)。触发词命中时的第一反应。
  - 验证：`npm run test:maintainer:proxy-egress`

**127.** 如果「HTTP_PROXY env not applied after choosing a node」，先读「Proxy Egress Bridge (select node + enable/disable)」相关文件（见 services/backend/src/services/proxy/proxyCoreConfigGen.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Proxy Egress Bridge (select node + enable/disable)。触发词命中时的第一反应。
  - 验证：`npm run test:maintainer:proxy-egress`


## 三、各子系统验证门（一条命令＝一块的绿灯）

**128.** 验证「Bootstrap and Packaging」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Bootstrap and Packaging。
  - 验证：`npm run check:maintainer:bootstrap`

**129.** 验证「Bootstrap and Packaging」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Bootstrap and Packaging。
  - 验证：`npm run check:manifest-sync`

**130.** 验证「Bootstrap and Packaging」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Bootstrap and Packaging。
  - 验证：`bash scripts/release/build-and-audit-pip-purity.sh`

**131.** 验证「CLI Routing and Help Surface」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：CLI Routing and Help Surface。
  - 验证：`npm run test:maintainer:cli-routing`

**132.** 验证「CLI Routing and Help Surface」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：CLI Routing and Help Surface。
  - 验证：`node -e "require('./services/backend/src/cli/router')"`

**133.** 验证「Prompt Capsule and Debug Prompt System」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`node --test services/backend/tests/promptOnDemandSections.test.js`

**134.** 验证「Prompt Capsule and Debug Prompt System」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`node --test services/backend/tests/promptLearningRules.test.js`

**135.** 验证「Prompt Capsule and Debug Prompt System」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`npx jest services/backend/tests/gatewayDebugPrompt.test.js --runInBand`

**136.** 验证「AI Gateway and Adapter Layer」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run test:maintainer:gateway`

**137.** 验证「AI Gateway and Adapter Layer」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：AI Gateway and Adapter Layer。
  - 验证：`node -e "require('./services/backend/src/services/gateway/aiGateway')"`

**138.** 验证「AI Gateway and Adapter Layer」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：AI Gateway and Adapter Layer。
  - 验证：`khy doctor`

**139.** 验证「Proxy, Daemon, and Runtime Port Discovery」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run test:maintainer:runtime`

**140.** 验证「Proxy, Daemon, and Runtime Port Discovery」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`khy doctor`

**141.** 验证「AI Management UI and API」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：AI Management UI and API。
  - 验证：`npm run test:maintainer:ai-management`

**142.** 验证「AI Management UI and API」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：AI Management UI and API。
  - 验证：`npm run build --prefix apps/ai-frontend`

**143.** 验证「Coding Projects (named workspaces + chat linkage)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run test:maintainer:projects`

**144.** 验证「Coding Projects (named workspaces + chat linkage)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run build --prefix apps/ai-frontend`

**145.** 验证「Workspace, Publish, and Verification Commands」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Workspace, Publish, and Verification Commands。
  - 验证：`npm run test:maintainer:publish`

**146.** 验证「Maintenance Safety and Rule Gates」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Maintenance Safety and Rule Gates。
  - 验证：`npm run check:maintainer:safety`

**147.** 验证「Maintenance Safety and Rule Gates」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Maintenance Safety and Rule Gates。
  - 验证：`npm run check:quality-gates`

**148.** 验证「Release and Rollback」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Release and Rollback。
  - 验证：`node --test maintenance/tests/ops-lib.test.js maintenance/tests/ops.integration.test.js`

**149.** 验证「Release and Rollback」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Release and Rollback。
  - 验证：`npm run check:version-sync`

**150.** 验证「Build Best Environment (Self-check / Repair / Probes)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Build Best Environment (Self-check / Repair / Probes)。
  - 验证：`npm run test:maintainer:env-optimize`

**151.** 验证「Evolution Prompt Playbook (1000 preset prompts)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Evolution Prompt Playbook (1000 preset prompts)。
  - 验证：`npm run test:evolution-prompts`

**152.** 验证「Symptom Triage (route a symptom to its subsystem)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Symptom Triage (route a symptom to its subsystem)。
  - 验证：`npm run test:triage`

**153.** 验证「Off-machine Restore Readiness (can a fresh machine restore khyos?)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Off-machine Restore Readiness (can a fresh machine restore khyos?)。
  - 验证：`npm run test:restore-readiness`

**154.** 验证「Installed-copy Integrity (is the on-disk bundle actually complete?)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Installed-copy Integrity (is the on-disk bundle actually complete?)。
  - 验证：`npm run test:install-integrity`

**155.** 验证「First-run Hydration Health (did the online dependency hydrate actually succeed?)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：First-run Hydration Health (did the online dependency hydrate actually succeed?)。
  - 验证：`npm run test:hydration-health`

**156.** 验证「Proxy Egress Bridge (select node + enable/disable)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Proxy Egress Bridge (select node + enable/disable)。
  - 验证：`npm run test:maintainer:proxy-egress`

**157.** 验证「Proxy Egress Bridge (select node + enable/disable)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Proxy Egress Bridge (select node + enable/disable)。
  - 验证：`npm run build --prefix apps/ai-frontend`


## 四、逐文件理解与补注释

**158.** 阅读「Bootstrap and Packaging」的 platform/khy_platform/cli.py，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Bootstrap and Packaging。读懂再动。
  - 验证：`npm run check:maintainer:bootstrap`

**159.** 阅读「Bootstrap and Packaging」的 platform/khy_platform/_bootstrap.py，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Bootstrap and Packaging。读懂再动。
  - 验证：`npm run check:maintainer:bootstrap`

**160.** 阅读「Bootstrap and Packaging」的 platform/khy_platform/__init__.py，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Bootstrap and Packaging。读懂再动。
  - 验证：`npm run check:maintainer:bootstrap`

**161.** 阅读「Bootstrap and Packaging」的 pyproject.toml，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Bootstrap and Packaging。读懂再动。
  - 验证：`npm run check:maintainer:bootstrap`

**162.** 阅读「Bootstrap and Packaging」的 setup.py，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Bootstrap and Packaging。读懂再动。
  - 验证：`npm run check:maintainer:bootstrap`

**163.** 阅读「Bootstrap and Packaging」的 MANIFEST.in，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Bootstrap and Packaging。读懂再动。
  - 验证：`npm run check:maintainer:bootstrap`

**164.** 阅读「Bootstrap and Packaging」的 packaging/npm/package.json，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Bootstrap and Packaging。读懂再动。
  - 验证：`npm run check:maintainer:bootstrap`

**165.** 阅读「Bootstrap and Packaging」的 services/backend/package.json，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Bootstrap and Packaging。读懂再动。
  - 验证：`npm run check:maintainer:bootstrap`

**166.** 阅读「CLI Routing and Help Surface」的 services/backend/src/constants/commandSchema.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：CLI Routing and Help Surface。读懂再动。
  - 验证：`node --check services/backend/src/constants/commandSchema.js`

**167.** 阅读「CLI Routing and Help Surface」的 services/backend/src/cli/aliases.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：CLI Routing and Help Surface。读懂再动。
  - 验证：`node --check services/backend/src/cli/aliases.js`

**168.** 阅读「CLI Routing and Help Surface」的 services/backend/src/cli/router.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：CLI Routing and Help Surface。读懂再动。
  - 验证：`node --check services/backend/src/cli/router.js`

**169.** 阅读「CLI Routing and Help Surface」的 services/backend/src/cli/repl.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：CLI Routing and Help Surface。读懂再动。
  - 验证：`node --check services/backend/src/cli/repl.js`

**170.** 阅读「CLI Routing and Help Surface」的 services/backend/src/cli/handlers，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：CLI Routing and Help Surface。读懂再动。
  - 验证：`npm run test:maintainer:cli-routing`

**171.** 阅读「CLI Routing and Help Surface」的 services/backend/tests/cli/router.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：CLI Routing and Help Surface。读懂再动。
  - 验证：`node --check services/backend/tests/cli/router.test.js`

**172.** 阅读「CLI Routing and Help Surface」的 services/backend/tests/cli/repl.tasks.interaction.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：CLI Routing and Help Surface。读懂再动。
  - 验证：`node --check services/backend/tests/cli/repl.tasks.interaction.test.js`

**173.** 阅读「Prompt Capsule and Debug Prompt System」的 services/backend/src/constants/prompts.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Prompt Capsule and Debug Prompt System。读懂再动。
  - 验证：`node --check services/backend/src/constants/prompts.js`

**174.** 阅读「Prompt Capsule and Debug Prompt System」的 services/backend/src/services/khyUpgradeRuntime.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Prompt Capsule and Debug Prompt System。读懂再动。
  - 验证：`node --check services/backend/src/services/khyUpgradeRuntime.js`

**175.** 阅读「Prompt Capsule and Debug Prompt System」的 services/backend/src/services/compact/prompt.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Prompt Capsule and Debug Prompt System。读懂再动。
  - 验证：`node --check services/backend/src/services/compact/prompt.js`

**176.** 阅读「Prompt Capsule and Debug Prompt System」的 services/backend/src/cli/handlers/gateway.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Prompt Capsule and Debug Prompt System。读懂再动。
  - 验证：`node --check services/backend/src/cli/handlers/gateway.js`

**177.** 阅读「Prompt Capsule and Debug Prompt System」的 services/backend/tests/promptOnDemandSections.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Prompt Capsule and Debug Prompt System。读懂再动。
  - 验证：`node --check services/backend/tests/promptOnDemandSections.test.js`

**178.** 阅读「Prompt Capsule and Debug Prompt System」的 services/backend/tests/promptLearningRules.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Prompt Capsule and Debug Prompt System。读懂再动。
  - 验证：`node --check services/backend/tests/promptLearningRules.test.js`

**179.** 阅读「Prompt Capsule and Debug Prompt System」的 services/backend/tests/gatewayDebugPrompt.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Prompt Capsule and Debug Prompt System。读懂再动。
  - 验证：`node --check services/backend/tests/gatewayDebugPrompt.test.js`

**180.** 阅读「AI Gateway and Adapter Layer」的 services/backend/src/services/gateway/aiGateway.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：AI Gateway and Adapter Layer。读懂再动。
  - 验证：`node --check services/backend/src/services/gateway/aiGateway.js`

**181.** 阅读「AI Gateway and Adapter Layer」的 services/backend/src/services/gateway/adapters，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：AI Gateway and Adapter Layer。读懂再动。
  - 验证：`npm run test:maintainer:gateway`

**182.** 阅读「AI Gateway and Adapter Layer」的 services/backend/src/services/gateway/proxyServer.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：AI Gateway and Adapter Layer。读懂再动。
  - 验证：`node --check services/backend/src/services/gateway/proxyServer.js`

**183.** 阅读「AI Gateway and Adapter Layer」的 services/backend/tests/aiGateway.stability.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：AI Gateway and Adapter Layer。读懂再动。
  - 验证：`node --check services/backend/tests/aiGateway.stability.test.js`

**184.** 阅读「AI Gateway and Adapter Layer」的 services/backend/tests/gateway/transportResilience.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：AI Gateway and Adapter Layer。读懂再动。
  - 验证：`node --check services/backend/tests/gateway/transportResilience.test.js`

**185.** 阅读「AI Gateway and Adapter Layer」的 services/backend/tests/gatewayAdapters.stability.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：AI Gateway and Adapter Layer。读懂再动。
  - 验证：`node --check services/backend/tests/gatewayAdapters.stability.test.js`

**186.** 阅读「Proxy, Daemon, and Runtime Port Discovery」的 services/backend/src/services/daemonManager.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Proxy, Daemon, and Runtime Port Discovery。读懂再动。
  - 验证：`node --check services/backend/src/services/daemonManager.js`

**187.** 阅读「Proxy, Daemon, and Runtime Port Discovery」的 services/backend/src/services/aiManagementServer.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Proxy, Daemon, and Runtime Port Discovery。读懂再动。
  - 验证：`node --check services/backend/src/services/aiManagementServer.js`

**188.** 阅读「Proxy, Daemon, and Runtime Port Discovery」的 services/backend/src/services/gateway/proxyServer.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Proxy, Daemon, and Runtime Port Discovery。读懂再动。
  - 验证：`node --check services/backend/src/services/gateway/proxyServer.js`

**189.** 阅读「Proxy, Daemon, and Runtime Port Discovery」的 services/backend/src/utils/proxyBaseUrl.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Proxy, Daemon, and Runtime Port Discovery。读懂再动。
  - 验证：`node --check services/backend/src/utils/proxyBaseUrl.js`

**190.** 阅读「Proxy, Daemon, and Runtime Port Discovery」的 services/backend/src/constants/serviceDefaults.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Proxy, Daemon, and Runtime Port Discovery。读懂再动。
  - 验证：`node --check services/backend/src/constants/serviceDefaults.js`

**191.** 阅读「Proxy, Daemon, and Runtime Port Discovery」的 services/backend/tests/daemonManager.runtimePort.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Proxy, Daemon, and Runtime Port Discovery。读懂再动。
  - 验证：`node --check services/backend/tests/daemonManager.runtimePort.test.js`

**192.** 阅读「Proxy, Daemon, and Runtime Port Discovery」的 services/backend/tests/gatewayManage.portDrift.integration.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Proxy, Daemon, and Runtime Port Discovery。读懂再动。
  - 验证：`node --check services/backend/tests/gatewayManage.portDrift.integration.test.js`

**193.** 阅读「Proxy, Daemon, and Runtime Port Discovery」的 services/backend/tests/services/proxyBaseUrl.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Proxy, Daemon, and Runtime Port Discovery。读懂再动。
  - 验证：`node --check services/backend/tests/services/proxyBaseUrl.test.js`

**194.** 阅读「Proxy, Daemon, and Runtime Port Discovery」的 services/backend/tests/services/serviceDefaults.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Proxy, Daemon, and Runtime Port Discovery。读懂再动。
  - 验证：`node --check services/backend/tests/services/serviceDefaults.test.js`

**195.** 阅读「AI Management UI and API」的 services/backend/src/routes/aiGatewayAdmin.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：AI Management UI and API。读懂再动。
  - 验证：`node --check services/backend/src/routes/aiGatewayAdmin.js`

**196.** 阅读「AI Management UI and API」的 services/ai-backend/src/routes/aiGatewayAdmin.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：AI Management UI and API。读懂再动。
  - 验证：`node --check services/ai-backend/src/routes/aiGatewayAdmin.js`

**197.** 阅读「AI Management UI and API」的 apps/ai-frontend/src，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：AI Management UI and API。读懂再动。
  - 验证：`npm run test:maintainer:ai-management`

**198.** 阅读「AI Management UI and API」的 apps/ai-frontend/package.json，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：AI Management UI and API。读懂再动。
  - 验证：`npm run test:maintainer:ai-management`

**199.** 阅读「AI Management UI and API」的 apps/ai-frontend/vite.config.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：AI Management UI and API。读懂再动。
  - 验证：`node --check apps/ai-frontend/vite.config.js`

**200.** 阅读「AI Management UI and API」的 services/backend/src/cli/handlers/gateway.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：AI Management UI and API。读懂再动。
  - 验证：`node --check services/backend/src/cli/handlers/gateway.js`

**201.** 阅读「AI Management UI and API」的 services/backend/tests/routes/aiGatewayAdmin.modelSlots.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：AI Management UI and API。读懂再动。
  - 验证：`node --check services/backend/tests/routes/aiGatewayAdmin.modelSlots.test.js`

**202.** 阅读「AI Management UI and API」的 services/backend/tests/gatewayManage.apiDisplay.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：AI Management UI and API。读懂再动。
  - 验证：`node --check services/backend/tests/gatewayManage.apiDisplay.test.js`

**203.** 阅读「Coding Projects (named workspaces + chat linkage)」的 platform/packages/shared/src/models/UserProject.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。读懂再动。
  - 验证：`node --check platform/packages/shared/src/models/UserProject.js`

**204.** 阅读「Coding Projects (named workspaces + chat linkage)」的 platform/packages/shared/src/models/index.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。读懂再动。
  - 验证：`node --check platform/packages/shared/src/models/index.js`

**205.** 阅读「Coding Projects (named workspaces + chat linkage)」的 services/backend/src/services/projectStore.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。读懂再动。
  - 验证：`node --check services/backend/src/services/projectStore.js`

**206.** 阅读「Coding Projects (named workspaces + chat linkage)」的 services/backend/src/services/aiManagementProjects.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。读懂再动。
  - 验证：`node --check services/backend/src/services/aiManagementProjects.js`

**207.** 阅读「Coding Projects (named workspaces + chat linkage)」的 services/backend/src/services/aiManagementServer.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。读懂再动。
  - 验证：`node --check services/backend/src/services/aiManagementServer.js`

**208.** 阅读「Coding Projects (named workspaces + chat linkage)」的 platform/packages/shared/src/models/Conversation.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。读懂再动。
  - 验证：`node --check platform/packages/shared/src/models/Conversation.js`

**209.** 阅读「Coding Projects (named workspaces + chat linkage)」的 services/backend/src/services/conversationStore.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。读懂再动。
  - 验证：`node --check services/backend/src/services/conversationStore.js`

**210.** 阅读「Coding Projects (named workspaces + chat linkage)」的 apps/ai-frontend/src/composables/useProjects.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。读懂再动。
  - 验证：`node --check apps/ai-frontend/src/composables/useProjects.js`

**211.** 阅读「Coding Projects (named workspaces + chat linkage)」的 apps/ai-frontend/src/composables/useChatConversations.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。读懂再动。
  - 验证：`node --check apps/ai-frontend/src/composables/useChatConversations.js`

**212.** 阅读「Coding Projects (named workspaces + chat linkage)」的 apps/ai-frontend/src/views/Projects.vue，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。读懂再动。
  - 验证：`npm run test:maintainer:projects`

**213.** 阅读「Coding Projects (named workspaces + chat linkage)」的 apps/ai-frontend/src/views/AIChat.vue，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。读懂再动。
  - 验证：`npm run test:maintainer:projects`

**214.** 阅读「Coding Projects (named workspaces + chat linkage)」的 apps/ai-frontend/src/composables/useRoutePrefetch.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。读懂再动。
  - 验证：`node --check apps/ai-frontend/src/composables/useRoutePrefetch.js`

**215.** 阅读「Coding Projects (named workspaces + chat linkage)」的 apps/ai-frontend/src/router/index.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。读懂再动。
  - 验证：`node --check apps/ai-frontend/src/router/index.js`

**216.** 阅读「Coding Projects (named workspaces + chat linkage)」的 apps/ai-frontend/src/views/Layout.vue，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。读懂再动。
  - 验证：`npm run test:maintainer:projects`

**217.** 阅读「Coding Projects (named workspaces + chat linkage)」的 services/backend/tests/projectStore.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。读懂再动。
  - 验证：`node --check services/backend/tests/projectStore.test.js`

**218.** 阅读「Coding Projects (named workspaces + chat linkage)」的 apps/ai-frontend/src/composables/useProjects.wiring.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。读懂再动。
  - 验证：`node --check apps/ai-frontend/src/composables/useProjects.wiring.test.js`

**219.** 阅读「Workspace, Publish, and Verification Commands」的 services/backend/src/cli/handlers/workspace.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Workspace, Publish, and Verification Commands。读懂再动。
  - 验证：`node --check services/backend/src/cli/handlers/workspace.js`

**220.** 阅读「Workspace, Publish, and Verification Commands」的 services/backend/src/cli/handlers/publish.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Workspace, Publish, and Verification Commands。读懂再动。
  - 验证：`node --check services/backend/src/cli/handlers/publish.js`

**221.** 阅读「Workspace, Publish, and Verification Commands」的 services/backend/src/cli/handlers/verify.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Workspace, Publish, and Verification Commands。读懂再动。
  - 验证：`node --check services/backend/src/cli/handlers/verify.js`

**222.** 阅读「Workspace, Publish, and Verification Commands」的 services/backend/tests/publish.sourceReleaseMode.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Workspace, Publish, and Verification Commands。读懂再动。
  - 验证：`node --check services/backend/tests/publish.sourceReleaseMode.test.js`

**223.** 阅读「Workspace, Publish, and Verification Commands」的 services/backend/tests/publish.dbPreflight.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Workspace, Publish, and Verification Commands。读懂再动。
  - 验证：`node --check services/backend/tests/publish.dbPreflight.test.js`

**224.** 阅读「Maintenance Safety and Rule Gates」的 AGENTS.md，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Maintenance Safety and Rule Gates。读懂再动。
  - 验证：`npm run check:maintainer:safety`

**225.** 阅读「Maintenance Safety and Rule Gates」的 CONTRIBUTING.md，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Maintenance Safety and Rule Gates。读懂再动。
  - 验证：`npm run check:maintainer:safety`

**226.** 阅读「Maintenance Safety and Rule Gates」的 scripts/check-agent-rules.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Maintenance Safety and Rule Gates。读懂再动。
  - 验证：`node --check scripts/check-agent-rules.js`

**227.** 阅读「Maintenance Safety and Rule Gates」的 scripts/check-change-safety.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Maintenance Safety and Rule Gates。读懂再动。
  - 验证：`node --check scripts/check-change-safety.js`

**228.** 阅读「Maintenance Safety and Rule Gates」的 scripts/install-git-hooks.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Maintenance Safety and Rule Gates。读懂再动。
  - 验证：`node --check scripts/install-git-hooks.js`

**229.** 阅读「Maintenance Safety and Rule Gates」的 scripts/ci/check-version-sync.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Maintenance Safety and Rule Gates。读懂再动。
  - 验证：`node --check scripts/ci/check-version-sync.js`

**230.** 阅读「Maintenance Safety and Rule Gates」的 scripts/ci/check-node-syntax.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Maintenance Safety and Rule Gates。读懂再动。
  - 验证：`node --check scripts/ci/check-node-syntax.js`

**231.** 阅读「Maintenance Safety and Rule Gates」的 scripts/ci/check-python-syntax.py，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Maintenance Safety and Rule Gates。读懂再动。
  - 验证：`npm run check:maintainer:safety`

**232.** 阅读「Maintenance Safety and Rule Gates」的 docs/维护者/维护映射表.json，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Maintenance Safety and Rule Gates。读懂再动。
  - 验证：`npm run check:maintainer:safety`

**233.** 阅读「Release and Rollback」的 maintenance/stable-release.json，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Release and Rollback。读懂再动。
  - 验证：`node --test maintenance/tests/ops-lib.test.js maintenance/tests/ops.integration.test.js`

**234.** 阅读「Release and Rollback」的 maintenance/lib/ops.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Release and Rollback。读懂再动。
  - 验证：`node --check maintenance/lib/ops.js`

**235.** 阅读「Release and Rollback」的 maintenance/lib/ops-lib.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Release and Rollback。读懂再动。
  - 验证：`node --check maintenance/lib/ops-lib.js`

**236.** 阅读「Release and Rollback」的 services/backend/src/cli/handlers/publish.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Release and Rollback。读懂再动。
  - 验证：`node --check services/backend/src/cli/handlers/publish.js`

**237.** 阅读「Release and Rollback」的 scripts/release/build-and-audit-pip-purity.sh，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Release and Rollback。读懂再动。
  - 验证：`node --test maintenance/tests/ops-lib.test.js maintenance/tests/ops.integration.test.js`

**238.** 阅读「Release and Rollback」的 scripts/ci/check-version-sync.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Release and Rollback。读懂再动。
  - 验证：`node --check scripts/ci/check-version-sync.js`

**239.** 阅读「Release and Rollback」的 maintenance/tests/ops-lib.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Release and Rollback。读懂再动。
  - 验证：`node --check maintenance/tests/ops-lib.test.js`

**240.** 阅读「Build Best Environment (Self-check / Repair / Probes)」的 services/backend/src/services/localBrainEnvOptimize.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Build Best Environment (Self-check / Repair / Probes)。读懂再动。
  - 验证：`node --check services/backend/src/services/localBrainEnvOptimize.js`

**241.** 阅读「Build Best Environment (Self-check / Repair / Probes)」的 services/backend/src/services/envProbes.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Build Best Environment (Self-check / Repair / Probes)。读懂再动。
  - 验证：`node --check services/backend/src/services/envProbes.js`

**242.** 阅读「Build Best Environment (Self-check / Repair / Probes)」的 services/backend/src/services/envRepair.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Build Best Environment (Self-check / Repair / Probes)。读懂再动。
  - 验证：`node --check services/backend/src/services/envRepair.js`

**243.** 阅读「Build Best Environment (Self-check / Repair / Probes)」的 services/backend/src/services/envPlatform.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Build Best Environment (Self-check / Repair / Probes)。读懂再动。
  - 验证：`node --check services/backend/src/services/envPlatform.js`

**244.** 阅读「Build Best Environment (Self-check / Repair / Probes)」的 services/backend/src/services/diskCleanup，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Build Best Environment (Self-check / Repair / Probes)。读懂再动。
  - 验证：`npm run test:maintainer:env-optimize`

**245.** 阅读「Build Best Environment (Self-check / Repair / Probes)」的 services/backend/src/services/localBrainService.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Build Best Environment (Self-check / Repair / Probes)。读懂再动。
  - 验证：`node --check services/backend/src/services/localBrainService.js`

**246.** 阅读「Build Best Environment (Self-check / Repair / Probes)」的 services/backend/src/cli/tui/hooks/useQueryBridge.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Build Best Environment (Self-check / Repair / Probes)。读懂再动。
  - 验证：`node --check services/backend/src/cli/tui/hooks/useQueryBridge.js`

**247.** 阅读「Build Best Environment (Self-check / Repair / Probes)」的 services/backend/tests/services/localBrainEnvOptimize.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Build Best Environment (Self-check / Repair / Probes)。读懂再动。
  - 验证：`node --check services/backend/tests/services/localBrainEnvOptimize.test.js`

**248.** 阅读「Build Best Environment (Self-check / Repair / Probes)」的 services/backend/tests/services/envProbes.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Build Best Environment (Self-check / Repair / Probes)。读懂再动。
  - 验证：`node --check services/backend/tests/services/envProbes.test.js`

**249.** 阅读「Build Best Environment (Self-check / Repair / Probes)」的 services/backend/tests/services/envRepair.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Build Best Environment (Self-check / Repair / Probes)。读懂再动。
  - 验证：`node --check services/backend/tests/services/envRepair.test.js`

**250.** 阅读「Build Best Environment (Self-check / Repair / Probes)」的 services/backend/tests/services/envPlatform.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Build Best Environment (Self-check / Repair / Probes)。读懂再动。
  - 验证：`node --check services/backend/tests/services/envPlatform.test.js`

**251.** 阅读「Evolution Prompt Playbook (1000 preset prompts)」的 scripts/docs/gen-evolution-prompts.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Evolution Prompt Playbook (1000 preset prompts)。读懂再动。
  - 验证：`node --check scripts/docs/gen-evolution-prompts.js`

**252.** 阅读「Evolution Prompt Playbook (1000 preset prompts)」的 scripts/tests/gen-evolution-prompts.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Evolution Prompt Playbook (1000 preset prompts)。读懂再动。
  - 验证：`node --check scripts/tests/gen-evolution-prompts.test.js`

**253.** 阅读「Evolution Prompt Playbook (1000 preset prompts)」的 docs/维护者/维护映射表.json，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Evolution Prompt Playbook (1000 preset prompts)。读懂再动。
  - 验证：`npm run test:evolution-prompts`

**254.** 阅读「Symptom Triage (route a symptom to its subsystem)」的 scripts/lib/maintainerTriage.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Symptom Triage (route a symptom to its subsystem)。读懂再动。
  - 验证：`node --check scripts/lib/maintainerTriage.js`

**255.** 阅读「Symptom Triage (route a symptom to its subsystem)」的 scripts/triage.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Symptom Triage (route a symptom to its subsystem)。读懂再动。
  - 验证：`node --check scripts/triage.js`

**256.** 阅读「Symptom Triage (route a symptom to its subsystem)」的 scripts/tests/maintainerTriage.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Symptom Triage (route a symptom to its subsystem)。读懂再动。
  - 验证：`node --check scripts/tests/maintainerTriage.test.js`

**257.** 阅读「Symptom Triage (route a symptom to its subsystem)」的 docs/维护者/维护映射表.json，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Symptom Triage (route a symptom to its subsystem)。读懂再动。
  - 验证：`npm run test:triage`

**258.** 阅读「Off-machine Restore Readiness (can a fresh machine restore khyos?)」的 scripts/lib/restoreReadiness.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Off-machine Restore Readiness (can a fresh machine restore khyos?)。读懂再动。
  - 验证：`node --check scripts/lib/restoreReadiness.js`

**259.** 阅读「Off-machine Restore Readiness (can a fresh machine restore khyos?)」的 scripts/restore-check.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Off-machine Restore Readiness (can a fresh machine restore khyos?)。读懂再动。
  - 验证：`node --check scripts/restore-check.js`

**260.** 阅读「Off-machine Restore Readiness (can a fresh machine restore khyos?)」的 scripts/tests/restoreReadiness.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Off-machine Restore Readiness (can a fresh machine restore khyos?)。读懂再动。
  - 验证：`node --check scripts/tests/restoreReadiness.test.js`

**261.** 阅读「Installed-copy Integrity (is the on-disk bundle actually complete?)」的 scripts/lib/installIntegrity.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Installed-copy Integrity (is the on-disk bundle actually complete?)。读懂再动。
  - 验证：`node --check scripts/lib/installIntegrity.js`

**262.** 阅读「Installed-copy Integrity (is the on-disk bundle actually complete?)」的 scripts/verify-install.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Installed-copy Integrity (is the on-disk bundle actually complete?)。读懂再动。
  - 验证：`node --check scripts/verify-install.js`

**263.** 阅读「Installed-copy Integrity (is the on-disk bundle actually complete?)」的 scripts/tests/installIntegrity.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Installed-copy Integrity (is the on-disk bundle actually complete?)。读懂再动。
  - 验证：`node --check scripts/tests/installIntegrity.test.js`

**264.** 阅读「First-run Hydration Health (did the online dependency hydrate actually succeed?)」的 scripts/lib/hydrationHealth.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：First-run Hydration Health (did the online dependency hydrate actually succeed?)。读懂再动。
  - 验证：`node --check scripts/lib/hydrationHealth.js`

**265.** 阅读「First-run Hydration Health (did the online dependency hydrate actually succeed?)」的 scripts/hydration-doctor.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：First-run Hydration Health (did the online dependency hydrate actually succeed?)。读懂再动。
  - 验证：`node --check scripts/hydration-doctor.js`

**266.** 阅读「First-run Hydration Health (did the online dependency hydrate actually succeed?)」的 scripts/tests/hydrationHealth.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：First-run Hydration Health (did the online dependency hydrate actually succeed?)。读懂再动。
  - 验证：`node --check scripts/tests/hydrationHealth.test.js`

**267.** 阅读「Proxy Egress Bridge (select node + enable/disable)」的 services/backend/src/services/proxy/proxyCoreConfigGen.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Proxy Egress Bridge (select node + enable/disable)。读懂再动。
  - 验证：`node --check services/backend/src/services/proxy/proxyCoreConfigGen.js`

**268.** 阅读「Proxy Egress Bridge (select node + enable/disable)」的 services/backend/src/services/proxy/proxyCoreManager.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Proxy Egress Bridge (select node + enable/disable)。读懂再动。
  - 验证：`node --check services/backend/src/services/proxy/proxyCoreManager.js`

**269.** 阅读「Proxy Egress Bridge (select node + enable/disable)」的 services/backend/src/services/proxyConfigService.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Proxy Egress Bridge (select node + enable/disable)。读懂再动。
  - 验证：`node --check services/backend/src/services/proxyConfigService.js`

**270.** 阅读「Proxy Egress Bridge (select node + enable/disable)」的 services/backend/src/services/aiManagementProxyEgress.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Proxy Egress Bridge (select node + enable/disable)。读懂再动。
  - 验证：`node --check services/backend/src/services/aiManagementProxyEgress.js`

**271.** 阅读「Proxy Egress Bridge (select node + enable/disable)」的 services/backend/src/services/aiManagementServer.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Proxy Egress Bridge (select node + enable/disable)。读懂再动。
  - 验证：`node --check services/backend/src/services/aiManagementServer.js`

**272.** 阅读「Proxy Egress Bridge (select node + enable/disable)」的 apps/ai-frontend/src/composables/useProxies.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Proxy Egress Bridge (select node + enable/disable)。读懂再动。
  - 验证：`node --check apps/ai-frontend/src/composables/useProxies.js`

**273.** 阅读「Proxy Egress Bridge (select node + enable/disable)」的 apps/ai-frontend/src/views/ProxyManagement.vue，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Proxy Egress Bridge (select node + enable/disable)。读懂再动。
  - 验证：`npm run test:maintainer:proxy-egress`

**274.** 阅读「Proxy Egress Bridge (select node + enable/disable)」的 services/backend/tests/proxyCoreConfigGen.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Proxy Egress Bridge (select node + enable/disable)。读懂再动。
  - 验证：`node --check services/backend/tests/proxyCoreConfigGen.test.js`

**275.** 阅读「Proxy Egress Bridge (select node + enable/disable)」的 services/backend/tests/proxyCoreManager.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Proxy Egress Bridge (select node + enable/disable)。读懂再动。
  - 验证：`node --check services/backend/tests/proxyCoreManager.test.js`

**276.** 阅读「Proxy Egress Bridge (select node + enable/disable)」的 services/backend/tests/proxyConfigService.egress.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Proxy Egress Bridge (select node + enable/disable)。读懂再动。
  - 验证：`node --check services/backend/tests/proxyConfigService.egress.test.js`

**277.** 阅读「Proxy Egress Bridge (select node + enable/disable)」的 services/backend/tests/aiManagementProxyEgress.wiring.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Proxy Egress Bridge (select node + enable/disable)。读懂再动。
  - 验证：`node --check services/backend/tests/aiManagementProxyEgress.wiring.test.js`

**278.** 阅读「Proxy Egress Bridge (select node + enable/disable)」的 apps/ai-frontend/src/composables/useProxies.egress.wiring.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Proxy Egress Bridge (select node + enable/disable)。读懂再动。
  - 验证：`node --check apps/ai-frontend/src/composables/useProxies.egress.wiring.test.js`

**279.** 阅读「斜杠命令菜单单一真源(经典REPL⇄TUI)」的 services/backend/src/cli/slashExtraCommands.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：斜杠命令菜单单一真源(经典REPL⇄TUI)。读懂再动。
  - 验证：`node --check services/backend/src/cli/slashExtraCommands.js`

**280.** 阅读「斜杠命令菜单单一真源(经典REPL⇄TUI)」的 services/backend/src/cli/resumeHint.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：斜杠命令菜单单一真源(经典REPL⇄TUI)。读懂再动。
  - 验证：`node --check services/backend/src/cli/resumeHint.js`

**281.** 阅读「斜杠命令菜单单一真源(经典REPL⇄TUI)」的 services/backend/src/cli/replSession.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：斜杠命令菜单单一真源(经典REPL⇄TUI)。读懂再动。
  - 验证：`node --check services/backend/src/cli/replSession.js`

**282.** 阅读「斜杠命令菜单单一真源(经典REPL⇄TUI)」的 services/backend/src/cli/tui/hooks/useCompletions.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：斜杠命令菜单单一真源(经典REPL⇄TUI)。读懂再动。
  - 验证：`node --check services/backend/src/cli/tui/hooks/useCompletions.js`

**283.** 阅读「斜杠命令菜单单一真源(经典REPL⇄TUI)」的 services/backend/src/cli/tui/app.jsx，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：斜杠命令菜单单一真源(经典REPL⇄TUI)。读懂再动。
  - 验证：`npm run maintainer:check`

**284.** 阅读「斜杠命令菜单单一真源(经典REPL⇄TUI)」的 services/backend/tests/slashExtraCommands.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：斜杠命令菜单单一真源(经典REPL⇄TUI)。读懂再动。
  - 验证：`node --check services/backend/tests/slashExtraCommands.test.js`

**285.** 阅读「斜杠命令菜单单一真源(经典REPL⇄TUI)」的 services/backend/tests/cli/resumeHint.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：斜杠命令菜单单一真源(经典REPL⇄TUI)。读懂再动。
  - 验证：`node --check services/backend/tests/cli/resumeHint.test.js`

**286.** 阅读「斜杠命令菜单单一真源(经典REPL⇄TUI)」的 services/backend/tests/cli/useCompletionsSlashExtras.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：斜杠命令菜单单一真源(经典REPL⇄TUI)。读懂再动。
  - 验证：`node --check services/backend/tests/cli/useCompletionsSlashExtras.test.js`

**287.** 阅读「前端响应信封解包单一真源(unwrap)」的 apps/ai-frontend/src/api/unwrap.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：前端响应信封解包单一真源(unwrap)。读懂再动。
  - 验证：`node --check apps/ai-frontend/src/api/unwrap.js`

**288.** 阅读「前端响应信封解包单一真源(unwrap)」的 apps/ai-frontend/src/api/unwrap.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：前端响应信封解包单一真源(unwrap)。读懂再动。
  - 验证：`node --check apps/ai-frontend/src/api/unwrap.test.js`

**289.** 阅读「前端响应信封解包单一真源(unwrap)」的 apps/ai-frontend/src/api/unwrap.wiring.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：前端响应信封解包单一真源(unwrap)。读懂再动。
  - 验证：`node --check apps/ai-frontend/src/api/unwrap.wiring.test.js`

**290.** 阅读「khy codex 凭据便捷管理(与 claude 一样启动)」的 services/backend/src/services/gateway/adapters/codexEnvAdoptPolicy.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：khy codex 凭据便捷管理(与 claude 一样启动)。读懂再动。
  - 验证：`node --check services/backend/src/services/gateway/adapters/codexEnvAdoptPolicy.js`

**291.** 阅读「khy codex 凭据便捷管理(与 claude 一样启动)」的 services/backend/src/services/gateway/adapters/openaiRelayPresets.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：khy codex 凭据便捷管理(与 claude 一样启动)。读懂再动。
  - 验证：`node --check services/backend/src/services/gateway/adapters/openaiRelayPresets.js`

**292.** 阅读「khy codex 凭据便捷管理(与 claude 一样启动)」的 services/backend/src/cli/handlers/codexAdopt.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：khy codex 凭据便捷管理(与 claude 一样启动)。读懂再动。
  - 验证：`node --check services/backend/src/cli/handlers/codexAdopt.js`

**293.** 阅读「khy codex 凭据便捷管理(与 claude 一样启动)」的 services/backend/src/cli/router.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：khy codex 凭据便捷管理(与 claude 一样启动)。读懂再动。
  - 验证：`node --check services/backend/src/cli/router.js`

**294.** 阅读「khy codex 凭据便捷管理(与 claude 一样启动)」的 services/backend/tests/services/gateway/codexEnvAdoptPolicy.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：khy codex 凭据便捷管理(与 claude 一样启动)。读懂再动。
  - 验证：`node --check services/backend/tests/services/gateway/codexEnvAdoptPolicy.test.js`

**295.** 阅读「khy codex 凭据便捷管理(与 claude 一样启动)」的 services/backend/tests/services/gateway/openaiRelayPresets.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：khy codex 凭据便捷管理(与 claude 一样启动)。读懂再动。
  - 验证：`node --check services/backend/tests/services/gateway/openaiRelayPresets.test.js`

**296.** 阅读「khy codex 凭据便捷管理(与 claude 一样启动)」的 services/backend/tests/cli/codexAdoptRouting.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：khy codex 凭据便捷管理(与 claude 一样启动)。读懂再动。
  - 验证：`node --check services/backend/tests/cli/codexAdoptRouting.test.js`

**297.** 阅读「AI 失败诊断质量(真实失败原因排序 + model_not_found 形状分诊)」的 services/backend/src/services/gateway/failureReasonRanking.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：AI 失败诊断质量(真实失败原因排序 + model_not_found 形状分诊)。读懂再动。
  - 验证：`node --check services/backend/src/services/gateway/failureReasonRanking.js`

**298.** 阅读「AI 失败诊断质量(真实失败原因排序 + model_not_found 形状分诊)」的 services/backend/src/services/gateway/modelNotFoundRecovery.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：AI 失败诊断质量(真实失败原因排序 + model_not_found 形状分诊)。读懂再动。
  - 验证：`node --check services/backend/src/services/gateway/modelNotFoundRecovery.js`

**299.** 阅读「AI 失败诊断质量(真实失败原因排序 + model_not_found 形状分诊)」的 services/backend/src/services/gateway/aiGateway.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：AI 失败诊断质量(真实失败原因排序 + model_not_found 形状分诊)。读懂再动。
  - 验证：`node --check services/backend/src/services/gateway/aiGateway.js`

**300.** 阅读「AI 失败诊断质量(真实失败原因排序 + model_not_found 形状分诊)」的 services/backend/tests/services/gateway/failureReasonRanking.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：AI 失败诊断质量(真实失败原因排序 + model_not_found 形状分诊)。读懂再动。
  - 验证：`node --check services/backend/tests/services/gateway/failureReasonRanking.test.js`

**301.** 阅读「AI 失败诊断质量(真实失败原因排序 + model_not_found 形状分诊)」的 services/backend/tests/services/gateway/modelNotFoundRecovery.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：AI 失败诊断质量(真实失败原因排序 + model_not_found 形状分诊)。读懂再动。
  - 验证：`node --check services/backend/tests/services/gateway/modelNotFoundRecovery.test.js`


## 五、进化配方（每个子系统都照做一遍）

**302.** 为「Bootstrap and Packaging」增加一个 flag 门控的纯叶子：零 IO、绝不抛异常，先在 flagRegistry 登记 KHY_* 门再接线。
  - 说明：新能力走门控叶子。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:flag-registry`

**303.** 为「Bootstrap and Packaging」补一条 node:test，至少覆盖：正常路径、一个边界、一个畸形/空输入。
  - 说明：补测试。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:maintainer:bootstrap`

**304.** 通读「Bootstrap and Packaging」核心文件，在顶部一句话写清职责，并给最难懂的分支补一句注释（不改行为）。
  - 说明：补可读性。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:maintainer:bootstrap`

**305.** 扫描「Bootstrap and Packaging」是否有文件超 2500 行；若有，按同名 re-export + DI 抽一个聚焦叶子，保字节等价。
  - 说明：拆上帝文件。 子系统：Bootstrap and Packaging。
  - 验证：`npm run arch:god`

**306.** 给「Bootstrap and Packaging」的注册表叶子（_PROBES/_REPAIRS 之类）上方补 4 步 HOW-TO-EXTEND 抄写式注释。
  - 说明：注册表可扩展。 子系统：Bootstrap and Packaging。
  - 验证：`npm run maintainer:check`

**307.** 把「Bootstrap and Packaging」中每轮/每请求重复构建的 Set/正则/常量提升为模块常量（参考书 Ch2）。
  - 说明：别每轮重建。 子系统：Bootstrap and Packaging。
  - 验证：`npm run arch:god`

**308.** 为「Bootstrap and Packaging」增加一个只读诊断探针：只观测不修改，绝不写盘、绝不发网络。
  - 说明：加只读探针。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:maintainer:bootstrap`

**309.** 为「Bootstrap and Packaging」增加一个「仅创建缺失项」的安全自愈：幂等、fail-soft、遇损坏拒删交人工。
  - 说明：加安全修复。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:maintainer:bootstrap`

**310.** 给「Bootstrap and Packaging」的失败路径补一条指名道姓的可执行指引，把错误码翻译成用户能照做的步骤。
  - 说明：错误可执行。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:maintainer:bootstrap`

**311.** 核对「Bootstrap and Packaging」的 verify 命令仍能一键复现绿灯；若命令漂移就修 package.json 别名。
  - 说明：verify 不漂移。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:maintainer:bootstrap`

**312.** 为「Bootstrap and Packaging」新增功能前先在 flagRegistry 登记开关，并确认父门链正确（父关则子必关）。
  - 说明：门先登记。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:flag-registry`

**313.** 为「Bootstrap and Packaging」的输入做防御式校验：null/undefined/空数组/超长都有明确且安全的默认行为。
  - 说明：防御式输入。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:maintainer:bootstrap`

**314.** 给「Bootstrap and Packaging」的外部调用加超时与失败兜底，任何一路挂了都 fail-soft 而不是整体崩。
  - 说明：失败兜底。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:maintainer:bootstrap`

**315.** 为「Bootstrap and Packaging」补一条针对历史 bug 的回归测试，命名写清它守护的是哪个坑。
  - 说明：回归测试。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:maintainer:bootstrap`

**316.** 检查「Bootstrap and Packaging」的日志：敏感值只打印长度不打印明文，绝不把 key/token 落盘或进日志。
  - 说明：日志脱敏。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:model-hardcoding`

**317.** 为「Bootstrap and Packaging」写一条 golden 测试：把一次已知正确的输出固化，防止未来悄悄漂移。
  - 说明：golden 固化。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:maintainer:bootstrap`

**318.** 为「Bootstrap and Packaging」排查可变状态跨簇共享：若被多处重赋值，抽取时必须用 DI 注入而非复制。
  - 说明：共享态用 DI。 子系统：Bootstrap and Packaging。
  - 验证：`npm run arch:god`

**319.** 为「Bootstrap and Packaging」补一个进程级缓存的测试重置钩子，避免测试间状态串味。
  - 说明：缓存可重置。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:maintainer:bootstrap`

**320.** 把「Bootstrap and Packaging」里散落的模型名/端点字面量收敛到单一权威来源（SSOT 访问器）。
  - 说明：收敛字面量。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:model-hardcoding`

**321.** 为「Bootstrap and Packaging」的公共函数补 JSDoc：写清意图、参数契约、返回值与副作用。
  - 说明：补 JSDoc。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:agent-rules`

**322.** 为「Bootstrap and Packaging」增加空参数补全保护：工具/命令缺关键参数时给出可推断的安全默认。
  - 说明：空参补全。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:maintainer:bootstrap`

**323.** 为「Bootstrap and Packaging」抽取叶子后 grep 每个被调函数，凡叶子调而宿主定义者必迁或 DI。
  - 说明：查死引用。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:leaf-contract`

**324.** 为「Bootstrap and Packaging」写一条场景测试：模拟一个真实用户操作序列，断言端到端结果。
  - 说明：场景测试。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:maintainer:bootstrap`

**325.** 把「Bootstrap and Packaging」里超过三层的嵌套条件重构为早返回（guard clause），降低阅读成本。
  - 说明：早返回。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:change-safety`

**326.** 为「Bootstrap and Packaging」补一条门关字节回退测试：关掉 KHY_* 门后行为逐字节回到改动前。
  - 说明：门关回退。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:flag-registry`

**327.** 给「Bootstrap and Packaging」仅用于匹配的正则去掉全局 g 标志，避免 lastIndex 状态残留。
  - 说明：正则去 g。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:maintainer:bootstrap`

**328.** 为「Bootstrap and Packaging」登记进 docs/维护者/维护映射表.json（whenToUse/paths/docs/verify 齐全）。
  - 说明：登记映射表。 子系统：Bootstrap and Packaging。
  - 验证：`npm run maintainer:check`

**329.** 为「Bootstrap and Packaging」补一句「一句话验证脚本」并并入 test:maintainer:all。
  - 说明：一句话验证。 子系统：Bootstrap and Packaging。
  - 验证：`npm run maintainer:check`

**330.** 检查「Bootstrap and Packaging」的错误信息是否可执行：告诉用户「下一步做什么」而不仅是「哪里错了」。
  - 说明：可执行错误。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:maintainer:bootstrap`

**331.** 为「Bootstrap and Packaging」的关键常量补注释解释「为什么是这个值」（保守高估、上限来源等）。
  - 说明：常量讲来源。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:change-safety`

**332.** 为「Bootstrap and Packaging」增加平台差异白名单（linux/windows/macos/android/ios），差异化规则收在注册表一处。
  - 说明：平台白名单。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:maintainer:bootstrap`

**333.** 为「Bootstrap and Packaging」补一条并发/竞态测试：同一资源被两条路径同时访问时结果仍正确。
  - 说明：并发测试。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:maintainer:bootstrap`

**334.** 把「Bootstrap and Packaging」里手写的重复逻辑抽成一个纯 helper，并给它单测。
  - 说明：抽纯 helper。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:leaf-contract`

**335.** 为「Bootstrap and Packaging」写一条「畸形输入绝不抛」的模糊测试：喂 null/数字/字符串/超大对象都返回安全值。
  - 说明：模糊测试。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:leaf-contract`

**336.** 检查「Bootstrap and Packaging」的默认值是否安全优先：不确定时偏向拒绝/降级而非放行。
  - 说明：安全默认。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:change-safety`

**337.** 为「Bootstrap and Packaging」补一条端点/URL 成形的确定性测试（不发真实请求，只断言拼出的字符串正确）。
  - 说明：URL 成形测试。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:maintainer:bootstrap`

**338.** 为「Bootstrap and Packaging」的每个导出函数确认都有对应测试引用，无孤儿导出。
  - 说明：无孤儿导出。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:leaf-contract`

**339.** 为「Bootstrap and Packaging」增加预算/上限保护：循环或累积有明确终止条件，防止失控。
  - 说明：预算护栏。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:maintainer:bootstrap`

**340.** 把「Bootstrap and Packaging」的巨型 switch 按 case 簇抽子分派器（pre-dispatch + 哨兵 fall-through）。
  - 说明：switch 拆解。 子系统：Bootstrap and Packaging。
  - 验证：`npm run arch:god`

**341.** 为「Bootstrap and Packaging」补一条幂等测试：同一操作跑两次结果一致、无副作用叠加。
  - 说明：幂等测试。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:maintainer:bootstrap`

**342.** 检查「Bootstrap and Packaging」是否遵守单向依赖：叶子不得反向 require 宿主网关，需要就用 IoC 缝。
  - 说明：单向依赖。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:leaf-contract`

**343.** 为「Bootstrap and Packaging」写一份「新维护者一分钟上手」的结构表（文件→职责一行）。
  - 说明：一分钟上手。 子系统：Bootstrap and Packaging。
  - 验证：`npm run maintainer:check`

**344.** 为「Bootstrap and Packaging」的时间相关逻辑改为「时钟由调用方喂入」，让它可离线确定性测试。
  - 说明：时钟可注入。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:maintainer:bootstrap`

**345.** 给「Bootstrap and Packaging」补一条「截断/采样时必须 log 丢了什么」的规则，杜绝静默截断。
  - 说明：别静默截断。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:change-safety`

**346.** 为「Bootstrap and Packaging」增加 dry-run 模式：先展示将要做什么，用户确认后才执行破坏性操作。
  - 说明：dry-run 先行。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:small-model:safety`

**347.** 检查「Bootstrap and Packaging」的 flag 语义：opt-in 严格只认 1/true，default-on 只认关键词才关。
  - 说明：门语义核对。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:flag-registry`

**348.** 为「Bootstrap and Packaging」补一条「父门关闭 → 子功能整体关闭」的门控测试。
  - 说明：父子门控。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:flag-registry`

**349.** 把「Bootstrap and Packaging」里的魔法数字提取为具名常量并注释其单位与来源。
  - 说明：消魔法数。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:change-safety`

**350.** 为「Bootstrap and Packaging」写一条向后兼容测试：旧输入格式仍能被正确解析。
  - 说明：向后兼容。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:maintainer:bootstrap`

**351.** 为「Bootstrap and Packaging」的注册表新增一维时，确认聚合器与格式化器各只改一处（不 smear）。
  - 说明：改动不 smear。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:maintainer:bootstrap`

**352.** 检查「Bootstrap and Packaging」抽取后宿主是否仍持有核心态，叶子只拿它需要的切片。
  - 说明：核心态留宿主。 子系统：Bootstrap and Packaging。
  - 验证：`npm run arch:god`

**353.** 为「Bootstrap and Packaging」补一条跨渠道/双通道一致性测试（如版本号 pip 与 npm 必须一致）。
  - 说明：双通道一致。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:maintainer:bootstrap`

**354.** 为「Bootstrap and Packaging」的用户可见文案统一措辞与语气，避免同义词乱用误导弱模型。
  - 说明：文案统一。 子系统：Bootstrap and Packaging。
  - 验证：`npm run maintainer:check`

**355.** 给「Bootstrap and Packaging」增加一个健康分自检项，纳入 khy doctor 的输出。
  - 说明：并入自检。 子系统：Bootstrap and Packaging。
  - 验证：`khy doctor`

**356.** 为「Bootstrap and Packaging」补一条资源清理测试：临时文件用后即删、句柄关闭、无泄漏。
  - 说明：资源清理。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:maintainer:bootstrap`

**357.** 把「Bootstrap and Packaging」里可能抛的第三方调用全部包进 try/catch 并给结构化 reason。
  - 说明：结构化容错。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:change-safety`

**358.** 为「Bootstrap and Packaging」写一条已知安全边界注释：明确它是 review aid 还是隔离边界，别夸大保证。
  - 说明：诚实边界。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:leaf-contract`

**359.** 为「Bootstrap and Packaging」补一条空结果早退路径：0 命中时跳过昂贵的下游步骤。
  - 说明：空结果早退。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:maintainer:bootstrap`

**360.** 检查「Bootstrap and Packaging」的命令别名是否都路由到正确 handler，补一条 alias 路由测试。
  - 说明：别名路由。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:maintainer:bootstrap`

**361.** 为「Bootstrap and Packaging」建立一条 memory 记录模板，把「为什么这么改」写进传承文档。
  - 说明：沉淀传承。 子系统：Bootstrap and Packaging。
  - 验证：`npm run maintainer:check`

**362.** 为「CLI Routing and Help Surface」增加一个 flag 门控的纯叶子：零 IO、绝不抛异常，先在 flagRegistry 登记 KHY_* 门再接线。
  - 说明：新能力走门控叶子。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run check:flag-registry`

**363.** 为「CLI Routing and Help Surface」补一条 node:test，至少覆盖：正常路径、一个边界、一个畸形/空输入。
  - 说明：补测试。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run test:maintainer:cli-routing`

**364.** 通读「CLI Routing and Help Surface」核心文件，在顶部一句话写清职责，并给最难懂的分支补一句注释（不改行为）。
  - 说明：补可读性。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run test:maintainer:cli-routing`

**365.** 扫描「CLI Routing and Help Surface」是否有文件超 2500 行；若有，按同名 re-export + DI 抽一个聚焦叶子，保字节等价。
  - 说明：拆上帝文件。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run arch:god`

**366.** 给「CLI Routing and Help Surface」的注册表叶子（_PROBES/_REPAIRS 之类）上方补 4 步 HOW-TO-EXTEND 抄写式注释。
  - 说明：注册表可扩展。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run maintainer:check`

**367.** 把「CLI Routing and Help Surface」中每轮/每请求重复构建的 Set/正则/常量提升为模块常量（参考书 Ch2）。
  - 说明：别每轮重建。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run arch:god`

**368.** 为「CLI Routing and Help Surface」增加一个只读诊断探针：只观测不修改，绝不写盘、绝不发网络。
  - 说明：加只读探针。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run test:maintainer:cli-routing`

**369.** 为「CLI Routing and Help Surface」增加一个「仅创建缺失项」的安全自愈：幂等、fail-soft、遇损坏拒删交人工。
  - 说明：加安全修复。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run test:maintainer:cli-routing`

**370.** 给「CLI Routing and Help Surface」的失败路径补一条指名道姓的可执行指引，把错误码翻译成用户能照做的步骤。
  - 说明：错误可执行。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run test:maintainer:cli-routing`

**371.** 核对「CLI Routing and Help Surface」的 verify 命令仍能一键复现绿灯；若命令漂移就修 package.json 别名。
  - 说明：verify 不漂移。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run test:maintainer:cli-routing`

**372.** 为「CLI Routing and Help Surface」新增功能前先在 flagRegistry 登记开关，并确认父门链正确（父关则子必关）。
  - 说明：门先登记。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run check:flag-registry`

**373.** 为「CLI Routing and Help Surface」的输入做防御式校验：null/undefined/空数组/超长都有明确且安全的默认行为。
  - 说明：防御式输入。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run test:maintainer:cli-routing`

**374.** 给「CLI Routing and Help Surface」的外部调用加超时与失败兜底，任何一路挂了都 fail-soft 而不是整体崩。
  - 说明：失败兜底。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run test:maintainer:cli-routing`

**375.** 为「CLI Routing and Help Surface」补一条针对历史 bug 的回归测试，命名写清它守护的是哪个坑。
  - 说明：回归测试。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run test:maintainer:cli-routing`

**376.** 检查「CLI Routing and Help Surface」的日志：敏感值只打印长度不打印明文，绝不把 key/token 落盘或进日志。
  - 说明：日志脱敏。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run check:model-hardcoding`

**377.** 为「CLI Routing and Help Surface」写一条 golden 测试：把一次已知正确的输出固化，防止未来悄悄漂移。
  - 说明：golden 固化。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run test:maintainer:cli-routing`

**378.** 为「CLI Routing and Help Surface」排查可变状态跨簇共享：若被多处重赋值，抽取时必须用 DI 注入而非复制。
  - 说明：共享态用 DI。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run arch:god`

**379.** 为「CLI Routing and Help Surface」补一个进程级缓存的测试重置钩子，避免测试间状态串味。
  - 说明：缓存可重置。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run test:maintainer:cli-routing`

**380.** 把「CLI Routing and Help Surface」里散落的模型名/端点字面量收敛到单一权威来源（SSOT 访问器）。
  - 说明：收敛字面量。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run check:model-hardcoding`

**381.** 为「CLI Routing and Help Surface」的公共函数补 JSDoc：写清意图、参数契约、返回值与副作用。
  - 说明：补 JSDoc。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run check:agent-rules`

**382.** 为「CLI Routing and Help Surface」增加空参数补全保护：工具/命令缺关键参数时给出可推断的安全默认。
  - 说明：空参补全。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run test:maintainer:cli-routing`

**383.** 为「CLI Routing and Help Surface」抽取叶子后 grep 每个被调函数，凡叶子调而宿主定义者必迁或 DI。
  - 说明：查死引用。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run check:leaf-contract`

**384.** 为「CLI Routing and Help Surface」写一条场景测试：模拟一个真实用户操作序列，断言端到端结果。
  - 说明：场景测试。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run test:maintainer:cli-routing`

**385.** 把「CLI Routing and Help Surface」里超过三层的嵌套条件重构为早返回（guard clause），降低阅读成本。
  - 说明：早返回。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run check:change-safety`

**386.** 为「CLI Routing and Help Surface」补一条门关字节回退测试：关掉 KHY_* 门后行为逐字节回到改动前。
  - 说明：门关回退。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run check:flag-registry`

**387.** 给「CLI Routing and Help Surface」仅用于匹配的正则去掉全局 g 标志，避免 lastIndex 状态残留。
  - 说明：正则去 g。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run test:maintainer:cli-routing`

**388.** 为「CLI Routing and Help Surface」登记进 docs/维护者/维护映射表.json（whenToUse/paths/docs/verify 齐全）。
  - 说明：登记映射表。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run maintainer:check`

**389.** 为「CLI Routing and Help Surface」补一句「一句话验证脚本」并并入 test:maintainer:all。
  - 说明：一句话验证。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run maintainer:check`

**390.** 检查「CLI Routing and Help Surface」的错误信息是否可执行：告诉用户「下一步做什么」而不仅是「哪里错了」。
  - 说明：可执行错误。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run test:maintainer:cli-routing`

**391.** 为「CLI Routing and Help Surface」的关键常量补注释解释「为什么是这个值」（保守高估、上限来源等）。
  - 说明：常量讲来源。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run check:change-safety`

**392.** 为「CLI Routing and Help Surface」增加平台差异白名单（linux/windows/macos/android/ios），差异化规则收在注册表一处。
  - 说明：平台白名单。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run test:maintainer:cli-routing`

**393.** 为「CLI Routing and Help Surface」补一条并发/竞态测试：同一资源被两条路径同时访问时结果仍正确。
  - 说明：并发测试。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run test:maintainer:cli-routing`

**394.** 把「CLI Routing and Help Surface」里手写的重复逻辑抽成一个纯 helper，并给它单测。
  - 说明：抽纯 helper。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run check:leaf-contract`

**395.** 为「CLI Routing and Help Surface」写一条「畸形输入绝不抛」的模糊测试：喂 null/数字/字符串/超大对象都返回安全值。
  - 说明：模糊测试。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run check:leaf-contract`

**396.** 检查「CLI Routing and Help Surface」的默认值是否安全优先：不确定时偏向拒绝/降级而非放行。
  - 说明：安全默认。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run check:change-safety`

**397.** 为「CLI Routing and Help Surface」补一条端点/URL 成形的确定性测试（不发真实请求，只断言拼出的字符串正确）。
  - 说明：URL 成形测试。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run test:maintainer:cli-routing`

**398.** 为「CLI Routing and Help Surface」的每个导出函数确认都有对应测试引用，无孤儿导出。
  - 说明：无孤儿导出。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run check:leaf-contract`

**399.** 为「CLI Routing and Help Surface」增加预算/上限保护：循环或累积有明确终止条件，防止失控。
  - 说明：预算护栏。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run test:maintainer:cli-routing`

**400.** 把「CLI Routing and Help Surface」的巨型 switch 按 case 簇抽子分派器（pre-dispatch + 哨兵 fall-through）。
  - 说明：switch 拆解。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run arch:god`

**401.** 为「CLI Routing and Help Surface」补一条幂等测试：同一操作跑两次结果一致、无副作用叠加。
  - 说明：幂等测试。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run test:maintainer:cli-routing`

**402.** 检查「CLI Routing and Help Surface」是否遵守单向依赖：叶子不得反向 require 宿主网关，需要就用 IoC 缝。
  - 说明：单向依赖。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run check:leaf-contract`

**403.** 为「CLI Routing and Help Surface」写一份「新维护者一分钟上手」的结构表（文件→职责一行）。
  - 说明：一分钟上手。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run maintainer:check`

**404.** 为「CLI Routing and Help Surface」的时间相关逻辑改为「时钟由调用方喂入」，让它可离线确定性测试。
  - 说明：时钟可注入。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run test:maintainer:cli-routing`

**405.** 给「CLI Routing and Help Surface」补一条「截断/采样时必须 log 丢了什么」的规则，杜绝静默截断。
  - 说明：别静默截断。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run check:change-safety`

**406.** 为「CLI Routing and Help Surface」增加 dry-run 模式：先展示将要做什么，用户确认后才执行破坏性操作。
  - 说明：dry-run 先行。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run check:small-model:safety`

**407.** 检查「CLI Routing and Help Surface」的 flag 语义：opt-in 严格只认 1/true，default-on 只认关键词才关。
  - 说明：门语义核对。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run check:flag-registry`

**408.** 为「CLI Routing and Help Surface」补一条「父门关闭 → 子功能整体关闭」的门控测试。
  - 说明：父子门控。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run check:flag-registry`

**409.** 把「CLI Routing and Help Surface」里的魔法数字提取为具名常量并注释其单位与来源。
  - 说明：消魔法数。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run check:change-safety`

**410.** 为「CLI Routing and Help Surface」写一条向后兼容测试：旧输入格式仍能被正确解析。
  - 说明：向后兼容。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run test:maintainer:cli-routing`

**411.** 为「CLI Routing and Help Surface」的注册表新增一维时，确认聚合器与格式化器各只改一处（不 smear）。
  - 说明：改动不 smear。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run test:maintainer:cli-routing`

**412.** 检查「CLI Routing and Help Surface」抽取后宿主是否仍持有核心态，叶子只拿它需要的切片。
  - 说明：核心态留宿主。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run arch:god`

**413.** 为「CLI Routing and Help Surface」补一条跨渠道/双通道一致性测试（如版本号 pip 与 npm 必须一致）。
  - 说明：双通道一致。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run test:maintainer:cli-routing`

**414.** 为「CLI Routing and Help Surface」的用户可见文案统一措辞与语气，避免同义词乱用误导弱模型。
  - 说明：文案统一。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run maintainer:check`

**415.** 给「CLI Routing and Help Surface」增加一个健康分自检项，纳入 khy doctor 的输出。
  - 说明：并入自检。 子系统：CLI Routing and Help Surface。
  - 验证：`khy doctor`

**416.** 为「CLI Routing and Help Surface」补一条资源清理测试：临时文件用后即删、句柄关闭、无泄漏。
  - 说明：资源清理。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run test:maintainer:cli-routing`

**417.** 把「CLI Routing and Help Surface」里可能抛的第三方调用全部包进 try/catch 并给结构化 reason。
  - 说明：结构化容错。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run check:change-safety`

**418.** 为「CLI Routing and Help Surface」写一条已知安全边界注释：明确它是 review aid 还是隔离边界，别夸大保证。
  - 说明：诚实边界。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run check:leaf-contract`

**419.** 为「CLI Routing and Help Surface」补一条空结果早退路径：0 命中时跳过昂贵的下游步骤。
  - 说明：空结果早退。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run test:maintainer:cli-routing`

**420.** 检查「CLI Routing and Help Surface」的命令别名是否都路由到正确 handler，补一条 alias 路由测试。
  - 说明：别名路由。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run test:maintainer:cli-routing`

**421.** 为「CLI Routing and Help Surface」建立一条 memory 记录模板，把「为什么这么改」写进传承文档。
  - 说明：沉淀传承。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run maintainer:check`

**422.** 为「Prompt Capsule and Debug Prompt System」增加一个 flag 门控的纯叶子：零 IO、绝不抛异常，先在 flagRegistry 登记 KHY_* 门再接线。
  - 说明：新能力走门控叶子。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`npm run check:flag-registry`

**423.** 为「Prompt Capsule and Debug Prompt System」补一条 node:test，至少覆盖：正常路径、一个边界、一个畸形/空输入。
  - 说明：补测试。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`node --test services/backend/tests/promptOnDemandSections.test.js`

**424.** 通读「Prompt Capsule and Debug Prompt System」核心文件，在顶部一句话写清职责，并给最难懂的分支补一句注释（不改行为）。
  - 说明：补可读性。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`node --test services/backend/tests/promptOnDemandSections.test.js`

**425.** 扫描「Prompt Capsule and Debug Prompt System」是否有文件超 2500 行；若有，按同名 re-export + DI 抽一个聚焦叶子，保字节等价。
  - 说明：拆上帝文件。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`npm run arch:god`

**426.** 给「Prompt Capsule and Debug Prompt System」的注册表叶子（_PROBES/_REPAIRS 之类）上方补 4 步 HOW-TO-EXTEND 抄写式注释。
  - 说明：注册表可扩展。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`npm run maintainer:check`

**427.** 把「Prompt Capsule and Debug Prompt System」中每轮/每请求重复构建的 Set/正则/常量提升为模块常量（参考书 Ch2）。
  - 说明：别每轮重建。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`npm run arch:god`

**428.** 为「Prompt Capsule and Debug Prompt System」增加一个只读诊断探针：只观测不修改，绝不写盘、绝不发网络。
  - 说明：加只读探针。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`node --test services/backend/tests/promptOnDemandSections.test.js`

**429.** 为「Prompt Capsule and Debug Prompt System」增加一个「仅创建缺失项」的安全自愈：幂等、fail-soft、遇损坏拒删交人工。
  - 说明：加安全修复。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`node --test services/backend/tests/promptOnDemandSections.test.js`

**430.** 给「Prompt Capsule and Debug Prompt System」的失败路径补一条指名道姓的可执行指引，把错误码翻译成用户能照做的步骤。
  - 说明：错误可执行。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`node --test services/backend/tests/promptOnDemandSections.test.js`

**431.** 核对「Prompt Capsule and Debug Prompt System」的 verify 命令仍能一键复现绿灯；若命令漂移就修 package.json 别名。
  - 说明：verify 不漂移。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`node --test services/backend/tests/promptOnDemandSections.test.js`

**432.** 为「Prompt Capsule and Debug Prompt System」新增功能前先在 flagRegistry 登记开关，并确认父门链正确（父关则子必关）。
  - 说明：门先登记。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`npm run check:flag-registry`

**433.** 为「Prompt Capsule and Debug Prompt System」的输入做防御式校验：null/undefined/空数组/超长都有明确且安全的默认行为。
  - 说明：防御式输入。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`node --test services/backend/tests/promptOnDemandSections.test.js`

**434.** 给「Prompt Capsule and Debug Prompt System」的外部调用加超时与失败兜底，任何一路挂了都 fail-soft 而不是整体崩。
  - 说明：失败兜底。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`node --test services/backend/tests/promptOnDemandSections.test.js`

**435.** 为「Prompt Capsule and Debug Prompt System」补一条针对历史 bug 的回归测试，命名写清它守护的是哪个坑。
  - 说明：回归测试。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`node --test services/backend/tests/promptOnDemandSections.test.js`

**436.** 检查「Prompt Capsule and Debug Prompt System」的日志：敏感值只打印长度不打印明文，绝不把 key/token 落盘或进日志。
  - 说明：日志脱敏。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`npm run check:model-hardcoding`

**437.** 为「Prompt Capsule and Debug Prompt System」写一条 golden 测试：把一次已知正确的输出固化，防止未来悄悄漂移。
  - 说明：golden 固化。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`node --test services/backend/tests/promptOnDemandSections.test.js`

**438.** 为「Prompt Capsule and Debug Prompt System」排查可变状态跨簇共享：若被多处重赋值，抽取时必须用 DI 注入而非复制。
  - 说明：共享态用 DI。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`npm run arch:god`

**439.** 为「Prompt Capsule and Debug Prompt System」补一个进程级缓存的测试重置钩子，避免测试间状态串味。
  - 说明：缓存可重置。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`node --test services/backend/tests/promptOnDemandSections.test.js`

**440.** 把「Prompt Capsule and Debug Prompt System」里散落的模型名/端点字面量收敛到单一权威来源（SSOT 访问器）。
  - 说明：收敛字面量。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`npm run check:model-hardcoding`

**441.** 为「Prompt Capsule and Debug Prompt System」的公共函数补 JSDoc：写清意图、参数契约、返回值与副作用。
  - 说明：补 JSDoc。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`npm run check:agent-rules`

**442.** 为「Prompt Capsule and Debug Prompt System」增加空参数补全保护：工具/命令缺关键参数时给出可推断的安全默认。
  - 说明：空参补全。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`node --test services/backend/tests/promptOnDemandSections.test.js`

**443.** 为「Prompt Capsule and Debug Prompt System」抽取叶子后 grep 每个被调函数，凡叶子调而宿主定义者必迁或 DI。
  - 说明：查死引用。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`npm run check:leaf-contract`

**444.** 为「Prompt Capsule and Debug Prompt System」写一条场景测试：模拟一个真实用户操作序列，断言端到端结果。
  - 说明：场景测试。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`node --test services/backend/tests/promptOnDemandSections.test.js`

**445.** 把「Prompt Capsule and Debug Prompt System」里超过三层的嵌套条件重构为早返回（guard clause），降低阅读成本。
  - 说明：早返回。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`npm run check:change-safety`

**446.** 为「Prompt Capsule and Debug Prompt System」补一条门关字节回退测试：关掉 KHY_* 门后行为逐字节回到改动前。
  - 说明：门关回退。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`npm run check:flag-registry`

**447.** 给「Prompt Capsule and Debug Prompt System」仅用于匹配的正则去掉全局 g 标志，避免 lastIndex 状态残留。
  - 说明：正则去 g。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`node --test services/backend/tests/promptOnDemandSections.test.js`

**448.** 为「Prompt Capsule and Debug Prompt System」登记进 docs/维护者/维护映射表.json（whenToUse/paths/docs/verify 齐全）。
  - 说明：登记映射表。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`npm run maintainer:check`

**449.** 为「Prompt Capsule and Debug Prompt System」补一句「一句话验证脚本」并并入 test:maintainer:all。
  - 说明：一句话验证。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`npm run maintainer:check`

**450.** 检查「Prompt Capsule and Debug Prompt System」的错误信息是否可执行：告诉用户「下一步做什么」而不仅是「哪里错了」。
  - 说明：可执行错误。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`node --test services/backend/tests/promptOnDemandSections.test.js`

**451.** 为「Prompt Capsule and Debug Prompt System」的关键常量补注释解释「为什么是这个值」（保守高估、上限来源等）。
  - 说明：常量讲来源。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`npm run check:change-safety`

**452.** 为「Prompt Capsule and Debug Prompt System」增加平台差异白名单（linux/windows/macos/android/ios），差异化规则收在注册表一处。
  - 说明：平台白名单。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`node --test services/backend/tests/promptOnDemandSections.test.js`

**453.** 为「Prompt Capsule and Debug Prompt System」补一条并发/竞态测试：同一资源被两条路径同时访问时结果仍正确。
  - 说明：并发测试。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`node --test services/backend/tests/promptOnDemandSections.test.js`

**454.** 把「Prompt Capsule and Debug Prompt System」里手写的重复逻辑抽成一个纯 helper，并给它单测。
  - 说明：抽纯 helper。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`npm run check:leaf-contract`

**455.** 为「Prompt Capsule and Debug Prompt System」写一条「畸形输入绝不抛」的模糊测试：喂 null/数字/字符串/超大对象都返回安全值。
  - 说明：模糊测试。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`npm run check:leaf-contract`

**456.** 检查「Prompt Capsule and Debug Prompt System」的默认值是否安全优先：不确定时偏向拒绝/降级而非放行。
  - 说明：安全默认。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`npm run check:change-safety`

**457.** 为「Prompt Capsule and Debug Prompt System」补一条端点/URL 成形的确定性测试（不发真实请求，只断言拼出的字符串正确）。
  - 说明：URL 成形测试。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`node --test services/backend/tests/promptOnDemandSections.test.js`

**458.** 为「Prompt Capsule and Debug Prompt System」的每个导出函数确认都有对应测试引用，无孤儿导出。
  - 说明：无孤儿导出。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`npm run check:leaf-contract`

**459.** 为「Prompt Capsule and Debug Prompt System」增加预算/上限保护：循环或累积有明确终止条件，防止失控。
  - 说明：预算护栏。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`node --test services/backend/tests/promptOnDemandSections.test.js`

**460.** 把「Prompt Capsule and Debug Prompt System」的巨型 switch 按 case 簇抽子分派器（pre-dispatch + 哨兵 fall-through）。
  - 说明：switch 拆解。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`npm run arch:god`

**461.** 为「Prompt Capsule and Debug Prompt System」补一条幂等测试：同一操作跑两次结果一致、无副作用叠加。
  - 说明：幂等测试。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`node --test services/backend/tests/promptOnDemandSections.test.js`

**462.** 检查「Prompt Capsule and Debug Prompt System」是否遵守单向依赖：叶子不得反向 require 宿主网关，需要就用 IoC 缝。
  - 说明：单向依赖。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`npm run check:leaf-contract`

**463.** 为「Prompt Capsule and Debug Prompt System」写一份「新维护者一分钟上手」的结构表（文件→职责一行）。
  - 说明：一分钟上手。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`npm run maintainer:check`

**464.** 为「Prompt Capsule and Debug Prompt System」的时间相关逻辑改为「时钟由调用方喂入」，让它可离线确定性测试。
  - 说明：时钟可注入。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`node --test services/backend/tests/promptOnDemandSections.test.js`

**465.** 给「Prompt Capsule and Debug Prompt System」补一条「截断/采样时必须 log 丢了什么」的规则，杜绝静默截断。
  - 说明：别静默截断。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`npm run check:change-safety`

**466.** 为「Prompt Capsule and Debug Prompt System」增加 dry-run 模式：先展示将要做什么，用户确认后才执行破坏性操作。
  - 说明：dry-run 先行。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`npm run check:small-model:safety`

**467.** 检查「Prompt Capsule and Debug Prompt System」的 flag 语义：opt-in 严格只认 1/true，default-on 只认关键词才关。
  - 说明：门语义核对。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`npm run check:flag-registry`

**468.** 为「Prompt Capsule and Debug Prompt System」补一条「父门关闭 → 子功能整体关闭」的门控测试。
  - 说明：父子门控。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`npm run check:flag-registry`

**469.** 把「Prompt Capsule and Debug Prompt System」里的魔法数字提取为具名常量并注释其单位与来源。
  - 说明：消魔法数。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`npm run check:change-safety`

**470.** 为「Prompt Capsule and Debug Prompt System」写一条向后兼容测试：旧输入格式仍能被正确解析。
  - 说明：向后兼容。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`node --test services/backend/tests/promptOnDemandSections.test.js`

**471.** 为「Prompt Capsule and Debug Prompt System」的注册表新增一维时，确认聚合器与格式化器各只改一处（不 smear）。
  - 说明：改动不 smear。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`node --test services/backend/tests/promptOnDemandSections.test.js`

**472.** 检查「Prompt Capsule and Debug Prompt System」抽取后宿主是否仍持有核心态，叶子只拿它需要的切片。
  - 说明：核心态留宿主。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`npm run arch:god`

**473.** 为「Prompt Capsule and Debug Prompt System」补一条跨渠道/双通道一致性测试（如版本号 pip 与 npm 必须一致）。
  - 说明：双通道一致。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`node --test services/backend/tests/promptOnDemandSections.test.js`

**474.** 为「Prompt Capsule and Debug Prompt System」的用户可见文案统一措辞与语气，避免同义词乱用误导弱模型。
  - 说明：文案统一。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`npm run maintainer:check`

**475.** 给「Prompt Capsule and Debug Prompt System」增加一个健康分自检项，纳入 khy doctor 的输出。
  - 说明：并入自检。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`khy doctor`

**476.** 为「Prompt Capsule and Debug Prompt System」补一条资源清理测试：临时文件用后即删、句柄关闭、无泄漏。
  - 说明：资源清理。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`node --test services/backend/tests/promptOnDemandSections.test.js`

**477.** 把「Prompt Capsule and Debug Prompt System」里可能抛的第三方调用全部包进 try/catch 并给结构化 reason。
  - 说明：结构化容错。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`npm run check:change-safety`

**478.** 为「Prompt Capsule and Debug Prompt System」写一条已知安全边界注释：明确它是 review aid 还是隔离边界，别夸大保证。
  - 说明：诚实边界。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`npm run check:leaf-contract`

**479.** 为「Prompt Capsule and Debug Prompt System」补一条空结果早退路径：0 命中时跳过昂贵的下游步骤。
  - 说明：空结果早退。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`node --test services/backend/tests/promptOnDemandSections.test.js`

**480.** 检查「Prompt Capsule and Debug Prompt System」的命令别名是否都路由到正确 handler，补一条 alias 路由测试。
  - 说明：别名路由。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`node --test services/backend/tests/promptOnDemandSections.test.js`

**481.** 为「Prompt Capsule and Debug Prompt System」建立一条 memory 记录模板，把「为什么这么改」写进传承文档。
  - 说明：沉淀传承。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`npm run maintainer:check`

**482.** 为「AI Gateway and Adapter Layer」增加一个 flag 门控的纯叶子：零 IO、绝不抛异常，先在 flagRegistry 登记 KHY_* 门再接线。
  - 说明：新能力走门控叶子。 子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run check:flag-registry`

**483.** 为「AI Gateway and Adapter Layer」补一条 node:test，至少覆盖：正常路径、一个边界、一个畸形/空输入。
  - 说明：补测试。 子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run test:maintainer:gateway`

**484.** 通读「AI Gateway and Adapter Layer」核心文件，在顶部一句话写清职责，并给最难懂的分支补一句注释（不改行为）。
  - 说明：补可读性。 子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run test:maintainer:gateway`

**485.** 扫描「AI Gateway and Adapter Layer」是否有文件超 2500 行；若有，按同名 re-export + DI 抽一个聚焦叶子，保字节等价。
  - 说明：拆上帝文件。 子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run arch:god`

**486.** 给「AI Gateway and Adapter Layer」的注册表叶子（_PROBES/_REPAIRS 之类）上方补 4 步 HOW-TO-EXTEND 抄写式注释。
  - 说明：注册表可扩展。 子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run maintainer:check`

**487.** 把「AI Gateway and Adapter Layer」中每轮/每请求重复构建的 Set/正则/常量提升为模块常量（参考书 Ch2）。
  - 说明：别每轮重建。 子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run arch:god`

**488.** 为「AI Gateway and Adapter Layer」增加一个只读诊断探针：只观测不修改，绝不写盘、绝不发网络。
  - 说明：加只读探针。 子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run test:maintainer:gateway`

**489.** 为「AI Gateway and Adapter Layer」增加一个「仅创建缺失项」的安全自愈：幂等、fail-soft、遇损坏拒删交人工。
  - 说明：加安全修复。 子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run test:maintainer:gateway`

**490.** 给「AI Gateway and Adapter Layer」的失败路径补一条指名道姓的可执行指引，把错误码翻译成用户能照做的步骤。
  - 说明：错误可执行。 子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run test:maintainer:gateway`

**491.** 核对「AI Gateway and Adapter Layer」的 verify 命令仍能一键复现绿灯；若命令漂移就修 package.json 别名。
  - 说明：verify 不漂移。 子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run test:maintainer:gateway`

**492.** 为「AI Gateway and Adapter Layer」新增功能前先在 flagRegistry 登记开关，并确认父门链正确（父关则子必关）。
  - 说明：门先登记。 子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run check:flag-registry`

**493.** 为「AI Gateway and Adapter Layer」的输入做防御式校验：null/undefined/空数组/超长都有明确且安全的默认行为。
  - 说明：防御式输入。 子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run test:maintainer:gateway`

**494.** 给「AI Gateway and Adapter Layer」的外部调用加超时与失败兜底，任何一路挂了都 fail-soft 而不是整体崩。
  - 说明：失败兜底。 子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run test:maintainer:gateway`

**495.** 为「AI Gateway and Adapter Layer」补一条针对历史 bug 的回归测试，命名写清它守护的是哪个坑。
  - 说明：回归测试。 子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run test:maintainer:gateway`

**496.** 检查「AI Gateway and Adapter Layer」的日志：敏感值只打印长度不打印明文，绝不把 key/token 落盘或进日志。
  - 说明：日志脱敏。 子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run check:model-hardcoding`

**497.** 为「AI Gateway and Adapter Layer」写一条 golden 测试：把一次已知正确的输出固化，防止未来悄悄漂移。
  - 说明：golden 固化。 子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run test:maintainer:gateway`

**498.** 为「AI Gateway and Adapter Layer」排查可变状态跨簇共享：若被多处重赋值，抽取时必须用 DI 注入而非复制。
  - 说明：共享态用 DI。 子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run arch:god`

**499.** 为「AI Gateway and Adapter Layer」补一个进程级缓存的测试重置钩子，避免测试间状态串味。
  - 说明：缓存可重置。 子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run test:maintainer:gateway`

**500.** 把「AI Gateway and Adapter Layer」里散落的模型名/端点字面量收敛到单一权威来源（SSOT 访问器）。
  - 说明：收敛字面量。 子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run check:model-hardcoding`

**501.** 为「AI Gateway and Adapter Layer」的公共函数补 JSDoc：写清意图、参数契约、返回值与副作用。
  - 说明：补 JSDoc。 子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run check:agent-rules`

**502.** 为「AI Gateway and Adapter Layer」增加空参数补全保护：工具/命令缺关键参数时给出可推断的安全默认。
  - 说明：空参补全。 子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run test:maintainer:gateway`

**503.** 为「AI Gateway and Adapter Layer」抽取叶子后 grep 每个被调函数，凡叶子调而宿主定义者必迁或 DI。
  - 说明：查死引用。 子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run check:leaf-contract`

**504.** 为「AI Gateway and Adapter Layer」写一条场景测试：模拟一个真实用户操作序列，断言端到端结果。
  - 说明：场景测试。 子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run test:maintainer:gateway`

**505.** 把「AI Gateway and Adapter Layer」里超过三层的嵌套条件重构为早返回（guard clause），降低阅读成本。
  - 说明：早返回。 子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run check:change-safety`

**506.** 为「AI Gateway and Adapter Layer」补一条门关字节回退测试：关掉 KHY_* 门后行为逐字节回到改动前。
  - 说明：门关回退。 子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run check:flag-registry`

**507.** 给「AI Gateway and Adapter Layer」仅用于匹配的正则去掉全局 g 标志，避免 lastIndex 状态残留。
  - 说明：正则去 g。 子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run test:maintainer:gateway`

**508.** 为「AI Gateway and Adapter Layer」登记进 docs/维护者/维护映射表.json（whenToUse/paths/docs/verify 齐全）。
  - 说明：登记映射表。 子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run maintainer:check`

**509.** 为「AI Gateway and Adapter Layer」补一句「一句话验证脚本」并并入 test:maintainer:all。
  - 说明：一句话验证。 子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run maintainer:check`

**510.** 检查「AI Gateway and Adapter Layer」的错误信息是否可执行：告诉用户「下一步做什么」而不仅是「哪里错了」。
  - 说明：可执行错误。 子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run test:maintainer:gateway`

**511.** 为「AI Gateway and Adapter Layer」的关键常量补注释解释「为什么是这个值」（保守高估、上限来源等）。
  - 说明：常量讲来源。 子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run check:change-safety`

**512.** 为「AI Gateway and Adapter Layer」增加平台差异白名单（linux/windows/macos/android/ios），差异化规则收在注册表一处。
  - 说明：平台白名单。 子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run test:maintainer:gateway`

**513.** 为「AI Gateway and Adapter Layer」补一条并发/竞态测试：同一资源被两条路径同时访问时结果仍正确。
  - 说明：并发测试。 子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run test:maintainer:gateway`

**514.** 把「AI Gateway and Adapter Layer」里手写的重复逻辑抽成一个纯 helper，并给它单测。
  - 说明：抽纯 helper。 子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run check:leaf-contract`

**515.** 为「AI Gateway and Adapter Layer」写一条「畸形输入绝不抛」的模糊测试：喂 null/数字/字符串/超大对象都返回安全值。
  - 说明：模糊测试。 子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run check:leaf-contract`

**516.** 检查「AI Gateway and Adapter Layer」的默认值是否安全优先：不确定时偏向拒绝/降级而非放行。
  - 说明：安全默认。 子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run check:change-safety`

**517.** 为「AI Gateway and Adapter Layer」补一条端点/URL 成形的确定性测试（不发真实请求，只断言拼出的字符串正确）。
  - 说明：URL 成形测试。 子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run test:maintainer:gateway`

**518.** 为「AI Gateway and Adapter Layer」的每个导出函数确认都有对应测试引用，无孤儿导出。
  - 说明：无孤儿导出。 子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run check:leaf-contract`

**519.** 为「AI Gateway and Adapter Layer」增加预算/上限保护：循环或累积有明确终止条件，防止失控。
  - 说明：预算护栏。 子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run test:maintainer:gateway`

**520.** 把「AI Gateway and Adapter Layer」的巨型 switch 按 case 簇抽子分派器（pre-dispatch + 哨兵 fall-through）。
  - 说明：switch 拆解。 子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run arch:god`

**521.** 为「AI Gateway and Adapter Layer」补一条幂等测试：同一操作跑两次结果一致、无副作用叠加。
  - 说明：幂等测试。 子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run test:maintainer:gateway`

**522.** 检查「AI Gateway and Adapter Layer」是否遵守单向依赖：叶子不得反向 require 宿主网关，需要就用 IoC 缝。
  - 说明：单向依赖。 子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run check:leaf-contract`

**523.** 为「AI Gateway and Adapter Layer」写一份「新维护者一分钟上手」的结构表（文件→职责一行）。
  - 说明：一分钟上手。 子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run maintainer:check`

**524.** 为「AI Gateway and Adapter Layer」的时间相关逻辑改为「时钟由调用方喂入」，让它可离线确定性测试。
  - 说明：时钟可注入。 子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run test:maintainer:gateway`

**525.** 给「AI Gateway and Adapter Layer」补一条「截断/采样时必须 log 丢了什么」的规则，杜绝静默截断。
  - 说明：别静默截断。 子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run check:change-safety`

**526.** 为「AI Gateway and Adapter Layer」增加 dry-run 模式：先展示将要做什么，用户确认后才执行破坏性操作。
  - 说明：dry-run 先行。 子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run check:small-model:safety`

**527.** 检查「AI Gateway and Adapter Layer」的 flag 语义：opt-in 严格只认 1/true，default-on 只认关键词才关。
  - 说明：门语义核对。 子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run check:flag-registry`

**528.** 为「AI Gateway and Adapter Layer」补一条「父门关闭 → 子功能整体关闭」的门控测试。
  - 说明：父子门控。 子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run check:flag-registry`

**529.** 把「AI Gateway and Adapter Layer」里的魔法数字提取为具名常量并注释其单位与来源。
  - 说明：消魔法数。 子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run check:change-safety`

**530.** 为「AI Gateway and Adapter Layer」写一条向后兼容测试：旧输入格式仍能被正确解析。
  - 说明：向后兼容。 子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run test:maintainer:gateway`

**531.** 为「AI Gateway and Adapter Layer」的注册表新增一维时，确认聚合器与格式化器各只改一处（不 smear）。
  - 说明：改动不 smear。 子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run test:maintainer:gateway`

**532.** 检查「AI Gateway and Adapter Layer」抽取后宿主是否仍持有核心态，叶子只拿它需要的切片。
  - 说明：核心态留宿主。 子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run arch:god`

**533.** 为「AI Gateway and Adapter Layer」补一条跨渠道/双通道一致性测试（如版本号 pip 与 npm 必须一致）。
  - 说明：双通道一致。 子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run test:maintainer:gateway`

**534.** 为「AI Gateway and Adapter Layer」的用户可见文案统一措辞与语气，避免同义词乱用误导弱模型。
  - 说明：文案统一。 子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run maintainer:check`

**535.** 给「AI Gateway and Adapter Layer」增加一个健康分自检项，纳入 khy doctor 的输出。
  - 说明：并入自检。 子系统：AI Gateway and Adapter Layer。
  - 验证：`khy doctor`

**536.** 为「AI Gateway and Adapter Layer」补一条资源清理测试：临时文件用后即删、句柄关闭、无泄漏。
  - 说明：资源清理。 子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run test:maintainer:gateway`

**537.** 把「AI Gateway and Adapter Layer」里可能抛的第三方调用全部包进 try/catch 并给结构化 reason。
  - 说明：结构化容错。 子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run check:change-safety`

**538.** 为「AI Gateway and Adapter Layer」写一条已知安全边界注释：明确它是 review aid 还是隔离边界，别夸大保证。
  - 说明：诚实边界。 子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run check:leaf-contract`

**539.** 为「AI Gateway and Adapter Layer」补一条空结果早退路径：0 命中时跳过昂贵的下游步骤。
  - 说明：空结果早退。 子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run test:maintainer:gateway`

**540.** 检查「AI Gateway and Adapter Layer」的命令别名是否都路由到正确 handler，补一条 alias 路由测试。
  - 说明：别名路由。 子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run test:maintainer:gateway`

**541.** 为「AI Gateway and Adapter Layer」建立一条 memory 记录模板，把「为什么这么改」写进传承文档。
  - 说明：沉淀传承。 子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run maintainer:check`

**542.** 为「Proxy, Daemon, and Runtime Port Discovery」增加一个 flag 门控的纯叶子：零 IO、绝不抛异常，先在 flagRegistry 登记 KHY_* 门再接线。
  - 说明：新能力走门控叶子。 子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run check:flag-registry`

**543.** 为「Proxy, Daemon, and Runtime Port Discovery」补一条 node:test，至少覆盖：正常路径、一个边界、一个畸形/空输入。
  - 说明：补测试。 子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run test:maintainer:runtime`

**544.** 通读「Proxy, Daemon, and Runtime Port Discovery」核心文件，在顶部一句话写清职责，并给最难懂的分支补一句注释（不改行为）。
  - 说明：补可读性。 子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run test:maintainer:runtime`

**545.** 扫描「Proxy, Daemon, and Runtime Port Discovery」是否有文件超 2500 行；若有，按同名 re-export + DI 抽一个聚焦叶子，保字节等价。
  - 说明：拆上帝文件。 子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run arch:god`

**546.** 给「Proxy, Daemon, and Runtime Port Discovery」的注册表叶子（_PROBES/_REPAIRS 之类）上方补 4 步 HOW-TO-EXTEND 抄写式注释。
  - 说明：注册表可扩展。 子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run maintainer:check`

**547.** 把「Proxy, Daemon, and Runtime Port Discovery」中每轮/每请求重复构建的 Set/正则/常量提升为模块常量（参考书 Ch2）。
  - 说明：别每轮重建。 子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run arch:god`

**548.** 为「Proxy, Daemon, and Runtime Port Discovery」增加一个只读诊断探针：只观测不修改，绝不写盘、绝不发网络。
  - 说明：加只读探针。 子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run test:maintainer:runtime`

**549.** 为「Proxy, Daemon, and Runtime Port Discovery」增加一个「仅创建缺失项」的安全自愈：幂等、fail-soft、遇损坏拒删交人工。
  - 说明：加安全修复。 子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run test:maintainer:runtime`

**550.** 给「Proxy, Daemon, and Runtime Port Discovery」的失败路径补一条指名道姓的可执行指引，把错误码翻译成用户能照做的步骤。
  - 说明：错误可执行。 子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run test:maintainer:runtime`

**551.** 核对「Proxy, Daemon, and Runtime Port Discovery」的 verify 命令仍能一键复现绿灯；若命令漂移就修 package.json 别名。
  - 说明：verify 不漂移。 子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run test:maintainer:runtime`

**552.** 为「Proxy, Daemon, and Runtime Port Discovery」新增功能前先在 flagRegistry 登记开关，并确认父门链正确（父关则子必关）。
  - 说明：门先登记。 子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run check:flag-registry`

**553.** 为「Proxy, Daemon, and Runtime Port Discovery」的输入做防御式校验：null/undefined/空数组/超长都有明确且安全的默认行为。
  - 说明：防御式输入。 子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run test:maintainer:runtime`

**554.** 给「Proxy, Daemon, and Runtime Port Discovery」的外部调用加超时与失败兜底，任何一路挂了都 fail-soft 而不是整体崩。
  - 说明：失败兜底。 子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run test:maintainer:runtime`

**555.** 为「Proxy, Daemon, and Runtime Port Discovery」补一条针对历史 bug 的回归测试，命名写清它守护的是哪个坑。
  - 说明：回归测试。 子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run test:maintainer:runtime`

**556.** 检查「Proxy, Daemon, and Runtime Port Discovery」的日志：敏感值只打印长度不打印明文，绝不把 key/token 落盘或进日志。
  - 说明：日志脱敏。 子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run check:model-hardcoding`

**557.** 为「Proxy, Daemon, and Runtime Port Discovery」写一条 golden 测试：把一次已知正确的输出固化，防止未来悄悄漂移。
  - 说明：golden 固化。 子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run test:maintainer:runtime`

**558.** 为「Proxy, Daemon, and Runtime Port Discovery」排查可变状态跨簇共享：若被多处重赋值，抽取时必须用 DI 注入而非复制。
  - 说明：共享态用 DI。 子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run arch:god`

**559.** 为「Proxy, Daemon, and Runtime Port Discovery」补一个进程级缓存的测试重置钩子，避免测试间状态串味。
  - 说明：缓存可重置。 子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run test:maintainer:runtime`

**560.** 把「Proxy, Daemon, and Runtime Port Discovery」里散落的模型名/端点字面量收敛到单一权威来源（SSOT 访问器）。
  - 说明：收敛字面量。 子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run check:model-hardcoding`

**561.** 为「Proxy, Daemon, and Runtime Port Discovery」的公共函数补 JSDoc：写清意图、参数契约、返回值与副作用。
  - 说明：补 JSDoc。 子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run check:agent-rules`

**562.** 为「Proxy, Daemon, and Runtime Port Discovery」增加空参数补全保护：工具/命令缺关键参数时给出可推断的安全默认。
  - 说明：空参补全。 子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run test:maintainer:runtime`

**563.** 为「Proxy, Daemon, and Runtime Port Discovery」抽取叶子后 grep 每个被调函数，凡叶子调而宿主定义者必迁或 DI。
  - 说明：查死引用。 子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run check:leaf-contract`

**564.** 为「Proxy, Daemon, and Runtime Port Discovery」写一条场景测试：模拟一个真实用户操作序列，断言端到端结果。
  - 说明：场景测试。 子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run test:maintainer:runtime`

**565.** 把「Proxy, Daemon, and Runtime Port Discovery」里超过三层的嵌套条件重构为早返回（guard clause），降低阅读成本。
  - 说明：早返回。 子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run check:change-safety`

**566.** 为「Proxy, Daemon, and Runtime Port Discovery」补一条门关字节回退测试：关掉 KHY_* 门后行为逐字节回到改动前。
  - 说明：门关回退。 子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run check:flag-registry`

**567.** 给「Proxy, Daemon, and Runtime Port Discovery」仅用于匹配的正则去掉全局 g 标志，避免 lastIndex 状态残留。
  - 说明：正则去 g。 子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run test:maintainer:runtime`

**568.** 为「Proxy, Daemon, and Runtime Port Discovery」登记进 docs/维护者/维护映射表.json（whenToUse/paths/docs/verify 齐全）。
  - 说明：登记映射表。 子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run maintainer:check`

**569.** 为「Proxy, Daemon, and Runtime Port Discovery」补一句「一句话验证脚本」并并入 test:maintainer:all。
  - 说明：一句话验证。 子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run maintainer:check`

**570.** 检查「Proxy, Daemon, and Runtime Port Discovery」的错误信息是否可执行：告诉用户「下一步做什么」而不仅是「哪里错了」。
  - 说明：可执行错误。 子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run test:maintainer:runtime`

**571.** 为「Proxy, Daemon, and Runtime Port Discovery」的关键常量补注释解释「为什么是这个值」（保守高估、上限来源等）。
  - 说明：常量讲来源。 子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run check:change-safety`

**572.** 为「Proxy, Daemon, and Runtime Port Discovery」增加平台差异白名单（linux/windows/macos/android/ios），差异化规则收在注册表一处。
  - 说明：平台白名单。 子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run test:maintainer:runtime`

**573.** 为「Proxy, Daemon, and Runtime Port Discovery」补一条并发/竞态测试：同一资源被两条路径同时访问时结果仍正确。
  - 说明：并发测试。 子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run test:maintainer:runtime`

**574.** 把「Proxy, Daemon, and Runtime Port Discovery」里手写的重复逻辑抽成一个纯 helper，并给它单测。
  - 说明：抽纯 helper。 子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run check:leaf-contract`

**575.** 为「Proxy, Daemon, and Runtime Port Discovery」写一条「畸形输入绝不抛」的模糊测试：喂 null/数字/字符串/超大对象都返回安全值。
  - 说明：模糊测试。 子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run check:leaf-contract`

**576.** 检查「Proxy, Daemon, and Runtime Port Discovery」的默认值是否安全优先：不确定时偏向拒绝/降级而非放行。
  - 说明：安全默认。 子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run check:change-safety`

**577.** 为「Proxy, Daemon, and Runtime Port Discovery」补一条端点/URL 成形的确定性测试（不发真实请求，只断言拼出的字符串正确）。
  - 说明：URL 成形测试。 子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run test:maintainer:runtime`

**578.** 为「Proxy, Daemon, and Runtime Port Discovery」的每个导出函数确认都有对应测试引用，无孤儿导出。
  - 说明：无孤儿导出。 子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run check:leaf-contract`

**579.** 为「Proxy, Daemon, and Runtime Port Discovery」增加预算/上限保护：循环或累积有明确终止条件，防止失控。
  - 说明：预算护栏。 子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run test:maintainer:runtime`

**580.** 把「Proxy, Daemon, and Runtime Port Discovery」的巨型 switch 按 case 簇抽子分派器（pre-dispatch + 哨兵 fall-through）。
  - 说明：switch 拆解。 子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run arch:god`

**581.** 为「Proxy, Daemon, and Runtime Port Discovery」补一条幂等测试：同一操作跑两次结果一致、无副作用叠加。
  - 说明：幂等测试。 子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run test:maintainer:runtime`

**582.** 检查「Proxy, Daemon, and Runtime Port Discovery」是否遵守单向依赖：叶子不得反向 require 宿主网关，需要就用 IoC 缝。
  - 说明：单向依赖。 子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run check:leaf-contract`

**583.** 为「Proxy, Daemon, and Runtime Port Discovery」写一份「新维护者一分钟上手」的结构表（文件→职责一行）。
  - 说明：一分钟上手。 子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run maintainer:check`

**584.** 为「Proxy, Daemon, and Runtime Port Discovery」的时间相关逻辑改为「时钟由调用方喂入」，让它可离线确定性测试。
  - 说明：时钟可注入。 子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run test:maintainer:runtime`

**585.** 给「Proxy, Daemon, and Runtime Port Discovery」补一条「截断/采样时必须 log 丢了什么」的规则，杜绝静默截断。
  - 说明：别静默截断。 子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run check:change-safety`

**586.** 为「Proxy, Daemon, and Runtime Port Discovery」增加 dry-run 模式：先展示将要做什么，用户确认后才执行破坏性操作。
  - 说明：dry-run 先行。 子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run check:small-model:safety`

**587.** 检查「Proxy, Daemon, and Runtime Port Discovery」的 flag 语义：opt-in 严格只认 1/true，default-on 只认关键词才关。
  - 说明：门语义核对。 子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run check:flag-registry`

**588.** 为「Proxy, Daemon, and Runtime Port Discovery」补一条「父门关闭 → 子功能整体关闭」的门控测试。
  - 说明：父子门控。 子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run check:flag-registry`

**589.** 把「Proxy, Daemon, and Runtime Port Discovery」里的魔法数字提取为具名常量并注释其单位与来源。
  - 说明：消魔法数。 子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run check:change-safety`

**590.** 为「Proxy, Daemon, and Runtime Port Discovery」写一条向后兼容测试：旧输入格式仍能被正确解析。
  - 说明：向后兼容。 子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run test:maintainer:runtime`

**591.** 为「Proxy, Daemon, and Runtime Port Discovery」的注册表新增一维时，确认聚合器与格式化器各只改一处（不 smear）。
  - 说明：改动不 smear。 子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run test:maintainer:runtime`

**592.** 检查「Proxy, Daemon, and Runtime Port Discovery」抽取后宿主是否仍持有核心态，叶子只拿它需要的切片。
  - 说明：核心态留宿主。 子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run arch:god`

**593.** 为「Proxy, Daemon, and Runtime Port Discovery」补一条跨渠道/双通道一致性测试（如版本号 pip 与 npm 必须一致）。
  - 说明：双通道一致。 子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run test:maintainer:runtime`

**594.** 为「Proxy, Daemon, and Runtime Port Discovery」的用户可见文案统一措辞与语气，避免同义词乱用误导弱模型。
  - 说明：文案统一。 子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run maintainer:check`

**595.** 给「Proxy, Daemon, and Runtime Port Discovery」增加一个健康分自检项，纳入 khy doctor 的输出。
  - 说明：并入自检。 子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`khy doctor`

**596.** 为「Proxy, Daemon, and Runtime Port Discovery」补一条资源清理测试：临时文件用后即删、句柄关闭、无泄漏。
  - 说明：资源清理。 子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run test:maintainer:runtime`

**597.** 把「Proxy, Daemon, and Runtime Port Discovery」里可能抛的第三方调用全部包进 try/catch 并给结构化 reason。
  - 说明：结构化容错。 子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run check:change-safety`

**598.** 为「Proxy, Daemon, and Runtime Port Discovery」写一条已知安全边界注释：明确它是 review aid 还是隔离边界，别夸大保证。
  - 说明：诚实边界。 子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run check:leaf-contract`

**599.** 为「Proxy, Daemon, and Runtime Port Discovery」补一条空结果早退路径：0 命中时跳过昂贵的下游步骤。
  - 说明：空结果早退。 子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run test:maintainer:runtime`

**600.** 检查「Proxy, Daemon, and Runtime Port Discovery」的命令别名是否都路由到正确 handler，补一条 alias 路由测试。
  - 说明：别名路由。 子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run test:maintainer:runtime`

**601.** 为「Proxy, Daemon, and Runtime Port Discovery」建立一条 memory 记录模板，把「为什么这么改」写进传承文档。
  - 说明：沉淀传承。 子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run maintainer:check`

**602.** 为「AI Management UI and API」增加一个 flag 门控的纯叶子：零 IO、绝不抛异常，先在 flagRegistry 登记 KHY_* 门再接线。
  - 说明：新能力走门控叶子。 子系统：AI Management UI and API。
  - 验证：`npm run check:flag-registry`

**603.** 为「AI Management UI and API」补一条 node:test，至少覆盖：正常路径、一个边界、一个畸形/空输入。
  - 说明：补测试。 子系统：AI Management UI and API。
  - 验证：`npm run test:maintainer:ai-management`

**604.** 通读「AI Management UI and API」核心文件，在顶部一句话写清职责，并给最难懂的分支补一句注释（不改行为）。
  - 说明：补可读性。 子系统：AI Management UI and API。
  - 验证：`npm run test:maintainer:ai-management`

**605.** 扫描「AI Management UI and API」是否有文件超 2500 行；若有，按同名 re-export + DI 抽一个聚焦叶子，保字节等价。
  - 说明：拆上帝文件。 子系统：AI Management UI and API。
  - 验证：`npm run arch:god`

**606.** 给「AI Management UI and API」的注册表叶子（_PROBES/_REPAIRS 之类）上方补 4 步 HOW-TO-EXTEND 抄写式注释。
  - 说明：注册表可扩展。 子系统：AI Management UI and API。
  - 验证：`npm run maintainer:check`

**607.** 把「AI Management UI and API」中每轮/每请求重复构建的 Set/正则/常量提升为模块常量（参考书 Ch2）。
  - 说明：别每轮重建。 子系统：AI Management UI and API。
  - 验证：`npm run arch:god`

**608.** 为「AI Management UI and API」增加一个只读诊断探针：只观测不修改，绝不写盘、绝不发网络。
  - 说明：加只读探针。 子系统：AI Management UI and API。
  - 验证：`npm run test:maintainer:ai-management`

**609.** 为「AI Management UI and API」增加一个「仅创建缺失项」的安全自愈：幂等、fail-soft、遇损坏拒删交人工。
  - 说明：加安全修复。 子系统：AI Management UI and API。
  - 验证：`npm run test:maintainer:ai-management`

**610.** 给「AI Management UI and API」的失败路径补一条指名道姓的可执行指引，把错误码翻译成用户能照做的步骤。
  - 说明：错误可执行。 子系统：AI Management UI and API。
  - 验证：`npm run test:maintainer:ai-management`

**611.** 核对「AI Management UI and API」的 verify 命令仍能一键复现绿灯；若命令漂移就修 package.json 别名。
  - 说明：verify 不漂移。 子系统：AI Management UI and API。
  - 验证：`npm run test:maintainer:ai-management`

**612.** 为「AI Management UI and API」新增功能前先在 flagRegistry 登记开关，并确认父门链正确（父关则子必关）。
  - 说明：门先登记。 子系统：AI Management UI and API。
  - 验证：`npm run check:flag-registry`

**613.** 为「AI Management UI and API」的输入做防御式校验：null/undefined/空数组/超长都有明确且安全的默认行为。
  - 说明：防御式输入。 子系统：AI Management UI and API。
  - 验证：`npm run test:maintainer:ai-management`

**614.** 给「AI Management UI and API」的外部调用加超时与失败兜底，任何一路挂了都 fail-soft 而不是整体崩。
  - 说明：失败兜底。 子系统：AI Management UI and API。
  - 验证：`npm run test:maintainer:ai-management`

**615.** 为「AI Management UI and API」补一条针对历史 bug 的回归测试，命名写清它守护的是哪个坑。
  - 说明：回归测试。 子系统：AI Management UI and API。
  - 验证：`npm run test:maintainer:ai-management`

**616.** 检查「AI Management UI and API」的日志：敏感值只打印长度不打印明文，绝不把 key/token 落盘或进日志。
  - 说明：日志脱敏。 子系统：AI Management UI and API。
  - 验证：`npm run check:model-hardcoding`

**617.** 为「AI Management UI and API」写一条 golden 测试：把一次已知正确的输出固化，防止未来悄悄漂移。
  - 说明：golden 固化。 子系统：AI Management UI and API。
  - 验证：`npm run test:maintainer:ai-management`

**618.** 为「AI Management UI and API」排查可变状态跨簇共享：若被多处重赋值，抽取时必须用 DI 注入而非复制。
  - 说明：共享态用 DI。 子系统：AI Management UI and API。
  - 验证：`npm run arch:god`

**619.** 为「AI Management UI and API」补一个进程级缓存的测试重置钩子，避免测试间状态串味。
  - 说明：缓存可重置。 子系统：AI Management UI and API。
  - 验证：`npm run test:maintainer:ai-management`

**620.** 把「AI Management UI and API」里散落的模型名/端点字面量收敛到单一权威来源（SSOT 访问器）。
  - 说明：收敛字面量。 子系统：AI Management UI and API。
  - 验证：`npm run check:model-hardcoding`

**621.** 为「AI Management UI and API」的公共函数补 JSDoc：写清意图、参数契约、返回值与副作用。
  - 说明：补 JSDoc。 子系统：AI Management UI and API。
  - 验证：`npm run check:agent-rules`

**622.** 为「AI Management UI and API」增加空参数补全保护：工具/命令缺关键参数时给出可推断的安全默认。
  - 说明：空参补全。 子系统：AI Management UI and API。
  - 验证：`npm run test:maintainer:ai-management`

**623.** 为「AI Management UI and API」抽取叶子后 grep 每个被调函数，凡叶子调而宿主定义者必迁或 DI。
  - 说明：查死引用。 子系统：AI Management UI and API。
  - 验证：`npm run check:leaf-contract`

**624.** 为「AI Management UI and API」写一条场景测试：模拟一个真实用户操作序列，断言端到端结果。
  - 说明：场景测试。 子系统：AI Management UI and API。
  - 验证：`npm run test:maintainer:ai-management`

**625.** 把「AI Management UI and API」里超过三层的嵌套条件重构为早返回（guard clause），降低阅读成本。
  - 说明：早返回。 子系统：AI Management UI and API。
  - 验证：`npm run check:change-safety`

**626.** 为「AI Management UI and API」补一条门关字节回退测试：关掉 KHY_* 门后行为逐字节回到改动前。
  - 说明：门关回退。 子系统：AI Management UI and API。
  - 验证：`npm run check:flag-registry`

**627.** 给「AI Management UI and API」仅用于匹配的正则去掉全局 g 标志，避免 lastIndex 状态残留。
  - 说明：正则去 g。 子系统：AI Management UI and API。
  - 验证：`npm run test:maintainer:ai-management`

**628.** 为「AI Management UI and API」登记进 docs/维护者/维护映射表.json（whenToUse/paths/docs/verify 齐全）。
  - 说明：登记映射表。 子系统：AI Management UI and API。
  - 验证：`npm run maintainer:check`

**629.** 为「AI Management UI and API」补一句「一句话验证脚本」并并入 test:maintainer:all。
  - 说明：一句话验证。 子系统：AI Management UI and API。
  - 验证：`npm run maintainer:check`

**630.** 检查「AI Management UI and API」的错误信息是否可执行：告诉用户「下一步做什么」而不仅是「哪里错了」。
  - 说明：可执行错误。 子系统：AI Management UI and API。
  - 验证：`npm run test:maintainer:ai-management`

**631.** 为「AI Management UI and API」的关键常量补注释解释「为什么是这个值」（保守高估、上限来源等）。
  - 说明：常量讲来源。 子系统：AI Management UI and API。
  - 验证：`npm run check:change-safety`

**632.** 为「AI Management UI and API」增加平台差异白名单（linux/windows/macos/android/ios），差异化规则收在注册表一处。
  - 说明：平台白名单。 子系统：AI Management UI and API。
  - 验证：`npm run test:maintainer:ai-management`

**633.** 为「AI Management UI and API」补一条并发/竞态测试：同一资源被两条路径同时访问时结果仍正确。
  - 说明：并发测试。 子系统：AI Management UI and API。
  - 验证：`npm run test:maintainer:ai-management`

**634.** 把「AI Management UI and API」里手写的重复逻辑抽成一个纯 helper，并给它单测。
  - 说明：抽纯 helper。 子系统：AI Management UI and API。
  - 验证：`npm run check:leaf-contract`

**635.** 为「AI Management UI and API」写一条「畸形输入绝不抛」的模糊测试：喂 null/数字/字符串/超大对象都返回安全值。
  - 说明：模糊测试。 子系统：AI Management UI and API。
  - 验证：`npm run check:leaf-contract`

**636.** 检查「AI Management UI and API」的默认值是否安全优先：不确定时偏向拒绝/降级而非放行。
  - 说明：安全默认。 子系统：AI Management UI and API。
  - 验证：`npm run check:change-safety`

**637.** 为「AI Management UI and API」补一条端点/URL 成形的确定性测试（不发真实请求，只断言拼出的字符串正确）。
  - 说明：URL 成形测试。 子系统：AI Management UI and API。
  - 验证：`npm run test:maintainer:ai-management`

**638.** 为「AI Management UI and API」的每个导出函数确认都有对应测试引用，无孤儿导出。
  - 说明：无孤儿导出。 子系统：AI Management UI and API。
  - 验证：`npm run check:leaf-contract`

**639.** 为「AI Management UI and API」增加预算/上限保护：循环或累积有明确终止条件，防止失控。
  - 说明：预算护栏。 子系统：AI Management UI and API。
  - 验证：`npm run test:maintainer:ai-management`

**640.** 把「AI Management UI and API」的巨型 switch 按 case 簇抽子分派器（pre-dispatch + 哨兵 fall-through）。
  - 说明：switch 拆解。 子系统：AI Management UI and API。
  - 验证：`npm run arch:god`

**641.** 为「AI Management UI and API」补一条幂等测试：同一操作跑两次结果一致、无副作用叠加。
  - 说明：幂等测试。 子系统：AI Management UI and API。
  - 验证：`npm run test:maintainer:ai-management`

**642.** 检查「AI Management UI and API」是否遵守单向依赖：叶子不得反向 require 宿主网关，需要就用 IoC 缝。
  - 说明：单向依赖。 子系统：AI Management UI and API。
  - 验证：`npm run check:leaf-contract`

**643.** 为「AI Management UI and API」写一份「新维护者一分钟上手」的结构表（文件→职责一行）。
  - 说明：一分钟上手。 子系统：AI Management UI and API。
  - 验证：`npm run maintainer:check`

**644.** 为「AI Management UI and API」的时间相关逻辑改为「时钟由调用方喂入」，让它可离线确定性测试。
  - 说明：时钟可注入。 子系统：AI Management UI and API。
  - 验证：`npm run test:maintainer:ai-management`

**645.** 给「AI Management UI and API」补一条「截断/采样时必须 log 丢了什么」的规则，杜绝静默截断。
  - 说明：别静默截断。 子系统：AI Management UI and API。
  - 验证：`npm run check:change-safety`

**646.** 为「AI Management UI and API」增加 dry-run 模式：先展示将要做什么，用户确认后才执行破坏性操作。
  - 说明：dry-run 先行。 子系统：AI Management UI and API。
  - 验证：`npm run check:small-model:safety`

**647.** 检查「AI Management UI and API」的 flag 语义：opt-in 严格只认 1/true，default-on 只认关键词才关。
  - 说明：门语义核对。 子系统：AI Management UI and API。
  - 验证：`npm run check:flag-registry`

**648.** 为「AI Management UI and API」补一条「父门关闭 → 子功能整体关闭」的门控测试。
  - 说明：父子门控。 子系统：AI Management UI and API。
  - 验证：`npm run check:flag-registry`

**649.** 把「AI Management UI and API」里的魔法数字提取为具名常量并注释其单位与来源。
  - 说明：消魔法数。 子系统：AI Management UI and API。
  - 验证：`npm run check:change-safety`

**650.** 为「AI Management UI and API」写一条向后兼容测试：旧输入格式仍能被正确解析。
  - 说明：向后兼容。 子系统：AI Management UI and API。
  - 验证：`npm run test:maintainer:ai-management`

**651.** 为「AI Management UI and API」的注册表新增一维时，确认聚合器与格式化器各只改一处（不 smear）。
  - 说明：改动不 smear。 子系统：AI Management UI and API。
  - 验证：`npm run test:maintainer:ai-management`

**652.** 检查「AI Management UI and API」抽取后宿主是否仍持有核心态，叶子只拿它需要的切片。
  - 说明：核心态留宿主。 子系统：AI Management UI and API。
  - 验证：`npm run arch:god`

**653.** 为「AI Management UI and API」补一条跨渠道/双通道一致性测试（如版本号 pip 与 npm 必须一致）。
  - 说明：双通道一致。 子系统：AI Management UI and API。
  - 验证：`npm run test:maintainer:ai-management`

**654.** 为「AI Management UI and API」的用户可见文案统一措辞与语气，避免同义词乱用误导弱模型。
  - 说明：文案统一。 子系统：AI Management UI and API。
  - 验证：`npm run maintainer:check`

**655.** 给「AI Management UI and API」增加一个健康分自检项，纳入 khy doctor 的输出。
  - 说明：并入自检。 子系统：AI Management UI and API。
  - 验证：`khy doctor`

**656.** 为「AI Management UI and API」补一条资源清理测试：临时文件用后即删、句柄关闭、无泄漏。
  - 说明：资源清理。 子系统：AI Management UI and API。
  - 验证：`npm run test:maintainer:ai-management`

**657.** 把「AI Management UI and API」里可能抛的第三方调用全部包进 try/catch 并给结构化 reason。
  - 说明：结构化容错。 子系统：AI Management UI and API。
  - 验证：`npm run check:change-safety`

**658.** 为「AI Management UI and API」写一条已知安全边界注释：明确它是 review aid 还是隔离边界，别夸大保证。
  - 说明：诚实边界。 子系统：AI Management UI and API。
  - 验证：`npm run check:leaf-contract`

**659.** 为「AI Management UI and API」补一条空结果早退路径：0 命中时跳过昂贵的下游步骤。
  - 说明：空结果早退。 子系统：AI Management UI and API。
  - 验证：`npm run test:maintainer:ai-management`

**660.** 检查「AI Management UI and API」的命令别名是否都路由到正确 handler，补一条 alias 路由测试。
  - 说明：别名路由。 子系统：AI Management UI and API。
  - 验证：`npm run test:maintainer:ai-management`

**661.** 为「AI Management UI and API」建立一条 memory 记录模板，把「为什么这么改」写进传承文档。
  - 说明：沉淀传承。 子系统：AI Management UI and API。
  - 验证：`npm run maintainer:check`

**662.** 为「Coding Projects (named workspaces + chat linkage)」增加一个 flag 门控的纯叶子：零 IO、绝不抛异常，先在 flagRegistry 登记 KHY_* 门再接线。
  - 说明：新能力走门控叶子。 子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run check:flag-registry`

**663.** 为「Coding Projects (named workspaces + chat linkage)」补一条 node:test，至少覆盖：正常路径、一个边界、一个畸形/空输入。
  - 说明：补测试。 子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run test:maintainer:projects`

**664.** 通读「Coding Projects (named workspaces + chat linkage)」核心文件，在顶部一句话写清职责，并给最难懂的分支补一句注释（不改行为）。
  - 说明：补可读性。 子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run test:maintainer:projects`

**665.** 扫描「Coding Projects (named workspaces + chat linkage)」是否有文件超 2500 行；若有，按同名 re-export + DI 抽一个聚焦叶子，保字节等价。
  - 说明：拆上帝文件。 子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run arch:god`

**666.** 给「Coding Projects (named workspaces + chat linkage)」的注册表叶子（_PROBES/_REPAIRS 之类）上方补 4 步 HOW-TO-EXTEND 抄写式注释。
  - 说明：注册表可扩展。 子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run maintainer:check`

**667.** 把「Coding Projects (named workspaces + chat linkage)」中每轮/每请求重复构建的 Set/正则/常量提升为模块常量（参考书 Ch2）。
  - 说明：别每轮重建。 子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run arch:god`

**668.** 为「Coding Projects (named workspaces + chat linkage)」增加一个只读诊断探针：只观测不修改，绝不写盘、绝不发网络。
  - 说明：加只读探针。 子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run test:maintainer:projects`

**669.** 为「Coding Projects (named workspaces + chat linkage)」增加一个「仅创建缺失项」的安全自愈：幂等、fail-soft、遇损坏拒删交人工。
  - 说明：加安全修复。 子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run test:maintainer:projects`

**670.** 给「Coding Projects (named workspaces + chat linkage)」的失败路径补一条指名道姓的可执行指引，把错误码翻译成用户能照做的步骤。
  - 说明：错误可执行。 子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run test:maintainer:projects`

**671.** 核对「Coding Projects (named workspaces + chat linkage)」的 verify 命令仍能一键复现绿灯；若命令漂移就修 package.json 别名。
  - 说明：verify 不漂移。 子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run test:maintainer:projects`

**672.** 为「Coding Projects (named workspaces + chat linkage)」新增功能前先在 flagRegistry 登记开关，并确认父门链正确（父关则子必关）。
  - 说明：门先登记。 子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run check:flag-registry`

**673.** 为「Coding Projects (named workspaces + chat linkage)」的输入做防御式校验：null/undefined/空数组/超长都有明确且安全的默认行为。
  - 说明：防御式输入。 子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run test:maintainer:projects`

**674.** 给「Coding Projects (named workspaces + chat linkage)」的外部调用加超时与失败兜底，任何一路挂了都 fail-soft 而不是整体崩。
  - 说明：失败兜底。 子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run test:maintainer:projects`

**675.** 为「Coding Projects (named workspaces + chat linkage)」补一条针对历史 bug 的回归测试，命名写清它守护的是哪个坑。
  - 说明：回归测试。 子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run test:maintainer:projects`

**676.** 检查「Coding Projects (named workspaces + chat linkage)」的日志：敏感值只打印长度不打印明文，绝不把 key/token 落盘或进日志。
  - 说明：日志脱敏。 子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run check:model-hardcoding`

**677.** 为「Coding Projects (named workspaces + chat linkage)」写一条 golden 测试：把一次已知正确的输出固化，防止未来悄悄漂移。
  - 说明：golden 固化。 子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run test:maintainer:projects`

**678.** 为「Coding Projects (named workspaces + chat linkage)」排查可变状态跨簇共享：若被多处重赋值，抽取时必须用 DI 注入而非复制。
  - 说明：共享态用 DI。 子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run arch:god`

**679.** 为「Coding Projects (named workspaces + chat linkage)」补一个进程级缓存的测试重置钩子，避免测试间状态串味。
  - 说明：缓存可重置。 子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run test:maintainer:projects`

**680.** 把「Coding Projects (named workspaces + chat linkage)」里散落的模型名/端点字面量收敛到单一权威来源（SSOT 访问器）。
  - 说明：收敛字面量。 子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run check:model-hardcoding`

**681.** 为「Coding Projects (named workspaces + chat linkage)」的公共函数补 JSDoc：写清意图、参数契约、返回值与副作用。
  - 说明：补 JSDoc。 子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run check:agent-rules`

**682.** 为「Coding Projects (named workspaces + chat linkage)」增加空参数补全保护：工具/命令缺关键参数时给出可推断的安全默认。
  - 说明：空参补全。 子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run test:maintainer:projects`

**683.** 为「Coding Projects (named workspaces + chat linkage)」抽取叶子后 grep 每个被调函数，凡叶子调而宿主定义者必迁或 DI。
  - 说明：查死引用。 子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run check:leaf-contract`

**684.** 为「Coding Projects (named workspaces + chat linkage)」写一条场景测试：模拟一个真实用户操作序列，断言端到端结果。
  - 说明：场景测试。 子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run test:maintainer:projects`

**685.** 把「Coding Projects (named workspaces + chat linkage)」里超过三层的嵌套条件重构为早返回（guard clause），降低阅读成本。
  - 说明：早返回。 子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run check:change-safety`

**686.** 为「Coding Projects (named workspaces + chat linkage)」补一条门关字节回退测试：关掉 KHY_* 门后行为逐字节回到改动前。
  - 说明：门关回退。 子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run check:flag-registry`

**687.** 给「Coding Projects (named workspaces + chat linkage)」仅用于匹配的正则去掉全局 g 标志，避免 lastIndex 状态残留。
  - 说明：正则去 g。 子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run test:maintainer:projects`

**688.** 为「Coding Projects (named workspaces + chat linkage)」登记进 docs/维护者/维护映射表.json（whenToUse/paths/docs/verify 齐全）。
  - 说明：登记映射表。 子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run maintainer:check`

**689.** 为「Coding Projects (named workspaces + chat linkage)」补一句「一句话验证脚本」并并入 test:maintainer:all。
  - 说明：一句话验证。 子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run maintainer:check`

**690.** 检查「Coding Projects (named workspaces + chat linkage)」的错误信息是否可执行：告诉用户「下一步做什么」而不仅是「哪里错了」。
  - 说明：可执行错误。 子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run test:maintainer:projects`

**691.** 为「Coding Projects (named workspaces + chat linkage)」的关键常量补注释解释「为什么是这个值」（保守高估、上限来源等）。
  - 说明：常量讲来源。 子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run check:change-safety`

**692.** 为「Coding Projects (named workspaces + chat linkage)」增加平台差异白名单（linux/windows/macos/android/ios），差异化规则收在注册表一处。
  - 说明：平台白名单。 子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run test:maintainer:projects`

**693.** 为「Coding Projects (named workspaces + chat linkage)」补一条并发/竞态测试：同一资源被两条路径同时访问时结果仍正确。
  - 说明：并发测试。 子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run test:maintainer:projects`

**694.** 把「Coding Projects (named workspaces + chat linkage)」里手写的重复逻辑抽成一个纯 helper，并给它单测。
  - 说明：抽纯 helper。 子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run check:leaf-contract`

**695.** 为「Coding Projects (named workspaces + chat linkage)」写一条「畸形输入绝不抛」的模糊测试：喂 null/数字/字符串/超大对象都返回安全值。
  - 说明：模糊测试。 子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run check:leaf-contract`

**696.** 检查「Coding Projects (named workspaces + chat linkage)」的默认值是否安全优先：不确定时偏向拒绝/降级而非放行。
  - 说明：安全默认。 子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run check:change-safety`

**697.** 为「Coding Projects (named workspaces + chat linkage)」补一条端点/URL 成形的确定性测试（不发真实请求，只断言拼出的字符串正确）。
  - 说明：URL 成形测试。 子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run test:maintainer:projects`

**698.** 为「Coding Projects (named workspaces + chat linkage)」的每个导出函数确认都有对应测试引用，无孤儿导出。
  - 说明：无孤儿导出。 子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run check:leaf-contract`

**699.** 为「Coding Projects (named workspaces + chat linkage)」增加预算/上限保护：循环或累积有明确终止条件，防止失控。
  - 说明：预算护栏。 子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run test:maintainer:projects`

**700.** 把「Coding Projects (named workspaces + chat linkage)」的巨型 switch 按 case 簇抽子分派器（pre-dispatch + 哨兵 fall-through）。
  - 说明：switch 拆解。 子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run arch:god`

**701.** 为「Coding Projects (named workspaces + chat linkage)」补一条幂等测试：同一操作跑两次结果一致、无副作用叠加。
  - 说明：幂等测试。 子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run test:maintainer:projects`

**702.** 检查「Coding Projects (named workspaces + chat linkage)」是否遵守单向依赖：叶子不得反向 require 宿主网关，需要就用 IoC 缝。
  - 说明：单向依赖。 子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run check:leaf-contract`

**703.** 为「Coding Projects (named workspaces + chat linkage)」写一份「新维护者一分钟上手」的结构表（文件→职责一行）。
  - 说明：一分钟上手。 子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run maintainer:check`

**704.** 为「Coding Projects (named workspaces + chat linkage)」的时间相关逻辑改为「时钟由调用方喂入」，让它可离线确定性测试。
  - 说明：时钟可注入。 子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run test:maintainer:projects`

**705.** 给「Coding Projects (named workspaces + chat linkage)」补一条「截断/采样时必须 log 丢了什么」的规则，杜绝静默截断。
  - 说明：别静默截断。 子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run check:change-safety`

**706.** 为「Coding Projects (named workspaces + chat linkage)」增加 dry-run 模式：先展示将要做什么，用户确认后才执行破坏性操作。
  - 说明：dry-run 先行。 子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run check:small-model:safety`

**707.** 检查「Coding Projects (named workspaces + chat linkage)」的 flag 语义：opt-in 严格只认 1/true，default-on 只认关键词才关。
  - 说明：门语义核对。 子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run check:flag-registry`

**708.** 为「Coding Projects (named workspaces + chat linkage)」补一条「父门关闭 → 子功能整体关闭」的门控测试。
  - 说明：父子门控。 子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run check:flag-registry`

**709.** 把「Coding Projects (named workspaces + chat linkage)」里的魔法数字提取为具名常量并注释其单位与来源。
  - 说明：消魔法数。 子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run check:change-safety`

**710.** 为「Coding Projects (named workspaces + chat linkage)」写一条向后兼容测试：旧输入格式仍能被正确解析。
  - 说明：向后兼容。 子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run test:maintainer:projects`

**711.** 为「Coding Projects (named workspaces + chat linkage)」的注册表新增一维时，确认聚合器与格式化器各只改一处（不 smear）。
  - 说明：改动不 smear。 子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run test:maintainer:projects`

**712.** 检查「Coding Projects (named workspaces + chat linkage)」抽取后宿主是否仍持有核心态，叶子只拿它需要的切片。
  - 说明：核心态留宿主。 子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run arch:god`

**713.** 为「Coding Projects (named workspaces + chat linkage)」补一条跨渠道/双通道一致性测试（如版本号 pip 与 npm 必须一致）。
  - 说明：双通道一致。 子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run test:maintainer:projects`

**714.** 为「Coding Projects (named workspaces + chat linkage)」的用户可见文案统一措辞与语气，避免同义词乱用误导弱模型。
  - 说明：文案统一。 子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run maintainer:check`

**715.** 给「Coding Projects (named workspaces + chat linkage)」增加一个健康分自检项，纳入 khy doctor 的输出。
  - 说明：并入自检。 子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`khy doctor`

**716.** 为「Coding Projects (named workspaces + chat linkage)」补一条资源清理测试：临时文件用后即删、句柄关闭、无泄漏。
  - 说明：资源清理。 子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run test:maintainer:projects`

**717.** 把「Coding Projects (named workspaces + chat linkage)」里可能抛的第三方调用全部包进 try/catch 并给结构化 reason。
  - 说明：结构化容错。 子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run check:change-safety`

**718.** 为「Coding Projects (named workspaces + chat linkage)」写一条已知安全边界注释：明确它是 review aid 还是隔离边界，别夸大保证。
  - 说明：诚实边界。 子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run check:leaf-contract`

**719.** 为「Coding Projects (named workspaces + chat linkage)」补一条空结果早退路径：0 命中时跳过昂贵的下游步骤。
  - 说明：空结果早退。 子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run test:maintainer:projects`

**720.** 检查「Coding Projects (named workspaces + chat linkage)」的命令别名是否都路由到正确 handler，补一条 alias 路由测试。
  - 说明：别名路由。 子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run test:maintainer:projects`

**721.** 为「Coding Projects (named workspaces + chat linkage)」建立一条 memory 记录模板，把「为什么这么改」写进传承文档。
  - 说明：沉淀传承。 子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run maintainer:check`

**722.** 为「Workspace, Publish, and Verification Commands」增加一个 flag 门控的纯叶子：零 IO、绝不抛异常，先在 flagRegistry 登记 KHY_* 门再接线。
  - 说明：新能力走门控叶子。 子系统：Workspace, Publish, and Verification Commands。
  - 验证：`npm run check:flag-registry`

**723.** 为「Workspace, Publish, and Verification Commands」补一条 node:test，至少覆盖：正常路径、一个边界、一个畸形/空输入。
  - 说明：补测试。 子系统：Workspace, Publish, and Verification Commands。
  - 验证：`npm run test:maintainer:publish`

**724.** 通读「Workspace, Publish, and Verification Commands」核心文件，在顶部一句话写清职责，并给最难懂的分支补一句注释（不改行为）。
  - 说明：补可读性。 子系统：Workspace, Publish, and Verification Commands。
  - 验证：`npm run test:maintainer:publish`

**725.** 扫描「Workspace, Publish, and Verification Commands」是否有文件超 2500 行；若有，按同名 re-export + DI 抽一个聚焦叶子，保字节等价。
  - 说明：拆上帝文件。 子系统：Workspace, Publish, and Verification Commands。
  - 验证：`npm run arch:god`

**726.** 给「Workspace, Publish, and Verification Commands」的注册表叶子（_PROBES/_REPAIRS 之类）上方补 4 步 HOW-TO-EXTEND 抄写式注释。
  - 说明：注册表可扩展。 子系统：Workspace, Publish, and Verification Commands。
  - 验证：`npm run maintainer:check`

**727.** 把「Workspace, Publish, and Verification Commands」中每轮/每请求重复构建的 Set/正则/常量提升为模块常量（参考书 Ch2）。
  - 说明：别每轮重建。 子系统：Workspace, Publish, and Verification Commands。
  - 验证：`npm run arch:god`

**728.** 为「Workspace, Publish, and Verification Commands」增加一个只读诊断探针：只观测不修改，绝不写盘、绝不发网络。
  - 说明：加只读探针。 子系统：Workspace, Publish, and Verification Commands。
  - 验证：`npm run test:maintainer:publish`

**729.** 为「Workspace, Publish, and Verification Commands」增加一个「仅创建缺失项」的安全自愈：幂等、fail-soft、遇损坏拒删交人工。
  - 说明：加安全修复。 子系统：Workspace, Publish, and Verification Commands。
  - 验证：`npm run test:maintainer:publish`

**730.** 给「Workspace, Publish, and Verification Commands」的失败路径补一条指名道姓的可执行指引，把错误码翻译成用户能照做的步骤。
  - 说明：错误可执行。 子系统：Workspace, Publish, and Verification Commands。
  - 验证：`npm run test:maintainer:publish`

**731.** 核对「Workspace, Publish, and Verification Commands」的 verify 命令仍能一键复现绿灯；若命令漂移就修 package.json 别名。
  - 说明：verify 不漂移。 子系统：Workspace, Publish, and Verification Commands。
  - 验证：`npm run test:maintainer:publish`

**732.** 为「Workspace, Publish, and Verification Commands」新增功能前先在 flagRegistry 登记开关，并确认父门链正确（父关则子必关）。
  - 说明：门先登记。 子系统：Workspace, Publish, and Verification Commands。
  - 验证：`npm run check:flag-registry`

**733.** 为「Workspace, Publish, and Verification Commands」的输入做防御式校验：null/undefined/空数组/超长都有明确且安全的默认行为。
  - 说明：防御式输入。 子系统：Workspace, Publish, and Verification Commands。
  - 验证：`npm run test:maintainer:publish`

**734.** 给「Workspace, Publish, and Verification Commands」的外部调用加超时与失败兜底，任何一路挂了都 fail-soft 而不是整体崩。
  - 说明：失败兜底。 子系统：Workspace, Publish, and Verification Commands。
  - 验证：`npm run test:maintainer:publish`

**735.** 为「Workspace, Publish, and Verification Commands」补一条针对历史 bug 的回归测试，命名写清它守护的是哪个坑。
  - 说明：回归测试。 子系统：Workspace, Publish, and Verification Commands。
  - 验证：`npm run test:maintainer:publish`

**736.** 检查「Workspace, Publish, and Verification Commands」的日志：敏感值只打印长度不打印明文，绝不把 key/token 落盘或进日志。
  - 说明：日志脱敏。 子系统：Workspace, Publish, and Verification Commands。
  - 验证：`npm run check:model-hardcoding`

**737.** 为「Workspace, Publish, and Verification Commands」写一条 golden 测试：把一次已知正确的输出固化，防止未来悄悄漂移。
  - 说明：golden 固化。 子系统：Workspace, Publish, and Verification Commands。
  - 验证：`npm run test:maintainer:publish`

**738.** 为「Workspace, Publish, and Verification Commands」排查可变状态跨簇共享：若被多处重赋值，抽取时必须用 DI 注入而非复制。
  - 说明：共享态用 DI。 子系统：Workspace, Publish, and Verification Commands。
  - 验证：`npm run arch:god`

**739.** 为「Workspace, Publish, and Verification Commands」补一个进程级缓存的测试重置钩子，避免测试间状态串味。
  - 说明：缓存可重置。 子系统：Workspace, Publish, and Verification Commands。
  - 验证：`npm run test:maintainer:publish`

**740.** 把「Workspace, Publish, and Verification Commands」里散落的模型名/端点字面量收敛到单一权威来源（SSOT 访问器）。
  - 说明：收敛字面量。 子系统：Workspace, Publish, and Verification Commands。
  - 验证：`npm run check:model-hardcoding`

**741.** 为「Workspace, Publish, and Verification Commands」的公共函数补 JSDoc：写清意图、参数契约、返回值与副作用。
  - 说明：补 JSDoc。 子系统：Workspace, Publish, and Verification Commands。
  - 验证：`npm run check:agent-rules`

**742.** 为「Workspace, Publish, and Verification Commands」增加空参数补全保护：工具/命令缺关键参数时给出可推断的安全默认。
  - 说明：空参补全。 子系统：Workspace, Publish, and Verification Commands。
  - 验证：`npm run test:maintainer:publish`

**743.** 为「Workspace, Publish, and Verification Commands」抽取叶子后 grep 每个被调函数，凡叶子调而宿主定义者必迁或 DI。
  - 说明：查死引用。 子系统：Workspace, Publish, and Verification Commands。
  - 验证：`npm run check:leaf-contract`

**744.** 为「Workspace, Publish, and Verification Commands」写一条场景测试：模拟一个真实用户操作序列，断言端到端结果。
  - 说明：场景测试。 子系统：Workspace, Publish, and Verification Commands。
  - 验证：`npm run test:maintainer:publish`

**745.** 把「Workspace, Publish, and Verification Commands」里超过三层的嵌套条件重构为早返回（guard clause），降低阅读成本。
  - 说明：早返回。 子系统：Workspace, Publish, and Verification Commands。
  - 验证：`npm run check:change-safety`

**746.** 为「Workspace, Publish, and Verification Commands」补一条门关字节回退测试：关掉 KHY_* 门后行为逐字节回到改动前。
  - 说明：门关回退。 子系统：Workspace, Publish, and Verification Commands。
  - 验证：`npm run check:flag-registry`

**747.** 给「Workspace, Publish, and Verification Commands」仅用于匹配的正则去掉全局 g 标志，避免 lastIndex 状态残留。
  - 说明：正则去 g。 子系统：Workspace, Publish, and Verification Commands。
  - 验证：`npm run test:maintainer:publish`

**748.** 为「Workspace, Publish, and Verification Commands」登记进 docs/维护者/维护映射表.json（whenToUse/paths/docs/verify 齐全）。
  - 说明：登记映射表。 子系统：Workspace, Publish, and Verification Commands。
  - 验证：`npm run maintainer:check`

**749.** 为「Workspace, Publish, and Verification Commands」补一句「一句话验证脚本」并并入 test:maintainer:all。
  - 说明：一句话验证。 子系统：Workspace, Publish, and Verification Commands。
  - 验证：`npm run maintainer:check`

**750.** 检查「Workspace, Publish, and Verification Commands」的错误信息是否可执行：告诉用户「下一步做什么」而不仅是「哪里错了」。
  - 说明：可执行错误。 子系统：Workspace, Publish, and Verification Commands。
  - 验证：`npm run test:maintainer:publish`

**751.** 为「Workspace, Publish, and Verification Commands」的关键常量补注释解释「为什么是这个值」（保守高估、上限来源等）。
  - 说明：常量讲来源。 子系统：Workspace, Publish, and Verification Commands。
  - 验证：`npm run check:change-safety`

**752.** 为「Workspace, Publish, and Verification Commands」增加平台差异白名单（linux/windows/macos/android/ios），差异化规则收在注册表一处。
  - 说明：平台白名单。 子系统：Workspace, Publish, and Verification Commands。
  - 验证：`npm run test:maintainer:publish`

**753.** 为「Workspace, Publish, and Verification Commands」补一条并发/竞态测试：同一资源被两条路径同时访问时结果仍正确。
  - 说明：并发测试。 子系统：Workspace, Publish, and Verification Commands。
  - 验证：`npm run test:maintainer:publish`

**754.** 把「Workspace, Publish, and Verification Commands」里手写的重复逻辑抽成一个纯 helper，并给它单测。
  - 说明：抽纯 helper。 子系统：Workspace, Publish, and Verification Commands。
  - 验证：`npm run check:leaf-contract`

**755.** 为「Workspace, Publish, and Verification Commands」写一条「畸形输入绝不抛」的模糊测试：喂 null/数字/字符串/超大对象都返回安全值。
  - 说明：模糊测试。 子系统：Workspace, Publish, and Verification Commands。
  - 验证：`npm run check:leaf-contract`

**756.** 检查「Workspace, Publish, and Verification Commands」的默认值是否安全优先：不确定时偏向拒绝/降级而非放行。
  - 说明：安全默认。 子系统：Workspace, Publish, and Verification Commands。
  - 验证：`npm run check:change-safety`

**757.** 为「Workspace, Publish, and Verification Commands」补一条端点/URL 成形的确定性测试（不发真实请求，只断言拼出的字符串正确）。
  - 说明：URL 成形测试。 子系统：Workspace, Publish, and Verification Commands。
  - 验证：`npm run test:maintainer:publish`

**758.** 为「Workspace, Publish, and Verification Commands」的每个导出函数确认都有对应测试引用，无孤儿导出。
  - 说明：无孤儿导出。 子系统：Workspace, Publish, and Verification Commands。
  - 验证：`npm run check:leaf-contract`

**759.** 为「Workspace, Publish, and Verification Commands」增加预算/上限保护：循环或累积有明确终止条件，防止失控。
  - 说明：预算护栏。 子系统：Workspace, Publish, and Verification Commands。
  - 验证：`npm run test:maintainer:publish`

**760.** 把「Workspace, Publish, and Verification Commands」的巨型 switch 按 case 簇抽子分派器（pre-dispatch + 哨兵 fall-through）。
  - 说明：switch 拆解。 子系统：Workspace, Publish, and Verification Commands。
  - 验证：`npm run arch:god`

**761.** 为「Workspace, Publish, and Verification Commands」补一条幂等测试：同一操作跑两次结果一致、无副作用叠加。
  - 说明：幂等测试。 子系统：Workspace, Publish, and Verification Commands。
  - 验证：`npm run test:maintainer:publish`

**762.** 检查「Workspace, Publish, and Verification Commands」是否遵守单向依赖：叶子不得反向 require 宿主网关，需要就用 IoC 缝。
  - 说明：单向依赖。 子系统：Workspace, Publish, and Verification Commands。
  - 验证：`npm run check:leaf-contract`

**763.** 为「Workspace, Publish, and Verification Commands」写一份「新维护者一分钟上手」的结构表（文件→职责一行）。
  - 说明：一分钟上手。 子系统：Workspace, Publish, and Verification Commands。
  - 验证：`npm run maintainer:check`

**764.** 为「Workspace, Publish, and Verification Commands」的时间相关逻辑改为「时钟由调用方喂入」，让它可离线确定性测试。
  - 说明：时钟可注入。 子系统：Workspace, Publish, and Verification Commands。
  - 验证：`npm run test:maintainer:publish`

**765.** 给「Workspace, Publish, and Verification Commands」补一条「截断/采样时必须 log 丢了什么」的规则，杜绝静默截断。
  - 说明：别静默截断。 子系统：Workspace, Publish, and Verification Commands。
  - 验证：`npm run check:change-safety`

**766.** 为「Workspace, Publish, and Verification Commands」增加 dry-run 模式：先展示将要做什么，用户确认后才执行破坏性操作。
  - 说明：dry-run 先行。 子系统：Workspace, Publish, and Verification Commands。
  - 验证：`npm run check:small-model:safety`

**767.** 检查「Workspace, Publish, and Verification Commands」的 flag 语义：opt-in 严格只认 1/true，default-on 只认关键词才关。
  - 说明：门语义核对。 子系统：Workspace, Publish, and Verification Commands。
  - 验证：`npm run check:flag-registry`

**768.** 为「Workspace, Publish, and Verification Commands」补一条「父门关闭 → 子功能整体关闭」的门控测试。
  - 说明：父子门控。 子系统：Workspace, Publish, and Verification Commands。
  - 验证：`npm run check:flag-registry`

**769.** 把「Workspace, Publish, and Verification Commands」里的魔法数字提取为具名常量并注释其单位与来源。
  - 说明：消魔法数。 子系统：Workspace, Publish, and Verification Commands。
  - 验证：`npm run check:change-safety`

**770.** 为「Workspace, Publish, and Verification Commands」写一条向后兼容测试：旧输入格式仍能被正确解析。
  - 说明：向后兼容。 子系统：Workspace, Publish, and Verification Commands。
  - 验证：`npm run test:maintainer:publish`

**771.** 为「Workspace, Publish, and Verification Commands」的注册表新增一维时，确认聚合器与格式化器各只改一处（不 smear）。
  - 说明：改动不 smear。 子系统：Workspace, Publish, and Verification Commands。
  - 验证：`npm run test:maintainer:publish`

**772.** 检查「Workspace, Publish, and Verification Commands」抽取后宿主是否仍持有核心态，叶子只拿它需要的切片。
  - 说明：核心态留宿主。 子系统：Workspace, Publish, and Verification Commands。
  - 验证：`npm run arch:god`

**773.** 为「Workspace, Publish, and Verification Commands」补一条跨渠道/双通道一致性测试（如版本号 pip 与 npm 必须一致）。
  - 说明：双通道一致。 子系统：Workspace, Publish, and Verification Commands。
  - 验证：`npm run test:maintainer:publish`

**774.** 为「Workspace, Publish, and Verification Commands」的用户可见文案统一措辞与语气，避免同义词乱用误导弱模型。
  - 说明：文案统一。 子系统：Workspace, Publish, and Verification Commands。
  - 验证：`npm run maintainer:check`

**775.** 给「Workspace, Publish, and Verification Commands」增加一个健康分自检项，纳入 khy doctor 的输出。
  - 说明：并入自检。 子系统：Workspace, Publish, and Verification Commands。
  - 验证：`khy doctor`

**776.** 为「Workspace, Publish, and Verification Commands」补一条资源清理测试：临时文件用后即删、句柄关闭、无泄漏。
  - 说明：资源清理。 子系统：Workspace, Publish, and Verification Commands。
  - 验证：`npm run test:maintainer:publish`

**777.** 把「Workspace, Publish, and Verification Commands」里可能抛的第三方调用全部包进 try/catch 并给结构化 reason。
  - 说明：结构化容错。 子系统：Workspace, Publish, and Verification Commands。
  - 验证：`npm run check:change-safety`

**778.** 为「Workspace, Publish, and Verification Commands」写一条已知安全边界注释：明确它是 review aid 还是隔离边界，别夸大保证。
  - 说明：诚实边界。 子系统：Workspace, Publish, and Verification Commands。
  - 验证：`npm run check:leaf-contract`

**779.** 为「Workspace, Publish, and Verification Commands」补一条空结果早退路径：0 命中时跳过昂贵的下游步骤。
  - 说明：空结果早退。 子系统：Workspace, Publish, and Verification Commands。
  - 验证：`npm run test:maintainer:publish`

**780.** 检查「Workspace, Publish, and Verification Commands」的命令别名是否都路由到正确 handler，补一条 alias 路由测试。
  - 说明：别名路由。 子系统：Workspace, Publish, and Verification Commands。
  - 验证：`npm run test:maintainer:publish`

**781.** 为「Workspace, Publish, and Verification Commands」建立一条 memory 记录模板，把「为什么这么改」写进传承文档。
  - 说明：沉淀传承。 子系统：Workspace, Publish, and Verification Commands。
  - 验证：`npm run maintainer:check`

**782.** 为「Maintenance Safety and Rule Gates」增加一个 flag 门控的纯叶子：零 IO、绝不抛异常，先在 flagRegistry 登记 KHY_* 门再接线。
  - 说明：新能力走门控叶子。 子系统：Maintenance Safety and Rule Gates。
  - 验证：`npm run check:flag-registry`

**783.** 为「Maintenance Safety and Rule Gates」补一条 node:test，至少覆盖：正常路径、一个边界、一个畸形/空输入。
  - 说明：补测试。 子系统：Maintenance Safety and Rule Gates。
  - 验证：`npm run check:maintainer:safety`

**784.** 通读「Maintenance Safety and Rule Gates」核心文件，在顶部一句话写清职责，并给最难懂的分支补一句注释（不改行为）。
  - 说明：补可读性。 子系统：Maintenance Safety and Rule Gates。
  - 验证：`npm run check:maintainer:safety`

**785.** 扫描「Maintenance Safety and Rule Gates」是否有文件超 2500 行；若有，按同名 re-export + DI 抽一个聚焦叶子，保字节等价。
  - 说明：拆上帝文件。 子系统：Maintenance Safety and Rule Gates。
  - 验证：`npm run arch:god`

**786.** 给「Maintenance Safety and Rule Gates」的注册表叶子（_PROBES/_REPAIRS 之类）上方补 4 步 HOW-TO-EXTEND 抄写式注释。
  - 说明：注册表可扩展。 子系统：Maintenance Safety and Rule Gates。
  - 验证：`npm run maintainer:check`

**787.** 把「Maintenance Safety and Rule Gates」中每轮/每请求重复构建的 Set/正则/常量提升为模块常量（参考书 Ch2）。
  - 说明：别每轮重建。 子系统：Maintenance Safety and Rule Gates。
  - 验证：`npm run arch:god`

**788.** 为「Maintenance Safety and Rule Gates」增加一个只读诊断探针：只观测不修改，绝不写盘、绝不发网络。
  - 说明：加只读探针。 子系统：Maintenance Safety and Rule Gates。
  - 验证：`npm run check:maintainer:safety`

**789.** 为「Maintenance Safety and Rule Gates」增加一个「仅创建缺失项」的安全自愈：幂等、fail-soft、遇损坏拒删交人工。
  - 说明：加安全修复。 子系统：Maintenance Safety and Rule Gates。
  - 验证：`npm run check:maintainer:safety`

**790.** 给「Maintenance Safety and Rule Gates」的失败路径补一条指名道姓的可执行指引，把错误码翻译成用户能照做的步骤。
  - 说明：错误可执行。 子系统：Maintenance Safety and Rule Gates。
  - 验证：`npm run check:maintainer:safety`

**791.** 核对「Maintenance Safety and Rule Gates」的 verify 命令仍能一键复现绿灯；若命令漂移就修 package.json 别名。
  - 说明：verify 不漂移。 子系统：Maintenance Safety and Rule Gates。
  - 验证：`npm run check:maintainer:safety`

**792.** 为「Maintenance Safety and Rule Gates」新增功能前先在 flagRegistry 登记开关，并确认父门链正确（父关则子必关）。
  - 说明：门先登记。 子系统：Maintenance Safety and Rule Gates。
  - 验证：`npm run check:flag-registry`

**793.** 为「Maintenance Safety and Rule Gates」的输入做防御式校验：null/undefined/空数组/超长都有明确且安全的默认行为。
  - 说明：防御式输入。 子系统：Maintenance Safety and Rule Gates。
  - 验证：`npm run check:maintainer:safety`

**794.** 给「Maintenance Safety and Rule Gates」的外部调用加超时与失败兜底，任何一路挂了都 fail-soft 而不是整体崩。
  - 说明：失败兜底。 子系统：Maintenance Safety and Rule Gates。
  - 验证：`npm run check:maintainer:safety`

**795.** 为「Maintenance Safety and Rule Gates」补一条针对历史 bug 的回归测试，命名写清它守护的是哪个坑。
  - 说明：回归测试。 子系统：Maintenance Safety and Rule Gates。
  - 验证：`npm run check:maintainer:safety`

**796.** 检查「Maintenance Safety and Rule Gates」的日志：敏感值只打印长度不打印明文，绝不把 key/token 落盘或进日志。
  - 说明：日志脱敏。 子系统：Maintenance Safety and Rule Gates。
  - 验证：`npm run check:model-hardcoding`

**797.** 为「Maintenance Safety and Rule Gates」写一条 golden 测试：把一次已知正确的输出固化，防止未来悄悄漂移。
  - 说明：golden 固化。 子系统：Maintenance Safety and Rule Gates。
  - 验证：`npm run check:maintainer:safety`

**798.** 为「Maintenance Safety and Rule Gates」排查可变状态跨簇共享：若被多处重赋值，抽取时必须用 DI 注入而非复制。
  - 说明：共享态用 DI。 子系统：Maintenance Safety and Rule Gates。
  - 验证：`npm run arch:god`

**799.** 为「Maintenance Safety and Rule Gates」补一个进程级缓存的测试重置钩子，避免测试间状态串味。
  - 说明：缓存可重置。 子系统：Maintenance Safety and Rule Gates。
  - 验证：`npm run check:maintainer:safety`

**800.** 把「Maintenance Safety and Rule Gates」里散落的模型名/端点字面量收敛到单一权威来源（SSOT 访问器）。
  - 说明：收敛字面量。 子系统：Maintenance Safety and Rule Gates。
  - 验证：`npm run check:model-hardcoding`

**801.** 为「Maintenance Safety and Rule Gates」的公共函数补 JSDoc：写清意图、参数契约、返回值与副作用。
  - 说明：补 JSDoc。 子系统：Maintenance Safety and Rule Gates。
  - 验证：`npm run check:agent-rules`

**802.** 为「Maintenance Safety and Rule Gates」增加空参数补全保护：工具/命令缺关键参数时给出可推断的安全默认。
  - 说明：空参补全。 子系统：Maintenance Safety and Rule Gates。
  - 验证：`npm run check:maintainer:safety`

**803.** 为「Maintenance Safety and Rule Gates」抽取叶子后 grep 每个被调函数，凡叶子调而宿主定义者必迁或 DI。
  - 说明：查死引用。 子系统：Maintenance Safety and Rule Gates。
  - 验证：`npm run check:leaf-contract`

**804.** 为「Maintenance Safety and Rule Gates」写一条场景测试：模拟一个真实用户操作序列，断言端到端结果。
  - 说明：场景测试。 子系统：Maintenance Safety and Rule Gates。
  - 验证：`npm run check:maintainer:safety`

**805.** 把「Maintenance Safety and Rule Gates」里超过三层的嵌套条件重构为早返回（guard clause），降低阅读成本。
  - 说明：早返回。 子系统：Maintenance Safety and Rule Gates。
  - 验证：`npm run check:change-safety`

**806.** 为「Maintenance Safety and Rule Gates」补一条门关字节回退测试：关掉 KHY_* 门后行为逐字节回到改动前。
  - 说明：门关回退。 子系统：Maintenance Safety and Rule Gates。
  - 验证：`npm run check:flag-registry`

**807.** 给「Maintenance Safety and Rule Gates」仅用于匹配的正则去掉全局 g 标志，避免 lastIndex 状态残留。
  - 说明：正则去 g。 子系统：Maintenance Safety and Rule Gates。
  - 验证：`npm run check:maintainer:safety`

**808.** 为「Maintenance Safety and Rule Gates」登记进 docs/维护者/维护映射表.json（whenToUse/paths/docs/verify 齐全）。
  - 说明：登记映射表。 子系统：Maintenance Safety and Rule Gates。
  - 验证：`npm run maintainer:check`

**809.** 为「Maintenance Safety and Rule Gates」补一句「一句话验证脚本」并并入 test:maintainer:all。
  - 说明：一句话验证。 子系统：Maintenance Safety and Rule Gates。
  - 验证：`npm run maintainer:check`

**810.** 检查「Maintenance Safety and Rule Gates」的错误信息是否可执行：告诉用户「下一步做什么」而不仅是「哪里错了」。
  - 说明：可执行错误。 子系统：Maintenance Safety and Rule Gates。
  - 验证：`npm run check:maintainer:safety`

**811.** 为「Maintenance Safety and Rule Gates」的关键常量补注释解释「为什么是这个值」（保守高估、上限来源等）。
  - 说明：常量讲来源。 子系统：Maintenance Safety and Rule Gates。
  - 验证：`npm run check:change-safety`

**812.** 为「Maintenance Safety and Rule Gates」增加平台差异白名单（linux/windows/macos/android/ios），差异化规则收在注册表一处。
  - 说明：平台白名单。 子系统：Maintenance Safety and Rule Gates。
  - 验证：`npm run check:maintainer:safety`

**813.** 为「Maintenance Safety and Rule Gates」补一条并发/竞态测试：同一资源被两条路径同时访问时结果仍正确。
  - 说明：并发测试。 子系统：Maintenance Safety and Rule Gates。
  - 验证：`npm run check:maintainer:safety`

**814.** 把「Maintenance Safety and Rule Gates」里手写的重复逻辑抽成一个纯 helper，并给它单测。
  - 说明：抽纯 helper。 子系统：Maintenance Safety and Rule Gates。
  - 验证：`npm run check:leaf-contract`

**815.** 为「Maintenance Safety and Rule Gates」写一条「畸形输入绝不抛」的模糊测试：喂 null/数字/字符串/超大对象都返回安全值。
  - 说明：模糊测试。 子系统：Maintenance Safety and Rule Gates。
  - 验证：`npm run check:leaf-contract`

**816.** 检查「Maintenance Safety and Rule Gates」的默认值是否安全优先：不确定时偏向拒绝/降级而非放行。
  - 说明：安全默认。 子系统：Maintenance Safety and Rule Gates。
  - 验证：`npm run check:change-safety`

**817.** 为「Maintenance Safety and Rule Gates」补一条端点/URL 成形的确定性测试（不发真实请求，只断言拼出的字符串正确）。
  - 说明：URL 成形测试。 子系统：Maintenance Safety and Rule Gates。
  - 验证：`npm run check:maintainer:safety`

**818.** 为「Maintenance Safety and Rule Gates」的每个导出函数确认都有对应测试引用，无孤儿导出。
  - 说明：无孤儿导出。 子系统：Maintenance Safety and Rule Gates。
  - 验证：`npm run check:leaf-contract`

**819.** 为「Maintenance Safety and Rule Gates」增加预算/上限保护：循环或累积有明确终止条件，防止失控。
  - 说明：预算护栏。 子系统：Maintenance Safety and Rule Gates。
  - 验证：`npm run check:maintainer:safety`

**820.** 把「Maintenance Safety and Rule Gates」的巨型 switch 按 case 簇抽子分派器（pre-dispatch + 哨兵 fall-through）。
  - 说明：switch 拆解。 子系统：Maintenance Safety and Rule Gates。
  - 验证：`npm run arch:god`

**821.** 为「Maintenance Safety and Rule Gates」补一条幂等测试：同一操作跑两次结果一致、无副作用叠加。
  - 说明：幂等测试。 子系统：Maintenance Safety and Rule Gates。
  - 验证：`npm run check:maintainer:safety`

**822.** 检查「Maintenance Safety and Rule Gates」是否遵守单向依赖：叶子不得反向 require 宿主网关，需要就用 IoC 缝。
  - 说明：单向依赖。 子系统：Maintenance Safety and Rule Gates。
  - 验证：`npm run check:leaf-contract`

**823.** 为「Maintenance Safety and Rule Gates」写一份「新维护者一分钟上手」的结构表（文件→职责一行）。
  - 说明：一分钟上手。 子系统：Maintenance Safety and Rule Gates。
  - 验证：`npm run maintainer:check`

**824.** 为「Maintenance Safety and Rule Gates」的时间相关逻辑改为「时钟由调用方喂入」，让它可离线确定性测试。
  - 说明：时钟可注入。 子系统：Maintenance Safety and Rule Gates。
  - 验证：`npm run check:maintainer:safety`

**825.** 给「Maintenance Safety and Rule Gates」补一条「截断/采样时必须 log 丢了什么」的规则，杜绝静默截断。
  - 说明：别静默截断。 子系统：Maintenance Safety and Rule Gates。
  - 验证：`npm run check:change-safety`

**826.** 为「Maintenance Safety and Rule Gates」增加 dry-run 模式：先展示将要做什么，用户确认后才执行破坏性操作。
  - 说明：dry-run 先行。 子系统：Maintenance Safety and Rule Gates。
  - 验证：`npm run check:small-model:safety`

**827.** 检查「Maintenance Safety and Rule Gates」的 flag 语义：opt-in 严格只认 1/true，default-on 只认关键词才关。
  - 说明：门语义核对。 子系统：Maintenance Safety and Rule Gates。
  - 验证：`npm run check:flag-registry`

**828.** 为「Maintenance Safety and Rule Gates」补一条「父门关闭 → 子功能整体关闭」的门控测试。
  - 说明：父子门控。 子系统：Maintenance Safety and Rule Gates。
  - 验证：`npm run check:flag-registry`

**829.** 把「Maintenance Safety and Rule Gates」里的魔法数字提取为具名常量并注释其单位与来源。
  - 说明：消魔法数。 子系统：Maintenance Safety and Rule Gates。
  - 验证：`npm run check:change-safety`

**830.** 为「Maintenance Safety and Rule Gates」写一条向后兼容测试：旧输入格式仍能被正确解析。
  - 说明：向后兼容。 子系统：Maintenance Safety and Rule Gates。
  - 验证：`npm run check:maintainer:safety`

**831.** 为「Maintenance Safety and Rule Gates」的注册表新增一维时，确认聚合器与格式化器各只改一处（不 smear）。
  - 说明：改动不 smear。 子系统：Maintenance Safety and Rule Gates。
  - 验证：`npm run check:maintainer:safety`

**832.** 检查「Maintenance Safety and Rule Gates」抽取后宿主是否仍持有核心态，叶子只拿它需要的切片。
  - 说明：核心态留宿主。 子系统：Maintenance Safety and Rule Gates。
  - 验证：`npm run arch:god`

**833.** 为「Maintenance Safety and Rule Gates」补一条跨渠道/双通道一致性测试（如版本号 pip 与 npm 必须一致）。
  - 说明：双通道一致。 子系统：Maintenance Safety and Rule Gates。
  - 验证：`npm run check:maintainer:safety`

**834.** 为「Maintenance Safety and Rule Gates」的用户可见文案统一措辞与语气，避免同义词乱用误导弱模型。
  - 说明：文案统一。 子系统：Maintenance Safety and Rule Gates。
  - 验证：`npm run maintainer:check`

**835.** 给「Maintenance Safety and Rule Gates」增加一个健康分自检项，纳入 khy doctor 的输出。
  - 说明：并入自检。 子系统：Maintenance Safety and Rule Gates。
  - 验证：`khy doctor`

**836.** 为「Maintenance Safety and Rule Gates」补一条资源清理测试：临时文件用后即删、句柄关闭、无泄漏。
  - 说明：资源清理。 子系统：Maintenance Safety and Rule Gates。
  - 验证：`npm run check:maintainer:safety`

**837.** 把「Maintenance Safety and Rule Gates」里可能抛的第三方调用全部包进 try/catch 并给结构化 reason。
  - 说明：结构化容错。 子系统：Maintenance Safety and Rule Gates。
  - 验证：`npm run check:change-safety`

**838.** 为「Maintenance Safety and Rule Gates」写一条已知安全边界注释：明确它是 review aid 还是隔离边界，别夸大保证。
  - 说明：诚实边界。 子系统：Maintenance Safety and Rule Gates。
  - 验证：`npm run check:leaf-contract`

**839.** 为「Maintenance Safety and Rule Gates」补一条空结果早退路径：0 命中时跳过昂贵的下游步骤。
  - 说明：空结果早退。 子系统：Maintenance Safety and Rule Gates。
  - 验证：`npm run check:maintainer:safety`

**840.** 检查「Maintenance Safety and Rule Gates」的命令别名是否都路由到正确 handler，补一条 alias 路由测试。
  - 说明：别名路由。 子系统：Maintenance Safety and Rule Gates。
  - 验证：`npm run check:maintainer:safety`

**841.** 为「Maintenance Safety and Rule Gates」建立一条 memory 记录模板，把「为什么这么改」写进传承文档。
  - 说明：沉淀传承。 子系统：Maintenance Safety and Rule Gates。
  - 验证：`npm run maintainer:check`

**842.** 为「Release and Rollback」增加一个 flag 门控的纯叶子：零 IO、绝不抛异常，先在 flagRegistry 登记 KHY_* 门再接线。
  - 说明：新能力走门控叶子。 子系统：Release and Rollback。
  - 验证：`npm run check:flag-registry`

**843.** 为「Release and Rollback」补一条 node:test，至少覆盖：正常路径、一个边界、一个畸形/空输入。
  - 说明：补测试。 子系统：Release and Rollback。
  - 验证：`node --test maintenance/tests/ops-lib.test.js maintenance/tests/ops.integration.test.js`

**844.** 通读「Release and Rollback」核心文件，在顶部一句话写清职责，并给最难懂的分支补一句注释（不改行为）。
  - 说明：补可读性。 子系统：Release and Rollback。
  - 验证：`node --test maintenance/tests/ops-lib.test.js maintenance/tests/ops.integration.test.js`

**845.** 扫描「Release and Rollback」是否有文件超 2500 行；若有，按同名 re-export + DI 抽一个聚焦叶子，保字节等价。
  - 说明：拆上帝文件。 子系统：Release and Rollback。
  - 验证：`npm run arch:god`

**846.** 给「Release and Rollback」的注册表叶子（_PROBES/_REPAIRS 之类）上方补 4 步 HOW-TO-EXTEND 抄写式注释。
  - 说明：注册表可扩展。 子系统：Release and Rollback。
  - 验证：`npm run maintainer:check`

**847.** 把「Release and Rollback」中每轮/每请求重复构建的 Set/正则/常量提升为模块常量（参考书 Ch2）。
  - 说明：别每轮重建。 子系统：Release and Rollback。
  - 验证：`npm run arch:god`

**848.** 为「Release and Rollback」增加一个只读诊断探针：只观测不修改，绝不写盘、绝不发网络。
  - 说明：加只读探针。 子系统：Release and Rollback。
  - 验证：`node --test maintenance/tests/ops-lib.test.js maintenance/tests/ops.integration.test.js`

**849.** 为「Release and Rollback」增加一个「仅创建缺失项」的安全自愈：幂等、fail-soft、遇损坏拒删交人工。
  - 说明：加安全修复。 子系统：Release and Rollback。
  - 验证：`node --test maintenance/tests/ops-lib.test.js maintenance/tests/ops.integration.test.js`

**850.** 给「Release and Rollback」的失败路径补一条指名道姓的可执行指引，把错误码翻译成用户能照做的步骤。
  - 说明：错误可执行。 子系统：Release and Rollback。
  - 验证：`node --test maintenance/tests/ops-lib.test.js maintenance/tests/ops.integration.test.js`

**851.** 核对「Release and Rollback」的 verify 命令仍能一键复现绿灯；若命令漂移就修 package.json 别名。
  - 说明：verify 不漂移。 子系统：Release and Rollback。
  - 验证：`node --test maintenance/tests/ops-lib.test.js maintenance/tests/ops.integration.test.js`

**852.** 为「Release and Rollback」新增功能前先在 flagRegistry 登记开关，并确认父门链正确（父关则子必关）。
  - 说明：门先登记。 子系统：Release and Rollback。
  - 验证：`npm run check:flag-registry`

**853.** 为「Release and Rollback」的输入做防御式校验：null/undefined/空数组/超长都有明确且安全的默认行为。
  - 说明：防御式输入。 子系统：Release and Rollback。
  - 验证：`node --test maintenance/tests/ops-lib.test.js maintenance/tests/ops.integration.test.js`

**854.** 给「Release and Rollback」的外部调用加超时与失败兜底，任何一路挂了都 fail-soft 而不是整体崩。
  - 说明：失败兜底。 子系统：Release and Rollback。
  - 验证：`node --test maintenance/tests/ops-lib.test.js maintenance/tests/ops.integration.test.js`

**855.** 为「Release and Rollback」补一条针对历史 bug 的回归测试，命名写清它守护的是哪个坑。
  - 说明：回归测试。 子系统：Release and Rollback。
  - 验证：`node --test maintenance/tests/ops-lib.test.js maintenance/tests/ops.integration.test.js`

**856.** 检查「Release and Rollback」的日志：敏感值只打印长度不打印明文，绝不把 key/token 落盘或进日志。
  - 说明：日志脱敏。 子系统：Release and Rollback。
  - 验证：`npm run check:model-hardcoding`

**857.** 为「Release and Rollback」写一条 golden 测试：把一次已知正确的输出固化，防止未来悄悄漂移。
  - 说明：golden 固化。 子系统：Release and Rollback。
  - 验证：`node --test maintenance/tests/ops-lib.test.js maintenance/tests/ops.integration.test.js`

**858.** 为「Release and Rollback」排查可变状态跨簇共享：若被多处重赋值，抽取时必须用 DI 注入而非复制。
  - 说明：共享态用 DI。 子系统：Release and Rollback。
  - 验证：`npm run arch:god`

**859.** 为「Release and Rollback」补一个进程级缓存的测试重置钩子，避免测试间状态串味。
  - 说明：缓存可重置。 子系统：Release and Rollback。
  - 验证：`node --test maintenance/tests/ops-lib.test.js maintenance/tests/ops.integration.test.js`

**860.** 把「Release and Rollback」里散落的模型名/端点字面量收敛到单一权威来源（SSOT 访问器）。
  - 说明：收敛字面量。 子系统：Release and Rollback。
  - 验证：`npm run check:model-hardcoding`

**861.** 为「Release and Rollback」的公共函数补 JSDoc：写清意图、参数契约、返回值与副作用。
  - 说明：补 JSDoc。 子系统：Release and Rollback。
  - 验证：`npm run check:agent-rules`

**862.** 为「Release and Rollback」增加空参数补全保护：工具/命令缺关键参数时给出可推断的安全默认。
  - 说明：空参补全。 子系统：Release and Rollback。
  - 验证：`node --test maintenance/tests/ops-lib.test.js maintenance/tests/ops.integration.test.js`

**863.** 为「Release and Rollback」抽取叶子后 grep 每个被调函数，凡叶子调而宿主定义者必迁或 DI。
  - 说明：查死引用。 子系统：Release and Rollback。
  - 验证：`npm run check:leaf-contract`

**864.** 为「Release and Rollback」写一条场景测试：模拟一个真实用户操作序列，断言端到端结果。
  - 说明：场景测试。 子系统：Release and Rollback。
  - 验证：`node --test maintenance/tests/ops-lib.test.js maintenance/tests/ops.integration.test.js`

**865.** 把「Release and Rollback」里超过三层的嵌套条件重构为早返回（guard clause），降低阅读成本。
  - 说明：早返回。 子系统：Release and Rollback。
  - 验证：`npm run check:change-safety`

**866.** 为「Release and Rollback」补一条门关字节回退测试：关掉 KHY_* 门后行为逐字节回到改动前。
  - 说明：门关回退。 子系统：Release and Rollback。
  - 验证：`npm run check:flag-registry`

**867.** 给「Release and Rollback」仅用于匹配的正则去掉全局 g 标志，避免 lastIndex 状态残留。
  - 说明：正则去 g。 子系统：Release and Rollback。
  - 验证：`node --test maintenance/tests/ops-lib.test.js maintenance/tests/ops.integration.test.js`

**868.** 为「Release and Rollback」登记进 docs/维护者/维护映射表.json（whenToUse/paths/docs/verify 齐全）。
  - 说明：登记映射表。 子系统：Release and Rollback。
  - 验证：`npm run maintainer:check`

**869.** 为「Release and Rollback」补一句「一句话验证脚本」并并入 test:maintainer:all。
  - 说明：一句话验证。 子系统：Release and Rollback。
  - 验证：`npm run maintainer:check`

**870.** 检查「Release and Rollback」的错误信息是否可执行：告诉用户「下一步做什么」而不仅是「哪里错了」。
  - 说明：可执行错误。 子系统：Release and Rollback。
  - 验证：`node --test maintenance/tests/ops-lib.test.js maintenance/tests/ops.integration.test.js`

**871.** 为「Release and Rollback」的关键常量补注释解释「为什么是这个值」（保守高估、上限来源等）。
  - 说明：常量讲来源。 子系统：Release and Rollback。
  - 验证：`npm run check:change-safety`

**872.** 为「Release and Rollback」增加平台差异白名单（linux/windows/macos/android/ios），差异化规则收在注册表一处。
  - 说明：平台白名单。 子系统：Release and Rollback。
  - 验证：`node --test maintenance/tests/ops-lib.test.js maintenance/tests/ops.integration.test.js`

**873.** 为「Release and Rollback」补一条并发/竞态测试：同一资源被两条路径同时访问时结果仍正确。
  - 说明：并发测试。 子系统：Release and Rollback。
  - 验证：`node --test maintenance/tests/ops-lib.test.js maintenance/tests/ops.integration.test.js`

**874.** 把「Release and Rollback」里手写的重复逻辑抽成一个纯 helper，并给它单测。
  - 说明：抽纯 helper。 子系统：Release and Rollback。
  - 验证：`npm run check:leaf-contract`

**875.** 为「Release and Rollback」写一条「畸形输入绝不抛」的模糊测试：喂 null/数字/字符串/超大对象都返回安全值。
  - 说明：模糊测试。 子系统：Release and Rollback。
  - 验证：`npm run check:leaf-contract`

**876.** 检查「Release and Rollback」的默认值是否安全优先：不确定时偏向拒绝/降级而非放行。
  - 说明：安全默认。 子系统：Release and Rollback。
  - 验证：`npm run check:change-safety`

**877.** 为「Release and Rollback」补一条端点/URL 成形的确定性测试（不发真实请求，只断言拼出的字符串正确）。
  - 说明：URL 成形测试。 子系统：Release and Rollback。
  - 验证：`node --test maintenance/tests/ops-lib.test.js maintenance/tests/ops.integration.test.js`

**878.** 为「Release and Rollback」的每个导出函数确认都有对应测试引用，无孤儿导出。
  - 说明：无孤儿导出。 子系统：Release and Rollback。
  - 验证：`npm run check:leaf-contract`

**879.** 为「Release and Rollback」增加预算/上限保护：循环或累积有明确终止条件，防止失控。
  - 说明：预算护栏。 子系统：Release and Rollback。
  - 验证：`node --test maintenance/tests/ops-lib.test.js maintenance/tests/ops.integration.test.js`

**880.** 把「Release and Rollback」的巨型 switch 按 case 簇抽子分派器（pre-dispatch + 哨兵 fall-through）。
  - 说明：switch 拆解。 子系统：Release and Rollback。
  - 验证：`npm run arch:god`

**881.** 为「Release and Rollback」补一条幂等测试：同一操作跑两次结果一致、无副作用叠加。
  - 说明：幂等测试。 子系统：Release and Rollback。
  - 验证：`node --test maintenance/tests/ops-lib.test.js maintenance/tests/ops.integration.test.js`

**882.** 检查「Release and Rollback」是否遵守单向依赖：叶子不得反向 require 宿主网关，需要就用 IoC 缝。
  - 说明：单向依赖。 子系统：Release and Rollback。
  - 验证：`npm run check:leaf-contract`

**883.** 为「Release and Rollback」写一份「新维护者一分钟上手」的结构表（文件→职责一行）。
  - 说明：一分钟上手。 子系统：Release and Rollback。
  - 验证：`npm run maintainer:check`

**884.** 为「Release and Rollback」的时间相关逻辑改为「时钟由调用方喂入」，让它可离线确定性测试。
  - 说明：时钟可注入。 子系统：Release and Rollback。
  - 验证：`node --test maintenance/tests/ops-lib.test.js maintenance/tests/ops.integration.test.js`

**885.** 给「Release and Rollback」补一条「截断/采样时必须 log 丢了什么」的规则，杜绝静默截断。
  - 说明：别静默截断。 子系统：Release and Rollback。
  - 验证：`npm run check:change-safety`

**886.** 为「Release and Rollback」增加 dry-run 模式：先展示将要做什么，用户确认后才执行破坏性操作。
  - 说明：dry-run 先行。 子系统：Release and Rollback。
  - 验证：`npm run check:small-model:safety`

**887.** 检查「Release and Rollback」的 flag 语义：opt-in 严格只认 1/true，default-on 只认关键词才关。
  - 说明：门语义核对。 子系统：Release and Rollback。
  - 验证：`npm run check:flag-registry`

**888.** 为「Release and Rollback」补一条「父门关闭 → 子功能整体关闭」的门控测试。
  - 说明：父子门控。 子系统：Release and Rollback。
  - 验证：`npm run check:flag-registry`

**889.** 把「Release and Rollback」里的魔法数字提取为具名常量并注释其单位与来源。
  - 说明：消魔法数。 子系统：Release and Rollback。
  - 验证：`npm run check:change-safety`

**890.** 为「Release and Rollback」写一条向后兼容测试：旧输入格式仍能被正确解析。
  - 说明：向后兼容。 子系统：Release and Rollback。
  - 验证：`node --test maintenance/tests/ops-lib.test.js maintenance/tests/ops.integration.test.js`

**891.** 为「Release and Rollback」的注册表新增一维时，确认聚合器与格式化器各只改一处（不 smear）。
  - 说明：改动不 smear。 子系统：Release and Rollback。
  - 验证：`node --test maintenance/tests/ops-lib.test.js maintenance/tests/ops.integration.test.js`

**892.** 检查「Release and Rollback」抽取后宿主是否仍持有核心态，叶子只拿它需要的切片。
  - 说明：核心态留宿主。 子系统：Release and Rollback。
  - 验证：`npm run arch:god`

**893.** 为「Release and Rollback」补一条跨渠道/双通道一致性测试（如版本号 pip 与 npm 必须一致）。
  - 说明：双通道一致。 子系统：Release and Rollback。
  - 验证：`node --test maintenance/tests/ops-lib.test.js maintenance/tests/ops.integration.test.js`

**894.** 为「Release and Rollback」的用户可见文案统一措辞与语气，避免同义词乱用误导弱模型。
  - 说明：文案统一。 子系统：Release and Rollback。
  - 验证：`npm run maintainer:check`

**895.** 给「Release and Rollback」增加一个健康分自检项，纳入 khy doctor 的输出。
  - 说明：并入自检。 子系统：Release and Rollback。
  - 验证：`khy doctor`

**896.** 为「Release and Rollback」补一条资源清理测试：临时文件用后即删、句柄关闭、无泄漏。
  - 说明：资源清理。 子系统：Release and Rollback。
  - 验证：`node --test maintenance/tests/ops-lib.test.js maintenance/tests/ops.integration.test.js`

**897.** 把「Release and Rollback」里可能抛的第三方调用全部包进 try/catch 并给结构化 reason。
  - 说明：结构化容错。 子系统：Release and Rollback。
  - 验证：`npm run check:change-safety`

**898.** 为「Release and Rollback」写一条已知安全边界注释：明确它是 review aid 还是隔离边界，别夸大保证。
  - 说明：诚实边界。 子系统：Release and Rollback。
  - 验证：`npm run check:leaf-contract`

**899.** 为「Release and Rollback」补一条空结果早退路径：0 命中时跳过昂贵的下游步骤。
  - 说明：空结果早退。 子系统：Release and Rollback。
  - 验证：`node --test maintenance/tests/ops-lib.test.js maintenance/tests/ops.integration.test.js`

**900.** 检查「Release and Rollback」的命令别名是否都路由到正确 handler，补一条 alias 路由测试。
  - 说明：别名路由。 子系统：Release and Rollback。
  - 验证：`node --test maintenance/tests/ops-lib.test.js maintenance/tests/ops.integration.test.js`

**901.** 为「Release and Rollback」建立一条 memory 记录模板，把「为什么这么改」写进传承文档。
  - 说明：沉淀传承。 子系统：Release and Rollback。
  - 验证：`npm run maintainer:check`

**902.** 为「Build Best Environment (Self-check / Repair / Probes)」增加一个 flag 门控的纯叶子：零 IO、绝不抛异常，先在 flagRegistry 登记 KHY_* 门再接线。
  - 说明：新能力走门控叶子。 子系统：Build Best Environment (Self-check / Repair / Probes)。
  - 验证：`npm run check:flag-registry`

**903.** 为「Build Best Environment (Self-check / Repair / Probes)」补一条 node:test，至少覆盖：正常路径、一个边界、一个畸形/空输入。
  - 说明：补测试。 子系统：Build Best Environment (Self-check / Repair / Probes)。
  - 验证：`npm run test:maintainer:env-optimize`

**904.** 通读「Build Best Environment (Self-check / Repair / Probes)」核心文件，在顶部一句话写清职责，并给最难懂的分支补一句注释（不改行为）。
  - 说明：补可读性。 子系统：Build Best Environment (Self-check / Repair / Probes)。
  - 验证：`npm run test:maintainer:env-optimize`

**905.** 扫描「Build Best Environment (Self-check / Repair / Probes)」是否有文件超 2500 行；若有，按同名 re-export + DI 抽一个聚焦叶子，保字节等价。
  - 说明：拆上帝文件。 子系统：Build Best Environment (Self-check / Repair / Probes)。
  - 验证：`npm run arch:god`

**906.** 给「Build Best Environment (Self-check / Repair / Probes)」的注册表叶子（_PROBES/_REPAIRS 之类）上方补 4 步 HOW-TO-EXTEND 抄写式注释。
  - 说明：注册表可扩展。 子系统：Build Best Environment (Self-check / Repair / Probes)。
  - 验证：`npm run maintainer:check`

**907.** 把「Build Best Environment (Self-check / Repair / Probes)」中每轮/每请求重复构建的 Set/正则/常量提升为模块常量（参考书 Ch2）。
  - 说明：别每轮重建。 子系统：Build Best Environment (Self-check / Repair / Probes)。
  - 验证：`npm run arch:god`

**908.** 为「Build Best Environment (Self-check / Repair / Probes)」增加一个只读诊断探针：只观测不修改，绝不写盘、绝不发网络。
  - 说明：加只读探针。 子系统：Build Best Environment (Self-check / Repair / Probes)。
  - 验证：`npm run test:maintainer:env-optimize`

**909.** 为「Build Best Environment (Self-check / Repair / Probes)」增加一个「仅创建缺失项」的安全自愈：幂等、fail-soft、遇损坏拒删交人工。
  - 说明：加安全修复。 子系统：Build Best Environment (Self-check / Repair / Probes)。
  - 验证：`npm run test:maintainer:env-optimize`

**910.** 给「Build Best Environment (Self-check / Repair / Probes)」的失败路径补一条指名道姓的可执行指引，把错误码翻译成用户能照做的步骤。
  - 说明：错误可执行。 子系统：Build Best Environment (Self-check / Repair / Probes)。
  - 验证：`npm run test:maintainer:env-optimize`

**911.** 核对「Build Best Environment (Self-check / Repair / Probes)」的 verify 命令仍能一键复现绿灯；若命令漂移就修 package.json 别名。
  - 说明：verify 不漂移。 子系统：Build Best Environment (Self-check / Repair / Probes)。
  - 验证：`npm run test:maintainer:env-optimize`

**912.** 为「Build Best Environment (Self-check / Repair / Probes)」新增功能前先在 flagRegistry 登记开关，并确认父门链正确（父关则子必关）。
  - 说明：门先登记。 子系统：Build Best Environment (Self-check / Repair / Probes)。
  - 验证：`npm run check:flag-registry`

**913.** 为「Build Best Environment (Self-check / Repair / Probes)」的输入做防御式校验：null/undefined/空数组/超长都有明确且安全的默认行为。
  - 说明：防御式输入。 子系统：Build Best Environment (Self-check / Repair / Probes)。
  - 验证：`npm run test:maintainer:env-optimize`

**914.** 给「Build Best Environment (Self-check / Repair / Probes)」的外部调用加超时与失败兜底，任何一路挂了都 fail-soft 而不是整体崩。
  - 说明：失败兜底。 子系统：Build Best Environment (Self-check / Repair / Probes)。
  - 验证：`npm run test:maintainer:env-optimize`

**915.** 为「Build Best Environment (Self-check / Repair / Probes)」补一条针对历史 bug 的回归测试，命名写清它守护的是哪个坑。
  - 说明：回归测试。 子系统：Build Best Environment (Self-check / Repair / Probes)。
  - 验证：`npm run test:maintainer:env-optimize`

**916.** 检查「Build Best Environment (Self-check / Repair / Probes)」的日志：敏感值只打印长度不打印明文，绝不把 key/token 落盘或进日志。
  - 说明：日志脱敏。 子系统：Build Best Environment (Self-check / Repair / Probes)。
  - 验证：`npm run check:model-hardcoding`

**917.** 为「Build Best Environment (Self-check / Repair / Probes)」写一条 golden 测试：把一次已知正确的输出固化，防止未来悄悄漂移。
  - 说明：golden 固化。 子系统：Build Best Environment (Self-check / Repair / Probes)。
  - 验证：`npm run test:maintainer:env-optimize`

**918.** 为「Build Best Environment (Self-check / Repair / Probes)」排查可变状态跨簇共享：若被多处重赋值，抽取时必须用 DI 注入而非复制。
  - 说明：共享态用 DI。 子系统：Build Best Environment (Self-check / Repair / Probes)。
  - 验证：`npm run arch:god`

**919.** 为「Build Best Environment (Self-check / Repair / Probes)」补一个进程级缓存的测试重置钩子，避免测试间状态串味。
  - 说明：缓存可重置。 子系统：Build Best Environment (Self-check / Repair / Probes)。
  - 验证：`npm run test:maintainer:env-optimize`

**920.** 把「Build Best Environment (Self-check / Repair / Probes)」里散落的模型名/端点字面量收敛到单一权威来源（SSOT 访问器）。
  - 说明：收敛字面量。 子系统：Build Best Environment (Self-check / Repair / Probes)。
  - 验证：`npm run check:model-hardcoding`

**921.** 为「Build Best Environment (Self-check / Repair / Probes)」的公共函数补 JSDoc：写清意图、参数契约、返回值与副作用。
  - 说明：补 JSDoc。 子系统：Build Best Environment (Self-check / Repair / Probes)。
  - 验证：`npm run check:agent-rules`

**922.** 为「Build Best Environment (Self-check / Repair / Probes)」增加空参数补全保护：工具/命令缺关键参数时给出可推断的安全默认。
  - 说明：空参补全。 子系统：Build Best Environment (Self-check / Repair / Probes)。
  - 验证：`npm run test:maintainer:env-optimize`

**923.** 为「Build Best Environment (Self-check / Repair / Probes)」抽取叶子后 grep 每个被调函数，凡叶子调而宿主定义者必迁或 DI。
  - 说明：查死引用。 子系统：Build Best Environment (Self-check / Repair / Probes)。
  - 验证：`npm run check:leaf-contract`

**924.** 为「Build Best Environment (Self-check / Repair / Probes)」写一条场景测试：模拟一个真实用户操作序列，断言端到端结果。
  - 说明：场景测试。 子系统：Build Best Environment (Self-check / Repair / Probes)。
  - 验证：`npm run test:maintainer:env-optimize`

**925.** 把「Build Best Environment (Self-check / Repair / Probes)」里超过三层的嵌套条件重构为早返回（guard clause），降低阅读成本。
  - 说明：早返回。 子系统：Build Best Environment (Self-check / Repair / Probes)。
  - 验证：`npm run check:change-safety`

**926.** 为「Build Best Environment (Self-check / Repair / Probes)」补一条门关字节回退测试：关掉 KHY_* 门后行为逐字节回到改动前。
  - 说明：门关回退。 子系统：Build Best Environment (Self-check / Repair / Probes)。
  - 验证：`npm run check:flag-registry`

**927.** 给「Build Best Environment (Self-check / Repair / Probes)」仅用于匹配的正则去掉全局 g 标志，避免 lastIndex 状态残留。
  - 说明：正则去 g。 子系统：Build Best Environment (Self-check / Repair / Probes)。
  - 验证：`npm run test:maintainer:env-optimize`

**928.** 为「Build Best Environment (Self-check / Repair / Probes)」登记进 docs/维护者/维护映射表.json（whenToUse/paths/docs/verify 齐全）。
  - 说明：登记映射表。 子系统：Build Best Environment (Self-check / Repair / Probes)。
  - 验证：`npm run maintainer:check`

**929.** 为「Build Best Environment (Self-check / Repair / Probes)」补一句「一句话验证脚本」并并入 test:maintainer:all。
  - 说明：一句话验证。 子系统：Build Best Environment (Self-check / Repair / Probes)。
  - 验证：`npm run maintainer:check`

**930.** 检查「Build Best Environment (Self-check / Repair / Probes)」的错误信息是否可执行：告诉用户「下一步做什么」而不仅是「哪里错了」。
  - 说明：可执行错误。 子系统：Build Best Environment (Self-check / Repair / Probes)。
  - 验证：`npm run test:maintainer:env-optimize`

**931.** 为「Build Best Environment (Self-check / Repair / Probes)」的关键常量补注释解释「为什么是这个值」（保守高估、上限来源等）。
  - 说明：常量讲来源。 子系统：Build Best Environment (Self-check / Repair / Probes)。
  - 验证：`npm run check:change-safety`

**932.** 为「Build Best Environment (Self-check / Repair / Probes)」增加平台差异白名单（linux/windows/macos/android/ios），差异化规则收在注册表一处。
  - 说明：平台白名单。 子系统：Build Best Environment (Self-check / Repair / Probes)。
  - 验证：`npm run test:maintainer:env-optimize`

**933.** 为「Build Best Environment (Self-check / Repair / Probes)」补一条并发/竞态测试：同一资源被两条路径同时访问时结果仍正确。
  - 说明：并发测试。 子系统：Build Best Environment (Self-check / Repair / Probes)。
  - 验证：`npm run test:maintainer:env-optimize`

**934.** 把「Build Best Environment (Self-check / Repair / Probes)」里手写的重复逻辑抽成一个纯 helper，并给它单测。
  - 说明：抽纯 helper。 子系统：Build Best Environment (Self-check / Repair / Probes)。
  - 验证：`npm run check:leaf-contract`

**935.** 为「Build Best Environment (Self-check / Repair / Probes)」写一条「畸形输入绝不抛」的模糊测试：喂 null/数字/字符串/超大对象都返回安全值。
  - 说明：模糊测试。 子系统：Build Best Environment (Self-check / Repair / Probes)。
  - 验证：`npm run check:leaf-contract`

**936.** 检查「Build Best Environment (Self-check / Repair / Probes)」的默认值是否安全优先：不确定时偏向拒绝/降级而非放行。
  - 说明：安全默认。 子系统：Build Best Environment (Self-check / Repair / Probes)。
  - 验证：`npm run check:change-safety`

**937.** 为「Build Best Environment (Self-check / Repair / Probes)」补一条端点/URL 成形的确定性测试（不发真实请求，只断言拼出的字符串正确）。
  - 说明：URL 成形测试。 子系统：Build Best Environment (Self-check / Repair / Probes)。
  - 验证：`npm run test:maintainer:env-optimize`

**938.** 为「Build Best Environment (Self-check / Repair / Probes)」的每个导出函数确认都有对应测试引用，无孤儿导出。
  - 说明：无孤儿导出。 子系统：Build Best Environment (Self-check / Repair / Probes)。
  - 验证：`npm run check:leaf-contract`

**939.** 为「Build Best Environment (Self-check / Repair / Probes)」增加预算/上限保护：循环或累积有明确终止条件，防止失控。
  - 说明：预算护栏。 子系统：Build Best Environment (Self-check / Repair / Probes)。
  - 验证：`npm run test:maintainer:env-optimize`

**940.** 把「Build Best Environment (Self-check / Repair / Probes)」的巨型 switch 按 case 簇抽子分派器（pre-dispatch + 哨兵 fall-through）。
  - 说明：switch 拆解。 子系统：Build Best Environment (Self-check / Repair / Probes)。
  - 验证：`npm run arch:god`

**941.** 为「Build Best Environment (Self-check / Repair / Probes)」补一条幂等测试：同一操作跑两次结果一致、无副作用叠加。
  - 说明：幂等测试。 子系统：Build Best Environment (Self-check / Repair / Probes)。
  - 验证：`npm run test:maintainer:env-optimize`

**942.** 检查「Build Best Environment (Self-check / Repair / Probes)」是否遵守单向依赖：叶子不得反向 require 宿主网关，需要就用 IoC 缝。
  - 说明：单向依赖。 子系统：Build Best Environment (Self-check / Repair / Probes)。
  - 验证：`npm run check:leaf-contract`

**943.** 为「Build Best Environment (Self-check / Repair / Probes)」写一份「新维护者一分钟上手」的结构表（文件→职责一行）。
  - 说明：一分钟上手。 子系统：Build Best Environment (Self-check / Repair / Probes)。
  - 验证：`npm run maintainer:check`

**944.** 为「Build Best Environment (Self-check / Repair / Probes)」的时间相关逻辑改为「时钟由调用方喂入」，让它可离线确定性测试。
  - 说明：时钟可注入。 子系统：Build Best Environment (Self-check / Repair / Probes)。
  - 验证：`npm run test:maintainer:env-optimize`

**945.** 给「Build Best Environment (Self-check / Repair / Probes)」补一条「截断/采样时必须 log 丢了什么」的规则，杜绝静默截断。
  - 说明：别静默截断。 子系统：Build Best Environment (Self-check / Repair / Probes)。
  - 验证：`npm run check:change-safety`

**946.** 为「Build Best Environment (Self-check / Repair / Probes)」增加 dry-run 模式：先展示将要做什么，用户确认后才执行破坏性操作。
  - 说明：dry-run 先行。 子系统：Build Best Environment (Self-check / Repair / Probes)。
  - 验证：`npm run check:small-model:safety`

**947.** 检查「Build Best Environment (Self-check / Repair / Probes)」的 flag 语义：opt-in 严格只认 1/true，default-on 只认关键词才关。
  - 说明：门语义核对。 子系统：Build Best Environment (Self-check / Repair / Probes)。
  - 验证：`npm run check:flag-registry`

**948.** 为「Build Best Environment (Self-check / Repair / Probes)」补一条「父门关闭 → 子功能整体关闭」的门控测试。
  - 说明：父子门控。 子系统：Build Best Environment (Self-check / Repair / Probes)。
  - 验证：`npm run check:flag-registry`

**949.** 把「Build Best Environment (Self-check / Repair / Probes)」里的魔法数字提取为具名常量并注释其单位与来源。
  - 说明：消魔法数。 子系统：Build Best Environment (Self-check / Repair / Probes)。
  - 验证：`npm run check:change-safety`

**950.** 为「Build Best Environment (Self-check / Repair / Probes)」写一条向后兼容测试：旧输入格式仍能被正确解析。
  - 说明：向后兼容。 子系统：Build Best Environment (Self-check / Repair / Probes)。
  - 验证：`npm run test:maintainer:env-optimize`

**951.** 为「Build Best Environment (Self-check / Repair / Probes)」的注册表新增一维时，确认聚合器与格式化器各只改一处（不 smear）。
  - 说明：改动不 smear。 子系统：Build Best Environment (Self-check / Repair / Probes)。
  - 验证：`npm run test:maintainer:env-optimize`

**952.** 检查「Build Best Environment (Self-check / Repair / Probes)」抽取后宿主是否仍持有核心态，叶子只拿它需要的切片。
  - 说明：核心态留宿主。 子系统：Build Best Environment (Self-check / Repair / Probes)。
  - 验证：`npm run arch:god`

**953.** 为「Build Best Environment (Self-check / Repair / Probes)」补一条跨渠道/双通道一致性测试（如版本号 pip 与 npm 必须一致）。
  - 说明：双通道一致。 子系统：Build Best Environment (Self-check / Repair / Probes)。
  - 验证：`npm run test:maintainer:env-optimize`

**954.** 为「Build Best Environment (Self-check / Repair / Probes)」的用户可见文案统一措辞与语气，避免同义词乱用误导弱模型。
  - 说明：文案统一。 子系统：Build Best Environment (Self-check / Repair / Probes)。
  - 验证：`npm run maintainer:check`

**955.** 给「Build Best Environment (Self-check / Repair / Probes)」增加一个健康分自检项，纳入 khy doctor 的输出。
  - 说明：并入自检。 子系统：Build Best Environment (Self-check / Repair / Probes)。
  - 验证：`khy doctor`

**956.** 为「Build Best Environment (Self-check / Repair / Probes)」补一条资源清理测试：临时文件用后即删、句柄关闭、无泄漏。
  - 说明：资源清理。 子系统：Build Best Environment (Self-check / Repair / Probes)。
  - 验证：`npm run test:maintainer:env-optimize`

**957.** 把「Build Best Environment (Self-check / Repair / Probes)」里可能抛的第三方调用全部包进 try/catch 并给结构化 reason。
  - 说明：结构化容错。 子系统：Build Best Environment (Self-check / Repair / Probes)。
  - 验证：`npm run check:change-safety`

**958.** 为「Build Best Environment (Self-check / Repair / Probes)」写一条已知安全边界注释：明确它是 review aid 还是隔离边界，别夸大保证。
  - 说明：诚实边界。 子系统：Build Best Environment (Self-check / Repair / Probes)。
  - 验证：`npm run check:leaf-contract`

**959.** 为「Build Best Environment (Self-check / Repair / Probes)」补一条空结果早退路径：0 命中时跳过昂贵的下游步骤。
  - 说明：空结果早退。 子系统：Build Best Environment (Self-check / Repair / Probes)。
  - 验证：`npm run test:maintainer:env-optimize`

**960.** 检查「Build Best Environment (Self-check / Repair / Probes)」的命令别名是否都路由到正确 handler，补一条 alias 路由测试。
  - 说明：别名路由。 子系统：Build Best Environment (Self-check / Repair / Probes)。
  - 验证：`npm run test:maintainer:env-optimize`

**961.** 为「Build Best Environment (Self-check / Repair / Probes)」建立一条 memory 记录模板，把「为什么这么改」写进传承文档。
  - 说明：沉淀传承。 子系统：Build Best Environment (Self-check / Repair / Probes)。
  - 验证：`npm run maintainer:check`

**962.** 为「Evolution Prompt Playbook (1000 preset prompts)」增加一个 flag 门控的纯叶子：零 IO、绝不抛异常，先在 flagRegistry 登记 KHY_* 门再接线。
  - 说明：新能力走门控叶子。 子系统：Evolution Prompt Playbook (1000 preset prompts)。
  - 验证：`npm run check:flag-registry`

**963.** 为「Evolution Prompt Playbook (1000 preset prompts)」补一条 node:test，至少覆盖：正常路径、一个边界、一个畸形/空输入。
  - 说明：补测试。 子系统：Evolution Prompt Playbook (1000 preset prompts)。
  - 验证：`npm run test:evolution-prompts`

**964.** 通读「Evolution Prompt Playbook (1000 preset prompts)」核心文件，在顶部一句话写清职责，并给最难懂的分支补一句注释（不改行为）。
  - 说明：补可读性。 子系统：Evolution Prompt Playbook (1000 preset prompts)。
  - 验证：`npm run test:evolution-prompts`

**965.** 扫描「Evolution Prompt Playbook (1000 preset prompts)」是否有文件超 2500 行；若有，按同名 re-export + DI 抽一个聚焦叶子，保字节等价。
  - 说明：拆上帝文件。 子系统：Evolution Prompt Playbook (1000 preset prompts)。
  - 验证：`npm run arch:god`

**966.** 给「Evolution Prompt Playbook (1000 preset prompts)」的注册表叶子（_PROBES/_REPAIRS 之类）上方补 4 步 HOW-TO-EXTEND 抄写式注释。
  - 说明：注册表可扩展。 子系统：Evolution Prompt Playbook (1000 preset prompts)。
  - 验证：`npm run maintainer:check`

**967.** 把「Evolution Prompt Playbook (1000 preset prompts)」中每轮/每请求重复构建的 Set/正则/常量提升为模块常量（参考书 Ch2）。
  - 说明：别每轮重建。 子系统：Evolution Prompt Playbook (1000 preset prompts)。
  - 验证：`npm run arch:god`

**968.** 为「Evolution Prompt Playbook (1000 preset prompts)」增加一个只读诊断探针：只观测不修改，绝不写盘、绝不发网络。
  - 说明：加只读探针。 子系统：Evolution Prompt Playbook (1000 preset prompts)。
  - 验证：`npm run test:evolution-prompts`

**969.** 为「Evolution Prompt Playbook (1000 preset prompts)」增加一个「仅创建缺失项」的安全自愈：幂等、fail-soft、遇损坏拒删交人工。
  - 说明：加安全修复。 子系统：Evolution Prompt Playbook (1000 preset prompts)。
  - 验证：`npm run test:evolution-prompts`

**970.** 给「Evolution Prompt Playbook (1000 preset prompts)」的失败路径补一条指名道姓的可执行指引，把错误码翻译成用户能照做的步骤。
  - 说明：错误可执行。 子系统：Evolution Prompt Playbook (1000 preset prompts)。
  - 验证：`npm run test:evolution-prompts`

**971.** 核对「Evolution Prompt Playbook (1000 preset prompts)」的 verify 命令仍能一键复现绿灯；若命令漂移就修 package.json 别名。
  - 说明：verify 不漂移。 子系统：Evolution Prompt Playbook (1000 preset prompts)。
  - 验证：`npm run test:evolution-prompts`

**972.** 为「Evolution Prompt Playbook (1000 preset prompts)」新增功能前先在 flagRegistry 登记开关，并确认父门链正确（父关则子必关）。
  - 说明：门先登记。 子系统：Evolution Prompt Playbook (1000 preset prompts)。
  - 验证：`npm run check:flag-registry`

**973.** 为「Evolution Prompt Playbook (1000 preset prompts)」的输入做防御式校验：null/undefined/空数组/超长都有明确且安全的默认行为。
  - 说明：防御式输入。 子系统：Evolution Prompt Playbook (1000 preset prompts)。
  - 验证：`npm run test:evolution-prompts`

**974.** 给「Evolution Prompt Playbook (1000 preset prompts)」的外部调用加超时与失败兜底，任何一路挂了都 fail-soft 而不是整体崩。
  - 说明：失败兜底。 子系统：Evolution Prompt Playbook (1000 preset prompts)。
  - 验证：`npm run test:evolution-prompts`

**975.** 为「Evolution Prompt Playbook (1000 preset prompts)」补一条针对历史 bug 的回归测试，命名写清它守护的是哪个坑。
  - 说明：回归测试。 子系统：Evolution Prompt Playbook (1000 preset prompts)。
  - 验证：`npm run test:evolution-prompts`

**976.** 检查「Evolution Prompt Playbook (1000 preset prompts)」的日志：敏感值只打印长度不打印明文，绝不把 key/token 落盘或进日志。
  - 说明：日志脱敏。 子系统：Evolution Prompt Playbook (1000 preset prompts)。
  - 验证：`npm run check:model-hardcoding`

**977.** 为「Evolution Prompt Playbook (1000 preset prompts)」写一条 golden 测试：把一次已知正确的输出固化，防止未来悄悄漂移。
  - 说明：golden 固化。 子系统：Evolution Prompt Playbook (1000 preset prompts)。
  - 验证：`npm run test:evolution-prompts`

**978.** 为「Evolution Prompt Playbook (1000 preset prompts)」排查可变状态跨簇共享：若被多处重赋值，抽取时必须用 DI 注入而非复制。
  - 说明：共享态用 DI。 子系统：Evolution Prompt Playbook (1000 preset prompts)。
  - 验证：`npm run arch:god`

**979.** 为「Evolution Prompt Playbook (1000 preset prompts)」补一个进程级缓存的测试重置钩子，避免测试间状态串味。
  - 说明：缓存可重置。 子系统：Evolution Prompt Playbook (1000 preset prompts)。
  - 验证：`npm run test:evolution-prompts`

**980.** 把「Evolution Prompt Playbook (1000 preset prompts)」里散落的模型名/端点字面量收敛到单一权威来源（SSOT 访问器）。
  - 说明：收敛字面量。 子系统：Evolution Prompt Playbook (1000 preset prompts)。
  - 验证：`npm run check:model-hardcoding`

**981.** 为「Evolution Prompt Playbook (1000 preset prompts)」的公共函数补 JSDoc：写清意图、参数契约、返回值与副作用。
  - 说明：补 JSDoc。 子系统：Evolution Prompt Playbook (1000 preset prompts)。
  - 验证：`npm run check:agent-rules`

**982.** 为「Evolution Prompt Playbook (1000 preset prompts)」增加空参数补全保护：工具/命令缺关键参数时给出可推断的安全默认。
  - 说明：空参补全。 子系统：Evolution Prompt Playbook (1000 preset prompts)。
  - 验证：`npm run test:evolution-prompts`

**983.** 为「Evolution Prompt Playbook (1000 preset prompts)」抽取叶子后 grep 每个被调函数，凡叶子调而宿主定义者必迁或 DI。
  - 说明：查死引用。 子系统：Evolution Prompt Playbook (1000 preset prompts)。
  - 验证：`npm run check:leaf-contract`

**984.** 为「Evolution Prompt Playbook (1000 preset prompts)」写一条场景测试：模拟一个真实用户操作序列，断言端到端结果。
  - 说明：场景测试。 子系统：Evolution Prompt Playbook (1000 preset prompts)。
  - 验证：`npm run test:evolution-prompts`

**985.** 把「Evolution Prompt Playbook (1000 preset prompts)」里超过三层的嵌套条件重构为早返回（guard clause），降低阅读成本。
  - 说明：早返回。 子系统：Evolution Prompt Playbook (1000 preset prompts)。
  - 验证：`npm run check:change-safety`

**986.** 为「Evolution Prompt Playbook (1000 preset prompts)」补一条门关字节回退测试：关掉 KHY_* 门后行为逐字节回到改动前。
  - 说明：门关回退。 子系统：Evolution Prompt Playbook (1000 preset prompts)。
  - 验证：`npm run check:flag-registry`

**987.** 给「Evolution Prompt Playbook (1000 preset prompts)」仅用于匹配的正则去掉全局 g 标志，避免 lastIndex 状态残留。
  - 说明：正则去 g。 子系统：Evolution Prompt Playbook (1000 preset prompts)。
  - 验证：`npm run test:evolution-prompts`

**988.** 为「Evolution Prompt Playbook (1000 preset prompts)」登记进 docs/维护者/维护映射表.json（whenToUse/paths/docs/verify 齐全）。
  - 说明：登记映射表。 子系统：Evolution Prompt Playbook (1000 preset prompts)。
  - 验证：`npm run maintainer:check`

**989.** 为「Evolution Prompt Playbook (1000 preset prompts)」补一句「一句话验证脚本」并并入 test:maintainer:all。
  - 说明：一句话验证。 子系统：Evolution Prompt Playbook (1000 preset prompts)。
  - 验证：`npm run maintainer:check`

**990.** 检查「Evolution Prompt Playbook (1000 preset prompts)」的错误信息是否可执行：告诉用户「下一步做什么」而不仅是「哪里错了」。
  - 说明：可执行错误。 子系统：Evolution Prompt Playbook (1000 preset prompts)。
  - 验证：`npm run test:evolution-prompts`

**991.** 为「Evolution Prompt Playbook (1000 preset prompts)」的关键常量补注释解释「为什么是这个值」（保守高估、上限来源等）。
  - 说明：常量讲来源。 子系统：Evolution Prompt Playbook (1000 preset prompts)。
  - 验证：`npm run check:change-safety`

**992.** 为「Evolution Prompt Playbook (1000 preset prompts)」增加平台差异白名单（linux/windows/macos/android/ios），差异化规则收在注册表一处。
  - 说明：平台白名单。 子系统：Evolution Prompt Playbook (1000 preset prompts)。
  - 验证：`npm run test:evolution-prompts`

**993.** 为「Evolution Prompt Playbook (1000 preset prompts)」补一条并发/竞态测试：同一资源被两条路径同时访问时结果仍正确。
  - 说明：并发测试。 子系统：Evolution Prompt Playbook (1000 preset prompts)。
  - 验证：`npm run test:evolution-prompts`

**994.** 把「Evolution Prompt Playbook (1000 preset prompts)」里手写的重复逻辑抽成一个纯 helper，并给它单测。
  - 说明：抽纯 helper。 子系统：Evolution Prompt Playbook (1000 preset prompts)。
  - 验证：`npm run check:leaf-contract`

**995.** 为「Evolution Prompt Playbook (1000 preset prompts)」写一条「畸形输入绝不抛」的模糊测试：喂 null/数字/字符串/超大对象都返回安全值。
  - 说明：模糊测试。 子系统：Evolution Prompt Playbook (1000 preset prompts)。
  - 验证：`npm run check:leaf-contract`

**996.** 检查「Evolution Prompt Playbook (1000 preset prompts)」的默认值是否安全优先：不确定时偏向拒绝/降级而非放行。
  - 说明：安全默认。 子系统：Evolution Prompt Playbook (1000 preset prompts)。
  - 验证：`npm run check:change-safety`

**997.** 为「Evolution Prompt Playbook (1000 preset prompts)」补一条端点/URL 成形的确定性测试（不发真实请求，只断言拼出的字符串正确）。
  - 说明：URL 成形测试。 子系统：Evolution Prompt Playbook (1000 preset prompts)。
  - 验证：`npm run test:evolution-prompts`

**998.** 为「Evolution Prompt Playbook (1000 preset prompts)」的每个导出函数确认都有对应测试引用，无孤儿导出。
  - 说明：无孤儿导出。 子系统：Evolution Prompt Playbook (1000 preset prompts)。
  - 验证：`npm run check:leaf-contract`

**999.** 为「Evolution Prompt Playbook (1000 preset prompts)」增加预算/上限保护：循环或累积有明确终止条件，防止失控。
  - 说明：预算护栏。 子系统：Evolution Prompt Playbook (1000 preset prompts)。
  - 验证：`npm run test:evolution-prompts`

**1000.** 把「Evolution Prompt Playbook (1000 preset prompts)」的巨型 switch 按 case 簇抽子分派器（pre-dispatch + 哨兵 fall-through）。
  - 说明：switch 拆解。 子系统：Evolution Prompt Playbook (1000 preset prompts)。
  - 验证：`npm run arch:god`

# [OPS-MAN-066] Khy-OS 进化提示词手册（1000 条）

> 交给 khy 或任何「弱智 AI / 4B 小模型」用的进化清单：一次喂一条，照着做，跑通它自带的验证命令。
> 全部锚定本仓真实子系统、真实文件、真实 verify（来自 `docs/_维护者/维护映射表.json`）。

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

> 新增子系统请先登记进 `docs/_维护者/维护映射表.json`，本手册下次重生会自动覆盖它。

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

**4.** 改任何文件前，先读 .ai/MAP.md 与 docs/_维护者/维护映射表.json 定位正确子系统。
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

**61.** 如果「要新增/修改一篇概念文档：命名用「[CONCEPT-NN] 什么是X.md」，保持房屋风格（callout/quiz/flip + mermaid 图），并在 00_INDEX_概念入门-总览.md 的 mermaid 与表格里补上交叉链接」，先读「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」相关文件（见 scripts/docs/check_beginner_docs.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。触发词命中时的第一反应。
  - 验证：`npm run docs:check-beginner`

**62.** 如果「要新增/修改一章修仙故事：正文要有剧情 + mermaid 图 + 「## 📒 凡人笔记」小白解读段 + 「【上一章｜下一章｜回总目录】」导航块，并在 00_INDEX_修仙学AI-总目录.md 登记」，先读「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」相关文件（见 scripts/docs/check_beginner_docs.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。触发词命中时的第一反应。
  - 验证：`npm run docs:check-beginner`

**63.** 如果「改完文档先跑 npm run docs:check-beginner 做单人维护体检，再跑 npm run docs:build 与 npm run docs:verify 生成并校验 HTML」，先读「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」相关文件（见 scripts/docs/check_beginner_docs.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。触发词命中时的第一反应。
  - 验证：`npm run docs:check-beginner`

**64.** 如果「要扩展体检规则：看 scripts/docs/check_beginner_docs.js 顶部的 HOW-TO-EXTEND 注释（新增 SECTIONS 条目或 checkSection 规则）」，先读「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」相关文件（见 scripts/docs/check_beginner_docs.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。触发词命中时的第一反应。
  - 验证：`npm run docs:check-beginner`

**65.** 如果「CLI does not start」，先读「Bootstrap and Packaging」相关文件（见 platform/khy_platform/cli.py），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Bootstrap and Packaging。触发词命中时的第一反应。
  - 验证：`npm run check:manifest-sync`

**66.** 如果「pip package layout is broken」，先读「Bootstrap and Packaging」相关文件（见 platform/khy_platform/cli.py），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Bootstrap and Packaging。触发词命中时的第一反应。
  - 验证：`npm run check:manifest-sync`

**67.** 如果「version numbers drift」，先读「Bootstrap and Packaging」相关文件（见 platform/khy_platform/cli.py），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Bootstrap and Packaging。触发词命中时的第一反应。
  - 验证：`npm run check:manifest-sync`

**68.** 如果「first-run bootstrap fails」，先读「Bootstrap and Packaging」相关文件（见 platform/khy_platform/cli.py），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Bootstrap and Packaging。触发词命中时的第一反应。
  - 验证：`npm run check:manifest-sync`

**69.** 如果「command not recognized」，先读「CLI Routing and Help Surface」相关文件（见 services/backend/src/constants/commandSchema.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：CLI Routing and Help Surface。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/cli/router.test.js services/backend/tests/cli/repl.tasks.interaction.test.js`

**70.** 如果「alias routes to wrong command」，先读「CLI Routing and Help Surface」相关文件（见 services/backend/src/constants/commandSchema.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：CLI Routing and Help Surface。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/cli/router.test.js services/backend/tests/cli/repl.tasks.interaction.test.js`

**71.** 如果「slash command missing」，先读「CLI Routing and Help Surface」相关文件（见 services/backend/src/constants/commandSchema.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：CLI Routing and Help Surface。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/cli/router.test.js services/backend/tests/cli/repl.tasks.interaction.test.js`

**72.** 如果「help text does not match behavior」，先读「CLI Routing and Help Surface」相关文件（见 services/backend/src/constants/commandSchema.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：CLI Routing and Help Surface。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/cli/router.test.js services/backend/tests/cli/repl.tasks.interaction.test.js`

**73.** 如果「system prompt assembly is wrong」，先读「Prompt Capsule and Debug Prompt System」相关文件（见 services/backend/src/constants/prompts.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Prompt Capsule and Debug Prompt System。触发词命中时的第一反应。
  - 验证：`node --test services/backend/tests/promptOnDemandSections.test.js`

**74.** 如果「on-demand capsules misfire」，先读「Prompt Capsule and Debug Prompt System」相关文件（见 services/backend/src/constants/prompts.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Prompt Capsule and Debug Prompt System。触发词命中时的第一反应。
  - 验证：`node --test services/backend/tests/promptOnDemandSections.test.js`

**75.** 如果「gateway debug-prompt output drifts」，先读「Prompt Capsule and Debug Prompt System」相关文件（见 services/backend/src/constants/prompts.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Prompt Capsule and Debug Prompt System。触发词命中时的第一反应。
  - 验证：`node --test services/backend/tests/promptOnDemandSections.test.js`

**76.** 如果「adapter selection is wrong」，先读「AI Gateway and Adapter Layer」相关文件（见 services/backend/src/services/gateway/aiGateway.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：AI Gateway and Adapter Layer。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/aiGateway.stability.test.js services/backend/tests/gateway/transportResilience.test.js services/backend/tests/gatewayAdapters.stability.test.js`

**77.** 如果「streaming breaks」，先读「AI Gateway and Adapter Layer」相关文件（见 services/backend/src/services/gateway/aiGateway.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：AI Gateway and Adapter Layer。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/aiGateway.stability.test.js services/backend/tests/gateway/transportResilience.test.js services/backend/tests/gatewayAdapters.stability.test.js`

**78.** 如果「model fallback is wrong」，先读「AI Gateway and Adapter Layer」相关文件（见 services/backend/src/services/gateway/aiGateway.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：AI Gateway and Adapter Layer。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/aiGateway.stability.test.js services/backend/tests/gateway/transportResilience.test.js services/backend/tests/gatewayAdapters.stability.test.js`

**79.** 如果「request normalization is wrong」，先读「AI Gateway and Adapter Layer」相关文件（见 services/backend/src/services/gateway/aiGateway.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：AI Gateway and Adapter Layer。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/aiGateway.stability.test.js services/backend/tests/gateway/transportResilience.test.js services/backend/tests/gatewayAdapters.stability.test.js`

**80.** 如果「daemon starts on wrong port」，先读「Proxy, Daemon, and Runtime Port Discovery」相关文件（见 services/backend/src/services/daemonManager.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Proxy, Daemon, and Runtime Port Discovery。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/daemonManager.runtimePort.test.js services/backend/tests/gatewayManage.portDrift.integration.test.js services/backend/tests/services/proxyBaseUrl.test.js services/backend/tests/services/serviceDefaults.test.js`

**81.** 如果「proxy URL is stale」，先读「Proxy, Daemon, and Runtime Port Discovery」相关文件（见 services/backend/src/services/daemonManager.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Proxy, Daemon, and Runtime Port Discovery。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/daemonManager.runtimePort.test.js services/backend/tests/gatewayManage.portDrift.integration.test.js services/backend/tests/services/proxyBaseUrl.test.js services/backend/tests/services/serviceDefaults.test.js`

**82.** 如果「gateway manage cannot reconnect」，先读「Proxy, Daemon, and Runtime Port Discovery」相关文件（见 services/backend/src/services/daemonManager.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Proxy, Daemon, and Runtime Port Discovery。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/daemonManager.runtimePort.test.js services/backend/tests/gatewayManage.portDrift.integration.test.js services/backend/tests/services/proxyBaseUrl.test.js services/backend/tests/services/serviceDefaults.test.js`

**83.** 如果「port drift appears after restart」，先读「Proxy, Daemon, and Runtime Port Discovery」相关文件（见 services/backend/src/services/daemonManager.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Proxy, Daemon, and Runtime Port Discovery。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/daemonManager.runtimePort.test.js services/backend/tests/gatewayManage.portDrift.integration.test.js services/backend/tests/services/proxyBaseUrl.test.js services/backend/tests/services/serviceDefaults.test.js`

**84.** 如果「gateway manage page is broken」，先读「AI Management UI and API」相关文件（见 services/backend/src/routes/aiGatewayAdmin.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：AI Management UI and API。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/routes/aiGatewayAdmin.modelSlots.test.js services/backend/tests/gatewayManage.apiDisplay.test.js`

**85.** 如果「AI management route fails」，先读「AI Management UI and API」相关文件（见 services/backend/src/routes/aiGatewayAdmin.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：AI Management UI and API。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/routes/aiGatewayAdmin.modelSlots.test.js services/backend/tests/gatewayManage.apiDisplay.test.js`

**86.** 如果「admin API and AI UI drift」，先读「AI Management UI and API」相关文件（见 services/backend/src/routes/aiGatewayAdmin.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：AI Management UI and API。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/routes/aiGatewayAdmin.modelSlots.test.js services/backend/tests/gatewayManage.apiDisplay.test.js`

**87.** 如果「projects workspace page is broken」，先读「Coding Projects (named workspaces + chat linkage)」相关文件（见 platform/packages/shared/src/models/UserProject.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/projectStore.test.js apps/ai-frontend/src/composables/useProjects.wiring.test.js`

**88.** 如果「chat sidebar project filter fails」，先读「Coding Projects (named workspaces + chat linkage)」相关文件（见 platform/packages/shared/src/models/UserProject.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/projectStore.test.js apps/ai-frontend/src/composables/useProjects.wiring.test.js`

**89.** 如果「conversations not filed under the right project」，先读「Coding Projects (named workspaces + chat linkage)」相关文件（见 platform/packages/shared/src/models/UserProject.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/projectStore.test.js apps/ai-frontend/src/composables/useProjects.wiring.test.js`

**90.** 如果「/api/ai/projects REST errors」，先读「Coding Projects (named workspaces + chat linkage)」相关文件（见 platform/packages/shared/src/models/UserProject.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/projectStore.test.js apps/ai-frontend/src/composables/useProjects.wiring.test.js`

**91.** 如果「workspace snapshot behavior is wrong」，先读「Workspace, Publish, and Verification Commands」相关文件（见 services/backend/src/cli/handlers/workspace.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Workspace, Publish, and Verification Commands。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/publish.sourceReleaseMode.test.js services/backend/tests/publish.dbPreflight.test.js`

**92.** 如果「publish command is broken」，先读「Workspace, Publish, and Verification Commands」相关文件（见 services/backend/src/cli/handlers/workspace.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Workspace, Publish, and Verification Commands。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/publish.sourceReleaseMode.test.js services/backend/tests/publish.dbPreflight.test.js`

**93.** 如果「verification workflow regressed」，先读「Workspace, Publish, and Verification Commands」相关文件（见 services/backend/src/cli/handlers/workspace.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Workspace, Publish, and Verification Commands。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/publish.sourceReleaseMode.test.js services/backend/tests/publish.dbPreflight.test.js`

**94.** 如果「you changed startup/network/task execution」，先读「Maintenance Safety and Rule Gates」相关文件（见 AGENTS.md），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Maintenance Safety and Rule Gates。触发词命中时的第一反应。
  - 验证：`npm run check:changed`

**95.** 如果「you need a fast changed-file gate」，先读「Maintenance Safety and Rule Gates」相关文件（见 AGENTS.md），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Maintenance Safety and Rule Gates。触发词命中时的第一反应。
  - 验证：`npm run check:changed`

**96.** 如果「you need to verify handoff guardrails」，先读「Maintenance Safety and Rule Gates」相关文件（见 AGENTS.md），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Maintenance Safety and Rule Gates。触发词命中时的第一反应。
  - 验证：`npm run check:changed`

**97.** 如果「you need a fixed, repeatable release path (check → build → audit → publish → verify)」，先读「Release and Rollback」相关文件（见 services/backend/src/cli/handlers/publish.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Release and Rollback。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/publish.sourceReleaseMode.test.js services/backend/tests/publish.dbPreflight.test.js`

**98.** 如果「an upgrade broke something and you must roll back to the last known-good version」，先读「Release and Rollback」相关文件（见 services/backend/src/cli/handlers/publish.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Release and Rollback。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/publish.sourceReleaseMode.test.js services/backend/tests/publish.dbPreflight.test.js`

**99.** 如果「you need to know which version is the current stable baseline」，先读「Release and Rollback」相关文件（见 services/backend/src/cli/handlers/publish.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Release and Rollback。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/publish.sourceReleaseMode.test.js services/backend/tests/publish.dbPreflight.test.js`

**100.** 如果「release artifacts or the post-release check regressed」，先读「Release and Rollback」相关文件（见 services/backend/src/cli/handlers/publish.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Release and Rollback。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/publish.sourceReleaseMode.test.js services/backend/tests/publish.dbPreflight.test.js`

**101.** 如果「the phrase 打造最佳环境 does not trigger the self-check pipeline」，先读「Build Best Environment (Self-check / Repair / Probes)」相关文件（见 services/backend/src/services/localBrainEnvOptimize.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Build Best Environment (Self-check / Repair / Probes)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/services/localBrainEnvOptimize.test.js services/backend/tests/services/envProbes.test.js services/backend/tests/services/envRepair.test.js services/backend/tests/services/envPlatform.test.js`

**102.** 如果「you want to add a new read-only health check (probe)」，先读「Build Best Environment (Self-check / Repair / Probes)」相关文件（见 services/backend/src/services/localBrainEnvOptimize.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Build Best Environment (Self-check / Repair / Probes)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/services/localBrainEnvOptimize.test.js services/backend/tests/services/envProbes.test.js services/backend/tests/services/envRepair.test.js services/backend/tests/services/envPlatform.test.js`

**103.** 如果「you want to add a new safe create-missing repair」，先读「Build Best Environment (Self-check / Repair / Probes)」相关文件（见 services/backend/src/services/localBrainEnvOptimize.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Build Best Environment (Self-check / Repair / Probes)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/services/localBrainEnvOptimize.test.js services/backend/tests/services/envProbes.test.js services/backend/tests/services/envRepair.test.js services/backend/tests/services/envPlatform.test.js`

**104.** 如果「a probe or repair should run only on some OSes (linux/windows/macos/android/ios)」，先读「Build Best Environment (Self-check / Repair / Probes)」相关文件（见 services/backend/src/services/localBrainEnvOptimize.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Build Best Environment (Self-check / Repair / Probes)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/services/localBrainEnvOptimize.test.js services/backend/tests/services/envProbes.test.js services/backend/tests/services/envRepair.test.js services/backend/tests/services/envPlatform.test.js`

**105.** 如果「the junk scan, repair, or probe section renders wrong」，先读「Build Best Environment (Self-check / Repair / Probes)」相关文件（见 services/backend/src/services/localBrainEnvOptimize.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Build Best Environment (Self-check / Repair / Probes)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/services/localBrainEnvOptimize.test.js services/backend/tests/services/envProbes.test.js services/backend/tests/services/envRepair.test.js services/backend/tests/services/envPlatform.test.js`

**106.** 如果「a novice user or weak AI needs a runnable list of safe next improvements」，先读「Evolution Prompt Playbook (1000 preset prompts)」相关文件（见 scripts/docs/gen-evolution-prompts.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Evolution Prompt Playbook (1000 preset prompts)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/gen-evolution-prompts.test.js`

**107.** 如果「the 1000-prompt playbook count or verify commands drifted」，先读「Evolution Prompt Playbook (1000 preset prompts)」相关文件（见 scripts/docs/gen-evolution-prompts.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Evolution Prompt Playbook (1000 preset prompts)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/gen-evolution-prompts.test.js`

**108.** 如果「you added a new subsystem and want the playbook to cover it」，先读「Evolution Prompt Playbook (1000 preset prompts)」相关文件（见 scripts/docs/gen-evolution-prompts.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Evolution Prompt Playbook (1000 preset prompts)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/gen-evolution-prompts.test.js`

**109.** 如果「the OPS-MAN-066 doc is out of sync with its generator」，先读「Evolution Prompt Playbook (1000 preset prompts)」相关文件（见 scripts/docs/gen-evolution-prompts.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Evolution Prompt Playbook (1000 preset prompts)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/gen-evolution-prompts.test.js`

**110.** 如果「you see an error or symptom but do not know which subsystem owns it」，先读「Symptom Triage (route a symptom to its subsystem)」相关文件（见 scripts/lib/maintainerTriage.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Symptom Triage (route a symptom to its subsystem)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/maintainerTriage.test.js`

**111.** 如果「a user or weak AI needs to be routed from a symptom to files and verify commands」，先读「Symptom Triage (route a symptom to its subsystem)」相关文件（见 scripts/lib/maintainerTriage.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Symptom Triage (route a symptom to its subsystem)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/maintainerTriage.test.js`

**112.** 如果「the triage matcher mis-routes a symptom」，先读「Symptom Triage (route a symptom to its subsystem)」相关文件（见 scripts/lib/maintainerTriage.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Symptom Triage (route a symptom to its subsystem)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/maintainerTriage.test.js`

**113.** 如果「the OPS-MAN-067 cheat sheet is out of sync with its generator」，先读「Symptom Triage (route a symptom to its subsystem)」相关文件（见 scripts/lib/maintainerTriage.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Symptom Triage (route a symptom to its subsystem)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/maintainerTriage.test.js`

**114.** 如果「a developer / user / maintainer installed khyos on a new machine and wants to know if it can fully restore」，先读「Off-machine Restore Readiness (can a fresh machine restore khyos?)」相关文件（见 scripts/lib/restoreReadiness.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Off-machine Restore Readiness (can a fresh machine restore khyos?)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreReadiness.test.js`

**115.** 如果「you need to explain what pip khy-os / npm @khy-os/khy-os actually bundle vs hydrate at first run」，先读「Off-machine Restore Readiness (can a fresh machine restore khyos?)」相关文件（见 scripts/lib/restoreReadiness.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Off-machine Restore Readiness (can a fresh machine restore khyos?)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreReadiness.test.js`

**116.** 如果「the restore self-check mis-reports readiness or a rule is missing」，先读「Off-machine Restore Readiness (can a fresh machine restore khyos?)」相关文件（见 scripts/lib/restoreReadiness.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Off-machine Restore Readiness (can a fresh machine restore khyos?)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreReadiness.test.js`

**117.** 如果「the OPS-MAN-068 restore checklist is out of sync with its generator」，先读「Off-machine Restore Readiness (can a fresh machine restore khyos?)」相关文件（见 scripts/lib/restoreReadiness.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Off-machine Restore Readiness (can a fresh machine restore khyos?)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreReadiness.test.js`

**118.** 如果「khyos was installed via pip khy-os / npm @khy-os/khy-os but fails to start and you suspect a truncated or partial bundle」，先读「Installed-copy Integrity (is the on-disk bundle actually complete?)」相关文件（见 scripts/lib/installIntegrity.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Installed-copy Integrity (is the on-disk bundle actually complete?)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/installIntegrity.test.js`

**119.** 如果「you need to verify the shipped bundle still contains every runtime-critical file」，先读「Installed-copy Integrity (is the on-disk bundle actually complete?)」相关文件（见 scripts/lib/installIntegrity.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Installed-copy Integrity (is the on-disk bundle actually complete?)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/installIntegrity.test.js`

**120.** 如果「a runtime-critical path was added/removed and CRITICAL_BUNDLE_PATHS must track the publish gate」，先读「Installed-copy Integrity (is the on-disk bundle actually complete?)」相关文件（见 scripts/lib/installIntegrity.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Installed-copy Integrity (is the on-disk bundle actually complete?)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/installIntegrity.test.js`

**121.** 如果「the OPS-MAN-069 installed-copy checklist is out of sync with its generator」，先读「Installed-copy Integrity (is the on-disk bundle actually complete?)」相关文件（见 scripts/lib/installIntegrity.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Installed-copy Integrity (is the on-disk bundle actually complete?)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/installIntegrity.test.js`

**122.** 如果「khyos installed and the bundle is complete, but the backend still fails to start and you suspect node_modules is missing or half-installed」，先读「First-run Hydration Health (did the online dependency hydrate actually succeed?)」相关文件（见 scripts/lib/hydrationHealth.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：First-run Hydration Health (did the online dependency hydrate actually succeed?)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/hydrationHealth.test.js`

**123.** 如果「you need to detect the splitbrain case: the .khy_quant_bootstrapped marker says hydration is done but node_modules was deleted」，先读「First-run Hydration Health (did the online dependency hydrate actually succeed?)」相关文件（见 scripts/lib/hydrationHealth.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：First-run Hydration Health (did the online dependency hydrate actually succeed?)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/hydrationHealth.test.js`

**124.** 如果「the @khy/shared workspace symlink is broken, or a critical runtime dependency is missing」，先读「First-run Hydration Health (did the online dependency hydrate actually succeed?)」相关文件（见 scripts/lib/hydrationHealth.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：First-run Hydration Health (did the online dependency hydrate actually succeed?)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/hydrationHealth.test.js`

**125.** 如果「a runtime dependency was renamed/removed and CRITICAL_PACKAGES must track services/backend package.json」，先读「First-run Hydration Health (did the online dependency hydrate actually succeed?)」相关文件（见 scripts/lib/hydrationHealth.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：First-run Hydration Health (did the online dependency hydrate actually succeed?)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/hydrationHealth.test.js`

**126.** 如果「the OPS-MAN-070 hydration checklist is out of sync with its generator」，先读「First-run Hydration Health (did the online dependency hydrate actually succeed?)」相关文件（见 scripts/lib/hydrationHealth.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：First-run Hydration Health (did the online dependency hydrate actually succeed?)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/hydrationHealth.test.js`

**127.** 如果「a landing agent (or a human) on a fresh machine wants ONE ordered restore plan instead of reconciling three separate self-checks by hand」，先读「Agent Restore Plan Synthesizer (one ordered, autonomy-classified restore plan a landing agent can drive)」相关文件（见 scripts/lib/agentRestorePlan.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Agent Restore Plan Synthesizer (one ordered, autonomy-classified restore plan a landing agent can drive)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/agentRestorePlan.test.js`

**128.** 如果「you need to know which restore steps an agent may run unattended vs which must stop and escalate to a human」，先读「Agent Restore Plan Synthesizer (one ordered, autonomy-classified restore plan a landing agent can drive)」相关文件（见 scripts/lib/agentRestorePlan.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Agent Restore Plan Synthesizer (one ordered, autonomy-classified restore plan a landing agent can drive)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/agentRestorePlan.test.js`

**129.** 如果「restore-check / verify-install / hydration-doctor each report overlapping symptoms and you want them deduped and dependency-ordered」，先读「Agent Restore Plan Synthesizer (one ordered, autonomy-classified restore plan a landing agent can drive)」相关文件（见 scripts/lib/agentRestorePlan.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Agent Restore Plan Synthesizer (one ordered, autonomy-classified restore plan a landing agent can drive)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/agentRestorePlan.test.js`

**130.** 如果「a new rule id was added to any of the three mirrors and needs an autonomy/order entry in _CONCERN_POLICY」，先读「Agent Restore Plan Synthesizer (one ordered, autonomy-classified restore plan a landing agent can drive)」相关文件（见 scripts/lib/agentRestorePlan.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Agent Restore Plan Synthesizer (one ordered, autonomy-classified restore plan a landing agent can drive)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/agentRestorePlan.test.js`

**131.** 如果「the OPS-MAN-075 restore-plan doc is out of sync with its generator」，先读「Agent Restore Plan Synthesizer (one ordered, autonomy-classified restore plan a landing agent can drive)」相关文件（见 scripts/lib/agentRestorePlan.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Agent Restore Plan Synthesizer (one ordered, autonomy-classified restore plan a landing agent can drive)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/agentRestorePlan.test.js`

**132.** 如果「a landing agent is about to auto-drive the composed restore plan and must first confirm its three sensors are not internally inconsistent」，先读「Cross-mirror Restore Conflict Detector (do the three restore self-checks contradict each other before an agent auto-drives?)」相关文件（见 scripts/lib/restoreConflictDetector.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Cross-mirror Restore Conflict Detector (do the three restore self-checks contradict each other before an agent auto-drives?)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreConflictDetector.test.js`

**133.** 如果「restore-check says ready but verify-install says incomplete, or hydration-doctor says unhealthy — you need to know if that is a real contradiction or just a severity disagreement」，先读「Cross-mirror Restore Conflict Detector (do the three restore self-checks contradict each other before an agent auto-drives?)」相关文件（见 scripts/lib/restoreConflictDetector.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Cross-mirror Restore Conflict Detector (do the three restore self-checks contradict each other before an agent auto-drives?)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreConflictDetector.test.js`

**134.** 如果「one mirror's top-line verdict contradicts its own blockers/missing list (self-inconsistency / corrupted install)」，先读「Cross-mirror Restore Conflict Detector (do the three restore self-checks contradict each other before an agent auto-drives?)」相关文件（见 scripts/lib/restoreConflictDetector.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Cross-mirror Restore Conflict Detector (do the three restore self-checks contradict each other before an agent auto-drives?)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreConflictDetector.test.js`

**135.** 如果「you need safeToAutodrive to gate unattended restore: false = escalate/re-probe, never act on a contradictory world-model」，先读「Cross-mirror Restore Conflict Detector (do the three restore self-checks contradict each other before an agent auto-drives?)」相关文件（见 scripts/lib/restoreConflictDetector.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Cross-mirror Restore Conflict Detector (do the three restore self-checks contradict each other before an agent auto-drives?)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreConflictDetector.test.js`

**136.** 如果「a new cross-mirror contradiction class was found and needs a rule in _CONFLICT_RULES」，先读「Cross-mirror Restore Conflict Detector (do the three restore self-checks contradict each other before an agent auto-drives?)」相关文件（见 scripts/lib/restoreConflictDetector.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Cross-mirror Restore Conflict Detector (do the three restore self-checks contradict each other before an agent auto-drives?)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreConflictDetector.test.js`

**137.** 如果「the OPS-MAN-076 conflict-detector doc is out of sync with its generator」，先读「Cross-mirror Restore Conflict Detector (do the three restore self-checks contradict each other before an agent auto-drives?)」相关文件（见 scripts/lib/restoreConflictDetector.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Cross-mirror Restore Conflict Detector (do the three restore self-checks contradict each other before an agent auto-drives?)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreConflictDetector.test.js`

**138.** 如果「restore-conflicts reported a contradiction and you need the ordered recovery chain to walk out of it, not just a blanket 'stop, human'」，先读「Cross-mirror Restore Conflict Resolver (given a detected contradiction, how does an agent safely resolve it step-by-step, and where must it hand off to a human?)」相关文件（见 scripts/lib/restoreConflictResolver.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Cross-mirror Restore Conflict Resolver (given a detected contradiction, how does an agent safely resolve it step-by-step, and where must it hand off to a human?)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreConflictResolver.test.js`

**139.** 如果「you need autoResolvable to gate self-drive: true = agent runs the moves and continues; false = run agent moves then stop at firstHumanMove」，先读「Cross-mirror Restore Conflict Resolver (given a detected contradiction, how does an agent safely resolve it step-by-step, and where must it hand off to a human?)」相关文件（见 scripts/lib/restoreConflictResolver.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Cross-mirror Restore Conflict Resolver (given a detected contradiction, how does an agent safely resolve it step-by-step, and where must it hand off to a human?)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreConflictResolver.test.js`

**140.** 如果「a self-inconsistent mirror (verdict vs list) should be resolved by trusting the concrete evidence list over the derived boolean (reconcile)」，先读「Cross-mirror Restore Conflict Resolver (given a detected contradiction, how does an agent safely resolve it step-by-step, and where must it hand off to a human?)」相关文件（见 scripts/lib/restoreConflictResolver.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Cross-mirror Restore Conflict Resolver (given a detected contradiction, how does an agent safely resolve it step-by-step, and where must it hand off to a human?)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreConflictResolver.test.js`

**141.** 如果「a hydration-blocked contradiction must be graded: first-run-normal or agent-fixable blockers auto-resolve; structural blockers (seed-missing) escalate」，先读「Cross-mirror Restore Conflict Resolver (given a detected contradiction, how does an agent safely resolve it step-by-step, and where must it hand off to a human?)」相关文件（见 scripts/lib/restoreConflictResolver.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Cross-mirror Restore Conflict Resolver (given a detected contradiction, how does an agent safely resolve it step-by-step, and where must it hand off to a human?)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreConflictResolver.test.js`

**142.** 如果「the detector added a new _CONFLICT_RULES id and _RESOLUTIONS must gain a matching resolution (the drift guard test enforces parity)」，先读「Cross-mirror Restore Conflict Resolver (given a detected contradiction, how does an agent safely resolve it step-by-step, and where must it hand off to a human?)」相关文件（见 scripts/lib/restoreConflictResolver.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Cross-mirror Restore Conflict Resolver (given a detected contradiction, how does an agent safely resolve it step-by-step, and where must it hand off to a human?)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreConflictResolver.test.js`

**143.** 如果「the OPS-MAN-079 conflict-resolver doc is out of sync with its generator」，先读「Cross-mirror Restore Conflict Resolver (given a detected contradiction, how does an agent safely resolve it step-by-step, and where must it hand off to a human?)」相关文件（见 scripts/lib/restoreConflictResolver.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Cross-mirror Restore Conflict Resolver (given a detected contradiction, how does an agent safely resolve it step-by-step, and where must it hand off to a human?)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreConflictResolver.test.js`

**144.** 如果「a fresh pip khy-os install dies at startup with 'CLI 入口脚本 缺失 / bin/khy.js missing' even though the package looked fine」，先读「Off-machine Launch-entry Contract (does each channel pin the launch script it execs?)」相关文件（见 scripts/lib/bundleLaunchContract.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Off-machine Launch-entry Contract (does each channel pin the launch script it execs?)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/bundleLaunchContract.test.js`

**145.** 如果「you need to guarantee that pip and npm each pin their own launch entrypoint (bin/khy.js, server.js) in their publish-completeness audit」，先读「Off-machine Launch-entry Contract (does each channel pin the launch script it execs?)」相关文件（见 scripts/lib/bundleLaunchContract.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Off-machine Launch-entry Contract (does each channel pin the launch script it execs?)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/bundleLaunchContract.test.js`

**146.** 如果「a launch-critical bundle file was added/removed and it must be pinned in all three lists (pip REQUIRED_WHEEL_PATHS/REQUIRED_SDIST_PATHS + npm REQUIRED_PATHS)」，先读「Off-machine Launch-entry Contract (does each channel pin the launch script it execs?)」相关文件（见 scripts/lib/bundleLaunchContract.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Off-machine Launch-entry Contract (does each channel pin the launch script it execs?)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/bundleLaunchContract.test.js`

**147.** 如果「the channel-parity guard reports a channel that ships an entrypoint it never audits」，先读「Off-machine Launch-entry Contract (does each channel pin the launch script it execs?)」相关文件（见 scripts/lib/bundleLaunchContract.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Off-machine Launch-entry Contract (does each channel pin the launch script it execs?)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/bundleLaunchContract.test.js`

**148.** 如果「selected proxy node does not route traffic」，先读「Proxy Egress Bridge (select node + enable/disable)」相关文件（见 services/backend/src/services/proxy/proxyCoreConfigGen.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Proxy Egress Bridge (select node + enable/disable)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/proxyCoreConfigGen.test.js services/backend/tests/proxyCoreManager.test.js services/backend/tests/proxyConfigService.egress.test.js services/backend/tests/aiManagementProxyEgress.wiring.test.js apps/ai-frontend/src/composables/useProxies.egress.wiring.test.js services/backend/tests/bootstrap/ensureProxyCoreEnv.test.js services/backend/tests/services/proxyCoreInstaller.test.js`

**149.** 如果「proxy enable/disable toggle fails」，先读「Proxy Egress Bridge (select node + enable/disable)」相关文件（见 services/backend/src/services/proxy/proxyCoreConfigGen.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Proxy Egress Bridge (select node + enable/disable)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/proxyCoreConfigGen.test.js services/backend/tests/proxyCoreManager.test.js services/backend/tests/proxyConfigService.egress.test.js services/backend/tests/aiManagementProxyEgress.wiring.test.js apps/ai-frontend/src/composables/useProxies.egress.wiring.test.js services/backend/tests/bootstrap/ensureProxyCoreEnv.test.js services/backend/tests/services/proxyCoreInstaller.test.js`

**150.** 如果「core-required node reports core-missing but no guidance shown」，先读「Proxy Egress Bridge (select node + enable/disable)」相关文件（见 services/backend/src/services/proxy/proxyCoreConfigGen.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Proxy Egress Bridge (select node + enable/disable)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/proxyCoreConfigGen.test.js services/backend/tests/proxyCoreManager.test.js services/backend/tests/proxyConfigService.egress.test.js services/backend/tests/aiManagementProxyEgress.wiring.test.js apps/ai-frontend/src/composables/useProxies.egress.wiring.test.js services/backend/tests/bootstrap/ensureProxyCoreEnv.test.js services/backend/tests/services/proxyCoreInstaller.test.js`

**151.** 如果「/api/proxy-egress REST errors」，先读「Proxy Egress Bridge (select node + enable/disable)」相关文件（见 services/backend/src/services/proxy/proxyCoreConfigGen.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Proxy Egress Bridge (select node + enable/disable)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/proxyCoreConfigGen.test.js services/backend/tests/proxyCoreManager.test.js services/backend/tests/proxyConfigService.egress.test.js services/backend/tests/aiManagementProxyEgress.wiring.test.js apps/ai-frontend/src/composables/useProxies.egress.wiring.test.js services/backend/tests/bootstrap/ensureProxyCoreEnv.test.js services/backend/tests/services/proxyCoreInstaller.test.js`

**152.** 如果「HTTP_PROXY env not applied after choosing a node」，先读「Proxy Egress Bridge (select node + enable/disable)」相关文件（见 services/backend/src/services/proxy/proxyCoreConfigGen.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Proxy Egress Bridge (select node + enable/disable)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/proxyCoreConfigGen.test.js services/backend/tests/proxyCoreManager.test.js services/backend/tests/proxyConfigService.egress.test.js services/backend/tests/aiManagementProxyEgress.wiring.test.js apps/ai-frontend/src/composables/useProxies.egress.wiring.test.js services/backend/tests/bootstrap/ensureProxyCoreEnv.test.js services/backend/tests/services/proxyCoreInstaller.test.js`

**153.** 如果「raw node still asks to set KHY_PROXY_CORE=1 after pip/npm install (env not auto-seeded)」，先读「Proxy Egress Bridge (select node + enable/disable)」相关文件（见 services/backend/src/services/proxy/proxyCoreConfigGen.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Proxy Egress Bridge (select node + enable/disable)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/proxyCoreConfigGen.test.js services/backend/tests/proxyCoreManager.test.js services/backend/tests/proxyConfigService.egress.test.js services/backend/tests/aiManagementProxyEgress.wiring.test.js apps/ai-frontend/src/composables/useProxies.egress.wiring.test.js services/backend/tests/bootstrap/ensureProxyCoreEnv.test.js services/backend/tests/services/proxyCoreInstaller.test.js`

**154.** 如果「mihomo core binary missing and not auto-installed out of the box」，先读「Proxy Egress Bridge (select node + enable/disable)」相关文件（见 services/backend/src/services/proxy/proxyCoreConfigGen.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Proxy Egress Bridge (select node + enable/disable)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/proxyCoreConfigGen.test.js services/backend/tests/proxyCoreManager.test.js services/backend/tests/proxyConfigService.egress.test.js services/backend/tests/aiManagementProxyEgress.wiring.test.js apps/ai-frontend/src/composables/useProxies.egress.wiring.test.js services/backend/tests/bootstrap/ensureProxyCoreEnv.test.js services/backend/tests/services/proxyCoreInstaller.test.js`

**155.** 如果「web proxy page says 'download mihomo' but never shows where to download it (download URL / dest path missing)」，先读「Proxy Egress Bridge (select node + enable/disable)」相关文件（见 services/backend/src/services/proxy/proxyCoreConfigGen.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Proxy Egress Bridge (select node + enable/disable)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/proxyCoreConfigGen.test.js services/backend/tests/proxyCoreManager.test.js services/backend/tests/proxyConfigService.egress.test.js services/backend/tests/aiManagementProxyEgress.wiring.test.js apps/ai-frontend/src/composables/useProxies.egress.wiring.test.js services/backend/tests/bootstrap/ensureProxyCoreEnv.test.js services/backend/tests/services/proxyCoreInstaller.test.js`

**156.** 如果「a fresh pip/npm install starts up and dies with a raw MODULE_NOT_FOUND stack trace and no explanation of why or how to fix it」，先读「Startup Failure Real-cause + Fix (does a fresh-machine crash say WHY and HOW, not just a raw stack?)」相关文件（见 services/backend/src/bootstrap/startupFailureExplain.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Startup Failure Real-cause + Fix (does a fresh-machine crash say WHY and HOW, not just a raw stack?)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/bootstrap/startupFailureExplain.test.js`

**157.** 如果「the backend's node_modules is half-installed / not hydrated / cleared, and you want the crash to name the real cause + a copy-paste fix instead of a cryptic trace」，先读「Startup Failure Real-cause + Fix (does a fresh-machine crash say WHY and HOW, not just a raw stack?)」相关文件（见 services/backend/src/bootstrap/startupFailureExplain.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Startup Failure Real-cause + Fix (does a fresh-machine crash say WHY and HOW, not just a raw stack?)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/bootstrap/startupFailureExplain.test.js`

**158.** 如果「a native module (better-sqlite3 等) was copied across platforms without rebuild and crashes with ERR_DLOPEN_FAILED」，先读「Startup Failure Real-cause + Fix (does a fresh-machine crash say WHY and HOW, not just a raw stack?)」相关文件（见 services/backend/src/bootstrap/startupFailureExplain.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Startup Failure Real-cause + Fix (does a fresh-machine crash say WHY and HOW, not just a raw stack?)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/bootstrap/startupFailureExplain.test.js`

**159.** 如果「you need to add a new class of first-run crash → real-cause + fix mapping shown by bin/khy.js _emitFatal」，先读「Startup Failure Real-cause + Fix (does a fresh-machine crash say WHY and HOW, not just a raw stack?)」相关文件（见 services/backend/src/bootstrap/startupFailureExplain.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Startup Failure Real-cause + Fix (does a fresh-machine crash say WHY and HOW, not just a raw stack?)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/bootstrap/startupFailureExplain.test.js`

**160.** 如果「right-click a .md file on Windows → '选择一个应用以打开此.md文件' → khy is missing from the 建议的应用/Recommended apps section」，先读「Windows .md Suggested-app Registration (does khy show in the Open-With '建议的应用' list?)」相关文件（见 services/backend/src/services/mdSuggestedAppsPlan.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Windows .md Suggested-app Registration (does khy show in the Open-With '建议的应用' list?)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/services/mdSuggestedAppsPlan.test.js`

**161.** 如果「you need khy to register as a recommended handler for .md/.markdown via Applications\<app>\SupportedTypes (not just OpenWithProgids)」，先读「Windows .md Suggested-app Registration (does khy show in the Open-With '建议的应用' list?)」相关文件（见 services/backend/src/services/mdSuggestedAppsPlan.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Windows .md Suggested-app Registration (does khy show in the Open-With '建议的应用' list?)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/services/mdSuggestedAppsPlan.test.js`

**162.** 如果「you add a new extension khy should be suggested to open, and must keep register/unregister PS1 symmetric (zero registry residue)」，先读「Windows .md Suggested-app Registration (does khy show in the Open-With '建议的应用' list?)」相关文件（见 services/backend/src/services/mdSuggestedAppsPlan.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Windows .md Suggested-app Registration (does khy show in the Open-With '建议的应用' list?)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/services/mdSuggestedAppsPlan.test.js`

**163.** 如果「the md-editor first-run auto-registration (mdEditorRegister) spawns register-windows.ps1 and you need to know exactly which HKCU keys it writes」，先读「Windows .md Suggested-app Registration (does khy show in the Open-With '建议的应用' list?)」相关文件（见 services/backend/src/services/mdSuggestedAppsPlan.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Windows .md Suggested-app Registration (does khy show in the Open-With '建议的应用' list?)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/services/mdSuggestedAppsPlan.test.js`

**164.** 如果「a user on a fresh machine installed via pip/npm and `khy` fails to start or behaves oddly — they need one command telling them the root cause and exact fix」，先读「Fresh-machine Off-machine-restore Self-check in `khy doctor` (真实原因+解决方法 for a fresh pip/npm install)」相关文件（见 services/backend/src/services/freshInstallDoctor.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Fresh-machine Off-machine-restore Self-check in `khy doctor` (真实原因+解决方法 for a fresh pip/npm install)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/services/freshInstallDoctor.test.js`

**165.** 如果「you want `khy doctor` to surface the shipped, human-facing off-machine-restore concerns: launch entry (bin/khy.js), server entry (server.js), dependency hydration (node_modules), khy-command reachability (PATH vs `python -m khy_platform`)」，先读「Fresh-machine Off-machine-restore Self-check in `khy doctor` (真实原因+解决方法 for a fresh pip/npm install)」相关文件（见 services/backend/src/services/freshInstallDoctor.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Fresh-machine Off-machine-restore Self-check in `khy doctor` (真实原因+解决方法 for a fresh pip/npm install)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/services/freshInstallDoctor.test.js`

**166.** 如果「you add a new fresh-install concern and must keep the pure assessor / IO gatherer split (assessFreshInstall never does IO, gatherFreshInstallFacts is injectable)」，先读「Fresh-machine Off-machine-restore Self-check in `khy doctor` (真实原因+解决方法 for a fresh pip/npm install)」相关文件（见 services/backend/src/services/freshInstallDoctor.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Fresh-machine Off-machine-restore Self-check in `khy doctor` (真实原因+解决方法 for a fresh pip/npm install)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/services/freshInstallDoctor.test.js`

**167.** 如果「this is the human-facing complement to the agent-facing restore-plan (agentRestorePlan) and the build-time mirrors (scripts/lib/restoreReadiness/installIntegrity/hydrationHealth)」，先读「Fresh-machine Off-machine-restore Self-check in `khy doctor` (真实原因+解决方法 for a fresh pip/npm install)」相关文件（见 services/backend/src/services/freshInstallDoctor.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Fresh-machine Off-machine-restore Self-check in `khy doctor` (真实原因+解决方法 for a fresh pip/npm install)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/services/freshInstallDoctor.test.js`

**168.** 如果「a user runs /recap on a Chinese conversation and decisions/insights/open-questions come back empty, or file names get truncated at full-width punctuation (。，；！？) — the recap extractors were English-only」，先读「CJK-ize /recap so session recap produces content on Chinese sessions」相关文件（见 services/backend/src/services/sessionRecapCjk.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：CJK-ize /recap so session recap produces content on Chinese sessions。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/services/sessionRecapCjk.test.js services/backend/tests/services/sessionRecapService.cjk.test.js`

**169.** 如果「you add a new Chinese decision/insight trigger stem or a new CJK terminator — extend the frozen arrays in sessionRecapCjk.js (_CJK_DECISION_MARKERS/_CJK_INSIGHT_MARKERS/_CJK_TERMINATORS)」，先读「CJK-ize /recap so session recap produces content on Chinese sessions」相关文件（见 services/backend/src/services/sessionRecapCjk.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：CJK-ize /recap so session recap produces content on Chinese sessions。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/services/sessionRecapCjk.test.js services/backend/tests/services/sessionRecapService.cjk.test.js`

**170.** 如果「the CJK extraction is additive (union with the English extractors) and gated KHY_RECAP_CJK default-on; gate off byte-reverts generateRecap to the original English behavior」，先读「CJK-ize /recap so session recap produces content on Chinese sessions」相关文件（见 services/backend/src/services/sessionRecapCjk.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：CJK-ize /recap so session recap produces content on Chinese sessions。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/services/sessionRecapCjk.test.js services/backend/tests/services/sessionRecapService.cjk.test.js`

**171.** 如果「this is the extraction complement to the /recap command shell (handlers/recap.js, gate KHY_RECAP) and the deterministic base service sessionRecapService.js」，先读「CJK-ize /recap so session recap produces content on Chinese sessions」相关文件（见 services/backend/src/services/sessionRecapCjk.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：CJK-ize /recap so session recap produces content on Chinese sessions。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/services/sessionRecapCjk.test.js services/backend/tests/services/sessionRecapService.cjk.test.js`

**172.** 如果「a user installs @khy-os/khy-os on a machine with Node < 20 and khy crashes cryptically deep in the backend instead of saying "need Node >= 20" — the pip channel already guards this via check_node, the npm launcher did not」，先读「npm-channel Node version preflight (parity with pip check_node; kills the cross-channel off-machine-restore contradiction)」相关文件（见 packaging/npm/scripts/nodeVersionPreflight.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：npm-channel Node version preflight (parity with pip check_node; kills the cross-channel off-machine-restore contradiction)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- packaging/npm/test/nodeVersionPreflight.test.js`

**173.** 如果「you raise the minimum Node major: keep MIN_MAJOR in nodeVersionPreflight.js in sync with pip cli.py check_node (major>=20), backend package.json engines, and devenv.js TOOLCHAINS」，先读「npm-channel Node version preflight (parity with pip check_node; kills the cross-channel off-machine-restore contradiction)」相关文件（见 packaging/npm/scripts/nodeVersionPreflight.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：npm-channel Node version preflight (parity with pip check_node; kills the cross-channel off-machine-restore contradiction)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- packaging/npm/test/nodeVersionPreflight.test.js`

**174.** 如果「you add a platform install hint or a China-mirror branch — extend _platformHint / _isChina, mirroring pip _print_node_install_hint」，先读「npm-channel Node version preflight (parity with pip check_node; kills the cross-channel off-machine-restore contradiction)」相关文件（见 packaging/npm/scripts/nodeVersionPreflight.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：npm-channel Node version preflight (parity with pip check_node; kills the cross-channel off-machine-restore contradiction)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- packaging/npm/test/nodeVersionPreflight.test.js`

**175.** 如果「the preflight is additive and gated KHY_NPM_NODE_PREFLIGHT default-on; gate off / any error / unparseable version byte-reverts bin/khy.js to the original unconditional spawnSync handoff (preflight must never be more fragile than the launch it protects)」，先读「npm-channel Node version preflight (parity with pip check_node; kills the cross-channel off-machine-restore contradiction)」相关文件（见 packaging/npm/scripts/nodeVersionPreflight.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：npm-channel Node version preflight (parity with pip check_node; kills the cross-channel off-machine-restore contradiction)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- packaging/npm/test/nodeVersionPreflight.test.js`

**176.** 如果「an agent is executing the restore-resolve recovery chain and needs, after each move + re-probe, a verdict on whether restore state actually advanced」，先读「Restore Convergence & Loop-Guard Verifier (after an agent executes a restore move and re-probes, did it actually advance? stop, continue, or escalate?)」相关文件（见 scripts/lib/restoreConvergenceVerifier.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Restore Convergence & Loop-Guard Verifier (after an agent executes a restore move and re-probes, did it actually advance? stop, continue, or escalate?)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreConvergenceVerifier.test.js`

**177.** 如果「you must close the restore family execution feedback loop: plan/conflicts/resolve are open-loop planners; this layer judges executed moves」，先读「Restore Convergence & Loop-Guard Verifier (after an agent executes a restore move and re-probes, did it actually advance? stop, continue, or escalate?)」相关文件（见 scripts/lib/restoreConvergenceVerifier.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Restore Convergence & Loop-Guard Verifier (after an agent executes a restore move and re-probes, did it actually advance? stop, continue, or escalate?)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreConvergenceVerifier.test.js`

**178.** 如果「guard against the self-drive failure modes at the restore layer: no-progress infinite loop, undetected regression, not-stopping-after-converged」，先读「Restore Convergence & Loop-Guard Verifier (after an agent executes a restore move and re-probes, did it actually advance? stop, continue, or escalate?)」相关文件（见 scripts/lib/restoreConvergenceVerifier.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Restore Convergence & Loop-Guard Verifier (after an agent executes a restore move and re-probes, did it actually advance? stop, continue, or escalate?)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreConvergenceVerifier.test.js`

**179.** 如果「you need the stop condition: converged-stop (all three mirrors green) / continue (advancing) / escalate-human (regressed or stalled to the limit)」，先读「Restore Convergence & Loop-Guard Verifier (after an agent executes a restore move and re-probes, did it actually advance? stop, continue, or escalate?)」相关文件（见 scripts/lib/restoreConvergenceVerifier.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Restore Convergence & Loop-Guard Verifier (after an agent executes a restore move and re-probes, did it actually advance? stop, continue, or escalate?)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreConvergenceVerifier.test.js`

**180.** 如果「tune the loop-guard sensitivity via STALL_LIMIT (consecutive no-progress rounds before forced human escalation)」，先读「Restore Convergence & Loop-Guard Verifier (after an agent executes a restore move and re-probes, did it actually advance? stop, continue, or escalate?)」相关文件（见 scripts/lib/restoreConvergenceVerifier.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Restore Convergence & Loop-Guard Verifier (after an agent executes a restore move and re-probes, did it actually advance? stop, continue, or escalate?)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreConvergenceVerifier.test.js`

**181.** 如果「adding a new mirror/concern source: extend _unresolvedKeys(snapshot) only; set-diff verdict logic then applies automatically」，先读「Restore Convergence & Loop-Guard Verifier (after an agent executes a restore move and re-probes, did it actually advance? stop, continue, or escalate?)」相关文件（见 scripts/lib/restoreConvergenceVerifier.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Restore Convergence & Loop-Guard Verifier (after an agent executes a restore move and re-probes, did it actually advance? stop, continue, or escalate?)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreConvergenceVerifier.test.js`

**182.** 如果「the OPS-MAN-082 convergence doc is out of sync with its generator」，先读「Restore Convergence & Loop-Guard Verifier (after an agent executes a restore move and re-probes, did it actually advance? stop, continue, or escalate?)」相关文件（见 scripts/lib/restoreConvergenceVerifier.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Restore Convergence & Loop-Guard Verifier (after an agent executes a restore move and re-probes, did it actually advance? stop, continue, or escalate?)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreConvergenceVerifier.test.js`

**183.** 如果「khy auto-decomposes a goal into subtasks and you want the ones with declared dependencies (explore → implement → verify) to run in ORDER, not all fanned out at once」，先读「Dependency-aware WAVE scheduling + fault-aware execution + predecessor-result injection for auto-decomposed subtasks (拆任务 → 有序并行 → 依赖失败则跳过下游并如实汇报 → 前驱结果注入下游不再盲跑 → 跳过与失败在最终报告分列 → 确定性顺序链拆解让整条 arc 在默认离机路径活起来 → 按角色收窄子智能体工具集,只读角色不给写工具 → 多个并行子任务改同一文件时如实告警可能的写-写覆盖 → 成功但零产出的子任务如实标注不折进完成 → 最终报告按角色标注每个子任务并把失败按类型分布,让失败的验证子任务不被匿名折进失败)」相关文件（见 services/backend/src/services/orchestrator/dependencyWaveScheduler.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Dependency-aware WAVE scheduling + fault-aware execution + predecessor-result injection for auto-decomposed subtasks (拆任务 → 有序并行 → 依赖失败则跳过下游并如实汇报 → 前驱结果注入下游不再盲跑 → 跳过与失败在最终报告分列 → 确定性顺序链拆解让整条 arc 在默认离机路径活起来 → 按角色收窄子智能体工具集,只读角色不给写工具 → 多个并行子任务改同一文件时如实告警可能的写-写覆盖 → 成功但零产出的子任务如实标注不折进完成 → 最终报告按角色标注每个子任务并把失败按类型分布,让失败的验证子任务不被匿名折进失败)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/services/orchestrator/dependencyWaveScheduler.test.js services/backend/tests/services/mergeResultsSkipDistinct.test.js services/backend/tests/services/sequentialChainDecompose.test.js services/backend/tests/services/orchestrator/roleToolScope.test.js services/backend/tests/services/orchestrator/mergeFileConflicts.test.js services/backend/tests/services/orchestrator/mergeEmptySuccess.test.js services/backend/tests/services/orchestrator/mergeRoleAttribution.test.js`

**184.** 如果「a subtask carries a `dependencies` field (from _llmDecomposer or a future strategy) that must be honored as execution order instead of being dropped」，先读「Dependency-aware WAVE scheduling + fault-aware execution + predecessor-result injection for auto-decomposed subtasks (拆任务 → 有序并行 → 依赖失败则跳过下游并如实汇报 → 前驱结果注入下游不再盲跑 → 跳过与失败在最终报告分列 → 确定性顺序链拆解让整条 arc 在默认离机路径活起来 → 按角色收窄子智能体工具集,只读角色不给写工具 → 多个并行子任务改同一文件时如实告警可能的写-写覆盖 → 成功但零产出的子任务如实标注不折进完成 → 最终报告按角色标注每个子任务并把失败按类型分布,让失败的验证子任务不被匿名折进失败)」相关文件（见 services/backend/src/services/orchestrator/dependencyWaveScheduler.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Dependency-aware WAVE scheduling + fault-aware execution + predecessor-result injection for auto-decomposed subtasks (拆任务 → 有序并行 → 依赖失败则跳过下游并如实汇报 → 前驱结果注入下游不再盲跑 → 跳过与失败在最终报告分列 → 确定性顺序链拆解让整条 arc 在默认离机路径活起来 → 按角色收窄子智能体工具集,只读角色不给写工具 → 多个并行子任务改同一文件时如实告警可能的写-写覆盖 → 成功但零产出的子任务如实标注不折进完成 → 最终报告按角色标注每个子任务并把失败按类型分布,让失败的验证子任务不被匿名折进失败)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/services/orchestrator/dependencyWaveScheduler.test.js services/backend/tests/services/mergeResultsSkipDistinct.test.js services/backend/tests/services/sequentialChainDecompose.test.js services/backend/tests/services/orchestrator/roleToolScope.test.js services/backend/tests/services/orchestrator/mergeFileConflicts.test.js services/backend/tests/services/orchestrator/mergeEmptySuccess.test.js services/backend/tests/services/orchestrator/mergeRoleAttribution.test.js`

**185.** 如果「you add a new dependency-reference syntax and must keep the pure leaf (planWaves never does IO/throws) + the conservative flat/cycle/dangling fallbacks」，先读「Dependency-aware WAVE scheduling + fault-aware execution + predecessor-result injection for auto-decomposed subtasks (拆任务 → 有序并行 → 依赖失败则跳过下游并如实汇报 → 前驱结果注入下游不再盲跑 → 跳过与失败在最终报告分列 → 确定性顺序链拆解让整条 arc 在默认离机路径活起来 → 按角色收窄子智能体工具集,只读角色不给写工具 → 多个并行子任务改同一文件时如实告警可能的写-写覆盖 → 成功但零产出的子任务如实标注不折进完成 → 最终报告按角色标注每个子任务并把失败按类型分布,让失败的验证子任务不被匿名折进失败)」相关文件（见 services/backend/src/services/orchestrator/dependencyWaveScheduler.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Dependency-aware WAVE scheduling + fault-aware execution + predecessor-result injection for auto-decomposed subtasks (拆任务 → 有序并行 → 依赖失败则跳过下游并如实汇报 → 前驱结果注入下游不再盲跑 → 跳过与失败在最终报告分列 → 确定性顺序链拆解让整条 arc 在默认离机路径活起来 → 按角色收窄子智能体工具集,只读角色不给写工具 → 多个并行子任务改同一文件时如实告警可能的写-写覆盖 → 成功但零产出的子任务如实标注不折进完成 → 最终报告按角色标注每个子任务并把失败按类型分布,让失败的验证子任务不被匿名折进失败)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/services/orchestrator/dependencyWaveScheduler.test.js services/backend/tests/services/mergeResultsSkipDistinct.test.js services/backend/tests/services/sequentialChainDecompose.test.js services/backend/tests/services/orchestrator/roleToolScope.test.js services/backend/tests/services/orchestrator/mergeFileConflicts.test.js services/backend/tests/services/orchestrator/mergeEmptySuccess.test.js services/backend/tests/services/orchestrator/mergeRoleAttribution.test.js`

**186.** 如果「this is the missing consumer bridging _llmDecomposer's dependencies output to the existing parallel primitive AgentTool._runOrchestrated via ordered waves」，先读「Dependency-aware WAVE scheduling + fault-aware execution + predecessor-result injection for auto-decomposed subtasks (拆任务 → 有序并行 → 依赖失败则跳过下游并如实汇报 → 前驱结果注入下游不再盲跑 → 跳过与失败在最终报告分列 → 确定性顺序链拆解让整条 arc 在默认离机路径活起来 → 按角色收窄子智能体工具集,只读角色不给写工具 → 多个并行子任务改同一文件时如实告警可能的写-写覆盖 → 成功但零产出的子任务如实标注不折进完成 → 最终报告按角色标注每个子任务并把失败按类型分布,让失败的验证子任务不被匿名折进失败)」相关文件（见 services/backend/src/services/orchestrator/dependencyWaveScheduler.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Dependency-aware WAVE scheduling + fault-aware execution + predecessor-result injection for auto-decomposed subtasks (拆任务 → 有序并行 → 依赖失败则跳过下游并如实汇报 → 前驱结果注入下游不再盲跑 → 跳过与失败在最终报告分列 → 确定性顺序链拆解让整条 arc 在默认离机路径活起来 → 按角色收窄子智能体工具集,只读角色不给写工具 → 多个并行子任务改同一文件时如实告警可能的写-写覆盖 → 成功但零产出的子任务如实标注不折进完成 → 最终报告按角色标注每个子任务并把失败按类型分布,让失败的验证子任务不被匿名折进失败)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/services/orchestrator/dependencyWaveScheduler.test.js services/backend/tests/services/mergeResultsSkipDistinct.test.js services/backend/tests/services/sequentialChainDecompose.test.js services/backend/tests/services/orchestrator/roleToolScope.test.js services/backend/tests/services/orchestrator/mergeFileConflicts.test.js services/backend/tests/services/orchestrator/mergeEmptySuccess.test.js services/backend/tests/services/orchestrator/mergeRoleAttribution.test.js`

**187.** 如果「a subtask in a later wave declares a dependency on an EARLIER subtask that FAILED — fault-aware execution (gate KHY_DEP_WAVE_FAULT_STOP) short-circuits it to skipped-failure (依赖失败，已跳过) instead of running it on a broken premise (partitionWaveBySurvivors, skip propagates transitively)」，先读「Dependency-aware WAVE scheduling + fault-aware execution + predecessor-result injection for auto-decomposed subtasks (拆任务 → 有序并行 → 依赖失败则跳过下游并如实汇报 → 前驱结果注入下游不再盲跑 → 跳过与失败在最终报告分列 → 确定性顺序链拆解让整条 arc 在默认离机路径活起来 → 按角色收窄子智能体工具集,只读角色不给写工具 → 多个并行子任务改同一文件时如实告警可能的写-写覆盖 → 成功但零产出的子任务如实标注不折进完成 → 最终报告按角色标注每个子任务并把失败按类型分布,让失败的验证子任务不被匿名折进失败)」相关文件（见 services/backend/src/services/orchestrator/dependencyWaveScheduler.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Dependency-aware WAVE scheduling + fault-aware execution + predecessor-result injection for auto-decomposed subtasks (拆任务 → 有序并行 → 依赖失败则跳过下游并如实汇报 → 前驱结果注入下游不再盲跑 → 跳过与失败在最终报告分列 → 确定性顺序链拆解让整条 arc 在默认离机路径活起来 → 按角色收窄子智能体工具集,只读角色不给写工具 → 多个并行子任务改同一文件时如实告警可能的写-写覆盖 → 成功但零产出的子任务如实标注不折进完成 → 最终报告按角色标注每个子任务并把失败按类型分布,让失败的验证子任务不被匿名折进失败)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/services/orchestrator/dependencyWaveScheduler.test.js services/backend/tests/services/mergeResultsSkipDistinct.test.js services/backend/tests/services/sequentialChainDecompose.test.js services/backend/tests/services/orchestrator/roleToolScope.test.js services/backend/tests/services/orchestrator/mergeFileConflicts.test.js services/backend/tests/services/orchestrator/mergeEmptySuccess.test.js services/backend/tests/services/orchestrator/mergeRoleAttribution.test.js`

**188.** 如果「a downstream wave member should SEE its direct predecessors' output (implement seeing what explore produced) instead of running blind — predecessor-result CONTEXT INJECTION (gate KHY_DEP_WAVE_CONTEXT_INJECT) prepends [前驱结果 t<n>]: <text> (4000-char truncation, ascending, direct deps only) to its prompt via buildPredecessorContext/injectPredecessorContext」，先读「Dependency-aware WAVE scheduling + fault-aware execution + predecessor-result injection for auto-decomposed subtasks (拆任务 → 有序并行 → 依赖失败则跳过下游并如实汇报 → 前驱结果注入下游不再盲跑 → 跳过与失败在最终报告分列 → 确定性顺序链拆解让整条 arc 在默认离机路径活起来 → 按角色收窄子智能体工具集,只读角色不给写工具 → 多个并行子任务改同一文件时如实告警可能的写-写覆盖 → 成功但零产出的子任务如实标注不折进完成 → 最终报告按角色标注每个子任务并把失败按类型分布,让失败的验证子任务不被匿名折进失败)」相关文件（见 services/backend/src/services/orchestrator/dependencyWaveScheduler.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Dependency-aware WAVE scheduling + fault-aware execution + predecessor-result injection for auto-decomposed subtasks (拆任务 → 有序并行 → 依赖失败则跳过下游并如实汇报 → 前驱结果注入下游不再盲跑 → 跳过与失败在最终报告分列 → 确定性顺序链拆解让整条 arc 在默认离机路径活起来 → 按角色收窄子智能体工具集,只读角色不给写工具 → 多个并行子任务改同一文件时如实告警可能的写-写覆盖 → 成功但零产出的子任务如实标注不折进完成 → 最终报告按角色标注每个子任务并把失败按类型分布,让失败的验证子任务不被匿名折进失败)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/services/orchestrator/dependencyWaveScheduler.test.js services/backend/tests/services/mergeResultsSkipDistinct.test.js services/backend/tests/services/sequentialChainDecompose.test.js services/backend/tests/services/orchestrator/roleToolScope.test.js services/backend/tests/services/orchestrator/mergeFileConflicts.test.js services/backend/tests/services/orchestrator/mergeEmptySuccess.test.js services/backend/tests/services/orchestrator/mergeRoleAttribution.test.js`

**189.** 如果「the FINAL user-facing report must distinguish a dependency-SKIPPED subtask (依赖失败，已跳过) from one that genuinely ran and failed — mergeResults (taskDecomposer.js, gate KHY_MERGE_SKIP_DISTINCT) renders skips as a distinct 跳过（依赖失败） status and a separate 跳过 footer count instead of folding them into 失败 (fixes the last-mile consumer bridge for the 087 `skipped` flag)」，先读「Dependency-aware WAVE scheduling + fault-aware execution + predecessor-result injection for auto-decomposed subtasks (拆任务 → 有序并行 → 依赖失败则跳过下游并如实汇报 → 前驱结果注入下游不再盲跑 → 跳过与失败在最终报告分列 → 确定性顺序链拆解让整条 arc 在默认离机路径活起来 → 按角色收窄子智能体工具集,只读角色不给写工具 → 多个并行子任务改同一文件时如实告警可能的写-写覆盖 → 成功但零产出的子任务如实标注不折进完成 → 最终报告按角色标注每个子任务并把失败按类型分布,让失败的验证子任务不被匿名折进失败)」相关文件（见 services/backend/src/services/orchestrator/dependencyWaveScheduler.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Dependency-aware WAVE scheduling + fault-aware execution + predecessor-result injection for auto-decomposed subtasks (拆任务 → 有序并行 → 依赖失败则跳过下游并如实汇报 → 前驱结果注入下游不再盲跑 → 跳过与失败在最终报告分列 → 确定性顺序链拆解让整条 arc 在默认离机路径活起来 → 按角色收窄子智能体工具集,只读角色不给写工具 → 多个并行子任务改同一文件时如实告警可能的写-写覆盖 → 成功但零产出的子任务如实标注不折进完成 → 最终报告按角色标注每个子任务并把失败按类型分布,让失败的验证子任务不被匿名折进失败)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/services/orchestrator/dependencyWaveScheduler.test.js services/backend/tests/services/mergeResultsSkipDistinct.test.js services/backend/tests/services/sequentialChainDecompose.test.js services/backend/tests/services/orchestrator/roleToolScope.test.js services/backend/tests/services/orchestrator/mergeFileConflicts.test.js services/backend/tests/services/orchestrator/mergeEmptySuccess.test.js services/backend/tests/services/orchestrator/mergeRoleAttribution.test.js`

**190.** 如果「the whole wave arc is a silent no-op on the DEFAULT OFFLINE path (pip/npm install, no LLM key) because the four DETERMINISTIC decompose strategies emit NO `dependencies` — only the opt-in LLM strategy 5 does, and decompose is called without callModel. The deterministic sequential-chain producer _splitSequentialChain (taskDecomposer.js, gate KHY_SEQ_CHAIN_DECOMPOSE) recognizes 先…再…/然后/首先…其次…最后/then/finally and emits `dependencies: [priorIndex]` so planWaves compiles a serial chain offline (the producer side of the arc)」，先读「Dependency-aware WAVE scheduling + fault-aware execution + predecessor-result injection for auto-decomposed subtasks (拆任务 → 有序并行 → 依赖失败则跳过下游并如实汇报 → 前驱结果注入下游不再盲跑 → 跳过与失败在最终报告分列 → 确定性顺序链拆解让整条 arc 在默认离机路径活起来 → 按角色收窄子智能体工具集,只读角色不给写工具 → 多个并行子任务改同一文件时如实告警可能的写-写覆盖 → 成功但零产出的子任务如实标注不折进完成 → 最终报告按角色标注每个子任务并把失败按类型分布,让失败的验证子任务不被匿名折进失败)」相关文件（见 services/backend/src/services/orchestrator/dependencyWaveScheduler.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Dependency-aware WAVE scheduling + fault-aware execution + predecessor-result injection for auto-decomposed subtasks (拆任务 → 有序并行 → 依赖失败则跳过下游并如实汇报 → 前驱结果注入下游不再盲跑 → 跳过与失败在最终报告分列 → 确定性顺序链拆解让整条 arc 在默认离机路径活起来 → 按角色收窄子智能体工具集,只读角色不给写工具 → 多个并行子任务改同一文件时如实告警可能的写-写覆盖 → 成功但零产出的子任务如实标注不折进完成 → 最终报告按角色标注每个子任务并把失败按类型分布,让失败的验证子任务不被匿名折进失败)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/services/orchestrator/dependencyWaveScheduler.test.js services/backend/tests/services/mergeResultsSkipDistinct.test.js services/backend/tests/services/sequentialChainDecompose.test.js services/backend/tests/services/orchestrator/roleToolScope.test.js services/backend/tests/services/orchestrator/mergeFileConflicts.test.js services/backend/tests/services/orchestrator/mergeEmptySuccess.test.js services/backend/tests/services/orchestrator/mergeRoleAttribution.test.js`

**191.** 如果「the decompose `role` string (explore/verify/implement) drives model selection (subAgentModelSelect) but NOT tool scoping — a read-only explore/verify subtask still receives Write/Edit/NotebookEdit. roleToolScope(role) (orchestrator/roleToolScope.js, gate KHY_ROLE_TOOL_SCOPE) maps read-only roles (explore/verify/plan/research/audit/review) to a disallowedTools strip (Edit/Write/NotebookEdit, NOT Bash) and mergeRoleScopeInto unions it into a base denylist matching AgentTool.buildSubagentDenylist's shape (the missing tool-scoping consumer of role; consume seam = buildSubagentDenylist union point)」，先读「Dependency-aware WAVE scheduling + fault-aware execution + predecessor-result injection for auto-decomposed subtasks (拆任务 → 有序并行 → 依赖失败则跳过下游并如实汇报 → 前驱结果注入下游不再盲跑 → 跳过与失败在最终报告分列 → 确定性顺序链拆解让整条 arc 在默认离机路径活起来 → 按角色收窄子智能体工具集,只读角色不给写工具 → 多个并行子任务改同一文件时如实告警可能的写-写覆盖 → 成功但零产出的子任务如实标注不折进完成 → 最终报告按角色标注每个子任务并把失败按类型分布,让失败的验证子任务不被匿名折进失败)」相关文件（见 services/backend/src/services/orchestrator/dependencyWaveScheduler.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Dependency-aware WAVE scheduling + fault-aware execution + predecessor-result injection for auto-decomposed subtasks (拆任务 → 有序并行 → 依赖失败则跳过下游并如实汇报 → 前驱结果注入下游不再盲跑 → 跳过与失败在最终报告分列 → 确定性顺序链拆解让整条 arc 在默认离机路径活起来 → 按角色收窄子智能体工具集,只读角色不给写工具 → 多个并行子任务改同一文件时如实告警可能的写-写覆盖 → 成功但零产出的子任务如实标注不折进完成 → 最终报告按角色标注每个子任务并把失败按类型分布,让失败的验证子任务不被匿名折进失败)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/services/orchestrator/dependencyWaveScheduler.test.js services/backend/tests/services/mergeResultsSkipDistinct.test.js services/backend/tests/services/sequentialChainDecompose.test.js services/backend/tests/services/orchestrator/roleToolScope.test.js services/backend/tests/services/orchestrator/mergeFileConflicts.test.js services/backend/tests/services/orchestrator/mergeEmptySuccess.test.js services/backend/tests/services/orchestrator/mergeRoleAttribution.test.js`

**192.** 如果「multiple PARALLEL subtasks in the same wave each carry filesModified; mergeResults folds them into a de-duping Set so a file written by ≥2 concurrent agents silently collapses to one 修改文件 entry — a write-write race (last-write-wins, one agent's work lost) invisible in the report. detectFileConflicts/formatConflictWarning (orchestrator/mergeFileConflicts.js, gate KHY_MERGE_FILE_CONFLICT) surface a ⚠️ 并行写冲突 footer line naming the file + the conflicting subtasks (path trim but case-SENSITIVE to avoid A.js/a.js false positives; honest告知 only, does not arbitrate the race). This is the second orthogonal honesty dimension of the mergeResults render (092 = skip≠fail state honesty; this = parallel write-conflict honesty)」，先读「Dependency-aware WAVE scheduling + fault-aware execution + predecessor-result injection for auto-decomposed subtasks (拆任务 → 有序并行 → 依赖失败则跳过下游并如实汇报 → 前驱结果注入下游不再盲跑 → 跳过与失败在最终报告分列 → 确定性顺序链拆解让整条 arc 在默认离机路径活起来 → 按角色收窄子智能体工具集,只读角色不给写工具 → 多个并行子任务改同一文件时如实告警可能的写-写覆盖 → 成功但零产出的子任务如实标注不折进完成 → 最终报告按角色标注每个子任务并把失败按类型分布,让失败的验证子任务不被匿名折进失败)」相关文件（见 services/backend/src/services/orchestrator/dependencyWaveScheduler.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Dependency-aware WAVE scheduling + fault-aware execution + predecessor-result injection for auto-decomposed subtasks (拆任务 → 有序并行 → 依赖失败则跳过下游并如实汇报 → 前驱结果注入下游不再盲跑 → 跳过与失败在最终报告分列 → 确定性顺序链拆解让整条 arc 在默认离机路径活起来 → 按角色收窄子智能体工具集,只读角色不给写工具 → 多个并行子任务改同一文件时如实告警可能的写-写覆盖 → 成功但零产出的子任务如实标注不折进完成 → 最终报告按角色标注每个子任务并把失败按类型分布,让失败的验证子任务不被匿名折进失败)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/services/orchestrator/dependencyWaveScheduler.test.js services/backend/tests/services/mergeResultsSkipDistinct.test.js services/backend/tests/services/sequentialChainDecompose.test.js services/backend/tests/services/orchestrator/roleToolScope.test.js services/backend/tests/services/orchestrator/mergeFileConflicts.test.js services/backend/tests/services/orchestrator/mergeEmptySuccess.test.js services/backend/tests/services/orchestrator/mergeRoleAttribution.test.js`

**193.** 如果「a subtask returns success (producer uses success !== false, so ANY non-explicit-false counts) yet produced NOTHING — no body (text/output empty), no filesModified, no toolCalls. mergeResults folds this 'empty success' into successCount and renders it as 完成, indistinguishable from real work — the most insidious false-green on an offline unattended fan-out (report shows 完成 3/3 while one agent silently did nothing / was cut off / no-op'd). isEmptySuccess/formatEmptySuccessWarning (orchestrator/mergeEmptySuccess.js, gate KHY_MERGE_EMPTY_SUCCESS) render such a subtask as ⚠️ 完成（无产出） and add a footer count (successCount UNCHANGED — it truly did not fail; only a visible marker + count so people can re-check). This is the THIRD orthogonal honesty dimension of the mergeResults render (092 = skip≠fail state; 098 = parallel write-conflict; this = empty-success honesty)」，先读「Dependency-aware WAVE scheduling + fault-aware execution + predecessor-result injection for auto-decomposed subtasks (拆任务 → 有序并行 → 依赖失败则跳过下游并如实汇报 → 前驱结果注入下游不再盲跑 → 跳过与失败在最终报告分列 → 确定性顺序链拆解让整条 arc 在默认离机路径活起来 → 按角色收窄子智能体工具集,只读角色不给写工具 → 多个并行子任务改同一文件时如实告警可能的写-写覆盖 → 成功但零产出的子任务如实标注不折进完成 → 最终报告按角色标注每个子任务并把失败按类型分布,让失败的验证子任务不被匿名折进失败)」相关文件（见 services/backend/src/services/orchestrator/dependencyWaveScheduler.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Dependency-aware WAVE scheduling + fault-aware execution + predecessor-result injection for auto-decomposed subtasks (拆任务 → 有序并行 → 依赖失败则跳过下游并如实汇报 → 前驱结果注入下游不再盲跑 → 跳过与失败在最终报告分列 → 确定性顺序链拆解让整条 arc 在默认离机路径活起来 → 按角色收窄子智能体工具集,只读角色不给写工具 → 多个并行子任务改同一文件时如实告警可能的写-写覆盖 → 成功但零产出的子任务如实标注不折进完成 → 最终报告按角色标注每个子任务并把失败按类型分布,让失败的验证子任务不被匿名折进失败)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/services/orchestrator/dependencyWaveScheduler.test.js services/backend/tests/services/mergeResultsSkipDistinct.test.js services/backend/tests/services/sequentialChainDecompose.test.js services/backend/tests/services/orchestrator/roleToolScope.test.js services/backend/tests/services/orchestrator/mergeFileConflicts.test.js services/backend/tests/services/orchestrator/mergeEmptySuccess.test.js services/backend/tests/services/orchestrator/mergeRoleAttribution.test.js`

**194.** 如果「every decompose subtask carries a `role` (implement/verify/explore/general via _inferRole) that drives model-selection (subAgentModelSelect) and tool-scoping (094 roleToolScope), but the FINAL user-facing report (mergeResults) folds the role away: header reads 子任务 N: preview and a failure renders 失败 with no signal WHICH KIND of work failed — a failed 验证 (results UNVALIDATED, serious) is indistinguishable from a failed 探索 (recoverable). formatRoleTag/formatRoleFailureSummary (orchestrator/mergeRoleAttribution.js, gate KHY_MERGE_ROLE_ATTRIBUTION) tag each header 子任务 N（验证）: … and add a footer ⚠️ 失败分布: 验证 1 项… line (bucket counts always sum to failCount, unknown roles → 通用 so a failure is never dropped; a failed verify appends a 结果未经校验 critical hint). This is the FOURTH orthogonal honesty dimension of the mergeResults render (092 = skip≠fail state; 098 = parallel write-conflict; 099 = empty-success; this = role-attribution honesty / which TYPE of work failed)」，先读「Dependency-aware WAVE scheduling + fault-aware execution + predecessor-result injection for auto-decomposed subtasks (拆任务 → 有序并行 → 依赖失败则跳过下游并如实汇报 → 前驱结果注入下游不再盲跑 → 跳过与失败在最终报告分列 → 确定性顺序链拆解让整条 arc 在默认离机路径活起来 → 按角色收窄子智能体工具集,只读角色不给写工具 → 多个并行子任务改同一文件时如实告警可能的写-写覆盖 → 成功但零产出的子任务如实标注不折进完成 → 最终报告按角色标注每个子任务并把失败按类型分布,让失败的验证子任务不被匿名折进失败)」相关文件（见 services/backend/src/services/orchestrator/dependencyWaveScheduler.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Dependency-aware WAVE scheduling + fault-aware execution + predecessor-result injection for auto-decomposed subtasks (拆任务 → 有序并行 → 依赖失败则跳过下游并如实汇报 → 前驱结果注入下游不再盲跑 → 跳过与失败在最终报告分列 → 确定性顺序链拆解让整条 arc 在默认离机路径活起来 → 按角色收窄子智能体工具集,只读角色不给写工具 → 多个并行子任务改同一文件时如实告警可能的写-写覆盖 → 成功但零产出的子任务如实标注不折进完成 → 最终报告按角色标注每个子任务并把失败按类型分布,让失败的验证子任务不被匿名折进失败)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/services/orchestrator/dependencyWaveScheduler.test.js services/backend/tests/services/mergeResultsSkipDistinct.test.js services/backend/tests/services/sequentialChainDecompose.test.js services/backend/tests/services/orchestrator/roleToolScope.test.js services/backend/tests/services/orchestrator/mergeFileConflicts.test.js services/backend/tests/services/orchestrator/mergeEmptySuccess.test.js services/backend/tests/services/orchestrator/mergeRoleAttribution.test.js`

**195.** 如果「OPS-094 built roleToolScope as a PURE LEAF with a documented consume seam but LEFT IT UNWIRED (zero production consumers = dead code) because god-file + blast-radius were then blocked. OPS-097 WIRES IT LIVE: AgentTool.buildSubagentDenylist gains a 4th `role` param and folds mergeRoleScopeInto(ownDeny, role) in before the spawn-tool∪ceiling logic; _runStandaloneAgent passes role at the call site. The net gap this closes: when built-in agents are unavailable (SDK mode → agentDef=null) a read-only explore/verify subtask's write-tool strip vanishes — the role now re-derives [Edit/Write/NotebookEdit] independent of agentDef; also closes the `verify`-not-in-toolFilter live gap. Wrapped in try/catch (leaf-load failure degrades to ownDeny, never breaks spawning); 4th param omitted/gate-off → byte-equivalent to the pre-wire 3-arg call. arch:god is a READ-ONLY gate (--god-report returns 0) so editing the god-file does not turn it red」，先读「Dependency-aware WAVE scheduling + fault-aware execution + predecessor-result injection for auto-decomposed subtasks (拆任务 → 有序并行 → 依赖失败则跳过下游并如实汇报 → 前驱结果注入下游不再盲跑 → 跳过与失败在最终报告分列 → 确定性顺序链拆解让整条 arc 在默认离机路径活起来 → 按角色收窄子智能体工具集,只读角色不给写工具 → 多个并行子任务改同一文件时如实告警可能的写-写覆盖 → 成功但零产出的子任务如实标注不折进完成 → 最终报告按角色标注每个子任务并把失败按类型分布,让失败的验证子任务不被匿名折进失败)」相关文件（见 services/backend/src/services/orchestrator/dependencyWaveScheduler.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Dependency-aware WAVE scheduling + fault-aware execution + predecessor-result injection for auto-decomposed subtasks (拆任务 → 有序并行 → 依赖失败则跳过下游并如实汇报 → 前驱结果注入下游不再盲跑 → 跳过与失败在最终报告分列 → 确定性顺序链拆解让整条 arc 在默认离机路径活起来 → 按角色收窄子智能体工具集,只读角色不给写工具 → 多个并行子任务改同一文件时如实告警可能的写-写覆盖 → 成功但零产出的子任务如实标注不折进完成 → 最终报告按角色标注每个子任务并把失败按类型分布,让失败的验证子任务不被匿名折进失败)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- services/backend/tests/services/orchestrator/dependencyWaveScheduler.test.js services/backend/tests/services/mergeResultsSkipDistinct.test.js services/backend/tests/services/sequentialChainDecompose.test.js services/backend/tests/services/orchestrator/roleToolScope.test.js services/backend/tests/services/orchestrator/mergeFileConflicts.test.js services/backend/tests/services/orchestrator/mergeEmptySuccess.test.js services/backend/tests/services/orchestrator/mergeRoleAttribution.test.js`

**196.** 如果「a landing agent must decide, BEFORE running any restore move, whether self-driving on this machine is authorized at all (the should-I that precedes the how)」，先读「Restore Self-Drive Authorization Gate (before executing any restore move, should the agent auto-drive on THIS machine at all? authorized / ask-first / forbidden)」相关文件（见 scripts/lib/restoreAutonomyGate.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Restore Self-Drive Authorization Gate (before executing any restore move, should the agent auto-drive on THIS machine at all? authorized / ask-first / forbidden)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreAutonomyGate.test.js`

**197.** 如果「guard against blast-radius: auto-restore could overwrite an existing usable install / config / proxy nodes / tasks under ~/.khy that the user never consented to touch」，先读「Restore Self-Drive Authorization Gate (before executing any restore move, should the agent auto-drive on THIS machine at all? authorized / ask-first / forbidden)」相关文件（见 scripts/lib/restoreAutonomyGate.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Restore Self-Drive Authorization Gate (before executing any restore move, should the agent auto-drive on THIS machine at all? authorized / ask-first / forbidden)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreAutonomyGate.test.js`

**198.** 如果「the recovery chain from restore-resolve contains a dangerous shell action (rm/push/publish) that must never be auto-driven -> forbidden」，先读「Restore Self-Drive Authorization Gate (before executing any restore move, should the agent auto-drive on THIS machine at all? authorized / ask-first / forbidden)」相关文件（见 scripts/lib/restoreAutonomyGate.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Restore Self-Drive Authorization Gate (before executing any restore move, should the agent auto-drive on THIS machine at all? authorized / ask-first / forbidden)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreAutonomyGate.test.js`

**199.** 如果「the chain requires a human (humanRequiredCount>0 or a move.autonomy===human): downgrade to ask-first if a human is reachable, forbidden if not」，先读「Restore Self-Drive Authorization Gate (before executing any restore move, should the agent auto-drive on THIS machine at all? authorized / ask-first / forbidden)」相关文件（见 scripts/lib/restoreAutonomyGate.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Restore Self-Drive Authorization Gate (before executing any restore move, should the agent auto-drive on THIS machine at all? authorized / ask-first / forbidden)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreAutonomyGate.test.js`

**200.** 如果「there is overwrite risk but no interactive human (non-TTY): safe default is forbidden, never unattended-overwrite user data」，先读「Restore Self-Drive Authorization Gate (before executing any restore move, should the agent auto-drive on THIS machine at all? authorized / ask-first / forbidden)」相关文件（见 scripts/lib/restoreAutonomyGate.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Restore Self-Drive Authorization Gate (before executing any restore move, should the agent auto-drive on THIS machine at all? authorized / ask-first / forbidden)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreAutonomyGate.test.js`

**201.** 如果「you need the closed loop head: authorize -> plan/conflicts/resolve/converge; converge judges the loop tail (did-it-work), this judges the loop head (should-I-start)」，先读「Restore Self-Drive Authorization Gate (before executing any restore move, should the agent auto-drive on THIS machine at all? authorized / ask-first / forbidden)」相关文件（见 scripts/lib/restoreAutonomyGate.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Restore Self-Drive Authorization Gate (before executing any restore move, should the agent auto-drive on THIS machine at all? authorized / ask-first / forbidden)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreAutonomyGate.test.js`

**202.** 如果「the OPS-MAN-084 autonomy-gate doc is out of sync with its generator」，先读「Restore Self-Drive Authorization Gate (before executing any restore move, should the agent auto-drive on THIS machine at all? authorized / ask-first / forbidden)」相关文件（见 scripts/lib/restoreAutonomyGate.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Restore Self-Drive Authorization Gate (before executing any restore move, should the agent auto-drive on THIS machine at all? authorized / ask-first / forbidden)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreAutonomyGate.test.js`

**203.** 如果「restore-authorize returned forbidden or ask-first and the developer/user/maintainer needs an actionable unlock roadmap, not a dead-end no」，先读「Restore Recourse / Actionable Denial (the inverse of the authorization gate: if the agent is denied, what is the minimal ordered safe path to yes?)」相关文件（见 scripts/lib/restoreRecoursePlan.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Restore Recourse / Actionable Denial (the inverse of the authorization gate: if the agent is denied, what is the minimal ordered safe path to yes?)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreRecoursePlan.test.js`

**204.** 如果「you need the inverse of the gate: authorize answers should-I, converge answers did-it-work, recourse answers if-no-what-is-the-minimal-path-to-yes」，先读「Restore Recourse / Actionable Denial (the inverse of the authorization gate: if the agent is denied, what is the minimal ordered safe path to yes?)」相关文件（见 scripts/lib/restoreRecoursePlan.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Restore Recourse / Actionable Denial (the inverse of the authorization gate: if the agent is denied, what is the minimal ordered safe path to yes?)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreRecoursePlan.test.js`

**205.** 如果「an overwrite-risk denial should surface its cheapest downgrade (provide a TTY -> ask-first) and its full unlock (back up ~/.khy -> authorized)」，先读「Restore Recourse / Actionable Denial (the inverse of the authorization gate: if the agent is denied, what is the minimal ordered safe path to yes?)」相关文件（见 scripts/lib/restoreRecoursePlan.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Restore Recourse / Actionable Denial (the inverse of the authorization gate: if the agent is denied, what is the minimal ordered safe path to yes?)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreRecoursePlan.test.js`

**206.** 如果「a dangerous-move denial must NOT promise any auto-unlock: it stays unresolved, human must review the chain (denial is actionable, not bypassable)」，先读「Restore Recourse / Actionable Denial (the inverse of the authorization gate: if the agent is denied, what is the minimal ordered safe path to yes?)」相关文件（见 scripts/lib/restoreRecoursePlan.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Restore Recourse / Actionable Denial (the inverse of the authorization gate: if the agent is denied, what is the minimal ordered safe path to yes?)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreRecoursePlan.test.js`

**207.** 如果「you need aggregate signals: cheapest option, fullyAgentUnblockable (every blocker self-healable), bestReachable (weakest-link authorization tier)」，先读「Restore Recourse / Actionable Denial (the inverse of the authorization gate: if the agent is denied, what is the minimal ordered safe path to yes?)」相关文件（见 scripts/lib/restoreRecoursePlan.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Restore Recourse / Actionable Denial (the inverse of the authorization gate: if the agent is denied, what is the minimal ordered safe path to yes?)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreRecoursePlan.test.js`

**208.** 如果「the authorization gate added a new blocker vocabulary term and _RECOURSE_RULES needs a matching recourse entry」，先读「Restore Recourse / Actionable Denial (the inverse of the authorization gate: if the agent is denied, what is the minimal ordered safe path to yes?)」相关文件（见 scripts/lib/restoreRecoursePlan.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Restore Recourse / Actionable Denial (the inverse of the authorization gate: if the agent is denied, what is the minimal ordered safe path to yes?)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreRecoursePlan.test.js`

**209.** 如果「the OPS-MAN-085 recourse doc is out of sync with its generator」，先读「Restore Recourse / Actionable Denial (the inverse of the authorization gate: if the agent is denied, what is the minimal ordered safe path to yes?)」相关文件（见 scripts/lib/restoreRecoursePlan.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Restore Recourse / Actionable Denial (the inverse of the authorization gate: if the agent is denied, what is the minimal ordered safe path to yes?)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreRecoursePlan.test.js`

**210.** 如果「an agent self-drives restore across many independent CLI invocations on a fresh machine and the converge loop-guard never escalates because stallCount resets to 0 each process」，先读「Restore Trace Journal / Durable Agent Memory (append-only event stream that rebuilds the cross-process stallCount the convergence loop-guard needs; closes the real seam where converge resets stallCount to 0 on every independent CLI invocation)」相关文件（见 scripts/lib/restoreTraceJournal.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Restore Trace Journal / Durable Agent Memory (append-only event stream that rebuilds the cross-process stallCount the convergence loop-guard needs; closes the real seam where converge resets stallCount to 0 on every independent CLI invocation)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreTraceJournal.test.js`

**211.** 如果「you need the cross-process stallCount to feed back into restore-converge verifyConvergence({stallCount}) so the anti-deadloop actually fires across process boundaries」，先读「Restore Trace Journal / Durable Agent Memory (append-only event stream that rebuilds the cross-process stallCount the convergence loop-guard needs; closes the real seam where converge resets stallCount to 0 on every independent CLI invocation)」相关文件（见 scripts/lib/restoreTraceJournal.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Restore Trace Journal / Durable Agent Memory (append-only event stream that rebuilds the cross-process stallCount the convergence loop-guard needs; closes the real seam where converge resets stallCount to 0 on every independent CLI invocation)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreTraceJournal.test.js`

**212.** 如果「a maintainer returns to a stuck machine and needs an audit trail of what the agent tried (reprobe x3 -> escalate) and where it stalled」，先读「Restore Trace Journal / Durable Agent Memory (append-only event stream that rebuilds the cross-process stallCount the convergence loop-guard needs; closes the real seam where converge resets stallCount to 0 on every independent CLI invocation)」相关文件（见 scripts/lib/restoreTraceJournal.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Restore Trace Journal / Durable Agent Memory (append-only event stream that rebuilds the cross-process stallCount the convergence loop-guard needs; closes the real seam where converge resets stallCount to 0 on every independent CLI invocation)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreTraceJournal.test.js`

**213.** 如果「you add a new converge verdict and _STALL_RULE (reset/keep/inc) needs a matching replay contribution so stallCount stays correct」，先读「Restore Trace Journal / Durable Agent Memory (append-only event stream that rebuilds the cross-process stallCount the convergence loop-guard needs; closes the real seam where converge resets stallCount to 0 on every independent CLI invocation)」相关文件（见 scripts/lib/restoreTraceJournal.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Restore Trace Journal / Durable Agent Memory (append-only event stream that rebuilds the cross-process stallCount the convergence loop-guard needs; closes the real seam where converge resets stallCount to 0 on every independent CLI invocation)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreTraceJournal.test.js`

**214.** 如果「the journal file lives at ~/.khy/.restore-trace/<session>.jsonl: a dot-prefixed dir deliberately excluded by the authorization gate user-data probe (operation trace is not user data)」，先读「Restore Trace Journal / Durable Agent Memory (append-only event stream that rebuilds the cross-process stallCount the convergence loop-guard needs; closes the real seam where converge resets stallCount to 0 on every independent CLI invocation)」相关文件（见 scripts/lib/restoreTraceJournal.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Restore Trace Journal / Durable Agent Memory (append-only event stream that rebuilds the cross-process stallCount the convergence loop-guard needs; closes the real seam where converge resets stallCount to 0 on every independent CLI invocation)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreTraceJournal.test.js`

**215.** 如果「the OPS-MAN-086 trace-journal doc is out of sync with its generator」，先读「Restore Trace Journal / Durable Agent Memory (append-only event stream that rebuilds the cross-process stallCount the convergence loop-guard needs; closes the real seam where converge resets stallCount to 0 on every independent CLI invocation)」相关文件（见 scripts/lib/restoreTraceJournal.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Restore Trace Journal / Durable Agent Memory (append-only event stream that rebuilds the cross-process stallCount the convergence loop-guard needs; closes the real seam where converge resets stallCount to 0 on every independent CLI invocation)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreTraceJournal.test.js`

**216.** 如果「an agent repeatedly lands on the same problem machine and keeps re-trying a strategy that prior sessions already proved is a dead-end (stalled->escalate every time)」，先读「Restore Strategy Ledger / Cross-Session Learning (learns across ALL sessions on this machine which resolution strategies have been repeatedly proven dead, so the next self-drive skips them instead of re-walking known dead-ends; the machine-level complement to the per-session trace journal)」相关文件（见 scripts/lib/restoreStrategyLedger.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Restore Strategy Ledger / Cross-Session Learning (learns across ALL sessions on this machine which resolution strategies have been repeatedly proven dead, so the next self-drive skips them instead of re-walking known dead-ends; the machine-level complement to the per-session trace journal)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreStrategyLedger.test.js`

**217.** 如果「you need cross-session learning: the trace journal (086) is per-session memory; the ledger (088) aggregates ALL ~/.khy/.restore-trace/*.jsonl to learn machine-wide」，先读「Restore Strategy Ledger / Cross-Session Learning (learns across ALL sessions on this machine which resolution strategies have been repeatedly proven dead, so the next self-drive skips them instead of re-walking known dead-ends; the machine-level complement to the per-session trace journal)」相关文件（见 scripts/lib/restoreStrategyLedger.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Restore Strategy Ledger / Cross-Session Learning (learns across ALL sessions on this machine which resolution strategies have been repeatedly proven dead, so the next self-drive skips them instead of re-walking known dead-ends; the machine-level complement to the per-session trace journal)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreStrategyLedger.test.js`

**218.** 如果「a strategy is only classified dead when it stalled across >= MIN_SAMPLES independent sessions and NEVER once advanced/converged (safety-first: one success clears all failures)」，先读「Restore Strategy Ledger / Cross-Session Learning (learns across ALL sessions on this machine which resolution strategies have been repeatedly proven dead, so the next self-drive skips them instead of re-walking known dead-ends; the machine-level complement to the per-session trace journal)」相关文件（见 scripts/lib/restoreStrategyLedger.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Restore Strategy Ledger / Cross-Session Learning (learns across ALL sessions on this machine which resolution strategies have been repeatedly proven dead, so the next self-drive skips them instead of re-walking known dead-ends; the machine-level complement to the per-session trace journal)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreStrategyLedger.test.js`

**219.** 如果「you need recommendedSkips (strategies to skip next time) without ever reordering the resolver safety chain (learning subtracts, it does not reorder)」，先读「Restore Strategy Ledger / Cross-Session Learning (learns across ALL sessions on this machine which resolution strategies have been repeatedly proven dead, so the next self-drive skips them instead of re-walking known dead-ends; the machine-level complement to the per-session trace journal)」相关文件（见 scripts/lib/restoreStrategyLedger.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Restore Strategy Ledger / Cross-Session Learning (learns across ALL sessions on this machine which resolution strategies have been repeatedly proven dead, so the next self-drive skips them instead of re-walking known dead-ends; the machine-level complement to the per-session trace journal)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreStrategyLedger.test.js`

**220.** 如果「single-session repeated failure must stay unproven (one unlucky session must never permanently blacklist a usable strategy)」，先读「Restore Strategy Ledger / Cross-Session Learning (learns across ALL sessions on this machine which resolution strategies have been repeatedly proven dead, so the next self-drive skips them instead of re-walking known dead-ends; the machine-level complement to the per-session trace journal)」相关文件（见 scripts/lib/restoreStrategyLedger.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Restore Strategy Ledger / Cross-Session Learning (learns across ALL sessions on this machine which resolution strategies have been repeatedly proven dead, so the next self-drive skips them instead of re-walking known dead-ends; the machine-level complement to the per-session trace journal)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreStrategyLedger.test.js`

**221.** 如果「the OPS-MAN-088 strategy-ledger doc is out of sync with its generator」，先读「Restore Strategy Ledger / Cross-Session Learning (learns across ALL sessions on this machine which resolution strategies have been repeatedly proven dead, so the next self-drive skips them instead of re-walking known dead-ends; the machine-level complement to the per-session trace journal)」相关文件（见 scripts/lib/restoreStrategyLedger.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Restore Strategy Ledger / Cross-Session Learning (learns across ALL sessions on this machine which resolution strategies have been repeatedly proven dead, so the next self-drive skips them instead of re-walking known dead-ends; the machine-level complement to the per-session trace journal)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreStrategyLedger.test.js`

**222.** 如果「the strategy ledger (088) produced recommendedSkips but grep shows zero consumers, so learned dead-ends were never actually avoided (dead field / broken bridge)」，先读「Restore Skip Applier / Apply Cross-Session Learning (the missing consumer that closes the dead-field bridge: the strategy ledger produced recommendedSkips but nothing consumed them; this annotates the resolver recovery chain with learned-dead/safe-to-skip markers WITHOUT deleting or reordering)」相关文件（见 scripts/lib/restoreSkipApplier.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Restore Skip Applier / Apply Cross-Session Learning (the missing consumer that closes the dead-field bridge: the strategy ledger produced recommendedSkips but nothing consumed them; this annotates the resolver recovery chain with learned-dead/safe-to-skip markers WITHOUT deleting or reordering)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreSkipApplier.test.js`

**223.** 如果「you need to APPLY cross-session learning to the resolver moves: annotate each with learnedDead/safeToSkip/mustTryDespiteDead, order-preserving」，先读「Restore Skip Applier / Apply Cross-Session Learning (the missing consumer that closes the dead-field bridge: the strategy ledger produced recommendedSkips but nothing consumed them; this annotates the resolver recovery chain with learned-dead/safe-to-skip markers WITHOUT deleting or reordering)」相关文件（见 scripts/lib/restoreSkipApplier.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Restore Skip Applier / Apply Cross-Session Learning (the missing consumer that closes the dead-field bridge: the strategy ledger produced recommendedSkips but nothing consumed them; this annotates the resolver recovery chain with learned-dead/safe-to-skip markers WITHOUT deleting or reordering)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreSkipApplier.test.js`

**224.** 如果「a learned-dead strategy must only be safeToSkip when every conflict it covers has a live (non-dead) alternative move; otherwise mustTryDespiteDead (never strand a conflict)」，先读「Restore Skip Applier / Apply Cross-Session Learning (the missing consumer that closes the dead-field bridge: the strategy ledger produced recommendedSkips but nothing consumed them; this annotates the resolver recovery chain with learned-dead/safe-to-skip markers WITHOUT deleting or reordering)」相关文件（见 scripts/lib/restoreSkipApplier.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Restore Skip Applier / Apply Cross-Session Learning (the missing consumer that closes the dead-field bridge: the strategy ledger produced recommendedSkips but nothing consumed them; this annotates the resolver recovery chain with learned-dead/safe-to-skip markers WITHOUT deleting or reordering)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreSkipApplier.test.js`

**225.** 如果「escalate is the human safety net and must NEVER be safeToSkip even if learned dead (learning must not swallow the hand-off-to-human exit)」，先读「Restore Skip Applier / Apply Cross-Session Learning (the missing consumer that closes the dead-field bridge: the strategy ledger produced recommendedSkips but nothing consumed them; this annotates the resolver recovery chain with learned-dead/safe-to-skip markers WITHOUT deleting or reordering)」相关文件（见 scripts/lib/restoreSkipApplier.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Restore Skip Applier / Apply Cross-Session Learning (the missing consumer that closes the dead-field bridge: the strategy ledger produced recommendedSkips but nothing consumed them; this annotates the resolver recovery chain with learned-dead/safe-to-skip markers WITHOUT deleting or reordering)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreSkipApplier.test.js`

**226.** 如果「honesty boundary: the applier only annotates, never deletes a move and never reorders the risk-ordered safety chain (reprobe->reconcile->trust-pessimistic->escalate)」，先读「Restore Skip Applier / Apply Cross-Session Learning (the missing consumer that closes the dead-field bridge: the strategy ledger produced recommendedSkips but nothing consumed them; this annotates the resolver recovery chain with learned-dead/safe-to-skip markers WITHOUT deleting or reordering)」相关文件（见 scripts/lib/restoreSkipApplier.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Restore Skip Applier / Apply Cross-Session Learning (the missing consumer that closes the dead-field bridge: the strategy ledger produced recommendedSkips but nothing consumed them; this annotates the resolver recovery chain with learned-dead/safe-to-skip markers WITHOUT deleting or reordering)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreSkipApplier.test.js`

**227.** 如果「you want the full end-to-end loop: gatherAssessments -> detect -> resolve -> ledger -> applyLearnedSkips via scripts/restore-apply.js」，先读「Restore Skip Applier / Apply Cross-Session Learning (the missing consumer that closes the dead-field bridge: the strategy ledger produced recommendedSkips but nothing consumed them; this annotates the resolver recovery chain with learned-dead/safe-to-skip markers WITHOUT deleting or reordering)」相关文件（见 scripts/lib/restoreSkipApplier.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Restore Skip Applier / Apply Cross-Session Learning (the missing consumer that closes the dead-field bridge: the strategy ledger produced recommendedSkips but nothing consumed them; this annotates the resolver recovery chain with learned-dead/safe-to-skip markers WITHOUT deleting or reordering)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreSkipApplier.test.js`

**228.** 如果「the OPS-MAN-089 skip-applier doc is out of sync with its generator」，先读「Restore Skip Applier / Apply Cross-Session Learning (the missing consumer that closes the dead-field bridge: the strategy ledger produced recommendedSkips but nothing consumed them; this annotates the resolver recovery chain with learned-dead/safe-to-skip markers WITHOUT deleting or reordering)」相关文件（见 scripts/lib/restoreSkipApplier.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Restore Skip Applier / Apply Cross-Session Learning (the missing consumer that closes the dead-field bridge: the strategy ledger produced recommendedSkips but nothing consumed them; this annotates the resolver recovery chain with learned-dead/safe-to-skip markers WITHOUT deleting or reordering)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreSkipApplier.test.js`

**229.** 如果「the restore family is complete (12 leaves / 10 CLIs) but NOT simple: a fresh machine faces 10 diagnostic commands with no unified verdict and no single next-action (directly serves the user goal of a complete AND simple restore)」，先读「Restore Navigator / Single Next-Action (the missing aggregator that closes the complete-but-not-simple usability bridge: the restore family is 12 leaves / 10 CLIs each answering one slice, but a fresh-machine agent or human gets no unified verdict and no single "which command do I run NOW"; this synthesizes all family verdicts into ONE next-action)」相关文件（见 scripts/lib/restoreNavigator.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Restore Navigator / Single Next-Action (the missing aggregator that closes the complete-but-not-simple usability bridge: the restore family is 12 leaves / 10 CLIs each answering one slice, but a fresh-machine agent or human gets no unified verdict and no single "which command do I run NOW"; this synthesizes all family verdicts into ONE next-action)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreNavigator.test.js`

**230.** 如果「you need ONE answer to "which command do I run right now, who runs it (agent/human), and why" derived from the whole family」，先读「Restore Navigator / Single Next-Action (the missing aggregator that closes the complete-but-not-simple usability bridge: the restore family is 12 leaves / 10 CLIs each answering one slice, but a fresh-machine agent or human gets no unified verdict and no single "which command do I run NOW"; this synthesizes all family verdicts into ONE next-action)」相关文件（见 scripts/lib/restoreNavigator.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Restore Navigator / Single Next-Action (the missing aggregator that closes the complete-but-not-simple usability bridge: the restore family is 12 leaves / 10 CLIs each answering one slice, but a fresh-machine agent or human gets no unified verdict and no single "which command do I run NOW"; this synthesizes all family verdicts into ONE next-action)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreNavigator.test.js`

**231.** 如果「safety-first decision order (most dangerous first): forbidden -> hard-conflict -> agent-drive -> DONE -> conservative unknown; the first matching tier decides the sole verdict」，先读「Restore Navigator / Single Next-Action (the missing aggregator that closes the complete-but-not-simple usability bridge: the restore family is 12 leaves / 10 CLIs each answering one slice, but a fresh-machine agent or human gets no unified verdict and no single "which command do I run NOW"; this synthesizes all family verdicts into ONE next-action)」相关文件（见 scripts/lib/restoreNavigator.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Restore Navigator / Single Next-Action (the missing aggregator that closes the complete-but-not-simple usability bridge: the restore family is 12 leaves / 10 CLIs each answering one slice, but a fresh-machine agent or human gets no unified verdict and no single "which command do I run NOW"; this synthesizes all family verdicts into ONE next-action)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreNavigator.test.js`

**232.** 如果「it must RESPECT the skip-applier (010) learning: pick the first move NOT marked safeToSkip; mustTryDespiteDead steps still run (sole path / safety net)」，先读「Restore Navigator / Single Next-Action (the missing aggregator that closes the complete-but-not-simple usability bridge: the restore family is 12 leaves / 10 CLIs each answering one slice, but a fresh-machine agent or human gets no unified verdict and no single "which command do I run NOW"; this synthesizes all family verdicts into ONE next-action)」相关文件（见 scripts/lib/restoreNavigator.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Restore Navigator / Single Next-Action (the missing aggregator that closes the complete-but-not-simple usability bridge: the restore family is 12 leaves / 10 CLIs each answering one slice, but a fresh-machine agent or human gets no unified verdict and no single "which command do I run NOW"; this synthesizes all family verdicts into ONE next-action)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreNavigator.test.js`

**233.** 如果「honesty boundary: the navigator only READS existing verdict fields, never reorders/deletes/fabricates authorized; malformed/missing fields -> conservative UNKNOWN + human」，先读「Restore Navigator / Single Next-Action (the missing aggregator that closes the complete-but-not-simple usability bridge: the restore family is 12 leaves / 10 CLIs each answering one slice, but a fresh-machine agent or human gets no unified verdict and no single "which command do I run NOW"; this synthesizes all family verdicts into ONE next-action)」相关文件（见 scripts/lib/restoreNavigator.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Restore Navigator / Single Next-Action (the missing aggregator that closes the complete-but-not-simple usability bridge: the restore family is 12 leaves / 10 CLIs each answering one slice, but a fresh-machine agent or human gets no unified verdict and no single "which command do I run NOW"; this synthesizes all family verdicts into ONE next-action)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreNavigator.test.js`

**234.** 如果「a dangerous command in the chosen step is redacted and forces actor=human (inherits the whole-family _DANGER_TOKENS red line)」，先读「Restore Navigator / Single Next-Action (the missing aggregator that closes the complete-but-not-simple usability bridge: the restore family is 12 leaves / 10 CLIs each answering one slice, but a fresh-machine agent or human gets no unified verdict and no single "which command do I run NOW"; this synthesizes all family verdicts into ONE next-action)」相关文件（见 scripts/lib/restoreNavigator.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Restore Navigator / Single Next-Action (the missing aggregator that closes the complete-but-not-simple usability bridge: the restore family is 12 leaves / 10 CLIs each answering one slice, but a fresh-machine agent or human gets no unified verdict and no single "which command do I run NOW"; this synthesizes all family verdicts into ONE next-action)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreNavigator.test.js`

**235.** 如果「you want the single front door: node scripts/restore-navigate.js --json (a fresh-machine self-driving agent reads it to decide the next step)」，先读「Restore Navigator / Single Next-Action (the missing aggregator that closes the complete-but-not-simple usability bridge: the restore family is 12 leaves / 10 CLIs each answering one slice, but a fresh-machine agent or human gets no unified verdict and no single "which command do I run NOW"; this synthesizes all family verdicts into ONE next-action)」相关文件（见 scripts/lib/restoreNavigator.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Restore Navigator / Single Next-Action (the missing aggregator that closes the complete-but-not-simple usability bridge: the restore family is 12 leaves / 10 CLIs each answering one slice, but a fresh-machine agent or human gets no unified verdict and no single "which command do I run NOW"; this synthesizes all family verdicts into ONE next-action)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreNavigator.test.js`

**236.** 如果「the OPS-MAN-090 navigator doc is out of sync with its generator」，先读「Restore Navigator / Single Next-Action (the missing aggregator that closes the complete-but-not-simple usability bridge: the restore family is 12 leaves / 10 CLIs each answering one slice, but a fresh-machine agent or human gets no unified verdict and no single "which command do I run NOW"; this synthesizes all family verdicts into ONE next-action)」相关文件（见 scripts/lib/restoreNavigator.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Restore Navigator / Single Next-Action (the missing aggregator that closes the complete-but-not-simple usability bridge: the restore family is 12 leaves / 10 CLIs each answering one slice, but a fresh-machine agent or human gets no unified verdict and no single "which command do I run NOW"; this synthesizes all family verdicts into ONE next-action)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreNavigator.test.js`

**237.** 如果「khy restore only checks tar exit code and prints 完整还原; it NEVER reconciles the snapshot header fileCount (git ls-tree -r blob count) against the files actually on disk -> silent under-extraction reads as complete」，先读「Restore Extraction-Completeness Verifier (consumes the DEAD snapshot header fileCount field at restore time: khy restore prints "fully restored" on tar exit 0 alone and never reconciles the disk file count against the snapshot fileCount; tar can exit 0 yet drop files (disk full / MAX_PATH / skipped entry types) -> silent under-extraction false-GREEN on the user's most important path "a COMPLETE and simple restore"; this reconciles expected vs actual and gives an honest verdict)」相关文件（见 scripts/lib/restoreCompletenessVerifier.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Restore Extraction-Completeness Verifier (consumes the DEAD snapshot header fileCount field at restore time: khy restore prints "fully restored" on tar exit 0 alone and never reconciles the disk file count against the snapshot fileCount; tar can exit 0 yet drop files (disk full / MAX_PATH / skipped entry types) -> silent under-extraction false-GREEN on the user's most important path "a COMPLETE and simple restore"; this reconciles expected vs actual and gives an honest verdict)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreCompletenessVerifier.test.js`

**238.** 如果「you need a post-restore completeness check a fresh-machine agent can run offline: node scripts/restore-verify-complete.js <dir> --json」，先读「Restore Extraction-Completeness Verifier (consumes the DEAD snapshot header fileCount field at restore time: khy restore prints "fully restored" on tar exit 0 alone and never reconciles the disk file count against the snapshot fileCount; tar can exit 0 yet drop files (disk full / MAX_PATH / skipped entry types) -> silent under-extraction false-GREEN on the user's most important path "a COMPLETE and simple restore"; this reconciles expected vs actual and gives an honest verdict)」相关文件（见 scripts/lib/restoreCompletenessVerifier.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Restore Extraction-Completeness Verifier (consumes the DEAD snapshot header fileCount field at restore time: khy restore prints "fully restored" on tar exit 0 alone and never reconciles the disk file count against the snapshot fileCount; tar can exit 0 yet drop files (disk full / MAX_PATH / skipped entry types) -> silent under-extraction false-GREEN on the user's most important path "a COMPLETE and simple restore"; this reconciles expected vs actual and gives an honest verdict)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreCompletenessVerifier.test.js`

**239.** 如果「verdict tiers (conservative first): unverifiable (no reconcilable counts) -> corrupt (sha256/tar precheck failed) -> incomplete (actual<expected, the silent under-extraction) -> over-extracted (actual>expected, residue/drift) -> complete (counts match AND precheck passed)」，先读「Restore Extraction-Completeness Verifier (consumes the DEAD snapshot header fileCount field at restore time: khy restore prints "fully restored" on tar exit 0 alone and never reconciles the disk file count against the snapshot fileCount; tar can exit 0 yet drop files (disk full / MAX_PATH / skipped entry types) -> silent under-extraction false-GREEN on the user's most important path "a COMPLETE and simple restore"; this reconciles expected vs actual and gives an honest verdict)」相关文件（见 scripts/lib/restoreCompletenessVerifier.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Restore Extraction-Completeness Verifier (consumes the DEAD snapshot header fileCount field at restore time: khy restore prints "fully restored" on tar exit 0 alone and never reconciles the disk file count against the snapshot fileCount; tar can exit 0 yet drop files (disk full / MAX_PATH / skipped entry types) -> silent under-extraction false-GREEN on the user's most important path "a COMPLETE and simple restore"; this reconciles expected vs actual and gives an honest verdict)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreCompletenessVerifier.test.js`

**240.** 如果「honesty boundary: ok===true ONLY when status===complete; evidence-insufficient never defaults to complete (unverifiable)」，先读「Restore Extraction-Completeness Verifier (consumes the DEAD snapshot header fileCount field at restore time: khy restore prints "fully restored" on tar exit 0 alone and never reconciles the disk file count against the snapshot fileCount; tar can exit 0 yet drop files (disk full / MAX_PATH / skipped entry types) -> silent under-extraction false-GREEN on the user's most important path "a COMPLETE and simple restore"; this reconciles expected vs actual and gives an honest verdict)」相关文件（见 scripts/lib/restoreCompletenessVerifier.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Restore Extraction-Completeness Verifier (consumes the DEAD snapshot header fileCount field at restore time: khy restore prints "fully restored" on tar exit 0 alone and never reconciles the disk file count against the snapshot fileCount; tar can exit 0 yet drop files (disk full / MAX_PATH / skipped entry types) -> silent under-extraction false-GREEN on the user's most important path "a COMPLETE and simple restore"; this reconciles expected vs actual and gives an honest verdict)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreCompletenessVerifier.test.js`

**241.** 如果「count semantics: expected = snapshot fileCount; actual = recursive regular-file count of the restored dir (excludes .git and snapshot sidecars, no symlink follow) to match git archive layout」，先读「Restore Extraction-Completeness Verifier (consumes the DEAD snapshot header fileCount field at restore time: khy restore prints "fully restored" on tar exit 0 alone and never reconciles the disk file count against the snapshot fileCount; tar can exit 0 yet drop files (disk full / MAX_PATH / skipped entry types) -> silent under-extraction false-GREEN on the user's most important path "a COMPLETE and simple restore"; this reconciles expected vs actual and gives an honest verdict)」相关文件（见 scripts/lib/restoreCompletenessVerifier.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Restore Extraction-Completeness Verifier (consumes the DEAD snapshot header fileCount field at restore time: khy restore prints "fully restored" on tar exit 0 alone and never reconciles the disk file count against the snapshot fileCount; tar can exit 0 yet drop files (disk full / MAX_PATH / skipped entry types) -> silent under-extraction false-GREEN on the user's most important path "a COMPLETE and simple restore"; this reconciles expected vs actual and gives an honest verdict)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreCompletenessVerifier.test.js`

**242.** 如果「--json exits 2 on any non-complete status so a self-driving agent does NOT treat the restore as finished」，先读「Restore Extraction-Completeness Verifier (consumes the DEAD snapshot header fileCount field at restore time: khy restore prints "fully restored" on tar exit 0 alone and never reconciles the disk file count against the snapshot fileCount; tar can exit 0 yet drop files (disk full / MAX_PATH / skipped entry types) -> silent under-extraction false-GREEN on the user's most important path "a COMPLETE and simple restore"; this reconciles expected vs actual and gives an honest verdict)」相关文件（见 scripts/lib/restoreCompletenessVerifier.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Restore Extraction-Completeness Verifier (consumes the DEAD snapshot header fileCount field at restore time: khy restore prints "fully restored" on tar exit 0 alone and never reconciles the disk file count against the snapshot fileCount; tar can exit 0 yet drop files (disk full / MAX_PATH / skipped entry types) -> silent under-extraction false-GREEN on the user's most important path "a COMPLETE and simple restore"; this reconciles expected vs actual and gives an honest verdict)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreCompletenessVerifier.test.js`

**243.** 如果「the OPS-MAN-095 completeness doc is out of sync with its generator」，先读「Restore Extraction-Completeness Verifier (consumes the DEAD snapshot header fileCount field at restore time: khy restore prints "fully restored" on tar exit 0 alone and never reconciles the disk file count against the snapshot fileCount; tar can exit 0 yet drop files (disk full / MAX_PATH / skipped entry types) -> silent under-extraction false-GREEN on the user's most important path "a COMPLETE and simple restore"; this reconciles expected vs actual and gives an honest verdict)」相关文件（见 scripts/lib/restoreCompletenessVerifier.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Restore Extraction-Completeness Verifier (consumes the DEAD snapshot header fileCount field at restore time: khy restore prints "fully restored" on tar exit 0 alone and never reconciles the disk file count against the snapshot fileCount; tar can exit 0 yet drop files (disk full / MAX_PATH / skipped entry types) -> silent under-extraction false-GREEN on the user's most important path "a COMPLETE and simple restore"; this reconciles expected vs actual and gives an honest verdict)。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/restoreCompletenessVerifier.test.js`

**244.** 如果「the restore/heal path validates crypto.algo but never the snapshot header format/formatVersion -> old restore code will blindly try to decrypt a newer-format snapshot」，先读「Restore Snapshot-Format Compatibility Gate (consumes the DEAD snapshot header format/formatVersion fields BEFORE decryption: makeSourceSnapshot stamps format='khy-source-snapshot'+formatVersion=1 but the restore/heal path (sourceHealService.decrypt, cli/handlers/publish.js) only checks crypto.algo and NEVER checks format/formatVersion -> grep 'khy-source-snapshot' has zero consumers in the restore codebase; a strange machine running OLD khy against a FUTURE formatVersion=2 snapshot decrypts blindly (cryptic auth error or silent mis-parse), and a non-khy dir enters decryption unchecked; this is the missing PRE-check answering 'does this khy even understand this snapshot format?')」相关文件（见 scripts/lib/snapshotFormatCompat.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Restore Snapshot-Format Compatibility Gate (consumes the DEAD snapshot header format/formatVersion fields BEFORE decryption: makeSourceSnapshot stamps format='khy-source-snapshot'+formatVersion=1 but the restore/heal path (sourceHealService.decrypt, cli/handlers/publish.js) only checks crypto.algo and NEVER checks format/formatVersion -> grep 'khy-source-snapshot' has zero consumers in the restore codebase; a strange machine running OLD khy against a FUTURE formatVersion=2 snapshot decrypts blindly (cryptic auth error or silent mis-parse), and a non-khy dir enters decryption unchecked; this is the missing PRE-check answering 'does this khy even understand this snapshot format?')。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/snapshotFormatCompat.test.js`

**245.** 如果「you need a pre-decryption format gate a fresh-machine agent can run offline: node scripts/restore-check-format.js <dir> --json」，先读「Restore Snapshot-Format Compatibility Gate (consumes the DEAD snapshot header format/formatVersion fields BEFORE decryption: makeSourceSnapshot stamps format='khy-source-snapshot'+formatVersion=1 but the restore/heal path (sourceHealService.decrypt, cli/handlers/publish.js) only checks crypto.algo and NEVER checks format/formatVersion -> grep 'khy-source-snapshot' has zero consumers in the restore codebase; a strange machine running OLD khy against a FUTURE formatVersion=2 snapshot decrypts blindly (cryptic auth error or silent mis-parse), and a non-khy dir enters decryption unchecked; this is the missing PRE-check answering 'does this khy even understand this snapshot format?')」相关文件（见 scripts/lib/snapshotFormatCompat.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Restore Snapshot-Format Compatibility Gate (consumes the DEAD snapshot header format/formatVersion fields BEFORE decryption: makeSourceSnapshot stamps format='khy-source-snapshot'+formatVersion=1 but the restore/heal path (sourceHealService.decrypt, cli/handlers/publish.js) only checks crypto.algo and NEVER checks format/formatVersion -> grep 'khy-source-snapshot' has zero consumers in the restore codebase; a strange machine running OLD khy against a FUTURE formatVersion=2 snapshot decrypts blindly (cryptic auth error or silent mis-parse), and a non-khy dir enters decryption unchecked; this is the missing PRE-check answering 'does this khy even understand this snapshot format?')。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/snapshotFormatCompat.test.js`

**246.** 如果「verdict tiers (conservative first): unverifiable (header missing / format non-string / formatVersion non-finite) -> alien (format!=='khy-source-snapshot') -> too-new (formatVersion>MAX, upgrade khy) -> too-old (formatVersion<MIN) -> supported (format known AND version within [MIN,MAX])」，先读「Restore Snapshot-Format Compatibility Gate (consumes the DEAD snapshot header format/formatVersion fields BEFORE decryption: makeSourceSnapshot stamps format='khy-source-snapshot'+formatVersion=1 but the restore/heal path (sourceHealService.decrypt, cli/handlers/publish.js) only checks crypto.algo and NEVER checks format/formatVersion -> grep 'khy-source-snapshot' has zero consumers in the restore codebase; a strange machine running OLD khy against a FUTURE formatVersion=2 snapshot decrypts blindly (cryptic auth error or silent mis-parse), and a non-khy dir enters decryption unchecked; this is the missing PRE-check answering 'does this khy even understand this snapshot format?')」相关文件（见 scripts/lib/snapshotFormatCompat.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Restore Snapshot-Format Compatibility Gate (consumes the DEAD snapshot header format/formatVersion fields BEFORE decryption: makeSourceSnapshot stamps format='khy-source-snapshot'+formatVersion=1 but the restore/heal path (sourceHealService.decrypt, cli/handlers/publish.js) only checks crypto.algo and NEVER checks format/formatVersion -> grep 'khy-source-snapshot' has zero consumers in the restore codebase; a strange machine running OLD khy against a FUTURE formatVersion=2 snapshot decrypts blindly (cryptic auth error or silent mis-parse), and a non-khy dir enters decryption unchecked; this is the missing PRE-check answering 'does this khy even understand this snapshot format?')。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/snapshotFormatCompat.test.js`

**247.** 如果「honesty boundary: ok===true ONLY when status===supported; unknown/alien/out-of-range never default to supported」，先读「Restore Snapshot-Format Compatibility Gate (consumes the DEAD snapshot header format/formatVersion fields BEFORE decryption: makeSourceSnapshot stamps format='khy-source-snapshot'+formatVersion=1 but the restore/heal path (sourceHealService.decrypt, cli/handlers/publish.js) only checks crypto.algo and NEVER checks format/formatVersion -> grep 'khy-source-snapshot' has zero consumers in the restore codebase; a strange machine running OLD khy against a FUTURE formatVersion=2 snapshot decrypts blindly (cryptic auth error or silent mis-parse), and a non-khy dir enters decryption unchecked; this is the missing PRE-check answering 'does this khy even understand this snapshot format?')」相关文件（见 scripts/lib/snapshotFormatCompat.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Restore Snapshot-Format Compatibility Gate (consumes the DEAD snapshot header format/formatVersion fields BEFORE decryption: makeSourceSnapshot stamps format='khy-source-snapshot'+formatVersion=1 but the restore/heal path (sourceHealService.decrypt, cli/handlers/publish.js) only checks crypto.algo and NEVER checks format/formatVersion -> grep 'khy-source-snapshot' has zero consumers in the restore codebase; a strange machine running OLD khy against a FUTURE formatVersion=2 snapshot decrypts blindly (cryptic auth error or silent mis-parse), and a non-khy dir enters decryption unchecked; this is the missing PRE-check answering 'does this khy even understand this snapshot format?')。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/snapshotFormatCompat.test.js`

**248.** 如果「this is a PRE-gate: it runs BEFORE completeness reconciliation (095), authorization (088), navigation (090) -- if the format is not understood, every later diagnostic is meaningless」，先读「Restore Snapshot-Format Compatibility Gate (consumes the DEAD snapshot header format/formatVersion fields BEFORE decryption: makeSourceSnapshot stamps format='khy-source-snapshot'+formatVersion=1 but the restore/heal path (sourceHealService.decrypt, cli/handlers/publish.js) only checks crypto.algo and NEVER checks format/formatVersion -> grep 'khy-source-snapshot' has zero consumers in the restore codebase; a strange machine running OLD khy against a FUTURE formatVersion=2 snapshot decrypts blindly (cryptic auth error or silent mis-parse), and a non-khy dir enters decryption unchecked; this is the missing PRE-check answering 'does this khy even understand this snapshot format?')」相关文件（见 scripts/lib/snapshotFormatCompat.js），按 B1 说清改什么，再跑其验证命令确认现状。
  - 说明：子系统：Restore Snapshot-Format Compatibility Gate (consumes the DEAD snapshot header format/formatVersion fields BEFORE decryption: makeSourceSnapshot stamps format='khy-source-snapshot'+formatVersion=1 but the restore/heal path (sourceHealService.decrypt, cli/handlers/publish.js) only checks crypto.algo and NEVER checks format/formatVersion -> grep 'khy-source-snapshot' has zero consumers in the restore codebase; a strange machine running OLD khy against a FUTURE formatVersion=2 snapshot decrypts blindly (cryptic auth error or silent mis-parse), and a non-khy dir enters decryption unchecked; this is the missing PRE-check answering 'does this khy even understand this snapshot format?')。触发词命中时的第一反应。
  - 验证：`npm run test:one -- scripts/tests/snapshotFormatCompat.test.js`


## 三、各子系统验证门（一条命令＝一块的绿灯）

**249.** 验证「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run docs:check-beginner`

**250.** 验证「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`node --test scripts/docs/check_beginner_docs.test.js`

**251.** 验证「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run docs:build`

**252.** 验证「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run docs:verify`

**253.** 验证「Bootstrap and Packaging」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Bootstrap and Packaging。
  - 验证：`npm run check:manifest-sync`

**254.** 验证「Bootstrap and Packaging」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Bootstrap and Packaging。
  - 验证：`bash scripts/release/build-and-audit-pip-purity.sh`

**255.** 验证「CLI Routing and Help Surface」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：CLI Routing and Help Surface。
  - 验证：`npm run test:one -- services/backend/tests/cli/router.test.js services/backend/tests/cli/repl.tasks.interaction.test.js`

**256.** 验证「CLI Routing and Help Surface」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：CLI Routing and Help Surface。
  - 验证：`node -e "require('./services/backend/src/cli/router')"`

**257.** 验证「Prompt Capsule and Debug Prompt System」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`node --test services/backend/tests/promptOnDemandSections.test.js`

**258.** 验证「Prompt Capsule and Debug Prompt System」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`node --test services/backend/tests/promptLearningRules.test.js`

**259.** 验证「Prompt Capsule and Debug Prompt System」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`npx jest services/backend/tests/gatewayDebugPrompt.test.js --runInBand`

**260.** 验证「AI Gateway and Adapter Layer」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run test:one -- services/backend/tests/aiGateway.stability.test.js services/backend/tests/gateway/transportResilience.test.js services/backend/tests/gatewayAdapters.stability.test.js`

**261.** 验证「AI Gateway and Adapter Layer」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：AI Gateway and Adapter Layer。
  - 验证：`node -e "require('./services/backend/src/services/gateway/aiGateway')"`

**262.** 验证「AI Gateway and Adapter Layer」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：AI Gateway and Adapter Layer。
  - 验证：`khy doctor`

**263.** 验证「Proxy, Daemon, and Runtime Port Discovery」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run test:one -- services/backend/tests/daemonManager.runtimePort.test.js services/backend/tests/gatewayManage.portDrift.integration.test.js services/backend/tests/services/proxyBaseUrl.test.js services/backend/tests/services/serviceDefaults.test.js`

**264.** 验证「Proxy, Daemon, and Runtime Port Discovery」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`khy doctor`

**265.** 验证「AI Management UI and API」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：AI Management UI and API。
  - 验证：`npm run test:one -- services/backend/tests/routes/aiGatewayAdmin.modelSlots.test.js services/backend/tests/gatewayManage.apiDisplay.test.js`

**266.** 验证「AI Management UI and API」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：AI Management UI and API。
  - 验证：`npm run build --prefix apps/ai-frontend`

**267.** 验证「Coding Projects (named workspaces + chat linkage)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run test:one -- services/backend/tests/projectStore.test.js apps/ai-frontend/src/composables/useProjects.wiring.test.js`

**268.** 验证「Coding Projects (named workspaces + chat linkage)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run build --prefix apps/ai-frontend`

**269.** 验证「Workspace, Publish, and Verification Commands」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Workspace, Publish, and Verification Commands。
  - 验证：`npm run test:one -- services/backend/tests/publish.sourceReleaseMode.test.js services/backend/tests/publish.dbPreflight.test.js`

**270.** 验证「Maintenance Safety and Rule Gates」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Maintenance Safety and Rule Gates。
  - 验证：`npm run check:changed`

**271.** 验证「Maintenance Safety and Rule Gates」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Maintenance Safety and Rule Gates。
  - 验证：`npm run check:quality-gates`

**272.** 验证「Release and Rollback」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Release and Rollback。
  - 验证：`npm run test:one -- services/backend/tests/publish.sourceReleaseMode.test.js services/backend/tests/publish.dbPreflight.test.js`

**273.** 验证「Release and Rollback」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Release and Rollback。
  - 验证：`npm run check:version-sync`

**274.** 验证「Build Best Environment (Self-check / Repair / Probes)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Build Best Environment (Self-check / Repair / Probes)。
  - 验证：`npm run test:one -- services/backend/tests/services/localBrainEnvOptimize.test.js services/backend/tests/services/envProbes.test.js services/backend/tests/services/envRepair.test.js services/backend/tests/services/envPlatform.test.js`

**275.** 验证「Evolution Prompt Playbook (1000 preset prompts)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Evolution Prompt Playbook (1000 preset prompts)。
  - 验证：`npm run test:one -- scripts/tests/gen-evolution-prompts.test.js`

**276.** 验证「Symptom Triage (route a symptom to its subsystem)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Symptom Triage (route a symptom to its subsystem)。
  - 验证：`npm run test:one -- scripts/tests/maintainerTriage.test.js`

**277.** 验证「Off-machine Restore Readiness (can a fresh machine restore khyos?)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Off-machine Restore Readiness (can a fresh machine restore khyos?)。
  - 验证：`npm run test:one -- scripts/tests/restoreReadiness.test.js`

**278.** 验证「Installed-copy Integrity (is the on-disk bundle actually complete?)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Installed-copy Integrity (is the on-disk bundle actually complete?)。
  - 验证：`npm run test:one -- scripts/tests/installIntegrity.test.js`

**279.** 验证「First-run Hydration Health (did the online dependency hydrate actually succeed?)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：First-run Hydration Health (did the online dependency hydrate actually succeed?)。
  - 验证：`npm run test:one -- scripts/tests/hydrationHealth.test.js`

**280.** 验证「Agent Restore Plan Synthesizer (one ordered, autonomy-classified restore plan a landing agent can drive)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Agent Restore Plan Synthesizer (one ordered, autonomy-classified restore plan a landing agent can drive)。
  - 验证：`npm run test:one -- scripts/tests/agentRestorePlan.test.js`

**281.** 验证「Cross-mirror Restore Conflict Detector (do the three restore self-checks contradict each other before an agent auto-drives?)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Cross-mirror Restore Conflict Detector (do the three restore self-checks contradict each other before an agent auto-drives?)。
  - 验证：`npm run test:one -- scripts/tests/restoreConflictDetector.test.js`

**282.** 验证「Cross-mirror Restore Conflict Resolver (given a detected contradiction, how does an agent safely resolve it step-by-step, and where must it hand off to a human?)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Cross-mirror Restore Conflict Resolver (given a detected contradiction, how does an agent safely resolve it step-by-step, and where must it hand off to a human?)。
  - 验证：`npm run test:one -- scripts/tests/restoreConflictResolver.test.js`

**283.** 验证「Off-machine Launch-entry Contract (does each channel pin the launch script it execs?)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Off-machine Launch-entry Contract (does each channel pin the launch script it execs?)。
  - 验证：`npm run test:one -- scripts/tests/bundleLaunchContract.test.js`

**284.** 验证「Proxy Egress Bridge (select node + enable/disable)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Proxy Egress Bridge (select node + enable/disable)。
  - 验证：`npm run test:one -- services/backend/tests/proxyCoreConfigGen.test.js services/backend/tests/proxyCoreManager.test.js services/backend/tests/proxyConfigService.egress.test.js services/backend/tests/aiManagementProxyEgress.wiring.test.js apps/ai-frontend/src/composables/useProxies.egress.wiring.test.js services/backend/tests/bootstrap/ensureProxyCoreEnv.test.js services/backend/tests/services/proxyCoreInstaller.test.js`

**285.** 验证「Proxy Egress Bridge (select node + enable/disable)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Proxy Egress Bridge (select node + enable/disable)。
  - 验证：`npm run build --prefix apps/ai-frontend`

**286.** 验证「Startup Failure Real-cause + Fix (does a fresh-machine crash say WHY and HOW, not just a raw stack?)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Startup Failure Real-cause + Fix (does a fresh-machine crash say WHY and HOW, not just a raw stack?)。
  - 验证：`npm run test:one -- services/backend/tests/bootstrap/startupFailureExplain.test.js`

**287.** 验证「Windows .md Suggested-app Registration (does khy show in the Open-With '建议的应用' list?)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Windows .md Suggested-app Registration (does khy show in the Open-With '建议的应用' list?)。
  - 验证：`npm run test:one -- services/backend/tests/services/mdSuggestedAppsPlan.test.js`

**288.** 验证「Fresh-machine Off-machine-restore Self-check in `khy doctor` (真实原因+解决方法 for a fresh pip/npm install)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Fresh-machine Off-machine-restore Self-check in `khy doctor` (真实原因+解决方法 for a fresh pip/npm install)。
  - 验证：`npm run test:one -- services/backend/tests/services/freshInstallDoctor.test.js`

**289.** 验证「CJK-ize /recap so session recap produces content on Chinese sessions」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：CJK-ize /recap so session recap produces content on Chinese sessions。
  - 验证：`npm run test:one -- services/backend/tests/services/sessionRecapCjk.test.js services/backend/tests/services/sessionRecapService.cjk.test.js`

**290.** 验证「npm-channel Node version preflight (parity with pip check_node; kills the cross-channel off-machine-restore contradiction)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：npm-channel Node version preflight (parity with pip check_node; kills the cross-channel off-machine-restore contradiction)。
  - 验证：`npm run test:one -- packaging/npm/test/nodeVersionPreflight.test.js`

**291.** 验证「Restore Convergence & Loop-Guard Verifier (after an agent executes a restore move and re-probes, did it actually advance? stop, continue, or escalate?)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Restore Convergence & Loop-Guard Verifier (after an agent executes a restore move and re-probes, did it actually advance? stop, continue, or escalate?)。
  - 验证：`npm run test:one -- scripts/tests/restoreConvergenceVerifier.test.js`

**292.** 验证「Dependency-aware WAVE scheduling + fault-aware execution + predecessor-result injection for auto-decomposed subtasks (拆任务 → 有序并行 → 依赖失败则跳过下游并如实汇报 → 前驱结果注入下游不再盲跑 → 跳过与失败在最终报告分列 → 确定性顺序链拆解让整条 arc 在默认离机路径活起来 → 按角色收窄子智能体工具集,只读角色不给写工具 → 多个并行子任务改同一文件时如实告警可能的写-写覆盖 → 成功但零产出的子任务如实标注不折进完成 → 最终报告按角色标注每个子任务并把失败按类型分布,让失败的验证子任务不被匿名折进失败)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Dependency-aware WAVE scheduling + fault-aware execution + predecessor-result injection for auto-decomposed subtasks (拆任务 → 有序并行 → 依赖失败则跳过下游并如实汇报 → 前驱结果注入下游不再盲跑 → 跳过与失败在最终报告分列 → 确定性顺序链拆解让整条 arc 在默认离机路径活起来 → 按角色收窄子智能体工具集,只读角色不给写工具 → 多个并行子任务改同一文件时如实告警可能的写-写覆盖 → 成功但零产出的子任务如实标注不折进完成 → 最终报告按角色标注每个子任务并把失败按类型分布,让失败的验证子任务不被匿名折进失败)。
  - 验证：`npm run test:one -- services/backend/tests/services/orchestrator/dependencyWaveScheduler.test.js services/backend/tests/services/mergeResultsSkipDistinct.test.js services/backend/tests/services/sequentialChainDecompose.test.js services/backend/tests/services/orchestrator/roleToolScope.test.js services/backend/tests/services/orchestrator/mergeFileConflicts.test.js services/backend/tests/services/orchestrator/mergeEmptySuccess.test.js services/backend/tests/services/orchestrator/mergeRoleAttribution.test.js`

**293.** 验证「Dependency-aware WAVE scheduling + fault-aware execution + predecessor-result injection for auto-decomposed subtasks (拆任务 → 有序并行 → 依赖失败则跳过下游并如实汇报 → 前驱结果注入下游不再盲跑 → 跳过与失败在最终报告分列 → 确定性顺序链拆解让整条 arc 在默认离机路径活起来 → 按角色收窄子智能体工具集,只读角色不给写工具 → 多个并行子任务改同一文件时如实告警可能的写-写覆盖 → 成功但零产出的子任务如实标注不折进完成 → 最终报告按角色标注每个子任务并把失败按类型分布,让失败的验证子任务不被匿名折进失败)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Dependency-aware WAVE scheduling + fault-aware execution + predecessor-result injection for auto-decomposed subtasks (拆任务 → 有序并行 → 依赖失败则跳过下游并如实汇报 → 前驱结果注入下游不再盲跑 → 跳过与失败在最终报告分列 → 确定性顺序链拆解让整条 arc 在默认离机路径活起来 → 按角色收窄子智能体工具集,只读角色不给写工具 → 多个并行子任务改同一文件时如实告警可能的写-写覆盖 → 成功但零产出的子任务如实标注不折进完成 → 最终报告按角色标注每个子任务并把失败按类型分布,让失败的验证子任务不被匿名折进失败)。
  - 验证：`npm run test:one -- services/backend/tests/services/orchestrator/dependencyWaveScheduler.test.js services/backend/tests/services/mergeResultsSkipDistinct.test.js services/backend/tests/services/sequentialChainDecompose.test.js services/backend/tests/services/orchestrator/roleToolScope.test.js services/backend/tests/services/orchestrator/mergeFileConflicts.test.js services/backend/tests/services/orchestrator/mergeEmptySuccess.test.js services/backend/tests/services/orchestrator/mergeRoleAttribution.test.js`

**294.** 验证「Dependency-aware WAVE scheduling + fault-aware execution + predecessor-result injection for auto-decomposed subtasks (拆任务 → 有序并行 → 依赖失败则跳过下游并如实汇报 → 前驱结果注入下游不再盲跑 → 跳过与失败在最终报告分列 → 确定性顺序链拆解让整条 arc 在默认离机路径活起来 → 按角色收窄子智能体工具集,只读角色不给写工具 → 多个并行子任务改同一文件时如实告警可能的写-写覆盖 → 成功但零产出的子任务如实标注不折进完成 → 最终报告按角色标注每个子任务并把失败按类型分布,让失败的验证子任务不被匿名折进失败)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Dependency-aware WAVE scheduling + fault-aware execution + predecessor-result injection for auto-decomposed subtasks (拆任务 → 有序并行 → 依赖失败则跳过下游并如实汇报 → 前驱结果注入下游不再盲跑 → 跳过与失败在最终报告分列 → 确定性顺序链拆解让整条 arc 在默认离机路径活起来 → 按角色收窄子智能体工具集,只读角色不给写工具 → 多个并行子任务改同一文件时如实告警可能的写-写覆盖 → 成功但零产出的子任务如实标注不折进完成 → 最终报告按角色标注每个子任务并把失败按类型分布,让失败的验证子任务不被匿名折进失败)。
  - 验证：`npm run test:one -- services/backend/tests/services/orchestrator/dependencyWaveScheduler.test.js services/backend/tests/services/mergeResultsSkipDistinct.test.js services/backend/tests/services/sequentialChainDecompose.test.js services/backend/tests/services/orchestrator/roleToolScope.test.js services/backend/tests/services/orchestrator/mergeFileConflicts.test.js services/backend/tests/services/orchestrator/mergeEmptySuccess.test.js services/backend/tests/services/orchestrator/mergeRoleAttribution.test.js`

**295.** 验证「Dependency-aware WAVE scheduling + fault-aware execution + predecessor-result injection for auto-decomposed subtasks (拆任务 → 有序并行 → 依赖失败则跳过下游并如实汇报 → 前驱结果注入下游不再盲跑 → 跳过与失败在最终报告分列 → 确定性顺序链拆解让整条 arc 在默认离机路径活起来 → 按角色收窄子智能体工具集,只读角色不给写工具 → 多个并行子任务改同一文件时如实告警可能的写-写覆盖 → 成功但零产出的子任务如实标注不折进完成 → 最终报告按角色标注每个子任务并把失败按类型分布,让失败的验证子任务不被匿名折进失败)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Dependency-aware WAVE scheduling + fault-aware execution + predecessor-result injection for auto-decomposed subtasks (拆任务 → 有序并行 → 依赖失败则跳过下游并如实汇报 → 前驱结果注入下游不再盲跑 → 跳过与失败在最终报告分列 → 确定性顺序链拆解让整条 arc 在默认离机路径活起来 → 按角色收窄子智能体工具集,只读角色不给写工具 → 多个并行子任务改同一文件时如实告警可能的写-写覆盖 → 成功但零产出的子任务如实标注不折进完成 → 最终报告按角色标注每个子任务并把失败按类型分布,让失败的验证子任务不被匿名折进失败)。
  - 验证：`npm run test:one -- services/backend/tests/services/orchestrator/dependencyWaveScheduler.test.js services/backend/tests/services/mergeResultsSkipDistinct.test.js services/backend/tests/services/sequentialChainDecompose.test.js services/backend/tests/services/orchestrator/roleToolScope.test.js services/backend/tests/services/orchestrator/mergeFileConflicts.test.js services/backend/tests/services/orchestrator/mergeEmptySuccess.test.js services/backend/tests/services/orchestrator/mergeRoleAttribution.test.js`

**296.** 验证「Dependency-aware WAVE scheduling + fault-aware execution + predecessor-result injection for auto-decomposed subtasks (拆任务 → 有序并行 → 依赖失败则跳过下游并如实汇报 → 前驱结果注入下游不再盲跑 → 跳过与失败在最终报告分列 → 确定性顺序链拆解让整条 arc 在默认离机路径活起来 → 按角色收窄子智能体工具集,只读角色不给写工具 → 多个并行子任务改同一文件时如实告警可能的写-写覆盖 → 成功但零产出的子任务如实标注不折进完成 → 最终报告按角色标注每个子任务并把失败按类型分布,让失败的验证子任务不被匿名折进失败)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Dependency-aware WAVE scheduling + fault-aware execution + predecessor-result injection for auto-decomposed subtasks (拆任务 → 有序并行 → 依赖失败则跳过下游并如实汇报 → 前驱结果注入下游不再盲跑 → 跳过与失败在最终报告分列 → 确定性顺序链拆解让整条 arc 在默认离机路径活起来 → 按角色收窄子智能体工具集,只读角色不给写工具 → 多个并行子任务改同一文件时如实告警可能的写-写覆盖 → 成功但零产出的子任务如实标注不折进完成 → 最终报告按角色标注每个子任务并把失败按类型分布,让失败的验证子任务不被匿名折进失败)。
  - 验证：`npm run test:one -- services/backend/tests/services/orchestrator/dependencyWaveScheduler.test.js services/backend/tests/services/mergeResultsSkipDistinct.test.js services/backend/tests/services/sequentialChainDecompose.test.js services/backend/tests/services/orchestrator/roleToolScope.test.js services/backend/tests/services/orchestrator/mergeFileConflicts.test.js services/backend/tests/services/orchestrator/mergeEmptySuccess.test.js services/backend/tests/services/orchestrator/mergeRoleAttribution.test.js`

**297.** 验证「Dependency-aware WAVE scheduling + fault-aware execution + predecessor-result injection for auto-decomposed subtasks (拆任务 → 有序并行 → 依赖失败则跳过下游并如实汇报 → 前驱结果注入下游不再盲跑 → 跳过与失败在最终报告分列 → 确定性顺序链拆解让整条 arc 在默认离机路径活起来 → 按角色收窄子智能体工具集,只读角色不给写工具 → 多个并行子任务改同一文件时如实告警可能的写-写覆盖 → 成功但零产出的子任务如实标注不折进完成 → 最终报告按角色标注每个子任务并把失败按类型分布,让失败的验证子任务不被匿名折进失败)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Dependency-aware WAVE scheduling + fault-aware execution + predecessor-result injection for auto-decomposed subtasks (拆任务 → 有序并行 → 依赖失败则跳过下游并如实汇报 → 前驱结果注入下游不再盲跑 → 跳过与失败在最终报告分列 → 确定性顺序链拆解让整条 arc 在默认离机路径活起来 → 按角色收窄子智能体工具集,只读角色不给写工具 → 多个并行子任务改同一文件时如实告警可能的写-写覆盖 → 成功但零产出的子任务如实标注不折进完成 → 最终报告按角色标注每个子任务并把失败按类型分布,让失败的验证子任务不被匿名折进失败)。
  - 验证：`npm run test:one -- services/backend/tests/services/orchestrator/dependencyWaveScheduler.test.js services/backend/tests/services/mergeResultsSkipDistinct.test.js services/backend/tests/services/sequentialChainDecompose.test.js services/backend/tests/services/orchestrator/roleToolScope.test.js services/backend/tests/services/orchestrator/mergeFileConflicts.test.js services/backend/tests/services/orchestrator/mergeEmptySuccess.test.js services/backend/tests/services/orchestrator/mergeRoleAttribution.test.js`

**298.** 验证「Dependency-aware WAVE scheduling + fault-aware execution + predecessor-result injection for auto-decomposed subtasks (拆任务 → 有序并行 → 依赖失败则跳过下游并如实汇报 → 前驱结果注入下游不再盲跑 → 跳过与失败在最终报告分列 → 确定性顺序链拆解让整条 arc 在默认离机路径活起来 → 按角色收窄子智能体工具集,只读角色不给写工具 → 多个并行子任务改同一文件时如实告警可能的写-写覆盖 → 成功但零产出的子任务如实标注不折进完成 → 最终报告按角色标注每个子任务并把失败按类型分布,让失败的验证子任务不被匿名折进失败)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Dependency-aware WAVE scheduling + fault-aware execution + predecessor-result injection for auto-decomposed subtasks (拆任务 → 有序并行 → 依赖失败则跳过下游并如实汇报 → 前驱结果注入下游不再盲跑 → 跳过与失败在最终报告分列 → 确定性顺序链拆解让整条 arc 在默认离机路径活起来 → 按角色收窄子智能体工具集,只读角色不给写工具 → 多个并行子任务改同一文件时如实告警可能的写-写覆盖 → 成功但零产出的子任务如实标注不折进完成 → 最终报告按角色标注每个子任务并把失败按类型分布,让失败的验证子任务不被匿名折进失败)。
  - 验证：`npm run test:one -- services/backend/tests/services/orchestrator/dependencyWaveScheduler.test.js services/backend/tests/services/mergeResultsSkipDistinct.test.js services/backend/tests/services/sequentialChainDecompose.test.js services/backend/tests/services/orchestrator/roleToolScope.test.js services/backend/tests/services/orchestrator/mergeFileConflicts.test.js services/backend/tests/services/orchestrator/mergeEmptySuccess.test.js services/backend/tests/services/orchestrator/mergeRoleAttribution.test.js`

**299.** 验证「Restore Self-Drive Authorization Gate (before executing any restore move, should the agent auto-drive on THIS machine at all? authorized / ask-first / forbidden)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Restore Self-Drive Authorization Gate (before executing any restore move, should the agent auto-drive on THIS machine at all? authorized / ask-first / forbidden)。
  - 验证：`npm run test:one -- scripts/tests/restoreAutonomyGate.test.js`

**300.** 验证「Restore Recourse / Actionable Denial (the inverse of the authorization gate: if the agent is denied, what is the minimal ordered safe path to yes?)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Restore Recourse / Actionable Denial (the inverse of the authorization gate: if the agent is denied, what is the minimal ordered safe path to yes?)。
  - 验证：`npm run test:one -- scripts/tests/restoreRecoursePlan.test.js`

**301.** 验证「Restore Trace Journal / Durable Agent Memory (append-only event stream that rebuilds the cross-process stallCount the convergence loop-guard needs; closes the real seam where converge resets stallCount to 0 on every independent CLI invocation)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Restore Trace Journal / Durable Agent Memory (append-only event stream that rebuilds the cross-process stallCount the convergence loop-guard needs; closes the real seam where converge resets stallCount to 0 on every independent CLI invocation)。
  - 验证：`npm run test:one -- scripts/tests/restoreTraceJournal.test.js`

**302.** 验证「Restore Strategy Ledger / Cross-Session Learning (learns across ALL sessions on this machine which resolution strategies have been repeatedly proven dead, so the next self-drive skips them instead of re-walking known dead-ends; the machine-level complement to the per-session trace journal)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Restore Strategy Ledger / Cross-Session Learning (learns across ALL sessions on this machine which resolution strategies have been repeatedly proven dead, so the next self-drive skips them instead of re-walking known dead-ends; the machine-level complement to the per-session trace journal)。
  - 验证：`npm run test:one -- scripts/tests/restoreStrategyLedger.test.js`

**303.** 验证「Restore Skip Applier / Apply Cross-Session Learning (the missing consumer that closes the dead-field bridge: the strategy ledger produced recommendedSkips but nothing consumed them; this annotates the resolver recovery chain with learned-dead/safe-to-skip markers WITHOUT deleting or reordering)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Restore Skip Applier / Apply Cross-Session Learning (the missing consumer that closes the dead-field bridge: the strategy ledger produced recommendedSkips but nothing consumed them; this annotates the resolver recovery chain with learned-dead/safe-to-skip markers WITHOUT deleting or reordering)。
  - 验证：`npm run test:one -- scripts/tests/restoreSkipApplier.test.js`

**304.** 验证「Restore Navigator / Single Next-Action (the missing aggregator that closes the complete-but-not-simple usability bridge: the restore family is 12 leaves / 10 CLIs each answering one slice, but a fresh-machine agent or human gets no unified verdict and no single "which command do I run NOW"; this synthesizes all family verdicts into ONE next-action)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Restore Navigator / Single Next-Action (the missing aggregator that closes the complete-but-not-simple usability bridge: the restore family is 12 leaves / 10 CLIs each answering one slice, but a fresh-machine agent or human gets no unified verdict and no single "which command do I run NOW"; this synthesizes all family verdicts into ONE next-action)。
  - 验证：`npm run test:one -- scripts/tests/restoreNavigator.test.js`

**305.** 验证「Restore Extraction-Completeness Verifier (consumes the DEAD snapshot header fileCount field at restore time: khy restore prints "fully restored" on tar exit 0 alone and never reconciles the disk file count against the snapshot fileCount; tar can exit 0 yet drop files (disk full / MAX_PATH / skipped entry types) -> silent under-extraction false-GREEN on the user's most important path "a COMPLETE and simple restore"; this reconciles expected vs actual and gives an honest verdict)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Restore Extraction-Completeness Verifier (consumes the DEAD snapshot header fileCount field at restore time: khy restore prints "fully restored" on tar exit 0 alone and never reconciles the disk file count against the snapshot fileCount; tar can exit 0 yet drop files (disk full / MAX_PATH / skipped entry types) -> silent under-extraction false-GREEN on the user's most important path "a COMPLETE and simple restore"; this reconciles expected vs actual and gives an honest verdict)。
  - 验证：`npm run test:one -- scripts/tests/restoreCompletenessVerifier.test.js`

**306.** 验证「Restore Snapshot-Format Compatibility Gate (consumes the DEAD snapshot header format/formatVersion fields BEFORE decryption: makeSourceSnapshot stamps format='khy-source-snapshot'+formatVersion=1 but the restore/heal path (sourceHealService.decrypt, cli/handlers/publish.js) only checks crypto.algo and NEVER checks format/formatVersion -> grep 'khy-source-snapshot' has zero consumers in the restore codebase; a strange machine running OLD khy against a FUTURE formatVersion=2 snapshot decrypts blindly (cryptic auth error or silent mis-parse), and a non-khy dir enters decryption unchecked; this is the missing PRE-check answering 'does this khy even understand this snapshot format?')」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Restore Snapshot-Format Compatibility Gate (consumes the DEAD snapshot header format/formatVersion fields BEFORE decryption: makeSourceSnapshot stamps format='khy-source-snapshot'+formatVersion=1 but the restore/heal path (sourceHealService.decrypt, cli/handlers/publish.js) only checks crypto.algo and NEVER checks format/formatVersion -> grep 'khy-source-snapshot' has zero consumers in the restore codebase; a strange machine running OLD khy against a FUTURE formatVersion=2 snapshot decrypts blindly (cryptic auth error or silent mis-parse), and a non-khy dir enters decryption unchecked; this is the missing PRE-check answering 'does this khy even understand this snapshot format?')。
  - 验证：`npm run test:one -- scripts/tests/snapshotFormatCompat.test.js`

**307.** 验证「Restore Provenance Reconciler (consumes the DEAD snapshot header captureMode/includesUncommitted/dirty fields: makeSourceSnapshot stamps whether the git archive was a clean HEAD or a dirty working-tree capture, but the restore banner (services/backend/src/cli/handlers/publish.js) only prints gitCommit.slice(0,12) and NEVER reads captureMode/includesUncommitted -> a fresh-machine user reads 'commit 44a491fb07f3' and believes the restored source EQUALS that clean published commit, when it is actually that commit PLUS uncommitted deltas (dirty capture); this pure leaf + read-only CLI answers 'which exact git state does this restored source equal?' so nobody mistakes a dirty capture for the published commit)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Restore Provenance Reconciler (consumes the DEAD snapshot header captureMode/includesUncommitted/dirty fields: makeSourceSnapshot stamps whether the git archive was a clean HEAD or a dirty working-tree capture, but the restore banner (services/backend/src/cli/handlers/publish.js) only prints gitCommit.slice(0,12) and NEVER reads captureMode/includesUncommitted -> a fresh-machine user reads 'commit 44a491fb07f3' and believes the restored source EQUALS that clean published commit, when it is actually that commit PLUS uncommitted deltas (dirty capture); this pure leaf + read-only CLI answers 'which exact git state does this restored source equal?' so nobody mistakes a dirty capture for the published commit)。
  - 验证：`npm run test:one -- scripts/tests/restoreProvenance.test.js`

**308.** 验证「Restore Archive-Extract Compatibility Gate (consumes the DEAD snapshot header plaintextFormat/layout fields: makeSourceSnapshot stamps plaintextFormat='tar.gz'+layout='git-archive' describing the DECRYPTED inner-archive shape, but the restore/heal extractor (sourceHealService._extractTarGz, cli/handlers/publish.js) HARD-CODES `tar -xzf` and NEVER reads plaintextFormat/layout -> grep shows zero consumers in the restore codebase; a fresh machine running OLD khy against a FUTURE plaintextFormat='tar.zst'/'zip' snapshot blindly runs `tar -xzf` (gzip header mismatch -> cryptic extract error, or partial bytes mis-parsed into half a tree); this pure leaf + read-only CLI answers 'does this khy's extractor even understand the decrypted archive shape BEFORE running tar -xzf?')」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Restore Archive-Extract Compatibility Gate (consumes the DEAD snapshot header plaintextFormat/layout fields: makeSourceSnapshot stamps plaintextFormat='tar.gz'+layout='git-archive' describing the DECRYPTED inner-archive shape, but the restore/heal extractor (sourceHealService._extractTarGz, cli/handlers/publish.js) HARD-CODES `tar -xzf` and NEVER reads plaintextFormat/layout -> grep shows zero consumers in the restore codebase; a fresh machine running OLD khy against a FUTURE plaintextFormat='tar.zst'/'zip' snapshot blindly runs `tar -xzf` (gzip header mismatch -> cryptic extract error, or partial bytes mis-parsed into half a tree); this pure leaf + read-only CLI answers 'does this khy's extractor even understand the decrypted archive shape BEFORE running tar -xzf?')。
  - 验证：`npm run test:one -- scripts/tests/archiveExtractCompat.test.js`

**309.** 验证「Restore Crypto-Suite Performability Gate (consumes the DEAD snapshot header crypto.kdf field, and turns a MISLEADING error honest: sourceSnapshotCrypto.encrypt stamps crypto.algo/kdf/scrypt but decrypt (sourceSnapshotCrypto.decrypt) ONLY validates crypto.algo and NEVER validates crypto.kdf -> grep 'kdf' has exactly one reference (the encrypt stamp), zero consumers; worse, decrypt reads scrypt params as `(c.scrypt && c.scrypt.N) || SCRYPT.N` (blind fallback to hard-coded scrypt), so a FUTURE kdf='argon2' snapshot on OLD khy silently mis-derives the key via scrypt, decipher.final() throws 'unable to authenticate data', and the caller MAPS THAT TO 'wrong secret' -> a fresh-machine user is told their passphrase is wrong when the truth is 'this khy cannot perform the argon2 KDF'; this pure leaf + read-only CLI is the missing PRE-decrypt gate answering 'can this khy actually perform the declared crypto suite (algo+kdf) and is the crypto material complete?')」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Restore Crypto-Suite Performability Gate (consumes the DEAD snapshot header crypto.kdf field, and turns a MISLEADING error honest: sourceSnapshotCrypto.encrypt stamps crypto.algo/kdf/scrypt but decrypt (sourceSnapshotCrypto.decrypt) ONLY validates crypto.algo and NEVER validates crypto.kdf -> grep 'kdf' has exactly one reference (the encrypt stamp), zero consumers; worse, decrypt reads scrypt params as `(c.scrypt && c.scrypt.N) || SCRYPT.N` (blind fallback to hard-coded scrypt), so a FUTURE kdf='argon2' snapshot on OLD khy silently mis-derives the key via scrypt, decipher.final() throws 'unable to authenticate data', and the caller MAPS THAT TO 'wrong secret' -> a fresh-machine user is told their passphrase is wrong when the truth is 'this khy cannot perform the argon2 KDF'; this pure leaf + read-only CLI is the missing PRE-decrypt gate answering 'can this khy actually perform the declared crypto suite (algo+kdf) and is the crypto material complete?')。
  - 验证：`npm run test:one -- scripts/tests/cryptoSuiteCompat.test.js`

**310.** 验证「Restore Field Effect Probe / Jacobian Lens (turns the STATIC dead-field hunt into a DYNAMIC regression guard: prior rounds wired each snapshot-header field to a restore-family gate -- format/formatVersion(105), captureMode/includesUncommitted/dirty/gitCommit(107), plaintextFormat/layout(108), crypto.algo/crypto.kdf(110) -- but whether a field TRULY drives a gate was only ever confirmed by hand-grep, which a 'read-but-discarded' fake consumer fools; this pure leaf + read-only CLI does finite-difference perturbation: perturb each contract field, run the gate panel, measure the change in (status,ok), UNIONed over a corpus of ISOLATING contexts; a field whose Jacobian is ~0 across all contexts = behaviorally DEAD regardless of whether it is syntactically read; inspired by Anthropic 'Verbalizable Representations Form a Global Workspace in Language Models' -- averaging over contexts is what separates 'happened to be used' from 'load-bearing')」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Restore Field Effect Probe / Jacobian Lens (turns the STATIC dead-field hunt into a DYNAMIC regression guard: prior rounds wired each snapshot-header field to a restore-family gate -- format/formatVersion(105), captureMode/includesUncommitted/dirty/gitCommit(107), plaintextFormat/layout(108), crypto.algo/crypto.kdf(110) -- but whether a field TRULY drives a gate was only ever confirmed by hand-grep, which a 'read-but-discarded' fake consumer fools; this pure leaf + read-only CLI does finite-difference perturbation: perturb each contract field, run the gate panel, measure the change in (status,ok), UNIONed over a corpus of ISOLATING contexts; a field whose Jacobian is ~0 across all contexts = behaviorally DEAD regardless of whether it is syntactically read; inspired by Anthropic 'Verbalizable Representations Form a Global Workspace in Language Models' -- averaging over contexts is what separates 'happened to be used' from 'load-bearing')。
  - 验证：`npm run test:one -- scripts/tests/restoreEffectProbe.test.js`

**311.** 验证「Restore Field-Consumer Attribution Probe / Label Preservation (the orthogonal DUAL of the OPS-113 effect probe: OPS-113 is breadth-blind -- it only counts whether a snapshot-header field drives >=1 restore gate, so a refactor that MOVES crypto.algo's effect from crypto(110) onto provenance(107) keeps OPS-113 fully green while introducing real CROSS-TALK -- the git-provenance verdict now depends on the encryption algorithm = concern leakage, and an encryption field steering a non-crypto verdict is also a security smell; this pure leaf reads OPS-113's probeResult (fields[].wiredBy + fields[].hits[gate]) and checks each contract field drives EXACTLY its declared owning gate, matching the field's wiredBy OPS number against the gate-name number; inspired by Anthropic 'Verbalizable Representations Form a Global Workspace in Language Models' section 4.3.2 -- a broadcast head must pass BOTH gain (breadth, ~ OPS-113) AND label preservation (map the direction faithfully back to itself, not scrambled among other directions); this probe is that second, independent score)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Restore Field-Consumer Attribution Probe / Label Preservation (the orthogonal DUAL of the OPS-113 effect probe: OPS-113 is breadth-blind -- it only counts whether a snapshot-header field drives >=1 restore gate, so a refactor that MOVES crypto.algo's effect from crypto(110) onto provenance(107) keeps OPS-113 fully green while introducing real CROSS-TALK -- the git-provenance verdict now depends on the encryption algorithm = concern leakage, and an encryption field steering a non-crypto verdict is also a security smell; this pure leaf reads OPS-113's probeResult (fields[].wiredBy + fields[].hits[gate]) and checks each contract field drives EXACTLY its declared owning gate, matching the field's wiredBy OPS number against the gate-name number; inspired by Anthropic 'Verbalizable Representations Form a Global Workspace in Language Models' section 4.3.2 -- a broadcast head must pass BOTH gain (breadth, ~ OPS-113) AND label preservation (map the direction faithfully back to itself, not scrambled among other directions); this probe is that second, independent score)。
  - 验证：`npm run test:one -- scripts/tests/restoreFieldAttribution.test.js`

**312.** 验证「Restore Completeness Reconciliation -- RUNTIME wiring (OPS-095 diagnosed that the snapshot header fileCount is a dead field -- khy restore only PRINTS it, never reconciles it against what tar actually wrote to disk -- and built a DEV-only checker scripts/restore-verify-complete.js, but never wired it into the runtime restore command; so real fresh-machine users still saw green 源码已完整还原 while files were silently missing after a tar that exited 0 on a full disk / MAX_PATH / skipped entry; THIS layer is the missing wiring: a bundled runtime pure leaf reconciles header.fileCount vs _collectRelFiles(dest).length right after extraction and makes handleRestore's banner honest, so no separate command is needed = wiring up capability that existed but was never connected)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Restore Completeness Reconciliation -- RUNTIME wiring (OPS-095 diagnosed that the snapshot header fileCount is a dead field -- khy restore only PRINTS it, never reconciles it against what tar actually wrote to disk -- and built a DEV-only checker scripts/restore-verify-complete.js, but never wired it into the runtime restore command; so real fresh-machine users still saw green 源码已完整还原 while files were silently missing after a tar that exited 0 on a full disk / MAX_PATH / skipped entry; THIS layer is the missing wiring: a bundled runtime pure leaf reconciles header.fileCount vs _collectRelFiles(dest).length right after extraction and makes handleRestore's banner honest, so no separate command is needed = wiring up capability that existed but was never connected)。
  - 验证：`npm run test:one -- services/backend/tests/services/restoreCompletenessCheck.test.js`

**313.** 验证「Restore PRE-DECRYPT Compatibility Preflight -- RUNTIME wiring (OPS-105 format-compat + OPS-110 crypto-suite-decryptability were built as DEV-only leaves scripts/lib/snapshotFormatCompat.js + scripts/lib/cryptoSuiteCompat.js and never wired into the runtime restore; runtime _restoreFromSnapshot's only pre-decrypt guard was header.crypto presence, then it blindly decrypt()s -- and decrypt() only accepts algo==='aes-256-gcm' and ALWAYS runs scryptSync ignoring crypto.kdf, so a future kdf:'argon2' or unknown algo snapshot on an old machine derives a WRONG key / throws low-level garbage, which publish.js's catch rewrites into the MISLEADING '请用 --secret <密钥>' = reporting a capability gap as a password error; THIS layer is the missing wiring: a bundled runtime pure leaf runs a preflight over the parsed header BEFORE decrypt and names the true cause = wiring up capability that existed but was never connected)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Restore PRE-DECRYPT Compatibility Preflight -- RUNTIME wiring (OPS-105 format-compat + OPS-110 crypto-suite-decryptability were built as DEV-only leaves scripts/lib/snapshotFormatCompat.js + scripts/lib/cryptoSuiteCompat.js and never wired into the runtime restore; runtime _restoreFromSnapshot's only pre-decrypt guard was header.crypto presence, then it blindly decrypt()s -- and decrypt() only accepts algo==='aes-256-gcm' and ALWAYS runs scryptSync ignoring crypto.kdf, so a future kdf:'argon2' or unknown algo snapshot on an old machine derives a WRONG key / throws low-level garbage, which publish.js's catch rewrites into the MISLEADING '请用 --secret <密钥>' = reporting a capability gap as a password error; THIS layer is the missing wiring: a bundled runtime pure leaf runs a preflight over the parsed header BEFORE decrypt and names the true cause = wiring up capability that existed but was never connected)。
  - 验证：`npm run test:one -- services/backend/tests/services/restorePreflightCheck.test.js`

**314.** 验证「Restore POST-DECRYPT PRE-EXTRACT inner-archive-shape check -- RUNTIME wiring (the snapshot header's plaintextFormat + layout stamps -- makeSourceSnapshot.js emits plaintextFormat:'tar.gz' at :244 and layout:'git-archive' at :239 -- were DEAD FIELDS in the runtime: the dev leaf scripts/lib/archiveExtractCompat.js could judge 'does this machine's tar -xzf understand this decrypted archive' but was consumed ONLY by dev CLI (restore-check-archive.js / restore-effect-probe.js), never wired into the runtime restore; runtime _restoreFromSnapshot decrypts + sha256-verifies then hardcodes `tar -xzf` via _extractTarGz WITHOUT ever reading plaintextFormat/layout, so a future tar.zst/zip snapshot on an old khy gets blindly tar -xzf'd into garbage / half a directory while the banner still says '目录布局原样'; THIS layer is the missing pre-extract consumer: a bundled runtime pure leaf checks the header AFTER decrypt+sha256, BEFORE creating the dest dir / unpacking = wiring up capability that existed but was never connected)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Restore POST-DECRYPT PRE-EXTRACT inner-archive-shape check -- RUNTIME wiring (the snapshot header's plaintextFormat + layout stamps -- makeSourceSnapshot.js emits plaintextFormat:'tar.gz' at :244 and layout:'git-archive' at :239 -- were DEAD FIELDS in the runtime: the dev leaf scripts/lib/archiveExtractCompat.js could judge 'does this machine's tar -xzf understand this decrypted archive' but was consumed ONLY by dev CLI (restore-check-archive.js / restore-effect-probe.js), never wired into the runtime restore; runtime _restoreFromSnapshot decrypts + sha256-verifies then hardcodes `tar -xzf` via _extractTarGz WITHOUT ever reading plaintextFormat/layout, so a future tar.zst/zip snapshot on an old khy gets blindly tar -xzf'd into garbage / half a directory while the banner still says '目录布局原样'; THIS layer is the missing pre-extract consumer: a bundled runtime pure leaf checks the header AFTER decrypt+sha256, BEFORE creating the dest dir / unpacking = wiring up capability that existed but was never connected)。
  - 验证：`npm run test:one -- services/backend/tests/services/restoreArchiveExtractCheck.test.js`

**315.** 验证「Restore ON-SUCCESS provenance honesty -- RUNTIME banner wiring (the snapshot header's captureMode + includesUncommitted + dirty stamps -- makeSourceSnapshot.js records how the snapshot was captured: working-tree(default)/head, includesUncommitted, dirty, gitCommit -- were DEAD FIELDS in the runtime banner: the dev leaf scripts/lib/restoreProvenance.js (OPS-107 assessRestoreProvenance) could judge 'which git state does this restored source actually equal' but was consumed ONLY by dev CLI (restore-provenance.js / restore-effect-probe.js), never wired into the runtime restore; runtime handleRestore's success banner printed ONLY gitCommit ('共 N 个文件 · commit 44a491fb · 目录布局原样') and NEVER read captureMode/includesUncommitted/dirty -- grep finds zero runtime consumers = dead triplet; MOST TOXIC on a fresh machine: the shipped snapshot is BY DEFAULT a dirty capture (captureMode='working-tree' includesUncommitted=true), so the restored source = commit 44a491fb PLUS uncommitted deltas, NOT the clean commit -- yet the maintainer sees 'commit 44a491fb · 目录布局原样' and mis-trusts it as exactly that commit; THIS layer is the missing on-success banner consumer: a bundled runtime pure leaf assesses the header and appends one honest banner line saying which git state the source really equals)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Restore ON-SUCCESS provenance honesty -- RUNTIME banner wiring (the snapshot header's captureMode + includesUncommitted + dirty stamps -- makeSourceSnapshot.js records how the snapshot was captured: working-tree(default)/head, includesUncommitted, dirty, gitCommit -- were DEAD FIELDS in the runtime banner: the dev leaf scripts/lib/restoreProvenance.js (OPS-107 assessRestoreProvenance) could judge 'which git state does this restored source actually equal' but was consumed ONLY by dev CLI (restore-provenance.js / restore-effect-probe.js), never wired into the runtime restore; runtime handleRestore's success banner printed ONLY gitCommit ('共 N 个文件 · commit 44a491fb · 目录布局原样') and NEVER read captureMode/includesUncommitted/dirty -- grep finds zero runtime consumers = dead triplet; MOST TOXIC on a fresh machine: the shipped snapshot is BY DEFAULT a dirty capture (captureMode='working-tree' includesUncommitted=true), so the restored source = commit 44a491fb PLUS uncommitted deltas, NOT the clean commit -- yet the maintainer sees 'commit 44a491fb · 目录布局原样' and mis-trusts it as exactly that commit; THIS layer is the missing on-success banner consumer: a bundled runtime pure leaf assesses the header and appends one honest banner line saying which git state the source really equals)。
  - 验证：`npm run test:one -- services/backend/tests/services/restoreProvenanceCheck.test.js`

**316.** 验证「Restore POST-DECRYPT PRE-EXTRACT cross-OS path-portability pre-scan -- RUNTIME wiring (the snapshot is PATH-BLIND at restore: makeSourceSnapshot packs the source tree into one tar.gz whose entry names were minted on Linux, then pip/npm ship it to STRANGER machines AND OSes; runtime handleRestore decrypts + blindly `tar -xzf`s WITHOUT ever looking at whether the entry names can land on the target filesystem -- on Windows/macOS a real fraction of Linux-valid names SILENTLY fail or get rewritten: Windows reserved device names (CON/PRN/AUX/NUL/COM1-9/LPT1-9, case+ext insensitive) can't be created, illegal chars (< > : " | ? * and control 0x00-0x1F) fail extraction, trailing dot/space segments get silently stripped, paths over 259 chars (MAX_PATH) get skipped, and case-insensitive collisions (Foo.js vs foo.js) overwrite each other on NTFS/APFS default volumes -- so files land FEWER than the archive holds; the ONLY cross-OS signal today is the reactive post-hoc completeness hint ('可能路径过长(Windows MAX_PATH) / tar 跳过条目…') AFTER a count shortfall = a guess that knows neither WHICH paths nor WHY; THIS layer is the missing pre-extract consumer: enumerate the archive entry names with `tar -tzf` BEFORE `tar -xzf`, classify each into the five hazard buckets, and emit a PROACTIVE, name-naming, host-aware honest banner = wiring up a cross-OS restore-honesty pre-scan the runtime never had)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Restore POST-DECRYPT PRE-EXTRACT cross-OS path-portability pre-scan -- RUNTIME wiring (the snapshot is PATH-BLIND at restore: makeSourceSnapshot packs the source tree into one tar.gz whose entry names were minted on Linux, then pip/npm ship it to STRANGER machines AND OSes; runtime handleRestore decrypts + blindly `tar -xzf`s WITHOUT ever looking at whether the entry names can land on the target filesystem -- on Windows/macOS a real fraction of Linux-valid names SILENTLY fail or get rewritten: Windows reserved device names (CON/PRN/AUX/NUL/COM1-9/LPT1-9, case+ext insensitive) can't be created, illegal chars (< > : " | ? * and control 0x00-0x1F) fail extraction, trailing dot/space segments get silently stripped, paths over 259 chars (MAX_PATH) get skipped, and case-insensitive collisions (Foo.js vs foo.js) overwrite each other on NTFS/APFS default volumes -- so files land FEWER than the archive holds; the ONLY cross-OS signal today is the reactive post-hoc completeness hint ('可能路径过长(Windows MAX_PATH) / tar 跳过条目…') AFTER a count shortfall = a guess that knows neither WHICH paths nor WHY; THIS layer is the missing pre-extract consumer: enumerate the archive entry names with `tar -tzf` BEFORE `tar -xzf`, classify each into the five hazard buckets, and emit a PROACTIVE, name-naming, host-aware honest banner = wiring up a cross-OS restore-honesty pre-scan the runtime never had)。
  - 验证：`npm run test:one -- services/backend/tests/services/restorePathPortabilityCheck.test.js`

**317.** 验证「First-response silent-window guard -- WIRING an interactive responsiveness capability the REPL never had (user /goal: '当我向Khy输入提示词时，khy要及时回应' -- there is a SILENT window between the user hitting enter and the first model chunk: in raw-mode TTY the dynamic spinner is render-suppressed (spinner.js:122 `if (isRaw && blockInRawMode) return`) so nothing spins/types, and the existing turnAckVoice ack only fires at FIRST-TOOL-DISPATCH which is AFTER the model has already produced chunks -- so if the first token is slow (model/network latency), the user stares at a frozen terminal with no way to tell whether khy is thinking or hung; THIS layer is the missing consumer: a DI-timer scheduler armed at request send that, if NO chunk arrives within KHY_FIRST_RESPONSE_ACK_MS (default 1200ms), emits a wait-aware line so the user knows khy received the prompt and is working -- first chunk cancels it, finally disarms it)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：First-response silent-window guard -- WIRING an interactive responsiveness capability the REPL never had (user /goal: '当我向Khy输入提示词时，khy要及时回应' -- there is a SILENT window between the user hitting enter and the first model chunk: in raw-mode TTY the dynamic spinner is render-suppressed (spinner.js:122 `if (isRaw && blockInRawMode) return`) so nothing spins/types, and the existing turnAckVoice ack only fires at FIRST-TOOL-DISPATCH which is AFTER the model has already produced chunks -- so if the first token is slow (model/network latency), the user stares at a frozen terminal with no way to tell whether khy is thinking or hung; THIS layer is the missing consumer: a DI-timer scheduler armed at request send that, if NO chunk arrives within KHY_FIRST_RESPONSE_ACK_MS (default 1200ms), emits a wait-aware line so the user knows khy received the prompt and is working -- first chunk cancels it, finally disarms it)。
  - 验证：`npm run test:one -- services/backend/tests/cli/firstResponseAckVoice.test.js`

**318.** 验证「readFile PRE-READ binary guard -- WIRING an existing capability (services/backend/src/services/formatInspect/fileFormatDetector.js's detectFile(absPath).isBinary was consumed by the WRITE-side tools replaceAtLocation.js:79 and inspectDocument.js:161 but was NEVER wired into the READ tool readFile.js, which only had a size guard and no binary detection; so pointing khy at a project dir containing a binary .tar.gz made readFile inject the raw binary bytes as text -- mojibake laced with NUL bytes, success:true -- into the model API request, poisoning it and hanging the request for over an hour (observed: D:\moonbit-linux\moonbit-linux-x86_64.tar.gz stuck 1h2m34s '等待响应…'); THIS is the missing wiring: run detectFile BEFORE reading and refuse binary files fast with an informative redirect instead of poisoning the context)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：readFile PRE-READ binary guard -- WIRING an existing capability (services/backend/src/services/formatInspect/fileFormatDetector.js's detectFile(absPath).isBinary was consumed by the WRITE-side tools replaceAtLocation.js:79 and inspectDocument.js:161 but was NEVER wired into the READ tool readFile.js, which only had a size guard and no binary detection; so pointing khy at a project dir containing a binary .tar.gz made readFile inject the raw binary bytes as text -- mojibake laced with NUL bytes, success:true -- into the model API request, poisoning it and hanging the request for over an hour (observed: D:\moonbit-linux\moonbit-linux-x86_64.tar.gz stuck 1h2m34s '等待响应…'); THIS is the missing wiring: run detectFile BEFORE reading and refuse binary files fast with an informative redirect instead of poisoning the context)。
  - 验证：`npm run test:one -- services/backend/tests/tools/readBinaryGuard.test.js`

**319.** 验证「readFile FORMAT-AWARE routing to existing extractors -- WIRING existing capabilities (OPS-121 made readFile REFUSE binary files to stop the 1h hang, but the user's real requirement is that khy should READ every format, not refuse it; the repo already had bounded extractors for PDF (documentSnippetService.extractDocumentSnippetAsync: pdftotext->pypdf->strings), image OCR (ocrSnippetService.extractImageOcrSnippetAsync: docHelper.py tesseract), archives (archiveInspectService.inspectArchive list-only-no-extract + archiveManifestPolicy.buildArchiveManifest for listing+text-peek), and docx (docHelper.py docx_to_text) -- all consumed only by the multimodal/upload/UpstreamStudy paths, NEVER by the read tool; THIS layer wires them: on binary detect, readFile first routes to the matching extractor and returns readable content, falling back to the OPS-121 refusal only for formats with no extractor (ELF/PE/xlsx/pptx/unknown) or when extraction fails; because every extractor is self-bounded (timeout+size cap) the routing can never hang)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：readFile FORMAT-AWARE routing to existing extractors -- WIRING existing capabilities (OPS-121 made readFile REFUSE binary files to stop the 1h hang, but the user's real requirement is that khy should READ every format, not refuse it; the repo already had bounded extractors for PDF (documentSnippetService.extractDocumentSnippetAsync: pdftotext->pypdf->strings), image OCR (ocrSnippetService.extractImageOcrSnippetAsync: docHelper.py tesseract), archives (archiveInspectService.inspectArchive list-only-no-extract + archiveManifestPolicy.buildArchiveManifest for listing+text-peek), and docx (docHelper.py docx_to_text) -- all consumed only by the multimodal/upload/UpstreamStudy paths, NEVER by the read tool; THIS layer wires them: on binary detect, readFile first routes to the matching extractor and returns readable content, falling back to the OPS-121 refusal only for formats with no extractor (ELF/PE/xlsx/pptx/unknown) or when extraction fails; because every extractor is self-bounded (timeout+size cap) the routing can never hang)。
  - 验证：`npm run test:one -- services/backend/tests/tools/readFileFormatRouter.test.js`

**320.** 验证「readFile special-file (FIFO/socket/char-or-block-device) pre-read guard -- WIRING a type-based block against permanent hangs (OPS-121/OPS-123 covered binary content and format routing, but non-regular files still slipped through EVERY guard: a FIFO/socket/device has size:0 and is not a binary format, so it passes the size check and is not caught by the binary guard; worse, detectFile() reads magic bytes and readTextFileSmart opens+reads it, and reading the first byte of a FIFO with no writer BLOCKS FOREVER -- detectFile itself hangs; reproduced: mkfifo then readFile.execute did not return after a 6s timeout (EXIT=124); wired: same FIFO returns in 4ms with success:false; inputValidators.validateNotDevicePath is only a path-exact denylist (/dev/zero,/dev/stdin...) and cannot catch a FIFO/socket/self-made device node at an arbitrary path -- THIS layer blocks by fs.statSync TYPE predicate, which returns metadata instantly and never blocks on a FIFO/device (measured 0ms), so the check is safe BEFORE any blocking open/read)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：readFile special-file (FIFO/socket/char-or-block-device) pre-read guard -- WIRING a type-based block against permanent hangs (OPS-121/OPS-123 covered binary content and format routing, but non-regular files still slipped through EVERY guard: a FIFO/socket/device has size:0 and is not a binary format, so it passes the size check and is not caught by the binary guard; worse, detectFile() reads magic bytes and readTextFileSmart opens+reads it, and reading the first byte of a FIFO with no writer BLOCKS FOREVER -- detectFile itself hangs; reproduced: mkfifo then readFile.execute did not return after a 6s timeout (EXIT=124); wired: same FIFO returns in 4ms with success:false; inputValidators.validateNotDevicePath is only a path-exact denylist (/dev/zero,/dev/stdin...) and cannot catch a FIFO/socket/self-made device node at an arbitrary path -- THIS layer blocks by fs.statSync TYPE predicate, which returns metadata instantly and never blocks on a FIFO/device (measured 0ms), so the check is safe BEFORE any blocking open/read)。
  - 验证：`npm run test:one -- services/backend/tests/tools/specialFileReadGuard.test.js`

**321.** 验证「readFile pseudo-filesystem (/proc·/sys) bounded-timeout read -- WIRING a location-based no-hang guard, the 4th orthogonal reading-hang vector (OPS-121 binary-content, OPS-123 format-routing, OPS-125 file-type FIFO/socket/device; THIS keys off file LOCATION). Linux /proc·/sys entries are REGULAR files (stat.isFile()===true), size:0, content generated-on-read; some (/proc/kmsg, certain /sys poll attrs) BLOCK FOREVER on the first byte. They slip EVERY prior guard: regular file -> passes OPS-125 type predicates (isFIFO/isSocket/... all false); size:0 -> passes the oversize check (0>maxBytes false); mostly non-binary -> detectFile() reads magic bytes and HANGS right there. Measured: /proc/cpuinfo is a size:0 regular file with all four special predicates false. Per the OPS-123 lesson (route to a bounded reader, don't blanket-refuse): most /proc·/sys files are FINITE (cpuinfo/uptime/self-status read instantly), only a few block -- so this layer does a BOUNDED read, not a refuse. Key architecture point (OPS-125 blood lesson extended): a SYNC blocking read cannot be timed out in-process (readTextFileSmart locks the event loop so Promise.race/setTimeout never fire); the ONLY sync-safe fix is to move the blocking read into a CHILD process (head -c <maxBytes> <path>) that spawnSync's timeout option can KILL. Finite pseudo-file -> head exits 0 -> content returned; blocking pseudo-file -> head killed at timeout -> bounded return, never an infinite hang. LIVE-verified: real /proc/cpuinfo via readFile.execute -> success:true format=pseudo-fs-proc 33ms; a real no-writer FIFO via real spawnSync timeout=1500 -> killed at 1502ms timedOut:true (not a hang)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：readFile pseudo-filesystem (/proc·/sys) bounded-timeout read -- WIRING a location-based no-hang guard, the 4th orthogonal reading-hang vector (OPS-121 binary-content, OPS-123 format-routing, OPS-125 file-type FIFO/socket/device; THIS keys off file LOCATION). Linux /proc·/sys entries are REGULAR files (stat.isFile()===true), size:0, content generated-on-read; some (/proc/kmsg, certain /sys poll attrs) BLOCK FOREVER on the first byte. They slip EVERY prior guard: regular file -> passes OPS-125 type predicates (isFIFO/isSocket/... all false); size:0 -> passes the oversize check (0>maxBytes false); mostly non-binary -> detectFile() reads magic bytes and HANGS right there. Measured: /proc/cpuinfo is a size:0 regular file with all four special predicates false. Per the OPS-123 lesson (route to a bounded reader, don't blanket-refuse): most /proc·/sys files are FINITE (cpuinfo/uptime/self-status read instantly), only a few block -- so this layer does a BOUNDED read, not a refuse. Key architecture point (OPS-125 blood lesson extended): a SYNC blocking read cannot be timed out in-process (readTextFileSmart locks the event loop so Promise.race/setTimeout never fire); the ONLY sync-safe fix is to move the blocking read into a CHILD process (head -c <maxBytes> <path>) that spawnSync's timeout option can KILL. Finite pseudo-file -> head exits 0 -> content returned; blocking pseudo-file -> head killed at timeout -> bounded return, never an infinite hang. LIVE-verified: real /proc/cpuinfo via readFile.execute -> success:true format=pseudo-fs-proc 33ms; a real no-writer FIFO via real spawnSync timeout=1500 -> killed at 1502ms timedOut:true (not a hang)。
  - 验证：`npm run test:one -- services/backend/tests/tools/pseudoFileReadGuard.test.js`

**322.** 验证「Shared pre-read hang guard for secondary file-reading tools (inspectDocument/replaceAtLocation) -- WIRING the anti-hang read-guard family onto the OTHER model-facing tools that touch bytes. OPS-121/123/125/129 hardened readFile.js and OPS-146 brought FileReadTool to parity, but inspectDocument.js (aliases read_format/inspect_format) and replaceAtLocation.js (replace_at) ALSO read files and had ZERO anti-hang guards: both call detectFile(absPath) right after existsSync (detectFile reads magic bytes -> HANGS FOREVER on a FIFO/blocking-pseudo), and both then readFileSync(...,'utf-8') which blocks too. A single composed pure leaf classifyPreReadHang({absPath,stat,env}) unifies the three infinite-hang vectors (Windows reserved device name path-check + FIFO/socket/device stat-type-check + Linux /proc·/sys blocking-pseudo detect) so every 'refuse-only' read tool closes the whole class with one call before touching bytes. LIVE-verified: FIFO/proc through inspectDocument.execute + replaceAtLocation.execute return in 0-3ms with success:false (previously infinite hang)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Shared pre-read hang guard for secondary file-reading tools (inspectDocument/replaceAtLocation) -- WIRING the anti-hang read-guard family onto the OTHER model-facing tools that touch bytes. OPS-121/123/125/129 hardened readFile.js and OPS-146 brought FileReadTool to parity, but inspectDocument.js (aliases read_format/inspect_format) and replaceAtLocation.js (replace_at) ALSO read files and had ZERO anti-hang guards: both call detectFile(absPath) right after existsSync (detectFile reads magic bytes -> HANGS FOREVER on a FIFO/blocking-pseudo), and both then readFileSync(...,'utf-8') which blocks too. A single composed pure leaf classifyPreReadHang({absPath,stat,env}) unifies the three infinite-hang vectors (Windows reserved device name path-check + FIFO/socket/device stat-type-check + Linux /proc·/sys blocking-pseudo detect) so every 'refuse-only' read tool closes the whole class with one call before touching bytes. LIVE-verified: FIFO/proc through inspectDocument.execute + replaceAtLocation.execute return in 0-3ms with success:false (previously infinite hang)。
  - 验证：`node --test services/backend/tests/tools/filePreReadHangGuard.test.js`

**323.** 验证「Multi-Model-Type Provider Config Reconciler (the four user-facing model TYPES each resolve a provider through DISCONNECTED env namespaces: text via apiKeyPool/providerPresets/gateway, video via KHY_VIDEO_GEN_* outside the registry, vector via EMBED_URL/ollama/gateway embeddings, role via subAgentModelSelect reusing the text pool; the capability taxonomy names these buckets but NOTHING reconciles per-type whether a user supplied a working API and whether it is a relay(中转站)/direct(直连)/local endpoint; this pure leaf + read-only CLI answers "which types are ready and how is each wired" for a fresh-machine user configuring different APIs per type)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Multi-Model-Type Provider Config Reconciler (the four user-facing model TYPES each resolve a provider through DISCONNECTED env namespaces: text via apiKeyPool/providerPresets/gateway, video via KHY_VIDEO_GEN_* outside the registry, vector via EMBED_URL/ollama/gateway embeddings, role via subAgentModelSelect reusing the text pool; the capability taxonomy names these buckets but NOTHING reconciles per-type whether a user supplied a working API and whether it is a relay(中转站)/direct(直连)/local endpoint; this pure leaf + read-only CLI answers "which types are ready and how is each wired" for a fresh-machine user configuring different APIs per type)。
  - 验证：`npm run test:one -- scripts/tests/modelTypeProviderPlan.test.js`

**324.** 验证「卡住任务的强制结束会话逃生舱(REPL busy 分支 Ctrl+C/Esc 三次升级结束会话)。事件循环仍活(转圈动画在转=setInterval 在跑=JS 处理器仍执行)但优雅取消没落地时,busy 分支的 Ctrl+C(replSession SIGINT 处理)与 Esc(busy 输入分支)原本恒做优雅取消+return、永不升级,导致 wedged 回合按几次都杀不掉。此纯叶把「同窗口内累计第 3 次 busy 中断→强制结束会话」的判定逻辑抽出(零 IO、绝不抛),replSession 在优雅取消前先问它是否该 force-exit(exit 130),前两次先走优雅取消打断卡住的任务,第 3 次才强制结束会话;无论底层 adapter 是否兑现 abort 信号,只要事件循环还活着就能杀掉卡住的回合」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：卡住任务的强制结束会话逃生舱(REPL busy 分支 Ctrl+C/Esc 三次升级结束会话)。事件循环仍活(转圈动画在转=setInterval 在跑=JS 处理器仍执行)但优雅取消没落地时,busy 分支的 Ctrl+C(replSession SIGINT 处理)与 Esc(busy 输入分支)原本恒做优雅取消+return、永不升级,导致 wedged 回合按几次都杀不掉。此纯叶把「同窗口内累计第 3 次 busy 中断→强制结束会话」的判定逻辑抽出(零 IO、绝不抛),replSession 在优雅取消前先问它是否该 force-exit(exit 130),前两次先走优雅取消打断卡住的任务,第 3 次才强制结束会话;无论底层 adapter 是否兑现 abort 信号,只要事件循环还活着就能杀掉卡住的回合。
  - 验证：`npm run test:one -- services/backend/tests/services/cli/repl/busyInterruptEscalation.test.js`

**325.** 验证「把 claude/codex/opencode 做成装进 khy 数据家(~/.khy/tools)、开箱即用且可更新的便携 CLI(纯叶解析 package.json bin 字段→用当前 node 直接跑 JS 入口,绕开 Windows .cmd/.ps1 shim 与 PATH 依赖=根治 spawn ENOENT)。claude(@anthropic-ai/claude-code)与 codex(@openai/codex)npm 包发布的是带 node shebang 的 JS 入口,直接 spawn 裸名依赖系统 PATH→用户没全局装→恒 ENOENT。本子系统读已安装包 package.json 的 bin→定位真实 JS 入口→返回 {command:process.execPath,argsPrefix:[entryAbs]},跨平台一致不碰 PATH/.cmd;原生二进制入口(shebang 嗅探)回退直接执行。opencode 保留其既有专用解析器 opencodeBinResolver,泛化解析器对它返回 null;并为 opencode 补数据家候选让 khy tools install opencode 也能被解析。khy claude/codex 启动前若不可用→交互确认「是否现在安装便携版?[Y/n]」→点头即装、装完 detect(true) 复检直接继续本次启动」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：把 claude/codex/opencode 做成装进 khy 数据家(~/.khy/tools)、开箱即用且可更新的便携 CLI(纯叶解析 package.json bin 字段→用当前 node 直接跑 JS 入口,绕开 Windows .cmd/.ps1 shim 与 PATH 依赖=根治 spawn ENOENT)。claude(@anthropic-ai/claude-code)与 codex(@openai/codex)npm 包发布的是带 node shebang 的 JS 入口,直接 spawn 裸名依赖系统 PATH→用户没全局装→恒 ENOENT。本子系统读已安装包 package.json 的 bin→定位真实 JS 入口→返回 {command:process.execPath,argsPrefix:[entryAbs]},跨平台一致不碰 PATH/.cmd;原生二进制入口(shebang 嗅探)回退直接执行。opencode 保留其既有专用解析器 opencodeBinResolver,泛化解析器对它返回 null;并为 opencode 补数据家候选让 khy tools install opencode 也能被解析。khy claude/codex 启动前若不可用→交互确认「是否现在安装便携版?[Y/n]」→点头即装、装完 detect(true) 复检直接继续本次启动。
  - 验证：`npm run test:one -- services/backend/tests/services/gateway/adapters/portableCli.test.js`

**326.** 验证「写记忆/召回记忆时明确告知用户(记忆操作可见化纯叶)。khy 早已自动写记忆(_maybeAutoSaveMemory)与自动召回记忆(memory engine surface + [RELEVANT_MEMORY] 注入),但两条路径都静默执行——用户看不到「刚记住了什么」或「这轮召回了哪些记忆」。本子系统抽纯叶 memoryOpsNotice.js 把这两个已有动作渲染成用户可见的状态提示,经既有 onStatus 状态通道推出:写入成功→🧠 已写入<类型>记忆(已落盘/本会话):<name>,召回命名记忆→🧠 召回 N 条相关记忆:a、b、c 等 N 条。零 IO、绝不抛、门控 default-on。直接回应 /goal 需求「写记忆和回忆时明确告知用户」」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：写记忆/召回记忆时明确告知用户(记忆操作可见化纯叶)。khy 早已自动写记忆(_maybeAutoSaveMemory)与自动召回记忆(memory engine surface + [RELEVANT_MEMORY] 注入),但两条路径都静默执行——用户看不到「刚记住了什么」或「这轮召回了哪些记忆」。本子系统抽纯叶 memoryOpsNotice.js 把这两个已有动作渲染成用户可见的状态提示,经既有 onStatus 状态通道推出:写入成功→🧠 已写入<类型>记忆(已落盘/本会话):<name>,召回命名记忆→🧠 召回 N 条相关记忆:a、b、c 等 N 条。零 IO、绝不抛、门控 default-on。直接回应 /goal 需求「写记忆和回忆时明确告知用户」。
  - 验证：`npm run test:one -- services/backend/tests/services/memoryOpsNotice.test.js`

**327.** 验证「Text-only-model Image OCR Fallback + Honest Confidence Caveat (when the running model is text-only/non-multimodal and NO vision model is reachable, khy must strip the raw image and inject locally-extracted OCR text as the answer basis; this area also closes the DEAD-FIELD gap where tesseract's per-word confidence/needsAiFallback was computed but dropped at every JS layer, so low-confidence OCR was injected as authoritative '请据此作答' with no warning — the sibling RecognizeImage tool path already honored needsAiFallback; the gateway did not)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Text-only-model Image OCR Fallback + Honest Confidence Caveat (when the running model is text-only/non-multimodal and NO vision model is reachable, khy must strip the raw image and inject locally-extracted OCR text as the answer basis; this area also closes the DEAD-FIELD gap where tesseract's per-word confidence/needsAiFallback was computed but dropped at every JS layer, so low-confidence OCR was injected as authoritative '请据此作答' with no warning — the sibling RecognizeImage tool path already honored needsAiFallback; the gateway did not)。
  - 验证：`npm run test:one -- services/backend/tests/gateway/ocrConfidenceCaveat.test.js services/backend/tests/gateway/imageOcrFallbackWiring.test.js services/backend/tests/gateway/imageOcrFallbackRealImage.test.js`

**328.** 验证「Text-only-model Image OCR Fallback + Honest Confidence Caveat (when the running model is text-only/non-multimodal and NO vision model is reachable, khy must strip the raw image and inject locally-extracted OCR text as the answer basis; this area also closes the DEAD-FIELD gap where tesseract's per-word confidence/needsAiFallback was computed but dropped at every JS layer, so low-confidence OCR was injected as authoritative '请据此作答' with no warning — the sibling RecognizeImage tool path already honored needsAiFallback; the gateway did not)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Text-only-model Image OCR Fallback + Honest Confidence Caveat (when the running model is text-only/non-multimodal and NO vision model is reachable, khy must strip the raw image and inject locally-extracted OCR text as the answer basis; this area also closes the DEAD-FIELD gap where tesseract's per-word confidence/needsAiFallback was computed but dropped at every JS layer, so low-confidence OCR was injected as authoritative '请据此作答' with no warning — the sibling RecognizeImage tool path already honored needsAiFallback; the gateway did not)。
  - 验证：`node --test services/backend/tests/gateway/imageOcrFallbackRealImage.test.js`

**329.** 验证「Text-only-model Image OCR Fallback + Honest Confidence Caveat (when the running model is text-only/non-multimodal and NO vision model is reachable, khy must strip the raw image and inject locally-extracted OCR text as the answer basis; this area also closes the DEAD-FIELD gap where tesseract's per-word confidence/needsAiFallback was computed but dropped at every JS layer, so low-confidence OCR was injected as authoritative '请据此作答' with no warning — the sibling RecognizeImage tool path already honored needsAiFallback; the gateway did not)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Text-only-model Image OCR Fallback + Honest Confidence Caveat (when the running model is text-only/non-multimodal and NO vision model is reachable, khy must strip the raw image and inject locally-extracted OCR text as the answer basis; this area also closes the DEAD-FIELD gap where tesseract's per-word confidence/needsAiFallback was computed but dropped at every JS layer, so low-confidence OCR was injected as authoritative '请据此作答' with no warning — the sibling RecognizeImage tool path already honored needsAiFallback; the gateway did not)。
  - 验证：`python3 -m unittest tests.unit.test_dochelper_ocr_confidence`

**330.** 验证「Text-only-model Image OCR Fallback — Honest COVERAGE Caveat (orthogonal to ocr-fallback-confidence: confidence is about ACCURACY of the recognized words; coverage is about COMPLETENESS — whether the injected OCR text actually covers ALL input images; closes the MISSING-DIMENSION gap where extractImageOcrDetails does images.slice(0,maxImages) and silently drops images beyond the cap, and where some attempted images produce no text — so a text-only model is told '请据此作答' as if it saw everything when N-3 images and unreadable images vanished with zero trace: the textbook 'silent truncation reads as covered everything' anti-pattern)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Text-only-model Image OCR Fallback — Honest COVERAGE Caveat (orthogonal to ocr-fallback-confidence: confidence is about ACCURACY of the recognized words; coverage is about COMPLETENESS — whether the injected OCR text actually covers ALL input images; closes the MISSING-DIMENSION gap where extractImageOcrDetails does images.slice(0,maxImages) and silently drops images beyond the cap, and where some attempted images produce no text — so a text-only model is told '请据此作答' as if it saw everything when N-3 images and unreadable images vanished with zero trace: the textbook 'silent truncation reads as covered everything' anti-pattern)。
  - 验证：`npm run test:one -- services/backend/tests/gateway/ocrCoverageNotice.test.js services/backend/tests/gateway/imageOcrCoverageWiring.test.js`

**331.** 验证「Text-only-model Image OCR Fallback — Honest COVERAGE Caveat (orthogonal to ocr-fallback-confidence: confidence is about ACCURACY of the recognized words; coverage is about COMPLETENESS — whether the injected OCR text actually covers ALL input images; closes the MISSING-DIMENSION gap where extractImageOcrDetails does images.slice(0,maxImages) and silently drops images beyond the cap, and where some attempted images produce no text — so a text-only model is told '请据此作答' as if it saw everything when N-3 images and unreadable images vanished with zero trace: the textbook 'silent truncation reads as covered everything' anti-pattern)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Text-only-model Image OCR Fallback — Honest COVERAGE Caveat (orthogonal to ocr-fallback-confidence: confidence is about ACCURACY of the recognized words; coverage is about COMPLETENESS — whether the injected OCR text actually covers ALL input images; closes the MISSING-DIMENSION gap where extractImageOcrDetails does images.slice(0,maxImages) and silently drops images beyond the cap, and where some attempted images produce no text — so a text-only model is told '请据此作答' as if it saw everything when N-3 images and unreadable images vanished with zero trace: the textbook 'silent truncation reads as covered everything' anti-pattern)。
  - 验证：`node --check services/backend/src/services/gateway/ocrCoverageNotice.js`

**332.** 验证「Text-only-model Image OCR Fallback — Honest COVERAGE Caveat (orthogonal to ocr-fallback-confidence: confidence is about ACCURACY of the recognized words; coverage is about COMPLETENESS — whether the injected OCR text actually covers ALL input images; closes the MISSING-DIMENSION gap where extractImageOcrDetails does images.slice(0,maxImages) and silently drops images beyond the cap, and where some attempted images produce no text — so a text-only model is told '请据此作答' as if it saw everything when N-3 images and unreadable images vanished with zero trace: the textbook 'silent truncation reads as covered everything' anti-pattern)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Text-only-model Image OCR Fallback — Honest COVERAGE Caveat (orthogonal to ocr-fallback-confidence: confidence is about ACCURACY of the recognized words; coverage is about COMPLETENESS — whether the injected OCR text actually covers ALL input images; closes the MISSING-DIMENSION gap where extractImageOcrDetails does images.slice(0,maxImages) and silently drops images beyond the cap, and where some attempted images produce no text — so a text-only model is told '请据此作答' as if it saw everything when N-3 images and unreadable images vanished with zero trace: the textbook 'silent truncation reads as covered everything' anti-pattern)。
  - 验证：`node --check services/backend/src/services/gateway/aiGatewayGenerateMethod.js`

**333.** 验证「Text-only-model Image OCR Fallback — Honest TRUNCATION Caveat (third orthogonal honesty axis: confidence=ACCURACY of recognized words; coverage=COMPLETENESS across images; truncation=COMPLETENESS WITHIN a single image — whether a dense image's OCR full text was cut at maxChars(1200) with only a weak in-band English '...[truncated]' sentinel; closes the DEAD-FIELD gap where ocrSnippetService's _truncate silently clipped the tail and the truncated boolean never left the service, so a text-only model is told '请据此作答' on a partial text believing it complete)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Text-only-model Image OCR Fallback — Honest TRUNCATION Caveat (third orthogonal honesty axis: confidence=ACCURACY of recognized words; coverage=COMPLETENESS across images; truncation=COMPLETENESS WITHIN a single image — whether a dense image's OCR full text was cut at maxChars(1200) with only a weak in-band English '...[truncated]' sentinel; closes the DEAD-FIELD gap where ocrSnippetService's _truncate silently clipped the tail and the truncated boolean never left the service, so a text-only model is told '请据此作答' on a partial text believing it complete)。
  - 验证：`npm run test:one -- services/backend/tests/gateway/ocrTruncationNotice.test.js services/backend/tests/gateway/imageOcrTruncationWiring.test.js`

**334.** 验证「Text-only-model Image OCR Fallback — Honest TRUNCATION Caveat (third orthogonal honesty axis: confidence=ACCURACY of recognized words; coverage=COMPLETENESS across images; truncation=COMPLETENESS WITHIN a single image — whether a dense image's OCR full text was cut at maxChars(1200) with only a weak in-band English '...[truncated]' sentinel; closes the DEAD-FIELD gap where ocrSnippetService's _truncate silently clipped the tail and the truncated boolean never left the service, so a text-only model is told '请据此作答' on a partial text believing it complete)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Text-only-model Image OCR Fallback — Honest TRUNCATION Caveat (third orthogonal honesty axis: confidence=ACCURACY of recognized words; coverage=COMPLETENESS across images; truncation=COMPLETENESS WITHIN a single image — whether a dense image's OCR full text was cut at maxChars(1200) with only a weak in-band English '...[truncated]' sentinel; closes the DEAD-FIELD gap where ocrSnippetService's _truncate silently clipped the tail and the truncated boolean never left the service, so a text-only model is told '请据此作答' on a partial text believing it complete)。
  - 验证：`node --check services/backend/src/services/gateway/ocrTruncationNotice.js`

**335.** 验证「Text-only-model Image OCR Fallback — Honest TRUNCATION Caveat (third orthogonal honesty axis: confidence=ACCURACY of recognized words; coverage=COMPLETENESS across images; truncation=COMPLETENESS WITHIN a single image — whether a dense image's OCR full text was cut at maxChars(1200) with only a weak in-band English '...[truncated]' sentinel; closes the DEAD-FIELD gap where ocrSnippetService's _truncate silently clipped the tail and the truncated boolean never left the service, so a text-only model is told '请据此作答' on a partial text believing it complete)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Text-only-model Image OCR Fallback — Honest TRUNCATION Caveat (third orthogonal honesty axis: confidence=ACCURACY of recognized words; coverage=COMPLETENESS across images; truncation=COMPLETENESS WITHIN a single image — whether a dense image's OCR full text was cut at maxChars(1200) with only a weak in-band English '...[truncated]' sentinel; closes the DEAD-FIELD gap where ocrSnippetService's _truncate silently clipped the tail and the truncated boolean never left the service, so a text-only model is told '请据此作答' on a partial text believing it complete)。
  - 验证：`node --check services/backend/src/services/ocrSnippetService.js`

**336.** 验证「Text-only-model Image OCR Fallback — Honest LANGUAGE-PACK Caveat (fourth orthogonal honesty axis, most directly serving '准确识别图片': confidence=ACCURACY of words; coverage=COMPLETENESS across images; truncation=COMPLETENESS within one image; language=whether the REQUESTED OCR languages could actually run — docHelper.py._resolve_lang silently narrows a 'chi_sim+eng' request to the subset that has traineddata installed, so text in a missing-language image is un-recognized/mis-transliterated while the model is told '请据此作答'; closes the DEAD-FIELD gap where the JSON returned only the narrowed lang and never the original request, so the drop was invisible)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Text-only-model Image OCR Fallback — Honest LANGUAGE-PACK Caveat (fourth orthogonal honesty axis, most directly serving '准确识别图片': confidence=ACCURACY of words; coverage=COMPLETENESS across images; truncation=COMPLETENESS within one image; language=whether the REQUESTED OCR languages could actually run — docHelper.py._resolve_lang silently narrows a 'chi_sim+eng' request to the subset that has traineddata installed, so text in a missing-language image is un-recognized/mis-transliterated while the model is told '请据此作答'; closes the DEAD-FIELD gap where the JSON returned only the narrowed lang and never the original request, so the drop was invisible)。
  - 验证：`npm run test:one -- services/backend/tests/gateway/ocrLanguageNotice.test.js services/backend/tests/gateway/imageOcrLanguageWiring.test.js services/backend/tests/gateway/ocrLanguageNarrowing.test.js`

**337.** 验证「Text-only-model Image OCR Fallback — Honest LANGUAGE-PACK Caveat (fourth orthogonal honesty axis, most directly serving '准确识别图片': confidence=ACCURACY of words; coverage=COMPLETENESS across images; truncation=COMPLETENESS within one image; language=whether the REQUESTED OCR languages could actually run — docHelper.py._resolve_lang silently narrows a 'chi_sim+eng' request to the subset that has traineddata installed, so text in a missing-language image is un-recognized/mis-transliterated while the model is told '请据此作答'; closes the DEAD-FIELD gap where the JSON returned only the narrowed lang and never the original request, so the drop was invisible)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Text-only-model Image OCR Fallback — Honest LANGUAGE-PACK Caveat (fourth orthogonal honesty axis, most directly serving '准确识别图片': confidence=ACCURACY of words; coverage=COMPLETENESS across images; truncation=COMPLETENESS within one image; language=whether the REQUESTED OCR languages could actually run — docHelper.py._resolve_lang silently narrows a 'chi_sim+eng' request to the subset that has traineddata installed, so text in a missing-language image is un-recognized/mis-transliterated while the model is told '请据此作答'; closes the DEAD-FIELD gap where the JSON returned only the narrowed lang and never the original request, so the drop was invisible)。
  - 验证：`node --check services/backend/src/services/gateway/ocrLanguageNotice.js`

**338.** 验证「Text-only-model Image OCR Fallback — Honest LANGUAGE-PACK Caveat (fourth orthogonal honesty axis, most directly serving '准确识别图片': confidence=ACCURACY of words; coverage=COMPLETENESS across images; truncation=COMPLETENESS within one image; language=whether the REQUESTED OCR languages could actually run — docHelper.py._resolve_lang silently narrows a 'chi_sim+eng' request to the subset that has traineddata installed, so text in a missing-language image is un-recognized/mis-transliterated while the model is told '请据此作答'; closes the DEAD-FIELD gap where the JSON returned only the narrowed lang and never the original request, so the drop was invisible)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Text-only-model Image OCR Fallback — Honest LANGUAGE-PACK Caveat (fourth orthogonal honesty axis, most directly serving '准确识别图片': confidence=ACCURACY of words; coverage=COMPLETENESS across images; truncation=COMPLETENESS within one image; language=whether the REQUESTED OCR languages could actually run — docHelper.py._resolve_lang silently narrows a 'chi_sim+eng' request to the subset that has traineddata installed, so text in a missing-language image is un-recognized/mis-transliterated while the model is told '请据此作答'; closes the DEAD-FIELD gap where the JSON returned only the narrowed lang and never the original request, so the drop was invisible)。
  - 验证：`python3 -m py_compile services/backend/src/services/docHelper.py`

**339.** 验证「Text-only-model Image OCR Fallback — Auto-ORIENTATION Correction (FIRST CORRECTIVE axis; prior four axes — confidence/coverage/truncation/language — only DISCLOSE a problem, this one actually RECOVERS the correct text, most directly serving '准确识别图片'): a rotated photo OCRs to 'confident-looking garbage' (conf ~51-62, which partially ESCAPES the <60 low-confidence flag of OPS-104) while the correctly-oriented image OCRs at ~95; docHelper.py._maybe_reorient brute-forces 90/180/270 rotations (tesseract OSD --psm 0 is unreliable on sparse text) and keeps the highest-confidence success, stamping orientationCorrected=<deg>; the gateway then discloses that the text came from a rotated-straight image, closing the gap where a text-only model would otherwise be fed rotated garbage as authoritative」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Text-only-model Image OCR Fallback — Auto-ORIENTATION Correction (FIRST CORRECTIVE axis; prior four axes — confidence/coverage/truncation/language — only DISCLOSE a problem, this one actually RECOVERS the correct text, most directly serving '准确识别图片'): a rotated photo OCRs to 'confident-looking garbage' (conf ~51-62, which partially ESCAPES the <60 low-confidence flag of OPS-104) while the correctly-oriented image OCRs at ~95; docHelper.py._maybe_reorient brute-forces 90/180/270 rotations (tesseract OSD --psm 0 is unreliable on sparse text) and keeps the highest-confidence success, stamping orientationCorrected=<deg>; the gateway then discloses that the text came from a rotated-straight image, closing the gap where a text-only model would otherwise be fed rotated garbage as authoritative。
  - 验证：`npm run test:one -- services/backend/tests/gateway/ocrOrientationNotice.test.js services/backend/tests/gateway/imageOcrOrientationWiring.test.js services/backend/tests/gateway/ocrOrientationRecovery.test.js`

**340.** 验证「Text-only-model Image OCR Fallback — Auto-ORIENTATION Correction (FIRST CORRECTIVE axis; prior four axes — confidence/coverage/truncation/language — only DISCLOSE a problem, this one actually RECOVERS the correct text, most directly serving '准确识别图片'): a rotated photo OCRs to 'confident-looking garbage' (conf ~51-62, which partially ESCAPES the <60 low-confidence flag of OPS-104) while the correctly-oriented image OCRs at ~95; docHelper.py._maybe_reorient brute-forces 90/180/270 rotations (tesseract OSD --psm 0 is unreliable on sparse text) and keeps the highest-confidence success, stamping orientationCorrected=<deg>; the gateway then discloses that the text came from a rotated-straight image, closing the gap where a text-only model would otherwise be fed rotated garbage as authoritative」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Text-only-model Image OCR Fallback — Auto-ORIENTATION Correction (FIRST CORRECTIVE axis; prior four axes — confidence/coverage/truncation/language — only DISCLOSE a problem, this one actually RECOVERS the correct text, most directly serving '准确识别图片'): a rotated photo OCRs to 'confident-looking garbage' (conf ~51-62, which partially ESCAPES the <60 low-confidence flag of OPS-104) while the correctly-oriented image OCRs at ~95; docHelper.py._maybe_reorient brute-forces 90/180/270 rotations (tesseract OSD --psm 0 is unreliable on sparse text) and keeps the highest-confidence success, stamping orientationCorrected=<deg>; the gateway then discloses that the text came from a rotated-straight image, closing the gap where a text-only model would otherwise be fed rotated garbage as authoritative。
  - 验证：`node --check services/backend/src/services/gateway/ocrOrientationNotice.js`

**341.** 验证「Text-only-model Image OCR Fallback — Auto-ORIENTATION Correction (FIRST CORRECTIVE axis; prior four axes — confidence/coverage/truncation/language — only DISCLOSE a problem, this one actually RECOVERS the correct text, most directly serving '准确识别图片'): a rotated photo OCRs to 'confident-looking garbage' (conf ~51-62, which partially ESCAPES the <60 low-confidence flag of OPS-104) while the correctly-oriented image OCRs at ~95; docHelper.py._maybe_reorient brute-forces 90/180/270 rotations (tesseract OSD --psm 0 is unreliable on sparse text) and keeps the highest-confidence success, stamping orientationCorrected=<deg>; the gateway then discloses that the text came from a rotated-straight image, closing the gap where a text-only model would otherwise be fed rotated garbage as authoritative」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Text-only-model Image OCR Fallback — Auto-ORIENTATION Correction (FIRST CORRECTIVE axis; prior four axes — confidence/coverage/truncation/language — only DISCLOSE a problem, this one actually RECOVERS the correct text, most directly serving '准确识别图片'): a rotated photo OCRs to 'confident-looking garbage' (conf ~51-62, which partially ESCAPES the <60 low-confidence flag of OPS-104) while the correctly-oriented image OCRs at ~95; docHelper.py._maybe_reorient brute-forces 90/180/270 rotations (tesseract OSD --psm 0 is unreliable on sparse text) and keeps the highest-confidence success, stamping orientationCorrected=<deg>; the gateway then discloses that the text came from a rotated-straight image, closing the gap where a text-only model would otherwise be fed rotated garbage as authoritative。
  - 验证：`python3 -m py_compile services/backend/src/services/docHelper.py`

**342.** 验证「Text-only-model Image OCR Fallback — Low-RESOLUTION Auto-Upscale (SIXTH axis, SECOND CORRECTIVE one, orthogonal to & alongside the orientation axis: orientation rotates-to-fix, this one enlarges-to-fix; the four earlier axes — confidence/coverage/truncation/language — only DISCLOSE, the two corrective axes actually RECOVER text, most directly serving '准确识别图片' for tiny/low-res images): a low-resolution image OCRs to NOTHING at native size (empty, not the orientation axis's 'confident garbage') because tesseract wants ~300 DPI; docHelper.py._maybe_upscale brute-forces 2/3/4× LANCZOS enlargements, keeps the highest-confidence success, and stamps upscaledFactor=<n>; the gateway then discloses that the text came from an auto-enlarged low-res image, closing the gap where a text-only model would otherwise get no text at all from a small image」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Text-only-model Image OCR Fallback — Low-RESOLUTION Auto-Upscale (SIXTH axis, SECOND CORRECTIVE one, orthogonal to & alongside the orientation axis: orientation rotates-to-fix, this one enlarges-to-fix; the four earlier axes — confidence/coverage/truncation/language — only DISCLOSE, the two corrective axes actually RECOVER text, most directly serving '准确识别图片' for tiny/low-res images): a low-resolution image OCRs to NOTHING at native size (empty, not the orientation axis's 'confident garbage') because tesseract wants ~300 DPI; docHelper.py._maybe_upscale brute-forces 2/3/4× LANCZOS enlargements, keeps the highest-confidence success, and stamps upscaledFactor=<n>; the gateway then discloses that the text came from an auto-enlarged low-res image, closing the gap where a text-only model would otherwise get no text at all from a small image。
  - 验证：`npm run test:one -- services/backend/tests/gateway/ocrResolutionNotice.test.js services/backend/tests/gateway/imageOcrResolutionWiring.test.js services/backend/tests/gateway/ocrResolutionRecovery.test.js`

**343.** 验证「Text-only-model Image OCR Fallback — Low-RESOLUTION Auto-Upscale (SIXTH axis, SECOND CORRECTIVE one, orthogonal to & alongside the orientation axis: orientation rotates-to-fix, this one enlarges-to-fix; the four earlier axes — confidence/coverage/truncation/language — only DISCLOSE, the two corrective axes actually RECOVER text, most directly serving '准确识别图片' for tiny/low-res images): a low-resolution image OCRs to NOTHING at native size (empty, not the orientation axis's 'confident garbage') because tesseract wants ~300 DPI; docHelper.py._maybe_upscale brute-forces 2/3/4× LANCZOS enlargements, keeps the highest-confidence success, and stamps upscaledFactor=<n>; the gateway then discloses that the text came from an auto-enlarged low-res image, closing the gap where a text-only model would otherwise get no text at all from a small image」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Text-only-model Image OCR Fallback — Low-RESOLUTION Auto-Upscale (SIXTH axis, SECOND CORRECTIVE one, orthogonal to & alongside the orientation axis: orientation rotates-to-fix, this one enlarges-to-fix; the four earlier axes — confidence/coverage/truncation/language — only DISCLOSE, the two corrective axes actually RECOVER text, most directly serving '准确识别图片' for tiny/low-res images): a low-resolution image OCRs to NOTHING at native size (empty, not the orientation axis's 'confident garbage') because tesseract wants ~300 DPI; docHelper.py._maybe_upscale brute-forces 2/3/4× LANCZOS enlargements, keeps the highest-confidence success, and stamps upscaledFactor=<n>; the gateway then discloses that the text came from an auto-enlarged low-res image, closing the gap where a text-only model would otherwise get no text at all from a small image。
  - 验证：`node --check services/backend/src/services/gateway/ocrResolutionNotice.js`

**344.** 验证「Text-only-model Image OCR Fallback — Low-RESOLUTION Auto-Upscale (SIXTH axis, SECOND CORRECTIVE one, orthogonal to & alongside the orientation axis: orientation rotates-to-fix, this one enlarges-to-fix; the four earlier axes — confidence/coverage/truncation/language — only DISCLOSE, the two corrective axes actually RECOVER text, most directly serving '准确识别图片' for tiny/low-res images): a low-resolution image OCRs to NOTHING at native size (empty, not the orientation axis's 'confident garbage') because tesseract wants ~300 DPI; docHelper.py._maybe_upscale brute-forces 2/3/4× LANCZOS enlargements, keeps the highest-confidence success, and stamps upscaledFactor=<n>; the gateway then discloses that the text came from an auto-enlarged low-res image, closing the gap where a text-only model would otherwise get no text at all from a small image」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Text-only-model Image OCR Fallback — Low-RESOLUTION Auto-Upscale (SIXTH axis, SECOND CORRECTIVE one, orthogonal to & alongside the orientation axis: orientation rotates-to-fix, this one enlarges-to-fix; the four earlier axes — confidence/coverage/truncation/language — only DISCLOSE, the two corrective axes actually RECOVER text, most directly serving '准确识别图片' for tiny/low-res images): a low-resolution image OCRs to NOTHING at native size (empty, not the orientation axis's 'confident garbage') because tesseract wants ~300 DPI; docHelper.py._maybe_upscale brute-forces 2/3/4× LANCZOS enlargements, keeps the highest-confidence success, and stamps upscaledFactor=<n>; the gateway then discloses that the text came from an auto-enlarged low-res image, closing the gap where a text-only model would otherwise get no text at all from a small image。
  - 验证：`python3 -m py_compile services/backend/src/services/docHelper.py`

**345.** 验证「unpack Unknown-Format Self-Remediation (generic extractor fallback + gated auto-install)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：unpack Unknown-Format Self-Remediation (generic extractor fallback + gated auto-install)。
  - 验证：`npm run test:one -- services/backend/tests/tools/unpackGeneric.test.js services/backend/tests/tools/unpackAsar.test.js`

**346.** 验证「unpack Unknown-Format Self-Remediation (generic extractor fallback + gated auto-install)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：unpack Unknown-Format Self-Remediation (generic extractor fallback + gated auto-install)。
  - 验证：`node --check services/backend/src/services/reverseEngineer/genericExtractor.js`

**347.** 验证「unpack Unknown-Format Self-Remediation (generic extractor fallback + gated auto-install)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：unpack Unknown-Format Self-Remediation (generic extractor fallback + gated auto-install)。
  - 验证：`node --check services/backend/src/tools/unpackTool.js`

**348.** 验证「Text-only-model Image OCR Fallback — Describe-cascade-fail SAFETY FLOOR decoupled from the cosmetic failure-summary gate (UPSTREAM control-flow axis: the prior six axes 104/109/111/112/115/116 all harden honesty INSIDE the OCR path assuming it was reached; this one guarantees the OCR path is RELIABLY REACHED when the describe-and-return vision cascade fully fails — 404/model_not_found + socket hang up — so a text-only model never gets a bare image and never hallucinates '消息里没有附带图片')」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Text-only-model Image OCR Fallback — Describe-cascade-fail SAFETY FLOOR decoupled from the cosmetic failure-summary gate (UPSTREAM control-flow axis: the prior six axes 104/109/111/112/115/116 all harden honesty INSIDE the OCR path assuming it was reached; this one guarantees the OCR path is RELIABLY REACHED when the describe-and-return vision cascade fully fails — 404/model_not_found + socket hang up — so a text-only model never gets a bare image and never hallucinates '消息里没有附带图片')。
  - 验证：`npm run test:one -- services/backend/tests/visionOcrFallback.test.js services/backend/tests/gateway/visionDescribeFailFloorWiring.test.js services/backend/tests/gateway/visionDescribeFailFloorRealImage.test.js`

**349.** 验证「Text-only-model Image OCR Fallback — Describe-cascade-fail SAFETY FLOOR decoupled from the cosmetic failure-summary gate (UPSTREAM control-flow axis: the prior six axes 104/109/111/112/115/116 all harden honesty INSIDE the OCR path assuming it was reached; this one guarantees the OCR path is RELIABLY REACHED when the describe-and-return vision cascade fully fails — 404/model_not_found + socket hang up — so a text-only model never gets a bare image and never hallucinates '消息里没有附带图片')」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Text-only-model Image OCR Fallback — Describe-cascade-fail SAFETY FLOOR decoupled from the cosmetic failure-summary gate (UPSTREAM control-flow axis: the prior six axes 104/109/111/112/115/116 all harden honesty INSIDE the OCR path assuming it was reached; this one guarantees the OCR path is RELIABLY REACHED when the describe-and-return vision cascade fully fails — 404/model_not_found + socket hang up — so a text-only model never gets a bare image and never hallucinates '消息里没有附带图片')。
  - 验证：`node --check services/backend/src/services/gateway/visionOcrFallback.js`

**350.** 验证「Text-only-model Image OCR Fallback — Describe-cascade-fail SAFETY FLOOR decoupled from the cosmetic failure-summary gate (UPSTREAM control-flow axis: the prior six axes 104/109/111/112/115/116 all harden honesty INSIDE the OCR path assuming it was reached; this one guarantees the OCR path is RELIABLY REACHED when the describe-and-return vision cascade fully fails — 404/model_not_found + socket hang up — so a text-only model never gets a bare image and never hallucinates '消息里没有附带图片')」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Text-only-model Image OCR Fallback — Describe-cascade-fail SAFETY FLOOR decoupled from the cosmetic failure-summary gate (UPSTREAM control-flow axis: the prior six axes 104/109/111/112/115/116 all harden honesty INSIDE the OCR path assuming it was reached; this one guarantees the OCR path is RELIABLY REACHED when the describe-and-return vision cascade fully fails — 404/model_not_found + socket hang up — so a text-only model never gets a bare image and never hallucinates '消息里没有附带图片')。
  - 验证：`node --check services/backend/src/services/gateway/aiGatewayGenerateMethod.js`

**351.** 验证「Text-only-model Image OCR Fallback — STRIP-IMAGE irreducible honesty floor decoupled from the OCR FEATURE gate (承 OPS-118: second orthogonal control-flow bridge on the same describe-cascade-fail path; OPS-118 guaranteed the floor PATH executes regardless of the cosmetic KHY_VISION_FAILURE_SUMMARY gate, but WITHIN the floor's empty-OCR else-branch the strip is UNCONDITIONAL while the '收到图但读不出' note is gated by KHY_VISION_OCR_FALLBACK — a FEATURE gate; user disables OCR fallback -> note suppressed but image still stripped -> bare prompt with no image + no note -> text model still hallucinates '消息里没有附带图片 / 当前对话中没有任何图片附件')」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Text-only-model Image OCR Fallback — STRIP-IMAGE irreducible honesty floor decoupled from the OCR FEATURE gate (承 OPS-118: second orthogonal control-flow bridge on the same describe-cascade-fail path; OPS-118 guaranteed the floor PATH executes regardless of the cosmetic KHY_VISION_FAILURE_SUMMARY gate, but WITHIN the floor's empty-OCR else-branch the strip is UNCONDITIONAL while the '收到图但读不出' note is gated by KHY_VISION_OCR_FALLBACK — a FEATURE gate; user disables OCR fallback -> note suppressed but image still stripped -> bare prompt with no image + no note -> text model still hallucinates '消息里没有附带图片 / 当前对话中没有任何图片附件')。
  - 验证：`npm run test:one -- services/backend/tests/gateway/visionStripImageFloorWiring.test.js services/backend/tests/gateway/visionStripImageFloorRealImage.test.js`

**352.** 验证「Text-only-model Image OCR Fallback — STRIP-IMAGE irreducible honesty floor decoupled from the OCR FEATURE gate (承 OPS-118: second orthogonal control-flow bridge on the same describe-cascade-fail path; OPS-118 guaranteed the floor PATH executes regardless of the cosmetic KHY_VISION_FAILURE_SUMMARY gate, but WITHIN the floor's empty-OCR else-branch the strip is UNCONDITIONAL while the '收到图但读不出' note is gated by KHY_VISION_OCR_FALLBACK — a FEATURE gate; user disables OCR fallback -> note suppressed but image still stripped -> bare prompt with no image + no note -> text model still hallucinates '消息里没有附带图片 / 当前对话中没有任何图片附件')」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Text-only-model Image OCR Fallback — STRIP-IMAGE irreducible honesty floor decoupled from the OCR FEATURE gate (承 OPS-118: second orthogonal control-flow bridge on the same describe-cascade-fail path; OPS-118 guaranteed the floor PATH executes regardless of the cosmetic KHY_VISION_FAILURE_SUMMARY gate, but WITHIN the floor's empty-OCR else-branch the strip is UNCONDITIONAL while the '收到图但读不出' note is gated by KHY_VISION_OCR_FALLBACK — a FEATURE gate; user disables OCR fallback -> note suppressed but image still stripped -> bare prompt with no image + no note -> text model still hallucinates '消息里没有附带图片 / 当前对话中没有任何图片附件')。
  - 验证：`node --check services/backend/src/services/gateway/visionOcrFallback.js`

**353.** 验证「Text-only-model Image OCR Fallback — STRIP-IMAGE irreducible honesty floor decoupled from the OCR FEATURE gate (承 OPS-118: second orthogonal control-flow bridge on the same describe-cascade-fail path; OPS-118 guaranteed the floor PATH executes regardless of the cosmetic KHY_VISION_FAILURE_SUMMARY gate, but WITHIN the floor's empty-OCR else-branch the strip is UNCONDITIONAL while the '收到图但读不出' note is gated by KHY_VISION_OCR_FALLBACK — a FEATURE gate; user disables OCR fallback -> note suppressed but image still stripped -> bare prompt with no image + no note -> text model still hallucinates '消息里没有附带图片 / 当前对话中没有任何图片附件')」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Text-only-model Image OCR Fallback — STRIP-IMAGE irreducible honesty floor decoupled from the OCR FEATURE gate (承 OPS-118: second orthogonal control-flow bridge on the same describe-cascade-fail path; OPS-118 guaranteed the floor PATH executes regardless of the cosmetic KHY_VISION_FAILURE_SUMMARY gate, but WITHIN the floor's empty-OCR else-branch the strip is UNCONDITIONAL while the '收到图但读不出' note is gated by KHY_VISION_OCR_FALLBACK — a FEATURE gate; user disables OCR fallback -> note suppressed but image still stripped -> bare prompt with no image + no note -> text model still hallucinates '消息里没有附带图片 / 当前对话中没有任何图片附件')。
  - 验证：`node --check services/backend/src/services/gateway/aiGatewayGenerateMethod.js`

**354.** 验证「Text-only-model Image OCR Fallback — POST-FAILURE rescue-net STRIP-IMAGE honesty floor (承 OPS-118/120: THIRD orthogonal '剥图 ⟹ 必留痕' bridge, but in the post-failure cascade rescue net instead of the prep-phase describe cascade; when the current model is deemed vision-capable (decideVisionRouting=keep, image kept) an adapter rejects the image at RUNTIME with 404/model_not_found -> shouldOcrRescue promotes _visionFallback -> the rescue net falls back to local OCR; the OCR-text-success branch strips+injects, but the empty-OCR / OCR-throw branch historically only emitStatus'd then break'd, leaving the BARE image to survive to a downstream text adapter that silently drops it and hallucinates '消息里没有附带图片')」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Text-only-model Image OCR Fallback — POST-FAILURE rescue-net STRIP-IMAGE honesty floor (承 OPS-118/120: THIRD orthogonal '剥图 ⟹ 必留痕' bridge, but in the post-failure cascade rescue net instead of the prep-phase describe cascade; when the current model is deemed vision-capable (decideVisionRouting=keep, image kept) an adapter rejects the image at RUNTIME with 404/model_not_found -> shouldOcrRescue promotes _visionFallback -> the rescue net falls back to local OCR; the OCR-text-success branch strips+injects, but the empty-OCR / OCR-throw branch historically only emitStatus'd then break'd, leaving the BARE image to survive to a downstream text adapter that silently drops it and hallucinates '消息里没有附带图片')。
  - 验证：`npm run test:one -- services/backend/tests/gateway/visionRescueStripFloorWiring.test.js services/backend/tests/gateway/visionRescueStripFloorRealImage.test.js`

**355.** 验证「Text-only-model Image OCR Fallback — POST-FAILURE rescue-net STRIP-IMAGE honesty floor (承 OPS-118/120: THIRD orthogonal '剥图 ⟹ 必留痕' bridge, but in the post-failure cascade rescue net instead of the prep-phase describe cascade; when the current model is deemed vision-capable (decideVisionRouting=keep, image kept) an adapter rejects the image at RUNTIME with 404/model_not_found -> shouldOcrRescue promotes _visionFallback -> the rescue net falls back to local OCR; the OCR-text-success branch strips+injects, but the empty-OCR / OCR-throw branch historically only emitStatus'd then break'd, leaving the BARE image to survive to a downstream text adapter that silently drops it and hallucinates '消息里没有附带图片')」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Text-only-model Image OCR Fallback — POST-FAILURE rescue-net STRIP-IMAGE honesty floor (承 OPS-118/120: THIRD orthogonal '剥图 ⟹ 必留痕' bridge, but in the post-failure cascade rescue net instead of the prep-phase describe cascade; when the current model is deemed vision-capable (decideVisionRouting=keep, image kept) an adapter rejects the image at RUNTIME with 404/model_not_found -> shouldOcrRescue promotes _visionFallback -> the rescue net falls back to local OCR; the OCR-text-success branch strips+injects, but the empty-OCR / OCR-throw branch historically only emitStatus'd then break'd, leaving the BARE image to survive to a downstream text adapter that silently drops it and hallucinates '消息里没有附带图片')。
  - 验证：`node --check services/backend/src/services/gateway/visionOcrFallback.js`

**356.** 验证「Text-only-model Image OCR Fallback — POST-FAILURE rescue-net STRIP-IMAGE honesty floor (承 OPS-118/120: THIRD orthogonal '剥图 ⟹ 必留痕' bridge, but in the post-failure cascade rescue net instead of the prep-phase describe cascade; when the current model is deemed vision-capable (decideVisionRouting=keep, image kept) an adapter rejects the image at RUNTIME with 404/model_not_found -> shouldOcrRescue promotes _visionFallback -> the rescue net falls back to local OCR; the OCR-text-success branch strips+injects, but the empty-OCR / OCR-throw branch historically only emitStatus'd then break'd, leaving the BARE image to survive to a downstream text adapter that silently drops it and hallucinates '消息里没有附带图片')」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Text-only-model Image OCR Fallback — POST-FAILURE rescue-net STRIP-IMAGE honesty floor (承 OPS-118/120: THIRD orthogonal '剥图 ⟹ 必留痕' bridge, but in the post-failure cascade rescue net instead of the prep-phase describe cascade; when the current model is deemed vision-capable (decideVisionRouting=keep, image kept) an adapter rejects the image at RUNTIME with 404/model_not_found -> shouldOcrRescue promotes _visionFallback -> the rescue net falls back to local OCR; the OCR-text-success branch strips+injects, but the empty-OCR / OCR-throw branch historically only emitStatus'd then break'd, leaving the BARE image to survive to a downstream text adapter that silently drops it and hallucinates '消息里没有附带图片')。
  - 验证：`node --check services/backend/src/services/gateway/aiGatewayGenerateMethod.js`

**357.** 验证「Text-only-model Image OCR Fallback — OCR-SUCCESS user-facing 'OCR was used' TRANSPARENCY disclosure (OPS-MAN-124; orthogonal to the six CONDITIONAL honesty axes: low-confidence / coverage / truncation / language / orientation / resolution — those fire only when the OCR result has a defect; when OCR succeeds CLEANLY none of them fire, so the injected prompt has only a model-facing '以下为图片 OCR 识别文本，请据此作答' header and the model answers as if it natively saw the image, never telling the USER that OCR was the reading method — violating '要能无感明显告知用户用了ocr但能正确识别图片')」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Text-only-model Image OCR Fallback — OCR-SUCCESS user-facing 'OCR was used' TRANSPARENCY disclosure (OPS-MAN-124; orthogonal to the six CONDITIONAL honesty axes: low-confidence / coverage / truncation / language / orientation / resolution — those fire only when the OCR result has a defect; when OCR succeeds CLEANLY none of them fire, so the injected prompt has only a model-facing '以下为图片 OCR 识别文本，请据此作答' header and the model answers as if it natively saw the image, never telling the USER that OCR was the reading method — violating '要能无感明显告知用户用了ocr但能正确识别图片')。
  - 验证：`npm run test:one -- services/backend/tests/gateway/ocrUsageNotice.test.js services/backend/tests/gateway/ocrUsageDisclosureWiring.test.js services/backend/tests/gateway/ocrUsageDisclosureRealImage.test.js`

**358.** 验证「Text-only-model Image OCR Fallback — OCR-SUCCESS user-facing 'OCR was used' TRANSPARENCY disclosure (OPS-MAN-124; orthogonal to the six CONDITIONAL honesty axes: low-confidence / coverage / truncation / language / orientation / resolution — those fire only when the OCR result has a defect; when OCR succeeds CLEANLY none of them fire, so the injected prompt has only a model-facing '以下为图片 OCR 识别文本，请据此作答' header and the model answers as if it natively saw the image, never telling the USER that OCR was the reading method — violating '要能无感明显告知用户用了ocr但能正确识别图片')」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Text-only-model Image OCR Fallback — OCR-SUCCESS user-facing 'OCR was used' TRANSPARENCY disclosure (OPS-MAN-124; orthogonal to the six CONDITIONAL honesty axes: low-confidence / coverage / truncation / language / orientation / resolution — those fire only when the OCR result has a defect; when OCR succeeds CLEANLY none of them fire, so the injected prompt has only a model-facing '以下为图片 OCR 识别文本，请据此作答' header and the model answers as if it natively saw the image, never telling the USER that OCR was the reading method — violating '要能无感明显告知用户用了ocr但能正确识别图片')。
  - 验证：`node --check services/backend/src/services/gateway/ocrUsageNotice.js`

**359.** 验证「Text-only-model Image OCR Fallback — OCR-SUCCESS user-facing 'OCR was used' TRANSPARENCY disclosure (OPS-MAN-124; orthogonal to the six CONDITIONAL honesty axes: low-confidence / coverage / truncation / language / orientation / resolution — those fire only when the OCR result has a defect; when OCR succeeds CLEANLY none of them fire, so the injected prompt has only a model-facing '以下为图片 OCR 识别文本，请据此作答' header and the model answers as if it natively saw the image, never telling the USER that OCR was the reading method — violating '要能无感明显告知用户用了ocr但能正确识别图片')」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Text-only-model Image OCR Fallback — OCR-SUCCESS user-facing 'OCR was used' TRANSPARENCY disclosure (OPS-MAN-124; orthogonal to the six CONDITIONAL honesty axes: low-confidence / coverage / truncation / language / orientation / resolution — those fire only when the OCR result has a defect; when OCR succeeds CLEANLY none of them fire, so the injected prompt has only a model-facing '以下为图片 OCR 识别文本，请据此作答' header and the model answers as if it natively saw the image, never telling the USER that OCR was the reading method — violating '要能无感明显告知用户用了ocr但能正确识别图片')。
  - 验证：`node --check services/backend/src/services/gateway/aiGatewayGenerateMethod.js`

**360.** 验证「Text-only-model Image OCR Fallback — DETERMINISTIC user-facing 'OCR was used' footnote (OPS-MAN-126; 承 OPS-124). OPS-124 only injects a model-facing INSTRUCTION into the prompt asking the model to disclose OCR usage — that is ADVISORY: the model may ignore it, leaving the answer with no OCR mention, so '明显告知用户' is NOT guaranteed. finishResult's success side already hosts a family of DETERMINISTIC truth footers (answerVerifier / modelIdentityTruth / cacheMetricsTruth) that guarantee truth reaches the user regardless of model compliance; OCR-usage had no such deterministic footer. This area adds the belt to OPS-124's suspenders.」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Text-only-model Image OCR Fallback — DETERMINISTIC user-facing 'OCR was used' footnote (OPS-MAN-126; 承 OPS-124). OPS-124 only injects a model-facing INSTRUCTION into the prompt asking the model to disclose OCR usage — that is ADVISORY: the model may ignore it, leaving the answer with no OCR mention, so '明显告知用户' is NOT guaranteed. finishResult's success side already hosts a family of DETERMINISTIC truth footers (answerVerifier / modelIdentityTruth / cacheMetricsTruth) that guarantee truth reaches the user regardless of model compliance; OCR-usage had no such deterministic footer. This area adds the belt to OPS-124's suspenders.。
  - 验证：`npm run test:one -- services/backend/tests/gateway/ocrUsageFootnote.test.js services/backend/tests/gateway/ocrUsageFootnoteWiring.test.js services/backend/tests/gateway/ocrUsageFootnoteRealImage.test.js`

**361.** 验证「Text-only-model Image OCR Fallback — DETERMINISTIC user-facing 'OCR was used' footnote (OPS-MAN-126; 承 OPS-124). OPS-124 only injects a model-facing INSTRUCTION into the prompt asking the model to disclose OCR usage — that is ADVISORY: the model may ignore it, leaving the answer with no OCR mention, so '明显告知用户' is NOT guaranteed. finishResult's success side already hosts a family of DETERMINISTIC truth footers (answerVerifier / modelIdentityTruth / cacheMetricsTruth) that guarantee truth reaches the user regardless of model compliance; OCR-usage had no such deterministic footer. This area adds the belt to OPS-124's suspenders.」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Text-only-model Image OCR Fallback — DETERMINISTIC user-facing 'OCR was used' footnote (OPS-MAN-126; 承 OPS-124). OPS-124 only injects a model-facing INSTRUCTION into the prompt asking the model to disclose OCR usage — that is ADVISORY: the model may ignore it, leaving the answer with no OCR mention, so '明显告知用户' is NOT guaranteed. finishResult's success side already hosts a family of DETERMINISTIC truth footers (answerVerifier / modelIdentityTruth / cacheMetricsTruth) that guarantee truth reaches the user regardless of model compliance; OCR-usage had no such deterministic footer. This area adds the belt to OPS-124's suspenders.。
  - 验证：`node --check services/backend/src/services/gateway/ocrUsageFootnote.js`

**362.** 验证「Text-only-model Image OCR Fallback — DETERMINISTIC user-facing 'OCR was used' footnote (OPS-MAN-126; 承 OPS-124). OPS-124 only injects a model-facing INSTRUCTION into the prompt asking the model to disclose OCR usage — that is ADVISORY: the model may ignore it, leaving the answer with no OCR mention, so '明显告知用户' is NOT guaranteed. finishResult's success side already hosts a family of DETERMINISTIC truth footers (answerVerifier / modelIdentityTruth / cacheMetricsTruth) that guarantee truth reaches the user regardless of model compliance; OCR-usage had no such deterministic footer. This area adds the belt to OPS-124's suspenders.」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Text-only-model Image OCR Fallback — DETERMINISTIC user-facing 'OCR was used' footnote (OPS-MAN-126; 承 OPS-124). OPS-124 only injects a model-facing INSTRUCTION into the prompt asking the model to disclose OCR usage — that is ADVISORY: the model may ignore it, leaving the answer with no OCR mention, so '明显告知用户' is NOT guaranteed. finishResult's success side already hosts a family of DETERMINISTIC truth footers (answerVerifier / modelIdentityTruth / cacheMetricsTruth) that guarantee truth reaches the user regardless of model compliance; OCR-usage had no such deterministic footer. This area adds the belt to OPS-124's suspenders.。
  - 验证：`node --check services/backend/src/services/gateway/aiGatewayGenerateMethod.js`

**363.** 验证「Text-only-model Image OCR Fallback — DETERMINISTIC answer-side CORRECTION when the model, on the empty-OCR strip path, STILL denies receiving the image (OPS-MAN-138; 承 OPS-118/120/122 '剥图必留痕' + OPS-126 deterministic-footnote philosophy). Reproduced 2026-07-12 (paste-cache 92c0154d): text-only model + image → vision cascade all 404/socket-hang-up → OCR fallback but the image is NON-TEXT (photo/screenshot/chart) or missing langpack → local OCR reads NOTHING → the three empty-OCR sites (prep Site1 ~1626 / prep Site2 ~1736 / post-failure rescue ~2927) unconditionally strip the image AND inject a model-facing '收到图但读不出、绝不能说没收到图' honest floor — BUT that is only a PROMPT INSTRUCTION the model can ignore; in the real failure the model ignored it and answered '消息里没有附带图片 / 当前对话中没有任何图片附件'. The deterministic finishResult footer family had NO member for this: ocrUsageFootnote (KHY_OCR_USAGE_FOOTNOTE) fires ONLY on _ocrImageTextRead=true (OCR text was read); empty-OCR strip sets _ocrFallbackApplied but NOT _ocrImageTextRead → outside that footer's predicate → zero deterministic correction when the model denies the image. This area adds the last user-visible defense. OPS-MAN-140 (承 138) extends the SAME leaf with an ORTHOGONAL variant for the mirror cell — OCR **SUCCEEDED** (_ocrImageTextRead=true) yet the model STILL denies the image: OPS-138's predicate `!_ocrImageTextRead` excludes it, and ocrUsageFootnote (:858) in that cell only appends '以上关于这张图片的内容是通过 OCR 读取的' which is self-CONTRADICTORY with the denial and does not rebut it. The OCR-success variant (KHY_VISION_DENIAL_CORRECTION_OCR_READ, default-on, distinct DENIAL_CORRECTION_OCR_READ_MARKER) REPLACES (not stacks — noise-conscious) that plain footnote with a denial-aware rebuttal ('你确实发了图、OCR 已成功读出文字、是模型没采用、请据 OCR 文本重新作答'); gate-off byte-reverts to the plain ocrUsageFootnote branch.」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Text-only-model Image OCR Fallback — DETERMINISTIC answer-side CORRECTION when the model, on the empty-OCR strip path, STILL denies receiving the image (OPS-MAN-138; 承 OPS-118/120/122 '剥图必留痕' + OPS-126 deterministic-footnote philosophy). Reproduced 2026-07-12 (paste-cache 92c0154d): text-only model + image → vision cascade all 404/socket-hang-up → OCR fallback but the image is NON-TEXT (photo/screenshot/chart) or missing langpack → local OCR reads NOTHING → the three empty-OCR sites (prep Site1 ~1626 / prep Site2 ~1736 / post-failure rescue ~2927) unconditionally strip the image AND inject a model-facing '收到图但读不出、绝不能说没收到图' honest floor — BUT that is only a PROMPT INSTRUCTION the model can ignore; in the real failure the model ignored it and answered '消息里没有附带图片 / 当前对话中没有任何图片附件'. The deterministic finishResult footer family had NO member for this: ocrUsageFootnote (KHY_OCR_USAGE_FOOTNOTE) fires ONLY on _ocrImageTextRead=true (OCR text was read); empty-OCR strip sets _ocrFallbackApplied but NOT _ocrImageTextRead → outside that footer's predicate → zero deterministic correction when the model denies the image. This area adds the last user-visible defense. OPS-MAN-140 (承 138) extends the SAME leaf with an ORTHOGONAL variant for the mirror cell — OCR **SUCCEEDED** (_ocrImageTextRead=true) yet the model STILL denies the image: OPS-138's predicate `!_ocrImageTextRead` excludes it, and ocrUsageFootnote (:858) in that cell only appends '以上关于这张图片的内容是通过 OCR 读取的' which is self-CONTRADICTORY with the denial and does not rebut it. The OCR-success variant (KHY_VISION_DENIAL_CORRECTION_OCR_READ, default-on, distinct DENIAL_CORRECTION_OCR_READ_MARKER) REPLACES (not stacks — noise-conscious) that plain footnote with a denial-aware rebuttal ('你确实发了图、OCR 已成功读出文字、是模型没采用、请据 OCR 文本重新作答'); gate-off byte-reverts to the plain ocrUsageFootnote branch.。
  - 验证：`npm run test:one -- services/backend/tests/gateway/visionDenialCorrection.test.js services/backend/tests/gateway/visionDenialCorrectionWiring.test.js services/backend/tests/gateway/visionDenialCorrectionRealImage.test.js`

**364.** 验证「Text-only-model Image OCR Fallback — DETERMINISTIC answer-side CORRECTION when the model, on the empty-OCR strip path, STILL denies receiving the image (OPS-MAN-138; 承 OPS-118/120/122 '剥图必留痕' + OPS-126 deterministic-footnote philosophy). Reproduced 2026-07-12 (paste-cache 92c0154d): text-only model + image → vision cascade all 404/socket-hang-up → OCR fallback but the image is NON-TEXT (photo/screenshot/chart) or missing langpack → local OCR reads NOTHING → the three empty-OCR sites (prep Site1 ~1626 / prep Site2 ~1736 / post-failure rescue ~2927) unconditionally strip the image AND inject a model-facing '收到图但读不出、绝不能说没收到图' honest floor — BUT that is only a PROMPT INSTRUCTION the model can ignore; in the real failure the model ignored it and answered '消息里没有附带图片 / 当前对话中没有任何图片附件'. The deterministic finishResult footer family had NO member for this: ocrUsageFootnote (KHY_OCR_USAGE_FOOTNOTE) fires ONLY on _ocrImageTextRead=true (OCR text was read); empty-OCR strip sets _ocrFallbackApplied but NOT _ocrImageTextRead → outside that footer's predicate → zero deterministic correction when the model denies the image. This area adds the last user-visible defense. OPS-MAN-140 (承 138) extends the SAME leaf with an ORTHOGONAL variant for the mirror cell — OCR **SUCCEEDED** (_ocrImageTextRead=true) yet the model STILL denies the image: OPS-138's predicate `!_ocrImageTextRead` excludes it, and ocrUsageFootnote (:858) in that cell only appends '以上关于这张图片的内容是通过 OCR 读取的' which is self-CONTRADICTORY with the denial and does not rebut it. The OCR-success variant (KHY_VISION_DENIAL_CORRECTION_OCR_READ, default-on, distinct DENIAL_CORRECTION_OCR_READ_MARKER) REPLACES (not stacks — noise-conscious) that plain footnote with a denial-aware rebuttal ('你确实发了图、OCR 已成功读出文字、是模型没采用、请据 OCR 文本重新作答'); gate-off byte-reverts to the plain ocrUsageFootnote branch.」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Text-only-model Image OCR Fallback — DETERMINISTIC answer-side CORRECTION when the model, on the empty-OCR strip path, STILL denies receiving the image (OPS-MAN-138; 承 OPS-118/120/122 '剥图必留痕' + OPS-126 deterministic-footnote philosophy). Reproduced 2026-07-12 (paste-cache 92c0154d): text-only model + image → vision cascade all 404/socket-hang-up → OCR fallback but the image is NON-TEXT (photo/screenshot/chart) or missing langpack → local OCR reads NOTHING → the three empty-OCR sites (prep Site1 ~1626 / prep Site2 ~1736 / post-failure rescue ~2927) unconditionally strip the image AND inject a model-facing '收到图但读不出、绝不能说没收到图' honest floor — BUT that is only a PROMPT INSTRUCTION the model can ignore; in the real failure the model ignored it and answered '消息里没有附带图片 / 当前对话中没有任何图片附件'. The deterministic finishResult footer family had NO member for this: ocrUsageFootnote (KHY_OCR_USAGE_FOOTNOTE) fires ONLY on _ocrImageTextRead=true (OCR text was read); empty-OCR strip sets _ocrFallbackApplied but NOT _ocrImageTextRead → outside that footer's predicate → zero deterministic correction when the model denies the image. This area adds the last user-visible defense. OPS-MAN-140 (承 138) extends the SAME leaf with an ORTHOGONAL variant for the mirror cell — OCR **SUCCEEDED** (_ocrImageTextRead=true) yet the model STILL denies the image: OPS-138's predicate `!_ocrImageTextRead` excludes it, and ocrUsageFootnote (:858) in that cell only appends '以上关于这张图片的内容是通过 OCR 读取的' which is self-CONTRADICTORY with the denial and does not rebut it. The OCR-success variant (KHY_VISION_DENIAL_CORRECTION_OCR_READ, default-on, distinct DENIAL_CORRECTION_OCR_READ_MARKER) REPLACES (not stacks — noise-conscious) that plain footnote with a denial-aware rebuttal ('你确实发了图、OCR 已成功读出文字、是模型没采用、请据 OCR 文本重新作答'); gate-off byte-reverts to the plain ocrUsageFootnote branch.。
  - 验证：`node --check services/backend/src/services/gateway/visionDenialCorrection.js`

**365.** 验证「Text-only-model Image OCR Fallback — DETERMINISTIC answer-side CORRECTION when the model, on the empty-OCR strip path, STILL denies receiving the image (OPS-MAN-138; 承 OPS-118/120/122 '剥图必留痕' + OPS-126 deterministic-footnote philosophy). Reproduced 2026-07-12 (paste-cache 92c0154d): text-only model + image → vision cascade all 404/socket-hang-up → OCR fallback but the image is NON-TEXT (photo/screenshot/chart) or missing langpack → local OCR reads NOTHING → the three empty-OCR sites (prep Site1 ~1626 / prep Site2 ~1736 / post-failure rescue ~2927) unconditionally strip the image AND inject a model-facing '收到图但读不出、绝不能说没收到图' honest floor — BUT that is only a PROMPT INSTRUCTION the model can ignore; in the real failure the model ignored it and answered '消息里没有附带图片 / 当前对话中没有任何图片附件'. The deterministic finishResult footer family had NO member for this: ocrUsageFootnote (KHY_OCR_USAGE_FOOTNOTE) fires ONLY on _ocrImageTextRead=true (OCR text was read); empty-OCR strip sets _ocrFallbackApplied but NOT _ocrImageTextRead → outside that footer's predicate → zero deterministic correction when the model denies the image. This area adds the last user-visible defense. OPS-MAN-140 (承 138) extends the SAME leaf with an ORTHOGONAL variant for the mirror cell — OCR **SUCCEEDED** (_ocrImageTextRead=true) yet the model STILL denies the image: OPS-138's predicate `!_ocrImageTextRead` excludes it, and ocrUsageFootnote (:858) in that cell only appends '以上关于这张图片的内容是通过 OCR 读取的' which is self-CONTRADICTORY with the denial and does not rebut it. The OCR-success variant (KHY_VISION_DENIAL_CORRECTION_OCR_READ, default-on, distinct DENIAL_CORRECTION_OCR_READ_MARKER) REPLACES (not stacks — noise-conscious) that plain footnote with a denial-aware rebuttal ('你确实发了图、OCR 已成功读出文字、是模型没采用、请据 OCR 文本重新作答'); gate-off byte-reverts to the plain ocrUsageFootnote branch.」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Text-only-model Image OCR Fallback — DETERMINISTIC answer-side CORRECTION when the model, on the empty-OCR strip path, STILL denies receiving the image (OPS-MAN-138; 承 OPS-118/120/122 '剥图必留痕' + OPS-126 deterministic-footnote philosophy). Reproduced 2026-07-12 (paste-cache 92c0154d): text-only model + image → vision cascade all 404/socket-hang-up → OCR fallback but the image is NON-TEXT (photo/screenshot/chart) or missing langpack → local OCR reads NOTHING → the three empty-OCR sites (prep Site1 ~1626 / prep Site2 ~1736 / post-failure rescue ~2927) unconditionally strip the image AND inject a model-facing '收到图但读不出、绝不能说没收到图' honest floor — BUT that is only a PROMPT INSTRUCTION the model can ignore; in the real failure the model ignored it and answered '消息里没有附带图片 / 当前对话中没有任何图片附件'. The deterministic finishResult footer family had NO member for this: ocrUsageFootnote (KHY_OCR_USAGE_FOOTNOTE) fires ONLY on _ocrImageTextRead=true (OCR text was read); empty-OCR strip sets _ocrFallbackApplied but NOT _ocrImageTextRead → outside that footer's predicate → zero deterministic correction when the model denies the image. This area adds the last user-visible defense. OPS-MAN-140 (承 138) extends the SAME leaf with an ORTHOGONAL variant for the mirror cell — OCR **SUCCEEDED** (_ocrImageTextRead=true) yet the model STILL denies the image: OPS-138's predicate `!_ocrImageTextRead` excludes it, and ocrUsageFootnote (:858) in that cell only appends '以上关于这张图片的内容是通过 OCR 读取的' which is self-CONTRADICTORY with the denial and does not rebut it. The OCR-success variant (KHY_VISION_DENIAL_CORRECTION_OCR_READ, default-on, distinct DENIAL_CORRECTION_OCR_READ_MARKER) REPLACES (not stacks — noise-conscious) that plain footnote with a denial-aware rebuttal ('你确实发了图、OCR 已成功读出文字、是模型没采用、请据 OCR 文本重新作答'); gate-off byte-reverts to the plain ocrUsageFootnote branch.。
  - 验证：`node --check services/backend/src/services/gateway/aiGatewayGenerateMethod.js`

**366.** 验证「Text-only-model Image OCR Fallback — DEFER the vision-failure WALL until the OCR outcome is known (OPS-MAN-142; 承 OPS-138/140, directly serving '减少显示的心灵噪音'). Reproduced 2026-07-12 (paste-cache 92c0154d): text-only model + image → describe-and-return cascade to vision models all fail → aiGatewayGenerateMethod EAGERLY emitAssistantMessage's the scary failure WALL (buildVisionFailureMessage, '图像识别失败…粘贴 GLM API Key') at ~line 1590 BEFORE OCR fallback runs. When the image is a TEXT image and local OCR then SUCCEEDS reading it, that scary wall was ALREADY shown to the user — self-CONTRADICTORY with the immediately-following '已用 OCR 成功识别' and the loudest 心灵噪音 in the log. This area DEFERS the wall's emission to after the OCR result is known: OCR success → suppress the wall (rescued, wall is pure misdirection); OCR empty/failure → emit it (user genuinely needs to act). Orthogonal to the parent KHY_VISION_FAILURE_SUMMARY (which decides whether the wall's TEXT is an honest summary at all).」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Text-only-model Image OCR Fallback — DEFER the vision-failure WALL until the OCR outcome is known (OPS-MAN-142; 承 OPS-138/140, directly serving '减少显示的心灵噪音'). Reproduced 2026-07-12 (paste-cache 92c0154d): text-only model + image → describe-and-return cascade to vision models all fail → aiGatewayGenerateMethod EAGERLY emitAssistantMessage's the scary failure WALL (buildVisionFailureMessage, '图像识别失败…粘贴 GLM API Key') at ~line 1590 BEFORE OCR fallback runs. When the image is a TEXT image and local OCR then SUCCEEDS reading it, that scary wall was ALREADY shown to the user — self-CONTRADICTORY with the immediately-following '已用 OCR 成功识别' and the loudest 心灵噪音 in the log. This area DEFERS the wall's emission to after the OCR result is known: OCR success → suppress the wall (rescued, wall is pure misdirection); OCR empty/failure → emit it (user genuinely needs to act). Orthogonal to the parent KHY_VISION_FAILURE_SUMMARY (which decides whether the wall's TEXT is an honest summary at all).。
  - 验证：`npm run test:one -- services/backend/tests/services/gateway/visionFailureSummary.test.js services/backend/tests/gateway/visionFailureSummaryOcrSuppressWiring.test.js services/backend/tests/gateway/visionFailureSummaryOcrSuppressRealImage.test.js`

**367.** 验证「Text-only-model Image OCR Fallback — DEFER the vision-failure WALL until the OCR outcome is known (OPS-MAN-142; 承 OPS-138/140, directly serving '减少显示的心灵噪音'). Reproduced 2026-07-12 (paste-cache 92c0154d): text-only model + image → describe-and-return cascade to vision models all fail → aiGatewayGenerateMethod EAGERLY emitAssistantMessage's the scary failure WALL (buildVisionFailureMessage, '图像识别失败…粘贴 GLM API Key') at ~line 1590 BEFORE OCR fallback runs. When the image is a TEXT image and local OCR then SUCCEEDS reading it, that scary wall was ALREADY shown to the user — self-CONTRADICTORY with the immediately-following '已用 OCR 成功识别' and the loudest 心灵噪音 in the log. This area DEFERS the wall's emission to after the OCR result is known: OCR success → suppress the wall (rescued, wall is pure misdirection); OCR empty/failure → emit it (user genuinely needs to act). Orthogonal to the parent KHY_VISION_FAILURE_SUMMARY (which decides whether the wall's TEXT is an honest summary at all).」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Text-only-model Image OCR Fallback — DEFER the vision-failure WALL until the OCR outcome is known (OPS-MAN-142; 承 OPS-138/140, directly serving '减少显示的心灵噪音'). Reproduced 2026-07-12 (paste-cache 92c0154d): text-only model + image → describe-and-return cascade to vision models all fail → aiGatewayGenerateMethod EAGERLY emitAssistantMessage's the scary failure WALL (buildVisionFailureMessage, '图像识别失败…粘贴 GLM API Key') at ~line 1590 BEFORE OCR fallback runs. When the image is a TEXT image and local OCR then SUCCEEDS reading it, that scary wall was ALREADY shown to the user — self-CONTRADICTORY with the immediately-following '已用 OCR 成功识别' and the loudest 心灵噪音 in the log. This area DEFERS the wall's emission to after the OCR result is known: OCR success → suppress the wall (rescued, wall is pure misdirection); OCR empty/failure → emit it (user genuinely needs to act). Orthogonal to the parent KHY_VISION_FAILURE_SUMMARY (which decides whether the wall's TEXT is an honest summary at all).。
  - 验证：`node --check services/backend/src/services/gateway/visionFailureSummary.js`

**368.** 验证「Text-only-model Image OCR Fallback — DEFER the vision-failure WALL until the OCR outcome is known (OPS-MAN-142; 承 OPS-138/140, directly serving '减少显示的心灵噪音'). Reproduced 2026-07-12 (paste-cache 92c0154d): text-only model + image → describe-and-return cascade to vision models all fail → aiGatewayGenerateMethod EAGERLY emitAssistantMessage's the scary failure WALL (buildVisionFailureMessage, '图像识别失败…粘贴 GLM API Key') at ~line 1590 BEFORE OCR fallback runs. When the image is a TEXT image and local OCR then SUCCEEDS reading it, that scary wall was ALREADY shown to the user — self-CONTRADICTORY with the immediately-following '已用 OCR 成功识别' and the loudest 心灵噪音 in the log. This area DEFERS the wall's emission to after the OCR result is known: OCR success → suppress the wall (rescued, wall is pure misdirection); OCR empty/failure → emit it (user genuinely needs to act). Orthogonal to the parent KHY_VISION_FAILURE_SUMMARY (which decides whether the wall's TEXT is an honest summary at all).」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Text-only-model Image OCR Fallback — DEFER the vision-failure WALL until the OCR outcome is known (OPS-MAN-142; 承 OPS-138/140, directly serving '减少显示的心灵噪音'). Reproduced 2026-07-12 (paste-cache 92c0154d): text-only model + image → describe-and-return cascade to vision models all fail → aiGatewayGenerateMethod EAGERLY emitAssistantMessage's the scary failure WALL (buildVisionFailureMessage, '图像识别失败…粘贴 GLM API Key') at ~line 1590 BEFORE OCR fallback runs. When the image is a TEXT image and local OCR then SUCCEEDS reading it, that scary wall was ALREADY shown to the user — self-CONTRADICTORY with the immediately-following '已用 OCR 成功识别' and the loudest 心灵噪音 in the log. This area DEFERS the wall's emission to after the OCR result is known: OCR success → suppress the wall (rescued, wall is pure misdirection); OCR empty/failure → emit it (user genuinely needs to act). Orthogonal to the parent KHY_VISION_FAILURE_SUMMARY (which decides whether the wall's TEXT is an honest summary at all).。
  - 验证：`node --check services/backend/src/services/gateway/aiGatewayGenerateMethod.js`

**369.** 验证「Text-only-model Image OCR Fallback — user-visible CLOSURE when describe-fail → OCR-SUCCESS (OPS-MAN-144; 承 OPS-142, directly serving '无感明显告知用户用了 ocr' + '减少显示的心灵噪音'). KHY_VISION_INTERMEDIATE_MESSAGE emits a '正在调用 <vision-model>，请稍候...' PROMISE before EACH vision candidate, and on describe-SUCCESS closes it at line ~1554 with '视觉识别完成，正在根据识别结果为您作答'. But when all vision models fail and local OCR then SUCCEEDS, those N '请稍候' promises are NEVER closed — the user sees N dangling promises with no '识别完成', both 心灵噪音 AND a missed 'used OCR' disclosure. This area appends ONE closure '视觉模型均不可用，已改用本地 OCR 成功识别<N 张>图片，正在据此作答' in the OCR-success fallback branch: closes the dangling promises AND unobtrusively-yet-clearly discloses the OCR downgrade at the intermediate-message layer. Shares the _intermediateEnabled precondition (off → whole thing silent); own gate KHY_VISION_OCR_SUCCESS_CLOSURE off → byte-revert (no closure). Orthogonal to OPS-142 (that suppresses the failure WALL; this closes the dangling PROMISES).」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Text-only-model Image OCR Fallback — user-visible CLOSURE when describe-fail → OCR-SUCCESS (OPS-MAN-144; 承 OPS-142, directly serving '无感明显告知用户用了 ocr' + '减少显示的心灵噪音'). KHY_VISION_INTERMEDIATE_MESSAGE emits a '正在调用 <vision-model>，请稍候...' PROMISE before EACH vision candidate, and on describe-SUCCESS closes it at line ~1554 with '视觉识别完成，正在根据识别结果为您作答'. But when all vision models fail and local OCR then SUCCEEDS, those N '请稍候' promises are NEVER closed — the user sees N dangling promises with no '识别完成', both 心灵噪音 AND a missed 'used OCR' disclosure. This area appends ONE closure '视觉模型均不可用，已改用本地 OCR 成功识别<N 张>图片，正在据此作答' in the OCR-success fallback branch: closes the dangling promises AND unobtrusively-yet-clearly discloses the OCR downgrade at the intermediate-message layer. Shares the _intermediateEnabled precondition (off → whole thing silent); own gate KHY_VISION_OCR_SUCCESS_CLOSURE off → byte-revert (no closure). Orthogonal to OPS-142 (that suppresses the failure WALL; this closes the dangling PROMISES).。
  - 验证：`npm run test:one -- services/backend/tests/services/gateway/visionOcrSuccessClosure.test.js services/backend/tests/gateway/visionOcrSuccessClosureWiring.test.js services/backend/tests/gateway/visionOcrSuccessClosureRealImage.test.js`

**370.** 验证「Text-only-model Image OCR Fallback — user-visible CLOSURE when describe-fail → OCR-SUCCESS (OPS-MAN-144; 承 OPS-142, directly serving '无感明显告知用户用了 ocr' + '减少显示的心灵噪音'). KHY_VISION_INTERMEDIATE_MESSAGE emits a '正在调用 <vision-model>，请稍候...' PROMISE before EACH vision candidate, and on describe-SUCCESS closes it at line ~1554 with '视觉识别完成，正在根据识别结果为您作答'. But when all vision models fail and local OCR then SUCCEEDS, those N '请稍候' promises are NEVER closed — the user sees N dangling promises with no '识别完成', both 心灵噪音 AND a missed 'used OCR' disclosure. This area appends ONE closure '视觉模型均不可用，已改用本地 OCR 成功识别<N 张>图片，正在据此作答' in the OCR-success fallback branch: closes the dangling promises AND unobtrusively-yet-clearly discloses the OCR downgrade at the intermediate-message layer. Shares the _intermediateEnabled precondition (off → whole thing silent); own gate KHY_VISION_OCR_SUCCESS_CLOSURE off → byte-revert (no closure). Orthogonal to OPS-142 (that suppresses the failure WALL; this closes the dangling PROMISES).」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Text-only-model Image OCR Fallback — user-visible CLOSURE when describe-fail → OCR-SUCCESS (OPS-MAN-144; 承 OPS-142, directly serving '无感明显告知用户用了 ocr' + '减少显示的心灵噪音'). KHY_VISION_INTERMEDIATE_MESSAGE emits a '正在调用 <vision-model>，请稍候...' PROMISE before EACH vision candidate, and on describe-SUCCESS closes it at line ~1554 with '视觉识别完成，正在根据识别结果为您作答'. But when all vision models fail and local OCR then SUCCEEDS, those N '请稍候' promises are NEVER closed — the user sees N dangling promises with no '识别完成', both 心灵噪音 AND a missed 'used OCR' disclosure. This area appends ONE closure '视觉模型均不可用，已改用本地 OCR 成功识别<N 张>图片，正在据此作答' in the OCR-success fallback branch: closes the dangling promises AND unobtrusively-yet-clearly discloses the OCR downgrade at the intermediate-message layer. Shares the _intermediateEnabled precondition (off → whole thing silent); own gate KHY_VISION_OCR_SUCCESS_CLOSURE off → byte-revert (no closure). Orthogonal to OPS-142 (that suppresses the failure WALL; this closes the dangling PROMISES).。
  - 验证：`node --check services/backend/src/services/gateway/visionOcrSuccessClosure.js`

**371.** 验证「Text-only-model Image OCR Fallback — user-visible CLOSURE when describe-fail → OCR-SUCCESS (OPS-MAN-144; 承 OPS-142, directly serving '无感明显告知用户用了 ocr' + '减少显示的心灵噪音'). KHY_VISION_INTERMEDIATE_MESSAGE emits a '正在调用 <vision-model>，请稍候...' PROMISE before EACH vision candidate, and on describe-SUCCESS closes it at line ~1554 with '视觉识别完成，正在根据识别结果为您作答'. But when all vision models fail and local OCR then SUCCEEDS, those N '请稍候' promises are NEVER closed — the user sees N dangling promises with no '识别完成', both 心灵噪音 AND a missed 'used OCR' disclosure. This area appends ONE closure '视觉模型均不可用，已改用本地 OCR 成功识别<N 张>图片，正在据此作答' in the OCR-success fallback branch: closes the dangling promises AND unobtrusively-yet-clearly discloses the OCR downgrade at the intermediate-message layer. Shares the _intermediateEnabled precondition (off → whole thing silent); own gate KHY_VISION_OCR_SUCCESS_CLOSURE off → byte-revert (no closure). Orthogonal to OPS-142 (that suppresses the failure WALL; this closes the dangling PROMISES).」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Text-only-model Image OCR Fallback — user-visible CLOSURE when describe-fail → OCR-SUCCESS (OPS-MAN-144; 承 OPS-142, directly serving '无感明显告知用户用了 ocr' + '减少显示的心灵噪音'). KHY_VISION_INTERMEDIATE_MESSAGE emits a '正在调用 <vision-model>，请稍候...' PROMISE before EACH vision candidate, and on describe-SUCCESS closes it at line ~1554 with '视觉识别完成，正在根据识别结果为您作答'. But when all vision models fail and local OCR then SUCCEEDS, those N '请稍候' promises are NEVER closed — the user sees N dangling promises with no '识别完成', both 心灵噪音 AND a missed 'used OCR' disclosure. This area appends ONE closure '视觉模型均不可用，已改用本地 OCR 成功识别<N 张>图片，正在据此作答' in the OCR-success fallback branch: closes the dangling promises AND unobtrusively-yet-clearly discloses the OCR downgrade at the intermediate-message layer. Shares the _intermediateEnabled precondition (off → whole thing silent); own gate KHY_VISION_OCR_SUCCESS_CLOSURE off → byte-revert (no closure). Orthogonal to OPS-142 (that suppresses the failure WALL; this closes the dangling PROMISES).。
  - 验证：`node --check services/backend/src/services/gateway/aiGatewayGenerateMethod.js`

**372.** 验证「Text-only-model Image OCR Fallback — de-duplicate the per-candidate '正在调用...请稍候' cascade notices (OPS-MAN-145; 承 OPS-144, directly serving '减少显示的心灵噪音'). When KHY_VISION_FALLBACK_CASCADE is on, the describe-and-return loop tries multiple vision candidates (built-in GLM pin → glm-4.6v-flash, glm-4v-flash, plus provider vision models). With KHY_VISION_INTERMEDIATE_MESSAGE on, EACH candidate previously emitted the byte-identical first sentence '我无法直接识别图片内容。正在调用 <model> 进行识别，请稍候...' — the redundant preamble '我无法直接识别图片内容' repeated N times, and candidates 2..N read like fresh parallel calls rather than a cascade fallback. This area makes the notice index-aware: candidate #1 keeps the FULL legacy preamble (byte-identical), candidates 2..N collapse to '视觉模型 <prev> 不可用，正在改用 <model> 继续识别...' — drops the redundant preamble, states the cascade nature, symmetric to the success-side reframe. Shares the _intermediateEnabled precondition (off → whole thing silent); own gate KHY_VISION_CASCADE_ATTEMPT_NOTICE off → every candidate byte-reverts to the full legacy preamble. Orthogonal to OPS-144 (that closes the dangling promises on OCR success; this de-duplicates the per-candidate promises themselves).」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Text-only-model Image OCR Fallback — de-duplicate the per-candidate '正在调用...请稍候' cascade notices (OPS-MAN-145; 承 OPS-144, directly serving '减少显示的心灵噪音'). When KHY_VISION_FALLBACK_CASCADE is on, the describe-and-return loop tries multiple vision candidates (built-in GLM pin → glm-4.6v-flash, glm-4v-flash, plus provider vision models). With KHY_VISION_INTERMEDIATE_MESSAGE on, EACH candidate previously emitted the byte-identical first sentence '我无法直接识别图片内容。正在调用 <model> 进行识别，请稍候...' — the redundant preamble '我无法直接识别图片内容' repeated N times, and candidates 2..N read like fresh parallel calls rather than a cascade fallback. This area makes the notice index-aware: candidate #1 keeps the FULL legacy preamble (byte-identical), candidates 2..N collapse to '视觉模型 <prev> 不可用，正在改用 <model> 继续识别...' — drops the redundant preamble, states the cascade nature, symmetric to the success-side reframe. Shares the _intermediateEnabled precondition (off → whole thing silent); own gate KHY_VISION_CASCADE_ATTEMPT_NOTICE off → every candidate byte-reverts to the full legacy preamble. Orthogonal to OPS-144 (that closes the dangling promises on OCR success; this de-duplicates the per-candidate promises themselves).。
  - 验证：`npm run test:one -- services/backend/tests/services/gateway/visionCascadeAttemptNotice.test.js services/backend/tests/gateway/visionCascadeAttemptNoticeWiring.test.js services/backend/tests/gateway/visionCascadeAttemptNoticeRealImage.test.js`

**373.** 验证「Text-only-model Image OCR Fallback — de-duplicate the per-candidate '正在调用...请稍候' cascade notices (OPS-MAN-145; 承 OPS-144, directly serving '减少显示的心灵噪音'). When KHY_VISION_FALLBACK_CASCADE is on, the describe-and-return loop tries multiple vision candidates (built-in GLM pin → glm-4.6v-flash, glm-4v-flash, plus provider vision models). With KHY_VISION_INTERMEDIATE_MESSAGE on, EACH candidate previously emitted the byte-identical first sentence '我无法直接识别图片内容。正在调用 <model> 进行识别，请稍候...' — the redundant preamble '我无法直接识别图片内容' repeated N times, and candidates 2..N read like fresh parallel calls rather than a cascade fallback. This area makes the notice index-aware: candidate #1 keeps the FULL legacy preamble (byte-identical), candidates 2..N collapse to '视觉模型 <prev> 不可用，正在改用 <model> 继续识别...' — drops the redundant preamble, states the cascade nature, symmetric to the success-side reframe. Shares the _intermediateEnabled precondition (off → whole thing silent); own gate KHY_VISION_CASCADE_ATTEMPT_NOTICE off → every candidate byte-reverts to the full legacy preamble. Orthogonal to OPS-144 (that closes the dangling promises on OCR success; this de-duplicates the per-candidate promises themselves).」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Text-only-model Image OCR Fallback — de-duplicate the per-candidate '正在调用...请稍候' cascade notices (OPS-MAN-145; 承 OPS-144, directly serving '减少显示的心灵噪音'). When KHY_VISION_FALLBACK_CASCADE is on, the describe-and-return loop tries multiple vision candidates (built-in GLM pin → glm-4.6v-flash, glm-4v-flash, plus provider vision models). With KHY_VISION_INTERMEDIATE_MESSAGE on, EACH candidate previously emitted the byte-identical first sentence '我无法直接识别图片内容。正在调用 <model> 进行识别，请稍候...' — the redundant preamble '我无法直接识别图片内容' repeated N times, and candidates 2..N read like fresh parallel calls rather than a cascade fallback. This area makes the notice index-aware: candidate #1 keeps the FULL legacy preamble (byte-identical), candidates 2..N collapse to '视觉模型 <prev> 不可用，正在改用 <model> 继续识别...' — drops the redundant preamble, states the cascade nature, symmetric to the success-side reframe. Shares the _intermediateEnabled precondition (off → whole thing silent); own gate KHY_VISION_CASCADE_ATTEMPT_NOTICE off → every candidate byte-reverts to the full legacy preamble. Orthogonal to OPS-144 (that closes the dangling promises on OCR success; this de-duplicates the per-candidate promises themselves).。
  - 验证：`node --check services/backend/src/services/gateway/visionCascadeAttemptNotice.js`

**374.** 验证「Text-only-model Image OCR Fallback — de-duplicate the per-candidate '正在调用...请稍候' cascade notices (OPS-MAN-145; 承 OPS-144, directly serving '减少显示的心灵噪音'). When KHY_VISION_FALLBACK_CASCADE is on, the describe-and-return loop tries multiple vision candidates (built-in GLM pin → glm-4.6v-flash, glm-4v-flash, plus provider vision models). With KHY_VISION_INTERMEDIATE_MESSAGE on, EACH candidate previously emitted the byte-identical first sentence '我无法直接识别图片内容。正在调用 <model> 进行识别，请稍候...' — the redundant preamble '我无法直接识别图片内容' repeated N times, and candidates 2..N read like fresh parallel calls rather than a cascade fallback. This area makes the notice index-aware: candidate #1 keeps the FULL legacy preamble (byte-identical), candidates 2..N collapse to '视觉模型 <prev> 不可用，正在改用 <model> 继续识别...' — drops the redundant preamble, states the cascade nature, symmetric to the success-side reframe. Shares the _intermediateEnabled precondition (off → whole thing silent); own gate KHY_VISION_CASCADE_ATTEMPT_NOTICE off → every candidate byte-reverts to the full legacy preamble. Orthogonal to OPS-144 (that closes the dangling promises on OCR success; this de-duplicates the per-candidate promises themselves).」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Text-only-model Image OCR Fallback — de-duplicate the per-candidate '正在调用...请稍候' cascade notices (OPS-MAN-145; 承 OPS-144, directly serving '减少显示的心灵噪音'). When KHY_VISION_FALLBACK_CASCADE is on, the describe-and-return loop tries multiple vision candidates (built-in GLM pin → glm-4.6v-flash, glm-4v-flash, plus provider vision models). With KHY_VISION_INTERMEDIATE_MESSAGE on, EACH candidate previously emitted the byte-identical first sentence '我无法直接识别图片内容。正在调用 <model> 进行识别，请稍候...' — the redundant preamble '我无法直接识别图片内容' repeated N times, and candidates 2..N read like fresh parallel calls rather than a cascade fallback. This area makes the notice index-aware: candidate #1 keeps the FULL legacy preamble (byte-identical), candidates 2..N collapse to '视觉模型 <prev> 不可用，正在改用 <model> 继续识别...' — drops the redundant preamble, states the cascade nature, symmetric to the success-side reframe. Shares the _intermediateEnabled precondition (off → whole thing silent); own gate KHY_VISION_CASCADE_ATTEMPT_NOTICE off → every candidate byte-reverts to the full legacy preamble. Orthogonal to OPS-144 (that closes the dangling promises on OCR success; this de-duplicates the per-candidate promises themselves).。
  - 验证：`node --check services/backend/src/services/gateway/aiGatewayGenerateMethod.js`

**375.** 验证「Text-only-model Image OCR Fallback — strip provider ROUTING PREFIX from vision model names in user-facing cascade notices (OPS-MAN-150; 承 OPS-145, directly serving '减少显示的心灵噪音'). On the reported OCR-fallback path the cascade's first attempt (_attempts[0] = decision.model = the switched-to-pinned vision model) keeps its provider routing prefix 'glm/glm-4.6v-flash' (prefix drives internal poolHint resolution), while all sibling candidates from collectVisionFallbackCandidates are BARE ids (glm-4v-flash, gpt-5.3-codex-review, claude-opus-4-6). So OPS-145's per-candidate '正在调用...请稍候' notices leaked the raw internal routing id 'glm/glm-4.6v-flash' into user prose for candidates [0]/[1] — inconsistent with every other bare line = mental noise leaking internal routing detail. FIX: a tiny pure leaf visionModelDisplayName.toDisplayModelName(model, env) strips the segment before the last '/' PRESERVING CASE (does NOT reuse _bareId, which is dedup-only and lowercases). Wired ONLY at the DISPLAY boundary: aiGatewayGenerateMethod normalizes model/prevModel just before buildCascadeAttemptNotice; internal _att.model/_prevAttemptModel routing state is UNTOUCHED (poolHint still resolves from the original prefixed id). Gate KHY_VISION_MODEL_DISPLAY_NAME default-on; off → byte-revert (prefix returns verbatim). Orthogonal to OPS-145 (which folds the repeated first sentence) — this folds the leaked prefix.」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Text-only-model Image OCR Fallback — strip provider ROUTING PREFIX from vision model names in user-facing cascade notices (OPS-MAN-150; 承 OPS-145, directly serving '减少显示的心灵噪音'). On the reported OCR-fallback path the cascade's first attempt (_attempts[0] = decision.model = the switched-to-pinned vision model) keeps its provider routing prefix 'glm/glm-4.6v-flash' (prefix drives internal poolHint resolution), while all sibling candidates from collectVisionFallbackCandidates are BARE ids (glm-4v-flash, gpt-5.3-codex-review, claude-opus-4-6). So OPS-145's per-candidate '正在调用...请稍候' notices leaked the raw internal routing id 'glm/glm-4.6v-flash' into user prose for candidates [0]/[1] — inconsistent with every other bare line = mental noise leaking internal routing detail. FIX: a tiny pure leaf visionModelDisplayName.toDisplayModelName(model, env) strips the segment before the last '/' PRESERVING CASE (does NOT reuse _bareId, which is dedup-only and lowercases). Wired ONLY at the DISPLAY boundary: aiGatewayGenerateMethod normalizes model/prevModel just before buildCascadeAttemptNotice; internal _att.model/_prevAttemptModel routing state is UNTOUCHED (poolHint still resolves from the original prefixed id). Gate KHY_VISION_MODEL_DISPLAY_NAME default-on; off → byte-revert (prefix returns verbatim). Orthogonal to OPS-145 (which folds the repeated first sentence) — this folds the leaked prefix.。
  - 验证：`npm run test:one -- services/backend/tests/services/gateway/visionModelDisplayName.test.js services/backend/tests/gateway/visionModelDisplayNameWiring.test.js services/backend/tests/gateway/visionModelDisplayNameRealImage.test.js`

**376.** 验证「Text-only-model Image OCR Fallback — strip provider ROUTING PREFIX from vision model names in user-facing cascade notices (OPS-MAN-150; 承 OPS-145, directly serving '减少显示的心灵噪音'). On the reported OCR-fallback path the cascade's first attempt (_attempts[0] = decision.model = the switched-to-pinned vision model) keeps its provider routing prefix 'glm/glm-4.6v-flash' (prefix drives internal poolHint resolution), while all sibling candidates from collectVisionFallbackCandidates are BARE ids (glm-4v-flash, gpt-5.3-codex-review, claude-opus-4-6). So OPS-145's per-candidate '正在调用...请稍候' notices leaked the raw internal routing id 'glm/glm-4.6v-flash' into user prose for candidates [0]/[1] — inconsistent with every other bare line = mental noise leaking internal routing detail. FIX: a tiny pure leaf visionModelDisplayName.toDisplayModelName(model, env) strips the segment before the last '/' PRESERVING CASE (does NOT reuse _bareId, which is dedup-only and lowercases). Wired ONLY at the DISPLAY boundary: aiGatewayGenerateMethod normalizes model/prevModel just before buildCascadeAttemptNotice; internal _att.model/_prevAttemptModel routing state is UNTOUCHED (poolHint still resolves from the original prefixed id). Gate KHY_VISION_MODEL_DISPLAY_NAME default-on; off → byte-revert (prefix returns verbatim). Orthogonal to OPS-145 (which folds the repeated first sentence) — this folds the leaked prefix.」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Text-only-model Image OCR Fallback — strip provider ROUTING PREFIX from vision model names in user-facing cascade notices (OPS-MAN-150; 承 OPS-145, directly serving '减少显示的心灵噪音'). On the reported OCR-fallback path the cascade's first attempt (_attempts[0] = decision.model = the switched-to-pinned vision model) keeps its provider routing prefix 'glm/glm-4.6v-flash' (prefix drives internal poolHint resolution), while all sibling candidates from collectVisionFallbackCandidates are BARE ids (glm-4v-flash, gpt-5.3-codex-review, claude-opus-4-6). So OPS-145's per-candidate '正在调用...请稍候' notices leaked the raw internal routing id 'glm/glm-4.6v-flash' into user prose for candidates [0]/[1] — inconsistent with every other bare line = mental noise leaking internal routing detail. FIX: a tiny pure leaf visionModelDisplayName.toDisplayModelName(model, env) strips the segment before the last '/' PRESERVING CASE (does NOT reuse _bareId, which is dedup-only and lowercases). Wired ONLY at the DISPLAY boundary: aiGatewayGenerateMethod normalizes model/prevModel just before buildCascadeAttemptNotice; internal _att.model/_prevAttemptModel routing state is UNTOUCHED (poolHint still resolves from the original prefixed id). Gate KHY_VISION_MODEL_DISPLAY_NAME default-on; off → byte-revert (prefix returns verbatim). Orthogonal to OPS-145 (which folds the repeated first sentence) — this folds the leaked prefix.。
  - 验证：`node --check services/backend/src/services/gateway/visionModelDisplayName.js`

**377.** 验证「Text-only-model Image OCR Fallback — strip provider ROUTING PREFIX from vision model names in user-facing cascade notices (OPS-MAN-150; 承 OPS-145, directly serving '减少显示的心灵噪音'). On the reported OCR-fallback path the cascade's first attempt (_attempts[0] = decision.model = the switched-to-pinned vision model) keeps its provider routing prefix 'glm/glm-4.6v-flash' (prefix drives internal poolHint resolution), while all sibling candidates from collectVisionFallbackCandidates are BARE ids (glm-4v-flash, gpt-5.3-codex-review, claude-opus-4-6). So OPS-145's per-candidate '正在调用...请稍候' notices leaked the raw internal routing id 'glm/glm-4.6v-flash' into user prose for candidates [0]/[1] — inconsistent with every other bare line = mental noise leaking internal routing detail. FIX: a tiny pure leaf visionModelDisplayName.toDisplayModelName(model, env) strips the segment before the last '/' PRESERVING CASE (does NOT reuse _bareId, which is dedup-only and lowercases). Wired ONLY at the DISPLAY boundary: aiGatewayGenerateMethod normalizes model/prevModel just before buildCascadeAttemptNotice; internal _att.model/_prevAttemptModel routing state is UNTOUCHED (poolHint still resolves from the original prefixed id). Gate KHY_VISION_MODEL_DISPLAY_NAME default-on; off → byte-revert (prefix returns verbatim). Orthogonal to OPS-145 (which folds the repeated first sentence) — this folds the leaked prefix.」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Text-only-model Image OCR Fallback — strip provider ROUTING PREFIX from vision model names in user-facing cascade notices (OPS-MAN-150; 承 OPS-145, directly serving '减少显示的心灵噪音'). On the reported OCR-fallback path the cascade's first attempt (_attempts[0] = decision.model = the switched-to-pinned vision model) keeps its provider routing prefix 'glm/glm-4.6v-flash' (prefix drives internal poolHint resolution), while all sibling candidates from collectVisionFallbackCandidates are BARE ids (glm-4v-flash, gpt-5.3-codex-review, claude-opus-4-6). So OPS-145's per-candidate '正在调用...请稍候' notices leaked the raw internal routing id 'glm/glm-4.6v-flash' into user prose for candidates [0]/[1] — inconsistent with every other bare line = mental noise leaking internal routing detail. FIX: a tiny pure leaf visionModelDisplayName.toDisplayModelName(model, env) strips the segment before the last '/' PRESERVING CASE (does NOT reuse _bareId, which is dedup-only and lowercases). Wired ONLY at the DISPLAY boundary: aiGatewayGenerateMethod normalizes model/prevModel just before buildCascadeAttemptNotice; internal _att.model/_prevAttemptModel routing state is UNTOUCHED (poolHint still resolves from the original prefixed id). Gate KHY_VISION_MODEL_DISPLAY_NAME default-on; off → byte-revert (prefix returns verbatim). Orthogonal to OPS-145 (which folds the repeated first sentence) — this folds the leaked prefix.。
  - 验证：`node --check services/backend/src/services/gateway/aiGatewayGenerateMethod.js`

**378.** 验证「Text-only-model Image OCR Fallback — strip provider ROUTING PREFIX from the vision model name in the FAILURE-SUMMARY wall too (OPS-MAN-159; 承 OPS-150, directly serving '减少显示的心灵噪音'). OPS-150 normalized the model name ONLY in the per-candidate cascade notices (buildCascadeAttemptNotice); the failure-summary wall (visionFailureSummary.buildVisionFailureMessage) has its OWN line '本次尝试的视觉模型:<model>' fed by the caller's _primaryModel = decision.model, which retains the 'glm/' routing prefix → the wall still leaked '本次尝试的视觉模型:glm/glm-4.6v-flash' inconsistently with the already-normalized cascade notices. This wall is user-visible when the vision cascade fully fails AND local OCR reads NO text (photos/screenshots/missing OCR langpack); on OCR-success it is suppressed by OPS-142 (_deferredFailureMsg). FIX: reuse OPS-150's pure leaf visionModelDisplayName.toDisplayModelName at the wall's DISPLAY boundary inside buildVisionFailureMessage (centralized so ALL callers — cascade path + recognizeImage.js tool — benefit), gated by the SAME flag KHY_VISION_MODEL_DISPLAY_NAME (default-on); off / leaf-unavailable → returns the raw prefixed id → byte-revert '本次尝试的视觉模型:glm/glm-4.6v-flash。'. Internal routing (_primaryModel/poolHint) UNTOUCHED. Orthogonal to OPS-150 (different emit site: the wall, not the notices).」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Text-only-model Image OCR Fallback — strip provider ROUTING PREFIX from the vision model name in the FAILURE-SUMMARY wall too (OPS-MAN-159; 承 OPS-150, directly serving '减少显示的心灵噪音'). OPS-150 normalized the model name ONLY in the per-candidate cascade notices (buildCascadeAttemptNotice); the failure-summary wall (visionFailureSummary.buildVisionFailureMessage) has its OWN line '本次尝试的视觉模型:<model>' fed by the caller's _primaryModel = decision.model, which retains the 'glm/' routing prefix → the wall still leaked '本次尝试的视觉模型:glm/glm-4.6v-flash' inconsistently with the already-normalized cascade notices. This wall is user-visible when the vision cascade fully fails AND local OCR reads NO text (photos/screenshots/missing OCR langpack); on OCR-success it is suppressed by OPS-142 (_deferredFailureMsg). FIX: reuse OPS-150's pure leaf visionModelDisplayName.toDisplayModelName at the wall's DISPLAY boundary inside buildVisionFailureMessage (centralized so ALL callers — cascade path + recognizeImage.js tool — benefit), gated by the SAME flag KHY_VISION_MODEL_DISPLAY_NAME (default-on); off / leaf-unavailable → returns the raw prefixed id → byte-revert '本次尝试的视觉模型:glm/glm-4.6v-flash。'. Internal routing (_primaryModel/poolHint) UNTOUCHED. Orthogonal to OPS-150 (different emit site: the wall, not the notices).。
  - 验证：`npm run test:one -- services/backend/tests/gateway/visionFailureSummaryDisplayName.test.js`

**379.** 验证「Text-only-model Image OCR Fallback — strip provider ROUTING PREFIX from the vision model name in the FAILURE-SUMMARY wall too (OPS-MAN-159; 承 OPS-150, directly serving '减少显示的心灵噪音'). OPS-150 normalized the model name ONLY in the per-candidate cascade notices (buildCascadeAttemptNotice); the failure-summary wall (visionFailureSummary.buildVisionFailureMessage) has its OWN line '本次尝试的视觉模型:<model>' fed by the caller's _primaryModel = decision.model, which retains the 'glm/' routing prefix → the wall still leaked '本次尝试的视觉模型:glm/glm-4.6v-flash' inconsistently with the already-normalized cascade notices. This wall is user-visible when the vision cascade fully fails AND local OCR reads NO text (photos/screenshots/missing OCR langpack); on OCR-success it is suppressed by OPS-142 (_deferredFailureMsg). FIX: reuse OPS-150's pure leaf visionModelDisplayName.toDisplayModelName at the wall's DISPLAY boundary inside buildVisionFailureMessage (centralized so ALL callers — cascade path + recognizeImage.js tool — benefit), gated by the SAME flag KHY_VISION_MODEL_DISPLAY_NAME (default-on); off / leaf-unavailable → returns the raw prefixed id → byte-revert '本次尝试的视觉模型:glm/glm-4.6v-flash。'. Internal routing (_primaryModel/poolHint) UNTOUCHED. Orthogonal to OPS-150 (different emit site: the wall, not the notices).」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Text-only-model Image OCR Fallback — strip provider ROUTING PREFIX from the vision model name in the FAILURE-SUMMARY wall too (OPS-MAN-159; 承 OPS-150, directly serving '减少显示的心灵噪音'). OPS-150 normalized the model name ONLY in the per-candidate cascade notices (buildCascadeAttemptNotice); the failure-summary wall (visionFailureSummary.buildVisionFailureMessage) has its OWN line '本次尝试的视觉模型:<model>' fed by the caller's _primaryModel = decision.model, which retains the 'glm/' routing prefix → the wall still leaked '本次尝试的视觉模型:glm/glm-4.6v-flash' inconsistently with the already-normalized cascade notices. This wall is user-visible when the vision cascade fully fails AND local OCR reads NO text (photos/screenshots/missing OCR langpack); on OCR-success it is suppressed by OPS-142 (_deferredFailureMsg). FIX: reuse OPS-150's pure leaf visionModelDisplayName.toDisplayModelName at the wall's DISPLAY boundary inside buildVisionFailureMessage (centralized so ALL callers — cascade path + recognizeImage.js tool — benefit), gated by the SAME flag KHY_VISION_MODEL_DISPLAY_NAME (default-on); off / leaf-unavailable → returns the raw prefixed id → byte-revert '本次尝试的视觉模型:glm/glm-4.6v-flash。'. Internal routing (_primaryModel/poolHint) UNTOUCHED. Orthogonal to OPS-150 (different emit site: the wall, not the notices).。
  - 验证：`node --check services/backend/src/services/gateway/visionFailureSummary.js`

**380.** 验证「Text-only-model Image OCR Fallback — dedup the '真实失败原因:' LABEL on the failure-summary wall (OPS-MAN-161; 承 OPS-159, directly serving '减少显示的心灵噪音'). This is the GAP flagged in the OPS-159 area's whenToUse: when a describe sub-call fails, gateway's aiGateway._buildFailureReasonSection prepends '真实失败原因:\n<真因…>', that string becomes _lastRawError → fed to buildVisionFailureMessage as rawError → cause = sanitizeCause(rawError) preserves the self-carried '真实失败原因:' label → the wall's cause push (真实失败原因:${cause}) prepends it a SECOND time = '真实失败原因:真实失败原因:…' stutter. aiGateway._prependFailureReason already has the same-intent guard `if(/真实失败原因/.test(body)) return body`; the wall historically missed the equivalent. FIX: gate KHY_VISION_FAILURE_CAUSE_DEDUP (default-on) — if cause already begins with the label (half- or full-width colon), strip the self-carried label so it appears exactly once; gate-off / exception → byte-revert to the doubled behavior. Orthogonal to OPS-159 (model-name prefix) and KHY_VISION_FAILURE_SUMMARY (whether the wall exists at all) on the SAME wall.」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Text-only-model Image OCR Fallback — dedup the '真实失败原因:' LABEL on the failure-summary wall (OPS-MAN-161; 承 OPS-159, directly serving '减少显示的心灵噪音'). This is the GAP flagged in the OPS-159 area's whenToUse: when a describe sub-call fails, gateway's aiGateway._buildFailureReasonSection prepends '真实失败原因:\n<真因…>', that string becomes _lastRawError → fed to buildVisionFailureMessage as rawError → cause = sanitizeCause(rawError) preserves the self-carried '真实失败原因:' label → the wall's cause push (真实失败原因:${cause}) prepends it a SECOND time = '真实失败原因:真实失败原因:…' stutter. aiGateway._prependFailureReason already has the same-intent guard `if(/真实失败原因/.test(body)) return body`; the wall historically missed the equivalent. FIX: gate KHY_VISION_FAILURE_CAUSE_DEDUP (default-on) — if cause already begins with the label (half- or full-width colon), strip the self-carried label so it appears exactly once; gate-off / exception → byte-revert to the doubled behavior. Orthogonal to OPS-159 (model-name prefix) and KHY_VISION_FAILURE_SUMMARY (whether the wall exists at all) on the SAME wall.。
  - 验证：`npm run test:one -- services/backend/tests/gateway/visionFailureCauseDedup.test.js`

**381.** 验证「Text-only-model Image OCR Fallback — dedup the '真实失败原因:' LABEL on the failure-summary wall (OPS-MAN-161; 承 OPS-159, directly serving '减少显示的心灵噪音'). This is the GAP flagged in the OPS-159 area's whenToUse: when a describe sub-call fails, gateway's aiGateway._buildFailureReasonSection prepends '真实失败原因:\n<真因…>', that string becomes _lastRawError → fed to buildVisionFailureMessage as rawError → cause = sanitizeCause(rawError) preserves the self-carried '真实失败原因:' label → the wall's cause push (真实失败原因:${cause}) prepends it a SECOND time = '真实失败原因:真实失败原因:…' stutter. aiGateway._prependFailureReason already has the same-intent guard `if(/真实失败原因/.test(body)) return body`; the wall historically missed the equivalent. FIX: gate KHY_VISION_FAILURE_CAUSE_DEDUP (default-on) — if cause already begins with the label (half- or full-width colon), strip the self-carried label so it appears exactly once; gate-off / exception → byte-revert to the doubled behavior. Orthogonal to OPS-159 (model-name prefix) and KHY_VISION_FAILURE_SUMMARY (whether the wall exists at all) on the SAME wall.」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Text-only-model Image OCR Fallback — dedup the '真实失败原因:' LABEL on the failure-summary wall (OPS-MAN-161; 承 OPS-159, directly serving '减少显示的心灵噪音'). This is the GAP flagged in the OPS-159 area's whenToUse: when a describe sub-call fails, gateway's aiGateway._buildFailureReasonSection prepends '真实失败原因:\n<真因…>', that string becomes _lastRawError → fed to buildVisionFailureMessage as rawError → cause = sanitizeCause(rawError) preserves the self-carried '真实失败原因:' label → the wall's cause push (真实失败原因:${cause}) prepends it a SECOND time = '真实失败原因:真实失败原因:…' stutter. aiGateway._prependFailureReason already has the same-intent guard `if(/真实失败原因/.test(body)) return body`; the wall historically missed the equivalent. FIX: gate KHY_VISION_FAILURE_CAUSE_DEDUP (default-on) — if cause already begins with the label (half- or full-width colon), strip the self-carried label so it appears exactly once; gate-off / exception → byte-revert to the doubled behavior. Orthogonal to OPS-159 (model-name prefix) and KHY_VISION_FAILURE_SUMMARY (whether the wall exists at all) on the SAME wall.。
  - 验证：`node --check services/backend/src/services/gateway/visionFailureSummary.js`

**382.** 验证「Text-only-model Image OCR Fallback — humanize the vision-pool adapter-failure STATUS on the OCR-rescued path (OPS-MAN-164, directly serving '减少显示的心灵噪音'). GAP: on the vision→local-OCR-success path, the final generation loop still attempts the vision-pool adapter and 404s; aiGatewayGenerateMethod's two adapter-failure emit sites (~2589 / ~3202) print the raw diagnostic status `visionpool 失败: OpenAI: 404 model_not_found` in real time — but the image was already read by OCR and answered, so that 404 line is SECONDARY mental noise. FIX: pure leaf visionPoolFailStatus.buildVisionPoolFailStatus({poolName, ocrRescued, env}) gated by KHY_VISION_POOL_FAIL_STATUS_HUMANIZE (default-on): when gate on && ocrRescued (options._ocrImageTextRead===true) && poolName matches /vision/i → return '视觉通道当前不可用，已用本地 OCR 兜底'; else null → caller keeps its raw `${name} 失败: ${errMsg}` line (byte-revert). Genuine failures (no OCR rescue) and non-vision pools keep the actionable root-cause diagnostic. Strict predicate: ocrRescued===true (never truthy-but-not-true) and /vision/i name match.」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Text-only-model Image OCR Fallback — humanize the vision-pool adapter-failure STATUS on the OCR-rescued path (OPS-MAN-164, directly serving '减少显示的心灵噪音'). GAP: on the vision→local-OCR-success path, the final generation loop still attempts the vision-pool adapter and 404s; aiGatewayGenerateMethod's two adapter-failure emit sites (~2589 / ~3202) print the raw diagnostic status `visionpool 失败: OpenAI: 404 model_not_found` in real time — but the image was already read by OCR and answered, so that 404 line is SECONDARY mental noise. FIX: pure leaf visionPoolFailStatus.buildVisionPoolFailStatus({poolName, ocrRescued, env}) gated by KHY_VISION_POOL_FAIL_STATUS_HUMANIZE (default-on): when gate on && ocrRescued (options._ocrImageTextRead===true) && poolName matches /vision/i → return '视觉通道当前不可用，已用本地 OCR 兜底'; else null → caller keeps its raw `${name} 失败: ${errMsg}` line (byte-revert). Genuine failures (no OCR rescue) and non-vision pools keep the actionable root-cause diagnostic. Strict predicate: ocrRescued===true (never truthy-but-not-true) and /vision/i name match.。
  - 验证：`npm run test:one -- services/backend/tests/gateway/visionPoolFailStatusHumanize.test.js`

**383.** 验证「Text-only-model Image OCR Fallback — humanize the vision-pool adapter-failure STATUS on the OCR-rescued path (OPS-MAN-164, directly serving '减少显示的心灵噪音'). GAP: on the vision→local-OCR-success path, the final generation loop still attempts the vision-pool adapter and 404s; aiGatewayGenerateMethod's two adapter-failure emit sites (~2589 / ~3202) print the raw diagnostic status `visionpool 失败: OpenAI: 404 model_not_found` in real time — but the image was already read by OCR and answered, so that 404 line is SECONDARY mental noise. FIX: pure leaf visionPoolFailStatus.buildVisionPoolFailStatus({poolName, ocrRescued, env}) gated by KHY_VISION_POOL_FAIL_STATUS_HUMANIZE (default-on): when gate on && ocrRescued (options._ocrImageTextRead===true) && poolName matches /vision/i → return '视觉通道当前不可用，已用本地 OCR 兜底'; else null → caller keeps its raw `${name} 失败: ${errMsg}` line (byte-revert). Genuine failures (no OCR rescue) and non-vision pools keep the actionable root-cause diagnostic. Strict predicate: ocrRescued===true (never truthy-but-not-true) and /vision/i name match.」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Text-only-model Image OCR Fallback — humanize the vision-pool adapter-failure STATUS on the OCR-rescued path (OPS-MAN-164, directly serving '减少显示的心灵噪音'). GAP: on the vision→local-OCR-success path, the final generation loop still attempts the vision-pool adapter and 404s; aiGatewayGenerateMethod's two adapter-failure emit sites (~2589 / ~3202) print the raw diagnostic status `visionpool 失败: OpenAI: 404 model_not_found` in real time — but the image was already read by OCR and answered, so that 404 line is SECONDARY mental noise. FIX: pure leaf visionPoolFailStatus.buildVisionPoolFailStatus({poolName, ocrRescued, env}) gated by KHY_VISION_POOL_FAIL_STATUS_HUMANIZE (default-on): when gate on && ocrRescued (options._ocrImageTextRead===true) && poolName matches /vision/i → return '视觉通道当前不可用，已用本地 OCR 兜底'; else null → caller keeps its raw `${name} 失败: ${errMsg}` line (byte-revert). Genuine failures (no OCR rescue) and non-vision pools keep the actionable root-cause diagnostic. Strict predicate: ocrRescued===true (never truthy-but-not-true) and /vision/i name match.。
  - 验证：`node --check services/backend/src/services/gateway/visionPoolFailStatus.js`

**384.** 验证「Text-only-model Image OCR Fallback — DETERMINISTIC live-STATUS 'downgraded to OCR' notice at the post-failure rescue net (OPS-MAN-127; 承 OPS-124/126). OPS-124 (prompt instruction) and OPS-126 (answer footnote) cover the ANSWER layer's 'OCR was used' disclosure; this area covers the LIVE-PROGRESS layer. prep-time Site1 (~1619) and Site2 (~1693) both emit an OCR-success emitStatus telling the user OCR was used; ONLY Site3 (the post-failure rescue net — the EXACT reported path gpt-4o keep → runtime 404 → rescue net) OCR-SUCCESS branch never emitted a status (its emitStatus calls covered only OCR failure/no-text). So on the exact reproduced path the live-progress layer stayed silent about the OCR downgrade. This area adds the missing rescue-net success status, aligned with Site1/Site2.」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Text-only-model Image OCR Fallback — DETERMINISTIC live-STATUS 'downgraded to OCR' notice at the post-failure rescue net (OPS-MAN-127; 承 OPS-124/126). OPS-124 (prompt instruction) and OPS-126 (answer footnote) cover the ANSWER layer's 'OCR was used' disclosure; this area covers the LIVE-PROGRESS layer. prep-time Site1 (~1619) and Site2 (~1693) both emit an OCR-success emitStatus telling the user OCR was used; ONLY Site3 (the post-failure rescue net — the EXACT reported path gpt-4o keep → runtime 404 → rescue net) OCR-SUCCESS branch never emitted a status (its emitStatus calls covered only OCR failure/no-text). So on the exact reproduced path the live-progress layer stayed silent about the OCR downgrade. This area adds the missing rescue-net success status, aligned with Site1/Site2.。
  - 验证：`npm run test:one -- services/backend/tests/gateway/ocrRescueStatusNotice.test.js services/backend/tests/gateway/ocrRescueStatusNoticeWiring.test.js services/backend/tests/gateway/ocrRescueStatusNoticeRealImage.test.js`

**385.** 验证「Text-only-model Image OCR Fallback — DETERMINISTIC live-STATUS 'downgraded to OCR' notice at the post-failure rescue net (OPS-MAN-127; 承 OPS-124/126). OPS-124 (prompt instruction) and OPS-126 (answer footnote) cover the ANSWER layer's 'OCR was used' disclosure; this area covers the LIVE-PROGRESS layer. prep-time Site1 (~1619) and Site2 (~1693) both emit an OCR-success emitStatus telling the user OCR was used; ONLY Site3 (the post-failure rescue net — the EXACT reported path gpt-4o keep → runtime 404 → rescue net) OCR-SUCCESS branch never emitted a status (its emitStatus calls covered only OCR failure/no-text). So on the exact reproduced path the live-progress layer stayed silent about the OCR downgrade. This area adds the missing rescue-net success status, aligned with Site1/Site2.」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Text-only-model Image OCR Fallback — DETERMINISTIC live-STATUS 'downgraded to OCR' notice at the post-failure rescue net (OPS-MAN-127; 承 OPS-124/126). OPS-124 (prompt instruction) and OPS-126 (answer footnote) cover the ANSWER layer's 'OCR was used' disclosure; this area covers the LIVE-PROGRESS layer. prep-time Site1 (~1619) and Site2 (~1693) both emit an OCR-success emitStatus telling the user OCR was used; ONLY Site3 (the post-failure rescue net — the EXACT reported path gpt-4o keep → runtime 404 → rescue net) OCR-SUCCESS branch never emitted a status (its emitStatus calls covered only OCR failure/no-text). So on the exact reproduced path the live-progress layer stayed silent about the OCR downgrade. This area adds the missing rescue-net success status, aligned with Site1/Site2.。
  - 验证：`node --check services/backend/src/services/gateway/ocrRescueStatusNotice.js`

**386.** 验证「Text-only-model Image OCR Fallback — DETERMINISTIC live-STATUS 'downgraded to OCR' notice at the post-failure rescue net (OPS-MAN-127; 承 OPS-124/126). OPS-124 (prompt instruction) and OPS-126 (answer footnote) cover the ANSWER layer's 'OCR was used' disclosure; this area covers the LIVE-PROGRESS layer. prep-time Site1 (~1619) and Site2 (~1693) both emit an OCR-success emitStatus telling the user OCR was used; ONLY Site3 (the post-failure rescue net — the EXACT reported path gpt-4o keep → runtime 404 → rescue net) OCR-SUCCESS branch never emitted a status (its emitStatus calls covered only OCR failure/no-text). So on the exact reproduced path the live-progress layer stayed silent about the OCR downgrade. This area adds the missing rescue-net success status, aligned with Site1/Site2.」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Text-only-model Image OCR Fallback — DETERMINISTIC live-STATUS 'downgraded to OCR' notice at the post-failure rescue net (OPS-MAN-127; 承 OPS-124/126). OPS-124 (prompt instruction) and OPS-126 (answer footnote) cover the ANSWER layer's 'OCR was used' disclosure; this area covers the LIVE-PROGRESS layer. prep-time Site1 (~1619) and Site2 (~1693) both emit an OCR-success emitStatus telling the user OCR was used; ONLY Site3 (the post-failure rescue net — the EXACT reported path gpt-4o keep → runtime 404 → rescue net) OCR-SUCCESS branch never emitted a status (its emitStatus calls covered only OCR failure/no-text). So on the exact reproduced path the live-progress layer stayed silent about the OCR downgrade. This area adds the missing rescue-net success status, aligned with Site1/Site2.。
  - 验证：`node --check services/backend/src/services/gateway/aiGatewayGenerateMethod.js`

**387.** 验证「CI Duplicate-code Detection Gate + Shared OCR-gateway Test Harness (goal 2026-07-12: '把所有重复的函数提取成公共库,统一维护;在 CI 里加重复代码检测,超过三行相同就报警'). Two parts: (1) services/backend/tests/gateway/_ocrGatewayHarness.js — a parameterized-factory shared harness absorbing the copy-pasted scaffolding (_wireGateway/_makeRecordingAdapter/_makeRejectAdapter/_realExtractImageOcrDetails/tesseract+python probes/PIL render/env save-restore) across the 20 OCR-gateway .test.js files, byte-equivalent to each file's in-place harness; underscore-prefixed so *.test.js never selects it; it DOES IO (spawnSync/fs/imageService) so its header does NOT self-declare pure-leaf/zero-IO (else check-leaf-contract leaf-io fires). (2) A self-authored duplicate-code detector: pure guard core scripts/lib/duplicationGuard.js (crypto/path only, zero-IO, deterministic, fail-soft, gate KHY_DUPLICATION_GUARD) + thin CLI scripts/check-duplication.js (all IO). Algorithm: normalize lines (skip blank/comment/pure-punctuation), sliding window MIN_BLOCK=4 significant lines (=more than three), sha1, a hash in >=2 places is a clone class, coalesce adjacent windows to maximal spans, one finding per (file,span). Phased per user decision 'warn + baseline first, flip to hard gate after migration': stage-1 DEFAULT_MODE='warn' (all warnings, existing dup never reds CI, NOT in the blocking check:small-model:safety aggregate); stage-2 --gate / KHY_DUPLICATION_MODE=gate (in baseline → warning, not in baseline → error). Baseline .duplication-baseline.json stores normalized-window content-hash fingerprints (relocation-stable, self-shrinks as extraction deletes dup copies). Flip-to-hard-gate is one reviewable diff: change DEFAULT_MODE + re-run --write-baseline + fold check:duplication into the safety aggregate.」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：CI Duplicate-code Detection Gate + Shared OCR-gateway Test Harness (goal 2026-07-12: '把所有重复的函数提取成公共库,统一维护;在 CI 里加重复代码检测,超过三行相同就报警'). Two parts: (1) services/backend/tests/gateway/_ocrGatewayHarness.js — a parameterized-factory shared harness absorbing the copy-pasted scaffolding (_wireGateway/_makeRecordingAdapter/_makeRejectAdapter/_realExtractImageOcrDetails/tesseract+python probes/PIL render/env save-restore) across the 20 OCR-gateway .test.js files, byte-equivalent to each file's in-place harness; underscore-prefixed so *.test.js never selects it; it DOES IO (spawnSync/fs/imageService) so its header does NOT self-declare pure-leaf/zero-IO (else check-leaf-contract leaf-io fires). (2) A self-authored duplicate-code detector: pure guard core scripts/lib/duplicationGuard.js (crypto/path only, zero-IO, deterministic, fail-soft, gate KHY_DUPLICATION_GUARD) + thin CLI scripts/check-duplication.js (all IO). Algorithm: normalize lines (skip blank/comment/pure-punctuation), sliding window MIN_BLOCK=4 significant lines (=more than three), sha1, a hash in >=2 places is a clone class, coalesce adjacent windows to maximal spans, one finding per (file,span). Phased per user decision 'warn + baseline first, flip to hard gate after migration': stage-1 DEFAULT_MODE='warn' (all warnings, existing dup never reds CI, NOT in the blocking check:small-model:safety aggregate); stage-2 --gate / KHY_DUPLICATION_MODE=gate (in baseline → warning, not in baseline → error). Baseline .duplication-baseline.json stores normalized-window content-hash fingerprints (relocation-stable, self-shrinks as extraction deletes dup copies). Flip-to-hard-gate is one reviewable diff: change DEFAULT_MODE + re-run --write-baseline + fold check:duplication into the safety aggregate.。
  - 验证：`npm run test:one -- scripts/tests/duplicationGuard.test.js scripts/tests/check-duplication.test.js`

**388.** 验证「CI Duplicate-code Detection Gate + Shared OCR-gateway Test Harness (goal 2026-07-12: '把所有重复的函数提取成公共库,统一维护;在 CI 里加重复代码检测,超过三行相同就报警'). Two parts: (1) services/backend/tests/gateway/_ocrGatewayHarness.js — a parameterized-factory shared harness absorbing the copy-pasted scaffolding (_wireGateway/_makeRecordingAdapter/_makeRejectAdapter/_realExtractImageOcrDetails/tesseract+python probes/PIL render/env save-restore) across the 20 OCR-gateway .test.js files, byte-equivalent to each file's in-place harness; underscore-prefixed so *.test.js never selects it; it DOES IO (spawnSync/fs/imageService) so its header does NOT self-declare pure-leaf/zero-IO (else check-leaf-contract leaf-io fires). (2) A self-authored duplicate-code detector: pure guard core scripts/lib/duplicationGuard.js (crypto/path only, zero-IO, deterministic, fail-soft, gate KHY_DUPLICATION_GUARD) + thin CLI scripts/check-duplication.js (all IO). Algorithm: normalize lines (skip blank/comment/pure-punctuation), sliding window MIN_BLOCK=4 significant lines (=more than three), sha1, a hash in >=2 places is a clone class, coalesce adjacent windows to maximal spans, one finding per (file,span). Phased per user decision 'warn + baseline first, flip to hard gate after migration': stage-1 DEFAULT_MODE='warn' (all warnings, existing dup never reds CI, NOT in the blocking check:small-model:safety aggregate); stage-2 --gate / KHY_DUPLICATION_MODE=gate (in baseline → warning, not in baseline → error). Baseline .duplication-baseline.json stores normalized-window content-hash fingerprints (relocation-stable, self-shrinks as extraction deletes dup copies). Flip-to-hard-gate is one reviewable diff: change DEFAULT_MODE + re-run --write-baseline + fold check:duplication into the safety aggregate.」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：CI Duplicate-code Detection Gate + Shared OCR-gateway Test Harness (goal 2026-07-12: '把所有重复的函数提取成公共库,统一维护;在 CI 里加重复代码检测,超过三行相同就报警'). Two parts: (1) services/backend/tests/gateway/_ocrGatewayHarness.js — a parameterized-factory shared harness absorbing the copy-pasted scaffolding (_wireGateway/_makeRecordingAdapter/_makeRejectAdapter/_realExtractImageOcrDetails/tesseract+python probes/PIL render/env save-restore) across the 20 OCR-gateway .test.js files, byte-equivalent to each file's in-place harness; underscore-prefixed so *.test.js never selects it; it DOES IO (spawnSync/fs/imageService) so its header does NOT self-declare pure-leaf/zero-IO (else check-leaf-contract leaf-io fires). (2) A self-authored duplicate-code detector: pure guard core scripts/lib/duplicationGuard.js (crypto/path only, zero-IO, deterministic, fail-soft, gate KHY_DUPLICATION_GUARD) + thin CLI scripts/check-duplication.js (all IO). Algorithm: normalize lines (skip blank/comment/pure-punctuation), sliding window MIN_BLOCK=4 significant lines (=more than three), sha1, a hash in >=2 places is a clone class, coalesce adjacent windows to maximal spans, one finding per (file,span). Phased per user decision 'warn + baseline first, flip to hard gate after migration': stage-1 DEFAULT_MODE='warn' (all warnings, existing dup never reds CI, NOT in the blocking check:small-model:safety aggregate); stage-2 --gate / KHY_DUPLICATION_MODE=gate (in baseline → warning, not in baseline → error). Baseline .duplication-baseline.json stores normalized-window content-hash fingerprints (relocation-stable, self-shrinks as extraction deletes dup copies). Flip-to-hard-gate is one reviewable diff: change DEFAULT_MODE + re-run --write-baseline + fold check:duplication into the safety aggregate.。
  - 验证：`npm run check:duplication`

**389.** 验证「CI Duplicate-code Detection Gate + Shared OCR-gateway Test Harness (goal 2026-07-12: '把所有重复的函数提取成公共库,统一维护;在 CI 里加重复代码检测,超过三行相同就报警'). Two parts: (1) services/backend/tests/gateway/_ocrGatewayHarness.js — a parameterized-factory shared harness absorbing the copy-pasted scaffolding (_wireGateway/_makeRecordingAdapter/_makeRejectAdapter/_realExtractImageOcrDetails/tesseract+python probes/PIL render/env save-restore) across the 20 OCR-gateway .test.js files, byte-equivalent to each file's in-place harness; underscore-prefixed so *.test.js never selects it; it DOES IO (spawnSync/fs/imageService) so its header does NOT self-declare pure-leaf/zero-IO (else check-leaf-contract leaf-io fires). (2) A self-authored duplicate-code detector: pure guard core scripts/lib/duplicationGuard.js (crypto/path only, zero-IO, deterministic, fail-soft, gate KHY_DUPLICATION_GUARD) + thin CLI scripts/check-duplication.js (all IO). Algorithm: normalize lines (skip blank/comment/pure-punctuation), sliding window MIN_BLOCK=4 significant lines (=more than three), sha1, a hash in >=2 places is a clone class, coalesce adjacent windows to maximal spans, one finding per (file,span). Phased per user decision 'warn + baseline first, flip to hard gate after migration': stage-1 DEFAULT_MODE='warn' (all warnings, existing dup never reds CI, NOT in the blocking check:small-model:safety aggregate); stage-2 --gate / KHY_DUPLICATION_MODE=gate (in baseline → warning, not in baseline → error). Baseline .duplication-baseline.json stores normalized-window content-hash fingerprints (relocation-stable, self-shrinks as extraction deletes dup copies). Flip-to-hard-gate is one reviewable diff: change DEFAULT_MODE + re-run --write-baseline + fold check:duplication into the safety aggregate.」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：CI Duplicate-code Detection Gate + Shared OCR-gateway Test Harness (goal 2026-07-12: '把所有重复的函数提取成公共库,统一维护;在 CI 里加重复代码检测,超过三行相同就报警'). Two parts: (1) services/backend/tests/gateway/_ocrGatewayHarness.js — a parameterized-factory shared harness absorbing the copy-pasted scaffolding (_wireGateway/_makeRecordingAdapter/_makeRejectAdapter/_realExtractImageOcrDetails/tesseract+python probes/PIL render/env save-restore) across the 20 OCR-gateway .test.js files, byte-equivalent to each file's in-place harness; underscore-prefixed so *.test.js never selects it; it DOES IO (spawnSync/fs/imageService) so its header does NOT self-declare pure-leaf/zero-IO (else check-leaf-contract leaf-io fires). (2) A self-authored duplicate-code detector: pure guard core scripts/lib/duplicationGuard.js (crypto/path only, zero-IO, deterministic, fail-soft, gate KHY_DUPLICATION_GUARD) + thin CLI scripts/check-duplication.js (all IO). Algorithm: normalize lines (skip blank/comment/pure-punctuation), sliding window MIN_BLOCK=4 significant lines (=more than three), sha1, a hash in >=2 places is a clone class, coalesce adjacent windows to maximal spans, one finding per (file,span). Phased per user decision 'warn + baseline first, flip to hard gate after migration': stage-1 DEFAULT_MODE='warn' (all warnings, existing dup never reds CI, NOT in the blocking check:small-model:safety aggregate); stage-2 --gate / KHY_DUPLICATION_MODE=gate (in baseline → warning, not in baseline → error). Baseline .duplication-baseline.json stores normalized-window content-hash fingerprints (relocation-stable, self-shrinks as extraction deletes dup copies). Flip-to-hard-gate is one reviewable diff: change DEFAULT_MODE + re-run --write-baseline + fold check:duplication into the safety aggregate.。
  - 验证：`node --check scripts/lib/duplicationGuard.js scripts/check-duplication.js`

**390.** 验证「Text-only-model Image OCR Fallback — DETERMINISTIC live-STATUS 'downgraded to OCR' notice at the PREP-time sites for NON-VERBOSE sessions (OPS-MAN-132; 承 OPS-127/124/126). OPS-127 made the Site3 rescue-net OCR-success status UNCONDITIONAL, but prep-time Site1 (~1618) and Site2 (~1692) OCR-success emitStatus were always nested inside `if (_isVerbose)`. So NON-VERBOSE sessions (default KHY_STATUS_VERBOSITY=auto) stayed silent on the live-progress layer during a prep-time OCR downgrade — asymmetric with the now-unconditional Site3. This area adds the missing unconditional prep-time status, guarded by !_isVerbose to avoid duplicating the existing verbose status.」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Text-only-model Image OCR Fallback — DETERMINISTIC live-STATUS 'downgraded to OCR' notice at the PREP-time sites for NON-VERBOSE sessions (OPS-MAN-132; 承 OPS-127/124/126). OPS-127 made the Site3 rescue-net OCR-success status UNCONDITIONAL, but prep-time Site1 (~1618) and Site2 (~1692) OCR-success emitStatus were always nested inside `if (_isVerbose)`. So NON-VERBOSE sessions (default KHY_STATUS_VERBOSITY=auto) stayed silent on the live-progress layer during a prep-time OCR downgrade — asymmetric with the now-unconditional Site3. This area adds the missing unconditional prep-time status, guarded by !_isVerbose to avoid duplicating the existing verbose status.。
  - 验证：`npm run test:one -- services/backend/tests/gateway/ocrRescueStatusPrep.test.js services/backend/tests/gateway/ocrRescueStatusPrepWiring.test.js services/backend/tests/gateway/ocrRescueStatusPrepRealImage.test.js`

**391.** 验证「Text-only-model Image OCR Fallback — DETERMINISTIC live-STATUS 'downgraded to OCR' notice at the PREP-time sites for NON-VERBOSE sessions (OPS-MAN-132; 承 OPS-127/124/126). OPS-127 made the Site3 rescue-net OCR-success status UNCONDITIONAL, but prep-time Site1 (~1618) and Site2 (~1692) OCR-success emitStatus were always nested inside `if (_isVerbose)`. So NON-VERBOSE sessions (default KHY_STATUS_VERBOSITY=auto) stayed silent on the live-progress layer during a prep-time OCR downgrade — asymmetric with the now-unconditional Site3. This area adds the missing unconditional prep-time status, guarded by !_isVerbose to avoid duplicating the existing verbose status.」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Text-only-model Image OCR Fallback — DETERMINISTIC live-STATUS 'downgraded to OCR' notice at the PREP-time sites for NON-VERBOSE sessions (OPS-MAN-132; 承 OPS-127/124/126). OPS-127 made the Site3 rescue-net OCR-success status UNCONDITIONAL, but prep-time Site1 (~1618) and Site2 (~1692) OCR-success emitStatus were always nested inside `if (_isVerbose)`. So NON-VERBOSE sessions (default KHY_STATUS_VERBOSITY=auto) stayed silent on the live-progress layer during a prep-time OCR downgrade — asymmetric with the now-unconditional Site3. This area adds the missing unconditional prep-time status, guarded by !_isVerbose to avoid duplicating the existing verbose status.。
  - 验证：`node --check services/backend/src/services/gateway/ocrRescueStatusNotice.js`

**392.** 验证「Text-only-model Image OCR Fallback — DETERMINISTIC live-STATUS 'downgraded to OCR' notice at the PREP-time sites for NON-VERBOSE sessions (OPS-MAN-132; 承 OPS-127/124/126). OPS-127 made the Site3 rescue-net OCR-success status UNCONDITIONAL, but prep-time Site1 (~1618) and Site2 (~1692) OCR-success emitStatus were always nested inside `if (_isVerbose)`. So NON-VERBOSE sessions (default KHY_STATUS_VERBOSITY=auto) stayed silent on the live-progress layer during a prep-time OCR downgrade — asymmetric with the now-unconditional Site3. This area adds the missing unconditional prep-time status, guarded by !_isVerbose to avoid duplicating the existing verbose status.」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Text-only-model Image OCR Fallback — DETERMINISTIC live-STATUS 'downgraded to OCR' notice at the PREP-time sites for NON-VERBOSE sessions (OPS-MAN-132; 承 OPS-127/124/126). OPS-127 made the Site3 rescue-net OCR-success status UNCONDITIONAL, but prep-time Site1 (~1618) and Site2 (~1692) OCR-success emitStatus were always nested inside `if (_isVerbose)`. So NON-VERBOSE sessions (default KHY_STATUS_VERBOSITY=auto) stayed silent on the live-progress layer during a prep-time OCR downgrade — asymmetric with the now-unconditional Site3. This area adds the missing unconditional prep-time status, guarded by !_isVerbose to avoid duplicating the existing verbose status.。
  - 验证：`node --check services/backend/src/services/gateway/aiGatewayGenerateMethod.js`

**393.** 验证「Text-only-model Image OCR Fallback — CROSS-LAYER de-duplication of the Site1 prep-status (OPS-132) and the OCR-success closure (OPS-144), so a single OCR downgrade is not announced twice as two PERMANENT lines (OPS-MAN-148; 承 OPS-132 + OPS-144, directly serving '减少显示的心灵噪音'). On the EXACT reported path (non-verbose · describe cascade all-failed → local OCR success), the same 'downgraded to OCR and succeeded' fact was announced TWICE: (1) a status chunk from OPS-132 buildOcrRescuePrepStatus ('已降级用本地 OCR 成功提取…'), which — because it contains '成功' — is mis-classified by emitRuntimeStatus into a PERMANENT '模型已连接' terminal line; and (2) an assistant_message chunk from OPS-144 buildOcrSuccessClosure ('视觉模型均不可用，已改用本地 OCR 成功识别…据此作答'). Since the OPS-144 closure already delivers the '明显告知用了 OCR' disclosure on Site1, the prep-status is a redundant, worse-worded second announcement. This area suppresses the Site1 prep-status ONLY when the closure will also fire.」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Text-only-model Image OCR Fallback — CROSS-LAYER de-duplication of the Site1 prep-status (OPS-132) and the OCR-success closure (OPS-144), so a single OCR downgrade is not announced twice as two PERMANENT lines (OPS-MAN-148; 承 OPS-132 + OPS-144, directly serving '减少显示的心灵噪音'). On the EXACT reported path (non-verbose · describe cascade all-failed → local OCR success), the same 'downgraded to OCR and succeeded' fact was announced TWICE: (1) a status chunk from OPS-132 buildOcrRescuePrepStatus ('已降级用本地 OCR 成功提取…'), which — because it contains '成功' — is mis-classified by emitRuntimeStatus into a PERMANENT '模型已连接' terminal line; and (2) an assistant_message chunk from OPS-144 buildOcrSuccessClosure ('视觉模型均不可用，已改用本地 OCR 成功识别…据此作答'). Since the OPS-144 closure already delivers the '明显告知用了 OCR' disclosure on Site1, the prep-status is a redundant, worse-worded second announcement. This area suppresses the Site1 prep-status ONLY when the closure will also fire.。
  - 验证：`npm run test:one -- services/backend/tests/gateway/ocrRescueStatusNotice.test.js services/backend/tests/gateway/ocrRescuePrepClosureDedupWiring.test.js services/backend/tests/gateway/ocrRescuePrepClosureDedupRealImage.test.js`

**394.** 验证「Text-only-model Image OCR Fallback — CROSS-LAYER de-duplication of the Site1 prep-status (OPS-132) and the OCR-success closure (OPS-144), so a single OCR downgrade is not announced twice as two PERMANENT lines (OPS-MAN-148; 承 OPS-132 + OPS-144, directly serving '减少显示的心灵噪音'). On the EXACT reported path (non-verbose · describe cascade all-failed → local OCR success), the same 'downgraded to OCR and succeeded' fact was announced TWICE: (1) a status chunk from OPS-132 buildOcrRescuePrepStatus ('已降级用本地 OCR 成功提取…'), which — because it contains '成功' — is mis-classified by emitRuntimeStatus into a PERMANENT '模型已连接' terminal line; and (2) an assistant_message chunk from OPS-144 buildOcrSuccessClosure ('视觉模型均不可用，已改用本地 OCR 成功识别…据此作答'). Since the OPS-144 closure already delivers the '明显告知用了 OCR' disclosure on Site1, the prep-status is a redundant, worse-worded second announcement. This area suppresses the Site1 prep-status ONLY when the closure will also fire.」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Text-only-model Image OCR Fallback — CROSS-LAYER de-duplication of the Site1 prep-status (OPS-132) and the OCR-success closure (OPS-144), so a single OCR downgrade is not announced twice as two PERMANENT lines (OPS-MAN-148; 承 OPS-132 + OPS-144, directly serving '减少显示的心灵噪音'). On the EXACT reported path (non-verbose · describe cascade all-failed → local OCR success), the same 'downgraded to OCR and succeeded' fact was announced TWICE: (1) a status chunk from OPS-132 buildOcrRescuePrepStatus ('已降级用本地 OCR 成功提取…'), which — because it contains '成功' — is mis-classified by emitRuntimeStatus into a PERMANENT '模型已连接' terminal line; and (2) an assistant_message chunk from OPS-144 buildOcrSuccessClosure ('视觉模型均不可用，已改用本地 OCR 成功识别…据此作答'). Since the OPS-144 closure already delivers the '明显告知用了 OCR' disclosure on Site1, the prep-status is a redundant, worse-worded second announcement. This area suppresses the Site1 prep-status ONLY when the closure will also fire.。
  - 验证：`node --check services/backend/src/services/gateway/ocrRescueStatusNotice.js`

**395.** 验证「Text-only-model Image OCR Fallback — CROSS-LAYER de-duplication of the Site1 prep-status (OPS-132) and the OCR-success closure (OPS-144), so a single OCR downgrade is not announced twice as two PERMANENT lines (OPS-MAN-148; 承 OPS-132 + OPS-144, directly serving '减少显示的心灵噪音'). On the EXACT reported path (non-verbose · describe cascade all-failed → local OCR success), the same 'downgraded to OCR and succeeded' fact was announced TWICE: (1) a status chunk from OPS-132 buildOcrRescuePrepStatus ('已降级用本地 OCR 成功提取…'), which — because it contains '成功' — is mis-classified by emitRuntimeStatus into a PERMANENT '模型已连接' terminal line; and (2) an assistant_message chunk from OPS-144 buildOcrSuccessClosure ('视觉模型均不可用，已改用本地 OCR 成功识别…据此作答'). Since the OPS-144 closure already delivers the '明显告知用了 OCR' disclosure on Site1, the prep-status is a redundant, worse-worded second announcement. This area suppresses the Site1 prep-status ONLY when the closure will also fire.」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Text-only-model Image OCR Fallback — CROSS-LAYER de-duplication of the Site1 prep-status (OPS-132) and the OCR-success closure (OPS-144), so a single OCR downgrade is not announced twice as two PERMANENT lines (OPS-MAN-148; 承 OPS-132 + OPS-144, directly serving '减少显示的心灵噪音'). On the EXACT reported path (non-verbose · describe cascade all-failed → local OCR success), the same 'downgraded to OCR and succeeded' fact was announced TWICE: (1) a status chunk from OPS-132 buildOcrRescuePrepStatus ('已降级用本地 OCR 成功提取…'), which — because it contains '成功' — is mis-classified by emitRuntimeStatus into a PERMANENT '模型已连接' terminal line; and (2) an assistant_message chunk from OPS-144 buildOcrSuccessClosure ('视觉模型均不可用，已改用本地 OCR 成功识别…据此作答'). Since the OPS-144 closure already delivers the '明显告知用了 OCR' disclosure on Site1, the prep-status is a redundant, worse-worded second announcement. This area suppresses the Site1 prep-status ONLY when the closure will also fire.。
  - 验证：`node --check services/backend/src/services/gateway/aiGatewayGenerateMethod.js`

**396.** 验证「Vision-Cascade Exhaustion Diagnostic — NETWORK reason class (OPS-MAN-134; 承 OPS-118/120/122 model-rejection strip-floor). diagnoseVisionExhaustion (pure leaf, already wired at aiGatewayGenerateMethod.js:3315) classified only 404 (model_not_provisioned) and 429 (rate_limited). When the vision cascade exhausts on a TRANSIENT network failure (socket hang up / ECONNRESET / tunneling-socket / 连接被重置) and terminal OCR recovers NO text (photo/color-block, no chars), the request fell to the generic '所有 AI 通道均不可用' wall — omitting the honest 'I did receive your image but the network could not deliver it to the vision model — this is NOT “no image received”' acknowledgment, which is exactly the reported failure where the model falsely denies the image. This area adds the orthogonal network_unreachable reason branch (and folds it into 'multiple' when it co-occurs with 404/429).」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Vision-Cascade Exhaustion Diagnostic — NETWORK reason class (OPS-MAN-134; 承 OPS-118/120/122 model-rejection strip-floor). diagnoseVisionExhaustion (pure leaf, already wired at aiGatewayGenerateMethod.js:3315) classified only 404 (model_not_provisioned) and 429 (rate_limited). When the vision cascade exhausts on a TRANSIENT network failure (socket hang up / ECONNRESET / tunneling-socket / 连接被重置) and terminal OCR recovers NO text (photo/color-block, no chars), the request fell to the generic '所有 AI 通道均不可用' wall — omitting the honest 'I did receive your image but the network could not deliver it to the vision model — this is NOT “no image received”' acknowledgment, which is exactly the reported failure where the model falsely denies the image. This area adds the orthogonal network_unreachable reason branch (and folds it into 'multiple' when it co-occurs with 404/429).。
  - 验证：`npm run test:one -- services/backend/tests/services/visionExhaustionDiagnostic.test.js services/backend/tests/gateway/visionNetworkExhaustionRealImage.test.js`

**397.** 验证「Vision-Cascade Exhaustion Diagnostic — NETWORK reason class (OPS-MAN-134; 承 OPS-118/120/122 model-rejection strip-floor). diagnoseVisionExhaustion (pure leaf, already wired at aiGatewayGenerateMethod.js:3315) classified only 404 (model_not_provisioned) and 429 (rate_limited). When the vision cascade exhausts on a TRANSIENT network failure (socket hang up / ECONNRESET / tunneling-socket / 连接被重置) and terminal OCR recovers NO text (photo/color-block, no chars), the request fell to the generic '所有 AI 通道均不可用' wall — omitting the honest 'I did receive your image but the network could not deliver it to the vision model — this is NOT “no image received”' acknowledgment, which is exactly the reported failure where the model falsely denies the image. This area adds the orthogonal network_unreachable reason branch (and folds it into 'multiple' when it co-occurs with 404/429).」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Vision-Cascade Exhaustion Diagnostic — NETWORK reason class (OPS-MAN-134; 承 OPS-118/120/122 model-rejection strip-floor). diagnoseVisionExhaustion (pure leaf, already wired at aiGatewayGenerateMethod.js:3315) classified only 404 (model_not_provisioned) and 429 (rate_limited). When the vision cascade exhausts on a TRANSIENT network failure (socket hang up / ECONNRESET / tunneling-socket / 连接被重置) and terminal OCR recovers NO text (photo/color-block, no chars), the request fell to the generic '所有 AI 通道均不可用' wall — omitting the honest 'I did receive your image but the network could not deliver it to the vision model — this is NOT “no image received”' acknowledgment, which is exactly the reported failure where the model falsely denies the image. This area adds the orthogonal network_unreachable reason branch (and folds it into 'multiple' when it co-occurs with 404/429).。
  - 验证：`node --check services/backend/src/services/gateway/visionExhaustionDiagnostic.js`

**398.** 验证「Workflow list load — page-scoped degraded UI (silent request, no cross-page banner). Fixes the reported bug where a red 「网络连接异常:无法访问 /api/workflow。请确认 ai-backend 服务可用后重试。」 banner appeared on the UNRELATED 代理管理 (Proxy Management) page. Root cause: the workflow list fetch (Workflows.vue onMounted → useWorkflow.listWorkflows → GET /api/workflow) was NOT marked silent and had no local error UI, so request.js's interceptor fired a GLOBAL body-mounted ElMessage (notifyError) on network failure; a navigation-orphaned / backend-unreachable failure leaked that global toast onto whatever page the user had moved to. Fix (per request.js:88-94 convention): mark the list GET { silent: true } and render the failure IN-PAGE (inline el-alert + 重试) via a loadError ref, so the failure stays scoped to the Workflows page and never bleeds cross-page.」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Workflow list load — page-scoped degraded UI (silent request, no cross-page banner). Fixes the reported bug where a red 「网络连接异常:无法访问 /api/workflow。请确认 ai-backend 服务可用后重试。」 banner appeared on the UNRELATED 代理管理 (Proxy Management) page. Root cause: the workflow list fetch (Workflows.vue onMounted → useWorkflow.listWorkflows → GET /api/workflow) was NOT marked silent and had no local error UI, so request.js's interceptor fired a GLOBAL body-mounted ElMessage (notifyError) on network failure; a navigation-orphaned / backend-unreachable failure leaked that global toast onto whatever page the user had moved to. Fix (per request.js:88-94 convention): mark the list GET { silent: true } and render the failure IN-PAGE (inline el-alert + 重试) via a loadError ref, so the failure stays scoped to the Workflows page and never bleeds cross-page.。
  - 验证：`npm run test:one -- apps/ai-frontend/src/composables/useWorkflow.wiring.test.js`

**399.** 验证「Workflow list load — page-scoped degraded UI (silent request, no cross-page banner). Fixes the reported bug where a red 「网络连接异常:无法访问 /api/workflow。请确认 ai-backend 服务可用后重试。」 banner appeared on the UNRELATED 代理管理 (Proxy Management) page. Root cause: the workflow list fetch (Workflows.vue onMounted → useWorkflow.listWorkflows → GET /api/workflow) was NOT marked silent and had no local error UI, so request.js's interceptor fired a GLOBAL body-mounted ElMessage (notifyError) on network failure; a navigation-orphaned / backend-unreachable failure leaked that global toast onto whatever page the user had moved to. Fix (per request.js:88-94 convention): mark the list GET { silent: true } and render the failure IN-PAGE (inline el-alert + 重试) via a loadError ref, so the failure stays scoped to the Workflows page and never bleeds cross-page.」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Workflow list load — page-scoped degraded UI (silent request, no cross-page banner). Fixes the reported bug where a red 「网络连接异常:无法访问 /api/workflow。请确认 ai-backend 服务可用后重试。」 banner appeared on the UNRELATED 代理管理 (Proxy Management) page. Root cause: the workflow list fetch (Workflows.vue onMounted → useWorkflow.listWorkflows → GET /api/workflow) was NOT marked silent and had no local error UI, so request.js's interceptor fired a GLOBAL body-mounted ElMessage (notifyError) on network failure; a navigation-orphaned / backend-unreachable failure leaked that global toast onto whatever page the user had moved to. Fix (per request.js:88-94 convention): mark the list GET { silent: true } and render the failure IN-PAGE (inline el-alert + 重试) via a loadError ref, so the failure stays scoped to the Workflows page and never bleeds cross-page.。
  - 验证：`node --check apps/ai-frontend/src/composables/useWorkflow.js`

**400.** 验证「缓存前缀击穿归因 (prompt-cache prefix bust attribution — 命中率低时定位是谁击穿了前缀：系统提示/工具集/工具顺序)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：缓存前缀击穿归因 (prompt-cache prefix bust attribution — 命中率低时定位是谁击穿了前缀：系统提示/工具集/工具顺序)。
  - 验证：`node --test services/backend/tests/cli/cacheWarning.test.js services/backend/tests/constants/promptPrefixShape.test.js`

**401.** 验证「缓存前缀击穿归因 (prompt-cache prefix bust attribution — 命中率低时定位是谁击穿了前缀：系统提示/工具集/工具顺序)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：缓存前缀击穿归因 (prompt-cache prefix bust attribution — 命中率低时定位是谁击穿了前缀：系统提示/工具集/工具顺序)。
  - 验证：`node --check services/backend/src/constants/promptPrefixShape.js`

**402.** 验证「缓存前缀击穿归因 (prompt-cache prefix bust attribution — 命中率低时定位是谁击穿了前缀：系统提示/工具集/工具顺序)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：缓存前缀击穿归因 (prompt-cache prefix bust attribution — 命中率低时定位是谁击穿了前缀：系统提示/工具集/工具顺序)。
  - 验证：`node --check services/backend/src/cli/cacheWarning.js`

**403.** 验证「交付门人类可读报告落盘 (deliveryGate markdown report — 把结构化 verdict 变成带逐条判定+改进建议的可打开报告)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：交付门人类可读报告落盘 (deliveryGate markdown report — 把结构化 verdict 变成带逐条判定+改进建议的可打开报告)。
  - 验证：`node --test services/backend/tests/services/deliveryGateReporter.test.js`

**404.** 验证「交付门人类可读报告落盘 (deliveryGate markdown report — 把结构化 verdict 变成带逐条判定+改进建议的可打开报告)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：交付门人类可读报告落盘 (deliveryGate markdown report — 把结构化 verdict 变成带逐条判定+改进建议的可打开报告)。
  - 验证：`node --check services/backend/src/services/agenticHarnessService.js`

**405.** 验证「交付门人类可读报告落盘 (deliveryGate markdown report — 把结构化 verdict 变成带逐条判定+改进建议的可打开报告)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：交付门人类可读报告落盘 (deliveryGate markdown report — 把结构化 verdict 变成带逐条判定+改进建议的可打开报告)。
  - 验证：`node --check services/backend/src/services/flagRegistry.js`

**406.** 验证「会话快照损坏兜底修复 (sessionFileRepair — 损坏/截断的 .json 快照在还原时先结构修复/partial salvage 再返回，而不是整段丢给 checkpoint/null)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：会话快照损坏兜底修复 (sessionFileRepair — 损坏/截断的 .json 快照在还原时先结构修复/partial salvage 再返回，而不是整段丢给 checkpoint/null)。
  - 验证：`node --test services/backend/tests/services/sessionFileRepairWiring.test.js`

**407.** 验证「会话快照损坏兜底修复 (sessionFileRepair — 损坏/截断的 .json 快照在还原时先结构修复/partial salvage 再返回，而不是整段丢给 checkpoint/null)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：会话快照损坏兜底修复 (sessionFileRepair — 损坏/截断的 .json 快照在还原时先结构修复/partial salvage 再返回，而不是整段丢给 checkpoint/null)。
  - 验证：`node --check services/backend/src/services/sessionPersistence.js`

**408.** 验证「会话快照损坏兜底修复 (sessionFileRepair — 损坏/截断的 .json 快照在还原时先结构修复/partial salvage 再返回，而不是整段丢给 checkpoint/null)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：会话快照损坏兜底修复 (sessionFileRepair — 损坏/截断的 .json 快照在还原时先结构修复/partial salvage 再返回，而不是整段丢给 checkpoint/null)。
  - 验证：`node --check services/backend/src/services/flagRegistry.js`

**409.** 验证「任务模板执行手册注入 (taskTemplates — 用户消息命中常见任务关键词时，把该模板的分步执行手册作为 [Task Playbook] 附加进模型 loopInput，降低小模型推理负担)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：任务模板执行手册注入 (taskTemplates — 用户消息命中常见任务关键词时，把该模板的分步执行手册作为 [Task Playbook] 附加进模型 loopInput，降低小模型推理负担)。
  - 验证：`node --test services/backend/tests/services/taskTemplateHintWiring.test.js`

**410.** 验证「任务模板执行手册注入 (taskTemplates — 用户消息命中常见任务关键词时，把该模板的分步执行手册作为 [Task Playbook] 附加进模型 loopInput，降低小模型推理负担)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：任务模板执行手册注入 (taskTemplates — 用户消息命中常见任务关键词时，把该模板的分步执行手册作为 [Task Playbook] 附加进模型 loopInput，降低小模型推理负担)。
  - 验证：`node --check services/backend/src/services/agenticHarnessService.js`

**411.** 验证「任务模板执行手册注入 (taskTemplates — 用户消息命中常见任务关键词时，把该模板的分步执行手册作为 [Task Playbook] 附加进模型 loopInput，降低小模型推理负担)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：任务模板执行手册注入 (taskTemplates — 用户消息命中常见任务关键词时，把该模板的分步执行手册作为 [Task Playbook] 附加进模型 loopInput，降低小模型推理负担)。
  - 验证：`node --check services/backend/src/services/flagRegistry.js`

**412.** 验证「指令注册表编译期收敛守卫 (directiveRegistryAudit — 把「DIRECTIVE_REGISTRY 指令 SSOT vs aiChatCore.js 实际 compose 的 key 集合」的一致性锁成 CI/提交期不变量，堵住协议漂移入口)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：指令注册表编译期收敛守卫 (directiveRegistryAudit — 把「DIRECTIVE_REGISTRY 指令 SSOT vs aiChatCore.js 实际 compose 的 key 集合」的一致性锁成 CI/提交期不变量，堵住协议漂移入口)。
  - 验证：`node --test services/backend/tests/services/directiveRegistryAudit.guard.test.js`

**413.** 验证「指令注册表编译期收敛守卫 (directiveRegistryAudit — 把「DIRECTIVE_REGISTRY 指令 SSOT vs aiChatCore.js 实际 compose 的 key 集合」的一致性锁成 CI/提交期不变量，堵住协议漂移入口)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：指令注册表编译期收敛守卫 (directiveRegistryAudit — 把「DIRECTIVE_REGISTRY 指令 SSOT vs aiChatCore.js 实际 compose 的 key 集合」的一致性锁成 CI/提交期不变量，堵住协议漂移入口)。
  - 验证：`node --check services/backend/src/services/directiveRegistryAudit.js`

**414.** 验证「取来即执行安全守卫接线 (fetchExecuteGuard — 把 curl…|sh / base64 -d|bash / bash -c "$(curl…)" 这类下载-解码-执行供应链签名接进 shellSafetyValidator.analyzeCommand，fail-closed 升为 critical 拦截)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：取来即执行安全守卫接线 (fetchExecuteGuard — 把 curl…|sh / base64 -d|bash / bash -c "$(curl…)" 这类下载-解码-执行供应链签名接进 shellSafetyValidator.analyzeCommand，fail-closed 升为 critical 拦截)。
  - 验证：`node --test services/backend/tests/security/fetchExecuteGuardWiring.test.js`

**415.** 验证「取来即执行安全守卫接线 (fetchExecuteGuard — 把 curl…|sh / base64 -d|bash / bash -c "$(curl…)" 这类下载-解码-执行供应链签名接进 shellSafetyValidator.analyzeCommand，fail-closed 升为 critical 拦截)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：取来即执行安全守卫接线 (fetchExecuteGuard — 把 curl…|sh / base64 -d|bash / bash -c "$(curl…)" 这类下载-解码-执行供应链签名接进 shellSafetyValidator.analyzeCommand，fail-closed 升为 critical 拦截)。
  - 验证：`node --check services/backend/src/services/shellSafetyValidator.js`

**416.** 验证「用户显式 git-init 白名单覆盖接线 (gitTrackWhitelist — 让用户对自动判定会「软拒绝」的精确系统/共享根显式声明「我确实要 git 化」，接进 workspaceGitInit.ensureWorkspaceRepo；硬安全约束永不覆盖)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：用户显式 git-init 白名单覆盖接线 (gitTrackWhitelist — 让用户对自动判定会「软拒绝」的精确系统/共享根显式声明「我确实要 git 化」，接进 workspaceGitInit.ensureWorkspaceRepo；硬安全约束永不覆盖)。
  - 验证：`node --test services/backend/tests/services/gitTrackWhitelistWiring.test.js`

**417.** 验证「用户显式 git-init 白名单覆盖接线 (gitTrackWhitelist — 让用户对自动判定会「软拒绝」的精确系统/共享根显式声明「我确实要 git 化」，接进 workspaceGitInit.ensureWorkspaceRepo；硬安全约束永不覆盖)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：用户显式 git-init 白名单覆盖接线 (gitTrackWhitelist — 让用户对自动判定会「软拒绝」的精确系统/共享根显式声明「我确实要 git 化」，接进 workspaceGitInit.ensureWorkspaceRepo；硬安全约束永不覆盖)。
  - 验证：`node --check services/backend/src/services/workspaceGitInit.js`

**418.** 验证「本地 Ollama 模型并入统一目录接线 (localOllamaProbe — 把本地正在服务的模型作 source:local 边接进 modelCatalogGraph.buildCatalogGraph 第 4 源，仅 live 发现时；never-throw 非阻塞)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：本地 Ollama 模型并入统一目录接线 (localOllamaProbe — 把本地正在服务的模型作 source:local 边接进 modelCatalogGraph.buildCatalogGraph 第 4 源，仅 live 发现时；never-throw 非阻塞)。
  - 验证：`node --test services/backend/tests/gateway/localOllamaProbeCatalogWiring.test.js`

**419.** 验证「本地 Ollama 模型并入统一目录接线 (localOllamaProbe — 把本地正在服务的模型作 source:local 边接进 modelCatalogGraph.buildCatalogGraph 第 4 源，仅 live 发现时；never-throw 非阻塞)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：本地 Ollama 模型并入统一目录接线 (localOllamaProbe — 把本地正在服务的模型作 source:local 边接进 modelCatalogGraph.buildCatalogGraph 第 4 源，仅 live 发现时；never-throw 非阻塞)。
  - 验证：`node --check services/backend/src/services/gateway/modelCatalogGraph.js`

**420.** 验证「行为特征化并入误报收口裁决接线 (characterizationSnapshot — falsePositiveFixGuard.finalize 就地用回归门 baseline/current 快照差分「未覆盖文件上的静默行为漂移」并入裁决；agenticHarnessService 透传快照)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：行为特征化并入误报收口裁决接线 (characterizationSnapshot — falsePositiveFixGuard.finalize 就地用回归门 baseline/current 快照差分「未覆盖文件上的静默行为漂移」并入裁决；agenticHarnessService 透传快照)。
  - 验证：`node --test services/backend/tests/services/characterizationFpfWiring.test.js`

**421.** 验证「行为特征化并入误报收口裁决接线 (characterizationSnapshot — falsePositiveFixGuard.finalize 就地用回归门 baseline/current 快照差分「未覆盖文件上的静默行为漂移」并入裁决；agenticHarnessService 透传快照)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：行为特征化并入误报收口裁决接线 (characterizationSnapshot — falsePositiveFixGuard.finalize 就地用回归门 baseline/current 快照差分「未覆盖文件上的静默行为漂移」并入裁决；agenticHarnessService 透传快照)。
  - 验证：`node --check services/backend/src/services/falsePositiveFixGuard.js`

**422.** 验证「CLI/Web 管理面平价守卫 (parityGuard.checkParity — 证明 CLI 与 Web 通过同一 registry 漏斗管理同一批资源，两个面永不矛盾，锁成 CI/提交期不变量)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：CLI/Web 管理面平价守卫 (parityGuard.checkParity — 证明 CLI 与 Web 通过同一 registry 漏斗管理同一批资源，两个面永不矛盾，锁成 CI/提交期不变量)。
  - 验证：`node --test services/backend/tests/services/management/parityGuardWiring.test.js`

**423.** 验证「CLI/Web 管理面平价守卫 (parityGuard.checkParity — 证明 CLI 与 Web 通过同一 registry 漏斗管理同一批资源，两个面永不矛盾，锁成 CI/提交期不变量)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：CLI/Web 管理面平价守卫 (parityGuard.checkParity — 证明 CLI 与 Web 通过同一 registry 漏斗管理同一批资源，两个面永不矛盾，锁成 CI/提交期不变量)。
  - 验证：`node --check services/backend/src/services/management/parityGuard.js`

**424.** 验证「动作契约极小核验器 V 的 CI 强制 (actionContractVerifier — 模型无关可证明不变量层的 fail-closed 谓词核验器,把 P1-P8 投毒抵抗+谓词/Hoare 逻辑锁成发布门禁)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：动作契约极小核验器 V 的 CI 强制 (actionContractVerifier — 模型无关可证明不变量层的 fail-closed 谓词核验器,把 P1-P8 投毒抵抗+谓词/Hoare 逻辑锁成发布门禁)。
  - 验证：`node --test services/backend/tests/actionContractVerifier.test.js`

**425.** 验证「动作契约极小核验器 V 的 CI 强制 (actionContractVerifier — 模型无关可证明不变量层的 fail-closed 谓词核验器,把 P1-P8 投毒抵抗+谓词/Hoare 逻辑锁成发布门禁)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：动作契约极小核验器 V 的 CI 强制 (actionContractVerifier — 模型无关可证明不变量层的 fail-closed 谓词核验器,把 P1-P8 投毒抵抗+谓词/Hoare 逻辑锁成发布门禁)。
  - 验证：`node --check services/backend/src/services/syscallGateway/actionContractVerifier.js`

**426.** 验证「离线文档站生成器 (build_docs_site.js：把每个 .md 确定性渲染成同名 .html，套统一模板=顶栏/侧边栏全站导航/面包屑/目录/上下一页/mermaid 图/构建期代码高亮/滚动动画，并把 .md 链接改写成 .html 实现站内跳转；verify_docs_site.js 是 B2 验证门)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：离线文档站生成器 (build_docs_site.js：把每个 .md 确定性渲染成同名 .html，套统一模板=顶栏/侧边栏全站导航/面包屑/目录/上下一页/mermaid 图/构建期代码高亮/滚动动画，并把 .md 链接改写成 .html 实现站内跳转；verify_docs_site.js 是 B2 验证门)。
  - 验证：`npm run docs:build`

**427.** 验证「离线文档站生成器 (build_docs_site.js：把每个 .md 确定性渲染成同名 .html，套统一模板=顶栏/侧边栏全站导航/面包屑/目录/上下一页/mermaid 图/构建期代码高亮/滚动动画，并把 .md 链接改写成 .html 实现站内跳转；verify_docs_site.js 是 B2 验证门)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：离线文档站生成器 (build_docs_site.js：把每个 .md 确定性渲染成同名 .html，套统一模板=顶栏/侧边栏全站导航/面包屑/目录/上下一页/mermaid 图/构建期代码高亮/滚动动画，并把 .md 链接改写成 .html 实现站内跳转；verify_docs_site.js 是 B2 验证门)。
  - 验证：`npm run docs:lint`

**428.** 验证「离线文档站生成器 (build_docs_site.js：把每个 .md 确定性渲染成同名 .html，套统一模板=顶栏/侧边栏全站导航/面包屑/目录/上下一页/mermaid 图/构建期代码高亮/滚动动画，并把 .md 链接改写成 .html 实现站内跳转；verify_docs_site.js 是 B2 验证门)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：离线文档站生成器 (build_docs_site.js：把每个 .md 确定性渲染成同名 .html，套统一模板=顶栏/侧边栏全站导航/面包屑/目录/上下一页/mermaid 图/构建期代码高亮/滚动动画，并把 .md 链接改写成 .html 实现站内跳转；verify_docs_site.js 是 B2 验证门)。
  - 验证：`npm run docs:verify`

**429.** 验证「离线文档站生成器 (build_docs_site.js：把每个 .md 确定性渲染成同名 .html，套统一模板=顶栏/侧边栏全站导航/面包屑/目录/上下一页/mermaid 图/构建期代码高亮/滚动动画，并把 .md 链接改写成 .html 实现站内跳转；verify_docs_site.js 是 B2 验证门)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：离线文档站生成器 (build_docs_site.js：把每个 .md 确定性渲染成同名 .html，套统一模板=顶栏/侧边栏全站导航/面包屑/目录/上下一页/mermaid 图/构建期代码高亮/滚动动画，并把 .md 链接改写成 .html 实现站内跳转；verify_docs_site.js 是 B2 验证门)。
  - 验证：`node --check scripts/docs/build_docs_site.js`

**430.** 验证「离线文档站生成器 (build_docs_site.js：把每个 .md 确定性渲染成同名 .html，套统一模板=顶栏/侧边栏全站导航/面包屑/目录/上下一页/mermaid 图/构建期代码高亮/滚动动画，并把 .md 链接改写成 .html 实现站内跳转；verify_docs_site.js 是 B2 验证门)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：离线文档站生成器 (build_docs_site.js：把每个 .md 确定性渲染成同名 .html，套统一模板=顶栏/侧边栏全站导航/面包屑/目录/上下一页/mermaid 图/构建期代码高亮/滚动动画，并把 .md 链接改写成 .html 实现站内跳转；verify_docs_site.js 是 B2 验证门)。
  - 验证：`node --check scripts/docs/lint_docs_widgets.js`

**431.** 验证「离线文档站生成器 (build_docs_site.js：把每个 .md 确定性渲染成同名 .html，套统一模板=顶栏/侧边栏全站导航/面包屑/目录/上下一页/mermaid 图/构建期代码高亮/滚动动画，并把 .md 链接改写成 .html 实现站内跳转；verify_docs_site.js 是 B2 验证门)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：离线文档站生成器 (build_docs_site.js：把每个 .md 确定性渲染成同名 .html，套统一模板=顶栏/侧边栏全站导航/面包屑/目录/上下一页/mermaid 图/构建期代码高亮/滚动动画，并把 .md 链接改写成 .html 实现站内跳转；verify_docs_site.js 是 B2 验证门)。
  - 验证：`node --test scripts/docs/build_docs_site.test.js`

**432.** 验证「离线文档站生成器 (build_docs_site.js：把每个 .md 确定性渲染成同名 .html，套统一模板=顶栏/侧边栏全站导航/面包屑/目录/上下一页/mermaid 图/构建期代码高亮/滚动动画，并把 .md 链接改写成 .html 实现站内跳转；verify_docs_site.js 是 B2 验证门)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：离线文档站生成器 (build_docs_site.js：把每个 .md 确定性渲染成同名 .html，套统一模板=顶栏/侧边栏全站导航/面包屑/目录/上下一页/mermaid 图/构建期代码高亮/滚动动画，并把 .md 链接改写成 .html 实现站内跳转；verify_docs_site.js 是 B2 验证门)。
  - 验证：`node --test scripts/docs/lint_docs_widgets.test.js`

**433.** 验证「离线文档站生成器 (build_docs_site.js：把每个 .md 确定性渲染成同名 .html，套统一模板=顶栏/侧边栏全站导航/面包屑/目录/上下一页/mermaid 图/构建期代码高亮/滚动动画，并把 .md 链接改写成 .html 实现站内跳转；verify_docs_site.js 是 B2 验证门)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：离线文档站生成器 (build_docs_site.js：把每个 .md 确定性渲染成同名 .html，套统一模板=顶栏/侧边栏全站导航/面包屑/目录/上下一页/mermaid 图/构建期代码高亮/滚动动画，并把 .md 链接改写成 .html 实现站内跳转；verify_docs_site.js 是 B2 验证门)。
  - 验证：`python3 -m unittest tests.unit.test_docs_site_build`

**434.** 验证「离线文档站生成器 (build_docs_site.js：把每个 .md 确定性渲染成同名 .html，套统一模板=顶栏/侧边栏全站导航/面包屑/目录/上下一页/mermaid 图/构建期代码高亮/滚动动画，并把 .md 链接改写成 .html 实现站内跳转；verify_docs_site.js 是 B2 验证门)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：离线文档站生成器 (build_docs_site.js：把每个 .md 确定性渲染成同名 .html，套统一模板=顶栏/侧边栏全站导航/面包屑/目录/上下一页/mermaid 图/构建期代码高亮/滚动动画，并把 .md 链接改写成 .html 实现站内跳转；verify_docs_site.js 是 B2 验证门)。
  - 验证：`python3 -m py_compile setup.py scripts/release/docs_bundle_regen.py platform/khy_platform/docs_site.py`

**435.** 验证「Google Vertex AI 端点成形 CLI 接线 (khy gateway vertex：把纯叶子 vertexRequestShaping 的 URL 成形能力接到人面前，告诉用户网关表单该填什么 baseUrl/端点/鉴权)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Google Vertex AI 端点成形 CLI 接线 (khy gateway vertex：把纯叶子 vertexRequestShaping 的 URL 成形能力接到人面前，告诉用户网关表单该填什么 baseUrl/端点/鉴权)。
  - 验证：`node --check services/backend/src/services/gateway/vertexRequestShaping.js`

**436.** 验证「Google Vertex AI 端点成形 CLI 接线 (khy gateway vertex：把纯叶子 vertexRequestShaping 的 URL 成形能力接到人面前，告诉用户网关表单该填什么 baseUrl/端点/鉴权)」：跑该命令，绿灯才算这块没坏。
  - 说明：子系统：Google Vertex AI 端点成形 CLI 接线 (khy gateway vertex：把纯叶子 vertexRequestShaping 的 URL 成形能力接到人面前，告诉用户网关表单该填什么 baseUrl/端点/鉴权)。
  - 验证：`node --check services/backend/src/cli/handlers/gateway.js`


## 四、逐文件理解与补注释

**437.** 阅读「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」的 scripts/docs/check_beginner_docs.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。读懂再动。
  - 验证：`node --check scripts/docs/check_beginner_docs.js`

**438.** 阅读「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」的 scripts/docs/check_beginner_docs.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。读懂再动。
  - 验证：`node --check scripts/docs/check_beginner_docs.test.js`

**439.** 阅读「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」的 docs/02_CONCEPTS_概念入门/00_INDEX_概念入门-总览.md，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。读懂再动。
  - 验证：`npm run docs:check-beginner`

**440.** 阅读「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」的 docs/09_STORY_修仙学AI/00_INDEX_修仙学AI-总目录.md，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。读懂再动。
  - 验证：`npm run docs:check-beginner`

**441.** 阅读「Bootstrap and Packaging」的 platform/khy_platform/cli.py，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Bootstrap and Packaging。读懂再动。
  - 验证：`npm run check:manifest-sync`

**442.** 阅读「Bootstrap and Packaging」的 platform/khy_platform/_bootstrap.py，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Bootstrap and Packaging。读懂再动。
  - 验证：`npm run check:manifest-sync`

**443.** 阅读「Bootstrap and Packaging」的 platform/khy_platform/__init__.py，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Bootstrap and Packaging。读懂再动。
  - 验证：`npm run check:manifest-sync`

**444.** 阅读「Bootstrap and Packaging」的 pyproject.toml，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Bootstrap and Packaging。读懂再动。
  - 验证：`npm run check:manifest-sync`

**445.** 阅读「Bootstrap and Packaging」的 software/khyquant/setup.py，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Bootstrap and Packaging。读懂再动。
  - 验证：`npm run check:manifest-sync`

**446.** 阅读「Bootstrap and Packaging」的 software/khyquant/MANIFEST.in，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Bootstrap and Packaging。读懂再动。
  - 验证：`npm run check:manifest-sync`

**447.** 阅读「Bootstrap and Packaging」的 packaging/npm/package.json，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Bootstrap and Packaging。读懂再动。
  - 验证：`npm run check:manifest-sync`

**448.** 阅读「Bootstrap and Packaging」的 services/backend/package.json，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Bootstrap and Packaging。读懂再动。
  - 验证：`npm run check:manifest-sync`

**449.** 阅读「CLI Routing and Help Surface」的 services/backend/src/constants/commandSchema.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：CLI Routing and Help Surface。读懂再动。
  - 验证：`node --check services/backend/src/constants/commandSchema.js`

**450.** 阅读「CLI Routing and Help Surface」的 services/backend/src/cli/aliases.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：CLI Routing and Help Surface。读懂再动。
  - 验证：`node --check services/backend/src/cli/aliases.js`

**451.** 阅读「CLI Routing and Help Surface」的 services/backend/src/cli/router.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：CLI Routing and Help Surface。读懂再动。
  - 验证：`node --check services/backend/src/cli/router.js`

**452.** 阅读「CLI Routing and Help Surface」的 services/backend/src/cli/repl.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：CLI Routing and Help Surface。读懂再动。
  - 验证：`node --check services/backend/src/cli/repl.js`

**453.** 阅读「CLI Routing and Help Surface」的 services/backend/src/cli/handlers，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：CLI Routing and Help Surface。读懂再动。
  - 验证：`npm run test:one -- services/backend/tests/cli/router.test.js services/backend/tests/cli/repl.tasks.interaction.test.js`

**454.** 阅读「CLI Routing and Help Surface」的 services/backend/tests/cli/router.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：CLI Routing and Help Surface。读懂再动。
  - 验证：`node --check services/backend/tests/cli/router.test.js`

**455.** 阅读「CLI Routing and Help Surface」的 services/backend/tests/cli/repl.tasks.interaction.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：CLI Routing and Help Surface。读懂再动。
  - 验证：`node --check services/backend/tests/cli/repl.tasks.interaction.test.js`

**456.** 阅读「Prompt Capsule and Debug Prompt System」的 services/backend/src/constants/prompts.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Prompt Capsule and Debug Prompt System。读懂再动。
  - 验证：`node --check services/backend/src/constants/prompts.js`

**457.** 阅读「Prompt Capsule and Debug Prompt System」的 services/backend/src/services/khyUpgradeRuntime.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Prompt Capsule and Debug Prompt System。读懂再动。
  - 验证：`node --check services/backend/src/services/khyUpgradeRuntime.js`

**458.** 阅读「Prompt Capsule and Debug Prompt System」的 services/backend/src/services/compact/prompt.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Prompt Capsule and Debug Prompt System。读懂再动。
  - 验证：`node --check services/backend/src/services/compact/prompt.js`

**459.** 阅读「Prompt Capsule and Debug Prompt System」的 services/backend/src/cli/handlers/gateway.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Prompt Capsule and Debug Prompt System。读懂再动。
  - 验证：`node --check services/backend/src/cli/handlers/gateway.js`

**460.** 阅读「Prompt Capsule and Debug Prompt System」的 services/backend/tests/promptOnDemandSections.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Prompt Capsule and Debug Prompt System。读懂再动。
  - 验证：`node --check services/backend/tests/promptOnDemandSections.test.js`

**461.** 阅读「Prompt Capsule and Debug Prompt System」的 services/backend/tests/promptLearningRules.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Prompt Capsule and Debug Prompt System。读懂再动。
  - 验证：`node --check services/backend/tests/promptLearningRules.test.js`

**462.** 阅读「Prompt Capsule and Debug Prompt System」的 services/backend/tests/gatewayDebugPrompt.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Prompt Capsule and Debug Prompt System。读懂再动。
  - 验证：`node --check services/backend/tests/gatewayDebugPrompt.test.js`

**463.** 阅读「AI Gateway and Adapter Layer」的 services/backend/src/services/gateway/aiGateway.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：AI Gateway and Adapter Layer。读懂再动。
  - 验证：`node --check services/backend/src/services/gateway/aiGateway.js`

**464.** 阅读「AI Gateway and Adapter Layer」的 services/backend/src/services/gateway/adapters，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：AI Gateway and Adapter Layer。读懂再动。
  - 验证：`npm run test:one -- services/backend/tests/aiGateway.stability.test.js services/backend/tests/gateway/transportResilience.test.js services/backend/tests/gatewayAdapters.stability.test.js`

**465.** 阅读「AI Gateway and Adapter Layer」的 services/backend/src/services/gateway/proxyServer.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：AI Gateway and Adapter Layer。读懂再动。
  - 验证：`node --check services/backend/src/services/gateway/proxyServer.js`

**466.** 阅读「AI Gateway and Adapter Layer」的 services/backend/tests/aiGateway.stability.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：AI Gateway and Adapter Layer。读懂再动。
  - 验证：`node --check services/backend/tests/aiGateway.stability.test.js`

**467.** 阅读「AI Gateway and Adapter Layer」的 services/backend/tests/gateway/transportResilience.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：AI Gateway and Adapter Layer。读懂再动。
  - 验证：`node --check services/backend/tests/gateway/transportResilience.test.js`

**468.** 阅读「AI Gateway and Adapter Layer」的 services/backend/tests/gatewayAdapters.stability.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：AI Gateway and Adapter Layer。读懂再动。
  - 验证：`node --check services/backend/tests/gatewayAdapters.stability.test.js`

**469.** 阅读「Proxy, Daemon, and Runtime Port Discovery」的 services/backend/src/services/daemonManager.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Proxy, Daemon, and Runtime Port Discovery。读懂再动。
  - 验证：`node --check services/backend/src/services/daemonManager.js`

**470.** 阅读「Proxy, Daemon, and Runtime Port Discovery」的 services/backend/src/services/aiManagementServer.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Proxy, Daemon, and Runtime Port Discovery。读懂再动。
  - 验证：`node --check services/backend/src/services/aiManagementServer.js`

**471.** 阅读「Proxy, Daemon, and Runtime Port Discovery」的 services/backend/src/services/gateway/proxyServer.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Proxy, Daemon, and Runtime Port Discovery。读懂再动。
  - 验证：`node --check services/backend/src/services/gateway/proxyServer.js`

**472.** 阅读「Proxy, Daemon, and Runtime Port Discovery」的 services/backend/src/utils/proxyBaseUrl.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Proxy, Daemon, and Runtime Port Discovery。读懂再动。
  - 验证：`node --check services/backend/src/utils/proxyBaseUrl.js`

**473.** 阅读「Proxy, Daemon, and Runtime Port Discovery」的 services/backend/src/constants/serviceDefaults.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Proxy, Daemon, and Runtime Port Discovery。读懂再动。
  - 验证：`node --check services/backend/src/constants/serviceDefaults.js`

**474.** 阅读「Proxy, Daemon, and Runtime Port Discovery」的 services/backend/tests/daemonManager.runtimePort.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Proxy, Daemon, and Runtime Port Discovery。读懂再动。
  - 验证：`node --check services/backend/tests/daemonManager.runtimePort.test.js`

**475.** 阅读「Proxy, Daemon, and Runtime Port Discovery」的 services/backend/tests/gatewayManage.portDrift.integration.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Proxy, Daemon, and Runtime Port Discovery。读懂再动。
  - 验证：`node --check services/backend/tests/gatewayManage.portDrift.integration.test.js`

**476.** 阅读「Proxy, Daemon, and Runtime Port Discovery」的 services/backend/tests/services/proxyBaseUrl.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Proxy, Daemon, and Runtime Port Discovery。读懂再动。
  - 验证：`node --check services/backend/tests/services/proxyBaseUrl.test.js`

**477.** 阅读「Proxy, Daemon, and Runtime Port Discovery」的 services/backend/tests/services/serviceDefaults.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Proxy, Daemon, and Runtime Port Discovery。读懂再动。
  - 验证：`node --check services/backend/tests/services/serviceDefaults.test.js`

**478.** 阅读「AI Management UI and API」的 services/backend/src/routes/aiGatewayAdmin.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：AI Management UI and API。读懂再动。
  - 验证：`node --check services/backend/src/routes/aiGatewayAdmin.js`

**479.** 阅读「AI Management UI and API」的 services/ai-backend/src/routes/aiGatewayAdmin.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：AI Management UI and API。读懂再动。
  - 验证：`node --check services/ai-backend/src/routes/aiGatewayAdmin.js`

**480.** 阅读「AI Management UI and API」的 apps/ai-frontend/src，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：AI Management UI and API。读懂再动。
  - 验证：`npm run test:one -- services/backend/tests/routes/aiGatewayAdmin.modelSlots.test.js services/backend/tests/gatewayManage.apiDisplay.test.js`

**481.** 阅读「AI Management UI and API」的 apps/ai-frontend/package.json，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：AI Management UI and API。读懂再动。
  - 验证：`npm run test:one -- services/backend/tests/routes/aiGatewayAdmin.modelSlots.test.js services/backend/tests/gatewayManage.apiDisplay.test.js`

**482.** 阅读「AI Management UI and API」的 apps/ai-frontend/vite.config.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：AI Management UI and API。读懂再动。
  - 验证：`node --check apps/ai-frontend/vite.config.js`

**483.** 阅读「AI Management UI and API」的 services/backend/src/cli/handlers/gateway.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：AI Management UI and API。读懂再动。
  - 验证：`node --check services/backend/src/cli/handlers/gateway.js`

**484.** 阅读「AI Management UI and API」的 services/backend/tests/routes/aiGatewayAdmin.modelSlots.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：AI Management UI and API。读懂再动。
  - 验证：`node --check services/backend/tests/routes/aiGatewayAdmin.modelSlots.test.js`

**485.** 阅读「AI Management UI and API」的 services/backend/tests/gatewayManage.apiDisplay.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：AI Management UI and API。读懂再动。
  - 验证：`node --check services/backend/tests/gatewayManage.apiDisplay.test.js`

**486.** 阅读「Coding Projects (named workspaces + chat linkage)」的 platform/packages/shared/src/models/UserProject.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。读懂再动。
  - 验证：`node --check platform/packages/shared/src/models/UserProject.js`

**487.** 阅读「Coding Projects (named workspaces + chat linkage)」的 platform/packages/shared/src/models/index.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。读懂再动。
  - 验证：`node --check platform/packages/shared/src/models/index.js`

**488.** 阅读「Coding Projects (named workspaces + chat linkage)」的 services/backend/src/services/projectStore.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。读懂再动。
  - 验证：`node --check services/backend/src/services/projectStore.js`

**489.** 阅读「Coding Projects (named workspaces + chat linkage)」的 services/backend/src/services/aiManagementProjects.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。读懂再动。
  - 验证：`node --check services/backend/src/services/aiManagementProjects.js`

**490.** 阅读「Coding Projects (named workspaces + chat linkage)」的 services/backend/src/services/aiManagementServer.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。读懂再动。
  - 验证：`node --check services/backend/src/services/aiManagementServer.js`

**491.** 阅读「Coding Projects (named workspaces + chat linkage)」的 platform/packages/shared/src/models/Conversation.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。读懂再动。
  - 验证：`node --check platform/packages/shared/src/models/Conversation.js`

**492.** 阅读「Coding Projects (named workspaces + chat linkage)」的 services/backend/src/services/conversationStore.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。读懂再动。
  - 验证：`node --check services/backend/src/services/conversationStore.js`

**493.** 阅读「Coding Projects (named workspaces + chat linkage)」的 apps/ai-frontend/src/composables/useProjects.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。读懂再动。
  - 验证：`node --check apps/ai-frontend/src/composables/useProjects.js`

**494.** 阅读「Coding Projects (named workspaces + chat linkage)」的 apps/ai-frontend/src/composables/useChatConversations.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。读懂再动。
  - 验证：`node --check apps/ai-frontend/src/composables/useChatConversations.js`

**495.** 阅读「Coding Projects (named workspaces + chat linkage)」的 apps/ai-frontend/src/views/Projects.vue，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。读懂再动。
  - 验证：`npm run test:one -- services/backend/tests/projectStore.test.js apps/ai-frontend/src/composables/useProjects.wiring.test.js`

**496.** 阅读「Coding Projects (named workspaces + chat linkage)」的 apps/ai-frontend/src/views/AIChat.vue，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。读懂再动。
  - 验证：`npm run test:one -- services/backend/tests/projectStore.test.js apps/ai-frontend/src/composables/useProjects.wiring.test.js`

**497.** 阅读「Coding Projects (named workspaces + chat linkage)」的 apps/ai-frontend/src/composables/useRoutePrefetch.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。读懂再动。
  - 验证：`node --check apps/ai-frontend/src/composables/useRoutePrefetch.js`

**498.** 阅读「Coding Projects (named workspaces + chat linkage)」的 apps/ai-frontend/src/router/index.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。读懂再动。
  - 验证：`node --check apps/ai-frontend/src/router/index.js`

**499.** 阅读「Coding Projects (named workspaces + chat linkage)」的 apps/ai-frontend/src/views/Layout.vue，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。读懂再动。
  - 验证：`npm run test:one -- services/backend/tests/projectStore.test.js apps/ai-frontend/src/composables/useProjects.wiring.test.js`

**500.** 阅读「Coding Projects (named workspaces + chat linkage)」的 services/backend/tests/projectStore.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。读懂再动。
  - 验证：`node --check services/backend/tests/projectStore.test.js`

**501.** 阅读「Coding Projects (named workspaces + chat linkage)」的 apps/ai-frontend/src/composables/useProjects.wiring.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。读懂再动。
  - 验证：`node --check apps/ai-frontend/src/composables/useProjects.wiring.test.js`

**502.** 阅读「Workspace, Publish, and Verification Commands」的 services/backend/src/cli/handlers/workspace.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Workspace, Publish, and Verification Commands。读懂再动。
  - 验证：`node --check services/backend/src/cli/handlers/workspace.js`

**503.** 阅读「Workspace, Publish, and Verification Commands」的 services/backend/src/cli/handlers/publish.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Workspace, Publish, and Verification Commands。读懂再动。
  - 验证：`node --check services/backend/src/cli/handlers/publish.js`

**504.** 阅读「Workspace, Publish, and Verification Commands」的 services/backend/src/cli/handlers/verify.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Workspace, Publish, and Verification Commands。读懂再动。
  - 验证：`node --check services/backend/src/cli/handlers/verify.js`

**505.** 阅读「Workspace, Publish, and Verification Commands」的 services/backend/tests/publish.sourceReleaseMode.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Workspace, Publish, and Verification Commands。读懂再动。
  - 验证：`node --check services/backend/tests/publish.sourceReleaseMode.test.js`

**506.** 阅读「Workspace, Publish, and Verification Commands」的 services/backend/tests/publish.dbPreflight.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Workspace, Publish, and Verification Commands。读懂再动。
  - 验证：`node --check services/backend/tests/publish.dbPreflight.test.js`

**507.** 阅读「Maintenance Safety and Rule Gates」的 AGENTS.md，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Maintenance Safety and Rule Gates。读懂再动。
  - 验证：`npm run check:changed`

**508.** 阅读「Maintenance Safety and Rule Gates」的 CONTRIBUTING.md，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Maintenance Safety and Rule Gates。读懂再动。
  - 验证：`npm run check:changed`

**509.** 阅读「Maintenance Safety and Rule Gates」的 scripts/ci/check-agent-rules.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Maintenance Safety and Rule Gates。读懂再动。
  - 验证：`node --check scripts/ci/check-agent-rules.js`

**510.** 阅读「Maintenance Safety and Rule Gates」的 scripts/ci/check-change-safety.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Maintenance Safety and Rule Gates。读懂再动。
  - 验证：`node --check scripts/ci/check-change-safety.js`

**511.** 阅读「Maintenance Safety and Rule Gates」的 scripts/install/install-git-hooks.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Maintenance Safety and Rule Gates。读懂再动。
  - 验证：`node --check scripts/install/install-git-hooks.js`

**512.** 阅读「Maintenance Safety and Rule Gates」的 scripts/ci/check-version-sync.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Maintenance Safety and Rule Gates。读懂再动。
  - 验证：`node --check scripts/ci/check-version-sync.js`

**513.** 阅读「Maintenance Safety and Rule Gates」的 scripts/ci/check-node-syntax.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Maintenance Safety and Rule Gates。读懂再动。
  - 验证：`node --check scripts/ci/check-node-syntax.js`

**514.** 阅读「Maintenance Safety and Rule Gates」的 scripts/ci/check-python-syntax.py，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Maintenance Safety and Rule Gates。读懂再动。
  - 验证：`npm run check:changed`

**515.** 阅读「Maintenance Safety and Rule Gates」的 docs/_维护者/维护映射表.json，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Maintenance Safety and Rule Gates。读懂再动。
  - 验证：`npm run check:changed`

**516.** 阅读「Release and Rollback」的 services/backend/src/cli/handlers/publish.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Release and Rollback。读懂再动。
  - 验证：`node --check services/backend/src/cli/handlers/publish.js`

**517.** 阅读「Release and Rollback」的 scripts/release/build-and-audit-pip-purity.sh，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Release and Rollback。读懂再动。
  - 验证：`npm run test:one -- services/backend/tests/publish.sourceReleaseMode.test.js services/backend/tests/publish.dbPreflight.test.js`

**518.** 阅读「Release and Rollback」的 scripts/ci/check-version-sync.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Release and Rollback。读懂再动。
  - 验证：`node --check scripts/ci/check-version-sync.js`

**519.** 阅读「Build Best Environment (Self-check / Repair / Probes)」的 services/backend/src/services/localBrainEnvOptimize.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Build Best Environment (Self-check / Repair / Probes)。读懂再动。
  - 验证：`node --check services/backend/src/services/localBrainEnvOptimize.js`

**520.** 阅读「Build Best Environment (Self-check / Repair / Probes)」的 services/backend/src/services/envProbes.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Build Best Environment (Self-check / Repair / Probes)。读懂再动。
  - 验证：`node --check services/backend/src/services/envProbes.js`

**521.** 阅读「Build Best Environment (Self-check / Repair / Probes)」的 services/backend/src/services/envRepair.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Build Best Environment (Self-check / Repair / Probes)。读懂再动。
  - 验证：`node --check services/backend/src/services/envRepair.js`

**522.** 阅读「Build Best Environment (Self-check / Repair / Probes)」的 services/backend/src/services/envPlatform.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Build Best Environment (Self-check / Repair / Probes)。读懂再动。
  - 验证：`node --check services/backend/src/services/envPlatform.js`

**523.** 阅读「Build Best Environment (Self-check / Repair / Probes)」的 services/backend/src/services/diskCleanup，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Build Best Environment (Self-check / Repair / Probes)。读懂再动。
  - 验证：`npm run test:one -- services/backend/tests/services/localBrainEnvOptimize.test.js services/backend/tests/services/envProbes.test.js services/backend/tests/services/envRepair.test.js services/backend/tests/services/envPlatform.test.js`

**524.** 阅读「Build Best Environment (Self-check / Repair / Probes)」的 services/backend/src/services/localBrainService.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Build Best Environment (Self-check / Repair / Probes)。读懂再动。
  - 验证：`node --check services/backend/src/services/localBrainService.js`

**525.** 阅读「Build Best Environment (Self-check / Repair / Probes)」的 services/backend/src/cli/tui/hooks/useQueryBridge.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Build Best Environment (Self-check / Repair / Probes)。读懂再动。
  - 验证：`node --check services/backend/src/cli/tui/hooks/useQueryBridge.js`

**526.** 阅读「Build Best Environment (Self-check / Repair / Probes)」的 services/backend/tests/services/localBrainEnvOptimize.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Build Best Environment (Self-check / Repair / Probes)。读懂再动。
  - 验证：`node --check services/backend/tests/services/localBrainEnvOptimize.test.js`

**527.** 阅读「Build Best Environment (Self-check / Repair / Probes)」的 services/backend/tests/services/envProbes.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Build Best Environment (Self-check / Repair / Probes)。读懂再动。
  - 验证：`node --check services/backend/tests/services/envProbes.test.js`

**528.** 阅读「Build Best Environment (Self-check / Repair / Probes)」的 services/backend/tests/services/envRepair.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Build Best Environment (Self-check / Repair / Probes)。读懂再动。
  - 验证：`node --check services/backend/tests/services/envRepair.test.js`

**529.** 阅读「Build Best Environment (Self-check / Repair / Probes)」的 services/backend/tests/services/envPlatform.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Build Best Environment (Self-check / Repair / Probes)。读懂再动。
  - 验证：`node --check services/backend/tests/services/envPlatform.test.js`

**530.** 阅读「Evolution Prompt Playbook (1000 preset prompts)」的 scripts/docs/gen-evolution-prompts.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Evolution Prompt Playbook (1000 preset prompts)。读懂再动。
  - 验证：`node --check scripts/docs/gen-evolution-prompts.js`

**531.** 阅读「Evolution Prompt Playbook (1000 preset prompts)」的 scripts/tests/gen-evolution-prompts.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Evolution Prompt Playbook (1000 preset prompts)。读懂再动。
  - 验证：`node --check scripts/tests/gen-evolution-prompts.test.js`

**532.** 阅读「Evolution Prompt Playbook (1000 preset prompts)」的 docs/_维护者/维护映射表.json，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Evolution Prompt Playbook (1000 preset prompts)。读懂再动。
  - 验证：`npm run test:one -- scripts/tests/gen-evolution-prompts.test.js`

**533.** 阅读「Symptom Triage (route a symptom to its subsystem)」的 scripts/lib/maintainerTriage.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Symptom Triage (route a symptom to its subsystem)。读懂再动。
  - 验证：`node --check scripts/lib/maintainerTriage.js`

**534.** 阅读「Symptom Triage (route a symptom to its subsystem)」的 scripts/diagnostics/triage.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Symptom Triage (route a symptom to its subsystem)。读懂再动。
  - 验证：`node --check scripts/diagnostics/triage.js`

**535.** 阅读「Symptom Triage (route a symptom to its subsystem)」的 scripts/tests/maintainerTriage.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Symptom Triage (route a symptom to its subsystem)。读懂再动。
  - 验证：`node --check scripts/tests/maintainerTriage.test.js`

**536.** 阅读「Symptom Triage (route a symptom to its subsystem)」的 docs/_维护者/维护映射表.json，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Symptom Triage (route a symptom to its subsystem)。读懂再动。
  - 验证：`npm run test:one -- scripts/tests/maintainerTriage.test.js`

**537.** 阅读「Off-machine Restore Readiness (can a fresh machine restore khyos?)」的 scripts/lib/restoreReadiness.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Off-machine Restore Readiness (can a fresh machine restore khyos?)。读懂再动。
  - 验证：`node --check scripts/lib/restoreReadiness.js`

**538.** 阅读「Off-machine Restore Readiness (can a fresh machine restore khyos?)」的 scripts/restore-check.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Off-machine Restore Readiness (can a fresh machine restore khyos?)。读懂再动。
  - 验证：`node --check scripts/restore-check.js`

**539.** 阅读「Off-machine Restore Readiness (can a fresh machine restore khyos?)」的 scripts/tests/restoreReadiness.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Off-machine Restore Readiness (can a fresh machine restore khyos?)。读懂再动。
  - 验证：`node --check scripts/tests/restoreReadiness.test.js`

**540.** 阅读「Installed-copy Integrity (is the on-disk bundle actually complete?)」的 scripts/lib/installIntegrity.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Installed-copy Integrity (is the on-disk bundle actually complete?)。读懂再动。
  - 验证：`node --check scripts/lib/installIntegrity.js`

**541.** 阅读「Installed-copy Integrity (is the on-disk bundle actually complete?)」的 scripts/verify-install.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Installed-copy Integrity (is the on-disk bundle actually complete?)。读懂再动。
  - 验证：`node --check scripts/verify-install.js`

**542.** 阅读「Installed-copy Integrity (is the on-disk bundle actually complete?)」的 scripts/tests/installIntegrity.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Installed-copy Integrity (is the on-disk bundle actually complete?)。读懂再动。
  - 验证：`node --check scripts/tests/installIntegrity.test.js`

**543.** 阅读「First-run Hydration Health (did the online dependency hydrate actually succeed?)」的 scripts/lib/hydrationHealth.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：First-run Hydration Health (did the online dependency hydrate actually succeed?)。读懂再动。
  - 验证：`node --check scripts/lib/hydrationHealth.js`

**544.** 阅读「First-run Hydration Health (did the online dependency hydrate actually succeed?)」的 scripts/hydration-doctor.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：First-run Hydration Health (did the online dependency hydrate actually succeed?)。读懂再动。
  - 验证：`node --check scripts/hydration-doctor.js`

**545.** 阅读「First-run Hydration Health (did the online dependency hydrate actually succeed?)」的 scripts/tests/hydrationHealth.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：First-run Hydration Health (did the online dependency hydrate actually succeed?)。读懂再动。
  - 验证：`node --check scripts/tests/hydrationHealth.test.js`

**546.** 阅读「Agent Restore Plan Synthesizer (one ordered, autonomy-classified restore plan a landing agent can drive)」的 scripts/lib/agentRestorePlan.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Agent Restore Plan Synthesizer (one ordered, autonomy-classified restore plan a landing agent can drive)。读懂再动。
  - 验证：`node --check scripts/lib/agentRestorePlan.js`

**547.** 阅读「Agent Restore Plan Synthesizer (one ordered, autonomy-classified restore plan a landing agent can drive)」的 scripts/restore-plan.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Agent Restore Plan Synthesizer (one ordered, autonomy-classified restore plan a landing agent can drive)。读懂再动。
  - 验证：`node --check scripts/restore-plan.js`

**548.** 阅读「Agent Restore Plan Synthesizer (one ordered, autonomy-classified restore plan a landing agent can drive)」的 scripts/tests/agentRestorePlan.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Agent Restore Plan Synthesizer (one ordered, autonomy-classified restore plan a landing agent can drive)。读懂再动。
  - 验证：`node --check scripts/tests/agentRestorePlan.test.js`

**549.** 阅读「Cross-mirror Restore Conflict Detector (do the three restore self-checks contradict each other before an agent auto-drives?)」的 scripts/lib/restoreConflictDetector.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Cross-mirror Restore Conflict Detector (do the three restore self-checks contradict each other before an agent auto-drives?)。读懂再动。
  - 验证：`node --check scripts/lib/restoreConflictDetector.js`

**550.** 阅读「Cross-mirror Restore Conflict Detector (do the three restore self-checks contradict each other before an agent auto-drives?)」的 scripts/restore-conflicts.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Cross-mirror Restore Conflict Detector (do the three restore self-checks contradict each other before an agent auto-drives?)。读懂再动。
  - 验证：`node --check scripts/restore-conflicts.js`

**551.** 阅读「Cross-mirror Restore Conflict Detector (do the three restore self-checks contradict each other before an agent auto-drives?)」的 scripts/tests/restoreConflictDetector.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Cross-mirror Restore Conflict Detector (do the three restore self-checks contradict each other before an agent auto-drives?)。读懂再动。
  - 验证：`node --check scripts/tests/restoreConflictDetector.test.js`

**552.** 阅读「Cross-mirror Restore Conflict Resolver (given a detected contradiction, how does an agent safely resolve it step-by-step, and where must it hand off to a human?)」的 scripts/lib/restoreConflictResolver.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Cross-mirror Restore Conflict Resolver (given a detected contradiction, how does an agent safely resolve it step-by-step, and where must it hand off to a human?)。读懂再动。
  - 验证：`node --check scripts/lib/restoreConflictResolver.js`

**553.** 阅读「Cross-mirror Restore Conflict Resolver (given a detected contradiction, how does an agent safely resolve it step-by-step, and where must it hand off to a human?)」的 scripts/restore-resolve.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Cross-mirror Restore Conflict Resolver (given a detected contradiction, how does an agent safely resolve it step-by-step, and where must it hand off to a human?)。读懂再动。
  - 验证：`node --check scripts/restore-resolve.js`

**554.** 阅读「Cross-mirror Restore Conflict Resolver (given a detected contradiction, how does an agent safely resolve it step-by-step, and where must it hand off to a human?)」的 scripts/tests/restoreConflictResolver.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Cross-mirror Restore Conflict Resolver (given a detected contradiction, how does an agent safely resolve it step-by-step, and where must it hand off to a human?)。读懂再动。
  - 验证：`node --check scripts/tests/restoreConflictResolver.test.js`

**555.** 阅读「Off-machine Launch-entry Contract (does each channel pin the launch script it execs?)」的 scripts/lib/bundleLaunchContract.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Off-machine Launch-entry Contract (does each channel pin the launch script it execs?)。读懂再动。
  - 验证：`node --check scripts/lib/bundleLaunchContract.js`

**556.** 阅读「Off-machine Launch-entry Contract (does each channel pin the launch script it execs?)」的 scripts/tests/bundleLaunchContract.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Off-machine Launch-entry Contract (does each channel pin the launch script it execs?)。读懂再动。
  - 验证：`node --check scripts/tests/bundleLaunchContract.test.js`

**557.** 阅读「Off-machine Launch-entry Contract (does each channel pin the launch script it execs?)」的 scripts/release/pip_packaging_rules.py，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Off-machine Launch-entry Contract (does each channel pin the launch script it execs?)。读懂再动。
  - 验证：`npm run test:one -- scripts/tests/bundleLaunchContract.test.js`

**558.** 阅读「Off-machine Launch-entry Contract (does each channel pin the launch script it execs?)」的 packaging/npm/scripts/audit-purity.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Off-machine Launch-entry Contract (does each channel pin the launch script it execs?)。读懂再动。
  - 验证：`node --check packaging/npm/scripts/audit-purity.js`

**559.** 阅读「Proxy Egress Bridge (select node + enable/disable)」的 services/backend/src/services/proxy/proxyCoreConfigGen.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Proxy Egress Bridge (select node + enable/disable)。读懂再动。
  - 验证：`node --check services/backend/src/services/proxy/proxyCoreConfigGen.js`

**560.** 阅读「Proxy Egress Bridge (select node + enable/disable)」的 services/backend/src/services/proxy/proxyCoreManager.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Proxy Egress Bridge (select node + enable/disable)。读懂再动。
  - 验证：`node --check services/backend/src/services/proxy/proxyCoreManager.js`

**561.** 阅读「Proxy Egress Bridge (select node + enable/disable)」的 services/backend/src/services/proxyConfigService.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Proxy Egress Bridge (select node + enable/disable)。读懂再动。
  - 验证：`node --check services/backend/src/services/proxyConfigService.js`

**562.** 阅读「Proxy Egress Bridge (select node + enable/disable)」的 services/backend/src/services/aiManagementProxyEgress.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Proxy Egress Bridge (select node + enable/disable)。读懂再动。
  - 验证：`node --check services/backend/src/services/aiManagementProxyEgress.js`

**563.** 阅读「Proxy Egress Bridge (select node + enable/disable)」的 services/backend/src/services/aiManagementServer.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Proxy Egress Bridge (select node + enable/disable)。读懂再动。
  - 验证：`node --check services/backend/src/services/aiManagementServer.js`

**564.** 阅读「Proxy Egress Bridge (select node + enable/disable)」的 apps/ai-frontend/src/composables/useProxies.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Proxy Egress Bridge (select node + enable/disable)。读懂再动。
  - 验证：`node --check apps/ai-frontend/src/composables/useProxies.js`

**565.** 阅读「Proxy Egress Bridge (select node + enable/disable)」的 apps/ai-frontend/src/views/ProxyManagement.vue，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Proxy Egress Bridge (select node + enable/disable)。读懂再动。
  - 验证：`npm run test:one -- services/backend/tests/proxyCoreConfigGen.test.js services/backend/tests/proxyCoreManager.test.js services/backend/tests/proxyConfigService.egress.test.js services/backend/tests/aiManagementProxyEgress.wiring.test.js apps/ai-frontend/src/composables/useProxies.egress.wiring.test.js services/backend/tests/bootstrap/ensureProxyCoreEnv.test.js services/backend/tests/services/proxyCoreInstaller.test.js`

**566.** 阅读「Proxy Egress Bridge (select node + enable/disable)」的 services/backend/tests/proxyCoreConfigGen.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Proxy Egress Bridge (select node + enable/disable)。读懂再动。
  - 验证：`node --check services/backend/tests/proxyCoreConfigGen.test.js`

**567.** 阅读「Proxy Egress Bridge (select node + enable/disable)」的 services/backend/tests/proxyCoreManager.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Proxy Egress Bridge (select node + enable/disable)。读懂再动。
  - 验证：`node --check services/backend/tests/proxyCoreManager.test.js`

**568.** 阅读「Proxy Egress Bridge (select node + enable/disable)」的 services/backend/tests/proxyConfigService.egress.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Proxy Egress Bridge (select node + enable/disable)。读懂再动。
  - 验证：`node --check services/backend/tests/proxyConfigService.egress.test.js`

**569.** 阅读「Proxy Egress Bridge (select node + enable/disable)」的 services/backend/tests/aiManagementProxyEgress.wiring.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Proxy Egress Bridge (select node + enable/disable)。读懂再动。
  - 验证：`node --check services/backend/tests/aiManagementProxyEgress.wiring.test.js`

**570.** 阅读「Proxy Egress Bridge (select node + enable/disable)」的 apps/ai-frontend/src/composables/useProxies.egress.wiring.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Proxy Egress Bridge (select node + enable/disable)。读懂再动。
  - 验证：`node --check apps/ai-frontend/src/composables/useProxies.egress.wiring.test.js`

**571.** 阅读「Proxy Egress Bridge (select node + enable/disable)」的 services/backend/src/bootstrap/ensureProxyCoreEnv.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Proxy Egress Bridge (select node + enable/disable)。读懂再动。
  - 验证：`node --check services/backend/src/bootstrap/ensureProxyCoreEnv.js`

**572.** 阅读「Proxy Egress Bridge (select node + enable/disable)」的 services/backend/src/services/proxy/proxyCoreInstaller.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Proxy Egress Bridge (select node + enable/disable)。读懂再动。
  - 验证：`node --check services/backend/src/services/proxy/proxyCoreInstaller.js`

**573.** 阅读「Proxy Egress Bridge (select node + enable/disable)」的 services/backend/tests/bootstrap/ensureProxyCoreEnv.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Proxy Egress Bridge (select node + enable/disable)。读懂再动。
  - 验证：`node --check services/backend/tests/bootstrap/ensureProxyCoreEnv.test.js`

**574.** 阅读「Proxy Egress Bridge (select node + enable/disable)」的 services/backend/tests/services/proxyCoreInstaller.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：Proxy Egress Bridge (select node + enable/disable)。读懂再动。
  - 验证：`node --check services/backend/tests/services/proxyCoreInstaller.test.js`

**575.** 阅读「斜杠命令菜单单一真源(经典REPL⇄TUI)」的 services/backend/src/cli/slashExtraCommands.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：斜杠命令菜单单一真源(经典REPL⇄TUI)。读懂再动。
  - 验证：`node --check services/backend/src/cli/slashExtraCommands.js`

**576.** 阅读「斜杠命令菜单单一真源(经典REPL⇄TUI)」的 services/backend/src/cli/resumeHint.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：斜杠命令菜单单一真源(经典REPL⇄TUI)。读懂再动。
  - 验证：`node --check services/backend/src/cli/resumeHint.js`

**577.** 阅读「斜杠命令菜单单一真源(经典REPL⇄TUI)」的 services/backend/src/cli/replSession.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：斜杠命令菜单单一真源(经典REPL⇄TUI)。读懂再动。
  - 验证：`node --check services/backend/src/cli/replSession.js`

**578.** 阅读「斜杠命令菜单单一真源(经典REPL⇄TUI)」的 services/backend/src/cli/tui/hooks/useCompletions.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：斜杠命令菜单单一真源(经典REPL⇄TUI)。读懂再动。
  - 验证：`node --check services/backend/src/cli/tui/hooks/useCompletions.js`

**579.** 阅读「斜杠命令菜单单一真源(经典REPL⇄TUI)」的 services/backend/src/cli/tui/app.jsx，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：斜杠命令菜单单一真源(经典REPL⇄TUI)。读懂再动。
  - 验证：`npm run maintainer:check`

**580.** 阅读「斜杠命令菜单单一真源(经典REPL⇄TUI)」的 services/backend/tests/slashExtraCommands.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：斜杠命令菜单单一真源(经典REPL⇄TUI)。读懂再动。
  - 验证：`node --check services/backend/tests/slashExtraCommands.test.js`

**581.** 阅读「斜杠命令菜单单一真源(经典REPL⇄TUI)」的 services/backend/tests/cli/resumeHint.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：斜杠命令菜单单一真源(经典REPL⇄TUI)。读懂再动。
  - 验证：`node --check services/backend/tests/cli/resumeHint.test.js`

**582.** 阅读「斜杠命令菜单单一真源(经典REPL⇄TUI)」的 services/backend/tests/cli/useCompletionsSlashExtras.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：斜杠命令菜单单一真源(经典REPL⇄TUI)。读懂再动。
  - 验证：`node --check services/backend/tests/cli/useCompletionsSlashExtras.test.js`

**583.** 阅读「前端响应信封解包单一真源(unwrap)」的 apps/ai-frontend/src/api/unwrap.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：前端响应信封解包单一真源(unwrap)。读懂再动。
  - 验证：`node --check apps/ai-frontend/src/api/unwrap.js`

**584.** 阅读「前端响应信封解包单一真源(unwrap)」的 apps/ai-frontend/src/api/unwrap.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：前端响应信封解包单一真源(unwrap)。读懂再动。
  - 验证：`node --check apps/ai-frontend/src/api/unwrap.test.js`

**585.** 阅读「前端响应信封解包单一真源(unwrap)」的 apps/ai-frontend/src/api/unwrap.wiring.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：前端响应信封解包单一真源(unwrap)。读懂再动。
  - 验证：`node --check apps/ai-frontend/src/api/unwrap.wiring.test.js`

**586.** 阅读「khy codex 凭据便捷管理(与 claude 一样启动)」的 services/backend/src/services/gateway/adapters/codexEnvAdoptPolicy.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：khy codex 凭据便捷管理(与 claude 一样启动)。读懂再动。
  - 验证：`node --check services/backend/src/services/gateway/adapters/codexEnvAdoptPolicy.js`

**587.** 阅读「khy codex 凭据便捷管理(与 claude 一样启动)」的 services/backend/src/services/gateway/adapters/openaiRelayPresets.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：khy codex 凭据便捷管理(与 claude 一样启动)。读懂再动。
  - 验证：`node --check services/backend/src/services/gateway/adapters/openaiRelayPresets.js`

**588.** 阅读「khy codex 凭据便捷管理(与 claude 一样启动)」的 services/backend/src/cli/handlers/codexAdopt.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：khy codex 凭据便捷管理(与 claude 一样启动)。读懂再动。
  - 验证：`node --check services/backend/src/cli/handlers/codexAdopt.js`

**589.** 阅读「khy codex 凭据便捷管理(与 claude 一样启动)」的 services/backend/src/cli/router.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：khy codex 凭据便捷管理(与 claude 一样启动)。读懂再动。
  - 验证：`node --check services/backend/src/cli/router.js`

**590.** 阅读「khy codex 凭据便捷管理(与 claude 一样启动)」的 services/backend/tests/services/gateway/codexEnvAdoptPolicy.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：khy codex 凭据便捷管理(与 claude 一样启动)。读懂再动。
  - 验证：`node --check services/backend/tests/services/gateway/codexEnvAdoptPolicy.test.js`

**591.** 阅读「khy codex 凭据便捷管理(与 claude 一样启动)」的 services/backend/tests/services/gateway/openaiRelayPresets.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：khy codex 凭据便捷管理(与 claude 一样启动)。读懂再动。
  - 验证：`node --check services/backend/tests/services/gateway/openaiRelayPresets.test.js`

**592.** 阅读「khy codex 凭据便捷管理(与 claude 一样启动)」的 services/backend/tests/cli/codexAdoptRouting.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：khy codex 凭据便捷管理(与 claude 一样启动)。读懂再动。
  - 验证：`node --check services/backend/tests/cli/codexAdoptRouting.test.js`

**593.** 阅读「AI 失败诊断质量(真实失败原因排序 + model_not_found 形状分诊/按模型冷却/存在性纠偏)」的 services/backend/src/services/gateway/failureReasonRanking.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：AI 失败诊断质量(真实失败原因排序 + model_not_found 形状分诊/按模型冷却/存在性纠偏)。读懂再动。
  - 验证：`node --check services/backend/src/services/gateway/failureReasonRanking.js`

**594.** 阅读「AI 失败诊断质量(真实失败原因排序 + model_not_found 形状分诊/按模型冷却/存在性纠偏)」的 services/backend/src/services/gateway/modelNotFoundRecovery.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：AI 失败诊断质量(真实失败原因排序 + model_not_found 形状分诊/按模型冷却/存在性纠偏)。读懂再动。
  - 验证：`node --check services/backend/src/services/gateway/modelNotFoundRecovery.js`

**595.** 阅读「AI 失败诊断质量(真实失败原因排序 + model_not_found 形状分诊/按模型冷却/存在性纠偏)」的 services/backend/src/services/gateway/modelNotFoundCooldownScope.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：AI 失败诊断质量(真实失败原因排序 + model_not_found 形状分诊/按模型冷却/存在性纠偏)。读懂再动。
  - 验证：`node --check services/backend/src/services/gateway/modelNotFoundCooldownScope.js`

**596.** 阅读「AI 失败诊断质量(真实失败原因排序 + model_not_found 形状分诊/按模型冷却/存在性纠偏)」的 services/backend/src/services/gateway/modelExistenceEvidence.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：AI 失败诊断质量(真实失败原因排序 + model_not_found 形状分诊/按模型冷却/存在性纠偏)。读懂再动。
  - 验证：`node --check services/backend/src/services/gateway/modelExistenceEvidence.js`

**597.** 阅读「AI 失败诊断质量(真实失败原因排序 + model_not_found 形状分诊/按模型冷却/存在性纠偏)」的 services/backend/src/services/gateway/aiGateway.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：AI 失败诊断质量(真实失败原因排序 + model_not_found 形状分诊/按模型冷却/存在性纠偏)。读懂再动。
  - 验证：`node --check services/backend/src/services/gateway/aiGateway.js`

**598.** 阅读「AI 失败诊断质量(真实失败原因排序 + model_not_found 形状分诊/按模型冷却/存在性纠偏)」的 services/backend/tests/services/gateway/failureReasonRanking.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：AI 失败诊断质量(真实失败原因排序 + model_not_found 形状分诊/按模型冷却/存在性纠偏)。读懂再动。
  - 验证：`node --check services/backend/tests/services/gateway/failureReasonRanking.test.js`

**599.** 阅读「AI 失败诊断质量(真实失败原因排序 + model_not_found 形状分诊/按模型冷却/存在性纠偏)」的 services/backend/tests/services/gateway/modelNotFoundRecovery.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：AI 失败诊断质量(真实失败原因排序 + model_not_found 形状分诊/按模型冷却/存在性纠偏)。读懂再动。
  - 验证：`node --check services/backend/tests/services/gateway/modelNotFoundRecovery.test.js`

**600.** 阅读「AI 失败诊断质量(真实失败原因排序 + model_not_found 形状分诊/按模型冷却/存在性纠偏)」的 services/backend/tests/services/gateway/modelNotFoundCooldownScope.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：AI 失败诊断质量(真实失败原因排序 + model_not_found 形状分诊/按模型冷却/存在性纠偏)。读懂再动。
  - 验证：`node --check services/backend/tests/services/gateway/modelNotFoundCooldownScope.test.js`

**601.** 阅读「AI 失败诊断质量(真实失败原因排序 + model_not_found 形状分诊/按模型冷却/存在性纠偏)」的 services/backend/tests/services/gateway/modelExistenceEvidence.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：AI 失败诊断质量(真实失败原因排序 + model_not_found 形状分诊/按模型冷却/存在性纠偏)。读懂再动。
  - 验证：`node --check services/backend/tests/services/gateway/modelExistenceEvidence.test.js`

**602.** 阅读「通配兜底守卫(裸模型盲落默认池打错端点的防护)」的 services/backend/src/services/gateway/wildcardPoolGuard.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：通配兜底守卫(裸模型盲落默认池打错端点的防护)。读懂再动。
  - 验证：`node --check services/backend/src/services/gateway/wildcardPoolGuard.js`

**603.** 阅读「通配兜底守卫(裸模型盲落默认池打错端点的防护)」的 services/backend/src/services/gateway/aiGateway.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：通配兜底守卫(裸模型盲落默认池打错端点的防护)。读懂再动。
  - 验证：`node --check services/backend/src/services/gateway/aiGateway.js`

**604.** 阅读「通配兜底守卫(裸模型盲落默认池打错端点的防护)」的 services/backend/src/services/flagRegistry.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：通配兜底守卫(裸模型盲落默认池打错端点的防护)。读懂再动。
  - 验证：`node --check services/backend/src/services/flagRegistry.js`

**605.** 阅读「通配兜底守卫(裸模型盲落默认池打错端点的防护)」的 services/backend/tests/services/gateway/wildcardPoolGuard.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：通配兜底守卫(裸模型盲落默认池打错端点的防护)。读懂再动。
  - 验证：`node --check services/backend/tests/services/gateway/wildcardPoolGuard.test.js`

**606.** 阅读「通配兜底守卫(裸模型盲落默认池打错端点的防护)」的 services/backend/tests/services/gateway/wildcardPoolGuard.wiring.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：通配兜底守卫(裸模型盲落默认池打错端点的防护)。读懂再动。
  - 验证：`node --check services/backend/tests/services/gateway/wildcardPoolGuard.wiring.test.js`

**607.** 阅读「安装台账(khy 写进宿主 exe/CLI 后保证卸载干净的真源)」的 services/backend/src/services/uninstall/installLedger.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：安装台账(khy 写进宿主 exe/CLI 后保证卸载干净的真源)。读懂再动。
  - 验证：`node --check services/backend/src/services/uninstall/installLedger.js`

**608.** 阅读「安装台账(khy 写进宿主 exe/CLI 后保证卸载干净的真源)」的 services/backend/src/services/uninstall/ledgerWriter.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：安装台账(khy 写进宿主 exe/CLI 后保证卸载干净的真源)。读懂再动。
  - 验证：`node --check services/backend/src/services/uninstall/ledgerWriter.js`

**609.** 阅读「安装台账(khy 写进宿主 exe/CLI 后保证卸载干净的真源)」的 services/backend/src/cli/handlers/uninstall.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：安装台账(khy 写进宿主 exe/CLI 后保证卸载干净的真源)。读懂再动。
  - 验证：`node --check services/backend/src/cli/handlers/uninstall.js`

**610.** 阅读「安装台账(khy 写进宿主 exe/CLI 后保证卸载干净的真源)」的 services/backend/src/services/mdEditorRegister.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：安装台账(khy 写进宿主 exe/CLI 后保证卸载干净的真源)。读懂再动。
  - 验证：`node --check services/backend/src/services/mdEditorRegister.js`

**611.** 阅读「安装台账(khy 写进宿主 exe/CLI 后保证卸载干净的真源)」的 services/backend/src/services/runtimeProvisioner.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：安装台账(khy 写进宿主 exe/CLI 后保证卸载干净的真源)。读懂再动。
  - 验证：`node --check services/backend/src/services/runtimeProvisioner.js`

**612.** 阅读「安装台账(khy 写进宿主 exe/CLI 后保证卸载干净的真源)」的 services/backend/src/services/flagRegistry.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：安装台账(khy 写进宿主 exe/CLI 后保证卸载干净的真源)。读懂再动。
  - 验证：`node --check services/backend/src/services/flagRegistry.js`

**613.** 阅读「安装台账(khy 写进宿主 exe/CLI 后保证卸载干净的真源)」的 services/backend/tests/services/installLedger.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：安装台账(khy 写进宿主 exe/CLI 后保证卸载干净的真源)。读懂再动。
  - 验证：`node --check services/backend/tests/services/installLedger.test.js`

**614.** 阅读「安装台账(khy 写进宿主 exe/CLI 后保证卸载干净的真源)」的 services/backend/tests/services/uninstallLedgerWiring.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：安装台账(khy 写进宿主 exe/CLI 后保证卸载干净的真源)。读懂再动。
  - 验证：`node --check services/backend/tests/services/uninstallLedgerWiring.test.js`

**615.** 阅读「安装台账(khy 写进宿主 exe/CLI 后保证卸载干净的真源)」的 services/backend/tests/services/ledgerWriter.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：安装台账(khy 写进宿主 exe/CLI 后保证卸载干净的真源)。读懂再动。
  - 验证：`node --check services/backend/tests/services/ledgerWriter.test.js`

**616.** 阅读「卸载第三方应用(原生自带卸载器 T2 层——让 khy 卸别人的 exe/CLI 卸干净)」的 services/backend/src/services/deviceApps/nativeUninstallPolicy.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：卸载第三方应用(原生自带卸载器 T2 层——让 khy 卸别人的 exe/CLI 卸干净)。读懂再动。
  - 验证：`node --check services/backend/src/services/deviceApps/nativeUninstallPolicy.js`

**617.** 阅读「卸载第三方应用(原生自带卸载器 T2 层——让 khy 卸别人的 exe/CLI 卸干净)」的 services/backend/src/services/deviceApps/nativeUninstaller.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：卸载第三方应用(原生自带卸载器 T2 层——让 khy 卸别人的 exe/CLI 卸干净)。读懂再动。
  - 验证：`node --check services/backend/src/services/deviceApps/nativeUninstaller.js`

**618.** 阅读「卸载第三方应用(原生自带卸载器 T2 层——让 khy 卸别人的 exe/CLI 卸干净)」的 services/backend/src/services/deviceApps/uninstallRoute.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：卸载第三方应用(原生自带卸载器 T2 层——让 khy 卸别人的 exe/CLI 卸干净)。读懂再动。
  - 验证：`node --check services/backend/src/services/deviceApps/uninstallRoute.js`

**619.** 阅读「卸载第三方应用(原生自带卸载器 T2 层——让 khy 卸别人的 exe/CLI 卸干净)」的 services/backend/src/cli/handlers/device.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：卸载第三方应用(原生自带卸载器 T2 层——让 khy 卸别人的 exe/CLI 卸干净)。读懂再动。
  - 验证：`node --check services/backend/src/cli/handlers/device.js`

**620.** 阅读「卸载第三方应用(原生自带卸载器 T2 层——让 khy 卸别人的 exe/CLI 卸干净)」的 services/backend/src/tools/DeviceAppsTool/index.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：卸载第三方应用(原生自带卸载器 T2 层——让 khy 卸别人的 exe/CLI 卸干净)。读懂再动。
  - 验证：`node --check services/backend/src/tools/DeviceAppsTool/index.js`

**621.** 阅读「卸载第三方应用(原生自带卸载器 T2 层——让 khy 卸别人的 exe/CLI 卸干净)」的 services/backend/src/services/flagRegistry.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：卸载第三方应用(原生自带卸载器 T2 层——让 khy 卸别人的 exe/CLI 卸干净)。读懂再动。
  - 验证：`node --check services/backend/src/services/flagRegistry.js`

**622.** 阅读「卸载第三方应用(原生自带卸载器 T2 层——让 khy 卸别人的 exe/CLI 卸干净)」的 services/backend/tests/services/deviceApps/nativeUninstallPolicy.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：卸载第三方应用(原生自带卸载器 T2 层——让 khy 卸别人的 exe/CLI 卸干净)。读懂再动。
  - 验证：`node --check services/backend/tests/services/deviceApps/nativeUninstallPolicy.test.js`

**623.** 阅读「卸载第三方应用(原生自带卸载器 T2 层——让 khy 卸别人的 exe/CLI 卸干净)」的 services/backend/tests/services/deviceApps/nativeUninstaller.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：卸载第三方应用(原生自带卸载器 T2 层——让 khy 卸别人的 exe/CLI 卸干净)。读懂再动。
  - 验证：`node --check services/backend/tests/services/deviceApps/nativeUninstaller.test.js`

**624.** 阅读「卸载第三方应用(原生自带卸载器 T2 层——让 khy 卸别人的 exe/CLI 卸干净)」的 services/backend/tests/services/deviceApps/uninstallRoute.test.js，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。
  - 说明：子系统：卸载第三方应用(原生自带卸载器 T2 层——让 khy 卸别人的 exe/CLI 卸干净)。读懂再动。
  - 验证：`node --check services/backend/tests/services/deviceApps/uninstallRoute.test.js`


## 五、进化配方（每个子系统都照做一遍）

**625.** 为「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」增加一个 flag 门控的纯叶子：零 IO、绝不抛异常，先在 flagRegistry 登记 KHY_* 门再接线。
  - 说明：新能力走门控叶子。 子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run check:flag-registry`

**626.** 为「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」补一条 node:test，至少覆盖：正常路径、一个边界、一个畸形/空输入。
  - 说明：补测试。 子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run docs:check-beginner`

**627.** 通读「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」核心文件，在顶部一句话写清职责，并给最难懂的分支补一句注释（不改行为）。
  - 说明：补可读性。 子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run docs:check-beginner`

**628.** 扫描「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」是否有文件超 2500 行；若有，按同名 re-export + DI 抽一个聚焦叶子，保字节等价。
  - 说明：拆上帝文件。 子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run arch:god`

**629.** 给「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」的注册表叶子（_PROBES/_REPAIRS 之类）上方补 4 步 HOW-TO-EXTEND 抄写式注释。
  - 说明：注册表可扩展。 子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run maintainer:check`

**630.** 把「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」中每轮/每请求重复构建的 Set/正则/常量提升为模块常量（参考书 Ch2）。
  - 说明：别每轮重建。 子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run arch:god`

**631.** 为「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」增加一个只读诊断探针：只观测不修改，绝不写盘、绝不发网络。
  - 说明：加只读探针。 子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run docs:check-beginner`

**632.** 为「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」增加一个「仅创建缺失项」的安全自愈：幂等、fail-soft、遇损坏拒删交人工。
  - 说明：加安全修复。 子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run docs:check-beginner`

**633.** 给「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」的失败路径补一条指名道姓的可执行指引，把错误码翻译成用户能照做的步骤。
  - 说明：错误可执行。 子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run docs:check-beginner`

**634.** 核对「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」的 verify 命令仍能一键复现绿灯；若命令漂移就修 package.json 别名。
  - 说明：verify 不漂移。 子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run docs:check-beginner`

**635.** 为「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」新增功能前先在 flagRegistry 登记开关，并确认父门链正确（父关则子必关）。
  - 说明：门先登记。 子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run check:flag-registry`

**636.** 为「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」的输入做防御式校验：null/undefined/空数组/超长都有明确且安全的默认行为。
  - 说明：防御式输入。 子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run docs:check-beginner`

**637.** 给「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」的外部调用加超时与失败兜底，任何一路挂了都 fail-soft 而不是整体崩。
  - 说明：失败兜底。 子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run docs:check-beginner`

**638.** 为「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」补一条针对历史 bug 的回归测试，命名写清它守护的是哪个坑。
  - 说明：回归测试。 子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run docs:check-beginner`

**639.** 检查「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」的日志：敏感值只打印长度不打印明文，绝不把 key/token 落盘或进日志。
  - 说明：日志脱敏。 子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run check:model-hardcoding`

**640.** 为「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」写一条 golden 测试：把一次已知正确的输出固化，防止未来悄悄漂移。
  - 说明：golden 固化。 子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run docs:check-beginner`

**641.** 为「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」排查可变状态跨簇共享：若被多处重赋值，抽取时必须用 DI 注入而非复制。
  - 说明：共享态用 DI。 子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run arch:god`

**642.** 为「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」补一个进程级缓存的测试重置钩子，避免测试间状态串味。
  - 说明：缓存可重置。 子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run docs:check-beginner`

**643.** 把「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」里散落的模型名/端点字面量收敛到单一权威来源（SSOT 访问器）。
  - 说明：收敛字面量。 子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run check:model-hardcoding`

**644.** 为「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」的公共函数补 JSDoc：写清意图、参数契约、返回值与副作用。
  - 说明：补 JSDoc。 子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run check:agent-rules`

**645.** 为「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」增加空参数补全保护：工具/命令缺关键参数时给出可推断的安全默认。
  - 说明：空参补全。 子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run docs:check-beginner`

**646.** 为「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」抽取叶子后 grep 每个被调函数，凡叶子调而宿主定义者必迁或 DI。
  - 说明：查死引用。 子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run check:leaf-contract`

**647.** 为「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」写一条场景测试：模拟一个真实用户操作序列，断言端到端结果。
  - 说明：场景测试。 子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run docs:check-beginner`

**648.** 把「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」里超过三层的嵌套条件重构为早返回（guard clause），降低阅读成本。
  - 说明：早返回。 子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run check:change-safety`

**649.** 为「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」补一条门关字节回退测试：关掉 KHY_* 门后行为逐字节回到改动前。
  - 说明：门关回退。 子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run check:flag-registry`

**650.** 给「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」仅用于匹配的正则去掉全局 g 标志，避免 lastIndex 状态残留。
  - 说明：正则去 g。 子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run docs:check-beginner`

**651.** 为「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」登记进 docs/_维护者/维护映射表.json（whenToUse/paths/docs/verify 齐全）。
  - 说明：登记映射表。 子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run maintainer:check`

**652.** 为「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」补一句「一句话验证脚本」并并入 test:maintainer:all。
  - 说明：一句话验证。 子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run maintainer:check`

**653.** 检查「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」的错误信息是否可执行：告诉用户「下一步做什么」而不仅是「哪里错了」。
  - 说明：可执行错误。 子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run docs:check-beginner`

**654.** 为「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」的关键常量补注释解释「为什么是这个值」（保守高估、上限来源等）。
  - 说明：常量讲来源。 子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run check:change-safety`

**655.** 为「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」增加平台差异白名单（linux/windows/macos/android/ios），差异化规则收在注册表一处。
  - 说明：平台白名单。 子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run docs:check-beginner`

**656.** 为「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」补一条并发/竞态测试：同一资源被两条路径同时访问时结果仍正确。
  - 说明：并发测试。 子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run docs:check-beginner`

**657.** 把「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」里手写的重复逻辑抽成一个纯 helper，并给它单测。
  - 说明：抽纯 helper。 子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run check:leaf-contract`

**658.** 为「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」写一条「畸形输入绝不抛」的模糊测试：喂 null/数字/字符串/超大对象都返回安全值。
  - 说明：模糊测试。 子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run check:leaf-contract`

**659.** 检查「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」的默认值是否安全优先：不确定时偏向拒绝/降级而非放行。
  - 说明：安全默认。 子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run check:change-safety`

**660.** 为「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」补一条端点/URL 成形的确定性测试（不发真实请求，只断言拼出的字符串正确）。
  - 说明：URL 成形测试。 子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run docs:check-beginner`

**661.** 为「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」的每个导出函数确认都有对应测试引用，无孤儿导出。
  - 说明：无孤儿导出。 子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run check:leaf-contract`

**662.** 为「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」增加预算/上限保护：循环或累积有明确终止条件，防止失控。
  - 说明：预算护栏。 子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run docs:check-beginner`

**663.** 把「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」的巨型 switch 按 case 簇抽子分派器（pre-dispatch + 哨兵 fall-through）。
  - 说明：switch 拆解。 子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run arch:god`

**664.** 为「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」补一条幂等测试：同一操作跑两次结果一致、无副作用叠加。
  - 说明：幂等测试。 子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run docs:check-beginner`

**665.** 检查「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」是否遵守单向依赖：叶子不得反向 require 宿主网关，需要就用 IoC 缝。
  - 说明：单向依赖。 子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run check:leaf-contract`

**666.** 为「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」写一份「新维护者一分钟上手」的结构表（文件→职责一行）。
  - 说明：一分钟上手。 子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run maintainer:check`

**667.** 为「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」的时间相关逻辑改为「时钟由调用方喂入」，让它可离线确定性测试。
  - 说明：时钟可注入。 子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run docs:check-beginner`

**668.** 给「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」补一条「截断/采样时必须 log 丢了什么」的规则，杜绝静默截断。
  - 说明：别静默截断。 子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run check:change-safety`

**669.** 为「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」增加 dry-run 模式：先展示将要做什么，用户确认后才执行破坏性操作。
  - 说明：dry-run 先行。 子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run check:small-model:safety`

**670.** 检查「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」的 flag 语义：opt-in 严格只认 1/true，default-on 只认关键词才关。
  - 说明：门语义核对。 子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run check:flag-registry`

**671.** 为「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」补一条「父门关闭 → 子功能整体关闭」的门控测试。
  - 说明：父子门控。 子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run check:flag-registry`

**672.** 把「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」里的魔法数字提取为具名常量并注释其单位与来源。
  - 说明：消魔法数。 子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run check:change-safety`

**673.** 为「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」写一条向后兼容测试：旧输入格式仍能被正确解析。
  - 说明：向后兼容。 子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run docs:check-beginner`

**674.** 为「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」的注册表新增一维时，确认聚合器与格式化器各只改一处（不 smear）。
  - 说明：改动不 smear。 子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run docs:check-beginner`

**675.** 检查「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」抽取后宿主是否仍持有核心态，叶子只拿它需要的切片。
  - 说明：核心态留宿主。 子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run arch:god`

**676.** 为「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」补一条跨渠道/双通道一致性测试（如版本号 pip 与 npm 必须一致）。
  - 说明：双通道一致。 子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run docs:check-beginner`

**677.** 为「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」的用户可见文案统一措辞与语气，避免同义词乱用误导弱模型。
  - 说明：文案统一。 子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run maintainer:check`

**678.** 给「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」增加一个健康分自检项，纳入 khy doctor 的输出。
  - 说明：并入自检。 子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`khy doctor`

**679.** 为「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」补一条资源清理测试：临时文件用后即删、句柄关闭、无泄漏。
  - 说明：资源清理。 子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run docs:check-beginner`

**680.** 把「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」里可能抛的第三方调用全部包进 try/catch 并给结构化 reason。
  - 说明：结构化容错。 子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run check:change-safety`

**681.** 为「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」写一条已知安全边界注释：明确它是 review aid 还是隔离边界，别夸大保证。
  - 说明：诚实边界。 子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run check:leaf-contract`

**682.** 为「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」补一条空结果早退路径：0 命中时跳过昂贵的下游步骤。
  - 说明：空结果早退。 子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run docs:check-beginner`

**683.** 检查「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」的命令别名是否都路由到正确 handler，补一条 alias 路由测试。
  - 说明：别名路由。 子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run docs:check-beginner`

**684.** 为「面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）」建立一条 memory 记录模板，把「为什么这么改」写进传承文档。
  - 说明：沉淀传承。 子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run maintainer:check`

**685.** 为「Bootstrap and Packaging」增加一个 flag 门控的纯叶子：零 IO、绝不抛异常，先在 flagRegistry 登记 KHY_* 门再接线。
  - 说明：新能力走门控叶子。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:flag-registry`

**686.** 为「Bootstrap and Packaging」补一条 node:test，至少覆盖：正常路径、一个边界、一个畸形/空输入。
  - 说明：补测试。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:manifest-sync`

**687.** 通读「Bootstrap and Packaging」核心文件，在顶部一句话写清职责，并给最难懂的分支补一句注释（不改行为）。
  - 说明：补可读性。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:manifest-sync`

**688.** 扫描「Bootstrap and Packaging」是否有文件超 2500 行；若有，按同名 re-export + DI 抽一个聚焦叶子，保字节等价。
  - 说明：拆上帝文件。 子系统：Bootstrap and Packaging。
  - 验证：`npm run arch:god`

**689.** 给「Bootstrap and Packaging」的注册表叶子（_PROBES/_REPAIRS 之类）上方补 4 步 HOW-TO-EXTEND 抄写式注释。
  - 说明：注册表可扩展。 子系统：Bootstrap and Packaging。
  - 验证：`npm run maintainer:check`

**690.** 把「Bootstrap and Packaging」中每轮/每请求重复构建的 Set/正则/常量提升为模块常量（参考书 Ch2）。
  - 说明：别每轮重建。 子系统：Bootstrap and Packaging。
  - 验证：`npm run arch:god`

**691.** 为「Bootstrap and Packaging」增加一个只读诊断探针：只观测不修改，绝不写盘、绝不发网络。
  - 说明：加只读探针。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:manifest-sync`

**692.** 为「Bootstrap and Packaging」增加一个「仅创建缺失项」的安全自愈：幂等、fail-soft、遇损坏拒删交人工。
  - 说明：加安全修复。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:manifest-sync`

**693.** 给「Bootstrap and Packaging」的失败路径补一条指名道姓的可执行指引，把错误码翻译成用户能照做的步骤。
  - 说明：错误可执行。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:manifest-sync`

**694.** 核对「Bootstrap and Packaging」的 verify 命令仍能一键复现绿灯；若命令漂移就修 package.json 别名。
  - 说明：verify 不漂移。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:manifest-sync`

**695.** 为「Bootstrap and Packaging」新增功能前先在 flagRegistry 登记开关，并确认父门链正确（父关则子必关）。
  - 说明：门先登记。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:flag-registry`

**696.** 为「Bootstrap and Packaging」的输入做防御式校验：null/undefined/空数组/超长都有明确且安全的默认行为。
  - 说明：防御式输入。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:manifest-sync`

**697.** 给「Bootstrap and Packaging」的外部调用加超时与失败兜底，任何一路挂了都 fail-soft 而不是整体崩。
  - 说明：失败兜底。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:manifest-sync`

**698.** 为「Bootstrap and Packaging」补一条针对历史 bug 的回归测试，命名写清它守护的是哪个坑。
  - 说明：回归测试。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:manifest-sync`

**699.** 检查「Bootstrap and Packaging」的日志：敏感值只打印长度不打印明文，绝不把 key/token 落盘或进日志。
  - 说明：日志脱敏。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:model-hardcoding`

**700.** 为「Bootstrap and Packaging」写一条 golden 测试：把一次已知正确的输出固化，防止未来悄悄漂移。
  - 说明：golden 固化。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:manifest-sync`

**701.** 为「Bootstrap and Packaging」排查可变状态跨簇共享：若被多处重赋值，抽取时必须用 DI 注入而非复制。
  - 说明：共享态用 DI。 子系统：Bootstrap and Packaging。
  - 验证：`npm run arch:god`

**702.** 为「Bootstrap and Packaging」补一个进程级缓存的测试重置钩子，避免测试间状态串味。
  - 说明：缓存可重置。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:manifest-sync`

**703.** 把「Bootstrap and Packaging」里散落的模型名/端点字面量收敛到单一权威来源（SSOT 访问器）。
  - 说明：收敛字面量。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:model-hardcoding`

**704.** 为「Bootstrap and Packaging」的公共函数补 JSDoc：写清意图、参数契约、返回值与副作用。
  - 说明：补 JSDoc。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:agent-rules`

**705.** 为「Bootstrap and Packaging」增加空参数补全保护：工具/命令缺关键参数时给出可推断的安全默认。
  - 说明：空参补全。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:manifest-sync`

**706.** 为「Bootstrap and Packaging」抽取叶子后 grep 每个被调函数，凡叶子调而宿主定义者必迁或 DI。
  - 说明：查死引用。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:leaf-contract`

**707.** 为「Bootstrap and Packaging」写一条场景测试：模拟一个真实用户操作序列，断言端到端结果。
  - 说明：场景测试。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:manifest-sync`

**708.** 把「Bootstrap and Packaging」里超过三层的嵌套条件重构为早返回（guard clause），降低阅读成本。
  - 说明：早返回。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:change-safety`

**709.** 为「Bootstrap and Packaging」补一条门关字节回退测试：关掉 KHY_* 门后行为逐字节回到改动前。
  - 说明：门关回退。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:flag-registry`

**710.** 给「Bootstrap and Packaging」仅用于匹配的正则去掉全局 g 标志，避免 lastIndex 状态残留。
  - 说明：正则去 g。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:manifest-sync`

**711.** 为「Bootstrap and Packaging」登记进 docs/_维护者/维护映射表.json（whenToUse/paths/docs/verify 齐全）。
  - 说明：登记映射表。 子系统：Bootstrap and Packaging。
  - 验证：`npm run maintainer:check`

**712.** 为「Bootstrap and Packaging」补一句「一句话验证脚本」并并入 test:maintainer:all。
  - 说明：一句话验证。 子系统：Bootstrap and Packaging。
  - 验证：`npm run maintainer:check`

**713.** 检查「Bootstrap and Packaging」的错误信息是否可执行：告诉用户「下一步做什么」而不仅是「哪里错了」。
  - 说明：可执行错误。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:manifest-sync`

**714.** 为「Bootstrap and Packaging」的关键常量补注释解释「为什么是这个值」（保守高估、上限来源等）。
  - 说明：常量讲来源。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:change-safety`

**715.** 为「Bootstrap and Packaging」增加平台差异白名单（linux/windows/macos/android/ios），差异化规则收在注册表一处。
  - 说明：平台白名单。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:manifest-sync`

**716.** 为「Bootstrap and Packaging」补一条并发/竞态测试：同一资源被两条路径同时访问时结果仍正确。
  - 说明：并发测试。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:manifest-sync`

**717.** 把「Bootstrap and Packaging」里手写的重复逻辑抽成一个纯 helper，并给它单测。
  - 说明：抽纯 helper。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:leaf-contract`

**718.** 为「Bootstrap and Packaging」写一条「畸形输入绝不抛」的模糊测试：喂 null/数字/字符串/超大对象都返回安全值。
  - 说明：模糊测试。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:leaf-contract`

**719.** 检查「Bootstrap and Packaging」的默认值是否安全优先：不确定时偏向拒绝/降级而非放行。
  - 说明：安全默认。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:change-safety`

**720.** 为「Bootstrap and Packaging」补一条端点/URL 成形的确定性测试（不发真实请求，只断言拼出的字符串正确）。
  - 说明：URL 成形测试。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:manifest-sync`

**721.** 为「Bootstrap and Packaging」的每个导出函数确认都有对应测试引用，无孤儿导出。
  - 说明：无孤儿导出。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:leaf-contract`

**722.** 为「Bootstrap and Packaging」增加预算/上限保护：循环或累积有明确终止条件，防止失控。
  - 说明：预算护栏。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:manifest-sync`

**723.** 把「Bootstrap and Packaging」的巨型 switch 按 case 簇抽子分派器（pre-dispatch + 哨兵 fall-through）。
  - 说明：switch 拆解。 子系统：Bootstrap and Packaging。
  - 验证：`npm run arch:god`

**724.** 为「Bootstrap and Packaging」补一条幂等测试：同一操作跑两次结果一致、无副作用叠加。
  - 说明：幂等测试。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:manifest-sync`

**725.** 检查「Bootstrap and Packaging」是否遵守单向依赖：叶子不得反向 require 宿主网关，需要就用 IoC 缝。
  - 说明：单向依赖。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:leaf-contract`

**726.** 为「Bootstrap and Packaging」写一份「新维护者一分钟上手」的结构表（文件→职责一行）。
  - 说明：一分钟上手。 子系统：Bootstrap and Packaging。
  - 验证：`npm run maintainer:check`

**727.** 为「Bootstrap and Packaging」的时间相关逻辑改为「时钟由调用方喂入」，让它可离线确定性测试。
  - 说明：时钟可注入。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:manifest-sync`

**728.** 给「Bootstrap and Packaging」补一条「截断/采样时必须 log 丢了什么」的规则，杜绝静默截断。
  - 说明：别静默截断。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:change-safety`

**729.** 为「Bootstrap and Packaging」增加 dry-run 模式：先展示将要做什么，用户确认后才执行破坏性操作。
  - 说明：dry-run 先行。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:small-model:safety`

**730.** 检查「Bootstrap and Packaging」的 flag 语义：opt-in 严格只认 1/true，default-on 只认关键词才关。
  - 说明：门语义核对。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:flag-registry`

**731.** 为「Bootstrap and Packaging」补一条「父门关闭 → 子功能整体关闭」的门控测试。
  - 说明：父子门控。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:flag-registry`

**732.** 把「Bootstrap and Packaging」里的魔法数字提取为具名常量并注释其单位与来源。
  - 说明：消魔法数。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:change-safety`

**733.** 为「Bootstrap and Packaging」写一条向后兼容测试：旧输入格式仍能被正确解析。
  - 说明：向后兼容。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:manifest-sync`

**734.** 为「Bootstrap and Packaging」的注册表新增一维时，确认聚合器与格式化器各只改一处（不 smear）。
  - 说明：改动不 smear。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:manifest-sync`

**735.** 检查「Bootstrap and Packaging」抽取后宿主是否仍持有核心态，叶子只拿它需要的切片。
  - 说明：核心态留宿主。 子系统：Bootstrap and Packaging。
  - 验证：`npm run arch:god`

**736.** 为「Bootstrap and Packaging」补一条跨渠道/双通道一致性测试（如版本号 pip 与 npm 必须一致）。
  - 说明：双通道一致。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:manifest-sync`

**737.** 为「Bootstrap and Packaging」的用户可见文案统一措辞与语气，避免同义词乱用误导弱模型。
  - 说明：文案统一。 子系统：Bootstrap and Packaging。
  - 验证：`npm run maintainer:check`

**738.** 给「Bootstrap and Packaging」增加一个健康分自检项，纳入 khy doctor 的输出。
  - 说明：并入自检。 子系统：Bootstrap and Packaging。
  - 验证：`khy doctor`

**739.** 为「Bootstrap and Packaging」补一条资源清理测试：临时文件用后即删、句柄关闭、无泄漏。
  - 说明：资源清理。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:manifest-sync`

**740.** 把「Bootstrap and Packaging」里可能抛的第三方调用全部包进 try/catch 并给结构化 reason。
  - 说明：结构化容错。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:change-safety`

**741.** 为「Bootstrap and Packaging」写一条已知安全边界注释：明确它是 review aid 还是隔离边界，别夸大保证。
  - 说明：诚实边界。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:leaf-contract`

**742.** 为「Bootstrap and Packaging」补一条空结果早退路径：0 命中时跳过昂贵的下游步骤。
  - 说明：空结果早退。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:manifest-sync`

**743.** 检查「Bootstrap and Packaging」的命令别名是否都路由到正确 handler，补一条 alias 路由测试。
  - 说明：别名路由。 子系统：Bootstrap and Packaging。
  - 验证：`npm run check:manifest-sync`

**744.** 为「Bootstrap and Packaging」建立一条 memory 记录模板，把「为什么这么改」写进传承文档。
  - 说明：沉淀传承。 子系统：Bootstrap and Packaging。
  - 验证：`npm run maintainer:check`

**745.** 为「CLI Routing and Help Surface」增加一个 flag 门控的纯叶子：零 IO、绝不抛异常，先在 flagRegistry 登记 KHY_* 门再接线。
  - 说明：新能力走门控叶子。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run check:flag-registry`

**746.** 为「CLI Routing and Help Surface」补一条 node:test，至少覆盖：正常路径、一个边界、一个畸形/空输入。
  - 说明：补测试。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run test:one -- services/backend/tests/cli/router.test.js services/backend/tests/cli/repl.tasks.interaction.test.js`

**747.** 通读「CLI Routing and Help Surface」核心文件，在顶部一句话写清职责，并给最难懂的分支补一句注释（不改行为）。
  - 说明：补可读性。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run test:one -- services/backend/tests/cli/router.test.js services/backend/tests/cli/repl.tasks.interaction.test.js`

**748.** 扫描「CLI Routing and Help Surface」是否有文件超 2500 行；若有，按同名 re-export + DI 抽一个聚焦叶子，保字节等价。
  - 说明：拆上帝文件。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run arch:god`

**749.** 给「CLI Routing and Help Surface」的注册表叶子（_PROBES/_REPAIRS 之类）上方补 4 步 HOW-TO-EXTEND 抄写式注释。
  - 说明：注册表可扩展。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run maintainer:check`

**750.** 把「CLI Routing and Help Surface」中每轮/每请求重复构建的 Set/正则/常量提升为模块常量（参考书 Ch2）。
  - 说明：别每轮重建。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run arch:god`

**751.** 为「CLI Routing and Help Surface」增加一个只读诊断探针：只观测不修改，绝不写盘、绝不发网络。
  - 说明：加只读探针。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run test:one -- services/backend/tests/cli/router.test.js services/backend/tests/cli/repl.tasks.interaction.test.js`

**752.** 为「CLI Routing and Help Surface」增加一个「仅创建缺失项」的安全自愈：幂等、fail-soft、遇损坏拒删交人工。
  - 说明：加安全修复。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run test:one -- services/backend/tests/cli/router.test.js services/backend/tests/cli/repl.tasks.interaction.test.js`

**753.** 给「CLI Routing and Help Surface」的失败路径补一条指名道姓的可执行指引，把错误码翻译成用户能照做的步骤。
  - 说明：错误可执行。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run test:one -- services/backend/tests/cli/router.test.js services/backend/tests/cli/repl.tasks.interaction.test.js`

**754.** 核对「CLI Routing and Help Surface」的 verify 命令仍能一键复现绿灯；若命令漂移就修 package.json 别名。
  - 说明：verify 不漂移。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run test:one -- services/backend/tests/cli/router.test.js services/backend/tests/cli/repl.tasks.interaction.test.js`

**755.** 为「CLI Routing and Help Surface」新增功能前先在 flagRegistry 登记开关，并确认父门链正确（父关则子必关）。
  - 说明：门先登记。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run check:flag-registry`

**756.** 为「CLI Routing and Help Surface」的输入做防御式校验：null/undefined/空数组/超长都有明确且安全的默认行为。
  - 说明：防御式输入。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run test:one -- services/backend/tests/cli/router.test.js services/backend/tests/cli/repl.tasks.interaction.test.js`

**757.** 给「CLI Routing and Help Surface」的外部调用加超时与失败兜底，任何一路挂了都 fail-soft 而不是整体崩。
  - 说明：失败兜底。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run test:one -- services/backend/tests/cli/router.test.js services/backend/tests/cli/repl.tasks.interaction.test.js`

**758.** 为「CLI Routing and Help Surface」补一条针对历史 bug 的回归测试，命名写清它守护的是哪个坑。
  - 说明：回归测试。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run test:one -- services/backend/tests/cli/router.test.js services/backend/tests/cli/repl.tasks.interaction.test.js`

**759.** 检查「CLI Routing and Help Surface」的日志：敏感值只打印长度不打印明文，绝不把 key/token 落盘或进日志。
  - 说明：日志脱敏。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run check:model-hardcoding`

**760.** 为「CLI Routing and Help Surface」写一条 golden 测试：把一次已知正确的输出固化，防止未来悄悄漂移。
  - 说明：golden 固化。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run test:one -- services/backend/tests/cli/router.test.js services/backend/tests/cli/repl.tasks.interaction.test.js`

**761.** 为「CLI Routing and Help Surface」排查可变状态跨簇共享：若被多处重赋值，抽取时必须用 DI 注入而非复制。
  - 说明：共享态用 DI。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run arch:god`

**762.** 为「CLI Routing and Help Surface」补一个进程级缓存的测试重置钩子，避免测试间状态串味。
  - 说明：缓存可重置。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run test:one -- services/backend/tests/cli/router.test.js services/backend/tests/cli/repl.tasks.interaction.test.js`

**763.** 把「CLI Routing and Help Surface」里散落的模型名/端点字面量收敛到单一权威来源（SSOT 访问器）。
  - 说明：收敛字面量。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run check:model-hardcoding`

**764.** 为「CLI Routing and Help Surface」的公共函数补 JSDoc：写清意图、参数契约、返回值与副作用。
  - 说明：补 JSDoc。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run check:agent-rules`

**765.** 为「CLI Routing and Help Surface」增加空参数补全保护：工具/命令缺关键参数时给出可推断的安全默认。
  - 说明：空参补全。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run test:one -- services/backend/tests/cli/router.test.js services/backend/tests/cli/repl.tasks.interaction.test.js`

**766.** 为「CLI Routing and Help Surface」抽取叶子后 grep 每个被调函数，凡叶子调而宿主定义者必迁或 DI。
  - 说明：查死引用。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run check:leaf-contract`

**767.** 为「CLI Routing and Help Surface」写一条场景测试：模拟一个真实用户操作序列，断言端到端结果。
  - 说明：场景测试。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run test:one -- services/backend/tests/cli/router.test.js services/backend/tests/cli/repl.tasks.interaction.test.js`

**768.** 把「CLI Routing and Help Surface」里超过三层的嵌套条件重构为早返回（guard clause），降低阅读成本。
  - 说明：早返回。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run check:change-safety`

**769.** 为「CLI Routing and Help Surface」补一条门关字节回退测试：关掉 KHY_* 门后行为逐字节回到改动前。
  - 说明：门关回退。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run check:flag-registry`

**770.** 给「CLI Routing and Help Surface」仅用于匹配的正则去掉全局 g 标志，避免 lastIndex 状态残留。
  - 说明：正则去 g。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run test:one -- services/backend/tests/cli/router.test.js services/backend/tests/cli/repl.tasks.interaction.test.js`

**771.** 为「CLI Routing and Help Surface」登记进 docs/_维护者/维护映射表.json（whenToUse/paths/docs/verify 齐全）。
  - 说明：登记映射表。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run maintainer:check`

**772.** 为「CLI Routing and Help Surface」补一句「一句话验证脚本」并并入 test:maintainer:all。
  - 说明：一句话验证。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run maintainer:check`

**773.** 检查「CLI Routing and Help Surface」的错误信息是否可执行：告诉用户「下一步做什么」而不仅是「哪里错了」。
  - 说明：可执行错误。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run test:one -- services/backend/tests/cli/router.test.js services/backend/tests/cli/repl.tasks.interaction.test.js`

**774.** 为「CLI Routing and Help Surface」的关键常量补注释解释「为什么是这个值」（保守高估、上限来源等）。
  - 说明：常量讲来源。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run check:change-safety`

**775.** 为「CLI Routing and Help Surface」增加平台差异白名单（linux/windows/macos/android/ios），差异化规则收在注册表一处。
  - 说明：平台白名单。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run test:one -- services/backend/tests/cli/router.test.js services/backend/tests/cli/repl.tasks.interaction.test.js`

**776.** 为「CLI Routing and Help Surface」补一条并发/竞态测试：同一资源被两条路径同时访问时结果仍正确。
  - 说明：并发测试。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run test:one -- services/backend/tests/cli/router.test.js services/backend/tests/cli/repl.tasks.interaction.test.js`

**777.** 把「CLI Routing and Help Surface」里手写的重复逻辑抽成一个纯 helper，并给它单测。
  - 说明：抽纯 helper。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run check:leaf-contract`

**778.** 为「CLI Routing and Help Surface」写一条「畸形输入绝不抛」的模糊测试：喂 null/数字/字符串/超大对象都返回安全值。
  - 说明：模糊测试。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run check:leaf-contract`

**779.** 检查「CLI Routing and Help Surface」的默认值是否安全优先：不确定时偏向拒绝/降级而非放行。
  - 说明：安全默认。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run check:change-safety`

**780.** 为「CLI Routing and Help Surface」补一条端点/URL 成形的确定性测试（不发真实请求，只断言拼出的字符串正确）。
  - 说明：URL 成形测试。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run test:one -- services/backend/tests/cli/router.test.js services/backend/tests/cli/repl.tasks.interaction.test.js`

**781.** 为「CLI Routing and Help Surface」的每个导出函数确认都有对应测试引用，无孤儿导出。
  - 说明：无孤儿导出。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run check:leaf-contract`

**782.** 为「CLI Routing and Help Surface」增加预算/上限保护：循环或累积有明确终止条件，防止失控。
  - 说明：预算护栏。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run test:one -- services/backend/tests/cli/router.test.js services/backend/tests/cli/repl.tasks.interaction.test.js`

**783.** 把「CLI Routing and Help Surface」的巨型 switch 按 case 簇抽子分派器（pre-dispatch + 哨兵 fall-through）。
  - 说明：switch 拆解。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run arch:god`

**784.** 为「CLI Routing and Help Surface」补一条幂等测试：同一操作跑两次结果一致、无副作用叠加。
  - 说明：幂等测试。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run test:one -- services/backend/tests/cli/router.test.js services/backend/tests/cli/repl.tasks.interaction.test.js`

**785.** 检查「CLI Routing and Help Surface」是否遵守单向依赖：叶子不得反向 require 宿主网关，需要就用 IoC 缝。
  - 说明：单向依赖。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run check:leaf-contract`

**786.** 为「CLI Routing and Help Surface」写一份「新维护者一分钟上手」的结构表（文件→职责一行）。
  - 说明：一分钟上手。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run maintainer:check`

**787.** 为「CLI Routing and Help Surface」的时间相关逻辑改为「时钟由调用方喂入」，让它可离线确定性测试。
  - 说明：时钟可注入。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run test:one -- services/backend/tests/cli/router.test.js services/backend/tests/cli/repl.tasks.interaction.test.js`

**788.** 给「CLI Routing and Help Surface」补一条「截断/采样时必须 log 丢了什么」的规则，杜绝静默截断。
  - 说明：别静默截断。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run check:change-safety`

**789.** 为「CLI Routing and Help Surface」增加 dry-run 模式：先展示将要做什么，用户确认后才执行破坏性操作。
  - 说明：dry-run 先行。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run check:small-model:safety`

**790.** 检查「CLI Routing and Help Surface」的 flag 语义：opt-in 严格只认 1/true，default-on 只认关键词才关。
  - 说明：门语义核对。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run check:flag-registry`

**791.** 为「CLI Routing and Help Surface」补一条「父门关闭 → 子功能整体关闭」的门控测试。
  - 说明：父子门控。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run check:flag-registry`

**792.** 把「CLI Routing and Help Surface」里的魔法数字提取为具名常量并注释其单位与来源。
  - 说明：消魔法数。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run check:change-safety`

**793.** 为「CLI Routing and Help Surface」写一条向后兼容测试：旧输入格式仍能被正确解析。
  - 说明：向后兼容。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run test:one -- services/backend/tests/cli/router.test.js services/backend/tests/cli/repl.tasks.interaction.test.js`

**794.** 为「CLI Routing and Help Surface」的注册表新增一维时，确认聚合器与格式化器各只改一处（不 smear）。
  - 说明：改动不 smear。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run test:one -- services/backend/tests/cli/router.test.js services/backend/tests/cli/repl.tasks.interaction.test.js`

**795.** 检查「CLI Routing and Help Surface」抽取后宿主是否仍持有核心态，叶子只拿它需要的切片。
  - 说明：核心态留宿主。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run arch:god`

**796.** 为「CLI Routing and Help Surface」补一条跨渠道/双通道一致性测试（如版本号 pip 与 npm 必须一致）。
  - 说明：双通道一致。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run test:one -- services/backend/tests/cli/router.test.js services/backend/tests/cli/repl.tasks.interaction.test.js`

**797.** 为「CLI Routing and Help Surface」的用户可见文案统一措辞与语气，避免同义词乱用误导弱模型。
  - 说明：文案统一。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run maintainer:check`

**798.** 给「CLI Routing and Help Surface」增加一个健康分自检项，纳入 khy doctor 的输出。
  - 说明：并入自检。 子系统：CLI Routing and Help Surface。
  - 验证：`khy doctor`

**799.** 为「CLI Routing and Help Surface」补一条资源清理测试：临时文件用后即删、句柄关闭、无泄漏。
  - 说明：资源清理。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run test:one -- services/backend/tests/cli/router.test.js services/backend/tests/cli/repl.tasks.interaction.test.js`

**800.** 把「CLI Routing and Help Surface」里可能抛的第三方调用全部包进 try/catch 并给结构化 reason。
  - 说明：结构化容错。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run check:change-safety`

**801.** 为「CLI Routing and Help Surface」写一条已知安全边界注释：明确它是 review aid 还是隔离边界，别夸大保证。
  - 说明：诚实边界。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run check:leaf-contract`

**802.** 为「CLI Routing and Help Surface」补一条空结果早退路径：0 命中时跳过昂贵的下游步骤。
  - 说明：空结果早退。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run test:one -- services/backend/tests/cli/router.test.js services/backend/tests/cli/repl.tasks.interaction.test.js`

**803.** 检查「CLI Routing and Help Surface」的命令别名是否都路由到正确 handler，补一条 alias 路由测试。
  - 说明：别名路由。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run test:one -- services/backend/tests/cli/router.test.js services/backend/tests/cli/repl.tasks.interaction.test.js`

**804.** 为「CLI Routing and Help Surface」建立一条 memory 记录模板，把「为什么这么改」写进传承文档。
  - 说明：沉淀传承。 子系统：CLI Routing and Help Surface。
  - 验证：`npm run maintainer:check`

**805.** 为「Prompt Capsule and Debug Prompt System」增加一个 flag 门控的纯叶子：零 IO、绝不抛异常，先在 flagRegistry 登记 KHY_* 门再接线。
  - 说明：新能力走门控叶子。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`npm run check:flag-registry`

**806.** 为「Prompt Capsule and Debug Prompt System」补一条 node:test，至少覆盖：正常路径、一个边界、一个畸形/空输入。
  - 说明：补测试。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`node --test services/backend/tests/promptOnDemandSections.test.js`

**807.** 通读「Prompt Capsule and Debug Prompt System」核心文件，在顶部一句话写清职责，并给最难懂的分支补一句注释（不改行为）。
  - 说明：补可读性。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`node --test services/backend/tests/promptOnDemandSections.test.js`

**808.** 扫描「Prompt Capsule and Debug Prompt System」是否有文件超 2500 行；若有，按同名 re-export + DI 抽一个聚焦叶子，保字节等价。
  - 说明：拆上帝文件。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`npm run arch:god`

**809.** 给「Prompt Capsule and Debug Prompt System」的注册表叶子（_PROBES/_REPAIRS 之类）上方补 4 步 HOW-TO-EXTEND 抄写式注释。
  - 说明：注册表可扩展。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`npm run maintainer:check`

**810.** 把「Prompt Capsule and Debug Prompt System」中每轮/每请求重复构建的 Set/正则/常量提升为模块常量（参考书 Ch2）。
  - 说明：别每轮重建。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`npm run arch:god`

**811.** 为「Prompt Capsule and Debug Prompt System」增加一个只读诊断探针：只观测不修改，绝不写盘、绝不发网络。
  - 说明：加只读探针。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`node --test services/backend/tests/promptOnDemandSections.test.js`

**812.** 为「Prompt Capsule and Debug Prompt System」增加一个「仅创建缺失项」的安全自愈：幂等、fail-soft、遇损坏拒删交人工。
  - 说明：加安全修复。 子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`node --test services/backend/tests/promptOnDemandSections.test.js`


## 六、逐文件进化

**813.** 为 scripts/docs/check_beginner_docs.js 补一条 node:test（若已有则加一个未覆盖的边界用例）。
  - 说明：子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run docs:check-beginner`

**814.** 检查 scripts/docs/check_beginner_docs.js 是否够弱模型维护：变量名自解释、无魔法数、关键分支有注释。
  - 说明：子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`node --check scripts/docs/check_beginner_docs.js`

**815.** 确认 scripts/docs/check_beginner_docs.js 不含写死的真 key/token，敏感值只经 env 注入（只打印长度不打印值）。
  - 说明：子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run check:model-hardcoding`

**816.** 为 scripts/docs/check_beginner_docs.test.js 补一条 node:test（若已有则加一个未覆盖的边界用例）。
  - 说明：子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run docs:check-beginner`

**817.** 检查 scripts/docs/check_beginner_docs.test.js 是否够弱模型维护：变量名自解释、无魔法数、关键分支有注释。
  - 说明：子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`node --check scripts/docs/check_beginner_docs.test.js`

**818.** 确认 scripts/docs/check_beginner_docs.test.js 不含写死的真 key/token，敏感值只经 env 注入（只打印长度不打印值）。
  - 说明：子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run check:model-hardcoding`

**819.** 为 docs/02_CONCEPTS_概念入门/00_INDEX_概念入门-总览.md 补一条 node:test（若已有则加一个未覆盖的边界用例）。
  - 说明：子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run docs:check-beginner`

**820.** 检查 docs/02_CONCEPTS_概念入门/00_INDEX_概念入门-总览.md 是否够弱模型维护：变量名自解释、无魔法数、关键分支有注释。
  - 说明：子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run docs:check-beginner`

**821.** 确认 docs/02_CONCEPTS_概念入门/00_INDEX_概念入门-总览.md 不含写死的真 key/token，敏感值只经 env 注入（只打印长度不打印值）。
  - 说明：子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run check:model-hardcoding`

**822.** 为 docs/09_STORY_修仙学AI/00_INDEX_修仙学AI-总目录.md 补一条 node:test（若已有则加一个未覆盖的边界用例）。
  - 说明：子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run docs:check-beginner`

**823.** 检查 docs/09_STORY_修仙学AI/00_INDEX_修仙学AI-总目录.md 是否够弱模型维护：变量名自解释、无魔法数、关键分支有注释。
  - 说明：子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run docs:check-beginner`

**824.** 确认 docs/09_STORY_修仙学AI/00_INDEX_修仙学AI-总目录.md 不含写死的真 key/token，敏感值只经 env 注入（只打印长度不打印值）。
  - 说明：子系统：面向小白概念文档 + 修仙学 AI 故事内容（作者向房屋风格 + 单人维护体检）。
  - 验证：`npm run check:model-hardcoding`

**825.** 为 platform/khy_platform/cli.py 补一条 node:test（若已有则加一个未覆盖的边界用例）。
  - 说明：子系统：Bootstrap and Packaging。
  - 验证：`npm run check:manifest-sync`

**826.** 检查 platform/khy_platform/cli.py 是否够弱模型维护：变量名自解释、无魔法数、关键分支有注释。
  - 说明：子系统：Bootstrap and Packaging。
  - 验证：`npm run check:manifest-sync`

**827.** 确认 platform/khy_platform/cli.py 不含写死的真 key/token，敏感值只经 env 注入（只打印长度不打印值）。
  - 说明：子系统：Bootstrap and Packaging。
  - 验证：`npm run check:model-hardcoding`

**828.** 为 platform/khy_platform/_bootstrap.py 补一条 node:test（若已有则加一个未覆盖的边界用例）。
  - 说明：子系统：Bootstrap and Packaging。
  - 验证：`npm run check:manifest-sync`

**829.** 检查 platform/khy_platform/_bootstrap.py 是否够弱模型维护：变量名自解释、无魔法数、关键分支有注释。
  - 说明：子系统：Bootstrap and Packaging。
  - 验证：`npm run check:manifest-sync`

**830.** 确认 platform/khy_platform/_bootstrap.py 不含写死的真 key/token，敏感值只经 env 注入（只打印长度不打印值）。
  - 说明：子系统：Bootstrap and Packaging。
  - 验证：`npm run check:model-hardcoding`

**831.** 为 platform/khy_platform/__init__.py 补一条 node:test（若已有则加一个未覆盖的边界用例）。
  - 说明：子系统：Bootstrap and Packaging。
  - 验证：`npm run check:manifest-sync`

**832.** 检查 platform/khy_platform/__init__.py 是否够弱模型维护：变量名自解释、无魔法数、关键分支有注释。
  - 说明：子系统：Bootstrap and Packaging。
  - 验证：`npm run check:manifest-sync`

**833.** 确认 platform/khy_platform/__init__.py 不含写死的真 key/token，敏感值只经 env 注入（只打印长度不打印值）。
  - 说明：子系统：Bootstrap and Packaging。
  - 验证：`npm run check:model-hardcoding`

**834.** 为 pyproject.toml 补一条 node:test（若已有则加一个未覆盖的边界用例）。
  - 说明：子系统：Bootstrap and Packaging。
  - 验证：`npm run check:manifest-sync`

**835.** 检查 pyproject.toml 是否够弱模型维护：变量名自解释、无魔法数、关键分支有注释。
  - 说明：子系统：Bootstrap and Packaging。
  - 验证：`npm run check:manifest-sync`

**836.** 确认 pyproject.toml 不含写死的真 key/token，敏感值只经 env 注入（只打印长度不打印值）。
  - 说明：子系统：Bootstrap and Packaging。
  - 验证：`npm run check:model-hardcoding`

**837.** 为 software/khyquant/setup.py 补一条 node:test（若已有则加一个未覆盖的边界用例）。
  - 说明：子系统：Bootstrap and Packaging。
  - 验证：`npm run check:manifest-sync`

**838.** 检查 software/khyquant/setup.py 是否够弱模型维护：变量名自解释、无魔法数、关键分支有注释。
  - 说明：子系统：Bootstrap and Packaging。
  - 验证：`npm run check:manifest-sync`

**839.** 确认 software/khyquant/setup.py 不含写死的真 key/token，敏感值只经 env 注入（只打印长度不打印值）。
  - 说明：子系统：Bootstrap and Packaging。
  - 验证：`npm run check:model-hardcoding`

**840.** 为 software/khyquant/MANIFEST.in 补一条 node:test（若已有则加一个未覆盖的边界用例）。
  - 说明：子系统：Bootstrap and Packaging。
  - 验证：`npm run check:manifest-sync`

**841.** 检查 software/khyquant/MANIFEST.in 是否够弱模型维护：变量名自解释、无魔法数、关键分支有注释。
  - 说明：子系统：Bootstrap and Packaging。
  - 验证：`npm run check:manifest-sync`

**842.** 确认 software/khyquant/MANIFEST.in 不含写死的真 key/token，敏感值只经 env 注入（只打印长度不打印值）。
  - 说明：子系统：Bootstrap and Packaging。
  - 验证：`npm run check:model-hardcoding`

**843.** 为 packaging/npm/package.json 补一条 node:test（若已有则加一个未覆盖的边界用例）。
  - 说明：子系统：Bootstrap and Packaging。
  - 验证：`npm run check:manifest-sync`

**844.** 检查 packaging/npm/package.json 是否够弱模型维护：变量名自解释、无魔法数、关键分支有注释。
  - 说明：子系统：Bootstrap and Packaging。
  - 验证：`npm run check:manifest-sync`

**845.** 确认 packaging/npm/package.json 不含写死的真 key/token，敏感值只经 env 注入（只打印长度不打印值）。
  - 说明：子系统：Bootstrap and Packaging。
  - 验证：`npm run check:model-hardcoding`

**846.** 为 services/backend/package.json 补一条 node:test（若已有则加一个未覆盖的边界用例）。
  - 说明：子系统：Bootstrap and Packaging。
  - 验证：`npm run check:manifest-sync`

**847.** 检查 services/backend/package.json 是否够弱模型维护：变量名自解释、无魔法数、关键分支有注释。
  - 说明：子系统：Bootstrap and Packaging。
  - 验证：`npm run check:manifest-sync`

**848.** 确认 services/backend/package.json 不含写死的真 key/token，敏感值只经 env 注入（只打印长度不打印值）。
  - 说明：子系统：Bootstrap and Packaging。
  - 验证：`npm run check:model-hardcoding`

**849.** 为 services/backend/src/constants/commandSchema.js 补一条 node:test（若已有则加一个未覆盖的边界用例）。
  - 说明：子系统：CLI Routing and Help Surface。
  - 验证：`npm run test:one -- services/backend/tests/cli/router.test.js services/backend/tests/cli/repl.tasks.interaction.test.js`

**850.** 检查 services/backend/src/constants/commandSchema.js 是否够弱模型维护：变量名自解释、无魔法数、关键分支有注释。
  - 说明：子系统：CLI Routing and Help Surface。
  - 验证：`node --check services/backend/src/constants/commandSchema.js`

**851.** 确认 services/backend/src/constants/commandSchema.js 不含写死的真 key/token，敏感值只经 env 注入（只打印长度不打印值）。
  - 说明：子系统：CLI Routing and Help Surface。
  - 验证：`npm run check:model-hardcoding`

**852.** 为 services/backend/src/cli/aliases.js 补一条 node:test（若已有则加一个未覆盖的边界用例）。
  - 说明：子系统：CLI Routing and Help Surface。
  - 验证：`npm run test:one -- services/backend/tests/cli/router.test.js services/backend/tests/cli/repl.tasks.interaction.test.js`

**853.** 检查 services/backend/src/cli/aliases.js 是否够弱模型维护：变量名自解释、无魔法数、关键分支有注释。
  - 说明：子系统：CLI Routing and Help Surface。
  - 验证：`node --check services/backend/src/cli/aliases.js`

**854.** 确认 services/backend/src/cli/aliases.js 不含写死的真 key/token，敏感值只经 env 注入（只打印长度不打印值）。
  - 说明：子系统：CLI Routing and Help Surface。
  - 验证：`npm run check:model-hardcoding`

**855.** 为 services/backend/src/cli/router.js 补一条 node:test（若已有则加一个未覆盖的边界用例）。
  - 说明：子系统：CLI Routing and Help Surface。
  - 验证：`npm run test:one -- services/backend/tests/cli/router.test.js services/backend/tests/cli/repl.tasks.interaction.test.js`

**856.** 检查 services/backend/src/cli/router.js 是否够弱模型维护：变量名自解释、无魔法数、关键分支有注释。
  - 说明：子系统：CLI Routing and Help Surface。
  - 验证：`node --check services/backend/src/cli/router.js`

**857.** 确认 services/backend/src/cli/router.js 不含写死的真 key/token，敏感值只经 env 注入（只打印长度不打印值）。
  - 说明：子系统：CLI Routing and Help Surface。
  - 验证：`npm run check:model-hardcoding`

**858.** 为 services/backend/src/cli/repl.js 补一条 node:test（若已有则加一个未覆盖的边界用例）。
  - 说明：子系统：CLI Routing and Help Surface。
  - 验证：`npm run test:one -- services/backend/tests/cli/router.test.js services/backend/tests/cli/repl.tasks.interaction.test.js`

**859.** 检查 services/backend/src/cli/repl.js 是否够弱模型维护：变量名自解释、无魔法数、关键分支有注释。
  - 说明：子系统：CLI Routing and Help Surface。
  - 验证：`node --check services/backend/src/cli/repl.js`

**860.** 确认 services/backend/src/cli/repl.js 不含写死的真 key/token，敏感值只经 env 注入（只打印长度不打印值）。
  - 说明：子系统：CLI Routing and Help Surface。
  - 验证：`npm run check:model-hardcoding`

**861.** 为 services/backend/src/cli/handlers 补一条 node:test（若已有则加一个未覆盖的边界用例）。
  - 说明：子系统：CLI Routing and Help Surface。
  - 验证：`npm run test:one -- services/backend/tests/cli/router.test.js services/backend/tests/cli/repl.tasks.interaction.test.js`

**862.** 检查 services/backend/src/cli/handlers 是否够弱模型维护：变量名自解释、无魔法数、关键分支有注释。
  - 说明：子系统：CLI Routing and Help Surface。
  - 验证：`npm run test:one -- services/backend/tests/cli/router.test.js services/backend/tests/cli/repl.tasks.interaction.test.js`

**863.** 确认 services/backend/src/cli/handlers 不含写死的真 key/token，敏感值只经 env 注入（只打印长度不打印值）。
  - 说明：子系统：CLI Routing and Help Surface。
  - 验证：`npm run check:model-hardcoding`

**864.** 为 services/backend/tests/cli/router.test.js 补一条 node:test（若已有则加一个未覆盖的边界用例）。
  - 说明：子系统：CLI Routing and Help Surface。
  - 验证：`npm run test:one -- services/backend/tests/cli/router.test.js services/backend/tests/cli/repl.tasks.interaction.test.js`

**865.** 检查 services/backend/tests/cli/router.test.js 是否够弱模型维护：变量名自解释、无魔法数、关键分支有注释。
  - 说明：子系统：CLI Routing and Help Surface。
  - 验证：`node --check services/backend/tests/cli/router.test.js`

**866.** 确认 services/backend/tests/cli/router.test.js 不含写死的真 key/token，敏感值只经 env 注入（只打印长度不打印值）。
  - 说明：子系统：CLI Routing and Help Surface。
  - 验证：`npm run check:model-hardcoding`

**867.** 为 services/backend/tests/cli/repl.tasks.interaction.test.js 补一条 node:test（若已有则加一个未覆盖的边界用例）。
  - 说明：子系统：CLI Routing and Help Surface。
  - 验证：`npm run test:one -- services/backend/tests/cli/router.test.js services/backend/tests/cli/repl.tasks.interaction.test.js`

**868.** 检查 services/backend/tests/cli/repl.tasks.interaction.test.js 是否够弱模型维护：变量名自解释、无魔法数、关键分支有注释。
  - 说明：子系统：CLI Routing and Help Surface。
  - 验证：`node --check services/backend/tests/cli/repl.tasks.interaction.test.js`

**869.** 确认 services/backend/tests/cli/repl.tasks.interaction.test.js 不含写死的真 key/token，敏感值只经 env 注入（只打印长度不打印值）。
  - 说明：子系统：CLI Routing and Help Surface。
  - 验证：`npm run check:model-hardcoding`

**870.** 为 services/backend/src/constants/prompts.js 补一条 node:test（若已有则加一个未覆盖的边界用例）。
  - 说明：子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`node --test services/backend/tests/promptOnDemandSections.test.js`

**871.** 检查 services/backend/src/constants/prompts.js 是否够弱模型维护：变量名自解释、无魔法数、关键分支有注释。
  - 说明：子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`node --check services/backend/src/constants/prompts.js`

**872.** 确认 services/backend/src/constants/prompts.js 不含写死的真 key/token，敏感值只经 env 注入（只打印长度不打印值）。
  - 说明：子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`npm run check:model-hardcoding`

**873.** 为 services/backend/src/services/khyUpgradeRuntime.js 补一条 node:test（若已有则加一个未覆盖的边界用例）。
  - 说明：子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`node --test services/backend/tests/promptOnDemandSections.test.js`

**874.** 检查 services/backend/src/services/khyUpgradeRuntime.js 是否够弱模型维护：变量名自解释、无魔法数、关键分支有注释。
  - 说明：子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`node --check services/backend/src/services/khyUpgradeRuntime.js`

**875.** 确认 services/backend/src/services/khyUpgradeRuntime.js 不含写死的真 key/token，敏感值只经 env 注入（只打印长度不打印值）。
  - 说明：子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`npm run check:model-hardcoding`

**876.** 为 services/backend/src/services/compact/prompt.js 补一条 node:test（若已有则加一个未覆盖的边界用例）。
  - 说明：子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`node --test services/backend/tests/promptOnDemandSections.test.js`

**877.** 检查 services/backend/src/services/compact/prompt.js 是否够弱模型维护：变量名自解释、无魔法数、关键分支有注释。
  - 说明：子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`node --check services/backend/src/services/compact/prompt.js`

**878.** 确认 services/backend/src/services/compact/prompt.js 不含写死的真 key/token，敏感值只经 env 注入（只打印长度不打印值）。
  - 说明：子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`npm run check:model-hardcoding`

**879.** 为 services/backend/src/cli/handlers/gateway.js 补一条 node:test（若已有则加一个未覆盖的边界用例）。
  - 说明：子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`node --test services/backend/tests/promptOnDemandSections.test.js`

**880.** 检查 services/backend/src/cli/handlers/gateway.js 是否够弱模型维护：变量名自解释、无魔法数、关键分支有注释。
  - 说明：子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`node --check services/backend/src/cli/handlers/gateway.js`

**881.** 确认 services/backend/src/cli/handlers/gateway.js 不含写死的真 key/token，敏感值只经 env 注入（只打印长度不打印值）。
  - 说明：子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`npm run check:model-hardcoding`

**882.** 为 services/backend/tests/promptOnDemandSections.test.js 补一条 node:test（若已有则加一个未覆盖的边界用例）。
  - 说明：子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`node --test services/backend/tests/promptOnDemandSections.test.js`

**883.** 检查 services/backend/tests/promptOnDemandSections.test.js 是否够弱模型维护：变量名自解释、无魔法数、关键分支有注释。
  - 说明：子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`node --check services/backend/tests/promptOnDemandSections.test.js`

**884.** 确认 services/backend/tests/promptOnDemandSections.test.js 不含写死的真 key/token，敏感值只经 env 注入（只打印长度不打印值）。
  - 说明：子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`npm run check:model-hardcoding`

**885.** 为 services/backend/tests/promptLearningRules.test.js 补一条 node:test（若已有则加一个未覆盖的边界用例）。
  - 说明：子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`node --test services/backend/tests/promptOnDemandSections.test.js`

**886.** 检查 services/backend/tests/promptLearningRules.test.js 是否够弱模型维护：变量名自解释、无魔法数、关键分支有注释。
  - 说明：子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`node --check services/backend/tests/promptLearningRules.test.js`

**887.** 确认 services/backend/tests/promptLearningRules.test.js 不含写死的真 key/token，敏感值只经 env 注入（只打印长度不打印值）。
  - 说明：子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`npm run check:model-hardcoding`

**888.** 为 services/backend/tests/gatewayDebugPrompt.test.js 补一条 node:test（若已有则加一个未覆盖的边界用例）。
  - 说明：子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`node --test services/backend/tests/promptOnDemandSections.test.js`

**889.** 检查 services/backend/tests/gatewayDebugPrompt.test.js 是否够弱模型维护：变量名自解释、无魔法数、关键分支有注释。
  - 说明：子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`node --check services/backend/tests/gatewayDebugPrompt.test.js`

**890.** 确认 services/backend/tests/gatewayDebugPrompt.test.js 不含写死的真 key/token，敏感值只经 env 注入（只打印长度不打印值）。
  - 说明：子系统：Prompt Capsule and Debug Prompt System。
  - 验证：`npm run check:model-hardcoding`

**891.** 为 services/backend/src/services/gateway/aiGateway.js 补一条 node:test（若已有则加一个未覆盖的边界用例）。
  - 说明：子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run test:one -- services/backend/tests/aiGateway.stability.test.js services/backend/tests/gateway/transportResilience.test.js services/backend/tests/gatewayAdapters.stability.test.js`

**892.** 检查 services/backend/src/services/gateway/aiGateway.js 是否够弱模型维护：变量名自解释、无魔法数、关键分支有注释。
  - 说明：子系统：AI Gateway and Adapter Layer。
  - 验证：`node --check services/backend/src/services/gateway/aiGateway.js`

**893.** 确认 services/backend/src/services/gateway/aiGateway.js 不含写死的真 key/token，敏感值只经 env 注入（只打印长度不打印值）。
  - 说明：子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run check:model-hardcoding`

**894.** 为 services/backend/src/services/gateway/adapters 补一条 node:test（若已有则加一个未覆盖的边界用例）。
  - 说明：子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run test:one -- services/backend/tests/aiGateway.stability.test.js services/backend/tests/gateway/transportResilience.test.js services/backend/tests/gatewayAdapters.stability.test.js`

**895.** 检查 services/backend/src/services/gateway/adapters 是否够弱模型维护：变量名自解释、无魔法数、关键分支有注释。
  - 说明：子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run test:one -- services/backend/tests/aiGateway.stability.test.js services/backend/tests/gateway/transportResilience.test.js services/backend/tests/gatewayAdapters.stability.test.js`

**896.** 确认 services/backend/src/services/gateway/adapters 不含写死的真 key/token，敏感值只经 env 注入（只打印长度不打印值）。
  - 说明：子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run check:model-hardcoding`

**897.** 为 services/backend/src/services/gateway/proxyServer.js 补一条 node:test（若已有则加一个未覆盖的边界用例）。
  - 说明：子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run test:one -- services/backend/tests/aiGateway.stability.test.js services/backend/tests/gateway/transportResilience.test.js services/backend/tests/gatewayAdapters.stability.test.js`

**898.** 检查 services/backend/src/services/gateway/proxyServer.js 是否够弱模型维护：变量名自解释、无魔法数、关键分支有注释。
  - 说明：子系统：AI Gateway and Adapter Layer。
  - 验证：`node --check services/backend/src/services/gateway/proxyServer.js`

**899.** 确认 services/backend/src/services/gateway/proxyServer.js 不含写死的真 key/token，敏感值只经 env 注入（只打印长度不打印值）。
  - 说明：子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run check:model-hardcoding`

**900.** 为 services/backend/tests/aiGateway.stability.test.js 补一条 node:test（若已有则加一个未覆盖的边界用例）。
  - 说明：子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run test:one -- services/backend/tests/aiGateway.stability.test.js services/backend/tests/gateway/transportResilience.test.js services/backend/tests/gatewayAdapters.stability.test.js`

**901.** 检查 services/backend/tests/aiGateway.stability.test.js 是否够弱模型维护：变量名自解释、无魔法数、关键分支有注释。
  - 说明：子系统：AI Gateway and Adapter Layer。
  - 验证：`node --check services/backend/tests/aiGateway.stability.test.js`

**902.** 确认 services/backend/tests/aiGateway.stability.test.js 不含写死的真 key/token，敏感值只经 env 注入（只打印长度不打印值）。
  - 说明：子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run check:model-hardcoding`

**903.** 为 services/backend/tests/gateway/transportResilience.test.js 补一条 node:test（若已有则加一个未覆盖的边界用例）。
  - 说明：子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run test:one -- services/backend/tests/aiGateway.stability.test.js services/backend/tests/gateway/transportResilience.test.js services/backend/tests/gatewayAdapters.stability.test.js`

**904.** 检查 services/backend/tests/gateway/transportResilience.test.js 是否够弱模型维护：变量名自解释、无魔法数、关键分支有注释。
  - 说明：子系统：AI Gateway and Adapter Layer。
  - 验证：`node --check services/backend/tests/gateway/transportResilience.test.js`

**905.** 确认 services/backend/tests/gateway/transportResilience.test.js 不含写死的真 key/token，敏感值只经 env 注入（只打印长度不打印值）。
  - 说明：子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run check:model-hardcoding`

**906.** 为 services/backend/tests/gatewayAdapters.stability.test.js 补一条 node:test（若已有则加一个未覆盖的边界用例）。
  - 说明：子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run test:one -- services/backend/tests/aiGateway.stability.test.js services/backend/tests/gateway/transportResilience.test.js services/backend/tests/gatewayAdapters.stability.test.js`

**907.** 检查 services/backend/tests/gatewayAdapters.stability.test.js 是否够弱模型维护：变量名自解释、无魔法数、关键分支有注释。
  - 说明：子系统：AI Gateway and Adapter Layer。
  - 验证：`node --check services/backend/tests/gatewayAdapters.stability.test.js`

**908.** 确认 services/backend/tests/gatewayAdapters.stability.test.js 不含写死的真 key/token，敏感值只经 env 注入（只打印长度不打印值）。
  - 说明：子系统：AI Gateway and Adapter Layer。
  - 验证：`npm run check:model-hardcoding`

**909.** 为 services/backend/src/services/daemonManager.js 补一条 node:test（若已有则加一个未覆盖的边界用例）。
  - 说明：子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run test:one -- services/backend/tests/daemonManager.runtimePort.test.js services/backend/tests/gatewayManage.portDrift.integration.test.js services/backend/tests/services/proxyBaseUrl.test.js services/backend/tests/services/serviceDefaults.test.js`

**910.** 检查 services/backend/src/services/daemonManager.js 是否够弱模型维护：变量名自解释、无魔法数、关键分支有注释。
  - 说明：子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`node --check services/backend/src/services/daemonManager.js`

**911.** 确认 services/backend/src/services/daemonManager.js 不含写死的真 key/token，敏感值只经 env 注入（只打印长度不打印值）。
  - 说明：子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run check:model-hardcoding`

**912.** 为 services/backend/src/services/aiManagementServer.js 补一条 node:test（若已有则加一个未覆盖的边界用例）。
  - 说明：子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run test:one -- services/backend/tests/daemonManager.runtimePort.test.js services/backend/tests/gatewayManage.portDrift.integration.test.js services/backend/tests/services/proxyBaseUrl.test.js services/backend/tests/services/serviceDefaults.test.js`

**913.** 检查 services/backend/src/services/aiManagementServer.js 是否够弱模型维护：变量名自解释、无魔法数、关键分支有注释。
  - 说明：子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`node --check services/backend/src/services/aiManagementServer.js`

**914.** 确认 services/backend/src/services/aiManagementServer.js 不含写死的真 key/token，敏感值只经 env 注入（只打印长度不打印值）。
  - 说明：子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run check:model-hardcoding`

**915.** 为 services/backend/src/services/gateway/proxyServer.js 补一条 node:test（若已有则加一个未覆盖的边界用例）。
  - 说明：子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run test:one -- services/backend/tests/daemonManager.runtimePort.test.js services/backend/tests/gatewayManage.portDrift.integration.test.js services/backend/tests/services/proxyBaseUrl.test.js services/backend/tests/services/serviceDefaults.test.js`

**916.** 检查 services/backend/src/services/gateway/proxyServer.js 是否够弱模型维护：变量名自解释、无魔法数、关键分支有注释。
  - 说明：子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`node --check services/backend/src/services/gateway/proxyServer.js`

**917.** 确认 services/backend/src/services/gateway/proxyServer.js 不含写死的真 key/token，敏感值只经 env 注入（只打印长度不打印值）。
  - 说明：子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run check:model-hardcoding`

**918.** 为 services/backend/src/utils/proxyBaseUrl.js 补一条 node:test（若已有则加一个未覆盖的边界用例）。
  - 说明：子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run test:one -- services/backend/tests/daemonManager.runtimePort.test.js services/backend/tests/gatewayManage.portDrift.integration.test.js services/backend/tests/services/proxyBaseUrl.test.js services/backend/tests/services/serviceDefaults.test.js`

**919.** 检查 services/backend/src/utils/proxyBaseUrl.js 是否够弱模型维护：变量名自解释、无魔法数、关键分支有注释。
  - 说明：子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`node --check services/backend/src/utils/proxyBaseUrl.js`

**920.** 确认 services/backend/src/utils/proxyBaseUrl.js 不含写死的真 key/token，敏感值只经 env 注入（只打印长度不打印值）。
  - 说明：子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run check:model-hardcoding`

**921.** 为 services/backend/src/constants/serviceDefaults.js 补一条 node:test（若已有则加一个未覆盖的边界用例）。
  - 说明：子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run test:one -- services/backend/tests/daemonManager.runtimePort.test.js services/backend/tests/gatewayManage.portDrift.integration.test.js services/backend/tests/services/proxyBaseUrl.test.js services/backend/tests/services/serviceDefaults.test.js`

**922.** 检查 services/backend/src/constants/serviceDefaults.js 是否够弱模型维护：变量名自解释、无魔法数、关键分支有注释。
  - 说明：子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`node --check services/backend/src/constants/serviceDefaults.js`

**923.** 确认 services/backend/src/constants/serviceDefaults.js 不含写死的真 key/token，敏感值只经 env 注入（只打印长度不打印值）。
  - 说明：子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run check:model-hardcoding`

**924.** 为 services/backend/tests/daemonManager.runtimePort.test.js 补一条 node:test（若已有则加一个未覆盖的边界用例）。
  - 说明：子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run test:one -- services/backend/tests/daemonManager.runtimePort.test.js services/backend/tests/gatewayManage.portDrift.integration.test.js services/backend/tests/services/proxyBaseUrl.test.js services/backend/tests/services/serviceDefaults.test.js`

**925.** 检查 services/backend/tests/daemonManager.runtimePort.test.js 是否够弱模型维护：变量名自解释、无魔法数、关键分支有注释。
  - 说明：子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`node --check services/backend/tests/daemonManager.runtimePort.test.js`

**926.** 确认 services/backend/tests/daemonManager.runtimePort.test.js 不含写死的真 key/token，敏感值只经 env 注入（只打印长度不打印值）。
  - 说明：子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run check:model-hardcoding`

**927.** 为 services/backend/tests/gatewayManage.portDrift.integration.test.js 补一条 node:test（若已有则加一个未覆盖的边界用例）。
  - 说明：子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run test:one -- services/backend/tests/daemonManager.runtimePort.test.js services/backend/tests/gatewayManage.portDrift.integration.test.js services/backend/tests/services/proxyBaseUrl.test.js services/backend/tests/services/serviceDefaults.test.js`

**928.** 检查 services/backend/tests/gatewayManage.portDrift.integration.test.js 是否够弱模型维护：变量名自解释、无魔法数、关键分支有注释。
  - 说明：子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`node --check services/backend/tests/gatewayManage.portDrift.integration.test.js`

**929.** 确认 services/backend/tests/gatewayManage.portDrift.integration.test.js 不含写死的真 key/token，敏感值只经 env 注入（只打印长度不打印值）。
  - 说明：子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run check:model-hardcoding`

**930.** 为 services/backend/tests/services/proxyBaseUrl.test.js 补一条 node:test（若已有则加一个未覆盖的边界用例）。
  - 说明：子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run test:one -- services/backend/tests/daemonManager.runtimePort.test.js services/backend/tests/gatewayManage.portDrift.integration.test.js services/backend/tests/services/proxyBaseUrl.test.js services/backend/tests/services/serviceDefaults.test.js`

**931.** 检查 services/backend/tests/services/proxyBaseUrl.test.js 是否够弱模型维护：变量名自解释、无魔法数、关键分支有注释。
  - 说明：子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`node --check services/backend/tests/services/proxyBaseUrl.test.js`

**932.** 确认 services/backend/tests/services/proxyBaseUrl.test.js 不含写死的真 key/token，敏感值只经 env 注入（只打印长度不打印值）。
  - 说明：子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run check:model-hardcoding`

**933.** 为 services/backend/tests/services/serviceDefaults.test.js 补一条 node:test（若已有则加一个未覆盖的边界用例）。
  - 说明：子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run test:one -- services/backend/tests/daemonManager.runtimePort.test.js services/backend/tests/gatewayManage.portDrift.integration.test.js services/backend/tests/services/proxyBaseUrl.test.js services/backend/tests/services/serviceDefaults.test.js`

**934.** 检查 services/backend/tests/services/serviceDefaults.test.js 是否够弱模型维护：变量名自解释、无魔法数、关键分支有注释。
  - 说明：子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`node --check services/backend/tests/services/serviceDefaults.test.js`

**935.** 确认 services/backend/tests/services/serviceDefaults.test.js 不含写死的真 key/token，敏感值只经 env 注入（只打印长度不打印值）。
  - 说明：子系统：Proxy, Daemon, and Runtime Port Discovery。
  - 验证：`npm run check:model-hardcoding`

**936.** 为 services/backend/src/routes/aiGatewayAdmin.js 补一条 node:test（若已有则加一个未覆盖的边界用例）。
  - 说明：子系统：AI Management UI and API。
  - 验证：`npm run test:one -- services/backend/tests/routes/aiGatewayAdmin.modelSlots.test.js services/backend/tests/gatewayManage.apiDisplay.test.js`

**937.** 检查 services/backend/src/routes/aiGatewayAdmin.js 是否够弱模型维护：变量名自解释、无魔法数、关键分支有注释。
  - 说明：子系统：AI Management UI and API。
  - 验证：`node --check services/backend/src/routes/aiGatewayAdmin.js`

**938.** 确认 services/backend/src/routes/aiGatewayAdmin.js 不含写死的真 key/token，敏感值只经 env 注入（只打印长度不打印值）。
  - 说明：子系统：AI Management UI and API。
  - 验证：`npm run check:model-hardcoding`

**939.** 为 services/ai-backend/src/routes/aiGatewayAdmin.js 补一条 node:test（若已有则加一个未覆盖的边界用例）。
  - 说明：子系统：AI Management UI and API。
  - 验证：`npm run test:one -- services/backend/tests/routes/aiGatewayAdmin.modelSlots.test.js services/backend/tests/gatewayManage.apiDisplay.test.js`

**940.** 检查 services/ai-backend/src/routes/aiGatewayAdmin.js 是否够弱模型维护：变量名自解释、无魔法数、关键分支有注释。
  - 说明：子系统：AI Management UI and API。
  - 验证：`node --check services/ai-backend/src/routes/aiGatewayAdmin.js`

**941.** 确认 services/ai-backend/src/routes/aiGatewayAdmin.js 不含写死的真 key/token，敏感值只经 env 注入（只打印长度不打印值）。
  - 说明：子系统：AI Management UI and API。
  - 验证：`npm run check:model-hardcoding`

**942.** 为 apps/ai-frontend/src 补一条 node:test（若已有则加一个未覆盖的边界用例）。
  - 说明：子系统：AI Management UI and API。
  - 验证：`npm run test:one -- services/backend/tests/routes/aiGatewayAdmin.modelSlots.test.js services/backend/tests/gatewayManage.apiDisplay.test.js`

**943.** 检查 apps/ai-frontend/src 是否够弱模型维护：变量名自解释、无魔法数、关键分支有注释。
  - 说明：子系统：AI Management UI and API。
  - 验证：`npm run test:one -- services/backend/tests/routes/aiGatewayAdmin.modelSlots.test.js services/backend/tests/gatewayManage.apiDisplay.test.js`

**944.** 确认 apps/ai-frontend/src 不含写死的真 key/token，敏感值只经 env 注入（只打印长度不打印值）。
  - 说明：子系统：AI Management UI and API。
  - 验证：`npm run check:model-hardcoding`

**945.** 为 apps/ai-frontend/package.json 补一条 node:test（若已有则加一个未覆盖的边界用例）。
  - 说明：子系统：AI Management UI and API。
  - 验证：`npm run test:one -- services/backend/tests/routes/aiGatewayAdmin.modelSlots.test.js services/backend/tests/gatewayManage.apiDisplay.test.js`

**946.** 检查 apps/ai-frontend/package.json 是否够弱模型维护：变量名自解释、无魔法数、关键分支有注释。
  - 说明：子系统：AI Management UI and API。
  - 验证：`npm run test:one -- services/backend/tests/routes/aiGatewayAdmin.modelSlots.test.js services/backend/tests/gatewayManage.apiDisplay.test.js`

**947.** 确认 apps/ai-frontend/package.json 不含写死的真 key/token，敏感值只经 env 注入（只打印长度不打印值）。
  - 说明：子系统：AI Management UI and API。
  - 验证：`npm run check:model-hardcoding`

**948.** 为 apps/ai-frontend/vite.config.js 补一条 node:test（若已有则加一个未覆盖的边界用例）。
  - 说明：子系统：AI Management UI and API。
  - 验证：`npm run test:one -- services/backend/tests/routes/aiGatewayAdmin.modelSlots.test.js services/backend/tests/gatewayManage.apiDisplay.test.js`

**949.** 检查 apps/ai-frontend/vite.config.js 是否够弱模型维护：变量名自解释、无魔法数、关键分支有注释。
  - 说明：子系统：AI Management UI and API。
  - 验证：`node --check apps/ai-frontend/vite.config.js`

**950.** 确认 apps/ai-frontend/vite.config.js 不含写死的真 key/token，敏感值只经 env 注入（只打印长度不打印值）。
  - 说明：子系统：AI Management UI and API。
  - 验证：`npm run check:model-hardcoding`

**951.** 为 services/backend/src/cli/handlers/gateway.js 补一条 node:test（若已有则加一个未覆盖的边界用例）。
  - 说明：子系统：AI Management UI and API。
  - 验证：`npm run test:one -- services/backend/tests/routes/aiGatewayAdmin.modelSlots.test.js services/backend/tests/gatewayManage.apiDisplay.test.js`

**952.** 检查 services/backend/src/cli/handlers/gateway.js 是否够弱模型维护：变量名自解释、无魔法数、关键分支有注释。
  - 说明：子系统：AI Management UI and API。
  - 验证：`node --check services/backend/src/cli/handlers/gateway.js`

**953.** 确认 services/backend/src/cli/handlers/gateway.js 不含写死的真 key/token，敏感值只经 env 注入（只打印长度不打印值）。
  - 说明：子系统：AI Management UI and API。
  - 验证：`npm run check:model-hardcoding`

**954.** 为 services/backend/tests/routes/aiGatewayAdmin.modelSlots.test.js 补一条 node:test（若已有则加一个未覆盖的边界用例）。
  - 说明：子系统：AI Management UI and API。
  - 验证：`npm run test:one -- services/backend/tests/routes/aiGatewayAdmin.modelSlots.test.js services/backend/tests/gatewayManage.apiDisplay.test.js`

**955.** 检查 services/backend/tests/routes/aiGatewayAdmin.modelSlots.test.js 是否够弱模型维护：变量名自解释、无魔法数、关键分支有注释。
  - 说明：子系统：AI Management UI and API。
  - 验证：`node --check services/backend/tests/routes/aiGatewayAdmin.modelSlots.test.js`

**956.** 确认 services/backend/tests/routes/aiGatewayAdmin.modelSlots.test.js 不含写死的真 key/token，敏感值只经 env 注入（只打印长度不打印值）。
  - 说明：子系统：AI Management UI and API。
  - 验证：`npm run check:model-hardcoding`

**957.** 为 services/backend/tests/gatewayManage.apiDisplay.test.js 补一条 node:test（若已有则加一个未覆盖的边界用例）。
  - 说明：子系统：AI Management UI and API。
  - 验证：`npm run test:one -- services/backend/tests/routes/aiGatewayAdmin.modelSlots.test.js services/backend/tests/gatewayManage.apiDisplay.test.js`

**958.** 检查 services/backend/tests/gatewayManage.apiDisplay.test.js 是否够弱模型维护：变量名自解释、无魔法数、关键分支有注释。
  - 说明：子系统：AI Management UI and API。
  - 验证：`node --check services/backend/tests/gatewayManage.apiDisplay.test.js`

**959.** 确认 services/backend/tests/gatewayManage.apiDisplay.test.js 不含写死的真 key/token，敏感值只经 env 注入（只打印长度不打印值）。
  - 说明：子系统：AI Management UI and API。
  - 验证：`npm run check:model-hardcoding`

**960.** 为 platform/packages/shared/src/models/UserProject.js 补一条 node:test（若已有则加一个未覆盖的边界用例）。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run test:one -- services/backend/tests/projectStore.test.js apps/ai-frontend/src/composables/useProjects.wiring.test.js`

**961.** 检查 platform/packages/shared/src/models/UserProject.js 是否够弱模型维护：变量名自解释、无魔法数、关键分支有注释。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`node --check platform/packages/shared/src/models/UserProject.js`

**962.** 确认 platform/packages/shared/src/models/UserProject.js 不含写死的真 key/token，敏感值只经 env 注入（只打印长度不打印值）。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run check:model-hardcoding`

**963.** 为 platform/packages/shared/src/models/index.js 补一条 node:test（若已有则加一个未覆盖的边界用例）。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run test:one -- services/backend/tests/projectStore.test.js apps/ai-frontend/src/composables/useProjects.wiring.test.js`

**964.** 检查 platform/packages/shared/src/models/index.js 是否够弱模型维护：变量名自解释、无魔法数、关键分支有注释。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`node --check platform/packages/shared/src/models/index.js`

**965.** 确认 platform/packages/shared/src/models/index.js 不含写死的真 key/token，敏感值只经 env 注入（只打印长度不打印值）。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run check:model-hardcoding`

**966.** 为 services/backend/src/services/projectStore.js 补一条 node:test（若已有则加一个未覆盖的边界用例）。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run test:one -- services/backend/tests/projectStore.test.js apps/ai-frontend/src/composables/useProjects.wiring.test.js`

**967.** 检查 services/backend/src/services/projectStore.js 是否够弱模型维护：变量名自解释、无魔法数、关键分支有注释。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`node --check services/backend/src/services/projectStore.js`

**968.** 确认 services/backend/src/services/projectStore.js 不含写死的真 key/token，敏感值只经 env 注入（只打印长度不打印值）。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run check:model-hardcoding`

**969.** 为 services/backend/src/services/aiManagementProjects.js 补一条 node:test（若已有则加一个未覆盖的边界用例）。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run test:one -- services/backend/tests/projectStore.test.js apps/ai-frontend/src/composables/useProjects.wiring.test.js`

**970.** 检查 services/backend/src/services/aiManagementProjects.js 是否够弱模型维护：变量名自解释、无魔法数、关键分支有注释。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`node --check services/backend/src/services/aiManagementProjects.js`

**971.** 确认 services/backend/src/services/aiManagementProjects.js 不含写死的真 key/token，敏感值只经 env 注入（只打印长度不打印值）。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run check:model-hardcoding`

**972.** 为 services/backend/src/services/aiManagementServer.js 补一条 node:test（若已有则加一个未覆盖的边界用例）。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run test:one -- services/backend/tests/projectStore.test.js apps/ai-frontend/src/composables/useProjects.wiring.test.js`

**973.** 检查 services/backend/src/services/aiManagementServer.js 是否够弱模型维护：变量名自解释、无魔法数、关键分支有注释。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`node --check services/backend/src/services/aiManagementServer.js`

**974.** 确认 services/backend/src/services/aiManagementServer.js 不含写死的真 key/token，敏感值只经 env 注入（只打印长度不打印值）。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run check:model-hardcoding`

**975.** 为 platform/packages/shared/src/models/Conversation.js 补一条 node:test（若已有则加一个未覆盖的边界用例）。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run test:one -- services/backend/tests/projectStore.test.js apps/ai-frontend/src/composables/useProjects.wiring.test.js`

**976.** 检查 platform/packages/shared/src/models/Conversation.js 是否够弱模型维护：变量名自解释、无魔法数、关键分支有注释。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`node --check platform/packages/shared/src/models/Conversation.js`

**977.** 确认 platform/packages/shared/src/models/Conversation.js 不含写死的真 key/token，敏感值只经 env 注入（只打印长度不打印值）。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run check:model-hardcoding`

**978.** 为 services/backend/src/services/conversationStore.js 补一条 node:test（若已有则加一个未覆盖的边界用例）。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run test:one -- services/backend/tests/projectStore.test.js apps/ai-frontend/src/composables/useProjects.wiring.test.js`

**979.** 检查 services/backend/src/services/conversationStore.js 是否够弱模型维护：变量名自解释、无魔法数、关键分支有注释。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`node --check services/backend/src/services/conversationStore.js`

**980.** 确认 services/backend/src/services/conversationStore.js 不含写死的真 key/token，敏感值只经 env 注入（只打印长度不打印值）。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run check:model-hardcoding`

**981.** 为 apps/ai-frontend/src/composables/useProjects.js 补一条 node:test（若已有则加一个未覆盖的边界用例）。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run test:one -- services/backend/tests/projectStore.test.js apps/ai-frontend/src/composables/useProjects.wiring.test.js`

**982.** 检查 apps/ai-frontend/src/composables/useProjects.js 是否够弱模型维护：变量名自解释、无魔法数、关键分支有注释。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`node --check apps/ai-frontend/src/composables/useProjects.js`

**983.** 确认 apps/ai-frontend/src/composables/useProjects.js 不含写死的真 key/token，敏感值只经 env 注入（只打印长度不打印值）。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run check:model-hardcoding`

**984.** 为 apps/ai-frontend/src/composables/useChatConversations.js 补一条 node:test（若已有则加一个未覆盖的边界用例）。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run test:one -- services/backend/tests/projectStore.test.js apps/ai-frontend/src/composables/useProjects.wiring.test.js`

**985.** 检查 apps/ai-frontend/src/composables/useChatConversations.js 是否够弱模型维护：变量名自解释、无魔法数、关键分支有注释。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`node --check apps/ai-frontend/src/composables/useChatConversations.js`

**986.** 确认 apps/ai-frontend/src/composables/useChatConversations.js 不含写死的真 key/token，敏感值只经 env 注入（只打印长度不打印值）。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run check:model-hardcoding`

**987.** 为 apps/ai-frontend/src/views/Projects.vue 补一条 node:test（若已有则加一个未覆盖的边界用例）。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run test:one -- services/backend/tests/projectStore.test.js apps/ai-frontend/src/composables/useProjects.wiring.test.js`

**988.** 检查 apps/ai-frontend/src/views/Projects.vue 是否够弱模型维护：变量名自解释、无魔法数、关键分支有注释。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run test:one -- services/backend/tests/projectStore.test.js apps/ai-frontend/src/composables/useProjects.wiring.test.js`

**989.** 确认 apps/ai-frontend/src/views/Projects.vue 不含写死的真 key/token，敏感值只经 env 注入（只打印长度不打印值）。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run check:model-hardcoding`

**990.** 为 apps/ai-frontend/src/views/AIChat.vue 补一条 node:test（若已有则加一个未覆盖的边界用例）。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run test:one -- services/backend/tests/projectStore.test.js apps/ai-frontend/src/composables/useProjects.wiring.test.js`

**991.** 检查 apps/ai-frontend/src/views/AIChat.vue 是否够弱模型维护：变量名自解释、无魔法数、关键分支有注释。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run test:one -- services/backend/tests/projectStore.test.js apps/ai-frontend/src/composables/useProjects.wiring.test.js`

**992.** 确认 apps/ai-frontend/src/views/AIChat.vue 不含写死的真 key/token，敏感值只经 env 注入（只打印长度不打印值）。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run check:model-hardcoding`

**993.** 为 apps/ai-frontend/src/composables/useRoutePrefetch.js 补一条 node:test（若已有则加一个未覆盖的边界用例）。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run test:one -- services/backend/tests/projectStore.test.js apps/ai-frontend/src/composables/useProjects.wiring.test.js`

**994.** 检查 apps/ai-frontend/src/composables/useRoutePrefetch.js 是否够弱模型维护：变量名自解释、无魔法数、关键分支有注释。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`node --check apps/ai-frontend/src/composables/useRoutePrefetch.js`

**995.** 确认 apps/ai-frontend/src/composables/useRoutePrefetch.js 不含写死的真 key/token，敏感值只经 env 注入（只打印长度不打印值）。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run check:model-hardcoding`

**996.** 为 apps/ai-frontend/src/router/index.js 补一条 node:test（若已有则加一个未覆盖的边界用例）。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run test:one -- services/backend/tests/projectStore.test.js apps/ai-frontend/src/composables/useProjects.wiring.test.js`

**997.** 检查 apps/ai-frontend/src/router/index.js 是否够弱模型维护：变量名自解释、无魔法数、关键分支有注释。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`node --check apps/ai-frontend/src/router/index.js`

**998.** 确认 apps/ai-frontend/src/router/index.js 不含写死的真 key/token，敏感值只经 env 注入（只打印长度不打印值）。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run check:model-hardcoding`

**999.** 为 apps/ai-frontend/src/views/Layout.vue 补一条 node:test（若已有则加一个未覆盖的边界用例）。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run test:one -- services/backend/tests/projectStore.test.js apps/ai-frontend/src/composables/useProjects.wiring.test.js`

**1000.** 检查 apps/ai-frontend/src/views/Layout.vue 是否够弱模型维护：变量名自解释、无魔法数、关键分支有注释。
  - 说明：子系统：Coding Projects (named workspaces + chat linkage)。
  - 验证：`npm run test:one -- services/backend/tests/projectStore.test.js apps/ai-frontend/src/composables/useProjects.wiring.test.js`

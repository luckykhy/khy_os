# Khy-OS 治理台账 (Governance Ledger)

> 跨 Block 过程登记。每完成一个 Block,在此追加一行(状态 = action + target + progress)。
> 规矩: 忠实、一行、可追溯;Block 逐个提交评审,不打包。

| date | block | action → target → progress |
| --- | --- | --- |
| 2026-08-17 | Block A | 完成 DeepSeek-Harness 式「插件按需激活」: src/services/plugins/pluginContribResolver.js 纯叶子懒加载 + executeTool 漏斗内接线(KHY_PLUGIN_LAZY_LOAD 门控默认开) + flagRegistry 注册 + 11/11 测试绿(修复 T3 顺序依赖: beforeEach 清空 on-disk extensions 树) |
| 2026-08-17 | Block B | 完成 DeepSeek-Harness 式「插件注册点」: src/services/hooks/hookContribSeams.js 纯叶子(单调收紧 tighten 借用 permissionPolicy/config STRATEGIES 真源,不另立顺序) + hookRegistry 新增 ToolPermission/PromptSection 事件 + 两处接线(requestPermission 于 policy 裁决后只收紧;aiChatCore 以 pluginPromptSection guard-tier entry 只追加) + flagRegistry 注册 KHY_HOOK_TOOL_PERMISSION / KHY_HOOK_PROMPT_SECTION(均默认开) + 16/16 测试绿(含对 STRATEGIES 全部有序对穷举证明「绝无放松路径」) |

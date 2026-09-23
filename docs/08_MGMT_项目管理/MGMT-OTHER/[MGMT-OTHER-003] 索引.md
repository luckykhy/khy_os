<!-- 文档分类: MGMT-OTHER-003 | 阶段: 项目管理 | 原路径: docs/索引.md -->
# 文档索引

KHY OS 文档总目录。按主题分类，文件名即主题，正文为简体中文。标注"（已归档）"的文档仅作历史保留，请以其顶部 banner 指向的新文档为准。

---

## 快速开始与部署
- [快速开始 — 安装与使用](../../07_OPS_运维/OPS-MAN/[OPS-MAN-027] 快速开始.md)
- [pip 安装后 — 按需配置体验](../../07_OPS_运维/OPS-MAN/[OPS-MAN-024] pip安装后-按需配置体验.md) — 按「你想要什么体验」逐场景配置，按需所取
- [pip 安装后 — 完整功能清单](../../07_OPS_运维/OPS-MAN/[OPS-MAN-023] pip安装后-完整功能清单.md) — 功能逐项参考手册
- [环境要求](../../07_OPS_运维/OPS-MAN/[OPS-MAN-028] 环境要求.md)
- [部署指南 — 域名 + SSL](../../06_DEPLOY_部署/DEPLOY-MAN/[DEPLOY-MAN-016] 部署指南-域名.md)
- [部署指南 — 无域名（仅 IP）](../../06_DEPLOY_部署/DEPLOY-MAN/[DEPLOY-MAN-017] 部署指南-无域名.md)
- [移动端远程指南](../../07_OPS_运维/OPS-MAN/[OPS-MAN-030] 移动端远程指南.md)
- [自动保护与回滚](../../07_OPS_运维/OPS-MAN/[OPS-MAN-033] 自动保护与回滚.md)
- [磁盘守卫 — 防膨胀机制](../../07_OPS_运维/OPS-MAN/[OPS-MAN-029] 磁盘守卫-防膨胀机制.md)

## 项目定位
- [项目定位](../../01_INIT_立项/INIT-PRD/[INIT-PRD-002] 项目-定位.md)
- [智能体操作系统路线图](../MGMT-PLAN/[MGMT-PLAN-006] 智能体-操作系统-路线图.md)
- [Khy-OS 远景演进路线图（2026-06-12，统领性）](../MGMT-PLAN/[MGMT-PLAN-007] Khy-OS远景演进路线图-2026-06-12.md)

## 架构
- [核心架构](../../03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-010] 核心架构.md)
- [Khyos 数学重塑 — 受约束随机最短路径](../../03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-003] Khyos-数学重塑-受约束随机最短路径.md)（第一性原理 CB-SSP；LRTA*/UCB/约束格重构）
  - 配套：[数学重塑 · 实施提示词链](../../03_DESIGN_设计/DESIGN-OTHER/[DESIGN-OTHER-001] Khyos-数学重塑-实施提示词链.md)（B→A→C→D 分阶段提示词，打开即用）
  - 落地规格：[CB-SSP 数学建模与实现映射](../../03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-002] Khyos-CB-SSP-数学建模与实现映射.md)（四阶段形式化 + 性质命题 + 测试即证明 + 代码锚点）
- [M1 微内核 + IPC + MoonBit 接口](../../03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-007] m1-微内核-ipc-moonbit.md)
- [MoonBit 系统边界](../../03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-008] moonbit-系统边界.md)
- [AI 网关适配器协议架构](../../03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-006] ai-gateway-适配器协议架构.md)
- [AgentFS — 智能体文件系统](../../03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-005] agentfs-智能体文件系统.md)
- [khy-agent-sdk — Claude 对齐与 D1–D6 治理融合](../../03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-043] khy-agent-sdk-Claude对齐与D1-D6融合规范.md)（`@khy/agent-sdk`：query/hooks/MCP/子代理 对齐 Claude + D1–D6 治理融合）
- [架构对比 — Claude Code vs KHY](../MGMT-RPT/[MGMT-RPT-019] 架构对比-cc-vs-khy.md)（§5 TUI 段已过期）

## 用户指南
- [KHY OS 用户指南](../../07_OPS_运维/OPS-MAN/[OPS-MAN-015] khy-os-用户指南.md)
- [KHY OS 用户指南（仅 CLI）](../../07_OPS_运维/OPS-MAN/[OPS-MAN-014] khy-os-用户指南-仅cli.md)
- [KHY OS 学习指南](../../07_OPS_运维/OPS-MAN/[OPS-MAN-011] khy-os-学习指南.md)
- [会话恢复（按 ID）](../../07_OPS_运维/OPS-MAN/[OPS-MAN-026] 会话恢复-按id.md)
- [Windows VMware 清单](../../07_OPS_运维/OPS-MAN/[OPS-MAN-025] windows-vmware-清单.md)

## 开发者指南
- [KHY OS 开发者指南](../../07_OPS_运维/OPS-MAN/[OPS-MAN-013] khy-os-开发者指南.md)
- [KHY OS 应用接入指南](../../07_OPS_运维/OPS-MAN/[OPS-MAN-012] khy-os-应用接入指南.md)
- [KHY OS 测试指南](../../05_TEST_测试/TEST-RPT/[TEST-RPT-002] khy-os-测试指南.md)
- [CLI 万能接入 — 集成指南](../../07_OPS_运维/OPS-MAN/[OPS-MAN-007] cli-万能接入-集成指南.md)
- [CLI 万能接入 — Abu 案例](../../07_OPS_运维/OPS-MAN/[OPS-MAN-006] cli-万能接入-abu-案例.md)
- [pip Docker 打包部署](../../06_DEPLOY_部署/DEPLOY-MAN/[DEPLOY-MAN-011] pip-docker-打包部署.md)
- [pip 安装布局参考](../../07_OPS_运维/OPS-MAN/[OPS-MAN-022] pip-安装布局参考.md)
- [Claude Code 代理配置](../../07_OPS_运维/OPS-MAN/[OPS-MAN-004] claude-code-代理配置.md)
- [Hermes 风格模型配置](../../07_OPS_运维/OPS-MAN/[OPS-MAN-010] hermes风格-模型配置.md)
- [GitHub 分支保护基线](../../07_OPS_运维/OPS-MAN/[OPS-MAN-009] github-分支保护基线.md)

## 智能体
- [KHY 智能体五步实施](../../07_OPS_运维/OPS-MAN/[OPS-MAN-017] khy-智能体-五步实施.md)
- [KHY 移动智能体协议](../../03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-001] khy-移动智能体协议.md)
- [KHY 系统提示词结构图](../../03_DESIGN_设计/DESIGN-OTHER/[DESIGN-OTHER-003] khy-系统提示词结构图.md)
- [Claude Code 规则到 KHY 映射表](../../07_OPS_运维/OPS-MAN/[OPS-MAN-005] claude-code-规则到-khy-映射表.md)
- [KHY 编程智能体风险预防（2026-05-30）](../../07_OPS_运维/OPS-MAN/[OPS-MAN-018] khy-编程智能体-风险预防-2026-05-30.md)
- [KHY 最小化大任务框架蓝图](../MGMT-PLAN/[MGMT-PLAN-003] khy-大任务框架蓝图.md)
- [KHY 远程 SSH 实施清单](../../07_OPS_运维/OPS-MAN/[OPS-MAN-019] khy-远程ssh-实施清单.md)
- [自主生产计划 R2（2026-05-24）](../MGMT-PLAN/[MGMT-PLAN-005] 自主生产计划-r2-2026-05-24.md)

## AI 网关与管理
- [AI 快速通道](../../07_OPS_运维/OPS-MAN/[OPS-MAN-001] ai-快速通道.md)
- [AI 管理 — 访问与登录](../../07_OPS_运维/OPS-MAN/[OPS-MAN-003] ai-管理-访问与登录.md)
- [AI 管理 — 新 API 对齐](../../07_OPS_运维/OPS-MAN/[OPS-MAN-002] ai-管理-新api对齐.md)
- [AI 显示 — 对标与对齐](../MGMT-RPT/[MGMT-RPT-012] ai-显示-对标与对齐.md)

## 设计模式
- [编码规范](../../03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-015] 编码规范.md)
- [模式图谱](../../03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-014] 模式图谱.md)
- [工具延迟加载](../../03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-012] 工具延迟加载.md)
- [弱模型兼容](../../03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-013] 弱模型兼容.md)

## 竞品对标与差距修复
- [KHY 对比 Qwen Code 差距分析](../MGMT-RPT/[MGMT-RPT-005] khy-对比-qwen-code-差距分析.md)
- [KHY 对比 Hermes 成长架构](../MGMT-RPT/[MGMT-RPT-003] khy-对比-hermes-成长架构.md)
- [KHY 对比 OpenAgent 交付差距](../MGMT-RPT/[MGMT-RPT-004] khy-对比-openagent-交付差距.md)
- [KHY 对比 DesireCore 借鉴分析](../MGMT-RPT/[MGMT-RPT-002] khy-对比-desirecore-借鉴分析.md)
- [DeepSeek TUI 对标](../MGMT-RPT/[MGMT-RPT-001] deepseek-tui-对标.md)
- [KHY Qwen 差距修复清单](../MGMT-RPT/[MGMT-RPT-014] khy-qwen-差距修复清单.md)
- [KHY LibreChat 差距修复路线图](../MGMT-PLAN/[MGMT-PLAN-002] khy-librechat-差距修复路线图.md)
- [CC 对标第六轮（2026-05-26）](../MGMT-RPT/[MGMT-RPT-013] cc-对标-第六轮-2026-05-26.md)
- [KHY UX 交互对标](../MGMT-RPT/[MGMT-RPT-015] khy-ux-交互对标.md)
- [KHY UX 交付深度学习指南](../../07_OPS_运维/OPS-MAN/[OPS-MAN-016] khy-ux-交付-深度学习指南.md)
- [竞品情报图谱](../MGMT-RPT/[MGMT-RPT-016] 竞品情报图谱.md)
- [OpenAgent 对齐日志](../../07_OPS_运维/OPS-MAN/[OPS-MAN-020] openagent-对齐日志.md)
- [OpenCode 任务编排经验](../../07_OPS_运维/OPS-MAN/[OPS-MAN-021] opencode-任务编排经验.md)
- [DeepSeek TUI 资源清理对齐](../../07_OPS_运维/OPS-MAN/[OPS-MAN-008] deepseek-tui-资源清理对齐.md)
- [三项目改进计划（2026-05-24）](../MGMT-PLAN/[MGMT-PLAN-004] 三项目改进计划-2026-05-24.md)

## 修复记录
- [修复记录时间线](../../04_IMPL_实现/IMPL-RPT/[IMPL-RPT-015] 修复记录时间线.md)
- [TUI inquirer 闪退修复（2026-06-05）](../../04_IMPL_实现/IMPL-RPT/[IMPL-RPT-003] tui-inquirer闪退修复-2026-06-05.md)
- [特性访问与代理解耦（2026-06-01）](../../04_IMPL_实现/IMPL-RPT/[IMPL-RPT-009] 特性访问与代理解耦-2026-06-01.md)
- [网关传输韧性修复（2026-05-29）](../../04_IMPL_实现/IMPL-RPT/[IMPL-RPT-020] 网关传输韧性修复-2026-05-29.md)
- [网关超时与帧修复](../../04_IMPL_实现/IMPL-RPT/[IMPL-RPT-021] 网关超时与帧修复.md)
- [守护进程端口发现修复](../../04_IMPL_实现/IMPL-RPT/[IMPL-RPT-017] 守护进程端口发现修复.md)
- [剪贴板粘贴修复](../../04_IMPL_实现/IMPL-RPT/[IMPL-RPT-016] 剪贴板粘贴修复.md)
- [KHY Claude 认证冲突修复（2026-05-27）](../../04_IMPL_实现/IMPL-RPT/[IMPL-RPT-013] khy-claude-认证冲突修复.md)
- [Trae 适配器官方扫描修复（2026-05-25）](../../04_IMPL_实现/IMPL-RPT/[IMPL-RPT-014] trae-适配器-官方扫描修复-2026-05-25.md)
- [管理前端自动可用修复（2026-05-31）](../../04_IMPL_实现/IMPL-RPT/[IMPL-RPT-018] 管理前端自动可用修复-2026-05-31.md)
- [终端提示符泄漏与交付空行修复（2026-05-31）](../../04_IMPL_实现/IMPL-RPT/[IMPL-RPT-019] 终端提示符泄漏与交付空行修复-2026-05-31.md)（部分过期）
- [终端崩溃事后分析（2026-05-09）]([MGMT-OTHER-002] 事后分析-终端崩溃-2026-05-09.md)
- [TUI 叙事模式 + 交互选择覆盖层（2026-06-01）](../../04_IMPL_实现/IMPL-RPT/[IMPL-RPT-004] tui-叙事与选择覆盖层-2026-06-01.md)（已归档）
- [TUI 流式显示与上下文窗口修复（2026-06-01）](../../04_IMPL_实现/IMPL-RPT/[IMPL-RPT-006] tui-流式与上下文显示-2026-06-01.md)（已归档）
- [v0.1.84 缺陷修复（2026-06-02）](../../04_IMPL_实现/IMPL-RPT/[IMPL-RPT-007] v0.1.84-修复说明.md)（已归档）
- [中转桥接状态刷屏修复（2026-06-03）](../../04_IMPL_实现/IMPL-RPT/[IMPL-RPT-008] 修复-桥接状态刷屏.md)（已归档）
- [终端 TUI 有框输入区重构方案（2026-05-31）](../../07_OPS_运维/OPS-MAN/[OPS-MAN-031] 终端-tui-有框输入区重构方案-2026-05-31.md)（已归档）

## 特性访问（提示词胶囊）
- [特性访问 — 提示词胶囊（2026-06-01）](../../03_DESIGN_设计/DESIGN-OTHER/[DESIGN-OTHER-004] 特性访问-提示词胶囊-2026-06-01.md)
- [特性访问 — 维护速查（2026-06-01）](../../07_OPS_运维/OPS-MAN/[OPS-MAN-035] 特性访问-维护速查-2026-06-01.md)

## 发布
- [源码还原与手工发布](../../06_DEPLOY_部署/DEPLOY-MAN/[DEPLOY-MAN-015] 源码还原与手工发布.md) — pip/npm 双渠道手工发布 + 从发行物还原工作坊源码
- [pip 发布后 → 还原源码 → 推送 GitHub](../../06_DEPLOY_部署/DEPLOY-MAN/[DEPLOY-MAN-012] pip发布后-github发布手册.md) — 内网只能 pip 发、外网只能 pip 装时，以 PyPI 为桥还原真实源码并推 GitHub
- [发布说明 0.1.27](../../06_DEPLOY_部署/DEPLOY-MAN/[DEPLOY-MAN-014] 发布说明-0.1.27.md)
- [PyPI 发布手册 0.1.17–0.1.18](../../06_DEPLOY_部署/DEPLOY-MAN/[DEPLOY-MAN-013] pypi-发布手册-0.1.17-0.1.18.md)（已归档）

## 报告
- [AB 交付质量对齐（2026-06-03）](../MGMT-RPT/[MGMT-RPT-006] AB-交付质量对齐-2026-06-03.md)
- [CLI 基准对比（2026-05-19）](../MGMT-RPT/[MGMT-RPT-007] cli-基准对比-2026-05-19.md)
- [Hermes 成长架构学习清单（2026-05-17）](../MGMT-RPT/[MGMT-RPT-009] hermes-成长架构-学习清单-2026-05-17.md)
- [Hermes × KHY P0 执行任务（2026-05-17）](../MGMT-RPT/[MGMT-RPT-008] hermes-khy-p0-执行任务-2026-05-17.md)
- [KHY OS 体验改进计划（2026-05-26）](../MGMT-PLAN/[MGMT-PLAN-001] khy-os-体验改进计划-2026-05-26.md)
- [pip 打包对等 — 发现（2026-05-17）](../../06_DEPLOY_部署/DEPLOY-MAN/[DEPLOY-MAN-010] pip-打包对等-发现-2026-05-17.md)
- [pip 打包对等 — 发布说明（2026-05-17）](../../06_DEPLOY_部署/DEPLOY-MAN/[DEPLOY-MAN-009] pip-打包对等-发布说明-2026-05-17.md)
- [三项目深度学习（2026-05-21）](../MGMT-RPT/[MGMT-RPT-011] 三项目深度学习-2026-05-21.md)
- [Windows 工具调用循环冻结（2026-05-28）](../MGMT-RPT/[MGMT-RPT-010] windows-工具调用循环冻结-2026-05-28.md)
- [验收不合规（2026-05-16）](../../05_TEST_测试/TEST-RPT/[TEST-RPT-001] 验收不合规-2026-05-16.md)

## Windows 回归
- [Windows UI 聊天回归清单](../../05_TEST_测试/TEST-RPT/[TEST-RPT-005] windows-ui-聊天回归清单.md)
- [Windows UI 聊天回归报告示例（2026-05-20）](../../05_TEST_测试/TEST-RPT/[TEST-RPT-004] windows-ui-聊天回归报告示例-2026-05-20.md)
- [Windows UI 聊天回归报告模板](../../05_TEST_测试/TEST-RPT/[TEST-RPT-003] windows-ui-聊天回归报告模板.md)

## 项目矛盾审计
- [项目矛盾审计（2026-05-21）](../MGMT-RPT/[MGMT-RPT-018] 项目矛盾审计-2026-05-21.md)
- [项目矛盾审计 R2（2026-05-21）](../MGMT-RPT/[MGMT-RPT-017] 项目矛盾审计-2026-05-21-r2.md)

## 验证
- [KHY OS 交付验证（2026-05-09）](../../05_TEST_测试/TEST-RPT/[TEST-RPT-006] khy-os-交付验证-2026-05-09.md)

## 维护者
- [维护映射表（机器消费数据，JSON）](../../14_维护者/registry/维护映射表.json)

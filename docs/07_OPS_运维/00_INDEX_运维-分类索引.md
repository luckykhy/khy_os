# 00_INDEX 运维分类索引

> **索引总领文件** · 本目录唯一入口 · 排序首位 · 结构遵循 [MGMT-STD-001] 第三章

## 一、分类内容边界

本目录（`docs/07_OPS_运维/`）收容**运维与使用手册**类文档：用户/开发者/接入指南、配置与对齐手册、运维清单与速查（MAN）。**不收**发布部署手册（归 `06_DEPLOY_部署/`）、架构设计（归 `03_DESIGN_设计/`）。

## 📦 pip 安装上手（新手起点）

通过 `pip install khy-os` 安装后，按下面的顺序读最省心：

| 顺序 | 文档 | 什么时候读 |
| --- | --- | --- |
| 1 | [OPS-MAN-027] 快速开始 | 第一次装完，想最快跑起来（三平台逐步上手） |
| 2 | [OPS-MAN-043] 从 0 到高手 | 想按成长阶梯一步步进阶（⭐ 推荐入口） |
| 3 | [OPS-MAN-023] 完整功能清单 | 想知道装完到底能干什么 |
| 4 | [OPS-MAN-024] 按需配置体验 | 按你的场景只配需要的那部分 |
| 5 | [OPS-MAN-037] 完整还原与全功能开启 | 还原源码树 / 构建自研内核 ISO |
| ❓ | [OPS-MAN-028] 环境要求 | 装不上 / 想先确认软硬件门槛时查 |

## 二、文件清单

| 文件名(含编号) | 核心职责(10字内) | 状态 |
| --- | --- | --- |
| [OPS-MAN-001] ai-快速通道.md | AI快速通道 | 定稿 |
| [OPS-MAN-002] ai-管理-新api对齐.md | 新API对齐 | 定稿 |
| [OPS-MAN-003] ai-管理-访问与登录.md | 访问与登录 | 定稿 |
| [OPS-MAN-004] claude-code-代理配置.md | Claude代理配置 | 定稿 |
| [OPS-MAN-005] claude-code-规则到-khy-映射表.md | 规则到KHY映射 | 定稿 |
| [OPS-MAN-006] cli-万能接入-abu-案例.md | 万能接入Abu案例 | 定稿 |
| [OPS-MAN-007] cli-万能接入-集成指南.md | 万能接入集成 | 定稿 |
| [OPS-MAN-008] deepseek-tui-资源清理对齐.md | 资源清理对齐 | 定稿 |
| [OPS-MAN-009] github-分支保护基线.md | 分支保护基线 | 定稿 |
| [OPS-MAN-010] hermes风格-模型配置.md | Hermes模型配置 | 定稿 |
| [OPS-MAN-011] khy-os-学习指南.md | 学习指南 | 定稿 |
| [OPS-MAN-012] khy-os-应用接入指南.md | 应用接入指南 | 定稿 |
| [OPS-MAN-013] khy-os-开发者指南.md | 开发者指南 | 定稿 |
| [OPS-MAN-014] khy-os-用户指南-仅cli.md | CLI用户指南 | 定稿 |
| [OPS-MAN-015] khy-os-用户指南.md | 用户指南 | 定稿 |
| [OPS-MAN-016] khy-ux-交付-深度学习指南.md | UX深度学习指南 | 定稿 |
| [OPS-MAN-017] khy-智能体-五步实施.md | 智能体五步实施 | 定稿 |
| [OPS-MAN-018] khy-编程智能体-风险预防-2026-05-30.md | 编程智能体风险预防 | 定稿 |
| [OPS-MAN-019] khy-远程ssh-实施清单.md | 远程SSH清单 | 设计/未交付 |
| [OPS-MAN-020] openagent-对齐日志.md | OpenAgent对齐 | 定稿 |
| [OPS-MAN-021] opencode-任务编排经验.md | 任务编排经验 | 定稿 |
| [OPS-MAN-022] pip-安装布局参考.md | pip安装布局 | 定稿 |
| [OPS-MAN-023] pip安装后-完整功能清单.md | 完整功能清单 | 定稿 |
| [OPS-MAN-024] pip安装后-按需配置体验.md | 按需配置体验 | 定稿 |
| [OPS-MAN-025] windows-vmware-清单.md | VMware清单 | 定稿 |
| [OPS-MAN-026] 会话恢复-按id.md | 会话恢复 | 定稿 |
| [OPS-MAN-027] 快速开始.md | 快速开始 | 定稿 |
| [OPS-MAN-028] 环境要求.md | 环境要求 | 定稿 |
| [OPS-MAN-029] 磁盘守卫-防膨胀机制.md | 磁盘防膨胀 | 定稿 |
| [OPS-MAN-030] 移动端远程指南.md | 移动端远程 | 定稿 |
| [OPS-MAN-031] 终端-tui-有框输入区重构方案-2026-05-31.md | TUI有框输入重构 | 定稿 |
| [OPS-MAN-032] 网关-自定义provider配置-agnes.md | 自定义provider配置 | 定稿 |
| [OPS-MAN-033] 自动保护与回滚.md | 自动保护回滚 | 定稿 |
| [OPS-MAN-034] TODO.md | 运维待办 | 草稿 |
| [OPS-MAN-035] 特性访问-维护速查-2026-06-01.md | 特性访问速查 | 定稿 |
| [OPS-MAN-036] khyos跨平台构建-Windows支持方案.md | 跨平台Win构建 | 定稿 |
| [OPS-MAN-037] pip安装后-完整还原与全功能开启指南.md | 完整还原全功能 | 定稿 |
| [OPS-MAN-038] AI元数据-.ai-种子文档-用法指南-2026-06-15.md | .ai种子文档用法 | 定稿 |
| [OPS-MAN-039] 文档排版-用法指南-2026-06-12.md | 文档排版用法 | 定稿 |
| [OPS-MAN-040] Git入门-main-HEAD-分支-工作树-结合本仓库.md | Git入门 | 定稿 |
| [OPS-MAN-041] 通过KHY学习模式-从0到1面试大厂Agent岗-路线图-2026-06-15.md | 学习模式面试路线图 | 定稿 |
| [OPS-MAN-042] 发布手册-pip与npm-无AI照做.md | 无AI照做发布pip/npm | 定稿 |
| [OPS-MAN-043] 从0到高手-新手成长路线与pip安装后清单.md | 新手→高手成长路线 | 定稿 |
| [OPS-MAN-044] 从使用入门到开发精通-开发者成长路线.md | 使用→开发成长路线 | 定稿 |
| [OPS-MAN-045] 账号池与多租户-深度指南.md | 账号池与多租户 | 定稿 |
| [OPS-MAN-046] 旗舰特性目录-vault-notify-mesh-insights-forge-image2web.md | 旗舰特性目录 | 定稿 |
| [OPS-MAN-047] 代理服务器深度指南-khy-proxy.md | 代理服务器深度指南 | 定稿 |
| [OPS-MAN-048] 本地模型微调-khy-train.md | 本地模型微调 | 定稿 |
| [OPS-MAN-049] 算力与加速器自检-khy-compute.md | 算力与加速器自检 | 定稿 |
| [OPS-MAN-050] 成长档案迁移-khy-growth.md | 成长档案迁移 | 定稿 |
| [OPS-MAN-051] 知识库与教学自我认知-khy-knowledge.md | 知识库与自我认知 | 定稿 |
| [OPS-MAN-052] 安全守护-khy-security.md | 安全守护 | 定稿 |
| [OPS-MAN-053] 监控与自检-khy-monitor.md | 监控与自检 | 定稿 |
| [OPS-MAN-054] 变更裁决-khy-verdict.md | 变更裁决 | 定稿 |
| [OPS-MAN-055] 可变性分级与变更治理-khy-evolve.md | 可变性分级治理 | 定稿 |
| [OPS-MAN-056] 按需依赖自愈-khy-deps.md | 按需依赖自愈 | 定稿 |
| [OPS-MAN-057] 工作流引擎-khy-workflow.md | 工作流引擎 | 定稿 |
| [OPS-MAN-058] 环境开关与文档命名规范.md | 环境开关与命名规范 | 定稿 |
| [OPS-MAN-059] 文档-PDF与HTML生成与查看.md | 文档PDF/HTML生成 | 定稿 |
| [OPS-MAN-060] 高危操作为何被拒与如何放行.md | 高危被拒与放行 | 定稿 |
| [OPS-MAN-061] 发布门禁.md | 发布门禁 | 定稿 |
| [OPS-MAN-062] 键盘快捷键参考与跨平台对齐.md | 快捷键跨平台参考 | 定稿 |
| [OPS-MAN-063] cc订阅迁移到新电脑-khy-claude-adopt-env.md | CC订阅跨机迁移 | 定稿 |
| [OPS-MAN-064] 打造最佳环境-如何扩展.md | 环境优化扩展手册 | 定稿 |
| [OPS-MAN-066] khyos进化提示词手册-1000条.md | 进化提示词1000条 | 定稿 |
| [OPS-MAN-067] 症状分诊速查表.md | 症状→子系统分诊速查 | 定稿 |
| [OPS-MAN-068] 离机还原自检清单.md | 离机还原就绪自检 | 定稿 |
| [OPS-MAN-069] 已装副本完整性自检清单.md | 已装 bundle 运行时关键文件完整性自检 | 定稿 |
| [OPS-MAN-070] 首启依赖hydration自检清单.md | 首启联网 hydrate 依赖健康自检(含裂脑检测) | 定稿 |
| [OPS-MAN-165] khy 个性化调优与使用建议.md | khy 个性化调优与使用建议 | 定稿 |
| [OPS-MAN-166] cc(Claude Code)个性化使用说明书·重逢版.md | cc 个性化使用说明书·重逢版 | 定稿 |
| [OPS-MAN-168] 弱模型护栏与维护子系统登记.md | 弱模型护栏与维护子系统登记（单人可维护补登记） | 定稿 |
| [OPS-MAN-169] 项目规则总纲-命名·skill·权限·mcp.md | 命名/skill/权限/mcp 规则总纲一站式索引 | 定稿 |

## 三、跨分类关联指引

- 文档总入口：`docs/00_INDEX_文档索引.md`。
- 部署发布前置：`docs/06_DEPLOY_部署/`；故障复盘：`docs/08_MGMT_项目管理/`。

# 00_INDEX 部署分类索引

> **索引总领文件** · 本目录唯一入口 · 排序首位 · 结构遵循 [MGMT-STD-001] 第三章

## 一、分类内容边界

本目录（`docs/06_DEPLOY_部署/`）收容**发布与部署**类文档：打包发布手册、发布说明、部署指南、对外发帖素材（MAN）。**不收**运维日常指南（归 `07_OPS_运维/`）、实现报告（归 `04_IMPL_实现/`）。

## 二、文件清单

| 文件名(含编号) | 核心职责(10字内) | 状态 |
| --- | --- | --- |
| [DEPLOY-MAN-001] DEMO.md | 演示素材 | 定稿 |
| [DEPLOY-MAN-002] PRODUCT_HUNT.md | ProductHunt素材 | 定稿 |
| [DEPLOY-MAN-003] PUBLISHING.md | 发布流程 | 定稿 |
| [DEPLOY-MAN-004] README.md | 发布包说明 | 定稿 |
| [DEPLOY-MAN-005] REDDIT.md | Reddit发帖素材 | 定稿 |
| [DEPLOY-MAN-006] REPO_META.md | 仓库元信息 | 定稿 |
| [DEPLOY-MAN-007] SHOW_HN.md | HackerNews素材 | 定稿 |
| [DEPLOY-MAN-008] TWITTER.md | Twitter发帖素材 | 定稿 |
| [DEPLOY-MAN-009] pip-打包对等-发布说明-2026-05-17.md | pip打包发布说明 | 定稿 |
| [DEPLOY-MAN-010] pip-打包对等-发现-2026-05-17.md | pip打包发现 | 定稿 |
| [DEPLOY-MAN-011] pip-docker-打包部署.md | pip-docker部署 | 定稿 |
| [DEPLOY-MAN-012] pip发布后-github发布手册.md | GitHub发布手册 | 定稿 |
| [DEPLOY-MAN-013] pypi-发布手册-0.1.17-0.1.18.md | PyPI发布手册 | 定稿 |
| [DEPLOY-MAN-014] 发布说明-0.1.27.md | 0.1.27发布说明 | 定稿 |
| [DEPLOY-MAN-015] 源码还原与手工发布.md | 源码还原发布 | 定稿 |
| [DEPLOY-MAN-016] 部署指南-域名.md | 有域名部署 | 定稿 |
| [DEPLOY-MAN-017] 部署指南-无域名.md | 无域名部署 | 定稿 |
| [DEPLOY-MAN-018] khyos-Android构建避坑指南.md | Android构建避坑 | 定稿 |
| [DEPLOY-MAN-019] 模型可用性与适配器探测.md | 适配器探测与可用性 | 定稿 |
| [DEPLOY-MAN-020] AI供应商与APIKey配置.md | 供应商与Key配置 | 定稿 |
| [DEPLOY-MAN-021] IDE桥接模式.md | 复用IDE凭据桥接 | 定稿 |
| PORTABLE.md | 便携化打包与启动 | 定稿·未编号 |
| LAN-FIREWALL.md | 局域网登录防火墙放行（ARCH-074 配套） | 定稿·未编号 |

> `PORTABLE.md` 沿用历史无编号文件名（`README.md` 与多处脚本按此路径引用）。
> 补编号需同步改写全部入站引用，属独立一轮工作；此处如实登记，不假装已合规。

`[DEPLOY-MAN-019/020/021]` 由根目录 `COMPLETE_DEPLOYMENT_GUIDE.md` /
`AI_MODEL_SETUP_GUIDE.md` / `IDE_BRIDGE_GUIDE.md` 重写而成（归档日期 2026-08-15）。
三份原文均把「适配器 enabled」与「模型 available」混为一谈，并给出多个仓库里
**不存在**的环境变量名；重写版按 `services/backend/src/services/gateway/` 源码实测更正，
先读 `[DEPLOY-MAN-019]` 再读另两篇。

## 三、跨分类关联指引

- 文档总入口：`docs/00_INDEX_文档索引.md`。
- 部署后运维：`docs/07_OPS_运维/`；交付验证：`docs/05_TEST_测试/`。

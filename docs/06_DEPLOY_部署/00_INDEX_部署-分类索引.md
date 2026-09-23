# 00_INDEX 部署分类索引

> **索引总领文件** · 本目录唯一入口 · 排序首位 · 结构遵循 [MGMT-STD-001] 第三章

## 一、分类内容边界

本目录（`docs/06_DEPLOY_部署/`）收容**发布与部署**类文档：打包发布手册、发布说明、部署指南、对外发帖素材（MAN）。**不收**运维日常指南（归 `07_OPS_运维/`）、实现报告（归 `04_IMPL_实现/`）。

## 二、文件清单

| 文件名(含编号) | 核心职责(10字内) | 状态 |
| --- | --- | --- |
|[DEPLOY-MAN-001] DEMO.md|演示素材|在产|
|[DEPLOY-MAN-002] PRODUCT_HUNT.md|ProductHunt素材|在产|
|[DEPLOY-MAN-003] PUBLISHING.md|发布流程|在产|
|[DEPLOY-MAN-004] README.md|发布包说明|在产|
|[DEPLOY-MAN-005] REDDIT.md|Reddit发帖素材|在产|
|[DEPLOY-MAN-006] REPO_META.md|仓库元信息|在产|
|[DEPLOY-MAN-007] SHOW_HN.md|HackerNews素材|在产|
|[DEPLOY-MAN-008] TWITTER.md|Twitter发帖素材|在产|
|[DEPLOY-MAN-009] pip-打包对等-发布说明-2026-05-17.md|pip打包发布说明|在产|
|[DEPLOY-MAN-010] pip-打包对等-发现-2026-05-17.md|pip打包发现|在产|
|[DEPLOY-MAN-011] pip-docker-打包部署.md|pip-docker部署|在产|
|[DEPLOY-MAN-012] pip发布后-github发布手册.md|GitHub发布手册|在产|
|[DEPLOY-MAN-013] pypi-发布手册-0.1.17-0.1.18.md|PyPI发布手册|在产|
|[DEPLOY-MAN-014] 发布说明-0.1.27.md|0.1.27发布说明|在产|
|[DEPLOY-MAN-015] 源码还原与手工发布.md|源码还原发布|在产|
|[DEPLOY-MAN-016] 部署指南-域名.md|有域名部署|在产|
|[DEPLOY-MAN-017] 部署指南-无域名.md|无域名部署|在产|
|[DEPLOY-MAN-018] khyos-Android构建避坑指南.md|Android构建避坑|在产|
|[DEPLOY-MAN-019] 模型可用性与适配器探测.md|适配器探测与可用性|在产|
|[DEPLOY-MAN-020] AI供应商与APIKey配置.md|供应商与Key配置|在产|
|[DEPLOY-MAN-021] IDE桥接模式.md|复用IDE凭据桥接|在产|
|PORTABLE.md|便携化打包与启动|在产|
|LAN-FIREWALL.md|局域网登录防火墙放行（ARCH-074 配套）|在产|

> `PORTABLE.md` 沿用历史无编号文件名（`README.md` 与多处脚本按此路径引用）。
> 补编号需同步改写全部入站引用，属独立一轮工作；此处如实登记，不假装已合规。

> 📌 **2026-09-18 裁决（B6）**：`[DEPLOY-MAN-016]` 与 `[DEPLOY-MAN-017]` **保留两篇、不合并**。
> `[MGMT-PLAN-009]` §1.2 原判「结构完全同构、只有 CORS/证书段落差 7 行」，实测不成立——
> 行级重合 **23.5%**、章节骨架重合仅 **6.4%**、差异约 **700 行**：
> 016 是「有域名 · 一键 `khy deploy` + Let's Encrypt SSL + nginx 域名站点」，
> 017 是「无域名 · 纯手动 IP-only + `server_name _` 站点」，是**两条不同的部署路径**而非一份文档的两种措辞。
> 已改为在两篇首部互加「姊妹篇边界」块做分流，不删减任何内容。

`[DEPLOY-MAN-019/020/021]` 由根目录 `COMPLETE_DEPLOYMENT_GUIDE.md` /
`AI_MODEL_SETUP_GUIDE.md` / `IDE_BRIDGE_GUIDE.md` 重写而成（归档日期 2026-08-15）。
三份原文均把「适配器 enabled」与「模型 available」混为一谈，并给出多个仓库里
**不存在**的环境变量名；重写版按 `services/backend/src/services/gateway/` 源码实测更正，
先读 `[DEPLOY-MAN-019]` 再读另两篇。

## 三、跨分类关联指引

## 2026-09-15 整理补登

|文件名|核心职责|在产|状态|
| --- | --- | --- | --- |
|[DEPLOY-0102] CPA+NewAPI分层架构快速指南.md|CPA/NewAPI 分层架构指引|在产|在产|
|[DEPLOY-0103] CPA集成快速指南.md|CPA 集成快速上手（provider-hub 集成版）|在产|在产|

两篇原为 `docs/06A_GUIDE_指南/[GUIDE-001]/[GUIDE-002]`。`06A_GUIDE_指南` 目录已删除：`06A` 字母后缀与 `06_DEPLOY` 序号冲突，且绕过了 `check:layout` 的 `STAGE_DIR_RE = /^\d{2}_/` 扫描范围；`[GUIDE-003] Git规范快速参考` 因与 `10_规范/[DESIGN-GIT-002]` 及 `DESIGN-GIT-003` 内容重复已删除。

---

- 文档总入口：`docs/00_INDEX_文档索引.md`。
- 部署后运维：`docs/07_OPS_运维/`；交付验证：`docs/05_TEST_测试/`。

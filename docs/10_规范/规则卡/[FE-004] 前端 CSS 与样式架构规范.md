---
name: 前端 CSS 与样式架构规范
id: FE-004
domain: TOOLING
nature: 约束
scope: "apps/ai-frontend/src/**, software/khyquant/frontend/src/**, platform/packages/ui-shared/**"
priority: P2
trigger: "新增或修改样式文件、CSS 变量、组件样式时"
constraint: "五原则：令牌优先（颜色/圆角/阴影全部走 var(--khy-*)，禁止硬编码值）、分层组织（Base → Tokens → Layout → Components → Utilities → Overrides）、就近原则（组件样式 scoped，全局样式仅放布局/令牌/动画）、无 !important（通过特异性顺序管理优先级）、移动优先（默认移动端样式，min-width 渐进增强）。令牌命名 --khy-{category}-{variant}，分类：--khy-bg-*、--khy-text-*、--khy-border-*、--khy-primary-*、--khy-{status}（success/warning/danger）、--khy-radius-*、--khy-shadow-*、--khy-font-*。双主题强制：任何颜色/阴影 token 必须同时定义浅色（:root）与深色（html.dark），仅定义浅色会在暗色下静默失效。BEM：.block__element--modifier，.is-state 状态类、.has-child 子元素指示。流式值优先 clamp() 而非媒体查询（padding: clamp(12px, 2vw, 32px)）。必须支持 prefers-reduced-motion: reduce 下关闭动画。硬编码 hex 收敛用 npm run frontend:fix-colors 扫描后替换为 var(--khy-*)。"
grants: "无新增权力：仅约束具体做法，不授予任何新权限。"
benefit: 暗色模式不会静默失效，颜色/阴影收敛到统一令牌后可批量替换，响应式用流式值减少断点维护。
exception: 无
version: "1.0.0 (2026-09-16)"
status: active
ssot: "docs/10_规范/DESIGN-FE/[DESIGN-FE-004] 前端 CSS 与样式架构规范.md"
formerly: 无
owner: frontend-team
---

# [FE-004] 前端 CSS 与样式架构规范

<!-- RULES-REGISTRY: FE-004 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/10_规范/registry/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/10_规范/DESIGN-FE/[DESIGN-FE-004] 前端 CSS 与样式架构规范.md。

## 约束

五原则：令牌优先（颜色/圆角/阴影全部走 var(--khy-*)，禁止硬编码值）、分层组织（Base → Tokens → Layout → Components → Utilities → Overrides）、就近原则（组件样式 scoped，全局样式仅放布局/令牌/动画）、无 !important（通过特异性顺序管理优先级）、移动优先（默认移动端样式，min-width 渐进增强）。令牌命名 --khy-{category}-{variant}，分类：--khy-bg-*、--khy-text-*、--khy-border-*、--khy-primary-*、--khy-{status}（success/warning/danger）、--khy-radius-*、--khy-shadow-*、--khy-font-*。双主题强制：任何颜色/阴影 token 必须同时定义浅色（:root）与深色（html.dark），仅定义浅色会在暗色下静默失效。BEM：.block__element--modifier，.is-state 状态类、.has-child 子元素指示。流式值优先 clamp() 而非媒体查询（padding: clamp(12px, 2vw, 32px)）。必须支持 prefers-reduced-motion: reduce 下关闭动画。硬编码 hex 收敛用 npm run frontend:fix-colors 扫描后替换为 var(--khy-*)。

## 授予权力

无新增权力：仅约束具体做法，不授予任何新权限。

## 提供福利

暗色模式不会静默失效，颜色/阴影收敛到统一令牌后可批量替换，响应式用流式值减少断点维护。

## 反例

见 `ssot` 指向的真源原文；本卡不复制反例，以免与真源漂移。

## 校验方式

人工评审（该规则暂无机械守卫）

## 例外

无

## 版本记录

- 1.0.0 (2026-09-16) 初版 / 迁移自 无

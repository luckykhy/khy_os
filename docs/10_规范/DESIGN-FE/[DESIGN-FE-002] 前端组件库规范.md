# [DESIGN-FE-002] 前端组件库规范

> **定位**：前端组件库规范的**唯一入口与 scope 裁决真源**。
> **结论**：① 组件库的目录/命名/分类看 §1；② 开发、API、测试、文档发布、质保五类细则各拆子篇（下表）；③ 本族整体是**目标态**——组件库落地前一切以 `[DESIGN-FE-001]` 为准。
>
> ⚠️ **状态标注（2026-09-09）——目标态，非现状**：本文描述的 `KhyButton`/`KhyInput`/`KhyCard` 等独立组件库在当前代码中**不存在**。实测现状（[DESIGN-FE-001] §5）：基座是 Element Plus（不重新封装），共享组件仅 `KhyPageHeader`/`KhyEmpty`/`KhyIcon`/`LoadErrorBanner`/`GlobalProgressBar`/`KhyFloatBall` 六个，跨前端共享逻辑走 `@khy/ui-shared`（纯 JS 原语，无 UI 组件）。**在组件库真正落地前，一切以 [DESIGN-FE-001] 为准**；本文仅在那时才转为生效规范。
>
> **拆分说明（2026-09-18，B7）**：原文 1,490 行，按 `[DESIGN-DOC-001]` §12 （规范骨架 ≤150 行，超出的细则拆子篇）拆为主篇 + 7 个子篇。原文已按 HK-3 复制留痕至 `.khyos/housekeeping/2026-09-17-doc-plan/10_规范/`，未删除。

---

## 0. 子篇索引（细则入口）

| 子篇 | 覆盖 | 行数 |
| --- | --- | ---: |
| [`[DESIGN-FE-005]` 组件开发规范]([DESIGN-FE-005] 组件开发规范.md) | 组件结构 / Props / Events / Slots / 样式五节的写法约束 | 245 |
| [`[DESIGN-FE-006]` 组件 API 设计 · 基础组件]([DESIGN-FE-006] 组件API设计-基础组件.md) | 基础组件（Button/Input/Card/Modal 等）的 API 目标态 | 229 |
| [`[DESIGN-FE-007]` 组件 API 设计 · 反馈组件]([DESIGN-FE-007] 组件API设计-反馈组件.md) | 反馈组件（Toast/Alert/Skeleton/Empty 等）的 API 目标态 | 237 |
| [`[DESIGN-FE-008]` 组件 API 设计 · 数据组件]([DESIGN-FE-008] 组件API设计-数据组件.md) | 数据组件（Table/List/Tree/Chart 等）的 API 目标态 | 156 |
| [`[DESIGN-FE-009]` 组件测试规范]([DESIGN-FE-009] 组件测试规范.md) | 单元测试 / 集成测试 / 视觉回归测试三层要求 | 256 |
| [`[DESIGN-FE-010]` 组件文档与发布规范]([DESIGN-FE-010] 组件文档与发布规范.md) | 组件文档结构与示例、版本管理、发布流程、CHANGELOG 规范 | 189 |
| [`[DESIGN-FE-011]` 组件质量保证规范]([DESIGN-FE-011] 组件质量保证规范.md) | 代码质量、测试覆盖率、性能监控三道质量门 | 96 |

---

## 1. 组件库概述

### 1.1 组件库架构

```
┌─────────────────────────────────────────────────────────────┐
│                    khy-os 组件库架构                          │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────┐   │
│  │              基础组件 (Base Components)              │   │
│  │  • Button  • Input  • Card  • Modal  • Table        │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              业务组件 (Business Components)          │   │
│  │  • UserCard  • OrderList  • PaymentForm             │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              布局组件 (Layout Components)            │   │
│  │  • PageHeader  • Sidebar  • Footer                  │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              反馈组件 (Feedback Components)          │   │
│  │  • Toast  • Alert  • Skeleton  • Empty              │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### 1.2 组件分类

| 分类 | 说明 | 示例 |
|------|------|------|
| **基础组件** | 通用 UI 原子组件 | Button, Input, Card, Modal |
| **业务组件** | 特定业务场景组件 | UserCard, OrderList, PaymentForm |
| **布局组件** | 页面布局相关组件 | PageHeader, Sidebar, Footer |
| **反馈组件** | 用户反馈相关组件 | Toast, Alert, Skeleton, Empty |
| **导航组件** | 导航相关组件 | Menu, Breadcrumb, Tabs, Pagination |
| **数据组件** | 数据展示相关组件 | Table, List, Tree, Chart |

### 1.3 组件命名规范

**命名规则**：
- 使用 PascalCase：`KhyButton`、`KhyCard`
- 以 `Khy` 前缀标识品牌组件
- 使用描述性名称：`UserProfileCard` 而非 `Card1`

**文件命名**：
```
components/
├── base/
│   ├── KhyButton.vue
│   ├── KhyInput.vue
│   └── KhyCard.vue
├── business/
│   ├── UserProfileCard.vue
│   └── OrderList.vue
├── layout/
│   ├── KhyPageHeader.vue
│   └── KhySidebar.vue
└── feedback/
    ├── KhyToast.vue
    └── KhyAlert.vue
```

---


---

## 9. 版本历史

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| 1.0.0 | 2026-09-04 | 初始版本，定义前端组件库规范 |
| 1.1.0 | 2026-09-18 | 按 `[DESIGN-DOC-001]` §12 拆分：主篇保留 §1 概述与索引，细则拆为 `FE-005`~`FE-011` 七个子篇（B7） |

---

*本规范由 khy-os 前端团队维护*

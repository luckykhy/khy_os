# [DESIGN-FE-010] 组件文档与发布规范

> **定位**：组件文档结构与示例、版本管理、发布流程、CHANGELOG 规范。
> **隶属**：本文是 [`[DESIGN-FE-002]` 前端组件库规范]([DESIGN-FE-002] 前端组件库规范.md) 的**子篇**；主篇是唯一入口与 scope 裁决真源，本文只承载细则。
> **状态**：随主篇——主篇 §0 声明为「目标态、非现状」，本文同样在组件库真正落地后才生效；在此之前一切以 [`[DESIGN-FE-001]` 前端页面规范]([DESIGN-FE-001] 前端页面规范.md) 为准。

---

## 5. 组件文档规范

### 5.1 文档结构

**组件文档模板**：
```markdown
# KhyButton 按钮

## 基本用法

<template>
  <KhyButton>默认按钮</KhyButton>
  <KhyButton variant="primary">主要按钮</KhyButton>
  <KhyButton variant="success">成功按钮</KhyButton>
</template>

## 属性

| 属性 | 说明 | 类型 | 默认值 | 可选值 |
|------|------|------|--------|--------|
| variant | 按钮类型 | String | 'default' | 'default', 'primary', 'success', 'warning', 'danger', 'ghost' |
| size | 按钮大小 | String | 'md' | 'sm', 'md', 'lg' |
| disabled | 是否禁用 | Boolean | false | - |
| loading | 是否加载中 | Boolean | false | - |
| block | 是否块级 | Boolean | false | - |

## 事件

| 事件名 | 说明 | 回调参数 |
|--------|------|----------|
| click | 点击事件 | (event: MouseEvent) |

## 插槽

| 插槽名 | 说明 |
|--------|------|
| default | 按钮内容 |
| icon | 按钮图标 |

## 示例

### 不同类型

<template>
  <KhyButton>默认按钮</KhyButton>
  <KhyButton variant="primary">主要按钮</KhyButton>
  <KhyButton variant="success">成功按钮</KhyButton>
  <KhyButton variant="warning">警告按钮</KhyButton>
  <KhyButton variant="danger">危险按钮</KhyButton>
</template>

### 不同大小

<template>
  <KhyButton size="sm">小按钮</KhyButton>
  <KhyButton size="md">中按钮</KhyButton>
  <KhyButton size="lg">大按钮</KhyButton>
</template>

### 加载状态

<template>
  <KhyButton loading>加载中...</KhyButton>
</template>

### 禁用状态

<template>
  <KhyButton disabled>禁用按钮</KhyButton>
</template>

## 设计指南

### 使用场景

- 用于触发操作或事件
- 用于提交表单
- 用于打开对话框
- 用于导航

### 最佳实践

- 使用清晰的动作词（如"保存"、"删除"、"提交"）
- 主要操作使用 primary 变体
- 危险操作使用 danger 变体
- 避免在页面中使用过多主要按钮

### 可访问性

- 按钮应有清晰的文本标签
- 禁用状态应有视觉提示
- 加载状态应有进度指示
- 支持键盘导航
```

### 5.2 示例代码

**在线示例**：
```vue
<template>
  <div class="example">
    <KhyButton variant="primary" @click="handleClick">
      点击我
    </KhyButton>
    <p v-if="clicked">已点击！</p>
  </div>
</template>

<script setup>
import { ref } from 'vue';

const clicked = ref(false);

const handleClick = () => {
  clicked.value = true;
};
</script>
```

---

## 6. 组件发布规范

### 6.1 版本管理

**语义化版本**：
- MAJOR：不兼容的 API 变更
- MINOR：向下兼容的功能性新增
- PATCH：向下兼容的问题修正

**版本号格式**：`v1.0.0`

### 6.2 发布流程

**发布步骤**：
1. 更新版本号
2. 更新 CHANGELOG
3. 运行测试
4. 构建组件库
5. 发布到 npm
6. 创建 Git Tag

**发布命令**：
```bash
# 更新版本
npm version patch|minor|major

# 构建组件库
npm run build

# 发布到 npm
npm publish

# 创建 Git Tag
git tag v1.0.0
git push origin v1.0.0
```

### 6.3 CHANGELOG 规范

**CHANGELOG 格式**：
```markdown
# Changelog

## [1.0.0] - 2026-09-04

### Added
- 新增 KhyButton 组件
- 新增 KhyInput 组件
- 新增 KhyCard 组件

### Changed
- 更新设计令牌系统

### Fixed
- 修复按钮禁用状态样式问题

### Deprecated
- 无

### Removed
- 无

### Security
- 无
```

---

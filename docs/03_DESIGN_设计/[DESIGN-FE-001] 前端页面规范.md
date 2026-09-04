# [DESIGN-FE-001] 前端页面规范

> 本文档定义 khy-os 项目前端页面的设计规范、组件标准、性能要求和质量保证。

---

## 1. 规范概述

### 1.1 适用范围

本规范适用于 khy-os 项目的所有前端应用：

| 应用 | 路径 | 技术栈 | 用途 |
|------|------|--------|------|
| **AI Frontend** | `apps/ai-frontend/` | Vue 3 + Vite + Element Plus | AI 平台管理界面 |
| **KhyQuant Frontend** | `software/khyquant/frontend/` | Vue 3 + Vite + Element Plus + PWA | 量化交易终端 |
| **khy-mobile** | `apps/khy-mobile/` | Vue 3 + Vite + Capacitor | 移动端伴侣应用 |

### 1.2 设计原则

1. **一致性**：统一的设计语言和交互模式
2. **可访问性**：支持残障用户，符合 WCAG 2.1 AA 标准
3. **响应式**：适配桌面、平板、手机等多种设备
4. **高性能**：快速加载，流畅交互
5. **可维护**：组件化、模块化、易于扩展

### 1.3 规范版本

- **当前版本**：`1.0.0`
- **最后更新**：2026-09-04
- **维护团队**：khy-os 前端团队

---

## 2. 设计令牌系统

### 2.1 令牌架构

```
┌─────────────────────────────────────────────────────────────┐
│                    设计令牌层次结构                            │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────┐   │
│  │              基础令牌 (Base Tokens)                  │   │
│  │  • 颜色  • 字体  • 间距  • 圆角  • 阴影  • 动画     │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              语义令牌 (Semantic Tokens)              │   │
│  │  • 表面  • 文本  • 品牌  • 状态  • 交互              │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              组件令牌 (Component Tokens)             │   │
│  │  • 按钮  • 输入框  • 卡片  • 表格  • 导航            │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 基础令牌

**颜色系统**：
```css
:root {
  /* 基础颜色 */
  --khy-white: #ffffff;
  --khy-black: #000000;
  
  /* 灰度色阶 */
  --khy-gray-50: #f9fafb;
  --khy-gray-100: #f3f4f6;
  --khy-gray-200: #e5e7eb;
  --khy-gray-300: #d1d5db;
  --khy-gray-400: #9ca3af;
  --khy-gray-500: #6b7280;
  --khy-gray-600: #4b5563;
  --khy-gray-700: #374151;
  --khy-gray-800: #1f2937;
  --khy-gray-900: #111827;
  
  /* 品牌色 */
  --khy-primary-50: #eff6ff;
  --khy-primary-100: #dbeafe;
  --khy-primary-200: #bfdbfe;
  --khy-primary-300: #93c5fd;
  --khy-primary-400: #60a5fa;
  --khy-primary-500: #3b82f6;
  --khy-primary-600: #2563eb;
  --khy-primary-700: #1d4ed8;
  --khy-primary-800: #1e40af;
  --khy-primary-900: #1e3a8a;
  
  /* 状态色 */
  --khy-success: #10b981;
  --khy-warning: #f59e0b;
  --khy-danger: #ef4444;
  --khy-info: #3b82f6;
}
```

**字体系统**：
```css
:root {
  /* 字体族 */
  --khy-font-sans: 'Public Sans', -apple-system, BlinkMacSystemFont, 
                   'Segoe UI', Roboto, 'PingFang SC', 'Noto Sans SC', 
                   'Microsoft YaHei', sans-serif;
  --khy-font-mono: 'JetBrains Mono', 'Fira Code', 'Consolas', 
                   'Monaco', monospace;
  
  /* 字体大小 */
  --khy-text-xs: 0.75rem;    /* 12px */
  --khy-text-sm: 0.875rem;   /* 14px */
  --khy-text-base: 1rem;     /* 16px */
  --khy-text-lg: 1.125rem;   /* 18px */
  --khy-text-xl: 1.25rem;    /* 20px */
  --khy-text-2xl: 1.5rem;    /* 24px */
  --khy-text-3xl: 1.875rem;  /* 30px */
  
  /* 行高 */
  --khy-leading-none: 1;
  --khy-leading-tight: 1.25;
  --khy-leading-snug: 1.375;
  --khy-leading-normal: 1.5;
  --khy-leading-relaxed: 1.625;
  --khy-leading-loose: 2;
}
```

**间距系统**：
```css
:root {
  --khy-space-0: 0;
  --khy-space-1: 0.25rem;   /* 4px */
  --khy-space-2: 0.5rem;    /* 8px */
  --khy-space-3: 0.75rem;   /* 12px */
  --khy-space-4: 1rem;      /* 16px */
  --khy-space-5: 1.25rem;   /* 20px */
  --khy-space-6: 1.5rem;    /* 24px */
  --khy-space-8: 2rem;      /* 32px */
  --khy-space-10: 2.5rem;   /* 40px */
  --khy-space-12: 3rem;     /* 48px */
  --khy-space-16: 4rem;     /* 64px */
}
```

**圆角系统**：
```css
:root {
  --khy-radius-none: 0;
  --khy-radius-sm: 0.25rem;   /* 4px */
  --khy-radius: 0.5rem;       /* 8px */
  --khy-radius-md: 0.75rem;   /* 12px */
  --khy-radius-lg: 1rem;      /* 16px */
  --khy-radius-xl: 1.5rem;    /* 24px */
  --khy-radius-2xl: 2rem;     /* 32px */
  --khy-radius-full: 9999px;
}
```

**阴影系统**：
```css
:root {
  --khy-shadow-sm: 0 1px 2px 0 rgb(0 0 0 / 0.05);
  --khy-shadow: 0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1);
  --khy-shadow-md: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1);
  --khy-shadow-lg: 0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1);
  --khy-shadow-xl: 0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1);
}
```

### 2.3 语义令牌

**表面颜色**：
```css
:root {
  /* 浅色主题 */
  --khy-bg-main: var(--khy-gray-50);
  --khy-bg-elevated: var(--khy-white);
  --khy-bg-card: var(--khy-white);
  --khy-bg-overlay: rgba(0, 0, 0, 0.5);
  
  /* 深色主题 */
  --khy-bg-main: var(--khy-gray-900);
  --khy-bg-elevated: var(--khy-gray-800);
  --khy-bg-card: var(--khy-gray-800);
  --khy-bg-overlay: rgba(0, 0, 0, 0.7);
}
```

**文本颜色**：
```css
:root {
  /* 浅色主题 */
  --khy-text-main: var(--khy-gray-900);
  --khy-text-strong: var(--khy-black);
  --khy-text-secondary: var(--khy-gray-600);
  --khy-text-muted: var(--khy-gray-400);
  --khy-text-inverse: var(--khy-white);
  
  /* 深色主题 */
  --khy-text-main: var(--khy-gray-100);
  --khy-text-strong: var(--khy-white);
  --khy-text-secondary: var(--khy-gray-400);
  --khy-text-muted: var(--khy-gray-500);
  --khy-text-inverse: var(--khy-black);
}
```

**品牌颜色**：
```css
:root {
  --khy-primary: var(--khy-primary-500);
  --khy-primary-hover: var(--khy-primary-600);
  --khy-primary-active: var(--khy-primary-700);
  --khy-primary-light: var(--khy-primary-50);
}
```

**状态颜色**：
```css
:root {
  --khy-success: #10b981;
  --khy-success-light: #d1fae5;
  --khy-warning: #f59e0b;
  --khy-warning-light: #fef3c7;
  --khy-danger: #ef4444;
  --khy-danger-light: #fee2e2;
  --khy-info: #3b82f6;
  --khy-info-light: #dbeafe;
}
```

### 2.4 主题切换

**实现方式**：
```javascript
// 主题切换函数
export function setTheme(theme) {
  document.documentElement.classList.toggle('dark', theme === 'dark');
  localStorage.setItem('khy-theme', theme);
}

// 初始化主题
export function initTheme() {
  const saved = localStorage.getItem('khy-theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = saved || (prefersDark ? 'dark' : 'light');
  setTheme(theme);
}
```

**CSS 变量覆盖**：
```css
/* 浅色主题 */
:root {
  --khy-bg-main: var(--khy-gray-50);
  --khy-text-main: var(--khy-gray-900);
}

/* 深色主题 */
html.dark {
  --khy-bg-main: var(--khy-gray-900);
  --khy-text-main: var(--khy-gray-100);
}
```

---

## 3. 页面布局规范

### 3.1 布局架构

**标准页面布局**：
```vue
<template>
  <div class="khy-page">
    <!-- 页面头部 -->
    <header class="khy-page-header">
      <slot name="header" />
    </header>
    
    <!-- 页面内容 -->
    <main class="khy-page-content">
      <slot />
    </main>
    
    <!-- 页面底部 -->
    <footer class="khy-page-footer">
      <slot name="footer" />
    </footer>
  </div>
</template>

<style scoped>
.khy-page {
  max-width: 1200px;
  margin: 0 auto;
  padding: var(--khy-space-6);
}

.khy-page-header {
  margin-bottom: var(--khy-space-6);
}

.khy-page-content {
  flex: 1;
}

.khy-page-footer {
  margin-top: var(--khy-space-6);
  padding-top: var(--khy-space-6);
  border-top: 1px solid var(--khy-gray-200);
}
</style>
```

### 3.2 响应式断点

```css
/* 移动端 */
@media (max-width: 639px) {
  /* 手机样式 */
}

/* 平板端 */
@media (min-width: 640px) and (max-width: 1023px) {
  /* 平板样式 */
}

/* 桌面端 */
@media (min-width: 1024px) {
  /* 桌面样式 */
}
```

**断点值**：
```css
:root {
  --khy-breakpoint-sm: 640px;
  --khy-breakpoint-md: 768px;
  --khy-breakpoint-lg: 1024px;
  --khy-breakpoint-xl: 1280px;
  --khy-breakpoint-2xl: 1536px;
}
```

### 3.3 网格系统

**12 列网格**：
```css
.khy-grid {
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  gap: var(--khy-space-4);
}

.khy-col-1 { grid-column: span 1; }
.khy-col-2 { grid-column: span 2; }
/* ... */
.khy-col-12 { grid-column: span 12; }

@media (max-width: 639px) {
  .khy-col-sm-12 { grid-column: span 12; }
}

@media (min-width: 640px) {
  .khy-col-md-6 { grid-column: span 6; }
}

@media (min-width: 1024px) {
  .khy-col-lg-4 { grid-column: span 4; }
}
```

### 3.4 侧边栏布局

**标准侧边栏布局**：
```vue
<template>
  <div class="khy-layout">
    <!-- 侧边栏 -->
    <aside class="khy-sidebar">
      <slot name="sidebar" />
    </aside>
    
    <!-- 主内容区 -->
    <div class="khy-main">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.khy-layout {
  display: flex;
  min-height: 100vh;
}

.khy-sidebar {
  width: 250px;
  background: var(--khy-bg-elevated);
  border-right: 1px solid var(--khy-gray-200);
}

.khy-main {
  flex: 1;
  padding: var(--khy-space-6);
}

@media (max-width: 1023px) {
  .khy-sidebar {
    position: fixed;
    z-index: 100;
    transform: translateX(-100%);
    transition: transform 0.3s ease;
  }
  
  .khy-sidebar.open {
    transform: translateX(0);
  }
}
</style>
```

---

## 4. 组件规范

### 4.1 组件命名

**命名规则**：
- 使用 PascalCase：`KhyButton`、`KhyCard`
- 以 `Khy` 前缀标识品牌组件
- 使用描述性名称：`UserProfileCard` 而非 `Card1`

**文件命名**：
```
components/
├── KhyButton.vue
├── KhyCard.vue
├── UserProfileCard.vue
└── ...
```

### 4.2 组件结构

**标准组件模板**：
```vue
<template>
  <div :class="componentClasses">
    <!-- 组件内容 -->
  </div>
</template>

<script setup>
import { computed } from 'vue';

// Props 定义
const props = defineProps({
  variant: {
    type: String,
    default: 'default',
    validator: (value) => ['default', 'primary', 'success', 'warning', 'danger'].includes(value)
  },
  size: {
    type: String,
    default: 'md',
    validator: (value) => ['sm', 'md', 'lg'].includes(value)
  },
  disabled: {
    type: Boolean,
    default: false
  }
});

// Emits 定义
const emit = defineEmits(['click', 'focus', 'blur']);

// 计算属性
const componentClasses = computed(() => [
  'khy-component',
  `khy-component--${props.variant}`,
  `khy-component--${props.size}`,
  {
    'khy-component--disabled': props.disabled
  }
]);

// 方法
const handleClick = (event) => {
  if (!props.disabled) {
    emit('click', event);
  }
};
</script>

<style scoped>
.khy-component {
  /* 基础样式 */
}

.khy-component--primary {
  /* 主要样式 */
}

.khy-component--disabled {
  /* 禁用样式 */
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
```

### 4.3 核心组件库

**按钮组件 (KhyButton)**：
```vue
<template>
  <button
    :class="buttonClasses"
    :disabled="disabled || loading"
    @click="handleClick"
  >
    <span v-if="loading" class="khy-button__spinner" />
    <slot />
  </button>
</template>

<script setup>
const props = defineProps({
  variant: {
    type: String,
    default: 'default',
    validator: (value) => ['default', 'primary', 'success', 'warning', 'danger', 'ghost'].includes(value)
  },
  size: {
    type: String,
    default: 'md',
    validator: (value) => ['sm', 'md', 'lg'].includes(value)
  },
  disabled: Boolean,
  loading: Boolean,
  block: Boolean
});

const buttonClasses = computed(() => [
  'khy-button',
  `khy-button--${props.variant}`,
  `khy-button--${props.size}`,
  {
    'khy-button--block': props.block,
    'khy-button--loading': props.loading
  }
]);
</script>

<style scoped>
.khy-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--khy-space-2);
  padding: var(--khy-space-2) var(--khy-space-4);
  font-weight: 500;
  border-radius: var(--khy-radius);
  transition: all 0.2s ease;
  cursor: pointer;
}

.khy-button:hover {
  transform: translateY(-1px);
  box-shadow: var(--khy-shadow-md);
}

.khy-button--primary {
  background: var(--khy-primary);
  color: var(--khy-white);
}

.khy-button--primary:hover {
  background: var(--khy-primary-hover);
}

.khy-button--sm {
  padding: var(--khy-space-1) var(--khy-space-3);
  font-size: var(--khy-text-sm);
}

.khy-button--lg {
  padding: var(--khy-space-3) var(--khy-space-6);
  font-size: var(--khy-text-lg);
}

.khy-button--block {
  width: 100%;
}

.khy-button--loading {
  opacity: 0.7;
  cursor: wait;
}

.khy-button__spinner {
  width: 1em;
  height: 1em;
  border: 2px solid transparent;
  border-top-color: currentColor;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
```

**卡片组件 (KhyCard)**：
```vue
<template>
  <div :class="cardClasses">
    <div v-if="$slots.header" class="khy-card__header">
      <slot name="header" />
    </div>
    <div class="khy-card__body">
      <slot />
    </div>
    <div v-if="$slots.footer" class="khy-card__footer">
      <slot name="footer" />
    </div>
  </div>
</template>

<script setup>
const props = defineProps({
  variant: {
    type: String,
    default: 'default',
    validator: (value) => ['default', 'elevated', 'outlined'].includes(value)
  },
  padding: {
    type: String,
    default: 'md',
    validator: (value) => ['none', 'sm', 'md', 'lg'].includes(value)
  }
});

const cardClasses = computed(() => [
  'khy-card',
  `khy-card--${props.variant}`,
  `khy-card--padding-${props.padding}`
]);
</script>

<style scoped>
.khy-card {
  background: var(--khy-bg-card);
  border-radius: var(--khy-radius-lg);
  overflow: hidden;
}

.khy-card--elevated {
  box-shadow: var(--khy-shadow);
}

.khy-card--outlined {
  border: 1px solid var(--khy-gray-200);
}

.khy-card__header {
  padding: var(--khy-space-4);
  border-bottom: 1px solid var(--khy-gray-200);
}

.khy-card__body {
  padding: var(--khy-space-4);
}

.khy-card--padding-none .khy-card__body {
  padding: 0;
}

.khy-card--padding-sm .khy-card__body {
  padding: var(--khy-space-2);
}

.khy-card--padding-lg .khy-card__body {
  padding: var(--khy-space-6);
}

.khy-card__footer {
  padding: var(--khy-space-4);
  border-top: 1px solid var(--khy-gray-200);
}
</style>
```

**输入框组件 (KhyInput)**：
```vue
<template>
  <div :class="inputClasses">
    <label v-if="label" class="khy-input__label">
      {{ label }}
      <span v-if="required" class="khy-input__required">*</span>
    </label>
    <div class="khy-input__wrapper">
      <input
        ref="inputRef"
        :type="type"
        :value="modelValue"
        :placeholder="placeholder"
        :disabled="disabled"
        :readonly="readonly"
        @input="handleInput"
        @focus="handleFocus"
        @blur="handleBlur"
      />
      <span v-if="$slots.suffix" class="khy-input__suffix">
        <slot name="suffix" />
      </span>
    </div>
    <p v-if="error" class="khy-input__error">{{ error }}</p>
    <p v-else-if="hint" class="khy-input__hint">{{ hint }}</p>
  </div>
</template>

<script setup>
const props = defineProps({
  modelValue: {
    type: [String, Number],
    default: ''
  },
  type: {
    type: String,
    default: 'text'
  },
  label: String,
  placeholder: String,
  hint: String,
  error: String,
  disabled: Boolean,
  readonly: Boolean,
  required: Boolean,
  size: {
    type: String,
    default: 'md',
    validator: (value) => ['sm', 'md', 'lg'].includes(value)
  }
});

const emit = defineEmits(['update:modelValue', 'focus', 'blur']);

const inputClasses = computed(() => [
  'khy-input',
  `khy-input--${props.size}`,
  {
    'khy-input--disabled': props.disabled,
    'khy-input--error': props.error
  }
]);

const handleInput = (event) => {
  emit('update:modelValue', event.target.value);
};
</script>

<style scoped>
.khy-input {
  display: flex;
  flex-direction: column;
  gap: var(--khy-space-1);
}

.khy-input__label {
  font-size: var(--khy-text-sm);
  font-weight: 500;
  color: var(--khy-text-main);
}

.khy-input__required {
  color: var(--khy-danger);
}

.khy-input__wrapper {
  display: flex;
  align-items: center;
  background: var(--khy-bg-elevated);
  border: 1px solid var(--khy-gray-300);
  border-radius: var(--khy-radius);
  transition: all 0.2s ease;
}

.khy-input__wrapper:focus-within {
  border-color: var(--khy-primary);
  box-shadow: 0 0 0 3px var(--khy-primary-light);
}

.khy-input__wrapper input {
  flex: 1;
  padding: var(--khy-space-2) var(--khy-space-3);
  background: transparent;
  border: none;
  outline: none;
  font-size: var(--khy-text-base);
  color: var(--khy-text-main);
}

.khy-input__wrapper input::placeholder {
  color: var(--khy-text-muted);
}

.khy-input__suffix {
  padding-right: var(--khy-space-3);
  color: var(--khy-text-muted);
}

.khy-input__error {
  font-size: var(--khy-text-sm);
  color: var(--khy-danger);
}

.khy-input__hint {
  font-size: var(--khy-text-sm);
  color: var(--khy-text-muted);
}

.khy-input--error .khy-input__wrapper {
  border-color: var(--khy-danger);
}

.khy-input--error .khy-input__wrapper:focus-within {
  box-shadow: 0 0 0 3px var(--khy-danger-light);
}

.khy-input--sm .khy-input__wrapper input {
  padding: var(--khy-space-1) var(--khy-space-2);
  font-size: var(--khy-text-sm);
}

.khy-input--lg .khy-input__wrapper input {
  padding: var(--khy-space-3) var(--khy-space-4);
  font-size: var(--khy-text-lg);
}
</style>
```

### 4.4 组件状态

**加载状态**：
```vue
<template>
  <div v-if="loading" class="khy-skeleton">
    <div class="khy-skeleton__line" />
    <div class="khy-skeleton__line khy-skeleton__line--short" />
  </div>
  <div v-else>
    <slot />
  </div>
</template>

<style scoped>
.khy-skeleton__line {
  height: 1rem;
  background: linear-gradient(90deg, var(--khy-gray-200) 25%, var(--khy-gray-100) 50%, var(--khy-gray-200) 75%);
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite;
  border-radius: var(--khy-radius-sm);
  margin-bottom: var(--khy-space-2);
}

.khy-skeleton__line--short {
  width: 60%;
}

@keyframes shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
</style>
```

**空状态**：
```vue
<template>
  <div class="khy-empty">
    <div class="khy-empty__icon">
      <slot name="icon">
        <span class="khy-empty__default-icon">📭</span>
      </slot>
    </div>
    <h3 class="khy-empty__title">{{ title }}</h3>
    <p v-if="description" class="khy-empty__description">{{ description }}</p>
    <div v-if="$slots.action" class="khy-empty__action">
      <slot name="action" />
    </div>
  </div>
</template>

<script setup>
defineProps({
  title: {
    type: String,
    default: '暂无数据'
  },
  description: String
});
</script>

<style scoped>
.khy-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: var(--khy-space-12) var(--khy-space-6);
  text-align: center;
}

.khy-empty__icon {
  font-size: 3rem;
  margin-bottom: var(--khy-space-4);
}

.khy-empty__title {
  font-size: var(--khy-text-lg);
  font-weight: 500;
  color: var(--khy-text-main);
  margin-bottom: var(--khy-space-2);
}

.khy-empty__description {
  font-size: var(--khy-text-sm);
  color: var(--khy-text-muted);
  margin-bottom: var(--khy-space-6);
}
</style>
```

---

## 5. 交互规范

### 5.1 动画系统

**过渡动画**：
```css
/* 淡入淡出 */
.khy-fade-enter-active,
.khy-fade-leave-active {
  transition: opacity 0.3s ease;
}

.khy-fade-enter-from,
.khy-fade-leave-to {
  opacity: 0;
}

/* 滑动 */
.khy-slide-enter-active,
.khy-slide-leave-active {
  transition: transform 0.3s ease;
}

.khy-slide-enter-from {
  transform: translateX(-100%);
}

.khy-slide-leave-to {
  transform: translateX(100%);
}

/* 缩放 */
.khy-scale-enter-active,
.khy-scale-leave-active {
  transition: transform 0.2s ease, opacity 0.2s ease;
}

.khy-scale-enter-from,
.khy-scale-leave-to {
  transform: scale(0.95);
  opacity: 0;
}
```

**微交互**：
```css
/* 按钮悬停 */
.khy-button:hover {
  transform: translateY(-1px);
  box-shadow: var(--khy-shadow-md);
}

/* 卡片悬停 */
.khy-card:hover {
  box-shadow: var(--khy-shadow-lg);
}

/* 输入框聚焦 */
.khy-input__wrapper:focus-within {
  border-color: var(--khy-primary);
  box-shadow: 0 0 0 3px var(--khy-primary-light);
}

/* 链接悬停 */
.khy-link:hover {
  color: var(--khy-primary-hover);
  text-decoration: underline;
}
```

### 5.2 加载状态

**全局加载**：
```vue
<template>
  <div v-if="loading" class="khy-global-loading">
    <div class="khy-global-loading__spinner" />
    <p class="khy-global-loading__text">{{ text }}</p>
  </div>
</template>

<style scoped>
.khy-global-loading {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: var(--khy-bg-overlay);
  z-index: 9999;
}

.khy-global-loading__spinner {
  width: 40px;
  height: 40px;
  border: 3px solid var(--khy-gray-200);
  border-top-color: var(--khy-primary);
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

.khy-global-loading__text {
  margin-top: var(--khy-space-4);
  color: var(--khy-text-inverse);
  font-size: var(--khy-text-sm);
}
</style>
```

**按钮加载**：
```vue
<template>
  <button :disabled="loading" @click="handleClick">
    <span v-if="loading" class="khy-button__spinner" />
    <slot />
  </button>
</template>
```

### 5.3 错误处理

**错误提示**：
```vue
<template>
  <div v-if="error" class="khy-error-banner">
    <span class="khy-error-banner__icon">⚠️</span>
    <span class="khy-error-banner__message">{{ error.message }}</span>
    <button class="khy-error-banner__close" @click="dismiss">×</button>
  </div>
</template>

<style scoped>
.khy-error-banner {
  display: flex;
  align-items: center;
  gap: var(--khy-space-3);
  padding: var(--khy-space-3) var(--khy-space-4);
  background: var(--khy-danger-light);
  border: 1px solid var(--khy-danger);
  border-radius: var(--khy-radius);
  color: var(--khy-danger);
}

.khy-error-banner__close {
  margin-left: auto;
  background: none;
  border: none;
  color: var(--khy-danger);
  cursor: pointer;
  font-size: var(--khy-text-lg);
}
</style>
```

**错误页面**：
```vue
<template>
  <div class="khy-error-page">
    <h1 class="khy-error-page__code">{{ code }}</h1>
    <p class="khy-error-page__message">{{ message }}</p>
    <button class="khy-button khy-button--primary" @click="goHome">
      返回首页
    </button>
  </div>
</template>

<script setup>
defineProps({
  code: {
    type: [String, Number],
    default: 404
  },
  message: {
    type: String,
    default: '页面未找到'
  }
});
</script>

<style scoped>
.khy-error-page {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  text-align: center;
}

.khy-error-page__code {
  font-size: 6rem;
  font-weight: 700;
  color: var(--khy-primary);
  line-height: 1;
  margin-bottom: var(--khy-space-4);
}

.khy-error-page__message {
  font-size: var(--khy-text-xl);
  color: var(--khy-text-secondary);
  margin-bottom: var(--khy-space-8);
}
</style>
```

### 5.4 表单验证

**验证规则**：
```javascript
export const validationRules = {
  required: (message = '此项为必填项') => ({
    required: true,
    message,
    trigger: 'blur'
  }),
  
  email: (message = '请输入有效的邮箱地址') => ({
    type: 'email',
    message,
    trigger: 'blur'
  }),
  
  min: (min, message) => ({
    min,
    message: message || `最少输入 ${min} 个字符`,
    trigger: 'blur'
  }),
  
  max: (max, message) => ({
    max,
    message: message || `最多输入 ${max} 个字符`,
    trigger: 'blur'
  }),
  
  pattern: (pattern, message = '格式不正确') => ({
    pattern,
    message,
    trigger: 'blur'
  })
};
```

**表单组件**：
```vue
<template>
  <form @submit.prevent="handleSubmit">
    <slot />
    <div class="khy-form__actions">
      <slot name="actions" />
    </div>
  </form>
</template>

<script setup>
const props = defineProps({
  model: {
    type: Object,
    required: true
  },
  rules: {
    type: Object,
    default: () => ({})
  }
});

const emit = defineEmits(['submit']);

const handleSubmit = async () => {
  // 验证表单
  const valid = await validate();
  if (valid) {
    emit('submit', props.model);
  }
};
</script>
```

---

## 6. 响应式规范

### 6.1 移动端适配

**触控优化**：
```css
/* 增大点击区域 */
.khy-button {
  min-height: 44px;
  min-width: 44px;
}

/* 优化输入框 */
.khy-input__wrapper input {
  font-size: 16px; /* 防止 iOS 缩放 */
}

/* 防止双击缩放 */
.khy-button {
  touch-action: manipulation;
}
```

**移动端导航**：
```vue
<template>
  <nav class="khy-mobile-nav">
    <button class="khy-mobile-nav__toggle" @click="toggleMenu">
      <span class="khy-mobile-nav__icon">☰</span>
    </button>
    <div v-show="menuOpen" class="khy-mobile-nav__menu">
      <slot />
    </div>
  </nav>
</template>

<style scoped>
.khy-mobile-nav__toggle {
  display: none;
}

@media (max-width: 1023px) {
  .khy-mobile-nav__toggle {
    display: block;
  }
  
  .khy-mobile-nav__menu {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: var(--khy-bg-overlay);
    z-index: 100;
  }
}
</style>
```

### 6.2 响应式图片

```vue
<template>
  <picture class="khy-responsive-image">
    <source :srcset="srcSetWebp" type="image/webp" />
    <source :srcset="srcSetJpg" type="image/jpeg" />
    <img
      :src="fallbackSrc"
      :alt="alt"
      :width="width"
      :height="height"
      loading="lazy"
      @load="handleLoad"
      @error="handleError"
    />
  </picture>
</template>

<script setup>
const props = defineProps({
  src: {
    type: String,
    required: true
  },
  alt: {
    type: String,
    required: true
  },
  width: Number,
  height: Number
});

const srcSetWebp = computed(() => `${props.src}?format=webp 1x, ${props.src}?format=webp&dpr=2 2x`);
const srcSetJpg = computed(() => `${props.src} 1x, ${props.src}?dpr=2 2x`);
const fallbackSrc = computed(() => props.src);
</script>

<style scoped>
.khy-responsive-image img {
  max-width: 100%;
  height: auto;
  display: block;
}
</style>
```

### 6.3 响应式表格

```vue
<template>
  <div class="khy-responsive-table">
    <table>
      <slot />
    </table>
  </div>
</template>

<style scoped>
.khy-responsive-table {
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}

@media (max-width: 639px) {
  .khy-responsive-table table {
    display: block;
  }
  
  .khy-responsive-table thead {
    display: none;
  }
  
  .khy-responsive-table tbody tr {
    display: block;
    margin-bottom: var(--khy-space-4);
    border: 1px solid var(--khy-gray-200);
    border-radius: var(--khy-radius);
  }
  
  .khy-responsive-table td {
    display: flex;
    justify-content: space-between;
    padding: var(--khy-space-2) var(--khy-space-3);
    border-bottom: 1px solid var(--khy-gray-100);
  }
  
  .khy-responsive-table td::before {
    content: attr(data-label);
    font-weight: 500;
    color: var(--khy-text-secondary);
  }
}
</style>
```

---

## 7. 性能规范

### 7.1 代码分割

**路由懒加载**：
```javascript
const routes = [
  {
    path: '/dashboard',
    component: () => import('@/views/Dashboard.vue')
  },
  {
    path: '/settings',
    component: () => import('@/views/Settings.vue')
  }
];
```

**组件懒加载**：
```vue
<script setup>
import { defineAsyncComponent } from 'vue';

const HeavyComponent = defineAsyncComponent(() => 
  import('@/components/HeavyComponent.vue')
);
</script>
```

### 7.2 图片优化

**图片格式**：
- 优先使用 WebP
- 回退到 JPEG/PNG
- 使用 SVG 图标

**图片加载**：
```vue
<template>
  <img
    :src="src"
    :alt="alt"
    loading="lazy"
    decoding="async"
    @load="handleLoad"
  />
</template>
```

### 7.3 缓存策略

**静态资源缓存**：
```javascript
// vite.config.js
export default {
  build: {
    rollupOptions: {
      output: {
        assetFileNames: 'assets/[name].[hash].[ext]'
      }
    }
  }
};
```

**API 缓存**：
```javascript
// 使用 Pinia 缓存
export const useUserStore = defineStore('user', {
  state: () => ({
    users: [],
    lastFetch: null
  }),
  
  actions: {
    async fetchUsers() {
      const now = Date.now();
      if (this.lastFetch && now - this.lastFetch < 5 * 60 * 1000) {
        return this.users;
      }
      
      this.users = await api.getUsers();
      this.lastFetch = now;
      return this.users;
    }
  }
});
```

### 7.4 性能监控

**Core Web Vitals**：
```javascript
// 监控 LCP
new PerformanceObserver((entryList) => {
  const entries = entryList.getEntries();
  const lastEntry = entries[entries.length - 1];
  console.log('LCP:', lastEntry.startTime);
}).observe({ type: 'largest-contentful-paint', buffered: true });

// 监控 FID
new PerformanceObserver((entryList) => {
  const entries = entryList.getEntries();
  entries.forEach((entry) => {
    console.log('FID:', entry.processingStart - entry.startTime);
  });
}).observe({ type: 'first-input', buffered: true });

// 监控 CLS
new PerformanceObserver((entryList) => {
  const entries = entryList.getEntries();
  entries.forEach((entry) => {
    console.log('CLS:', entry.value);
  });
}).observe({ type: 'layout-shift', buffered: true });
```

**性能预算**：
```javascript
// vite.config.js
export default {
  build: {
    chunkSizeWarningLimit: 500,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['vue', 'vue-router', 'pinia'],
          element: ['element-plus']
        }
      }
    }
  }
};
```

---

## 8. 可访问性规范

### 8.1 语义化 HTML

```vue
<template>
  <!-- 使用语义化标签 -->
  <header>
    <nav aria-label="主导航">
      <ul>
        <li><a href="/">首页</a></li>
        <li><a href="/about">关于</a></li>
      </ul>
    </nav>
  </header>
  
  <main>
    <article>
      <h1>页面标题</h1>
      <section>
        <h2>章节标题</h2>
        <p>内容...</p>
      </section>
    </article>
  </main>
  
  <footer>
    <p>版权信息</p>
  </footer>
</template>
```

### 8.2 ARIA 属性

```vue
<template>
  <!-- 按钮 -->
  <button aria-label="关闭对话框" @click="close">×</button>
  
  <!-- 输入框 -->
  <input
    aria-label="搜索"
    aria-describedby="search-hint"
    type="search"
  />
  <p id="search-hint">输入关键词搜索</p>
  
  <!-- 对话框 -->
  <div role="dialog" aria-modal="true" aria-labelledby="dialog-title">
    <h2 id="dialog-title">确认操作</h2>
    <p>确定要删除吗？</p>
  </div>
  
  <!-- 加载状态 -->
  <div aria-live="polite" aria-busy="true">
    加载中...
  </div>
</template>
```

### 8.3 键盘导航

```vue
<template>
  <div
    role="tablist"
    @keydown="handleKeydown"
  >
    <button
      v-for="(tab, index) in tabs"
      :key="tab.id"
      role="tab"
      :aria-selected="activeTab === tab.id"
      :tabindex="activeTab === tab.id ? 0 : -1"
      @click="activeTab = tab.id"
    >
      {{ tab.label }}
    </button>
  </div>
</template>

<script setup>
const handleKeydown = (event) => {
  const tabs = document.querySelectorAll('[role="tab"]');
  const currentIndex = Array.from(tabs).indexOf(event.target);
  
  switch (event.key) {
    case 'ArrowRight':
      event.preventDefault();
      const nextIndex = (currentIndex + 1) % tabs.length;
      tabs[nextIndex].focus();
      break;
    case 'ArrowLeft':
      event.preventDefault();
      const prevIndex = (currentIndex - 1 + tabs.length) % tabs.length;
      tabs[prevIndex].focus();
      break;
  }
};
</script>
```

### 8.4 颜色对比度

```css
/* 确保文本对比度符合 WCAG AA 标准 */
/* 正常文本：至少 4.5:1 */
/* 大文本：至少 3:1 */

.khy-text-high-contrast {
  color: var(--khy-text-main); /* 对比度 > 7:1 */
}

.khy-text-medium-contrast {
  color: var(--khy-text-secondary); /* 对比度 > 4.5:1 */
}

.khy-text-low-contrast {
  color: var(--khy-text-muted); /* 对比度 > 3:1 */
}
```

### 8.5 动画偏好

```css
/* 尊重用户的动画偏好 */
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

---

## 9. 测试规范

### 9.1 单元测试

**组件测试**：
```javascript
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import KhyButton from '../KhyButton.vue';

describe('KhyButton', () => {
  it('renders correctly', () => {
    const wrapper = mount(KhyButton, {
      props: {
        variant: 'primary'
      },
      slots: {
        default: 'Click me'
      }
    });
    
    expect(wrapper.text()).toBe('Click me');
    expect(wrapper.classes()).toContain('khy-button--primary');
  });
  
  it('emits click event', async () => {
    const wrapper = mount(KhyButton);
    
    await wrapper.trigger('click');
    
    expect(wrapper.emitted('click')).toBeTruthy();
  });
  
  it('does not emit click when disabled', async () => {
    const wrapper = mount(KhyButton, {
      props: {
        disabled: true
      }
    });
    
    await wrapper.trigger('click');
    
    expect(wrapper.emitted('click')).toBeFalsy();
  });
});
```

### 9.2 集成测试

**页面测试**：
```javascript
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestingPinia } from '@pinia/testing';
import UserProfile from '../UserProfile.vue';

describe('UserProfile', () => {
  it('displays user information', () => {
    const wrapper = mount(UserProfile, {
      global: {
        plugins: [
          createTestingPinia({
            initialState: {
              user: {
                name: 'John Doe',
                email: 'john@example.com'
              }
            }
          })
        ]
      }
    });
    
    expect(wrapper.text()).toContain('John Doe');
    expect(wrapper.text()).toContain('john@example.com');
  });
});
```

### 9.3 E2E 测试

**Playwright 测试**：
```javascript
import { test, expect } from '@playwright/test';

test('user can login', async ({ page }) => {
  await page.goto('/login');
  
  await page.fill('[data-testid="email"]', 'user@example.com');
  await page.fill('[data-testid="password"]', 'password123');
  await page.click('[data-testid="submit"]');
  
  await expect(page).toHaveURL('/dashboard');
  await expect(page.locator('[data-testid="user-name"]')).toHaveText('John Doe');
});
```

### 9.4 视觉回归测试

**Chromatic 测试**：
```javascript
// Button.stories.js
export default {
  title: 'Components/KhyButton',
  component: KhyButton
};

export const Primary = {
  args: {
    variant: 'primary',
    children: 'Button'
  }
};

export const Disabled = {
  args: {
    variant: 'primary',
    disabled: true,
    children: 'Button'
  }
};
```

---

## 10. 文档规范

### 10.1 组件文档

**文档模板**：
```markdown
# KhyButton 按钮

## 基本用法

<template>
  <KhyButton variant="primary">主要按钮</KhyButton>
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
```

### 10.2 设计规范文档

**文档结构**：
```
docs/
├── frontend/
│   ├── design-tokens.md      # 设计令牌
│   ├── components.md         # 组件库
│   ├── layout.md            # 布局规范
│   ├── interaction.md       # 交互规范
│   ├── responsive.md        # 响应式规范
│   ├── accessibility.md     # 可访问性规范
│   └── performance.md       # 性能规范
```

---

## 11. CI/CD 规范

### 11.1 代码检查

**ESLint 配置**：
```javascript
// .eslintrc.js
module.exports = {
  extends: [
    'eslint:recommended',
    'plugin:vue/vue3-recommended',
    'prettier'
  ],
  rules: {
    'vue/multi-word-component-names': 'off',
    'vue/no-v-html': 'warn',
    'no-console': ['warn', { allow: ['warn', 'error'] }]
  }
};
```

**Prettier 配置**：
```json
{
  "printWidth": 100,
  "tabWidth": 2,
  "singleQuote": true,
  "trailingComma": "es5",
  "arrowParens": "always",
  "endOfLine": "lf"
}
```

### 11.2 测试门禁

**测试命令**：
```bash
# 运行测试
npm run test

# 生成覆盖率
npm run test:coverage

# 运行 E2E 测试
npm run test:e2e
```

**覆盖率要求**：
```javascript
// vitest.config.js
export default {
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'src/__tests__/'],
      thresholds: {
        branches: 80,
        functions: 80,
        lines: 80,
        statements: 80
      }
    }
  }
};
```

### 11.3 性能门禁

**Bundle 大小检查**：
```javascript
// scripts/ci/check-frontend-size.js
const MAX_BUNDLE_SIZE = 5 * 1024 * 1024; // 5MB

const checkBundleSize = async () => {
  const stats = await getBuildStats();
  if (stats.totalBytes > MAX_BUNDLE_SIZE) {
    console.error(`Bundle size exceeds limit: ${stats.totalBytes} > ${MAX_BUNDLE_SIZE}`);
    process.exit(1);
  }
};
```

**Lighthouse 检查**：
```javascript
// scripts/ci/check-lighthouse.js
const MIN_SCORES = {
  performance: 90,
  accessibility: 90,
  'best-practices': 90,
  seo: 90
};

const checkLighthouse = async () => {
  const scores = await runLighthouse();
  for (const [category, score] of Object.entries(scores)) {
    if (score < MIN_SCORES[category]) {
      console.error(`${category} score too low: ${score} < ${MIN_SCORES[category]}`);
      process.exit(1);
    }
  }
};
```

---

## 12. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-04 | 初始版本，定义前端页面规范 |

---

*本规范由 khy-os 前端团队维护*
# [DESIGN-FE-003] 前端快速参考卡

> 快速查阅 khy-os 前端规范的参考卡。

---

## 设计令牌速查

### 颜色系统

```css
/* 品牌色 */
--khy-primary: #3b82f6;
--khy-primary-hover: #2563eb;
--khy-primary-active: #1d4ed8;
--khy-primary-light: #eff6ff;

/* 状态色 */
--khy-success: #10b981;
--khy-warning: #f59e0b;
--khy-danger: #ef4444;
--khy-info: #3b82f6;

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
```

### 字体系统

```css
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
```

### 间距系统

```css
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
```

### 圆角系统

```css
--khy-radius-sm: 0.25rem;   /* 4px */
--khy-radius: 0.5rem;       /* 8px */
--khy-radius-md: 0.75rem;   /* 12px */
--khy-radius-lg: 1rem;      /* 16px */
--khy-radius-xl: 1.5rem;    /* 24px */
--khy-radius-2xl: 2rem;     /* 32px */
--khy-radius-full: 9999px;
```

### 阴影系统

```css
--khy-shadow-sm: 0 1px 2px 0 rgb(0 0 0 / 0.05);
--khy-shadow: 0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1);
--khy-shadow-md: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1);
--khy-shadow-lg: 0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1);
--khy-shadow-xl: 0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1);
```

---

## 组件速查

### 按钮组件 (KhyButton)

```vue
<template>
  <!-- 基础用法 -->
  <KhyButton>默认按钮</KhyButton>
  <KhyButton variant="primary">主要按钮</KhyButton>
  <KhyButton variant="success">成功按钮</KhyButton>
  <KhyButton variant="warning">警告按钮</KhyButton>
  <KhyButton variant="danger">危险按钮</KhyButton>
  
  <!-- 不同大小 -->
  <KhyButton size="sm">小按钮</KhyButton>
  <KhyButton size="md">中按钮</KhyButton>
  <KhyButton size="lg">大按钮</KhyButton>
  
  <!-- 状态 -->
  <KhyButton disabled>禁用按钮</KhyButton>
  <KhyButton loading>加载中...</KhyButton>
  <KhyButton block>块级按钮</KhyButton>
</template>
```

**属性**：
| 属性 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| variant | String | 'default' | 按钮类型 |
| size | String | 'md' | 按钮大小 |
| disabled | Boolean | false | 是否禁用 |
| loading | Boolean | false | 是否加载中 |
| block | Boolean | false | 是否块级 |

### 输入框组件 (KhyInput)

```vue
<template>
  <!-- 基础用法 -->
  <KhyInput v-model="value" placeholder="请输入" />
  
  <!-- 带标签 -->
  <KhyInput v-model="value" label="用户名" placeholder="请输入用户名" />
  
  <!-- 带提示 -->
  <KhyInput v-model="value" hint="请输入有效的邮箱地址" />
  
  <!-- 带错误 -->
  <KhyInput v-model="value" error="此项为必填项" />
  
  <!-- 不同大小 -->
  <KhyInput v-model="value" size="sm" />
  <KhyInput v-model="value" size="md" />
  <KhyInput v-model="value" size="lg" />
</template>
```

**属性**：
| 属性 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| modelValue | String/Number | '' | 绑定值 |
| type | String | 'text' | 输入类型 |
| label | String | - | 标签 |
| placeholder | String | - | 占位符 |
| hint | String | - | 提示信息 |
| error | String | - | 错误信息 |
| disabled | Boolean | false | 是否禁用 |
| readonly | Boolean | false | 是否只读 |
| required | Boolean | false | 是否必填 |
| maxlength | Number | - | 最大长度 |
| size | String | 'md' | 尺寸 |

### 卡片组件 (KhyCard)

```vue
<template>
  <!-- 基础用法 -->
  <KhyCard>
    <p>卡片内容</p>
  </KhyCard>
  
  <!-- 带头部和底部 -->
  <KhyCard>
    <template #header>
      <h3>卡片标题</h3>
    </template>
    <p>卡片内容</p>
    <template #footer>
      <KhyButton>操作</KhyButton>
    </template>
  </KhyCard>
  
  <!-- 不同变体 -->
  <KhyCard variant="elevated">阴影卡片</KhyCard>
  <KhyCard variant="outlined">边框卡片</KhyCard>
</template>
```

**属性**：
| 属性 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| variant | String | 'default' | 卡片类型 |
| padding | String | 'md' | 内边距 |
| hoverable | Boolean | false | 是否可悬停 |
| clickable | Boolean | false | 是否可点击 |

---

## 布局速查

### 页面布局

```vue
<template>
  <div class="khy-page">
    <header class="khy-page-header">
      <slot name="header" />
    </header>
    <main class="khy-page-content">
      <slot />
    </main>
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
</style>
```

### 侧边栏布局

```vue
<template>
  <div class="khy-layout">
    <aside class="khy-sidebar">
      <slot name="sidebar" />
    </aside>
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

### 网格系统

```vue
<template>
  <div class="khy-grid">
    <div class="khy-col-6">半宽</div>
    <div class="khy-col-6">半宽</div>
  </div>
  
  <div class="khy-grid">
    <div class="khy-col-4">三分之一</div>
    <div class="khy-col-4">三分之一</div>
    <div class="khy-col-4">三分之一</div>
  </div>
</template>

<style scoped>
.khy-grid {
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  gap: var(--khy-space-4);
}

.khy-col-4 { grid-column: span 4; }
.khy-col-6 { grid-column: span 6; }
.khy-col-12 { grid-column: span 12; }
</style>
```

---

## 交互速查

### 动画

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

### 微交互

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
```

### 加载状态

```vue
<!-- 骨架屏 -->
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

---

## 响应式速查

### 断点

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

### 触控优化

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

### 响应式表格

```vue
<template>
  <div class="khy-responsive-table">
    <table>
      <thead>
        <tr>
          <th>姓名</th>
          <th>邮箱</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td data-label="姓名">张三</td>
          <td data-label="邮箱">zhangsan@example.com</td>
          <td data-label="操作">
            <KhyButton size="sm">编辑</KhyButton>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
@media (max-width: 639px) {
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

## 可访问性速查

### 语义化 HTML

```vue
<template>
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

### ARIA 属性

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

### 键盘导航

```vue
<template>
  <div role="tablist" @keydown="handleKeydown">
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

### 动画偏好

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

## 性能速查

### 代码分割

```javascript
// 路由懒加载
const routes = [
  {
    path: '/dashboard',
    component: () => import('@/views/Dashboard.vue')
  }
];

// 组件懒加载
const HeavyComponent = defineAsyncComponent(() => 
  import('@/components/HeavyComponent.vue')
);
```

### 图片优化

```vue
<template>
  <picture>
    <source :srcset="srcSetWebp" type="image/webp" />
    <source :srcset="srcSetJpg" type="image/jpeg" />
    <img
      :src="fallbackSrc"
      :alt="alt"
      loading="lazy"
      decoding="async"
    />
  </picture>
</template>
```

### 缓存策略

```javascript
// Pinia 缓存
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

---

## 测试速查

### 单元测试

```javascript
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import KhyButton from '../KhyButton.vue';

describe('KhyButton', () => {
  it('renders correctly', () => {
    const wrapper = mount(KhyButton, {
      slots: { default: 'Button' }
    });
    
    expect(wrapper.text()).toBe('Button');
  });
  
  it('emits click event', async () => {
    const wrapper = mount(KhyButton);
    
    await wrapper.trigger('click');
    
    expect(wrapper.emitted('click')).toBeTruthy();
  });
});
```

### 集成测试

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
  });
});
```

---

## 常见问题速查

### Q: 如何创建新组件？

**A**:
```vue
<template>
  <div :class="componentClasses">
    <slot />
  </div>
</template>

<script setup>
const props = defineProps({
  variant: {
    type: String,
    default: 'default'
  }
});

const componentClasses = computed(() => [
  'khy-component',
  `khy-component--${props.variant}`
]);
</script>

<style scoped>
.khy-component {
  /* 样式 */
}
</style>
```

### Q: 如何使用设计令牌？

**A**:
```css
.my-component {
  color: var(--khy-text-main);
  background: var(--khy-bg-elevated);
  padding: var(--khy-space-4);
  border-radius: var(--khy-radius);
  box-shadow: var(--khy-shadow);
}
```

### Q: 如何实现响应式布局？

**A**:
```css
.container {
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  gap: var(--khy-space-4);
}

.col {
  grid-column: span 12;
}

@media (min-width: 640px) {
  .col {
    grid-column: span 6;
  }
}

@media (min-width: 1024px) {
  .col {
    grid-column: span 4;
  }
}
```

### Q: 如何处理加载状态？

**A**:
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
```

---

## 相关文档

- `[DESIGN-FE-001]` 前端页面规范
- `[DESIGN-FE-002]` 前端组件库规范
- `[DESIGN-ARCH-072]` 项目规范化总纲

---

## 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-04 | 初始版本，提供前端快速参考 |

---

*本参考卡由 khy-os 前端团队维护*
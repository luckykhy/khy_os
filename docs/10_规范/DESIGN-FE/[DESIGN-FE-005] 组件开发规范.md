# [DESIGN-FE-005] 组件开发规范

> **定位**：组件结构 / Props / Events / Slots / 样式五节的写法约束。
> **隶属**：本文是 [`[DESIGN-FE-002]` 前端组件库规范]([DESIGN-FE-002] 前端组件库规范.md) 的**子篇**；主篇是唯一入口与 scope 裁决真源，本文只承载细则。
> **状态**：随主篇——主篇 §0 声明为「目标态、非现状」，本文同样在组件库真正落地后才生效；在此之前一切以 [`[DESIGN-FE-001]` 前端页面规范]([DESIGN-FE-001] 前端页面规范.md) 为准。

---


### 2.1 组件结构

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

### 2.2 Props 规范

**Props 定义**：
```javascript
const props = defineProps({
  // 必填属性
  value: {
    type: [String, Number],
    required: true
  },
  
  // 可选属性
  variant: {
    type: String,
    default: 'default',
    validator: (value) => ['default', 'primary', 'success'].includes(value)
  },
  
  // 复杂属性
  options: {
    type: Array,
    default: () => [],
    validator: (value) => value.every(item => item.label && item.value)
  },
  
  // 对象属性
  config: {
    type: Object,
    default: () => ({
      size: 'md',
      disabled: false
    })
  }
});
```

**Props 命名**：
- 使用 camelCase：`userName`、`isActive`
- 布尔类型以 `is`、`has`、`can` 开头：`isLoading`、`hasError`
- 事件处理以 `on` 开头：`onClick`、`onChange`

### 2.3 Events 规范

**Events 定义**：
```javascript
const emit = defineEmits([
  // 基础事件
  'click',
  'focus',
  'blur',
  
  // 带数据事件
  'change',
  'input',
  'submit',
  
  // 自定义事件
  'update:modelValue',
  'item-click',
  'selection-change'
]);
```

**Events 命名**：
- 使用 kebab-case：`item-click`、`selection-change`
- 双向绑定使用 `update:modelValue`
- 动词开头：`click`、`change`、`submit`

### 2.4 Slots 规范

**Slots 定义**：
```vue
<template>
  <div class="khy-component">
    <!-- 默认插槽 -->
    <div class="khy-component__content">
      <slot />
    </div>
    
    <!-- 具名插槽 -->
    <div v-if="$slots.header" class="khy-component__header">
      <slot name="header" />
    </div>
    
    <!-- 作用域插槽 -->
    <div class="khy-component__list">
      <slot
        v-for="item in items"
        :key="item.id"
        name="item"
        :item="item"
        :index="items.indexOf(item)"
      />
    </div>
  </div>
</template>
```

**Slots 命名**：
- 使用 kebab-case：`header`、`item`、`footer`
- 默认插槽无需命名
- 作用域插槽提供清晰的数据结构

### 2.5 样式规范

**样式组织**：
```vue
<style scoped>
/* 1. 基础样式 */
.khy-component {
  /* 布局 */
  display: flex;
  align-items: center;
  
  /* 盒模型 */
  padding: var(--khy-space-2);
  border: 1px solid var(--khy-gray-200);
  border-radius: var(--khy-radius);
  
  /* 排版 */
  font-size: var(--khy-text-base);
  color: var(--khy-text-main);
  
  /* 视觉 */
  background: var(--khy-bg-elevated);
  box-shadow: var(--khy-shadow-sm);
  
  /* 动画 */
  transition: all 0.2s ease;
}

/* 2. 变体样式 */
.khy-component--primary {
  background: var(--khy-primary);
  color: var(--khy-white);
}

/* 3. 尺寸样式 */
.khy-component--sm {
  padding: var(--khy-space-1);
  font-size: var(--khy-text-sm);
}

/* 4. 状态样式 */
.khy-component--disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 5. 子元素样式 */
.khy-component__header {
  margin-bottom: var(--khy-space-2);
}

/* 6. 修饰符样式 */
.khy-component--rounded {
  border-radius: var(--khy-radius-full);
}
</style>
```

**CSS 变量**：
```css
:root {
  /* 组件级变量 */
  --khy-component-bg: var(--khy-bg-elevated);
  --khy-component-border: var(--khy-gray-200);
  --khy-component-radius: var(--khy-radius);
  --khy-component-padding: var(--khy-space-2);
}
```

---

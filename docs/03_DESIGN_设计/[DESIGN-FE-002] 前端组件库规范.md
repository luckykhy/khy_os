# [DESIGN-FE-002] 前端组件库规范

> 本文档定义 khy-os 项目前端组件库的设计标准、开发规范和发布流程。

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

## 2. 组件开发规范

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

## 3. 组件 API 设计

### 3.1 基础组件 API

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
  // 按钮类型
  variant: {
    type: String,
    default: 'default',
    validator: (value) => ['default', 'primary', 'success', 'warning', 'danger', 'ghost'].includes(value)
  },
  // 按钮大小
  size: {
    type: String,
    default: 'md',
    validator: (value) => ['sm', 'md', 'lg'].includes(value)
  },
  // 是否禁用
  disabled: Boolean,
  // 是否加载中
  loading: Boolean,
  // 是否块级
  block: Boolean,
  // 图标
  icon: String
});

const emit = defineEmits(['click']);

const buttonClasses = computed(() => [
  'khy-button',
  `khy-button--${props.variant}`,
  `khy-button--${props.size}`,
  {
    'khy-button--block': props.block,
    'khy-button--loading': props.loading,
    'khy-button--icon-only': props.icon && !props.$slots.default
  }
]);

const handleClick = (event) => {
  if (!props.disabled && !props.loading) {
    emit('click', event);
  }
};
</script>
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
      <span v-if="$slots.prefix" class="khy-input__prefix">
        <slot name="prefix" />
      </span>
      <input
        ref="inputRef"
        :type="type"
        :value="modelValue"
        :placeholder="placeholder"
        :disabled="disabled"
        :readonly="readonly"
        :maxlength="maxlength"
        @input="handleInput"
        @change="handleChange"
        @focus="handleFocus"
        @blur="handleBlur"
      />
      <span v-if="$slots.suffix" class="khy-input__suffix">
        <slot name="suffix" />
      </span>
    </div>
    <p v-if="error" class="khy-input__error">{{ error }}</p>
    <p v-else-if="hint" class="khy-input__hint">{{ hint }}</p>
    <p v-if="maxlength" class="khy-input__count">
      {{ modelValue?.length || 0 }}/{{ maxlength }}
    </p>
  </div>
</template>

<script setup>
const props = defineProps({
  // 绑定值
  modelValue: {
    type: [String, Number],
    default: ''
  },
  // 输入类型
  type: {
    type: String,
    default: 'text'
  },
  // 标签
  label: String,
  // 占位符
  placeholder: String,
  // 提示信息
  hint: String,
  // 错误信息
  error: String,
  // 是否禁用
  disabled: Boolean,
  // 是否只读
  readonly: Boolean,
  // 是否必填
  required: Boolean,
  // 最大长度
  maxlength: Number,
  // 尺寸
  size: {
    type: String,
    default: 'md',
    validator: (value) => ['sm', 'md', 'lg'].includes(value)
  }
});

const emit = defineEmits(['update:modelValue', 'change', 'focus', 'blur']);

const inputRef = ref(null);

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

const handleChange = (event) => {
  emit('change', event.target.value);
};

const handleFocus = (event) => {
  emit('focus', event);
};

const handleBlur = (event) => {
  emit('blur', event);
};

// 暴露方法
defineExpose({
  focus: () => inputRef.value?.focus(),
  blur: () => inputRef.value?.blur(),
  select: () => inputRef.value?.select()
});
</script>
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
  // 卡片类型
  variant: {
    type: String,
    default: 'default',
    validator: (value) => ['default', 'elevated', 'outlined'].includes(value)
  },
  // 内边距
  padding: {
    type: String,
    default: 'md',
    validator: (value) => ['none', 'sm', 'md', 'lg'].includes(value)
  },
  // 是否可悬停
  hoverable: Boolean,
  // 是否可点击
  clickable: Boolean
});

const emit = defineEmits(['click']);

const cardClasses = computed(() => [
  'khy-card',
  `khy-card--${props.variant}`,
  `khy-card--padding-${props.padding}`,
  {
    'khy-card--hoverable': props.hoverable,
    'khy-card--clickable': props.clickable
  }
]);

const handleClick = (event) => {
  if (props.clickable) {
    emit('click', event);
  }
};
</script>
```

### 3.2 反馈组件 API

**Toast 组件 (KhyToast)**：
```vue
<template>
  <Teleport to="body">
    <Transition name="khy-toast">
      <div
        v-if="visible"
        :class="toastClasses"
        @mouseenter="pauseTimer"
        @mouseleave="resumeTimer"
      >
        <span class="khy-toast__icon">{{ icon }}</span>
        <div class="khy-toast__content">
          <p class="khy-toast__title">{{ title }}</p>
          <p v-if="message" class="khy-toast__message">{{ message }}</p>
        </div>
        <button
          v-if="closable"
          class="khy-toast__close"
          @click="close"
        >
          ×
        </button>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
const props = defineProps({
  // 类型
  type: {
    type: String,
    default: 'info',
    validator: (value) => ['success', 'warning', 'error', 'info'].includes(value)
  },
  // 标题
  title: {
    type: String,
    required: true
  },
  // 消息
  message: String,
  // 持续时间
  duration: {
    type: Number,
    default: 3000
  },
  // 是否可关闭
  closable: {
    type: Boolean,
    default: true
  },
  // 自动关闭
  autoClose: {
    type: Boolean,
    default: true
  }
});

const emit = defineEmits(['close']);

const visible = ref(false);
let timer = null;

const toastClasses = computed(() => [
  'khy-toast',
  `khy-toast--${props.type}`
]);

const icon = computed(() => {
  const icons = {
    success: '✓',
    warning: '⚠',
    error: '✕',
    info: 'ℹ'
  };
  return icons[props.type];
});

const show = () => {
  visible.value = true;
  if (props.autoClose) {
    startTimer();
  }
};

const close = () => {
  visible.value = false;
  emit('close');
};

const startTimer = () => {
  if (props.duration > 0) {
    timer = setTimeout(close, props.duration);
  }
};

const pauseTimer = () => {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
};

const resumeTimer = () => {
  if (props.autoClose) {
    startTimer();
  }
};

// 暴露方法
defineExpose({
  show,
  close
});
</script>
```

**Modal 组件 (KhyModal)**：
```vue
<template>
  <Teleport to="body">
    <Transition name="khy-modal">
      <div
        v-if="visible"
        class="khy-modal-overlay"
        @click.self="handleOverlayClick"
      >
        <div
          :class="modalClasses"
          :style="modalStyle"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="titleId"
        >
          <div class="khy-modal__header">
            <h2 :id="titleId" class="khy-modal__title">
              <slot name="title">{{ title }}</slot>
            </h2>
            <button
              v-if="closable"
              class="khy-modal__close"
              aria-label="关闭"
              @click="close"
            >
              ×
            </button>
          </div>
          <div class="khy-modal__body">
            <slot />
          </div>
          <div v-if="$slots.footer" class="khy-modal__footer">
            <slot name="footer" />
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
const props = defineProps({
  // 标题
  title: String,
  // 宽度
  width: {
    type: [String, Number],
    default: '500px'
  },
  // 是否可见
  modelValue: Boolean,
  // 是否可关闭
  closable: {
    type: Boolean,
    default: true
  },
  // 点击遮罩关闭
  closeOnOverlay: {
    type: Boolean,
    default: true
  },
  // 是否显示遮罩
  showOverlay: {
    type: Boolean,
    default: true
  },
  // 是否居中
  centered: Boolean
});

const emit = defineEmits(['update:modelValue', 'close', 'open']);

const visible = computed({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value)
});

const titleId = computed(() => `khy-modal-title-${Math.random().toString(36).substr(2, 9)}`);

const modalClasses = computed(() => [
  'khy-modal',
  {
    'khy-modal--centered': props.centered
  }
]);

const modalStyle = computed(() => ({
  width: typeof props.width === 'number' ? `${props.width}px` : props.width
}));

const handleOverlayClick = () => {
  if (props.closeOnOverlay) {
    close();
  }
};

const close = () => {
  visible.value = false;
  emit('close');
};

const open = () => {
  visible.value = true;
  emit('open');
};

// 暴露方法
defineExpose({
  open,
  close
});
</script>
```

### 3.3 数据组件 API

**Table 组件 (KhyTable)**：
```vue
<template>
  <div class="khy-table-wrapper">
    <table :class="tableClasses">
      <thead>
        <tr>
          <th
            v-for="column in columns"
            :key="column.key"
            :class="[
              'khy-table__th',
              {
                'khy-table__th--sortable': column.sortable,
                'khy-table__th--sorted': sortKey === column.key
              }
            ]"
            :style="{ width: column.width }"
            @click="handleSort(column)"
          >
            <div class="khy-table__th-content">
              <span>{{ column.title }}</span>
              <span v-if="column.sortable" class="khy-table__sort-icon">
                {{ getSortIcon(column.key) }}
              </span>
            </div>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="(row, index) in data"
          :key="row[rowKey] || index"
          :class="[
            'khy-table__row',
            {
              'khy-table__row--selected': isSelected(row),
              'khy-table__row--striped': striped && index % 2 === 1
            }
          ]"
          @click="handleRowClick(row)"
        >
          <td
            v-for="column in columns"
            :key="column.key"
            class="khy-table__td"
          >
            <slot
              :name="column.key"
              :row="row"
              :column="column"
              :value="row[column.key]"
            >
              {{ row[column.key] }}
            </slot>
          </td>
        </tr>
      </tbody>
    </table>
    
    <div v-if="loading" class="khy-table__loading">
      <slot name="loading">
        <div class="khy-table__spinner" />
      </slot>
    </div>
    
    <div v-if="data.length === 0 && !loading" class="khy-table__empty">
      <slot name="empty">
        <p>暂无数据</p>
      </slot>
    </div>
  </div>
</template>

<script setup>
const props = defineProps({
  // 数据源
  data: {
    type: Array,
    default: () => []
  },
  // 列配置
  columns: {
    type: Array,
    required: true
  },
  // 行键
  rowKey: {
    type: String,
    default: 'id'
  },
  // 是否可选择
  selectable: Boolean,
  // 选中的行
  selectedRows: {
    type: Array,
    default: () => []
  },
  // 是否斑马纹
  striped: Boolean,
  // 是否加载中
  loading: Boolean,
  // 排序
  sortable: Boolean
});

const emit = defineEmits([
  'row-click',
  'selection-change',
  'sort-change'
]);

const sortKey = ref('');
const sortOrder = ref('asc');

const tableClasses = computed(() => [
  'khy-table',
  {
    'khy-table--striped': props.striped,
    'khy-table--selectable': props.selectable,
    'khy-table--loading': props.loading
  }
]);

const isSelected = (row) => {
  return props.selectedRows.some(item => item[props.rowKey] === row[props.rowKey]);
};

const handleRowClick = (row) => {
  emit('row-click', row);
};

const handleSort = (column) => {
  if (!column.sortable) return;
  
  if (sortKey.value === column.key) {
    sortOrder.value = sortOrder.value === 'asc' ? 'desc' : 'asc';
  } else {
    sortKey.value = column.key;
    sortOrder.value = 'asc';
  }
  
  emit('sort-change', { key: sortKey.value, order: sortOrder.value });
};

const getSortIcon = (key) => {
  if (sortKey.value !== key) return '↕';
  return sortOrder.value === 'asc' ? '↑' : '↓';
};
</script>
```

---

## 4. 组件测试规范

### 4.1 单元测试

**测试文件结构**：
```
components/
├── KhyButton.vue
├── KhyButton.test.js
├── KhyInput.vue
└── KhyInput.test.js
```

**测试用例模板**：
```javascript
import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import KhyButton from '../KhyButton.vue';

describe('KhyButton', () => {
  // 基础渲染
  describe('rendering', () => {
    it('renders correctly with default props', () => {
      const wrapper = mount(KhyButton, {
        slots: { default: 'Button' }
      });
      
      expect(wrapper.text()).toBe('Button');
      expect(wrapper.classes()).toContain('khy-button');
      expect(wrapper.classes()).toContain('khy-button--default');
    });
    
    it('renders with variant', () => {
      const wrapper = mount(KhyButton, {
        props: { variant: 'primary' },
        slots: { default: 'Button' }
      });
      
      expect(wrapper.classes()).toContain('khy-button--primary');
    });
    
    it('renders with size', () => {
      const wrapper = mount(KhyButton, {
        props: { size: 'lg' },
        slots: { default: 'Button' }
      });
      
      expect(wrapper.classes()).toContain('khy-button--lg');
    });
  });
  
  // Props 验证
  describe('props', () => {
    it('validates variant prop', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      
      mount(KhyButton, {
        props: { variant: 'invalid' }
      });
      
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });
  
  // 事件处理
  describe('events', () => {
    it('emits click event', async () => {
      const wrapper = mount(KhyButton);
      
      await wrapper.trigger('click');
      
      expect(wrapper.emitted('click')).toBeTruthy();
      expect(wrapper.emitted('click')[0][0]).toBeInstanceOf(MouseEvent);
    });
    
    it('does not emit click when disabled', async () => {
      const wrapper = mount(KhyButton, {
        props: { disabled: true }
      });
      
      await wrapper.trigger('click');
      
      expect(wrapper.emitted('click')).toBeFalsy();
    });
    
    it('does not emit click when loading', async () => {
      const wrapper = mount(KhyButton, {
        props: { loading: true }
      });
      
      await wrapper.trigger('click');
      
      expect(wrapper.emitted('click')).toBeFalsy();
    });
  });
  
  // 插槽
  describe('slots', () => {
    it('renders default slot', () => {
      const wrapper = mount(KhyButton, {
        slots: { default: 'Custom Content' }
      });
      
      expect(wrapper.text()).toBe('Custom Content');
    });
    
    it('renders icon slot', () => {
      const wrapper = mount(KhyButton, {
        slots: {
          icon: '<span class="icon">🔍</span>'
        }
      });
      
      expect(wrapper.find('.icon').exists()).toBe(true);
    });
  });
  
  // 可访问性
  describe('accessibility', () => {
    it('has correct aria attributes when disabled', () => {
      const wrapper = mount(KhyButton, {
        props: { disabled: true }
      });
      
      expect(wrapper.attributes('disabled')).toBeDefined();
    });
    
    it('has correct aria attributes when loading', () => {
      const wrapper = mount(KhyButton, {
        props: { loading: true }
      });
      
      expect(wrapper.attributes('aria-busy')).toBe('true');
    });
  });
});
```

### 4.2 集成测试

**页面级测试**：
```javascript
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestingPinia } from '@pinia/testing';
import UserProfile from '../UserProfile.vue';

describe('UserProfile', () => {
  const createWrapper = (options = {}) => {
    return mount(UserProfile, {
      global: {
        plugins: [
          createTestingPinia({
            initialState: {
              user: {
                name: 'John Doe',
                email: 'john@example.com',
                avatar: 'https://example.com/avatar.jpg'
              }
            }
          })
        ],
        stubs: {
          KhyButton: false,
          KhyCard: false
        }
      },
      ...options
    });
  };
  
  it('displays user information', () => {
    const wrapper = createWrapper();
    
    expect(wrapper.text()).toContain('John Doe');
    expect(wrapper.text()).toContain('john@example.com');
  });
  
  it('renders avatar', () => {
    const wrapper = createWrapper();
    
    const avatar = wrapper.find('.user-avatar');
    expect(avatar.exists()).toBe(true);
    expect(avatar.attributes('src')).toBe('https://example.com/avatar.jpg');
  });
  
  it('emits logout event', async () => {
    const wrapper = createWrapper();
    
    await wrapper.find('[data-testid="logout-button"]').trigger('click');
    
    expect(wrapper.emitted('logout')).toBeTruthy();
  });
});
```

### 4.3 视觉回归测试

**Storybook 配置**：
```javascript
// Button.stories.js
export default {
  title: 'Components/Base/KhyButton',
  component: KhyButton,
  argTypes: {
    variant: {
      control: { type: 'select' },
      options: ['default', 'primary', 'success', 'warning', 'danger', 'ghost']
    },
    size: {
      control: { type: 'select' },
      options: ['sm', 'md', 'lg']
    },
    disabled: { control: 'boolean' },
    loading: { control: 'boolean' }
  }
};

const Template = (args) => ({
  components: { KhyButton },
  setup() {
    return { args };
  },
  template: '<KhyButton v-bind="args">{{ args.default }}</KhyButton>'
});

export const Default = Template.bind({});
Default.args = {
  default: 'Button',
  variant: 'default'
};

export const Primary = Template.bind({});
Primary.args = {
  default: 'Button',
  variant: 'primary'
};

export const Disabled = Template.bind({});
Disabled.args = {
  default: 'Button',
  variant: 'primary',
  disabled: true
};

export const Loading = Template.bind({});
Loading.args = {
  default: 'Button',
  variant: 'primary',
  loading: true
};
```

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

## 7. 组件质量保证

### 7.1 代码质量

**ESLint 规则**：
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
    'vue/require-default-prop': 'error',
    'vue/require-prop-types': 'error'
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

### 7.2 测试覆盖率

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

### 7.3 性能监控

**Bundle 大小**：
```javascript
// rollup.config.js
export default {
  output: {
    file: 'dist/khy-components.esm.js',
    format: 'esm',
    sourcemap: true
  },
  plugins: [
    visualizer({
      open: true,
      gzipSize: true
    })
  ]
};
```

**性能预算**：
```json
{
  "budgets": [
    {
      "type": "initial",
      "maximumWarning": "500kb",
      "maximumError": "1mb"
    },
    {
      "type": "anyComponentStyle",
      "maximumWarning": "2kb",
      "maximumError": "4kb"
    }
  ]
}
```

---

## 8. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-04 | 初始版本，定义前端组件库规范 |

---

*本规范由 khy-os 前端团队维护*
# [DESIGN-FE-006] 组件 API 设计 · 基础组件

> **定位**：基础组件（Button/Input/Card/Modal 等）的 API 目标态。
> **隶属**：本文是 [`[DESIGN-FE-002]` 前端组件库规范]([DESIGN-FE-002] 前端组件库规范.md) 的**子篇**；主篇是唯一入口与 scope 裁决真源，本文只承载细则。
> **状态**：随主篇——主篇 §0 声明为「目标态、非现状」，本文同样在组件库真正落地后才生效；在此之前一切以 [`[DESIGN-FE-001]` 前端页面规范]([DESIGN-FE-001] 前端页面规范.md) 为准。

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

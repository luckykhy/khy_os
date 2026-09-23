# [DESIGN-FE-007] 组件 API 设计 · 反馈组件

> **定位**：反馈组件（Toast/Alert/Skeleton/Empty 等）的 API 目标态。
> **隶属**：本文是 [`[DESIGN-FE-002]` 前端组件库规范]([DESIGN-FE-002] 前端组件库规范.md) 的**子篇**；主篇是唯一入口与 scope 裁决真源，本文只承载细则。
> **状态**：随主篇——主篇 §0 声明为「目标态、非现状」，本文同样在组件库真正落地后才生效；在此之前一切以 [`[DESIGN-FE-001]` 前端页面规范]([DESIGN-FE-001] 前端页面规范.md) 为准。

---


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

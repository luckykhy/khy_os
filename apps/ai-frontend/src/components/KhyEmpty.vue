<template>
  <div class="khy-empty" :class="{ 'is-compact': compact }">
    <div class="khy-empty__halo">
      <KhyIcon
        v-if="icon === KY_ICON_CMP"
        :kind="iconProps.kind || 'info'"
        :size="iconProps.size || 'lg'"
        :color="iconProps.color"
        :glow="iconProps.glow !== false"
      />
      <el-icon v-else-if="icon" class="khy-empty__icon"><component :is="icon" /></el-icon>
    </div>
    <p class="khy-empty__title">{{ title }}</p>
    <p v-if="description" class="khy-empty__desc">{{ description }}</p>
    <div v-if="$slots.action" class="khy-empty__action">
      <slot name="action" />
    </div>
  </div>
</template>

<script setup>
// KhyEmpty — 统一空状态。默认图标使用 KhyIcon（khy 品牌 SVG），
// 保留对 Element Plus 图标的兼容。

import { markRaw } from 'vue';
import KhyIcon from './KhyIcon.vue';

const KY_ICON_CMP = markRaw(KhyIcon);

defineProps({
  icon: { type: [Object, Function], default: () => markRaw(KhyIcon) },
  iconProps: { type: Object, default: () => ({ kind: 'info' }) },
  // 主文案:说清"此刻为空",语气温和。
  title: { type: String, default: '这里暂时还是空的' },
  // 辅助文案:告诉用户"下一步能做什么",提供方向感。
  description: { type: String, default: '' },
  // 紧凑模式:嵌在卡片 / 表格里时收窄留白。
  compact: { type: Boolean, default: false },
});
</script>

<style scoped>
.khy-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 40px 24px;
  gap: 10px;
}
.khy-empty.is-compact {
  padding: 24px 16px;
  gap: 8px;
}
.khy-empty__halo {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 64px;
  height: 64px;
  border-radius: 50%;
  background: radial-gradient(circle at 50% 40%, var(--khy-primary-soft), transparent 72%);
  border: 1px solid var(--khy-border-light);
  transition:
    transform 0.3s ease,
    box-shadow 0.3s ease;
}
.khy-empty.is-compact .khy-empty__halo {
  width: 48px;
  height: 48px;
}
.khy-empty:hover .khy-empty__halo {
  transform: translateY(-2px);
  box-shadow: 0 8px 22px var(--khy-primary-soft);
}
.khy-empty__icon,
.khy-empty__icon :deep(.khy-icon) {
  font-size: 28px;
}
.khy-empty.is-compact .khy-empty__icon,
.khy-empty.is-compact .khy-empty__icon :deep(.khy-icon) {
  font-size: 22px;
}
.khy-empty__title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--khy-text-strong);
}
.khy-empty__desc {
  margin: 0;
  max-width: 340px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--khy-text-muted);
}
.khy-empty__action {
  margin-top: 6px;
}
@media (prefers-reduced-motion: reduce) {
  .khy-empty__halo,
  .khy-empty:hover .khy-empty__halo {
    transition: none;
    transform: none;
  }
}
</style>

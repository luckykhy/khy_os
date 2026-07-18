<template>
  <div class="khy-empty" :class="{ 'is-compact': compact }">
    <div class="khy-empty__halo">
      <el-icon class="khy-empty__icon"><component :is="icon" /></el-icon>
    </div>
    <p class="khy-empty__title">{{ title }}</p>
    <p v-if="description" class="khy-empty__desc">{{ description }}</p>
    <div v-if="$slots.action" class="khy-empty__action">
      <slot name="action" />
    </div>
  </div>
</template>

<script setup>
// KhyEmpty — 统一空状态。刻意不用"空箱子 / 机器人插画"这类 AI 套路插图,而是
// 一枚柔和光晕里的语义图标 + 一句有温度、贴合业务的引导文案 + 可选行动入口。
// 目的:把"这里空空如也"变成"接下来可以做什么"。纯展示,全部走 --khy-* token,
// 亮/暗主题与减弱动效自动适配。
import { markRaw } from 'vue'
import { InfoFilled } from '@element-plus/icons-vue'

defineProps({
  // 传入 Element Plus 图标组件(如 Cpu / Connection / Box)。默认信息图标。
  icon: { type: [Object, Function], default: () => markRaw(InfoFilled) },
  // 主文案:说清"此刻为空",语气温和。
  title: { type: String, default: '这里暂时还是空的' },
  // 辅助文案:告诉用户"下一步能做什么",提供方向感。
  description: { type: String, default: '' },
  // 紧凑模式:嵌在卡片 / 表格里时收窄留白。
  compact: { type: Boolean, default: false },
})
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
  transition: transform 0.3s ease, box-shadow 0.3s ease;
}
.khy-empty.is-compact .khy-empty__halo {
  width: 48px;
  height: 48px;
}
.khy-empty:hover .khy-empty__halo {
  transform: translateY(-2px);
  box-shadow: 0 8px 22px var(--khy-primary-soft);
}
.khy-empty__icon {
  font-size: 28px;
  color: var(--khy-primary);
}
.khy-empty.is-compact .khy-empty__icon {
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

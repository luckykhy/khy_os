<template>
  <div class="khy-page-head">
    <div class="khy-page-head__text">
      <h2 class="khy-page-title">{{ title }}</h2>
      <p v-if="subtitle" class="khy-page-head__sub">{{ subtitle }}</p>
    </div>
    <div v-if="$slots.actions" class="khy-page-head__actions">
      <slot name="actions" />
    </div>
  </div>
</template>

<script setup>
// KhyPageHeader — 统一页头(单一真源)。此前各视图各自手写 `.page-head` 行
// (标题 + 副标题 + 右侧动作簇),布局 CSS 在 ~8 个视图里重复漂移。此组件把这套
// 样板收敛到一处:复用全局 `.khy-page-title`(色/字距一致),自带副标题与右侧
// 动作区布局。纯展示,全部走 --khy-* token,亮/暗主题自动适配。
//
// 用法:
//   <KhyPageHeader title="页面标题" subtitle="一句话说明这个页面能做什么">
//     <template #actions><el-button>动作</el-button></template>
//   </KhyPageHeader>
defineProps({
  // 页面主标题(必填)。渲染为全局 utility 类 .khy-page-title 的 <h2>。
  title: { type: String, required: true },
  // 可选副标题:一句话说明本页用途,弱化色。
  subtitle: { type: String, default: '' },
})
</script>

<style scoped>
.khy-page-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 18px;
}
/* 中和全局 .khy-page-title 的 18px 下边距(此处由容器统一管理间距)。 */
.khy-page-head .khy-page-title {
  margin: 0;
}
.khy-page-head__sub {
  margin: 4px 0 0;
  color: var(--khy-text-secondary);
  font-size: 13px;
  line-height: 1.5;
}
.khy-page-head__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
@media (max-width: 640px) {
  .khy-page-head {
    flex-direction: column;
    align-items: stretch;
  }
  .khy-page-head__actions {
    flex-wrap: wrap;
  }
}
</style>

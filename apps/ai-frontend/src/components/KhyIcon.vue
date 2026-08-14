<template>
  <span
    class="khy-icon"
    :class="[`khy-icon--${props.size}`, { 'khy-icon--no-glow': !props.glow }]"
    :style="cssVars"
    role="img"
    :aria-label="props.ariaLabel || props.kind"
  >
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path v-for="(d, i) in paths" :key="i" v-bind="pathAttrs" :d="d" />
    </svg>
  </span>
</template>

<script setup>
import { computed } from 'vue';
/**
 * KhyIcon — khy 品牌专属图标系统。
 *
 * 设计语言：
 *  - 圆润端点 (round caps/joins)、单线 stroke、品牌蓝 #2f7ef7
 *  - 24×24 viewBox、stroke-width 1.8、可配置 glow 光晕
 *  - 全部 SVG path 内联，零外部图标库依赖
 */

const props = defineProps({
  kind: { type: String, default: 'info' },
  size: { type: String, default: 'md' },
  color: { type: String, default: '' },
  glow: { type: Boolean, default: true },
  ariaLabel: { type: String, default: '' },
});

const SIZES = { xs: 14, sm: 18, md: 22, lg: 26, xl: 32 };

// Single-stroke round-caps paths for each semantic icon
const ICONS = {
  info: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z',
  connection:
    'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-1-13h2v6h-2zm0 8h2v2h-2z',
  key: 'M12.65 10A5.99 5.99 0 0 0 7 6H6v6h6v1.65A6 6 0 1 0 12.65 10zm0 10A4 4 0 1 1 17 12a4 4 0 0 1-4 4zM17 6h-1V5h-2v1h-1a3 3 0 0 0 0 6h1v2h2v-2h1a3 3 0 0 0 0-6z',
  refresh:
    'M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 8 8h-2A6 6 0 1 1 12 6h2.65L11 3.35 8.65 5.7 12 9.05V12H4v2h8v2.95l3.35-3.35 1.3 1.3z',
  guide:
    'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm0-5c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm0-4.5c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1z',
  cpu: 'M6 2h12a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm7 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  chat: 'M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z',
  user: 'M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z',
  link: 'M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7a4.4 4.4 0 0 0 0 8h.1a4.4 4.4 0 0 0 3.1 3.1v.1a3.1 3.1 0 0 1-3.1 3.1H7V20h4a4.4 4.4 0 0 0 3.1-3.1 3.1 3.1 0 0 1-3.1-3.1zM13 7h5v5h-5z',
  success:
    'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z',
  warning: 'M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z',
  error:
    'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z',
  search:
    'M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z',
  coins:
    'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-2-5.5l6-4.5-6-4.5v9z',
  grid: 'M4 4h7v7H4zm9 0h7v7h-7zm0 9h7v7h-7zM4 13h7v7H4z',
  tools:
    'M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.6-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1.1.1-1.4z',
  data: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm14 14V5H5v12h14zM7 7h4v4H7zm6 0h4v4h-4zM7 13h4v4H7zm6 0h4v4h-4z',
  monitor:
    'M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v4h2v-4h8v4h2v-4h5c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z',
  folder: 'M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z',
  shopping:
    'M7 18c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm10 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zM7.17 14.75l.03-.12.9-1.63h7.45c.75 0 1.41-.41 1.75-1.03l3.58-6.49A1.003 1.003 0 0 0 20 4H5.21l-.94-2H1v2h2l3.6 7.59-1.35 2.44C4.52 15.37 5.48 17 7 17h12v-2H7.42c-.14 0-.25-.11-.25-.25z',
  compass:
    'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-5.5-2.5l7.51-3.49L17 6.5l-7.51 3.49L6.5 17z',
  lock: 'M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zM12 17c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1s3.1 1.39 3.1 3.1v2z',
  wallet:
    'M21 7H3a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2zm-2 10H5V9h14v8zM7 12h2v2H7z',
  home: 'M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z',
  warningAlt: 'M12 2L1 21h22L12 2zm0 3.83L19.53 19H4.47L12 5.83zM11 16h2v2h-2zm0-6h2v4h-2v-4z',
  help: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm0-4c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm0-4.5c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1z',
  settings:
    'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z',
};

const paths = computed(() => ICONS[props.kind] || ICONS.info);

const cssVars = computed(() => {
  const s = SIZES[props.size] ?? SIZES.md;
  const c = props.color || 'var(--khy-primary, #2f7ef7)';
  return { '--khy-icon-size': `${s}px`, '--khy-icon-color': c };
});

const pathAttrs = computed(() => ({
  stroke: props.color || 'var(--khy-primary, #2f7ef7)',
  'stroke-width': 1.8,
  'stroke-linecap': 'round',
  'stroke-linejoin': 'round',
  fill: 'none',
}));
</script>

<style scoped>
.khy-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--khy-icon-size, 22px);
  height: var(--khy-icon-size, 22px);
  flex-shrink: 0;
  vertical-align: -0.125em;
}
.khy-icon svg {
  width: 100%;
  height: 100%;
  transition:
    filter 0.2s ease,
    opacity 0.2s ease;
}
.khy-icon:not(.khy-icon--no-glow) svg {
  filter: drop-shadow(0 0 4px var(--khy-icon-color, #2f7ef7))
    drop-shadow(0 0 1px var(--khy-icon-color, #2f7ef7));
}
.khy-icon--no-glow svg {
  filter: none;
}

/* size shortcuts */
.khy-icon--xs {
  --khy-icon-size: 14px;
}
.khy-icon--sm {
  --khy-icon-size: 18px;
}
.khy-icon--md {
  --khy-icon-size: 22px;
}
.khy-icon--lg {
  --khy-icon-size: 26px;
}
.khy-icon--xl {
  --khy-icon-size: 32px;
}
</style>

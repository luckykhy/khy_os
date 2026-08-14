/**
 * useResponsive.js — Responsive layout composable
 *
 * Provides reactive isMobile/isDesktop flags based on viewport width.
 * Used by SimpleTradingInterface.vue and Trading.vue.
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'

const MOBILE_BREAKPOINT = 768

export function useResponsive() {
  const windowWidth = ref(typeof window !== 'undefined' ? window.innerWidth : 1200)

  function onResize() {
    windowWidth.value = window.innerWidth
  }

  onMounted(() => {
    window.addEventListener('resize', onResize)
  })

  onUnmounted(() => {
    window.removeEventListener('resize', onResize)
  })

  const isMobile = computed(() => windowWidth.value < MOBILE_BREAKPOINT)
  const isDesktop = computed(() => windowWidth.value >= MOBILE_BREAKPOINT)

  return { isMobile, isDesktop, windowWidth }
}

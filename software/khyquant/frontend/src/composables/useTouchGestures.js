/**
 * useTouchGestures.js — Mobile touch gesture handling composable
 *
 * Provides touch event handlers for drawer drag interactions on mobile.
 * Used by SimpleTradingInterface.vue.
 */
import { ref } from 'vue'

export function useTouchGestures(options = {}) {
  const {
    onSwipeLeft,
    onSwipeRight,
    onSwipeUp,
    onSwipeDown,
    threshold = 50,
  } = options

  const touchStartX = ref(0)
  const touchStartY = ref(0)
  const isDragging = ref(false)

  function onTouchStart(e) {
    const touch = e.touches?.[0]
    if (!touch) return
    touchStartX.value = touch.clientX
    touchStartY.value = touch.clientY
    isDragging.value = true
  }

  function onTouchMove(e) {
    if (!isDragging.value) return
    const touch = e.touches?.[0]
    if (!touch) return
    const dx = touch.clientX - touchStartX.value
    const dy = touch.clientY - touchStartY.value

    if (Math.abs(dx) > threshold && Math.abs(dx) > Math.abs(dy)) {
      if (dx > 0 && onSwipeRight) onSwipeRight(e)
      else if (dx < 0 && onSwipeLeft) onSwipeLeft(e)
      isDragging.value = false
    } else if (Math.abs(dy) > threshold && Math.abs(dy) > Math.abs(dx)) {
      if (dy > 0 && onSwipeDown) onSwipeDown(e)
      else if (dy < 0 && onSwipeUp) onSwipeUp(e)
      isDragging.value = false
    }
  }

  function onTouchEnd() {
    isDragging.value = false
  }

  return {
    isDragging,
    touchHandlers: {
      onTouchStart,
      onTouchMove,
      onTouchEnd,
    },
    onTouchStart,
    onTouchMove,
    onTouchEnd,
  }
}

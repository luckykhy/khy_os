import { ref, onMounted, onUnmounted } from 'vue'

/**
 * Lightweight composable wrapping navigator.onLine + online/offline events.
 * Used by OfflineIndicator to show a banner when the browser loses connectivity.
 */
export function useOnlineStatus() {
  const isOnline = ref(typeof navigator !== 'undefined' ? navigator.onLine : true)

  function handleOnline() { isOnline.value = true }
  function handleOffline() { isOnline.value = false }

  onMounted(() => {
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
  })

  onUnmounted(() => {
    window.removeEventListener('online', handleOnline)
    window.removeEventListener('offline', handleOffline)
  })

  return { isOnline }
}

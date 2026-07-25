import { computed, ref } from 'vue'

// Single source of truth for "is the app currently waiting on something".
// Two independent signals are merged so neither can mask the other:
//   - httpPending: a balanced in-flight counter incremented/decremented by the
//     axios interceptors (one ++ per request, one -- per settle, retries included).
//   - routeLoading: a boolean toggled by the router around navigation + lazy
//     chunk download. A boolean (not a counter) avoids leaks when a guard issues
//     redirects (many beforeEach, a single afterEach).
// The top progress bar (GlobalProgressBar.vue) renders whenever isLoading is true.
const httpPending = ref(0)
const routeLoading = ref(false)

const isLoading = computed(() => httpPending.value > 0 || routeLoading.value)

export function httpStart() {
  httpPending.value += 1
}

export function httpDone() {
  httpPending.value = Math.max(0, httpPending.value - 1)
}

export function routeStart() {
  routeLoading.value = true
}

export function routeDone() {
  routeLoading.value = false
}

export function useGlobalLoading() {
  return { isLoading, httpPending, routeLoading }
}

import { ref } from 'vue'
import request from '@/api/request'

/**
 * Composable for futures tick data (available dates & symbols).
 * Used by DataReplay.vue and Trading.vue.
 *
 * Exports:
 *   availableDates  - ref([])  list of date strings
 *   availableSymbols - ref([]) list of symbol strings
 *   loading         - ref(false)
 *   loadDates()     - fetch available dates from backend
 *   loadSymbols(date) - fetch available symbols for a given date
 *   refreshIndex()  - reload dates (alias for loadDates)
 *   formatDate(d)   - format a date string for display
 */
export function useFuturesTickData() {
  const availableDates = ref([])
  const availableSymbols = ref([])
  const loading = ref(false)

  /**
   * Load available tick data dates from the backend.
   */
  async function loadDates() {
    loading.value = true
    try {
      const res = await request.get('/futures-tick/dates')
      if (res.data && Array.isArray(res.data.data)) {
        availableDates.value = res.data.data
      } else if (res.data && Array.isArray(res.data.dates)) {
        availableDates.value = res.data.dates
      } else if (res.data && Array.isArray(res.data)) {
        availableDates.value = res.data
      } else {
        availableDates.value = []
      }
    } catch (err) {
      console.warn('[useFuturesTickData] loadDates failed:', err.message)
      availableDates.value = []
    } finally {
      loading.value = false
    }
  }

  /**
   * Load available symbols for a given date.
   * @param {string} date
   */
  async function loadSymbols(date) {
    if (!date) return
    loading.value = true
    try {
      const res = await request.get('/futures-tick/symbols', { params: { date } })
      if (res.data && Array.isArray(res.data.data)) {
        availableSymbols.value = res.data.data
      } else if (res.data && Array.isArray(res.data.symbols)) {
        availableSymbols.value = res.data.symbols
      } else if (res.data && Array.isArray(res.data)) {
        availableSymbols.value = res.data
      } else {
        availableSymbols.value = []
      }
    } catch (err) {
      console.warn('[useFuturesTickData] loadSymbols failed:', err.message)
      availableSymbols.value = []
    } finally {
      loading.value = false
    }
  }

  /**
   * Refresh the date index (alias for loadDates).
   */
  async function refreshIndex() {
    await loadDates()
  }

  /**
   * Format a date string (YYYYMMDD or YYYY-MM-DD) for display.
   * @param {string} d
   * @returns {string}
   */
  function formatDate(d) {
    if (!d) return ''
    const s = String(d).replace(/-/g, '')
    if (s.length === 8) {
      return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
    }
    return d
  }

  return {
    availableDates,
    availableSymbols,
    loading,
    loadDates,
    loadSymbols,
    refreshIndex,
    formatDate,
  }
}

import { defineStore } from 'pinia';
import { ref, computed } from 'vue';

/**
 * guiEval — Pinia store for GUI Eval platform.
 * Manages selected task/run state and filter presets across sub-pages.
 */
export const useGuiEvalStore = defineStore('guiEval', () => {
  // ── Selection ──────────────────────────────────────────────────
  const selectedTaskId = ref(null);
  const selectedRunId = ref(null);

  // ── Filters ────────────────────────────────────────────────────
  const taskFilters = ref({ status: '', difficulty: '', q: '' });
  const runFilters = ref({ status: '', verdict: '' });

  // ── Derived ────────────────────────────────────────────────────
  const hasSelection = computed(() => !!selectedTaskId.value || !!selectedRunId.value);

  // ── Actions ────────────────────────────────────────────────────
  function selectTask(id) {
    selectedTaskId.value = id;
    selectedRunId.value = null;
  }
  function selectRun(id) {
    selectedRunId.value = id;
    selectedTaskId.value = null;
  }
  function clearSelection() {
    selectedTaskId.value = null;
    selectedRunId.value = null;
  }

  return {
    // State
    selectedTaskId,
    selectedRunId,
    taskFilters,
    runFilters,
    // Derived
    hasSelection,
    // Actions
    selectTask,
    selectRun,
    clearSelection,
  };
});

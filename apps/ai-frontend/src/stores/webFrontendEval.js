import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { webFrontendEvalApi } from '@/api/webFrontendEval';

export const useWebFrontendEvalStore = defineStore('webFrontendEval', () => {
  // ── State ─────────────────────────────────────────────────────
  const selectedTaskId = ref(null);
  const selectedRunId = ref(null);
  const taskFilters = ref({ level: '', category: '', status: '', q: '' });
  const runFilters = ref({ status: '', taskId: '' });
  const loading = ref(false);

  // ── Getters ───────────────────────────────────────────────────
  const selectedTask = computed(() => selectedTaskId.value);
  const selectedRun = computed(() => selectedRunId.value);
  const hasTaskSelection = computed(() => !!selectedTaskId.value);
  const hasRunSelection = computed(() => !!selectedRunId.value);

  // ── Actions ───────────────────────────────────────────────────
  function selectTask(id) {
    selectedTaskId.value = id;
  }
  function clearTaskSelection() {
    selectedTaskId.value = null;
  }

  function selectRun(id) {
    selectedRunId.value = id;
  }
  function clearRunSelection() {
    selectedRunId.value = null;
  }

  function clearAll() {
    selectedTaskId.value = null;
    selectedRunId.value = null;
  }

  async function loadTasks(opts = {}) {
    loading.value = true;
    try {
      const params = { ...taskFilters.value, ...opts };
      Object.keys(params).forEach((k) => !params[k] && delete params[k]);
      const { data } = await webFrontendEvalApi.listTasks(params);
      return data?.data || data;
    } finally {
      loading.value = false;
    }
  }

  async function loadRuns(opts = {}) {
    loading.value = true;
    try {
      const params = { ...runFilters.value, ...opts };
      Object.keys(params).forEach((k) => !params[k] && delete params[k]);
      const { data } = await webFrontendEvalApi.listRuns(params);
      return data?.data || data;
    } finally {
      loading.value = false;
    }
  }

  async function loadStats() {
    const { data } = await webFrontendEvalApi.getStats();
    return data?.data || data;
  }

  async function loadLevels() {
    const { data } = await webFrontendEvalApi.getLevels();
    return data?.data || data;
  }

  async function loadCategories() {
    const { data } = await webFrontendEvalApi.getCategories();
    return data?.data || data;
  }

  return {
    // state
    selectedTaskId,
    selectedRunId,
    taskFilters,
    runFilters,
    loading,
    // getters
    selectedTask,
    selectedRun,
    hasTaskSelection,
    hasRunSelection,
    // actions
    selectTask,
    clearTaskSelection,
    selectRun,
    clearRunSelection,
    clearAll,
    loadTasks,
    loadRuns,
    loadStats,
    loadLevels,
    loadCategories,
  };
});

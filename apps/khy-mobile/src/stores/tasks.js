import { defineStore } from 'pinia';
import { ref } from 'vue';
import * as scheduler from '@/api/taskScheduler';

export const useTasksStore = defineStore('mobile-tasks', () => {
  const tasks = ref([]);
  const loading = ref(false);
  let unsub = null;

  async function refresh() {
    loading.value = true;
    try {
      tasks.value = await scheduler.listTasks();
    } finally {
      loading.value = false;
    }
  }

  function start() {
    if (unsub) return;
    scheduler.startScheduler();
    refresh();
    unsub = scheduler.subscribe((next) => { tasks.value = next; });
  }

  function stop() {
    if (unsub) { unsub(); unsub = null; }
    scheduler.stopScheduler();
  }

  async function createTask(partial) {
    const id = `t_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const task = await scheduler.upsertTask({ id, ...partial });
    await refresh();
    return task;
  }

  async function updateTask(id, patch) {
    const t = tasks.value.find((x) => x.id === id);
    if (!t) return;
    return scheduler.upsertTask({ ...t, ...patch });
  }

  async function removeTask(id) {
    await scheduler.removeTask(id);
    await refresh();
  }

  async function trigger(id) {
    await scheduler.triggerTask(id);
  }

  async function setStatus(id, status) {
    await scheduler.setTaskStatus(id, status);
  }

  async function clearHistory(id) {
    await scheduler.clearHistory(id);
  }

  async function syncNow() {
    return scheduler.tryBackendSync();
  }

  return {
    tasks, loading, refresh, start, stop,
    createTask, updateTask, removeTask, trigger, setStatus, clearHistory, syncNow,
  };
});

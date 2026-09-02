import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import {
  bumpPromptUse,
  listPrompts,
  removePrompt,
  upsertPrompt,
} from '@/api/localDb';
import {
  approveRemotePrompt,
  createRemotePrompt,
  fetchBuiltinPrompts,
  fetchRemotePrompts,
  removeRemotePrompt,
  updateRemotePrompt,
  useRemotePrompt,
} from '@/api/prompts';
import { operationStatus } from '@/api/status';

// Prompts store: local prompt library merged with khy-os sync. Local prompts
// work offline; remote prompts (source 'khyos_sync') refresh from the backend
// and can be pushed back up.

export const usePromptsStore = defineStore('mobile-prompts', () => {
  const prompts = ref([]);
  const builtin = ref([]);
  const keyword = ref('');
  const status = ref(operationStatus('读取', '提示词库', '等待开始'));
  const error = ref('');
  const syncing = ref(false);

  const filtered = computed(() => {
    const q = keyword.value.trim().toLowerCase();
    if (!q) return prompts.value;
    return prompts.value.filter(
      (item) =>
        item.title.toLowerCase().includes(q) ||
        item.content.toLowerCase().includes(q) ||
        (item.category || '').toLowerCase().includes(q) ||
        (item.tags || []).some((tag) => String(tag).toLowerCase().includes(q))
    );
  });

  async function refresh() {
    status.value = operationStatus('读取', '提示词库', '进行中');
    try {
      prompts.value = await listPrompts();
      status.value = operationStatus('读取', '提示词库', '已更新', 'success');
    } catch (cause) {
      error.value = cause.message || '读取提示词库失败';
      status.value = operationStatus('读取', '提示词库', '失败', 'error');
    }
  }

  async function loadBuiltin() {
    try {
      builtin.value = await fetchBuiltinPrompts();
    } catch {
      builtin.value = [];
    }
  }

  async function addLocal(prompt) {
    const saved = await upsertPrompt({ ...prompt, source: prompt.source || 'custom' });
    await refresh();
    return saved;
  }

  async function update(prompt) {
    const saved = await upsertPrompt(prompt);
    if (prompt.id && prompt.source === 'khyos_sync' && !prompt.id.startsWith('builtin-')) {
      try {
        await updateRemotePrompt(prompt.id, {
          title: prompt.title,
          content: prompt.content,
          category: prompt.category || null,
          tags: prompt.tags || [],
        });
      } catch { /* keep local copy as fallback */ }
    }
    await refresh();
    return saved;
  }

  async function remove(id) {
    await removePrompt(id);
    const remoteId = id.startsWith('builtin-') ? null : id;
    if (remoteId) {
      try { await removeRemotePrompt(remoteId); } catch { /* local only */ }
    }
    await refresh();
  }

  async function use(id) {
    const prompt = prompts.value.find((item) => item.id === id);
    await bumpPromptUse(id);
    if (prompt?.source === 'khyos_sync' && !id.startsWith('builtin-')) {
      try { await useRemotePrompt(id); } catch { /* local only */ }
    }
    await refresh();
  }

  async function syncFromRemote() {
    syncing.value = true;
    status.value = operationStatus('同步', 'khy-os 提示词库', '进行中');
    try {
      const remote = await fetchRemotePrompts({ status: 'active' });
      const local = await listPrompts();
      const localByContent = new Map(local.map((item) => [item.content, item]));
      const merged = [...local];
      for (const item of remote) {
        const content = String(item.content || '').trim();
        if (!content) continue;
        const existing = localByContent.get(content);
        if (existing) {
          const index = merged.findIndex((m) => m.id === existing.id);
          if (index >= 0) {
            merged[index] = {
              ...existing,
              title: item.title || existing.title,
              category: item.category || existing.category,
              tags: item.tags && item.tags.length ? item.tags : existing.tags,
              source: existing.source === 'khyos_sync' ? 'khyos_sync' : 'khyos_sync',
              id: existing.id.startsWith('builtin-') ? `khyos-${item.id}` : existing.id,
            };
          }
        } else {
          merged.push({
            id: `khyos-${item.id}`,
            title: item.title || '同步提示词',
            content,
            category: item.category || '同步',
            tags: Array.isArray(item.tags) ? item.tags : [],
            source: 'khyos_sync',
            useCount: Number(item.usedCount || 0),
            createdAt: item.createdAt || new Date().toISOString(),
          });
        }
      }
      for (const prompt of merged) {
        await upsertPrompt(prompt);
      }
      await refresh();
      await loadBuiltin();
      status.value = operationStatus('同步', 'khy-os 提示词库', '已完成', 'success');
    } catch (cause) {
      error.value = cause.message || '同步提示词库失败';
      status.value = operationStatus('同步', 'khy-os 提示词库', '失败', 'error');
    } finally {
      syncing.value = false;
    }
  }

  async function pushToRemote(prompt) {
    const created = await createRemotePrompt({
      title: prompt.title,
      content: prompt.content,
      category: prompt.category || null,
      tags: prompt.tags || [],
    });
    await upsertPrompt({ ...prompt, id: `khyos-${created.id}`, source: 'khyos_sync' });
    await refresh();
    return created;
  }

  async function approvePending(id) {
    const remoteId = id.startsWith('khyos-') ? id.slice('khyos-'.length) : id;
    try {
      await approveRemotePrompt(remoteId);
    } catch { /* fall through */ }
    await syncFromRemote();
  }

  return {
    prompts,
    builtin,
    keyword,
    filtered,
    status,
    error,
    syncing,
    refresh,
    loadBuiltin,
    addLocal,
    update,
    remove,
    use,
    syncFromRemote,
    pushToRemote,
    approvePending,
  };
});

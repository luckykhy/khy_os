import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import {
  appendMessage,
  createConversation,
  getConversation,
  listConversations,
  listMessages,
  removeConversation,
  updateConversation,
  updateMessage,
} from '@/api/localDb';

// Conversations store: local multi-session management backed by Preferences.
// Each conversation runs in either 'remote' (through khy-os gateway) or
// 'standalone' (direct OpenAI-compatible) mode.

export const useConversationsStore = defineStore('mobile-conversations', () => {
  const conversations = ref([]);
  const currentId = ref(null);
  const messages = ref([]);
  const keyword = ref('');
  const loading = ref(false);

  const current = computed(
    () => conversations.value.find((item) => item.id === currentId.value) || null
  );
  const filtered = computed(() => {
    const q = keyword.value.trim().toLowerCase();
    if (!q) return conversations.value;
    return conversations.value.filter(
      (item) =>
        item.title.toLowerCase().includes(q) ||
        (item.model || '').toLowerCase().includes(q) ||
        (item.provider || '').toLowerCase().includes(q)
    );
  });

  async function refresh() {
    loading.value = true;
    try {
      conversations.value = await listConversations();
    } finally {
      loading.value = false;
    }
  }

  async function open(id) {
    currentId.value = id;
    messages.value = await listMessages(id);
    await refresh();
    return messages.value;
  }

  async function create({ title, model, provider, mode }) {
    const conversation = await createConversation({ title, model, provider, mode });
    await refresh();
    currentId.value = conversation.id;
    messages.value = [];
    return conversation;
  }

  async function rename(id, title) {
    const updated = await updateConversation(id, { title });
    await refresh();
    return updated;
  }

  async function setModel(id, model, provider) {
    const updated = await updateConversation(id, { model, provider });
    await refresh();
    return updated;
  }

  async function togglePin(id) {
    const conversation = getConversation(id);
    const updated = await updateConversation(id, { pinned: !conversation?.pinned });
    await refresh();
    return updated;
  }

  async function remove(id) {
    const wasCurrent = id === currentId.value;
    await removeConversation(id);
    await refresh();
    if (wasCurrent) {
      currentId.value = null;
      messages.value = [];
    }
  }

  async function clearAll() {
    for (const item of conversations.value) {
      await removeConversation(item.id);
    }
    await refresh();
    currentId.value = null;
    messages.value = [];
  }

  async function addMessage(conversation, message) {
    await appendMessage(conversation, message);
    messages.value = await listMessages(conversation);
    await refresh();
  }

  async function patchMessage(conversation, seq, patch) {
    await updateMessage(conversation, seq, patch);
    messages.value = await listMessages(conversation);
  }

  function reset() {
    currentId.value = null;
    messages.value = [];
    conversations.value = [];
    keyword.value = '';
  }

  return {
    conversations,
    currentId,
    current,
    messages,
    keyword,
    filtered,
    loading,
    refresh,
    open,
    create,
    rename,
    setModel,
    togglePin,
    remove,
    clearAll,
    addMessage,
    patchMessage,
    reset,
  };
});

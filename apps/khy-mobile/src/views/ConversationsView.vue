<script setup>
import { onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useConversationsStore } from '@/stores/conversations';

const router = useRouter();
const conversations = useConversationsStore();

onMounted(async () => {
  await conversations.refresh();
});

function openConversation(id) {
  conversations.open(id).then(() => router.push('/chat'));
}

async function removeConversation(id, event) {
  event.stopPropagation();
  await conversations.remove(id);
}

async function togglePin(id, event) {
  event.stopPropagation();
  await conversations.togglePin(id);
}

async function clearAll() {
  await conversations.clearAll();
}
</script>

<template>
  <div class="stack">
    <div class="row">
      <div>
        <h1 class="page-title">会话</h1>
        <p class="page-subtitle">共 {{ conversations.conversations.length }} 个会话</p>
      </div>
      <button v-if="conversations.conversations.length" class="button danger" @click="clearAll">清空</button>
    </div>

    <label class="field">
      <input v-model="conversations.keyword" placeholder="搜索标题 / 模型 / 供应商" />
    </label>

    <section v-if="!conversations.filtered.length" class="panel muted">
      暂无会话，去「对话」页开始一个新对话。
    </section>
    <section v-else class="conv-list">
      <article
        v-for="conv in conversations.filtered"
        :key="conv.id"
        class="conv-card panel"
        :class="{ pinned: conv.pinned, active: conv.id === conversations.currentId }"
        @click="openConversation(conv.id)"
      >
        <div class="row">
          <div class="conv-title">
            <span v-if="conv.pinned" class="pin-mark">📌</span>
            <strong>{{ conv.title }}</strong>
          </div>
          <span class="conv-mode" :class="conv.mode">{{ conv.mode === 'standalone' ? '独立' : '远程' }}</span>
        </div>
        <div class="row conv-meta">
          <span class="muted">{{ conv.model || '未选模型' }}</span>
          <span class="muted">{{ conv.provider || '' }}</span>
          <span class="muted">{{ (conv.updatedAt || '').slice(0, 16).replace('T', ' ') }}</span>
        </div>
        <div class="row conv-ops">
          <button class="button small" @click="togglePin(conv.id, $event)">{{ conv.pinned ? '取消置顶' : '置顶' }}</button>
          <button class="button small danger" @click="removeConversation(conv.id, $event)">删除</button>
        </div>
      </article>
    </section>
  </div>
</template>

<style scoped>
.conv-list { display: grid; gap: 10px; }
.conv-card { display: grid; gap: 8px; cursor: pointer; }
.conv-card.active { border-color: var(--m-accent); }
.conv-card.pinned { border-left: 3px solid var(--m-accent); }
.conv-title { display: flex; align-items: center; gap: 6px; min-width: 0; }
.conv-title strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pin-mark { font-size: 12px; }
.conv-mode { padding: 1px 7px; border-radius: 4px; font-size: 10px; }
.conv-mode.remote { color: var(--m-accent); background: var(--m-bg-deep); border: 1px solid var(--m-border); }
.conv-mode.standalone { color: var(--m-warn); background: #40371d; border: 1px solid #6b5a22; }
.conv-meta { gap: 8px; flex-wrap: wrap; }
.conv-ops { gap: 8px; justify-content: flex-end; }
.button.small { padding: 5px 10px; font-size: 12px; }
</style>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { usePromptsStore } from '@/stores/prompts';
import { statusText } from '@/api/status';
import { copyText } from '@/composables/useMarkdown';

const router = useRouter();
const prompts = usePromptsStore();
const activeTab = ref('mine'); // 'mine' | 'builtin'
const dialog = ref(false);
const editing = ref(null);
const form = ref({ title: '', content: '', category: '', tagsText: '' });
const saving = ref(false);
const formError = ref('');

const keyword = ref('');
const filtered = computed(() => {
  const q = keyword.value.trim().toLowerCase();
  const source = activeTab.value === 'builtin' ? 'builtin' : null;
  const base = source === 'builtin' ? prompts.builtin : prompts.prompts;
  if (!q) return base;
  return base.filter((item) =>
    item.title.toLowerCase().includes(q) ||
    item.content.toLowerCase().includes(q) ||
    (item.category || '').toLowerCase().includes(q)
  );
});

onMounted(async () => {
  await prompts.refresh();
  await prompts.loadBuiltin().catch(() => {});
});

function openCreate() {
  editing.value = null;
  form.value = { title: '', content: '', category: '', tagsText: '' };
  formError.value = '';
  dialog.value = true;
}

function openEdit(prompt) {
  editing.value = prompt;
  form.value = {
    title: prompt.title,
    content: prompt.content,
    category: prompt.category || '',
    tagsText: Array.isArray(prompt.tags) ? prompt.tags.join(', ') : '',
  };
  formError.value = '';
  dialog.value = true;
}

async function handleSave() {
  if (!form.value.content.trim()) {
    formError.value = '提示词内容不能为空';
    return;
  }
  saving.value = true;
  formError.value = '';
  try {
    const payload = {
      title: form.value.title.trim() || '未命名提示词',
      content: form.value.content.trim(),
      category: form.value.category.trim() || '通用',
      tags: form.value.tagsText.split(/[,，]/).map((t) => t.trim()).filter(Boolean),
    };
    if (editing.value) {
      await prompts.update({ ...payload, id: editing.value.id, source: editing.value.source });
    } else {
      await prompts.addLocal(payload);
    }
    dialog.value = false;
  } catch (cause) {
    formError.value = cause.message || '保存失败';
  } finally {
    saving.value = false;
  }
}

async function handleDelete(prompt) {
  await prompts.remove(prompt.id);
}

async function useInChat(prompt) {
  await prompts.use(prompt.id);
  await copyText(prompt.content);
  await router.push('/chat');
}

async function handleCopy(prompt) {
  await copyText(prompt.content);
}

async function syncRemote() {
  await prompts.syncFromRemote();
}
</script>

<template>
  <div class="stack">
    <div class="row">
      <div>
        <h1 class="page-title">提示词库</h1>
        <p class="page-subtitle">本地收藏 + khy-os 同步</p>
      </div>
      <button class="button primary" @click="openCreate">新建</button>
    </div>

    <div class="tabs row">
      <button class="tab" :class="{ active: activeTab === 'mine' }" @click="activeTab = 'mine'">
        我的提示词（{{ prompts.prompts.length }}）
      </button>
      <button class="tab" :class="{ active: activeTab === 'builtin' }" @click="activeTab = 'builtin'">
        内置模板（{{ prompts.builtin.length }}）
      </button>
      <button class="button small" :disabled="prompts.syncing" @click="syncRemote">同步</button>
    </div>

    <label class="field">
      <input v-model="keyword" placeholder="搜索标题 / 内容 / 分类" />
    </label>

    <p class="status-line" :class="prompts.status.tone">{{ statusText(prompts.status) }}</p>
    <p v-if="prompts.error" class="alert">{{ prompts.error }}</p>

    <section v-if="!filtered.length" class="panel muted">暂无提示词，点击「新建」创建或「同步」从 khy-os 拉取。</section>
    <section v-else class="prompt-list">
      <article v-for="prompt in filtered" :key="prompt.id" class="prompt-card panel">
        <div class="row">
          <div class="prompt-head">
            <strong>{{ prompt.title }}</strong>
            <span class="tag" v-for="tag in (prompt.tags || [])" :key="tag">{{ tag }}</span>
          </div>
          <span class="prompt-source" :class="prompt.source">{{ prompt.source }}</span>
        </div>
        <p class="prompt-content">{{ prompt.content }}</p>
        <div class="row prompt-ops">
          <span class="muted" v-if="prompt.category">分类：{{ prompt.category }}</span>
          <span class="muted" v-else>分类：无</span>
          <span class="muted">使用 {{ prompt.useCount || 0 }} 次</span>
          <div class="row prompt-buttons">
            <button class="button small primary" @click="useInChat(prompt)">使用</button>
            <button class="button small" @click="handleCopy(prompt)">复制</button>
            <button class="button small" @click="openEdit(prompt)" v-if="activeTab === 'mine'">编辑</button>
            <button class="button small danger" @click="handleDelete(prompt)" v-if="activeTab === 'mine'">删除</button>
          </div>
        </div>
      </article>
    </section>

    <div v-if="dialog" class="modal-backdrop" @click.self="dialog = false">
      <div class="modal">
        <h2>{{ editing ? '编辑提示词' : '新建提示词' }}</h2>
        <label class="field">标题<input v-model="form.title" placeholder="留空则从内容派生" /></label>
        <label class="field">内容<textarea v-model="form.content" required placeholder="粘贴你的提示词"></textarea></label>
        <label class="field">分类<input v-model="form.category" placeholder="如：写作 / 编码 / 分析" /></label>
        <label class="field">标签<input v-model="form.tagsText" placeholder="逗号分隔" /></label>
        <p v-if="formError" class="alert">{{ formError }}</p>
        <div class="row">
          <button class="button" @click="dialog = false">取消</button>
          <button class="button primary" :disabled="saving" @click="handleSave">保存</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tabs { gap: 8px; flex-wrap: wrap; }
.tab { flex: 1; min-width: 110px; padding: 9px 10px; border: 1px solid var(--m-border); border-radius: 6px; color: var(--m-text-mid); background: var(--m-surface); font-size: 13px; }
.tab.active { color: var(--m-accent-on); border-color: var(--m-accent); background: var(--m-accent); }
.button.small { padding: 6px 10px; font-size: 12px; }
.prompt-list { display: grid; gap: 10px; }
.prompt-card { display: grid; gap: 8px; }
.prompt-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; min-width: 0; }
.prompt-head strong { font-size: 15px; }
.tag { padding: 1px 7px; border-radius: 4px; color: var(--m-accent); background: var(--m-bg-deep); border: 1px solid var(--m-border); font-size: 11px; }
.prompt-source { font-size: 10px; text-transform: uppercase; color: var(--m-text-dim); }
.prompt-content { margin: 0; color: var(--m-text-mid); font-size: 13px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 72px; overflow: hidden; }
.prompt-ops { flex-wrap: wrap; }
.prompt-buttons { gap: 6px; }
.modal-backdrop { position: fixed; inset: 0; z-index: 50; display: grid; place-items: center; padding: 18px; background: rgba(5, 10, 16, .72); }
.modal { width: min(460px, 100%); display: grid; gap: 12px; padding: 18px; border: 1px solid var(--m-border-strong); border-radius: 10px; background: var(--m-surface); }
.modal h2 { margin: 0; font-size: 18px; }
</style>

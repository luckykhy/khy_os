<template>
  <div class="prompt-library-page">
    <KhyPageHeader title="提示词库">
      <template #actions>
        <el-input
          v-model="keyword"
          placeholder="搜索标题 / 内容 / 标签"
          clearable
          size="default"
          style="width: 240px;"
          @input="onSearch"
        />
        <el-button type="primary" @click="openCreate">新建提示词</el-button>
      </template>
    </KhyPageHeader>

    <!-- 提示词模板 · 内置多角度起步库 -->
    <el-card class="section-card template-card" shadow="hover">
      <template #header>
        <div class="card-header-row">
          <span>
            提示词模板
            <el-tag size="small" effect="dark" style="margin-left: 6px;">{{ templateCount }}</el-tag>
          </span>
          <span class="card-header-hint">内置多角度模板，点「用一次」直接复制，或「存入我的库」长期保存</span>
        </div>
      </template>
      <div class="template-groups">
        <div v-for="g in groupedTemplates" :key="g.category" class="template-group">
          <div class="template-group-title">{{ g.category }}</div>
          <div class="template-items">
            <div v-for="t in g.items" :key="t.id || t.title" class="template-item">
              <div class="template-item-body">
                <div class="template-item-title">{{ t.title }}</div>
                <div class="template-item-content">{{ t.prompt }}</div>
              </div>
              <div class="template-item-ops">
                <el-button text size="small" @click="handleUseTemplate(t)">用一次</el-button>
                <el-button text size="small" type="primary" @click="handleSaveTemplate(t)">存入我的库</el-button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </el-card>

    <!-- AI 发现·待审核 -->
    <el-card v-if="pending.length" class="section-card pending-card" shadow="hover">
      <template #header>
        <div class="card-header-row">
          <span>
            待审核
            <el-tag type="warning" size="small" effect="dark" style="margin-left: 6px;">
              AI 发现 {{ pending.length }}
            </el-tag>
          </span>
          <span class="card-header-hint">系统自动发现的好提示词，留存或丢弃由你决定</span>
        </div>
      </template>
      <div class="pending-list">
        <div v-for="p in pending" :key="p.id" class="pending-item">
          <div class="pending-body">
            <div class="pending-title">{{ p.title }}</div>
            <div class="pending-content">{{ p.content }}</div>
          </div>
          <div class="pending-ops">
            <el-button type="success" size="small" @click="handleApprove(p)">留存</el-button>
            <el-button type="danger" size="small" plain @click="handleDelete(p, '丢弃')">丢弃</el-button>
          </div>
        </div>
      </div>
    </el-card>

    <!-- 我的提示词 -->
    <el-card class="section-card" shadow="hover" v-loading="loading">
      <template #header>
        <div class="card-header-row">
          <span>我的提示词 <el-tag size="small" style="margin-left: 6px;">{{ filteredPrompts.length }}</el-tag></span>
        </div>
      </template>
      <el-empty v-if="!filteredPrompts.length" description="还没有保存的提示词" />
      <el-table v-else :data="filteredPrompts" style="width: 100%;">
        <el-table-column prop="title" label="标题" min-width="180" show-overflow-tooltip />
        <el-table-column prop="content" label="内容" min-width="280" show-overflow-tooltip />
        <el-table-column label="分类" width="120">
          <template #default="{ row }">
            <el-tag v-if="row.category" size="small" type="info">{{ row.category }}</el-tag>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="标签" width="180">
          <template #default="{ row }">
            <el-tag v-for="t in row.tags" :key="t" size="small" style="margin-right: 4px;">{{ t }}</el-tag>
            <span v-if="!row.tags || !row.tags.length" class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column prop="usedCount" label="使用次数" width="90" align="center" />
        <el-table-column label="操作" width="240" fixed="right">
          <template #default="{ row }">
            <el-button text size="small" @click="handleCopy(row)">复制</el-button>
            <el-button text size="small" @click="handleUse(row)">用一次</el-button>
            <el-button text size="small" @click="openEdit(row)">编辑</el-button>
            <el-button text size="small" type="danger" @click="handleDelete(row, '删除')">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 新建 / 编辑对话框 -->
    <el-dialog
      v-model="dialogVisible"
      :title="editing ? '编辑提示词' : '新建提示词'"
      width="560px"
      @closed="resetForm"
    >
      <el-form :model="form" label-width="72px">
        <el-form-item label="标题">
          <el-input v-model="form.title" placeholder="留空则自动从内容派生" maxlength="200" />
        </el-form-item>
        <el-form-item label="内容" required>
          <el-input
            v-model="form.content"
            type="textarea"
            :autosize="{ minRows: 5, maxRows: 14 }"
            placeholder="在此粘贴你的提示词"
          />
        </el-form-item>
        <el-form-item label="分类">
          <el-input v-model="form.category" placeholder="可选，如：写作 / 编码 / 分析" maxlength="80" />
        </el-form-item>
        <el-form-item label="标签">
          <el-input v-model="form.tagsText" placeholder="逗号分隔，如：角色设定, 分步" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="handleSave">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { usePromptLibrary } from '@/composables/usePromptLibrary'
import KhyPageHeader from '@/components/KhyPageHeader.vue'

const {
  prompts, pending, builtinTemplates, loading,
  fetchAll, createPrompt, updatePrompt, removePrompt, usePrompt, approvePrompt,
} = usePromptLibrary()

// Local mirror of the backend built-in catalog so the template section is NEVER
// blank even when the backend is unreachable / gated off. Intentionally a small
// subset covering the main angles (not drift) — the live list from
// GET /api/ai/prompts/builtin takes over whenever it returns anything.
const FALLBACK_TEMPLATES = [
  { id: 'code-write', title: '写一个脚本', category: '编码', prompt: '用 Python 写一个读取 CSV 并做分组统计的脚本，带简单的错误处理和注释。' },
  { id: 'code-explain', title: '解释这段代码', category: '编码', prompt: '逐段解释下面这段代码在做什么，指出可能的坑或改进点：\n\n' },
  { id: 'summarize-points', title: '提炼要点', category: '分析总结', prompt: '帮我总结下面内容的核心要点，用简洁的分点列出，并指出最关键的一条：\n\n' },
  { id: 'debug-error', title: '帮我看报错', category: '调试', prompt: '我遇到这个报错，帮我把它翻译成人话，分析可能的原因，并给出排查步骤：\n\n' },
  { id: 'plan-breakdown', title: '拆解成任务清单', category: '规划', prompt: '帮我把下面这个需求拆成可执行的任务清单，标出依赖关系和优先级：\n\n' },
  { id: 'write-polish', title: '润色这段文字', category: '写作', prompt: '帮我润色下面这段文字，让它更通顺、专业，同时保持原意：\n\n' },
  { id: 'translate-zh-en', title: '中英互译', category: '翻译', prompt: '帮我把下面内容翻译成地道的英文（如果原文是英文则翻成中文），保留专业术语：\n\n' },
  { id: 'learn-explain', title: '通俗讲清一个概念', category: '学习', prompt: '用通俗的比喻和一个简单例子，讲清楚【在此填入概念，如"梯度下降"】这个概念，假设我是初学者。' },
]

// Live template list: backend catalog when available, else the local fallback.
const liveTemplates = computed(() =>
  (builtinTemplates.value && builtinTemplates.value.length)
    ? builtinTemplates.value
    : FALLBACK_TEMPLATES)
const templateCount = computed(() => liveTemplates.value.length)

// Group templates by category for display, preserving first-seen order.
const groupedTemplates = computed(() => {
  const groups = []
  const index = new Map()
  for (const t of liveTemplates.value) {
    const cat = t.category || '常用'
    if (!index.has(cat)) {
      index.set(cat, groups.length)
      groups.push({ category: cat, items: [] })
    }
    groups[index.get(cat)].items.push(t)
  }
  return groups
})

const keyword = ref('')
const filteredPrompts = computed(() => {
  const q = keyword.value.trim().toLowerCase()
  if (!q) return prompts.value
  return prompts.value.filter((p) =>
    (p.title || '').toLowerCase().includes(q) ||
    (p.content || '').toLowerCase().includes(q) ||
    (p.category || '').toLowerCase().includes(q) ||
    (p.tags || []).some((t) => String(t).toLowerCase().includes(q)))
})

function onSearch() { /* client-side filter via computed; no refetch needed */ }

// ── Create / edit dialog ──
const dialogVisible = ref(false)
const editing = ref(null)
const saving = ref(false)
const form = ref({ title: '', content: '', category: '', tagsText: '' })

function resetForm() {
  editing.value = null
  form.value = { title: '', content: '', category: '', tagsText: '' }
}

function openCreate() {
  resetForm()
  dialogVisible.value = true
}

function openEdit(row) {
  editing.value = row
  form.value = {
    title: row.title || '',
    content: row.content || '',
    category: row.category || '',
    tagsText: (row.tags || []).join(', '),
  }
  dialogVisible.value = true
}

async function handleSave() {
  const content = form.value.content.trim()
  if (!content) {
    ElMessage.warning('内容不能为空')
    return
  }
  const payload = {
    title: form.value.title.trim(),
    content,
    category: form.value.category.trim(),
    tags: form.value.tagsText.split(',').map((t) => t.trim()).filter(Boolean),
  }
  try {
    saving.value = true
    if (editing.value) await updatePrompt(editing.value.id, payload)
    else await createPrompt(payload)
    ElMessage.success('已保存')
    dialogVisible.value = false
  } catch (err) {
    ElMessage.error(err?.response?.data?.message || '保存失败')
  } finally {
    saving.value = false
  }
}

async function handleCopy(row) {
  try {
    await navigator.clipboard.writeText(row.content || '')
    ElMessage.success('已复制到剪贴板')
  } catch {
    ElMessage.warning('复制失败，请手动选择')
  }
}

// ── Built-in template actions ──
// "用一次": copy the template body so the user can paste it into the chat composer.
async function handleUseTemplate(t) {
  try {
    await navigator.clipboard.writeText(t.prompt || '')
    ElMessage.success('模板已复制，去对话里粘贴使用')
  } catch {
    ElMessage.warning('复制失败，请手动选择')
  }
}

// "存入我的库": promote a built-in template into the user's personal library.
async function handleSaveTemplate(t) {
  try {
    await createPrompt({
      title: t.title || '',
      content: t.prompt || '',
      category: t.category || '',
      tags: [],
    })
    ElMessage.success('已存入我的提示词库')
  } catch (err) {
    ElMessage.error(err?.response?.data?.message || '保存失败')
  }
}

async function handleUse(row) {
  try {
    await usePrompt(row.id)
    await handleCopy(row)
  } catch {
    ElMessage.error('操作失败')
  }
}

async function handleApprove(row) {
  try {
    await approvePrompt(row.id)
    ElMessage.success('已留存到提示词库')
  } catch {
    ElMessage.error('操作失败')
  }
}

async function handleDelete(row, verb) {
  try {
    await ElMessageBox.confirm(`确定${verb}「${row.title}」吗？`, '确认', { type: 'warning' })
  } catch {
    return // cancelled
  }
  try {
    await removePrompt(row.id)
    ElMessage.success(`已${verb}`)
  } catch {
    ElMessage.error('操作失败')
  }
}

onMounted(fetchAll)
</script>

<style scoped>
.prompt-library-page {
  padding: 4px 2px;
}
.section-card {
  margin-bottom: 16px;
}
.card-header-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.card-header-hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.pending-card {
  border-left: 3px solid var(--el-color-warning);
}
.template-card {
  border-left: 3px solid var(--el-color-primary);
}
.template-groups {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.template-group-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-secondary);
  margin-bottom: 6px;
}
.template-items {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 8px;
}
.template-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--el-fill-color-light);
}
.template-item-body {
  min-width: 0;
  flex: 1;
}
.template-item-title {
  font-weight: 600;
  margin-bottom: 4px;
}
.template-item-content {
  font-size: 12px;
  color: var(--el-text-color-regular);
  white-space: pre-wrap;
  max-height: 60px;
  overflow: hidden;
}
.template-item-ops {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex-shrink: 0;
}
.pending-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.pending-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--el-fill-color-light);
}
.pending-body {
  min-width: 0;
  flex: 1;
}
.pending-title {
  font-weight: 600;
  margin-bottom: 4px;
}
.pending-content {
  font-size: 13px;
  color: var(--el-text-color-regular);
  white-space: pre-wrap;
  max-height: 84px;
  overflow: hidden;
}
.pending-ops {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex-shrink: 0;
}
.muted {
  color: var(--el-text-color-placeholder);
}
</style>

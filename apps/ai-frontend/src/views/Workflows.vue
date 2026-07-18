<template>
  <div class="workflows-page">
    <KhyPageHeader title="可视化工作流" subtitle="拖拽编排 · 导出为可执行 Skill">
      <template #actions>
        <el-button :icon="Upload" @click="cozeImportVisible = true">导入 Coze</el-button>
        <el-button :icon="Files" @click="openTemplates">从模板新建</el-button>
        <el-button :icon="MagicStick" @click="openGenerate">用自然语言生成</el-button>
        <el-button type="primary" :icon="Plus" @click="openCreate">新建工作流</el-button>
      </template>
    </KhyPageHeader>

    <el-card shadow="never" class="workflows-card">
      <!-- 列表载入失败的**本页可见降级**:就地展示 + 重试,取代此前会泄漏到别页的全局横幅。
           (请求已 silent,见 useWorkflow.listWorkflows;不再叠全局 notifyError。) -->
      <el-alert
        v-if="loadError"
        class="wf-load-error"
        type="error"
        :closable="false"
        show-icon
        :title="loadError"
      >
        <template #default>
          <el-button size="small" type="primary" plain @click="retryLoad">重试</el-button>
        </template>
      </el-alert>
      <el-table
        v-loading="loading"
        :data="workflows"
        empty-text="还没有工作流，点击右上角新建"
        style="width: 100%"
      >
        <el-table-column prop="name" label="名称" min-width="200">
          <template #default="{ row }">
            <span class="wf-name">{{ row.name }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="description" label="描述" min-width="240" show-overflow-tooltip />
        <el-table-column prop="version" label="版本" width="90" align="center" />
        <el-table-column prop="updatedAt" label="更新时间" width="200">
          <template #default="{ row }">{{ formatTime(row.updatedAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="220" align="right">
          <template #default="{ row }">
            <el-button text type="primary" :icon="EditPen" @click="openEditor(row)">编辑</el-button>
            <el-button text :icon="Edit" @click="openRename(row)">重命名</el-button>
            <el-button text type="danger" :icon="Delete" @click="confirmDelete(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- Create / rename dialog -->
    <el-dialog v-model="dialogVisible" :title="dialogTitle" width="460px">
      <el-form label-width="72px" @submit.prevent>
        <el-form-item label="名称">
          <el-input v-model="form.name" maxlength="80" placeholder="工作流名称" />
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="form.description" type="textarea" :rows="2" maxlength="500" placeholder="可选" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitDialog">确定</el-button>
      </template>
    </el-dialog>

    <!-- Template picker dialog -->
    <el-dialog v-model="tplDialogVisible" title="从模板新建" width="640px">
      <div v-loading="tplLoading" class="tpl-list">
        <div
          v-for="tpl in templates"
          :key="tpl.id"
          class="tpl-card"
          :class="{ 'tpl-card--active': selectedTpl === tpl.id }"
          @click="selectedTpl = tpl.id"
        >
          <div class="tpl-card__head">
            <span class="tpl-card__name">{{ tpl.name }}</span>
            <el-tag size="small" type="info">{{ tpl.nodeCount }} 节点</el-tag>
          </div>
          <div class="tpl-card__desc">{{ tpl.description }}</div>
        </div>
        <el-empty v-if="!tplLoading && !templates.length" description="暂无模板" />
      </div>
      <template #footer>
        <el-button @click="tplDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="tplCreating" :disabled="!selectedTpl" @click="submitTemplate">
          创建并编辑
        </el-button>
      </template>
    </el-dialog>

    <!-- Natural-language generation — describe a task, the user's own AI upstream
         drafts a graph, preview it, then create + open in the editor. -->
    <el-dialog v-model="genDialogVisible" title="用自然语言生成工作流" width="640px">
      <el-form label-position="top" @submit.prevent>
        <el-form-item label="描述你想自动化的任务">
          <el-input
            v-model="genPrompt"
            type="textarea"
            :rows="5"
            maxlength="4000"
            show-word-limit
            placeholder="例如：抓取一个网页，让模型总结要点，把结果存到变量并结束。"
          />
        </el-form-item>
      </el-form>

      <div v-if="genResult" class="gen-preview">
        <div class="gen-preview__head">
          <span class="gen-preview__name">{{ genResult.name }}</span>
          <el-tag size="small" type="success">{{ genResult.report?.nodeCount ?? genResult.graph?.nodes?.length ?? 0 }} 节点</el-tag>
          <el-tag v-if="genResult.report?.repaired" size="small" type="warning">已自动修复</el-tag>
        </div>
        <div class="gen-preview__desc">{{ genResult.description }}</div>
        <div class="gen-preview__nodes">
          <el-tag
            v-for="n in (genResult.graph?.nodes || [])"
            :key="n.id"
            size="small"
            class="gen-node-tag"
          >{{ n.name || n.type }}</el-tag>
        </div>
      </div>

      <template #footer>
        <el-button @click="genDialogVisible = false">取消</el-button>
        <el-button v-if="!genResult" type="primary" :loading="genLoading" :disabled="!genPrompt.trim()" @click="submitGenerate">
          生成
        </el-button>
        <template v-else>
          <el-button :disabled="genCreating" @click="genResult = null">重新生成</el-button>
          <el-button type="primary" :loading="genCreating" @click="acceptGenerated">创建并编辑</el-button>
        </template>
      </template>
    </el-dialog>

    <!-- Coze import — browse a built-in catalog or uploaded collection, install
         entries on demand. Replaces the former standalone Coze gallery page. -->
    <CozeImportDialog v-model="cozeImportVisible" @installed="listWorkflows" />
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Edit, EditPen, Delete, Files, Upload, MagicStick } from '@element-plus/icons-vue'
import { useWorkflow } from '@/composables/useWorkflow'
import CozeImportDialog from '@/views/CozeImportDialog.vue'
import KhyPageHeader from '@/components/KhyPageHeader.vue'

const router = useRouter()
const {
  workflows, loading, saving, loadError,
  listWorkflows, createWorkflow, saveWorkflow, deleteWorkflow,
  listTemplates, createFromTemplate,
  generateWorkflow,
} = useWorkflow()

const dialogVisible = ref(false)
const dialogMode = ref('create') // 'create' | 'rename'
const dialogTitle = ref('新建工作流')
const editingId = ref(null)
const form = reactive({ name: '', description: '' })

// Template picker state
const tplDialogVisible = ref(false)
const tplLoading = ref(false)
const tplCreating = ref(false)
const templates = ref([])
const selectedTpl = ref(null)

// Coze import dialog visibility (browse + install).
const cozeImportVisible = ref(false)

// Natural-language generation state. The flow: describe → generate (non-persist,
// preview) → "创建并编辑" persists via createWorkflow then opens the editor.
const genDialogVisible = ref(false)
const genPrompt = ref('')
const genResult = ref(null)
const genLoading = ref(false)
const genCreating = ref(false)

function formatTime(t) {
  if (!t) return '-'
  try {
    return new Date(t).toLocaleString()
  } catch {
    return String(t)
  }
}

function openCreate() {
  dialogMode.value = 'create'
  dialogTitle.value = '新建工作流'
  editingId.value = null
  form.name = ''
  form.description = ''
  dialogVisible.value = true
}

function openRename(row) {
  dialogMode.value = 'rename'
  dialogTitle.value = '重命名工作流'
  editingId.value = row.id
  form.name = row.name
  form.description = row.description || ''
  dialogVisible.value = true
}

async function submitDialog() {
  const name = form.name.trim()
  if (!name) {
    ElMessage.warning('请输入名称')
    return
  }
  try {
    if (dialogMode.value === 'create') {
      const wf = await createWorkflow({ name, description: form.description })
      dialogVisible.value = false
      ElMessage.success('已创建')
      openEditor(wf)
    } else {
      await saveWorkflow(editingId.value, { name, description: form.description })
      dialogVisible.value = false
      ElMessage.success('已保存')
      await listWorkflows()
    }
  } catch (err) {
    ElMessage.error(err?.response?.data?.message || err?.message || '操作失败')
  }
}

async function openTemplates() {
  selectedTpl.value = null
  tplDialogVisible.value = true
  tplLoading.value = true
  try {
    templates.value = await listTemplates()
  } catch (err) {
    ElMessage.error(err?.response?.data?.message || err?.message || '加载模板失败')
  } finally {
    tplLoading.value = false
  }
}

async function submitTemplate() {
  if (!selectedTpl.value) return
  tplCreating.value = true
  try {
    const wf = await createFromTemplate(selectedTpl.value)
    tplDialogVisible.value = false
    ElMessage.success('已从模板创建')
    openEditor(wf)
  } catch (err) {
    ElMessage.error(err?.response?.data?.message || err?.message || '创建失败')
  } finally {
    tplCreating.value = false
  }
}

function openEditor(row) {
  router.push({ name: 'WorkflowEditor', params: { id: row.id } })
}

function openGenerate() {
  genPrompt.value = ''
  genResult.value = null
  genLoading.value = false
  genCreating.value = false
  genDialogVisible.value = true
}

async function submitGenerate() {
  const prompt = genPrompt.value.trim()
  if (!prompt) {
    ElMessage.warning('请先描述任务')
    return
  }
  genLoading.value = true
  try {
    // Non-persist: returns { graph, name, description, report } for preview.
    genResult.value = await generateWorkflow(prompt)
  } catch (err) {
    ElMessage.error(err?.response?.data?.message || err?.message || '生成失败')
  } finally {
    genLoading.value = false
  }
}

async function acceptGenerated() {
  if (!genResult.value) return
  genCreating.value = true
  try {
    const { name, description, graph } = genResult.value
    const wf = await createWorkflow({ name, description, graph })
    genDialogVisible.value = false
    ElMessage.success('已创建，进入编辑器')
    openEditor(wf)
  } catch (err) {
    ElMessage.error(err?.response?.data?.message || err?.message || '创建失败')
  } finally {
    genCreating.value = false
  }
}

async function confirmDelete(row) {
  try {
    await ElMessageBox.confirm(`确定删除工作流「${row.name}」？`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  try {
    await deleteWorkflow(row.id)
    ElMessage.success('已删除')
  } catch (err) {
    ElMessage.error(err?.response?.data?.message || err?.message || '删除失败')
  }
}

// 载入失败时的重试(本页降级 UI 的动作)。请求已 silent,失败仅落 loadError,不弹全局横幅。
function retryLoad() {
  listWorkflows().catch(() => { /* loadError 已就地渲染,吞掉 rejection 避免未处理 */ })
}

onMounted(retryLoad)
</script>

<style scoped>
.wf-load-error {
  margin-bottom: 12px;
}
.wf-name {
  font-weight: 500;
}
.tpl-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 52vh;
  overflow-y: auto;
}
.tpl-card {
  border: 1px solid var(--khy-border);
  border-radius: 8px;
  padding: 12px 14px;
  cursor: pointer;
  transition: border-color 0.15s, background-color 0.15s;
}
.tpl-card:hover {
  border-color: var(--el-color-primary-light-5);
}
.tpl-card--active {
  border-color: var(--khy-primary);
  background-color: var(--khy-primary-soft);
}
.tpl-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
.tpl-card__name {
  font-weight: 600;
}
.tpl-card__desc {
  font-size: 12px;
  color: var(--khy-text-secondary);
  line-height: 1.5;
}
.gen-preview {
  margin-top: 4px;
  border: 1px solid var(--khy-border);
  border-radius: 8px;
  padding: 12px 14px;
  background-color: var(--khy-bg-soft);
}
.gen-preview__head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.gen-preview__name {
  font-weight: 600;
}
.gen-preview__desc {
  font-size: 12px;
  color: var(--khy-text-secondary);
  line-height: 1.5;
  margin-bottom: 10px;
}
.gen-preview__nodes {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.gen-node-tag {
  margin: 0;
}
</style>

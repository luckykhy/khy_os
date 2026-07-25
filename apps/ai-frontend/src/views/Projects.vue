<template>
  <div class="projects-page">
    <KhyPageHeader title="项目工作区" subtitle="命名的多文件夹编码工作区 · 对齐 Hermes coding projects">
      <template #actions>
        <el-switch
          v-model="showArchived"
          inline-prompt
          active-text="含归档"
          inactive-text="仅活跃"
          @change="refresh"
        />
        <el-button type="primary" :icon="Plus" @click="openCreate">新建项目</el-button>
      </template>
    </KhyPageHeader>

    <el-card shadow="never" class="projects-card">
      <el-table
        v-loading="loading"
        :data="projects"
        empty-text="还没有项目，点击右上角新建"
        style="width: 100%"
      >
        <el-table-column label="项目" min-width="220">
          <template #default="{ row }">
            <span class="proj-icon" v-if="row.icon">{{ row.icon }}</span>
            <span class="proj-name" :style="row.color ? { color: row.color } : null">{{ row.name }}</span>
            <el-tag v-if="row.archived" size="small" type="info" class="proj-archived-tag">已归档</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="description" label="描述" min-width="220" show-overflow-tooltip />
        <el-table-column label="主路径" min-width="200" show-overflow-tooltip>
          <template #default="{ row }">
            <span class="proj-path">{{ row.primaryPath || '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="文件夹" width="100" align="center">
          <template #default="{ row }">{{ (row.folders && row.folders.length) || 0 }}</template>
        </el-table-column>
        <el-table-column prop="updatedAt" label="更新时间" width="190">
          <template #default="{ row }">{{ formatTime(row.updatedAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="300" align="right">
          <template #default="{ row }">
            <el-button
              text
              :type="isActive(row) ? 'success' : 'primary'"
              :icon="isActive(row) ? Select : Aim"
              @click="toggleActive(row)"
            >{{ isActive(row) ? '当前工作区' : '设为当前' }}</el-button>
            <el-button text :icon="Edit" @click="openEdit(row)">编辑</el-button>
            <el-button
              text
              :icon="row.archived ? RefreshLeft : Box"
              @click="toggleArchive(row)"
            >{{ row.archived ? '恢复' : '归档' }}</el-button>
            <el-button text type="danger" :icon="Delete" @click="confirmDelete(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- Create / edit dialog -->
    <el-dialog v-model="dialogVisible" :title="dialogTitle" width="520px">
      <el-form label-width="80px" @submit.prevent>
        <el-form-item label="名称">
          <el-input v-model="form.name" maxlength="120" placeholder="项目名称（必填）" />
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="form.description" type="textarea" :rows="2" maxlength="500" placeholder="可选" />
        </el-form-item>
        <el-form-item label="主路径">
          <el-input v-model="form.primaryPath" maxlength="500" placeholder="工作区主文件夹（仅作分组标签，不执行 cd）" />
        </el-form-item>
        <el-form-item label="图标">
          <el-input v-model="form.icon" maxlength="32" placeholder="可选 emoji，如 🚀" style="width: 160px" />
          <el-color-picker v-model="form.color" class="proj-color-picker" />
          <span class="proj-color-hint">强调色（可选）</span>
        </el-form-item>
        <el-form-item label="附加文件夹">
          <el-input
            v-model="foldersText"
            type="textarea"
            :rows="3"
            placeholder="每行一个文件夹路径（仅作分组锚点标签）"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="busy" @click="submitDialog">确定</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Edit, Delete, Box, RefreshLeft, Aim, Select } from '@element-plus/icons-vue'
import { useProjects } from '@/composables/useProjects'
import KhyPageHeader from '@/components/KhyPageHeader.vue'

const {
  projects, loading, busy, activeProjectId,
  list, create, update, remove, archive, setActiveProject,
} = useProjects()

const showArchived = ref(false)

const dialogVisible = ref(false)
const dialogMode = ref('create') // 'create' | 'edit'
const dialogTitle = ref('新建项目')
const editingId = ref(null)
const form = reactive({ name: '', description: '', primaryPath: '', icon: '', color: '' })
// Folders are edited as newline-separated text, normalized to an array on submit.
const foldersText = ref('')

function formatTime(t) {
  if (!t) return '-'
  try {
    return new Date(t).toLocaleString()
  } catch {
    return String(t)
  }
}

function isActive(row) {
  return activeProjectId.value === row.id
}

function refresh() {
  return list({ includeArchived: showArchived.value })
}

function parseFolders(text) {
  return String(text || '')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

function openCreate() {
  dialogMode.value = 'create'
  dialogTitle.value = '新建项目'
  editingId.value = null
  form.name = ''
  form.description = ''
  form.primaryPath = ''
  form.icon = ''
  form.color = ''
  foldersText.value = ''
  dialogVisible.value = true
}

function openEdit(row) {
  dialogMode.value = 'edit'
  dialogTitle.value = '编辑项目'
  editingId.value = row.id
  form.name = row.name
  form.description = row.description || ''
  form.primaryPath = row.primaryPath || ''
  form.icon = row.icon || ''
  form.color = row.color || ''
  foldersText.value = Array.isArray(row.folders) ? row.folders.join('\n') : ''
  dialogVisible.value = true
}

async function submitDialog() {
  const name = form.name.trim()
  if (!name) {
    ElMessage.warning('请输入项目名称')
    return
  }
  const payload = {
    name,
    description: form.description,
    primaryPath: form.primaryPath,
    icon: form.icon,
    color: form.color,
    folders: parseFolders(foldersText.value),
  }
  try {
    if (dialogMode.value === 'create') {
      await create(payload)
      ElMessage.success('已创建')
    } else {
      await update(editingId.value, payload)
      ElMessage.success('已保存')
    }
    dialogVisible.value = false
    await refresh()
  } catch (err) {
    ElMessage.error(err?.response?.data?.message || err?.message || '操作失败')
  }
}

function toggleActive(row) {
  setActiveProject(isActive(row) ? null : row.id)
}

async function toggleArchive(row) {
  try {
    await archive(row.id, !row.archived)
    ElMessage.success(row.archived ? '已恢复' : '已归档')
    await refresh()
  } catch (err) {
    ElMessage.error(err?.response?.data?.message || err?.message || '操作失败')
  }
}

async function confirmDelete(row) {
  try {
    await ElMessageBox.confirm(`确定删除项目「${row.name}」？此操作不可撤销。`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  try {
    await remove(row.id)
    ElMessage.success('已删除')
    await refresh()
  } catch (err) {
    ElMessage.error(err?.response?.data?.message || err?.message || '删除失败')
  }
}

onMounted(refresh)
</script>

<style scoped>
.proj-icon {
  margin-right: 6px;
}
.proj-name {
  font-weight: 500;
}
.proj-archived-tag {
  margin-left: 8px;
}
.proj-path {
  font-family: var(--el-font-family-mono, monospace);
  font-size: 12px;
  color: var(--khy-text-secondary);
}
.proj-color-picker {
  margin-left: 12px;
  vertical-align: middle;
}
.proj-color-hint {
  margin-left: 8px;
  font-size: 12px;
  color: var(--khy-text-secondary);
}
</style>

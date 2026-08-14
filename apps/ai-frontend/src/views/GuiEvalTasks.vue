<template>
  <div class="gui-eval-page">
    <KhyPageHeader title="评测任务列表">
      <template #actions>
        <el-button type="primary" @click="openCreateDialog">
          <el-icon><Plus /></el-icon> 创建任务
        </el-button>
      </template>
    </KhyPageHeader>

    <el-card shadow="never">
      <el-form :inline="true" :model="filters" class="filter-bar">
        <el-form-item label="状态">
          <el-select v-model="filters.status" clearable placeholder="全部" style="width: 120px">
            <el-option label="草稿" value="draft" />
            <el-option label="启用" value="active" />
            <el-option label="归档" value="archived" />
            <el-option label="废弃" value="deprecated" />
          </el-select>
        </el-form-item>
        <el-form-item label="难度">
          <el-select v-model="filters.difficulty" clearable placeholder="全部" style="width: 120px">
            <el-option label="简单" value="easy" />
            <el-option label="中等" value="medium" />
            <el-option label="困难" value="hard" />
            <el-option label="专家" value="expert" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-input
            v-model="filters.q"
            placeholder="搜索任务名称..."
            clearable
            style="width: 200px"
          />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="loadData" :loading="loading">查询</el-button>
        </el-form-item>
      </el-form>

      <el-table :data="tasks" stripe v-loading="loading">
        <el-table-column prop="id" label="ID" width="60" />
        <el-table-column label="名称" min-width="200">
          <template #default="{ row }">
            <el-link type="primary" @click="$router.push(`/gui-eval/tasks/${row.id}`)">{{
              row.name
            }}</el-link>
            <div class="task-tags">
              <el-tag v-for="t in row.tags" :key="t" size="small" type="info" effect="plain">{{
                t
              }}</el-tag>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="难度" width="80" align="center">
          <template #default="{ row }">
            <el-tag :type="difficultyType(row.difficulty)" size="small">{{
              difficultyLabel(row.difficulty)
            }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="90" align="center">
          <template #default="{ row }">
            <el-tag :type="statusType(row.status)" size="small">{{ row.status }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="Checkpoints" width="90" align="center">
          <template #default="{ row }">{{ (row.checkpoints || []).length }}</template>
        </el-table-column>
        <el-table-column label="单价" width="100" align="right">
          <template #default="{ row }">¥{{ row.pricing?.basePrice ?? 320 }}</template>
        </el-table-column>
        <el-table-column label="创建者" width="80" align="center">
          <template #default="{ row }">{{ row.created_by || '-' }}</template>
        </el-table-column>
        <el-table-column label="操作" width="200" fixed="right">
          <template #default="{ row }">
            <el-button
              type="primary"
              link
              size="small"
              @click="$router.push(`/gui-eval/tasks/${row.id}`)"
              >编辑</el-button
            >
            <el-button
              type="success"
              link
              size="small"
              @click="executeTask(row)"
              :disabled="row.status !== 'active'"
              >执行</el-button
            >
            <el-button type="danger" link size="small" @click="deleteTask(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div class="pagination-bar">
        <el-pagination
          v-model:current-page="page"
          :page-size="pageSize"
          :total="total"
          layout="total, prev, pager, next"
          @current-change="loadData"
        />
      </div>
    </el-card>

    <!-- Create Task Dialog -->
    <el-dialog
      v-model="createDialog.visible"
      title="新建评测任务"
      width="680px"
      :close-on-click-modal="false"
    >
      <el-form :model="createDialog.form" label-width="100px">
        <el-form-item label="任务名称" required>
          <el-input v-model="createDialog.form.name" placeholder="如：打开计算器计算 2+2" />
        </el-form-item>
        <el-form-item label="难度">
          <el-select v-model="createDialog.form.difficulty">
            <el-option label="简单 (easy)" value="easy" />
            <el-option label="中等 (medium)" value="medium" />
            <el-option label="困难 (hard)" value="hard" />
            <el-option label="专家 (expert)" value="expert" />
          </el-select>
        </el-form-item>
        <el-form-item label="分类">
          <el-input v-model="createDialog.form.category" placeholder="如 OS / Browser / Office" />
        </el-form-item>
        <el-form-item label="目标描述">
          <el-input
            v-model="createDialog.form.description"
            type="textarea"
            :rows="3"
            placeholder="给模型的完整目标说明..."
          />
        </el-form-item>
        <el-form-item label="定价（元）">
          <el-input-number v-model="createDialog.form.basePrice" :min="1" :max="99999" />
        </el-form-item>
        <el-form-item label="标签">
          <el-select
            v-model="createDialog.form.tags"
            multiple
            allow-create
            filterable
            placeholder="添加标签"
          >
            <el-option label="windows" value="windows" />
            <el-option label="browser" value="browser" />
            <el-option label="office" value="office" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createDialog.visible = false">取消</el-button>
        <el-button type="primary" @click="createTask" :loading="createDialog.loading"
          >创建</el-button
        >
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Plus } from '@element-plus/icons-vue';
import { guiEvalApi } from '@/api/guiEval';
import KhyPageHeader from '@/components/KhyPageHeader.vue';

const loading = ref(false);
const tasks = ref([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const filters = reactive({ status: '', difficulty: '', q: '' });

const createDialog = reactive({
  visible: false,
  loading: false,
  form: {
    name: '',
    description: '',
    difficulty: 'medium',
    category: '',
    basePrice: 320,
    tags: [],
  },
});

async function loadData() {
  loading.value = true;
  try {
    const params = { page: page.value, pageSize: pageSize.value };
    if (filters.status) params.status = filters.status;
    if (filters.difficulty) params.difficulty = filters.difficulty;
    if (filters.q) params.q = filters.q;
    const r = await guiEvalApi.listTasks(params);
    tasks.value = r.data?.tasks || [];
    total.value = r.data?.total || 0;
  } catch {
    ElMessage.error('加载任务列表失败');
  } finally {
    loading.value = false;
  }
}

function openCreateDialog() {
  createDialog.form = {
    name: '',
    description: '',
    difficulty: 'medium',
    category: '',
    basePrice: 320,
    tags: [],
  };
  createDialog.visible = true;
}

async function createTask() {
  if (!createDialog.form.name.trim()) return ElMessage.warning('请输入任务名称');
  createDialog.loading = true;
  try {
    const payload = {
      name: createDialog.form.name,
      description: createDialog.form.description || null,
      difficulty: createDialog.form.difficulty,
      category: createDialog.form.category || null,
      status: 'draft',
      pricing: { basePrice: createDialog.form.basePrice },
      tags: createDialog.form.tags,
      materials: [],
      environment: {},
      checkpoints: [],
    };
    await guiEvalApi.createTask(payload);
    ElMessage.success('任务创建成功');
    createDialog.visible = false;
    loadData();
  } catch (e) {
    ElMessage.error(e.message || '创建失败');
  } finally {
    createDialog.loading = false;
  }
}

async function executeTask(row) {
  try {
    await guiEvalApi.executeTask(row.id);
    ElMessage.success('任务已入队执行');
  } catch (e) {
    ElMessage.error(e.message || '执行失败');
  }
}

async function deleteTask(row) {
  try {
    await ElMessageBox.confirm(
      `确定删除任务「${row.name}」？关联的运行记录也将被删除。`,
      '确认删除',
      { type: 'warning' }
    );
    await guiEvalApi.deleteTask(row.id);
    ElMessage.success('已删除');
    loadData();
  } catch {
    /* dismissed */
  }
}

function difficultyType(d) {
  return { easy: 'success', medium: '', hard: 'warning', expert: 'danger' }[d] || 'info';
}
function difficultyLabel(d) {
  return { easy: '简单', medium: '中等', hard: '困难', expert: '专家' }[d] || d;
}
function statusType(s) {
  return { draft: 'info', active: 'success', archived: 'info', deprecated: 'danger' }[s] || 'info';
}

onMounted(loadData);
</script>

<style scoped>
.gui-eval-page {
  padding: 16px;
}
.filter-bar {
  margin-bottom: 16px;
}
.task-tags {
  display: flex;
  gap: 4px;
  margin-top: 4px;
  flex-wrap: wrap;
}
.pagination-bar {
  margin-top: 16px;
  display: flex;
  justify-content: flex-end;
}
</style>

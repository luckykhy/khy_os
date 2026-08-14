<template>
  <div class="wfe-page">
    <KhyPageHeader title="前端标注任务列表">
      <template #actions>
        <el-button type="primary" @click="openCreateDialog">
          <el-icon><Plus /></el-icon> 新建任务
        </el-button>
      </template>
    </KhyPageHeader>

    <el-card shadow="never">
      <el-form :inline="true" :model="filters" class="filter-bar">
        <el-form-item label="层级">
          <el-select v-model="filters.level" clearable placeholder="全部" style="width: 140px">
            <el-option label="L1 — 静态展示" value="L1" />
            <el-option label="L2 — 交互响应" value="L2" />
            <el-option label="L3 — 复杂 3D/物理" value="L3" />
          </el-select>
        </el-form-item>
        <el-form-item label="分类">
          <el-select v-model="filters.category" clearable placeholder="全部" style="width: 120px">
            <el-option label="2D" value="2d" />
            <el-option label="3D" value="3d" />
          </el-select>
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="filters.status" clearable placeholder="全部" style="width: 120px">
            <el-option label="草稿" value="draft" />
            <el-option label="启用" value="active" />
            <el-option label="归档" value="archived" />
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
        <el-table-column label="名称" min-width="220">
          <template #default="{ row }">
            <el-link type="primary" @click="$router.push(`/web-frontend-eval/tasks/${row.id}`)">{{
              row.name
            }}</el-link>
            <div class="task-tags">
              <el-tag v-for="t in row.tags" :key="t" size="small" type="info" effect="plain">{{
                t
              }}</el-tag>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="层级" width="100" align="center">
          <template #default="{ row }">
            <el-tag :type="levelType(row.level)" size="small">{{ row.level }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="分类" width="70" align="center">
          <template #default="{ row }">{{ row.category?.toUpperCase() }}</template>
        </el-table-column>
        <el-table-column label="状态" width="90" align="center">
          <template #default="{ row }">
            <el-tag :type="statusType(row.status)" size="small">{{
              statusLabel(row.status)
            }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="验收项" width="80" align="center">
          <template #default="{ row }">{{ (row.acceptance_criteria || []).length }}</template>
        </el-table-column>
        <el-table-column label="素材" width="70" align="center">
          <template #default="{ row }">{{ (row.assets || []).length }}</template>
        </el-table-column>
        <el-table-column label="操作" width="180" fixed="right">
          <template #default="{ row }">
            <el-button
              type="primary"
              link
              size="small"
              @click="$router.push(`/web-frontend-eval/tasks/${row.id}`)"
              >编辑</el-button
            >
            <el-button
              type="success"
              link
              size="small"
              @click="startRun(row)"
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
      title="新建标注任务"
      width="720px"
      :close-on-click-modal="false"
    >
      <el-form :model="createDialog.form" label-width="100px">
        <el-form-item label="任务名称" required>
          <el-input
            v-model="createDialog.form.name"
            placeholder="如：用 Three.js 实现交互式 3D 粒子立方体"
          />
        </el-form-item>
        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="层级">
              <el-select v-model="createDialog.form.level">
                <el-option label="L1 — 静态展示" value="L1" />
                <el-option label="L2 — 交互响应" value="L2" />
                <el-option label="L3 — 复杂 3D/物理" value="L3" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="分类">
              <el-select v-model="createDialog.form.category">
                <el-option label="2D Web 前端" value="2d" />
                <el-option label="3D Web 前端" value="3d" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="任务指令">
          <el-input
            v-model="createDialog.form.promptMd"
            type="textarea"
            :rows="5"
            placeholder="标注人员看到的完整任务指令（给 AI 的 prompt 内容）"
          />
        </el-form-item>
        <el-form-item label="素材说明">
          <el-input
            v-model="createDialog.form.assetsNote"
            type="textarea"
            :rows="2"
            placeholder="如：参考图来自 Figma 设计稿，3D 模型使用 CC0 授权..."
          />
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
import { webFrontendEvalApi } from '@/api/webFrontendEval';
import KhyPageHeader from '@/components/KhyPageHeader.vue';

const loading = ref(false);
const tasks = ref([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const filters = reactive({ level: '', category: '', status: '', q: '' });

const createDialog = reactive({
  visible: false,
  loading: false,
  form: { name: '', level: 'L1', category: '2d', promptMd: '', assetsNote: '' },
});

async function loadData() {
  loading.value = true;
  try {
    const params = { page: page.value, pageSize: pageSize.value };
    if (filters.level) params.level = filters.level;
    if (filters.category) params.category = filters.category;
    if (filters.status) params.status = filters.status;
    if (filters.q) params.q = filters.q;
    const r = await webFrontendEvalApi.listTasks(params);
    tasks.value = r.data?.tasks || [];
    total.value = r.data?.total || 0;
  } catch {
    ElMessage.error('加载任务列表失败');
  } finally {
    loading.value = false;
  }
}

function openCreateDialog() {
  createDialog.form = { name: '', level: 'L1', category: '2d', promptMd: '', assetsNote: '' };
  createDialog.visible = true;
}

async function createTask() {
  if (!createDialog.form.name.trim()) return ElMessage.warning('请输入任务名称');
  createDialog.loading = true;
  try {
    const payload = {
      name: createDialog.form.name,
      level: createDialog.form.level,
      category: createDialog.form.category,
      status: 'draft',
      prompt_md: createDialog.form.promptMd,
      description: createDialog.form.assetsNote || null,
      assets: [],
      acceptance_criteria: [],
      tags: [],
      lock_dependencies: true,
    };
    await webFrontendEvalApi.createTask(payload);
    ElMessage.success('任务创建成功');
    createDialog.visible = false;
    loadData();
  } catch (e) {
    ElMessage.error(e.message || '创建失败');
  } finally {
    createDialog.loading = false;
  }
}

async function startRun(row) {
  try {
    await webFrontendEvalApi.createRun(row.id, {});
    ElMessage.success('标注任务已创建');
  } catch (e) {
    ElMessage.error(e.message || '创建失败');
  }
}

async function deleteTask(row) {
  try {
    await ElMessageBox.confirm(
      `确定删除任务「${row.name}」？关联的运行记录也将被删除。`,
      '确认删除',
      { type: 'warning' }
    );
    await webFrontendEvalApi.deleteTask(row.id);
    ElMessage.success('已删除');
    loadData();
  } catch {
    /* dismissed */
  }
}

function levelType(l) {
  return { L1: 'success', L2: 'warning', L3: 'danger' }[l] || 'info';
}
function statusType(s) {
  return { draft: 'info', active: 'success', archived: 'info', deprecated: 'danger' }[s] || 'info';
}
function statusLabel(s) {
  return { draft: '草稿', active: '启用', archived: '归档', deprecated: '废弃' }[s] || s;
}

onMounted(loadData);
</script>

<style scoped>
.wfe-page {
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

<template>
  <div class="wfe-page">
    <KhyPageHeader :title="task ? `标注任务：${task.name}` : '任务详情'">
      <template #actions>
        <el-button @click="$router.push('/web-frontend-eval/tasks')">返回列表</el-button>
        <el-button v-if="task" type="primary" @click="saveTask" :loading="saving">保存</el-button>
        <el-button v-if="task && task.status !== 'active'" type="success" @click="activateTask"
          >启用</el-button
        >
      </template>
    </KhyPageHeader>

    <div v-if="!task" v-loading="loading" class="loading-placeholder">
      <el-skeleton :rows="8" animated />
    </div>

    <el-row v-else :gutter="16">
      <el-col :xs="24" :lg="12">
        <el-card shadow="never" class="section-card">
          <template #header><span>基本信息</span></template>
          <el-form :model="editForm" label-width="100px" :disabled="!editing">
            <el-form-item label="任务名称">
              <el-input v-model="editForm.name" />
            </el-form-item>
            <el-row :gutter="12">
              <el-col :span="12">
                <el-form-item label="层级">
                  <el-select v-model="editForm.level">
                    <el-option label="L1 — 静态展示" value="L1" />
                    <el-option label="L2 — 交互响应" value="L2" />
                    <el-option label="L3 — 复杂 3D/物理" value="L3" />
                  </el-select>
                </el-form-item>
              </el-col>
              <el-col :span="12">
                <el-form-item label="分类">
                  <el-select v-model="editForm.category">
                    <el-option label="2D Web 前端" value="2d" />
                    <el-option label="3D Web 前端" value="3d" />
                  </el-select>
                </el-form-item>
              </el-col>
            </el-row>
            <el-form-item label="状态">
              <el-select v-model="editForm.status">
                <el-option label="草稿" value="draft" />
                <el-option label="启用" value="active" />
                <el-option label="归档" value="archived" />
                <el-option label="废弃" value="deprecated" />
              </el-select>
            </el-form-item>
            <el-form-item label="任务指令">
              <el-input
                v-model="editForm.promptMd"
                type="textarea"
                :rows="6"
                placeholder="标注人员看到的完整任务指令（给 AI 的 prompt 内容）"
              />
            </el-form-item>
            <el-form-item label="锁定依赖">
              <el-switch v-model="editForm.lockDependencies" />
            </el-form-item>
            <el-form-item v-if="!editing">
              <el-button type="primary" @click="editing = true">编辑</el-button>
            </el-form-item>
            <el-form-item v-else>
              <el-button type="success" @click="saveTask" :loading="saving">保存</el-button>
              <el-button @click="editing = false">取消</el-button>
            </el-form-item>
          </el-form>
        </el-card>

        <el-card shadow="never" class="section-card" style="margin-top: 16px">
          <template #header>
            <span>素材列表（{{ (task.assets || []).length }} 个）</span>
          </template>
          <div v-if="editing">
            <div v-for="(asset, idx) in editForm.assets" :key="idx" class="asset-item">
              <el-input v-model="asset.name" placeholder="名称" size="small" style="width: 150px" />
              <el-select v-model="asset.type" size="small" style="width: 120px">
                <el-option label="图片" value="image" />
                <el-option label="3D模型" value="model" />
                <el-option label="贴图" value="texture" />
                <el-option label="HDRI" value="hdri" />
                <el-option label="音频" value="audio" />
                <el-option label="视频" value="video" />
              </el-select>
              <el-input v-model="asset.source" placeholder="来源" size="small" style="flex: 1" />
              <el-input
                v-model="asset.license"
                placeholder="授权"
                size="small"
                style="width: 120px"
              />
              <el-button type="danger" size="small" circle @click="editForm.assets.splice(idx, 1)">
                <el-icon><Delete /></el-icon>
              </el-button>
            </div>
            <el-button type="primary" size="small" @click="addAsset" style="margin-top: 8px"
              >+ 添加素材</el-button
            >
          </div>
          <el-table v-else :data="task.assets || []" stripe size="small" empty-text="暂无素材">
            <el-table-column prop="name" label="名称" min-width="120" />
            <el-table-column prop="type" label="类型" width="80" />
            <el-table-column prop="source" label="来源" min-width="150" show-overflow-tooltip />
            <el-table-column prop="license" label="授权" width="100" show-overflow-tooltip />
          </el-table>
        </el-card>
      </el-col>

      <el-col :xs="24" :lg="12">
        <el-card shadow="never" class="section-card">
          <template #header>
            <span>验收标准（{{ (task.acceptance_criteria || []).length }} 项）</span>
            <el-button v-if="editing" type="primary" size="small" @click="addCriterion"
              >+ 添加</el-button
            >
          </template>
          <div v-if="editing">
            <div v-for="(ac, idx) in editForm.criteria" :key="idx" class="ac-item">
              <el-input v-model="ac.id" placeholder="ID" size="small" style="width: 80px" />
              <el-input
                v-model="ac.description"
                placeholder="验收描述"
                size="small"
                style="flex: 1"
              />
              <el-input-number v-model="ac.weight" :min="0" :max="1" :step="0.1" size="small" />
              <el-button
                type="danger"
                size="small"
                circle
                @click="editForm.criteria.splice(idx, 1)"
              >
                <el-icon><Delete /></el-icon>
              </el-button>
            </div>
          </div>
          <el-table
            v-else
            :data="task.acceptance_criteria || []"
            stripe
            size="small"
            empty-text="暂无验收标准"
          >
            <el-table-column prop="id" label="ID" width="80" />
            <el-table-column
              prop="description"
              label="描述"
              min-width="200"
              show-overflow-tooltip
            />
            <el-table-column label="权重" width="80" align="center">
              <template #default="{ row }">{{ row.weight }}</template>
            </el-table-column>
          </el-table>
        </el-card>

        <el-card shadow="never" class="section-card" style="margin-top: 16px">
          <template #header>
            <span>运行记录（{{ (task.runs || []).length }} 条）</span>
          </template>
          <el-table :data="task.runs || []" stripe size="small" empty-text="暂无运行记录">
            <el-table-column prop="id" label="ID" width="60" />
            <el-table-column prop="status" label="状态" width="100">
              <template #default="{ row }">
                <el-tag :type="runStatusType(row.status)" size="small">{{
                  runStatusLabel(row.status)
                }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="qc_score" label="QC评分" width="80" align="center">
              <template #default="{ row }">{{
                row.qc_score != null ? row.qc_score : '-'
              }}</template>
            </el-table-column>
            <el-table-column label="操作" width="80" align="center">
              <template #default="{ row }">
                <el-button
                  type="primary"
                  link
                  size="small"
                  @click="$router.push(`/web-frontend-eval/runs/${row.id}`)"
                  >查看</el-button
                >
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { Delete } from '@element-plus/icons-vue';
import { webFrontendEvalApi } from '@/api/webFrontendEval';
import KhyPageHeader from '@/components/KhyPageHeader.vue';

const route = useRoute();
const router = useRouter();
const loading = ref(false);
const saving = ref(false);
const task = ref(null);
const editing = ref(false);

const editForm = reactive({
  name: '',
  level: 'L1',
  category: '2d',
  status: 'draft',
  promptMd: '',
  lockDependencies: true,
  assets: [],
  criteria: [],
});

async function loadTask() {
  loading.value = true;
  try {
    const r = await webFrontendEvalApi.getTask(route.params.id);
    task.value = r.data;
    Object.assign(editForm, {
      name: r.data.name,
      level: r.data.level || 'L1',
      category: r.data.category || '2d',
      status: r.data.status,
      promptMd: r.data.prompt_md || '',
      lockDependencies: r.data.lock_dependencies !== false,
      assets: JSON.parse(JSON.stringify(r.data.assets || [])),
      criteria: JSON.parse(JSON.stringify(r.data.acceptance_criteria || [])),
    });
  } catch (e) {
    ElMessage.error(e.message || '加载任务失败');
  } finally {
    loading.value = false;
  }
}

async function saveTask() {
  saving.value = true;
  try {
    await webFrontendEvalApi.updateTask(task.value.id, {
      name: editForm.name,
      level: editForm.level,
      category: editForm.category,
      status: editForm.status,
      prompt_md: editForm.promptMd,
      lock_dependencies: editForm.lockDependencies,
      assets: editForm.assets,
      acceptance_criteria: editForm.criteria,
    });
    ElMessage.success('已保存');
    editing.value = false;
    await loadTask();
  } catch (e) {
    ElMessage.error(e.message || '保存失败');
  } finally {
    saving.value = false;
  }
}

function activateTask() {
  editForm.status = 'active';
  saveTask();
}

function addAsset() {
  editForm.assets.push({ name: '', type: 'image', source: '', license: '' });
}

function addCriterion() {
  editForm.criteria.push({ id: `AC${editForm.criteria.length + 1}`, description: '', weight: 1 });
}

function runStatusType(s) {
  return (
    {
      draft: 'info',
      annotating: '',
      reviewing: 'warning',
      completed: 'success',
      rejected: 'danger',
      archived: 'info',
    }[s] || 'info'
  );
}
function runStatusLabel(s) {
  return (
    {
      draft: '草稿',
      annotating: '标注中',
      reviewing: '审核中',
      completed: '完成',
      rejected: '驳回',
      archived: '归档',
    }[s] || s
  );
}

onMounted(() => {
  if (route.params.id) loadTask();
});
</script>

<style scoped>
.wfe-page {
  padding: 16px;
}
.section-card {
  border-radius: 8px;
  margin-bottom: 16px;
}
.loading-placeholder {
  padding: 16px;
}
.asset-item {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 8px;
}
.ac-item {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 8px;
}
</style>

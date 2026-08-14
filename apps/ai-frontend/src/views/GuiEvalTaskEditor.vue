<template>
  <div class="gui-eval-page">
    <KhyPageHeader :title="task ? `任务编辑：${task.name}` : '任务详情'">
      <template #actions>
        <el-button @click="$router.push('/gui-eval/tasks')">返回列表</el-button>
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
            <el-form-item label="难度">
              <el-select v-model="editForm.difficulty">
                <el-option label="简单" value="easy" />
                <el-option label="中等" value="medium" />
                <el-option label="困难" value="hard" />
                <el-option label="专家" value="expert" />
              </el-select>
            </el-form-item>
            <el-form-item label="分类">
              <el-input v-model="editForm.category" />
            </el-form-item>
            <el-form-item label="状态">
              <el-select v-model="editForm.status">
                <el-option label="草稿" value="draft" />
                <el-option label="启用" value="active" />
                <el-option label="归档" value="archived" />
                <el-option label="废弃" value="deprecated" />
              </el-select>
            </el-form-item>
            <el-form-item label="目标描述">
              <el-input v-model="editForm.description" type="textarea" :rows="4" />
            </el-form-item>
            <el-form-item label="定价（元）">
              <el-input-number v-model="editForm.basePrice" :min="1" :max="99999" />
            </el-form-item>
            <el-form-item label="超时（秒）">
              <el-input-number v-model="editForm.maxDuration" :min="30" :max="86400" />
            </el-form-item>
            <el-form-item label="允许重试">
              <el-switch v-model="editForm.retryAllowed" />
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
            <span>素材 & 环境</span>
          </template>
          <div class="json-block">
            <el-input
              v-if="editing"
              v-model="editForm.materialsText"
              type="textarea"
              :rows="4"
              placeholder="JSON 数组"
            />
            <pre v-else>{{ formatJson(task.materials) }}</pre>
          </div>
          <div class="json-block" style="margin-top: 12px">
            <div class="json-label">环境配置</div>
            <el-input
              v-if="editing"
              v-model="editForm.environmentText"
              type="textarea"
              :rows="4"
              placeholder="JSON 对象"
            />
            <pre v-else>{{ formatJson(task.environment) }}</pre>
          </div>
        </el-card>
      </el-col>

      <el-col :xs="24" :lg="12">
        <el-card shadow="never" class="section-card">
          <template #header>
            <span>Checkpoints（{{ (task.checkpoints || []).length }} 个）</span>
            <el-button v-if="editing" type="primary" size="small" @click="addCheckpoint"
              >+ 添加</el-button
            >
          </template>
          <div v-if="editing">
            <div v-for="(cp, idx) in editForm.checkpoints" :key="idx" class="cp-item">
              <el-input v-model="cp.id" placeholder="ID" size="small" style="width: 100px" />
              <el-select v-model="cp.type" size="small">
                <el-option
                  v-for="t in checkpointTypes"
                  :key="t.value"
                  :label="t.label"
                  :value="t.value"
                />
              </el-select>
              <el-input v-model="cp.description" placeholder="描述" size="small" style="flex: 1" />
              <el-input-number v-model="cp.weight" :min="0" :max="1" :step="0.1" size="small" />
              <el-button
                type="danger"
                size="small"
                circle
                @click="editForm.checkpoints.splice(idx, 1)"
                ><el-icon><Delete /></el-icon
              ></el-button>
            </div>
          </div>
          <el-table
            v-else
            :data="task.checkpoints || []"
            stripe
            size="small"
            empty-text="暂无 Checkpoint"
          >
            <el-table-column prop="id" label="ID" width="80" />
            <el-table-column prop="type" label="类型" width="120">
              <template #default="{ row }">{{ cpLabel(row.type) }}</template>
            </el-table-column>
            <el-table-column
              prop="description"
              label="描述"
              min-width="150"
              show-overflow-tooltip
            />
            <el-table-column label="权重" width="80" align="center">
              <template #default="{ row }">{{ row.weight }}</template>
            </el-table-column>
          </el-table>
        </el-card>

        <el-card shadow="never" class="section-card" style="margin-top: 16px">
          <template #header>
            <span>Gold Standard</span>
            <el-button v-if="editing" type="primary" size="small" @click="editGold = !editGold">{{
              editGold ? '关闭编辑' : '编辑'
            }}</el-button>
          </template>
          <el-input
            v-if="editing && editGold"
            v-model="editForm.goldText"
            type="textarea"
            :rows="8"
            placeholder="Gold Standard JSON"
          />
          <pre v-else class="json-block">{{ formatJson(task.gold_standard) }}</pre>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { Delete } from '@element-plus/icons-vue';
import { guiEvalApi } from '@/api/guiEval';
import KhyPageHeader from '@/components/KhyPageHeader.vue';

const route = useRoute();
const router = useRouter();
const loading = ref(false);
const saving = ref(false);
const task = ref(null);
const editing = ref(false);
const editGold = ref(false);

const editForm = reactive({
  name: '',
  description: '',
  difficulty: 'medium',
  category: '',
  status: 'draft',
  basePrice: 320,
  maxDuration: 300,
  retryAllowed: true,
  materialsText: '[]',
  environmentText: '{}',
  goldText: '{}',
  checkpoints: [],
});

const checkpointTypes = [
  { value: 'screenshot_match', label: '截屏匹配' },
  { value: 'ui_element', label: 'UI 元素' },
  { value: 'file_created', label: '文件创建' },
  { value: 'file_content', label: '文件内容' },
  { value: 'process_running', label: '进程检查' },
  { value: 'semantic', label: '语义比对' },
  { value: 'custom_script', label: '自定义脚本' },
];

async function loadTask() {
  loading.value = true;
  try {
    const r = await guiEvalApi.getTask(route.params.id);
    task.value = r.data;
    Object.assign(editForm, {
      name: r.data.name,
      description: r.data.description || '',
      difficulty: r.data.difficulty || 'medium',
      category: r.data.category || '',
      status: r.data.status,
      basePrice: r.data.pricing?.basePrice || 320,
      maxDuration: r.data.max_duration || 300,
      retryAllowed: r.data.retry_allowed !== false,
      materialsText: JSON.stringify(r.data.materials || [], null, 2),
      environmentText: JSON.stringify(r.data.environment || {}, null, 2),
      goldText: JSON.stringify(r.data.gold_standard || {}, null, 2),
      checkpoints: JSON.parse(JSON.stringify(r.data.checkpoints || [])),
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
    let materials, environment, gold;
    try {
      materials = JSON.parse(editForm.materialsText);
    } catch {
      materials = [];
    }
    try {
      environment = JSON.parse(editForm.environmentText);
    } catch {
      environment = {};
    }
    try {
      gold = JSON.parse(editForm.goldText);
    } catch {
      gold = {};
    }
    await guiEvalApi.updateTask(task.value.id, {
      name: editForm.name,
      description: editForm.description,
      difficulty: editForm.difficulty,
      category: editForm.category,
      status: editForm.status,
      materials,
      environment,
      checkpoints: editForm.checkpoints,
      gold_standard: gold,
      pricing: { basePrice: editForm.basePrice },
      max_duration: editForm.maxDuration,
      retry_allowed: editForm.retryAllowed,
    });
    ElMessage.success('已保存');
    editing.value = false;
    editGold.value = false;
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

function addCheckpoint() {
  editForm.checkpoints.push({
    id: `cp${editForm.checkpoints.length + 1}`,
    type: 'ui_element',
    description: '',
    weight: 1,
  });
}

function formatJson(v) {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
function cpLabel(t) {
  const m = {
    screenshot_match: '截屏匹配',
    ui_element: 'UI 元素',
    file_created: '文件创建',
    file_content: '文件内容',
    process_running: '进程检查',
    semantic: '语义比对',
    custom_script: '自定义脚本',
  };
  return m[t] || t;
}

onMounted(() => {
  if (route.params.id) loadTask();
});
</script>

<style scoped>
.gui-eval-page {
  padding: 16px;
}
.section-card {
  border-radius: 8px;
  margin-bottom: 16px;
}
.loading-placeholder {
  padding: 16px;
}
.json-block {
  background: #f5f7fa;
  border-radius: 4px;
  padding: 12px;
  font-size: 12px;
  overflow-x: auto;
}
.json-label {
  font-size: 12px;
  color: #909399;
  margin-bottom: 4px;
}
.cp-item {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 8px;
}
</style>

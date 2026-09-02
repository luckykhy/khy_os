<template>
  <el-card class="cc-card" shadow="never" v-loading="loading">
    <template #header>
      <div class="cc-head">
        <span class="cc-title">供应商卡片（CC Switch 风格）</span>
        <div class="cc-head-actions">
          <el-button size="small" :loading="scanning" @click="onScan">扫描用量</el-button>
          <el-button size="small" type="primary" plain @click="openAdd">添加卡片</el-button>
        </div>
      </div>
    </template>

    <!-- 应用激活状态 -->
    <div class="cc-apps" v-if="apps.length">
      <div class="cc-app" v-for="a in apps" :key="a.app">
        <span class="cc-app-name">{{ a.label }}</span>
        <el-select
          size="small"
          :model-value="a.activeCardId || ''"
          placeholder="未激活"
          clearable
          style="width: 180px"
          @change="(v) => onUseCard(a.app, v)"
        >
          <el-option
            v-for="c in enabledCards"
            :key="c.id"
            :label="c.name"
            :value="c.id"
            :disabled="!c.apps.includes(a.app)"
          />
        </el-select>
        <span class="cc-app-scan" v-if="a.scanEnabled">自动扫描</span>
      </div>
    </div>

    <el-divider v-if="apps.length" />

    <!-- 卡片列表 -->
    <el-table :data="cards" size="small" empty-text="还没有供应商卡片。点击右上角「添加卡片」创建。">
      <el-table-column prop="name" label="名称" min-width="120" />
      <el-table-column prop="protocol" label="协议" width="120" />
      <el-table-column prop="baseUrl" label="Base URL" min-width="200" show-overflow-tooltip />
      <el-table-column label="密钥" width="80">
        <template #default="{ row }">
          <el-tag v-if="row.hasKey" size="small" type="success">已配置</el-tag>
          <el-tag v-else size="small" type="info">无</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="defaultModel" label="默认模型" min-width="140" show-overflow-tooltip />
      <el-table-column label="状态" width="80">
        <template #default="{ row }">
          <el-tag :type="row.enabled ? 'success' : 'danger'" size="small">{{
            row.enabled ? '启用' : '禁用'
          }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="200" fixed="right">
        <template #default="{ row }">
          <el-button
            size="small"
            text
            type="primary"
            @click="onToggle(row)"
            >{{ row.enabled ? '禁用' : '启用' }}</el-button
          >
          <el-button size="small" text type="danger" @click="onRemove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- 添加对话框 -->
    <el-dialog v-model="showAdd" title="添加供应商卡片" width="520px">
      <el-form :model="form" label-width="90px">
        <el-form-item label="名称" required>
          <el-input v-model="form.name" placeholder="如 DeepSeek / OpenRouter" />
        </el-form-item>
        <el-form-item label="Base URL" required>
          <el-input v-model="form.baseUrl" placeholder="https://api.deepseek.com/v1" />
        </el-form-item>
        <el-form-item label="API 密钥">
          <el-input
            v-model="form.key"
            type="password"
            show-password
            placeholder="留空则之后补充"
          />
        </el-form-item>
        <el-form-item label="协议">
          <el-select v-model="form.protocol" style="width: 100%">
            <el-option label="OpenAI (chat/completions)" value="openai" />
            <el-option label="Anthropic (messages)" value="anthropic" />
            <el-option label="OpenAI Responses (Codex)" value="openai_responses" />
            <el-option label="Gemini (generateContent)" value="gemini" />
          </el-select>
        </el-form-item>
        <el-form-item label="默认模型">
          <el-input v-model="form.defaultModel" placeholder="如 deepseek-chat" />
        </el-form-item>
        <el-form-item label="模型列表">
          <el-input v-model="form.modelsText" placeholder="逗号分隔，如 deepseek-chat,deepseek-reasoner" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showAdd = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="onAdd">保存</el-button>
      </template>
    </el-dialog>
  </el-card>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import request from '@/api/request';

const loading = ref(false);
const saving = ref(false);
const scanning = ref(false);
const showAdd = ref(false);
const cards = ref([]);
const apps = ref([]);

const form = ref({
  name: '',
  baseUrl: '',
  key: '',
  protocol: 'openai',
  defaultModel: '',
  modelsText: '',
});

const enabledCards = computed(() => cards.value.filter((c) => c.enabled));

async function fetchAll() {
  loading.value = true;
  try {
    const [c, s] = await Promise.all([
      request.get('/api/cc-switch/cards'),
      request.get('/api/cc-switch/status'),
    ]);
    cards.value = (c.data && c.data.data) || [];
    apps.value = (s.data && s.data.data) || [];
  } catch (err) {
    ElMessage.error(err?.response?.data?.message || '加载供应商卡片失败');
  } finally {
    loading.value = false;
  }
}

function openAdd() {
  form.value = { name: '', baseUrl: '', key: '', protocol: 'openai', defaultModel: '', modelsText: '' };
  showAdd.value = true;
}

async function onAdd() {
  if (!form.value.name || !form.value.baseUrl) {
    ElMessage.warning('名称与 Base URL 为必填');
    return;
  }
  saving.value = true;
  try {
    const payload = {
      name: form.value.name,
      baseUrl: form.value.baseUrl,
      protocol: form.value.protocol,
      defaultModel: form.value.defaultModel,
      models: form.value.modelsText
        .split(',')
        .map((m) => m.trim())
        .filter(Boolean),
    };
    if (form.value.key) payload.key = form.value.key;
    await request.post('/api/cc-switch/cards', payload);
    ElMessage.success('卡片已添加');
    showAdd.value = false;
    await fetchAll();
  } catch (err) {
    ElMessage.error(err?.response?.data?.message || '添加失败');
  } finally {
    saving.value = false;
  }
}

async function onUseCard(app, cardId) {
  if (!cardId) {
    return;
  }
  try {
    await request.post('/api/cc-switch/use', { app, cardId });
    ElMessage.success(`已切换 ${app} → 选中卡片`);
    await fetchAll();
  } catch (err) {
    ElMessage.error(err?.response?.data?.message || '切换失败');
    await fetchAll();
  }
}

async function onToggle(row) {
  try {
    await request.put(`/api/cc-switch/cards/${row.id}`, { enabled: !row.enabled });
    await fetchAll();
  } catch (err) {
    ElMessage.error(err?.response?.data?.message || '更新失败');
  }
}

async function onRemove(row) {
  try {
    await ElMessageBox.confirm(`确定删除卡片「${row.name}」？`, '删除确认', { type: 'warning' });
  } catch {
    return;
  }
  try {
    await request.delete(`/api/cc-switch/cards/${row.id}`);
    ElMessage.success('已删除');
    await fetchAll();
  } catch (err) {
    ElMessage.error(err?.response?.data?.message || '删除失败');
  }
}

async function onScan() {
  scanning.value = true;
  try {
    const res = await request.post('/api/cc-switch/scan', {});
    const d = res.data && res.data.data;
    ElMessage.success(`扫描完成：导入 ${d.imported} 条 / ${d.files} 个文件`);
  } catch (err) {
    ElMessage.error(err?.response?.data?.message || '扫描失败');
  } finally {
    scanning.value = false;
  }
}

onMounted(fetchAll);
</script>

<style scoped>
.cc-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.cc-title {
  font-weight: 600;
}
.cc-head-actions {
  display: flex;
  gap: 8px;
}
.cc-apps {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 4px;
}
.cc-app {
  display: flex;
  align-items: center;
  gap: 12px;
}
.cc-app-name {
  width: 110px;
  font-weight: 500;
}
.cc-app-scan {
  font-size: 12px;
  color: #909399;
}
</style>

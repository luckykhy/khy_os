<template>
  <div class="channel-apis-page">
    <KhyPageHeader
      subtitle="维护各 AI 渠道的端点与 Key，并查看 Agent 配置方法"
      title="渠道 API 文档"
    >
      <template #actions>
        <el-button @click="$router.push('/admin/channels/new')">
          <el-icon><Plus /></el-icon>
          新增渠道
        </el-button>
      </template>
    </KhyPageHeader>

    <el-card shadow="never">
      <el-form class="filter-bar" :inline="true">
        <el-form-item label="搜索">
          <el-input
            v-model="keyword"
            clearable
            placeholder="渠道名 / 供应商 / 端点 / 环境变量"
            style="width: 280px"
            @keyup.enter="loadData"
          />
        </el-form-item>
        <el-form-item>
          <el-button :loading="loading" @click="loadData">查询</el-button>
        </el-form-item>
      </el-form>

      <el-table v-loading="loading" :data="rows" stripe>
        <el-table-column label="渠道名" min-width="140">
          <template #default="{ row }">
            <el-link type="primary" @click="goEdit(row)">{{ row.channel_name }}</el-link>
          </template>
        </el-table-column>
        <el-table-column label="供应商" width="110">
          <template #default="{ row }">
            <el-tag size="small">{{ row.provider }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="端点 URL" min-width="230">
          <template #default="{ row }">
            <span v-if="row.endpoint_url" class="endpoint">{{ row.endpoint_url }}</span>
            <span v-else class="endpoint endpoint--empty">待填写</span>
          </template>
        </el-table-column>
        <el-table-column label="API Key" width="220">
          <template #default="{ row }">
            <span class="key-cell">
              <code class="key-text">{{ visibleKey(row) }}</code>
              <el-button
                v-if="row.has_key"
                :icon="isRevealed(row) ? Hide : View"
                link
                size="small"
                @click="toggleReveal(row)"
              />
            </span>
          </template>
        </el-table-column>
        <el-table-column label="配置方式" width="100">
          <template #default="{ row }">{{ methodLabel(row.config_method) }}</template>
        </el-table-column>
        <el-table-column fixed="right" label="操作" width="210">
          <template #default="{ row }">
            <el-button link size="small" type="primary" @click="goEdit(row)">编辑</el-button>
            <el-button link size="small" type="warning" @click="copyConfig(row)">
              复制配置
            </el-button>
            <el-button link size="small" type="danger" @click="removeRow(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div class="count-bar">
        <span>共 {{ rows.length }} 个渠道</span>
        <el-link type="primary" @click="$router.push('/admin/channels/new')">
          新增一个渠道
        </el-link>
      </div>
    </el-card>

    <el-card class="guide-card" shadow="never">
      <template #header>
        <span>各 Agent 渠道配置方法</span>
      </template>

      <el-row :gutter="16">
        <el-col
          v-for="agent in agents"
          :key="agent.agent"
          :lg="8"
          :md="12"
          :xs="24"
        >
          <div class="guide-item">
            <div class="guide-title">
              <span>{{ agent.agent }}</span>
              <el-tag size="small">{{ agent.provider }}</el-tag>
            </div>
            <ul class="guide-steps">
              <li v-for="(step, index) in agent.steps" :key="index">{{ step }}</li>
            </ul>
            <div class="guide-meta">
              <span v-if="agent.envVars.length">变量：{{ agent.envVars.join(' / ') }}</span>
              <span v-else class="guide-meta--muted">变量：待填写</span>
              <span v-if="agent.configFile" class="guide-meta__file">{{ agent.configFile }}</span>
              <el-link
                v-if="agent.docsUrl"
                href="#"
                @click="openDocs(agent.docsUrl)"
                >官方文档</el-link
              >
            </div>
          </div>
        </el-col>
      </el-row>
    </el-card>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Hide, Plus, View } from '@element-plus/icons-vue';
import { channelApisApi } from '@/api/channelApis';
import KhyPageHeader from '@/components/KhyPageHeader.vue';

const loading = ref(false);
const keyword = ref('');
const rows = ref([]);
// id -> plaintext key. Held in component memory only; it is never written to
// localStorage / sessionStorage.
const revealed = reactive({});
const agents = ref([]);
const router = useRouter();

const METHODS = {
  env_var: '环境变量',
  config_file: '配置文件',
  both: '两者皆可',
};

function methodLabel(method) {
  return METHODS[method] || method || '—';
}

function isRevealed(row) {
  return Boolean(revealed[row.id]);
}

function visibleKey(row) {
  return revealed[row.id] || row.masked_key || '未设置';
}

function goEdit(row) {
  if (!row || row.id == null) {
    return;
  }
  router.push(`/admin/channels/${row.id}`);
}

function copyText(text, label) {
  return navigator.clipboard.writeText(String(text || '')).then(() => {
    ElMessage.success(`${label}已复制`);
  });
}

/** 文档区：内置 Agent 配置说明，与数据库行无关。 */
async function loadAgents() {
  try {
    const res = await channelApisApi.agentGuides();
    agents.value = ((res && res.data && res.data.agents) || []).map((a) => ({
      ...a,
      envVars: Array.isArray(a.envVars) ? a.envVars : [],
      steps: Array.isArray(a.steps) ? a.steps : [],
    }));
  } catch {
    agents.value = [];
  }
}

function openDocs(url) {
  if (url) {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

async function loadData() {
  loading.value = true;
  try {
    const params = keyword.value.trim() ? { q: keyword.value.trim() } : {};
    const res = await channelApisApi.list(params);
    rows.value = (res && res.data && res.data.channels) || [];
  } catch {
    ElMessage.error('加载渠道列表失败，请确认后端服务已启动');
  } finally {
    loading.value = false;
  }
}

/** 眼睛图标：一次性取明文并就地展示；再次点击收起。 */
async function toggleReveal(row) {
  if (revealed[row.id]) {
    delete revealed[row.id];
    return;
  }
  try {
    const res = await channelApisApi.reveal(row.id);
    const key = (res && res.api_key) || '';
    if (!key) {
      ElMessage.warning('该渠道未保存 Key');
      return;
    }
    revealed[row.id] = key;
  } catch {
    ElMessage.error('取明文失败，请确认已登录管理员账号');
  }
}

/** 复制配置命令：已有 Key 时走 reveal（服务端审计），否则给可填空模板。 */
async function copyConfig(row) {
  let text = '';
  if (row.has_key) {
    try {
      const res = await channelApisApi.reveal(row.id);
      text = (res && res.config && res.config.copy && res.config.copy.envExport) || '';
    } catch {
      text = '';
    }
  }
  if (!text) {
    const res = await channelApisApi.config(row.id);
    text = (res && res.copy && res.copy.envExport) || '';
  }
  if (!text) {
    ElMessage.warning('该渠道未填写环境变量名，无法生成配置命令');
    return;
  }
  try {
    await copyText(text, '配置命令');
  } catch {
    ElMessage.warning('复制失败，请手动选中文本复制');
  }
}

async function removeRow(row) {
  try {
    await ElMessageBox.confirm(
      `确定删除渠道「${row.channel_name}」？其端点与 Key 将一并清除。`,
      '确认删除',
      { type: 'warning' }
    );
  } catch {
    return;
  }
  try {
    await channelApisApi.remove(row.id);
    ElMessage.success('已删除');
    delete revealed[row.id];
    await loadData();
  } catch {
    ElMessage.error('删除失败，请稍后重试');
  }
}

onMounted(() => {
  loadData();
  loadAgents();
});
</script>

<style scoped>
.channel-apis-page {
  padding: 16px;
}

.filter-bar {
  margin-bottom: 16px;
}

.endpoint {
  font-family: var(--khy-font-mono, ui-monospace, monospace);
  font-size: 12px;
  word-break: break-all;
}

.endpoint--empty {
  color: var(--khy-text-muted, #999);
}

.key-cell {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.key-text {
  font-family: var(--khy-font-mono, ui-monospace, monospace);
  font-size: 12px;
}

.count-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 16px;
  color: var(--khy-text-secondary);
  font-size: 13px;
}

.guide-card {
  margin-top: 16px;
}

.guide-item {
  padding: 12px;
  border: 1px solid var(--khy-border-light, var(--el-border-color-lighter));
  border-radius: var(--khy-radius-sm, 6px);
  background: var(--khy-bg-soft, var(--el-fill-color-blank));
}

.guide-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
  font-weight: 600;
}

.guide-steps {
  margin: 0 0 8px 0;
  padding-left: 18px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--khy-text-secondary);
}

.guide-steps li {
  word-break: break-word;
}

.guide-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 12px;
  align-items: center;
  font-size: 12px;
  color: var(--khy-text-muted, #999);
}

.guide-meta__file {
  font-family: var(--khy-font-mono, ui-monospace, monospace);
  word-break: break-all;
}

.guide-meta--muted {
  color: var(--khy-text-muted, #999);
}
</style>

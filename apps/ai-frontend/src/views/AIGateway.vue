<template>
  <div class="ai-gateway">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>AI 网关配置</span>
          <el-button type="primary" @click="refreshStatus">刷新状态</el-button>
        </div>
      </template>

      <el-table :data="gatewayList" style="width: 100%">
        <el-table-column prop="provider" label="供应商" width="150" />
        <el-table-column prop="name" label="服务名称" />
        <el-table-column label="状态">
          <template #default="{ row }">
            <el-tag :type="row.status === 'available' ? 'success' : 'danger'">
              {{ row.status === 'available' ? '可用' : '不可用' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="latency" label="延迟 (ms)" width="120" />
        <el-table-column prop="requests" label="请求数" width="120" />
        <el-table-column label="优先级" width="100">
          <template #default="{ row }">
            {{ row.priority }}
          </template>
        </el-table-column>
        <el-table-column label="操作" width="200">
          <template #default="{ row }">
            <el-button size="small" @click="testProvider(row)">测试</el-button>
            <el-button size="small" type="primary" @click="editProvider(row)">编辑</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card style="margin-top: 20px">
      <template #header>
        <span>网关统计</span>
      </template>
      <el-row :gutter="20">
        <el-col :span="8">
          <div class="stat-item">
            <div class="stat-label">总请求数</div>
            <div class="stat-value">{{ stats.totalRequests }}</div>
          </div>
        </el-col>
        <el-col :span="8">
          <div class="stat-item">
            <div class="stat-label">成功率</div>
            <div class="stat-value">{{ stats.successRate }}%</div>
          </div>
        </el-col>
        <el-col :span="8">
          <div class="stat-item">
            <div class="stat-label">平均延迟</div>
            <div class="stat-value">{{ stats.avgLatency }}ms</div>
          </div>
        </el-col>
      </el-row>
    </el-card>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { authedFetch } from '@/utils/authedFetch';
import { ElMessage } from 'element-plus';

const gatewayList = ref([]);
const stats = ref({
  totalRequests: 0,
  successRate: 0,
  avgLatency: 0
});

async function loadGatewayStatus() {
  try {
    const data = await authedFetch('/api/gateway/status');
    gatewayList.value = data.providers || [];
    stats.value = data.stats || stats.value;
  } catch (error) {
    ElMessage.error('加载网关状态失败');
  }
}

async function refreshStatus() {
  await loadGatewayStatus();
  ElMessage.success('状态已刷新');
}

async function testProvider(provider) {
  try {
    ElMessage.info(`正在测试 ${provider.name}...`);
    await authedFetch(`/api/gateway/test/${provider.provider}`);
    ElMessage.success(`${provider.name} 测试成功`);
    await loadGatewayStatus();
  } catch (error) {
    ElMessage.error(`${provider.name} 测试失败: ${error.message}`);
  }
}

function editProvider(provider) {
  ElMessage.info('编辑功能待实现');
}

onMounted(() => {
  loadGatewayStatus();
});
</script>

<style scoped>
.ai-gateway {
  width: 100%;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.stat-item {
  text-align: center;
  padding: 20px;
  background: #f5f7fa;
  border-radius: 8px;
}

.stat-label {
  font-size: 14px;
  color: #909399;
  margin-bottom: 8px;
}

.stat-value {
  font-size: 24px;
  font-weight: 600;
  color: #333;
}
</style>

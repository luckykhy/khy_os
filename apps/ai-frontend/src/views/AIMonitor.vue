<template>
  <div class="ai-monitor">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>AI 监控</span>
          <el-button type="primary" @click="refreshMetrics">刷新</el-button>
        </div>
      </template>

      <el-row :gutter="20">
        <el-col :span="6">
          <div class="metric-card">
            <div class="metric-label">请求总数</div>
            <div class="metric-value">{{ metrics.totalRequests }}</div>
            <div class="metric-change success">+12.5%</div>
          </div>
        </el-col>
        <el-col :span="6">
          <div class="metric-card">
            <div class="metric-label">成功率</div>
            <div class="metric-value">{{ metrics.successRate }}%</div>
            <div class="metric-change success">+2.3%</div>
          </div>
        </el-col>
        <el-col :span="6">
          <div class="metric-card">
            <div class="metric-label">平均延迟</div>
            <div class="metric-value">{{ metrics.avgLatency }}ms</div>
            <div class="metric-change warning">+5.2%</div>
          </div>
        </el-col>
        <el-col :span="6">
          <div class="metric-card">
            <div class="metric-label">错误数</div>
            <div class="metric-value">{{ metrics.errors }}</div>
            <div class="metric-change danger">+8</div>
          </div>
        </el-col>
      </el-row>
    </el-card>

    <el-card style="margin-top: 20px">
      <template #header>
        <span>请求趋势</span>
      </template>
      <div ref="trendChartRef" style="width: 100%; height: 400px"></div>
    </el-card>

    <el-card style="margin-top: 20px">
      <template #header>
        <span>错误日志</span>
      </template>
      <el-table :data="errorLogs" style="width: 100%">
        <el-table-column prop="timestamp" label="时间" width="180" />
        <el-table-column prop="provider" label="供应商" width="120" />
        <el-table-column prop="error" label="错误信息" />
        <el-table-column prop="count" label="次数" width="80" />
      </el-table>
    </el-card>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { authedFetch } from '@/utils/authedFetch';
import { ElMessage } from 'element-plus';

const metrics = ref({
  totalRequests: 0,
  successRate: 0,
  avgLatency: 0,
  errors: 0
});

const errorLogs = ref([]);

async function loadMetrics() {
  try {
    const data = await authedFetch('/api/monitor/metrics');
    metrics.value = data.metrics || metrics.value;
    errorLogs.value = data.errorLogs || [];
  } catch (error) {
    ElMessage.error('加载监控数据失败');
  }
}

async function refreshMetrics() {
  await loadMetrics();
  ElMessage.success('数据已刷新');
}

onMounted(() => {
  loadMetrics();
});
</script>

<style scoped>
.ai-monitor {
  width: 100%;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.metric-card {
  text-align: center;
  padding: 24px;
  background: #f5f7fa;
  border-radius: 8px;
}

.metric-label {
  font-size: 14px;
  color: #909399;
  margin-bottom: 12px;
}

.metric-value {
  font-size: 32px;
  font-weight: 600;
  color: #333;
  margin-bottom: 8px;
}

.metric-change {
  font-size: 14px;
  font-weight: 500;
}

.metric-change.success {
  color: #67c23a;
}

.metric-change.warning {
  color: #e6a23c;
}

.metric-change.danger {
  color: #f56c6c;
}
</style>

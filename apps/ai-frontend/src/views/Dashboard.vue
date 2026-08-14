<template>
  <div class="dashboard">
    <el-row :gutter="20">
      <el-col :span="6">
        <el-card class="stat-card">
          <div class="stat-content">
            <div class="stat-icon success">
              <el-icon><Check /></el-icon>
            </div>
            <div class="stat-info">
              <div class="stat-value">{{ stats.activeAgents }}</div>
              <div class="stat-label">活跃智能体</div>
            </div>
          </div>
        </el-card>
      </el-col>

      <el-col :span="6">
        <el-card class="stat-card">
          <div class="stat-content">
            <div class="stat-icon primary">
              <el-icon><Connection /></el-icon>
            </div>
            <div class="stat-info">
              <div class="stat-value">{{ stats.apiCalls }}</div>
              <div class="stat-label">API 调用次数</div>
            </div>
          </div>
        </el-card>
      </el-col>

      <el-col :span="6">
        <el-card class="stat-card">
          <div class="stat-content">
            <div class="stat-icon warning">
              <el-icon><CreditCard /></el-icon>
            </div>
            <div class="stat-info">
              <div class="stat-value">¥{{ stats.totalCost }}</div>
              <div class="stat-label">总消费</div>
            </div>
          </div>
        </el-card>
      </el-col>

      <el-col :span="6">
        <el-card class="stat-card">
          <div class="stat-content">
            <div class="stat-icon info">
              <el-icon><User /></el-icon>
            </div>
            <div class="stat-info">
              <div class="stat-value">{{ stats.totalUsers }}</div>
              <div class="stat-label">总用户数</div>
            </div>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-row :gutter="20" style="margin-top: 20px">
      <el-col :span="12">
        <el-card>
          <template #header>
            <span>AI 服务状态</span>
          </template>
          <el-table :data="serviceStatus" style="width: 100%">
            <el-table-column prop="name" label="服务名称" />
            <el-table-column prop="status" label="状态">
              <template #default="{ row }">
                <el-tag :type="row.status === '正常' ? 'success' : 'danger'">
                  {{ row.status }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="latency" label="延迟 (ms)" />
          </el-table>
        </el-card>
      </el-col>

      <el-col :span="12">
        <el-card>
          <template #header>
            <span>最近活动</span>
          </template>
          <el-timeline>
            <el-timeline-item
              v-for="(activity, index) in recentActivities"
              :key="index"
              :timestamp="activity.timestamp"
            >
              {{ activity.content }}
            </el-timeline-item>
          </el-timeline>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { authedFetch } from '@/utils/authedFetch';

const stats = ref({
  activeAgents: 0,
  apiCalls: 0,
  totalCost: 0,
  totalUsers: 0
});

const serviceStatus = ref([
  { name: 'Claude API', status: '正常', latency: 120 },
  { name: 'Qwen API', status: '正常', latency: 95 },
  { name: 'Cursor API', status: '正常', latency: 110 }
]);

const recentActivities = ref([
  { content: '用户 admin 登录系统', timestamp: '2024-08-14 10:30:00' },
  { content: 'AI 网关配置已更新', timestamp: '2024-08-14 10:15:00' },
  { content: '新智能体已创建', timestamp: '2024-08-14 09:45:00' }
]);

onMounted(async () => {
  try {
    const data = await authedFetch('/api/dashboard/stats');
    stats.value = data.stats || stats.value;
  } catch (error) {
    console.error('Failed to load dashboard stats:', error);
  }
});
</script>

<style scoped>
.dashboard {
  width: 100%;
}

.stat-card {
  height: 120px;
}

.stat-content {
  display: flex;
  align-items: center;
  gap: 16px;
  height: 100%;
}

.stat-icon {
  width: 60px;
  height: 60px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 28px;
  color: #fff;
}

.stat-icon.success {
  background-color: #67c23a;
}

.stat-icon.primary {
  background-color: #409eff;
}

.stat-icon.warning {
  background-color: #e6a23c;
}

.stat-icon.info {
  background-color: #909399;
}

.stat-info {
  flex: 1;
}

.stat-value {
  font-size: 28px;
  font-weight: 600;
  color: #333;
  line-height: 1.2;
}

.stat-label {
  font-size: 14px;
  color: #909399;
  margin-top: 4px;
}
</style>

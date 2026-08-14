<template>
  <div class="agent-dashboard">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>智能体控制台</span>
          <el-button type="primary" @click="createAgent">创建智能体</el-button>
        </div>
      </template>

      <el-table :data="agentList" style="width: 100%">
        <el-table-column prop="id" label="ID" width="80" />
        <el-table-column prop="name" label="名称" />
        <el-table-column prop="type" label="类型" width="120" />
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="getStatusType(row.status)">
              {{ getStatusText(row.status) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="requests" label="请求数" width="100" />
        <el-table-column prop="lastActive" label="最后活动" width="180" />
        <el-table-column label="操作" width="200">
          <template #default="{ row }">
            <el-button size="small" @click="viewAgent(row)">查看</el-button>
            <el-button
              size="small"
              :type="row.status === 'running' ? 'warning' : 'success'"
              @click="toggleAgent(row)"
            >
              {{ row.status === 'running' ? '停止' : '启动' }}
            </el-button>
            <el-button size="small" type="danger" @click="deleteAgent(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-row :gutter="20" style="margin-top: 20px">
      <el-col :span="12">
        <el-card>
          <template #header>
            <span>智能体性能</span>
          </template>
          <div ref="performanceChartRef" style="width: 100%; height: 300px"></div>
        </el-card>
      </el-col>

      <el-col :span="12">
        <el-card>
          <template #header>
            <span>智能体日志</span>
          </template>
          <div class="log-container">
            <div v-for="(log, index) in agentLogs" :key="index" class="log-item">
              <span class="log-time">{{ log.timestamp }}</span>
              <span :class="['log-level', log.level]">{{ log.level }}</span>
              <span class="log-message">{{ log.message }}</span>
            </div>
          </div>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { authedFetch } from '@/utils/authedFetch';
import { ElMessage, ElMessageBox } from 'element-plus';

const agentList = ref([]);
const agentLogs = ref([]);

function getStatusType(status) {
  const types = {
    running: 'success',
    stopped: 'info',
    error: 'danger'
  };
  return types[status] || 'info';
}

function getStatusText(status) {
  const texts = {
    running: '运行中',
    stopped: '已停止',
    error: '错误'
  };
  return texts[status] || status;
}

async function loadAgents() {
  try {
    const data = await authedFetch('/api/agents');
    agentList.value = data.agents || [];
  } catch (error) {
    ElMessage.error('加载智能体列表失败');
  }
}

async function loadLogs() {
  try {
    const data = await authedFetch('/api/agents/logs');
    agentLogs.value = data.logs || [];
  } catch (error) {
    console.error('Failed to load logs:', error);
  }
}

function createAgent() {
  ElMessage.info('创建智能体功能待实现');
}

function viewAgent(agent) {
  ElMessage.info(`查看智能体: ${agent.name}`);
}

async function toggleAgent(agent) {
  const action = agent.status === 'running' ? 'stop' : 'start';
  try {
    await authedFetch(`/api/agents/${agent.id}/${action}`, { method: 'POST' });
    ElMessage.success(`智能体已${action === 'start' ? '启动' : '停止'}`);
    await loadAgents();
  } catch (error) {
    ElMessage.error(`操作失败: ${error.message}`);
  }
}

async function deleteAgent(agent) {
  try {
    await ElMessageBox.confirm(`确定要删除智能体 "${agent.name}" 吗？`, '警告', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning'
    });

    await authedFetch(`/api/agents/${agent.id}`, { method: 'DELETE' });
    ElMessage.success('智能体已删除');
    await loadAgents();
  } catch (error) {
    if (error !== 'cancel') {
      ElMessage.error('删除失败');
    }
  }
}

onMounted(() => {
  loadAgents();
  loadLogs();
});
</script>

<style scoped>
.agent-dashboard {
  width: 100%;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.log-container {
  max-height: 300px;
  overflow-y: auto;
  font-family: 'Courier New', monospace;
  font-size: 12px;
}

.log-item {
  padding: 6px 0;
  border-bottom: 1px solid #ebeef5;
  display: flex;
  gap: 12px;
}

.log-time {
  color: #909399;
  flex-shrink: 0;
}

.log-level {
  font-weight: 600;
  flex-shrink: 0;
  width: 50px;
}

.log-level.INFO {
  color: #409eff;
}

.log-level.WARN {
  color: #e6a23c;
}

.log-level.ERROR {
  color: #f56c6c;
}

.log-message {
  flex: 1;
}
</style>

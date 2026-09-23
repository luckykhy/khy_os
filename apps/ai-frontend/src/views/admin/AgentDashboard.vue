<template>
  <div class="khy-page agent-dashboard">
    <KhyPageHeader title="Agent 监控">
      <template #actions>
        <el-switch
          v-model="autoRefresh"
          active-text="自动"
          inactive-text="手动"
          inline-prompt
          @change="toggleAutoRefresh"
        />
        <el-button :loading="loading" size="small" type="primary" @click="manualRefresh">
          刷新
        </el-button>
      </template>
    </KhyPageHeader>

    <!-- 连接降级提示:轮询连续失败后自动暂停,给一条非侵入的横幅 + 手动重试入口,
         而不是每 5 秒弹一次 toast 刷屏。 -->
    <el-alert
      v-if="degraded"
      class="degraded-banner"
      :closable="false"
      show-icon
      title="暂时连不上 Agent 监控服务"
      type="warning"
    >
      <template #default>
        <span>已自动暂停刷新以避免持续报错。后端恢复后点「重试」即可继续。</span>
        <el-button class="degraded-retry" plain size="small" type="warning" @click="manualRefresh">
          重试
        </el-button>
      </template>
    </el-alert>

    <!-- Stats summary -->
    <el-row class="stats-row" :gutter="12">
      <el-col v-for="s in statCards" :key="s.label" :sm="6" :xs="12">
        <el-card class="stat-card" shadow="never">
          <div class="stat-value" :style="{ color: s.color }">{{ s.value }}</div>
          <div class="stat-label">{{ s.label }}</div>
        </el-card>
      </el-col>
    </el-row>

    <!-- Agent tree -->
    <el-card class="section-card" shadow="hover">
      <template #header>
        <span>Agent 层级</span>
        <el-tag v-if="dashboard.stats" size="small" style="margin-left: 8px" type="info">
          最大深度：{{ dashboard.stats.maxDepth }}
        </el-tag>
      </template>

      <KhyEmpty
        v-if="!tree.length"
        compact
        description="当你在对话中触发多智能体协作时，它们的层级会实时出现在这里。"
        :icon="Cpu"
        title="当前没有正在运行的 Agent"
      />

      <el-tree
        v-else
        :data="tree"
        default-expand-all
        node-key="id"
        :props="{ children: 'children', label: 'id' }"
      >
        <template #default="{ data }">
          <div class="agent-node">
            <el-tag effect="dark" size="small" :type="statusTagType(data.status)">
              {{ data.status }}
            </el-tag>
            <span class="agent-id">{{ data.id }}</span>
            <el-tag size="small" type="info">{{ data.role }}</el-tag>
            <span v-if="data.runningMs" class="agent-time">
              {{ formatMs(data.runningMs) }}
            </span>
            <el-badge
              v-if="data.mailboxSize > 0"
              class="agent-badge"
              type="warning"
              :value="data.mailboxSize"
            />
          </div>
        </template>
      </el-tree>
    </el-card>

    <!-- Flat agent table -->
    <el-card class="section-card" shadow="hover">
      <template #header><span>全部 Agent</span></template>
      <el-table :data="agents" empty-text="暂无 Agent 记录" size="small" stripe>
        <el-table-column label="ID" prop="id" show-overflow-tooltip width="180" />
        <el-table-column label="角色" prop="role" width="100">
          <template #default="{ row }">
            <el-tag size="small">{{ row.role }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="状态" prop="status" width="100">
          <template #default="{ row }">
            <el-tag size="small" :type="statusTagType(row.status)">{{ row.status }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column align="center" label="深度" prop="depth" width="70" />
        <el-table-column label="耗时" width="100">
          <template #default="{ row }">{{ formatMs(row.runningMs) }}</template>
        </el-table-column>
        <el-table-column label="父节点" prop="parentId" show-overflow-tooltip width="180" />
        <el-table-column align="center" label="信箱" prop="mailboxSize" width="80" />
      </el-table>
    </el-card>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { Cpu } from '@element-plus/icons-vue';
import { useAgentDashboard } from '@/composables/useAgentDashboard';
import KhyEmpty from '@/components/KhyEmpty.vue';
import KhyPageHeader from '@/components/KhyPageHeader.vue';

// The fetch + backoff state machine lives in useAgentDashboard so /admin/overview
// can show the same agent block without forking the polling logic.
const autoRefresh = ref(true);
const agent = useAgentDashboard({ auto: autoRefresh });

const {
  dashboard,
  agents,
  tree,
  loading,
  degraded,
  statCards,
  manualRefresh,
  statusTagType,
  formatMs,
} = agent;

function toggleAutoRefresh(val) {
  agent.toggleAuto(val);
}
</script>

<style scoped>
.agent-dashboard {
  padding: 16px;
}
.stats-row {
  margin-bottom: 16px;
}
.degraded-banner {
  margin-bottom: 16px;
}
.degraded-retry {
  margin-left: 12px;
}
.stat-card {
  text-align: center;
  padding: 8px 0;
}
.stat-value {
  font-size: 28px;
  font-weight: 700;
  line-height: 1.2;
}
.stat-label {
  font-size: 12px;
  color: var(--khy-gray-400);
  margin-top: 4px;
}
.section-card {
  margin-bottom: 16px;
}
.agent-node {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 0;
}
.agent-id {
  font-family: var(--khy-font-mono, monospace);
  font-size: 13px;
}
.agent-time {
  font-size: 12px;
  color: var(--khy-gray-400);
}
</style>

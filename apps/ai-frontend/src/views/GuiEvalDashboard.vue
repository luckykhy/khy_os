<template>
  <div class="gui-eval-page">
    <KhyPageHeader title="GUI Agent 评测平台">
      <template #actions>
        <el-button type="primary" @click="$router.push('/gui-eval/tasks')">
          <el-icon><Plus /></el-icon> 新建任务
        </el-button>
        <el-button @click="$router.push('/gui-eval/runs')">
          <el-icon><VideoPlay /></el-icon> 执行记录
        </el-button>
      </template>
    </KhyPageHeader>

    <el-row :gutter="16" class="stats-row">
      <el-col :xs="24" :sm="12" :md="6">
        <el-card shadow="hover" class="stat-card stat-card--blue">
          <div class="stat-title">总任务数</div>
          <div class="stat-value">{{ stats?.tasks?.total ?? '-' }}</div>
          <div class="stat-sub">启用 {{ stats?.tasks?.active ?? 0 }} 个</div>
        </el-card>
      </el-col>
      <el-col :xs="24" :sm="12" :md="6">
        <el-card shadow="hover" class="stat-card stat-card--green">
          <div class="stat-title">总执行数</div>
          <div class="stat-value">{{ stats?.runs?.total ?? '-' }}</div>
          <div class="stat-sub">
            通过 {{ stats?.runs?.pass ?? 0 }} / 部分 {{ stats?.runs?.partial ?? 0 }} / 失败
            {{ stats?.runs?.fail ?? 0 }}
          </div>
        </el-card>
      </el-col>
      <el-col :xs="24" :sm="12" :md="6">
        <el-card shadow="hover" class="stat-card stat-card--amber">
          <div class="stat-title">待评测</div>
          <div class="stat-value">{{ stats?.runs?.pending ?? '-' }}</div>
          <div class="stat-sub">等待自动或人工评测</div>
        </el-card>
      </el-col>
      <el-col :xs="24" :sm="12" :md="6">
        <el-card shadow="hover" class="stat-card stat-card--purple">
          <div class="stat-title">累计结算</div>
          <div class="stat-value">¥{{ formatMoney(stats?.payout?.total) }}</div>
        </el-card>
      </el-col>
    </el-row>

    <el-row :gutter="16" class="content-row">
      <el-col :xs="24" :lg="14">
        <el-card shadow="never" class="section-card">
          <template #header>
            <div class="section-header">
              <span>最近执行记录</span>
              <el-button type="primary" link @click="$router.push('/gui-eval/runs')"
                >查看全部</el-button
              >
            </div>
          </template>
          <el-table :data="recentRuns" stripe size="small" v-loading="loading">
            <el-table-column prop="id" label="ID" width="60" />
            <el-table-column label="任务" min-width="180">
              <template #default="{ row }">
                <el-link type="primary" @click="$router.push(`/gui-eval/tasks/${row.task_id}`)">
                  {{ row.task?.name || `任务 #${row.task_id}` }}
                </el-link>
              </template>
            </el-table-column>
            <el-table-column label="状态" width="100">
              <template #default="{ row }">
                <el-tag :type="statusTagType(row.status)" size="small">{{ row.status }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="判定" width="90">
              <template #default="{ row }">
                <el-tag v-if="row.verdict" :type="verdictTagType(row.verdict)" size="small">{{
                  row.verdict
                }}</el-tag>
                <span v-else class="text-muted">-</span>
              </template>
            </el-table-column>
            <el-table-column label="得分" width="80" align="center">
              <template #default="{ row }">
                <span v-if="row.overall_score != null"
                  >{{ (row.overall_score * 100).toFixed(0) }}%</span
                >
                <span v-else class="text-muted">-</span>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="80" align="center">
              <template #default="{ row }">
                <el-button
                  type="primary"
                  link
                  size="small"
                  @click="$router.push(`/gui-eval/runs/${row.id}`)"
                  >详情</el-button
                >
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>

      <el-col :xs="24" :lg="10">
        <el-card shadow="never" class="section-card">
          <template #header>
            <div class="section-header">
              <span>模型排行</span>
            </div>
          </template>
          <el-table :data="leaderboard" stripe size="small" v-loading="loading">
            <el-table-column label="排名" width="50" type="index" align="center" />
            <el-table-column prop="model" label="模型" min-width="160" />
            <el-table-column label="执行" width="80" align="center">
              <template #default="{ row }">{{ row.runs }}</template>
            </el-table-column>
            <el-table-column label="均分" width="80" align="center">
              <template #default="{ row }">{{ (row.avgScore * 100).toFixed(0) }}%</template>
            </el-table-column>
            <el-table-column label="总支出" width="100" align="right">
              <template #default="{ row }">¥{{ formatMoney(row.totalPayout) }}</template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import { Plus, VideoPlay } from '@element-plus/icons-vue';
import { guiEvalApi } from '@/api/guiEval';
import KhyPageHeader from '@/components/KhyPageHeader.vue';

const loading = ref(false);
const stats = ref(null);
const recentRuns = ref([]);
const leaderboard = ref([]);

async function loadStats() {
  try {
    stats.value = (await guiEvalApi.getStats()).data;
  } catch {
    /* stats optional */
  }
}
async function loadRuns() {
  try {
    const r = await guiEvalApi.listRuns({ pageSize: 10 });
    recentRuns.value = r.runs || [];
  } catch {
    /* skip */
  }
}
async function loadLeaderboard() {
  try {
    leaderboard.value = (await guiEvalApi.getLeaderboard()).data.leaderboard || [];
  } catch {
    /* skip */
  }
}

async function refresh() {
  loading.value = true;
  try {
    await Promise.all([loadStats(), loadRuns(), loadLeaderboard()]);
  } finally {
    loading.value = false;
  }
}

onMounted(refresh);

function statusTagType(s) {
  const m = {
    queued: 'info',
    preparing: 'info',
    running: '',
    evaluating: 'warning',
    completed: 'success',
    failed: 'danger',
    cancelled: 'info',
    timeout: 'danger',
  };
  return m[s] || 'info';
}
function verdictTagType(v) {
  const m = {
    pass: 'success',
    partial: 'warning',
    fail: 'danger',
    pending: 'info',
    pending_review: 'warning',
  };
  return m[v] || 'info';
}
function formatMoney(n) {
  const v = Number(n) || 0;
  return v.toFixed(2);
}
</script>

<style scoped>
.gui-eval-page {
  padding: 16px;
}
.stats-row {
  margin-bottom: 16px;
}
.stat-card {
  border-radius: 8px;
}
.stat-card .stat-title {
  font-size: 13px;
  color: #909399;
  margin-bottom: 4px;
}
.stat-card .stat-value {
  font-size: 28px;
  font-weight: 700;
  color: #303133;
}
.stat-card .stat-sub {
  font-size: 12px;
  color: #c0c4cc;
  margin-top: 2px;
}
.stat-card--blue .stat-value {
  color: var(--khy-primary);
}
.stat-card--green .stat-value {
  color: var(--khy-success);
}
.stat-card--amber .stat-value {
  color: #e6a23c;
}
.stat-card--purple .stat-value {
  color: #909399;
}
.content-row {
}
.section-card {
  border-radius: 8px;
  margin-bottom: 16px;
}
.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.text-muted {
  color: #c0c4cc;
}
</style>

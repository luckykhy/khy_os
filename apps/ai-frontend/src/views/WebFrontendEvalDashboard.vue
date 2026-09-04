<template>
  <div class="wfe-page">
    <KhyPageHeader title="前端标注平台">
      <template #actions>
        <el-button type="primary" @click="$router.push('/web-frontend-eval/tasks')">
          <el-icon><Plus /></el-icon> 新建任务
        </el-button>
        <el-button @click="$router.push('/web-frontend-eval/runs')">
          <el-icon><Document /></el-icon> 执行记录
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
            完成 {{ stats?.runs?.completed ?? 0 }} / 驳回 {{ stats?.runs?.rejected ?? 0 }}
          </div>
        </el-card>
      </el-col>
      <el-col :xs="24" :sm="12" :md="6">
        <el-card shadow="hover" class="stat-card stat-card--amber">
          <div class="stat-title">标注中</div>
          <div class="stat-value">{{ stats?.runs?.annotating ?? '-' }}</div>
          <div class="stat-sub">等待 QC 审核</div>
        </el-card>
      </el-col>
      <el-col :xs="24" :sm="12" :md="6">
        <el-card shadow="hover" class="stat-card stat-card--purple">
          <div class="stat-title">层级分布</div>
          <div class="stat-value">{{ levelBreakdown }}</div>
          <div class="stat-sub">L1 / L2 / L3 任务</div>
        </el-card>
      </el-col>
    </el-row>

    <el-row :gutter="16" class="content-row">
      <el-col :xs="24" :lg="14">
        <el-card shadow="never" class="section-card">
          <template #header>
            <div class="section-header">
              <span>最近执行记录</span>
              <el-button type="primary" link @click="$router.push('/web-frontend-eval/runs')"
                >查看全部</el-button
              >
            </div>
          </template>
          <el-table :data="recentRuns" stripe size="small" v-loading="loading">
            <el-table-column prop="id" label="ID" width="60" />
            <el-table-column label="任务" min-width="180">
              <template #default="{ row }">
                <el-link
                  type="primary"
                  @click="$router.push(`/web-frontend-eval/tasks/${row.task_id}`)"
                >
                  {{ row.task?.name || `任务 #${row.task_id}` }}
                </el-link>
              </template>
            </el-table-column>
            <el-table-column label="层级" width="70" align="center">
              <template #default="{ row }">{{ row.task?.level || '-' }}</template>
            </el-table-column>
            <el-table-column label="分类" width="70" align="center">
              <template #default="{ row }">{{ row.task?.category?.toUpperCase() || '-' }}</template>
            </el-table-column>
            <el-table-column label="状态" width="100">
              <template #default="{ row }">
                <el-tag :type="runStatusType(row.status)" size="small">{{
                  runStatusLabel(row.status)
                }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="QC" width="80" align="center">
              <template #default="{ row }">
                <span v-if="row.qc_score != null">{{ (row.qc_score * 100).toFixed(0) }}%</span>
                <span v-else class="text-muted">-</span>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="80" align="center">
              <template #default="{ row }">
                <el-button
                  type="primary"
                  link
                  size="small"
                  @click="$router.push(`/web-frontend-eval/runs/${row.id}`)"
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
              <span>层级说明</span>
            </div>
          </template>
          <div class="level-info">
            <div class="level-item">
              <el-tag type="success">L1</el-tag>
              <span class="level-desc">静态展示 — HTML/CSS 基础页面</span>
            </div>
            <div class="level-item">
              <el-tag type="warning">L2</el-tag>
              <span class="level-desc">交互响应 — 含状态切换、表单验证</span>
            </div>
            <div class="level-item">
              <el-tag type="danger">L3</el-tag>
              <span class="level-desc">复杂 3D/物理 — Three.js/WebGL/动画</span>
            </div>
          </div>
        </el-card>

        <el-card shadow="never" class="section-card" style="margin-top: 16px">
          <template #header>
            <div class="section-header">
              <span>快速入口</span>
            </div>
          </template>
          <div class="quick-links">
            <el-button
              @click="$router.push('/web-frontend-eval/tasks')"
              style="width: 100%; margin-bottom: 8px"
              >任务管理</el-button
            >
            <el-button
              @click="$router.push('/web-frontend-eval/runs')"
              style="width: 100%; margin-bottom: 8px"
              >执行记录</el-button
            >
            <el-button
              type="info"
              plain
              @click="$router.push('/web-frontend-eval/tasks')"
              style="width: 100%"
              >+ 新建 2D 任务</el-button
            >
            <el-button
              type="warning"
              plain
              @click="$router.push('/web-frontend-eval/tasks')"
              style="width: 100%"
              >+ 新建 3D 任务</el-button
            >
          </div>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup>
import { ref, onMounted, computed } from 'vue';
import { Plus, Document } from '@element-plus/icons-vue';
import { webFrontendEvalApi } from '@/api/webFrontendEval';
import KhyPageHeader from '@/components/KhyPageHeader.vue';

const loading = ref(false);
const stats = ref(null);
const recentRuns = ref([]);

async function refresh() {
  loading.value = true;
  try {
    const [statsData, runsData] = await Promise.all([
      webFrontendEvalApi.getStats(),
      webFrontendEvalApi.listRuns({ pageSize: 10 }),
    ]);
    stats.value = statsData.data;
    recentRuns.value = runsData.data?.runs || [];
  } finally {
    loading.value = false;
  }
}

const levelBreakdown = computed(() => {
  // Quick breakdown from recent runs
  const counts = { L1: 0, L2: 0, L3: 0 };
  for (const r of recentRuns.value) {
    const lv = r.task?.level;
    if (lv && counts.hasOwnProperty(lv)) counts[lv]++;
  }
  return `${counts.L1}/${counts.L2}/${counts.L3}`;
});

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

onMounted(refresh);
</script>

<style scoped>
.wfe-page {
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
.level-info {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 8px 0;
}
.level-item {
  display: flex;
  align-items: center;
  gap: 12px;
}
.level-desc {
  font-size: 13px;
  color: #606266;
}
.quick-links {
  display: flex;
  flex-direction: column;
}
.text-muted {
  color: #c0c4cc;
}
</style>

<template>
  <div class="wfe-page">
    <KhyPageHeader title="标注执行记录">
      <template #actions>
        <el-button @click="$router.push('/web-frontend-eval/tasks')">任务列表</el-button>
      </template>
    </KhyPageHeader>

    <el-card shadow="never">
      <el-form :inline="true" :model="filters" class="filter-bar">
        <el-form-item label="状态">
          <el-select v-model="filters.status" clearable placeholder="全部" style="width: 130px">
            <el-option label="草稿" value="draft" />
            <el-option label="标注中" value="annotating" />
            <el-option label="审核中" value="reviewing" />
            <el-option label="完成" value="completed" />
            <el-option label="驳回" value="rejected" />
            <el-option label="归档" value="archived" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="loadData" :loading="loading">查询</el-button>
        </el-form-item>
      </el-form>

      <el-table :data="runs" stripe v-loading="loading">
        <el-table-column prop="id" label="ID" width="60" />
        <el-table-column label="任务" min-width="200">
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
        <el-table-column label="AI 模型" width="140">
          <template #default="{ row }">{{ row.ai_model || '-' }}</template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="runStatusType(row.status)" size="small">{{
              runStatusLabel(row.status)
            }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="QC 评分" width="80" align="center">
          <template #default="{ row }">
            <span v-if="row.qc_score != null">{{ (row.qc_score * 100).toFixed(0) }}%</span>
            <span v-else class="text-muted">-</span>
          </template>
        </el-table-column>
        <el-table-column label="API 轮次" width="80" align="center">
          <template #default="{ row }">{{ row.api_call_rounds || '-' }}</template>
        </el-table-column>
        <el-table-column label="耗时" width="80" align="center">
          <template #default="{ row }">{{ formatDuration(row.total_duration) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="100" fixed="right">
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

      <div class="pagination-bar">
        <el-pagination
          v-model:current-page="page"
          :page-size="pageSize"
          :total="total"
          layout="total, prev, pager, next"
          @current-change="loadData"
        />
      </div>
    </el-card>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue';
import { webFrontendEvalApi } from '@/api/webFrontendEval';
import KhyPageHeader from '@/components/KhyPageHeader.vue';

const loading = ref(false);
const runs = ref([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const filters = reactive({ status: '' });

async function loadData() {
  loading.value = true;
  try {
    const params = { page: page.value, pageSize: pageSize.value };
    if (filters.status) params.status = filters.status;
    const r = await webFrontendEvalApi.listRuns(params);
    runs.value = r.data?.runs || [];
    total.value = r.data?.total || 0;
  } catch {
    /* skip */
  } finally {
    loading.value = false;
  }
}

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
function formatDuration(sec) {
  if (sec == null) return '-';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m${sec % 60}s`;
  return `${Math.floor(sec / 3600)}h`;
}

onMounted(loadData);
</script>

<style scoped>
.wfe-page {
  padding: 16px;
}
.filter-bar {
  margin-bottom: 16px;
}
.pagination-bar {
  margin-top: 16px;
  display: flex;
  justify-content: flex-end;
}
.text-muted {
  color: #c0c4cc;
}
</style>

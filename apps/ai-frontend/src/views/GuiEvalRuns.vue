<template>
  <div class="gui-eval-page">
    <KhyPageHeader title="执行记录">
      <template #actions>
        <el-button @click="$router.push('/gui-eval/tasks')">任务列表</el-button>
      </template>
    </KhyPageHeader>

    <el-card shadow="never">
      <el-form :inline="true" :model="filters" class="filter-bar">
        <el-form-item label="状态">
          <el-select v-model="filters.status" clearable placeholder="全部" style="width: 130px">
            <el-option label="排队" value="queued" />
            <el-option label="准备中" value="preparing" />
            <el-option label="执行中" value="running" />
            <el-option label="评测中" value="evaluating" />
            <el-option label="完成" value="completed" />
            <el-option label="失败" value="failed" />
            <el-option label="取消" value="cancelled" />
            <el-option label="超时" value="timeout" />
          </el-select>
        </el-form-item>
        <el-form-item label="判定">
          <el-select v-model="filters.verdict" clearable placeholder="全部" style="width: 120px">
            <el-option label="待评测" value="pending" />
            <el-option label="通过" value="pass" />
            <el-option label="部分" value="partial" />
            <el-option label="失败" value="fail" />
            <el-option label="待复核" value="pending_review" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="loadData" :loading="loading">查询</el-button>
        </el-form-item>
      </el-form>

      <el-table :data="runs" stripe v-loading="loading">
        <el-table-column prop="id" label="ID" width="60" />
        <el-table-column label="任务" min-width="180">
          <template #default="{ row }">
            <el-link type="primary" @click="$router.push(`/gui-eval/tasks/${row.task_id}`)">
              {{ row.task?.name || `任务 #${row.task_id}` }}
            </el-link>
          </template>
        </el-table-column>
        <el-table-column label="模型" width="120">
          <template #default="{ row }">{{ row.agent_model || '-' }}</template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="runStatusType(row.status)" size="small">{{ row.status }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="判定" width="100">
          <template #default="{ row }">
            <el-tag v-if="row.verdict" :type="verdictType(row.verdict)" size="small">{{
              verdictLabel(row.verdict)
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
        <el-table-column label="结算" width="80" align="right">
          <template #default="{ row }">{{
            row.payout_amount ? `¥${Number(row.payout_amount).toFixed(2)}` : '-'
          }}</template>
        </el-table-column>
        <el-table-column label="耗时" width="80" align="center">
          <template #default="{ row }">{{ formatDuration(row.total_duration) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="120" fixed="right">
          <template #default="{ row }">
            <el-button
              type="primary"
              link
              size="small"
              @click="$router.push(`/gui-eval/runs/${row.id}`)"
              >详情</el-button
            >
            <el-button
              type="warning"
              link
              size="small"
              @click="$router.push(`/gui-eval/review/${row.id}`)"
              :disabled="row.verdict !== 'pending_review'"
              >复核</el-button
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
import { guiEvalApi } from '@/api/guiEval';
import KhyPageHeader from '@/components/KhyPageHeader.vue';

const loading = ref(false);
const runs = ref([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const filters = reactive({ status: '', verdict: '' });

async function loadData() {
  loading.value = true;
  try {
    const params = { page: page.value, pageSize: pageSize.value };
    if (filters.status) params.status = filters.status;
    if (filters.verdict) params.verdict = filters.verdict;
    const r = await guiEvalApi.listRuns(params);
    runs.value = r.runs || [];
    total.value = r.total || 0;
  } catch {
    /* skip */
  } finally {
    loading.value = false;
  }
}

function runStatusType(s) {
  return (
    {
      queued: 'info',
      preparing: 'info',
      running: '',
      evaluating: 'warning',
      completed: 'success',
      failed: 'danger',
      cancelled: 'info',
      timeout: 'danger',
    }[s] || 'info'
  );
}
function verdictType(v) {
  return (
    {
      pass: 'success',
      partial: 'warning',
      fail: 'danger',
      pending: 'info',
      pending_review: 'warning',
    }[v] || 'info'
  );
}
function verdictLabel(v) {
  return (
    { pass: '通过', partial: '部分', fail: '失败', pending: '待评测', pending_review: '待复核' }[
      v
    ] || v
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
.gui-eval-page {
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

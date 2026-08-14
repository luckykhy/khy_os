<template>
  <div class="gui-eval-page">
    <KhyPageHeader :title="run ? `执行详情 #${run.id}` : '加载中...'">
      <template #actions>
        <el-button @click="$router.back()">返回</el-button>
        <el-button
          v-if="run?.status === 'completed'"
          type="warning"
          @click="submitReviewDialog = true"
          >人工复核</el-button
        >
        <el-button
          v-if="run?.task_id"
          type="primary"
          @click="$router.push(`/gui-eval/tasks/${run.task_id}`)"
          >查看任务</el-button
        >
      </template>
    </KhyPageHeader>

    <div v-if="!run" v-loading="loading">
      <el-skeleton :rows="6" animated />
    </div>

    <template v-else>
      <el-row :gutter="16">
        <el-col :xs="24" :md="8">
          <el-card shadow="never" class="info-card">
            <template #header><span>执行信息</span></template>
            <div class="info-row">
              <span class="info-label">任务</span
              ><span class="info-value">{{ run.task?.name || run.task_id }}</span>
            </div>
            <div class="info-row">
              <span class="info-label">模型</span
              ><span class="info-value">{{ run.agent_model || '-' }}</span>
            </div>
            <div class="info-row">
              <span class="info-label">状态</span
              ><el-tag :type="runStatusType(run.status)" size="small">{{ run.status }}</el-tag>
            </div>
            <div class="info-row">
              <span class="info-label">判定</span
              ><el-tag v-if="run.verdict" :type="verdictType(run.verdict)" size="small">{{
                verdictLabel(run.verdict)
              }}</el-tag>
            </div>
            <div class="info-row">
              <span class="info-label">得分</span
              ><span class="info-value">{{
                run.overall_score != null ? (run.overall_score * 100).toFixed(1) + '%' : '-'
              }}</span>
            </div>
            <div class="info-row">
              <span class="info-label">自动得分</span
              ><span class="info-value">{{
                run.auto_score != null ? (run.auto_score * 100).toFixed(1) + '%' : '-'
              }}</span>
            </div>
            <div class="info-row">
              <span class="info-label">人工得分</span
              ><span class="info-value">{{
                run.manual_score != null ? (run.manual_score * 100).toFixed(1) + '%' : '-'
              }}</span>
            </div>
            <div class="info-row">
              <span class="info-label">结算</span
              ><span class="info-value">{{
                run.payout_amount ? `¥${Number(run.payout_amount).toFixed(2)}` : '-'
              }}</span>
            </div>
            <div class="info-row">
              <span class="info-label">开始时间</span
              ><span class="info-value">{{ formatTime(run.started_at) }}</span>
            </div>
            <div class="info-row">
              <span class="info-label">完成时间</span
              ><span class="info-value">{{ formatTime(run.completed_at) }}</span>
            </div>
            <div class="info-row">
              <span class="info-label">总耗时</span
              ><span class="info-value">{{ formatDuration(run.total_duration) }}</span>
            </div>
          </el-card>

          <el-card
            shadow="never"
            class="section-card"
            style="margin-top: 16px"
            v-if="run.error_message"
          >
            <template #header><span style="color: #f56c6c">错误</span></template>
            <pre class="error-block"
              >{{ run.error_message }}{{ run.error_stack ? '\n\n' + run.error_stack : '' }}</pre>
          </el-card>
        </el-col>

        <el-col :xs="24" :md="16">
          <el-card shadow="never" class="section-card">
            <template #header>
              <span>Checkpoint 结果 ({{ (run.checkpoint_results || []).length }} 条)</span>
            </template>
            <el-table
              :data="run.checkpoint_results || []"
              stripe
              size="small"
              empty-text="暂无评测结果"
            >
              <el-table-column label="#" width="40" type="index" align="center" />
              <el-table-column label="ID" width="80">
                <template #default="{ row }">{{ row.checkpointId }}</template>
              </el-table-column>
              <el-table-column label="结果" width="80" align="center">
                <template #default="{ row }">
                  <el-tag :type="row.passed ? 'success' : 'danger'" size="small">{{
                    row.passed ? '通过' : '失败'
                  }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="得分" width="70" align="center">
                <template #default="{ row }">{{ (row.autoScore * 100).toFixed(0) }}%</template>
              </el-table-column>
              <el-table-column prop="evidence" label="证据" min-width="200" show-overflow-tooltip />
              <el-table-column prop="duration" label="耗时(ms)" width="80" align="center" />
            </el-table>
          </el-card>

          <el-card
            shadow="never"
            class="section-card"
            style="margin-top: 16px"
            v-if="(run.discrepancies || []).length"
          >
            <template #header><span style="color: #e6a23c">与 Gold 标准的差异</span></template>
            <el-table :data="run.discrepancies" stripe size="small">
              <el-table-column prop="checkpointId" label="Checkpoint" width="100" />
              <el-table-column prop="severity" label="严重程度" width="100">
                <template #default="{ row }">
                  <el-tag :type="severityType(row.severity)" size="small">{{
                    row.severity
                  }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column prop="expected" label="期望" show-overflow-tooltip />
              <el-table-column prop="actual" label="实际" show-overflow-tooltip />
            </el-table>
          </el-card>

          <el-card
            shadow="never"
            class="section-card"
            style="margin-top: 16px"
            v-if="(run.trajectory || []).length"
          >
            <template #header>
              <span>轨迹概览 ({{ (run.trajectory || []).length }} 步)</span>
            </template>
            <el-timeline>
              <el-timeline-item
                v-for="(step, i) in visibleTrajectory"
                :key="i"
                :type="step.success ? 'success' : 'danger'"
                :timestamp="formatTime(step.timestamp)"
              >
                <div class="step-item">
                  <code>{{ step.action }}</code>
                  <span class="step-params">{{ truncateParams(step.params) }}</span>
                </div>
              </el-timeline-item>
            </el-timeline>
            <el-button
              v-if="(run.trajectory || []).length > 20"
              type="primary"
              link
              @click="showAllSteps = !showAllSteps"
            >
              {{ showAllSteps ? '收起' : `显示全部 ${run.trajectory.length} 步` }}
            </el-button>
          </el-card>
        </el-col>
      </el-row>

      <!-- Screenshots Gallery -->
      <el-card
        shadow="never"
        class="section-card"
        style="margin-top: 16px"
        v-if="(run.recordings?.screenshots || []).length"
      >
        <template #header
          ><span>截屏记录 ({{ (run.recordings?.screenshots || []).length }} 张)</span></template
        >
        <div class="screenshot-gallery">
          <div v-for="(shot, i) in run.recordings.screenshots" :key="i" class="screenshot-item">
            <img :src="shotPath(shot)" :alt="`Step ${shot.step}`" />
            <span class="shot-label">Step {{ shot.step }}</span>
          </div>
        </div>
      </el-card>

      <!-- Review Dialog -->
      <el-dialog v-model="submitReviewDialog" title="人工复核" width="500px">
        <el-form :model="reviewForm" label-width="100px">
          <el-form-item label="得分（0-1）">
            <el-input-number v-model="reviewForm.manualScore" :min="0" :max="1" :step="0.05" />
          </el-form-item>
        </el-form>
        <template #footer>
          <el-button @click="submitReviewDialog = false">取消</el-button>
          <el-button type="primary" @click="submitReview" :loading="reviewLoading">提交</el-button>
        </template>
      </el-dialog>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage } from 'element-plus';
import { guiEvalApi } from '@/api/guiEval';
import KhyPageHeader from '@/components/KhyPageHeader.vue';

const route = useRoute();
const loading = ref(false);
const run = ref(null);
const showAllSteps = ref(false);
const submitReviewDialog = ref(false);
const reviewLoading = ref(false);
const reviewForm = reactive({ manualScore: 0 });

async function loadRun() {
  loading.value = true;
  try {
    const r = await guiEvalApi.getRun(route.params.id);
    run.value = r.data;
  } catch (e) {
    ElMessage.error(e.message || '加载执行记录失败');
  } finally {
    loading.value = false;
  }
}

const visibleTrajectory = computed(() => {
  if (!run.value) return [];
  const all = run.value.trajectory || [];
  return showAllSteps.value ? all : all.slice(0, 20);
});

async function submitReview() {
  reviewLoading.value = true;
  try {
    await guiEvalApi.submitReview(run.value.id, { manualScore: reviewForm.manualScore });
    ElMessage.success('复核已提交');
    submitReviewDialog.value = false;
    await loadRun();
  } catch (e) {
    ElMessage.error(e.message || '提交失败');
  } finally {
    reviewLoading.value = false;
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
function severityType(s) {
  return { minor: 'info', major: 'warning', critical: 'danger' }[s] || 'info';
}
function formatTime(t) {
  if (!t) return '-';
  const d = new Date(t);
  return d.toLocaleString('zh-CN');
}
function formatDuration(sec) {
  if (sec == null) return '-';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h`;
}
function truncateParams(p) {
  try {
    return JSON.stringify(p).slice(0, 60);
  } catch {
    return '';
  }
}
function shotPath(shot) {
  // Screenshots served by backend static route — prefix with API base
  return (import.meta.env.VITE_AI_API_BASE_URL || '') + (shot.path || shot);
}

onMounted(() => {
  if (route.params.id) loadRun();
});
</script>

<style scoped>
.gui-eval-page {
  padding: 16px;
}
.section-card {
  border-radius: 8px;
  margin-bottom: 16px;
}
.info-card {
  border-radius: 8px;
}
.info-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 0;
  border-bottom: 1px solid #f0f0f0;
}
.info-row:last-child {
  border-bottom: none;
}
.info-label {
  color: #909399;
  font-size: 13px;
}
.info-value {
  font-weight: 500;
}
.error-block {
  background: #fef0f0;
  padding: 12px;
  border-radius: 4px;
  font-size: 12px;
  color: #f56c6c;
  white-space: pre-wrap;
}
.step-item {
  display: flex;
  gap: 8px;
  align-items: baseline;
}
.step-item code {
  background: #f5f7fa;
  padding: 2px 6px;
  border-radius: 3px;
  font-size: 12px;
}
.step-params {
  color: #909399;
  font-size: 12px;
}
.screenshot-gallery {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 12px;
}
.screenshot-item {
  text-align: center;
}
.screenshot-item img {
  max-width: 100%;
  border-radius: 4px;
  border: 1px solid #e4e7ed;
}
.shot-label {
  font-size: 12px;
  color: #909399;
  display: block;
  margin-top: 4px;
}
</style>

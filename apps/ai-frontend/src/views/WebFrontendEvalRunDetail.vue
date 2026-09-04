<template>
  <div class="wfe-page">
    <KhyPageHeader :title="run ? `标注记录 #${run.id}` : '加载中...'">
      <template #actions>
        <el-button @click="$router.back()">返回</el-button>
        <el-button
          v-if="run?.task_id"
          type="primary"
          @click="$router.push(`/web-frontend-eval/tasks/${run.task_id}`)"
          >查看任务</el-button
        >
        <el-button v-if="run?.status === 'annotating'" type="warning" @click="assembleDialog = true"
          >组装轨迹包</el-button
        >
        <el-button v-if="run?.status === 'reviewing'" type="success" @click="completeRun"
          >通过</el-button
        >
        <el-button v-if="run?.status === 'reviewing'" type="danger" @click="rejectDialog = true"
          >驳回</el-button
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
            <template #header><span>基本信息</span></template>
            <div class="info-row">
              <span class="info-label">任务</span
              ><span class="info-value">{{ run.task?.name || run.task_id }}</span>
            </div>
            <div class="info-row">
              <span class="info-label">层级</span
              ><span class="info-value">{{ run.task?.level || '-' }}</span>
            </div>
            <div class="info-row">
              <span class="info-label">分类</span
              ><span class="info-value">{{ run.task?.category?.toUpperCase() || '-' }}</span>
            </div>
            <div class="info-row">
              <span class="info-label">AI 模型</span
              ><span class="info-value">{{ run.ai_model || '-' }}</span>
            </div>
            <div class="info-row">
              <span class="info-label">状态</span
              ><el-tag :type="runStatusType(run.status)" size="small">{{
                runStatusLabel(run.status)
              }}</el-tag>
            </div>
            <div class="info-row">
              <span class="info-label">QC 评分</span
              ><span class="info-value">{{
                run.qc_score != null ? (run.qc_score * 100).toFixed(1) + '%' : '-'
              }}</span>
            </div>
            <div class="info-row">
              <span class="info-label">API 轮次</span
              ><span class="info-value">{{ run.api_call_rounds || '-' }}</span>
            </div>
            <div class="info-row">
              <span class="info-label">轨迹包</span
              ><span class="info-value">{{ run.package_path ? '已关联' : '-' }}</span>
            </div>
            <div class="info-row">
              <span class="info-label">已打包</span>
              <el-tag v-if="run.package_zipped" type="success" size="small">已 zip</el-tag>
              <span v-else class="text-muted">未打包</span>
            </div>
            <div class="info-row">
              <span class="info-label">开始时间</span
              ><span class="info-value">{{ formatTime(run.createdAt) }}</span>
            </div>
            <div class="info-row">
              <span class="info-label">交付时间</span
              ><span class="info-value">{{ formatTime(run.delivered_at) }}</span>
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
            v-if="run.rejection_reason"
          >
            <template #header><span style="color: var(--khy-danger)">驳回原因</span></template>
            <div class="rejection-text">{{ run.rejection_reason }}</div>
          </el-card>
        </el-col>

        <el-col :xs="24" :md="16">
          <!-- QC Results -->
          <el-card shadow="never" class="section-card" v-if="run.qc_result">
            <template #header>
              <span>QC 结果</span>
              <el-tag
                :type="qcVerdictType(run.qc_result.verdict)"
                size="small"
                style="margin-left: 8px"
              >
                {{ qcVerdictLabel(run.qc_result.verdict) }}
              </el-tag>
            </template>
            <div v-if="(run.qc_result.defects || []).length" class="defects-list">
              <div v-for="(defect, i) in run.qc_result.defects" :key="i" class="defect-item">
                <el-tag :type="defectSeverityType(defect.severity)" size="small">{{
                  defect.severity
                }}</el-tag>
                <span class="defect-key">[{{ defect.key }}]</span>
                <span>{{ defect.description }}</span>
              </div>
            </div>
            <el-empty v-else description="无缺陷" :image-size="60" />
          </el-card>

          <!-- Self-check -->
          <el-card
            shadow="never"
            class="section-card"
            style="margin-top: 16px"
            v-if="run.self_check"
          >
            <template #header><span>自检清单</span></template>
            <div v-if="run.self_check.items?.length">
              <div v-for="(item, i) in run.self_check.items" :key="i" class="self-check-item">
                <el-icon :color="item.passed ? 'var(--khy-success)' : 'var(--khy-danger)'">
                  <Check v-if="item.passed" /><Close v-else />
                </el-icon>
                <span class="sc-text">{{ item.key }}</span>
                <span v-if="item.note" class="sc-note">{{ item.note }}</span>
              </div>
            </div>
            <pre v-else class="json-block">{{ JSON.stringify(run.self_check, null, 2) }}</pre>
          </el-card>

          <!-- Notes -->
          <el-card shadow="never" class="section-card" style="margin-top: 16px" v-if="run.notes">
            <template #header><span>标注备注</span></template>
            <div class="notes-text">{{ run.notes }}</div>
          </el-card>
        </el-col>
      </el-row>

      <!-- Assemble Dialog -->
      <el-dialog
        v-model="assembleDialog"
        title="组装轨迹包"
        width="600px"
        :close-on-click-modal="false"
      >
        <el-form :model="assembleForm" label-width="120px">
          <el-form-item label="轨迹包目录">
            <el-input
              v-model="assembleForm.packagePath"
              placeholder="如：D:/data/web-eval/task-001/"
            />
          </el-form-item>
        </el-form>
        <template #footer>
          <el-button @click="assembleDialog = false">取消</el-button>
          <el-button type="primary" @click="doAssemble" :loading="assembling">组装 + QC</el-button>
        </template>
      </el-dialog>

      <!-- Reject Dialog -->
      <el-dialog v-model="rejectDialog" title="驳回标注" width="500px">
        <el-form :model="rejectForm" label-width="100px">
          <el-form-item label="驳回原因" required>
            <el-input
              v-model="rejectForm.reason"
              type="textarea"
              :rows="4"
              placeholder="请说明驳回原因..."
            />
          </el-form-item>
        </el-form>
        <template #footer>
          <el-button @click="rejectDialog = false">取消</el-button>
          <el-button type="danger" @click="doReject" :loading="rejecting">确认驳回</el-button>
        </template>
      </el-dialog>
    </template>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage } from 'element-plus';
import { Check, Close } from '@element-plus/icons-vue';
import { webFrontendEvalApi } from '@/api/webFrontendEval';
import KhyPageHeader from '@/components/KhyPageHeader.vue';

const route = useRoute();
const loading = ref(false);
const assembling = ref(false);
const rejecting = ref(false);
const run = ref(null);
const assembleDialog = ref(false);
const rejectDialog = ref(false);
const assembleForm = reactive({ packagePath: '' });
const rejectForm = reactive({ reason: '' });

async function loadRun() {
  loading.value = true;
  try {
    const r = await webFrontendEvalApi.getRun(route.params.id);
    run.value = r.data;
  } catch (e) {
    ElMessage.error(e.message || '加载执行记录失败');
  } finally {
    loading.value = false;
  }
}

async function doAssemble() {
  if (!assembleForm.packagePath.trim()) return ElMessage.warning('请输入轨迹包目录路径');
  // First update the run with the package path
  await webFrontendEvalApi.updateRun(run.value.id, { package_path: assembleForm.packagePath });
  assembling.value = true;
  try {
    await webFrontendEvalApi.assemblePackage(run.value.id);
    ElMessage.success('轨迹包组装完成，QC 已执行');
    assembleDialog.value = false;
    await loadRun();
  } catch (e) {
    ElMessage.error(e.message || '组装失败');
  } finally {
    assembling.value = false;
  }
}

async function completeRun() {
  try {
    await webFrontendEvalApi.completeRun(run.value.id);
    ElMessage.success('标注已完成');
    await loadRun();
  } catch (e) {
    ElMessage.error(e.message || '操作失败');
  }
}

async function doReject() {
  if (!rejectForm.reason.trim()) return ElMessage.warning('请输入驳回原因');
  rejecting.value = true;
  try {
    await webFrontendEvalApi.rejectRun(run.value.id, rejectForm.reason);
    ElMessage.success('已驳回');
    rejectDialog.value = false;
    await loadRun();
  } catch (e) {
    ElMessage.error(e.message || '驳回失败');
  } finally {
    rejecting.value = false;
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
function qcVerdictType(v) {
  return { pass: 'success', needs_rework: 'warning', fail: 'danger' }[v] || 'info';
}
function qcVerdictLabel(v) {
  return { pass: '通过', needs_rework: '需返工', fail: '不合格' }[v] || v;
}
function defectSeverityType(s) {
  return { critical: 'danger', major: 'warning', minor: 'info' }[s] || 'info';
}
function formatTime(t) {
  if (!t) return '-';
  const d = new Date(t);
  return d.toLocaleString('zh-CN');
}
function formatDuration(sec) {
  if (sec == null) return '-';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m${sec % 60}s`;
  return `${Math.floor(sec / 3600)}h`;
}

onMounted(() => {
  if (route.params.id) loadRun();
});
</script>

<style scoped>
.wfe-page {
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
.text-muted {
  color: #c0c4cc;
}
.defects-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.defect-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  background: #f5f7fa;
  border-radius: 4px;
}
.defect-key {
  font-family: monospace;
  color: #909399;
}
.self-check-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
}
.sc-text {
  font-size: 13px;
}
.sc-note {
  color: #909399;
  font-size: 12px;
  margin-left: 4px;
}
.rejection-text {
  color: var(--khy-danger);
  padding: 8px;
}
.notes-text {
  font-size: 13px;
  line-height: 1.6;
}
.json-block {
  background: #f5f7fa;
  padding: 12px;
  border-radius: 4px;
  font-size: 12px;
  overflow-x: auto;
  white-space: pre-wrap;
}
</style>

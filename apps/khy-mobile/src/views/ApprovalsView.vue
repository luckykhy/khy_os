<script setup>
import { onMounted, ref } from 'vue';
import { apiJson } from '@/api/client';
import { operationStatus, statusText } from '@/api/status';
import ApprovalCard from '@/components/ApprovalCard.vue';

const approvals = ref([]);
const busyTicket = ref('');
const status = ref(operationStatus('读取', '待审批队列', '等待开始'));
const error = ref('');

async function load() {
  error.value = ''; status.value = operationStatus('读取', '待审批队列', '进行中');
  try {
    const data = await apiJson('/api/large-tasks/retry-policy/approvals/pending');
    approvals.value = (data.approvals || []).sort((a, b) => Date.parse(a.expires_at) - Date.parse(b.expires_at));
    status.value = operationStatus('读取', '待审批队列', `已更新 ${approvals.value.length} 项`, 'success');
  } catch (cause) { error.value = cause.message; status.value = operationStatus('读取', '待审批队列', '失败', 'error'); }
}
async function decide(ticket, decision) {
  busyTicket.value = ticket.ticket_id; error.value = '';
  status.value = operationStatus(decision === 'approve' ? '批准' : '拒绝', ticket.ticket_id, '提交中');
  try {
    await apiJson('/api/large-tasks/retry-policy/approvals/decision', { method: 'POST', body: JSON.stringify({ ticket_id: ticket.ticket_id, decision }) });
    status.value = operationStatus(decision === 'approve' ? '批准' : '拒绝', ticket.ticket_id, '已完成', 'success');
    await load();
  } catch (cause) { error.value = cause.message; status.value = operationStatus('提交', ticket.ticket_id, '失败', 'error'); }
  finally { busyTicket.value = ''; }
}
onMounted(load);
</script>

<template><div class="stack">
  <div class="row"><div><h1 class="page-title">待审批</h1><p class="page-subtitle">提交前核对操作、目标与影响</p></div><button class="button" title="刷新" @click="load">↻</button></div>
  <p class="status-line" :class="status.tone">{{ statusText(status) }}</p><p v-if="error" class="alert">{{ error }}</p>
  <ApprovalCard v-for="ticket in approvals" :key="ticket.ticket_id" :ticket="ticket" :busy="busyTicket === ticket.ticket_id" @decision="decide(ticket, $event)" />
  <p v-if="!approvals.length && !error" class="panel muted">没有等待处理的审批单</p>
</div></template>

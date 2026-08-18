<script setup>
defineProps({ ticket: { type: Object, required: true }, busy: Boolean });
defineEmits(['decision']);
const targetText = (target) => typeof target === 'string' ? target : target?.display || '未说明目标';
</script>

<template>
  <article class="approval-card">
    <div class="row"><span class="risk" :class="`risk-${ticket.risk_level || 'medium'}`">{{ ticket.risk_level || 'medium' }}</span><strong>{{ ticket.requested_action || '待审批操作' }}</strong></div>
    <p class="target">目标：{{ targetText(ticket.target) }}</p>
    <p>{{ ticket.reason || '未提供原因' }}</p>
    <p class="muted">影响：{{ ticket.impact_summary || '未提供影响说明' }}</p>
    <pre v-if="ticket.command_preview?.length">{{ ticket.command_preview.join('\n') }}</pre>
    <div class="row actions"><button class="button danger" :disabled="busy" @click="$emit('decision', 'reject')">拒绝</button><button class="button primary" :disabled="busy" @click="$emit('decision', 'approve')">批准</button></div>
  </article>
</template>

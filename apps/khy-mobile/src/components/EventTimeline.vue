<script setup>
defineProps({ events: { type: Array, default: () => [] } });
</script>

<template>
  <ol class="event-timeline"><li v-for="event in events" :key="event.id"><span class="timeline-dot" :class="`tone-${event.severity}`"></span><div><strong>{{ event.title }}</strong><p>{{ event.message || '状态已更新' }}</p><small>{{ event.at }}</small></div></li></ol>
</template>

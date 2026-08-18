import { computed, ref } from 'vue';
import { defineStore } from 'pinia';

const MAX_EVENTS = 100;

function eventKey(event) {
  return String(event?.event_id || event?.approval_event_id || event?.id || `${event?.trace_id || ''}:${event?.sequence || ''}:${event?.ts || event?.at || ''}`);
}

function summarize(event) {
  const payload = event?.payload && typeof event.payload === 'object' ? event.payload : {};
  return {
    id: eventKey(event),
    traceId: String(event?.trace_id || ''),
    sequence: Number(event?.sequence || 0),
    at: String(event?.ts || event?.at || new Date().toISOString()),
    kind: String(event?.kind || event?.event_type || 'status'),
    severity: String(event?.severity || 'info'),
    title: String(event?.title || event?.message || event?.event_type || '状态更新').slice(0, 120),
    message: String(event?.message || payload?.progress || '').slice(0, 280),
    read: false,
  };
}

export const useNotificationsStore = defineStore('mobile-notifications', () => {
  const events = ref([]);
  const unread = computed(() => events.value.filter((event) => !event.read).length);

  function add(event) {
    const summary = summarize(event);
    if (!summary.id || events.value.some((item) => item.id === summary.id)) return;
    events.value = [summary, ...events.value].slice(0, MAX_EVENTS);
  }

  function markAllRead() {
    events.value = events.value.map((event) => ({ ...event, read: true }));
  }

  function clear() {
    events.value = [];
  }

  return { events, unread, add, markAllRead, clear };
});

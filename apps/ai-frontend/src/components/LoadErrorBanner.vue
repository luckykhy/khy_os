<template>
  <el-alert
    v-if="text"
    class="load-error-banner"
    :closable="false"
    :title="text"
    type="error"
  />
</template>

<script setup>
import { computed } from 'vue';

// Renders a load failure the view can no longer hide. Paired with
// useLoadError() from @/api/loadError.
//
// Accepts either a plain string or a Vue ref, so it can sit next to composable
// state without each view hand-unwrapping it in the template.
const props = defineProps({
  message: {
    type: [String, Object],
    default: '',
  },
});

const text = computed(() => String(props.message?.value ?? props.message ?? ''));
</script>

<style scoped>
.load-error-banner {
  margin-bottom: 14px;
}
</style>

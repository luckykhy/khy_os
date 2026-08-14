<template>
  <div class="state-panel">
    <div class="panel-header">
      <h4>{{ title }}</h4>
      <el-button v-if="refreshable" size="small" @click="handleRefresh">
        <el-icon><Refresh /></el-icon>
      </el-button>
    </div>
    <div class="panel-body">
      <slot></slot>
    </div>
  </div>
</template>

<script setup>
defineProps({
  title: {
    type: String,
    required: true
  },
  refreshable: {
    type: Boolean,
    default: false
  }
});

const emit = defineEmits(['refresh']);

function handleRefresh() {
  emit('refresh');
}
</script>

<style scoped>
.state-panel {
  border: 1px solid #ebeef5;
  border-radius: 8px;
  overflow: hidden;
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  background: #f5f7fa;
  border-bottom: 1px solid #ebeef5;
}

.panel-header h4 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: #333;
}

.panel-body {
  padding: 16px;
}
</style>

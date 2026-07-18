<template>
  <div class="test-bot">
    <div class="bot-icon" @click="showMessage">
      🤖
    </div>
  </div>
</template>

<script setup>
import { ElMessage } from 'element-plus'

const showMessage = () => {
  ElMessage.success('TradingAgents机器人正常工作！')
}
</script>

<style scoped>
.test-bot {
  position: fixed;
  top: 20px;
  left: 20px;
  z-index: 9999;
}

.bot-icon {
  width: 60px;
  height: 60px;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: 24px;
  box-shadow: 0 4px 20px rgba(102, 126, 234, 0.3);
  transition: all 0.3s ease;
}

.bot-icon:hover {
  transform: scale(1.1);
}
</style>
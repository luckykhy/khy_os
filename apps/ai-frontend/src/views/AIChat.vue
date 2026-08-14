<template>
  <div class="ai-chat">
    <el-card class="chat-card">
      <div class="chat-container">
        <div class="messages-area" ref="messagesRef">
          <div
            v-for="(msg, index) in messages"
            :key="index"
            :class="['message', msg.role]"
          >
            <div class="message-avatar">
              <el-icon v-if="msg.role === 'user'"><UserFilled /></el-icon>
              <el-icon v-else><Cpu /></el-icon>
            </div>
            <div class="message-content">
              <div class="message-text">{{ msg.content }}</div>
              <div class="message-time">{{ msg.timestamp }}</div>
            </div>
          </div>
          <div v-if="loading" class="message assistant">
            <div class="message-avatar">
              <el-icon><Cpu /></el-icon>
            </div>
            <div class="message-content">
              <div class="typing-indicator">
                <span></span>
                <span></span>
                <span></span>
              </div>
            </div>
          </div>
        </div>

        <div class="input-area">
          <el-input
            v-model="inputText"
            type="textarea"
            :rows="3"
            placeholder="输入消息..."
            @keydown.ctrl.enter="sendMessage"
          />
          <div class="input-actions">
            <el-button type="primary" :loading="loading" @click="sendMessage">
              发送 (Ctrl+Enter)
            </el-button>
            <el-button @click="clearMessages">清空对话</el-button>
          </div>
        </div>
      </div>
    </el-card>
  </div>
</template>

<script setup>
import { ref, nextTick } from 'vue';
import { authedFetch } from '@/utils/authedFetch';
import { ElMessage } from 'element-plus';

const messages = ref([]);
const inputText = ref('');
const loading = ref(false);
const messagesRef = ref(null);

function getCurrentTime() {
  const now = new Date();
  return now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

async function sendMessage() {
  if (!inputText.value.trim() || loading.value) return;

  const userMessage = {
    role: 'user',
    content: inputText.value,
    timestamp: getCurrentTime()
  };

  messages.value.push(userMessage);
  const prompt = inputText.value;
  inputText.value = '';

  await nextTick();
  scrollToBottom();

  loading.value = true;
  try {
    const response = await authedFetch('/api/ai/chat', {
      method: 'POST',
      body: JSON.stringify({ prompt, messages: messages.value })
    });

    const assistantMessage = {
      role: 'assistant',
      content: response.reply || '抱歉，我无法回答这个问题。',
      timestamp: getCurrentTime()
    };

    messages.value.push(assistantMessage);
    await nextTick();
    scrollToBottom();
  } catch (error) {
    ElMessage.error('发送失败: ' + error.message);
  } finally {
    loading.value = false;
  }
}

function clearMessages() {
  messages.value = [];
  ElMessage.success('对话已清空');
}

function scrollToBottom() {
  if (messagesRef.value) {
    messagesRef.value.scrollTop = messagesRef.value.scrollHeight;
  }
}
</script>

<style scoped>
.ai-chat {
  width: 100%;
  height: calc(100vh - 120px);
}

.chat-card {
  height: 100%;
}

.chat-container {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 180px);
}

.messages-area {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
  background: #f5f7fa;
  border-radius: 8px;
  margin-bottom: 20px;
}

.message {
  display: flex;
  gap: 12px;
  margin-bottom: 20px;
}

.message.user {
  flex-direction: row-reverse;
}

.message-avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: #409eff;
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.message.user .message-avatar {
  background: #67c23a;
}

.message-content {
  max-width: 70%;
}

.message.user .message-content {
  text-align: right;
}

.message-text {
  padding: 12px 16px;
  background: #fff;
  border-radius: 8px;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.05);
  line-height: 1.6;
  white-space: pre-wrap;
  word-wrap: break-word;
}

.message.user .message-text {
  background: #409eff;
  color: #fff;
}

.message-time {
  font-size: 12px;
  color: #909399;
  margin-top: 4px;
}

.typing-indicator {
  display: flex;
  gap: 4px;
  padding: 12px 16px;
}

.typing-indicator span {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #909399;
  animation: typing 1.4s infinite;
}

.typing-indicator span:nth-child(2) {
  animation-delay: 0.2s;
}

.typing-indicator span:nth-child(3) {
  animation-delay: 0.4s;
}

@keyframes typing {
  0%,
  60%,
  100% {
    transform: translateY(0);
  }
  30% {
    transform: translateY(-10px);
  }
}

.input-area {
  flex-shrink: 0;
}

.input-actions {
  display: flex;
  gap: 10px;
  margin-top: 10px;
  justify-content: flex-end;
}
</style>

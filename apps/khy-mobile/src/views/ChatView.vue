<script setup>
import { nextTick, ref } from 'vue';
import { consumeSse } from '@/api/sse';
import { operationStatus, statusText } from '@/api/status';

const messages = ref([]);
const question = ref('');
const busy = ref(false);
const status = ref(operationStatus('等待', 'AI 对话', '可发送'));
const error = ref('');
let controller = null;

async function send() {
  const text = question.value.trim();
  if (!text || busy.value) return;
  const history = messages.value.map(({ role, content }) => ({ role, content })).slice(-10);
  messages.value.push({ id: crypto.randomUUID(), role: 'user', content: text });
  const assistant = { id: crypto.randomUUID(), role: 'assistant', content: '', thinking: '', controls: [] };
  messages.value.push(assistant);
  question.value = '';
  error.value = '';
  busy.value = true;
  controller = new AbortController();
  status.value = operationStatus('生成', 'AI 回复', '连接中');
  try {
    await consumeSse('/api/ai/chat/stream', {
      method: 'POST',
      body: JSON.stringify({ question: text, conversationHistory: history }),
      signal: controller.signal,
      onEvent({ data }) {
        const event = data && typeof data === 'object' ? data : {};
        if (event.type === 'chunk') assistant.content += event.content || '';
        else if (event.type === 'done') assistant.content = event.content || assistant.content;
        else if (event.type === 'thinking_content') assistant.thinking += event.text || '';
        else if (event.type === 'control_request') assistant.controls.push(event);
        else if (event.type === 'error') throw new Error(event.message || 'AI 响应失败');
        status.value = operationStatus('接收', 'AI 回复', event.type || '数据到达', event.type === 'error' ? 'error' : 'success');
        nextTick(() => document.querySelector('.chat-end')?.scrollIntoView({ behavior: 'smooth' }));
      },
    });
    status.value = operationStatus('生成', 'AI 回复', '已完成', 'success');
  } catch (cause) {
    if (cause.name !== 'AbortError') {
      error.value = cause.message || 'AI 对话失败';
      status.value = operationStatus('生成', 'AI 回复', '失败', 'error');
    }
  } finally {
    busy.value = false;
    controller = null;
  }
}

function stop() {
  controller?.abort();
  status.value = operationStatus('停止', 'AI 回复', '已完成');
}
</script>

<template>
  <div class="chat-page">
    <div class="row"><div><h1 class="page-title">AI 对话</h1><p class="page-subtitle">与 Khy-OS 节点上的 AI 服务通信</p></div><button v-if="messages.length" class="button" @click="messages = []">清空</button></div>
    <section class="messages">
      <div v-if="!messages.length" class="empty-chat"><strong>开始一个新问题</strong><p>消息通过当前配对节点发送。</p></div>
      <article v-for="message in messages" :key="message.id" class="message" :class="message.role">
        <small>{{ message.role === 'user' ? '你' : 'Khy AI' }}</small>
        <p>{{ message.content || (busy ? '正在生成…' : '暂无内容') }}</p>
        <details v-if="message.thinking"><summary>思考过程</summary><p>{{ message.thinking }}</p></details>
        <div v-for="control in message.controls" :key="control.requestId" class="control-note">检测到控制请求 {{ control.requestId || '待处理' }}，请前往审批页核对。</div>
      </article>
      <div class="chat-end"></div>
    </section>
    <div class="composer stack">
      <p class="status-line" :class="status.tone">{{ statusText(status) }}</p>
      <p v-if="error" class="alert">{{ error }}</p>
      <textarea v-model="question" placeholder="输入消息" @keydown.ctrl.enter.prevent="send"></textarea>
      <div class="row"><button v-if="busy" class="button danger" @click="stop">停止</button><span v-else class="muted">Ctrl + Enter 发送</span><button class="button primary" :disabled="busy || !question.trim()" @click="send">发送</button></div>
    </div>
  </div>
</template>

<style scoped>
.chat-page { display: grid; gap: 14px; }.messages { display: grid; gap: 12px; min-height: 42vh; }.empty-chat { display: grid; place-content: center; min-height: 34vh; text-align: center; color: #8ca0b5; }.empty-chat strong { color: #e9eef5; }.message { width: min(88%, 620px); padding: 12px 14px; border: 1px solid #243241; border-radius: 8px; background: #111a24; }.message.user { justify-self: end; background: #16312d; border-color: #275149; }.message small { color: #68d5c0; }.message p { margin: 6px 0 0; white-space: pre-wrap; line-height: 1.6; overflow-wrap: anywhere; }.message details { margin-top: 8px; color: #8ca0b5; font-size: 12px; }.control-note { margin-top: 9px; padding: 8px; color: #f0cf83; background: #302a18; border-radius: 5px; font-size: 12px; }.composer { position: sticky; bottom: 72px; padding-top: 8px; background: #0b1118; }.composer textarea { min-height: 72px; }
</style>

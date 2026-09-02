<template>
  <div class="chat-input-row">
    <el-button
      class="chat-attach-btn"
      aria-label="添加附件"
      title="添加图片 / 视频 / 文档 / 项目"
      :disabled="loading"
      @click="$emit('attach')"
      circle
    >
      <el-icon><Paperclip /></el-icon>
    </el-button>
    <el-button
      class="chat-location-btn"
      :class="{ 'is-active': locationEnabled, 'is-denied': locationPermission === 'denied' }"
      aria-label="定位开关"
      :title="locationBtnTitle"
      :disabled="loading"
      @click="$emit('toggle-location')"
      circle
    >
      <span aria-hidden="true">📍</span>
    </el-button>
    <el-button
      class="chat-voice-input-btn"
      aria-label="语音输入"
      title="语音输入（Win+H）"
      :disabled="loading"
      @click="onVoiceInput"
      circle
    >
      <el-icon><Microphone /></el-icon>
    </el-button>
    <el-input
      ref="chatInputRef"
      v-model="input"
      type="textarea"
      :autosize="{ minRows: 1, maxRows: 5 }"
      resize="none"
      :placeholder="dynamicPlaceholder"
      aria-label="对话输入框"
      :disabled="loading"
      @focus="onInputFocus"
      @blur="onInputBlur"
      @keydown.enter="handleInputEnter"
      @keydown.up="handleInputArrowHistoryGuard"
      @keydown.down="handleInputArrowHistoryGuard"
    />
    <div class="chat-action-buttons">
      <el-button
        class="chat-send-btn"
        type="primary"
        aria-label="发送消息"
        @click="onSendClick"
        :loading="loading"
        >发送</el-button
      >
      <el-button
        v-if="loading"
        class="chat-stop-btn"
        type="danger"
        plain
        aria-label="停止生成"
        @click="$emit('stop')"
      >
        停止生成
      </el-button>
    </div>
  </div>
</template>

<script setup>
// ChatInputBar —— 从 AIChat.vue 抽离的输入栏子组件。
// 关键目标：输入文本的 `input` ref 完全内聚在本组件内部，用户打字时只重渲染本组件，
// 不再触发父组件 AIChat.vue 的消息列表 patch（消除输入卡顿）。
// 父子通过 defineEmits/ defineProps 通信，父组件通过 ref 调用 setText/clear/focus。
import { ref, computed, nextTick, onMounted, onBeforeUnmount } from 'vue';
import { Paperclip, Microphone } from '@element-plus/icons-vue';

const props = defineProps({
  // 发送中/加载态：禁用输入与各按钮、发送按钮转 loading、显示停止按钮。
  loading: { type: Boolean, default: false },
  // 定位开关状态（来自父组件 useGeolocation），仅用于按钮视觉与标题。
  locationEnabled: { type: Boolean, default: false },
  locationPermission: { type: String, default: '' },
  locationBtnTitle: { type: String, default: '' },
});

const emit = defineEmits([
  'send',
  'stop',
  'attach',
  'toggle-location',
  'voice-input',
  'focus',
  'blur',
]);

// ── 输入文本（组件内部状态）────────────────────────────────────────────────
// 这是消除输入卡顿的核心：打字触发的响应式更新被限定在本子组件，父组件的
// 消息列表（含大量 v-for / computed）不再随每次按键进入 patch cycle。
const input = ref('');
const chatInputRef = ref(null);

// ── 输入框智能引导:占位符轮播 ───────────────────────────────────────────────
// 仅在输入框为空且未聚焦时轮换;一聚焦或开始输入就固定,避免文字在光标下跳动。
const placeholderHints = [
  '输入任何问题，写代码、查资料或聊天都可以…（可添加图片/视频/文档/项目附件）',
  '试试：帮我把这段报错翻译成人话，并给出修复思路',
  '试试：读取这张截图里的表格，整理成 Markdown',
  '试试：把这个需求拆成可执行的任务清单',
  '试试：审查这段代码有没有安全隐患',
  '提示：想看有哪些能力？左侧菜单 →「功能索引」',
];
const placeholderIndex = ref(0);
const inputFocused = ref(false);
const dynamicPlaceholder = computed(
  () => placeholderHints[placeholderIndex.value] || placeholderHints[0]
);
let placeholderTimer = null;
function startPlaceholderRotation() {
  stopPlaceholderRotation();
  placeholderTimer = setInterval(() => {
    // 只在"空且未聚焦"时轮换,其余情况保持不动。
    if (input.value || inputFocused.value) return;
    placeholderIndex.value = (placeholderIndex.value + 1) % placeholderHints.length;
  }, 4200);
}
function stopPlaceholderRotation() {
  if (placeholderTimer) {
    clearInterval(placeholderTimer);
    placeholderTimer = null;
  }
}

function onInputFocus() {
  inputFocused.value = true;
  // 交由父组件在聚焦时预建 WebSocket（提前完成握手与认证）。
  emit('focus');
}
function onInputBlur() {
  inputFocused.value = false;
  emit('blur');
}

// ── 发送 / 快捷键 ────────────────────────────────────────────────────────────
// 发送不在本组件内做业务校验（附件/上传中/loading 由父组件统一判定），只把当前
// 文本抛给父组件；父组件成功发起后回调 clear() 清空输入框，保证与原行为一致。
function onSendClick() {
  emit('send', input.value);
}
function handleInputEnter(event) {
  if (event?.isComposing || event?.keyCode === 229) return;
  if (event?.shiftKey || event?.ctrlKey || event?.altKey || event?.metaKey) return;
  event.preventDefault();
  emit('send', input.value);
}
function handleInputArrowHistoryGuard(event) {
  if (event?.isComposing || event?.keyCode === 229) return;
  const current = String(input.value || '');
  // Guard against browser/IME history recall when input is empty.
  if (current.trim().length > 0) return;
  event.preventDefault();
  event.stopPropagation();
}

async function onVoiceInput() {
  if (props.loading) return;
  // 先让输入框获得焦点，语音听写的文字才会落入输入框，再交由父组件触发系统语音输入。
  chatInputRef.value?.focus?.();
  emit('voice-input');
}

// ── 暴露给父组件的方法（useExample/retract/newConversation/发送后清空）────────
function setText(text) {
  input.value = typeof text === 'string' ? text : (text && text.prompt) || '';
}
async function clear() {
  input.value = '';
  // 关键:IME 中文上屏 / 长文本回车发送时,<el-input type="textarea" :autosize>
  // 的 inline 高度还停在扩展行数,仅设 input.value='' 不会同步触发 autosize
  // 重算,导致 DOM 上残留一长串占位行。把 autosize 强制重置到 minRows=1,
  // 再下一帧让 Vue 把空字符串 commit 到 textarea,即可消除多余空行。
  await nextTick();
  const inst = chatInputRef.value;
  if (inst && typeof inst.resizeTextarea === 'function') {
    try {
      inst.resizeTextarea();
    } catch (_) {
      /* element-plus 内部可能重命名,失败就交给下一帧自动 */
    }
  }
}
function focus() {
  chatInputRef.value?.focus?.();
}
defineExpose({ setText, clear, focus });

onMounted(() => startPlaceholderRotation());
onBeforeUnmount(() => stopPlaceholderRotation());
</script>

<style scoped>
.chat-input-row {
  display: flex;
  align-items: flex-end;
  gap: 8px;
}

.chat-attach-btn {
  height: 44px;
  width: 44px;
  flex: 0 0 auto;
}

.chat-location-btn {
  height: 44px;
  width: 44px;
  flex: 0 0 auto;
}

.chat-voice-input-btn {
  height: 44px;
  width: 44px;
  flex: 0 0 auto;
}

.chat-location-btn.is-active {
  border-color: var(--el-color-primary);
  color: var(--el-color-primary);
}

.chat-location-btn.is-denied {
  opacity: 0.5;
  filter: grayscale(1);
}

/* Make a single-line composer the same height (44px) as the send button so the
   two bottom edges line up; when the textarea grows to multiple rows the row's
   flex-end keeps the button pinned to the bottom. */
.chat-input-row :deep(.el-textarea__inner) {
  min-height: 44px;
  padding-top: 11px;
  padding-bottom: 11px;
  line-height: 20px;
}

.chat-action-buttons {
  display: flex;
  align-items: center;
  gap: 8px;
}

.chat-send-btn {
  height: 44px;
  min-width: 88px;
}

.chat-stop-btn {
  height: 44px;
  min-width: 88px;
}

@media (max-width: 768px) {
  .chat-input-row {
    flex-direction: column;
    align-items: stretch;
  }

  .chat-attach-btn {
    align-self: flex-start;
  }

  .chat-action-buttons {
    width: 100%;
  }

  .chat-send-btn {
    flex: 1;
    width: 100%;
  }

  .chat-stop-btn {
    flex: 1;
  }
}
</style>

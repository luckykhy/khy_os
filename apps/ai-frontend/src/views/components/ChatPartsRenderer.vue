<template>
  <!--
    ChatPartsRenderer — Parts-based 消息渲染器（Vercel AI SDK 对齐）

    每条消息 = 类型化 parts 数组，每种 part 类型对应一个专用渲染组件：
    - text        → 纯文本 / Markdown
    - tool-call   → 工具调用卡片
    - tool-result → 工具结果块
    - thinking    → 思考折叠块
    - artifact    → 结构化产物（diff / table / chart / code）
    - image       → 图片预览

    参考：Vercel AI SDK parts-based message model
    对齐：Agent UI 十诫 #10 Generative UI over plain text
  -->
  <div class="chat-parts">
    <template v-for="(part, pi) in parts" :key="pi">
      <!-- 文本 -->
      <div v-if="part.type === 'text'" class="chat-part-text">
        <div v-if="part.text" class="chat-part-text-content">{{ part.text }}</div>
      </div>

      <!-- 工具调用 -->
      <div v-else-if="part.type === 'tool-call'" class="chat-part-toolcall">
        <div class="chat-part-toolcall-header">
          <el-icon class="chat-part-toolcall-icon"><Tools /></el-icon>
          <span class="chat-part-toolcall-name">{{ part.toolName }}</span>
          <span v-if="part.args && part.args.command" class="chat-part-toolcall-cmd">{{
            summarizeCommand(part.args.command)
          }}</span>
        </div>
      </div>

      <!-- 工具结果 -->
      <div
        v-else-if="part.type === 'tool-result'"
        class="chat-part-toolresult"
        :class="{ 'is-error': part.error }"
      >
        <div class="chat-part-toolresult-header">
          <el-icon v-if="part.error" class="chat-part-toolresult-icon is-error">
            <CircleClose />
          </el-icon>
          <el-icon v-else class="chat-part-toolresult-icon">
            <Select />
          </el-icon>
          <span class="chat-part-toolresult-status">{{
            part.error ? '执行失败' : '执行成功'
          }}</span>
        </div>
        <pre v-if="part.result" class="chat-part-toolresult-body">{{
          summarizeResult(part.result)
        }}</pre>
      </div>

      <!-- 思考过程 -->
      <div v-else-if="part.type === 'thinking'" class="chat-part-thinking">
        <button
          type="button"
          class="chat-part-thinking-toggle"
          @click="part.expanded = !part.expanded"
        >
          <span class="chat-part-thinking-icon">{{ part.expanded ? '▾' : '▸' }}</span>
          <span class="chat-part-thinking-label">{{
            part.expanded ? '收起思考' : '查看思考过程'
          }}</span>
        </button>
        <div v-if="part.expanded" class="chat-part-thinking-content">
          <pre v-for="(line, li) in (part.text || '').split('\n')" :key="li" class="chat-part-thinking-line">{{ line }}</pre>
        </div>
      </div>

      <!-- 结构化产物（Generative UI） -->
      <div v-else-if="part.type === 'artifact'" class="chat-part-artifact">
        <!-- Diff 产物 -->
        <div v-if="part.kind === 'diff'" class="chat-artifact-diff">
          <div class="chat-artifact-diff-header">
            <el-icon><Document /></el-icon>
            <span class="chat-artifact-diff-title">{{ part.title || '文件变更' }}</span>
            <span v-if="part.additions != null" class="chat-artifact-diff-add">+{{ part.additions }}</span>
            <span v-if="part.deletions != null" class="chat-artifact-diff-del">-{{ part.deletions }}</span>
          </div>
          <div v-if="part.hunks" class="chat-artifact-diff-hunks">
            <div
              v-for="(hunk, hi) in part.hunks"
              :key="hi"
              class="chat-artifact-diff-hunk"
            >
              <div v-if="hunk.header" class="chat-artifact-diff-hunk-header">{{ hunk.header }}</div>
              <div
                v-for="(line, li) in (hunk.lines || [])"
                :key="li"
                :class="['chat-artifact-diff-line', line.addition ? 'is-add' : line.deletion ? 'is-del' : '']"
              >
                <span class="chat-artifact-diff-line-num">{{ line.oldLine || '' }}</span>
                <span class="chat-artifact-diff-line-num">{{ line.newLine || '' }}</span>
                <span class="chat-artifact-diff-line-content">{{ line.content }}</span>
              </div>
            </div>
          </div>
          <pre v-else-if="part.content" class="chat-artifact-diff-raw">{{ part.content }}</pre>
        </div>

        <!-- Table 产物 -->
        <div v-else-if="part.kind === 'table'" class="chat-artifact-table">
          <div v-if="part.title" class="chat-artifact-table-title">{{ part.title }}</div>
          <el-table v-if="part.headers && part.rows" :data="part.rows" size="small" stripe border>
            <el-table-column
              v-for="h in part.headers"
              :key="h.key"
              :prop="h.key"
              :label="h.label || h.key"
              :width="h.width"
            />
          </el-table>
        </div>

        <!-- Code 产物 -->
        <div v-else-if="part.kind === 'code'" class="chat-artifact-code">
          <div v-if="part.title || part.language" class="chat-artifact-code-header">
            <span v-if="part.language" class="chat-artifact-code-lang">{{ part.language }}</span>
            <span v-if="part.title" class="chat-artifact-code-title">{{ part.title }}</span>
          </div>
          <pre class="chat-artifact-code-body"><code>{{ part.content }}</code></pre>
        </div>

        <!-- 通用产物 -->
        <div v-else class="chat-artifact-generic">
          <pre>{{ JSON.stringify(part.data || part, null, 2) }}</pre>
        </div>
      </div>

      <!-- 图片 -->
      <div v-else-if="part.type === 'image'" class="chat-part-image">
        <img :src="part.url || part.src" :alt="part.alt || '生成图片'" />
      </div>

      <!-- 未知类型回退 -->
      <div v-else class="chat-part-unknown">
        <pre>{{ JSON.stringify(part, null, 2) }}</pre>
      </div>
    </template>
  </div>
</template>

<script setup>
import { Tools, CircleClose, Select, Document } from '@element-plus/icons-vue';

/**
 * 命令摘要（截断到 60 字符）
 */
function summarizeCommand(cmd) {
  if (!cmd) return '';
  const s = String(cmd).replace(/\s+/g, ' ').trim();
  return s.length > 60 ? `${s.slice(0, 60)}…` : s;
}

/**
 * 结果摘要（截断到 200 字符）
 */
function summarizeResult(result) {
  if (!result) return '';
  const s = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

defineProps({
  parts: {
    type: Array,
    default: () => [],
  },
});
</script>

<style scoped>
.chat-parts {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* ── 文本 ── */
.chat-part-text-content {
  white-space: pre-wrap;
  word-break: break-word;
}

/* ── 工具调用 ── */
.chat-part-toolcall {
  padding: 6px 10px;
  border-left: 2px solid var(--khy-primary, #2563eb);
  background: var(--khy-bg-soft, #eff4ff);
  border-radius: 0 6px 6px 0;
}
.chat-part-toolcall-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}
.chat-part-toolcall-icon {
  color: var(--khy-primary, #2563eb);
}
.chat-part-toolcall-name {
  font-weight: 600;
  color: var(--khy-primary, #2563eb);
}
.chat-part-toolcall-cmd {
  color: var(--khy-text-secondary, #475467);
  font-family: var(--khy-font-mono, monospace);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 200px;
}

/* ── 工具结果 ── */
.chat-part-toolresult {
  padding: 6px 10px;
  background: var(--el-fill-color-lighter, #f5f7fa);
  border-radius: 6px;
  border: 1px solid var(--el-border-color-lighter, #ebeef5);
}
.chat-part-toolresult.is-error {
  background: var(--el-color-danger-light-9, #fef0f0);
  border-color: var(--el-color-danger-light-5, #f56c6c);
}
.chat-part-toolresult-header {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  margin-bottom: 4px;
}
.chat-part-toolresult-icon {
  color: var(--el-color-success, #67c23a);
}
.chat-part-toolresult-icon.is-error {
  color: var(--el-color-danger, #f56c6c);
}
.chat-part-toolresult-body {
  margin: 0;
  font-family: var(--khy-font-mono, monospace);
  font-size: 11px;
  line-height: 1.5;
  color: var(--khy-text-secondary, #475467);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 120px;
  overflow-y: auto;
}

/* ── 思考过程 ── */
.chat-part-thinking {
  border-left: 2px solid var(--el-color-primary-light-5, #c6e2ff);
  padding-left: 8px;
}
.chat-part-thinking-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: none;
  border: none;
  padding: 2px 0;
  cursor: pointer;
  font-size: 12px;
  color: var(--el-text-color-secondary, #909399);
}
.chat-part-thinking-toggle:hover {
  color: var(--el-color-primary, #409eff);
}
.chat-part-thinking-icon {
  font-size: 10px;
  width: 12px;
  text-align: center;
}
.chat-part-thinking-content {
  margin-top: 4px;
  padding: 6px 8px;
  background: var(--el-fill-color-lighter, #f5f7fa);
  border-radius: 4px;
  max-height: 200px;
  overflow-y: auto;
}
.chat-part-thinking-line {
  margin: 0;
  font-family: var(--khy-font-mono, monospace);
  font-size: 11px;
  line-height: 1.5;
  color: var(--el-text-color-regular, #606266);
  white-space: pre-wrap;
}

/* ── 结构化产物（Generative UI） ── */
.chat-part-artifact {
  border: 1px solid var(--el-border-color-lighter, #ebeef5);
  border-radius: 6px;
  overflow: hidden;
}

/* Diff 产物 */
.chat-artifact-diff-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  background: var(--el-fill-color-light, #f0f2f5);
  font-size: 12px;
  font-weight: 600;
}
.chat-artifact-diff-title {
  flex: 1 1 auto;
  min-width: 0;
}
.chat-artifact-diff-add {
  color: var(--el-color-success, #67c23a);
  font-family: var(--khy-font-mono, monospace);
  font-size: 11px;
}
.chat-artifact-diff-del {
  color: var(--el-color-danger, #f56c6c);
  font-family: var(--khy-font-mono, monospace);
  font-size: 11px;
}
.chat-artifact-diff-hunks {
  font-family: var(--khy-font-mono, monospace);
  font-size: 11px;
}
.chat-artifact-diff-hunk-header {
  padding: 2px 10px;
  background: var(--el-color-primary-light-9, #ecf5ff);
  color: var(--el-color-primary, #409eff);
}
.chat-artifact-diff-line {
  display: flex;
  gap: 8px;
  padding: 0 10px;
  line-height: 1.4;
}
.chat-artifact-diff-line.is-add {
  background: var(--el-color-success-light-9, #f0f9eb);
}
.chat-artifact-diff-line.is-del {
  background: var(--el-color-danger-light-9, #fef0f0);
}
.chat-artifact-diff-line-num {
  flex: 0 0 30px;
  color: var(--el-text-color-secondary, #909399);
  text-align: right;
  user-select: none;
}
.chat-artifact-diff-line-content {
  flex: 1 1 auto;
  white-space: pre-wrap;
  word-break: break-word;
}
.chat-artifact-diff-raw {
  margin: 0;
  padding: 8px 10px;
  font-family: var(--khy-font-mono, monospace);
  font-size: 11px;
  white-space: pre-wrap;
  max-height: 200px;
  overflow-y: auto;
}

/* Table 产物 */
.chat-artifact-table-title {
  padding: 6px 10px;
  font-size: 12px;
  font-weight: 600;
  background: var(--el-fill-color-light, #f0f2f5);
}

/* Code 产物 */
.chat-artifact-code-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: var(--el-fill-color-light, #f0f2f5);
  font-size: 12px;
}
.chat-artifact-code-lang {
  font-weight: 600;
  color: var(--el-color-primary, #409eff);
}
.chat-artifact-code-body {
  margin: 0;
  padding: 8px 10px;
  font-family: var(--khy-font-mono, monospace);
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 300px;
  overflow-y: auto;
}

/* 通用产物 */
.chat-artifact-generic pre {
  margin: 0;
  padding: 8px 10px;
  font-family: var(--khy-font-mono, monospace);
  font-size: 11px;
  white-space: pre-wrap;
}

/* 图片 */
.chat-part-image img {
  max-width: 100%;
  border-radius: 6px;
}

/* 未知类型 */
.chat-part-unknown pre {
  margin: 0;
  padding: 6px 10px;
  font-family: var(--khy-font-mono, monospace);
  font-size: 11px;
  background: var(--el-fill-color-lighter, #f5f7fa);
  border-radius: 4px;
  white-space: pre-wrap;
}
</style>

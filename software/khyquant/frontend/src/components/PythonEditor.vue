<template>
  <div class="python-editor">
    <!-- 工具栏 -->
    <div class="editor-toolbar">
      <div class="toolbar-left">
        <el-button-group size="small">
          <el-button @click="insertSnippet('function')">函数</el-button>
          <el-button @click="insertSnippet('if')">IF</el-button>
          <el-button @click="insertSnippet('for')">FOR</el-button>
          <el-button @click="insertSnippet('class')">类</el-button>
          <el-button @click="insertSnippet('try')">TRY</el-button>
        </el-button-group>
      </div>
      <div class="toolbar-right">
        <el-button size="small" @click="formatCode">
          <el-icon><MagicStick /></el-icon>
          格式化
        </el-button>
        <el-button size="small" @click="validateCode" :loading="validating">
          <el-icon><Check /></el-icon>
          验证语法
        </el-button>
      </div>
    </div>

    <!-- 语法错误提示 -->
    <el-alert
      v-if="syntaxErrors.filter(e => e.type === 'error').length > 0"
      type="error"
      :closable="false"
      style="margin-bottom: 10px;"
    >
      <template #title>
        <div style="font-size: 12px;">
          <strong>Syntax errors ({{ syntaxErrors.filter(e => e.type === 'error').length }}):</strong>
        </div>
      </template>
      <div style="font-size: 12px; margin-top: 8px;">
        <div v-for="(error, index) in syntaxErrors.filter(e => e.type === 'error')" :key="'err-'+index" style="margin: 4px 0;">
          <el-icon><WarningFilled /></el-icon>
          <span v-if="error.line > 0">Line {{ error.line }}: </span>
          <strong>{{ error.message }}</strong>
          <pre v-if="error.code && error.code !== 'global'" style="background: rgba(255,255,255,0.15); padding: 4px 8px; border-radius: 3px; margin: 4px 0 0 20px; font-size: 11px; white-space: pre-wrap;">{{ error.code }}</pre>
        </div>
      </div>
    </el-alert>

    <el-alert
      v-if="syntaxErrors.filter(e => e.type === 'warning').length > 0"
      type="warning"
      :closable="true"
      style="margin-bottom: 10px;"
    >
      <template #title>
        <div style="font-size: 12px;">
          <strong>Warnings ({{ syntaxErrors.filter(e => e.type === 'warning').length }}):</strong>
        </div>
      </template>
      <div style="font-size: 12px; margin-top: 8px;">
        <div v-for="(error, index) in syntaxErrors.filter(e => e.type === 'warning')" :key="'warn-'+index" style="margin: 4px 0;">
          Line {{ error.line }}: {{ error.message }}
          <code style="background: rgba(255,255,255,0.2); padding: 2px 6px; border-radius: 3px; margin-left: 8px;">
            {{ error.code }}
          </code>
        </div>
      </div>
    </el-alert>

    <!-- 代码编辑器 -->
    <div class="code-editor-container">
      <textarea
        ref="editorTextarea"
        v-model="localCode"
        class="python-code-editor"
        :placeholder="placeholder"
        @input="onCodeChange"
        @keydown="onKeyDown"
        @scroll="syncScroll"
        spellcheck="false"
      ></textarea>
      
      <!-- 语法高亮层 -->
      <div ref="highlightLayer" class="syntax-highlight-layer" v-html="highlightedCode"></div>
    </div>

    <!-- 语法提示 -->
    <div class="syntax-tips">
      <el-alert type="info" :closable="false">
        <template #title>
          <div style="font-size: 12px;">
            <strong>Python语法提示：</strong>
            使用4个空格缩进，
            语句块后使用冒号 <code>:</code>，
            函数定义 <code>def name(params):</code>
          </div>
        </template>
      </el-alert>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick } from 'vue'
import { MagicStick, Check, WarningFilled } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { getApiBaseUrl } from '@/config/api'

const props = defineProps({
  modelValue: {
    type: String,
    default: ''
  },
  placeholder: {
    type: String,
    default: '请输入Python代码...'
  }
})

const emit = defineEmits(['update:modelValue', 'validate'])

const editorTextarea = ref(null)
const localCode = ref(props.modelValue)
const syntaxErrors = ref([])
const validating = ref(false)
const highlightLayer = ref(null)

watch(() => props.modelValue, (newValue) => {
  if (newValue !== localCode.value) {
    localCode.value = newValue
  }
})

watch(localCode, (newValue) => {
  emit('update:modelValue', newValue)
})

// 同步滚动
function syncScroll() {
  if (editorTextarea.value && highlightLayer.value) {
    highlightLayer.value.scrollTop = editorTextarea.value.scrollTop
    highlightLayer.value.scrollLeft = editorTextarea.value.scrollLeft
  }
}

// 语法高亮 - 字符级别包裹，确保换行一致
const highlightedCode = computed(() => {
  if (!localCode.value) return ''
  
  const code = localCode.value
  const tokens = []
  let i = 0
  
  const keywords = [
    'def', 'class', 'if', 'elif', 'else', 'for', 'while', 'break', 'continue',
    'return', 'try', 'except', 'finally', 'raise', 'import', 'from', 'as',
    'with', 'pass', 'lambda', 'yield', 'async', 'await', 'True', 'False', 'None'
  ]
  
  while (i < code.length) {
    const char = code[i]
    
    // 字符串
    if (char === '"' || char === "'") {
      const quote = char
      const start = i
      
      // 三引号
      if (code[i + 1] === quote && code[i + 2] === quote) {
        i += 3
        while (i < code.length - 2) {
          if (code[i] === quote && code[i + 1] === quote && code[i + 2] === quote) {
            i += 3
            break
          }
          i++
        }
      } else {
        i++
        while (i < code.length && code[i] !== quote) {
          if (code[i] === '\\') i++
          i++
        }
        i++
      }
      tokens.push({ type: 'string', text: code.substring(start, i) })
      continue
    }
    
    // 注释
    if (char === '#') {
      const start = i
      while (i < code.length && code[i] !== '\n') i++
      tokens.push({ type: 'comment', text: code.substring(start, i) })
      continue
    }
    
    // 标识符和关键字
    if (/[a-zA-Z_]/.test(char)) {
      const start = i
      while (i < code.length && /[a-zA-Z0-9_]/.test(code[i])) i++
      const word = code.substring(start, i)
      
      if (keywords.includes(word)) {
        tokens.push({ type: 'keyword', text: word })
      } else if (i < code.length && /\s*\(/.test(code.substring(i, i + 10))) {
        tokens.push({ type: 'function', text: word })
      } else {
        tokens.push({ type: 'text', text: word })
      }
      continue
    }
    
    // 数字
    if (/\d/.test(char)) {
      const start = i
      while (i < code.length && /[\d.]/.test(code[i])) i++
      tokens.push({ type: 'number', text: code.substring(start, i) })
      continue
    }
    
    // 其他字符
    tokens.push({ type: 'text', text: char })
    i++
  }
  
  // 转换为HTML，每个字符独立包裹
  let html = ''
  for (const token of tokens) {
    const escaped = token.text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
    
    if (token.type === 'text') {
      html += escaped
    } else {
      for (const char of escaped) {
        html += `<span class="hl-${token.type}">${char}</span>`
      }
    }
  }
  
  return html
})

function onCodeChange() {
  if (localCode.value) {
    validateSyntax()
  } else {
    syntaxErrors.value = []
  }
}

function onKeyDown(event) {
  if (event.key === 'Tab') {
    event.preventDefault()
    const start = event.target.selectionStart
    const end = event.target.selectionEnd
    const spaces = '    ' // Python使用4个空格
    localCode.value = localCode.value.substring(0, start) + spaces + localCode.value.substring(end)
    
    nextTick(() => {
      event.target.selectionStart = event.target.selectionEnd = start + spaces.length
    })
  }
}

function insertSnippet(type) {
  const textarea = editorTextarea.value
  const start = textarea.selectionStart
  const end = textarea.selectionEnd
  
  let template = ''
  switch (type) {
    case 'function':
      template = 'def function_name(params):\n    # 代码\n    return result'
      break
    case 'if':
      template = 'if condition:\n    # 代码\n    pass'
      break
    case 'for':
      template = 'for item in items:\n    # 代码\n    pass'
      break
    case 'class':
      template = 'class ClassName:\n    def __init__(self):\n        pass'
      break
    case 'try':
      template = 'try:\n    # 代码\nexcept Exception as e:\n    print(e)'
      break
  }
  
  localCode.value = localCode.value.substring(0, start) + template + localCode.value.substring(end)
  
  nextTick(() => {
    textarea.focus()
    textarea.selectionStart = start
    textarea.selectionEnd = start + template.length
  })
}

function formatCode() {
  if (!localCode.value) return
  ElMessage.success('Python代码格式化需要后端支持')
}

function validateCode() {
  validating.value = true
  validateSyntaxWithBackend().finally(() => {
    validating.value = false
  })
}

async function validateSyntaxWithBackend() {
  if (!localCode.value) {
    syntaxErrors.value = []
    emit('validate', { valid: true, errors: [] })
    return
  }

  // First do local checks
  const localErrors = validateSyntaxLocal()

  // Then try backend Python syntax check
  try {
    const response = await fetch(`${getApiBaseUrl()}/strategy/validate-python`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: localCode.value })
    })
    const data = await response.json()
    if (data.success && data.errors && data.errors.length > 0) {
      // Backend found real Python syntax errors
      const backendErrors = data.errors.map(err => ({
        line: err.line || 0,
        message: err.message || 'Syntax error',
        code: err.code || '',
        type: 'error'
      }))
      syntaxErrors.value = [...backendErrors, ...localErrors.filter(e => e.type === 'warning')]
    } else if (data.success && (!data.errors || data.errors.length === 0)) {
      // Backend says code is valid - only show local warnings
      syntaxErrors.value = localErrors
      if (localErrors.filter(e => e.type !== 'warning').length === 0) {
        ElMessage.success('Python syntax is valid')
      }
    } else {
      // Backend returned error, fall back to local only
      syntaxErrors.value = localErrors
    }
  } catch (err) {
    // Backend unreachable, use local validation only
    syntaxErrors.value = localErrors
    if (localErrors.filter(e => e.type === 'error').length === 0) {
      ElMessage.success('Local syntax check passed (backend unavailable)')
    } else {
      ElMessage.warning(`Found ${localErrors.filter(e => e.type === 'error').length} potential issues`)
    }
  }

  const hasErrors = syntaxErrors.value.filter(e => e.type === 'error').length > 0
  emit('validate', { valid: !hasErrors, errors: syntaxErrors.value })
}

function validateSyntax() {
  const errors = validateSyntaxLocal()
  syntaxErrors.value = errors
  emit('validate', {
    valid: errors.filter(e => e.type === 'error').length === 0,
    errors: errors
  })
  return errors.filter(e => e.type === 'error').length === 0
}

function validateSyntaxLocal() {
  const errors = []

  if (!localCode.value) return errors

  const code = localCode.value
  const lines = code.split('\n')

  let parenCount = 0
  let bracketCount = 0
  let braceCount = 0

  for (let i = 0; i < code.length; i++) {
    const char = code[i]

    if (char === '"' || char === "'") {
      const quote = char
      if (i + 2 < code.length && code[i + 1] === quote && code[i + 2] === quote) {
        i += 3
        while (i < code.length - 2) {
          if (code[i] === quote && code[i + 1] === quote && code[i + 2] === quote) {
            i += 2
            break
          }
          i++
        }
      } else {
        i++
        while (i < code.length && code[i] !== quote) {
          if (code[i] === '\\' && i + 1 < code.length) i++
          i++
        }
      }
      continue
    }

    if (char === '#') {
      while (i < code.length && code[i] !== '\n') i++
      continue
    }

    if (char === '(') parenCount++
    if (char === ')') parenCount--
    if (char === '[') bracketCount++
    if (char === ']') bracketCount--
    if (char === '{') braceCount++
    if (char === '}') braceCount--
  }

  if (parenCount !== 0) {
    errors.push({
      line: 0,
      message: `Mismatched parentheses (${parenCount > 0 ? 'missing' : 'extra'} ${Math.abs(parenCount)} ))`,
      code: 'global',
      type: 'error'
    })
  }

  if (bracketCount !== 0) {
    errors.push({
      line: 0,
      message: `Mismatched brackets (${bracketCount > 0 ? 'missing' : 'extra'} ${Math.abs(bracketCount)} ])`,
      code: 'global',
      type: 'error'
    })
  }

  if (braceCount !== 0) {
    errors.push({
      line: 0,
      message: `Mismatched braces (${braceCount > 0 ? 'missing' : 'extra'} ${Math.abs(braceCount)} })`,
      code: 'global',
      type: 'error'
    })
  }

  lines.forEach((line, index) => {
    const trimmed = line.trim()
    const lineNum = index + 1

    if (!trimmed || trimmed.startsWith('#')) return

    if (trimmed.match(/^(if|elif|else|for|while|def|class|try|except|finally|with)\s/) ||
        trimmed.match(/^(if|elif|else|for|while|def|class|try|except|finally|with)$/)) {
      if (!trimmed.endsWith(':') && !trimmed.endsWith('\\')) {
        errors.push({
          line: lineNum,
          message: 'Missing colon at end of statement',
          code: trimmed.substring(0, 60) + (trimmed.length > 60 ? '...' : ''),
          type: 'error'
        })
      }
    }

    const leadingSpaces = line.match(/^ */)[0].length
    if (leadingSpaces % 4 !== 0 && trimmed && leadingSpaces > 0) {
      errors.push({
        line: lineNum,
        message: 'Indentation should be a multiple of 4 spaces',
        code: line.substring(0, 50) + (line.length > 50 ? '...' : ''),
        type: 'warning'
      })
    }
  })

  return errors
}

defineExpose({
  validateCode,
  formatCode,
  insertSnippet
})
</script>

<style scoped>
.python-editor {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.editor-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  background: #f5f7fa;
  border-radius: 4px;
}

.code-editor-container {
  position: relative;
  min-height: 400px;
  border: 1px solid #dcdfe6;
  border-radius: 4px;
  overflow: hidden;
}

.python-code-editor {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  padding: 12px;
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  font-size: 14px;
  line-height: 1.6;
  color: transparent;
  caret-color: #303133;
  background: transparent;
  border: none;
  outline: none;
  resize: vertical;
  z-index: 2;
  white-space: pre-wrap;
  word-wrap: break-word;
  overflow-wrap: break-word;
  overflow: auto;
  tab-size: 4;
  -moz-tab-size: 4;
}

.syntax-highlight-layer {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  padding: 12px;
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  font-size: 14px;
  line-height: 1.6;
  color: #303133;
  background: #ffffff;
  pointer-events: none;
  z-index: 1;
  white-space: pre-wrap;
  word-wrap: break-word;
  overflow-wrap: break-word;
  overflow: auto;
}

/* 语法高亮样式 */
:deep(.hl-keyword) {
  color: #9933cc;
  font-weight: 600;
}

:deep(.hl-function) {
  color: #0066cc;
  font-weight: 600;
}

:deep(.hl-number) {
  color: #009900;
}

:deep(.hl-string) {
  color: #cc0000;
}

:deep(.hl-comment) {
  color: #999999;
  font-style: italic;
}

code {
  background: #f5f7fa;
  padding: 2px 6px;
  border-radius: 3px;
  font-family: 'Consolas', monospace;
}
</style>

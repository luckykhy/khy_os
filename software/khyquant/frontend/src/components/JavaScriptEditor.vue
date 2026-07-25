<template>
  <div class="javascript-editor">
    <!-- 工具栏 -->
    <div class="editor-toolbar">
      <div class="toolbar-left">
        <el-button-group size="small">
          <el-button @click="insertSnippet('function')">函数</el-button>
          <el-button @click="insertSnippet('if')">IF</el-button>
          <el-button @click="insertSnippet('for')">FOR</el-button>
          <el-button @click="insertSnippet('const')">CONST</el-button>
          <el-button @click="insertSnippet('arrow')">箭头函数</el-button>
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
          <pre v-if="error.code && error.code !== 'global'" style="background: rgba(255,255,255,0.15); padding: 4px 8px; border-radius: 3px; margin: 4px 0 0 20px; font-size: 11px; white-space: pre-wrap; overflow-x: auto;">{{ error.code }}</pre>
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
        class="js-code-editor"
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
            <strong>JavaScript语法提示：</strong>
            使用 <code>const</code>/<code>let</code> 声明变量，
            使用 <code>===</code> 进行比较，
            函数使用 <code>function name() {}</code> 或 <code>const name = () => {}</code>
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

const props = defineProps({
  modelValue: {
    type: String,
    default: ''
  },
  placeholder: {
    type: String,
    default: '请输入JavaScript代码...'
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
    'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while',
    'break', 'continue', 'switch', 'case', 'default', 'try', 'catch', 'finally',
    'throw', 'new', 'class', 'extends', 'import', 'export', 'from', 'async', 'await'
  ]
  
  while (i < code.length) {
    const char = code[i]
    
    // 字符串
    if (char === '"' || char === "'" || char === '`') {
      const quote = char
      const start = i
      i++
      while (i < code.length && code[i] !== quote) {
        if (code[i] === '\\') i++
        i++
      }
      i++
      tokens.push({ type: 'string', text: code.substring(start, i) })
      continue
    }
    
    // 注释
    if (char === '/' && code[i + 1] === '/') {
      const start = i
      while (i < code.length && code[i] !== '\n') i++
      tokens.push({ type: 'comment', text: code.substring(start, i) })
      continue
    }
    
    if (char === '/' && code[i + 1] === '*') {
      const start = i
      i += 2
      while (i < code.length - 1 && !(code[i] === '*' && code[i + 1] === '/')) i++
      i += 2
      tokens.push({ type: 'comment', text: code.substring(start, i) })
      continue
    }
    
    // 标识符和关键字
    if (/[a-zA-Z_$]/.test(char)) {
      const start = i
      while (i < code.length && /[a-zA-Z0-9_$]/.test(code[i])) i++
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
    const spaces = '  '
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
      template = 'function name(params) {\n  // 代码\n  return result;\n}'
      break
    case 'if':
      template = 'if (condition) {\n  // 代码\n}'
      break
    case 'for':
      template = 'for (let i = 0; i < length; i++) {\n  // 代码\n}'
      break
    case 'const':
      template = 'const name = value;'
      break
    case 'arrow':
      template = 'const name = (params) => {\n  // 代码\n  return result;\n}'
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
  
  try {
    const lines = localCode.value.split('\n')
    let indentLevel = 0
    const formatted = []
    
    lines.forEach(line => {
      const trimmed = line.trim()
      if (!trimmed) {
        formatted.push('')
        return
      }
      
      if (trimmed.startsWith('}') || trimmed.startsWith(']') || trimmed.startsWith(')')) {
        indentLevel = Math.max(0, indentLevel - 1)
      }
      
      formatted.push('  '.repeat(indentLevel) + trimmed)
      
      if (trimmed.endsWith('{') || trimmed.endsWith('[') || trimmed.endsWith('(')) {
        indentLevel++
      }
    })
    
    localCode.value = formatted.join('\n')
    ElMessage.success('代码已格式化')
  } catch (error) {
    ElMessage.error('格式化失败: ' + error.message)
  }
}

function validateCode() {
  validating.value = true
  try {
    validateSyntax()
    if (syntaxErrors.value.length === 0) {
      ElMessage.success('语法验证通过')
    } else {
      ElMessage.warning(`发现 ${syntaxErrors.value.length} 个语法错误`)
    }
  } finally {
    validating.value = false
  }
}

function validateSyntax() {
  const errors = []

  if (!localCode.value) {
    syntaxErrors.value = []
    emit('validate', { valid: true, errors: [] })
    return
  }

  const code = localCode.value
  const lines = code.split('\n')

  // Real JavaScript syntax check via Function constructor
  try {
    new Function('data', 'params', code)
  } catch (syntaxError) {
    const msg = syntaxError.message || 'Unknown syntax error'
    // Extract line number from error message (e.g., "Unexpected token (3:5)")
    let errorLine = 0
    let errorCol = 0
    const lineMatch = msg.match(/\((\d+):(\d+)\)/)
    if (lineMatch) {
      errorLine = parseInt(lineMatch[1])
      errorCol = parseInt(lineMatch[2])
    }
    // Some engines use different formats
    const altMatch = msg.match(/line (\d+)/i)
    if (!lineMatch && altMatch) {
      errorLine = parseInt(altMatch[1])
    }

    const errorLineText = errorLine > 0 && errorLine <= lines.length
      ? lines[errorLine - 1]
      : ''
    const caret = errorCol > 0 ? ' '.repeat(Math.max(0, errorCol - 1)) + '^' : ''

    errors.push({
      line: errorLine || 1,
      message: msg.replace(/\(\d+:\d+\)/, '').trim(),
      code: errorLineText
        ? errorLineText.substring(0, 80) + (caret ? '\n' + caret : '')
        : 'global',
      type: 'error'
    })
  }

  // Bracket matching check
  let braceCount = 0
  let parenCount = 0
  let bracketCount = 0

  for (let i = 0; i < code.length; i++) {
    const char = code[i]

    // Skip strings
    if (char === '"' || char === "'" || char === '`') {
      const quote = char
      i++
      while (i < code.length && code[i] !== quote) {
        if (code[i] === '\\' && i + 1 < code.length) i++
        i++
      }
      continue
    }

    // Skip single-line comments
    if (char === '/' && i + 1 < code.length && code[i + 1] === '/') {
      while (i < code.length && code[i] !== '\n') i++
      continue
    }

    // Skip multi-line comments
    if (char === '/' && i + 1 < code.length && code[i + 1] === '*') {
      i += 2
      while (i < code.length - 1 && !(code[i] === '*' && code[i + 1] === '/')) i++
      if (i < code.length - 1) i += 2
      i--
      continue
    }

    if (char === '{') braceCount++
    if (char === '}') braceCount--
    if (char === '(') parenCount++
    if (char === ')') parenCount--
    if (char === '[') bracketCount++
    if (char === ']') bracketCount--
  }

  if (braceCount !== 0) {
    errors.push({
      line: 0,
      message: `Mismatched braces (${braceCount > 0 ? 'missing' : 'extra'} ${Math.abs(braceCount)} })`,
      code: 'global',
      type: 'error'
    })
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

  // Style warnings (lower priority)
  lines.forEach((line, index) => {
    const trimmed = line.trim()
    const lineNum = index + 1

    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*')) return

    if (trimmed.match(/[^=!<>]==(?!=)/)) {
      errors.push({
        line: lineNum,
        message: 'Prefer === instead of ==',
        code: trimmed.substring(0, 50) + (trimmed.length > 50 ? '...' : ''),
        type: 'warning'
      })
    }
  })

  syntaxErrors.value = errors
  emit('validate', {
    valid: errors.filter(e => e.type === 'error').length === 0,
    errors: errors
  })

  return errors.filter(e => e.type === 'error').length === 0
}

defineExpose({
  validateCode,
  formatCode,
  insertSnippet
})
</script>

<style scoped>
.javascript-editor {
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

.js-code-editor {
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
  tab-size: 2;
  -moz-tab-size: 2;
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

.syntax-tips {
  font-size: 12px;
}

code {
  background: #f5f7fa;
  padding: 2px 6px;
  border-radius: 3px;
  font-family: 'Consolas', monospace;
}
</style>

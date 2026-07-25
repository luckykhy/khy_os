<template>
  <div class="tdx-formula-editor">
    <!-- 工具栏 -->
    <div class="editor-toolbar">
      <div class="toolbar-left">
        <el-button-group size="small">
          <el-button @click="insertFunction('HHV')">HHV</el-button>
          <el-button @click="insertFunction('LLV')">LLV</el-button>
          <el-button @click="insertFunction('MA')">MA</el-button>
          <el-button @click="insertFunction('CROSS')">CROSS</el-button>
          <el-button @click="insertFunction('IF')">IF</el-button>
          <el-button @click="insertFunction('COUNT')">COUNT</el-button>
          <el-button @click="insertFunction('SUM')">SUM</el-button>
          <el-button @click="insertFunction('REF')">REF</el-button>
        </el-button-group>
      </div>
      <div class="toolbar-right">
        <el-button size="small" @click="formatCode">
          <el-icon><MagicStick /></el-icon>
          格式化
        </el-button>
        <el-button size="small" @click="parseCode">
          <el-icon><View /></el-icon>
          解析变量
        </el-button>
      </div>
    </div>

    <!-- 代码编辑器 -->
    <div class="code-editor-container">
      <textarea
        ref="editorTextarea"
        v-model="localCode"
        class="tdx-code-editor"
        :placeholder="placeholder"
        @input="onCodeChange"
        @keydown="onKeyDown"
        spellcheck="false"
      ></textarea>
      
      <!-- 语法高亮层 -->
      <div class="syntax-highlight-layer" v-html="highlightedCode"></div>
    </div>

    <!-- 变量列表 -->
    <div v-if="parsedVariables.length > 0" class="variables-panel">
      <div class="panel-header">
        <el-icon><List /></el-icon>
        <span>识别的变量 ({{ parsedVariables.length }})</span>
      </div>
      <div class="variables-list">
        <el-tag
          v-for="variable in parsedVariables"
          :key="variable.name"
          size="small"
          :type="variable.type === 'display' ? 'success' : 'info'"
          style="margin: 4px;"
        >
          {{ variable.name }}
          <span v-if="variable.value" style="margin-left: 4px; opacity: 0.7;">
            = {{ variable.value }}
          </span>
        </el-tag>
      </div>
    </div>

    <!-- 语法提示 -->
    <div class="syntax-tips">
      <!-- 🔥 新增：语法错误提示 -->
      <el-alert 
        v-if="syntaxErrors.length > 0" 
        type="error" 
        :closable="false"
        style="margin-bottom: 10px;"
      >
        <template #title>
          <div style="font-size: 12px;">
            <strong>语法错误 ({{ syntaxErrors.length }}个)：</strong>
          </div>
        </template>
        <div style="font-size: 12px; margin-top: 8px;">
          <div v-for="(error, index) in syntaxErrors" :key="index" style="margin: 4px 0;">
            <el-icon><WarningFilled /></el-icon>
            第{{ error.line }}行: {{ error.message }}
            <code style="background: rgba(255,255,255,0.2); padding: 2px 6px; border-radius: 3px; margin-left: 8px;">
              {{ error.code }}
            </code>
          </div>
        </div>
      </el-alert>
      
      <el-alert type="info" :closable="false">
        <template #title>
          <div style="font-size: 12px;">
            <strong>通达信公式语法：</strong>
            变量赋值用 <code>:=</code> (如: MA5:=MA(CLOSE,5))，
            显示变量用 <code>:</code> (如: 均线:MA(CLOSE,5))，
            条件判断用 <code>IF(条件,真值,假值)</code>，
            逻辑运算用 <code>AND</code> 和 <code>OR</code>
          </div>
        </template>
      </el-alert>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { MagicStick, View, List, WarningFilled } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'

const props = defineProps({
  modelValue: {
    type: String,
    default: ''
  },
  placeholder: {
    type: String,
    default: '请输入通达信公式代码...'
  }
})

const emit = defineEmits(['update:modelValue', 'parse', 'validate'])

const editorTextarea = ref(null)
const localCode = ref(props.modelValue)
const parsedVariables = ref([])
const syntaxErrors = ref([])  // 🔥 新增：语法错误列表

// 监听外部变化
watch(() => props.modelValue, (newValue) => {
  if (newValue !== localCode.value) {
    localCode.value = newValue
  }
})

// 监听内部变化
watch(localCode, (newValue) => {
  emit('update:modelValue', newValue)
})

// 语法高亮
const highlightedCode = computed(() => {
  if (!localCode.value) return ''
  
  let code = localCode.value
  
  // 转义HTML
  code = code
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  
  // 高亮函数名（蓝色）
  const functions = [
    'HHV', 'LLV', 'MA', 'SMA', 'EMA', 'CROSS', 'IF', 'COUNT', 'SUM', 'REF',
    'MAX', 'MIN', 'ABS', 'SQRT', 'POW', 'MOD', 'FLOOR', 'CEIL',
    'BARSLAST', 'SUMBARS', 'VALUEWHEN', 'STD', 'VAR',
    'DRAWICON', 'DRAWTEXT', 'DRAWNUMBER', 'SOUND'
  ]
  
  functions.forEach(func => {
    const regex = new RegExp(`\\b${func}\\b`, 'g')
    code = code.replace(regex, `<span class="hl-function">${func}</span>`)
  })
  
  // 高亮关键字（紫色）
  const keywords = ['AND', 'OR', 'NOT', 'THEN', 'ELSE']
  keywords.forEach(keyword => {
    const regex = new RegExp(`\\b${keyword}\\b`, 'g')
    code = code.replace(regex, `<span class="hl-keyword">${keyword}</span>`)
  })
  
  // 高亮系统变量（橙色）
  const systemVars = ['OPEN', 'HIGH', 'LOW', 'CLOSE', 'VOLUME', 'BARPOS', 'UNIT', 'MINPRICE']
  systemVars.forEach(sysVar => {
    const regex = new RegExp(`\\b${sysVar}\\b`, 'g')
    code = code.replace(regex, `<span class="hl-system">${sysVar}</span>`)
  })
  
  // 高亮数字（绿色）
  code = code.replace(/\b(\d+\.?\d*)\b/g, '<span class="hl-number">$1</span>')
  
  // 高亮字符串（红色）
  code = code.replace(/'([^']*)'/g, '<span class="hl-string">\'$1\'</span>')
  
  // 高亮注释（灰色）
  code = code.replace(/\/\/(.*)$/gm, '<span class="hl-comment">//$1</span>')
  code = code.replace(/\{([^}]*)\}/g, '<span class="hl-comment">{$1}</span>')
  
  // 高亮赋值运算符
  code = code.replace(/:=/g, '<span class="hl-operator">:=</span>')
  code = code.replace(/([^:]):([^=])/g, '$1<span class="hl-operator">:</span>$2')
  
  return code
})

// 代码变化处理
function onCodeChange() {
  // 自动解析变量和验证语法
  if (localCode.value) {
    parseCodeSilently()
    validateSyntax()  // 🔥 新增：实时语法验证
  } else {
    syntaxErrors.value = []
  }
}

// 键盘事件处理
function onKeyDown(event) {
  // Tab键插入空格
  if (event.key === 'Tab') {
    event.preventDefault()
    const start = event.target.selectionStart
    const end = event.target.selectionEnd
    const spaces = '  '
    localCode.value = localCode.value.substring(0, start) + spaces + localCode.value.substring(end)
    
    // 恢复光标位置
    setTimeout(() => {
      event.target.selectionStart = event.target.selectionEnd = start + spaces.length
    }, 0)
  }
}

// 插入函数
function insertFunction(funcName) {
  const textarea = editorTextarea.value
  const start = textarea.selectionStart
  const end = textarea.selectionEnd
  
  let template = ''
  switch (funcName) {
    case 'HHV':
    case 'LLV':
      template = `${funcName}(CLOSE, 20)`
      break
    case 'MA':
    case 'SMA':
    case 'EMA':
      template = `${funcName}(CLOSE, 5)`
      break
    case 'CROSS':
      template = `${funcName}(MA5, MA10)`
      break
    case 'IF':
      template = `${funcName}(条件, 真值, 假值)`
      break
    case 'COUNT':
      template = `${funcName}(条件, 周期)`
      break
    case 'SUM':
      template = `${funcName}(数据, 周期)`
      break
    case 'REF':
      template = `${funcName}(数据, 周期)`
      break
    default:
      template = `${funcName}()`
  }
  
  localCode.value = localCode.value.substring(0, start) + template + localCode.value.substring(end)
  
  // 恢复焦点并选中插入的内容
  setTimeout(() => {
    textarea.focus()
    textarea.selectionStart = start
    textarea.selectionEnd = start + template.length
  }, 0)
}

// 格式化代码
function formatCode() {
  if (!localCode.value) return
  
  // 按分号和换行分割
  const lines = localCode.value.split(/[;\n]/).map(line => line.trim()).filter(line => line)
  
  // 重新组合，每行一个语句
  localCode.value = lines.join(';\n') + ';'
  
  ElMessage.success('代码已格式化')
}

// 解析代码（显示结果）
function parseCode() {
  const result = parseStrategy(localCode.value)
  parsedVariables.value = result.variables
  
  emit('parse', result)
  
  if (result.variables.length > 0) {
    ElMessage.success(`成功识别 ${result.variables.length} 个变量`)
  } else {
    ElMessage.warning('未识别到变量定义')
  }
}

// 静默解析（不显示消息）
function parseCodeSilently() {
  const result = parseStrategy(localCode.value)
  parsedVariables.value = result.variables
}

// 🔥 新增：语法验证函数
function validateSyntax() {
  const errors = []
  
  if (!localCode.value) {
    syntaxErrors.value = []
    emit('validate', { valid: true, errors: [] })
    return
  }
  
  // 按行分割
  const lines = localCode.value.split(/\n/)
  
  lines.forEach((line, index) => {
    const trimmed = line.trim()
    const lineNum = index + 1
    
    // 跳过空行和注释
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('{')) return
    
    // 检查1: 括号匹配
    const openParens = (trimmed.match(/\(/g) || []).length
    const closeParens = (trimmed.match(/\)/g) || []).length
    if (openParens !== closeParens) {
      errors.push({
        line: lineNum,
        message: '括号不匹配',
        code: trimmed.substring(0, 50) + (trimmed.length > 50 ? '...' : ''),
        type: 'parenthesis'
      })
    }
    
    // 检查2: 赋值运算符
    if (trimmed.includes('=') && !trimmed.includes(':=') && !trimmed.includes('==') && !trimmed.includes('!=') && !trimmed.includes('>=') && !trimmed.includes('<=')) {
      // 检查是否是单独的 = (可能是错误的赋值)
      if (trimmed.match(/[^:!<>]=(?!=)/)) {
        errors.push({
          line: lineNum,
          message: '赋值应使用 := 而不是 =',
          code: trimmed.substring(0, 50) + (trimmed.length > 50 ? '...' : ''),
          type: 'assignment'
        })
      }
    }
    
    // 检查3: 未闭合的字符串
    const singleQuotes = (trimmed.match(/'/g) || []).length
    if (singleQuotes % 2 !== 0) {
      errors.push({
        line: lineNum,
        message: '字符串引号未闭合',
        code: trimmed.substring(0, 50) + (trimmed.length > 50 ? '...' : ''),
        type: 'string'
      })
    }
    
    // 检查4: 函数名拼写（常见错误）
    const validFunctions = [
      'HHV', 'LLV', 'MA', 'SMA', 'EMA', 'CROSS', 'IF', 'COUNT', 'SUM', 'REF',
      'MAX', 'MIN', 'ABS', 'SQRT', 'POW', 'MOD', 'FLOOR', 'CEIL',
      'BARSLAST', 'SUMBARS', 'VALUEWHEN', 'STD', 'VAR',
      'DRAWICON', 'DRAWTEXT', 'DRAWNUMBER', 'SOUND',
      'OPEN', 'HIGH', 'LOW', 'CLOSE', 'VOLUME', 'BARPOS', 'UNIT', 'MINPRICE',
      'AND', 'OR', 'NOT', 'THEN', 'ELSE'
    ]
    
    // 提取可能的函数调用
    const funcMatches = trimmed.match(/\b([A-Z][A-Z0-9]*)\s*\(/g)
    if (funcMatches) {
      funcMatches.forEach(match => {
        const funcName = match.replace(/\s*\(/, '')
        if (!validFunctions.includes(funcName) && !funcName.match(/^[A-Z]{1,3}\d+$/)) {
          errors.push({
            line: lineNum,
            message: `未知函数: ${funcName}`,
            code: trimmed.substring(0, 50) + (trimmed.length > 50 ? '...' : ''),
            type: 'function'
          })
        }
      })
    }
    
    // 检查5: 逗号后缺少空格（代码风格警告）
    if (trimmed.match(/,\S/) && !trimmed.match(/,\d/)) {
      // 这是一个轻微的警告，不算严重错误
      // errors.push({
      //   line: lineNum,
      //   message: '建议在逗号后添加空格',
      //   code: trimmed.substring(0, 50) + (trimmed.length > 50 ? '...' : ''),
      //   type: 'style'
      // })
    }
    
    // 检查6: 空的函数调用
    if (trimmed.match(/\b[A-Z]+\(\s*\)/)) {
      errors.push({
        line: lineNum,
        message: '函数调用缺少参数',
        code: trimmed.substring(0, 50) + (trimmed.length > 50 ? '...' : ''),
        type: 'parameter'
      })
    }
  })
  
  syntaxErrors.value = errors
  emit('validate', { 
    valid: errors.length === 0, 
    errors: errors 
  })
  
  return errors.length === 0
}

// 解析策略代码
function parseStrategy(code) {
  const variables = []
  const parameters = []
  
  if (!code) {
    return { variables, parameters }
  }
  
  // 按行分割
  const lines = code.split(/[;\n]/)
  
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('{')) continue
    
    // 匹配变量定义: 变量名:=表达式 或 变量名:表达式
    const assignMatch = trimmed.match(/^([^:]+):=(.+)$/)
    const displayMatch = trimmed.match(/^([^:]+):([^=].+)$/)
    
    if (assignMatch) {
      const [, varName, expression] = assignMatch
      const cleanName = varName.trim()
      const cleanExpr = expression.split(',')[0].trim() // 移除NODRAW等属性
      
      variables.push({
        name: cleanName,
        value: cleanExpr,
        type: 'assign',
        line: trimmed
      })
    } else if (displayMatch) {
      const [, varName, expression] = displayMatch
      const cleanName = varName.trim()
      const cleanExpr = expression.split(',')[0].trim()
      
      variables.push({
        name: cleanName,
        value: cleanExpr,
        type: 'display',
        line: trimmed
      })
    }
    
    // 匹配参数定义（数字常量）
    const paramMatch = trimmed.match(/^([^:]+):=(\d+\.?\d*)/)
    if (paramMatch) {
      const [, paramName, paramValue] = paramMatch
      parameters.push({
        name: paramName.trim(),
        value: parseFloat(paramValue)
      })
    }
  }
  
  return { variables, parameters }
}

// 暴露方法给父组件
defineExpose({
  parseCode,
  insertFunction,
  validateSyntax  // 🔥 新增：暴露验证方法
})
</script>

<style scoped>
.tdx-formula-editor {
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

.tdx-code-editor {
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
  white-space: pre;
  overflow-wrap: normal;
  overflow-x: auto;
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
  white-space: pre;
  overflow-wrap: normal;
  overflow-x: auto;
}

/* 语法高亮样式 */
:deep(.hl-function) {
  color: #0066cc;
  font-weight: 600;
}

:deep(.hl-keyword) {
  color: #9933cc;
  font-weight: 600;
}

:deep(.hl-system) {
  color: #ff6600;
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

:deep(.hl-operator) {
  color: #666666;
  font-weight: 600;
}

.variables-panel {
  border: 1px solid #dcdfe6;
  border-radius: 4px;
  overflow: hidden;
}

.panel-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: #f5f7fa;
  border-bottom: 1px solid #dcdfe6;
  font-size: 14px;
  font-weight: 600;
  color: #606266;
}

.variables-list {
  padding: 12px;
  max-height: 200px;
  overflow-y: auto;
}

.syntax-tips {
  font-size: 12px;
}

.syntax-tips code {
  padding: 2px 6px;
  background: #f5f7fa;
  border-radius: 3px;
  font-family: 'Consolas', 'Monaco', monospace;
  color: #e6a23c;
}

/* 移动端适配 */
@media (max-width: 768px) {
  .editor-toolbar {
    flex-direction: column;
    gap: 8px;
  }
  
  .toolbar-left,
  .toolbar-right {
    width: 100%;
  }
  
  .code-editor-container {
    min-height: 300px;
  }
  
  .tdx-code-editor,
  .syntax-highlight-layer {
    font-size: 12px;
  }
}
</style>

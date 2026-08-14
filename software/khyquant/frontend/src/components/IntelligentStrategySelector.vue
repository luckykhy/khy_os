<template>
  <div class="intelligent-strategy-selector">
    <!-- 智能策略选择器 -->
    <div class="selector-header">
      <div class="header-left">
        <el-icon><MagicStick /></el-icon>
        <span class="title">智能策略适配</span>
      </div>
      <div class="header-right">
        <!-- 🔥 新增：快速选择已有策略 -->
        <el-select
          v-model="selectedExistingStrategyId"
          placeholder="选择已有策略"
          clearable
          filterable
          @change="handleExistingStrategySelect"
          style="width: 200px; margin-right: 10px;"
          size="small"
        >
          <el-option
            v-for="strategy in existingStrategies"
            :key="strategy.id"
            :label="strategy.name"
            :value="strategy.id"
          >
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <span>{{ strategy.name }}</span>
              <el-tag :type="getLanguageColor(strategy.language)" size="small" style="margin-left: 8px;">
                {{ getLanguageLabel(strategy.language) }}
              </el-tag>
            </div>
          </el-option>
        </el-select>
        
        <el-button 
          size="small" 
          type="primary" 
          @click="showStrategyCreator = true"
          :disabled="!currentSymbol"
        >
          <el-icon><Plus /></el-icon>
          创建策略
        </el-button>
      </div>
    </div>

    <!-- 当前适配的策略 -->
    <div v-if="adaptedStrategy" class="adapted-strategy">
      <div class="strategy-card">
        <div class="strategy-info">
          <div class="strategy-name">{{ adaptedStrategy.name }}</div>
          <div class="strategy-meta">
            <el-tag :type="getStrategyTypeColor(adaptedStrategy.type)" size="small">
              {{ getStrategyTypeLabel(adaptedStrategy.type) }}
            </el-tag>
            <el-tag type="info" size="small">{{ getLanguageLabel(adaptedStrategy.language) }}</el-tag>
            <span class="confidence">置信度: {{ (adaptedStrategy.confidence * 100).toFixed(0) }}%</span>
          </div>
          <div class="strategy-description">{{ adaptedStrategy.description }}</div>
          
          <!-- 🔥 新增：参数显示 -->
          <div v-if="adaptedStrategy.parameters && Object.keys(adaptedStrategy.parameters).length > 0" class="strategy-parameters">
            <div class="parameters-title">当前参数:</div>
            <div class="parameters-list">
              <span v-for="(value, key) in adaptedStrategy.parameters" :key="key" class="param-item">
                {{ key }}: {{ value }}
              </span>
            </div>
          </div>
        </div>
        <div class="strategy-actions">
          <el-button size="small" type="success" @click="applyStrategy" :loading="applying">
            应用策略
          </el-button>
          <el-button size="small" type="warning" @click="showParametersDialog">
            <el-icon><Setting /></el-icon>
            参数
          </el-button>
          <el-button size="small" @click="clearStrategy">
            清除
          </el-button>
          <el-button size="small" type="primary" @click="editCurrentStrategy">
            <el-icon><Edit /></el-icon>
            编辑
          </el-button>
        </div>
      </div>
    </div>

    <!-- 智能推荐策略列表 -->
    <div v-else class="strategy-recommendations">
      <div class="recommendations-header">
        <template v-if="showAllStrategies">
          <el-button size="small" text @click="showAllStrategies = false">
            ← 返回推荐
          </el-button>
          <span>全部策略 ({{ allStrategies.length }})</span>
        </template>
        <template v-else>
          <span>为 {{ currentSymbol }} 推荐的策略</span>
          <el-button size="small" text @click="refreshRecommendations" :loading="loadingRecommendations">
            <el-icon><Refresh /></el-icon>
            刷新
          </el-button>
        </template>
      </div>

      <div v-if="loadingRecommendations" class="loading-state">
        <el-skeleton :rows="3" animated />
      </div>

      <div v-else-if="displayedStrategies.length > 0" class="recommendations-list">
        <div
          v-for="strategy in displayedStrategies"
          :key="strategy.id"
          class="recommendation-item"
        >
          <div class="recommendation-content" @click="selectRecommendedStrategy(strategy)">
            <div class="recommendation-info">
              <div class="recommendation-name">{{ strategy.name }}</div>
              <div class="recommendation-meta">
                <el-tag :type="getStrategyTypeColor(strategy.type)" size="small">
                  {{ getStrategyTypeLabel(strategy.type) }}
                </el-tag>
                <span class="match-score" v-if="!showAllStrategies">匹配度: {{ strategy.matchScore }}%</span>
              </div>
              <div class="recommendation-reason">{{ strategy.reason }}</div>
            </div>
            <div class="recommendation-stats" v-if="strategy.stats">
              <div class="stat-item">
                <span class="label">收益:</span>
                <span class="value" :class="getProfitClass(strategy.stats.return)">
                  {{ strategy.stats.return }}%
                </span>
              </div>
              <div class="stat-item">
                <span class="label">胜率:</span>
                <span class="value">{{ strategy.stats.winRate }}%</span>
              </div>
            </div>
          </div>

          <!-- 策略操作按钮 -->
          <div class="recommendation-actions">
            <el-button
              v-if="!isStrategyApplied(strategy)"
              size="small"
              type="success"
              @click.stop="applyRecommendedStrategy(strategy)"
            >
              应用
            </el-button>
            <el-button
              v-else
              size="small"
              type="warning"
              @click.stop="unapplyStrategy(strategy)"
            >
              取消应用
            </el-button>
            <el-button
              size="small"
              type="primary"
              @click.stop="editRecommendedStrategy(strategy)"
            >
              <el-icon><Edit /></el-icon>
              编辑
            </el-button>
          </div>
        </div>

        <!-- View all button -->
        <div class="view-all-btn" v-if="!showAllStrategies && allStrategies.length > recommendedStrategies.length">
          <el-button text type="primary" size="small" @click="showAllStrategies = true">
            查看全部策略 ({{ allStrategies.length }}) →
          </el-button>
        </div>
      </div>

      <div v-else class="empty-recommendations">
        <el-empty description="暂无推荐策略" />
        <el-button type="primary" @click="showStrategyCreator = true">
          创建新策略
        </el-button>
      </div>
    </div>

    <!-- 策略创建/编辑对话框 -->
    <el-dialog
      v-model="showStrategyCreator"
      :title="editingStrategy ? '编辑策略' : '智能策略创建'"
      width="800px"
      :before-close="handleCreatorClose"
    >
      <div class="strategy-creator">
        <!-- 代码输入区域 -->
        <div class="code-input-section">
          <div class="section-header">
            <span class="section-title">策略代码</span>
            <div class="code-actions">
              <el-button 
                size="small" 
                type="primary" 
                @click="analyzeCode"
                :loading="analyzing"
                :disabled="!strategyCode.trim()"
              >
                <el-icon><MagicStick /></el-icon>
                智能分析
              </el-button>
              <el-button 
                size="small" 
                @click="loadTemplate"
              >
                <el-icon><Document /></el-icon>
                加载模板
              </el-button>
            </div>
          </div>
          
          <!-- Code editor — switches based on detected/selected language -->
          <JavaScriptEditor
            v-if="currentEditorLanguage === 'javascript'"
            v-model="strategyCode"
            placeholder="请输入JavaScript策略代码..."
          />
          <PythonEditor
            v-else-if="currentEditorLanguage === 'python'"
            v-model="strategyCode"
            placeholder="请输入Python策略代码..."
          />
          <TdxFormulaEditor
            v-else-if="currentEditorLanguage === 'tdx'"
            v-model="strategyCode"
            placeholder="请输入通达信公式..."
          />
          <el-input
            v-else
            v-model="strategyCode"
            type="textarea"
            :rows="12"
            placeholder="请输入策略代码，系统将自动检测语言和策略类型..."
            class="code-input"
          />
        </div>

        <!-- 智能分析结果 -->
        <div v-if="analysisResult" class="analysis-result">
          <div class="analysis-header">
            <el-icon><SuccessFilled /></el-icon>
            <span>智能分析结果</span>
            <el-tag :type="getConfidenceType(analysisResult.confidence)" size="small">
              置信度: {{ (analysisResult.confidence * 100).toFixed(0) }}%
            </el-tag>
          </div>
          
          <div class="analysis-details">
            <div class="detail-row">
              <span class="label">检测语言:</span>
              <el-tag type="primary" size="small">
                {{ getLanguageLabel(analysisResult.detectedLanguage.language) }}
              </el-tag>
              <span class="confidence-text">
                ({{ (analysisResult.detectedLanguage.confidence * 100).toFixed(0) }}%)
              </span>
            </div>
            
            <div class="detail-row">
              <span class="label">策略类型:</span>
              <el-tag :type="getStrategyTypeColor(analysisResult.detectedType.type)" size="small">
                {{ getStrategyTypeLabel(analysisResult.detectedType.type) }}
              </el-tag>
              <span class="confidence-text">
                ({{ (analysisResult.detectedType.confidence * 100).toFixed(0) }}%)
              </span>
            </div>
            
            <div class="detail-row">
              <span class="label">复杂度:</span>
              <el-tag :type="getComplexityType(analysisResult.complexity)" size="small">
                {{ getComplexityLabel(analysisResult.complexity) }}
              </el-tag>
            </div>
            
            <div v-if="analysisResult.autoConfig.tags.length > 0" class="detail-row">
              <span class="label">特征标签:</span>
              <el-tag 
                v-for="tag in analysisResult.autoConfig.tags" 
                :key="tag" 
                size="small" 
                class="tag-item"
              >
                {{ tag }}
              </el-tag>
            </div>
          </div>

          <!-- 自动配置预览 -->
          <div class="auto-config-preview">
            <div class="preview-title">自动配置预览:</div>
            <div class="config-item">
              <span class="config-label">策略名称:</span>
              <span class="config-value">{{ analysisResult.autoConfig.name }}</span>
            </div>
            <div class="config-item">
              <span class="config-label">策略描述:</span>
              <span class="config-value">{{ analysisResult.autoConfig.description }}</span>
            </div>
            <div v-if="Object.keys(analysisResult.autoConfig.parameters).length > 0" class="config-item">
              <span class="config-label">参数:</span>
              <span class="config-value">{{ JSON.stringify(analysisResult.autoConfig.parameters) }}</span>
            </div>
          </div>

          <!-- 智能建议 -->
          <div v-if="analysisResult.recommendations.length > 0" class="recommendations">
            <div class="recommendations-title">智能建议:</div>
            <div 
              v-for="(rec, index) in analysisResult.recommendations" 
              :key="index"
              class="recommendation"
              :class="rec.type"
            >
              <el-icon v-if="rec.type === 'warning'"><Warning /></el-icon>
              <el-icon v-else-if="rec.type === 'success'"><SuccessFilled /></el-icon>
              <el-icon v-else><InfoFilled /></el-icon>
              <span>{{ rec.message }}</span>
            </div>
          </div>
        </div>

        <!-- 手动配置选项 -->
        <div v-if="!analysisResult || showManualConfig" class="manual-config">
          <div class="config-header">
            <span class="config-title">手动配置</span>
            <el-switch 
              v-model="showManualConfig" 
              active-text="手动配置" 
              inactive-text="智能配置"
            />
          </div>
          
          <el-form :model="manualConfig" label-width="100px" size="small">
            <el-form-item label="策略名称">
              <el-input v-model="manualConfig.name" placeholder="请输入策略名称" />
            </el-form-item>
            
            <el-form-item label="策略类型">
              <el-select v-model="manualConfig.type" placeholder="选择策略类型">
                <el-option label="趋势策略" value="trend" />
                <el-option label="均值回归" value="mean_reversion" />
                <el-option label="动量策略" value="momentum" />
                <el-option label="套利策略" value="arbitrage" />
                <el-option label="做市策略" value="market_making" />
                <el-option label="其他" value="other" />
              </el-select>
            </el-form-item>
            
            <el-form-item label="编程语言">
              <el-select v-model="manualConfig.language" placeholder="选择语言">
                <el-option label="JavaScript" value="javascript" />
                <el-option label="Python" value="python" />
                <el-option label="通达信公式" value="tdx" />
              </el-select>
            </el-form-item>
          </el-form>
        </div>
      </div>

      <template #footer>
        <div class="dialog-footer">
          <el-button @click="showStrategyCreator = false">取消</el-button>
          <el-button 
            type="primary" 
            @click="createIntelligentStrategy" 
            :loading="creating"
            :disabled="!strategyCode.trim()"
          >
            {{ editingStrategy ? '保存策略' : '创建策略' }}
          </el-button>
        </div>
      </template>
    </el-dialog>

    <!-- 🔥 修改：从已有策略加载对话框 -->
    <el-dialog
      v-model="showTemplateSelector"
      title="从已有策略加载"
      width="700px"
    >
      <div v-if="strategyTemplates.length === 0" style="text-align: center; padding: 40px; color: #909399;">
        <el-empty description="暂无可用策略">
          <el-button type="primary" @click="showTemplateSelector = false">
            关闭
          </el-button>
        </el-empty>
      </div>
      <div v-else class="template-list">
        <div 
          v-for="template in strategyTemplates" 
          :key="template.id"
          class="template-item"
          @click="selectTemplate(template)"
        >
          <div class="template-info">
            <div class="template-name">{{ template.name }}</div>
            <div class="template-description">{{ template.description }}</div>
            <div class="template-meta">
              <el-tag type="primary" size="small">{{ getLanguageLabel(template.language) }}</el-tag>
              <el-tag :type="getStrategyTypeColor(template.type)" size="small">
                {{ getStrategyTypeLabel(template.type) }}
              </el-tag>
              <span v-if="template.createdAt" style="margin-left: 8px; color: #909399; font-size: 12px;">
                {{ formatDate(template.createdAt) }}
              </span>
            </div>
          </div>
        </div>
      </div>
    </el-dialog>

    <!-- 🔥 新增：参数设置对话框 -->
    <el-dialog
      v-model="showParametersEditor"
      title="策略参数设置"
      width="600px"
    >
      <div class="parameters-editor">
        <el-alert
          title="提示"
          type="info"
          :closable="false"
          style="margin-bottom: 15px;"
        >
          <template #default>
            <div style="font-size: 12px; line-height: 1.6;">
              <div>• 多箱体策略默认参数：箱段=20, 交易单位=1, 允许损比=0.0667, 初始资金=50000</div>
              <div>• 修改参数后需要重新应用策略才能生效</div>
            </div>
          </template>
        </el-alert>

        <el-form :model="parametersForm" label-width="120px" size="default">
          <el-form-item label="箱段">
            <el-input-number 
              v-model="parametersForm.箱段" 
              :min="5" 
              :max="100" 
              :step="1"
              style="width: 100%;"
            />
            <div class="param-hint">箱体周期，建议 10-30</div>
          </el-form-item>

          <el-form-item label="交易单位">
            <el-input-number 
              v-model="parametersForm.交易单位" 
              :min="1" 
              :max="100" 
              :step="1"
              style="width: 100%;"
            />
            <div class="param-hint">每次交易的基础单位</div>
          </el-form-item>

          <el-form-item label="允许损比">
            <el-input-number 
              v-model="parametersForm.允许损比" 
              :min="0.01" 
              :max="0.5" 
              :step="0.01"
              :precision="4"
              style="width: 100%;"
            />
            <div class="param-hint">凯利公式计算的资金比例，建议 0.05-0.1</div>
          </el-form-item>

          <el-form-item label="初始资金">
            <el-input-number 
              v-model="parametersForm.初始资金" 
              :min="10000" 
              :max="10000000" 
              :step="10000"
              style="width: 100%;"
            />
            <div class="param-hint">初始资金量</div>
          </el-form-item>
        </el-form>

        <div class="parameters-json">
          <div class="json-title">JSON 格式（高级用户）:</div>
          <el-input
            v-model="parametersJsonStr"
            type="textarea"
            :rows="4"
            placeholder='{"箱段": 20, "交易单位": 1, "允许损比": 0.0667, "初始资金": 50000}'
          />
        </div>
      </div>

      <template #footer>
        <div class="dialog-footer">
          <el-button @click="showParametersEditor = false">取消</el-button>
          <el-button @click="resetParameters">重置为默认值</el-button>
          <el-button type="primary" @click="saveParameters">
            保存并应用
          </el-button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
// ---------------------------------------------------------------------------
// IntelligentStrategySelector —— 智能策略适配面板
//
// 架构角色：属于前端交互层，对应论文第4.3节（策略适配层）和第5.2节
//
// 功能说明：
//   这是策略适配层的前端入口。用户可以：
//   1. 从已有策略列表中选择一个策略
//   2. 手动编写策略代码（支持 JavaScript / Python / 通达信公式）
//   3. 系统自动识别语言、判定类型、评估复杂度、生成执行配置
//      （对应论文表13：识别→评估→配置 三段处理）
//   4. 将适配后的策略应用到当前标的，触发回测或实时执行
//
// 设计模式：
//   - 适配器模式（论文图6）：不管什么语言的代码，输出统一的配置对象
//   - 策略模式：执行阶段根据语言分流到不同执行器
//
// Props:
//   currentSymbol {string} — 当前选中的股票代码
//   marketData {Object}    — 当前行情数据
//   externalStrategies {Array} — 外部传入的策略列表
//
// Emits:
//   strategy-selected  — 用户选择了某个策略
//   strategy-applied   — 策略已应用到当前标的
//   signals-generated  — 策略执行产生了交易信号
// ---------------------------------------------------------------------------
// ---- 依赖导入 ----
import { ref, computed, onMounted, watch } from 'vue'
import { ElMessage } from 'element-plus'
import {
  MagicStick, Plus, Refresh, SuccessFilled, Warning, InfoFilled,
  Document, Edit, CopyDocument, Setting
} from '@element-plus/icons-vue'
import { useStrategyStore } from '@/stores/strategyStore'       // Pinia 策略状态仓库
import axios from 'axios'
import request from '@/utils/request'                           // 统一请求封装（带鉴权和拦截器）
import { ensureArray, addArrayWatchGuard, validateApiArrayField } from '@/utils/arrayGuards' // 数组安全守卫
import JavaScriptEditor from '@/components/JavaScriptEditor.vue'  // JS 代码编辑器子组件
import PythonEditor from '@/components/PythonEditor.vue'          // Python 代码编辑器子组件
import TdxFormulaEditor from '@/components/TdxFormulaEditor.vue'  // 通达信公式编辑器子组件
import { executeSandbox } from '@/utils/sandboxExecute'           // 沙箱执行器（在后端 VM 中安全运行策略代码）

// ---- 组件 Props 定义 ----
// 父组件（Trading.vue）向本组件传入的数据
const props = defineProps({
  currentSymbol: {       // 当前用户选择的股票代码，如 "sh600000"
    type: String,
    default: ''
  },
  marketData: {          // 当前标的的实时行情数据
    type: Object,
    default: () => ({})
  },
  externalStrategies: {  // 从外部（如回放模块）传入的额外策略列表
    type: Array,
    default: () => []
  }
})

// ---- 事件定义 ----
// 本组件向父组件抛出的三个关键事件
const emit = defineEmits([
  'strategy-selected',   // 用户选中了某个策略（选择阶段）
  'strategy-applied',    // 策略已被正式应用到当前标的（应用阶段）
  'signals-generated'    // 策略执行后产生了交易信号和辅助线数据（执行结果）
])

// ---- Pinia 状态仓库 ----
// 全局策略状态，多个组件共享同一份策略数据
const strategyStore = useStrategyStore()

// ---- 核心响应式数据 ----
const adaptedStrategy = ref(null)           // 当前被选中/适配后的策略对象（适配器输出）
const recommendedStrategies = ref([])       // 智能推荐的前 N 条策略（展示在推荐面板）
const allStrategies = ref([])               // 全量策略列表（包含所有推荐结果）
const showAllStrategies = ref(false)        // 是否展开全部策略（切换推荐/全量视图）
const loadingRecommendations = ref(false)   // 推荐加载中标志
const applying = ref(false)                 // 策略应用中标志

// ---- 已有策略列表和选择 ----
const existingStrategies = ref([])          // 用户已创建的策略列表（来自数据库 + 外部传入合并去重）
const selectedExistingStrategyId = ref(null) // 当前选中的已有策略 ID
const loadingExistingStrategies = ref(false) // 加载已有策略中标志

// ---- 策略创建/编辑相关 ----
const showStrategyCreator = ref(false)      // 是否显示策略创建/编辑对话框
const strategyCode = ref('')                // 用户输入的策略源代码
const analysisResult = ref(null)            // 后端适配器返回的分析结果（语言识别、类型判定等）
const analyzing = ref(false)                // 正在执行智能分析
const creating = ref(false)                 // 正在创建/更新策略
const showManualConfig = ref(false)         // 是否显示手动配置面板
const editingStrategy = ref(null)           // 当前正在编辑的策略（null 表示新建模式）

// 手动配置表单：当自动分析置信度不足时，用户可手动指定
const manualConfig = ref({
  name: '',
  type: 'trend',
  language: 'javascript'
})

// 当前编辑器使用的语言：优先使用适配器自动识别的语言，其次用户手动选择
// 对应论文公式4 Score(l)=Σ w_f·1(f∈code) 的语言识别结果
const currentEditorLanguage = computed(() => {
  if (analysisResult.value?.detectedLanguage?.language) {
    return analysisResult.value.detectedLanguage.language
  }
  if (showManualConfig.value) {
    return manualConfig.value.language
  }
  return ''
})

// 模板相关
const showTemplateSelector = ref(false)
const strategyTemplates = ref([])

// 展示列表：切换"仅推荐前 N 个"和"全量策略列表"两种视图
const displayedStrategies = computed(() => {
  return showAllStrategies.value ? allStrategies.value : recommendedStrategies.value
})

// ---- 数组安全守卫 ----
// 防止后端返回非数组（如 null/undefined/string）导致 .map() 崩溃
addArrayWatchGuard(recommendedStrategies, 'recommendedStrategies', watch)
addArrayWatchGuard(existingStrategies, 'existingStrategies', watch)
addArrayWatchGuard(allStrategies, 'allStrategies', watch)
addArrayWatchGuard(strategyTemplates, 'strategyTemplates', watch)

// ---- 策略参数编辑器 ----
// 用户可在此调整策略的运行参数（如均线周期、资金量等），调整后重新执行策略
const showParametersEditor = ref(false)
const parametersForm = ref({
  箱段: 20,
  交易单位: 1,
  允许损比: 0.0667,
  初始资金: 50000
})
const parametersJsonStr = ref('')     // 参数的 JSON 文本（支持直接编辑 JSON）

// ---- 计算属性 ----
// 根据股票代码前缀自动判断标的类型（股票/指数/期货），用于推荐评分
const currentInstrumentType = computed(() => {
  if (!props.currentSymbol) return 'stock'
  
  // 根据代码判断工具类型
  if (props.currentSymbol.startsWith('sh000') || props.currentSymbol.startsWith('sz399')) {
    return 'index'
  } else if (props.currentSymbol.includes('IF') || props.currentSymbol.includes('IC')) {
    return 'futures'
  }
  return 'stock'
})

// ---- 监听器（Watchers）----
// 当用户切换标的时，重新加载推荐策略
watch(() => props.currentSymbol, (newSymbol) => {
  if (newSymbol) {
    loadRecommendations()
  }
})

// 当外部策略列表或 store 中的策略发生变化时，重新合并加载已有策略
watch(
  () => [props.externalStrategies, strategyStore.strategies],
  () => {
    loadExistingStrategies()
  },
  { deep: true }
)

// 当全局 store 中的选中策略变更时，同步本组件的选中状态
watch(
  () => strategyStore.selectedStrategy,
  (selected) => {
    if (!selected) {
      selectedExistingStrategyId.value = null
      return
    }

    const normalizedSelectedId = normalizeStrategyId(selected.id)
    const normalizedCurrentId = normalizeStrategyId(selectedExistingStrategyId.value)
    if (normalizedSelectedId && normalizedSelectedId !== normalizedCurrentId) {
      selectedExistingStrategyId.value = selected.id
    }

    const matched = findStrategyById(selected.id, existingStrategies.value)
    if (matched) {
      const sameAsCurrent = normalizeStrategyId(adaptedStrategy.value?.id) === normalizeStrategyId(matched.id)
      adaptedStrategy.value = {
        ...matched,
        confidence: sameAsCurrent ? adaptedStrategy.value.confidence : 1.0,
        matchScore: sameAsCurrent ? adaptedStrategy.value.matchScore : 100,
        reason: sameAsCurrent ? adaptedStrategy.value.reason : '策略列表同步选择'
      }
    }
  },
  { deep: true }
)

// ---- 生命周期钩子 ----
// 组件挂载后：初始化推荐列表、策略模板和已有策略
onMounted(() => {
  if (props.currentSymbol) {
    loadRecommendations()
  }
  loadStrategyTemplates()
  loadExistingStrategies() // 🔥 新增：加载已有策略
})

// ======================================================================
// 核心方法（对应论文第5.2节：策略适配与回测实现）
// ======================================================================

/**
 * loadRecommendations —— 加载智能推荐策略列表
 * 根据当前标的代码，向后端请求推荐策略（或本地评分兜底）
 */
async function loadRecommendations() {
  if (!props.currentSymbol) return
  
  loadingRecommendations.value = true
  try {
    // 模拟智能推荐逻辑
    const recommendations = await generateIntelligentRecommendations()
    // 🔥 使用 ensureArray 确保 recommendations 是数组
    recommendedStrategies.value = ensureArray(recommendations, [], 'recommendations')
  } catch (error) {
    console.error('加载推荐策略失败:', error)
    ElMessage.error('加载推荐策略失败')
    // 🔥 失败时确保使用空数组
    recommendedStrategies.value = []
  } finally {
    loadingRecommendations.value = false
  }
}

/**
 * generateIntelligentRecommendations —— 生成智能推荐（两级策略）
 * 第一级：调用后端 /strategies/recommend 接口，利用真实回测数据排序
 * 第二级（兜底）：后端不可用时，退化为本地类型亲和度评分
 */
async function generateIntelligentRecommendations() {
  // 第一级：尝试后端推荐 API（真实回测 + 可选 AI）
  try {
    const res = await request.post('/strategies/recommend', {
      symbol: props.currentSymbol,
      strategies: [], // empty = let backend load from DB
      useAI: false,   // will be enabled when AI gateway is configured
      limit: 20,
    }, { silentError: true, silentLoading: true, timeout: 10000 })

    if (res.success && Array.isArray(res.data?.recommendations) && res.data.recommendations.length > 0) {
      const recs = res.data.recommendations.map(r => ({
        ...r,
        stats: r.stats ? { return: r.stats.return, winRate: r.stats.winRate } : null,
      }))
      // Deduplicate by normalized name
      const seen = new Set()
      const deduped = []
      for (const r of recs) {
        const key = normalizeNameForDedup(r.name)
        if (seen.has(key)) continue
        seen.add(key)
        deduped.push(r)
      }
      allStrategies.value = deduped
      return deduped.slice(0, 5) // top 5 for recommendation panel
    }
  } catch {
    // API unavailable — fall through to local scoring
  }

  // 2. Fallback: local type-affinity scoring (no real backtest)
  return generateLocalRecommendations()
}

/**
 * generateLocalRecommendations —— 本地兜底推荐
 * 当后端 API 不可用时，根据标的类型（股票/指数/期货）对用户策略做启发式评分
 * 不同标的类型对不同策略类型有不同的亲和度权重
 */
function generateLocalRecommendations() {
  const instrumentType = currentInstrumentType.value
  const recommendations = []
  const typeScoreMap = {
    index:   { trend: 90, momentum: 85, mean_reversion: 70, reversal: 70, arbitrage: 60, market_making: 50 },
    stock:   { mean_reversion: 90, reversal: 90, trend: 85, momentum: 80, arbitrage: 60, market_making: 50 },
    futures: { arbitrage: 90, trend: 85, momentum: 80, mean_reversion: 70, reversal: 70, market_making: 75 },
  }
  const scoreMap = typeScoreMap[instrumentType] || typeScoreMap.stock

  const userStrategies = ensureArray(strategyStore.strategies, [], 'strategyStore.strategies')
  const seenNames = new Set()

  for (const strategy of userStrategies) {
    if (!strategy.code) continue
    const nameKey = normalizeNameForDedup(strategy.name)
    if (seenNames.has(nameKey)) continue
    seenNames.add(nameKey)

    const baseScore = scoreMap[strategy.type] || 65
    const statusBoost = strategy.status === 'active' ? 5 : 0
    const matchScore = Math.min(99, baseScore + statusBoost)

    recommendations.push({
      id: strategy.id,
      name: strategy.name,
      type: strategy.type || 'other',
      language: strategy.language || 'javascript',
      matchScore,
      reason: strategy.description || `${strategy.type || '通用'}策略`,
      stats: strategy.stats || null,
      code: strategy.code,
      parameters: strategy.parameters || {},
      isUserStrategy: true,
    })
  }

  recommendations.sort((a, b) => b.matchScore - a.matchScore)
  allStrategies.value = [...recommendations]
  return recommendations.slice(0, 5)
}

/**
 * selectRecommendedStrategy —— 用户从推荐列表中选择一个策略
 * 将策略信息包装为适配输出对象，同步到 Pinia store，并通知父组件
 */
function selectRecommendedStrategy(strategy) {
  adaptedStrategy.value = {
    ...strategy,
    confidence: strategy.matchScore / 100,
    description: strategy.reason
  }

  selectedExistingStrategyId.value = strategy.id
  strategyStore.selectStrategy(adaptedStrategy.value)

  emit('strategy-selected', adaptedStrategy.value)
  ElMessage.success(`已选择策略: ${strategy.name}`)
}

/** unapplyStrategy —— 取消应用指定策略 */
function unapplyStrategy(strategy) {
  if (adaptedStrategy.value && adaptedStrategy.value.id === strategy.id) {
    clearStrategy()
    ElMessage.info(`已取消应用策略: ${strategy.name}`)
  }
}

/** isStrategyApplied —— 判断某策略是否是当前已应用的策略 */
function isStrategyApplied(strategy) {
  return adaptedStrategy.value && adaptedStrategy.value.id === strategy.id
}

/**
 * applyStrategy —— 应用当前适配后的策略到交易界面
 * 流程：发送 strategy-applied 事件 → 执行策略代码 → 生成交易信号 → 发送 signals-generated 事件
 * 对应论文第5.2节中"适配完成后执行回测"的前端触发入口
 */
async function applyStrategy() {
  if (!adaptedStrategy.value) return

  applying.value = true
  try {
    console.log('🚀 应用策略:', adaptedStrategy.value.name)

    // 应用策略到交易界面
    emit('strategy-applied', adaptedStrategy.value)

    // 生成并传递交易信号
    await generateAndEmitSignals(adaptedStrategy.value)
    
    ElMessage.success(`策略 "${adaptedStrategy.value.name}" 已应用到交易界面`)
  } catch (error) {
    console.error('应用策略失败:', error)
    ElMessage.error('应用策略失败')
  } finally {
    applying.value = false
  }
}

/** applyRecommendedStrategy —— 一键选择并应用推荐策略（选择 + 应用的快捷操作）*/
async function applyRecommendedStrategy(strategy) {
  try {
    console.log('🚀 应用推荐策略:', strategy.name)
    
    // 先选择策略
    selectRecommendedStrategy(strategy)
    
    // 然后应用策略
    setTimeout(async () => {
      await applyStrategy()
    }, 100)
  } catch (error) {
    console.error('应用推荐策略失败:', error)
    ElMessage.error('应用推荐策略失败: ' + error.message)
  }
}

/**
 * generateAndEmitSignals —— 生成并发送交易信号
 * 执行策略代码，获取买卖信号和辅助线（如均线、布林带），
 * 然后通过 signals-generated 事件传递给父组件（图表渲染）
 */
async function generateAndEmitSignals(strategy) {
  try {
    console.log('🔄 生成策略信号:', strategy.name)
    
    // 🔥 修改：executeStrategyForSignals 现在返回 { signals, auxiliaryData }
    const result = await executeStrategyForSignals(strategy)
    
    const signals = result.signals || []
    const auxiliaryData = result.auxiliaryData || {}
    
    if (!signals || signals.length === 0) {
      console.warn('⚠️ 策略没有生成任何信号')
      ElMessage.warning(`策略 "${strategy.name}" 没有生成交易信号`)
      
      // 即使没有信号，也要发送辅助线数据
      if (Object.keys(auxiliaryData).length > 0) {
        console.log('📊 虽然没有信号，但有辅助线数据，仍然发送')
        emit('signals-generated', {
          strategy: strategy,
          signals: [],
          auxiliaryData: auxiliaryData
        })
      }
      return
    }
    
    // 🔥 修改：发送信号和辅助线数据到父组件
    emit('signals-generated', {
      strategy: strategy,
      signals: signals,
      auxiliaryData: auxiliaryData  // 🔥 新增：传递辅助线数据
    })
    
    console.log('✅ 策略信号已生成并发送:', {
      signals: signals.length,
      auxiliaryLines: Object.keys(auxiliaryData).length
    })
    
    // 显示成功消息
    if (Object.keys(auxiliaryData).length > 0) {
      ElMessage.success(`策略 "${strategy.name}" 生成了 ${signals.length} 个交易信号和 ${Object.keys(auxiliaryData).length} 条辅助线`)
    } else {
      ElMessage.success(`策略 "${strategy.name}" 生成了 ${signals.length} 个交易信号`)
    }
    
  } catch (error) {
    console.error('❌ 生成策略信号失败:', error)
    ElMessage.error(`生成策略信号失败: ${error.message}`)
    
    // 即使失败也尝试发送空数据，避免界面卡住
    emit('signals-generated', {
      strategy: strategy,
      signals: [],
      auxiliaryData: {}
    })
  }
}

/**
 * executeStrategyForSignals —— 实际执行策略代码并获取信号
 * 核心执行流程：
 *   1. 生成模拟 K 线数据（或接入真实数据）
 *   2. 通过 executeSandbox() 在后端 VM 沙箱中安全运行策略代码
 *   3. 解析返回结果：新格式 { signals, auxiliaryData } 或旧格式 [signal, ...]
 *   4. 如果代码执行失败，退化为默认信号生成
 * 对应论文第4.3节策略模式：根据语言分流到不同执行器
 */
async function executeStrategyForSignals(strategy) {
  try {
    console.log('🔄 执行策略获取信号:', strategy.name)
    
    // 生成模拟K线数据
    const mockKlineData = generateMockKlineData()
    
    // 🔥 确保 signals 和 auxiliaryData 始终初始化为正确的类型
    let signals = []
    let auxiliaryData = {}
    
    // 如果策略有代码，尝试执行实际的策略代码
    if (strategy.code) {
      try {
        console.log('📊 执行实际策略代码:', strategy.name)

        // 执行策略 - 使用策略的参数或默认参数
        const params = strategy.parameters || {
          箱段: 20,
          交易单位: 1,
          允许损比: 1/15,
          初始资金: 50000
        }

        // Execute via backend vm sandbox
        const strategyResults = await executeSandbox({
          code: strategy.code,
          klineData: mockKlineData,
          parameters: params,
          language: strategy.language || 'javascript'
        })
        
        console.log('📊 策略执行结果类型:', typeof strategyResults, Array.isArray(strategyResults) ? '数组' : '对象')
        
        // 🔥 关键修复:处理新旧两种返回格式
        if (strategyResults && typeof strategyResults === 'object' && !Array.isArray(strategyResults)) {
          // 新格式：{ signals, auxiliaryData }
          console.log('✅ 检测到新格式（对象）')
          
          // 🔥 确保 signals 是数组
          const rawSignals = Array.isArray(strategyResults.signals) ? strategyResults.signals : []
          
          signals = rawSignals
            .filter(s => s && (s.type === 'buy' || s.type === 'sell'))
            .map((signal, index) => ({
              id: `strategy-signal-${signal.index || index}`,
              type: signal.type,
              index: signal.index || index,
              price: signal.price,
              time: signal.time || mockKlineData[signal.index]?.time || Date.now(), // 🔥 使用秒级时间戳
              timestamp: (signal.time || mockKlineData[signal.index]?.time || Date.now()) * 1000, // 🔥 毫秒时间戳用于显示
              reason: signal.reason || `${strategy.name} - ${signal.type === 'buy' ? '买入' : '卖出'}信号`
            }))
          
          // 🔥 提取辅助线数据
          auxiliaryData = strategyResults.auxiliaryData || {}
          
          console.log('✅ 新格式解析成功:', {
            signals: signals.length,
            auxiliaryLines: Object.keys(auxiliaryData).length,
            auxiliaryLineNames: Object.keys(auxiliaryData)
          })
          
          // 🔥 调试：检查辅助线数据的详细信息
          if (Object.keys(auxiliaryData).length > 0) {
            Object.keys(auxiliaryData).forEach(lineName => {
              const lineData = auxiliaryData[lineName]
              console.log(`📊 辅助线 "${lineName}":`, {
                dataPoints: lineData.data?.length || 0,
                firstPoint: lineData.data?.[0],
                lastPoint: lineData.data?.[lineData.data.length - 1]
              })
            })
          }
        } else if (Array.isArray(strategyResults)) {
          // 旧格式：直接返回信号数组
          console.log('⚠️ 检测到旧格式（数组）')
          signals = strategyResults
            .filter(s => s && (s.type === 'buy' || s.type === 'sell'))
            .map((signal, index) => ({
              id: `strategy-signal-${signal.index || index}`,
              type: signal.type,
              index: signal.index || index,
              price: signal.price,
              time: mockKlineData[signal.index]?.time || Date.now(), // 🔥 使用秒级时间戳
              timestamp: (mockKlineData[signal.index]?.time || Date.now()) * 1000, // 🔥 毫秒时间戳用于显示
              reason: signal.reason || `${strategy.name} - ${signal.type === 'buy' ? '买入' : '卖出'}信号`
            }))
          
          auxiliaryData = {}
          console.log('⚠️ 旧格式不包含辅助线数据')
        } else {
          // 🔥 未知格式，使用空数组
          console.warn('⚠️ 策略返回了未知格式，使用空信号数组')
          signals = []
          auxiliaryData = {}
        }
        
        console.log('✅ 策略代码执行成功，生成信号:', signals.length, '个，辅助线:', Object.keys(auxiliaryData).length, '条')
        
        // 🔥 新增：详细检查辅助线数据
        if (Object.keys(auxiliaryData).length > 0) {
          console.error('🔍🔍🔍 详细检查辅助线数据 🔍🔍🔍')  // 使用 error 确保显眼
          Object.keys(auxiliaryData).forEach(lineName => {
            const lineData = auxiliaryData[lineName]
            console.error(`  📊 ${lineName}:`)
            console.error(`    - name: ${lineData.name}`)
            console.error(`    - color: ${lineData.color}`)
            console.error(`    - data 类型: ${typeof lineData.data}`)
            console.error(`    - data 是数组: ${Array.isArray(lineData.data)}`)
            console.error(`    - data 长度: ${lineData.data?.length || 0}`)
            
            if (lineData.data && lineData.data.length > 0) {
              console.error(`    - 第一个数据点:`, lineData.data[0])
              console.error(`    - 最后一个数据点:`, lineData.data[lineData.data.length - 1])
            } else {
              console.error(`    ❌❌❌ data 数组为空！`)
            }
          })
        } else {
          console.error('❌❌❌ 没有辅助线数据！')
        }
        
      } catch (codeError) {
        console.warn('⚠️ 策略代码执行失败，使用默认信号生成:', codeError.message)
        signals = generateDefaultSignals(strategy, mockKlineData)
        auxiliaryData = {}
      }
    } else {
      // 使用默认信号生成
      signals = generateDefaultSignals(strategy, mockKlineData)
      auxiliaryData = {}
    }
    
    console.log('✅ 策略信号生成成功:', signals.length, '个信号，', Object.keys(auxiliaryData).length, '条辅助线')
    console.log('📍 信号详情:', Array.isArray(signals) ? signals.slice(0, 3).map(s => ({
      type: s.type,
      index: s.index,
      time: new Date(s.time).toLocaleDateString(),
      price: s.price
    })) : [])
    
    if (Object.keys(auxiliaryData).length > 0) {
      console.log('📍 辅助线详情:', Object.keys(auxiliaryData).map(key => ({
        name: key,
        dataPoints: auxiliaryData[key]?.data?.length || 0
      })))
    }
    
    // 🔥 返回包含辅助线数据的对象
    return {
      signals,
      auxiliaryData
    }
    
  } catch (error) {
    console.error('❌ 执行策略获取信号失败:', error)
    throw error
  }
}

/**
 * generateDefaultSignals —— 生成默认信号（兜底）
 * 当策略代码执行失败或没有代码时，根据策略类型生成均匀分布的模拟买卖信号
 */
function generateDefaultSignals(strategy, mockKlineData) {
  const signals = []
  
  // 确保信号分布在K线数据的有效范围内
  const validIndexes = []
  const startIndex = Math.max(5, Math.floor(mockKlineData.length * 0.1)) // 从10%位置开始
  const endIndex = Math.min(mockKlineData.length - 5, Math.floor(mockKlineData.length * 0.9)) // 到90%位置结束
  
  if (strategy.type === 'trend') {
    // 趋势策略信号 - 分布更均匀
    const signalCount = 6
    for (let i = 0; i < signalCount; i++) {
      const index = startIndex + Math.floor((endIndex - startIndex) * i / (signalCount - 1))
      validIndexes.push(index)
    }
  } else if (strategy.type === 'momentum') {
    // 动量策略信号
    const signalCount = 5
    for (let i = 0; i < signalCount; i++) {
      const index = startIndex + Math.floor((endIndex - startIndex) * i / (signalCount - 1))
      validIndexes.push(index)
    }
  } else {
    // 默认信号生成
    const signalCount = 8
    for (let i = 0; i < signalCount; i++) {
      const index = startIndex + Math.floor((endIndex - startIndex) * i / (signalCount - 1))
      validIndexes.push(index)
    }
  }
  
  // 为每个有效索引生成信号
  validIndexes.forEach((index, i) => {
    const klineItem = mockKlineData[index]
    const signalType = i % 2 === 0 ? 'buy' : 'sell'
    
    signals.push({
      id: `signal-${index}`,
      type: signalType,
      index: index,
      price: klineItem.close,
      time: klineItem.time, // 使用K线的确切时间
      timestamp: klineItem.time,
      reason: `${strategy.name} - ${signalType === 'buy' ? '买入' : '卖出'}信号 (第${index}根K线)`
    })
  })
  
  return signals
}

/**
 * generateMockKlineData —— 生成模拟 K 线数据
 * 生成 60 根日 K 线（秒级时间戳），用于本地策略执行
 * 时间戳格式与 lightweight-charts 图表库兼容
 */
function generateMockKlineData() {
  const data = []
  // 🔥 关键修复：使用与 SimpleTradingInterface 相同的基础价格
  // 这样策略计算的辅助线价格范围就会与图表K线一致
  let basePrice = 10  // 🔥 改为10，与图表显示一致
  const now = Math.floor(Date.now() / 1000) // 🔥 修复：使用秒级时间戳，与测试页面一致
  
  // 🔥 生成更多数据点以匹配图表（60根K线）
  for (let i = 0; i < 60; i++) {
    const time = now - (60 - i) * 24 * 60 * 60 // 🔥 修复：秒级时间戳（不是毫秒）
    const change = (Math.random() - 0.5) * 0.4  // 🔥 调整波动率以匹配基础价格10
    const open = basePrice
    const close = open + change
    const high = Math.max(open, close) + Math.random() * 0.2
    const low = Math.min(open, close) - Math.random() * 0.2
    
    data.push({
      time: time, // 🔥 秒级时间戳，用于图表显示
      timestamp: time, // 🔥 秒级时间戳
      index: i, // 添加索引
      open: parseFloat(open.toFixed(2)),
      high: parseFloat(high.toFixed(2)),
      low: parseFloat(low.toFixed(2)),
      close: parseFloat(close.toFixed(2))
    })
    
    basePrice = close
  }
  
  console.log('📊 生成K线数据:', data.length, '条，时间范围:', new Date(data[0].time * 1000).toLocaleDateString(), '到', new Date(data[data.length-1].time * 1000).toLocaleDateString())
  console.log('📊 价格范围:', Math.min(...data.map(d => d.low)).toFixed(2), '-', Math.max(...data.map(d => d.high)).toFixed(2))
  console.log('📊 时间格式: 秒级时间戳 (与 lightweight-charts 兼容)')
  return data
}

/** clearStrategy —— 清空当前选中的策略，重置所有选择状态 */
function clearStrategy() {
  adaptedStrategy.value = null
  selectedExistingStrategyId.value = null
  strategyStore.selectStrategy(null)
  emit('strategy-selected', null)
}

/** refreshRecommendations —— 刷新推荐列表（用户点击刷新按钮触发）*/
function refreshRecommendations() {
  loadRecommendations()
}

// ======================================================================
// 策略创建与智能分析（对应论文第4.3节：适配器三段处理）
// IntelligentStrategyAdapter: detectLanguage() → detectType() → assessComplexity() → autoConfig()
// ======================================================================

/**
 * analyzeCode —— 智能分析策略代码（调用后端适配器 API）
 * 将用户输入的策略代码发送到后端 /api/strategy/analyze 接口，
 * 后端执行适配器三段处理：
 *   1. detectLanguage() — 语言识别（论文公式4: Score(l)=Σ w_f·1(f∈code)）
 *   2. detectType()     — 策略类型判定（趋势/动量/均值回归等）
 *   3. assessComplexity() + autoConfig() — 复杂度评估并自动生成执行配置
 * 如果分析置信度 > 0.7，自动应用配置；否则提示用户手动确认
 */
async function analyzeCode() {
  if (!strategyCode.value.trim()) {
    ElMessage.warning('请先输入策略代码')
    return
  }

  analyzing.value = true
  try {
    const response = await request.post('/api/strategy/analyze', {
      code: strategyCode.value,
      name: manualConfig.value.name,
      description: ''
    })

    if (response.success) {
      analysisResult.value = response.data.analysis
      
      // 如果置信度高，自动应用配置
      if (analysisResult.value.confidence > 0.7) {
        showManualConfig.value = false
        ElMessage.success('智能分析完成，已自动配置')
      } else {
        ElMessage.info('智能分析完成，建议手动确认配置')
      }
    } else {
      throw new Error(response.message || 'Analysis failed')
    }
  } catch (error) {
    console.error('智能分析失败:', error)
    ElMessage.error('智能分析失败: ' + error.message)
  } finally {
    analyzing.value = false
  }
}

/**
 * createIntelligentStrategy —— 创建或更新策略
 * 根据分析结果（智能配置）或手动配置，调用 strategyStore 持久化策略
 * 创建成功后自动选中新策略并通知父组件
 */
async function createIntelligentStrategy() {
  creating.value = true
  try {
    let strategyConfig
    
    if (analysisResult.value && !showManualConfig.value) {
      // 使用智能配置
      strategyConfig = {
        ...analysisResult.value.autoConfig,
        code: strategyCode.value
      }
    } else {
      // 使用手动配置
      strategyConfig = {
        name: manualConfig.value.name || '自定义策略',
        type: manualConfig.value.type,
        language: manualConfig.value.language,
        code: strategyCode.value,
        description: editingStrategy.value ? editingStrategy.value.description : '手动创建的策略',
        parameters: editingStrategy.value ? editingStrategy.value.parameters : {}
      }
    }
    
    let newStrategy
    if (editingStrategy.value) {
      // 更新现有策略
      newStrategy = await strategyStore.updateStrategy(editingStrategy.value.id, strategyConfig)
      ElMessage.success(`策略 "${strategyConfig.name}" 更新成功`)
    } else {
      // 创建新策略
      newStrategy = await strategyStore.createStrategy(strategyConfig)
      ElMessage.success(`策略 "${strategyConfig.name}" 创建成功`)
    }
    
    // 自动选择新创建/更新的策略
    adaptedStrategy.value = {
      ...newStrategy,
      confidence: analysisResult.value?.confidence || 0.8,
      matchScore: 95,
      reason: editingStrategy.value ? '已更新的策略' : '新创建的策略'
    }

    selectedExistingStrategyId.value = newStrategy.id
    strategyStore.selectStrategy(adaptedStrategy.value)
    
    showStrategyCreator.value = false
    resetCreatorForm()
    
    emit('strategy-selected', adaptedStrategy.value)
    
  } catch (error) {
    console.error(editingStrategy.value ? '更新策略失败:' : '创建策略失败:', error)
    ElMessage.error((editingStrategy.value ? '更新策略失败: ' : '创建策略失败: ') + error.message)
  } finally {
    creating.value = false
  }
}

/**
 * loadStrategyTemplates —— 加载用户已创建的策略作为代码模板
 * 用户新建策略时可从模板列表中选择，快速填充代码
 */
async function loadStrategyTemplates() {
  try {
    console.log('📋 加载用户策略作为模板...')
    
    // 从 strategyStore 加载用户创建的策略
    if (strategyStore.strategies.length === 0) {
      await strategyStore.loadStrategies()
    }
    
    // 将用户策略转换为模板格式
    strategyTemplates.value = strategyStore.strategies.map(strategy => ({
      id: strategy.id,
      name: strategy.name,
      description: strategy.description || '暂无描述',
      code: strategy.code,
      type: strategy.type || 'trend',
      language: strategy.language || 'javascript',
      createdAt: strategy.createdAt,
      parameters: strategy.parameters || {}
    }))
    
    console.log('✅ 已加载用户策略作为模板:', strategyTemplates.value.length, '个')
  } catch (error) {
    console.error('❌ 加载策略模板失败:', error)
    ElMessage.error('加载策略失败: ' + error.message)
  }
}

/** normalizeExistingStrategy —— 将不同来源的策略对象统一为标准格式（适配器模式的体现）*/
function normalizeExistingStrategy(strategy) {
  if (!strategy || typeof strategy !== 'object') return null
  return {
    id: strategy.id,
    name: strategy.name || 'Unnamed Strategy',
    description: strategy.description || '暂无描述',
    code: strategy.code || '',
    type: strategy.type || 'trend',
    language: strategy.language || 'javascript',
    parameters: strategy.parameters || {},
    createdAt: strategy.createdAt || strategy.updatedAt
  }
}

/** normalizeStrategyId —— 将策略 ID 统一转为字符串，方便比较 */
function normalizeStrategyId(strategyId) {
  if (strategyId === null || strategyId === undefined || strategyId === '') return null
  return String(strategyId)
}

/** findStrategyById —— 在策略列表中按 ID 查找策略 */
function findStrategyById(strategyId, source = []) {
  const normalizedTargetId = normalizeStrategyId(strategyId)
  if (!normalizedTargetId) return null
  const list = Array.isArray(source) ? source : []
  return list.find(item => normalizeStrategyId(item?.id) === normalizedTargetId) || null
}

// 中英文策略名映射表，用于去重（同一策略可能有中文名和英文名）
const NAME_ALIASES = {
  'rsi反转策略': 'rsi reversal', 'rsi反转': 'rsi reversal',
  'macd动量策略': 'macd momentum', 'macd动量': 'macd momentum',
  '均线交叉': 'ma crossover', '指数趋势跟踪': 'ma crossover',
  '突破趋势策略': 'trend breakout', '期货价差套利策略': 'futures spread',
  'rsi均值回归策略': 'rsi mean reversion', 'rsi超买超卖策略': 'rsi mean reversion',
}

/** normalizeNameForDedup —— 将策略名称标准化以便去重（去除空格/符号，转小写，查别名表）*/
function normalizeNameForDedup(name) {
  if (!name) return ''
  const lower = name.toLowerCase().replace(/[\s\-_（）()]/g, '')
  return NAME_ALIASES[lower] || lower
}

/**
 * mergeStrategySources —— 合并多个策略来源并去重
 * 先按 ID 去重，再按标准化名称去重，确保列表中没有重复策略
 */
function mergeStrategySources(...sources) {
  const merged = []
  const seenIds = new Set()
  const seenNames = new Set()

  for (const source of sources) {
    const list = Array.isArray(source) ? source : []
    for (const item of list) {
      const normalized = normalizeExistingStrategy(item)
      if (!normalized) continue

      // Dedup by id first
      const idKey = normalized.id !== undefined && normalized.id !== null ? `id:${normalized.id}` : null
      if (idKey && seenIds.has(idKey)) continue

      // Dedup by normalized name
      const nameKey = normalizeNameForDedup(normalized.name)
      if (nameKey && seenNames.has(nameKey)) continue

      if (idKey) seenIds.add(idKey)
      if (nameKey) seenNames.add(nameKey)
      merged.push(normalized)
    }
  }

  return merged
}

/**
 * loadExistingStrategies —— 加载用户已有的策略列表
 * 合并 Pinia store 中的策略和父组件传入的外部策略，统一去重后展示
 * 如果 store 为空，会先触发一次从后端加载
 */
async function loadExistingStrategies() {
  loadingExistingStrategies.value = true
  try {
    console.log('📋 加载已有策略列表...')
    
    // 从 strategyStore 加载用户创建的策略
    if (strategyStore.strategies.length === 0) {
      await strategyStore.loadStrategies()
    }
    
    const storeStrategies = ensureArray(strategyStore.strategies, [], 'strategyStore.strategies')
    const replayAndExternal = ensureArray(props.externalStrategies, [], 'externalStrategies')

    existingStrategies.value = mergeStrategySources(storeStrategies, replayAndExternal)

    if (strategyStore.selectedStrategy) {
      const selected = findStrategyById(strategyStore.selectedStrategy.id, existingStrategies.value)
      if (selected) {
        selectedExistingStrategyId.value = selected.id
      }
    }
    
    console.log('✅ 已加载已有策略:', existingStrategies.value.length, '个')
  } catch (error) {
    console.error('❌ 加载已有策略失败:', error)
    ElMessage.error('加载策略列表失败: ' + error.message)
    // 🔥 失败时确保使用空数组
    existingStrategies.value = []
  } finally {
    loadingExistingStrategies.value = false
  }
}

/**
 * handleExistingStrategySelect —— 处理用户从下拉列表中选择已有策略
 * 流程：查找策略 → 包装为适配输出 → 同步 store → 通知父组件 → 自动应用
 * 置信度设为 1.0（用户主动选择，无需评估）
 */
async function handleExistingStrategySelect(strategyId) {
  if (!strategyId) {
    // 清空选择
    strategyStore.selectStrategy(null)
    adaptedStrategy.value = null
    emit('strategy-selected', null)
    return
  }
  
  try {
    // 🔥 使用 ensureArray 确保 existingStrategies.value 是数组
    const strategies = ensureArray(existingStrategies.value, [], 'existingStrategies')
    const strategy = findStrategyById(strategyId, strategies)
    if (!strategy) {
      ElMessage.error('策略不存在')
      return
    }
    
    console.log('⚡ 选择已有策略:', strategy.name)
    
    // 设置为当前适配策略
    adaptedStrategy.value = {
      ...strategy,
      confidence: 1.0, // 用户主动选择，置信度100%
      matchScore: 100,
      reason: '用户手动选择'
    }

    strategyStore.selectStrategy(adaptedStrategy.value)
    
    // 发送策略选择事件
    emit('strategy-selected', adaptedStrategy.value)
    
    // 自动应用策略
    ElMessage.success(`已选择策略: ${strategy.name}，正在应用...`)
    
    // 延迟一下再应用，让用户看到选择成功的提示
    setTimeout(async () => {
      await applyStrategy()
    }, 300)
    
  } catch (error) {
    console.error('❌ 选择策略失败:', error)
    ElMessage.error('选择策略失败: ' + error.message)
  }
}

/** loadTemplate —— 打开模板选择器对话框 */
function loadTemplate() {
  showTemplateSelector.value = true
}

/** selectTemplate —— 用户选择了某个模板，将模板代码和配置填入表单 */
function selectTemplate(template) {
  strategyCode.value = template.code
  manualConfig.value.name = template.name
  manualConfig.value.type = template.type || 'trend'
  manualConfig.value.language = template.language || 'javascript'
  
  showTemplateSelector.value = false
  ElMessage.success('模板已加载')
}

// ---- 策略编辑方法 ----
/** editCurrentStrategy —— 编辑当前已选中的策略（进入编辑模式，打开代码编辑器）*/
function editCurrentStrategy() {
  if (!adaptedStrategy.value) {
    ElMessage.warning('请先选择一个策略')
    return
  }
  
  console.log('编辑策略:', adaptedStrategy.value)
  
  // 设置编辑模式
  editingStrategy.value = { ...adaptedStrategy.value }
  
  // 填充表单数据 - 重要：加载策略的实际代码
  strategyCode.value = adaptedStrategy.value.code || getDefaultStrategyCode(adaptedStrategy.value.type, adaptedStrategy.value.language)
  manualConfig.value = {
    name: adaptedStrategy.value.name,
    type: adaptedStrategy.value.type || 'trend',
    language: adaptedStrategy.value.language || 'javascript'
  }
  
  // 清除分析结果，因为我们要编辑现有策略
  analysisResult.value = null
  showManualConfig.value = true // 编辑时显示手动配置
  
  // 显示编辑对话框
  showStrategyCreator.value = true
  
  ElMessage.info(`正在编辑策略: ${adaptedStrategy.value.name}`)
}

/** editRecommendedStrategy —— 编辑推荐列表中的某个策略 */
function editRecommendedStrategy(strategy) {
  console.log('编辑推荐策略:', strategy)
  
  // 设置编辑模式
  editingStrategy.value = { ...strategy }
  
  // 填充表单数据 - 重要：加载策略的实际代码
  strategyCode.value = strategy.code || getDefaultStrategyCode(strategy.type, strategy.language)
  manualConfig.value = {
    name: strategy.name,
    type: strategy.type || 'trend',
    language: strategy.language || 'javascript'
  }
  
  // 清除分析结果，显示手动配置以便编辑
  analysisResult.value = null
  showManualConfig.value = true
  
  // 显示编辑对话框
  showStrategyCreator.value = true
  
  ElMessage.info(`正在编辑策略: ${strategy.name}`)
}

/**
 * getDefaultStrategyCode —— 获取默认策略代码模板
 * 根据策略类型和编程语言返回预置的代码骨架，帮助用户快速上手
 */
function getDefaultStrategyCode(type, language) {
  const templates = {
    javascript: {
      trend: `// 趋势策略 - JavaScript
function strategy(data, params) {
  const signals = [];
  const maPeriod = params.maPeriod || 20;
  
  // 计算移动平均线
  for (let i = maPeriod; i < data.length; i++) {
    const ma = data.slice(i - maPeriod, i).reduce((sum, candle) => sum + candle.close, 0) / maPeriod;
    const currentPrice = data[i].close;
    
    if (currentPrice > ma * 1.02) {
      signals.push({
        type: 'buy',
        index: i,
        price: currentPrice,
        reason: '价格突破均线'
      });
    } else if (currentPrice < ma * 0.98) {
      signals.push({
        type: 'sell',
        index: i,
        price: currentPrice,
        reason: '价格跌破均线'
      });
    } else {
      signals.push({type: 'hold', index: i});
    }
  }
  
  return signals;
}`,
      momentum: `// 动量策略 - JavaScript
function strategy(data, params) {
  const signals = [];
  const period = params.period || 14;
  
  for (let i = period; i < data.length; i++) {
    const currentPrice = data[i].close;
    const pastPrice = data[i - period].close;
    const momentum = (currentPrice - pastPrice) / pastPrice;
    
    if (momentum > 0.05) {
      signals.push({
        type: 'buy',
        index: i,
        price: currentPrice,
        reason: '强势动量买入'
      });
    } else if (momentum < -0.05) {
      signals.push({
        type: 'sell',
        index: i,
        price: currentPrice,
        reason: '弱势动量卖出'
      });
    } else {
      signals.push({type: 'hold', index: i});
    }
  }
  
  return signals;
}`
    },
    python: {
      trend: `# 趋势策略 - Python
def strategy(data, params):
    signals = []
    ma_period = params.get('maPeriod', 20)
    
    for i in range(ma_period, len(data)):
        ma = sum(candle['close'] for candle in data[i-ma_period:i]) / ma_period
        current_price = data[i]['close']
        
        if current_price > ma * 1.02:
            signals.append({
                'type': 'buy',
                'index': i,
                'price': current_price,
                'reason': '价格突破均线'
            })
        elif current_price < ma * 0.98:
            signals.append({
                'type': 'sell',
                'index': i,
                'price': current_price,
                'reason': '价格跌破均线'
            })
        else:
            signals.append({'type': 'hold', 'index': i})
    
    return signals`,
      momentum: `# 动量策略 - Python
def strategy(data, params):
    signals = []
    period = params.get('period', 14)
    
    for i in range(period, len(data)):
        current_price = data[i]['close']
        past_price = data[i - period]['close']
        momentum = (current_price - past_price) / past_price
        
        if momentum > 0.05:
            signals.append({
                'type': 'buy',
                'index': i,
                'price': current_price,
                'reason': '强势动量买入'
            })
        elif momentum < -0.05:
            signals.append({
                'type': 'sell',
                'index': i,
                'price': current_price,
                'reason': '弱势动量卖出'
            })
        else:
            signals.append({'type': 'hold', 'index': i})
    
    return signals`
    }
  }
  
  return templates[language]?.[type] || templates.javascript?.trend || ''
}

/** resetCreatorForm —— 重置策略创建表单到初始状态 */
function resetCreatorForm() {
  strategyCode.value = ''
  analysisResult.value = null
  showManualConfig.value = false
  editingStrategy.value = null // 重置编辑状态
  manualConfig.value = {
    name: '',
    type: 'trend',
    language: 'javascript'
  }
}

/** handleCreatorClose —— 关闭策略创建/编辑对话框并清空表单 */
function handleCreatorClose() {
  showStrategyCreator.value = false
  resetCreatorForm()
}

// ======================================================================
// UI 辅助方法 —— 颜色、标签、格式化等纯展示逻辑
// ======================================================================

/** getStrategyTypeColor —— 根据策略类型返回 Element Plus 标签颜色 */
function getStrategyTypeColor(type) {
  const colors = {
    trend: 'success',
    mean_reversion: 'warning',
    momentum: 'primary',
    arbitrage: 'info',
    market_making: 'danger',
    other: 'default'
  }
  return colors[type] || 'default'
}

/** getStrategyTypeLabel —— 将策略类型英文 key 转为中文标签 */
function getStrategyTypeLabel(type) {
  const labels = {
    trend: '趋势策略',
    mean_reversion: '均值回归',
    momentum: '动量策略',
    arbitrage: '套利策略',
    market_making: '做市策略',
    other: '其他'
  }
  return labels[type] || type
}

/** getLanguageLabel —— 将编程语言 key 转为展示名称 */
function getLanguageLabel(language) {
  const labels = {
    javascript: 'JavaScript',
    python: 'Python'
  }
  return labels[language] || language
}

/** getLanguageColor —— 根据编程语言返回标签颜色 */
function getLanguageColor(language) {
  const colors = {
    javascript: 'warning',
    python: 'success'
  }
  return colors[language] || 'info'
}

/** getComplexityType —— 根据复杂度级别返回颜色标识（simple=绿/intermediate=黄/advanced=红）*/
function getComplexityType(complexity) {
  const types = {
    simple: 'success',
    intermediate: 'warning',
    advanced: 'danger'
  }
  return types[complexity] || 'info'
}

/** getComplexityLabel —— 将复杂度英文 key 转为中文标签 */
function getComplexityLabel(complexity) {
  const labels = {
    simple: '简单',
    intermediate: '中等',
    advanced: '高级'
  }
  return labels[complexity] || complexity
}

/** getConfidenceType —— 根据置信度返回颜色（>=0.8绿色/>=0.6黄色/其他红色）*/
function getConfidenceType(confidence) {
  if (confidence >= 0.8) return 'success'
  if (confidence >= 0.6) return 'warning'
  return 'danger'
}

/** getProfitClass —— 根据盈亏值返回 CSS 类名（正值绿色/负值红色/零灰色）*/
function getProfitClass(profit) {
  if (profit > 0) return 'profit-positive'
  if (profit < 0) return 'profit-negative'
  return 'profit-neutral'
}

/** formatDate —— 将日期对象格式化为 YYYY-MM-DD 字符串 */
function formatDate(date) {
  if (!date) return '-'
  const d = new Date(date)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * showParametersDialog —— 打开策略参数编辑对话框
 * 加载当前已选策略的参数，用户可在此调整后重新执行策略
 */
function showParametersDialog() {
  if (!adaptedStrategy.value) {
    ElMessage.warning('请先选择一个策略')
    return
  }
  
  // 加载当前策略的参数
  const currentParams = adaptedStrategy.value.parameters || {}
  
  // 设置默认参数
  parametersForm.value = {
    箱段: currentParams.箱段 || 20,
    交易单位: currentParams.交易单位 || 1,
    允许损比: currentParams.允许损比 || 0.0667,
    初始资金: currentParams.初始资金 || 50000
  }
  
  // 更新 JSON 字符串
  parametersJsonStr.value = JSON.stringify(parametersForm.value, null, 2)
  
  showParametersEditor.value = true
  
  console.log('📝 打开参数编辑器，当前参数:', parametersForm.value)
}

/**
 * saveParameters —— 保存修改后的策略参数
 * 支持两种输入方式：表单字段和 JSON 文本，保存后自动重新应用策略
 */
async function saveParameters() {
  try {
    // 尝试从 JSON 字符串解析参数
    let newParams
    try {
      newParams = JSON.parse(parametersJsonStr.value)
    } catch (jsonError) {
      // 如果 JSON 解析失败，使用表单数据
      newParams = { ...parametersForm.value }
    }
    
    // 验证参数
    if (!newParams.箱段 || newParams.箱段 < 5 || newParams.箱段 > 100) {
      ElMessage.error('箱段参数无效，应在 5-100 之间')
      return
    }
    
    // 更新策略参数
    adaptedStrategy.value.parameters = newParams
    
    console.log('✅ 参数已更新:', newParams)
    
    // 关闭对话框
    showParametersEditor.value = false
    
    // 提示用户重新应用策略
    ElMessage.success('参数已保存，请点击"应用策略"按钮使参数生效')
    
    // 如果策略已经应用，自动重新应用
    if (applying.value === false) {
      setTimeout(() => {
        applyStrategy()
      }, 500)
    }
    
  } catch (error) {
    console.error('❌ 保存参数失败:', error)
    ElMessage.error('保存参数失败: ' + error.message)
  }
}

/** resetParameters —— 将策略参数重置为默认值 */
function resetParameters() {
  parametersForm.value = {
    箱段: 20,
    交易单位: 1,
    允许损比: 0.0667,
    初始资金: 50000
  }
  
  parametersJsonStr.value = JSON.stringify(parametersForm.value, null, 2)
  
  ElMessage.info('参数已重置为默认值')
}

// 参数表单和 JSON 文本的双向同步：表单改动 → 更新 JSON 文本
watch(parametersForm, (newValue) => {
  try {
    parametersJsonStr.value = JSON.stringify(newValue, null, 2)
  } catch (error) {
    console.warn('更新 JSON 字符串失败:', error)
  }
}, { deep: true })

// 参数双向同步：JSON 文本改动 → 更新表单字段
watch(parametersJsonStr, (newValue) => {
  try {
    const parsed = JSON.parse(newValue)
    if (parsed.箱段) parametersForm.value.箱段 = parsed.箱段
    if (parsed.交易单位) parametersForm.value.交易单位 = parsed.交易单位
    if (parsed.允许损比) parametersForm.value.允许损比 = parsed.允许损比
    if (parsed.初始资金) parametersForm.value.初始资金 = parsed.初始资金
  } catch (error) {
    // JSON 解析失败，忽略
  }
})

</script>

<style scoped>
.intelligent-strategy-selector {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: #111;
  color: #fff;
}

.selector-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 15px;
  border-bottom: 1px solid #333;
  background: linear-gradient(to bottom, #2a2a2a, #1a1a1a);
}

.header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.title {
  font-weight: bold;
  color: #00aaff;
  font-size: 14px;
}

/* 适配策略卡片 */
.adapted-strategy {
  padding: 15px;
}

.strategy-card {
  background: 
    linear-gradient(135deg, rgba(16, 185, 129, 0.08), rgba(59, 130, 246, 0.08)),
    repeating-linear-gradient(
      90deg,
      transparent,
      transparent 2px,
      rgba(34, 197, 94, 0.03) 2px,
      rgba(34, 197, 94, 0.03) 4px
    ),
    repeating-linear-gradient(
      0deg,
      transparent,
      transparent 2px,
      rgba(59, 130, 246, 0.03) 2px,
      rgba(59, 130, 246, 0.03) 4px
    );
  border: 1px solid rgba(34, 197, 94, 0.3);
  border-radius: 8px;
  padding: 15px;
  box-shadow: 
    0 4px 12px rgba(34, 197, 94, 0.15),
    inset 0 1px 0 rgba(255, 255, 255, 0.05);
  position: relative;
  overflow: hidden;
}

.strategy-card::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-image: 
    /* K线图案 */
    linear-gradient(to top, transparent 45%, rgba(34, 197, 94, 0.15) 48%, rgba(34, 197, 94, 0.15) 52%, transparent 55%),
    linear-gradient(to top, transparent 60%, rgba(239, 68, 68, 0.15) 63%, rgba(239, 68, 68, 0.15) 67%, transparent 70%),
    linear-gradient(to top, transparent 30%, rgba(34, 197, 94, 0.15) 33%, rgba(34, 197, 94, 0.15) 37%, transparent 40%),
    /* 数据点 */
    radial-gradient(circle at 15% 25%, rgba(59, 130, 246, 0.2) 2px, transparent 2px),
    radial-gradient(circle at 35% 45%, rgba(34, 197, 94, 0.2) 2px, transparent 2px),
    radial-gradient(circle at 55% 35%, rgba(59, 130, 246, 0.2) 2px, transparent 2px),
    radial-gradient(circle at 75% 55%, rgba(34, 197, 94, 0.2) 2px, transparent 2px),
    radial-gradient(circle at 85% 40%, rgba(59, 130, 246, 0.2) 2px, transparent 2px);
  background-size: 
    20px 100%,
    20px 100%,
    20px 100%,
    100% 100%,
    100% 100%,
    100% 100%,
    100% 100%,
    100% 100%;
  background-position: 
    10% 0,
    30% 0,
    50% 0,
    0 0,
    0 0,
    0 0,
    0 0,
    0 0;
  opacity: 0.4;
  pointer-events: none;
  z-index: 0;
}

.strategy-card::after {
  content: '📈';
  position: absolute;
  right: 15px;
  top: 15px;
  font-size: 48px;
  opacity: 0.08;
  z-index: 0;
}

.strategy-card > * {
  position: relative;
  z-index: 1;
}

.strategy-info {
  margin-bottom: 12px;
}

.strategy-name {
  font-size: 14px;
  font-weight: bold;
  color: #10b981;
  margin-bottom: 8px;
  text-shadow: 0 0 10px rgba(16, 185, 129, 0.3);
}

.strategy-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.confidence {
  font-size: 12px;
  color: #888;
}

.strategy-description {
  font-size: 12px;
  color: #ccc;
  line-height: 1.4;
}

.strategy-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

/* 推荐策略列表 */
.strategy-recommendations {
  flex: 1;
  display: flex;
  flex-direction: column;
}

.recommendations-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 15px;
  border-bottom: 1px solid #333;
  background: #1a1a1a;
  font-size: 13px;
  color: #ccc;
}

.loading-state {
  padding: 15px;
}

.recommendations-list {
  max-height: calc(100vh - 280px);
  overflow-y: auto;
  padding: 10px;
}

.view-all-btn {
  text-align: center;
  padding: 8px 0 4px;
  border-top: 1px solid #333;
}

.recommendation-item {
  background: #1a1a1a;
  border: 1px solid #333;
  border-radius: 6px;
  padding: 12px;
  margin-bottom: 8px;
  transition: all 0.3s ease;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.recommendation-item:hover {
  border-color: #555;
  background: #222;
}

.recommendation-content {
  display: flex;
  justify-content: space-between;
  cursor: pointer;
  flex: 1;
}

.recommendation-info {
  flex: 1;
}

.recommendation-name {
  font-size: 13px;
  font-weight: bold;
  color: #fff;
  margin-bottom: 4px;
}

.recommendation-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.match-score {
  font-size: 11px;
  color: #00aaff;
  font-weight: 600;
}

.recommendation-reason {
  font-size: 11px;
  color: #888;
  line-height: 1.3;
}

.recommendation-stats {
  display: flex;
  gap: 15px;
  font-size: 11px;
  min-width: 120px;
}

.recommendation-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  padding-top: 4px;
  border-top: 1px solid #333;
}

.recommendation-actions .el-button {
  padding: 4px 8px;
  font-size: 11px;
  height: auto;
  min-height: 24px;
}

.recommendation-actions .el-button .el-icon {
  font-size: 12px;
}

.stat-item {
  display: flex;
  gap: 4px;
}

.stat-item .label {
  color: #888;
}

.stat-item .value {
  color: #ccc;
  font-weight: 600;
}

.profit-positive {
  color: #ff4444 !important;
}

.profit-negative {
  color: #00aa00 !important;
}

.empty-recommendations {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 30px;
  gap: 15px;
}

/* 策略创建对话框 */
.strategy-creator {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.code-input-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.section-title {
  font-weight: bold;
  color: #00aaff;
}

.code-actions {
  display: flex;
  gap: 8px;
}

.code-input {
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
}

/* 分析结果样式 */
.analysis-result {
  background: rgba(0, 170, 255, 0.1);
  border: 1px solid #00aaff;
  border-radius: 6px;
  padding: 15px;
}

.analysis-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  font-weight: bold;
  color: #00aaff;
}

.analysis-details {
  margin-bottom: 15px;
}

.detail-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  font-size: 13px;
}

.detail-row .label {
  color: #ccc;
  min-width: 80px;
}

.confidence-text {
  color: #888;
  font-size: 12px;
}

.tag-item {
  margin-right: 4px;
}

.auto-config-preview {
  background: rgba(255, 255, 255, 0.05);
  border-radius: 4px;
  padding: 10px;
  margin-bottom: 15px;
}

.preview-title {
  font-size: 12px;
  font-weight: bold;
  color: #00aaff;
  margin-bottom: 8px;
}

.config-item {
  display: flex;
  margin-bottom: 4px;
  font-size: 12px;
}

.config-label {
  color: #888;
  min-width: 80px;
}

.config-value {
  color: #ccc;
  flex: 1;
}

.recommendations {
  margin-bottom: 15px;
}

.recommendations-title {
  font-size: 12px;
  font-weight: bold;
  color: #00aaff;
  margin-bottom: 8px;
}

.recommendation {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
  font-size: 12px;
  padding: 4px 8px;
  border-radius: 4px;
}

.recommendation.warning {
  background: rgba(255, 193, 7, 0.1);
  color: #ffc107;
}

.recommendation.success {
  background: rgba(40, 167, 69, 0.1);
  color: #28a745;
}

.recommendation.info {
  background: rgba(23, 162, 184, 0.1);
  color: #17a2b8;
}

/* 手动配置 */
.manual-config {
  border-top: 1px solid #333;
  padding-top: 15px;
}

.config-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 15px;
}

.config-title {
  font-weight: bold;
  color: #ccc;
}

/* 模板列表 */
.template-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 400px;
  overflow-y: auto;
}

.template-item {
  background: #1a1a1a;
  border: 1px solid #333;
  border-radius: 6px;
  padding: 15px;
  cursor: pointer;
  transition: all 0.3s ease;
}

.template-item:hover {
  border-color: #555;
  background: #222;
}

.template-name {
  font-size: 14px;
  font-weight: bold;
  color: #fff;
  margin-bottom: 8px;
}

.template-description {
  font-size: 12px;
  color: #888;
  line-height: 1.4;
  margin-bottom: 8px;
}

.template-meta {
  display: flex;
  gap: 8px;
}

/* Element Plus 样式覆盖 */
:deep(.el-dialog) {
  background: #1a1a1a;
  border: 1px solid #333;
}

:deep(.el-dialog__header) {
  background: #222;
  border-bottom: 1px solid #333;
}

:deep(.el-dialog__title) {
  color: #fff;
}

:deep(.el-dialog__body) {
  background: #1a1a1a;
  color: #fff;
}

:deep(.el-form-item__label) {
  color: #ccc;
}

:deep(.el-input__wrapper) {
  background: #222;
  border-color: #444;
}

:deep(.el-input__inner) {
  color: #fff;
}

:deep(.el-textarea__inner) {
  background: #222;
  border-color: #444;
  color: #fff;
}

:deep(.el-select .el-input__wrapper) {
  background: #222;
  border-color: #444;
}

:deep(.el-button) {
  background: #333;
  border-color: #555;
  color: #ccc;
}

:deep(.el-button:hover) {
  background: #555;
  border-color: #777;
}

:deep(.el-button--primary) {
  background: #00aaff;
  border-color: #00aaff;
}

:deep(.el-button--success) {
  background: #00aa00;
  border-color: #00aa00;
}

:deep(.el-tag) {
  background: rgba(0, 170, 0, 0.2);
  border-color: #00aa00;
  color: #00aa00;
}

:deep(.el-empty) {
  color: #888;
}

/* 滚动条样式 */
::-webkit-scrollbar {
  width: 6px;
}

::-webkit-scrollbar-track {
  background: #1a1a1a;
}

::-webkit-scrollbar-thumb {
  background: #555;
  border-radius: 3px;
}

::-webkit-scrollbar-thumb:hover {
  background: #777;
}

/* 🔥 新增：参数显示样式 */
.strategy-parameters {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid #333;
}

.parameters-title {
  font-size: 11px;
  color: #888;
  margin-bottom: 5px;
}

.parameters-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.param-item {
  font-size: 11px;
  color: #00aaff;
  background: rgba(0, 170, 255, 0.1);
  padding: 2px 8px;
  border-radius: 3px;
  border: 1px solid rgba(0, 170, 255, 0.3);
}

/* 🔥 新增：参数编辑器样式 */
.parameters-editor {
  padding: 10px 0;
}

.param-hint {
  font-size: 11px;
  color: #888;
  margin-top: 4px;
  line-height: 1.3;
}

.parameters-json {
  margin-top: 20px;
  padding-top: 15px;
  border-top: 1px solid #333;
}

.json-title {
  font-size: 12px;
  color: #ccc;
  margin-bottom: 8px;
  font-weight: 600;
}

:deep(.el-input-number) {
  width: 100%;
}

:deep(.el-input-number .el-input__inner) {
  text-align: left;
}

</style>

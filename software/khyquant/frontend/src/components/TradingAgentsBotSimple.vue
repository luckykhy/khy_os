<template>
  <div 
    v-if="isVisible"
    ref="robotRef"
    class="trading-agents-bot"
    :class="{ 
      'expanded': isExpanded,
      'analyzing': isThinking,
      'dragging': isDragging
    }"
    :style="robotStyle"
  >
    <!-- 悬浮机器人图标 -->
    <div 
      class="bot-avatar" 
      :class="{ 'expanded': isExpanded, 'thinking': isThinking, 'dragging': isDragging }"
      @mousedown="startDrag"
      @touchstart="startDrag"
    >
      <img src="/robot-avatar.jpg" alt="AI助手" class="robot-face-image" />
      <div class="status-ring" :class="analysisStatus">
        <div class="pulse-ring"></div>
      </div>
      <div class="agent-count">{{ activeAgents.length }}</div>
      
      <!-- 拖拽提示 -->
      <div v-if="showDragHint && !isExpanded && !isDragging" class="robot-tooltip">
        点击展开AI智能体团队
      </div>
    </div>

    <!-- 智能体分析面板 -->
    <transition name="panel-slide">
      <div 
        v-if="isExpanded" 
        class="analysis-panel"
        :style="panelStyle"
      >
        <!-- 面板头部 -->
        <div class="panel-header">
          <div class="header-left">
            <h3>AI智能体团队</h3>
            <span class="team-status">{{ teamStatusText }}</span>
          </div>
          <div class="header-actions">
            <el-button 
              @click="openTokenManager" 
              size="small" 
              type="primary"
              plain
            >
              <el-icon><Key /></el-icon>
              Token管理
            </el-button>
            <el-button 
              @click="hideAssistant" 
              size="small" 
              type="warning"
              plain
              title="完全隐藏AI助手"
            >
              <el-icon><Hide /></el-icon>
              隐藏
            </el-button>
            <el-button 
              @click="minimizePanel" 
              size="small" 
              circle 
              :icon="Minus"
              title="最小化面板"
            />
            <el-button 
              @click="closePanel" 
              size="small" 
              circle 
              :icon="Close"
              title="关闭面板"
            />
          </div>
        </div>

        <!-- 面板内容区域（可滚动） -->
        <div class="panel-content">
          <!-- 股票输入区域 -->
        <div class="stock-input-section">
          <div class="input-group">
            <el-input 
              v-model="stockCode" 
              placeholder="输入股票代码 (如: 000001, sh000300)"
              size="large"
              clearable
              @keyup.enter="startAnalysis"
              @input="validateStockCode"
            >
              <template #prepend>
                <el-icon><TrendCharts /></el-icon>
              </template>
              <template #append>
                <el-button 
                  @click="startAnalysis" 
                  :loading="isThinking"
                  :disabled="!isValidStockCode"
                  type="primary"
                >
                  {{ isThinking ? '分析中...' : '开始分析' }}
                </el-button>
              </template>
            </el-input>
          </div>
          
          <!-- 快速选择 -->
          <div class="quick-select">
            <span class="quick-label">快速选择:</span>
            <el-tag 
              v-for="stock in popularStocks" 
              :key="stock.value"
              @click="selectStock(stock.value)"
              class="stock-tag"
              effect="plain"
            >
              {{ stock.label }}
            </el-tag>
          </div>
        </div>

        <!-- 智能体状态区域 -->
        <div class="agents-section">
          <div class="section-header">
            <h4>智能体团队状态</h4>
            <el-progress 
              :percentage="overallProgress" 
              :status="progressStatus"
              :stroke-width="6"
              class="overall-progress"
            />
          </div>
          
          <div class="agents-grid">
            <div
              v-for="agent in agents"
              :key="agent.id"
              class="agent-card"
              :class="{ 
                'active': agent.isActive,
                'analyzing': agent.status === 'analyzing',
                'completed': agent.status === 'completed',
                'error': agent.status === 'error'
              }"
              @click="toggleAgent(agent.id)"
            >
              <div class="agent-avatar">
                <!-- 智能体图标 -->
                <div class="agent-icon" v-html="getAgentIcon(agent.id)"></div>
                <div class="agent-status-dot" :class="agent.status"></div>
              </div>
              <div class="agent-info">
                <div class="agent-header-row">
                  <div class="agent-name">{{ agent.name }}</div>
                  <span v-if="agent.algorithm" class="algorithm-badge">{{ agent.algorithm }}</span>
                </div>
                <div class="agent-description">{{ agent.description }}</div>
                <div v-if="agent.algorithmDesc" class="algorithm-description">
                  🤖 {{ agent.algorithmDesc }}
                </div>
                <div v-if="agent.progress > 0" class="agent-progress">
                  <el-progress 
                    :percentage="agent.progress" 
                    :stroke-width="4"
                    :show-text="false"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 分析结果区域 -->
        <div v-if="analysisResult" class="results-section">
          <div class="result-summary">
            <h4>{{ analysisResult.stockCode }} 分析报告</h4>
            <div class="result-meta">
              <el-tag :type="getRecommendationType(analysisResult.recommendation)" size="small">
                {{ analysisResult.recommendation || '待定' }}
              </el-tag>
              <span class="confidence">置信度: {{ analysisResult.confidence || 0 }}%</span>
              <!-- AI提供商信息 -->
              <div class="ai-provider-info">
                <ChannelHealthIndicator />
                <el-tag
                  :type="analysisResult.isRealLLM ? 'success' : 'info'"
                  size="small"
                  effect="plain"
                >
                  <el-icon><ChatDotRound /></el-icon>
                  {{ analysisResult.aiProvider || '未知AI' }}
                </el-tag>
                <span class="model-info" v-if="analysisResult.modelName">
                  {{ analysisResult.modelName }}
                </span>
              </div>
            </div>
            <div class="result-summary-text">{{ analysisResult.summary }}</div>
            <!-- 详细AI信息 -->
            <div class="ai-details" v-if="analysisResult.isRealLLM">
              <div class="ai-detail-item">
                <span class="label">AI模型:</span>
                <span class="value">{{ analysisResult.modelName || 'gpt-4-turbo' }}</span>
              </div>
              <div class="ai-detail-item">
                <span class="label">API版本:</span>
                <span class="value">{{ analysisResult.apiVersion || 'v1.0' }}</span>
              </div>
              <div class="ai-detail-item">
                <span class="label">分析时间:</span>
                <span class="value">{{ formatTime(analysisResult.timestamp) }}</span>
              </div>
            </div>
          </div>
          
          <!-- 智能体结果标签页 -->
          <el-tabs v-model="activeResultTab" type="card" size="small">
            <el-tab-pane 
              v-for="agentResult in analysisResult.agentResults" 
              :key="agentResult.agentId"
              :label="getAgentTabLabel(agentResult)"
              :name="agentResult.agentId"
            >
              <div class="agent-result-content">
                <div class="agent-analysis">{{ agentResult.analysis }}</div>
                <div v-if="agentResult.keyFindings" class="key-findings">
                  <h6>关键发现:</h6>
                  <ul>
                    <li v-for="finding in agentResult.keyFindings" :key="finding">
                      {{ finding }}
                    </li>
                  </ul>
                </div>
              </div>
            </el-tab-pane>
          </el-tabs>
        </div>

        <!-- 对话模式区域 -->
        <div v-if="analysisResult" class="chat-section">
          <div class="chat-header">
            <h5>继续对话</h5>
            <el-tag size="small" type="success">
              {{ currentModelName }}
            </el-tag>
          </div>
          
          <!-- 对话消息列表 -->
          <div class="chat-messages" ref="chatMessagesRef">
            <div 
              v-for="(msg, index) in chatMessages" 
              :key="index"
              class="chat-message"
              :class="msg.role"
            >
              <div class="message-content markdown-body" v-html="renderMarkdown(msg.content)"></div>
              <div v-if="msg.role === 'assistant' && msg.model" class="message-model">{{ msg.model }}</div>
              <div class="message-time">{{ formatTime(msg.timestamp) }}</div>
            </div>
            <div v-if="isStreaming" class="chat-message assistant streaming">
              <div v-if="thinkingContent" class="thinking-block">
                <span class="thinking-label">Thinking</span>
                <div class="thinking-text">{{ thinkingContent }}</div>
              </div>
              <div class="message-content markdown-body" v-html="renderMarkdown(streamContent || '...')"></div>
              <div class="streaming-cursor"></div>
            </div>
            <div v-else-if="isChatting" class="chat-message assistant">
              <div class="message-content typing">
                <span></span><span></span><span></span>
              </div>
            </div>
          </div>
          
          <!-- 对话输入框 -->
          <div class="chat-input-area">
            <el-input
              v-model="chatInput"
              type="textarea"
              :rows="2"
              placeholder="询问关于这只股票的问题... (小K专注金融量化分析)"
              :disabled="isChatting"
              clearable
              @compositionstart="handleCompositionStart"
              @compositionend="handleCompositionEnd"
            />
            <el-button
              v-if="isStreaming"
              type="danger"
              @click="cancelStream"
            >
              停止
            </el-button>
            <el-button
              v-else
              type="primary"
              @click="sendChatMessage"
              :loading="isChatting"
              :disabled="!chatInput.trim()"
            >
              <el-icon><ChatDotRound /></el-icon>
              发送
            </el-button>
          </div>
        </div>

        <!-- 历史记录 -->
        <div class="history-section">
          <el-collapse v-model="activeHistoryPanel">
            <el-collapse-item title="分析历史" name="history">
              <div class="history-list">
                <div 
                  v-for="record in analysisHistory" 
                  :key="record.id"
                  class="history-item"
                  @click="loadHistoryRecord(record)"
                >
                  <div class="history-info">
                    <span class="stock-code">{{ record.stockCode }}</span>
                    <span class="analysis-time">{{ formatTime(record.timestamp) }}</span>
                  </div>
                  <div class="history-recommendation">
                    <el-tag :type="getRecommendationType(record.recommendation)" size="small">
                      {{ record.recommendation }}
                    </el-tag>
                  </div>
                </div>
              </div>
            </el-collapse-item>
          </el-collapse>
        </div>
        </div> <!-- 关闭 panel-content -->
        
        <!-- 面板底部操作（固定在底部） -->
        <div class="panel-footer">
          <div class="footer-info">
            <span class="agents-count">{{ activeAgents.length }} 个智能体待命</span>
            <span v-if="analysisResult" class="analysis-status">• 有分析结果</span>
          </div>
          <div class="footer-actions">
            <el-button size="small" @click="resetPosition">
              <el-icon><Refresh /></el-icon>
              重置位置
            </el-button>
            <el-button 
              size="small" 
              @click="exportReport" 
              :disabled="!analysisResult"
              :title="analysisResult ? '导出分析报告' : '请先进行分析'"
            >
              <el-icon><Download /></el-icon>
              导出报告
            </el-button>
          </div>
        </div>
      </div>
    </transition>

    <!-- Token管理对话框 -->
    <el-dialog
      v-model="tokenDialogVisible"
      title="AI Token 管理"
      width="600px"
      :close-on-click-modal="false"
    >
      <div class="token-manager">
        <el-alert
          title="Token安全提示"
          type="warning"
          :closable="false"
          show-icon
          style="margin-bottom: 20px;"
        >
          Token将加密存储在本地，不会上传到服务器。请妥善保管您的API密钥。
        </el-alert>

        <el-form :model="tokenForm" label-width="120px" label-position="left">
          <el-form-item label="OpenAI">
            <div class="token-input-with-test">
              <el-input
                v-model="tokenForm.openai"
                type="password"
                placeholder="sk-..."
                show-password
                clearable
                style="flex: 1;"
              >
                <template #prepend>
                  <el-icon><Key /></el-icon>
                </template>
              </el-input>
              <el-button 
                type="primary" 
                @click="testToken('openai')"
                :loading="testingToken === 'openai'"
                style="margin-left: 10px;"
              >
                测试
              </el-button>
            </div>
            <div class="token-hint">用于GPT-4、GPT-3.5等模型</div>
            <div class="token-link"><a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener">前往 OpenAI 管理 API Key →</a></div>
          </el-form-item>

          <el-form-item label="Anthropic Claude">
            <div class="token-input-with-test">
              <el-input
                v-model="tokenForm.anthropic"
                type="password"
                placeholder="sk-ant-..."
                show-password
                clearable
                style="flex: 1;"
              >
                <template #prepend>
                  <el-icon><Key /></el-icon>
                </template>
              </el-input>
              <el-button 
                type="primary" 
                @click="testToken('anthropic')"
                :loading="testingToken === 'anthropic'"
                style="margin-left: 10px;"
              >
                测试
              </el-button>
            </div>
            <div class="token-hint">用于Claude 3系列模型</div>
            <div class="token-link"><a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">前往 Anthropic 管理 API Key →</a></div>
          </el-form-item>

          <el-form-item label="Google Gemini">
            <div class="token-input-with-test">
              <el-input
                v-model="tokenForm.google"
                type="password"
                placeholder="AIza..."
                show-password
                clearable
                style="flex: 1;"
              >
                <template #prepend>
                  <el-icon><Key /></el-icon>
                </template>
              </el-input>
              <el-button 
                type="primary" 
                @click="testToken('google')"
                :loading="testingToken === 'google'"
                style="margin-left: 10px;"
              >
                测试
              </el-button>
            </div>
            <div class="token-hint">用于Gemini Pro等模型</div>
            <div class="token-link"><a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">前往 Google AI Studio 管理 API Key →</a></div>
          </el-form-item>

          <el-form-item label="Hugging Face">
            <div class="token-input-with-test">
              <el-input
                v-model="tokenForm.huggingface"
                type="password"
                placeholder="hf_..."
                show-password
                clearable
                style="flex: 1;"
              >
                <template #prepend>
                  <el-icon><Key /></el-icon>
                </template>
              </el-input>
              <el-button 
                type="primary" 
                @click="testToken('huggingface')"
                :loading="testingToken === 'huggingface'"
                style="margin-left: 10px;"
              >
                测试
              </el-button>
            </div>
            <div class="token-hint">用于Hugging Face推理API和模型</div>
            <div class="token-link"><a href="https://huggingface.co/settings/tokens" target="_blank" rel="noopener">前往 Hugging Face 管理 Token →</a></div>
          </el-form-item>

          <el-form-item label="Finlight 新闻">
            <div class="token-input-with-test">
              <el-input
                v-model="tokenForm.finlight"
                type="password"
                placeholder="sk_..."
                show-password
                clearable
                style="flex: 1;"
              >
                <template #prepend>
                  <el-icon><Key /></el-icon>
                </template>
              </el-input>
              <el-button
                type="primary"
                @click="testToken('finlight')"
                :loading="testingToken === 'finlight'"
                style="margin-left: 10px;"
              >
                测试
              </el-button>
            </div>
            <div class="token-hint">用于新闻分析师获取实时金融新闻语料</div>
            <div class="token-link"><a href="https://app.finlight.me/api-keys" target="_blank" rel="noopener">前往 Finlight.me 管理 API Key →</a></div>
          </el-form-item>

          <el-form-item label="百度文心一言">
            <div class="token-input-with-test">
              <el-input
                v-model="tokenForm.baidu"
                type="password"
                placeholder="API Key"
                show-password
                clearable
                style="flex: 1;"
              >
                <template #prepend>
                  <el-icon><Key /></el-icon>
                </template>
              </el-input>
              <el-button 
                type="primary" 
                @click="testToken('baidu')"
                :loading="testingToken === 'baidu'"
                style="margin-left: 10px;"
              >
                测试
              </el-button>
            </div>
            <div class="token-hint">用于文心一言系列模型</div>
            <div class="token-link"><a href="https://console.bce.baidu.com/qianfan/ais/console/applicationConsole/application" target="_blank" rel="noopener">前往百度千帆平台管理 API Key →</a></div>
          </el-form-item>

          <el-form-item label="阿里通义千问">
            <div class="token-input-with-test">
              <el-input
                v-model="tokenForm.alibaba"
                type="password"
                placeholder="API Key"
                show-password
                clearable
                style="flex: 1;"
              >
                <template #prepend>
                  <el-icon><Key /></el-icon>
                </template>
              </el-input>
              <el-button 
                type="primary" 
                @click="testToken('alibaba')"
                :loading="testingToken === 'alibaba'"
                style="margin-left: 10px;"
              >
                测试
              </el-button>
            </div>
            <div class="token-hint">用于通义千问系列模型</div>
            <div class="token-link"><a href="https://dashscope.console.aliyun.com/apiKey" target="_blank" rel="noopener">前往阿里云百炼平台管理 API Key →</a></div>
          </el-form-item>

          <el-form-item label="讯飞星火">
            <div class="token-input-with-test">
              <el-input
                v-model="tokenForm.xunfei"
                type="password"
                placeholder="API Key"
                show-password
                clearable
                style="flex: 1;"
              >
                <template #prepend>
                  <el-icon><Key /></el-icon>
                </template>
              </el-input>
              <el-button 
                type="primary" 
                @click="testToken('xunfei')"
                :loading="testingToken === 'xunfei'"
                style="margin-left: 10px;"
              >
                测试
              </el-button>
            </div>
            <div class="token-hint">用于星火认知大模型</div>
            <div class="token-link"><a href="https://console.xfyun.cn/services/bm35" target="_blank" rel="noopener">前往讯飞开放平台管理 API Key →</a></div>
          </el-form-item>

          <el-form-item label="智谱AI">
            <div class="token-input-with-test">
              <el-input
                v-model="tokenForm.zhipu"
                type="password"
                placeholder="API Key"
                show-password
                clearable
                style="flex: 1;"
              >
                <template #prepend>
                  <el-icon><Key /></el-icon>
                </template>
              </el-input>
              <el-button 
                type="primary" 
                @click="testToken('zhipu')"
                :loading="testingToken === 'zhipu'"
                style="margin-left: 10px;"
              >
                测试
              </el-button>
            </div>
            <div class="token-hint">用于ChatGLM系列模型</div>
            <div class="token-link"><a href="https://open.bigmodel.cn/usercenter/apikeys" target="_blank" rel="noopener">前往智谱AI开放平台管理 API Key →</a></div>
          </el-form-item>
        </el-form>

        <div class="token-status">
          <el-divider content-position="left">Token状态</el-divider>
          <div class="status-grid">
            <div 
              v-for="(value, key) in tokenForm" 
              :key="key"
              class="status-item"
            >
              <span class="provider-name">{{ getProviderName(key) }}</span>
              <el-tag 
                :type="value ? 'success' : 'info'" 
                size="small"
                effect="plain"
              >
                {{ value ? '已配置' : '未配置' }}
              </el-tag>
            </div>
          </div>
        </div>
      </div>

      <!-- Model Retrain Section -->
      <div class="retrain-section" style="margin-top: 20px; padding-top: 16px; border-top: 1px solid #e4e7ed;">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px;">
          <span style="font-weight: 600; font-size: 14px;">ML Model Management</span>
          <el-tag :type="retrainStatus.status === 'running' ? 'warning' : retrainStatus.status === 'completed' ? 'success' : 'info'" size="small">
            {{ retrainStatus.status === 'running' ? 'Training...' : retrainStatus.status === 'completed' ? 'Ready' : 'Idle' }}
          </el-tag>
        </div>
        <el-button
          type="warning"
          @click="triggerRetrain"
          :loading="retrainStatus.status === 'running'"
          :disabled="retrainStatus.status === 'running'"
          style="width: 100%;"
        >
          <el-icon><Refresh /></el-icon>
          {{ retrainStatus.status === 'running' ? 'Retraining in progress...' : 'Retrain Models' }}
        </el-button>
        <div v-if="retrainStatus.status === 'running' && retrainStatus.logs && retrainStatus.logs.length > 0"
             style="margin-top: 8px; max-height: 80px; overflow-y: auto; background: #1a1a2e; color: #16c784; padding: 6px 8px; border-radius: 4px; font-size: 11px; font-family: monospace; line-height: 1.4;">
          <div v-for="(log, i) in retrainStatus.logs.slice(-5)" :key="i">{{ log }}</div>
        </div>
        <div v-if="retrainStatus.status === 'completed'" style="margin-top: 6px; font-size: 12px; color: #67c23a;">
          Training completed at {{ retrainStatus.finishedAt }}
        </div>
        <div v-if="retrainStatus.status === 'failed'" style="margin-top: 6px; font-size: 12px; color: #f56c6c;">
          Training failed. Check logs for details.
        </div>
      </div>

      <template #footer>
        <div class="dialog-footer">
          <el-button @click="tokenDialogVisible = false">取消</el-button>
          <el-button @click="clearAllTokens" type="danger" plain>清除所有</el-button>
          <el-button type="primary" @click="saveTokens">保存配置</el-button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
// ---------------------------------------------------------------------------
// TradingAgentsBotSimple —— 多智能体AI分析助手（浮动机器人面板）
//
// 架构角色：属于前端交互层，对应论文第4.4节（多智能体协同层）和第5.3节
//
// 功能说明：
//   这是一个可拖拽的浮动面板，展示六个AI分析师智能体的协同分析过程。
//   用户点击"开始分析"后，系统依次调用后端 /api/analysis/analyze 接口，
//   六个智能体并行分析，最终由融合引擎加权投票生成综合建议。
//
// 六个智能体（对应论文表14）：
//   市场分析师(RandomForest) → 趋势方向与结构信号
//   技术分析师(XGBoost)      → 指标结论与信号强度
//   基本面分析师(LightGBM)   → 价值判断与配置建议
//   新闻分析师(NaiveBayes)   → 情绪结论与事件影响
//   风险分析师(LogisticRegression) → 风险等级与仓位建议
//   策略分析师(DNN)          → 综合动作与执行参数
//
// 交互特性：
//   - 可拖拽定位（mousedown/touchstart 事件）
//   - 面板展开/收起动画
//   - 分析进度实时展示
//   - Token 管理（API密钥配置）
// ---------------------------------------------------------------------------

import { ref, reactive, computed, onMounted, onUnmounted, watch, nextTick, onUpdated } from 'vue'
import { getApiBaseUrl } from '@/config/api'
import request from '@/utils/request'
import { renderMarkdown, attachCopyListeners } from '@/utils/markdown'
import { useStreamChat } from '@/composables/useStreamChat'
import ChannelHealthIndicator from '@/components/ChannelHealthIndicator.vue'
import '@/assets/markdown.scss'
import { 
  ChatDotRound, 
  Setting, 
  Refresh, 
  Close, 
  User, 
  TrendCharts, 
  Search,
  Minus,
  Download,
  Key,
  Hide
} from '@element-plus/icons-vue'
import { ElMessage, ElNotification, ElMessageBox } from 'element-plus'

// 六个智能体的前端配置 —— 与后端 REQUIRED_AGENT_IDS 对应
// 每个智能体包含：id、名称、算法描述、能力标签、运行状态
// 对应论文表14（角色分工与输出映射）
const agentConfigs = [
  { // MarketAgent —— 随机森林，捕捉宏观趋势与板块轮动
    id: 'market',
    name: '市场分析师',
    description: '市场趋势和宏观分析',
    algorithm: '随机森林',
    algorithmDesc: '500棵决策树集成学习，擅长捕捉非线性关系',
    capabilities: ['市场趋势', '宏观分析', '板块轮动'],
    enabled: true,
    isActive: true,
    status: 'idle',
    progress: 0,
    result: null,
    error: null
  },
  { // TechAgent —— XGBoost，对MACD/KDJ/RSI等技术指标高度敏感
    id: 'technical',
    name: '技术分析师',
    description: '技术指标和图表分析',
    algorithm: 'XGBoost',
    algorithmDesc: '极端梯度提升，对技术指标高度敏感',
    capabilities: ['技术指标', 'K线形态', '支撑阻力'],
    enabled: true,
    isActive: true,
    status: 'idle',
    progress: 0,
    result: null,
    error: null
  },
  { // FundAgent —— LightGBM，高效处理PE/PB/ROE等财务指标
    id: 'fundamentals',
    name: '基本面分析师',
    description: '财务数据和估值分析',
    algorithm: 'LightGBM',
    algorithmDesc: '轻量级梯度提升，高效处理财务数据',
    capabilities: ['财务分析', '估值模型', '行业对比'],
    enabled: true,
    isActive: true,
    status: 'idle',
    progress: 0,
    result: null,
    error: null
  },
  { // NewsAgent —— 朴素贝叶斯，适合文本情感分类与事件影响评估
    id: 'news',
    name: '新闻分析师',
    description: '新闻情绪和事件影响分析',
    algorithm: '朴素贝叶斯',
    algorithmDesc: '概率统计模型，适合文本情感分析',
    capabilities: ['新闻解读', '情绪分析', '事件影响'],
    enabled: true,
    isActive: true,
    status: 'idle',
    progress: 0,
    result: null,
    error: null
  },
  { // RiskAgent —— 逻辑回归，输出风险概率，可解释性强
    id: 'risk',
    name: '风险分析师',
    description: '风险评估和管理建议',
    algorithm: '逻辑回归',
    algorithmDesc: '线性模型，输出风险概率，可解释性强',
    capabilities: ['风险评估', '波动分析', '风控建议'],
    enabled: true,
    isActive: true,
    status: 'idle',
    progress: 0,
    result: null,
    error: null
  },
  { // StrategyAgent —— 深度神经网络(4层DNN)，综合所有信号生成最终交易策略
    id: 'strategy',
    name: '策略分析师',
    description: '投资策略和操作建议',
    algorithm: '深度神经网络',
    algorithmDesc: '4层网络[256-128-64-32]，学习复杂交易模式',
    capabilities: ['策略制定', '仓位管理', '时机选择'],
    enabled: true,
    isActive: false,
    status: 'idle',
    progress: 0,
    result: null,
    error: null
  }
]

// ========================= 响应式数据 =========================
// 面板核心状态：展开/收起、分析中、可见性
const robotRef = ref()
const isExpanded = ref(false)   // 面板是否展开
const isThinking = ref(false)   // 智能体是否正在分析中
// 从localStorage读取显示状态,默认显示(true)
const isVisible = ref(localStorage.getItem('ai-assistant-visible') !== 'false')
const stockCode = ref('')
const isValidStockCode = ref(false)
const activeResultTab = ref('')
const activeHistoryPanel = ref([])
const showDragHint = ref(false)

// 对话模式
const chatMessages = ref([])
const chatInput = ref('')
const isChatting = ref(false)
const chatMessagesRef = ref()

// SSE streaming chat
const { isStreaming, streamContent, thinkingContent, currentModel: streamModel, sendStream, cancelStream } = useStreamChat()

// Token管理
const tokenDialogVisible = ref(false)
const testingToken = ref('') // 正在测试的token类型
const tokenForm = reactive({
  openai: '',
  anthropic: '',
  google: '',
  huggingface: '',
  finlight: '',
  baidu: '',
  alibaba: '',
  xunfei: '',
  zhipu: ''
})

// 智能体运行时状态 —— 由 agentConfigs 深拷贝而来，分析过程中动态更新 status/progress
const agents = reactive(agentConfigs.map(config => ({ ...config })))
const analysisResult = ref(null)   // 最新一次分析的完整结果（含六个智能体输出 + 融合建议）
const analysisHistory = ref([])    // 历史分析记录（最多保留20条）

// ========================= 拖拽相关状态 =========================
// 浮动机器人支持鼠标/触摸拖拽，位置持久化到 localStorage
const isDragging = ref(false)          // 是否正在拖拽
const position = ref({ x: 20, y: 20 })// 机器人在视口中的绝对坐标
const dragStart = ref({ x: 0, y: 0 }) // 拖拽起始偏移量
const hasMoved = ref(false)            // 是否发生过实际移动（区分拖拽与点击）
const isMobileClient = ref(typeof window !== 'undefined' ? window.innerWidth <= 767 : false)

// 热门股票快速选择
const popularStocks = ref([
  { label: '沪深300', value: 'sh000300' },
  { label: '上证指数', value: 'sh000001' },
  { label: '深证成指', value: 'sz399001' },
  { label: '创业板指', value: 'sz399006' },
  { label: '贵州茅台', value: 'sh600519' },
  { label: '招商银行', value: 'sh600036' }
])

// ========================= 计算属性 =========================
// 当前激活的智能体列表 —— 只有 isActive && enabled 的才参与分析
const activeAgents = computed(() =>
  agents.filter(agent => agent.isActive && agent.enabled)
)

// 整体分析进度 —— 所有激活智能体进度的算术平均值
const overallProgress = computed(() => {
  if (!isThinking.value) return 0
  const activeAgentsList = activeAgents.value
  if (activeAgentsList.length === 0) return 0

  const totalProgress = activeAgentsList.reduce((sum, agent) => sum + agent.progress, 0)
  return Math.round(totalProgress / activeAgentsList.length)
})

const progressStatus = computed(() => {
  if (overallProgress.value === 100) return 'success'
  if (overallProgress.value > 0) return 'active'
  return 'normal'
})

const analysisStatus = computed(() => {
  if (isThinking.value) return 'analyzing'
  if (analysisResult.value) return 'completed'
  return 'idle'
})

const teamStatusText = computed(() => {
  const activeCount = activeAgents.value.length
  if (isThinking.value) return `${activeCount}个智能体正在分析...`
  if (analysisResult.value) return `分析完成 - ${activeCount}个智能体参与`
  return `${activeCount}个智能体待命`
})

const robotStyle = computed(() => {
  if (isMobileClient.value && !isExpanded.value) {
    return {
      left: 'auto',
      top: 'auto',
      right: '12px',
      bottom: 'calc(90px + env(safe-area-inset-bottom))',
      cursor: 'pointer',
      zIndex: 10050
    }
  }

  return {
    left: `${position.value.x}px`,
    top: `${position.value.y}px`,
    cursor: isDragging.value ? 'grabbing' : 'grab',
    zIndex: isExpanded.value ? 10060 : 10050
  }
})

const panelStyle = computed(() => {
  const robotWidth = 80
  const panelWidth = 450
  const screenWidth = window.innerWidth
  
  // 智能定位：如果右侧空间不够，则显示在左侧
  const showOnLeft = (position.value.x + robotWidth + panelWidth) > screenWidth
  
  return {
    left: showOnLeft 
      ? `${Math.max(10, position.value.x - panelWidth - 10)}px`
      : `${position.value.x + robotWidth + 10}px`,
    top: `${Math.max(10, position.value.y)}px`,
    maxHeight: `${window.innerHeight - position.value.y - 20}px`
  }
})

// ========================= 拖拽功能 =========================
// 拖拽开始：记录起始坐标，绑定 mousemove/touchmove 监听器
const startDrag = (event) => {
  if (isMobileClient.value && !isExpanded.value) {
    // 移动端单击直接展开，避免浮层不可见/难拖拽
    event.preventDefault()
    togglePanel()
    return
  }

  event.preventDefault()
  
  isDragging.value = true
  hasMoved.value = false
  showDragHint.value = false
  
  const clientX = event.clientX || (event.touches && event.touches[0].clientX)
  const clientY = event.clientY || (event.touches && event.touches[0].clientY)
  
  dragStart.value = {
    x: clientX - position.value.x,
    y: clientY - position.value.y
  }
  
  document.addEventListener('mousemove', onDrag)
  document.addEventListener('mouseup', stopDrag)
  document.addEventListener('touchmove', onDragTouch, { passive: false })
  document.addEventListener('touchend', stopDrag)
  
  document.body.style.cursor = 'grabbing'
  document.body.style.userSelect = 'none'
}

// 鼠标移动时实时更新位置
const onDrag = (event) => {
  if (!isDragging.value) return

  event.preventDefault()
  hasMoved.value = true

  updatePosition(event.clientX, event.clientY)
}

const onDragTouch = (event) => {
  if (!isDragging.value) return
  
  event.preventDefault()
  hasMoved.value = true
  
  const touch = event.touches[0]
  updatePosition(touch.clientX, touch.clientY)
}

// 统一坐标更新 —— 限制在视口范围内，防止拖出屏幕
const updatePosition = (clientX, clientY) => {
  const newX = clientX - dragStart.value.x
  const newY = clientY - dragStart.value.y
  
  const maxX = window.innerWidth - 80
  const maxY = window.innerHeight - 80
  
  position.value = {
    x: Math.max(0, Math.min(newX, maxX)),
    y: Math.max(0, Math.min(newY, maxY))
  }
  
  savePosition()
}

// 拖拽结束：移除监听器，若未移动则视为点击 → 切换面板展开/收起
const stopDrag = (event) => {
  if (!isDragging.value) return

  document.removeEventListener('mousemove', onDrag)
  document.removeEventListener('mouseup', stopDrag)
  document.removeEventListener('touchmove', onDragTouch)
  document.removeEventListener('touchend', stopDrag)
  
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
  
  const wasDragging = isDragging.value
  isDragging.value = false
  
  if (!hasMoved.value && wasDragging) {
    setTimeout(() => {
      togglePanel()
    }, 10)
  }
}

// 保存显示状态到localStorage
const saveVisibilityState = () => {
  localStorage.setItem('ai-assistant-visible', isVisible.value.toString())
}

// 面板操作
const togglePanel = () => {
  if (!isDragging.value) {
    isExpanded.value = !isExpanded.value
  }
}

const closePanel = () => {
  isExpanded.value = false
}

const minimizePanel = () => {
  isExpanded.value = false
}

// 完全隐藏AI助手
const hideAssistant = () => {
  isVisible.value = false
  isExpanded.value = false
  saveVisibilityState()
  ElMessage.success('已隐藏AI助手,可在主页点击"呼叫小K"重新显示')
}

// ========================= 智能体操作 =========================
// 切换单个智能体的启用/禁用状态（分析进行中时不允许切换）
const toggleAgent = (agentId) => {
  if (isThinking.value) return
  const agent = agents.find(a => a.id === agentId)
  if (!agent || !agent.enabled) return
  agent.isActive = !agent.isActive
  if (!agent.isActive) { agent.status = 'idle'; agent.progress = 0 }
  ElMessage({
    message: `${agent.name} ${agent.isActive ? '已启用' : '已禁用'}`,
    type: agent.isActive ? 'success' : 'info',
    duration: 1500
  })
}

// 获取智能体图标
const getAgentIcon = (agentId) => {
  const icons = {
    market: `<svg viewBox="0 0 24 24" fill="currentColor" width="32" height="32">
      <path d="M3.5 18.49l6-6.01 4 4L22 6.92l-1.41-1.41-7.09 7.97-4-4L2 16.99z"/>
      <circle cx="12" cy="12" r="1.5"/>
      <circle cx="7" cy="17" r="1.5"/>
      <circle cx="17" cy="7" r="1.5"/>
    </svg>`,
    
    technical: `<svg viewBox="0 0 24 24" fill="currentColor" width="32" height="32">
      <path d="M9 4v1.38c-.83-.33-1.72-.5-2.61-.5-1.79 0-3.58.68-4.95 2.05l3.33 3.33h1.11v1.11c.86.86 1.98 1.31 3.11 1.36V15H6v3c0 1.1.9 2 2 2h10c1.66 0 3-1.34 3-3V4H9zm-1.11 6.41V8.26H5.61L4.57 7.22a5.07 5.07 0 0 1 1.82-.34c1.34 0 2.59.52 3.54 1.46l1.41 1.41-.2.2a2.7 2.7 0 0 1-1.92.8c-.47 0-.93-.12-1.33-.34zM19 17c0 .55-.45 1-1 1s-1-.45-1-1v-2h-6v-2.59c.57-.23 1.1-.57 1.56-1.03l.2-.2L15.59 14H17v-1.41l-6-5.97V6h8v11z"/>
    </svg>`,
    
    fundamentals: `<svg viewBox="0 0 24 24" fill="currentColor" width="32" height="32">
      <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM9 17H7v-7h2v7zm4 0h-2V7h2v10zm4 0h-2v-4h2v4z"/>
    </svg>`,
    
    news: `<svg viewBox="0 0 24 24" fill="currentColor" width="32" height="32">
      <path d="M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 9h12v2H6V9zm8 5H6v-2h8v2zm4-6H6V6h12v2z"/>
    </svg>`,
    
    risk: `<svg viewBox="0 0 24 24" fill="currentColor" width="32" height="32">
      <path d="M12 2L4 5v6.09c0 5.05 3.41 9.76 8 10.91 4.59-1.15 8-5.86 8-10.91V5l-8-3zm-1 14h2v2h-2v-2zm0-8h2v6h-2V8z"/>
    </svg>`,
    
    strategy: `<svg viewBox="0 0 24 24" fill="currentColor" width="32" height="32">
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
      <circle cx="12" cy="12" r="2"/>
    </svg>`
  }
  
  return icons[agentId] || icons.market
}

// 股票代码验证
const validateStockCode = () => {
  const code = stockCode.value.trim()
  // 更宽松的验证：允许空值以外的任何输入，让用户可以测试
  isValidStockCode.value = code.length > 0
  
  // 如果需要严格验证，可以使用以下正则：
  // isValidStockCode.value = /^(sh\d{6}|sz\d{6}|\d{6}|[A-Z]{1,5})$/i.test(code)
}

const selectStock = (code) => {
  stockCode.value = code
  validateStockCode()
}

// ========================= 核心分析流程 =========================
// 入口方法：验证输入 → 重置状态 → 调用 performRealAnalysis
// 对应论文第5.3节（多智能体协同实现）中的"分析触发"流程
const startAnalysis = async () => {
  if (!isValidStockCode.value) {
    ElMessage.warning('请输入有效的股票代码')
    return
  }

  if (activeAgents.value.length === 0) {
    ElMessage.warning('请至少选择一个智能体')
    return
  }

  try {
    isThinking.value = true
    
    // 重置智能体状态
    agents.forEach(agent => {
      if (agent.isActive) {
        agent.status = 'analyzing'
        agent.progress = 0
        agent.error = null
      }
    })

    ElNotification({
      title: '分析开始',
      message: `正在使用 ${activeAgents.value.length} 个智能体分析 ${stockCode.value}`,
      type: 'info',
      duration: 3000
    })

    // 调用真实的后端LLM分析
    await performRealAnalysis()
    
    ElMessage.success('TradingAgents分析完成！')
  } catch (error) {
    console.error('分析失败:', error)
    ElMessage.error('分析失败，请稍后重试')
    
    // 重置状态
    agents.forEach(agent => {
      agent.status = 'idle'
      agent.progress = 0
    })
  } finally {
    isThinking.value = false
  }
}

// 真实分析流程 —— 调用后端 /trading-agents/analyze 接口
// 流程：连接服务(20%) → 智能体团队并行分析(50%) → 生成报告(80%) → 完成(100%)
// 后端会依次执行 AgentBase.loadData() → reason() → formatOutput()（论文图7类图）
// 最终由 AgentFusionEngine 按历史准确率归一化权重加权投票（论文4.4节）
const performRealAnalysis = async () => {
  try {
    // 显示进度
    updateAnalysisProgress(20, '连接智能体服务...')

    // 调用后端API进行真实分析（通过统一 request 封装，自动注入 JWT）
    const data = await request.post('/trading-agents/analyze', {
      symbol: stockCode.value,
      useML: true,
      context: {
        // 前端ID → 后端ID映射（前端用短名，后端用 xxx_analyst 全名）
        enabledAgents: activeAgents.value.map(agent => {
          const map = {
            'market': 'market_analyst',
            'technical': 'technical_analyst',
            'fundamentals': 'fundamental_analyst',
            'news': 'news_analyst',
            'risk': 'risk_analyst',
            'strategy': 'strategy_analyst'
          }
          return map[agent.id] || agent.id
        }),
        finlightApiKey: tokenForm.finlight || '',
      }
    })

    updateAnalysisProgress(50, '智能体团队分析中...')

    if (!data.success) {
      throw new Error(data.message || '分析失败')
    }

    updateAnalysisProgress(80, '生成分析报告...')

    // 处理真实的分析结果
    const analysisData = data.data
    // 将根级别的 isMLPowered/mode 注入 analysisData 供后续使用
    analysisData._isMLPowered = data.isMLPowered
    analysisData._mode = data.mode
    
    // 将后端返回的智能体分析结果转换为前端展示格式
    // 后端 agentResults 数组中每个元素对应一个智能体的 formatOutput() 输出
    const agentResults = []

    // 后端ID → 前端ID 反向映射（用于匹配用户选中的智能体）
    const backendToFrontendIdMap = {
      'market_analyst': 'market',
      'technical_analyst': 'technical',  // 技术分析师映射到technical
      'fundamental_analyst': 'fundamentals',
      'news_analyst': 'news',
      'risk_analyst': 'risk',
      'strategy_analyst': 'strategy'
    }
    
    if (analysisData.agentResults && analysisData.agentResults.length > 0) {
      // 直接使用后端返回的agentResults
      analysisData.agentResults.forEach(result => {
        // 映射后端ID到前端ID
        const frontendId = backendToFrontendIdMap[result.agentId] || result.agentId
        
        // 只添加用户选择的智能体
        if (activeAgents.value.find(a => a.id === frontendId)) {
          agentResults.push({
            agentId: frontendId,  // 使用前端ID
            agentName: result.agentName,
            status: 'completed',
            score: result.score,
            analysis: result.analysis,  // 这里会是详实的分析报告
            algorithm: result.algorithm,  // 算法名称
            keyFindings: result.keyFindings || []
          })
        }
      })
    }
    // 兼容旧的analysisResults格式
    else if (analysisData.analysisResults) {
      const results = analysisData.analysisResults
      
      // 只添加用户选择的智能体结果
      if (activeAgents.value.find(a => a.id === 'fundamentals') && results.fundamental) {
        agentResults.push({
          agentId: 'fundamentals',
          agentName: '基本面分析师',
          status: 'completed',
          score: (results.fundamental.score * 10).toFixed(1),
          analysis: results.fundamental.analysis || '基本面分析完成',
          keyFindings: results.fundamental.factors || ['财务指标分析', '估值评估', '行业对比']
        })
      }
      
      if (activeAgents.value.find(a => a.id === 'market') && results.technical) {
        agentResults.push({
          agentId: 'market',
          agentName: '市场分析师',
          status: 'completed',
          score: (results.technical.score * 10).toFixed(1),
          analysis: results.technical.analysis || '技术面分析完成',
          keyFindings: results.technical.indicators || ['技术指标', '趋势分析', '支撑阻力']
        })
      }
      
      if (activeAgents.value.find(a => a.id === 'social') && results.sentiment) {
        agentResults.push({
          agentId: 'social',
          agentName: '社交媒体分析师',
          status: 'completed',
          score: (results.sentiment.score * 10).toFixed(1),
          analysis: results.sentiment.analysis || '市场情绪分析完成',
          keyFindings: results.sentiment.sources || ['社交媒体', '投资者情绪', '市场氛围']
        })
      }
      
      if (activeAgents.value.find(a => a.id === 'news') && results.news) {
        agentResults.push({
          agentId: 'news',
          agentName: '新闻分析师',
          status: 'completed',
          score: (results.news.score * 10).toFixed(1),
          analysis: results.news.analysis || '新闻面分析完成',
          keyFindings: results.news.events?.map(e => e.event) || ['新闻事件', '政策影响', '市场反应']
        })
      }
    }
    
    // 如果后端没有返回足够的结果,为剩余的选中智能体生成基础结果
    const remainingAgents = activeAgents.value.filter(agent => 
      !agentResults.find(result => result.agentId === agent.id)
    )
    
    remainingAgents.forEach(agent => {
      agentResults.push({
        agentId: agent.id,
        agentName: agent.name,
        status: 'completed',
        score: '7.5',
        analysis: `${agent.name}完成了专业分析，基于${agent.description}提供投资建议。`,
        keyFindings: agent.capabilities || ['专业分析', '投资建议', '风险评估']
      })
    })

    updateAnalysisProgress(100, '分析完成')

    // 处理置信度 —— 融合引擎输出的加权投票置信度
    // 后端可能返回 0~1 的小数或 0~100 的百分比，这里统一归一化
    const rawConfidence = analysisData.confidence || 0.5;
    const confidence = rawConfidence > 1 
      ? Math.min(Math.round(rawConfidence), 100)  // 已经是百分比，限制在100以内
      : Math.round(rawConfidence * 100);  // 是小数，转换为百分比

    // 组装最终分析结果对象，供面板展示和小K对话使用
    analysisResult.value = {
      stockCode: stockCode.value,
      recommendation: analysisData.finalDecision?.recommendation?.action || '持有',
      confidence: confidence,
      summary: `基于您选择的 ${agentResults.length} 个智能体的综合分析，${stockCode.value} 的投资建议如下。${analysisData.stockData ? '本次分析基于实时股票数据。' : ''}`,
      agentResults, // 只包含用户选择的智能体
      timestamp: Date.now(),
      analysisId: `analysis_${Date.now()}`,
      isRealLLM: analysisData.isRealLLM || false,
      aiProvider: analysisData._isMLPowered ? 'ML本地模型' : (analysisData.aiProvider || '在线AI'),
      modelName: analysisData._isMLPowered ? '随机森林/XGBoost/LightGBM' : (analysisData.modelName || ''),
      apiVersion: analysisData.apiVersion || 'v1.0',
      stockData: analysisData.stockData // 保存股票数据供小K使用
    }

    // 设置第一个结果标签页为活跃
    if (agentResults.length > 0) {
      activeResultTab.value = agentResults[0].agentId
    }

    // 添加到历史记录
    analysisHistory.value.unshift({
      id: analysisResult.value.analysisId,
      stockCode: stockCode.value,
      timestamp: Date.now(),
      recommendation: analysisResult.value.recommendation,
      confidence: analysisResult.value.confidence
    })

    // 限制历史记录数量
    if (analysisHistory.value.length > 20) {
      analysisHistory.value = analysisHistory.value.slice(0, 20)
    }

    // 分析完成后,小K自动打招呼
    await nextTick()
    addAssistantGreeting()

  } catch (error) {
    console.error('真实分析失败，使用降级分析:', error)
    
    // 降级到模拟分析
    ElNotification({
      title: '分析模式切换',
      message: 'LLM服务暂时不可用，使用本地分析模式',
      type: 'warning',
      duration: 3000
    })
    
    await simulateAnalysis()
  }
}

// 统一更新所有激活智能体的进度值（同步推进）
const updateAnalysisProgress = (progress, message) => {
  activeAgents.value.forEach(agent => {
    agent.progress = progress
    if (progress === 100) {
      agent.status = 'completed'
    }
  })
  
  console.log(`分析进度: ${progress}% - ${message}`)
}

// 降级模拟分析 —— 当后端API不可用时的本地兜底方案
// 模拟三个步骤：获取数据 → 本地分析 → 生成报告，每步带延时动画
const simulateAnalysis = async () => {
  const analysisSteps = [
    { step: 1, message: '获取市场数据...', duration: 1000 },
    { step: 2, message: '本地智能体分析...', duration: 2000 },
    { step: 3, message: '生成分析报告...', duration: 1000 }
  ]

  for (const step of analysisSteps) {
    await new Promise(resolve => setTimeout(resolve, step.duration))
    
    // 更新智能体进度
    const progressIncrement = 100 / analysisSteps.length
    activeAgents.value.forEach(agent => {
      agent.progress = Math.min(100, agent.progress + progressIncrement)
      if (agent.progress === 100) {
        agent.status = 'completed'
      }
    })
  }

  // 生成模拟分析结果
  const actions = ['强烈买入', '买入', '持有', '卖出']
  const action = actions[Math.floor(Math.random() * actions.length)]
  const confidence = Math.round(Math.random() * 40 + 50) // 50-90%
  
  const agentResults = activeAgents.value.map(agent => ({
    agentId: agent.id,
    agentName: agent.name,
    status: 'completed',
    score: (Math.random() * 4 + 6).toFixed(1), // 6-10分
    analysis: `${agent.name}基于${agent.description}，对${stockCode.value}进行了深度分析。*注：这是本地分析结果，如需AI分析请检查网络连接*`,
    keyFindings: [
      `${agent.capabilities[0]}显示积极信号`,
      `${agent.capabilities[1]}表现良好`,
      `建议关注${agent.capabilities[2]}`
    ]
  }))

  analysisResult.value = {
    stockCode: stockCode.value,
    recommendation: action,
    confidence,
    summary: `基于 ${activeAgents.value.length} 个智能体的综合分析，${stockCode.value} 展现出复合的投资特征。*注：这是本地分析模式*`,
    agentResults,
    timestamp: Date.now(),
    analysisId: `analysis_${Date.now()}`,
    isRealLLM: false, // 标记这是模拟分析
    aiProvider: '本地模拟', // AI提供商信息
    modelName: '本地算法', // 具体模型名称
    apiVersion: 'local' // API版本
  }

  // 设置第一个结果标签页为活跃
  if (agentResults.length > 0) {
    activeResultTab.value = agentResults[0].agentId
  }

  // 添加到历史记录
  analysisHistory.value.unshift({
    id: analysisResult.value.analysisId,
    stockCode: stockCode.value,
    timestamp: Date.now(),
    recommendation: action,
    confidence
  })

  // 限制历史记录数量
  if (analysisHistory.value.length > 20) {
    analysisHistory.value = analysisHistory.value.slice(0, 20)
  }
  
  // 分析完成后,小K自动打招呼
  await nextTick()
  addAssistantGreeting()
}

// 工具方法
const getRecommendationType = (recommendation) => {
  const recMap = {
    '强烈买入': 'success',
    '买入': 'primary',
    '持有': 'info',
    '卖出': 'warning',
    '强烈卖出': 'danger'
  }
  return recMap[recommendation] || 'info'
}

const getAgentTabLabel = (agentResult) => {
  const agent = agents.find(a => a.id === agentResult.agentId)
  return agentResult.agentName
}

const formatTime = (timestamp) => {
  return new Date(timestamp).toLocaleString('zh-CN')
}

// Convert URLs in plain text to clickable links (XSS-safe)
const linkifyContent = (text) => {
  if (!text) return ''
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
  const linked = escaped.replace(
    /(https?:\/\/[^\s<&"']+)/g,
    (url) => {
      // Encode the URL for safe href attribute insertion
      const safeUrl = url.replace(/&amp;/g, '&')
      let parsed
      try { parsed = new URL(safeUrl) } catch { return url } // skip malformed URLs
      // Strict protocol whitelist — block javascript:, data:, vbscript:, etc.
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return url
      const encoded = safeUrl.replace(/"/g, '%22').replace(/'/g, '%27')
      return `<a href="${encoded}" target="_blank" rel="noopener noreferrer">${url}</a>`
    }
  )
  // Defense-in-depth: sanitize output to prevent XSS even if escaping has a gap
  const div = document.createElement('div')
  div.innerHTML = linked
  // Only allow <a> with safe attributes and <br>
  div.querySelectorAll('*').forEach(el => {
    if (el.tagName === 'A') {
      const href = el.getAttribute('href')
      const allowed = ['href', 'target', 'rel']
      for (const attr of [...el.attributes]) {
        if (!allowed.includes(attr.name)) el.removeAttribute(attr.name)
      }
      if (href && !/^https?:\/\//i.test(href)) el.removeAttribute('href')
    } else if (el.tagName !== 'BR') {
      el.replaceWith(document.createTextNode(el.textContent))
    }
  })
  return div.innerHTML
}

// Dynamic model name from the most recent assistant message
const currentModelName = computed(() => {
  const lastAssistant = [...chatMessages.value].reverse().find(m => m.role === 'assistant')
  return lastAssistant?.model || '小K金融量化助手'
})

const loadHistoryRecord = (record) => {
  // 这里可以从后端加载完整的历史记录
  ElMessage.info(`加载历史记录: ${record.stockCode}`)
}

// 导出分析报告为 JSON 文件，方便离线查看或二次分析
const exportReport = () => {
  if (!analysisResult.value) {
    ElMessage.warning('请先进行分析再导出报告')
    return
  }
  
  try {
    const reportData = {
      ...analysisResult.value,
      exportTime: new Date().toISOString(),
      exportVersion: '1.0.0'
    }

    const blob = new Blob([JSON.stringify(reportData, null, 2)], {
      type: 'application/json'
    })
    
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `trading-analysis-${analysisResult.value.stockCode}-${Date.now()}.json`
    a.style.display = 'none' // 确保链接不可见
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)

    ElMessage.success('分析报告导出成功！')
  } catch (error) {
    console.error('导出报告失败:', error)
    ElMessage.error('导出报告失败，请稍后重试')
  }
}

// ========================= 位置持久化 =========================
// 将机器人坐标保存到 localStorage，刷新页面后恢复上次位置
const savePosition = () => {
  localStorage.setItem('tradingAgentsBotPosition', JSON.stringify(position.value))
}

const refreshViewportMode = () => {
  isMobileClient.value = window.innerWidth <= 767
}

// 加载保存的位置，移动端使用固定右下角定位
const loadPosition = () => {
  refreshViewportMode()

  if (isMobileClient.value) {
    position.value = {
      x: Math.max(10, window.innerWidth - 90),
      y: Math.max(10, window.innerHeight - 170)
    }
    return
  }

  const saved = localStorage.getItem('tradingAgentsBotPosition')
  if (saved) {
    try {
      const savedPosition = JSON.parse(saved)
      if (savedPosition.x >= 0 && savedPosition.x <= window.innerWidth - 80 &&
          savedPosition.y >= 0 && savedPosition.y <= window.innerHeight - 80) {
        position.value = savedPosition
      }
    } catch (error) {
      console.error('加载机器人位置失败:', error)
    }
  }
}

const resetPosition = () => {
  if (isMobileClient.value) {
    position.value = {
      x: Math.max(10, window.innerWidth - 90),
      y: Math.max(10, window.innerHeight - 170)
    }
  } else {
    position.value = { x: 20, y: 20 }
  }
  savePosition()
  ElMessage.success('位置已重置')
}

// ========================= 对话功能（小K问答） =========================
// 用户可在分析完成后与"小K"对话，追问技术面、风险等细节
const hasValidToken = computed(() => {
  return Object.values(tokenForm).some(token => token && token.trim().length > 0)
})

// 输入法组合状态
const isComposing = ref(false)

// 处理输入法开始
const handleCompositionStart = () => {
  isComposing.value = true
}

// 处理输入法结束
const handleCompositionEnd = () => {
  isComposing.value = false
}

// 分析完成后，小K自动发送一条问候消息，展示分析摘要并引导用户追问
const addAssistantGreeting = () => {
  if (!analysisResult.value) return
  
  const result = analysisResult.value
  const greetings = [
    `你好!我是小K 👋\n\n我已经完成了对 ${result.stockCode} 的深度分析。基于${result.agentResults.length}个智能体的综合研判,当前建议是"${result.recommendation}",置信度${result.confidence}%。\n\n有什么想了解的吗?我可以为您详细解读技术面、基本面、风险评估等各个方面~`,
    
    `您好!小K为您服务 😊\n\n${result.stockCode} 的分析报告已经生成!综合${result.agentResults.length}位智能体的专业意见,我们给出"${result.recommendation}"的投资建议,置信度达到${result.confidence}%。\n\n想深入了解哪个方面呢?技术指标、基本面、还是风险控制?`,
    
    `嗨!小K在这里 🤖\n\n刚刚完成了${result.stockCode}的全方位分析!${result.agentResults.length}个智能体团队一致认为应该"${result.recommendation}",我们对这个判断有${result.confidence}%的把握。\n\n有任何疑问随时问我,我会结合分析结果为您详细解答!`,
    
    `你好呀!我是您的量化助手小K ✨\n\n${result.stockCode}的智能分析已完成!经过${result.agentResults.length}个专业智能体的深度研判,当前投资建议是"${result.recommendation}",置信度${result.confidence}%。\n\n想了解具体的分析依据吗?或者有其他问题也可以问我~`
  ]
  
  const greeting = greetings[Math.floor(Math.random() * greetings.length)]
  
  chatMessages.value.push({
    role: 'assistant',
    content: greeting,
    timestamp: Date.now(),
    model: '小K金融量化助手'
  })
  
  // 滚动到底部
  nextTick(() => {
    if (chatMessagesRef.value) {
      chatMessagesRef.value.scrollTop = chatMessagesRef.value.scrollHeight
    }
  })
}

// 交易意图识别 —— 从用户消息中提取买入/卖出指令
// 支持中英文："买入 1000 600519" / "buy 1000 shares of 600519"
// 匹配成功返回 { action, symbol, quantity }，否则返回 null
function detectTradingIntent(text) {
  // Pattern: "buy 1000 shares of 600519" or "sell 500 600036"
  const buyMatch = text.match(/(?:buy|买入?|建仓)\s*(\d+)\s*(?:shares?|股|手)?\s*(?:of\s*)?(\w{6})/i)
  const sellMatch = text.match(/(?:sell|卖出?|平仓|减仓)\s*(\d+)\s*(?:shares?|股|手)?\s*(?:of\s*)?(\w{6})/i)
  if (buyMatch) return { action: 'buy', quantity: parseInt(buyMatch[1]), symbol: buyMatch[2] }
  if (sellMatch) return { action: 'sell', quantity: parseInt(sellMatch[1]), symbol: sellMatch[2] }
  // Pattern: "buy 600519 1000"
  const altBuy = text.match(/(?:buy|买入?)\s*(\w{6})\s+(\d+)/i)
  const altSell = text.match(/(?:sell|卖出?)\s*(\w{6})\s+(\d+)/i)
  if (altBuy) return { action: 'buy', symbol: altBuy[1], quantity: parseInt(altBuy[2]) }
  if (altSell) return { action: 'sell', symbol: altSell[1], quantity: parseInt(altSell[2]) }
  return null
}

// 发送聊天消息 —— 先检测交易意图，再通过 SSE 流式通道对话
// SSE 失败时降级到同步 /ai/chat，最终降级到 generatePredefinedAnswer
const sendChatMessage = async () => {
  if (!chatInput.value.trim() || isChatting.value || isStreaming.value || isComposing.value) return

  const userMessage = {
    role: 'user',
    content: chatInput.value.trim(),
    timestamp: Date.now()
  }

  chatMessages.value.push(userMessage)
  const question = chatInput.value
  chatInput.value = ''

  // Scroll to bottom
  nextTick(() => {
    if (chatMessagesRef.value) {
      chatMessagesRef.value.scrollTop = chatMessagesRef.value.scrollHeight
    }
  })

  // S17: Check for trading intent
  const tradingIntent = detectTradingIntent(question)
  if (tradingIntent) {
    isChatting.value = true
    try {
      const orderData = await request.post('/trading/order', {
        symbol: tradingIntent.symbol,
        direction: tradingIntent.action,
        quantity: tradingIntent.quantity,
        orderType: 'market'
      })
      chatMessages.value.push({
        role: 'assistant',
        content: orderData.success
          ? `Order executed: ${tradingIntent.action.toUpperCase()} ${tradingIntent.quantity} shares of ${tradingIntent.symbol} at ${orderData.data?.price?.toFixed(2) || 'market price'}. Order ID: ${orderData.data?.orderId || 'N/A'}`
          : `Order failed: ${orderData.message}`,
        timestamp: Date.now(),
        model: 'XiaoK Trading'
      })
    } catch (err) {
      chatMessages.value.push({
        role: 'assistant',
        content: `Trading error: ${err.message}`,
        timestamp: Date.now(),
        model: 'XiaoK Trading'
      })
    }
    isChatting.value = false
    nextTick(() => { if (chatMessagesRef.value) chatMessagesRef.value.scrollTop = chatMessagesRef.value.scrollHeight })
    return
  }

  // ── Primary: SSE streaming ──
  // Retrieve JWT from user store for authenticated SSE request
  let authToken = null
  try {
    const { useUserStore } = await import('@/stores/user')
    const userStore = useUserStore()
    authToken = userStore.token || localStorage.getItem('token')
  } catch { authToken = localStorage.getItem('token') }

  const conversationHistory = chatMessages.value
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .slice(-10)
    .map(m => ({ role: m.role, content: m.content }))

  const body = {
    question,
    stockCode: analysisResult.value?.stockCode || null,
    conversationHistory,
    tokens: hasValidToken.value ? tokenForm : null,
  }

  try {
    await sendStream(body, (result) => {
      if (result.error) {
        // SSE returned an error — fall through to sync fallback below
        throw new Error(result.error)
      }
      // Success: push the completed message
      chatMessages.value.push({
        role: 'assistant',
        content: result.content || streamContent.value,
        timestamp: Date.now(),
        model: result.model || streamModel.value || 'AI'
      })
      nextTick(() => {
        if (chatMessagesRef.value) chatMessagesRef.value.scrollTop = chatMessagesRef.value.scrollHeight
      })
    }, authToken)

    // If we reach here without error, streaming succeeded
    return
  } catch {
    // SSE failed — fall back to synchronous /ai/chat
  }

  // ── Fallback: synchronous POST /ai/chat ──
  isChatting.value = true
  try {
    const data = await request.post('/ai/chat', {
      stockCode: analysisResult.value?.stockCode,
      analysisContext: analysisResult.value,
      question: question,
      tokens: hasValidToken.value ? tokenForm : null,
      useLocalModel: !hasValidToken.value
    }, { timeout: 30000, silentError: true, silentLoading: true })

    if (data && (data.answer || data.message)) {
      chatMessages.value.push({
        role: 'assistant',
        content: data.answer || data.message || 'Sorry, I could not answer.',
        timestamp: Date.now(),
        model: data.model || 'XiaoK'
      })
    } else {
      const answer = analysisResult.value
        ? generatePredefinedAnswer(question, analysisResult.value)
        : 'Sorry, the AI service is currently unavailable.'
      chatMessages.value.push({ role: 'assistant', content: answer, timestamp: Date.now(), model: 'Predefined' })
    }
  } catch {
    const answer = analysisResult.value
      ? generatePredefinedAnswer(question, analysisResult.value)
      : 'Sorry, the AI service is currently unavailable.'
    chatMessages.value.push({ role: 'assistant', content: answer, timestamp: Date.now(), model: 'Predefined' })
  } finally {
    isChatting.value = false
    nextTick(() => {
      if (chatMessagesRef.value) chatMessagesRef.value.scrollTop = chatMessagesRef.value.scrollHeight
    })
  }
}

// 预定义问答 —— 后端AI不可用时的本地兜底，按关键词匹配返回对应智能体的分析
const generatePredefinedAnswer = (question, analysis) => {
  const q = question.toLowerCase()
  
  // 关于推荐的问题
  if (q.includes('推荐') || q.includes('建议') || q.includes('买') || q.includes('卖')) {
    return `根据分析结果,我的建议是${analysis.recommendation}。主要原因是:${analysis.summary}`
  }
  
  // 关于风险的问题
  if (q.includes('风险') || q.includes('危险') || q.includes('安全')) {
    const riskAgent = analysis.agentResults?.find(a => a.agentId === 'risk')
    if (riskAgent) {
      return `风险评估:${riskAgent.analysis}`
    }
    return `置信度为${analysis.confidence}%,建议谨慎操作,注意风险控制。`
  }
  
  // 关于技术面的问题
  if (q.includes('技术') || q.includes('指标') || q.includes('趋势')) {
    const marketAgent = analysis.agentResults?.find(a => a.agentId === 'market')
    if (marketAgent) {
      return `技术分析:${marketAgent.analysis}`
    }
    return `请查看市场分析师的详细技术分析报告。`
  }
  
  // 关于基本面的问题
  if (q.includes('基本面') || q.includes('财务') || q.includes('估值')) {
    const fundAgent = analysis.agentResults?.find(a => a.agentId === 'fundamentals')
    if (fundAgent) {
      return `基本面分析:${fundAgent.analysis}`
    }
    return `请查看基本面分析师的详细财务分析报告。`
  }
  
  // 默认回答
  return `关于${analysis.stockCode}的问题,建议您查看完整的分析报告。当前推荐:${analysis.recommendation},置信度:${analysis.confidence}%。`
}

// 显示拖拽提示
const showDragHintTemporary = () => {
  showDragHint.value = true
  setTimeout(() => {
    showDragHint.value = false
  }, 3000)
}

// ========================= Token 管理 =========================
// 用户可配置多个AI服务商的API密钥，存储于 localStorage（base64编码）
const openTokenManager = () => {
  loadTokens()
  tokenDialogVisible.value = true
  // Also check retrain status
  checkRetrainStatus()
}

// 模型重训练状态 —— 支持在Token管理面板中触发后端模型重新训练
const retrainStatus = ref({ status: 'idle' })
let retrainPollTimer = null

const triggerRetrain = async () => {
  try {
    const data = await request.post('/trading-agents/retrain', { days: 365, skipDistill: true })
    if (data.success) {
      retrainStatus.value = data.data
      ElMessage.success('Model retraining started')
      startRetrainPolling()
    } else {
      ElMessage.warning(data.message || 'Retrain already in progress')
      if (data.job) retrainStatus.value = data.job
    }
  } catch (err) {
    ElMessage.error('Failed to start retraining: ' + err.message)
  }
}

const checkRetrainStatus = async () => {
  try {
    const data = await request.get('/trading-agents/retrain-status', { silentLoading: true, silentError: true })
    if (data.success) {
      retrainStatus.value = data.data
      if (data.data.status === 'running') startRetrainPolling()
    }
  } catch (err) {
    // Silently ignore
  }
}

const startRetrainPolling = () => {
  if (retrainPollTimer) return
  retrainPollTimer = setInterval(async () => {
    await checkRetrainStatus()
    if (retrainStatus.value.status !== 'running') {
      clearInterval(retrainPollTimer)
      retrainPollTimer = null
      if (retrainStatus.value.status === 'completed') {
        ElMessage.success('Model retraining completed!')
      }
    }
  }, 3000)
}

const getProviderName = (key) => {
  const names = {
    openai: 'OpenAI',
    anthropic: 'Anthropic',
    google: 'Google',
    huggingface: 'Hugging Face',
    finlight: 'Finlight',
    baidu: '百度',
    alibaba: '阿里',
    xunfei: '讯飞',
    zhipu: '智谱'
  }
  return names[key] || key
}

const loadTokens = async () => {
  try {
    const saved = localStorage.getItem('aiTokens')
    if (saved) {
      let tokens
      if (saved.includes('.')) {
        // AES-GCM encrypted format
        const { decryptFromStorage } = await import('@/utils/localEncrypt')
        tokens = await decryptFromStorage(saved)
      } else {
        // Migration from base64
        tokens = JSON.parse(atob(saved))
      }
      Object.assign(tokenForm, tokens)
    }
  } catch (error) {
    console.error('加载Token失败:', error)
  }
}

const saveTokens = async () => {
  try {
    const { encryptForStorage } = await import('@/utils/localEncrypt')
    const encrypted = await encryptForStorage(tokenForm)
    localStorage.setItem('aiTokens', encrypted)

    ElMessage.success('Token配置已保存')
    tokenDialogVisible.value = false
  } catch (error) {
    console.error('保存Token失败:', error)
    ElMessage.error('保存失败，请重试')
  }
}

// 测试Token是否可用
const testToken = async (tokenType) => {
  const token = tokenForm[tokenType]
  
  if (!token || token.trim() === '') {
    ElMessage.warning('请先输入Token')
    return
  }
  
  testingToken.value = tokenType
  
  try {
    const tokenNames = {
      openai: 'OpenAI',
      anthropic: 'Anthropic Claude',
      google: 'Google Gemini',
      huggingface: 'Hugging Face',
      finlight: 'Finlight 新闻',
      baidu: '百度文心一言',
      alibaba: '阿里通义千问',
      xunfei: '讯飞星火',
      zhipu: '智谱AI'
    }
    
    // 根据不同的token类型调用不同的API进行测试
    let testResult = false
    let errorMessage = ''
    
    switch (tokenType) {
      case 'huggingface':
        // 测试Hugging Face token
        try {
          const response = await fetch('https://huggingface.co/api/whoami-v2', {
            headers: {
              'Authorization': `Bearer ${token}`
            }
          })
          testResult = response.ok
          if (!testResult) {
            const data = await response.json()
            errorMessage = data.error || '验证失败'
          }
        } catch (error) {
          errorMessage = error.message
        }
        break
        
      case 'openai':
        // 测试OpenAI token
        try {
          const response = await fetch('https://api.openai.com/v1/models', {
            headers: {
              'Authorization': `Bearer ${token}`
            }
          })
          testResult = response.ok
          if (!testResult) {
            const data = await response.json()
            errorMessage = data.error?.message || '验证失败'
          }
        } catch (error) {
          errorMessage = error.message
        }
        break
        
      case 'anthropic':
        // 测试Anthropic token (简单验证格式)
        testResult = token.startsWith('sk-ant-')
        if (!testResult) {
          errorMessage = 'Token格式不正确，应以sk-ant-开头'
        }
        break
        
      case 'google':
        // 测试Google Gemini token (简单验证格式)
        testResult = token.startsWith('AIza')
        if (!testResult) {
          errorMessage = 'Token格式不正确，应以AIza开头'
        }
        break

      case 'finlight':
        // Test Finlight.me API key by making a real request
        try {
          const response = await fetch('https://api.finlight.me/v2/articles', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-API-KEY': token,
            },
            body: JSON.stringify({ query: 'stock market', limit: 1 })
          })
          testResult = response.ok
          if (!testResult) {
            const data = await response.json().catch(() => ({}))
            errorMessage = data.message || data.error || `HTTP ${response.status}`
          }
        } catch (error) {
          errorMessage = error.message
        }
        break

      default:
        // 其他token暂时只验证是否为空
        testResult = token.length > 10
        if (!testResult) {
          errorMessage = 'Token长度不足'
        }
    }
    
    if (testResult) {
      ElMessage.success(`${tokenNames[tokenType]} Token验证成功！`)
    } else {
      ElMessage.error(`${tokenNames[tokenType]} Token验证失败：${errorMessage}`)
    }
  } catch (error) {
    console.error('测试Token失败:', error)
    ElMessage.error(`测试失败：${error.message}`)
  } finally {
    testingToken.value = ''
  }
}

const clearAllTokens = () => {
  ElMessageBox.confirm(
    '确定要清除所有Token配置吗？此操作不可恢复。',
    '警告',
    {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning'
    }
  ).then(() => {
    Object.keys(tokenForm).forEach(key => {
      tokenForm[key] = ''
    })
    localStorage.removeItem('aiTokens')
    ElMessage.success('已清除所有Token')
  }).catch(() => {
    // 用户取消
  })
}

// ========================= 生命周期与全局事件 =========================
// 通过 window 自定义事件实现跨组件通信（Trading.vue 可触发显示/隐藏）
const handleShowAssistant = () => {
  isVisible.value = true
  saveVisibilityState()
  setTimeout(() => {
    isExpanded.value = true
  }, 300)
}

const handleHideAssistant = () => {
  isVisible.value = false
  isExpanded.value = false
  saveVisibilityState()
}

const handleViewportResize = () => {
  refreshViewportMode()

  const maxX = window.innerWidth - 80
  const maxY = window.innerHeight - 80

  if (position.value.x > maxX || position.value.y > maxY) {
    position.value = {
      x: Math.min(position.value.x, maxX),
      y: Math.min(position.value.y, maxY)
    }
    savePosition()
  }
}

// Bind copy-button click handlers after DOM updates (markdown code blocks)
onUpdated(() => {
  attachCopyListeners(chatMessagesRef.value)
})

// 组件挂载：恢复位置 → 加载Token → 注册全局事件监听 → 显示拖拽提示
onMounted(() => {
  loadPosition()

  // 加载已保存的tokens
  loadTokens()

  // 监听全局事件，用于从其他页面（如Trading.vue）显示/隐藏AI助手
  window.addEventListener('show-ai-assistant', handleShowAssistant)
  window.addEventListener('hide-ai-assistant', handleHideAssistant)

  window.addEventListener('resize', handleViewportResize)

  // 3秒后显示拖拽提示，引导用户拖动机器人
  setTimeout(showDragHintTemporary, 3000)
})

// 组件卸载：清理所有事件监听器，防止内存泄漏
onUnmounted(() => {
  document.removeEventListener('mousemove', onDrag)
  document.removeEventListener('mouseup', stopDrag)
  document.removeEventListener('touchmove', onDragTouch)
  document.removeEventListener('touchend', stopDrag)
  window.removeEventListener('show-ai-assistant', handleShowAssistant)
  window.removeEventListener('hide-ai-assistant', handleHideAssistant)
  window.removeEventListener('resize', handleViewportResize)
  if (retrainPollTimer) {
    clearInterval(retrainPollTimer)
    retrainPollTimer = null
  }
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
})
</script>

<style scoped>
.trading-agents-bot {
  position: fixed;
  z-index: 50;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  transition: all 0.3s ease;
}

/* 机器人头像 - 整合智能体文件夹的样式 */
.bot-avatar {
  width: 80px;
  height: 80px;
  background: linear-gradient(135deg, #1a1a1a 0%, #2d2d2d 100%);
  border: 4px solid #FFD700;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: grab;
  box-shadow: 0 8px 32px rgba(255, 215, 0, 0.3);
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  position: relative;
  overflow: visible;
  user-select: none;
}

.bot-avatar:hover {
  transform: scale(1.05);
  box-shadow: 0 12px 40px rgba(255, 215, 0, 0.4);
  border-color: #FFC700;
}

.bot-avatar:active,
.bot-avatar.dragging {
  cursor: grabbing;
  transform: scale(1.1);
  box-shadow: 0 16px 48px rgba(255, 215, 0, 0.5);
  border-color: #FFED4E;
}

.bot-avatar.expanded {
  background: linear-gradient(135deg, #2d2d2d 0%, #1a1a1a 100%);
  border-color: #FFD700;
}

.bot-avatar.thinking {
  animation: analyzing-pulse 2s infinite;
}

.robot-face {
  font-size: 32px;
  filter: drop-shadow(0 2px 4px rgba(0,0,0,0.3));
  pointer-events: none;
}

.robot-face-image {
  width: 60px;
  height: 60px;
  border-radius: 50%;
  object-fit: cover;
  filter: drop-shadow(0 2px 4px rgba(0,0,0,0.3));
  pointer-events: none;
}

.status-ring {
  position: absolute;
  top: -5px;
  right: -5px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: 3px solid white;
  pointer-events: none;
}

.status-ring.idle { background: #95a5a6; }
.status-ring.analyzing { 
  background: #f39c12; 
  animation: pulse 1.5s infinite;
}
.status-ring.completed { background: #27ae60; }

.pulse-ring {
  position: absolute;
  top: -3px;
  left: -3px;
  right: -3px;
  bottom: -3px;
  border-radius: 50%;
  border: 2px solid currentColor;
  opacity: 0;
}

.status-ring.analyzing .pulse-ring {
  animation: pulse-ring 1.5s infinite;
}

.agent-count {
  position: absolute;
  bottom: -8px;
  right: -8px;
  background: #e74c3c;
  color: white;
  border-radius: 50%;
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: bold;
  border: 2px solid white;
}

.robot-tooltip {
  position: absolute;
  top: -45px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(0,0,0,0.8);
  color: white;
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 12px;
  white-space: nowrap;
  opacity: 0;
  transition: opacity 0.3s;
  pointer-events: none;
}

.robot-tooltip::after {
  content: '';
  position: absolute;
  top: 100%;
  left: 50%;
  transform: translateX(-50%);
  border: 5px solid transparent;
  border-top-color: rgba(0,0,0,0.8);
}

.bot-avatar:hover .robot-tooltip {
  opacity: 1;
}

/* 分析面板 - 整合智能体文件夹的高级面板样式 */
.analysis-panel {
  position: absolute;
  width: 450px;
  max-height: 80vh;
  background: white;
  border-radius: var(--radius-lg);
  box-shadow: 0 16px 64px rgba(0,0,0,0.2);
  overflow: visible;
  z-index: 51;
  border: 1px solid #e1e8ed;
  display: flex;
  flex-direction: column;
}

/* 面板内容区域（可滚动） */
.panel-content {
  flex: 1;
  overflow-y: auto;
  max-height: calc(80vh - 120px); /* 减去头部和底部的高度 */
}

.panel-content::-webkit-scrollbar {
  width: 6px;
}

.panel-content::-webkit-scrollbar-track {
  background: #f1f1f1;
  border-radius: 3px;
}

.panel-content::-webkit-scrollbar-thumb {
  background: #c1c1c1;
  border-radius: 3px;
}

.panel-content::-webkit-scrollbar-thumb:hover {
  background: #a8a8a8;
}

.panel-header {
  background: linear-gradient(135deg, 
    #C71585 0%,    /* 深粉红 */
    #D2691E 15%,   /* 深橙色 */
    #B8860B 30%,   /* 深金色 */
    #228B22 45%,   /* 森林绿 */
    #008B8B 60%,   /* 深青色 */
    #4169E1 75%,   /* 皇家蓝 */
    #6A5ACD 90%,   /* 石板蓝 */
    #8B008B 100%   /* 深洋红 */
  );
  background-size: 200% 200%;
  animation: rainbow-flow 8s ease infinite;
  color: white;
  padding: 20px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

@keyframes rainbow-flow {
  0% { background-position: 0% 50%; }
  50% { background-position: 100% 50%; }
  100% { background-position: 0% 50%; }
}

.header-left h3 {
  margin: 0 0 4px 0;
  font-size: 18px;
  font-weight: 600;
}

.team-status {
  font-size: 12px;
  opacity: 0.9;
}

.header-actions {
  display: flex;
  gap: 8px;
}

/* 股票输入区域 */
.stock-input-section {
  padding: 20px;
  border-bottom: 1px solid #f0f0f0;
}

.input-group {
  margin-bottom: 16px;
}

.quick-select {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.quick-label {
  font-size: 12px;
  color: #666;
  white-space: nowrap;
}

.stock-tag {
  cursor: pointer;
  transition: all 0.2s;
}

.stock-tag:hover {
  transform: translateY(-1px);
  box-shadow: 0 2px 8px rgba(0,0,0,0.1);
}

/* 智能体区域 */
.agents-section {
  padding: 20px;
  border-bottom: 1px solid #f0f0f0;
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.section-header h4 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: #333;
}

.overall-progress {
  width: 120px;
}

.agents-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
}

.agent-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border-radius: 8px;
  background: #f8f9fa;
  border: 2px solid transparent;
  cursor: pointer;
  transition: all 0.2s ease;
}

.agent-card:hover {
  background: #e9ecef;
  transform: translateY(-1px);
  box-shadow: 0 2px 8px rgba(0,0,0,0.1);
}

.agent-card.active {
  background: #e8f5e8;
  border-color: #b3d8b3;
}

.agent-card.analyzing {
  background: #fff3cd;
  border-color: #ffeaa7;
  animation: pulse 2s infinite;
}

.agent-card.completed {
  background: #d4edda;
  border-color: #c3e6cb;
  cursor: pointer;
  transition: all 0.2s ease;
}

.agent-card.completed:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0,0,0,0.15);
}

.agent-card.completed:not(.active) {
  border-color: #dcdfe6;
  background: #f5f7fa;
  opacity: 0.85;
}

.agent-card.error {
  background: #f8d7da;
  border-color: #f5c6cb;
}

.agent-avatar {
  position: relative;
  width: 40px;
  height: 40px;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 2px 8px rgba(0,0,0,0.1);
  transition: all 0.3s ease;
}

.agent-card:hover .agent-avatar {
  transform: scale(1.1);
  box-shadow: 0 4px 12px rgba(102, 126, 234, 0.3);
}

.agent-card.active .agent-avatar {
  background: linear-gradient(135deg, #11998e 0%, #38ef7d 100%);
}

.agent-card.analyzing .agent-avatar {
  background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
  animation: pulse 2s infinite;
}

.agent-card.completed .agent-avatar {
  background: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%);
}

.agent-icon {
  width: 32px;
  height: 32px;
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
}

.agent-icon svg {
  width: 100%;
  height: 100%;
  filter: drop-shadow(0 1px 2px rgba(0,0,0,0.2));
}

.agent-status-dot {
  position: absolute;
  bottom: -2px;
  right: -2px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 2px solid white;
}

.agent-status-dot.idle { background: #95a5a6; }
.agent-status-dot.analyzing { background: #f39c12; }
.agent-status-dot.completed { background: #27ae60; }
.agent-status-dot.error { background: #e74c3c; }

.agent-info {
  flex: 1;
  min-width: 0;
}

.agent-header-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 2px;
}

.agent-name {
  font-size: 13px;
  font-weight: 600;
  color: #333;
}

.algorithm-badge {
  display: inline-block;
  padding: 2px 6px;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  border-radius: var(--radius-md);
  font-size: 10px;
  font-weight: 500;
  white-space: nowrap;
}

.agent-description {
  font-size: 11px;
  color: #666;
  line-height: 1.3;
  margin-bottom: 4px;
}

.algorithm-description {
  font-size: 10px;
  color: #666;
  margin-top: 4px;
  padding: 4px 6px;
  background: rgba(102, 126, 234, 0.08);
  border-radius: 4px;
  border-left: 2px solid #667eea;
  line-height: 1.4;
}

.agent-progress {
  margin-top: 4px;
}

/* 分析结果区域 */
.results-section {
  padding: 20px;
  border-bottom: 1px solid #f0f0f0;
  max-height: 400px;
  overflow-y: auto;
}

.result-summary {
  margin-bottom: 20px;
  padding: 16px;
  background: linear-gradient(135deg, #e3f2fd 0%, #f3e5f5 100%);
  border-radius: var(--radius-md);
  border: 1px solid #e1f5fe;
}

.result-summary h4 {
  margin: 0 0 8px 0;
  font-size: 16px;
  color: #1565c0;
}

.result-meta {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-bottom: 8px;
  flex-wrap: wrap;
}

.confidence {
  font-size: 12px;
  color: #666;
}

.ai-provider-info {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

.model-info {
  font-size: 11px;
  color: #666;
  font-family: 'Consolas', 'Monaco', monospace;
}

.ai-details {
  margin-top: 12px;
  padding: 8px 12px;
  background: rgba(255, 255, 255, 0.7);
  border-radius: 6px;
  border: 1px solid #e3f2fd;
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
}

.ai-detail-item {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
}

.ai-detail-item .label {
  color: #666;
  font-weight: 500;
}

.ai-detail-item .value {
  color: #333;
  font-family: 'Consolas', 'Monaco', monospace;
  background: rgba(102, 126, 234, 0.1);
  padding: 2px 6px;
  border-radius: 3px;
}

.result-summary-text {
  font-size: 13px;
  color: #424242;
  line-height: 1.5;
}

.agent-result-content {
  padding: 16px 0;
}

.agent-analysis {
  font-size: 13px;
  line-height: 1.6;
  color: #495057;
  margin-bottom: 16px;
}

.key-findings h6 {
  margin: 0 0 8px 0;
  font-size: 12px;
  font-weight: 600;
  color: #495057;
}

.key-findings ul {
  margin: 0;
  padding-left: 16px;
}

.key-findings li {
  font-size: 12px;
  color: #6c757d;
  margin-bottom: 4px;
}

/* 对话模式区域 */
.chat-section {
  padding: 20px;
  border-bottom: 1px solid #f0f0f0;
  background: #fafafa;
}

.chat-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.chat-header h5 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: #1f2937;
}

.chat-messages {
  max-height: 300px;
  overflow-y: auto;
  margin-bottom: 16px;
  padding: 12px;
  background: white;
  border-radius: 8px;
  border: 1px solid #e5e7eb;
}

.chat-message {
  margin-bottom: 12px;
  display: flex;
  flex-direction: column;
}

.chat-message.user {
  align-items: flex-end;
}

.chat-message.assistant {
  align-items: flex-start;
}

.message-content {
  max-width: 80%;
  padding: 10px 14px;
  border-radius: var(--radius-md);
  font-size: 14px;
  line-height: 1.5;
  word-wrap: break-word;
}

.chat-message.user .message-content {
  background: #95ec69;  /* 微信绿色 */
  color: #000000;  /* 黑色文字 */
}

.chat-message.assistant .message-content {
  background: #f3f4f6;
  color: #1f2937;
}

.message-content.typing {
  display: flex;
  gap: 4px;
  padding: 10px 20px;
}

.message-content.typing span {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #9ca3af;
  animation: typing 1.4s infinite;
}

.message-content.typing span:nth-child(2) {
  animation-delay: 0.2s;
}

.message-content.typing span:nth-child(3) {
  animation-delay: 0.4s;
}

@keyframes typing {
  0%, 60%, 100% {
    transform: translateY(0);
  }
  30% {
    transform: translateY(-10px);
  }
}

.message-time {
  font-size: 11px;
  color: #9ca3af;
  margin-top: 4px;
  padding: 0 4px;
}

.message-model {
  font-size: 11px;
  color: #909399;
  margin-top: 2px;
  padding: 0 4px;
}

/* Streaming animation */
.streaming .message-content {
  border-left: 3px solid var(--el-color-primary, #409eff);
  padding-left: 12px;
}

.streaming-cursor {
  display: inline-block;
  width: 8px;
  height: 16px;
  background: var(--el-color-primary, #409eff);
  margin-left: 2px;
  animation: cursor-blink 1s step-end infinite;
  vertical-align: text-bottom;
}

@keyframes cursor-blink {
  50% { opacity: 0; }
}

.thinking-block {
  margin-bottom: 8px;
  padding: 8px 12px;
  background: #f0f5ff;
  border-radius: 6px;
  border-left: 3px solid #8b5cf6;
}

.thinking-label {
  font-size: 11px;
  font-weight: 600;
  color: #8b5cf6;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.thinking-text {
  font-size: 12px;
  color: #6b7280;
  margin-top: 4px;
  line-height: 1.4;
  font-style: italic;
}

.message-content a {
  color: #409eff;
  text-decoration: underline;
  word-break: break-all;
}

.chat-input-area {
  display: flex;
  gap: 10px;
  align-items: flex-end;
}

.chat-input-area .el-textarea {
  flex: 1;
}

/* 历史记录 */
.history-section {
  padding: 20px;
}

.history-list {
  max-height: 200px;
  overflow-y: auto;
}

.history-item {
  padding: 12px;
  border-bottom: 1px solid #f0f0f0;
  cursor: pointer;
  transition: background-color 0.2s;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.history-item:hover {
  background-color: #f8f9fa;
}

.history-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.stock-code {
  font-weight: 600;
  color: #333;
  font-size: 14px;
}

.analysis-time {
  font-size: 11px;
  color: #666;
}

/* 面板底部 */
.panel-footer {
  background: #f8f9fa;
  padding: 16px 20px;
  border-top: 1px solid #dee2e6;
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-shrink: 0; /* 防止被压缩 */
  border-bottom-left-radius: 16px;
  border-bottom-right-radius: 16px;
}

.footer-info {
  font-size: 12px;
  color: #6c757d;
}

.footer-actions {
  display: flex;
  gap: 8px;
}

.footer-actions .el-button {
  min-width: 80px;
  pointer-events: auto;
}

.footer-actions .el-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.analysis-status {
  font-size: 11px;
  color: #28a745;
  margin-left: 8px;
}

/* 动画效果 */
@keyframes analyzing-pulse {
  0%, 100% { 
    box-shadow: 0 8px 32px rgba(102, 126, 234, 0.3);
  }
  50% { 
    box-shadow: 0 8px 32px rgba(102, 126, 234, 0.6);
  }
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.7; }
}

@keyframes pulse-ring {
  0% {
    opacity: 1;
    transform: scale(1);
  }
  100% {
    opacity: 0;
    transform: scale(1.5);
  }
}

.panel-slide-enter-active,
.panel-slide-leave-active {
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.panel-slide-enter-from {
  opacity: 0;
  transform: translateX(-20px) scale(0.95);
}

.panel-slide-leave-to {
  opacity: 0;
  transform: translateX(-20px) scale(0.95);
}

/* 响应式设计 */
@media (max-width: 768px) {
  .analysis-panel {
    width: calc(100vw - 20px);
    max-width: 400px;
  }
  
  .agents-grid {
    grid-template-columns: 1fr;
  }
  
  .bot-avatar {
    width: 60px;
    height: 60px;
  }
  
  .robot-face {
    font-size: 24px;
  }
}

/* 防止拖拽时选中文本 */
.trading-agents-bot * {
  -webkit-user-drag: none;
  -khtml-user-drag: none;
  -moz-user-drag: none;
  -o-user-drag: none;
  user-drag: none;
}

/* Token管理对话框样式 */
.token-manager {
  padding: 10px 0;
}

.token-input-with-test {
  display: flex;
  align-items: center;
  width: 100%;
}

.token-hint {
  font-size: 12px;
  color: #909399;
  margin-top: 4px;
  line-height: 1.4;
}

.token-link {
  font-size: 12px;
  margin-top: 2px;
}

.token-link a {
  color: #409eff;
  text-decoration: none;
}

.token-link a:hover {
  text-decoration: underline;
}

.token-status {
  margin-top: 24px;
}

.status-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
  margin-top: 12px;
}

.status-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  background: #f5f7fa;
  border-radius: 6px;
}

.provider-name {
  font-size: 13px;
  color: #606266;
  font-weight: 500;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.header-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.header-actions .el-button--primary {
  background: rgba(255, 255, 255, 0.2);
  border-color: rgba(255, 255, 255, 0.3);
  color: white;
}

.header-actions .el-button--primary:hover {
  background: rgba(255, 255, 255, 0.3);
  border-color: rgba(255, 255, 255, 0.4);
}

/* ===== MOBILE: Full-screen overlay when expanded ===== */
@media (max-width: 767px) {
  /* 移动端保留悬浮头像，避免“呼叫后看不见” */
  .trading-agents-bot:not(.expanded) {
    display: block !important;
  }

  /* Full-screen overlay when expanded */
  .trading-agents-bot.expanded {
    position: fixed !important;
    inset: 0 !important;
    width: 100% !important;
    height: 100% !important;
    height: 100dvh !important;
    z-index: 2000 !important;
    display: flex !important;
    flex-direction: column;
  }

  .trading-agents-bot.expanded .bot-avatar {
    display: none;
  }

  .trading-agents-bot.expanded .analysis-panel {
    position: static !important;
    width: 100% !important;
    height: 100% !important;
    max-height: none !important;
    border-radius: 0 !important;
    display: flex;
    flex-direction: column;
  }

  /* Panel header */
  .trading-agents-bot.expanded .panel-header {
    padding: 12px 16px;
    padding-top: calc(12px + env(safe-area-inset-top));
    flex-shrink: 0;
  }

  .trading-agents-bot.expanded .panel-header h3 {
    font-size: 17px;
  }

  /* Close button as 44x44 tap target */
  .trading-agents-bot.expanded .header-actions .el-button {
    min-width: 44px;
    min-height: 44px;
  }

  /* Scrollable content */
  .trading-agents-bot.expanded .panel-content {
    flex: 1;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    padding: 12px 16px;
    min-height: 0;
  }

  /* Stock input full-width */
  .trading-agents-bot.expanded .stock-input-section {
    margin-bottom: 12px;
  }

  .trading-agents-bot.expanded .input-group {
    width: 100%;
  }

  /* Quick select chips horizontal scroll */
  .trading-agents-bot.expanded .quick-select {
    display: flex;
    overflow-x: auto;
    gap: 6px;
    padding-bottom: 4px;
    scrollbar-width: none;
    flex-wrap: nowrap;
  }
  .trading-agents-bot.expanded .quick-select::-webkit-scrollbar { display: none; }

  .trading-agents-bot.expanded .stock-tag {
    flex-shrink: 0;
    min-height: 36px;
    padding: 6px 14px;
    touch-action: manipulation;
  }

  /* Agent cards 2-column on mobile */
  .trading-agents-bot.expanded .agents-grid {
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }

  .trading-agents-bot.expanded .agent-card {
    padding: 10px;
    min-height: 44px;
  }

  /* Chat messages full-width */
  .trading-agents-bot.expanded .chat-messages {
    padding: 8px;
  }

  .trading-agents-bot.expanded .chat-message {
    max-width: 90%;
    padding: 10px 14px;
    font-size: 14px;
  }

  /* Fixed bottom chat input */
  .trading-agents-bot.expanded .chat-input-section {
    position: sticky;
    bottom: 0;
    background: inherit;
    padding: 10px 16px;
    padding-bottom: calc(10px + env(safe-area-inset-bottom));
    border-top: 1px solid rgba(255, 255, 255, 0.1);
    flex-shrink: 0;
  }

  /* Send button 48px */
  .trading-agents-bot.expanded .chat-input-section .el-button {
    min-width: 48px;
    min-height: 48px;
  }

  /* Analysis result cards full width */
  .trading-agents-bot.expanded .analysis-result .result-card {
    width: 100%;
  }

  /* Touch optimization */
  .trading-agents-bot.expanded * {
    touch-action: manipulation;
  }

  .trading-agents-bot.expanded .el-button {
    min-height: 44px;
  }

  /* Trade suggestion cards */
  .trading-agents-bot.expanded .trade-suggestion {
    width: 100%;
    padding: 12px 16px;
    border-radius: var(--radius-md);
  }

  .trading-agents-bot.expanded .trade-suggestion .confirm-btn {
    width: 100%;
    min-height: 48px;
    font-size: 15px;
    font-weight: 600;
  }
}
</style>

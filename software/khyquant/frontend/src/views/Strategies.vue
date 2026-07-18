<template>
  <div class="strategies-page">
    <!-- 策略列表 -->
    <el-card class="strategy-list-card">
      <template #header>
        <div class="card-header">
          <span>我的策略</span>
          <div class="header-actions">
            <el-button type="primary" @click="showCreateDialog = true">
              <el-icon><Plus /></el-icon>
              创建策略
            </el-button>
            <el-button @click="showTemplateDialog = true">
              <el-icon><Document /></el-icon>
              使用模板
            </el-button>
          </div>
        </div>
      </template>
      
      <!-- 🔥 批量操作工具栏 -->
      <div v-if="selectedStrategyIds.length > 0" class="batch-toolbar">
        <div class="batch-info">
          <span>已选择 <strong>{{ selectedStrategyIds.length }}</strong> 项</span>
        </div>
        <div class="batch-actions">
          <el-button type="danger" size="small" @click="handleBatchDelete">
            <el-icon><Delete /></el-icon>
            批量删除
          </el-button>
          <el-button type="success" size="small" @click="handleBatchToggleStatus('active')">
            <el-icon><VideoPlay /></el-icon>
            批量启用
          </el-button>
          <el-button type="warning" size="small" @click="handleBatchToggleStatus('paused')">
            <el-icon><VideoPause /></el-icon>
            批量暂停
          </el-button>
          <el-button type="primary" size="small" @click="handleBatchExport">
            <el-icon><Download /></el-icon>
            批量导出
          </el-button>
          <el-button size="small" @click="handleBatchCopy">
            <el-icon><CopyDocument /></el-icon>
            批量复制
          </el-button>
          <el-button size="small" @click="clearSelection">
            <el-icon><Close /></el-icon>
            取消选择
          </el-button>
        </div>
      </div>

      <!-- ===== MOBILE CARD LIST ===== -->
      <div v-if="isMobileView" class="m-strategy-cards" v-loading="loading">
        <div
          v-for="row in strategyStore.strategies"
          :key="row.id"
          class="m-strategy-card"
          @click="viewStrategy(row)"
        >
          <div class="m-card-top">
            <span class="m-card-name">{{ row.name }}</span>
            <el-tag :type="getStatusColor(row.status)" size="small">{{ getStatusName(row.status) }}</el-tag>
          </div>
          <div class="m-card-desc">{{ row.description || 'No description' }}</div>
          <div class="m-card-meta">
            <el-tag :type="getTypeColor(row.type)" size="small">{{ getTypeName(row.type) }}</el-tag>
            <el-tag :type="getLanguageColor(row.language)" size="small">{{ getLanguageName(row.language) }}</el-tag>
            <span class="m-card-date">{{ formatDate(row.createdAt) }}</span>
          </div>
          <div class="m-card-actions" @click.stop>
            <button class="m-action-btn" @click="backtestStrategy(row)">Backtest</button>
            <button class="m-action-btn" @click="editStrategy(row)">Edit</button>
            <button class="m-action-btn danger" @click="handleDeleteStrategy(row)">Delete</button>
          </div>
        </div>
        <div v-if="!loading && strategyStore.strategies.length === 0" class="m-empty">
          <p>No strategies yet</p>
          <p style="color: #999; font-size: 13px;">Tap "Create Strategy" to start</p>
        </div>
      </div>

      <!-- ===== DESKTOP TABLE ===== -->
      <el-table
        v-if="!isMobileView"
        v-loading="loading"
        :data="strategyStore.strategies"
        style="width: 100%"
        @row-click="handleRowClick"
        @selection-change="handleSelectionChange"
        ref="strategyTable"
      >
        <!-- 🔥 添加选择列 -->
        <el-table-column type="selection" width="55" />
        <el-table-column prop="name" label="策略名称" width="200" />
        <el-table-column prop="description" label="描述" show-overflow-tooltip />
        <el-table-column prop="type" label="类型" width="120">
          <template #default="{ row }">
            <el-tag :type="getTypeColor(row.type)">{{ getTypeName(row.type) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="language" label="语言" width="100">
          <template #default="{ row }">
            <el-tag :type="getLanguageColor(row.language)">{{ getLanguageName(row.language) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="status" label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="getStatusColor(row.status)">{{ getStatusName(row.status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="createdAt" label="创建时间" width="180">
          <template #default="{ row }">
            {{ formatDate(row.createdAt) }}
          </template>
        </el-table-column>
        <el-table-column label="操作" width="280" fixed="right">
          <template #default="{ row }">
            <!-- 桌面端：显示所有按钮 -->
            <div class="desktop-actions">
              <el-button link type="primary" @click.stop="viewStrategy(row)">
                <el-icon><View /></el-icon>
                查看
              </el-button>
              <el-button link type="success" @click.stop="backtestStrategy(row)">
                <el-icon><TrendCharts /></el-icon>
                回测
              </el-button>
              <el-button link type="primary" @click.stop="editStrategy(row)">
                <el-icon><Edit /></el-icon>
                编辑
              </el-button>
              <el-button link type="danger" @click.stop="handleDeleteStrategy(row)">
                <el-icon><Delete /></el-icon>
                删除
              </el-button>
            </div>
            
            <!-- 移动端：显示下拉菜单 -->
            <div class="mobile-actions">
              <el-dropdown @command="(command) => handleMobileAction(command, row)">
                <el-button type="primary" size="small">
                  <el-icon><MoreFilled /></el-icon>
                </el-button>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item command="view">
                      <el-icon><View /></el-icon>
                      查看
                    </el-dropdown-item>
                    <el-dropdown-item command="backtest">
                      <el-icon><TrendCharts /></el-icon>
                      回测
                    </el-dropdown-item>
                    <el-dropdown-item command="edit">
                      <el-icon><Edit /></el-icon>
                      编辑
                    </el-dropdown-item>
                    <el-dropdown-item command="delete" divided>
                      <el-icon><Delete /></el-icon>
                      删除
                    </el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
            </div>
          </template>
        </el-table-column>
      </el-table>

      <!-- 空状态 -->
      <div v-if="!loading && strategyStore.strategies.length === 0" class="empty-state">
        <div class="empty-state-custom">
          <img src="/empty-state.jpg" alt="暂无数据" class="empty-image" />
          <p class="empty-text">暂无策略数据</p>
          <p class="empty-description">点击上方"创建策略"按钮开始创建您的第一个量化策略</p>
        </div>
      </div>

      <el-pagination
        v-if="total > 0"
        v-model:current-page="currentPage"
        v-model:page-size="pageSize"
        :total="total"
        :page-sizes="[10, 20, 50, 100]"
        layout="total, sizes, prev, pager, next, jumper"
        @size-change="loadStrategies"
        @current-change="loadStrategies"
        style="margin-top: 20px; justify-content: flex-end"
      />
    </el-card>

    <!-- 创建/编辑策略对话框 -->
    <el-dialog
      v-model="showCreateDialog"
      :title="editingStrategy ? '编辑策略' : '创建策略'"
      width="80%"
      :close-on-click-modal="false"
    >
      <el-form :model="strategyForm" label-width="100px">
        <el-form-item label="策略名称" required>
          <el-input v-model="strategyForm.name" placeholder="请输入策略名称" />
        </el-form-item>
        
        <el-form-item label="策略描述">
          <el-input 
            v-model="strategyForm.description" 
            type="textarea" 
            :rows="3"
            placeholder="请输入策略描述"
          />
        </el-form-item>
        
          <el-form-item label="策略类型">
            <el-select v-model="strategyForm.type" placeholder="请选择策略类型">
              <el-option label="趋势策略" value="trend" />
              <el-option label="均值回归" value="mean_reversion" />
              <el-option label="动量策略" value="momentum" />
              <el-option label="套利策略" value="arbitrage" />
              <el-option label="做市策略" value="market_making" />
              <el-option label="其他" value="other" />
            </el-select>
          </el-form-item>

        <el-form-item label="策略语言">
          <el-select v-model="strategyForm.language" placeholder="请选择策略语言" @change="onLanguageChange">
            <el-option label="JavaScript" value="javascript" />
            <el-option label="Python" value="python" />
            <el-option label="通达信公式" value="tdx" />
          </el-select>
        </el-form-item>

        <el-form-item label="策略代码" required>
          <!-- 通达信公式编辑器 -->
          <TdxFormulaEditor
            v-if="strategyForm.language === 'tdx'"
            v-model="strategyForm.code"
            :placeholder="getCodePlaceholder()"
            @parse="handleTdxParse"
          />
          
          <!-- JavaScript编辑器 -->
          <JavaScriptEditor
            v-else-if="strategyForm.language === 'javascript'"
            v-model="strategyForm.code"
            :placeholder="getCodePlaceholder()"
          />
          
          <!-- Python编辑器 -->
          <PythonEditor
            v-else-if="strategyForm.language === 'python'"
            v-model="strategyForm.code"
            :placeholder="getCodePlaceholder()"
          />
          
          <!-- 其他语言使用普通文本框 -->
          <div v-else class="code-editor-wrapper">
            <el-input
              v-model="strategyForm.code"
              type="textarea"
              :rows="20"
              :placeholder="getCodePlaceholder()"
              class="code-editor"
            />
            <div class="code-tips">
              <el-alert
                title="策略编写提示"
                type="info"
                :closable="false"
              >
                <template #default>
                  <div>{{ getStrategyTips() }}</div>
                </template>
              </el-alert>
            </div>
          </div>
        </el-form-item>

        <el-form-item label="策略参数">
          <el-input
            v-model="parametersJson"
            type="textarea"
            :rows="4"
            placeholder='{"shortPeriod": 5, "longPeriod": 20}'
          />
        </el-form-item>

        <el-form-item label="公开策略">
          <el-switch v-model="strategyForm.isPublic" />
          <span style="margin-left: 10px; color: #999; font-size: 12px;">
            公开后其他用户可以查看和使用
          </span>
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="showCreateDialog = false">取消</el-button>
        <el-button type="primary" @click="saveStrategy" :loading="saving">
          {{ editingStrategy ? '保存' : '创建' }}
        </el-button>
      </template>
    </el-dialog>

    <!-- 策略模板对话框 -->
    <el-dialog
      v-model="showTemplateDialog"
      title="选择策略模板"
      width="60%"
    >
      <el-row :gutter="20">
        <el-col 
          v-for="template in templates" 
          :key="template.id" 
          :span="12"
          style="margin-bottom: 20px"
        >
          <el-card class="template-card" @click="useTemplate(template)">
            <template #header>
              <div class="template-header">
                <span class="template-name">{{ template.name }}</span>
                <div class="template-icons">
                  <el-tag :type="getLanguageColor(template.language)" size="small" style="margin-right: 8px">
                    {{ getLanguageName(template.language) }}
                  </el-tag>
                  <el-icon class="template-icon"><TrendCharts /></el-icon>
                </div>
              </div>
            </template>
            <div class="template-description">{{ template.description }}</div>
            <div class="template-params">
              <el-tag v-for="(value, key) in template.params" :key="key" size="small">
                {{ key }}: {{ value }}
              </el-tag>
            </div>
          </el-card>
        </el-col>
      </el-row>
    </el-dialog>

    <!-- 回测对话框 -->
    <el-dialog
      v-model="showBacktestDialog"
      title="策略回测"
      width="90%"
      top="3vh"
      :close-on-click-modal="false"
    >
      <el-form :model="backtestForm" label-width="100px" style="margin-bottom: 20px">
        <el-row :gutter="20">
          <el-col :span="8">
            <el-form-item label="选择标的">
              <InstrumentSelector 
                v-model="backtestForm.symbol"
                @select="handleInstrumentSelect"
              />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="初始资金">
              <el-input-number 
                v-model="backtestForm.initialCapital" 
                :min="10000" 
                :step="10000"
                style="width: 100%"
              />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="">
              <el-button 
                type="primary" 
                @click="runBacktest" 
                :loading="backtesting"
                style="width: 100%"
              >
                <el-icon><CaretRight /></el-icon>
                开始回测
              </el-button>
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20">
          <el-col :span="8">
            <el-form-item label="开始日期">
              <el-date-picker
                v-model="backtestForm.startDate"
                type="date"
                placeholder="选择开始日期"
                style="width: 100%"
                value-format="YYYY-MM-DD"
              />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="结束日期">
              <el-date-picker
                v-model="backtestForm.endDate"
                type="date"
                placeholder="选择结束日期"
                style="width: 100%"
                value-format="YYYY-MM-DD"
              />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20">
          <el-col :span="24">
            <el-form-item label="逐笔数据">
              <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap; width: 100%;">
                <el-switch
                  v-model="useTickCsv"
                  active-text="使用Tick CSV"
                  inactive-text="使用K线接口"
                />
                <input
                  ref="tickCsvInputRef"
                  type="file"
                  accept=".csv,text/csv"
                  style="display: none;"
                  @change="handleTickCsvSelected"
                />
                <el-button
                  size="small"
                  @click="openTickCsvPicker"
                  :disabled="!useTickCsv"
                >
                  选择CSV文件
                </el-button>
                <el-select
                  v-model="tickCsvAggregation"
                  size="small"
                  style="width: 130px"
                  :disabled="!useTickCsv"
                >
                  <el-option label="Tick" value="tick" />
                  <el-option label="1s" value="1s" />
                  <el-option label="5s" value="5s" />
                  <el-option label="15s" value="15s" />
                  <el-option label="1m" value="1m" />
                </el-select>
                <el-button
                  text
                  size="small"
                  @click="clearTickCsv"
                  :disabled="!tickCsvContent"
                >
                  清除CSV
                </el-button>
                <span style="color: #606266; font-size: 12px;">
                  {{ tickCsvFileName || '未选择文件' }}
                </span>
              </div>
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>

      <!-- 回测结果 -->
      <div v-if="backtestResult" class="backtest-result">
        <!-- 第一行：基础指标 -->
        <el-row :gutter="20" style="margin-bottom: 20px">
          <el-col :span="6">
            <el-card>
              <el-statistic title="总收益率" :value="backtestResult.totalReturn" suffix="%" />
            </el-card>
          </el-col>
          <el-col :span="6">
            <el-card>
              <el-statistic title="最终权益" :value="backtestResult.finalEquity" prefix="¥" />
            </el-card>
          </el-col>
          <el-col :span="6">
            <el-card>
              <el-statistic title="交易次数" :value="backtestResult.totalTrades" />
            </el-card>
          </el-col>
          <el-col :span="6">
            <el-card>
              <el-statistic title="胜率" :value="backtestResult.winRate" suffix="%" />
            </el-card>
          </el-col>
        </el-row>

        <!-- 第二行：高级指标 -->
        <el-row :gutter="20" style="margin-bottom: 20px">
          <el-col :span="6">
            <el-card>
              <el-statistic title="夏普率" :value="backtestResult.sharpeRatio">
                <template #suffix>
                  <el-tooltip content="夏普率越高，风险调整后收益越好。一般>1为良好，>2为优秀" placement="top">
                    <el-icon style="cursor: help; margin-left: 4px;"><QuestionFilled /></el-icon>
                  </el-tooltip>
                </template>
              </el-statistic>
            </el-card>
          </el-col>
          <el-col :span="6">
            <el-card>
              <el-statistic title="索提诺比率" :value="backtestResult.sortinoRatio">
                <template #suffix>
                  <el-tooltip content="索提诺比率只考虑下行风险，比夏普率更关注亏损" placement="top">
                    <el-icon style="cursor: help; margin-left: 4px;"><QuestionFilled /></el-icon>
                  </el-tooltip>
                </template>
              </el-statistic>
            </el-card>
          </el-col>
          <el-col :span="6">
            <el-card>
              <el-statistic title="卡玛比率" :value="backtestResult.calmarRatio">
                <template #suffix>
                  <el-tooltip content="年化收益率/最大回撤，衡量收益与最大回撤的比率" placement="top">
                    <el-icon style="cursor: help; margin-left: 4px;"><QuestionFilled /></el-icon>
                  </el-tooltip>
                </template>
              </el-statistic>
            </el-card>
          </el-col>
          <el-col :span="6">
            <el-card>
              <el-statistic title="盈亏比" :value="backtestResult.profitFactor">
                <template #suffix>
                  <el-tooltip content="平均盈利/平均亏损，>1表示盈利大于亏损" placement="top">
                    <el-icon style="cursor: help; margin-left: 4px;"><QuestionFilled /></el-icon>
                  </el-tooltip>
                </template>
              </el-statistic>
            </el-card>
          </el-col>
        </el-row>

        <!-- 🔥 新增：资金明细卡片 -->
        <el-card style="margin-bottom: 20px" v-if="backtestResult && backtestResult.summary">
          <template #header>
            <div style="display: flex; align-items: center; gap: 8px;">
              <el-icon><Wallet /></el-icon>
              <span>资金明细</span>
            </div>
          </template>
          
          <el-descriptions :column="2" border>
            <el-descriptions-item label="初始本金">
              <span style="font-size: 16px; font-weight: 600; color: #409eff;">
                ¥{{ backtestResult.summary.initialCapital?.toLocaleString() || '0' }}
              </span>
            </el-descriptions-item>
            
            <el-descriptions-item label="最终资金">
              <span style="font-size: 16px; font-weight: 600;" :style="{ color: backtestResult.summary.finalCapital >= backtestResult.summary.initialCapital ? '#f56c6c' : '#67c23a' }">
                ¥{{ backtestResult.summary.finalCapital?.toLocaleString() || '0' }}
              </span>
            </el-descriptions-item>
            
            <el-descriptions-item label="总买入金额">
              <span style="font-size: 14px; color: #67c23a;">
                ¥{{ (backtestResult.summary.totalBuyAmount || 0).toLocaleString() }}
              </span>
            </el-descriptions-item>
            
            <el-descriptions-item label="总卖出金额">
              <span style="font-size: 14px; color: #f56c6c;">
                ¥{{ (backtestResult.summary.totalSellAmount || 0).toLocaleString() }}
              </span>
            </el-descriptions-item>
            
            <el-descriptions-item label="总手续费">
              <span style="font-size: 14px; color: #e6a23c;">
                ¥{{ (backtestResult.summary.totalFees || 0).toFixed(2) }}
              </span>
              <el-tooltip placement="top">
                <template #content>
                  买入手续费: ¥{{ (backtestResult.summary.totalBuyFees || 0).toFixed(2) }}<br/>
                  卖出手续费: ¥{{ (backtestResult.summary.totalSellFees || 0).toFixed(2) }}<br/>
                  印花税: ¥{{ (backtestResult.summary.totalStampTax || 0).toFixed(2) }}
                </template>
                <el-icon style="margin-left: 4px; cursor: help;"><QuestionFilled /></el-icon>
              </el-tooltip>
            </el-descriptions-item>
            
            <el-descriptions-item label="净盈亏">
              <span style="font-size: 16px; font-weight: 600;" :style="{ color: backtestResult.summary.totalProfit >= 0 ? '#f56c6c' : '#67c23a' }">
                {{ backtestResult.summary.totalProfit >= 0 ? '+' : '' }}¥{{ (backtestResult.summary.totalProfit || 0).toFixed(2) }}
                <span style="font-size: 12px; margin-left: 8px;">
                  ({{ backtestResult.summary.totalReturn >= 0 ? '+' : '' }}{{ backtestResult.summary.totalReturn?.toFixed(2) || '0' }}%)
                </span>
              </span>
            </el-descriptions-item>
            
            <el-descriptions-item label="平均盈利">
              <span style="color: #f56c6c;">
                ¥{{ (backtestResult.summary.avgProfit || 0).toFixed(2) }}
              </span>
            </el-descriptions-item>
            
            <el-descriptions-item label="平均亏损">
              <span style="color: #67c23a;">
                ¥{{ (backtestResult.summary.avgLoss || 0).toFixed(2) }}
              </span>
            </el-descriptions-item>
          </el-descriptions>
          
          <!-- 🔥 新增：盈亏计算公式 -->
          <el-divider content-position="left">
            <el-icon><Operation /></el-icon>
            <span style="margin-left: 4px;">详细计算公式</span>
          </el-divider>
          
          <div v-if="backtestResult.profitBreakdown && backtestResult.profitBreakdown.length > 0" style="padding: 0 20px;">
            <!-- 每笔交易盈亏 -->
            <div style="margin-bottom: 16px;">
              <div style="font-size: 14px; color: #606266; margin-bottom: 8px;">
                <strong>每笔交易盈亏：</strong>
              </div>
              <div style="display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px;">
                <el-tag 
                  v-for="(item, index) in backtestResult.profitBreakdown" 
                  :key="index"
                  :type="item.profit >= 0 ? 'success' : 'danger'"
                  size="small"
                >
                  第{{ item.tradeNumber }}笔: {{ item.profitFormatted }}
                </el-tag>
              </div>
            </div>
            
            <!-- 总盈亏计算 -->
            <div style="margin-bottom: 16px;">
              <div style="font-size: 14px; color: #606266; margin-bottom: 8px;">
                <strong>总盈亏 = 各笔交易盈亏之和：</strong>
              </div>
              <el-alert 
                :title="backtestResult.profitFormula + ' = ¥' + (backtestResult.totalProfit || 0).toFixed(2)"
                type="info"
                :closable="false"
                style="font-family: 'Courier New', monospace; font-size: 13px;"
              />
            </div>
            
            <!-- 最终权益计算 -->
            <div style="margin-bottom: 16px;">
              <div style="font-size: 14px; color: #606266; margin-bottom: 8px;">
                <strong>最终权益 = 初始资金 + 总盈亏：</strong>
              </div>
              <el-alert 
                :title="`¥${backtestResult.initialCapital?.toLocaleString()} + ¥${(backtestResult.totalProfit || 0).toFixed(2)} = ¥${backtestResult.finalEquity?.toLocaleString()}`"
                type="success"
                :closable="false"
                style="font-family: 'Courier New', monospace; font-size: 13px;"
              />
            </div>
            
            <!-- 总收益率计算 -->
            <div style="margin-bottom: 16px;">
              <div style="font-size: 14px; color: #606266; margin-bottom: 8px;">
                <strong>总收益率 = (最终权益 - 初始资金) / 初始资金 × 100%：</strong>
              </div>
              <el-alert 
                :title="`(¥${backtestResult.finalEquity?.toLocaleString()} - ¥${backtestResult.initialCapital?.toLocaleString()}) / ¥${backtestResult.initialCapital?.toLocaleString()} × 100% = ${backtestResult.totalReturn}%`"
                type="info"
                :closable="false"
                style="font-family: 'Courier New', monospace; font-size: 13px;"
              />
            </div>
            
            <!-- 胜率计算 -->
            <div style="margin-bottom: 16px;" v-if="backtestResult.summary">
              <div style="font-size: 14px; color: #606266; margin-bottom: 8px;">
                <strong>胜率 = 盈利交易次数 / 总交易次数 × 100%：</strong>
              </div>
              <el-alert 
                :title="`${backtestResult.summary.winningTrades} / ${backtestResult.summary.totalTrades} × 100% = ${backtestResult.winRate}%`"
                type="info"
                :closable="false"
                style="font-family: 'Courier New', monospace; font-size: 13px;"
              />
            </div>
            
            <!-- 盈亏比计算 -->
            <div style="margin-bottom: 16px;" v-if="backtestResult.summary">
              <div style="font-size: 14px; color: #606266; margin-bottom: 8px;">
                <strong>盈亏比 = 平均盈利 / 平均亏损：</strong>
              </div>
              <el-alert 
                :title="`¥${backtestResult.summary.avgProfit?.toFixed(2)} / ¥${backtestResult.summary.avgLoss?.toFixed(2)} = ${backtestResult.profitFactor?.toFixed(2)}`"
                type="info"
                :closable="false"
                style="font-family: 'Courier New', monospace; font-size: 13px;"
              />
            </div>
            
            <!-- 最大回撤计算 -->
            <div style="margin-bottom: 16px;" v-if="backtestResult.summary">
              <div style="font-size: 14px; color: #606266; margin-bottom: 8px;">
                <strong>最大回撤 = (峰值 - 谷值) / 峰值 × 100%：</strong>
              </div>
              <el-alert 
                :title="`最大回撤 = ${backtestResult.summary.maxDrawdown?.toFixed(2)}%`"
                type="warning"
                :closable="false"
                style="font-family: 'Courier New', monospace; font-size: 13px;"
              />
            </div>
            
            <!-- 夏普率计算 -->
            <div style="margin-bottom: 16px;" v-if="backtestResult.sharpeRatio">
              <div style="font-size: 14px; color: #606266; margin-bottom: 8px;">
                <strong>夏普率 = (平均收益率 - 无风险利率) / 收益率标准差 × √252：</strong>
              </div>
              <el-alert 
                :title="`夏普率 = ${backtestResult.sharpeRatio?.toFixed(2)}`"
                type="info"
                :closable="false"
                style="font-family: 'Courier New', monospace; font-size: 13px;"
              />
            </div>
            
            <!-- 索提诺比率计算 -->
            <div style="margin-bottom: 16px;" v-if="backtestResult.sortinoRatio">
              <div style="font-size: 14px; color: #606266; margin-bottom: 8px;">
                <strong>索提诺比率 = (平均收益率 - 无风险利率) / 下行标准差 × √252：</strong>
              </div>
              <el-alert 
                :title="`索提诺比率 = ${backtestResult.sortinoRatio?.toFixed(2)}`"
                type="info"
                :closable="false"
                style="font-family: 'Courier New', monospace; font-size: 13px;"
              />
            </div>
            
            <!-- 卡玛比率计算 -->
            <div style="margin-bottom: 16px;" v-if="backtestResult.calmarRatio && backtestResult.summary">
              <div style="font-size: 14px; color: #606266; margin-bottom: 8px;">
                <strong>卡玛比率 = 年化收益率 / 最大回撤：</strong>
              </div>
              <el-alert 
                :title="`${backtestResult.summary.annualizedReturn?.toFixed(2)}% / ${backtestResult.summary.maxDrawdown?.toFixed(2)}% = ${backtestResult.calmarRatio?.toFixed(2)}`"
                type="info"
                :closable="false"
                style="font-family: 'Courier New', monospace; font-size: 13px;"
              />
            </div>
            
            <!-- 总手续费计算 -->
            <div v-if="backtestResult.summary">
              <div style="font-size: 14px; color: #606266; margin-bottom: 8px;">
                <strong>总手续费 = 买入手续费 + 卖出手续费 + 印花税：</strong>
              </div>
              <el-alert 
                :title="`¥${backtestResult.summary.totalBuyFees?.toFixed(2)} + ¥${backtestResult.summary.totalSellFees?.toFixed(2)} + ¥${backtestResult.summary.totalStampTax?.toFixed(2)} = ¥${backtestResult.summary.totalFees?.toFixed(2)}`"
                type="warning"
                :closable="false"
                style="font-family: 'Courier New', monospace; font-size: 13px;"
              />
            </div>
          </div>
          
          <div v-else style="padding: 20px; text-align: center; color: #909399;">
            暂无交易记录
          </div>
        </el-card>

        <!-- K线图 -->
        <el-card style="margin-bottom: 20px">
          <template #header>
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <div style="display: flex; align-items: center; gap: 12px;">
                <span>策略信号图</span>
                <!-- 🔥 数据源标识 -->
                <el-tag v-if="backtestDataSource" :type="getDataSourceTagType(backtestDataSource)" size="small">
                  {{ getDataSourceName(backtestDataSource) }}
                </el-tag>
              </div>
              <div style="display: flex; align-items: center; gap: 16px;">
                <!-- 周期选择 -->
                <el-radio-group v-model="chartPeriod" size="small">
                  <el-radio-button label="1d">日线</el-radio-button>
                </el-radio-group>
                
                <!-- 信号显示开关 -->
                <el-switch
                  v-model="showSignalsOnChart"
                  active-text="显示信号"
                  inactive-text="隐藏信号"
                />
                
                <!-- 辅助线显示开关 -->
                <el-switch
                  v-if="backtestAuxiliaryData && Object.keys(backtestAuxiliaryData).length > 0"
                  v-model="showAuxiliaryLines"
                  active-text="显示辅助线"
                  inactive-text="隐藏辅助线"
                />
              </div>
            </div>
          </template>
          
          <!-- 使用与SimpleTradingInterface相同的图表实现 -->
          <div class="chart-wrapper">
            <div class="chart-container" ref="backtestChartContainer" style="height: 500px;"></div>
          </div>
        </el-card>

        <!-- 交易记录 -->
        <el-card>
          <template #header>
            <span>交易记录</span>
          </template>
          <el-table :data="backtestResult.trades" max-height="300">
            <el-table-column type="index" label="#" width="50" />
            <el-table-column prop="type" label="类型" width="80">
              <template #default="{ row }">
                <el-tag :type="row.type === 'buy' ? 'danger' : 'success'">
                  {{ row.type === 'buy' ? '买入' : '卖出' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="price" label="价格" width="100" />
            <el-table-column prop="quantity" label="数量" width="100" />
            <el-table-column prop="profit" label="盈亏" width="120">
              <template #default="{ row }">
                <span v-if="row.type === 'sell'" :style="{ color: row.profit >= 0 ? '#67C23A' : '#F56C6C' }">
                  {{ row.profit >= 0 ? '+' : '' }}{{ row.profit?.toFixed(2) || '-' }}
                  <span style="font-size: 12px; margin-left: 4px;">
                    ({{ row.return >= 0 ? '+' : '' }}{{ (row.return * 100).toFixed(2) }}%)
                  </span>
                </span>
                <span v-else style="color: #909399;">-</span>
              </template>
            </el-table-column>
            <el-table-column prop="reason" label="原因" show-overflow-tooltip />
            <el-table-column prop="date" label="时间" width="180">
              <template #default="{ row }">
                {{ row.date }}
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </div>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, computed, watch, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { 
  Plus, Document, View, Edit, Delete, TrendCharts, CaretRight, QuestionFilled, Wallet, Operation,
  VideoPlay, VideoPause, Download, CopyDocument, Close, MoreFilled
} from '@element-plus/icons-vue'
import { useStrategyStore } from '@/stores/strategyStore'
import { isMobile as checkMobile } from '@/utils/device'
import {
  getStrategyTemplates,
  executeStrategy
} from '@/api/strategy'
import { createChart } from 'lightweight-charts'
import { toUnixSeconds } from '@/utils/tvTime'
import axios from 'axios'
import InstrumentSelector from '@/components/InstrumentSelector.vue'
import TdxFormulaEditor from '@/components/TdxFormulaEditor.vue'
import JavaScriptEditor from '@/components/JavaScriptEditor.vue'
import PythonEditor from '@/components/PythonEditor.vue'
import { getApiBaseUrl } from '@/config/api'
import { getFriendlyErrorMessage } from '@/utils/errorMessage'
import { parseTickCsvToKline } from '@/utils/tickCsvParser'
import { executeSandbox } from '@/utils/sandboxExecute'

// 路由
const route = useRoute()
const router = useRouter()

// 策略状态管理
const strategyStore = useStrategyStore()

// Device detection
const isMobileView = ref(false)
const updateMobileView = () => { isMobileView.value = checkMobile() }

const loading = ref(false)
const saving = ref(false)
const backtesting = ref(false)
const loadingInstruments = ref(false)
const useLightweightCharts = ref(true) // 默认使用Lightweight Charts（已移除ECharts选项）

// 🔥 批量管理相关
const selectedStrategyIds = ref([])
const strategyTable = ref(null)

// 图表相关
const backtestChartContainer = ref(null)
const backtestChart = ref(null)
const backtestCandlestickSeries = ref(null)
const chartPeriod = ref('1d')
const showSignalsOnChart = ref(true)
const showAuxiliaryLines = ref(true)

const templates = ref([])
const availableInstruments = ref([])
const currentPage = ref(1)
const pageSize = ref(10)
const total = ref(0)

const showCreateDialog = ref(false)
const showTemplateDialog = ref(false)
const showBacktestDialog = ref(false)
const editingStrategy = ref(null)
const currentStrategy = ref(null)

const strategyForm = reactive({
  name: '',
  description: '',
  code: '',
  type: 'trend',
  parameters: {},
  isPublic: false,
  language: 'javascript'
})

const parametersJson = ref('{}')

const backtestForm = reactive({
  instrumentType: 'stock',
  symbol: '',
  initialCapital: 100000,
  startDate: '',
  endDate: ''
})
const useTickCsv = ref(false)
const tickCsvInputRef = ref(null)
const tickCsvFileName = ref('')
const tickCsvContent = ref('')
const tickCsvAggregation = ref('tick')

const backtestResult = ref(null)
const backtestKlineData = ref(null)
const backtestSignals = ref(null)
const backtestTradeSignals = ref(null)  // 🔥 新增：保存交易信号（用于图表显示）
const backtestAuxiliaryData = ref(null)
const backtestDataSource = ref('') // 🔥 新增：记录回测数据源

onMounted(async () => {
  updateMobileView()
  window.addEventListener('resize', updateMobileView)

  // 加载数据
  await Promise.all([
    loadStrategies(),
    loadTemplates(),
    loadAvailableInstruments()
  ])
  
  // 处理URL参数
  handleRouteQuery()
  
  // 监听策略事件
  strategyStore.on('strategyCreated', () => {
    loadStrategies()
  })
  
  strategyStore.on('strategyUpdated', () => {
    loadStrategies()
  })
  
  strategyStore.on('strategyDeleted', () => {
    loadStrategies()
  })
})

// 监听回测对话框打开，初始化图表
watch(showBacktestDialog, async (newValue) => {
  if (newValue) {
    console.log('📊 回测对话框已打开，准备初始化图表')
    // 设置默认日期（最近10年，与智能交易界面一致）
    if (!backtestForm.startDate) {
      const endDate = new Date()
      const startDate = new Date()
      startDate.setFullYear(startDate.getFullYear() - 10) // 🔥 改为10年
      backtestForm.startDate = startDate.toISOString().split('T')[0]
      backtestForm.endDate = endDate.toISOString().split('T')[0]
    }
    
    await nextTick()
    if (backtestChartContainer.value) {
      initBacktestChart()
    }
  } else {
    // 对话框关闭时清理图表
    if (backtestChart.value) {
      backtestChart.value.remove()
      backtestChart.value = null
      backtestCandlestickSeries.value = null
    }
  }
})

// 监听周期变化（已简化：只支持日线）
watch(chartPeriod, async () => {
  // 由于只支持日线，不需要重新聚合数据
  console.log('📊 周期固定为日线，无需重新聚合')
})

// 监听信号显示开关
watch(showSignalsOnChart, () => {
  console.log('🔄 信号显示开关切换:', showSignalsOnChart.value)
  console.log('📊 图表状态:', {
    chart: !!backtestChart.value,
    series: !!backtestCandlestickSeries.value,
    tradeSignals: backtestTradeSignals.value?.length || 0,  // 🔥 使用交易信号
    klineData: backtestKlineData.value?.length || 0
  })
  
  if (backtestChart.value && backtestCandlestickSeries.value) {
    if (showSignalsOnChart.value && backtestTradeSignals.value && backtestTradeSignals.value.length > 0) {  // 🔥 使用交易信号
      console.log('📊 显示信号标记，数量:', backtestTradeSignals.value.length)
      displaySignalsOnBacktestChart(backtestTradeSignals.value, backtestKlineData.value)
    } else {
      console.log('📊 隐藏信号标记')
      backtestCandlestickSeries.value.setMarkers([])
    }
  } else {
    console.warn('⚠️ 图表未初始化，无法切换信号显示')
  }
})

// 监听辅助线显示开关
watch(showAuxiliaryLines, () => {
  if (backtestChart.value && backtestKlineData.value) {
    console.log('📊 辅助线显示切换:', showAuxiliaryLines.value)
    // 重新初始化图表以清除或显示辅助线
    initBacktestChart()
    updateBacktestChart(backtestKlineData.value, backtestSignals.value, backtestAuxiliaryData.value)
  }
})

// 处理路由查询参数
function handleRouteQuery() {
  const { action, strategyId, symbol } = route.query
  
  if (action === 'backtest' && strategyId) {
    const strategy = strategyStore.getStrategy(parseInt(strategyId))
    if (strategy) {
      backtestStrategy(strategy)
      if (symbol) {
        backtestForm.symbol = symbol
      }
    }
  } else if (action === 'edit' && strategyId) {
    const strategy = strategyStore.getStrategy(parseInt(strategyId))
    if (strategy) {
      editStrategy(strategy)
    }
  }
}

// 计算属性 - 按类型分组的工具
const groupedInstruments = computed(() => {
  if (!backtestForm.instrumentType) return []
  
  const filtered = availableInstruments.value.filter(item => item.type === backtestForm.instrumentType)
  
  // 按行业分组
  const groups = {}
  filtered.forEach(item => {
    const sector = item.sector || '其他'
    if (!groups[sector]) {
      groups[sector] = []
    }
    groups[sector].push(item)
  })
  
  return Object.keys(groups).map(sector => ({
    label: sector,
    options: groups[sector]
  }))
})

// 加载可用工具
async function loadAvailableInstruments() {
  loadingInstruments.value = true
  try {
    const token = localStorage.getItem('token')
    if (!token) {
      console.warn('未找到登录token')
      return
    }

    const response = await axios.get('/api/watchlist/available', {
      headers: { Authorization: `Bearer ${token}` },
      params: { limit: 200 }
    })

    if (response.data && response.data.success) {
      availableInstruments.value = response.data.data.instruments
      console.log('✅ 可用工具加载成功:', availableInstruments.value.length, '个')
      
      // 如果还没有选择工具，默认选择第一个股票
      if (!backtestForm.symbol && availableInstruments.value.length > 0) {
        const firstStock = availableInstruments.value.find(item => item.type === 'stock')
        if (firstStock) {
          backtestForm.symbol = firstStock.code
        }
      }
    }
  } catch (error) {
    console.error('加载可用工具失败:', error)
    ElMessage.error('加载可用工具失败')
  } finally {
    loadingInstruments.value = false
  }
}

// 工具类型变化处理
function onInstrumentTypeChange() {
  backtestForm.symbol = ''
  // 自动选择该类型的第一个工具
  const filtered = availableInstruments.value.filter(item => item.type === backtestForm.instrumentType)
  if (filtered.length > 0) {
    backtestForm.symbol = filtered[0].code
  }
}

// 处理标的选择
function handleInstrumentSelect(instrument) {
  console.log('✅ 选择标的:', instrument)
  backtestForm.symbol = instrument.code
  // 根据标的类型自动设置工具类型
  if (instrument.type) {
    backtestForm.instrumentType = instrument.type
  }
}

// 加载策略列表
async function loadStrategies() {
  loading.value = true
  try {
    const data = await strategyStore.loadStrategies({
      page: currentPage.value,
      pageSize: pageSize.value
    })
    total.value = data.total
  } catch (error) {
    console.error('加载策略列表失败:', error)
  } finally {
    loading.value = false
  }
}

// 加载模板
async function loadTemplates() {
  try {
    const res = await getStrategyTemplates()
    if (res.success) {
      templates.value = res.data
    }
  } catch (error) {
    console.error('加载模板失败:', error)
  }
}

// 使用模板
function useTemplate(template) {
  strategyForm.name = template.name
  strategyForm.description = template.description
  strategyForm.code = template.code
  strategyForm.type = 'trend'
  strategyForm.language = template.language || 'javascript'
  parametersJson.value = JSON.stringify(template.params, null, 2)
  showTemplateDialog.value = false
  showCreateDialog.value = true
}

function openTickCsvPicker() {
  if (!useTickCsv.value) return
  tickCsvInputRef.value?.click()
}

function clearTickCsv() {
  tickCsvFileName.value = ''
  tickCsvContent.value = ''
  if (tickCsvInputRef.value) {
    tickCsvInputRef.value.value = ''
  }
}

async function handleTickCsvSelected(event) {
  const file = event?.target?.files?.[0]
  if (!file) return

  // Keep some headroom under backend/json limits and browser memory.
  const maxSizeBytes = 45 * 1024 * 1024
  if (file.size > maxSizeBytes) {
    ElMessage.error('CSV文件过大，请控制在45MB以内')
    clearTickCsv()
    return
  }

  tickCsvFileName.value = file.name
  tickCsvContent.value = await file.text()

  try {
    const preview = parseTickCsvToKline(tickCsvContent.value, {
      aggregation: tickCsvAggregation.value,
      minRows: 2
    })
    ElMessage.success(`CSV加载成功：${preview.meta.sourceRows} 行，解析 ${preview.meta.outputRows} 条`)
  } catch (error) {
    ElMessage.error(`CSV解析失败: ${error.message}`)
    clearTickCsv()
  }
}

// 保存策略
async function saveStrategy() {
  if (!strategyForm.name || !strategyForm.code) {
    ElMessage.warning('请填写策略名称和代码')
    return
  }

  try {
    strategyForm.parameters = JSON.parse(parametersJson.value || '{}')
  } catch (error) {
    ElMessage.error('策略参数格式错误，请输入有效的JSON')
    return
  }

  saving.value = true
  try {
    if (editingStrategy.value) {
      await strategyStore.updateStrategy(editingStrategy.value.id, strategyForm)
    } else {
      await strategyStore.createStrategy(strategyForm)
    }
    showCreateDialog.value = false
    resetForm()
  } catch (error) {
    console.error('保存策略失败:', error)
    ElMessage.error('保存策略失败: ' + getFriendlyErrorMessage(error, '保存策略失败'))
  } finally {
    saving.value = false
  }
}

// 查看策略
function viewStrategy(strategy) {
  currentStrategy.value = strategy
  backtestStrategy(strategy)
}

// 编辑策略
async function editStrategy(strategy) {
  try {
    editingStrategy.value = strategy
    strategyForm.name = strategy.name
    strategyForm.description = strategy.description || ''
    strategyForm.code = strategy.code
    strategyForm.type = strategy.type
    strategyForm.isPublic = strategy.isPublic || false
    strategyForm.language = strategy.language || 'javascript'
    parametersJson.value = JSON.stringify(strategy.parameters || {}, null, 2)
    showCreateDialog.value = true
  } catch (error) {
    ElMessage.error('加载策略详情失败')
  }
}

// 回测策略
function backtestStrategy(strategy) {
  console.log('🎯 准备回测策略:', strategy)
  currentStrategy.value = strategy
  backtestResult.value = null
  backtestKlineData.value = null
  backtestSignals.value = null
  backtestTradeSignals.value = null  // 🔥 清空交易信号
  showBacktestDialog.value = true
  console.log('📊 回测对话框已打开，当前策略ID:', currentStrategy.value.id)
}

// 执行回测
// 执行回测
async function runBacktest() {
  if (!backtestForm.symbol) {
    ElMessage.warning('请选择股票')
    return
  }
  
  if (!backtestForm.startDate || !backtestForm.endDate) {
    ElMessage.warning('请选择回测日期范围')
    return
  }

  backtesting.value = true
  try {
    console.log('🔄 开始回测，参数:', {
      strategyId: currentStrategy.value.id,
      symbol: backtestForm.symbol,
      initialCapital: backtestForm.initialCapital,
      startDate: backtestForm.startDate,
      endDate: backtestForm.endDate
    })
    
    const strategy = currentStrategy.value
    
    // 1. 获取回测数据（优先使用Tick CSV）
    let fullKlineData = []
    if (useTickCsv.value) {
      if (!tickCsvContent.value) {
        ElMessage.warning('请先选择Tick级CSV文件')
        return
      }

      const parsedTickData = parseTickCsvToKline(tickCsvContent.value, {
        aggregation: tickCsvAggregation.value
      })
      const startSec = Math.floor(new Date(backtestForm.startDate).getTime() / 1000)
      const endSec = Math.floor(new Date(backtestForm.endDate).getTime() / 1000)
      fullKlineData = parsedTickData.data.filter((row) => row.time >= startSec && row.time <= endSec)
      if (fullKlineData.length < 20) {
        ElMessage.error('CSV在当前日期范围内的数据不足（少于20条）')
        return
      }
      backtestDataSource.value = 'tick_csv'
      console.log('📊 Tick CSV解析完成:', parsedTickData.meta)
    } else {
      // 🔥 默认使用完整历史K线（从上市到现在，与智能交易界面一致）
      fullKlineData = await generateBacktestKlineData(
        backtestForm.symbol,
        null,  // 传null表示从上市时间开始
        null   // 传null表示到当前时间
      )
    }

    console.log('📊 生成回测K线数据:', fullKlineData.length, '条')
    if (fullKlineData.length > 0) {
      console.log('📊 完整数据时间范围:', {
        start: new Date(fullKlineData[0].time * 1000).toLocaleDateString(),
        end: new Date(fullKlineData[fullKlineData.length - 1].time * 1000).toLocaleDateString()
      })
    } else {
      console.error('❌ K线数据为空！')
      ElMessage.error('生成K线数据失败')
      return
    }
    
    // 2. 执行策略代码获取信号
    let strategySignals = []
    let auxiliaryData = {}
    
    if (strategy.code) {
      try {
        console.log('🚀 开始执行策略代码...')
        console.log('📊 策略名称:', strategy.name)
        console.log('📊 策略语言:', strategy.language)
        console.log('📊 K线数据长度:', fullKlineData.length)
        
        const result = await executeStrategyCode(strategy, fullKlineData)
        
        console.log('📊 策略执行结果:', result)
        console.log('📊 原始信号数量:', result?.signals?.length || 0)
        console.log('📊 辅助线数量:', result?.auxiliaryData ? Object.keys(result.auxiliaryData).length : 0)
        
        strategySignals = result?.signals || []
        auxiliaryData = result?.auxiliaryData || {}
        
        // 🔥 关键修复：为每个信号添加时间和价格信息
        strategySignals = strategySignals.map(signal => {
          const dataPoint = fullKlineData[signal.index]
          if (dataPoint) {
            return {
              ...signal,
              time: dataPoint.time, // 添加时间戳
              price: signal.price || dataPoint.close // 确保有价格
            }
          }
          return signal
        }).filter(signal => signal.time) // 过滤掉没有时间的信号
        
        console.log('✅ 信号时间信息已添加，有效信号:', strategySignals.length, '个')
        if (strategySignals.length > 0) {
          console.log('📊 信号示例:', strategySignals.slice(0, 3))
        }
        
        if (auxiliaryData && Object.keys(auxiliaryData).length > 0) {
          console.log('✅ 辅助线数据:', Object.keys(auxiliaryData))
          // 打印每条辅助线的数据点数量
          Object.keys(auxiliaryData).forEach(key => {
            const lineData = auxiliaryData[key]
            console.log(`  - ${key}: ${lineData?.data?.length || 0} 个数据点`)
          })
        } else {
          console.warn('⚠️ 没有辅助线数据')
        }
      } catch (error) {
        console.error('❌ 策略执行失败:', error)
        console.error('❌ 错误详情:', error.message)
        console.error('❌ 错误堆栈:', error.stack)
        ElMessage.warning('策略执行失败：' + error.message)
      }
    } else {
      console.warn('⚠️ 策略没有代码')
    }
    
    // 3. 🔥 筛选回测日期范围内的信号（用于回测计算）
    const startTimestamp = new Date(backtestForm.startDate).getTime() / 1000
    const endTimestamp = new Date(backtestForm.endDate).getTime() / 1000
    
    const backtestSignals = strategySignals.filter(signal => 
      signal.time >= startTimestamp && signal.time <= endTimestamp
    )
    
    console.log('📊 全部信号数量:', strategySignals.length, '个')
    console.log('📊 回测范围内的信号:', backtestSignals.length, '个')
    console.log('📊 回测时间范围:', {
      start: backtestForm.startDate,
      end: backtestForm.endDate,
      startTimestamp: startTimestamp,
      endTimestamp: endTimestamp
    })
    
    // 🔥 如果回测范围内没有信号，给出警告
    if (backtestSignals.length === 0) {
      console.warn('⚠️ 回测日期范围内没有交易信号！')
      console.warn('⚠️ 建议：')
      console.warn('  1. 扩大回测日期范围')
      console.warn('  2. 调整策略参数（如降低箱体周期）')
      console.warn('  3. 检查策略逻辑是否正确')
      
      if (strategySignals.length > 0) {
        // 显示信号的时间范围
        const signalTimes = strategySignals.map(s => s.time).filter(t => t)
        if (signalTimes.length > 0) {
          const minTime = Math.min(...signalTimes)
          const maxTime = Math.max(...signalTimes)
          console.warn('⚠️ 信号时间范围:', {
            start: new Date(minTime * 1000).toLocaleDateString(),
            end: new Date(maxTime * 1000).toLocaleDateString()
          })
        }
      }
    }
    
    // 4. 执行回测计算（只计算回测范围内的交易）
    let capital = backtestForm.initialCapital
    let position = 0
    const trades = []
    let buyPrice = 0
    let buyCost = 0  // 🔑 新增：记录买入总成本
    let totalProfit = 0  // 🔑 新增：累计总盈亏
    
    // 🔥 新增：资金流水统计
    let totalBuyAmount = 0      // 总买入金额
    let totalSellAmount = 0     // 总卖出金额
    let totalBuyFees = 0        // 总买入手续费
    let totalSellFees = 0       // 总卖出手续费
    let totalStampTax = 0       // 总印花税
    
    // 手续费率
    const buyFeeRate = 0.0003   // 买入手续费 0.03%
    const sellFeeRate = 0.0003  // 卖出手续费 0.03%（修正为0.03%）
    const stampTaxRate = 0.001  // 印花税 0.1%
    
    // 🔑 关键：每次使用固定金额买入（初始资金的95%）
    const FIXED_INVESTMENT = backtestForm.initialCapital * 0.95
    
    for (let i = 0; i < backtestSignals.length; i++) {
      const signal = backtestSignals[i]
      
      const isBuySignal = signal.type === 'buy' || signal.type === 'open_long'
      const isSellSignal = signal.type === 'sell' || signal.type === 'close_long'
      
      if (isBuySignal && position === 0) {
        // 🔑 买入：使用固定金额（不使用复利）
        const quantity = Math.floor(FIXED_INVESTMENT / signal.price)
        
        if (quantity > 0) {
          const actualBuyAmount = quantity * signal.price
          const buyFee = actualBuyAmount * buyFeeRate
          buyCost = actualBuyAmount + buyFee  // 记录总成本
          
          position = quantity
          buyPrice = signal.price
          
          // 🔥 统计买入金额和手续费
          totalBuyAmount += actualBuyAmount
          totalBuyFees += buyFee
          
          // 🔥 修复：确保时间戳是秒级的，并正确格式化日期
          const tradeDate = new Date(signal.time * 1000)
          const dateStr = `${tradeDate.getFullYear()}-${String(tradeDate.getMonth() + 1).padStart(2, '0')}-${String(tradeDate.getDate()).padStart(2, '0')} ${String(tradeDate.getHours()).padStart(2, '0')}:${String(tradeDate.getMinutes()).padStart(2, '0')}`
          
          trades.push({
            id: trades.length + 1,
            date: dateStr,
            type: 'buy',
            price: signal.price,
            quantity: quantity,
            amount: actualBuyAmount,
            fee: buyFee,
            cost: buyCost,
            reason: signal.reason || '买入信号',
            timestamp: signal.time
          })
          
          console.log(`买入: 价格=${signal.price}, 数量=${quantity}, 成本=${buyCost.toFixed(2)}`)
        }
      } else if (isSellSignal && position > 0) {
        // 🔑 卖出：计算本次交易盈亏
        const quantity = position
        const sellAmount = quantity * signal.price
        const sellFee = sellAmount * sellFeeRate
        const stampTax = sellAmount * stampTaxRate
        const totalSellCost = sellFee + stampTax
        const netAmount = sellAmount - totalSellCost  // 卖出净收入
        
        // 🔑 关键：本次盈亏 = 卖出净收入 - 买入总成本
        const profit = netAmount - buyCost
        totalProfit += profit  // 累加到总盈亏
        
        const returnRate = (signal.price - buyPrice) / buyPrice
        
        // 🔥 统计卖出金额和手续费
        totalSellAmount += sellAmount
        totalSellFees += sellFee
        totalStampTax += stampTax
        
        // 🔥 修复：确保时间戳是秒级的，并正确格式化日期
        const tradeDate = new Date(signal.time * 1000)
        const dateStr = `${tradeDate.getFullYear()}-${String(tradeDate.getMonth() + 1).padStart(2, '0')}-${String(tradeDate.getDate()).padStart(2, '0')} ${String(tradeDate.getHours()).padStart(2, '0')}:${String(tradeDate.getMinutes()).padStart(2, '0')}`
        
        trades.push({
          id: trades.length + 1,
          date: dateStr,
          type: 'sell',
          price: signal.price,
          quantity: quantity,
          amount: sellAmount,
          fee: sellFee,
          stampTax: stampTax,
          return: returnRate,
          profit: profit,
          reason: signal.reason || '卖出信号',
          timestamp: signal.time
        })
        
        console.log(`卖出: 价格=${signal.price}, 数量=${quantity}, 盈亏=${profit.toFixed(2)}, 累计盈亏=${totalProfit.toFixed(2)}`)
        
        position = 0
      }
    }
    
    // 🔑 关键：如果回测结束时还有持仓，强制平仓
    if (position > 0) {
      const lastPrice = fullKlineData[fullKlineData.length - 1].close
      const quantity = position
      const sellAmount = quantity * lastPrice
      const sellFee = sellAmount * sellFeeRate
      const stampTax = sellAmount * stampTaxRate
      const totalSellCost = sellFee + stampTax
      const netAmount = sellAmount - totalSellCost
      
      // 计算最后一次交易的盈亏
      const profit = netAmount - buyCost
      totalProfit += profit
      
      // 统计
      totalSellAmount += sellAmount
      totalSellFees += sellFee
      totalStampTax += stampTax
      
      // 记录强制平仓交易
      const lastDate = fullKlineData[fullKlineData.length - 1]
      const tradeDate = new Date(lastDate.time * 1000)
      const dateStr = `${tradeDate.getFullYear()}-${String(tradeDate.getMonth() + 1).padStart(2, '0')}-${String(tradeDate.getDate()).padStart(2, '0')} ${String(tradeDate.getHours()).padStart(2, '0')}:${String(tradeDate.getMinutes()).padStart(2, '0')}`
      
      trades.push({
        id: trades.length + 1,
        date: dateStr,
        type: 'sell',
        price: lastPrice,
        quantity: quantity,
        amount: sellAmount,
        fee: sellFee,
        stampTax: stampTax,
        return: (lastPrice - buyPrice) / buyPrice,
        profit: profit,
        reason: '回测结束强制平仓',
        timestamp: lastDate.time,
        isForceClose: true  // 标记为强制平仓
      })
      
      console.log(`🔚 回测结束强制平仓: 价格=${lastPrice.toFixed(2)}, 数量=${quantity}, 盈亏=${profit.toFixed(2)}, 累计盈亏=${totalProfit.toFixed(2)}`)
      
      position = 0
    }
    
    // 🔥 计算总手续费
    const totalFees = totalBuyFees + totalSellFees + totalStampTax
    
    // 🔥 打印交易统计
    console.log('📊 交易统计:', {
      总交易次数: trades.length,
      买入次数: trades.filter(t => t.type === 'buy').length,
      卖出次数: trades.filter(t => t.type === 'sell').length,
      当前持仓: position,
      累计盈亏: totalProfit.toFixed(2),
      总买入金额: totalBuyAmount.toFixed(2),
      总卖出金额: totalSellAmount.toFixed(2),
      总手续费: totalFees.toFixed(2)
    })
    
    // 🔑 先定义 sellTrades（必须在使用之前定义）
    const sellTrades = trades.filter(t => t.type === 'sell')
    
    // 🔥 新增：生成盈亏明细（用于显示加法式子）
    const profitBreakdown = sellTrades.map((trade, index) => ({
      tradeNumber: index + 1,
      profit: trade.profit,
      profitFormatted: trade.profit >= 0 ? `+${trade.profit.toFixed(2)}` : trade.profit.toFixed(2)
    }))
    
    // 生成加法式子字符串
    const profitFormula = profitBreakdown.map(item => item.profitFormatted).join(' + ')
    const totalProfitCalculated = profitBreakdown.reduce((sum, item) => sum + item.profit, 0)
    
    console.log('📊 盈亏明细:', profitBreakdown)
    console.log('📊 盈亏公式:', profitFormula)
    console.log('📊 计算总盈亏:', totalProfitCalculated.toFixed(2))
    
    // 🔑 计算最终权益：初始资金 + 累计盈亏（已包含所有交易）
    const finalCapital = backtestForm.initialCapital + totalProfit
    const totalReturn = ((finalCapital - backtestForm.initialCapital) / backtestForm.initialCapital) * 100
    
    // 计算交易统计
    const profitTrades = sellTrades.filter(t => t.profit > 0)
    const lossTrades = sellTrades.filter(t => t.profit < 0)
    const winRate = sellTrades.length > 0 ? (profitTrades.length / sellTrades.length) * 100 : 0
    
    // 计算最大回撤
    let maxDrawdown = 0
    let peak = backtestForm.initialCapital
    let currentCapital = backtestForm.initialCapital
    
    for (const trade of trades) {
      if (trade.type === 'sell') {
        currentCapital += trade.profit
        if (currentCapital > peak) {
          peak = currentCapital
        }
        const drawdown = ((peak - currentCapital) / peak) * 100
        if (drawdown > maxDrawdown) {
          maxDrawdown = drawdown
        }
      }
    }
    
    // 计算年化收益率
    const startDate = new Date(backtestForm.startDate)
    const endDate = new Date(backtestForm.endDate)
    const days = (endDate - startDate) / (1000 * 60 * 60 * 24)
    const years = days / 365
    const annualizedReturn = years > 0 ? (Math.pow(finalCapital / backtestForm.initialCapital, 1 / years) - 1) * 100 : 0
    
    // 🔥 新增：计算更多回测指标
    // 计算每日收益率
    const dailyReturns = []
    let prevCapital = backtestForm.initialCapital
    
    for (const trade of trades) {
      if (trade.type === 'sell') {
        const currentCapital = prevCapital + trade.profit
        const dailyReturn = (currentCapital - prevCapital) / prevCapital
        dailyReturns.push(dailyReturn)
        prevCapital = currentCapital
      }
    }
    
    // 计算夏普率 (Sharpe Ratio)
    let sharpeRatio = 0
    if (dailyReturns.length > 0) {
      const avgReturn = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length
      const variance = dailyReturns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / dailyReturns.length
      const stdDev = Math.sqrt(variance)
      const riskFreeRate = 0.03 / 252 // 假设无风险利率3%，转换为日收益率
      sharpeRatio = stdDev > 0 ? ((avgReturn - riskFreeRate) / stdDev) * Math.sqrt(252) : 0
    }
    
    // 计算索提诺比率 (Sortino Ratio) - 只考虑下行风险
    let sortinoRatio = 0
    if (dailyReturns.length > 0) {
      const avgReturn = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length
      const downsideReturns = dailyReturns.filter(r => r < 0)
      if (downsideReturns.length > 0) {
        const downsideVariance = downsideReturns.reduce((sum, r) => sum + Math.pow(r, 2), 0) / downsideReturns.length
        const downsideStdDev = Math.sqrt(downsideVariance)
        const riskFreeRate = 0.03 / 252
        sortinoRatio = downsideStdDev > 0 ? ((avgReturn - riskFreeRate) / downsideStdDev) * Math.sqrt(252) : 0
      }
    }
    
    // 计算卡玛比率 (Calmar Ratio) - 年化收益率 / 最大回撤
    const calmarRatio = maxDrawdown > 0 ? annualizedReturn / maxDrawdown : 0
    
    // 计算盈亏比
    const avgProfit = profitTrades.length > 0 ? profitTrades.reduce((sum, t) => sum + t.profit, 0) / profitTrades.length : 0
    const avgLoss = lossTrades.length > 0 ? Math.abs(lossTrades.reduce((sum, t) => sum + t.profit, 0) / lossTrades.length) : 0
    const profitFactor = avgLoss > 0 ? avgProfit / avgLoss : 0
    
    // 5. 构建回测结果
    backtestResult.value = {
      success: true,
      initialCapital: backtestForm.initialCapital,  // 🔥 新增
      finalEquity: parseFloat(finalCapital.toFixed(2)),     // 🔥 改为数字
      totalReturn: parseFloat(totalReturn.toFixed(2)),      // 🔥 改为数字
      totalTrades: sellTrades.length,
      winRate: parseFloat(winRate.toFixed(2)),              // 🔥 改为数字
      sharpeRatio: parseFloat(sharpeRatio.toFixed(2)),      // 🔥 改为数字
      sortinoRatio: parseFloat(sortinoRatio.toFixed(2)),    // 🔥 改为数字
      calmarRatio: parseFloat(calmarRatio.toFixed(2)),      // 🔥 改为数字
      profitFactor: parseFloat(profitFactor.toFixed(2)),    // 🔥 改为数字
      // 🔥 新增：盈亏明细
      profitBreakdown: profitBreakdown,
      profitFormula: profitFormula,
      totalProfit: parseFloat(totalProfit.toFixed(2)),
      totalProfitCalculated: parseFloat(totalProfitCalculated.toFixed(2)),
      summary: {
        initialCapital: backtestForm.initialCapital,
        finalCapital: finalCapital,
        totalProfit: totalProfit,
        totalReturn: totalReturn,
        annualizedReturn: annualizedReturn,
        maxDrawdown: maxDrawdown,
        totalTrades: sellTrades.length,
        winningTrades: profitTrades.length,
        losingTrades: lossTrades.length,
        winRate: winRate,
        sharpeRatio: sharpeRatio,      // 🔥 新增
        sortinoRatio: sortinoRatio,    // 🔥 新增
        calmarRatio: calmarRatio,      // 🔥 新增
        profitFactor: profitFactor,    // 🔥 新增
        avgProfit: avgProfit,          // 🔥 新增
        avgLoss: avgLoss,              // 🔥 新增
        // 🔥 新增：资金明细
        totalBuyAmount: totalBuyAmount,
        totalSellAmount: totalSellAmount,
        totalBuyFees: totalBuyFees,
        totalSellFees: totalSellFees,
        totalStampTax: totalStampTax,
        totalFees: totalFees
      },
      trades: trades
    }
    
    // 🔥 打印回测结果摘要
    console.log('📊 回测结果摘要:', {
      总收益率: totalReturn.toFixed(2) + '%',
      最终权益: finalCapital.toFixed(2),
      交易次数: sellTrades.length,
      胜率: winRate.toFixed(2) + '%',
      夏普率: sharpeRatio.toFixed(2),
      最大回撤: maxDrawdown.toFixed(2) + '%'
    })
    
    // 6. 保存数据用于图表显示
    backtestKlineData.value = fullKlineData
    backtestAuxiliaryData.value = auxiliaryData
    
    // 🔥 从交易记录生成信号标记（用于图表显示）
    const tradeSignals = trades.map(trade => ({
      time: trade.timestamp,
      type: trade.type,
      price: trade.price,
      reason: trade.reason
    }))
    
    console.log('📊 生成交易信号标记:', tradeSignals.length, '个')
    console.log('📊 交易信号详情:', tradeSignals)
    
    // 🔥 保存交易信号到专用变量（不会被周期切换覆盖）
    backtestTradeSignals.value = tradeSignals
    
    console.log('📊 backtestTradeSignals.value 已设置:', backtestTradeSignals.value.length, '个')
    
    // 7. 初始化并更新图表
    await nextTick()
    initBacktestChart()
    
    // 🔥 只使用日线数据，不需要聚合
    updateBacktestChart(fullKlineData, tradeSignals, auxiliaryData)
    
    console.log('📊 图表更新后 backtestTradeSignals.value:', backtestTradeSignals.value?.length || 0, '个')
    
    // 8. 保存回测结果
    try {
      // 🔥 构建增强的回测结果对象
      const enhancedResult = {
        id: `backtest_${strategy.id}_${Date.now()}`, // 生成唯一ID
        strategyId: strategy.id,
        strategyName: strategy.name,
        strategyType: strategy.type || 'trend',
        symbol: backtestForm.symbol,
        dataSource: backtestDataSource.value || 'unknown',
        period: chartPeriod.value || '1d',
        startDate: backtestForm.startDate,
        endDate: backtestForm.endDate,
        initialCapital: backtestForm.initialCapital,
        finalCapital: finalCapital,
        totalReturn: totalReturn,
        annualizedReturn: annualizedReturn,
        maxDrawdown: maxDrawdown,
        sharpeRatio: sharpeRatio,
        sortinoRatio: sortinoRatio,
        calmarRatio: calmarRatio,
        profitLossRatio: profitFactor,  // 🔥 使用 profitFactor
        totalTrades: sellTrades.length,
        winningTrades: profitTrades.length,
        losingTrades: lossTrades.length,
        winRate: winRate,
        trades: trades,
        signals: strategySignals,
        parameters: strategy.parameters,
        originalStrategy: {
          id: strategy.id,
          name: strategy.name,
          type: strategy.type,
          description: strategy.description,
          code: strategy.code,
          parameters: strategy.parameters
        },
        backtestParams: {
          initialCapital: backtestForm.initialCapital,
          fees: {
            buyFeeRate: 0.0003,
            sellFeeRate: 0.0013,
            stampTaxRate: 0.001
          },
          slippage: 0.0001
        },
        createdAt: new Date().toISOString()
      }
      
      // 🔥 保存到 localStorage（用于回测分析页面显示）
      try {
        strategyStore.saveBacktestToLocalStorage(enhancedResult)
        console.log('✅ 回测结果已保存到 localStorage')
      } catch (localStorageError) {
        console.error('❌ 保存到 localStorage 失败:', localStorageError)
      }
      
      // 🔥 保存到数据库
      const saveData = {
        strategyId: strategy.id,
        strategyName: strategy.name,
        symbol: backtestForm.symbol,
        startDate: backtestForm.startDate,
        endDate: backtestForm.endDate,
        initialCapital: backtestForm.initialCapital,
        finalCapital: finalCapital,
        totalReturn: totalReturn,
        annualizedReturn: annualizedReturn,
        maxDrawdown: maxDrawdown,
        totalTrades: sellTrades.length,
        winningTrades: profitTrades.length,
        losingTrades: lossTrades.length,
        winRate: winRate,
        trades: trades,
        signals: strategySignals,
        parameters: strategy.parameters,
        dataSource: backtestDataSource.value || 'unknown'
      }
      
      await axios.post('/api/backtest/save', saveData, {
        headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
      })
      
      console.log('✅ 回测结果已保存到数据库')
      ElMessage.success('回测完成，结果已保存')
    } catch (saveError) {
      console.error('❌ 保存回测结果失败:', saveError)
      ElMessage.warning('回测完成，但保存失败')
    }
    
  } catch (error) {
    console.error('❌ 回测异常:', error)
    ElMessage.error('回测失败：' + (error.response?.data?.message || error.message))
  } finally {
    backtesting.value = false
  }
}

// 生成回测K线数据（与SimpleTradingInterface保持一致）
async function generateBacktestKlineData(symbol, startDate, endDate) {
  // 🔥 优先尝试从后端API获取真实数据（使用与SimpleTradingInterface相同的API）
  try {
    console.log('🌐 尝试从后端API获取真实数据:', symbol)
    
    // 获取标的上市时间，从上市开始获取完整历史数据
    const instrumentInfo = getInstrumentInfo(symbol)
    const listingDate = new Date(instrumentInfo.listingDate)
    
    // 计算日期范围：从上市时间到现在
    const actualStartDate = startDate ? new Date(startDate) : listingDate
    const actualEndDate = endDate ? new Date(endDate) : new Date()
    
    console.log(`📅 获取历史数据: ${actualStartDate.toLocaleDateString()} - ${actualEndDate.toLocaleDateString()}`)
    
    // 转换周期格式
    const periodMap = {
      '1d': 'daily',
      '1w': 'weekly',
      '1M': 'monthly'
    }
    const period = periodMap[chartPeriod.value] || 'daily'
    
    // 🔥 使用与SimpleTradingInterface相同的API路径和方法
    const apiUrl = `${getApiBaseUrl()}/comprehensive-data/kline`
    console.log('📡 API URL:', apiUrl)
    
    const response = await axios.get(apiUrl, {
      headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
      params: {
        symbol,
        startDate: actualStartDate.toISOString().split('T')[0],
        endDate: actualEndDate.toISOString().split('T')[0],
        period
      },
      timeout: 30000 // 30秒超时
    })
    
    console.log('✅ 后端API响应:', response.data.source, '数据条数:', response.data.kline?.length || 0)
    
    if (response.data.kline && response.data.kline.length > 0) {
      // 🔥 记录数据源信息
      backtestDataSource.value = response.data.source || 'unknown'
      console.log(`📊 使用数据源: ${backtestDataSource.value}`)
      
      // 转换数据格式为 lightweight-charts 需要的格式
      return response.data.kline.map(item => ({
        time: toUnixSeconds(item.time || item.date || item.timestamp),
        open: parseFloat(item.open),
        high: parseFloat(item.high),
        low: parseFloat(item.low),
        close: parseFloat(item.close),
        volume: parseInt(item.volume || 0)
      }))
    }
  } catch (error) {
    console.warn('获取真实数据失败，使用模拟数据:', error.message)
  }
  
  // 🔥 生成模拟数据（完全采用SimpleTradingInterface的方法）
  backtestDataSource.value = 'enhanced_mock' // 标记为模拟数据
  console.log('📊 生成模拟K线数据:', symbol, startDate, endDate)
  
  const data = []
  
  // 获取标的信息（包含上市时间）
  const instrumentInfo = getInstrumentInfo(symbol)
  const listingDate = new Date(instrumentInfo.listingDate)
  const basePrice = instrumentInfo.basePrice
  
  // 🔥 关键改进：如果传入null，则从上市时间到现在生成完整数据
  let actualStartDate, end
  
  if (startDate === null || startDate === undefined) {
    // 从上市时间开始
    actualStartDate = listingDate
  } else {
    // 从指定日期或上市时间开始（取较晚的）
    const specifiedStart = new Date(startDate)
    actualStartDate = listingDate > specifiedStart ? listingDate : specifiedStart
  }
  
  if (endDate === null || endDate === undefined) {
    // 到当前时间
    end = new Date()
  } else {
    end = new Date(endDate)
  }
  
  console.log(`📅 标的: ${instrumentInfo.name}`)
  console.log(`📅 上市时间: ${listingDate.toLocaleDateString()}`)
  console.log(`📅 数据起始: ${actualStartDate.toLocaleDateString()}`)
  console.log(`📅 数据结束: ${end.toLocaleDateString()}`)
  
  // 验证日期有效性
  if (isNaN(actualStartDate.getTime()) || isNaN(end.getTime())) {
    console.error('❌ 日期无效！', { actualStartDate, end })
    throw new Error('日期参数无效')
  }
  
  if (actualStartDate >= end) {
    console.error('❌ 开始日期必须早于结束日期！', { actualStartDate, end })
    throw new Error('日期范围无效')
  }
  
  // 使用固定种子确保数据一致性
  let seed = getSymbolSeed(symbol)
  const seededRandom = () => {
    seed = (seed * 9301 + 49297) % 233280
    return seed / 233280
  }
  
  let currentPrice = basePrice
  
  // 🔥 针对沪深300优化：模拟真实的牛熊周期
  const isHS300 = symbol.includes('000300') || symbol.includes('sh000300')
  
  if (isHS300) {
    // 沪深300特殊处理：从807.78点到4660点，模拟真实走势
    const totalDays = Math.floor((end.getTime() - actualStartDate.getTime()) / (1000 * 60 * 60 * 24))
    const targetPrice = 4660 // 2026年2月的价格
    
    // 🔥 定义真实的牛熊周期（基于历史数据）
    const cycles = [
      { start: 0, end: 0.12, trend: 4.5, volatility: 0.025 },      // 2005-2007: 超级大牛市 (807 -> 6124)
      { start: 0.12, end: 0.18, trend: -3.5, volatility: 0.035 },  // 2007-2008: 暴跌 (6124 -> 1665)
      { start: 0.18, end: 0.28, trend: 1.2, volatility: 0.020 },   // 2008-2010: 反弹 (1665 -> 3300)
      { start: 0.28, end: 0.38, trend: -0.5, volatility: 0.018 },  // 2010-2012: 震荡下跌 (3300 -> 2100)
      { start: 0.38, end: 0.42, trend: 0.8, volatility: 0.015 },   // 2012-2014: 慢牛启动 (2100 -> 2500)
      { start: 0.42, end: 0.48, trend: 4.0, volatility: 0.030 },   // 2014-2015: 疯牛 (2500 -> 5380)
      { start: 0.48, end: 0.52, trend: -2.5, volatility: 0.040 },  // 2015-2016: 股灾 (5380 -> 2850)
      { start: 0.52, end: 0.62, trend: 0.3, volatility: 0.015 },   // 2016-2018: 震荡 (2850 -> 3100)
      { start: 0.62, end: 0.68, trend: 1.0, volatility: 0.020 },   // 2018-2020: 慢牛 (3100 -> 4200)
      { start: 0.68, end: 0.75, trend: 0.5, volatility: 0.018 },   // 2020-2021: 震荡上涨 (4200 -> 4800)
      { start: 0.75, end: 0.85, trend: -0.3, volatility: 0.020 },  // 2021-2023: 调整 (4800 -> 4200)
      { start: 0.85, end: 1.0, trend: 0.6, volatility: 0.015 }     // 2023-2026: 震荡上涨 (4200 -> 4660)
    ]
    
    let dayCount = 0
    
    for (let d = new Date(actualStartDate); d <= end; d.setDate(d.getDate() + 1)) {
      // 跳过周末
      if (d.getDay() !== 0 && d.getDay() !== 6) {
        const progress = dayCount / totalDays
        
        // 找到当前所在的周期
        let currentCycle = cycles[cycles.length - 1]
        for (const cycle of cycles) {
          if (progress >= cycle.start && progress < cycle.end) {
            currentCycle = cycle
            break
          }
        }
        
        // 计算趋势因子和波动率
        const trendFactor = currentCycle.trend * 0.0003 // 每日趋势
        const volatility = currentCycle.volatility // 使用周期特定的波动率
        
        // 生成价格变化
        const randomChange = (seededRandom() - 0.5) * volatility
        const trendChange = trendFactor
        const totalChange = randomChange + trendChange
        
        const open = currentPrice
        const close = open * (1 + totalChange)
        const high = Math.max(open, close) * (1 + seededRandom() * volatility * 0.3)
        const low = Math.min(open, close) * (1 - seededRandom() * volatility * 0.3)
        
        // 生成成交量
        const baseVolume = 50000000 // 5000万手
        const volumeVariation = (seededRandom() - 0.5) * 0.5 + 1
        const volume = Math.floor(baseVolume * volumeVariation * (1 + Math.abs(totalChange) * 10))
        
        data.push({
          time: Math.floor(d.getTime() / 1000),
          open: parseFloat(open.toFixed(2)),
          high: parseFloat(high.toFixed(2)),
          low: parseFloat(low.toFixed(2)),
          close: parseFloat(close.toFixed(2)),
          volume: volume
        })
        
        currentPrice = close
        dayCount++
      }
    }
  } else {
    // 其他标的：使用原来的简单算法
    const volatility = 0.025 // 日线波动率（2.5%）
    const trendFactor = 0.002 // 趋势因子（长期上涨）
    
    let dayCount = 0
    const totalDays = Math.floor((end.getTime() - actualStartDate.getTime()) / (1000 * 60 * 60 * 24))
    
    for (let d = new Date(actualStartDate); d <= end; d.setDate(d.getDate() + 1)) {
      // 跳过周末
      if (d.getDay() !== 0 && d.getDay() !== 6) {
        // 🔥 添加长期趋势（模拟股票长期上涨）
        const longTermTrend = Math.pow(1 + trendFactor, dayCount / totalDays)
        
        // 生成价格变化
        const change = (seededRandom() - 0.5) * volatility
        const open = currentPrice
        const close = open * (1 + change) * longTermTrend
        const high = Math.max(open, close) * (1 + seededRandom() * volatility * 0.5)
        const low = Math.min(open, close) * (1 - seededRandom() * volatility * 0.5)
        
        // 生成成交量（基于价格波动）
        const baseVolume = 10000000
        const volumeVariation = (seededRandom() - 0.5) * 0.5 + 1 // 0.75 - 1.25倍
        const volume = Math.floor(baseVolume * volumeVariation * (1 + Math.abs(change) * 10))
        
        data.push({
          time: Math.floor(d.getTime() / 1000),
          open: parseFloat(open.toFixed(2)),
          high: parseFloat(high.toFixed(2)),
          low: parseFloat(low.toFixed(2)),
          close: parseFloat(close.toFixed(2)),
          volume: volume
        })
        
        currentPrice = close
        dayCount++
      }
    }
  }
  
  console.log(`✅ 模拟K线数据生成完成: ${data.length} 条`)
  if (data.length > 0) {
    console.log(`📊 价格范围: ${basePrice.toFixed(2)} -> ${currentPrice.toFixed(2)}`)
    console.log(`📊 时间范围: ${new Date(data[0].time * 1000).toLocaleDateString()} - ${new Date(data[data.length-1].time * 1000).toLocaleDateString()}`)
  } else {
    console.error('❌ 生成的K线数据为空！')
    console.error('❌ 参数:', { symbol, actualStartDate, end })
  }
  
  return data
}

// 获取标的信息（包含上市时间和基础价格）
function getInstrumentInfo(symbol) {
  const instrumentMap = {
    // 主要指数
    'sh000001': { listingDate: '1991-07-15', basePrice: 100, name: '上证指数' },
    '000001.SH': { listingDate: '1991-07-15', basePrice: 100, name: '上证指数' },
    'sh000300': { listingDate: '2005-04-08', basePrice: 807.78, name: '沪深300' }, // 🔥 真实上市价格
    '000300.SH': { listingDate: '2005-04-08', basePrice: 807.78, name: '沪深300' }, // 🔥 真实上市价格
    'sz399001': { listingDate: '1991-04-03', basePrice: 1000, name: '深证成指' },
    '399001.SZ': { listingDate: '1991-04-03', basePrice: 1000, name: '深证成指' },
    'sz399006': { listingDate: '2010-06-01', basePrice: 1000, name: '创业板指' },
    '399006.SZ': { listingDate: '2010-06-01', basePrice: 1000, name: '创业板指' },
    
    // 知名股票
    'sh600519': { listingDate: '2001-08-27', basePrice: 10, name: '贵州茅台' },
    '600519.SH': { listingDate: '2001-08-27', basePrice: 10, name: '贵州茅台' },
    'sz000002': { listingDate: '1991-01-29', basePrice: 5, name: '万科A' },
    '000002.SZ': { listingDate: '1991-01-29', basePrice: 5, name: '万科A' },
    'sh600036': { listingDate: '2002-04-09', basePrice: 8, name: '招商银行' },
    '600036.SH': { listingDate: '2002-04-09', basePrice: 8, name: '招商银行' },
    'sz000001': { listingDate: '1991-04-03', basePrice: 3, name: '平安银行' },
    '000001.SZ': { listingDate: '1991-04-03', basePrice: 3, name: '平安银行' },
    
    // 期货
    'CU2312.SHFE': { listingDate: '2023-01-01', basePrice: 60000, name: '铜2312' },
    'AU2312.SHFE': { listingDate: '2023-01-01', basePrice: 400, name: '黄金2312' },
  }
  
  return instrumentMap[symbol] || { 
    listingDate: '2000-01-01', 
    basePrice: 10, 
    name: '未知标的' 
  }
}

// 根据标的代码生成种子
function getSymbolSeed(symbol) {
  let hash = 0
  for (let i = 0; i < symbol.length; i++) {
    const char = symbol.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash
  }
  return Math.abs(hash) % 100000 + 12345
}

// 聚合K线数据（日线 -> 周线/月线/年线）
function aggregateKlineData(dailyData, period) {
  if (period === '1d') {
    return dailyData // 日线不需要聚合
  }
  
  console.log(`📊 开始聚合数据: ${dailyData.length} 条日线 -> ${period}`)
  
  const aggregated = []
  let currentBar = null
  
  for (let i = 0; i < dailyData.length; i++) {
    const candle = dailyData[i]
    const date = new Date(candle.time * 1000)
    
    // 判断是否需要开始新的聚合周期
    let startNewBar = false
    
    if (!currentBar) {
      startNewBar = true
    } else {
      const currentDate = new Date(currentBar.time * 1000)
      
      switch (period) {
        case '1w': // 周线：每周一开始新bar
          if (date.getDay() === 1 && date.getTime() - currentDate.getTime() > 86400000) {
            startNewBar = true
          }
          break
        case '1M': // 月线：每月1号开始新bar
          if (date.getDate() === 1 || date.getMonth() !== currentDate.getMonth()) {
            startNewBar = true
          }
          break
        case '1Y': // 年线：每年开始新bar（只在年份变化时）
          if (date.getFullYear() !== currentDate.getFullYear()) {
            startNewBar = true
          }
          break
      }
    }
    
    if (startNewBar) {
      // 保存上一个bar
      if (currentBar) {
        aggregated.push(currentBar)
      }
      
      // 开始新bar
      currentBar = {
        time: candle.time,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume
      }
    } else {
      // 更新当前bar
      currentBar.high = Math.max(currentBar.high, candle.high)
      currentBar.low = Math.min(currentBar.low, candle.low)
      currentBar.close = candle.close
      currentBar.volume += candle.volume
    }
  }
  
  // 添加最后一个bar
  if (currentBar) {
    aggregated.push(currentBar)
  }
  
  console.log(`✅ 聚合完成: ${aggregated.length} 条${period}`)
  return aggregated
}

// 执行策略代码
async function executeStrategyCode(strategy, klineData) {
  if (!strategy || !strategy.code) {
    console.warn('⚠️ 策略或策略代码不存在')
    return { signals: [], auxiliaryData: {} }
  }
  
  try {
    console.log('🚀 执行策略代码:', strategy.name, '语言:', strategy.language)
    console.log('📊 K线数据:', klineData.length, '条')
    
    // All languages execute via backend vm sandbox
    try {
      console.log('📝 策略代码长度:', strategy.code.length, '字符, 语言:', strategy.language || 'javascript')
      const result = await executeSandbox({
        code: strategy.code,
        klineData,
        parameters: strategy.parameters || {},
        language: strategy.language || 'javascript'
      })
      console.log('✅ 策略沙箱执行完成, signals:', result.signals?.length || 0)
      return result
    } catch (error) {
      console.error('❌ 策略执行失败:', error)
      throw new Error('策略执行失败: ' + error.message)
    }
  } catch (error) {
    console.error('❌ 策略执行异常:', error)
    throw error
  }
}

// 初始化回测图表
function initBacktestChart() {
  if (!backtestChartContainer.value) {
    console.warn('图表容器不存在')
    return
  }
  
  // 如果图表已存在，先销毁
  if (backtestChart.value) {
    backtestChart.value.remove()
    backtestChart.value = null
  }
  
  try {
    backtestChart.value = createChart(backtestChartContainer.value, {
      width: backtestChartContainer.value.clientWidth,
      height: 500,
      layout: {
        background: { color: '#2d2d2d' },
        textColor: '#e0e0e0'
      },
      grid: {
        vertLines: { color: '#404040' },
        horzLines: { color: '#404040' }
      },
      crosshair: {
        mode: 0, // 禁用 crosshair 模式以避免错误
        vertLine: { visible: false },
        horzLine: { visible: false }
      },
      rightPriceScale: {
        borderColor: '#606060',
        textColor: '#e0e0e0'
      },
      timeScale: {
        borderColor: '#606060',
        textColor: '#e0e0e0',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 12,
        barSpacing: 3,
        fixLeftEdge: false,
        lockVisibleTimeRangeOnResize: true,
        rightBarStaysOnScroll: true,
        borderVisible: false,
        visible: true,
        ticksVisible: true,
        tickMarkFormatter: (time, tickMarkType, locale) => {
          const date = new Date(time * 1000)
          // 只支持日线，使用简单的日期格式
          return date.toLocaleDateString('zh-CN', { 
            year: '2-digit',
            month: '2-digit',
            day: '2-digit'
          })
        }
      }
    })
    
    backtestCandlestickSeries.value = backtestChart.value.addCandlestickSeries({
      upColor: '#ff6b6b',
      downColor: '#51cf66',
      borderVisible: false,
      wickUpColor: '#ff6b6b',
      wickDownColor: '#51cf66'
    })
    
    console.log('✅ 回测图表初始化成功')
  } catch (error) {
    console.error('❌ 回测图表初始化失败:', error)
  }
}

// 更新回测图表
function updateBacktestChart(klineData, signals, auxiliaryData) {
  if (!backtestChart.value || !backtestCandlestickSeries.value) {
    console.warn('图表未初始化')
    return
  }
  
  try {
    // 设置K线数据
    backtestCandlestickSeries.value.setData(klineData)
    console.log('✅ K线数据已设置:', klineData.length, '条')
    
    // 显示信号标记
    if (showSignalsOnChart.value && signals && signals.length > 0) {
      displaySignalsOnBacktestChart(signals, klineData)
    }
    
    // 显示辅助线
    if (showAuxiliaryLines.value && auxiliaryData && Object.keys(auxiliaryData).length > 0) {
      console.log('📊 准备显示辅助线，数量:', Object.keys(auxiliaryData).length)
      displayAuxiliaryLinesOnChart(auxiliaryData)
    }
    
    console.log('✅ 回测图表更新成功')
  } catch (error) {
    console.error('❌ 回测图表更新失败:', error)
  }
}

// 在回测图表上显示信号
function displaySignalsOnBacktestChart(signals, klineData) {
  if (!backtestChart.value || !signals || signals.length === 0) {
    console.warn('⚠️ 图表或信号不存在')
    return
  }
  
  try {
    console.log('🎯 准备显示信号标记:', signals.length, '个')
    console.log('📊 K线数据范围:', klineData.length, '条')
    console.log('📊 信号示例:', signals.slice(0, 3))
    
    const markers = []
    
    for (const signal of signals) {
      // 跳过hold信号
      if (signal.type === 'hold') continue
      
      const isBuy = signal.type === 'buy' || signal.type === 'open_long'
      
      // 确定信号时间
      let signalTime = signal.time
      
      // 如果信号有index，使用K线数据的时间
      if (signal.index !== undefined && klineData[signal.index]) {
        signalTime = klineData[signal.index].time
      }
      
      // 如果时间无效，跳过
      if (!signalTime) {
        console.warn('⚠️ 信号时间无效:', signal)
        continue
      }
      
      markers.push({
        time: signalTime,
        position: isBuy ? 'belowBar' : 'aboveBar',
        color: isBuy ? '#26a69a' : '#ef5350',
        shape: isBuy ? 'arrowUp' : 'arrowDown',
        text: (signal.reason || (isBuy ? '买' : '卖')).substring(0, 10)  // 🔥 限制文本长度
      })
    }
    
    if (markers.length > 0) {
      console.log('📊 准备设置的标记数据:', markers)
      console.log('📊 第一个标记:', markers[0])
      console.log('📊 K线时间范围:', {
        first: klineData[0]?.time,
        last: klineData[klineData.length - 1]?.time
      })

      // Set markers directly (no clear-then-set to avoid flicker)
      backtestCandlestickSeries.value.setMarkers(markers)
      console.log('✅ 信号标记已显示:', markers.length, '个')

      if (backtestChart.value) {
        backtestChart.value.timeScale().fitContent()
      }
    } else {
      console.warn('⚠️ 没有有效的信号标记')
    }
  } catch (error) {
    console.error('❌ 显示信号标记失败:', error)
  }
}

// 在图表上显示辅助线
function displayAuxiliaryLinesOnChart(auxiliaryData) {
  if (!backtestChart.value || !auxiliaryData || !backtestKlineData.value) {
    console.warn('⚠️ 图表、辅助线数据或K线数据不存在')
    return
  }
  
  try {
    console.log('🎨 开始显示辅助线:', Object.keys(auxiliaryData))
    console.log('🎨 辅助线数据详情:', auxiliaryData)
    
    const klineData = backtestKlineData.value
    let successCount = 0
    
    // 遍历所有辅助线数据
    Object.keys(auxiliaryData).forEach(lineName => {
      const lineConfig = auxiliaryData[lineName]
      
      if (!lineConfig || !lineConfig.data || !Array.isArray(lineConfig.data)) {
        console.warn(`⚠️ 辅助线 "${lineName}" 数据格式不正确:`, lineConfig)
        return
      }
      
      console.log(`📊 处理辅助线 "${lineName}"，原始数据点数:`, lineConfig.data.length)
      
      // 基于当前K线数据重新计算辅助线
      const expandedLineData = []
      const period = 20  // 箱体周期
      
      // 根据辅助线类型重新计算
      if (lineName === '多线' || lineName.includes('上轨')) {
        // 多线（箱体上轨）：使用滚动窗口的最高价
        klineData.forEach((candle, index) => {
          const start = Math.max(0, index - period + 1)
          const slice = klineData.slice(start, index + 1)
          const high = Math.max(...slice.map(c => c.high))
          expandedLineData.push({
            time: candle.time,
            value: parseFloat(high.toFixed(2))
          })
        })
        console.log(`✅ 多线重新计算完成: ${expandedLineData.length} 个数据点`)
      } else if (lineName === '空线' || lineName.includes('下轨')) {
        // 空线（箱体下轨）：使用滚动窗口的最低价
        klineData.forEach((candle, index) => {
          const start = Math.max(0, index - period + 1)
          const slice = klineData.slice(start, index + 1)
          const low = Math.min(...slice.map(c => c.low))
          expandedLineData.push({
            time: candle.time,
            value: parseFloat(low.toFixed(2))
          })
        })
        console.log(`✅ 空线重新计算完成: ${expandedLineData.length} 个数据点`)
      } else if (lineName === '箱体中线' || lineName.includes('中线')) {
        // 箱体中线：上轨和下轨的平均值
        klineData.forEach((candle, index) => {
          const start = Math.max(0, index - period + 1)
          const slice = klineData.slice(start, index + 1)
          const high = Math.max(...slice.map(c => c.high))
          const low = Math.min(...slice.map(c => c.low))
          const mid = (high + low) / 2
          expandedLineData.push({
            time: candle.time,
            value: parseFloat(mid.toFixed(2))
          })
        })
        console.log(`✅ 箱体中线重新计算完成: ${expandedLineData.length} 个数据点`)
      } else if (lineName.startsWith('MA')) {
        // 移动平均线：直接使用原始数据
        lineConfig.data.forEach(point => {
          if (point && point.time !== undefined && point.value !== undefined && point.value !== null) {
            expandedLineData.push({
              time: point.time,
              value: parseFloat(point.value.toFixed(2))
            })
          }
        })
        console.log(`✅ ${lineName} 数据处理完成: ${expandedLineData.length} 个数据点`)
      } else {
        // 其他类型的辅助线，直接使用原始数据
        lineConfig.data.forEach(point => {
          if (point && point.time !== undefined && point.value !== undefined && point.value !== null) {
            expandedLineData.push({
              time: point.time,
              value: parseFloat(point.value.toFixed(2))
            })
          }
        })
        console.log(`✅ ${lineName} 数据处理完成: ${expandedLineData.length} 个数据点`)
      }
      
      if (expandedLineData.length === 0) {
        console.warn(`⚠️ 辅助线 "${lineName}" 没有有效数据点`)
        return
      }
      
      // 创建线条系列
      const lineStyle = lineConfig.lineStyle !== undefined ? lineConfig.lineStyle : 0
      const lineWidth = lineConfig.lineWidth || 2
      const color = lineConfig.color || getLineColor(lineName)
      
      try {
        const lineSeries = backtestChart.value.addLineSeries({
          color: color,
          lineWidth: lineWidth,
          lineStyle: lineStyle,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false
        })
        
        lineSeries.setData(expandedLineData)
        successCount++
        console.log(`✅ 辅助线 "${lineName}" 显示成功，颜色: ${color}`)
      } catch (error) {
        console.error(`❌ 显示辅助线 "${lineName}" 失败:`, error)
      }
    })
    
    console.log(`✅ 辅助线显示完成，成功: ${successCount}/${Object.keys(auxiliaryData).length}`)
  } catch (error) {
    console.error('❌ 显示辅助线失败:', error)
  }
}

// 获取线条颜色
function getLineColor(key) {
  const colors = {
    'MA5': '#FF6B6B',
    'MA10': '#4ECDC4',
    'MA20': '#45B7D1',
    'MA30': '#FFA07A',
    'MA60': '#96CEB4',
    'upper': '#FF6B6B',
    'middle': '#4ECDC4',
    'lower': '#45B7D1',
    '多线': '#FF6B6B',
    '空线': '#26a69a',
    '箱体中线': '#FFA726',
    'BOLL_UPPER': '#FF6B6B',
    'BOLL_MIDDLE': '#4ECDC4',
    'BOLL_LOWER': '#45B7D1'
  }
  return colors[key] || '#999999'
}

// 计算指标（简化版）
function calculateIndicators(data) {
  const calculateMA = (data, period) => {
    const ma = []
    for (let i = 0; i < data.length; i++) {
      if (i < period - 1) {
        ma.push(null)  // 使用null而不是'-'
      } else {
        let sum = 0
        for (let j = 0; j < period; j++) {
          sum += data[i - j].close
        }
        ma.push(parseFloat((sum / period).toFixed(2)))  // 转换为数字
      }
    }
    return ma
  }

  return {
    ma5: calculateMA(data, 5),
    ma10: calculateMA(data, 10),
    ma20: calculateMA(data, 20),
    ma30: calculateMA(data, 30)
  }
}

// 移动端操作菜单处理
function handleMobileAction(command, row) {
  switch (command) {
    case 'view':
      viewStrategy(row)
      break
    case 'backtest':
      backtestStrategy(row)
      break
    case 'edit':
      editStrategy(row)
      break
    case 'delete':
      handleDeleteStrategy(row)
      break
    default:
      console.warn('未知的操作命令:', command)
  }
}

// 删除策略
async function handleDeleteStrategy(strategy) {
  try {
    await ElMessageBox.confirm('确定要删除该策略吗？', '提示', {
      type: 'warning'
    })
    
    await strategyStore.deleteStrategy(strategy.id)
  } catch (error) {
    if (error !== 'cancel') {
      console.error('删除策略失败:', error)
    }
  }
}

// 重置表单
function resetForm() {
  editingStrategy.value = null
  strategyForm.name = ''
  strategyForm.description = ''
  strategyForm.code = ''
  strategyForm.type = 'trend'
  strategyForm.parameters = {}
  strategyForm.isPublic = false
  strategyForm.language = 'javascript'
  parametersJson.value = '{}'
}

// 行点击
function handleRowClick(row) {
  viewStrategy(row)
}

// 辅助函数
function getTypeName(type) {
  const map = {
    trend: '趋势',
    mean_reversion: '均值回归',
    momentum: '动量',
    arbitrage: '套利',
    market_making: '做市',
    other: '其他'
  }
  return map[type] || type
}

function getTypeColor(type) {
  const map = {
    trend: 'primary',
    mean_reversion: 'success',
    momentum: 'warning',
    arbitrage: 'warning',
    market_making: 'danger',
    other: 'info'
  }
  return map[type] || 'info'
}

function getStatusName(status) {
  const map = {
    draft: '草稿',
    active: '运行中',
    paused: '已暂停',
    archived: '已归档'
  }
  return map[status] || status
}

function getStatusColor(status) {
  const map = {
    draft: 'info',
    active: 'success',
    paused: 'warning',
    archived: 'info'
  }
  return map[status] || 'info'
}

function getSymbolName(symbol) {
  const instrument = availableInstruments.value.find(item => item.code === symbol)
  return instrument ? instrument.name : symbol
}

function formatDate(date) {
  if (!date) return '-'
  const d = new Date(date)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// 🔥 新增：获取数据源显示名称
function getDataSourceName(source) {
  const sourceMap = {
    'adata': 'AData',
    'akshare': 'AKShare',
    'tick_csv': '逐笔CSV数据',
    'mock': '增强模拟数据',
    'enhanced_mock': '增强模拟数据'
  }
  return sourceMap[source] || source || '未知'
}

// 🔥 新增：获取数据源标签类型
function getDataSourceTagType(source) {
  if (source === 'adata' || source === 'akshare') {
    return 'success' // 真实数据源用绿色
  } else if (source === 'tick_csv') {
    return 'primary'
  } else if (source === 'mock' || source === 'enhanced_mock') {
    return 'warning' // 增强模拟数据用橙色
  }
  return 'info'
}

// 获取代码占位符
function getCodePlaceholder() {
  if (strategyForm.language === 'tdx' || strategyForm.language === 'tongdaxin') {
    return `请输入通达信公式代码

示例 - 凯利公式多空策略：

{变量赋值}
允许损比:=1/15;
总资金:=90000;
开仓额:=总资金*允许损比,NODRAW;
交易单位:=UNIT;
有效周期:=BARPOS,NODRAW;

波高:=MAX(HIGH,HHV(LOW,2));
波低:=MIN(LOW,LLV(HIGH,2));

{多空}
步距:=波高-LLV(波高,2)+HHV(波低,2)-波低;
步距程:=SUM(步距,有效周期);
波距:=波高-波低,NODRAW;
多空路程:=MAX(5*MINPRICE,波距);
时多空:=IF(步距程>多空路程,SUMBARS(步距,多空路程),有效周期);

多:HHV(波高,时多空),COLORRED,DOT;
空:LLV(波低,时多空),COLORGREEN,DOT;

{交易条件}
多入:=多升 AND COUNT(多升,空降周期)=1;
空出:=空降 AND COUNT(空降,多升周期)=1;

支持的函数：
- MAX, MIN, ABS, SQRT, POW, MOD, FLOOR
- HHV, LLV, SUM, COUNT, BARSLAST, SUMBARS
- IF, REF, VALUEWHEN
- 系统变量：HIGH, LOW, OPEN, CLOSE, VOLUME, BARPOS`
  } else if (strategyForm.language === 'python') {
    return `请输入Python策略代码

支持多种编写方式：

方式1 - 标准函数：
def strategy(data, params):
    # 你的策略逻辑
    return signals

方式2 - 任意函数名：
def my_trading_strategy(data, params):
    # 你的策略逻辑
    return signals

方式3 - 类方式：
class MyStrategy:
    def execute(self, data, params):
        # 你的策略逻辑
        return signals

方式4 - 直接执行：
# 直接编写逻辑代码
signals = []
for i, row in enumerate(data):
    # 你的策略逻辑
    signals.append({'type': 'hold', 'index': i})

系统会自动检测并执行你的代码！`
  } else {
    return `请输入JavaScript策略代码

支持多种编写方式：

方式1 - 标准函数：
function strategy(data, params) {
  // 你的策略逻辑
  return signals;
}

方式2 - 任意函数名：
function myTradingStrategy(data, params) {
  // 你的策略逻辑
  return signals;
}

方式3 - 箭头函数：
const strategy = (data, params) => {
  // 你的策略逻辑
  return signals;
};

方式4 - 类方式：
class MyStrategy {
  execute(data, params) {
    // 你的策略逻辑
    return signals;
  }
}

系统会自动检测并执行你的代码！`
  }
}

// 获取策略提示
function getStrategyTips() {
  if (strategyForm.language === 'python') {
    return `Python策略编写提示：
• 支持任意函数名，系统会自动检测入口点
• 推荐函数名：strategy, execute, run, main, trade
• 参数格式：data (K线数据列表), params (策略参数字典)
• 返回格式：信号列表 [{'type': 'buy'|'sell'|'hold', 'index': 索引, 'price': 价格, 'reason': '原因'}]
• 可以使用 pandas, numpy 等库进行数据分析
• 支持类方法、直接执行等多种编写方式
• 系统会智能适配你的代码结构`
  } else {
    return `JavaScript策略编写提示：
• 支持任意函数名，系统会自动检测入口点
• 推荐函数名：strategy, execute, run, main, trade
• 参数格式：data (K线数据数组), params (策略参数对象)
• 返回格式：信号数组 [{type: 'buy'|'sell'|'hold', index: 索引, price: 价格, reason: '原因'}]
• 支持函数、箭头函数、类方法等多种编写方式
• 系统会智能适配你的代码结构`
  }
}

function getLanguageName(language) {
  const map = {
    javascript: 'JavaScript',
    python: 'Python',
    tdx: '通达信',
    tongdaxin: '通达信'
  }
  return map[language] || language
}

function getLanguageColor(language) {
  const map = {
    javascript: 'warning',
    python: 'success',
    tdx: 'danger',
    tongdaxin: 'danger'
  }
  return map[language] || 'info'
}

// 语言切换处理
function onLanguageChange(newLanguage) {
  // 如果切换语言且当前有代码，询问是否清空
  if (strategyForm.code && strategyForm.code.trim()) {
    ElMessageBox.confirm(
      '切换语言将清空当前代码，是否继续？',
      '提示',
      {
        type: 'warning'
      }
    ).then(() => {
      strategyForm.code = ''
    }).catch(() => {
      // 用户取消，恢复原语言
      strategyForm.language = newLanguage === 'python' ? 'javascript' : 'python'
    })
  }
}

// 处理通达信公式解析
function handleTdxParse(result) {
  console.log('📊 通达信公式解析结果:', result)
  
  // 如果有参数，自动填充到参数JSON
  if (result.parameters && result.parameters.length > 0) {
    const paramsObj = {}
    result.parameters.forEach(param => {
      paramsObj[param.name] = param.value
    })
    parametersJson.value = JSON.stringify(paramsObj, null, 2)
  }
  
  // 显示解析统计
  ElMessage.success({
    message: `解析成功：识别 ${result.variables.length} 个变量，${result.parameters.length} 个参数`,
    duration: 3000
  })
}

// ==================== 🔥 批量管理功能 ====================

// 处理选择变化
function handleSelectionChange(selection) {
  selectedStrategyIds.value = selection.map(s => s.id)
  console.log('📊 已选择策略:', selectedStrategyIds.value)
}

// 清除选择
function clearSelection() {
  if (strategyTable.value) {
    strategyTable.value.clearSelection()
  }
  selectedStrategyIds.value = []
}

// 批量删除
async function handleBatchDelete() {
  if (selectedStrategyIds.value.length === 0) {
    ElMessage.warning('请先选择要删除的策略')
    return
  }

  try {
    await ElMessageBox.confirm(
      `确定要删除选中的 ${selectedStrategyIds.value.length} 个策略吗？此操作不可恢复！`,
      '批量删除确认',
      {
        type: 'warning',
        confirmButtonText: '确定删除',
        cancelButtonText: '取消'
      }
    )

    loading.value = true
    let successCount = 0
    let failCount = 0

    // 逐个删除策略
    for (const id of selectedStrategyIds.value) {
      try {
        await strategyStore.deleteStrategy(id)
        successCount++
      } catch (error) {
        console.error(`删除策略 ${id} 失败:`, error)
        failCount++
      }
    }

    // 显示结果
    if (failCount === 0) {
      ElMessage.success(`成功删除 ${successCount} 个策略`)
    } else {
      ElMessage.warning(`删除完成：成功 ${successCount} 个，失败 ${failCount} 个`)
    }

    // 清除选择并刷新列表
    clearSelection()
    await loadStrategies()
  } catch (error) {
    if (error !== 'cancel') {
      console.error('批量删除失败:', error)
      ElMessage.error('批量删除失败')
    }
  } finally {
    loading.value = false
  }
}

// 批量切换状态
async function handleBatchToggleStatus(status) {
  if (selectedStrategyIds.value.length === 0) {
    ElMessage.warning('请先选择要操作的策略')
    return
  }

  const statusName = status === 'active' ? '启用' : '暂停'

  try {
    await ElMessageBox.confirm(
      `确定要${statusName}选中的 ${selectedStrategyIds.value.length} 个策略吗？`,
      `批量${statusName}确认`,
      {
        type: 'info',
        confirmButtonText: `确定${statusName}`,
        cancelButtonText: '取消'
      }
    )

    loading.value = true
    let successCount = 0
    let failCount = 0

    // 逐个更新策略状态
    for (const id of selectedStrategyIds.value) {
      try {
        const strategy = strategyStore.getStrategy(id)
        if (strategy) {
          await strategyStore.updateStrategy(id, { status })
          successCount++
        }
      } catch (error) {
        console.error(`更新策略 ${id} 状态失败:`, error)
        failCount++
      }
    }

    // 显示结果
    if (failCount === 0) {
      ElMessage.success(`成功${statusName} ${successCount} 个策略`)
    } else {
      ElMessage.warning(`操作完成：成功 ${successCount} 个，失败 ${failCount} 个`)
    }

    // 清除选择并刷新列表
    clearSelection()
    await loadStrategies()
  } catch (error) {
    if (error !== 'cancel') {
      console.error('批量更新状态失败:', error)
      ElMessage.error('批量更新状态失败')
    }
  } finally {
    loading.value = false
  }
}

// 批量导出
function handleBatchExport() {
  if (selectedStrategyIds.value.length === 0) {
    ElMessage.warning('请先选择要导出的策略')
    return
  }

  try {
    // 获取选中的策略数据
    const selectedStrategies = selectedStrategyIds.value.map(id => {
      const strategy = strategyStore.getStrategy(id)
      return {
        name: strategy.name,
        description: strategy.description,
        type: strategy.type,
        language: strategy.language,
        code: strategy.code,
        parameters: strategy.parameters,
        isPublic: strategy.isPublic,
        createdAt: strategy.createdAt
      }
    })

    // 生成JSON文件
    const jsonStr = JSON.stringify(selectedStrategies, null, 2)
    const blob = new Blob([jsonStr], { type: 'application/json' })
    const url = URL.createObjectURL(blob)

    // 创建下载链接
    const link = document.createElement('a')
    link.href = url
    const timestamp = new Date().toISOString().split('T')[0].replace(/-/g, '')
    link.download = `strategies_export_${timestamp}.json`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)

    ElMessage.success(`成功导出 ${selectedStrategies.length} 个策略`)
    clearSelection()
  } catch (error) {
    console.error('批量导出失败:', error)
    ElMessage.error('批量导出失败')
  }
}

// 批量复制
async function handleBatchCopy() {
  if (selectedStrategyIds.value.length === 0) {
    ElMessage.warning('请先选择要复制的策略')
    return
  }

  try {
    await ElMessageBox.confirm(
      `确定要复制选中的 ${selectedStrategyIds.value.length} 个策略吗？`,
      '批量复制确认',
      {
        type: 'info',
        confirmButtonText: '确定复制',
        cancelButtonText: '取消'
      }
    )

    loading.value = true
    let successCount = 0
    let failCount = 0

    // 逐个复制策略
    for (const id of selectedStrategyIds.value) {
      try {
        const strategy = strategyStore.getStrategy(id)
        if (strategy) {
          // 创建副本
          const copyData = {
            name: `${strategy.name} (副本)`,
            description: strategy.description,
            type: strategy.type,
            language: strategy.language,
            code: strategy.code,
            parameters: strategy.parameters,
            isPublic: false // 副本默认不公开
          }
          await strategyStore.createStrategy(copyData)
          successCount++
        }
      } catch (error) {
        console.error(`复制策略 ${id} 失败:`, error)
        failCount++
      }
    }

    // 显示结果
    if (failCount === 0) {
      ElMessage.success(`成功复制 ${successCount} 个策略`)
    } else {
      ElMessage.warning(`复制完成：成功 ${successCount} 个，失败 ${failCount} 个`)
    }

    // 清除选择并刷新列表
    clearSelection()
    await loadStrategies()
  } catch (error) {
    if (error !== 'cancel') {
      console.error('批量复制失败:', error)
      ElMessage.error('批量复制失败')
    }
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.strategies-page {
  padding: 0;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.header-actions {
  display: flex;
  gap: 10px;
}

.code-editor-wrapper {
  width: 100%;
}

.code-editor :deep(textarea) {
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  font-size: 13px;
  line-height: 1.5;
}

.code-tips {
  margin-top: 10px;
}

.code-tips pre {
  background: #f5f5f5;
  padding: 10px;
  border-radius: 4px;
  font-size: 12px;
  line-height: 1.5;
}

.template-card {
  cursor: pointer;
  transition: all 0.3s;
}

.template-card:hover {
  transform: translateY(-4px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}

.template-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.template-icons {
  display: flex;
  align-items: center;
}

.template-name {
  font-weight: bold;
  font-size: 16px;
}

.template-icon {
  font-size: 20px;
  color: #409eff;
}

.template-description {
  color: #666;
  margin-bottom: 10px;
  min-height: 40px;
}

.template-params {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.backtest-result {
  margin-top: 20px;
}

/* Ensure dialog body is scrollable when content is tall */
:deep(.el-dialog__body) {
  max-height: calc(94vh - 80px);
  overflow-y: auto;
}

:deep(.el-table__row) {
  cursor: pointer;
}

:deep(.el-table__row:hover) {
  background-color: #f5f7fa;
}

.instrument-option {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
}

.instrument-name {
  font-weight: bold;
  flex: 1;
}

.instrument-code {
  color: #2962FF;
  font-family: 'Consolas', 'Monaco', monospace;
  margin: 0 8px;
}

.instrument-sector {
  color: #888;
  font-size: 12px;
}

/* 🔥 批量操作工具栏样式 */
.batch-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  border-radius: 8px;
  margin-bottom: 16px;
  box-shadow: 0 2px 8px rgba(102, 126, 234, 0.3);
}

.batch-info {
  color: white;
  font-size: 14px;
}

.batch-info strong {
  font-size: 18px;
  font-weight: 600;
  margin: 0 4px;
}

.batch-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.batch-actions .el-button {
  border: none;
  background: rgba(255, 255, 255, 0.2);
  color: white;
  transition: all 0.3s;
}

.batch-actions .el-button:hover {
  background: rgba(255, 255, 255, 0.3);
  transform: translateY(-2px);
  box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
}

.batch-actions .el-button.is-danger {
  background: rgba(245, 108, 108, 0.3);
}

.batch-actions .el-button.is-danger:hover {
  background: rgba(245, 108, 108, 0.5);
}

.batch-actions .el-button.is-success {
  background: rgba(103, 194, 58, 0.3);
}

.batch-actions .el-button.is-success:hover {
  background: rgba(103, 194, 58, 0.5);
}

.batch-actions .el-button.is-warning {
  background: rgba(230, 162, 60, 0.3);
}

.batch-actions .el-button.is-warning:hover {
  background: rgba(230, 162, 60, 0.5);
}

.batch-actions .el-button.is-primary {
  background: rgba(64, 158, 255, 0.3);
}

.batch-actions .el-button.is-primary:hover {
  background: rgba(64, 158, 255, 0.5);
}

/* 空状态样式 */
.empty-state {
  padding: 60px 20px;
  text-align: center;
}

.empty-state-custom {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
}

.empty-image {
  width: 200px;
  height: auto;
  opacity: 0.6;
  margin-bottom: 8px;
}

.empty-text {
  font-size: 16px;
  color: #909399;
  margin: 0;
}

.empty-description {
  font-size: 14px;
  color: #C0C4CC;
  margin: 0;
}

/* ===== MOBILE CARD LIST ===== */
.m-strategy-cards {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 4px 0;
}

.m-strategy-card {
  background: #fff;
  border: 1px solid #ebeef5;
  border-radius: var(--radius-md);
  padding: 14px 16px;
  cursor: pointer;
  touch-action: manipulation;
  transition: box-shadow 0.2s;
}
.m-strategy-card:active {
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.1);
}

.m-card-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}
.m-card-name {
  font-size: 16px;
  font-weight: 600;
  color: #303133;
}

.m-card-desc {
  font-size: 13px;
  color: #909399;
  margin-bottom: 10px;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.m-card-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.m-card-date {
  font-size: 12px;
  color: #c0c4cc;
  margin-left: auto;
}

.m-card-actions {
  display: flex;
  gap: 8px;
  border-top: 1px solid #f0f0f0;
  padding-top: 10px;
}
.m-action-btn {
  flex: 1;
  min-height: 36px;
  border: 1px solid #dcdfe6;
  border-radius: var(--radius-sm);
  background: #fff;
  color: #409eff;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  touch-action: manipulation;
}
.m-action-btn:active { background: #f5f7fa; }
.m-action-btn.danger { color: #f56c6c; border-color: #fde2e2; }
.m-action-btn.danger:active { background: #fef0f0; }

.m-empty {
  text-align: center;
  padding: 40px 20px;
  color: #606266;
}

/* Mobile layout overrides */
@media (max-width: 767px) {
  .strategies-page { padding: 0; }

  .strategy-list-card {
    border-radius: 0;
    border-left: none;
    border-right: none;
  }

  .card-header {
    flex-direction: column;
    gap: 10px;
    align-items: stretch;
  }

  .header-actions {
    display: flex;
    gap: 8px;
  }

  .header-actions .el-button {
    flex: 1;
    min-height: 44px;
  }

  .batch-toolbar {
    flex-direction: column;
    gap: 10px;
    align-items: stretch;
  }

  .batch-actions {
    flex-wrap: wrap;
  }

  /* Hide desktop table */
  .el-table { display: none !important; }

  /* Dialog full-screen on mobile */
  :deep(.el-dialog) {
    width: 95% !important;
    margin: 10px auto !important;
    max-height: 90vh;
  }

  :deep(.el-dialog__body) {
    max-height: calc(90vh - 120px);
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
  }

  .el-pagination {
    flex-wrap: wrap;
    justify-content: center !important;
  }
}
</style>

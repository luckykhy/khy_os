<template>

  <div class="simple-trading-interface">

    <!-- 顶部工具栏 -->

    <div class="top-toolbar">

      <div class="toolbar-left">

        <!-- 周期选择 -->

        <el-radio-group v-model="selectedPeriod" @change="onPeriodChange" size="small">

          <el-radio-button
            v-for="p in availablePeriods"
            :key="p.value"
            :label="p.value"
          >{{ p.label }}</el-radio-button>

        </el-radio-group>

      </div>



      <div class="toolbar-center">

        <!-- 当前合约信息 - 已在左上角显示,暂时隐藏避免重复 -->

        <!-- 如需恢复显示,取消下面的注释即可 -->

        <!--

        <div class="contract-info">

          <span class="contract-code">{{ currentContract.symbol }}</span>

          <span class="contract-name">{{ currentContract.name }}</span>

          <span class="current-price" :class="priceChangeClass">{{ currentPrice }}</span>

          <span class="price-change" :class="priceChangeClass">

            {{ priceChangeText }} ({{ pricePercentText }})

          </span>

        </div>

        -->

      </div>



      <div class="toolbar-right">

        <!-- 刷新数据按钮 -->

        <el-button 

          @click="refreshData" 

          :loading="refreshing"

          type="warning"

          size="small"

          style="margin-right: 10px;"

        >

          <el-icon><Refresh /></el-icon>

          {{ refreshing ? '刷新中...' : '刷新数据' }}

        </el-button>

        

        <!-- 数据源指示器 -->

        <DataSourceIndicator

          :source-name="dataSourceState.currentSource.value?.name || 'Unknown'"

          :status="dataSourceState.connectionStatus.value"

          :quality="dataSourceState.dataQuality.value"

          :success-rate="dataSourceState.currentSource.value?.successRate || 0"

          :response-time="dataSourceState.currentSource.value?.responseTime || 0"

          :last-update="dataSourceState.lastUpdate"

          :current-source="dataSourceState.currentSource.value?.key || ''"

          :available-sources="dataSourceState.availableSources.value"

          @source-change="handleSourceChange"

          @manage="handleManageDataSource"

        />

        

        <!-- 策略控制 -->

        <el-button-group size="small">

          <el-button @click="loadStrategy" :loading="loadingStrategy" type="primary">

            <el-icon><TrendCharts /></el-icon>

            {{ loadedStrategy ? '刷新策略' : '加载策略' }}

          </el-button>

          <el-button

            @click="toggleMA"

            :type="showMA ? 'warning' : 'info'"

          >

            {{ showMA ? '隐藏均线' : '显示均线' }}

          </el-button>

          <el-button

            @click="toggleBoll"

            :type="showBoll ? 'warning' : 'info'"

          >

            {{ showBoll ? '隐藏布林' : '显示布林' }}

          </el-button>

          <el-button 

            @click="toggleAuxiliaryLines" 

            :disabled="!auxiliaryData || Object.keys(auxiliaryData).length === 0"

            :type="showAuxiliaryLines ? 'warning' : 'info'"

          >

            {{ showAuxiliaryLines ? '隐藏辅助线' : '显示辅助线' }}

          </el-button>

          <el-button 

            @click="toggleStrategyIndicator" 

            :disabled="!loadedStrategy"

            :type="showStrategyIndicator ? 'warning' : 'info'"

          >

            {{ showStrategyIndicator ? '隐藏指标' : '显示指标' }}

          </el-button>

          <el-button 

            @click="toggleSignals" 

            :disabled="safeSignals.length === 0"

            :type="showSignals ? 'warning' : 'info'"

          >

            {{ showSignals ? '隐藏信号' : '显示信号' }}

          </el-button>

          <el-button @click="openBacktestDialog" :loading="backtesting" type="success">

            回测

          </el-button>

          <el-button v-if="isFuturesSymbol" @click="showUploadDialog = true" type="info" plain>

            上传数据

          </el-button>

        </el-button-group>

      </div>

    </div>



    <!-- 主要内容区域 -->

    <div class="main-content">

      <!-- 图表区域 -->

      <div class="center-panel">

        <!-- 悬停信息显示 -->

        <div class="crosshair-info" v-if="crosshairData.visible">

          <div class="info-item">

            <span class="label">时间:</span>

            <span class="value">{{ crosshairData.time }}</span>

          </div>

          <div class="info-item">

            <span class="label">开:</span>

            <span class="value">{{ crosshairData.open }}</span>

          </div>

          <div class="info-item">

            <span class="label">高:</span>

            <span class="value price-up">{{ crosshairData.high }}</span>

          </div>

          <div class="info-item">

            <span class="label">低:</span>

            <span class="value price-down">{{ crosshairData.low }}</span>

          </div>

          <div class="info-item">

            <span class="label">收:</span>

            <span class="value" :class="crosshairData.changeClass">{{ crosshairData.close }}</span>

          </div>

          <div class="info-item" v-if="crosshairData.volume">

            <span class="label">量:</span>

            <span class="value">{{ crosshairData.volume }}</span>

          </div>

        </div>

        

        <div class="chart-container" ref="chartContainer"></div>

      </div>



      <!-- 右侧交易面板 -->

      <div class="right-panel" key="right-panel-stable">

        <!-- 下单面板 - 始终显示 -->

        <div class="trading-section full-panel">

          <ModernTradingPanel

            :current-symbol="selectedSymbol"

            :current-price="currentPrice"

            :available-funds="availableFunds"

          />

        </div>

      </div>

    </div>



    <!-- 底部持仓面板 -->

    <CollapsiblePositionBar

      :positions="mockPositions"

      :available-funds="availableFunds"

      :current-prices="currentPrices"

      @select-position="handleSelectPosition"

      @close-position="handleClosePosition"

    />



    <!-- 策略选择对话框 -->

    <el-dialog

      v-model="showStrategySelectDialog"

      title="选择策略"

      width="70%"

      :close-on-click-modal="false"

      class="strategy-select-dialog"

    >

      <div v-loading="loadingStrategies" class="strategy-list-container">

        <!-- 策略列表 -->

        <el-row :gutter="20" v-if="availableStrategies.length > 0">

          <el-col 

            v-for="strategy in availableStrategies" 

            :key="strategy.id" 

            :span="12"

            style="margin-bottom: 20px"

          >

            <el-card 

              class="strategy-card" 

              :class="{ 'selected': selectedStrategyId === strategy.id }"

              @click="selectedStrategyId = strategy.id"

              shadow="hover"

            >

              <template #header>

                <div class="strategy-card-header">

                  <span class="strategy-name">{{ strategy.name }}</span>

                  <div class="strategy-tags">

                    <el-tag :type="getLanguageColor(strategy.language)" size="small">

                      {{ getLanguageName(strategy.language) }}

                    </el-tag>

                    <el-tag :type="getStrategyTypeColor(strategy.type)" size="small" style="margin-left: 8px">

                      {{ getStrategyTypeLabel(strategy.type) }}

                    </el-tag>

                  </div>

                </div>

              </template>

              

              <div class="strategy-card-body">

                <div class="strategy-description" v-if="strategy.description">

                  {{ strategy.description }}

                </div>

                <div class="strategy-description" v-else style="color: #909399;">

                  暂无描述

                </div>

                

                <div class="strategy-info">

                  <div class="info-item">

                    <el-icon><Calendar /></el-icon>

                    <span>{{ formatDateTime(strategy.createdAt) }}</span>

                  </div>

                  <div class="info-item" v-if="strategy.parameters && Object.keys(strategy.parameters).length > 0">

                    <el-icon><Setting /></el-icon>

                    <span>{{ Object.keys(strategy.parameters).length }} 个参数</span>

                  </div>

                </div>

              </div>

            </el-card>

          </el-col>

        </el-row>

        

        <!-- 无策略提示 -->

        <el-empty 

          v-else 

          description="暂无可用策略"

          style="padding: 60px 0;"

        >

          <el-button type="primary" @click="goToStrategyManagement">

            前往策略管理创建策略

          </el-button>

        </el-empty>

      </div>

      

      <template #footer>

        <span class="dialog-footer">

          <el-button @click="showStrategySelectDialog = false">取消</el-button>

          <el-button 

            type="primary" 

            @click="confirmSelectStrategy(availableStrategies.find(s => s.id === selectedStrategyId))"

            :disabled="!selectedStrategyId"

            :loading="loadingStrategy"

          >

            <el-icon><Check /></el-icon>

            确认选择

          </el-button>

        </span>

      </template>

    </el-dialog>



    <!-- 快速策略选择对话框 -->

    <el-dialog

      v-model="showQuickStrategyDialog"

      title="从已有策略加载"

      width="800px"

      :close-on-click-modal="false"

      class="quick-strategy-dialog"

    >

      <div v-loading="loadingStrategies" class="quick-strategy-container">

        <!-- 搜索框 -->

        <el-input

          v-model="strategySearchKeyword"

          placeholder="搜索策略名称或描述..."

          clearable

          style="margin-bottom: 16px;"

        >

          <template #prefix>

            <el-icon><Search /></el-icon>

          </template>

        </el-input>



        <!-- 策略列表 -->

        <div class="quick-strategy-list" v-if="filteredStrategies.length > 0">

          <div 

            v-for="strategy in filteredStrategies" 

            :key="strategy.id"

            class="quick-strategy-item"

            :class="{ 'selected': selectedQuickStrategyId === strategy.id }"

            @click="selectedQuickStrategyId = strategy.id"

          >

            <div class="strategy-main-info">

              <div class="strategy-name-row">

                <span class="strategy-name">{{ strategy.name }}</span>

                <div class="strategy-tags">

                  <el-tag :type="getLanguageColor(strategy.language)" size="small">

                    {{ getLanguageName(strategy.language) }}

                  </el-tag>

                  <el-tag :type="getStrategyTypeColor(strategy.type)" size="small">

                    {{ getStrategyTypeLabel(strategy.type) }}

                  </el-tag>

                </div>

              </div>

              <div class="strategy-description" v-if="strategy.description">

                {{ strategy.description }}

              </div>

            </div>

            <div class="strategy-actions">

              <el-button 

                type="primary" 

                size="small"

                @click.stop="quickLoadStrategy(strategy)"

                :loading="loadingStrategy && selectedQuickStrategyId === strategy.id"

              >

                加载

              </el-button>

            </div>

          </div>

        </div>

        

        <!-- 无策略提示 -->

        <el-empty 

          v-else-if="!loadingStrategies"

          description="暂无可用策略"

          style="padding: 60px 0;"

        >

          <el-button type="primary" @click="goToStrategyManagement">

            前往策略管理创建策略

          </el-button>

        </el-empty>

      </div>

      

      <template #footer>

        <span class="dialog-footer">

          <el-button @click="showQuickStrategyDialog = false">关闭</el-button>

        </span>

      </template>

    </el-dialog>



    <!-- 回测对话框 -->

    <el-dialog

      v-model="showBacktestDialog"

      title="策略回测"

      width="600px"

      :before-close="handleCloseBacktest"

      class="backtest-dialog"

    >

      <el-form :model="backtestParams" :rules="backtestRules" ref="backtestFormRef" label-width="120px">

        <!-- 策略选择 -->

        <el-form-item label="选择策略" prop="strategyId">

          <el-select 

            v-model="backtestParams.strategyId" 

            placeholder="请选择要回测的策略"

            style="width: 100%"

            :loading="loadingStrategies"

            @change="onStrategySelect"

          >

            <el-option

              v-for="strategy in availableStrategies"

              :key="strategy.id"

              :label="strategy.name"

              :value="strategy.id"

            >

              <div style="display: flex; justify-content: space-between; align-items: center;">

                <span>{{ strategy.name }}</span>

                <el-tag :type="getStrategyTypeColor(strategy.type)" size="small">

                  {{ getStrategyTypeLabel(strategy.type) }}

                </el-tag>

              </div>

            </el-option>

          </el-select>

        </el-form-item>

        

        <!-- 策略信息显示 -->

        <div v-if="selectedStrategy" class="strategy-info-display">

          <div class="info-row">

            <span class="label">策略类型：</span>

            <el-tag :type="getStrategyTypeColor(selectedStrategy.type)">

              {{ getStrategyTypeLabel(selectedStrategy.type) }}

            </el-tag>

          </div>

          <div class="info-row" v-if="selectedStrategy.description">

            <span class="label">策略描述：</span>

            <span class="value">{{ selectedStrategy.description }}</span>

          </div>

          <div class="info-row">

            <span class="label">创建时间：</span>

            <span class="value">{{ formatDateTime(selectedStrategy.createdAt) }}</span>

          </div>

        </div>

        

        <el-divider />

        

        <!-- 回测参数 -->

        <el-row :gutter="20">

          <el-col :span="12">

            <el-form-item label="开始日期" prop="startDate">

              <el-date-picker

                v-model="backtestParams.startDate"

                type="date"

                placeholder="选择开始日期"

                style="width: 100%"

                :disabled-date="disabledStartDate"

              />

            </el-form-item>

          </el-col>

          <el-col :span="12">

            <el-form-item label="结束日期" prop="endDate">

              <el-date-picker

                v-model="backtestParams.endDate"

                type="date"

                placeholder="选择结束日期"

                style="width: 100%"

                :disabled-date="disabledEndDate"

              />

            </el-form-item>

          </el-col>

        </el-row>

        

        <el-row :gutter="20">

          <el-col :span="12">

            <el-form-item label="初始资金" prop="initialCapital">

              <el-input-number

                v-model="backtestParams.initialCapital"

                :min="10000"

                :max="10000000"

                :step="10000"

                style="width: 100%"

                :formatter="value => `¥ ${value}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',')"

                :parser="value => value.replace(/¥\s?|(,*)/g, '')"

              />

            </el-form-item>

          </el-col>

          <el-col :span="12">

            <el-form-item label="手续费率" prop="commission">

              <el-input-number

                v-model="backtestParams.commission"

                :min="0"

                :max="0.01"

                :step="0.0001"

                :precision="4"

                style="width: 100%"

                :formatter="value => `${(value * 100).toFixed(2)}%`"

                :parser="value => parseFloat(value.replace('%', '')) / 100"

              />

            </el-form-item>

          </el-col>

        </el-row>



        <el-row :gutter="20">

          <el-col :span="12">

            <el-form-item label="滑点设置" prop="slippage">

              <el-input-number

                v-model="backtestParams.slippage"

                :min="0"

                :max="0.01"

                :step="0.0001"

                :precision="4"

                style="width: 100%"

                :formatter="value => `${(value * 100).toFixed(2)}%`"

                :parser="value => parseFloat(value.replace('%', '')) / 100"

              />

            </el-form-item>

          </el-col>

          <el-col :span="12">

            <el-form-item label="基准合约">

              <el-select v-model="backtestParams.benchmark" placeholder="选择基准" style="width: 100%">

                <el-option label="沪深300" value="000300" />

                <el-option label="上证指数" value="000001" />

                <el-option label="深证成指" value="399001" />

                <el-option label="创业板指" value="399006" />

              </el-select>

            </el-form-item>

          </el-col>

        </el-row>

      </el-form>

      

      <template #footer>

        <span class="dialog-footer">

          <el-button @click="showBacktestDialog = false">取消</el-button>

          <el-button type="primary" @click="runBacktest" :loading="backtesting" :disabled="!backtestParams.strategyId">

            <el-icon><TrendCharts /></el-icon>

            开始回测

          </el-button>

        </span>

      </template>

    </el-dialog>



    <!-- Upload futures data dialog -->

    <el-dialog v-model="showUploadDialog" title="上传期货数据" width="550px" append-to-body>

      <!-- 数据周期选择 -->

      <div style="margin-bottom: 12px;">

        <span style="font-weight: bold; margin-right: 8px;">数据周期:</span>

        <el-radio-group v-model="uploadPeriod" size="small">

          <el-radio-button label="Tick">Tick</el-radio-button>

          <el-radio-button label="1m">1分</el-radio-button>

          <el-radio-button label="5m">5分</el-radio-button>

          <el-radio-button label="15m">15分</el-radio-button>

          <el-radio-button label="30m">30分</el-radio-button>

          <el-radio-button label="1h">1时</el-radio-button>

          <el-radio-button label="1d">日线</el-radio-button>

        </el-radio-group>

      </div>

      <div style="display: flex; gap: 16px;">

        <div style="flex: 1;">

          <div style="font-weight: bold; margin-bottom: 8px;">上传 ZIP / CSV 文件</div>

          <el-upload

            drag

            :action="`${getApiBaseUrl()}/futures-tick/upload`"

            :headers="uploadHeaders"

            :data="{ period: uploadPeriod }"

            accept=".zip,.csv"

            :on-success="onUploadSuccess"

            :on-error="onUploadError"

            :auto-upload="true"

          >

            <el-icon style="font-size: 36px; color: #409eff"><TrendCharts /></el-icon>

            <div style="font-size: 12px; margin-top: 4px">拖拽或点击上传</div>

          </el-upload>

        </div>

        <div style="flex: 1;">

          <div style="font-weight: bold; margin-bottom: 8px;">上传文件夹（多个 CSV）</div>

          <el-button type="primary" plain style="width: 100%; height: 120px;" @click="triggerFolderUpload">

            <div style="text-align: center;">

              <el-icon style="font-size: 36px"><TrendCharts /></el-icon>

              <div style="font-size: 12px; margin-top: 4px">选择文件夹</div>

            </div>

          </el-button>

          <input

            ref="folderInputRef"

            type="file"

            webkitdirectory

            directory

            multiple

            style="display: none;"

            @change="handleFolderUpload"

          />

        </div>

      </div>

      <div style="color: #909399; font-size: 12px; margin-top: 12px;">

        ZIP 格式: YYYYMMDD.zip | CSV 文件夹: 包含合约 CSV 的日期文件夹 | 最大 500MB<br/>

        文件将保存至 <b>{{ uploadPeriod }}/</b> 目录下

      </div>

      <div v-if="folderUploadProgress" style="margin-top: 8px; color: #409eff; font-size: 12px;">

        {{ folderUploadProgress }}

      </div>

    </el-dialog>

  </div>

</template>



<script src="./SimpleTradingInterface.js"></script>



<style scoped src="./SimpleTradingInterface.css"></style>
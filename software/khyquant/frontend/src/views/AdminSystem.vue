<template>
  <div class="admin-system">
    <el-row :gutter="20">
      <!-- 系统信息卡片 -->
      <el-col :span="8">
        <el-card>
          <template #header>
            <div class="card-header">
              <span>📊 系统信息</span>
              <el-button size="small" @click="refreshSystemInfo" :loading="infoLoading">
                <el-icon><Refresh /></el-icon>
                刷新
              </el-button>
            </div>
          </template>
          
          <div v-if="systemInfo">
            <el-descriptions :column="1" border>
              <el-descriptions-item label="系统名称">
                {{ systemInfo.settings.system?.find(s => s.key === 'system.name')?.value || 'KHY-Quant' }}
              </el-descriptions-item>
              <el-descriptions-item label="系统版本">
                {{ systemInfo.settings.system?.find(s => s.key === 'system.version')?.value || '1.0.0' }}
              </el-descriptions-item>
              <el-descriptions-item label="Node.js版本">
                {{ systemInfo.systemInfo.nodeVersion }}
              </el-descriptions-item>
              <el-descriptions-item label="运行平台">
                {{ systemInfo.systemInfo.platform }}
              </el-descriptions-item>
              <el-descriptions-item label="运行时间">
                {{ formatUptime(systemInfo.systemInfo.uptime) }}
              </el-descriptions-item>
              <el-descriptions-item label="内存使用">
                {{ formatMemory(systemInfo.systemInfo.memoryUsage.used) }} / 
                {{ formatMemory(systemInfo.systemInfo.memoryUsage.total) }}
              </el-descriptions-item>
            </el-descriptions>

            <div class="stats-section">
              <h4>系统统计</h4>
              <el-row :gutter="16">
                <el-col :span="12">
                  <el-statistic title="用户数量" :value="systemInfo.statistics.userCount" />
                </el-col>
                <el-col :span="12">
                  <el-statistic title="策略数量" :value="systemInfo.statistics.strategyCount" />
                </el-col>
                <el-col :span="12">
                  <el-statistic title="回测数量" :value="systemInfo.statistics.backtestCount" />
                </el-col>
                <el-col :span="12">
                  <el-statistic title="交易数量" :value="systemInfo.statistics.tradeCount" />
                </el-col>
              </el-row>
            </div>
          </div>
        </el-card>
      </el-col>

      <!-- 系统设置卡片 -->
      <el-col :span="16">
        <el-card>
          <template #header>
            <div class="card-header">
              <span>⚙️ 系统设置</span>
              <div class="header-actions">
                <el-button size="small" @click="initializeSettings" :loading="initLoading">
                  <el-icon><Setting /></el-icon>
                  初始化默认设置
                </el-button>
                <el-button size="small" type="primary" @click="saveSettings" :loading="saveLoading">
                  <el-icon><Check /></el-icon>
                  保存设置
                </el-button>
              </div>
            </div>
          </template>

          <!-- 设置分类标签 -->
          <el-tabs v-model="activeTab" @tab-change="handleTabChange">
            <el-tab-pane 
              v-for="(settings, category) in groupedSettings" 
              :key="category"
              :label="getCategoryLabel(category)"
              :name="category"
            >
              <div class="settings-form">
                <el-form :model="settingsForm" label-width="150px">
                  <el-form-item 
                    v-for="setting in settings" 
                    :key="setting.key"
                    :label="setting.description || setting.key"
                  >
                    <!-- 布尔值设置 -->
                    <el-switch
                      v-if="setting.type === 'boolean'"
                      v-model="settingsForm[setting.key]"
                      :disabled="!setting.isEditable"
                    />
                    
                    <!-- 数字设置 -->
                    <el-input-number
                      v-else-if="setting.type === 'number'"
                      v-model="settingsForm[setting.key]"
                      :disabled="!setting.isEditable"
                      :min="setting.validation?.min"
                      :max="setting.validation?.max"
                      :step="setting.validation?.step || 1"
                      style="width: 200px"
                    />
                    
                    <!-- 文本区域设置 -->
                    <el-input
                      v-else-if="setting.type === 'text'"
                      v-model="settingsForm[setting.key]"
                      type="textarea"
                      :disabled="!setting.isEditable"
                      :rows="3"
                      style="width: 400px"
                    />
                    
                    <!-- 字符串设置 -->
                    <el-input
                      v-else
                      v-model="settingsForm[setting.key]"
                      :disabled="!setting.isEditable"
                      style="width: 300px"
                    />

                    <!-- 重置按钮 -->
                    <el-button
                      v-if="setting.isEditable"
                      size="small"
                      style="margin-left: 10px"
                      @click="resetSetting(setting.key)"
                    >
                      重置
                    </el-button>
                  </el-form-item>
                </el-form>
              </div>
            </el-tab-pane>
          </el-tabs>
        </el-card>
      </el-col>
    </el-row>

    <!-- 维护模式警告 -->
    <el-alert
      v-if="isMaintenanceMode"
      title="系统当前处于维护模式"
      type="warning"
      :closable="false"
      show-icon
      style="margin-top: 20px"
    >
      <template #default>
        维护模式下，普通用户将无法访问系统。请在维护完成后关闭维护模式。
      </template>
    </el-alert>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Refresh, Setting, Check } from '@element-plus/icons-vue'
import { adminAPI } from '@/api/admin'

// 数据状态
const infoLoading = ref(false)
const saveLoading = ref(false)
const initLoading = ref(false)
const systemInfo = ref(null)
const groupedSettings = ref({})
const settingsForm = reactive({})
const activeTab = ref('system')

// 计算属性
const isMaintenanceMode = computed(() => {
  return settingsForm['system.maintenance_mode'] === true
})

// 分类标签映射
const categoryLabels = {
  system: '系统基本',
  user: '用户管理',
  security: '安全设置',
  trading: '交易设置',
  data: '数据管理',
  notification: '通知设置'
}

// 方法
const getCategoryLabel = (category) => {
  return categoryLabels[category] || category
}

const refreshSystemInfo = async () => {
  try {
    infoLoading.value = true
    const response = await adminAPI.getSystemInfo()
    if (response.success) {
      systemInfo.value = response.data
      groupedSettings.value = response.data.settings
      
      // 初始化表单数据
      Object.keys(response.data.settings).forEach(category => {
        response.data.settings[category].forEach(setting => {
          settingsForm[setting.key] = setting.value
        })
      })
    }
  } catch (error) {
    ElMessage.error('获取系统信息失败')
    console.error('获取系统信息失败:', error)
  } finally {
    infoLoading.value = false
  }
}

const saveSettings = async () => {
  try {
    await ElMessageBox.confirm(
      '确定要保存系统设置吗？某些设置可能需要重启系统才能生效。',
      '确认保存',
      {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )

    saveLoading.value = true
    const response = await adminAPI.updateSystemSettings(settingsForm)
    
    if (response.success) {
      ElMessage.success('系统设置保存成功')
      await refreshSystemInfo()
    }
  } catch (error) {
    if (error !== 'cancel') {
      ElMessage.error('保存系统设置失败')
      console.error('保存系统设置失败:', error)
    }
  } finally {
    saveLoading.value = false
  }
}

const resetSetting = async (key) => {
  try {
    await ElMessageBox.confirm(
      `确定要将 "${key}" 重置为默认值吗？`,
      '确认重置',
      {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )

    const response = await adminAPI.resetSystemSetting(key)
    if (response.success) {
      settingsForm[key] = response.data.value
      ElMessage.success('设置重置成功')
    }
  } catch (error) {
    if (error !== 'cancel') {
      ElMessage.error('重置设置失败')
      console.error('重置设置失败:', error)
    }
  }
}

const initializeSettings = async () => {
  try {
    await ElMessageBox.confirm(
      '确定要初始化默认设置吗？这将创建所有缺失的默认设置项。',
      '确认初始化',
      {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'info'
      }
    )

    initLoading.value = true
    const response = await adminAPI.initializeSystemSettings()
    
    if (response.success) {
      ElMessage.success('默认设置初始化成功')
      await refreshSystemInfo()
    }
  } catch (error) {
    if (error !== 'cancel') {
      ElMessage.error('初始化设置失败')
      console.error('初始化设置失败:', error)
    }
  } finally {
    initLoading.value = false
  }
}

const handleTabChange = (tabName) => {
  activeTab.value = tabName
}

const formatUptime = (seconds) => {
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  
  if (days > 0) {
    return `${days}天 ${hours}小时 ${minutes}分钟`
  } else if (hours > 0) {
    return `${hours}小时 ${minutes}分钟`
  } else {
    return `${minutes}分钟`
  }
}

const formatMemory = (bytes) => {
  const mb = bytes / 1024 / 1024
  return `${mb.toFixed(1)} MB`
}

// 生命周期
onMounted(() => {
  refreshSystemInfo()
})
</script>

<style scoped>
.admin-system {
  width: 100%;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-weight: 600;
}

.header-actions {
  display: flex;
  gap: 10px;
}

.stats-section {
  margin-top: 20px;
  padding-top: 20px;
  border-top: 1px solid #ebeef5;
}

.stats-section h4 {
  margin: 0 0 16px 0;
  font-size: 14px;
  color: #303133;
}

.settings-form {
  padding: 20px 0;
}

:deep(.el-descriptions-item__label) {
  font-weight: 600;
  color: #303133;
}

:deep(.el-descriptions-item__content) {
  color: #606266;
}

:deep(.el-statistic__content) {
  font-size: 20px;
  font-weight: 600;
}

:deep(.el-statistic__title) {
  font-size: 12px;
  color: #909399;
  margin-bottom: 8px;
}

:deep(.el-form-item) {
  margin-bottom: 20px;
}

:deep(.el-form-item__label) {
  font-weight: 500;
}

:deep(.el-tabs__content) {
  padding: 0;
}
</style>
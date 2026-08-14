<template>
  <div class="feedback-page">
    <!-- Header -->
    <div class="page-hero">
      <h1>意见反馈</h1>
      <p>您的建议是我们持续改进的动力</p>
    </div>

    <div class="feedback-container">
      <!-- Submit form -->
      <el-card class="form-card" shadow="hover">
        <template #header>
          <div class="card-title">
            <el-icon :size="20"><EditPen /></el-icon>
            <span>提交反馈</span>
          </div>
        </template>

        <el-form
          :model="feedbackForm"
          :rules="rules"
          ref="feedbackFormRef"
          label-position="top"
          class="feedback-form"
        >
          <el-row :gutter="20">
            <el-col :xs="24" :sm="12">
              <el-form-item label="反馈类型" prop="type">
                <el-select v-model="feedbackForm.type" placeholder="请选择" style="width: 100%">
                  <el-option label="功能建议" value="suggestion">
                    <el-icon class="opt-icon" style="color:#67c23a"><Star /></el-icon>
                    <span>功能建议</span>
                  </el-option>
                  <el-option label="问题反馈" value="bug">
                    <el-icon class="opt-icon" style="color:#f56c6c"><WarningFilled /></el-icon>
                    <span>问题反馈</span>
                  </el-option>
                  <el-option label="使用咨询" value="question">
                    <el-icon class="opt-icon" style="color:#409eff"><QuestionFilled /></el-icon>
                    <span>使用咨询</span>
                  </el-option>
                  <el-option label="其他" value="other">
                    <el-icon class="opt-icon" style="color:#909399"><MoreFilled /></el-icon>
                    <span>其他</span>
                  </el-option>
                </el-select>
              </el-form-item>
            </el-col>
            <el-col :xs="24" :sm="12">
              <el-form-item label="联系方式">
                <el-input v-model="feedbackForm.contact" placeholder="邮箱或电话（可选）" />
              </el-form-item>
            </el-col>
          </el-row>

          <el-form-item label="标题" prop="title">
            <el-input v-model="feedbackForm.title" placeholder="简要描述您的反馈" maxlength="100" show-word-limit />
          </el-form-item>

          <el-form-item label="详细描述" prop="content">
            <el-input
              v-model="feedbackForm.content"
              type="textarea"
              :rows="5"
              placeholder="请详细描述您的问题或建议..."
              maxlength="1000"
              show-word-limit
            />
          </el-form-item>

          <div class="form-actions">
            <el-button type="primary" @click="submitFeedback" :loading="submitting" :icon="Promotion">
              提交反馈
            </el-button>
            <el-button @click="resetForm">重置</el-button>
          </div>
        </el-form>
      </el-card>

      <!-- History -->
      <el-card class="history-card" shadow="hover">
        <template #header>
          <div class="card-title">
            <el-icon :size="20"><Clock /></el-icon>
            <span>反馈记录</span>
            <el-button size="small" text type="primary" @click="loadFeedbackHistory" style="margin-left:auto">
              <el-icon><Refresh /></el-icon> 刷新
            </el-button>
          </div>
        </template>

        <div v-if="feedbackHistory.length === 0" class="empty-box">
          <el-empty description="暂无反馈记录" :image-size="120" />
        </div>

        <div v-else class="history-list">
          <div v-for="item in feedbackHistory" :key="item.id" class="history-item">
            <div class="item-top">
              <el-tag :type="typeTagMap[item.type]" size="small" effect="dark" round>
                {{ typeTextMap[item.type] || item.type }}
              </el-tag>
              <span class="item-title">{{ item.title }}</span>
              <el-tag :type="statusTagMap[item.status]" size="small" effect="light" class="status-tag">
                {{ statusTextMap[item.status] || item.status }}
              </el-tag>
            </div>
            <p class="item-content">
              {{ item.content.length > 120 ? item.content.substring(0, 120) + '...' : item.content }}
            </p>
            <div class="item-meta">
              <span>{{ formatDate(item.createdAt) }}</span>
            </div>
            <div v-if="item.adminReply || item.reply" class="item-reply">
              <strong>管理员回复：</strong>{{ item.adminReply || item.reply }}
            </div>
          </div>
        </div>
      </el-card>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, shallowRef } from 'vue'
import { ElMessage } from 'element-plus'
import {
  EditPen, Star, WarningFilled, QuestionFilled, MoreFilled,
  Promotion, Clock, Refresh
} from '@element-plus/icons-vue'
import axios from 'axios'

const feedbackFormRef = ref()
const submitting = ref(false)
const feedbackHistory = ref([])

const feedbackForm = reactive({
  type: '',
  title: '',
  content: '',
  contact: ''
})

const rules = {
  type: [{ required: true, message: '请选择反馈类型', trigger: 'change' }],
  title: [
    { required: true, message: '请输入标题', trigger: 'blur' },
    { min: 5, max: 100, message: '5~100 个字符', trigger: 'blur' }
  ],
  content: [
    { required: true, message: '请输入描述', trigger: 'blur' },
    { min: 10, max: 1000, message: '10~1000 个字符', trigger: 'blur' }
  ]
}

const typeTextMap = { suggestion: '功能建议', bug: '问题反馈', question: '使用咨询', other: '其他' }
const typeTagMap = { suggestion: 'success', bug: 'danger', question: 'primary', other: 'info' }
const statusTextMap = { pending: '待处理', processing: '处理中', resolved: '已解决', closed: '已关闭' }
const statusTagMap = { pending: 'warning', processing: '', resolved: 'success', closed: 'info' }

const formatDate = (d) => new Date(d).toLocaleString('zh-CN')

const submitFeedback = async () => {
  if (!feedbackFormRef.value) return
  try {
    await feedbackFormRef.value.validate()
    submitting.value = true
    const token = localStorage.getItem('token')
    const headers = token ? { Authorization: `Bearer ${token}` } : {}
    const res = await axios.post('/api/feedback', feedbackForm, { headers })
    if (res.data.success) {
      ElMessage.success('反馈提交成功！')
      resetForm()
      loadFeedbackHistory()
    } else {
      ElMessage.error(res.data.message || '提交失败')
    }
  } catch (err) {
    if (err.response?.status === 401) {
      ElMessage.warning('模拟模式：反馈已记录')
      feedbackHistory.value.unshift({
        id: Date.now(), ...feedbackForm, status: 'pending', createdAt: new Date().toISOString()
      })
      resetForm()
    } else if (!err.errors) {
      ElMessage.error('提交失败，请稍后重试')
    }
  } finally {
    submitting.value = false
  }
}

const resetForm = () => {
  feedbackFormRef.value?.resetFields()
  Object.assign(feedbackForm, { type: '', title: '', content: '', contact: '' })
}

const loadFeedbackHistory = async () => {
  try {
    const token = localStorage.getItem('token')
    const headers = token ? { Authorization: `Bearer ${token}` } : {}
    const res = await axios.get('/api/feedback', { headers })
    if (res.data.success) {
      feedbackHistory.value = res.data.data.list || res.data.data
    }
  } catch {
    feedbackHistory.value = [
      { id: 1, type: 'suggestion', title: '希望增加更多技术指标', content: '建议在K线图中增加MACD、KDJ等更多技术指标，方便进行技术分析。', status: 'resolved', createdAt: '2026-01-20T10:30:00Z', reply: '已在新版本中增加。' },
      { id: 2, type: 'bug', title: '交易页面偶尔卡顿', content: '在使用交易功能时，数据更新频繁时页面偶尔会出现卡顿现象。', status: 'processing', createdAt: '2026-01-18T14:15:00Z' }
    ]
  }
}

onMounted(() => loadFeedbackHistory())
</script>

<style scoped>
.feedback-page {
  min-height: 100vh;
  background: #f5f7fa;
}

.page-hero {
  background: linear-gradient(135deg, #304156 0%, #1f2d3d 100%);
  color: #fff;
  text-align: center;
  padding: 48px 20px 40px;
}
.page-hero h1 { font-size: 28px; font-weight: 600; margin: 0 0 8px; }
.page-hero p { font-size: 15px; opacity: 0.85; margin: 0; }

.feedback-container {
  max-width: 800px;
  margin: -20px auto 40px;
  padding: 0 16px;
  position: relative;
  z-index: 1;
}

.form-card,
.history-card {
  border-radius: 12px;
  margin-bottom: 20px;
}

.card-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  font-size: 16px;
}

.feedback-form :deep(.el-form-item__label) {
  font-weight: 500;
}

.opt-icon { margin-right: 6px; vertical-align: middle; }

.form-actions {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
  padding-top: 8px;
}

.empty-box { padding: 20px 0; }

.history-list { display: flex; flex-direction: column; gap: 14px; }

.history-item {
  border: 1px solid #e8ecf0;
  border-radius: 10px;
  padding: 16px;
  background: #fafbfc;
  transition: box-shadow 0.2s;
}
.history-item:hover { box-shadow: 0 2px 8px rgba(0,0,0,0.06); }

.item-top {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}
.item-title { font-weight: 600; color: #303133; flex: 1; }
.status-tag { flex-shrink: 0; }

.item-content {
  color: #606266;
  font-size: 13px;
  line-height: 1.6;
  margin: 0 0 8px;
}

.item-meta {
  font-size: 12px;
  color: #909399;
}

.item-reply {
  margin-top: 10px;
  padding: 10px 14px;
  background: #ecf5ff;
  border-left: 3px solid #409eff;
  border-radius: 6px;
  font-size: 13px;
  color: #303133;
  line-height: 1.6;
}

@media (max-width: 768px) {
  .feedback-container { margin-top: -10px; }
  .page-hero { padding: 32px 16px 28px; }
  .page-hero h1 { font-size: 22px; }
}
</style>

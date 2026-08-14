<template>
  <div class="profile-page" :class="{ 'mobile-view': isMobile }">
    <!-- 用户头像区域 -->
    <div class="profile-banner">
      <div class="avatar-section">
        <div class="avatar-wrapper">
          <div class="user-avatar-badge" :style="{ width: isMobile ? '80px' : '100px', height: isMobile ? '80px' : '100px' }">
            <img src="/school-badge.svg" alt="用户头像" class="badge-image" />
          </div>
        </div>
        <div class="user-basic-info">
          <h2 class="username">{{ userStore.user?.username || '加载中...' }}</h2>
          <div class="user-meta">
            <el-tag :type="getRoleType(userStore.user?.role)" size="small" class="role-tag">
              {{ getRoleText(userStore.user?.role) }}
            </el-tag>
            <el-tag :type="getStatusType(userStore.user?.status)" size="small" class="status-tag">
              {{ getStatusText(userStore.user?.status) }}
            </el-tag>
          </div>
        </div>
      </div>
      <el-button 
        class="refresh-btn" 
        :size="isMobile ? 'small' : 'default'"
        @click="refreshUserInfo" 
        :loading="loading"
        circle
      >
        <el-icon><Refresh /></el-icon>
      </el-button>
    </div>

    <!-- 内容区域 -->
    <div class="profile-content">
      <el-row :gutter="isMobile ? 12 : 20">
        <!-- 用户信息卡片 -->
        <el-col :xs="24" :sm="24" :md="16">
          <el-card class="info-card" shadow="hover">
            <template #header>
              <div class="card-header">
                <el-icon class="header-icon"><InfoFilled /></el-icon>
                <span>个人信息</span>
              </div>
            </template>
            
            <div v-if="!userStore.user" class="loading-container">
              <el-icon class="is-loading"><Loading /></el-icon>
              <p>加载用户信息中...</p>
            </div>
            
            <div v-else class="info-grid">
              <div class="info-item">
                <div class="info-label">用户ID</div>
                <div class="info-value">{{ userStore.user.id }}</div>
              </div>
              <div class="info-item">
                <div class="info-label">用户名</div>
                <div class="info-value">{{ userStore.user.username }}</div>
              </div>
              <div class="info-item">
                <div class="info-label">邮箱</div>
                <div class="info-value">{{ userStore.user.email }}</div>
              </div>
              <div class="info-item">
                <div class="info-label">角色</div>
                <div class="info-value">
                  <el-tag :type="getRoleType(userStore.user.role)" size="small">
                    {{ getRoleText(userStore.user.role) }}
                  </el-tag>
                </div>
              </div>
              <div class="info-item">
                <div class="info-label">状态</div>
                <div class="info-value">
                  <el-tag :type="getStatusType(userStore.user.status)" size="small">
                    {{ getStatusText(userStore.user.status) }}
                  </el-tag>
                </div>
              </div>
              <div class="info-item">
                <div class="info-label">注册时间</div>
                <div class="info-value">{{ formatDate(userStore.user.createdAt) }}</div>
              </div>
              <div class="info-item">
                <div class="info-label">最后登录</div>
                <div class="info-value">{{ formatDate(userStore.user.lastLoginAt) }}</div>
              </div>
              <div class="info-item">
                <div class="info-label">更新时间</div>
                <div class="info-value">{{ formatDate(userStore.user.updatedAt) }}</div>
              </div>
            </div>
          </el-card>
        </el-col>

        <!-- 安全设置卡片 -->
        <el-col :xs="24" :sm="24" :md="8">
          <el-card class="security-card" shadow="hover">
            <template #header>
              <div class="card-header">
                <el-icon class="header-icon"><Lock /></el-icon>
                <span>安全设置</span>
              </div>
            </template>
            
            <div class="security-actions">
              <el-button 
                type="primary" 
                @click="showPasswordDialog = true"
                :size="isMobile ? 'default' : 'large'"
                class="change-password-btn"
              >
                <el-icon><Lock /></el-icon>
                <span>修改密码</span>
              </el-button>

              <!-- 生物识别绑定 -->
              <div class="bio-section">
                <div class="bio-header">
                  <span class="bio-title">🪪 生物识别登录</span>
                  <el-tag :type="bioBound ? 'success' : 'info'" size="small">
                    {{ bioBound ? '已绑定' : '未绑定' }}
                  </el-tag>
                </div>
                <p class="bio-desc">绑定后可使用 Windows Hello 人脸或指纹直接登录</p>
                <div class="bio-btns">
                  <el-button
                    v-if="!bioBound"
                    type="success"
                    :size="isMobile ? 'default' : 'large'"
                    :loading="bioLoading"
                    class="bio-btn"
                    @click="handleBindBio"
                  >
                    <span>绑定生物识别</span>
                  </el-button>
                  <template v-else>
                    <el-button
                      type="warning"
                      :size="isMobile ? 'default' : 'large'"
                      :loading="bioLoading"
                      class="bio-btn"
                      @click="handleBindBio"
                    >
                      重新绑定
                    </el-button>
                    <el-button
                      type="danger"
                      :size="isMobile ? 'default' : 'large'"
                      :loading="bioLoading"
                      class="bio-btn"
                      @click="handleUnbindBio"
                    >
                      解绑
                    </el-button>
                  </template>
                </div>
                <p v-if="!webauthnSupported" class="bio-unsupported">
                  ⚠️ 当前浏览器不支持 WebAuthn，请使用 Chrome / Edge
                </p>
              </div>
              
              <div class="security-tips">
                <div class="tip-header">
                  <el-icon class="tip-icon"><Warning /></el-icon>
                  <span>安全提示</span>
                </div>
                <ul class="tip-list">
                  <li>定期修改密码可以提高账户安全性</li>
                  <li>密码长度至少6位字符</li>
                  <li>建议使用字母、数字和符号组合</li>
                </ul>
              </div>
            </div>
          </el-card>
        </el-col>
        <!-- Bank-Securities Transfer Card (full width) -->
        <el-col :span="24">
          <el-card class="transfer-card" shadow="hover">
            <template #header>
              <div class="card-header">
                <el-icon class="header-icon"><Wallet /></el-icon>
                <span>银证转账</span>
              </div>
            </template>

            <div class="transfer-layout">
              <!-- Left: Account info + Transfer form -->
              <div class="transfer-form-section">
                <div class="account-info-row">
                  <div class="account-box">
                    <div class="account-label">证券账户余额</div>
                    <div class="account-value">¥{{ formatMoney(transferState.securitiesBalance) }}</div>
                  </div>
                  <div class="account-box">
                    <div class="account-label">银行账户 ({{ transferState.bankName }})</div>
                    <div class="account-value">{{ transferState.bankAccount }}</div>
                  </div>
                </div>

                <div class="transfer-tabs">
                  <button
                    class="transfer-tab"
                    :class="{ active: transferDirection === 'deposit' }"
                    @click="transferDirection = 'deposit'"
                  >银行转证券</button>
                  <button
                    class="transfer-tab"
                    :class="{ active: transferDirection === 'withdraw' }"
                    @click="transferDirection = 'withdraw'"
                  >证券转银行</button>
                </div>

                <el-form class="transfer-form" @submit.prevent="handleTransfer">
                  <el-form-item label="转账金额 (CNY)">
                    <el-input-number
                      v-model="transferAmount"
                      :min="100"
                      :max="5000000"
                      :step="1000"
                      :precision="2"
                      controls-position="right"
                      style="width: 100%"
                    />
                  </el-form-item>
                  <el-form-item :label="transferDirection === 'deposit' ? '银行密码' : '交易密码'">
                    <el-input
                      v-model="transferPassword"
                      type="password"
                      show-password
                      placeholder="模拟模式任意密码即可"
                    />
                  </el-form-item>
                  <el-button
                    type="primary"
                    :loading="transferLoading"
                    @click="handleTransfer"
                    class="transfer-submit-btn"
                  >
                    {{ transferDirection === 'deposit' ? '确认转入' : '确认转出' }}
                  </el-button>
                </el-form>
              </div>

              <!-- Right: Transfer history -->
              <div class="transfer-history-section">
                <div class="history-header">
                  <span>转账记录</span>
                  <el-button size="small" @click="loadTransferHistory" :loading="historyLoading" circle>
                    <el-icon><Refresh /></el-icon>
                  </el-button>
                </div>
                <div class="history-list">
                  <div
                    v-for="record in transferHistory"
                    :key="record.id"
                    class="history-item"
                    :class="record.type"
                  >
                    <div class="history-row-top">
                      <span class="history-type">{{ record.type === 'deposit' ? '银行转入' : '证券转出' }}</span>
                      <span class="history-amount" :class="record.type === 'deposit' ? 'amount-in' : 'amount-out'">
                        {{ record.type === 'deposit' ? '+' : '-' }}¥{{ formatMoney(Number(record.amount)) }}
                      </span>
                    </div>
                    <div class="history-row-bottom">
                      <span class="history-time">{{ formatDate(record.createdAt) }}</span>
                      <el-tag size="small" :type="record.status === 'completed' ? 'success' : 'warning'">
                        {{ record.status === 'completed' ? '已完成' : '处理中' }}
                      </el-tag>
                    </div>
                  </div>
                  <div v-if="transferHistory.length === 0" class="history-empty">暂无转账记录</div>
                </div>
              </div>
            </div>
          </el-card>
        </el-col>
      </el-row>
    </div>

    <!-- 修改密码对话框 -->
    <el-dialog
      v-model="showPasswordDialog"
      title="修改密码"
      :width="isMobile ? '90%' : '400px'"
      :fullscreen="isMobile && isPortrait"
      @close="resetPasswordForm"
      class="password-dialog"
    >
      <el-form
        ref="passwordFormRef"
        :model="passwordForm"
        :rules="passwordRules"
        :label-width="isMobile ? '80px' : '100px'"
        class="password-form"
      >
        <el-form-item label="当前密码" prop="currentPassword">
          <el-input
            v-model="passwordForm.currentPassword"
            type="password"
            placeholder="请输入当前密码"
            show-password
            :size="isMobile ? 'default' : 'large'"
          />
        </el-form-item>
        <el-form-item label="新密码" prop="newPassword">
          <el-input
            v-model="passwordForm.newPassword"
            type="password"
            placeholder="请输入新密码"
            show-password
            :size="isMobile ? 'default' : 'large'"
          />
        </el-form-item>
        <el-form-item label="确认密码" prop="confirmPassword">
          <el-input
            v-model="passwordForm.confirmPassword"
            type="password"
            placeholder="请再次输入新密码"
            show-password
            :size="isMobile ? 'default' : 'large'"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <div class="dialog-footer">
          <el-button @click="showPasswordDialog = false" :size="isMobile ? 'default' : 'large'">
            取消
          </el-button>
          <el-button 
            type="primary" 
            @click="handleChangePassword" 
            :loading="passwordLoading"
            :size="isMobile ? 'default' : 'large'"
          >
            确认修改
          </el-button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { useUserStore } from '@/stores/user'
import { ElMessage } from 'element-plus'
import { Refresh, Loading, Lock, User, InfoFilled, Warning, Wallet } from '@element-plus/icons-vue'
import { changePassword } from '@/api/auth'
import { useResponsive } from '@/composables/useResponsive'
import request from '@/utils/request'

// 响应式布局
const { isMobile, isTablet, isPortrait } = useResponsive()

const userStore = useUserStore()
const loading = ref(false)

// 密码修改相关
const showPasswordDialog = ref(false)
const passwordLoading = ref(false)
const passwordFormRef = ref()

const passwordForm = reactive({
  currentPassword: '',
  newPassword: '',
  confirmPassword: ''
})

const passwordRules = {
  currentPassword: [
    { required: true, message: '请输入当前密码', trigger: 'blur' }
  ],
  newPassword: [
    { required: true, message: '请输入新密码', trigger: 'blur' },
    { min: 6, message: '密码长度至少6位', trigger: 'blur' }
  ],
  confirmPassword: [
    { required: true, message: '请再次输入新密码', trigger: 'blur' },
    {
      validator: (rule, value, callback) => {
        if (value !== passwordForm.newPassword) {
          callback(new Error('两次输入的密码不一致'))
        } else {
          callback()
        }
      },
      trigger: 'blur'
    }
  ]
}

// 刷新用户信息
const refreshUserInfo = async () => {
  console.log('=== 开始刷新用户信息 ===')
  loading.value = true
  try {
    console.log('调用 userStore.fetchUserInfo()...')
    await userStore.fetchUserInfo()
    console.log('用户信息获取成功:', userStore.user)
    ElMessage.success('用户信息刷新成功')
  } catch (error) {
    console.error('刷新用户信息失败:', error)
    ElMessage.error('刷新用户信息失败: ' + (error.message || '未知错误'))
  } finally {
    loading.value = false
    console.log('=== 刷新用户信息完成 ===')
  }
}

// 修改密码
const handleChangePassword = async () => {
  try {
    await passwordFormRef.value.validate()
    passwordLoading.value = true

    const response = await changePassword({
      currentPassword: passwordForm.currentPassword,
      newPassword: passwordForm.newPassword,
      confirmPassword: passwordForm.confirmPassword
    })

    if (response.success) {
      ElMessage.success('密码修改成功')
      showPasswordDialog.value = false
      resetPasswordForm()
    }
  } catch (error) {
    if (error.response?.data?.message) {
      ElMessage.error(error.response.data.message)
    } else {
      ElMessage.error('修改密码失败')
    }
    console.error('修改密码失败:', error)
  } finally {
    passwordLoading.value = false
  }
}

// 重置密码表单
const resetPasswordForm = () => {
  passwordForm.currentPassword = ''
  passwordForm.newPassword = ''
  passwordForm.confirmPassword = ''
  passwordFormRef.value?.resetFields()
}

// 格式化日期
const formatDate = (dateString) => {
  if (!dateString) return '-'
  return new Date(dateString).toLocaleString('zh-CN')
}

// 获取角色类型
const getRoleType = (role) => {
  const types = {
    'admin': 'danger',
    'user': 'primary',
    'guest': 'info'
  }
  return types[role] || 'info'
}

// 获取角色文本
const getRoleText = (role) => {
  const texts = {
    'admin': '管理员',
    'user': '普通用户',
    'guest': '访客'
  }
  return texts[role] || role
}

// 获取状态类型
const getStatusType = (status) => {
  const types = {
    'active': 'success',
    'inactive': 'warning',
    'banned': 'danger'
  }
  return types[status] || 'info'
}

// 获取状态文本
const getStatusText = (status) => {
  const texts = {
    'active': '正常',
    'inactive': '未激活',
    'banned': '已禁用'
  }
  return texts[status] || status
}

// ── Bank-Securities Transfer ────────────────────────────────────────────────
const transferDirection = ref('deposit')
const transferAmount = ref(10000)
const transferPassword = ref('')
const transferLoading = ref(false)
const historyLoading = ref(false)
const transferHistory = ref([])
const transferState = reactive({
  securitiesBalance: 1000000,
  bankBalance: 5000000,
  bankName: 'Demo Bank',
  bankAccount: '****8888',
  securitiesAccount: ''
})

const loadTransferBalance = async () => {
  try {
    const res = await request.get('/bank-transfer/balance')
    if (res && res.data) {
      Object.assign(transferState, res.data)
    }
  } catch { /* silent */ }
}

const loadTransferHistory = async () => {
  historyLoading.value = true
  try {
    const res = await request.get('/bank-transfer/history')
    if (res && res.data && res.data.list) {
      transferHistory.value = res.data.list
    }
  } catch { /* silent */ }
  historyLoading.value = false
}

const handleTransfer = async () => {
  if (transferAmount.value < 100) {
    ElMessage.warning('最低转账金额为100元')
    return
  }
  transferLoading.value = true
  try {
    const endpoint = transferDirection.value === 'deposit' ? '/bank-transfer/deposit' : '/bank-transfer/withdraw'
    const payload = {
      amount: transferAmount.value,
      ...(transferDirection.value === 'deposit' ? { bankPassword: transferPassword.value } : { tradingPassword: transferPassword.value })
    }
    const res = await request.post(endpoint, payload)
    if (res && res.success) {
      ElMessage.success(transferDirection.value === 'deposit' ? '转入成功' : '转出成功')
      transferPassword.value = ''
      loadTransferBalance()
      loadTransferHistory()
    } else {
      ElMessage.error(res?.message || 'Transfer failed')
    }
  } catch (err) {
    ElMessage.error(err?.response?.data?.message || err?.message || 'Transfer failed')
  }
  transferLoading.value = false
}

const formatMoney = (amount) => {
  if (typeof amount !== 'number' || isNaN(amount)) return '0.00'
  return amount.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// 页面加载时获取用户信息
onMounted(async () => {
  webauthnSupported.value = !!window.PublicKeyCredential

  if (!userStore.user && userStore.isAuthenticated()) {
    await refreshUserInfo()
  }

  // 查询生物识别绑定状态
  await checkBioStatus()

  // Load bank transfer data
  loadTransferBalance()
  loadTransferHistory()
})

// ── 生物识别 ──────────────────────────────────────────────────────────────────
const bioBound          = ref(false)
const bioLoading        = ref(false)
const webauthnSupported = ref(true)

async function checkBioStatus() {
  if (!userStore.token) return
  try {
    const res = await fetch('/api/webauthn/status', {
      headers: { 'Authorization': `Bearer ${userStore.token}` }
    }).then(r => r.json())
    bioBound.value = res.bound ?? false
  } catch { /* 静默失败 */ }
}

async function handleBindBio() {
  if (!window.PublicKeyCredential) {
    ElMessage.error('当前浏览器不支持 WebAuthn，请使用 Chrome / Edge'); return
  }
  bioLoading.value = true
  try {
    // 1. 获取注册 options
    const optRes = await fetch('/api/webauthn/register-options', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${userStore.token}` }
    }).then(r => r.json())
    if (!optRes.success) throw new Error(optRes.message)
    const { options } = optRes

    // 2. 调用 Windows Hello
    const credential = await navigator.credentials.create({
      publicKey: {
        challenge:            b64ToUint8(options.challenge),
        rp:                   options.rp,
        user: {
          id:          b64ToUint8(options.user.id),
          name:        options.user.name,
          displayName: options.user.displayName
        },
        pubKeyCredParams:     options.pubKeyCredParams,
        authenticatorSelection: options.authenticatorSelection,
        timeout:              options.timeout,
        attestation:          options.attestation
      }
    })

    // 3. 发送到后端保存
    const verifyRes = await fetch('/api/webauthn/register-verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${userStore.token}` },
      body: JSON.stringify({
        id:     credential.id,
        rawId:  uint8ToB64(new Uint8Array(credential.rawId)),
        type:   credential.type || 'public-key',
        response: {
          clientDataJSON:    uint8ToB64(new Uint8Array(credential.response.clientDataJSON)),
          authenticatorData: uint8ToB64(new Uint8Array(
            credential.response.getAuthenticatorData?.() ?? credential.response.authenticatorData
          )),
          attestationObject: uint8ToB64(new Uint8Array(credential.response.attestationObject)),
          transports: credential.response.getTransports?.() ?? []
        }
      })
    }).then(r => r.json())

    if (!verifyRes.success) throw new Error(verifyRes.message)

    bioBound.value = true
    ElMessage.success('生物识别绑定成功！下次可直接使用 Windows Hello 登录')
  } catch (e) {
    if (e.name === 'NotAllowedError') ElMessage.warning('操作被取消')
    else ElMessage.error(e.message || '绑定失败')
  } finally {
    bioLoading.value = false
  }
}

async function handleUnbindBio() {
  bioLoading.value = true
  try {
    const res = await fetch('/api/webauthn/unbind', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${userStore.token}` }
    }).then(r => r.json())
    if (!res.success) throw new Error(res.message)
    bioBound.value = false
    ElMessage.success('生物识别已解绑')
  } catch (e) {
    ElMessage.error(e.message || '解绑失败')
  } finally {
    bioLoading.value = false
  }
}

// ── WebAuthn 工具函数 ─────────────────────────────────────────────────────────
function b64ToUint8(b64) {
  const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(bin, c => c.charCodeAt(0))
}
function uint8ToB64(u8) {
  return btoa(String.fromCharCode(...u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}
</script>

<style scoped>
.profile-page {
  --theme-primary: #6366f1;
  --theme-primary-rgb: 99, 102, 241;
  --theme-bg: #f0f4f8;
  --theme-banner-start: #e8f4fd;
  --theme-banner-mid: #dbeafe;
  --theme-banner-end: #c7d2fe;
  --theme-text: #1e293b;

  padding: 0;
  min-height: 100vh;
  background: var(--theme-bg);
}

/* 用户头像横幅 */
.profile-banner {
  position: relative;
  background: linear-gradient(135deg, var(--theme-banner-start) 0%, var(--theme-banner-mid) 40%, var(--theme-banner-end) 100%);
  padding: 40px 20px 80px;
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  box-shadow: 0 4px 12px rgba(var(--theme-primary-rgb), 0.1);
}

.avatar-section {
  display: flex;
  align-items: center;
  gap: 20px;
}

.avatar-wrapper {
  position: relative;
}

.user-avatar-badge {
  background: white;
  border: 4px solid rgba(var(--theme-primary-rgb), 0.3);
  box-shadow: 0 8px 24px rgba(var(--theme-primary-rgb), 0.15);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  transition: all 0.3s ease;
}

.user-avatar-badge:hover {
  transform: scale(1.05);
  box-shadow: 0 12px 32px rgba(var(--theme-primary-rgb), 0.25);
  border-color: rgba(var(--theme-primary-rgb), 0.5);
}

.badge-image {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.user-avatar {
  background: linear-gradient(135deg, #81ecec 0%, #00b894 100%);
  border: 4px solid rgba(255, 255, 255, 0.3);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
}

.user-basic-info {
  color: var(--theme-text);
}

.username {
  margin: 0 0 12px 0;
  font-size: 28px;
  font-weight: 600;
  text-shadow: none;
}

.user-meta {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.role-tag,
.status-tag {
  backdrop-filter: blur(10px);
  background: rgba(var(--theme-primary-rgb), 0.1) !important;
  border: 1px solid rgba(var(--theme-primary-rgb), 0.3);
  color: var(--theme-primary) !important;
}

.refresh-btn {
  background: rgba(var(--theme-primary-rgb), 0.1);
  border: 1px solid rgba(var(--theme-primary-rgb), 0.3);
  color: var(--theme-primary);
  backdrop-filter: blur(10px);
  transition: all 0.3s ease;
}

.refresh-btn:hover {
  background: rgba(var(--theme-primary-rgb), 0.2);
  transform: rotate(180deg);
  border-color: rgba(var(--theme-primary-rgb), 0.5);
}

/* 内容区域 */
.profile-content {
  margin-top: -60px;
  padding: 0 20px 40px;
  position: relative;
  z-index: 1;
}

/* Card style */
.info-card,
.security-card {
  border-radius: var(--radius-md);
  border: none;
  overflow: hidden;
  transition: all 0.3s ease;
  margin-bottom: 16px;
}

.info-card:hover,
.security-card:hover {
  transform: translateY(-4px);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.15);
}

.card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  font-size: 16px;
  color: #303133;
}

.header-icon {
  font-size: 20px;
  color: #409eff;
}

/* 信息网格 */
.info-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 20px;
}

.info-item {
  padding: 16px;
  background: linear-gradient(135deg, #f5f7fa 0%, #f0f2f5 100%);
  border-radius: var(--radius-md);
  transition: all 0.3s ease;
}

.info-item:hover {
  background: linear-gradient(135deg, #e8eaf0 0%, #e0e3e8 100%);
  transform: translateX(4px);
}

.info-label {
  font-size: 12px;
  color: #909399;
  margin-bottom: 8px;
  font-weight: 500;
}

.info-value {
  font-size: 14px;
  color: #303133;
  font-weight: 600;
  word-break: break-all;
}

/* 加载状态 */
.loading-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 80px 20px;
  color: #909399;
}

.loading-container .el-icon {
  font-size: 48px;
  margin-bottom: 16px;
  color: #409eff;
}

.loading-container p {
  font-size: 14px;
  margin: 0;
}

/* 生物识别区域 */
.bio-section {
  padding: 16px;
  background: linear-gradient(135deg, #e8f4fd 0%, #dbeeff 100%);
  border-radius: var(--radius-md);
  border-left: 4px solid #409eff;
}

.bio-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.bio-title {
  font-weight: 600;
  font-size: 14px;
  color: #303133;
}

.bio-desc {
  font-size: 12px;
  color: #606266;
  margin: 0 0 12px;
  line-height: 1.5;
}

.bio-btns {
  display: flex;
  gap: 8px;
}

.bio-btn {
  flex: 1;
  border-radius: 8px;
  font-weight: 600;
}

.bio-unsupported {
  font-size: 12px;
  color: #e6a23c;
  margin: 8px 0 0;
}

/* 安全设置 */
.security-actions {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.change-password-btn {
  width: 100%;
  height: 48px;
  font-size: 16px;
  font-weight: 600;
  border-radius: var(--radius-md);
  background: linear-gradient(135deg, #a8e6cf 0%, #56c596 100%);
  border: none;
  transition: all 0.3s ease;
}

.change-password-btn:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 24px rgba(86, 197, 150, 0.4);
}

.security-tips {
  padding: 16px;
  background: linear-gradient(135deg, #fff9e6 0%, #fff3d6 100%);
  border-radius: var(--radius-md);
  border-left: 4px solid #e6a23c;
}

.tip-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  font-weight: 600;
  color: #e6a23c;
}

.tip-icon {
  font-size: 18px;
}

.tip-list {
  margin: 0;
  padding-left: 20px;
  color: #606266;
  font-size: 13px;
  line-height: 1.8;
}

.tip-list li {
  margin-bottom: 4px;
}

/* 对话框样式 */
.password-dialog :deep(.el-dialog__header) {
  background: linear-gradient(135deg, #a8e6cf 0%, #56c596 100%);
  color: white;
  padding: 20px;
  margin: 0;
}

.password-dialog :deep(.el-dialog__title) {
  color: white;
  font-weight: 600;
}

.password-dialog :deep(.el-dialog__headerbtn .el-dialog__close) {
  color: white;
}

.password-form {
  padding: 20px 0;
}

.dialog-footer {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
}

.dialog-footer .el-button {
  min-width: 100px;
  border-radius: 8px;
}

/* ── Bank Transfer Card ─────────────────────────────────────────────────── */
.transfer-card {
  border-radius: var(--radius-md);
  border: none;
  overflow: hidden;
  transition: all 0.3s ease;
  margin-bottom: 16px;
}

.transfer-card:hover {
  transform: translateY(-4px);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.15);
}

.transfer-layout {
  display: flex;
  gap: 24px;
}

.transfer-form-section {
  flex: 1;
  min-width: 0;
}

.transfer-history-section {
  width: 360px;
  flex-shrink: 0;
  border-left: 1px solid #ebeef5;
  padding-left: 24px;
}

.account-info-row {
  display: flex;
  gap: 16px;
  margin-bottom: 20px;
}

.account-box {
  flex: 1;
  padding: 14px 16px;
  background: linear-gradient(135deg, #f5f7fa 0%, #f0f2f5 100%);
  border-radius: 8px;
}

.account-label {
  font-size: 12px;
  color: #909399;
  margin-bottom: 6px;
}

.account-value {
  font-size: 20px;
  font-weight: 700;
  color: #303133;
  font-family: 'Consolas', monospace;
}

.transfer-tabs {
  display: flex;
  gap: 0;
  margin-bottom: 20px;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid #dcdfe6;
}

.transfer-tab {
  flex: 1;
  padding: 10px;
  border: none;
  background: #f5f7fa;
  font-size: 14px;
  font-weight: 600;
  color: #606266;
  cursor: pointer;
  transition: all 0.2s;
}

.transfer-tab.active {
  background: #409eff;
  color: white;
}

.transfer-tab:hover:not(.active) {
  background: #e8eaf0;
}

.transfer-form {
  max-width: 400px;
}

.transfer-submit-btn {
  width: 100%;
  height: 44px;
  font-size: 15px;
  font-weight: 600;
  border-radius: 8px;
}

.history-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
  font-weight: 600;
  font-size: 14px;
  color: #303133;
}

.history-list {
  max-height: 320px;
  overflow-y: auto;
}

.history-item {
  padding: 10px 12px;
  border-radius: 6px;
  margin-bottom: 8px;
  background: #f9fafb;
  border: 1px solid #ebeef5;
}

.history-item.deposit {
  border-left: 3px solid #67c23a;
}

.history-item.withdraw {
  border-left: 3px solid #e6a23c;
}

.history-row-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 4px;
}

.history-type {
  font-size: 13px;
  font-weight: 600;
  color: #303133;
}

.history-amount {
  font-size: 14px;
  font-weight: 700;
  font-family: 'Consolas', monospace;
}

.amount-in {
  color: #67c23a;
}

.amount-out {
  color: #e6a23c;
}

.history-row-bottom {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.history-time {
  font-size: 11px;
  color: #909399;
}

.history-empty {
  text-align: center;
  color: #909399;
  padding: 40px 0;
  font-size: 13px;
}

/* 移动端适配 */
@media (max-width: 768px) {
  .transfer-layout {
    flex-direction: column;
  }

  .transfer-history-section {
    width: 100%;
    border-left: none;
    padding-left: 0;
    border-top: 1px solid #ebeef5;
    padding-top: 16px;
  }

  .account-info-row {
    flex-direction: column;
  }

  .profile-page.mobile-view {
    background: #f5f7fa;
  }

  .profile-banner {
    padding: 24px 16px 60px;
    flex-direction: column;
    gap: 16px;
  }

  .avatar-section {
    width: 100%;
    gap: 16px;
  }

  .user-avatar {
    border-width: 3px;
  }

  .username {
    font-size: 22px;
    margin-bottom: 8px;
  }

  .refresh-btn {
    position: absolute;
    top: 16px;
    right: 16px;
  }

  .profile-content {
    margin-top: -40px;
    padding: 0 12px 24px;
  }

  .info-card,
  .security-card {
    border-radius: var(--radius-md);
    margin-bottom: 12px;
  }

  .info-grid {
    grid-template-columns: 1fr;
    gap: 12px;
  }

  .info-item {
    padding: 12px;
  }

  .card-header {
    font-size: 15px;
  }

  .header-icon {
    font-size: 18px;
  }

  .change-password-btn {
    height: 44px;
    font-size: 15px;
  }

  .security-tips {
    padding: 12px;
  }

  .tip-list {
    font-size: 12px;
  }

  .password-form {
    padding: 16px 0;
  }

  .dialog-footer {
    flex-direction: column-reverse;
  }

  .dialog-footer .el-button {
    width: 100%;
  }

  /* 移动端滚动优化 */
  .profile-page {
    overflow-y: auto;
    overflow-x: hidden;
    -webkit-overflow-scrolling: touch;
  }

  /* 隐藏滚动条 */
  .profile-page::-webkit-scrollbar {
    display: none;
  }
}

/* 平板适配 */
@media (min-width: 769px) and (max-width: 1024px) {
  .profile-banner {
    padding: 32px 20px 70px;
  }

  .username {
    font-size: 24px;
  }

  .info-grid {
    grid-template-columns: repeat(2, 1fr);
    gap: 16px;
  }
}

/* 小屏手机适配 */
@media (max-width: 375px) {
  .username {
    font-size: 20px;
  }

  .user-avatar {
    width: 70px !important;
    height: 70px !important;
  }

  .info-label {
    font-size: 11px;
  }

  .info-value {
    font-size: 13px;
  }
}

/* 横屏模式 */
@media (max-width: 768px) and (orientation: landscape) {
  .profile-banner {
    padding: 20px 16px 50px;
  }

  .username {
    font-size: 20px;
  }

  .user-avatar {
    width: 60px !important;
    height: 60px !important;
  }

  .info-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}
</style>

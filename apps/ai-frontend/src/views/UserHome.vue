<template>
  <div class="user-home-page">
    <section class="home-hero">
      <div class="home-hero-glow" aria-hidden="true"></div>
      <div class="home-hero-main">
        <span class="home-hero-logo">K</span>
        <div class="home-hero-text">
          <h2 class="home-hero-title">欢迎回到 KHY AI 工作台</h2>
          <p class="home-hero-sub">直接开始 AI 对话，或切换到管理员视图进行系统配置与渠道管理。</p>
        </div>
      </div>
      <el-tag class="home-hero-tag" effect="dark" round>
        当前身份：{{ userStore.isAdmin ? '管理员（用户视图）' : '普通用户' }}
      </el-tag>
    </section>

    <!-- 首访轻量引导:仅第一次进入时出现,可关闭且记忆到 localStorage,绝不强制、
         不打断操作。指向新增的「功能索引」,解决"有功能却不知去哪用"。 -->
    <el-alert
      v-if="showOnboarding"
      type="primary"
      show-icon
      :closable="true"
      class="home-onboarding"
      title="第一次来？这里有一份能力地图"
      @close="dismissOnboarding"
    >
      <template #default>
        <span>小K 能写代码、读图、查资料、跑多智能体协作……想快速了解全部功能，去看看</span>
        <el-button link type="primary" class="home-onboarding-link" @click="goFeatures">功能索引</el-button>
        <span>。</span>
      </template>
    </el-alert>

    <el-alert
      type="success"
      :closable="false"
      show-icon
      title="已进入用户视图。你可以直接开始 AI 对话；如需系统配置与渠道管理，请切换到管理员视图。"
      class="home-alert"
    />

    <el-row :gutter="16">
      <el-col :xs="24" :lg="14">
        <el-card class="home-card" shadow="hover">
          <template #header>
            <div class="card-header-row">
              <el-icon class="card-header-icon"><ChatDotRound /></el-icon>
              <span>快速开始</span>
            </div>
          </template>
          <div class="quick-actions">
            <el-button type="primary" size="large" @click="goChat">
              <el-icon class="btn-icon"><ChatLineRound /></el-icon>
              进入 AI 对话
            </el-button>
            <el-button v-if="userStore.isAdmin" size="large" @click="enterAdmin">
              <el-icon class="btn-icon"><Setting /></el-icon>
              切换到管理员视图
            </el-button>
          </div>
        </el-card>
      </el-col>

      <el-col :xs="24" :lg="10">
        <el-card class="home-card" shadow="hover">
          <template #header>
            <div class="card-header-row">
              <el-icon class="card-header-icon"><InfoFilled /></el-icon>
              <span>连接提示</span>
            </div>
          </template>
          <ul class="tips-list">
            <li>若出现 Network Error，请确认 `ai-backend` 容器状态为 healthy。</li>
            <li>浏览器访问地址建议保持与部署环境提供的入口一致。</li>
            <li>管理员页面请求量更高，网络抖动时会自动进行一次重试。</li>
          </ul>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useUserStore } from '@/stores/user'
import { ChatDotRound, ChatLineRound, Setting, InfoFilled } from '@element-plus/icons-vue'

defineOptions({ name: 'UserHome' })

const router = useRouter()
const userStore = useUserStore()

// 首访引导:只在从未关闭过时显示。localStorage 读失败(隐私模式等)时默认不打扰。
const ONBOARDED_KEY = 'khy_ai_home_onboarded'
const showOnboarding = ref(false)
try {
  showOnboarding.value = localStorage.getItem(ONBOARDED_KEY) !== '1'
} catch {
  showOnboarding.value = false
}
function dismissOnboarding() {
  showOnboarding.value = false
  try { localStorage.setItem(ONBOARDED_KEY, '1') } catch { /* noop */ }
}
function goFeatures() {
  dismissOnboarding()
  router.push('/features')
}

function goChat() {
  router.push('/chat')
}

function enterAdmin() {
  userStore.setWorkspace('admin')
  router.push('/dashboard')
}
</script>

<style scoped>
.user-home-page {
  max-width: 1120px;
  margin: 0 auto;
}

.home-onboarding {
  margin-bottom: 12px;
  border-radius: var(--khy-radius);
}
.home-onboarding-link {
  padding: 0 2px;
  vertical-align: baseline;
}

.home-hero {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  padding: 24px 26px;
  margin-bottom: 16px;
  border-radius: var(--khy-radius-lg);
  border: 1px solid var(--khy-border);
  background: linear-gradient(135deg, var(--khy-primary), var(--khy-primary-strong));
  box-shadow: var(--khy-shadow-lift);
  overflow: hidden;
}

.home-hero-glow {
  position: absolute;
  top: -80px;
  right: -40px;
  width: 260px;
  height: 260px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.18);
  filter: blur(50px);
  pointer-events: none;
  animation: home-glow-drift 16s ease-in-out infinite;
}

@keyframes home-glow-drift {
  0%, 100% { transform: translate(0, 0) scale(1); opacity: 0.85; }
  50%      { transform: translate(-26px, 22px) scale(1.12); opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  .home-hero-glow { animation: none; }
}

.home-hero-main {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 16px;
  min-width: 0;
}

.home-hero-logo {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 52px;
  height: 52px;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.18);
  border: 1px solid rgba(255, 255, 255, 0.35);
  color: #fff;
  font-weight: 800;
  font-size: 26px;
  flex-shrink: 0;
}

.home-hero-text {
  min-width: 0;
}

.home-hero-title {
  margin: 0;
  color: #fff;
  font-weight: 700;
  font-size: 22px;
  letter-spacing: 0.3px;
}

.home-hero-sub {
  margin: 6px 0 0 0;
  color: rgba(255, 255, 255, 0.88);
  font-size: 13px;
  line-height: 1.5;
}

.home-hero-tag {
  position: relative;
  z-index: 1;
  background: rgba(255, 255, 255, 0.16) !important;
  border-color: rgba(255, 255, 255, 0.35) !important;
  color: #fff !important;
}

.home-alert {
  margin-bottom: 14px;
}

.home-card {
  margin-bottom: 16px;
  border-radius: var(--khy-radius-lg);
}

.card-header-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
}

.card-header-icon {
  color: var(--khy-primary);
  font-size: 17px;
}

.quick-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.btn-icon {
  margin-right: 6px;
}

.tips-list {
  margin: 0;
  padding-left: 18px;
  line-height: 1.7;
  color: var(--khy-text-secondary);
}
</style>

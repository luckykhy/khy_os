<template>
  <div class="login-page">
    <canvas ref="starCanvasRef" class="star-canvas" />

    <section class="login-card" :class="{ shake: shaking }">
      <header class="card-header">
        <img src="/logo.png" alt="KHY-Quant" class="brand-logo" />
        <h1>量化交易系统</h1>
        <p>KHY-Quant · 智能量化平台</p>
      </header>

      <div class="welcome-text">
        <h2>欢迎回来</h2>
        <span>请选择登录方式</span>
      </div>

      <div class="platform-copy">
        <strong>智能交易工作台</strong>
        <p>统一的策略开发、执行和监控平台，适用于桌面浏览器。</p>
      </div>

      <div class="login-main">
        <section class="left-panel">
          <div class="input-wrap">
            <span class="input-icon">👤</span>
            <input
              v-model="form.username"
              placeholder="用户名或邮箱"
              autocomplete="username"
              @keyup.enter="handleLogin"
            />
          </div>

          <div class="input-wrap">
            <span class="input-icon">🔒</span>
            <input
              v-model="form.password"
              :type="showPwd ? 'text' : 'password'"
              placeholder="密码"
              autocomplete="current-password"
              @keyup.enter="handleLogin"
            />
            <span class="eye-btn" @click="showPwd = !showPwd">{{ showPwd ? '🙈' : '👁️' }}</span>
          </div>

          <label class="remember-wrap">
            <input v-model="rememberPassword" type="checkbox" @change="handleRememberPasswordToggle" />
            <span>记住密码</span>
          </label>

          <button class="login-btn" :disabled="loading" @click="handleLogin">
            <span v-if="!loading">登 录</span>
            <span v-else class="spinner" />
          </button>

          <button class="login-btn secondary bio-btn" :disabled="bioLoading" @click="startBioLogin">
            <span v-if="!bioLoading">生物识别登录</span>
            <span v-else class="spinner" />
          </button>

          <p v-if="!isWebAuthnSupported" class="unsupported-inline">当前设备不支持生物识别</p>
          <p class="status-text" :class="bioStatusType">{{ bioStatusMessage }}</p>

          <div class="form-links">
            <router-link to="/forgot-password">忘记密码？</router-link>
            <router-link to="/register">立即注册</router-link>
          </div>
        </section>

        <div class="panel-divider" />

        <section class="right-panel">
          <h3>扫码登录</h3>
          <div class="qr-wrap">
            <canvas ref="qrCanvasRef" class="qr-canvas" />
            <div class="qr-scan-line" />
            <div v-if="qrLoading" class="qr-overlay">二维码生成中...</div>
          </div>

          <p class="qr-countdown">二维码 {{ qrSeconds }} 秒后刷新</p>
          <p class="qr-hint">使用手机扫码快速登录</p>

          <button class="refresh-btn" type="button" @click="refreshQr(true)">立即刷新</button>
          <p v-if="qrError" class="status-text error">{{ qrError }}</p>
        </section>
      </div>

      <footer v-if="showConnectionSettings" class="connection-settings">
        <div class="setting-title">连接模式</div>
        <div class="setting-row">
          <select v-model="connectionMode" class="setting-select" @change="applyConnectionSettings">
            <option v-if="allowLocalMode" value="local">单机（离线本地）</option>
            <option value="auto">自动（优先云端，失败回退本地）</option>
            <option value="cloud">云端（仅服务器）</option>
          </select>
        </div>
        <div v-if="connectionMode !== 'local'" class="setting-row">
          <input
            v-model="backendUrl"
            class="setting-input"
            placeholder="服务器地址，如 https://khyquant.top"
            @blur="applyConnectionSettings"
          />
        </div>
      </footer>
    </section>
  </div>
</template>

<script setup>
// ---------------------------------------------------------------------------
// Login —— 用户登录页面
//
// 架构角色：属于前端交互层，对应论文第5.1节（认证与中间件实现）
//
// 认证方式：
//   1. 传统登录：用户名 + 密码 → JWT Token
//   2. 生物识别登录：WebAuthn 指纹/面容（可选）
//   3. 凭据记忆：加密存储用户名密码到 localStorage
//
// 安全设计（对应论文第3.2节安全需求）：
//   - 密码通过 bcrypt 加密传输
//   - JWT Token 存储在 Pinia Store（内存），不写 cookie
//   - WebAuthn 使用浏览器原生安全硬件
//
// 视觉效果：
//   - Canvas 星空动画背景
//   - 登录卡片毛玻璃效果
// ---------------------------------------------------------------------------
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import QRCode from 'qrcode'
import { useUserStore } from '@/stores/user'
import {
  getBackendUrl,
  getConnectionMode,
  setBackendUrl,
  setConnectionMode
} from '@/utils/connectionMode'

const router = useRouter()
const userStore = useUserStore()

const loading = ref(false)
const showPwd = ref(false)
const shaking = ref(false)
const rememberPassword = ref(false)
const form = reactive({ username: '', password: '' })

// ── 凭据记忆功能：使用AES-GCM加密存储到localStorage ──
const REMEMBER_CREDENTIAL_KEY = 'khy_quant_login_remember_v2'
const OLD_REMEMBER_KEY = 'khy_quant_login_remember_v1'
const OLD_XOR_KEY = 'KHY_QUANT_LOGIN_2026'

const connectionMode = ref(getConnectionMode())
const backendUrl = ref(getBackendUrl())

// Web部署环境检测：线上域名(khyquant.top)隐藏本地连接选项
const isWebDeploy = computed(() => {
  const host = window.location?.hostname || ''
  return host.includes('khyquant.top') || host.includes('khyquant.com')
})
const allowLocalMode = computed(() => !isWebDeploy.value)
const showConnectionSettings = computed(() => !isWebDeploy.value)

const bioLoading = ref(false)
const bioStatusMessage = ref('')
const bioStatusType = ref('')
const isWebAuthnSupported = ref(false)

const qrCanvasRef = ref(null)
const qrToken = ref('')
const qrSeconds = ref(60)
const qrLoading = ref(false)
const qrError = ref('')
let qrCountdownTimer = null
let qrPollTimer = null

const starCanvasRef = ref(null)
let starCtx = null
let stars = []
let starAnimationId = null
let lastFrameTime = 0

// ── 星空动画背景（Canvas绘制） ──
const STAR_COUNT = 180

// 创建单个星星对象：随机位置、大小、速度、闪烁频率和颜色
function createStar(width, height) {
  const size = 1 + Math.random() * 2
  const angle = Math.random() * Math.PI * 2
  const speed = 2 + Math.random() * 6
  const periodMs = 2000 + Math.random() * 3000
  return {
    x: Math.random() * width,
    y: Math.random() * height,
    size,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed * 0.7,
    minAlpha: 0.18 + Math.random() * 0.18,
    maxAlpha: 0.62 + Math.random() * 0.35,
    twinkleSpeed: (Math.PI * 2) / periodMs,
    phase: Math.random() * Math.PI * 2,
    color: Math.random() > 0.68 ? [196, 224, 255] : [255, 255, 255]
  }
}

// 初始化Canvas画布，适配设备像素比（DPR），生成所有星星
function initStarCanvas() {
  const canvas = starCanvasRef.value
  if (!canvas) return

  const width = window.innerWidth
  const height = window.innerHeight
  const dpr = window.devicePixelRatio || 1

  canvas.width = Math.floor(width * dpr)
  canvas.height = Math.floor(height * dpr)
  canvas.style.width = `${width}px`
  canvas.style.height = `${height}px`

  starCtx = canvas.getContext('2d')
  if (!starCtx) return
  starCtx.setTransform(dpr, 0, 0, dpr, 0, 0)

  stars = Array.from({ length: STAR_COUNT }, () => createStar(width, height))
}

// 每帧更新星星位置和透明度，绘制到Canvas（requestAnimationFrame驱动）
function updateAndDrawStars(timestamp) {
  const canvas = starCanvasRef.value
  if (!canvas || !starCtx) return

  const width = window.innerWidth
  const height = window.innerHeight

  if (!lastFrameTime) lastFrameTime = timestamp
  const deltaSec = Math.min((timestamp - lastFrameTime) / 1000, 0.05)
  lastFrameTime = timestamp

  starCtx.clearRect(0, 0, width, height)

  for (const star of stars) {
    star.x += star.vx * deltaSec
    star.y += star.vy * deltaSec

    if (star.x < -4) star.x = width + 4
    if (star.x > width + 4) star.x = -4
    if (star.y < -4) star.y = height + 4
    if (star.y > height + 4) star.y = -4

    const progress = 0.5 + 0.5 * Math.sin(timestamp * star.twinkleSpeed + star.phase)
    const alpha = star.minAlpha + (star.maxAlpha - star.minAlpha) * progress

    starCtx.fillStyle = `rgba(${star.color[0]}, ${star.color[1]}, ${star.color[2]}, ${alpha.toFixed(3)})`
    starCtx.beginPath()
    starCtx.arc(star.x, star.y, star.size, 0, Math.PI * 2)
    starCtx.fill()
  }

  starAnimationId = requestAnimationFrame(updateAndDrawStars)
}

function startStarAnimation() {
  if (starAnimationId) cancelAnimationFrame(starAnimationId)
  lastFrameTime = 0
  starAnimationId = requestAnimationFrame(updateAndDrawStars)
}

function stopStarAnimation() {
  if (starAnimationId) {
    cancelAnimationFrame(starAnimationId)
    starAnimationId = null
  }
}

function handleResize() {
  initStarCanvas()
}

// 应用连接模式设置（本地/自动/云端），保存到localStorage
function applyConnectionSettings() {
  setConnectionMode(connectionMode.value)
  if (connectionMode.value !== 'local') {
    setBackendUrl(backendUrl.value)
  }
}

// 登录失败时触发卡片抖动动画效果
function triggerShake() {
  shaking.value = true
  setTimeout(() => {
    shaking.value = false
  }, 500)
}

function toBase64(bytes) {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

function fromBase64(value) {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

// Legacy XOR decoder for migration from v1 format
function decodeOldXorPayload(payload) {
  const encoder = new TextEncoder()
  const key = encoder.encode(OLD_XOR_KEY)
  const binary = atob(payload)
  const encryptedBytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) encryptedBytes[i] = binary.charCodeAt(i)
  const plainBytes = new Uint8Array(encryptedBytes.length)
  for (let i = 0; i < encryptedBytes.length; i++) plainBytes[i] = encryptedBytes[i] ^ key[i % key.length]
  return JSON.parse(new TextDecoder().decode(plainBytes))
}

function clearRememberedCredentials() {
  localStorage.removeItem(REMEMBER_CREDENTIAL_KEY)
  localStorage.removeItem(OLD_REMEMBER_KEY) // clean up old format
}

// Encrypt and save credentials to localStorage using AES-GCM
async function saveRememberedCredentials() {
  if (!rememberPassword.value) {
    clearRememberedCredentials()
    return
  }

  const username = form.username.trim()
  const password = form.password
  if (!username || !password) return

  try {
    const { encryptForStorage } = await import('@/utils/localEncrypt')
    const encrypted = await encryptForStorage({
      username,
      password,
      savedAt: Date.now()
    })
    localStorage.setItem(REMEMBER_CREDENTIAL_KEY, encrypted)
    localStorage.removeItem(OLD_REMEMBER_KEY) // clean up old format
  } catch { /* best effort */ }
}

// Load and decrypt saved credentials from localStorage
async function loadRememberedCredentials() {
  // Try new AES-GCM format first
  let encrypted = localStorage.getItem(REMEMBER_CREDENTIAL_KEY)
  if (encrypted) {
    try {
      const { decryptFromStorage } = await import('@/utils/localEncrypt')
      const payload = await decryptFromStorage(encrypted)
      if (!payload?.username || !payload?.password) return
      form.username = payload.username
      form.password = payload.password
      rememberPassword.value = true
      return
    } catch { /* fall through */ }
  }

  // Migration: try old XOR format
  const oldEncrypted = localStorage.getItem(OLD_REMEMBER_KEY)
  if (!oldEncrypted) return

  try {
    const payload = decodeOldXorPayload(oldEncrypted)
    if (!payload?.username || !payload?.password) {
      clearRememberedCredentials()
      return
    }

    form.username = payload.username
    form.password = payload.password
    rememberPassword.value = true
  } catch {
    clearRememberedCredentials()
  }
}

function handleRememberPasswordToggle() {
  if (!rememberPassword.value) {
    clearRememberedCredentials()
    return
  }
  saveRememberedCredentials()
}

watch([
  () => form.username,
  () => form.password
], () => {
  if (rememberPassword.value) {
    saveRememberedCredentials()
  }
})

// ── 传统登录：用户名+密码 → 调用Pinia Store的loginUser → 获取JWT Token ──
async function handleLogin() {
  const username = form.username.trim()
  const password = form.password

  if (!username || !password) {
    triggerShake()
    ElMessage.warning('请填写用户名和密码')
    return
  }

  loading.value = true
  try {
    const response = await userStore.loginUser({ username, password })
    if (response?.success) {
      if (rememberPassword.value) {
        saveRememberedCredentials()
      } else {
        clearRememberedCredentials()
      }

      ElMessage.success('登录成功')
      await router.replace('/dashboard')
      return
    }

    throw new Error(response?.message || '登录失败')
  } catch (error) {
    triggerShake()
    ElMessage.error(error?.response?.data?.message || error?.message || '登录失败')
  } finally {
    loading.value = false
  }
}

// ── WebAuthn生物识别登录（对应论文第5.1节 多因子认证） ──
// 检测当前设备是否支持WebAuthn平台认证器（指纹/面容识别）
async function detectWebAuthnSupport() {
  if (typeof window === 'undefined') return
  if (!window.PublicKeyCredential) {
    isWebAuthnSupported.value = false
    return
  }

  if (typeof window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable !== 'function') {
    isWebAuthnSupported.value = true
    return
  }

  try {
    isWebAuthnSupported.value = await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
  } catch {
    isWebAuthnSupported.value = true
  }
}

function base64UrlToUint8Array(input) {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/')
  const padding = '='.repeat((4 - (normalized.length % 4)) % 4)
  const raw = atob(normalized + padding)
  return Uint8Array.from(raw, (char) => char.charCodeAt(0))
}

function arrayBufferToBase64Url(buffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte)
  })
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function serializeAssertion(assertion) {
  return {
    id: assertion.id,
    rawId: arrayBufferToBase64Url(assertion.rawId),
    type: assertion.type,
    response: {
      clientDataJSON: arrayBufferToBase64Url(assertion.response.clientDataJSON),
      authenticatorData: arrayBufferToBase64Url(assertion.response.authenticatorData),
      signature: arrayBufferToBase64Url(assertion.response.signature),
      userHandle: assertion.response.userHandle
        ? arrayBufferToBase64Url(assertion.response.userHandle)
        : null
    }
  }
}

// 发起生物识别登录流程：获取挑战 → 调用设备认证器 → 验证签名 → 获取Token
async function startBioLogin() {
  if (!isWebAuthnSupported.value) {
    bioStatusType.value = 'error'
    bioStatusMessage.value = '当前设备不支持生物识别'
    return
  }

  const identifier = form.username.trim()
  if (!identifier) {
    bioStatusType.value = 'error'
    bioStatusMessage.value = '请先输入用户名或邮箱'
    return
  }

  bioLoading.value = true
  bioStatusType.value = 'pending'
  bioStatusMessage.value = '正在准备生物识别挑战...'

  try {
    const optionsResp = await fetch('/api/webauthn/login-options', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: identifier })
    })
    const optionsData = await optionsResp.json()
    if (!optionsResp.ok || !optionsData.success) {
      throw new Error(optionsData.message || '无法启动生物识别登录')
    }

    bioStatusMessage.value = '请在设备上完成生物识别验证...'

    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge: base64UrlToUint8Array(optionsData.options.challenge),
        rpId: optionsData.options.rpId,
        allowCredentials: (optionsData.options.allowCredentials || []).map((item) => ({
          type: item.type,
          id: base64UrlToUint8Array(item.id),
          // 强制指定 internal，确保只弹出平台认证器（指纹/人脸），不弹 USB 安全密钥
          transports: ['internal']
        })),
        userVerification: optionsData.options.userVerification || 'required',
        timeout: optionsData.options.timeout,
        // 明确告知浏览器只使用平台认证器，避免弹出 USB 安全密钥提示
        authenticatorAttachment: 'platform'
      }
    })

    if (!assertion) {
      throw new Error('生物识别验证已取消')
    }

    const verifyResp = await fetch('/api/webauthn/login-verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: optionsData.userId,
        credential: serializeAssertion(assertion)
      })
    })

    const verifyData = await verifyResp.json()
    if (!verifyResp.ok || !verifyData.success) {
      throw new Error(verifyData.message || '生物识别验证失败')
    }

    userStore.setToken(verifyData.data.token)
    userStore.setUser(verifyData.data.user)
    bioStatusType.value = 'ok'
    bioStatusMessage.value = '生物识别登录成功，正在跳转...'
    ElMessage.success('生物识别登录成功')

    setTimeout(() => {
      router.replace('/dashboard')
    }, 450)
  } catch (error) {
    bioStatusType.value = 'error'
    if (error?.name === 'NotAllowedError') {
      bioStatusMessage.value = '验证已取消或超时'
    } else {
      bioStatusMessage.value = error?.message || '生物识别登录失败'
    }
  } finally {
    bioLoading.value = false
  }
}

// ── 扫码登录（二维码生成、轮询确认状态） ──
// 停止二维码倒计时和状态轮询定时器
function stopQrLoops() {
  if (qrCountdownTimer) {
    clearInterval(qrCountdownTimer)
    qrCountdownTimer = null
  }
  if (qrPollTimer) {
    clearInterval(qrPollTimer)
    qrPollTimer = null
  }
}

function startQrCountdown() {
  if (qrCountdownTimer) clearInterval(qrCountdownTimer)
  qrCountdownTimer = setInterval(() => {
    qrSeconds.value = Math.max(0, qrSeconds.value - 1)
    if (qrSeconds.value <= 0) {
      refreshQr(true)
    }
  }, 1000)
}

// 每2秒轮询后端查询二维码是否已被扫描确认
function startQrPolling() {
  if (qrPollTimer) clearInterval(qrPollTimer)
  qrPollTimer = setInterval(async () => {
    if (!qrToken.value) return

    try {
      const response = await fetch(`/api/auth/qr-status?token=${encodeURIComponent(qrToken.value)}`)
      // NOTE: fetch() is used intentionally here — these are pre-auth endpoints
      // that run before the user has a JWT, so the request interceptor has nothing to inject.
      const data = await response.json().catch(() => ({}))

      if (!response.ok) {
        if (response.status === 404 || response.status === 410) {
          await refreshQr(true)
        }
        return
      }

      if (data.status === 'confirmed' && data.token) {
        stopQrLoops()
        userStore.setToken(data.token)
        if (data.user) {
          userStore.setUser(data.user)
        } else {
          await userStore.fetchUserInfo()
        }
        ElMessage.success('扫码登录成功')
        router.replace('/dashboard')
      }
    } catch {
      // ignore transient poll failures
    }
  }, 2000)
}

async function renderQrCode(content) {
  if (!qrCanvasRef.value) return
  await QRCode.toCanvas(qrCanvasRef.value, content, {
    width: 220,
    margin: 1,
    color: {
      dark: '#0f172a',
      light: '#ffffff'
    }
  })
}

// 生成/刷新登录二维码：调用后端获取Token，渲染到Canvas，启动倒计时和轮询
async function refreshQr(force = false) {
  if (qrLoading.value) return

  if (!force && qrToken.value && qrSeconds.value > 0) {
    startQrCountdown()
    startQrPolling()
    return
  }

  qrLoading.value = true
  qrError.value = ''
  stopQrLoops()

  try {
    const response = await fetch('/api/auth/qr-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    })
    const data = await response.json()

    if (!response.ok || !data.success) {
      throw new Error(data.message || '无法生成二维码')
    }

    const payload = data.data || {}
    qrToken.value = payload.token || ''
    qrSeconds.value = Number(payload.expiresIn || 60)

    if (!payload.qrUrl) {
      throw new Error('二维码链接缺失')
    }

    await renderQrCode(payload.qrUrl)
    startQrCountdown()
    startQrPolling()
  } catch (error) {
    qrError.value = error?.message || '二维码生成失败'
  } finally {
    qrLoading.value = false
  }
}

// ── 组件生命周期 ──
// 挂载时：加载记住的凭据、检测WebAuthn、初始化星空动画、生成二维码
onMounted(async () => {
  applyConnectionSettings()
  loadRememberedCredentials()
  await detectWebAuthnSupport()

  initStarCanvas()
  startStarAnimation()
  window.addEventListener('resize', handleResize, { passive: true })

  await refreshQr(true)
})

// 卸载时：清理定时器和动画，移除resize监听
onUnmounted(() => {
  stopQrLoops()
  stopStarAnimation()
  window.removeEventListener('resize', handleResize)
})
</script>

<style scoped>
.login-page {
  position: relative;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  background-image: url('/assets/login-background.jpg');
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
}

.login-page::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(145deg, rgba(5, 10, 26, 0.45), rgba(13, 21, 42, 0.6));
  z-index: 0;
}

.star-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  z-index: 1;
  pointer-events: none;
}

.login-card {
  position: relative;
  z-index: 2;
  width: min(700px, 94vw);
  max-height: calc(100vh - 36px);
  overflow-y: auto;
  padding: 24px 24px 20px;
  border-radius: 16px;
  background: rgba(15, 22, 45, 0.46);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border: 1px solid rgba(255, 255, 255, 0.25);
  box-shadow: 0 18px 56px rgba(4, 10, 26, 0.52);
}

.login-card.shake {
  animation: shake 0.45s ease;
}

@keyframes shake {
  0%, 100% { transform: translateX(0); }
  25% { transform: translateX(-8px); }
  75% { transform: translateX(8px); }
}

.card-header {
  text-align: center;
}

.brand-logo {
  width: 44px;
  height: 44px;
  object-fit: contain;
  display: inline-block;
  margin-bottom: 8px;
}

.card-header h1 {
  margin: 0;
  font-size: 25px;
  color: #ffffff;
  letter-spacing: 1px;
}

.card-header p {
  margin: 6px 0 0;
  font-size: 13px;
  color: rgba(226, 235, 255, 0.78);
}

.welcome-text {
  text-align: center;
  margin: 16px 0 14px;
}

.welcome-text h2 {
  margin: 0;
  font-size: 21px;
  color: #ffffff;
}

.welcome-text span {
  margin-top: 5px;
  display: inline-block;
  color: rgba(210, 224, 255, 0.82);
  font-size: 13px;
}

.platform-copy {
  margin: 0 0 12px;
  text-align: center;
}

.platform-copy strong {
  display: block;
  font-size: 13px;
  color: rgba(224, 235, 255, 0.92);
  letter-spacing: 0.5px;
}

.platform-copy p {
  margin: 4px auto 0;
  max-width: 410px;
  font-size: 12px;
  line-height: 1.5;
  color: rgba(198, 216, 255, 0.78);
}

.login-main {
  display: flex;
  align-items: stretch;
  margin-top: 12px;
}

.left-panel,
.right-panel {
  flex: 1;
  min-width: 0;
}

.left-panel {
  padding-right: 16px;
}

.right-panel {
  padding-left: 16px;
  text-align: center;
}

.right-panel h3 {
  margin: 0 0 12px;
  font-size: 18px;
  color: #ffffff;
}

.panel-divider {
  width: 1px;
  background: rgba(178, 201, 255, 0.3);
  border-radius: 2px;
}

.input-wrap {
  display: flex;
  align-items: center;
  border-radius: 10px;
  border: 1px solid rgba(174, 196, 255, 0.34);
  background: rgba(10, 16, 34, 0.56);
  margin-bottom: 12px;
}

.input-wrap:focus-within {
  border-color: rgba(102, 158, 255, 0.9);
  box-shadow: 0 0 0 2px rgba(90, 146, 255, 0.22);
}

.input-icon {
  padding: 0 11px;
}

.input-wrap input {
  flex: 1;
  border: none;
  background: transparent;
  color: #f5f8ff;
  font-size: 14px;
  padding: 11px 0;
  outline: none;
}

.input-wrap input::placeholder {
  color: rgba(202, 218, 255, 0.66);
}

.eye-btn {
  padding: 0 12px;
  cursor: pointer;
}

.remember-wrap {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  color: rgba(220, 234, 255, 0.9);
  font-size: 13px;
}

.remember-wrap input {
  width: 14px;
  height: 14px;
  accent-color: #4f8cff;
  cursor: pointer;
}

.login-btn {
  width: 100%;
  border: none;
  border-radius: 10px;
  min-height: 43px;
  background: linear-gradient(135deg, #2f7efc 0%, #5b43ef 100%);
  color: #ffffff;
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 2px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 10px 24px rgba(51, 110, 246, 0.35);
}

.login-btn.secondary {
  background: linear-gradient(135deg, #0ea97f 0%, #1686d9 100%);
  box-shadow: 0 10px 24px rgba(17, 153, 142, 0.34);
}

.bio-btn {
  margin-top: 10px;
}

.login-btn:disabled {
  opacity: 0.72;
  cursor: not-allowed;
}

.spinner {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.35);
  border-top-color: #fff;
  animation: spin 0.75s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.unsupported-inline {
  margin: 10px 0 0;
  color: #ffd37e;
  font-size: 12px;
}

.status-text {
  margin-top: 10px;
  min-height: 19px;
  color: rgba(211, 227, 255, 0.92);
  font-size: 13px;
}

.status-text.pending {
  color: #93c5ff;
}

.status-text.ok {
  color: #85f0b8;
}

.status-text.error {
  color: #ff9e9e;
}

.form-links {
  margin-top: 12px;
  display: flex;
  justify-content: space-between;
}

.form-links a {
  color: rgba(190, 214, 255, 0.95);
  text-decoration: none;
  font-size: 13px;
}

.qr-wrap {
  position: relative;
  width: 236px;
  margin: 0 auto;
  border-radius: 12px;
  overflow: hidden;
  background: #fff;
  padding: 8px;
  box-shadow: 0 12px 28px rgba(0, 0, 0, 0.33);
}

.qr-canvas {
  width: 220px;
  height: 220px;
  display: block;
}

.qr-scan-line {
  position: absolute;
  left: 8px;
  right: 8px;
  height: 2px;
  background: linear-gradient(90deg, transparent, #3d8df7, transparent);
  animation: scan 2s ease-in-out infinite;
}

@keyframes scan {
  from { top: 8px; }
  to { top: calc(100% - 8px); }
}

.qr-overlay {
  position: absolute;
  inset: 0;
  background: rgba(12, 18, 35, 0.64);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
}

.qr-countdown {
  margin: 10px 0 4px;
  font-size: 13px;
  color: rgba(194, 211, 247, 0.88);
}

.qr-hint {
  margin: 0 0 10px;
  font-size: 13px;
  color: rgba(220, 232, 255, 0.88);
}

.refresh-btn {
  border: 1px solid rgba(180, 203, 255, 0.45);
  border-radius: 8px;
  min-height: 34px;
  padding: 0 14px;
  background: rgba(15, 22, 43, 0.56);
  color: #d9e7ff;
  cursor: pointer;
}

.connection-settings {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid rgba(180, 202, 255, 0.26);
}

.setting-title {
  color: rgba(220, 233, 255, 0.95);
  font-size: 12px;
  font-weight: 700;
}

.setting-row {
  margin-top: 8px;
}

.setting-select,
.setting-input {
  width: 100%;
  border-radius: 8px;
  min-height: 36px;
  border: 1px solid rgba(176, 199, 255, 0.4);
  background: rgba(12, 20, 43, 0.58);
  color: #f0f6ff;
  padding: 8px 10px;
  outline: none;
}

.setting-select:focus,
.setting-input:focus {
  border-color: rgba(113, 168, 255, 0.95);
  box-shadow: 0 0 0 2px rgba(113, 168, 255, 0.24);
}

@media (max-width: 860px) {
  .login-card {
    width: 94vw;
  }

  .login-main {
    flex-direction: column;
    gap: 14px;
  }

  .left-panel,
  .right-panel {
    padding: 0;
  }

  .panel-divider {
    width: 100%;
    height: 1px;
  }
}

@media (max-width: 640px) {
  .login-card {
    padding: 18px 16px 16px;
  }

  .card-header h1 {
    font-size: 22px;
  }

  .qr-wrap {
    width: 208px;
    padding: 6px;
  }

  .qr-canvas {
    width: 196px;
    height: 196px;
  }
}
</style>

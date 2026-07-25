<template>
  <div class="api-example">
    <h2>SaaS API Flow Demo</h2>
    <p class="subtitle">Login &rarr; Get JWT &rarr; Submit Signal &rarr; List Signals</p>

    <!-- Step 1: Login -->
    <section class="step-card">
      <h3>Step 1 &mdash; Authenticate</h3>
      <el-form :model="loginForm" label-width="90px" style="max-width: 400px">
        <el-form-item label="Username">
          <el-input v-model="loginForm.username" placeholder="admin" />
        </el-form-item>
        <el-form-item label="Password">
          <el-input v-model="loginForm.password" type="password" placeholder="******" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :loading="loginLoading" @click="doLogin">
            POST /api/auth/login
          </el-button>
        </el-form-item>
      </el-form>
      <div v-if="token" class="result success">
        <strong>JWT Token:</strong>
        <code>{{ token.slice(0, 40) }}...</code>
      </div>
    </section>

    <!-- Step 2: Submit Signal -->
    <section class="step-card" :class="{ disabled: !token }">
      <h3>Step 2 &mdash; Submit Signal</h3>
      <el-form :model="signalForm" label-width="100px" style="max-width: 400px">
        <el-form-item label="Symbol">
          <el-input v-model="signalForm.symbol" placeholder="600519" />
        </el-form-item>
        <el-form-item label="Signal">
          <el-select v-model="signalForm.signal">
            <el-option label="BUY" value="BUY" />
            <el-option label="SELL" value="SELL" />
            <el-option label="HOLD" value="HOLD" />
          </el-select>
        </el-form-item>
        <el-form-item label="Price">
          <el-input v-model="signalForm.price" placeholder="1800.00" />
        </el-form-item>
        <el-form-item label="Confidence">
          <el-input v-model="signalForm.confidence" placeholder="0.85" />
        </el-form-item>
        <el-form-item>
          <el-button type="success" :loading="signalLoading" :disabled="!token" @click="submitSignal">
            POST /api/external/signal
          </el-button>
        </el-form-item>
      </el-form>
      <div v-if="signalResult" class="result success">
        <strong>Created:</strong>
        <pre>{{ JSON.stringify(signalResult, null, 2) }}</pre>
      </div>
    </section>

    <!-- Step 3: List Signals -->
    <section class="step-card" :class="{ disabled: !token }">
      <h3>Step 3 &mdash; List My Signals</h3>
      <el-button type="warning" :loading="listLoading" :disabled="!token" @click="listSignals">
        GET /api/external/signals
      </el-button>
      <div v-if="signalsList.length" class="result">
        <el-table :data="signalsList" size="small" border stripe style="margin-top: 12px">
          <el-table-column prop="id" label="ID" width="60" />
          <el-table-column prop="symbol" label="Symbol" width="100" />
          <el-table-column prop="signal" label="Signal" width="80" />
          <el-table-column prop="price" label="Price" width="100" />
          <el-table-column prop="confidence" label="Conf." width="80" />
          <el-table-column prop="source" label="Source" width="100" />
          <el-table-column prop="createdAt" label="Created At" />
        </el-table>
      </div>
    </section>

    <!-- Error display -->
    <div v-if="errorMsg" class="result error">
      <strong>Error:</strong> {{ errorMsg }}
    </div>

    <!-- Raw cURL examples -->
    <section class="step-card">
      <h3>cURL Examples (for scripts / external systems)</h3>
      <pre class="curl-block"># 1. Login — get a token
curl -X POST {{ baseUrl }}/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"your_password"}'

# 2. Submit a signal (replace TOKEN)
curl -X POST {{ baseUrl }}/api/external/signal \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TOKEN" \
  -d '{"symbol":"600519","signal":"BUY","price":1800,"confidence":0.92}'

# 3. List your signals
curl {{ baseUrl }}/api/external/signals?page=1&amp;pageSize=10 \
  -H "Authorization: Bearer TOKEN"</pre>
    </section>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { ElMessage } from 'element-plus'
import request from '@/utils/request'
import { useUserStore } from '@/stores/user'

const userStore = useUserStore()
const baseUrl = computed(() => window.location.origin)

// --- Login state ---
const loginForm = ref({ username: '', password: '' })
const loginLoading = ref(false)
const token = ref('')

// --- Signal state ---
const signalForm = ref({ symbol: '600519', signal: 'BUY', price: '', confidence: '' })
const signalLoading = ref(false)
const signalResult = ref(null)

// --- List state ---
const listLoading = ref(false)
const signalsList = ref([])

const errorMsg = ref('')

// -------------------------------------------------------------------
// Step 1: Login using the existing auth endpoint + Pinia store
// -------------------------------------------------------------------
async function doLogin() {
  errorMsg.value = ''
  loginLoading.value = true
  try {
    const res = await request({
      url: '/auth/login',
      method: 'post',
      data: loginForm.value
    })

    if (res.success && res.data?.token) {
      token.value = res.data.token
      // Also persist into Pinia so the axios interceptor picks it up
      userStore.setToken(res.data.token)
      userStore.setUser(res.data.user)
      ElMessage.success('Authenticated — token acquired')
    } else {
      errorMsg.value = res.message || 'Login failed'
    }
  } catch (e) {
    errorMsg.value = e.response?.data?.message || e.message
  } finally {
    loginLoading.value = false
  }
}

// -------------------------------------------------------------------
// Step 2: Submit a signal (token auto-added by axios interceptor)
// -------------------------------------------------------------------
async function submitSignal() {
  errorMsg.value = ''
  signalLoading.value = true
  try {
    const payload = {
      symbol: signalForm.value.symbol,
      signal: signalForm.value.signal
    }
    if (signalForm.value.price) payload.price = Number(signalForm.value.price)
    if (signalForm.value.confidence) payload.confidence = Number(signalForm.value.confidence)

    const res = await request({
      url: '/external/signal',
      method: 'post',
      data: payload
    })

    if (res.success) {
      signalResult.value = res.data
      ElMessage.success('Signal recorded')
    } else {
      errorMsg.value = res.message || 'Signal submission failed'
    }
  } catch (e) {
    errorMsg.value = e.response?.data?.message || e.message
  } finally {
    signalLoading.value = false
  }
}

// -------------------------------------------------------------------
// Step 3: List signals for the authenticated user
// -------------------------------------------------------------------
async function listSignals() {
  errorMsg.value = ''
  listLoading.value = true
  try {
    const res = await request({
      url: '/external/signals',
      method: 'get',
      params: { page: 1, pageSize: 20 }
    })

    if (res.success) {
      signalsList.value = res.data?.list || []
      ElMessage.success(`Loaded ${signalsList.value.length} signals`)
    } else {
      errorMsg.value = res.message || 'Failed to load signals'
    }
  } catch (e) {
    errorMsg.value = e.response?.data?.message || e.message
  } finally {
    listLoading.value = false
  }
}
</script>

<style scoped>
.api-example {
  max-width: 800px;
  margin: 0 auto;
  padding: 24px;
}
.subtitle {
  color: #909399;
  margin-bottom: 24px;
}
.step-card {
  background: #fafafa;
  border: 1px solid #ebeef5;
  border-radius: 8px;
  padding: 20px;
  margin-bottom: 20px;
  transition: opacity 0.2s;
}
.step-card.disabled {
  opacity: 0.5;
  pointer-events: none;
}
.step-card h3 {
  margin: 0 0 16px 0;
  font-size: 16px;
}
.result {
  margin-top: 12px;
  padding: 12px;
  border-radius: 4px;
  font-size: 13px;
  word-break: break-all;
}
.result.success {
  background: #f0f9eb;
  border: 1px solid #e1f3d8;
}
.result.error {
  background: #fef0f0;
  border: 1px solid #fde2e2;
  color: #f56c6c;
}
.result pre {
  margin: 8px 0 0 0;
  white-space: pre-wrap;
  font-size: 12px;
}
.curl-block {
  background: #1e1e1e;
  color: #d4d4d4;
  padding: 16px;
  border-radius: 6px;
  font-size: 13px;
  line-height: 1.6;
  overflow-x: auto;
  white-space: pre-wrap;
}
</style>

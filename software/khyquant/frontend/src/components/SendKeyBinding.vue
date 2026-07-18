<template>
  <div class="sendkey-binding">
    <h2>WeChat Notification Binding</h2>
    <p class="subtitle">
      Bind your ServerChan SendKey to receive trading signals on WeChat.
      <a href="https://sct.ftqq.com" target="_blank" rel="noopener">Get a SendKey</a>
    </p>

    <!-- Status -->
    <div class="status-row">
      <span class="status-label">Status:</span>
      <el-tag v-if="isBound" type="success" size="small">Bound</el-tag>
      <el-tag v-else type="info" size="small">Not bound</el-tag>
    </div>

    <!-- Input -->
    <el-form label-width="100px" style="max-width: 520px; margin-top: 16px">
      <el-form-item label="SendKey">
        <el-input
          v-model="sendKeyInput"
          placeholder="SCT..."
          clearable
          show-password
        />
      </el-form-item>
      <el-form-item>
        <el-button type="primary" :loading="saving" @click="save">
          Save
        </el-button>
        <el-button v-if="isBound" type="danger" plain :loading="saving" @click="unbind">
          Unbind
        </el-button>
      </el-form-item>
    </el-form>

    <!-- Help -->
    <el-collapse style="margin-top: 24px">
      <el-collapse-item title="How it works" name="help">
        <ol>
          <li>Register at <a href="https://sct.ftqq.com" target="_blank">sct.ftqq.com</a> and get your SendKey.</li>
          <li>Paste the SendKey above and click Save.</li>
          <li>When a trading signal is created (via API or UI), a push notification is sent to your WeChat automatically.</li>
          <li>The push is non-blocking &mdash; it does not slow down signal processing.</li>
        </ol>
      </el-collapse-item>
    </el-collapse>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import request from '@/utils/request'

const sendKeyInput = ref('')
const isBound = ref(false)
const saving = ref(false)

async function fetchStatus() {
  try {
    const res = await request({ url: '/users/sendkey-status', method: 'get' })
    isBound.value = res.success && res.data?.bound
  } catch {
    isBound.value = false
  }
}

async function save() {
  if (!sendKeyInput.value.trim()) {
    ElMessage.warning('Please enter a SendKey')
    return
  }
  saving.value = true
  try {
    const res = await request({
      url: '/users/sendkey',
      method: 'put',
      data: { sendKey: sendKeyInput.value.trim() }
    })
    if (res.success) {
      isBound.value = true
      sendKeyInput.value = ''
      ElMessage.success('SendKey saved')
    } else {
      ElMessage.error(res.message || 'Save failed')
    }
  } catch (e) {
    ElMessage.error(e.response?.data?.message || e.message)
  } finally {
    saving.value = false
  }
}

async function unbind() {
  saving.value = true
  try {
    const res = await request({
      url: '/users/sendkey',
      method: 'put',
      data: { sendKey: '' }
    })
    if (res.success) {
      isBound.value = false
      sendKeyInput.value = ''
      ElMessage.success('SendKey unbound')
    } else {
      ElMessage.error(res.message || 'Unbind failed')
    }
  } catch (e) {
    ElMessage.error(e.response?.data?.message || e.message)
  } finally {
    saving.value = false
  }
}

onMounted(() => {
  fetchStatus()
})
</script>

<style scoped>
.sendkey-binding {
  max-width: 600px;
  margin: 0 auto;
  padding: 24px;
}
.subtitle {
  color: #909399;
  margin-bottom: 16px;
}
.subtitle a {
  color: #409eff;
}
.status-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.status-label {
  color: #606266;
  font-weight: 500;
}
</style>

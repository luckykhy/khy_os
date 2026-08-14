<template>
  <div class="settings">
    <el-card>
      <template #header>
        <span>系统设置</span>
      </template>

      <el-tabs v-model="activeTab">
        <el-tab-pane label="基本设置" name="basic">
          <el-form :model="basicSettings" label-width="120px">
            <el-form-item label="系统名称">
              <el-input v-model="basicSettings.systemName" />
            </el-form-item>
            <el-form-item label="系统描述">
              <el-input v-model="basicSettings.systemDesc" type="textarea" :rows="3" />
            </el-form-item>
            <el-form-item label="时区">
              <el-select v-model="basicSettings.timezone">
                <el-option label="Asia/Shanghai" value="Asia/Shanghai" />
                <el-option label="UTC" value="UTC" />
              </el-select>
            </el-form-item>
            <el-form-item>
              <el-button type="primary" @click="saveBasicSettings">保存</el-button>
            </el-form-item>
          </el-form>
        </el-tab-pane>

        <el-tab-pane label="API 配置" name="api">
          <el-form :model="apiSettings" label-width="120px">
            <el-form-item label="API 地址">
              <el-input v-model="apiSettings.apiUrl" />
            </el-form-item>
            <el-form-item label="API 超时(ms)">
              <el-input-number v-model="apiSettings.timeout" :min="1000" :max="60000" />
            </el-form-item>
            <el-form-item label="重试次数">
              <el-input-number v-model="apiSettings.retries" :min="0" :max="10" />
            </el-form-item>
            <el-form-item>
              <el-button type="primary" @click="saveApiSettings">保存</el-button>
            </el-form-item>
          </el-form>
        </el-tab-pane>

        <el-tab-pane label="安全设置" name="security">
          <el-form :model="securitySettings" label-width="120px">
            <el-form-item label="启用双因素">
              <el-switch v-model="securitySettings.twoFactor" />
            </el-form-item>
            <el-form-item label="会话超时(分)">
              <el-input-number v-model="securitySettings.sessionTimeout" :min="5" :max="1440" />
            </el-form-item>
            <el-form-item label="密码策略">
              <el-select v-model="securitySettings.passwordPolicy">
                <el-option label="简单" value="simple" />
                <el-option label="中等" value="medium" />
                <el-option label="强" value="strong" />
              </el-select>
            </el-form-item>
            <el-form-item>
              <el-button type="primary" @click="saveSecuritySettings">保存</el-button>
            </el-form-item>
          </el-form>
        </el-tab-pane>
      </el-tabs>
    </el-card>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { authedFetch } from '@/utils/authedFetch';
import { ElMessage } from 'element-plus';

const activeTab = ref('basic');

const basicSettings = ref({
  systemName: 'KHY AI Platform',
  systemDesc: 'AI 平台操作系统',
  timezone: 'Asia/Shanghai'
});

const apiSettings = ref({
  apiUrl: 'http://localhost:5000',
  timeout: 30000,
  retries: 3
});

const securitySettings = ref({
  twoFactor: false,
  sessionTimeout: 60,
  passwordPolicy: 'medium'
});

async function loadSettings() {
  try {
    const data = await authedFetch('/api/settings');
    if (data.settings) {
      basicSettings.value = { ...basicSettings.value, ...data.settings.basic };
      apiSettings.value = { ...apiSettings.value, ...data.settings.api };
      securitySettings.value = { ...securitySettings.value, ...data.settings.security };
    }
  } catch (error) {
    console.error('Failed to load settings:', error);
  }
}

async function saveBasicSettings() {
  try {
    await authedFetch('/api/settings/basic', {
      method: 'PUT',
      body: JSON.stringify(basicSettings.value)
    });
    ElMessage.success('基本设置已保存');
  } catch (error) {
    ElMessage.error('保存失败');
  }
}

async function saveApiSettings() {
  try {
    await authedFetch('/api/settings/api', {
      method: 'PUT',
      body: JSON.stringify(apiSettings.value)
    });
    ElMessage.success('API 配置已保存');
  } catch (error) {
    ElMessage.error('保存失败');
  }
}

async function saveSecuritySettings() {
  try {
    await authedFetch('/api/settings/security', {
      method: 'PUT',
      body: JSON.stringify(securitySettings.value)
    });
    ElMessage.success('安全设置已保存');
  } catch (error) {
    ElMessage.error('保存失败');
  }
}

onMounted(() => {
  loadSettings();
});
</script>

<style scoped>
.settings {
  width: 100%;
}
</style>

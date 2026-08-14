<template>
  <div class="login-container">
    <el-card class="login-card">
      <template #header>
        <div class="card-header">
          <h2>KHY AI 管理平台</h2>
        </div>
      </template>

      <el-form ref="formRef" :model="form" :rules="rules" label-width="80px" @submit.prevent="handleLogin">
        <el-form-item label="用户名" prop="username">
          <el-input v-model="form.username" placeholder="请输入用户名" clearable>
            <template #append>
              <el-button @click="fillDefaultUsername">使用默认管理员</el-button>
            </template>
          </el-input>
        </el-form-item>

        <el-form-item label="密码" prop="password">
          <el-input
            v-model="form.password"
            type="password"
            placeholder="请输入密码"
            show-password
            @keyup.enter="handleLogin"
          />
        </el-form-item>

        <el-form-item>
          <el-button type="primary" :loading="loading" style="width: 100%" @click="handleLogin">
            登录
          </el-button>
        </el-form-item>
      </el-form>

      <el-alert
        type="info"
        :closable="false"
        show-icon
        style="margin-top: 16px"
      >
        <template #title>
          <div style="font-size: 12px;">
            默认管理员密码位于：<code>.khy/credentials/default-admin.json</code>
          </div>
        </template>
      </el-alert>
    </el-card>
  </div>
</template>

<script setup>
import { ref, reactive } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { ElMessage } from 'element-plus';

const router = useRouter();
const route = useRoute();
const authStore = useAuthStore();

const formRef = ref(null);
const loading = ref(false);

const form = reactive({
  username: '',
  password: ''
});

const rules = {
  username: [{ required: true, message: '请输入用户名', trigger: 'blur' }],
  password: [{ required: true, message: '请输入密码', trigger: 'blur' }]
};

async function fillDefaultUsername() {
  try {
    const username = await authStore.getDefaultUsername();
    if (username) {
      form.username = username;
      ElMessage.success(`已填入默认用户名: ${username}`);
    }
  } catch (error) {
    ElMessage.error('获取默认用户名失败');
  }
}

async function handleLogin() {
  if (!formRef.value) return;

  await formRef.value.validate(async (valid) => {
    if (!valid) return;

    loading.value = true;
    try {
      await authStore.login(form.username, form.password);
      ElMessage.success('登录成功');

      const redirect = route.query.redirect || '/dashboard';
      router.push(redirect);
    } catch (error) {
      ElMessage.error(error.message || '登录失败');
    } finally {
      loading.value = false;
    }
  });
}
</script>

<style scoped>
.login-container {
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 100vh;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
}

.login-card {
  width: 450px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
}

.card-header {
  text-align: center;
}

.card-header h2 {
  margin: 0;
  color: #333;
  font-size: 24px;
  font-weight: 600;
}

code {
  background: #f4f4f5;
  padding: 2px 6px;
  border-radius: 3px;
  font-size: 11px;
  color: #606266;
}
</style>

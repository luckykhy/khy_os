<template>
  <div class="debug-page">
    <el-card>
      <template #header>
        <span>调试页面</span>
      </template>
      
      <el-space direction="vertical" style="width: 100%">
        <el-button @click="testLogin" type="primary">测试登录</el-button>
        <el-button @click="testGetUserInfo" type="success">测试获取用户信息</el-button>
        <el-button @click="checkStore" type="info">检查Store状态</el-button>
        <el-button @click="testWasmBridge" type="warning">测试WASM桥接</el-button>
        <el-button @click="clearAll" type="danger">清除所有数据</el-button>
      </el-space>
      
      <el-divider>调试信息</el-divider>
      
      <pre>{{ debugInfo }}</pre>
    </el-card>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useUserStore } from '@/stores/user'
import { ElMessage } from 'element-plus'
import { loadWasmBridge } from '@/services/wasm/wasmBridge'

const userStore = useUserStore()
const debugInfo = ref('等待调试...')

const testLogin = async () => {
  try {
    debugInfo.value = '正在测试登录...'
    
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // 登记:'admin123' 为调试用登录测试的示范默认口令,非真实凭据。pragma: allowlist secret
      body: JSON.stringify({ username: 'admin', password: 'admin123' }) // pragma: allowlist secret
    })
    
    const data = await response.json()
    debugInfo.value = `登录测试结果:\n${JSON.stringify(data, null, 2)}`
    
    if (data.success) {
      ElMessage.success('登录测试成功')
    } else {
      ElMessage.error('登录测试失败')
    }
  } catch (error) {
    debugInfo.value = `登录测试错误:\n${error.message}`
    ElMessage.error('登录测试错误')
  }
}

const testGetUserInfo = async () => {
  try {
    debugInfo.value = '正在测试获取用户信息...'
    
    const token = localStorage.getItem('token')
    if (!token) {
      debugInfo.value = '错误: 没有找到token，请先登录'
      ElMessage.error('没有token，请先登录')
      return
    }
    
    const response = await fetch('/api/auth/me', {
      headers: { 'Authorization': `Bearer ${token}` }
    })
    
    const data = await response.json()
    debugInfo.value = `获取用户信息结果:\n${JSON.stringify(data, null, 2)}`
    
    if (data.success) {
      ElMessage.success('获取用户信息成功')
    } else {
      ElMessage.error('获取用户信息失败')
    }
  } catch (error) {
    debugInfo.value = `获取用户信息错误:\n${error.message}`
    ElMessage.error('获取用户信息错误')
  }
}

const checkStore = () => {
  const storeState = {
    user: userStore.user,
    token: userStore.token ? userStore.token.substring(0, 50) + '...' : null,
    isAuthenticated: userStore.isAuthenticated(),
    localStorage_token: localStorage.getItem('token') ? localStorage.getItem('token').substring(0, 50) + '...' : null
  }
  
  debugInfo.value = `Store状态:\n${JSON.stringify(storeState, null, 2)}`
}

const testWasmBridge = async () => {
  try {
    debugInfo.value = '正在测试 WASM 桥接...'
    const bridge = await loadWasmBridge('/wasm/khy-math-demo.wasm')
    const exportsList = bridge.listFunctions()
    const a = 7
    const b = 12
    const result = bridge.callFunction('add', [a, b])

    debugInfo.value = `WASM桥接结果:\n${JSON.stringify({
      module: '/wasm/khy-math-demo.wasm',
      exports: exportsList,
      call: `add(${a}, ${b})`,
      result
    }, null, 2)}`

    ElMessage.success('WASM桥接成功')
  } catch (error) {
    debugInfo.value = `WASM桥接错误:\n${error.message}`
    ElMessage.error('WASM桥接失败')
  }
}

const clearAll = () => {
  userStore.logout()
  localStorage.clear()
  debugInfo.value = '所有数据已清除'
  ElMessage.success('所有数据已清除')
}
</script>

<style scoped>
.debug-page {
  padding: 20px;
}

pre {
  background: #f5f5f5;
  padding: 15px;
  border-radius: 4px;
  font-size: 12px;
  max-height: 400px;
  overflow-y: auto;
}
</style>

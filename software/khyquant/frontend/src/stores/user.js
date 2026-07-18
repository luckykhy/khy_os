import { defineStore } from 'pinia'
import { ref } from 'vue'
import { login, register, getCurrentUser, logout as logoutAPI } from '@/api/auth'
import {
  loginLocalUser,
  registerLocalUser,
  getCurrentLocalUser,
  logoutLocalUser,
  isLocalToken,
  shouldFallbackLocalAuth
} from '@/services/localAuthService'
import {
  getConnectionMode,
  setConnectionMode,
  getBackendUrl,
  setBackendUrl
} from '@/utils/connectionMode'

export const useUserStore = defineStore('user', () => {
  const normalizeToken = (rawToken) => {
    if (!rawToken) return ''

    let tokenValue = rawToken
    if (typeof tokenValue === 'object') {
      tokenValue = tokenValue.token || tokenValue.value || tokenValue.data?.token || ''
    }

    if (typeof tokenValue !== 'string') {
      return ''
    }

    return tokenValue.replace(/^Bearer\s+/i, '').trim()
  }

  const user = ref(null)
  const token = ref(normalizeToken(localStorage.getItem('token') || ''))
  const connectionMode = ref(getConnectionMode())
  const backendUrl = ref(getBackendUrl())
  const logoutInProgress = ref(false)

  const isAuthenticated = () => {
    return !!token.value
  }

  const setUser = (userData) => {
    user.value = userData
  }

  const setToken = (newToken) => {
    const normalized = normalizeToken(newToken)
    token.value = normalized
    if (normalized) {
      localStorage.setItem('token', normalized)
    } else {
      localStorage.removeItem('token')
    }
  }

  const updateConnectionMode = (mode) => {
    connectionMode.value = mode
    setConnectionMode(mode)
    // Local standalone mode should not carry cloud JWT sessions.
    if (mode === 'local' && token.value && !isLocalToken(token.value)) {
      setUser(null)
      setToken('')
    }
    // Cloud/auto mode should not carry local-only pseudo tokens.
    if (mode !== 'local' && token.value && isLocalToken(token.value)) {
      setUser(null)
      setToken('')
    }
  }

  const updateBackendUrl = (url) => {
    backendUrl.value = (url || '').trim()
    setBackendUrl(backendUrl.value)
  }

  const loginUser = async (credentials) => {
    const tryRemoteLogin = async () => {
      const response = await login(credentials)
      if (import.meta.env.DEV) console.log('登录响应:', response)

      // 响应拦截器已经返回了response.data，所以直接访问response
      if (response.success && response.data) {
        setToken(response.data.token)
        setUser(response.data.user)
        return response
      }
      throw new Error(response.message || '登录失败')
    }

    const allowLocalFallback = (error) => {
      if (connectionMode.value === 'local') {
        // Local mode should fallback only when backend is unavailable,
        // not when backend explicitly rejected credentials.
        return !error?.response
      }
      return shouldFallbackLocalAuth(error)
    }

    try {
      return await tryRemoteLogin()
    } catch (error) {
      if (allowLocalFallback(error)) {
        const localResponse = loginLocalUser(credentials)
        setToken(localResponse.data.token)
        setUser(localResponse.data.user)
        return localResponse
      }
      console.error('登录错误:', error)
      throw error
    }
  }

  const registerUser = async (userData) => {
    const tryRemoteRegister = async () => {
      const response = await register(userData)
      if (import.meta.env.DEV) console.log('注册响应:', response)

      // 响应拦截器已经返回了response.data，所以直接访问response
      if (response.success && response.data) {
        setToken(response.data.token)
        setUser(response.data.user)
        return response
      }
      throw new Error(response.message || '注册失败')
    }

    const allowLocalFallback = (error) => {
      if (connectionMode.value === 'local') {
        return !error?.response
      }
      return shouldFallbackLocalAuth(error)
    }

    try {
      return await tryRemoteRegister()
    } catch (error) {
      if (allowLocalFallback(error)) {
        const localResponse = registerLocalUser(userData)
        setToken(localResponse.data.token)
        setUser(localResponse.data.user)
        return localResponse
      }
      console.error('注册错误:', error)
      throw error
    }
  }

  const logout = async (options = {}) => {
    const { skipRemote = false } = options
    const currentToken = token.value

    if (logoutInProgress.value) {
      setUser(null)
      setToken('')
      return
    }

    logoutInProgress.value = true
    try {
      // 如果有token，调用后端退出登录API记录日志
      if (currentToken) {
        if (isLocalToken(currentToken)) {
          logoutLocalUser()
        } else if (!skipRemote && connectionMode.value !== 'local') {
          await logoutAPI({
            silentLoading: true,
            __skipAuthErrorHandling: true
          }).catch(error => {
            console.warn('退出登录API调用失败:', error)
          })
        }
      }
    } catch (error) {
      console.warn('退出登录时记录日志失败:', error)
    } finally {
      // 无论API调用是否成功，都清除本地状态
      setUser(null)
      setToken('')
      logoutInProgress.value = false
    }
  }

  const fetchUserInfo = async () => {
    try {
      if (import.meta.env.DEV) {
        console.log('开始获取用户信息...')
        console.log('当前token:', token.value ? '[REDACTED]' : '无token')
      }

      let response
      if (isLocalToken(token.value)) {
        if (connectionMode.value !== 'local') {
          throw new Error('检测到本地模式凭证，请重新登录云端账号')
        }
        response = getCurrentLocalUser(token.value)
      } else if (connectionMode.value === 'local') {
        response = await getCurrentUser({ silentLoading: true })
      } else {
        response = await getCurrentUser({ silentLoading: true })
      }
      if (import.meta.env.DEV) console.log('获取用户信息响应:', response)

      // 响应拦截器已经返回了response.data，所以直接访问response
      if (response.success && response.data) {
        setUser(response.data)
        if (import.meta.env.DEV) console.log('用户信息设置成功:', response.data)
      } else {
        console.error('响应格式错误:', response)
        throw new Error(response.message || '获取用户信息失败')
      }
      return response
    } catch (error) {
      console.error('获取用户信息失败:', error)
      await logout({ skipRemote: true })
      throw error
    }
  }

  return {
    user,
    token,
    connectionMode,
    backendUrl,
    isAuthenticated,
    setUser,
    setToken,
    updateConnectionMode,
    updateBackendUrl,
    loginUser,
    registerUser,
    logout,
    fetchUserInfo
  }
})

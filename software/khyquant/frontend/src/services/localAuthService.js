import { shouldUseLocalAuthFallback } from '@/utils/connectionMode'

const LOCAL_USERS_KEY = 'khy_local_users'

function safeBase64Encode(str) {
  return btoa(unescape(encodeURIComponent(str)))
}

function safeBase64Decode(str) {
  try {
    return decodeURIComponent(escape(atob(str)))
  } catch (error) {
    return ''
  }
}

function nowISO() {
  return new Date().toISOString()
}

function normalizeUsers() {
  const raw = localStorage.getItem(LOCAL_USERS_KEY)
  if (!raw) return []
  try {
    const data = JSON.parse(raw)
    return Array.isArray(data) ? data : []
  } catch (error) {
    return []
  }
}

function saveUsers(users) {
  localStorage.setItem(LOCAL_USERS_KEY, JSON.stringify(users))
}

function hashPassword(password) {
  // Lightweight local hash for demo/offline mode only
  return safeBase64Encode(`khy-local:${password}`)
}

function buildLocalToken(user) {
  const payload = {
    type: 'local',
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role || 'user',
    iat: Date.now()
  }
  return `local-token.${safeBase64Encode(JSON.stringify(payload))}`
}

function parseLocalToken(token) {
  if (!isLocalToken(token)) return null
  const encoded = token.slice('local-token.'.length)
  const decoded = safeBase64Decode(encoded)
  if (!decoded) return null
  try {
    return JSON.parse(decoded)
  } catch (error) {
    return null
  }
}

function sanitizeUser(user) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role || 'user',
    source: 'local'
  }
}

export function isLocalToken(token) {
  return typeof token === 'string' && token.startsWith('local-token.')
}

export function shouldFallbackLocalAuth(error) {
  return shouldUseLocalAuthFallback(error)
}

export function registerLocalUser({ username, email, password }) {
  const users = normalizeUsers()
  const normalizedUsername = (username || '').trim()
  const normalizedEmail = (email || '').trim().toLowerCase()

  const exists = users.some((u) => u.username === normalizedUsername || u.email === normalizedEmail)
  if (exists) {
    const err = new Error('用户名或邮箱已被注册（本地）')
    err.code = 'LOCAL_USER_EXISTS'
    throw err
  }

  const user = {
    id: `local-${Date.now()}`,
    username: normalizedUsername,
    email: normalizedEmail,
    passwordHash: hashPassword(password || ''),
    role: 'user',
    createdAt: nowISO(),
    updatedAt: nowISO()
  }

  users.unshift(user)
  saveUsers(users)

  const sanitized = sanitizeUser(user)
  return {
    success: true,
    message: '本地注册成功',
    data: {
      token: buildLocalToken(sanitized),
      user: sanitized,
      mode: 'local'
    }
  }
}

export function loginLocalUser({ username, password }) {
  const users = normalizeUsers()
  const account = (username || '').trim()
  const passwordHash = hashPassword(password || '')

  const user = users.find((u) => (u.username === account || u.email === account.toLowerCase()) && u.passwordHash === passwordHash)
  if (!user) {
    const err = new Error('本地账号或密码错误')
    err.code = 'LOCAL_LOGIN_FAILED'
    throw err
  }

  user.updatedAt = nowISO()
  saveUsers(users)

  const sanitized = sanitizeUser(user)
  return {
    success: true,
    message: '本地登录成功',
    data: {
      token: buildLocalToken(sanitized),
      user: sanitized,
      mode: 'local'
    }
  }
}

export function getCurrentLocalUser(token) {
  const payload = parseLocalToken(token)
  if (!payload) {
    const err = new Error('本地登录凭证无效')
    err.code = 'LOCAL_TOKEN_INVALID'
    throw err
  }

  const users = normalizeUsers()
  const found = users.find((u) => u.id === payload.id)
  if (!found) {
    const err = new Error('本地用户不存在')
    err.code = 'LOCAL_USER_NOT_FOUND'
    throw err
  }

  return {
    success: true,
    data: sanitizeUser(found)
  }
}

export function logoutLocalUser() {
  return {
    success: true,
    message: '本地模式已退出'
  }
}

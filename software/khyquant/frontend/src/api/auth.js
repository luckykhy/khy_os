import request from './request'

export const login = (credentials) => {
  return request({
    url: '/auth/login',
    method: 'post',
    data: credentials
  })
}

export const register = (userData) => {
  return request({
    url: '/auth/register',
    method: 'post',
    data: userData
  })
}

export const getCurrentUser = (config = {}) => {
  return request({
    url: '/auth/me',
    method: 'get',
    ...config
  })
}

export const logout = (config = {}) => {
  return request({
    url: '/auth/logout',
    method: 'post',
    ...config
  })
}

export const changePassword = (passwordData) => {
  return request({
    url: '/auth/change-password',
    method: 'post',
    data: passwordData
  })
}

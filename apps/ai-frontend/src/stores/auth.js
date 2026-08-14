import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { authedFetch } from '@/utils/authedFetch';

export const useAuthStore = defineStore('auth', () => {
  const token = ref(localStorage.getItem('token') || '');
  const user = ref(null);

  const isAuthenticated = computed(() => !!token.value);

  async function login(username, password) {
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ username, password })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || '登录失败');
      }

      const data = await response.json();
      token.value = data.token;
      user.value = data.user;
      localStorage.setItem('token', data.token);

      return true;
    } catch (error) {
      console.error('Login error:', error);
      throw error;
    }
  }

  async function logout() {
    token.value = '';
    user.value = null;
    localStorage.removeItem('token');
  }

  async function checkAuth() {
    if (!token.value) return false;

    try {
      const data = await authedFetch('/api/auth/me');
      user.value = data.user;
      return true;
    } catch (error) {
      console.error('Auth check failed:', error);
      logout();
      return false;
    }
  }

  async function getDefaultUsername() {
    try {
      const response = await fetch('/api/auth/default-username');
      const data = await response.json();
      return data.username || '';
    } catch (error) {
      console.error('Failed to get default username:', error);
      return '';
    }
  }

  return {
    token,
    user,
    isAuthenticated,
    login,
    logout,
    checkAuth,
    getDefaultUsername
  };
});

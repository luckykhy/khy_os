import { defineStore } from 'pinia';
import { hasAuthToken, parseStoredJson } from '@khy/ui-shared/auth/state';
import request from '@/api/request';
import { TOKEN_KEY } from '@/utils/safeStorage';
import { normalizeRole, isAdmin, roleLabel } from '@/auth/permissions';

const USER_STORAGE_KEY = 'khy_ai_user';

// Admins land on the console, everyone else on the user home. There is no
// per-session "view" switch: which menu you see follows the route you are on,
// and the admin routes are guarded separately.
const ADMIN_HOME = '/admin/overview';
const USER_HOME = '/home';

export const useUserStore = defineStore('user', {
  state: () => ({
    token: localStorage.getItem(TOKEN_KEY) || '',
    user: parseStoredJson(localStorage.getItem(USER_STORAGE_KEY), null),
  }),
  getters: {
    role: (state) => normalizeRole(state.user),
    isAdmin: (state) => isAdmin(state.user),
    roleLabel: (state) => roleLabel(state.user),
    preferredHome() {
      return this.isAdmin ? ADMIN_HOME : USER_HOME;
    },
  },
  actions: {
    async login(username, password) {
      const { data } = await request.post('/api/auth/login', { username, password });
      const payload = data && typeof data.data === 'object' && data.data ? data.data : data;
      const token = String(payload?.token || '').trim();
      if (!token) throw new Error('登录响应缺少令牌');

      this.token = token;
      this.user = payload?.user || null;

      localStorage.setItem(TOKEN_KEY, token);
      localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(this.user || null));
      return payload;
    },
    async fetchProfile() {
      const { data } = await request.get('/api/auth/me');
      const payload = data && typeof data.data === 'object' && data.data ? data.data : data;
      this.user = payload?.user || null;
      localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(this.user || null));
      return this.user;
    },
    async ensureSession() {
      if (!this.token) return false;
      if (this.user) return true;
      try {
        await this.fetchProfile();
        return true;
      } catch {
        this.logout();
        return false;
      }
    },
    logout() {
      this.token = '';
      this.user = null;
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_STORAGE_KEY);
    },
    isAuthenticated() {
      return hasAuthToken(this.token);
    },
  },
});

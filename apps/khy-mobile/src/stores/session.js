import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { apiJson, login as loginRequest } from '@/api/client';
import { clearSession, getSession, setSession } from '@/api/secureSession';
import { operationStatus } from '@/api/status';

export const useSessionStore = defineStore('mobile-session', () => {
  const session = ref(null);
  const user = ref(null);
  const status = ref(operationStatus('读取', '登录会话', '等待开始'));
  const error = ref('');
  const authenticated = computed(() => Boolean(session.value?.accessToken));

  async function restore({ verify = true } = {}) {
    error.value = '';
    status.value = operationStatus('读取', '登录会话', '进行中');
    session.value = await getSession();
    user.value = session.value?.user || null;
    if (!session.value?.accessToken) {
      status.value = operationStatus('读取', '登录会话', '未登录');
      return null;
    }
    if (verify) await verifyCurrentUser();
    else status.value = operationStatus('读取', '登录会话', '已恢复', 'success');
    return session.value;
  }

  async function signIn(username, password) {
    error.value = '';
    status.value = operationStatus('登录', username, '验证中');
    try {
      session.value = await loginRequest(username, password);
      user.value = session.value.user;
      await verifyCurrentUser();
      status.value = operationStatus('登录', username, '已完成', 'success');
      return session.value;
    } catch (cause) {
      error.value = cause.message || '登录失败';
      status.value = operationStatus('登录', username, '失败', 'error');
      throw cause;
    }
  }

  async function verifyCurrentUser() {
    status.value = operationStatus('校验', '当前登录会话', '进行中');
    try {
      const data = await apiJson('/api/auth/me');
      user.value = data.user || data;
      session.value = { ...(await getSession()), user: user.value };
      await setSession(session.value);
      status.value = operationStatus('校验', '当前登录会话', '有效', 'success');
      return user.value;
    } catch (cause) {
      session.value = await getSession();
      if (!session.value) user.value = null;
      error.value = cause.message || '会话校验失败';
      status.value = operationStatus('校验', '当前登录会话', '失败', 'error');
      throw cause;
    }
  }

  async function signOut() {
    await clearSession();
    session.value = null;
    user.value = null;
    error.value = '';
    status.value = operationStatus('退出', '登录会话', '已完成');
  }

  function markExpired() {
    session.value = null;
    user.value = null;
    status.value = operationStatus('续期', '登录会话', '已失效', 'error');
  }

  return { session, user, status, error, authenticated, restore, signIn, verifyCurrentUser, signOut, markExpired };
});

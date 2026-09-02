import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import router from './router';
import { setSessionExpiredHandler } from './api/client';
import { useSessionStore } from './stores/session';
import { useErrorNotifyStore } from './stores/errorNotify';
import { classifyKhyError } from './utils/classifyKhyError.mjs';
import './styles.css';

const pinia = createPinia();
const app = createApp(App).use(pinia).use(router);
const session = useSessionStore(pinia);
const errorNotify = useErrorNotifyStore(pinia);

// 暴露给 api/*.js 内部调用：thrown 错误 → 通知层。
// 之前 console.error 静默丢失，现在任何 api/*.js throw 的错误都会被显示出来。
// 混乱点 #2 的根因 —— 这里补全全局 catch。
app.config.errorHandler = (err, _instance, info) => {
  errorNotify.notify(classifyKhyError(err, { fallbackCode: 'INTERNAL' }), {
    action: 'Vue 错误',
    target: info,
  });
};

window.addEventListener('unhandledrejection', (event) => {
  errorNotify.notify(classifyKhyError(event.reason, { fallbackCode: 'UNHANDLED' }), {
    action: '未捕获 Promise',
    target: '异步任务',
  });
});

setSessionExpiredHandler(async () => {
  session.markExpired();
  if (router.currentRoute.value.path !== '/login') {
    await router.replace({ path: '/login', query: { next: router.currentRoute.value.fullPath } });
  }
});

app.mount('#app');

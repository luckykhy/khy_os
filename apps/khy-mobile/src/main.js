import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import router from './router';
import { setSessionExpiredHandler } from './api/client';
import { useSessionStore } from './stores/session';
import './styles.css';

const pinia = createPinia();
const app = createApp(App).use(pinia).use(router);
const session = useSessionStore(pinia);

setSessionExpiredHandler(async () => {
  session.markExpired();
  if (router.currentRoute.value.path !== '/login') {
    await router.replace({ path: '/login', query: { next: router.currentRoute.value.fullPath } });
  }
});

app.mount('#app');

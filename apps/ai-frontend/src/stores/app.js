import { defineStore } from 'pinia';
import { ref } from 'vue';

export const useAppStore = defineStore('app', () => {
  const sidebarCollapsed = ref(false);
  const theme = ref('light');

  function toggleSidebar() {
    sidebarCollapsed.value = !sidebarCollapsed.value;
  }

  function setTheme(newTheme) {
    theme.value = newTheme;
    localStorage.setItem('theme', newTheme);
  }

  return {
    sidebarCollapsed,
    theme,
    toggleSidebar,
    setTheme
  };
});

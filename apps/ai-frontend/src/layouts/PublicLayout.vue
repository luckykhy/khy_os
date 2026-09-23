<template>
  <div class="public-shell">
    <div v-if="branded" class="public-brand">
      <span class="public-logo">K</span>
      <span class="public-name">KHY AI</span>
    </div>
    <div class="public-body">
      <slot />
    </div>
  </div>
</template>

<script setup>
// PublicLayout — the shared container for every page rendered outside
// Layout.vue: /login, /forgot-password and the status pages (/401 /403 /404 /500).
//
// It deliberately does NOT emit <html>/<head>/<body>: index.html owns the
// document shell, and a <title> rendered into #app would never reach the
// browser tab. Document titles are set once, by router.afterEach.
defineOptions({ name: 'PublicLayout' });

defineProps({
  // Status pages carry the compact brand bar. /login and /forgot-password each
  // render their own larger brand inside the card, so both pass
  // :branded="false" to avoid a doubled logo.
  branded: {
    type: Boolean,
    default: true,
  },
});
</script>

<style scoped>
.public-shell {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 24px;
  padding: 32px 20px;
}

.public-brand {
  display: flex;
  align-items: center;
  gap: 10px;
}

.public-logo {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 10px;
  background: var(--khy-bg-card-grad);
  color: var(--khy-white);
  font-weight: 700;
  font-size: 18px;
}

.public-name {
  font-size: 16px;
  font-weight: 700;
  color: var(--khy-text-strong);
}

.public-body {
  width: 100%;
  display: flex;
  justify-content: center;
}
</style>

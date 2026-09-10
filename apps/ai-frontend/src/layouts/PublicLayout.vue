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
// PublicLayout — the shared container for pages rendered outside Layout.vue:
// /forgot-password and the status pages (/401 /403 /404 /500).
//
// /login deliberately keeps its own .login-shell instead of being wrapped here:
// its ambient brand orbs are position:absolute children that need the shell's
// `position: relative` + `overflow: hidden` to stay clipped to the card area.
// Consolidating that last public page onto this layout is Phase 4 (visual
// consolidation) work, paired with the Phase 3.3 login rewrite that deletes the
// orbs.
//
// It deliberately does NOT emit <html>/<head>/<body>: index.html owns the
// document shell, and a <title> rendered into #app would never reach the
// browser tab. Document titles are set once, by router.afterEach.
defineOptions({ name: 'PublicLayout' });

defineProps({
  // Status pages carry the compact brand bar. /forgot-password renders its own
  // larger brand inside the card, so it passes :branded="false" to avoid a
  // doubled logo.
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

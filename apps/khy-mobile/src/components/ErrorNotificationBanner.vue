<template>
  <div class="error-banner-stack" aria-live="polite">
    <transition-group name="error-banner" tag="div">
      <div
        v-for="b in banners"
        :key="b.id"
        class="error-banner"
        :class="`tone-${b.severity} cat-${b.category}`"
        role="status"
      >
        <div class="error-banner__head">
          <span class="error-banner__title">{{ b.title }}</span>
          <span class="error-banner__code">[{{ b.code }}]</span>
          <button
            v-if="b.severity === 'error' || b.severity === 'fatal'"
            class="error-banner__close"
            aria-label="关闭"
            @click="notify.dismiss(b.id)"
          >×</button>
        </div>
        <div class="error-banner__msg">{{ b.message }}</div>
        <div v-if="b.hint" class="error-banner__hint">{{ b.hint }}</div>
      </div>
    </transition-group>

    <div v-if="fatalModal" class="error-modal-mask" @click.self="notify.dismissFatal()">
      <div class="error-modal" :class="`tone-${fatalModal.severity}`" role="alertdialog">
        <div class="error-modal__head">
          <span class="error-modal__title">{{ fatalModal.title }}</span>
          <span class="error-modal__code">[{{ fatalModal.code }}]</span>
        </div>
        <div class="error-modal__msg">{{ fatalModal.message }}</div>
        <div v-if="fatalModal.hint" class="error-modal__hint">{{ fatalModal.hint }}</div>
        <button class="error-modal__ok" @click="notify.dismissFatal()">我知道了</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { useErrorNotifyStore } from '../stores/errorNotify';

const notify = useErrorNotifyStore();
const banners = computed(() => notify.banners);
const fatalModal = computed(() => notify.fatalModal);
</script>

<style scoped>
.error-banner-stack {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 9999;
  pointer-events: none;
  display: flex;
  flex-direction: column;
  align-items: stretch;
}
.error-banner {
  pointer-events: auto;
  margin: 8px 12px;
  padding: 10px 14px;
  border-radius: 12px;
  font-size: 13px;
  line-height: 1.5;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08);
}
.tone-info {
  background: #f0f6ff;
  color: #2a4a6b;
  border-left: 3px solid #6ea4b8;
}
.tone-warn {
  background: #fff5e0;
  color: #6b4a1c;
  border-left: 3px solid #d4a256;
}
.tone-error {
  background: #fdebe9;
  color: #6b2a26;
  border-left: 3px solid #c46a5e;
}
.tone-fatal {
  background: #6b2a26;
  color: #fdebe9;
  border-left: 3px solid #c46a5e;
}
.error-banner__head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}
.error-banner__title {
  font-weight: 600;
  font-size: 12px;
  opacity: 0.85;
}
.error-banner__code {
  font-family: monospace;
  font-size: 11px;
  opacity: 0.6;
}
.error-banner__close {
  margin-left: auto;
  background: transparent;
  border: 0;
  font-size: 18px;
  line-height: 1;
  color: inherit;
  opacity: 0.6;
  cursor: pointer;
}
.error-banner__msg { font-weight: 500; }
.error-banner__hint { font-size: 12px; opacity: 0.8; margin-top: 4px; }
.error-modal-mask {
  position: fixed;
  inset: 0;
  z-index: 10000;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: auto;
}
.error-modal {
  background: #fff;
  border-radius: 16px;
  padding: 24px;
  max-width: 360px;
  margin: 16px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.2);
}
.error-modal.tone-fatal { border-top: 4px solid #c46a5e; }
.error-modal__head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 8px;
}
.error-modal__title { font-weight: 700; font-size: 16px; }
.error-modal__code { font-family: monospace; font-size: 12px; opacity: 0.6; }
.error-modal__msg { font-size: 14px; margin-bottom: 8px; }
.error-modal__hint { font-size: 13px; opacity: 0.75; margin-bottom: 16px; }
.error-modal__ok {
  display: block;
  width: 100%;
  padding: 10px;
  border: 0;
  border-radius: 10px;
  background: #6fa978;
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.error-banner-enter-from, .error-banner-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}
.error-banner-enter-active, .error-banner-leave-active {
  transition: all 200ms ease;
}
</style>
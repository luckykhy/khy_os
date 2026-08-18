<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { CapacitorBarcodeScanner } from '@capacitor/barcode-scanner';
import { useRuntimeStore } from '@/stores/runtime';
import { statusText } from '@/api/status';

const runtime = useRuntimeStore();
const router = useRouter();
const route = useRoute();
const address = ref('');
const pairingPayload = ref('');
const busy = ref(false);
const next = computed(() => typeof route.query.next === 'string' ? route.query.next : '/login');

onMounted(async () => {
  const existing = await runtime.restore();
  address.value = existing?.apiBaseUrl || '';
});

async function connect(value = address.value, source = 'manual') {
  busy.value = true;
  try {
    await runtime.verifyAndSave(value, source);
    await router.replace(next.value === '/connect' ? '/login' : next.value);
  } catch { /* store renders the error */ }
  finally { busy.value = false; }
}

async function usePairingText() {
  busy.value = true;
  try {
    await runtime.acceptPairing(pairingPayload.value);
    await router.replace('/login');
  } catch { /* store renders the error */ }
  finally { busy.value = false; }
}

async function scan() {
  busy.value = true;
  try {
    const result = await CapacitorBarcodeScanner.scanBarcode({ hint: 0 });
    const value = result?.ScanResult || result?.scanResult || result?.content || '';
    pairingPayload.value = value;
    await runtime.acceptPairing(value);
    await router.replace('/login');
  } catch (cause) {
    runtime.error = cause.message || '扫码未完成';
  } finally { busy.value = false; }
}
</script>

<template>
  <main class="connection-page">
    <section class="connection-inner stack">
      <div><small class="brand-mark">KHY-OS COMPANION</small><h1>连接你的工作节点</h1><p>选择二维码配对，或输入节点展示的 API 地址。</p></div>
      <section class="panel stack">
        <button class="button primary" :disabled="busy" @click="scan">扫描配对二维码</button>
        <label class="field">配对内容<textarea v-model="pairingPayload" placeholder="粘贴节点生成的配对内容"></textarea></label>
        <button class="button" :disabled="busy || !pairingPayload.trim()" @click="usePairingText">读取配对内容</button>
      </section>
      <section class="panel stack">
        <label class="field">后端 API 地址<input v-model="address" inputmode="url" autocomplete="url" placeholder="https://your-khy-node.example" /></label>
        <button class="button primary" :disabled="busy || !address.trim()" @click="connect()">检查并保存</button>
      </section>
      <p class="status-line" :class="runtime.status.tone">{{ statusText(runtime.status) }}</p>
      <p v-if="runtime.error" class="alert">{{ runtime.error }}</p>
    </section>
  </main>
</template>

<style scoped>
.connection-page { min-height: 100vh; display: grid; place-items: center; padding: 24px 16px; background: #0b1118; }
.connection-inner { width: min(480px, 100%); }.brand-mark { color: #68d5c0; letter-spacing: .08em; }.connection-inner h1 { margin: 8px 0; font-size: 30px; }.connection-inner > div p { margin: 0; color: #8ca0b5; line-height: 1.6; }
</style>

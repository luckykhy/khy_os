import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { clearRuntime, loadRuntime, normalizeBaseUrl, parsePairingPayload, saveRuntime } from '@/api/runtime';
import { checkHealth } from '@/api/client';
import { operationStatus } from '@/api/status';

export const useRuntimeStore = defineStore('mobile-runtime', () => {
  const config = ref(null);
  const status = ref(operationStatus('读取', '移动连接配置', '等待开始'));
  const error = ref('');
  const configured = computed(() => Boolean(config.value?.apiBaseUrl));

  async function restore() {
    status.value = operationStatus('读取', '移动连接配置', '进行中');
    config.value = await loadRuntime();
    status.value = operationStatus('读取', '移动连接配置', config.value ? '已恢复' : '未配置');
    return config.value;
  }

  async function verifyAndSave(input, source = 'manual') {
    error.value = '';
    const target = typeof input === 'string' ? input : input?.apiBaseUrl;
    status.value = operationStatus('检查', String(target || '后端地址'), '解析中');
    try {
      const candidate = typeof input === 'string'
        ? { apiBaseUrl: normalizeBaseUrl(input), source }
        : { ...input, apiBaseUrl: normalizeBaseUrl(input?.apiBaseUrl), source: input?.source || source };
      status.value = operationStatus('检查', candidate.apiBaseUrl, '连接中');
      await checkHealth(candidate.apiBaseUrl);
      config.value = await saveRuntime({ ...candidate, lastVerifiedAt: new Date().toISOString() });
      status.value = operationStatus('检查', config.value.apiBaseUrl, '已通过', 'success');
      return config.value;
    } catch (cause) {
      error.value = cause.message || '连接检查失败';
      status.value = operationStatus('检查', String(target || '后端地址'), '失败', 'error');
      throw cause;
    }
  }

  async function acceptPairing(raw) {
    const pairing = parsePairingPayload(raw);
    status.value = operationStatus('解析', '二维码配对信息', '已读取');
    return verifyAndSave(pairing, pairing.source);
  }

  async function clear() {
    await clearRuntime();
    config.value = null;
    status.value = operationStatus('清除', '移动连接配置', '已完成');
  }

  return { config, status, error, configured, restore, verifyAndSave, acceptPairing, clear };
});

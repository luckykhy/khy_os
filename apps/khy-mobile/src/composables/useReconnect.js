import { onBeforeUnmount, onMounted, ref } from 'vue';
import { Network } from '@capacitor/network';
import { operationStatus } from '@/api/status';

export function useReconnect(onReconnect) {
  const connected = ref(true);
  const connectionType = ref('unknown');
  const status = ref(operationStatus('检查', '设备网络', '等待开始'));
  let listener;

  async function applyNetworkState(next) {
    const wasConnected = connected.value;
    connected.value = Boolean(next.connected);
    connectionType.value = next.connectionType || 'unknown';
    status.value = operationStatus(
      '检查',
      `设备网络（${connectionType.value}）`,
      connected.value ? '已连接' : '已断开',
      connected.value ? 'success' : 'error'
    );
    if (!wasConnected && connected.value) await onReconnect?.();
  }

  onMounted(async () => {
    await applyNetworkState(await Network.getStatus());
    listener = await Network.addListener('networkStatusChange', applyNetworkState);
  });

  onBeforeUnmount(async () => {
    await listener?.remove();
  });

  return { connected, connectionType, status };
}

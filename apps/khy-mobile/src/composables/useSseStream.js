import { onBeforeUnmount, ref } from 'vue';
import { consumeSse } from '@/api/sse';
import { operationStatus } from '@/api/status';

export function useSseStream(target, onEvent) {
  const running = ref(false);
  const error = ref('');
  const status = ref(operationStatus('订阅', target, '未连接'));
  let controller = null;

  async function start(path, request = {}) {
    stop('正在重建');
    const current = new AbortController();
    controller = current;
    running.value = true;
    error.value = '';
    status.value = operationStatus('订阅', target, '连接中');
    try {
      await consumeSse(path, {
        ...request,
        signal: current.signal,
        onEvent(event) {
          if (controller !== current) return;
          status.value = operationStatus('接收', target, event.event || '事件已到达', 'success');
          onEvent?.(event);
        },
      });
      if (!current.signal.aborted && controller === current) {
        status.value = operationStatus('订阅', target, '已结束');
      }
    } catch (cause) {
      if (cause.name !== 'AbortError' && controller === current) {
        error.value = cause.message || '事件流连接失败';
        status.value = operationStatus('订阅', target, '失败', 'error');
        throw cause;
      }
    } finally {
      if (controller === current) {
        controller = null;
        running.value = false;
      }
    }
  }

  function stop(progress = '已停止') {
    controller?.abort();
    controller = null;
    running.value = false;
    status.value = operationStatus('订阅', target, progress);
  }

  onBeforeUnmount(() => stop());
  return { running, error, status, start, stop };
}

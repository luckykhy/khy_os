import { onBeforeUnmount, onMounted, ref } from 'vue';
import { App } from '@capacitor/app';

export function useMobileLifecycle({ onResume, onPause } = {}) {
  const active = ref(true);
  let listener;

  onMounted(async () => {
    listener = await App.addListener('appStateChange', async ({ isActive }) => {
      active.value = isActive;
      if (isActive) await onResume?.();
      else await onPause?.();
    });
  });

  onBeforeUnmount(async () => {
    await listener?.remove();
  });

  return { active };
}

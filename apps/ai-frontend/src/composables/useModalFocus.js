// useModalFocus — modal 焦点归还:打开前捕获触发元素,关闭后把焦点还回去。
//
// 背景:Element Plus 的 el-dialog / el-drawer 打开时聚焦弹层 body,关闭时焦点
// 落到弹层 DOM 末尾或 <body>——键盘/读屏用户就"迷路"了。本 composable 把
// 捕获与归还收敛成一处,各 view 只需:
//   const { captureTrigger, restoreFocus } = useModalFocus();
//   <el-button @click="() => { captureTrigger(); visible.value = true; }" />
//   <el-dialog ... @closed="restoreFocus()" />
import { ref } from 'vue';

export function useModalFocus() {
  const _trigger = ref(null);

  /** 在弹层打开前调用:记住当前 focused 元素(通常是触发按钮)。 */
  function captureTrigger(el = document.activeElement) {
    _trigger.value = el instanceof HTMLElement ? el : null;
  }

  /** 在弹层关闭后调用:把焦点还给捕获的触发元素(一次性消费)。 */
  function restoreFocus() {
    const el = _trigger.value;
    _trigger.value = null;
    if (el && typeof el.focus === 'function') {
      // rAF:等弹层从 DOM 移除后聚焦,避免被残留的 focus-trap 抢走。
      requestAnimationFrame(() => {
        try {
          el.focus({ preventScroll: true });
        } catch {
          /* element detached — skip */
        }
      });
    }
  }

  return { captureTrigger, restoreFocus };
}

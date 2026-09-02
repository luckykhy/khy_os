// 适配 Android 软键盘：把 visualViewport.height 与 window.innerHeight 的差值
// 写进 :root 的 --kbd-h CSS 变量。IME 弹起时各 sticky/fixed 元素用它上推。
// 退出（web 平台 / 桌面）时差值 = 0 → 各元素回到 safe-area-inset-bottom 兜底位置。
import { onBeforeUnmount, onMounted } from 'vue';

const VAR = '--kbd-h';

function setVar(value) {
  if (typeof document === 'undefined') return;
  document.documentElement.style.setProperty(VAR, `${Math.max(0, Math.round(value))}px`);
}

function computeKeyboardHeight() {
  if (typeof window === 'undefined' || !window.visualViewport) return 0;
  const vv = window.visualViewport;
  // visualViewport.height 在键盘弹起时会缩小（≤ innerHeight）
  // 差值 = 键盘大致占的高度（但要扣掉 chrome tab/url bar）
  const delta = window.innerHeight - vv.height;
  // 阈值 100px 防止误判（地址栏显隐）
  return delta > 100 ? delta : 0;
}

// Vue 组件 setup 用：自动 mount/unmount
export function useChatKeyboard() {
  let raf = 0;
  function onResize() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      setVar(computeKeyboardHeight());
    });
  }

  onMounted(() => {
    if (typeof window === 'undefined') return;
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', onResize);
      window.visualViewport.addEventListener('scroll', onResize);
    }
    setVar(0);
  });
  onBeforeUnmount(() => {
    if (typeof window === 'undefined') return;
    if (window.visualViewport) {
      window.visualViewport.removeEventListener('resize', onResize);
      window.visualViewport.removeEventListener('scroll', onResize);
    }
    if (raf) cancelAnimationFrame(raf);
    setVar(0);
  });
}

// 非 setup 上下文用（main.js 等）：手动启停
export function attachChatKeyboard() {
  if (typeof window === 'undefined') return () => {};
  let raf = 0;
  function onResize() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      setVar(computeKeyboardHeight());
    });
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', onResize);
    window.visualViewport.addEventListener('scroll', onResize);
  }
  setVar(0);
  return () => {
    if (window.visualViewport) {
      window.visualViewport.removeEventListener('resize', onResize);
      window.visualViewport.removeEventListener('scroll', onResize);
    }
    if (raf) cancelAnimationFrame(raf);
    setVar(0);
  };
}


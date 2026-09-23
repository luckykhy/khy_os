// useModalFocus — 捕获/归还模态层焦点的回归测试。
//
// 环境说明:本仓 vitest 默认 environment:'node',无 document。这里用最小桩
// 替代 HTMLElement 实例化(既测 instanceof 分支,又避开 jsdom 依赖),并用
// fake-timer 拦截 rAF 验证「弹层移除后才归还焦点」。
import { describe, expect, it, vi, afterEach } from 'vitest';
import { useModalFocus } from './useModalFocus.js';

// 最小 HTMLElement 桩:与 document.createElement('button') 行为一致地通过
// `instanceof HTMLElement` 判定。
const FakeHTMLElement = function FakeHTMLElement() {};
vi.stubGlobal('HTMLElement', FakeHTMLElement);
// document 只在 captureTrigger 默认参数中惰性访问,给个最小桩即可。
vi.stubGlobal('document', {
  get activeElement() {
    return null;
  },
  createElement: () => Object.create(FakeHTMLElement.prototype),
});

// node 环境无 rAF:装一个手动队列,用 flushRaf() 显式驱动,避免依赖 fake-timer
// 的 rAF shim。
let _rafQueue = [];
vi.stubGlobal(
  'requestAnimationFrame',
  (fn) => {
    _rafQueue.push(fn);
    return _rafQueue.length;
  }
);
function flushRaf() {
  const q = _rafQueue;
  _rafQueue = [];
  q.forEach((fn) => fn());
}

function fakeEl() {
  const el = Object.create(FakeHTMLElement.prototype);
  el.focus = vi.fn();
  return el;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('useModalFocus', () => {
  it('restoreFocus focuses the captured trigger element (via rAF, preventScroll)', () => {
    const inst = useModalFocus();
    const el = fakeEl();
    inst.captureTrigger(el);
    inst.restoreFocus();
    flushRaf();
    expect(el.focus).toHaveBeenCalledTimes(1);
    expect(el.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('restoreFocus is a no-op when nothing was captured', () => {
    const inst = useModalFocus();
    expect(() => inst.restoreFocus()).not.toThrow();
    flushRaf();
  });

  it('tolerates a detached element (focus throwing)', () => {
    const inst = useModalFocus();
    const el = {
      focus: () => {
        throw new Error('not connected');
      },
    };
    inst.captureTrigger(el);
    expect(() => {
      inst.restoreFocus();
      flushRaf();
    }).not.toThrow();
  });

  it('captureTrigger ignores non-HTMLElement active elements', () => {
    const inst = useModalFocus();
    expect(() => {
      inst.captureTrigger(null);
      inst.captureTrigger(42);
      inst.restoreFocus();
      flushRaf();
    }).not.toThrow();
  });

  it('second restoreFocus does not refocus the already-consumed trigger', () => {
    const inst = useModalFocus();
    const el = fakeEl();
    inst.captureTrigger(el);
    inst.restoreFocus();
    flushRaf();
    inst.restoreFocus(); // trigger consumed
    flushRaf();
    expect(el.focus).toHaveBeenCalledTimes(1);
  });
});

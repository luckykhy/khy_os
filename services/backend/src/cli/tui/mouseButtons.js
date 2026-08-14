'use strict';

/**
 * mouseButtons — 终端按钮的鼠标层核心(纯叶子 + 极薄运行时 dispatcher)。
 *
 * 学习 opencode TUI(opentui/core)的按钮实现:dialog-confirm / permission 选项排
 * 用 `onMouseUp` 点击、`onMouseOver`/`onMouseOut` 悬停高亮、`backgroundColor` 标记
 * 激活项。ink 没有鼠标抽象,本节把「SGR 鼠标序列解析 → 终端命中测试 → 事件分派」收敛
 * 到一个零依赖模块,组件只需在 `<Box>` 上写 `onClick` / `onMouseUp` /
 * `onMouseOver` / `onMouseOut`(ink Box 会把未知 props 并入 style → `node.style.onXxx`)。
 *
 * ── ink 输入管线(实测 ink 6.8.0)───────────────────────────────────────────
 * 终端开着鼠标追踪时,把 `\x1b[<0;20;10M`(按下) / `\x1b[<0;20;10m`(松开) 这类
 * SGR 序列写进 stdin。ink 的 input-parser 把整条当作单个 CSI 事件,parse-keypress
 * 认不出(name='', 所有 key 标志位 false),use-input.js 再把前缀 `\x1b` 剥掉 →
 * 每个 `useInput` handler 收到 `input === '[<0;20;10M'`。所以:
 *   - 解析输入在这里处理 `[<b;x;yM` / `[<b;x;ym`(M=按下,m=松开),`<` 是 SGR 标志;
 *   - 坐标是**屏幕绝对、1-based**(col=列,row=行),要转 0-based;
 *   - 必须给文本消费方加 `isMouseSequence` 守卫,否则 `[<0;20;10M` 会被当字面文本
 *     插进输入框/发送给内核。
 *
 * ── 命中测试坐标(关键)─────────────────────────────────────────────────────
 * ink 的 live 区恒贴屏幕底部(log-update 原地擦写 + startupAnchor 首帧锚底)。
 * 树里 `<Static>` 渲染成 `position: absolute` 的 ink-box(ink Static.js:21-25),
 * **不参与流式布局**:它不占高度、也不把 live 子节点往下推 —— 因此 root 的 yoga
 * 高度 = live 区高度,节点相对 root 原点的累计瑜伽 Y(y)就是它在 live 区内的行。
 * 映射到屏幕行:
 *   screenRow = (rows - rootHeight) + y      (anchorBottom 模式,默认开)
 *   screenRow = y                            (锚顶模式,仅 KHY_TUI_ANCHOR_BOTTOM=off)
 * X 无偏移:screenCol = 累计瑜伽 X。
 * 这个映射与 renderer/render-node-to-output 的 offset 累加完全一致(该文件 82 行),
 * 与 caretGeometry.js 的 parentNode 链累加同源;命中测试只需跳过 internal_static
 * 子树(静态区早已滚入 scrollback,不可点)。
 *
 * ── 门控 ───────────────────────────────────────────────────────────────────
 *   KHY_MOUSE_BUTTONS  默认 win32 开、其他平台关(仅显式 env 可跨平台打开):
 *                     Win+H 语音输入是 Windows 专属,且 SGR 1006 在
 *                     macOS Terminal.app / 部分 legacy 终端缺失,默认关更安全。
 *   KHY_MOUSE_HOVER   默认开:额外启用 1003(任意移动)实现 onMouseOver/Out 悬停;
 *                     1003 事件量大,关掉则只剩 1000+1006 的点击。
 * 两者都沿用 0/false/off/no 关闭口径(sidebarLayout/railLayout 同款)。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

/** SGR 鼠标序列(ink 剥掉 ESC 后的形态)。`M`=按下,`m`=松开。 */
const SGR_MOUSE_RE = /^\[<(\d+);(\d+);(\d+)([Mm])$/;

function _off(env, name) {
  const v = String((env && env[name]) || '')
    .trim()
    .toLowerCase();
  return OFF_VALUES.includes(v);
}

/**
 * 该输入串是否为 SGR 鼠标序列。文本消费方(useTextInput、各 overlay 的 useInput)
 * 用它做守卫,防止 `[<0;20;10M` 被当字面文本插入。
 * @param {*} input ink useInput 传入的原始串(可为任意类型)
 * @returns {boolean}
 */
function isMouseSequence(input) {
  return typeof input === 'string' && SGR_MOUSE_RE.test(input);
}

/**
 * 解析 SGR 鼠标序列。
 * @param {string} input ink useInput 的 input(已剥 ESC:`[<0;20;10M`)
 * @returns {{button:number, col:number, row:number, isPress:boolean, isRelease:boolean, isMotion:boolean, isWheel:boolean}|null}
 *   col/row 为 0-based 屏幕坐标;button 为 SGR 按钮码(0=左键,2=右键,
 *   64=滚轮上,65=滚轮下;shift/meta/ctrl 以 4/8/16 叠加在低位);
 *   isMotion 表示携带位移位(32)的移动/拖拽事件(仅 1003 追踪时出现);
 *   isWheel 表示滚轮事件(SGR 按钮 64/65,可带修饰位)。
 */
function parseSgrMouse(input) {
  if (typeof input !== 'string') {
    return null;
  }
  const m = SGR_MOUSE_RE.exec(input);
  if (!m) {
    return null;
  }
  const button = parseInt(m[1], 10);
  const col = Math.max(0, parseInt(m[2], 10) - 1);
  const row = Math.max(0, parseInt(m[3], 10) - 1);
  const isPress = m[4] === 'M';
  // 滚轮在 SGR 里是按钮 64(上)/65(下),修饰位 shift(4)/meta(8)/ctrl(16)
  // 直接加在低位,故用 `& ~28` 剥掉三个修饰位后比对。
  const wheelBase = button & ~28;
  return {
    button,
    col,
    row,
    isPress,
    isRelease: !isPress,
    isMotion: (button & 32) !== 0,
    isWheel: wheelBase === 64 || wheelBase === 65,
  };
}

/**
 * 鼠标按钮层总闸。默认 win32 开(语音按钮是 Windows 专属),其他平台关;
 * 显式 env(任意非 off 值)→ 强制开(跨平台 opt-in),显式 off → 关。
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [platform]
 * @returns {boolean}
 */
function mouseButtonsEnabled(env = process.env, platform = process.platform) {
  const raw = String((env && env.KHY_MOUSE_BUTTONS) || '').trim();
  if (raw !== '') {
    return !OFF_VALUES.includes(raw.toLowerCase());
  }
  return platform === 'win32';
}

/**
 * 悬停追踪(1003)门控:默认开,仅显式 falsy 关闭。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function mouseHoverEnabled(env = process.env) {
  return !_off(env, 'KHY_MOUSE_HOVER');
}

/**
 * 启用鼠标追踪的 ANSI 字节:1000(按钮事件)+ 1006(SGR 坐标),悬停开则加 1003。
 * 写入 stdout(交给 ink 的 stdout)即可,终端立即生效。
 * @param {{hover?: boolean}} [opts]
 * @returns {string}
 */
function enableBytes({ hover = false } = {}) {
  let out = '\x1b[?1000h\x1b[?1006h';
  if (hover) {
    out += '\x1b[?1003h';
  }
  return out;
}

/**
 * 停用鼠标追踪的 ANSI 字节(与 enableBytes 对称的 `l` 模式),退出时必调,
 * 否则终端停留在追踪态,用户失去鼠标选择文本能力。
 * @param {{hover?: boolean}} [opts]
 * @returns {string}
 */
function disableBytes({ hover = false } = {}) {
  let out = '\x1b[?1000l\x1b[?1006l';
  if (hover) {
    out += '\x1b[?1003l';
  }
  return out;
}

/**
 * 收集整棵 live 树里「可交互」节点的屏幕布局。DFS 镜像
 * render-node-to-output.js:71-145 的 offset 累加规则(x = offsetX + getComputedLeft(),
 * y = offsetY + getComputedTop()),跳过 `<Static>`(internal_static,绝对定位、
 * 已滚入 scrollback)与 display:none。
 *
 * `height` = root yoga 高度(= live 区高度;<Static> 绝对定位不占高),供调用方换算屏幕行。
 * @param {object|null} rootNode ink instance.rootNode
 * @returns {{width:number, height:number, items:Array<object>}}
 *   items: [{node, x, y, width, height, onClick, onMouseUp, onMouseOver, onMouseOut}]
 *   x/y 是相对 root 原点的累计偏移(与 renderer 一致)。
 */
function collectLayout(rootNode) {
  const out = { width: 0, height: 0, items: [] };
  if (!rootNode || !rootNode.yogaNode) {
    return out;
  }
  const rootYoga = rootNode.yogaNode;
  out.width = rootYoga.getComputedWidth() || 0;
  out.height = rootYoga.getComputedHeight() || 0;

  const walk = (node, offsetX, offsetY) => {
    if (!node || node.internal_static) {
      return;
    }
    const yoga = node.yogaNode;
    if (!yoga) {
      return;
    }
    // Yoga.DISPLAY_NONE === 1 (DISPLAY_FLEX === 0) — avoid importing ESM yoga-layout.
    if (typeof yoga.getDisplay === 'function' && yoga.getDisplay() === 1) {
      return;
    }
    const x = offsetX + (yoga.getComputedLeft() || 0);
    const y = offsetY + (yoga.getComputedTop() || 0);
    const style = node.style || {};
    if (
      typeof style.onClick === 'function' ||
      typeof style.onMouseUp === 'function' ||
      typeof style.onMouseOver === 'function' ||
      typeof style.onMouseOut === 'function'
    ) {
      out.items.push({
        node,
        x,
        y,
        width: yoga.getComputedWidth() || 0,
        height: yoga.getComputedHeight() || 0,
        onClick: style.onClick,
        onMouseUp: style.onMouseUp,
        onMouseOver: style.onMouseOver,
        onMouseOut: style.onMouseOut,
      });
    }
    const children = node.childNodes || [];
    for (let i = 0; i < children.length; i++) {
      walk(children[i], x, y);
    }
  };
  walk(rootNode, 0, 0);
  return out;
}

/**
 * 把 root 原点(相对坐标 y=0)换算成屏幕行偏移。
 * @param {number} rootHeight collectLayout().height(live 区高度)
 * @param {{rows:number, anchorBottom:boolean}} ctx
 * @returns {number} 屏幕行 = y + 返回值
 */
function screenOffset(rootHeight, ctx = {}) {
  const rows = Number(ctx.rows) > 0 ? Number(ctx.rows) : 24;
  if (ctx.anchorBottom !== false) {
    return rows - rootHeight;
  }
  return 0;
}

/**
 * 命中测试:返回覆盖 (col,row) 的**最上层**(渲染顺序靠后=绘制在顶层)可交互节点。
 * @param {{items:Array<object>}} layout collectLayout() 的结果
 * @param {number} col 0-based 屏幕列
 * @param {number} row 0-based 屏幕行
 * @param {number} offset screenOffset() 的结果
 * @returns {object|null} collectLayout() 里的 item(含 node)
 */
function hitTest(layout, col, row, offset) {
  if (!layout || !Array.isArray(layout.items)) {
    return null;
  }
  let best = null;
  for (let i = 0; i < layout.items.length; i++) {
    const it = layout.items[i];
    const x0 = it.x;
    const x1 = it.x + it.width;
    const y0 = it.y + offset;
    const y1 = it.y + offset + it.height;
    if (col >= x0 && col < x1 && row >= y0 && row < y1) {
      best = it;
    }
  }
  return best;
}

/**
 * 创建鼠标事件分派器(单例实例,App 顶层 useInput 调用)。
 *
 * ctx 形如 `{ rootNode, rows, anchorBottom }`:
 *   rootNode    = inkRuntime.getInkInstance().rootNode
 *   rows        = 物理终端行数(process.stdout.rows 或 fallback)
 *   anchorBottom = startupAnchor.anchorBottomEnabled(process.env)(默认 true)
 *
 * 语义对齐 opencode:在**松开**(onMouseUp)触发点击(命中松开点);
 * 悬停开时在位移事件上做 onMouseOver/onMouseOut 高亮状态机。
 *
 * ── 对抗式「点击 + 原生选择/滚轮」透传 ──────────────────────────────────────
 * xterm 追踪(1000/1002/1003)会同时吞掉原生选择与滚轮。为尽量两全,dispatcher
 * 区分「点击按钮」与「选择/滚动意图」:
 *   - 按下命中按钮(pendingClick)→ 等待松开触发 onClick(拖出按钮则取消);
 *   - 按下落空(pendingSelect)→ 按住拖动(位移且按钮在 0/1/2)→ 判定为选择意图,
 *     调 onNative() 临时关追踪让终端原生选择接管本次拖拽;
 *   - 滚轮事件(64/65)→ 调 onNative() 让终端原生滚动。
 * onNative 由调用方(App.js)实现:写 disableBytes + 空闲后恢复 enableBytes。
 * @param {{hover?: boolean, motionThrottleMs?: number, onNative?: function}} [opts]
 *        motionThrottleMs=0 关闭位移节流(测试用;运行时默认 30ms 防高频命中测试)。
 * @returns {{onInput:function, reset:function}}
 */
function createMouseDispatcher({ hover = true, motionThrottleMs = 30, onNative } = {}) {
  let hoverNode = null;
  let lastMoveAt = 0;
  let pendingClick = false; // 按下落在按钮上 → 等待松开触发点击
  let pendingSelect = false; // 按下落在空白 → 拖动则透传给原生选择
  const throttle = Number(motionThrottleMs) > 0 ? Number(motionThrottleMs) : 0;
  // 布局缓存:collectLayout(整树 DFS)只在该算时算一次。1003 移动追踪会让终端在
  // 每次鼠标移动都发事件(可到 60~120Hz);若每个事件都重算布局,大树上 2~20ms/
  // 次会打满 CPU、把键盘输入挤到后面(「输入延迟卡断」)。失效信号 = ink 实例的
  // lastOutput(每帧渲染后变化)+ root 身份;渲染之间所有事件复用同一份布局。
  let layoutCache = { root: null, key: null, layout: null };

  const getLayout = (rootNode, cacheKey) => {
    if (layoutCache.layout && layoutCache.root === rootNode && layoutCache.key === cacheKey) {
      return layoutCache.layout;
    }
    const layout = collectLayout(rootNode);
    layoutCache = { root: rootNode, key: cacheKey, layout };
    return layout;
  };

  const fireNative = () => {
    if (typeof onNative === 'function') {
      try {
        onNative();
      } catch {
        /* fail-soft */
      }
    }
  };

  return {
    onInput(input, ctx) {
      const ev = parseSgrMouse(input);
      if (!ev) {
        return false;
      }
      if (!ctx || !ctx.rootNode) {
        return true;
      }
      const layout = getLayout(ctx.rootNode, ctx.cacheKey);
      const offset = screenOffset(layout.height, ctx);

      // Wheel events: never treated as clicks — hand to the native passthrough
      // (tracking off → terminal's own scrollback scrolling resumes).
      if (ev.isWheel) {
        fireNative();
        return true;
      }

      if (ev.isMotion) {
        // Drag while the press landed on empty space → selection intent: switch
        // to native so the terminal's own click-drag selection takes over.
        // `button & 31 <= 2` means a real button is held during the motion
        // (motion bit 32 set; plain moves report button 3 = none).
        if (pendingSelect && (ev.button & 31) <= 2) {
          pendingSelect = false;
          fireNative();
          return true;
        }
        if (!hover) {
          return true;
        }
        // 位移事件可高频到达;限流到 ~30ms 一次,避免点击瞬间反复命中测试。
        const now = Date.now();
        if (throttle > 0 && now - lastMoveAt < throttle) {
          return true;
        }
        lastMoveAt = now;
        const item = hitTest(layout, ev.col, ev.row, offset);
        const node = item ? item.node : null;
        if (node !== hoverNode) {
          if (hoverNode && hoverNode.style && typeof hoverNode.style.onMouseOut === 'function') {
            try {
              hoverNode.style.onMouseOut(ev);
            } catch {
              /* fail-soft */
            }
          }
          hoverNode = node;
          if (node && node.style && typeof node.style.onMouseOver === 'function') {
            try {
              node.style.onMouseOver(ev);
            } catch {
              /* fail-soft */
            }
          }
        }
        return true;
      }

      if (ev.isPress) {
        // Press decides intent: on a button → click candidate; on empty space →
        // selection candidate (a subsequent drag passes through to native).
        const item = hitTest(layout, ev.col, ev.row, offset);
        if (item) {
          pendingClick = true;
        } else {
          pendingSelect = true;
        }
        return true;
      }

      // Release: if the press had armed a click, fire on the node under the
      // release point (drag-off-button cancels, opencode same semantics).
      const wasClick = pendingClick;
      pendingClick = false;
      pendingSelect = false;
      if (wasClick) {
        const item = hitTest(layout, ev.col, ev.row, offset);
        const node = item ? item.node : null;
        const style = node && node.style ? node.style : null;
        const handler = style ? style.onMouseUp || style.onClick : null;
        if (typeof handler === 'function') {
          try {
            handler(ev);
          } catch {
            /* fail-soft */
          }
        }
      }
      return true;
    },
    reset() {
      hoverNode = null;
      pendingClick = false;
      pendingSelect = false;
    },
  };
}

module.exports = {
  OFF_VALUES,
  SGR_MOUSE_RE,
  isMouseSequence,
  parseSgrMouse,
  mouseButtonsEnabled,
  mouseHoverEnabled,
  enableBytes,
  disableBytes,
  collectLayout,
  screenOffset,
  hitTest,
  createMouseDispatcher,
};

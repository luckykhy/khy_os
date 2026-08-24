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
 * ink 的 live 区在 legacy startupAnchor 开启时贴屏幕底部；默认启动则从当前
 * 光标位置连续渲染。
 * 树里 `<Static>` 渲染成 `position: absolute` 的 ink-box(ink Static.js:21-25),
 * **不参与流式布局**:它不占高度、也不把 live 子节点往下推 —— 因此 root 的 yoga
 * 高度 = live 区高度,节点相对 root 原点的累计瑜伽 Y(y)就是它在 live 区内的行。
 * 映射到屏幕行:
 *   screenRow = (rows - rootHeight) + y      (anchorBottom 模式,显式开启)
 *   screenRow = y                            (默认连续渲染模式)
 * X 无偏移:screenCol = 累计瑜伽 X。
 * 这个映射与 renderer/render-node-to-output 的 offset 累加完全一致(该文件 82 行),
 * 与 caretGeometry.js 的 parentNode 链累加同源;命中测试只需跳过 internal_static
 * 子树(静态区早已滚入 scrollback,不可点)。
 *
 * ── 门控:为什么默认全关 ──────────────────────────
 * 终端的鼠标追踪是**独占**的:一旦开启,滚轮与按住拖动都被送进本进程的 stdin,
 * 终端自己再也收不到 —— 用户同时失去「滚轮翻 scrollback」和「拖选复制」这两个最
 * 基础的终端能力。补偿是补不回来的:触发的那一下已经进了 stdin、终端没收到,
 * 无法回灌。慢速一格一格地滚(阅读时最常见的滚法)每一格都被吞掉。
 *
 * 参照实现(Claude Code,2026-08 实测):全量检索其 307MB 单文件 bundle,鼠标追踪
 * 序列只有 `?1000h`/`?1006h` 各一处,且上下文是一个 vendored 的多选提示组件;**没有
 * 1002,也没有 1003**。即 CC 的主 REPL 根本不接管鼠标,原生滚轮与拖选全程可用;
 * 展开与滚动全走键盘 —— Ctrl+O 开 Transcript 视图,视图内用 `scroll:*` 动作族
 * (j/k、Ctrl+U/D、g/G、Ctrl+E 全展开)。本模块因此也降到 1000(见 enableBytes):
 * 1000 不报位移,拖选从来不会变成本进程的事件,原生选择完整保留;历史上那套
 * 针对拖选的透传补偿(`pendingSelect`)随之删除 —— 它只在 1002 下才能触发,而当初
 * 选 1002 的理由恰恰就是「为了喂它」。现在仅剩滚轮需要透传(见 dispatcher)。
 *
 * 收益侧只有两个可点元素(麦克风按钮、待发图片的 ×),且麦克风有等价键位 Alt+M、
 * 图片有 Esc 清除。拿「少按一个键」换掉「滚动 + 复制」不成比例,所以:
 *
 *   KHY_MOUSE_BUTTONS  **默认全平台关**;显式 1/true/on/yes 才开点击层(开了就接受
 *                     上述滚轮退化,拖选则不受影响)。
 *   KHY_MOUSE_HOVER   默认关:悬停高亮要 1003「任意移动」追踪,那是 60~120Hz 的
 *                     事件洪流、持续占用终端输入;显式 1/true/on/yes 才启用。
 * 两者都沿用 0/false/off/no 关闭口径(sidebarLayout/railLayout 同款)。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

/** SGR 鼠标序列(ink 剥掉 ESC 后的形态)。`M`=按下,`m`=松开。 */
const SGR_MOUSE_RE = /^\[<(\d+);(\d+);(\d+)([Mm])$/;

function _on(env, name) {
  const v = String((env && env[name]) || '')
    .trim()
    .toLowerCase();
  return ['1', 'true', 'on', 'yes'].includes(v);
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
 *   isMotion 表示携带位移位(32)的移动/拖拽事件(默认的 1000 一个都不报,仅 hover 的 1003 会报);
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
 * 鼠标按钮层总闸。**默认全平台关**,只有显式 env 才开 —— 见头部「为什么默认全关」:
 * 追踪态是独占的,开着就没有滚轮翻页与拖选复制,而透传补偿补不回触发事件本身。
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [_platform] 保留形参:平台已不参与判定,仅为不破坏既有调用点签名
 * @returns {boolean}
 */
function mouseButtonsEnabled(env = process.env, _platform = process.platform) {
  return _on(env, 'KHY_MOUSE_BUTTONS');
}

/**
 * 悬停追踪(1003)门控:默认关，仅显式 truthy 开启。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function mouseHoverEnabled(env = process.env) {
  return _on(env, 'KHY_MOUSE_HOVER');
}

/**
 * 启用鼠标追踪的 ANSI 字节。写进 stdout(交给 ink 的 stdout)即可,终端立即生效。
 *
 * 用 **1000(X11 basic)**,与 Claude Code 唯一那处追踪调用同档(见头部)。1000 只报
 * 「按下 / 松开」,一个位移事件都不报 —— 这正是我们要的:点击只需要按下与松开两个
 * 端点,位移是纯负担。
 *
 * 曾经用的是 1002(button-event,按住键时连位移一起报),理由是「有位移事件才能判定
 * 拖拽,从而把拖选透传给终端」。那条推理是反的:1002 报出的位移意味着**按下那一下
 * 已经被本进程吃掉了** —— 终端没收到,原生选择只能从拖到一半的地方接管,选出来的范
 * 围必然是错的,补偿补不回起点。降到 1000 后位移根本不上报,按下/松开落在空白处时
 * dispatcher 什么都不做,终端自己看到完整的一次拖拽,拖选行为完全正常。
 *
 * 1006 是 SGR 坐标编码,与追踪模式正交,两者都要。hover 额外开 1003(任意移动),
 * 那是 60~120Hz 洪流且必然吞掉拖选,故单独门控、默认关。
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
 * 停用鼠标追踪的 ANSI 字节。退出时必调,否则终端停留在追踪态,用户在**之后每一条
 * 命令**里都失去滚轮与拖选(被 hard kill 的旧会话就是这样把终端留坏的)。
 *
 * 无条件复位 1000/1002/1003 三个追踪模式,不看 hover:「只关自己开过的那些」这种
 * 对称写法埋过雷 —— 开的是 1002 而关的是 1000,终端就留在追踪态。DECRST 打在本来
 * 就没开的模式上是 no-op,多关几个零成本,少关一个就是一个坏掉的终端。也因此它可
 * 以当「无条件消毒」用:不确定终端是否被上一个进程留在追踪态时,直接写它。
 * @param {{hover?: boolean}} [_opts] 保留形参:已无条件全关,仅为不破坏既有调用点
 * @returns {string}
 */
function disableBytes(_opts) {
  return '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l';
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
  if (ctx.anchorBottom === true) {
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
 *   anchorBottom = startupAnchor.anchorBottomEnabled(process.env)(默认 false)
 *
 * 语义对齐 opencode:在**松开**(onMouseUp)触发点击(命中松开点);
 * 悬停开时在位移事件上做 onMouseOver/onMouseOut 高亮状态机。
 *
 * ── 滚轮透传 ────────────────────────────────────────────────────────────────
 * xterm 追踪会吞掉原生滚轮。dispatcher 只做两件事:
 *   - 按下命中按钮(pendingClick)→ 等待松开触发 onClick(拖出按钮则取消);
 *   - 滚轮事件(64/65)→ 调 onNative() 临时关追踪,让终端原生滚动接管。
 * onNative 由调用方(App.js)实现:写 disableBytes + 空闲后恢复 enableBytes。
 *
 * **拖选不需要补偿**:1000 不报位移,按下/松开落在空白处时下面什么都不做,终端自己
 * 看到完整的一次拖拽。历史上这里有一条 `pendingSelect` 分支试图把拖选透传给终端,
 * 它在真实终端里一次都没触发过 —— 1002 才报位移,而当初选 1002 的理由恰恰是「为了
 * 喂它」,是个循环论证。已随降档一并删除。
 * @param {{hover?: boolean, motionThrottleMs?: number, onNative?: function}} [opts]
 *        motionThrottleMs=0 关闭位移节流(测试用;运行时默认 30ms 防高频命中测试)。
 * @returns {{onInput:function, reset:function}}
 */
function createMouseDispatcher({ hover = true, motionThrottleMs = 30, onNative } = {}) {
  let hoverNode = null;
  let lastMoveAt = 0;
  let pendingClick = false; // 按下落在按钮上 → 等待松开触发点击
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

      // Motion only ever arrives under 1003 (hover, opt-in): 1000 reports press
      // and release, nothing in between. Kept because the parser still classifies
      // motion, and a stray motion event must not fall through to press/release.
      if (ev.isMotion) {
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
        // Press on a button arms a click. Press on empty space is deliberately a
        // no-op: under 1000 the terminal never sees this press, but it never sees
        // a drag either, so there is nothing to hand back and nothing to fake.
        if (hitTest(layout, ev.col, ev.row, offset)) {
          pendingClick = true;
        }
        return true;
      }

      // Release: if the press had armed a click, fire on the node under the
      // release point (drag-off-button cancels, opencode same semantics).
      const wasClick = pendingClick;
      pendingClick = false;
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

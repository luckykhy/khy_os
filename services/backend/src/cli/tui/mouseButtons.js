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
 * (j/k、Ctrl+U/D、g/G、Ctrl+E 全展开)。本模块因此也降到 1000(见 enableBytes)。
 *
 * ⚠ **一处曾被写错、且直接造成用户可见故障的推理(2026-09-17 修正)**:
 * 历史注释写「1000 不报位移,拖选从来不会变成本进程的事件,原生选择完整保留」——
 * **这是错的**。1000(X11 basic)不报 `motion`,但**按下/松开照样上报**,而按下正是
 * 终端原生拖选的**起点**。dispatcher 当时对 `press` 无条件 `return true`,把起点
 * 吃进 stdin → 终端此后只看到一团无主位移,原生选择无法启动。用户报的「拖选选不中」
 * 就是这条。降档到 1000 只消灭了 motion 上报,**press 还在**;`pendingSelect` 补偿删掉
 * 之后,拖选是「从补偿失败」变成「完全无补偿」,而不是恢复正常。
 * ⇒ 纪律:**「不报 X」不等于「不报 Y」**。判据要写清「到底哪些事件类别会上报」,
 *   不能由「不报位移」推出「这个手势与我无关」。现在的判据是按**事件类别**逐项决定
 *   吞不吞(见 onInput):滚轮仍吞、含修饰键放行、空白处按下/松开放行、命中按钮才吞。
 * ⇒ 修饰位也是本条的延伸:`Shift` 在 §6.2 里承诺「永远走原生选择」,故 `parseSgrMouse`
 *   必须拆出 `isShift/isAlt/isCtrl`,且放行判据要**排除滚轮**(Shift+滚轮 = 横向滚动)。
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
    // 修饰位必须**拆出来单独暴露**。历史上这里只存了整颗 button 码,调用方
    // 从不检查它们,于是 §6.2「Shift + 任何鼠标操作永远走终端原生选择」这条
    // 硬承诺在实现侧不存在 —— 文档承诺了,代码不认识。位值与上面 wheelBase
    // 的掩码同源(shift 4 / meta 8 / ctrl 16)。
    isShift: (button & 4) !== 0,
    isAlt: (button & 8) !== 0,
    isCtrl: (button & 16) !== 0,
  };
}

/**
 * 鼠标按钮层总闸。**默认全平台关**,只有显式 env 才开 —— 见头部「为什么默认全关」:
 * 追踪态是独占的,开着就没有滚轮翻页与拖选复制,而透传补偿补不回触发事件本身。
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [_platform] 保留形参:平台已不参与判定,仅为不破坏既有调用点签名
 * @returns {boolean}
 */
/**
 * 终端能力自动检测:当 KHY_MOUSE_BUTTONS 未显式设置时,根据环境变量推断终端是否支持
 * SGR 鼠标协议。默认认为现代终端支持（保守回退 true,因为不开比开更安全——关是用户显式选择）。
 *
 * 检测顺序:
 *  1. Windows Terminal (WT_SESSION 非空)
 *  2. 已知 GUI 终端 (TERM_PROGRAM)
 *  3. 已知 TUI 终端 (TERM 包含)
 *  4. 兜底 true（现代终端大概率支持，不支持时用户可显式 KHY_MOUSE_BUTTONS=0 关闭）
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function autoDetectTerminal(env = process.env) {
  const wtSession = String(env.WT_SESSION || '').trim();
  if (wtSession) return true;

  const termProgram = String(env.TERM_PROGRAM || '').trim();
  const knownGui = new Set([
    'Apple_Terminal', 'iTerm.app', 'vscode', 'WezTerm',
    'Alacritty', 'kitty', 'WindowsTerminal', 'Ghostty',
  ]);
  if (knownGui.has(termProgram)) return true;

  const term = String(env.TERM || '').trim().toLowerCase();
  const knownTui = ['xterm', 'screen', 'tmux', 'linux', 'rxvt', 'alacritty', 'kitty', 'wezterm'];
  for (const t of knownTui) {
    if (term.includes(t)) return true;
  }

  // DESIGN-ARCH-102 §6.2 / P6: 未知终端不接管 —— 只有**明确识别**为支持 SGR 的
  // 终端才默认开 click 档;兜底 false 保住原生滚轮/拖选,用户仍可用 KHY_MOUSE=click
  // 或 KHY_MOUSE_BUTTONS=1 显式接管。
  return false;
}

/**
 * 三档鼠标策略(DESIGN-ARCH-102 §6.2,取代旧的「全开/全关」布尔):
 *   off   —— 完全不接管(原生滚轮+拖选保留)
 *   click —— 只开 1000+1006(按下/松开,不报位移);滚轮事件一律 fireNative()
 *   full  —— 额外开 1003 悬停高亮(事件洪流,明确 opt-in)
 * KHY_MOUSE_BUTTONS / KHY_MOUSE_HOVER 保留为显式覆盖(旧 env 优先),否则由档位决定。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {'off'|'click'|'full'}
 */
function mouseTier(env = process.env) {
  const v = String((env && env.KHY_MOUSE) || '').trim().toLowerCase();
  if (v === 'off' || v === '0' || v === 'no') return 'off';
  if (v === 'full') return 'full';
  if (v === 'click' || v === '1' || v === 'on' || v === 'yes' || v === '') return 'click';
  return 'click';
}

function mouseButtonsEnabled(env = process.env, _platform = process.platform) {
  const v = String((env && env.KHY_MOUSE_BUTTONS) || '').trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'on' || v === 'yes') return true;
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return false;
  // 三档 + 未知终端不接管的组合语义:click/full 档默认接管,但仅当终端被**识别**;
  // off 档恒不接管。
  if (mouseTier(env) === 'off') return false;
  return autoDetectTerminal(env);
}

/**
 * 悬停追踪(1003)门控:仅 full 档默认开;显式 env 可独立覆盖。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function mouseHoverEnabled(env = process.env) {
  const v = String((env && env.KHY_MOUSE_HOVER) || '').trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'on' || v === 'yes') return true;
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return false;
  return mouseTier(env) === 'full';
}

/**
 * 滚轮方向(纯叶子):SGR 按钮 64=上 / 65=下,修饰位 shift(4)/meta(8)/ctrl(16)
 * 直接加在低位,故先 `& ~28` 剥掉再比对。非滚轮 → null。
 * @param {number} button SGR 按钮码
 * @returns {'up'|'down'|null}
 */
function wheelDirection(button) {
  const base = Number(button) & ~28;
  if (base === 64) return 'up';
  if (base === 65) return 'down';
  return null;
}

/**
 * 用户是否**显式**关掉了鼠标层(`KHY_MOUSE=off` / `KHY_MOUSE_BUTTONS=0`)。
 * 与 `mouseButtonsEnabled` 的区别:那个是「自动检测后的结论」,本函数只看用户有没有
 * 明确表态 —— 备用缓冲区里要强制接管滚轮时,只有显式表态才允许否决。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function mouseExplicitlyDisabled(env = process.env) {
  const tier = String((env && env.KHY_MOUSE) || '')
    .trim()
    .toLowerCase();
  if (tier === 'off' || tier === '0' || tier === 'no') {
    return true;
  }
  const v = String((env && env.KHY_MOUSE_BUTTONS) || '')
    .trim()
    .toLowerCase();
  return v === '0' || v === 'false' || v === 'off' || v === 'no';
}

/**
 * 启用鼠标追踪的 ANSI 字节。写进 stdout(交给 ink 的 stdout)即可,终端立即生效。
 *
 * ── 三档追踪模式(互斥,只能开一个)────────────────────────────────────────
 *   1000  X11 basic        报 按下 / 松开。**不报位移** → 应用内自绘选择收不到拖动
 *                          轨迹,只能画成「端点跳变」,无法实时跟手。
 *   1002  button-event     报 按下 / 松开 / **按住时的位移**。应用内自绘选择需要它:
 *                          选区要随指针实时扩展(见 §4.2.1 「App 内自绘选择」)。
 *   1003  any-motion       报 一切移动(按住与否),60~120Hz 洪流。只有悬停高亮需要,
 *                          且必然吃掉原生拖选,故单独门控、默认关。
 *   1006  坐标编码         与追踪模式**正交**(SGR 扩展坐标),永远都要带上。终端不发
 *                          1006 时坐标退化成 223 列上限的老式编码,长行选区会错位。
 *
 * ── 为什么 `select` 是「替换」而不是「叠加」──────────────────────────────
 * 1000 与 1002 是**同一能力的不同档位**,终端按「最后一条生效的 DECSET」解释,叠加写
 * 只会在不同终端上产生不确定行为(有的终端 1002 覆盖 1000,有的两个都置位后按 1000 报)。
 * 所以 `select=true` 时**只写 1002h**:它向下兼容 1000 的全部事件(按下/松开照报),
 * 又多了位移。`select=false` 时维持 1000h —— 点击层不需要位移,多报只是负担。
 *
 * 这个参数的存在本身就修正了一条历史错误推理(见头部 ⚠):曾经认为「1002 报位移意味着
 * 按下已被吃掉、所以必须降到 1000」。**因果是反的** —— 按下被吃掉是因为 dispatcher
 * 对 `press` 无条件 `return true`,与开哪一档无关。1000 下 press 照样上报、照样被吃。
 * 降档只是把「能自绘的位移信息」一起删掉了,问题一点没解决。
 *
 * @param {{hover?: boolean, select?: boolean}} [opts]
 *        hover  额外开 1003(悬停高亮,代价是吃掉原生拖选)
 *        select 用 1002 替换 1000(应用内自绘选择必须;未开选择时保持 1000)
 * @returns {string}
 */
function enableBytes({ hover = false, select = false } = {}) {
  let out = select ? '\x1b[?1002h\x1b[?1006h' : '\x1b[?1000h\x1b[?1006h';
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
 * ── 滚轮 ────────────────────────────────────────────────────────────────────
 * xterm 追踪会吞掉原生滚轮。dispatcher 做三件事:
 *   - 按下命中按钮(pendingClick)→ 等待松开触发 onClick(拖出按钮则取消);
 *   - 滚轮事件(64/65)→ 调 `onWheel('up'|'down')`,由 App 转成应用内视口滚动
 *     (备用缓冲区里没有回滚缓冲,交还终端只会换来合成的 ↑/↓,见上「滚轮」一节);
 *   - onWheel 未接线 → 回退 `onNative()` 临时关追踪,让终端原生滚动接管。
 *
 * **拖选不需要补偿**:1000 不报位移,按下/松开落在空白处时下面什么都不做,终端自己
 * 看到完整的一次拖拽。历史上这里有一条 `pendingSelect` 分支试图把拖选透传给终端,
 * 它在真实终端里一次都没触发过 —— 1002 才报位移,而当初选 1002 的理由恰恰是「为了
 * 喂它」,是个循环论证。已随降档一并删除。
 * ── 滚轮:应用内滚动(不再交还终端)────────────────────────────────────────────
 * 历史上滚轮事件只做一件事:`fireNative()` 临时关追踪,把滚动交还给终端原生
 * scrollback。这在**主屏幕**成立,在**备用缓冲区**里是错的 —— 备屏没有回滚缓冲,
 * 终端(Windows Terminal / xterm 的 alternate-scroll)于是把滚轮**合成 ↑/↓ 键**
 * 送进来,而本仓 arrowRouting 把 ↑/↓ 无条件绑到 `history:previous/next` →
 * 用户滚一下滚轮,输入框里的历史记录被召回。这就是「滚轮变成回溯历史」的根因。
 *
 * 现在滚轮走 `onWheel(dir)`:由 App 转成 `scroll:lineUp/lineDown` 喂给**应用内**
 * 视口(Viewport)。终端一个字节都收不到,也就无从合成方向键。onWheel 缺失(旧调用点)
 * 才回退 `fireNative()`,保持向后兼容。
 * @param {{hover?: boolean, motionThrottleMs?: number, onNative?: function, onWheel?: function}} [opts]
 *        motionThrottleMs=0 关闭位移节流(测试用;运行时默认 30ms 防高频命中测试)。
 *        onWheel(dir, ev) 收到 'up'|'down' —— 提供了就不再走原生透传。
 * @returns {{onInput:function, reset:function}}
 */
function createMouseDispatcher({
  hover = true,
  motionThrottleMs = 30,
  onNative,
  onWheel,
  onSelectEvent,
} = {}) {
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

  /**
   * 上报一次选择层事件。`kind` ∈ `'down' | 'move' | 'up'`(`'cancel'` 由 reset 触发)。
   *
   * 为什么是「上报」而不是「在这里改状态」:选区的模型在 `selection.js`(纯叶子),
   * 状态活在 React 里(要触发重渲才能画出反色)。dispatcher 是极薄运行时,只负责
   * 「把物理事件翻译成语义事件」,不持有选区 —— 与 `onWheel` 同一范式。
   *
   * 坐标是 `parseSgrMouse` 输出的 **0-based 屏幕绝对坐标**(parser 已把 SGR 的
   * 1-based 减过 1)。**不在这里减视口滚动偏移**:那是 App 层 state 才知道的量,
   * 让调度层去猜偏移正是「坐标看着对、选区总差几行」这类 bug 的来源。
   */
  const fireSelect = (kind, ev) => {
    if (typeof onSelectEvent !== 'function') {
      return;
    }
    try {
      onSelectEvent(kind, ev);
    } catch {
      /* fail-soft —— 选择层坏掉绝不能连累键盘输入 */
    }
  };

  // select 模式是否生效,由「有没有接 onSelectEvent」决定(没接 = 不开自绘选择,
  // 走纯点击层的老行为)。抽成闭包变量而不是每次算,是因为 onInput 是热路径。
  const selectEnabled = typeof onSelectEvent === 'function';

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

      // Wheel events are never clicks. Preferred path: hand the direction to the
      // in-app viewport (onWheel). The native passthrough is only a fallback for
      // callers that did not wire onWheel — inside the alternate screen it is
      // actively harmful (no scrollback → the terminal synthesizes ↑/↓ → the app
      // reads that as input-history recall).
      if (ev.isWheel) {
        const dir = wheelDirection(ev.button);
        if (typeof onWheel === 'function' && dir) {
          try {
            onWheel(dir, ev);
          } catch {
            /* fail-soft — a scroll handler must never kill the input path */
          }
        } else {
          fireNative();
        }
        return true;
      }

      // ── 前置放行:修饰键 = 用户想要终端行为(§6.2 硬承诺)────────────────────
      // 「Shift + 任何鼠标操作永远走终端原生选择」是 [DESIGN-ARCH-102] §6.2 的明文
      // 承诺,而修饰位在此之前被完整解析却从不检查。Shift/Alt/Ctrl 在终端语境里
      // 统一是「绕过本程序」的约定键,本进程拿它没有任何用途(按钮点击不需要修饰,
      // 自绘选择也不需要 —— 用户按着 Shift 拖就是要终端自己的选择)。
      //
      // ⚠ **位置是根因级的,必须排在 `isMotion` / `press` / `release` 全部之前**:
      //   ① 排在 motion 之后 → **Shift+拖动位移会被当成自绘选区的扩展轨迹**
      //      (`[<36;x;yM` = Shift|motion),用户按着 Shift 拖本想走终端原生选择,
      //      结果本进程也在同时画自己的选区,两套选区打架。这条是端到端探针抓的
      //      (单测只测了 press,漏了 motion 这条路径)。
      //   ② 排在 press 之后 → 起不到作用,按下已经被吞掉了。
      //   ③ 排在 wheel 之前 → Shift+滚轮会被放行,而终端里 Shift+滚轮 = 横向滚动,
      //      不是「我要拖选」;备屏下放行滚轮还会被合成 ↑/↓ → 历史回溯(§0.9.3)。
      //      故判据里显式排除 `ev.isWheel`(滚轮已在上面单独处理并 return)。
      //
      // 返回 false = 不消费。⚠ 诚实边界:ink 已把事件从 stdin 读走,`false` 物理上
      // 回不到终端;放行的真实价值在于「**不去吞它、也不去画自己的选区**」—— 终端
      // 自身对本机鼠标的最终解释(xterm/WT/kitty 对 Shift+鼠标 的原生选择)不受干扰。
      // 且对**未上报**修饰序列的终端,这一条自然不触发,是零副作用的双保险。
      if (ev.isShift || ev.isAlt || ev.isCtrl) {
        return false;
      }

      // Motion only ever arrives under 1002 (select) or 1003 (hover, opt-in).
      // Kept because the parser still classifies motion, and a stray motion event
      // must not fall through to press/release.
      if (ev.isMotion) {
        // ① 自绘选择优先:1002 下按住拖动的位移就是选区的扩展轨迹。
        //    必须先于 hover/点击层判断 —— 拖动时用户要的是选文字,不是高亮按钮。
        //    限流只用于 hover(30ms),选区**不限流**:丢一个位移点会让选区
        //    「跳一段」,而扩展选区是纯算术(state slice),比 hover 的整树命中测试
        //    便宜得多,没有限流的必要。
        if (selectEnabled) {
          fireSelect('move', ev);
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
        // Press on a button arms a click. Press on **empty space** is now handed
        // back (return false): the terminal needs the full gesture (press → drag →
        // release) to start a native selection, and the press is its origin. Eating
        // it leaves the terminal with an origin-less drag it cannot interpret —
        // which is exactly the「拖选选不中」the user reports. We have nothing to do
        // with a press that missed every button (pendingClick only ever serves
        // buttons), so there is no reason to swallow it.
        //
        // Historical reasoning that this branch must correct: the old comment claimed
        // 「1000 never reports motion, so a drag is never an event here and native
        // selection is untouched」. That confused motion with press — 1000 does not
        // report motion, but the press IS reported, and it was swallowed. Dropping
        // to 1000 removed only the motion reports; the drag's origin was still eaten.
        if (hitTest(layout, ev.col, ev.row, offset)) {
          pendingClick = true;
          return true;
        }
        // 空白处按下:自绘选择以它为**起点**。先上报再放行 —— 放行是为了不干扰
        // 终端侧(未开追踪的场景),上报是为了本进程自己画选区。两者不冲突:
        // 「不消费」只是不去吞,事件已经到过我们手里了。
        if (selectEnabled) {
          fireSelect('down', ev);
        }
        return false;
      }

      // Release: if the press had armed a click, fire on the node under the
      // release point (drag-off-button cancels, opencode same semantics).
      //
      // ⚠ 关键:`armed` 只表示「起点在按钮上」,不表示「这次手势是点击」。用户完全
      // 可以从按钮上按下、然后拖出去做原生选择 —— 那正是「从按钮旁边开始选一段文字」
      // 的常见动作。所以松开点的处理按**命中**而非按 armed 决定吞不吞:
      //   命中按钮 → 吞 + 触发(click 档的核心价值,等价键位 Alt+M / Esc 仍在)
      //   落空     → 放行(拖出按钮 = 用户放弃点击,想要的是原生选择)
      // 历史实现按 armed 无条件 `return true`,连「拖出去选文字」这一下的终点也吃掉,
      // 于是即便起点侥幸没被吞,整段手势仍缺终点 —— 与缺陷 A 同一类病。
      const wasClick = pendingClick;
      pendingClick = false;
      const item = hitTest(layout, ev.col, ev.row, offset);
      // 自绘选择的终点:只要开着手势就上报。**必须早于 return** —— 松手即「定稿」,
      // 之后 App 层会 extractText + writeClipboard,这是整条链路唯一真正的产出点。
      if (selectEnabled) {
        fireSelect('up', ev);
      }
      if (item) {
        const node = item.node;
        const style = node && node.style ? node.style : null;
        const handler = wasClick && style ? style.onMouseUp || style.onClick : null;
        if (typeof handler === 'function') {
          try {
            handler(ev);
          } catch {
            /* fail-soft */
          }
        }
        return true;
      }
      // Released over empty space: hand it back so the terminal sees the end of a
      // native drag (whether or not the press had landed on a button).
      return false;
    },
    reset() {
      hoverNode = null;
      pendingClick = false;
      fireSelect('cancel', null);
    },
  };
}

module.exports = {
  OFF_VALUES,
  SGR_MOUSE_RE,
  isMouseSequence,
  parseSgrMouse,
  autoDetectTerminal,
  mouseTier,
  mouseButtonsEnabled,
  mouseHoverEnabled,
  mouseExplicitlyDisabled,
  wheelDirection,
  enableBytes,
  disableBytes,
  collectLayout,
  screenOffset,
  hitTest,
  createMouseDispatcher,
};

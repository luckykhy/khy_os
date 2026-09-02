'use strict';

// scrollbackPreserve.js — pure leaf (zero IO, deterministic, never throws).
//
// 纯叶子:零 IO、确定性、env 门控、绝不抛、可单测。
//
// 目的:让 ink TUI 在 fullscreen 重绘时**不擦终端原生回滚缓冲(scrollback)**,使用户能向上
// 滚动查看中间历史(本次修复的 bug:「滚动查看历史要么在最上面,要么在最下面,无法滚到中间」)。
//
// 背景(诊断):khy 默认走 ink TUI,已提交历史走 ink `<Static>` + 终端原生 scrollback,本 TUI
// **不自管 transcript 滚动**。ink 在 live 区渲染高度 `lastOutputHeight >= stdout.rows` 时进入
// fullscreen 分支,执行 `stdout.write(ansiEscapes.clearTerminal + fullStaticOutput + output)`
// (node_modules/ink/build/ink.js:327、instance.js:132)。非 win32 的 clearTerminal =
// `\x1b[2J\x1b[3J\x1b[H`(node_modules/ansi-escapes/index.js:85-91),其中 **`\x1b[3J` 清空回滚
// 缓冲**。长输出时此分支反复触发 → scrollback 被持续擦除、视图弹回顶部 → 用户只剩当前帧。
//
// 修复(本叶子是「噪声定义」单一真源):在写给 ink 的 stdout 边界把 `\x1b[3J`(且仅它)剥掉,
// 保留 `\x1b[2J`(清屏)/`\x1b[H`(光标归位)→ fullscreen 重绘外观不变,但 scrollback 存活。
// 这一处统一覆盖 ink 的所有 clearTerminal 来源(稳态 fullscreen / 瞬时 spike / 缩放重绘)。
// 与 `liveRegionBudget`(尽量不触发 fullscreen)正交叠加:那是第一层「少触发」,本叶子是第二层
// 「即便触发也不擦回滚」。
//
// 平台差异(本叶子的第二处职责):两类终端都先剥离 clearTerminal 中的 `3J`,此外 win32 再
// 多做一步「清屏形式改写」。原因:conhost / Windows Terminal 的 **ED2(`[2J`)不是就地擦除**,
// 而是把当前视口整屏**向上滚进** scrollback 再填白 —— 于是 ink 每触发一次 fullscreen 分支,
// 回滚缓冲里就永久多出一份完整的 banner+输入框副本(用户报「UI 显示混乱 / 同一输入框重复两遍」)。
//
// 历史上试过反向**注入** `3J` 来压制,已刻意废弃:那会直接清空用户正在查看的原生 scrollback,
// 代价高于它修的症状。正解是第三条路 —— 把 `[2J[0f` 改写成等价的 `[H[J`:
//   `[H` 光标归位 + `[J`(ED0,从光标擦到屏幕末尾)。视觉终态与 ED2 完全一致(可视区清空、
//   光标在左上角),但 ED0 是**就地擦除**,既不滚屏 → 不留重复副本,也不碰 scrollback → 历史仍可上翻。
// 两个目标(去重复 / 保回滚)由此同时满足,不再二选一。
// 非 win32 的 `[2J` 本就是就地擦除,保持原样,逐字节不变。
//
// 第三层职责 —— 全屏帧「整段转录重发」抑制(门控 KHY_SUPPRESS_STATIC_REPRINT,默认开):
// ink 的 fullscreen 分支(ink.js:327 / instance.js:132,后者仅 experimental)每次都把
// `clearTerminal + fullStaticOutput + output` 作为**一次 write** 发出 —— fullStaticOutput 是
// 累积的**全部**已提交 <Static> 转录。即使清屏头已被改写成 ED0 就地擦除,只要
// (转录高度 + 活动帧高度) > 视口 rows,这次重写本身就**必然滚屏**,把重印的头部推进 scrollback
// —— 与增量提交时已写进终端的同一批消息形成第二、第三份完整副本(用户报「启动后历史重复几次」
// 的直接成因)。而重发是**纯冗余**:fullscreen 分支只在上一帧活动区已填满视口时触发,彼时
// 全部 static 内容早已通过增量提交写入终端(scrollback),视口里只剩活动区尾巴。本层识别该帧、
// 用 ink 实例的 `fullStaticOutput` 做**字节级前缀校验**(防误伤任何其他含清屏头的写入),校验
// 通过才把冗余转录段剥掉,只留「就地清屏 + 活动帧」。校验失败 / 实例缺失 / 门控关 → 逐字节
// 回退今日行为。跨 write 拆开的帧会被暂存到完整再校验,flush() 兜底归还,绝不吞字节。
//
// 第四层职责 —— 全屏帧「活区尾切」(门控 KHY_FULLSCREEN_TAILCUT,默认开):
// 第三层剥掉 static 后,帧变成 `ED0就地擦除 + 活动帧 output`。但 fullscreen 分支的触发条件恰是
// **活动帧自身高度 ≥ rows**(ink.js:322 `lastOutputHeight >= rows`),此时重印 output 的前
// (outputHeight - rows + 1) 行**必然把视口既有内容连同新帧头部一起滚进 scrollback**——每帧
// 滚一次,滚动出去的正是帧的头/尾行(工具行/输入框/页脚),在 scrollback 里逐帧堆叠成串副本
// (用户报「对话中重复渲染多次」;复现实验:纯 ink 6.8 + 本叶子三层门控全开,5 个 fullscreen
// 帧即积累 x6/x7/x8 重复行)。上游 ink 用 `3J` 每帧清空 scrollback 掩盖此滚动,而本叶子第二层
// 恰恰为保全 scrollback 剥掉了 `3J` —— 副本因此从「被掩盖」变成「永久积累」。正解不是恢复 3J,
// 而是从源头不让它滚:ED0 擦除后视口为空,被切掉的帧头行印出来也会**立刻**被滚动推出视口
// (它们在视口顶之外,用户从未看见),故把 output **尾切到 rows-1 行**(保留末尾行 + 光标不触底
// 不产生 pending-wrap)字节上等价于「可见终态完全一致」,却保证整帧不滚屏 → 零副本。下一帧的
// eraseLines 按 ink 未切记账多擦的行会被终端钳在视口顶内,擦的是空白,无害。切分按 `\n` 原始行
// 进行(ink renderer 输出的行是 Yoga 布局后的行,SGR 自包含);仅作用于**已通过字节级校验并成功
// 剥掉 static** 的帧(未经校验绝不切,宁可漏切不可错切);rows 经 options.getRows 注入(app.js
// 传 process.stdout.rows),取不到/≤1 → 不切,逐字节回退。跨 write 拆开的帧(framing 暂存路径)
// 因无法定位 output 边界而不切(罕见路径,滚动泄漏概率与本层收益均以直接路径为主)。
//
// 门控 KHY_PRESERVE_SCROLLBACK 默认开;关 → `normalizeClearTerminal`/`stripScrollbackClear`
// 原样返回 → ink 写出原字节 → 两平台都回退到 ink 的原始行为(win32 重复帧症状随之回归)。

const OFF_VALUES = ['0', 'false', 'off', 'no'];

// 待剥离的「清回滚缓冲」子序列 `\x1b[3J`。ESC 用显式 `` 构造(绝不在源码里嵌入不可见的
// 字面 ESC 字节,避免编辑/镜像时被吞)。注:仅此一序列被剥,`\x1b[2J`(清屏)/`\x1b[H`(归位)保留。
const SCROLLBACK_CLEAR = '[3J';

/**
 * ESC(0x1b)从本叶子自有的 SCROLLBACK_CLEAR 首字节派生,避免在源码里再嵌入不可见字面 ESC
 * 字节(编辑/四树镜像时易被吞)。下面是 win32 的 ink clearTerminal 与其「注入 3J」修正形式。
 */
const ESC = SCROLLBACK_CLEAR.charAt(0); // '\x1b'
// ink 6.x 依赖 ansi-escapes@7,其 clearTerminal 按 **isOldWindows()** 分支,而不是 platform:
//   老 conhost → `2J + 0f`;其余(含 Windows 10/11 + Windows Terminal)→ `2J + 3J + H`。
// 实测 Win11 走的是后者 —— 所以「win32 本就无 3J 可剥」是只对老 conhost 成立的旧结论,
// 两种形式都要能识别,否则改写会静默漏掉现代 Windows 这条主路径。
const WIN_CLEAR = `${ESC}[2J${ESC}[0f`; // 老 conhost 形式
const NIX_CLEAR = `${ESC}[2J${ESC}[3J${ESC}[H`; // 现代形式(Win11 亦然)
const CLEAR_VIEWPORT = `${ESC}[2J${ESC}[H`; // 现代形式剥掉 3J 之后的样子
// win32 的等价「就地清屏」形式,是上面三者在 win32 上的统一改写目标(理由见头注)。
// 注意顺序:必须先 `[H` 归位再 `[J` 擦到末尾 —— ED0 只擦光标之后,不归位就擦不干净整屏。
const WIN_CLEAR_INPLACE = `${ESC}[H${ESC}[J`;
// 兼容旧调用方的导出名:它即 win32 归一化后的目标序列。
const WIN_CLEAR_FIXED = WIN_CLEAR_INPLACE;

/**
 * scrollback 保全默认开;仅显式 falsy 关闭。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env = process.env) {
  const raw = env && env.KHY_PRESERVE_SCROLLBACK;
  const v = String(raw === null || raw === undefined ? '' : raw)
    .trim()
    .toLowerCase();
  return !OFF_VALUES.includes(v);
}

/**
 * 全屏帧「整段转录重发」抑制默认开;仅显式 falsy 关闭。
 * @param {object} [env]
 * @returns {boolean}
 */
function isReprintGuardEnabled(env = process.env) {
  const raw = env && env.KHY_SUPPRESS_STATIC_REPRINT;
  const v = String(raw === null || raw === undefined ? '' : raw)
    .trim()
    .toLowerCase();
  return !OFF_VALUES.includes(v);
}

/**
 * 全屏帧「活区尾切」默认开;仅显式 falsy 关闭。
 * @param {object} [env]
 * @returns {boolean}
 */
function isTailcutEnabled(env = process.env) {
  const raw = env && env.KHY_FULLSCREEN_TAILCUT;
  const v = String(raw === null || raw === undefined ? '' : raw)
    .trim()
    .toLowerCase();
  return !OFF_VALUES.includes(v);
}

/**
 * 从单次 stdout 写入块中剥离「清回滚缓冲」子序列 `\x1b[3J`,保留其余转义(`2J`/`H` 等)。
 *
 * 门控关 → 原样返回(逐字节回退)。非字符串(Buffer/undefined/…)→ 原样返回(ink 的
 * clearTerminal 帧恒为字符串;Buffer 不动,保守)。整体 try/catch 兜底:任何异常 → 返回原
 * 入参(失败软化,绝不破坏输出)。
 *
 * @param {*} chunk - stdout.write 的首参
 * @param {object} [env]
 * @returns {*} 过滤后的 chunk(或原样)
 */
function stripScrollbackClear(chunk, env = process.env) {
  try {
    if (!isEnabled(env)) {
      return chunk;
    }
    if (typeof chunk !== 'string') {
      return chunk;
    }
    if (chunk.indexOf(SCROLLBACK_CLEAR) === -1) {
      return chunk;
    }
    return chunk.split(SCROLLBACK_CLEAR).join('');
  } catch {
    return chunk;
  }
}

/**
 * 规范化 ink 写出的 clearTerminal 序列：所有平台都剥离 `\x1b[3J`，因此
 * fullscreen 重绘仍可清理当前可视区，但不会清空终端原生 scrollback。
 * Windows 的 ink 序列本身不含 3J，保持逐字节不变。
 *
 * @param {*} chunk - stdout.write 的首参
 * @param {object} [env]
 * @param {string} [platform] - 默认 process.platform;测试可显式传 'win32'/'linux'
 * @returns {*} 规范化后的 chunk(或原样)
 */
function normalizeClearTerminal(chunk, env = process.env, platform = process.platform) {
  try {
    if (!isEnabled(env)) {
      return chunk;
    }
    if (typeof chunk !== 'string') {
      return chunk;
    }
    // 第一步(两平台一致):剥 `3J`,保全原生 scrollback。
    const stripped = stripScrollbackClear(chunk, env);
    if (platform !== 'win32' || typeof stripped !== 'string') {
      return stripped;
    }
    // 第二步(仅 win32):把两种 ED2 清屏形式都换成就地擦除,避免旧视口被滚进 scrollback。
    // 此时 3J 已被剥掉,现代形式已塌缩为 CLEAR_VIEWPORT(`2J + H`)。
    let out = stripped;
    if (out.indexOf(WIN_CLEAR) !== -1) {
      out = out.split(WIN_CLEAR).join(WIN_CLEAR_INPLACE);
    }
    if (out.indexOf(CLEAR_VIEWPORT) !== -1) {
      out = out.split(CLEAR_VIEWPORT).join(WIN_CLEAR_INPLACE);
    }
    return out;
  } catch {
    return chunk;
  }
}

/**
 * 匹配文本开头的 clearTerminal 形式,返回其字节长度(不匹配 → 0)。
 * 覆盖四种形态:win32 归一化后的 `H+J`、剥 3J 后的 `2J+H`、老 conhost 原生 `2J+0f`、
 * 现代原生 `2J+3J+H`(KHY_PRESERVE_SCROLLBACK 关闭时归一化层不生效,原生形式直达本层)。
 * 四者互不为前缀,匹配无歧义;取最长命中。
 * @param {string} text
 * @returns {number}
 */
function _matchClearPrefix(text) {
  const candidates = [NIX_CLEAR, WIN_CLEAR, CLEAR_VIEWPORT, WIN_CLEAR_INPLACE];
  let hit = 0;
  for (const t of candidates) {
    if (text.startsWith(t) && t.length > hit) {
      hit = t.length;
    }
  }
  return hit;
}

/**
 * 解析一帧已组装完整的全屏帧:`clear + static + output` → `clear + output`。
 * static 段与快照**逐字节一致**才剥离;任何不一致原样返回(fail-soft,绝不误伤)。
 * 返回 `{ text, stripped }`:stripped=false 表示未识别为冗余重发(调用方绝不对其后处理)。
 * @param {string} frame
 * @param {number} clearLen
 * @param {string} snapshot
 * @returns {{ text: string, stripped: boolean }}
 */
function _resolveFullscreenFrame(frame, clearLen, snapshot) {
  if (frame.slice(clearLen, clearLen + snapshot.length) === snapshot) {
    return {
      text: frame.slice(0, clearLen) + frame.slice(clearLen + snapshot.length),
      stripped: true,
    };
  }
  return { text: frame, stripped: false };
}

/**
 * 活区尾切(第四层):把已剥掉 static 的全屏帧 output 尾切到 maxRows 个**视觉行**。
 *
 * 度量单位是「视觉行」而非「原始 \n 行」:一条宽于终端 columns 的原始行会被终端软换行成
 * ⌈displayWidth/columns⌉ 个视觉行,按原始行切会仍留超出视口的视觉高度 → 依旧滚屏。
 * 视觉行成本 = Σ ⌈displayWidth(line)/columns⌉(与 ink-components/liveHeightClamp 的
 * wrappedRows 同一口径;displayWidth 由调用方注入 —— CJK/emoji 感知、已剥 ANSI)。
 * 底部锚定:从末行向前累加,放不下的头部行舍弃。测量函数缺失 → 退化为按原始行尾切;
 * columns 不可用 → 每行记 1 视觉行(不换行假设,宁少切勿多切)。行数在预算内 → 原串
 * 同引用返回(热路径零改动);行内 SGR 自包含,切分不破坏样式;末尾 `\n` 状态由
 * split/join 的空末元素自然保留。
 * @param {string} text - 帧的 output 部分
 * @param {number} maxRows - 保留的最大视觉行数(≥1)
 * @param {function(string): number} [measureWidth] - 显示宽度函数(已剥 ANSI);缺省按字符数
 * @param {number} [columns] - 终端列数;非有限/≤0 → 每行记 1 视觉行
 * @returns {string}
 */
function _tailcutOutputToRows(text, maxRows, measureWidth, columns) {
  if (typeof text !== 'string' || !Number.isFinite(maxRows) || maxRows < 1) {
    return text;
  }
  const lines = text.split('\n');
  const cols = Number(columns);
  const colOk = Number.isFinite(cols) && cols > 0;
  const width = (line) => {
    if (typeof measureWidth !== 'function') {
      return String(line == null ? '' : line).length;
    }
    try {
      const w = Number(measureWidth(String(line == null ? '' : line)));
      return Number.isFinite(w) && w >= 0 ? w : 1;
    } catch {
      return 1;
    }
  };
  const rowsOf = (line) => {
    if (!colOk) {
      return 1;
    }
    const w = width(line);
    return w <= 0 ? 1 : Math.max(1, Math.ceil(w / cols));
  };
  // 从末行向前累加视觉行成本,预算耗尽即停(底部锚定,与 liveHeightClamp 同哲学)。
  // 注意:预算判定必须按**视觉行**进行 —— 原始行数 ≤ maxRows 不代表视觉行数 ≤ maxRows
  // (宽行软换行),故先完成累加再决定是否原样返回。末尾 `\n` 产生的空末元素不承载可见
  // 内容,先摘出、累加后按原状态补回(否则它会白占一行预算,把末行内容挤出去)。
  const hasTrailingNewline = lines.length > 1 && lines[lines.length - 1] === '';
  const visible = hasTrailingNewline ? lines.slice(0, -1) : lines;
  let used = 0;
  let start = visible.length - 1;
  while (start >= 0) {
    const cost = rowsOf(visible[start]);
    if (used + cost > maxRows) {
      break;
    }
    used += cost;
    start -= 1;
  }
  if (start < 0) {
    return text; // 整段都在预算内 → 原串同引用(热路径零改动)
  }
  // 连末行自身都放不下(cost > maxRows)→ 饱和保留末行整行(切无可切,诚实退化:单行
  // 自身超视口,宁可多占一行也不返回空帧)。
  const kept =
    start >= visible.length - 1
      ? visible.slice(-1)
      : visible.slice(start + 1);
  if (hasTrailingNewline) {
    kept.push('');
  }
  return kept.join('\n');
}

/**
 * 为 stdout.write() 创建有状态规范化器。Ink 通常一次写出完整全屏帧，但流包装器
 * 允许把清屏序列拆到多次 write()，也允许传 Buffer。这里只保留「可能是目标序列
 * 开头」的最长尾缀，序列完整后再规范化；最多暂存 WIN_CLEAR.length - 1 个字节。
 *
 * 第三层(可选,options.getStaticSnapshot 注入):组装完整的全屏帧若为
 * `clearTerminal + fullStaticOutput + output` 形态且 static 段与快照逐字节一致,
 * 剥掉冗余的整段转录重发。跨 write 拆开的帧暂存到 _framing 直至可判定,
 * flush() 归还全部未决字节。
 *
 * 第四层(可选,options.getRows / getColumns / measureWidth 注入):对第三层已成功剥掉
 * static 的帧,把活动帧 output 尾切到 rows-1 个**视觉行**,使 ED0 就地擦除后的重印不滚屏
 * (详见头注第四层)。
 *
 * 门控关闭时每次写入逐字节直通。flush() 返回尚未闭合的尾缀，供退出清理和测试使用。
 * @param {object} [env]
 * @param {string} [platform]
 * @param {{getStaticSnapshot?: function(): string|null, getRows?: function(): *,
 *           getColumns?: function(): *, measureWidth?: function(string): number}} [options]
 * @returns {{write:function(*):*,flush:function():string}}
 */
function createClearTerminalNormalizer(env = process.env, platform = process.platform, options = null) {
  let pending = '';
  // 第三层暂存区:已归一化但尚未组装完整的全屏帧(跨 write 拆开的 static 段)。
  // framingSnap 冻结暂存时刻的实例快照 —— 校验永远针对「写帧那一刻」的 fullStaticOutput,
  // 不在解析时重读(重读可能拿到已增长的缓冲,造成假阴性),也绝不拿帧自身切片自证
  // (那是同义反复,失去防误伤意义)。
  let framing = '';
  let framingClearLen = 0;
  let framingNeed = 0;
  let framingSnap = null;
  const getStaticSnapshot =
    options && typeof options.getStaticSnapshot === 'function' ? options.getStaticSnapshot : null;
  const getRows = options && typeof options.getRows === 'function' ? options.getRows : null;
  const getColumns =
    options && typeof options.getColumns === 'function' ? options.getColumns : null;
  const measureWidth =
    options && typeof options.measureWidth === 'function' ? options.measureWidth : null;

  // 第四层:对已成功剥离 static 的帧 output 做视口内尾切。任何一步不满足
  // (门控关 / rows 不可用 / rows≤1)→ 原样返回,逐字节回退。
  function _applyTailcut(strippedFrame, clearLen) {
    if (!isTailcutEnabled(env) || !getRows) {
      return strippedFrame;
    }
    let rows = NaN;
    try {
      rows = Number(getRows());
    } catch {
      return strippedFrame;
    }
    if (!Number.isFinite(rows) || rows < 2) {
      return strippedFrame;
    }
    let columns = NaN;
    if (getColumns) {
      try {
        columns = Number(getColumns());
      } catch {
        columns = NaN;
      }
    }
    const output = strippedFrame.slice(clearLen);
    const cut = _tailcutOutputToRows(output, Math.floor(rows) - 1, measureWidth, columns);
    if (cut === output) {
      return strippedFrame;
    }
    return strippedFrame.slice(0, clearLen) + cut;
  }

  function write(chunk) {
    try {
      if (!isEnabled(env)) {
        return chunk;
      }
      const isBuffer = Buffer.isBuffer(chunk);
      if (typeof chunk !== 'string' && !isBuffer) {
        return chunk;
      }
      // win32 还要识别被拆开的 `[2J[0f`(8 字节),否则半截序列会漏过改写。
      const tokens = platform === 'win32'
        ? [SCROLLBACK_CLEAR, WIN_CLEAR, CLEAR_VIEWPORT, NIX_CLEAR]
        : [SCROLLBACK_CLEAR];
      const longest = tokens.reduce((a, t) => (t.length > a ? t.length : a), 0);
      const text = pending + (isBuffer ? chunk.toString('utf8') : chunk);
      pending = '';

      // 只暂存「可能是某个 token 的真前缀」的最长尾缀;已完整的 token 不留,立即归一化。
      let keep = 0;
      const max = Math.min(longest - 1, text.length);
      for (let n = max; n > 0; n -= 1) {
        if (tokens.some((t) => t.length > n && text.endsWith(t.slice(0, n)))) {
          keep = n;
          break;
        }
      }

      const ready = keep > 0 ? text.slice(0, -keep) : text;
      pending = keep > 0 ? text.slice(-keep) : '';
      const normalized = normalizeClearTerminal(ready, env, platform);
      if (!isReprintGuardEnabled(env) || !getStaticSnapshot) {
        return isBuffer ? Buffer.from(normalized, 'utf8') : normalized;
      }

      // ── 第三层:全屏帧整段转录重发抑制 ──────────────────────────────────────
      if (framing) {
        // 正在累积一帧跨 write 拆开的全屏帧:追加并判定是否已可解析。
        framing += normalized;
        if (framing.length < framingNeed) {
          return isBuffer ? Buffer.from('', 'utf8') : '';
        }
        const resolved = _resolveFullscreenFrame(framing, framingClearLen, framingSnap);
        // framing 路径无法定位 output 边界(帧后可能拼有后续帧字节),不做第四层尾切。
        const out = resolved.text;
        framing = '';
        framingClearLen = 0;
        framingNeed = 0;
        framingSnap = null;
        return isBuffer ? Buffer.from(out, 'utf8') : out;
      }

      const clearLen = _matchClearPrefix(normalized);
      if (!clearLen) {
        return isBuffer ? Buffer.from(normalized, 'utf8') : normalized;
      }
      let snap = null;
      try {
        snap = getStaticSnapshot();
      } catch {
        snap = null;
      }
      if (typeof snap !== 'string') {
        // 快照不可用(实例未注册 / 内部结构变化)→ 无法校验,逐字节回退今日行为。
        // 注意:空串是**合法**快照(会话尚无 static)——帧本就是 `clear + output`,
        // 剥离为零长度、校验平凡成立,第四层尾切照常生效(会话初期的长流式回答正是
        // 最先触顶的场景,不能因快照为空而跳过)。
        return isBuffer ? Buffer.from(normalized, 'utf8') : normalized;
      }
      const need = clearLen + snap.length;
      if (normalized.length < need) {
        // static 段被流包装器拆到后续 write:暂存,凑齐再判,绝不提前吐出半帧。
        framing = normalized;
        framingClearLen = clearLen;
        framingNeed = need;
        framingSnap = snap;
        return isBuffer ? Buffer.from('', 'utf8') : '';
      }
      const resolved = _resolveFullscreenFrame(normalized, clearLen, snap);
      if (!resolved.stripped) {
        // static 与快照不一致 → 非冗余重发,绝不剥也绝不切(fail-soft)。
        return isBuffer ? Buffer.from(resolved.text, 'utf8') : resolved.text;
      }
      // 第四层:已验证的 `clear + output` 帧 → 活区尾切到视口内,保证不滚屏。
      const out = _applyTailcut(resolved.text, clearLen);
      return isBuffer ? Buffer.from(out, 'utf8') : out;
    } catch {
      pending = '';
      framing = '';
      framingClearLen = 0;
      framingNeed = 0;
      framingSnap = null;
      return chunk;
    }
  }

  function flush() {
    const rest = framing + pending;
    framing = '';
    framingClearLen = 0;
    framingNeed = 0;
    framingSnap = null;
    pending = '';
    return rest;
  }

  return { write, flush };
}

module.exports = {
  isEnabled,
  isReprintGuardEnabled,
  isTailcutEnabled,
  stripScrollbackClear,
  normalizeClearTerminal,
  createClearTerminalNormalizer,
  OFF_VALUES,
  SCROLLBACK_CLEAR,
  WIN_CLEAR,
  NIX_CLEAR,
  CLEAR_VIEWPORT,
  WIN_CLEAR_INPLACE,
  WIN_CLEAR_FIXED,
  _tailcutOutputToRows,
};

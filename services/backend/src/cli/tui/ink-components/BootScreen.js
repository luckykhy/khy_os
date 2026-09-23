'use strict';

/**
 * BootScreen — 启动期节拍表的 TUI 渲染器。
 *
 * 真源：节拍与状态 = [DESIGN-ARCH-115]（`cli/startupBeats.js`）；视觉 = [DESIGN-ARCH-134]（本文）。
 *
 * 本组件**只渲染，不持有节拍状态**。状态在 `cli/startupBeats.js`（启动板块单一真源），
 * TUI / 经典 / pre-Ink 三个渲染器都消费它 —— 这是 [DESIGN-ARCH-102] P8
 * 「一条路径胜过两条」在启动板块的落法。
 *
 * 状态渲染映射：
 *   done              `✓` 绿
 *   active            `⠋` 青（spinner）
 *   failed / critical `✗` 红 —— 阻断，附一行可操作指引
 *   failed / 非 critical `⚠` 黄 —— 降级，启动继续
 *   pending           `·` 灰
 *
 * 视觉契约（[DESIGN-ARCH-134] §3，本次新增的部分）：
 *   1. **水平居中**：根 Box `alignItems: 'center'`。ink 根节点宽度被硬设为终端列数
 *      （`node_modules/ink/build/ink.js:242`）⇒ 竖排容器的子 Box 默认 stretch 满宽，内容左对齐；
 *      给根 Box 加 `alignItems: 'center'` 即居中，**不需要任何尺寸 props**（先例 `CcLogo.js:24`）。
 *   2. **`alignItems` 是逐子元素居中** —— 所以六拍行必须包进一个
 *      `alignItems: 'flex-start'` 的内层 column Box，只让内层这一层居中，否则每行各自居中、
 *      左边缘参差。品牌块同理。
 *   3. **进度行**：复用 `ProgressBar`（kind='count'），**不写第二个进度条实现**。
 *      数据来自 `beats.progress()`（done/total/elapsedMs），耗时格式化复用
 *      `cli/bootPhaseLine.js` 的 `_elapsedMsToStr` —— 同一份人读时长口径。
 *   4. **品牌块**：`cli/tui/logoArt.js` 的一份四叶草 + 字标 + tagline，与欢迎横幅共用同一资产。
 *      按档位降级（F→G→H→I→J），档位由 `cli/tui/bootLayout.js` 的 H1 阶梯决定。
 *
 * 门控 KHY_BOOT_SCREEN：
 *   '1' / 默认   渲染本组件（消费 startupBeats）
 *   '0'          父级跳过本组件，直接进主 UI
 *   'legacy'     同 '0' —— 回退到「引入节拍表之前」的行为。
 *                注意：这不是「恢复旧的四步加载屏」。旧加载屏本身就是被替换的对象，
 *                而引入它之前的启动行为正是「没有启动屏、直接进主 UI」，即 '0' 的语义。
 *
 * 可选 props（App 下发，H8 合规：组件自己不读 process.stdout）：
 *   rows  终端行数 → 决定品牌块档位；缺省时 bootLayout 落 I 档（帧高 15 ≤ 现状 17 ⇒ 不比以前差）
 *   cols  终端列数 → `< 40` 时放弃居中（内容块约 34 列，再窄会折行错位）
 */

const React = require('react');
const inkRuntime = require('../inkRuntime');
const { beats, STATUS } = require('../../startupBeats');
const { cloverRows, WORDMARK, TAGLINE } = require('../logoArt');
const { plan } = require('../bootLayout');
const ProgressBar = require('./ProgressBar');
const { _elapsedMsToStr } = require('../../bootPhaseLine');

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
// ⚠️ 帧间隔此处仍是硬编码 80ms。与 [DESIGN-ARCH-102] §5.3 C9（160ms）及
// tui/AGENTS.md §3.3（80ms）的取值冲突尚未裁决（[DESIGN-ARCH-115] §2.2）；
// 收敛进 ccTimers.TIMING.spinner.interval 属 P1（D10），本轮不动。
const FRAME_MS = 80;

const OFF_VALUES = ['0', 'false', 'off', 'no', 'legacy'];

// logoArt 的三档明暗 → ink 颜色。`D` = 暗边（green + dim），`M` = 主体，`B` = 高光。
const SHADE_COLOR = { D: 'green', M: 'green', B: 'greenBright' };

function isBootScreenEnabled(env = process.env) {
  const v = String((env && env.KHY_BOOT_SCREEN) || '').trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

/**
 * 订阅节拍真源。组件自己驱动重绘，不依赖父组件的渲染周期 ——
 * 历史实现把 tracker 的 `steps` 当 prop 传进来，而 tracker 的 notify 无人订阅，
 * 进度条只在父级因别的理由重绘时「顺带」前进。
 *
 * @param {object} [tracker] 注入的 tracker（测试用）；默认用模块级单例。
 */
function useBeats(tracker) {
  const src = tracker || beats;
  const [steps, setSteps] = React.useState(() => src.beats);
  React.useEffect(() => src.subscribe(() => setSteps(src.beats)), [src]);
  return steps;
}

/** 耗时 ≥ 1s 才显示：前 1 秒「0ms」比不显示更吵。 */
function progressLabel(elapsedMs) {
  const n = Number(elapsedMs) || 0;
  return n >= 1000 ? `启动中 · ${_elapsedMsToStr(n)}` : '启动中';
}

/**
 * @param {{tracker?: object, rows?: number, cols?: number}} props
 */
function BootScreen({ tracker, rows, cols }) {
  const { Box, Text } = inkRuntime.get();
  const h = React.createElement;
  const src = tracker || beats;
  const steps = useBeats(src);
  const [frame, setFrame] = React.useState(0);

  React.useEffect(() => {
    const id = setInterval(() => {
      setFrame((f) => (f + 1) % FRAMES.length);
    }, FRAME_MS);
    return () => clearInterval(id);
  }, []);

  // 帧高阶梯 + 是否居中。纯函数，零 IO；rows 缺省 ⇒ 保守档（不比改造前差）。
  const layout = plan({ rows, cols });
  const prog = src.progress();

  // 品牌块（整块作为一个子元素参与居中，内部左齐）。
  const brandChildren = [];
  if (layout.clover) {
    cloverRows().forEach((cells, i) => {
      brandChildren.push(
        h(
          Text,
          { key: `clover-${i}` },
          ...cells.map((c, j) =>
            c.ch === ' '
              ? h(Text, { key: `c${i}-${j}` }, ' ')
              : h(
                  Text,
                  {
                    key: `c${i}-${j}`,
                    color: SHADE_COLOR[c.shade] || 'green',
                    dimColor: c.shade === 'D',
                  },
                  c.ch
                )
          )
        )
      );
    });
  }
  if (layout.wordmark) {
    brandChildren.push(h(Text, { key: 'wordmark', bold: true, color: 'green' }, WORDMARK));
  }
  if (layout.tagline) {
    brandChildren.push(h(Text, { key: 'tagline', dimColor: true }, TAGLINE));
  }

  const stepRows = steps.map((step) => {
    const done = step.status === STATUS.DONE;
    const failed = step.status === STATUS.FAILED;
    const active = step.status === STATUS.ACTIVE;

    let glyph = '·';
    let color = 'gray';
    let dim = true;
    if (done) {
      glyph = '✓';
      color = 'green';
      dim = false;
    } else if (failed) {
      // critical 的失败是阻断（红），非 critical 是降级（黄）—— [DESIGN-ARCH-115] §6
      glyph = step.critical ? '✗' : '⚠';
      color = step.critical ? 'red' : 'yellow';
      dim = false;
    } else if (active) {
      glyph = FRAMES[frame];
      color = 'cyan';
      dim = false;
    }

    return h(
      Box,
      { key: step.id },
      h(Text, { dimColor: dim }, '  '),
      h(Text, { dimColor: dim, color }, glyph + ' '),
      h(Text, { dimColor: dim, color }, step.label),
      failed && step.note ? h(Text, { dimColor: true }, '  ' + step.note) : null
    );
  });

  // 底部汇总：阻断优先，其次降级。恒定 1 行（[DESIGN-ARCH-102] H10 单槽瞬时信息只有一条）。
  const blocking = src.blockingFailure();
  const degraded = src.degraded();
  let tailRow = null;
  if (blocking) {
    tailRow = h(Text, { key: 'blocking', color: 'red' }, '  → ' + (blocking.note || '启动中断'));
  } else if (degraded.length > 0) {
    tailRow = h(Text, { key: 'degraded', color: 'yellow' }, `  ! ${degraded.length} 项降级，Ctrl+O 查看`);
  }

  return h(
    Box,
    {
      flexDirection: 'column',
      alignItems: layout.center ? 'center' : 'flex-start',
      paddingX: 2,
      paddingY: 1,
    },
    // 品牌三行**各自**居中（经典 splash 的对称形态）。
    // ⚠ 不要把品牌块包进内层 Box 再整体居中：内层 Box 的宽度 = 最宽的子行（tagline 27 列），
    //   四叶草（13 列）会被带着一起左移 7 列，视觉上偏到左边。实测 ink_width_probe 证实。
    // 节拍块则必须保持一个内层 flex-start Box：六行 label 要左边缘对齐，整块才居中。
    ...brandChildren,
    h(Text, { key: 'gap', dimColor: true }, ''),
    // 进度行：复用 ProgressBar；百分比说的是「N 拍里完成了 M 拍」，不是时间进度。
    h(ProgressBar, {
      key: 'progress',
      kind: 'count',
      current: prog.done,
      total: prog.total,
      label: progressLabel(prog.elapsedMs),
    }),
    // 节拍块：同理包一层，否则六行 label 各自居中、左边参差。
    h(
      Box,
      { key: 'beats', flexDirection: 'column', alignItems: 'flex-start' },
      ...stepRows,
      tailRow
    ),
    h(Text, { key: 'tail-gap', dimColor: true }, '')
  );
}

module.exports = { BootScreen, isBootScreenEnabled, useBeats };

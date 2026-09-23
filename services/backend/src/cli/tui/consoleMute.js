'use strict';

/**
 * consoleMute — TUI 会话期间把 winston 的**控制台**通道请出屏幕（BUG-13）。
 *
 * 为什么需要它：winston 的 Console transport 写的是 `console._stdout.write` /
 * `console._stderr.write`（见 node_modules/winston/lib/winston/transports/console.js），
 * 而 ink 的 `patchConsole` 只替换 `console.log/warn/...` 这 18 个**方法**，不碰
 * `console._stdout`。于是任何一条 `logger.warn(...)` 都绕开 ink 注入的 stdout 流
 * **和它的帧高账本**，直接落在终端上 —— ink 下一次 `eraseLines` 擦不到它，
 * 用户看到的就是「英文内部日志压在状态栏下面、重绘后还残留」（BUG-13；BUG-17 的
 * Watchdog 行、BUG-29 的陈旧行都属这一族）。
 *
 * 这里只动**音量**，不动**记录**：文件 transport（DailyRotateFile，落 `.khy/logs/`
 * 由 storagePaths 动态解析）全程照写，日志一条都不丢，只是不再打屏。
 * 退出 TUI 时如实恢复原级别，回落到 REPL / shell 后日志音量与进入前一致。
 *
 * 真源复用：音量调节走 `src/utils/logger.js` 已有的 `setConsoleLevel`（CLI 启动时
 * `bin/khy.js` 调的也是它），本模块不自己摸 transport。logger 由调用方注入，
 * 本模块零 require、零 IO、绝不抛 —— 音量这种事绝不该拖垮启动路径。
 */

/**
 * 静音控制台通道，并给出恢复器。
 *
 * @param {{setConsoleLevel?:Function, transports?:Array}} [logger] 日志门面（注入，不 require）
 * @param {object} [env] 环境量（默认 process.env），门控 `KHY_TUI_CONSOLE_LOG`
 * @returns {{muted: boolean, previous: string|undefined, restore: () => boolean}}
 *   `muted` 是否真的改到了；`restore()` 恢复并返回是否恢复到有值可恢复的程度。
 *   门控关闭 / 门面不具备能力 / 中途抛错 ⇒ `muted:false`、`restore()` 为 no-op（逐字节回退今日行为）。
 */
function muteConsoleForSession(logger, env = process.env) {
  const noop = { muted: false, previous: undefined, restore: () => false };
  try {
    // 逃生阀：想看打屏日志（调试 TUI 内部行为）时设 KHY_TUI_CONSOLE_LOG=1 回到旧行为。
    if (String((env && env.KHY_TUI_CONSOLE_LOG) || '').trim() === '1') return noop;
    if (!logger || typeof logger.setConsoleLevel !== 'function') return noop;

    // 记下当前级别以便如实恢复。门面没有 console transport（如 NODE_ENV=production）
    // 时 previous 为 undefined，setConsoleLevel 也会返回 false —— 那就什么都没改，
    // restore 也无须改回去。
    const consoleTransport = Array.isArray(logger.transports)
      ? logger.transports.find((t) => t && t.name === 'console')
      : null;
    const previous = consoleTransport ? consoleTransport.level : undefined;

    const muted = logger.setConsoleLevel('silent') === true;
    if (!muted) return Object.assign({}, noop, { previous });
    return {
      muted: true,
      previous,
      restore: () => {
        try {
          // 恢复策略：有记录值就回到记录值；没有就退回 'info'（winston 的常见默认），
          // 绝不留下 'silent' —— 那会让 TUI 之后的整段会话静默丢日志。
          return logger.setConsoleLevel(previous || 'info') === true;
        } catch {
          return false;
        }
      },
    };
  } catch {
    return noop;
  }
}

module.exports = { muteConsoleForSession };

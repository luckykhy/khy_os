'use strict';

/**
 * bootPhaseLine.js — 启动引导阶段的「瞬时进度行」。
 *
 * 修的问题:引导进度用 `\r` 反复覆写同一行(`  ⏳ 加载环境配置...`),行尾不带换行,
 * 于是光标始终停在这一行的中间。启动路径上别处的输出 —— ensureAuthenticated 的
 * 「ℹ 已登录」、_scheduleStartupUpdateCheck 的版本通知、bootstrap 各步骤的 ⚠ 警告 ——
 * 都会从那个位置继续写,把进度行和通知糊成一行。实测捕获:
 *   `  🔄 准备运行环境 ...  ℹ 已登录: mfplg075`
 * 进度行本该是瞬时的、用完即抹,却因此变成一条永久残留的半截行。
 *
 * 做法:进度行「点亮」期间接管 console.log/info/warn/error,在真正输出之前先
 * `\r\x1b[K` 擦掉整行、把光标让回行首;擦完即标记熄灭,直到下一次 write() 重新点亮。
 *
 * 光包 console.* 不够:winston 的 Console transport 走 `console._stdout.write`,inquirer 走
 * readline/stdout,两者都绕开 console.*。所以进度行亮着的这段时间里同时给
 * process.stdout.write 挂一层让位 —— 但只挂这一小段:第一笔写入让完位就立刻把这条最热的
 * 路径还原,进度行熄灭 / end() 也各自还原一次,绝不让包装层活到 TUI 稳态。
 *
 * 与 promptOutputGuard 的关系:那一个管「提问期间把 console 输出暂存后补发」,这一个管
 * 「输出落地前先让出瞬时行」。二者都靠包装 console.* 生效,且都在 finally/end() 里还原
 * 自己那一层;本模块在 main() 最开头装、提问闸门在提问期间装,天然内外嵌套,不冲突。
 *
 * 门控 KHY_BOOT_PHASE_LINE(默认开;仅 0/false/off/no 关)。关 → create() 返回空实现,
 * 逐字节回退到「不显示引导进度行」的行为。
 * 失败软化:stderr 不可写、console 被别处换过等情况一律吞掉 —— 引导本身永远优先。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

// 需要让位的 console 方法。绕开 console 的直写(winston / inquirer)另由 stdout 让位层兜住。
const METHODS = ['log', 'info', 'warn', 'error'];

// 擦除整行并把光标收回行首。CSI K 只清光标到行尾,配合 \r 才是「整行清空」。
const CLEAR_LINE = '\r\x1b[K';

/**
 * 进度行是否启用。默认开;仅显式 0/false/off/no 关。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env = process.env) {
  try {
    const raw = env && env.KHY_BOOT_PHASE_LINE;
    if (raw === undefined || raw === null) {
      return true;
    }
    return !OFF_VALUES.includes(String(raw).trim().toLowerCase());
  } catch {
    return true;
  }
}

/**
 * 门控关闭时的空实现:两个方法都存在,调用方无需分支判断。
 * @returns {{write: function(string): void, end: function(): void}}
 */
function _noopHandle() {
  return { write() {}, end() {} };
}

// 格式化已等待毫秒 → 人类可读:「320ms」「3.2s」「1m 04s」。
function _elapsedMsToStr(ms) {
  const v = Math.max(0, ms | 0);
  if (v < 1000) return `${v}ms`;
  const s = v / 1000;
  if (s < 60) return `${s.toFixed(1).replace(/\.0$/, '')}s`;
  const m = Math.floor(s / 60);
  const rs = Math.floor(s - m * 60);
  return `${m}m ${String(rs).padStart(2, '0')}s`;
}

/**
 * 创建一条瞬时进度行,并在其存活期间接管 console.*。
 *
 * 每次 write(text[, totalSteps]) 点亮后,若未传 totalSteps,则启动 1s 间隔的
 * elapsed 时钟(显示「已等待 Xs」);传 totalSteps(整数 > 0)时改用步骤分母
 * 显示「text 2/5」,并停止 elapsed 时钟(由调用方控制步进节奏)。
 *
 * @param {object} [options]
 * @param {object} [options.env] - 门控环境(测试注入)
 * @param {{write: function(string): *}} [options.stream] - 进度行输出流,默认 process.stderr
 * @param {object} [options.console] - 被接管的 console 对象(测试注入)
 * @param {{write: function(string): *}} [options.stdout] - 被让位的 stdout,默认 process.stdout
 * @returns {{write: function(string, [number]): void, end: function(): void}}
 *   write(text, totalSteps?) 覆写进度行;end() 擦掉进度行并还原所有接管。两者均可重复调用。
 */
function create(options = {}) {
  const env = options.env || process.env;
  if (!isEnabled(env)) {
    return _noopHandle();
  }

  const stream = options.stream || process.stderr;
  const sink = options.console || console;
  const out = options.stdout || process.stdout;

  let live = false;
  let ended = false;
  let stdoutPatch = null;
  let phaseStartHr = 0;
  let elapsedTimer = null;
  let lastText = '';
  let lastStep = 0;
  let lastTotalSteps = 0;

  const unpatchStdout = () => {
    if (!stdoutPatch) {
      return;
    }
    const { target, original } = stdoutPatch;
    stdoutPatch = null;
    try {
      target.write = original;
    } catch {
      /* 还原不了也不能抛 */
    }
  };

  const stopElapsedTimer = () => {
    if (elapsedTimer) {
      clearInterval(elapsedTimer);
      elapsedTimer = null;
    }
  };

  // 渲染一行进度:
  //   有 step/totalSteps  →  `text (step/total)`
  //   无 step/totalSteps  →  `text (已等待 Xs)`  或 `text`  (0ms)
  const _renderLine = (text, step, totalSteps, elapsedMs) => {
    let display = text;
    const hasStep = Number.isInteger(totalSteps) && totalSteps > 0 && Number.isInteger(step) && step > 0;
    if (hasStep) {
      display = `${text} (${step}/${totalSteps})`;
    }
    const suffix = hasStep ? '' : elapsedMs > 0 ? ` (已等待 ${_elapsedMsToStr(elapsedMs)})` : '';
    return `\r  ${display}${suffix}...\x1b[K`;
  };

  const clear = () => {
    unpatchStdout();
    stopElapsedTimer();
    if (!live) {
      return;
    }
    live = false;
    try {
      stream.write(CLEAR_LINE);
    } catch {
      /* 终端可能已关闭 */
    }
  };

  const patchStdout = () => {
    if (stdoutPatch || !out || typeof out.write !== 'function') {
      return;
    }
    const original = out.write;
    stdoutPatch = { target: out, original };
    out.write = (...args) => {
      clear();
      return original.apply(out, args);
    };
  };

  const original = {};
  for (const m of METHODS) {
    const prev = sink[m];
    if (typeof prev !== 'function') {
      continue;
    }
    original[m] = prev;
    sink[m] = (...args) => {
      clear();
      return prev.apply(sink, args);
    };
  }

  return {
    /**
     * 覆写进度行。
     * @param {string} text - 阶段文本
     * @param {number} [step] - 当前步骤号(1-based)
     * @param {number} [totalSteps] - 总步骤数;step+totalSteps 同时传时显示「(step/total)」,
     *   否则(仅 text)显示已等待 elapsed 时钟(≥1s 后开始)
     */
    write(text, step, totalSteps) {
      if (ended) {
        return;
      }
      stopElapsedTimer();
      lastText = text;
      lastStep = Number.isInteger(step) ? step : 0;
      lastTotalSteps = Number.isInteger(totalSteps) ? totalSteps : 0;
      phaseStartHr = process.hrtime.bigint();
      try {
        stream.write(_renderLine(text, lastStep, lastTotalSteps, 0));
        live = true;
        // 有步骤分母时保持静态(由调用方控制步进节奏);无分母时每 1s 刷新 elapsed
        if (!lastTotalSteps) {
          elapsedTimer = setInterval(() => {
            if (!live || ended) {
              stopElapsedTimer();
              return;
            }
            try {
              const ms = Number(process.hrtime.bigint() - phaseStartHr) / 1e6;
              stream.write(_renderLine(lastText, 0, 0, ms));
            } catch {
              /* stderr 不可写 */
            }
          }, 1000);
          if (elapsedTimer.unref) {
            elapsedTimer.unref();
          }
        }
      } catch {
        /* stderr 不可写时静默 */
        return;
      }
      patchStdout();
    },
    end() {
      if (ended) {
        return;
      }
      ended = true;
      stopElapsedTimer();
      clear();
      for (const m of METHODS) {
        if (typeof original[m] === 'function') {
          sink[m] = original[m];
        }
      }
    },
  };
}

module.exports = {
  create,
  isEnabled,
  _elapsedMsToStr, // export for tests
  METHODS,
  OFF_VALUES,
  CLEAR_LINE,
};

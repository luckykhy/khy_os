"""
khy 终端 UI 工具 —— 零外部依赖的彩色输出、spinner、进度条。

仅在 stderr 输出彩色/动画效果，不污染 stdout（stdout 保留给机器可读输出）。
非 TTY 环境自动降级为纯文本，日志友好。
"""
from __future__ import annotations

import itertools
import os
import sys
import threading
import time


# ── ANSI 转义码 ────────────────────────────────────────────────
_STYLES = {
    "bold": "\033[1m",
    "dim": "\033[2m",
    "reset": "\033[0m",
}

_COLORS = {
    "red": "\033[31m",
    "green": "\033[32m",
    "yellow": "\033[33m",
    "blue": "\033[34m",
    "magenta": "\033[35m",
    "cyan": "\033[36m",
    "white": "\033[37m",
    "bright_red": "\033[91m",
    "bright_green": "\033[92m",
    "bright_yellow": "\033[93m",
}

# 终端环境检测（全局缓存一次）
_IS_TTY = bool(getattr(sys.stderr, "isatty", lambda: False)())
# 环境变量 NO_COLOR / KHY_NO_COLOR 可强制禁用颜色
_NO_COLOR = (
    os.environ.get("NO_COLOR", "") == "1"
    or os.environ.get("KHY_NO_COLOR", "") == "1"
)


def _colorize(text: str, fg: str | None = None, style: str | None = None) -> str:
    """对文本应用 ANSI 颜色/样式（非 TTY 或 NO_COLOR 时原样返回）。"""
    if not _IS_TTY or _NO_COLOR:
        return text
    parts = []
    if style and style in _STYLES:
        parts.append(_STYLES[style])
    if fg and fg in _COLORS:
        parts.append(_COLORS[fg])
    parts.append(text)
    parts.append(_STYLES["reset"])
    return "".join(parts)


# ── 状态标记（对标 _PF_MARK，新增彩色版）───────────────────────

def ok(text: str = " OK ") -> str:
    """✅ 绿色 [ OK ] 标记"""
    return _colorize(f"[{text}]", fg="green", style="bold")


def warn(text: str = "WARN") -> str:
    """⚠️ 黄色 [WARN] 标记"""
    return _colorize(f"[{text}]", fg="yellow", style="bold")


def fail(text: str = "FAIL") -> str:
    """❌ 红色 [FAIL] 标记"""
    return _colorize(f"[{text}]", fg="red", style="bold")


def info(text: str = "INFO") -> str:
    """ℹ️ 青色 [INFO] 标记"""
    return _colorize(f"[{text}]", fg="cyan")


def dim(text: str) -> str:
    """灰色辅助文字"""
    return _colorize(text, style="dim")


# ── Spinner ─────────────────────────────────────────────────────
# 使用 threading 在后台线程运行动画，不阻塞主任务。

_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
# Windows 回退：cmd 和旧终端不支持 braile 字符
_WIN_FALLBACK_FRAMES = ["|", "/", "-", "\\"]


class Spinner:
    """轻量级 spinner —— 在后台线程运行动画。

    用法：
        with Spinner("正在加载") as s:
            do_slow_work()
            s.text = "即将完成..."
            do_more_work()
        # 退出 with 块时自动停止 spinner，打印 [ OK ]
    """

    def __init__(
        self,
        text: str = "",
        *,
        stream=None,
        ok_text: str = "OK",
        fail_text: str = "FAIL",
    ):
        self._text = text
        self._stream = stream or sys.stderr
        self._ok_text = ok_text
        self._fail_text = fail_text
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._frames = _WIN_FALLBACK_FRAMES if os.name == "nt" else _SPINNER_FRAMES
        self._frame_cycle = itertools.cycle(self._frames)
        self._result = True

    def __enter__(self):
        if not _IS_TTY:
            # 非 TTY：直接打印文字，不启动 spinner 线程
            if self._text:
                self._stream.write(f"[khy] {self._text}...\n")
                self._stream.flush()
            return self
        self._start()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self._result = exc_type is None
        self._stop.set()
        if self._thread:
            self._thread.join(0.5)
            self._thread = None
        status = ok(self._ok_text) if self._result else fail(self._fail_text)
        if _IS_TTY:
            # 覆盖 spinner 帧
            self._stream.write(f"\r{status} {self._text}\n")
        else:
            self._stream.write(f"{status} {self._text}\n")
        self._stream.flush()

    def _start(self):
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self):
        while not self._stop.is_set():
            frame = next(self._frame_cycle)
            msg = f"\r{frame} {self._text}..."
            self._stream.write(msg)
            self._stream.flush()
            self._stop.wait(0.12)

    @property
    def text(self) -> str:
        return self._text

    @text.setter
    def text(self, value: str):
        self._text = value


# ── 进度条 ──────────────────────────────────────────────────────

class ProgressBar:
    """在 stderr 上绘制进度条，带速度/ETA 计算。

    用法：
        pb = ProgressBar("下载中", total=100)
        for i in range(100):
            do_chunk()
            pb.advance(1)
        pb.finish()
    """

    def __init__(self, label: str, total: int = 0, *, width: int = 30, stream=None):
        self.label = label
        self.total = total
        self._width = width
        self._stream = stream or sys.stderr
        self._done = 0
        self._start_time = time.time()
        self._last_write = 0.0
        self._finished = False

    def advance(self, n: int = 1):
        self._done += n
        self._draw()

    def set(self, value: int):
        self._done = value
        self._draw()

    def finish(self):
        self._finished = True
        self._draw()
        if _IS_TTY:
            self._stream.write("\n")
        else:
            self._stream.write("\n")
        self._stream.flush()

    def _draw(self):
        if not _IS_TTY:
            # 非 TTY：每 5 秒打印一次进度文字
            now = time.time()
            if now - self._last_write < 5:
                return
            self._last_write = now
            if self.total > 0:
                pct = int(self._done * 100 / self.total)
                self._stream.write(f"[khy] {self.label}: {pct}%\n")
            else:
                self._stream.write(f"[khy] {self.label}: {self._done}\n")
            self._stream.flush()
            return

        elapsed = time.time() - self._start_time
        if self.total > 0:
            pct = self._done / self.total
            filled = int(self._width * pct)
            bar = "█" * filled + "░" * (self._width - filled)
            speed = self._done / elapsed if elapsed > 0 else 0
            if speed > 0 and self._done < self.total:
                remaining = (self.total - self._done) / speed
                eta = f" ETA {remaining:.0f}s"
            else:
                eta = ""
            self._stream.write(
                f"\r{khy_prefix()} {bar} {pct * 100:.0f}% "
                f"({_fmt_size(self._done)}/{_fmt_size(self.total)}) "
                f"{_fmt_speed(speed)}{eta}"
            )
        else:
            speed = self._done / elapsed if elapsed > 0 else 0
            self._stream.write(
                f"\r{khy_prefix()} {self.label}: {_fmt_size(self._done)} "
                f"{_fmt_speed(speed)}"
            )
        self._stream.flush()

    def close(self):
        if not self._finished:
            self.finish()


def _fmt_size(n: int) -> str:
    """格式化字节数为人类可读形式。"""
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.1f}{unit}"
        n /= 1024
    return f"{n:.1f}TB"


def _fmt_speed(speed: float) -> str:
    """格式化速度。"""
    return _fmt_size(int(speed)) + "/s"


def khy_prefix() -> str:
    """返回带颜色的 [khy] 前缀。"""
    return _colorize("khy", fg="cyan", style="bold")

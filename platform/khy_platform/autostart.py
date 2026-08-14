# @pattern Strategy
"""Cross-platform boot autostart registration for the Khy system-tray shell.

Goal ("安装即写自启"): after ``pip install`` the user expects the Khy tray to
come back on its own after a reboot — like Clash Verge — without having to run
anything manually. This module writes a per-user autostart entry that launches
``khy tray --detach`` at login, on all three desktop platforms.

Design constraints (mirrored from the project's ``ensure_md_registration``
philosophy):
  * **Per-user, no elevation.** File-based entries in the user's own autostart
    location — never the registry Run key, never system-wide LaunchDaemons.
  * **Idempotent.** ``enable`` is a no-op when the entry already exists;
    ``disable`` is a no-op when it is already gone.
  * **Fail-soft.** Nothing here ever raises: a hiccup writing an autostart file
    must not break ``pip install`` or ``khy tray``. Callers read the returned
    status string instead.
  * **Honest platform coverage.** Unknown/headless platforms self-report a
    ``skip-*`` status rather than pretending success.

The entry always invokes the ``khy`` console script (resolved on PATH) so it
keeps working across pip upgrades that relocate the bundled backend.
"""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

# Gate: default-on. Set KHY_TRAY_AUTOSTART=0/false/off to opt out (install-phase
# registration and `khy tray enable-autostart` both honor it).
_AUTOSTART_ENV = "KHY_TRAY_AUTOSTART"

# Stable identifiers for the per-platform autostart artifacts.
_WIN_STARTUP_FILENAME = "khy-tray.cmd"
_MAC_LAUNCH_LABEL = "com.khy.tray"
_LINUX_DESKTOP_FILENAME = "khy-tray.desktop"


def autostart_enabled_by_env() -> bool:
    """Whether the autostart gate is on (default-on unless explicitly disabled)."""
    raw = os.environ.get(_AUTOSTART_ENV)
    if raw is None:
        return True
    return raw.strip().lower() not in {"0", "false", "off", "no"}


def _resolve_launch_command() -> str:
    """Best-effort absolute path to the ``khy`` console script (fallback: name).

    Using the resolved path avoids a stale entry when the shim is not on the
    login shell's PATH; when it cannot be resolved we fall back to the bare
    ``khy`` name so the entry is still meaningful once PATH is set up.
    """
    for name in ("khy", "khy-os"):
        found = shutil.which(name)
        if found:
            return found
    return "khy"


# ── Per-platform artifact locations ──────────────────────────────────────────


def _windows_startup_path() -> Path | None:
    appdata = os.environ.get("APPDATA")
    base = Path(appdata) if appdata else Path.home() / "AppData" / "Roaming"
    return base / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup" / _WIN_STARTUP_FILENAME


def _mac_launch_agent_path() -> Path:
    return Path.home() / "Library" / "LaunchAgents" / f"{_MAC_LAUNCH_LABEL}.plist"


def _linux_autostart_path() -> Path:
    config_home = os.environ.get("XDG_CONFIG_HOME")
    base = Path(config_home) if config_home else Path.home() / ".config"
    return base / "autostart" / _LINUX_DESKTOP_FILENAME


def _artifact_path() -> Path | None:
    """The autostart file for the current platform, or None if unsupported."""
    if sys.platform == "win32":
        return _windows_startup_path()
    if sys.platform == "darwin":
        return _mac_launch_agent_path()
    if sys.platform.startswith("linux"):
        return _linux_autostart_path()
    return None


# ── Per-platform artifact contents ───────────────────────────────────────────


def _windows_contents(launch: str) -> str:
    # `start "" <cmd>` launches without holding a console window open. The
    # detached tray then owns its own lifecycle.
    return f'@echo off\r\nstart "" {launch} tray --detach\r\n'


def _mac_contents(launch: str) -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" '
        '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
        '<plist version="1.0">\n'
        "<dict>\n"
        "  <key>Label</key>\n"
        f"  <string>{_MAC_LAUNCH_LABEL}</string>\n"
        "  <key>ProgramArguments</key>\n"
        "  <array>\n"
        f"    <string>{launch}</string>\n"
        "    <string>tray</string>\n"
        "    <string>--detach</string>\n"
        "  </array>\n"
        "  <key>RunAtLoad</key>\n"
        "  <true/>\n"
        "</dict>\n"
        "</plist>\n"
    )


def _linux_contents(launch: str) -> str:
    return (
        "[Desktop Entry]\n"
        "Type=Application\n"
        "Name=Khy Tray\n"
        "Comment=Khy runtime system-tray launcher\n"
        f"Exec={launch} tray --detach\n"
        "Terminal=false\n"
        "X-GNOME-Autostart-enabled=true\n"
    )


def _artifact_contents(launch: str) -> str | None:
    if sys.platform == "win32":
        return _windows_contents(launch)
    if sys.platform == "darwin":
        return _mac_contents(launch)
    if sys.platform.startswith("linux"):
        return _linux_contents(launch)
    return None


# ── Public API ───────────────────────────────────────────────────────────────


def is_autostart_installed() -> bool:
    """True when the current platform's autostart artifact already exists."""
    path = _artifact_path()
    try:
        return bool(path and path.exists())
    except Exception:
        return False


def enable_autostart() -> dict:
    """Write the per-user autostart entry for this platform (idempotent).

    Returns ``{"ok": bool, "status": str, "path": str|None}``. Statuses:
      * ``"already"`` — entry existed, nothing to do.
      * ``"installed"`` — entry was just written.
      * ``"skip-disabled"`` — gate off via KHY_TRAY_AUTOSTART.
      * ``"skip-unsupported"`` — platform has no known autostart location.
      * ``"error: ..."`` — write failed (swallowed; never raised).
    """
    if not autostart_enabled_by_env():
        return {"ok": False, "status": "skip-disabled", "path": None}

    path = _artifact_path()
    if path is None:
        return {"ok": False, "status": "skip-unsupported", "path": None}

    try:
        if path.exists():
            return {"ok": True, "status": "already", "path": str(path)}
        launch = _resolve_launch_command()
        contents = _artifact_contents(launch)
        if contents is None:
            return {"ok": False, "status": "skip-unsupported", "path": None}
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(contents, encoding="utf-8")
        return {"ok": True, "status": "installed", "path": str(path)}
    except Exception as exc:  # never raise — install-phase / CLI must not break
        return {"ok": False, "status": f"error: {exc}", "path": None}


def disable_autostart() -> dict:
    """Remove the per-user autostart entry for this platform (idempotent)."""
    path = _artifact_path()
    if path is None:
        return {"ok": False, "status": "skip-unsupported", "path": None}
    try:
        if not path.exists():
            return {"ok": True, "status": "absent", "path": str(path)}
        path.unlink()
        return {"ok": True, "status": "removed", "path": str(path)}
    except Exception as exc:
        return {"ok": False, "status": f"error: {exc}", "path": None}

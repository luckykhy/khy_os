# @pattern Observer
"""
WeChat Alert Module — ServerChan Degradation/Fallback Pattern

When is_internet_available=False (default, for offline dev environments),
all notifications are logged locally to notifications.log without any
network calls. When True, messages are POSTed to the ServerChan API.
"""

import logging
import os
from datetime import datetime
from typing import Any

# Lazy-import requests only when actually needed (avoids ImportError in
# minimal environments that don't have it installed).
_requests = None


def _get_requests():
    """Import requests on first use so the module loads even without it."""
    global _requests
    if _requests is None:
        import requests
        _requests = requests
    return _requests


class WeChatNotifier:
    """ServerChan-based WeChat notifier with offline fallback."""

    API_URL_TEMPLATE = "https://sctapi.ftqq.com/{key}.send"

    def __init__(self, send_key: str, is_internet_available: bool = False) -> None:
        self.send_key = send_key
        self.is_internet_available = is_internet_available
        self._api_url = self.API_URL_TEMPLATE.format(key=send_key)

        # --- Logging setup (file + console, named logger) ---
        self._logger = logging.getLogger("wechat_notifier")
        self._logger.setLevel(logging.DEBUG)

        if not self._logger.handlers:
            log_path = os.path.join(os.path.dirname(__file__), "notifications.log")

            fh = logging.FileHandler(log_path, encoding="utf-8")
            fh.setLevel(logging.DEBUG)
            fh.setFormatter(logging.Formatter(
                "%(asctime)s | %(levelname)-7s | %(message)s",
                datefmt="%Y-%m-%d %H:%M:%S",
            ))

            ch = logging.StreamHandler()
            ch.setLevel(logging.INFO)
            ch.setFormatter(logging.Formatter("%(message)s"))

            self._logger.addHandler(fh)
            self._logger.addHandler(ch)

    # ------------------------------------------------------------------
    # Core dispatch
    # ------------------------------------------------------------------
    def _send(self, title: str, content: str) -> bool:
        """Dispatch a notification via ServerChan or local log.

        Returns True on success, False on failure. Never raises.
        """
        if not self.is_internet_available:
            self._logger.info("[Local Mode] title=%s | content=%s", title, content)
            print(f"[Local Mode] Message saved locally: {title}")
            return True

        # --- Online mode: POST to ServerChan ---
        try:
            requests = _get_requests()
            resp = requests.post(
                self._api_url,
                data={"title": title, "desp": content},
                timeout=10,
            )
            result = resp.json()

            if result.get("code") == 0:
                self._logger.info("[Online] Sent OK: %s", title)
                return True

            self._logger.warning(
                "[Online] ServerChan returned error: %s", result
            )
            return False

        except Exception as exc:
            self._logger.error(
                "[Online] Failed to send '%s': %s", title, exc
            )
            print(f"[Online Error] Notification failed (program continues): {exc}")
            return False

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    def send_message(self, title: str, content: str = "") -> bool:
        """Send a simple text notification.

        Args:
            title:   Notification title (required, non-empty).
            content: Optional body in Markdown.

        Returns:
            True on success, False on failure.
        """
        if not title or not title.strip():
            self._logger.warning("send_message called with empty title — skipped")
            return False
        return self._send(title.strip(), content)

    def send_daily_report(self, data_dict: dict[str, Any]) -> bool:
        """Format *data_dict* as a Markdown table and send it.

        Args:
            data_dict: Key/value pairs to include in the report.

        Returns:
            True on success, False on failure.
        """
        today = datetime.now().strftime("%Y-%m-%d")
        title = f"Daily Trading Report - {today}"

        # Build Markdown table
        lines = [
            f"## {title}",
            "",
            "| Item | Value |",
            "| :--- | :---- |",
        ]
        for key, value in data_dict.items():
            lines.append(f"| {key} | {value} |")

        content = "\n".join(lines)
        return self._send(title, content)


# ------------------------------------------------------------------
# Quick demo / smoke test
# ------------------------------------------------------------------
if __name__ == "__main__":
    notifier = WeChatNotifier(
        send_key="YOUR_SEND_KEY_HERE",
        is_internet_available=False,   # local dev mode
    )

    # 1) Simple message
    notifier.send_message(
        title="Trade Alert",
        content="BUY sh600519 @ 1800.00 — MA golden cross triggered",
    )

    # 2) Daily report
    notifier.send_daily_report({
        "Total Trades":    12,
        "Win Rate":        "75.0%",
        "Total P&L":       "+¥8,320.50",
        "Max Drawdown":    "-2.1%",
        "Sharpe Ratio":    1.85,
        "Open Positions":  3,
    })

    print("\n✓ Demo finished. Check notifications.log for entries.")

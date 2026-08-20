#!/usr/bin/env bash
#
# unregister-linux.sh — 干净卸载 khyosMarkdown 的 Linux 关联（零残留）。
#
# 删除 register-linux.sh 写入的 .desktop 与 MIME 包文件，并刷新数据库。
# 与注册脚本对称，全部用户级（~/.local），无需 sudo。

set -euo pipefail

APP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
MIME_PKG_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/mime/packages"
DESKTOP_FILE="$APP_DIR/khyosMarkdown.desktop"
MIME_FILE="$MIME_PKG_DIR/khyosMarkdown.xml"

removed=0
for f in "$DESKTOP_FILE" "$MIME_FILE"; do
  if [ -f "$f" ]; then rm -f "$f"; echo "  [unregister] 已移除 $f"; removed=$((removed + 1));
  else echo "  [unregister] 不存在（跳过）$f"; fi
done

# 刷新数据库（命令缺失不致命）。
command -v update-mime-database >/dev/null 2>&1 && \
  update-mime-database "${XDG_DATA_HOME:-$HOME/.local/share}/mime" >/dev/null 2>&1 || true
command -v update-desktop-database >/dev/null 2>&1 && \
  update-desktop-database "$APP_DIR" >/dev/null 2>&1 || true

echo ''
if [ "$removed" -gt 0 ]; then echo "  [unregister] ✓ 完成，关联已清除，零残留。";
else echo "  [unregister] 无可清除项（此前未注册）。"; fi

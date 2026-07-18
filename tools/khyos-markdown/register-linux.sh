#!/usr/bin/env bash
#
# register-linux.sh — 注册「使用 khyosMarkdown 打开」.md 右键/打开方式（仅当前用户）。
#
# 宪法红线4（系统纯净）：全部写入 ~/.local（用户级），绝不用 sudo、绝不写 /usr 或 /etc。
# 卸载请运行 unregister-linux.sh，零残留。
#
# 写入位置：
#   ~/.local/share/applications/khyosMarkdown.desktop   桌面入口（含 MimeType 关联）
#   ~/.local/share/mime/packages/khyosMarkdown.xml       确保 .md → text/markdown 映射存在
# 并将 text/markdown 的默认打开程序设为本入口。
#
# 红线3（路径免疫）：.desktop 用 %f 传入单个文件路径，桌面环境会自动正确传递含空格/中文的路径。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRIDGE="$SCRIPT_DIR/khyos-md-bridge.js"
[ -f "$BRIDGE" ] || { echo "  [register] ✗ 桥接器缺失：$BRIDGE" >&2; exit 1; }

NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  echo "  [register] ⚠ 未在 PATH 中找到 node。请先安装 Node.js：https://nodejs.org/" >&2
  echo "  [register]   仍将写入 .desktop（Exec 用 'node'），安装 node 后即可生效。" >&2
  NODE="node"
fi

APP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
MIME_PKG_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/mime/packages"
DESKTOP_FILE="$APP_DIR/khyosMarkdown.desktop"
MIME_FILE="$MIME_PKG_DIR/khyosMarkdown.xml"

mkdir -p "$APP_DIR" "$MIME_PKG_DIR"

# 桌面入口：%f = 被打开的单个文件绝对路径（桌面环境负责正确转义空格/中文）。
cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=khyosMarkdown
Name[zh_CN]=khyosMarkdown 文档工作台
Comment=Open and preview Markdown with khyosMarkdown
Comment[zh_CN]=用 khyosMarkdown 打开并预览 Markdown
Exec=$NODE "$BRIDGE" %f
Terminal=false
NoDisplay=false
MimeType=text/markdown;text/x-markdown;
Categories=Utility;TextEditor;
Icon=text-markdown
EOF

# 确保 .md → text/markdown 映射存在（部分发行版默认缺失）。
cat > "$MIME_FILE" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<mime-info xmlns="http://www.freedesktop.org/standards/shared-mime-info">
  <mime-type type="text/markdown">
    <comment>Markdown document</comment>
    <glob pattern="*.md"/>
    <glob pattern="*.markdown"/>
  </mime-type>
</mime-info>
EOF

# 刷新数据库（命令缺失不致命）。
command -v update-mime-database >/dev/null 2>&1 && \
  update-mime-database "${XDG_DATA_HOME:-$HOME/.local/share}/mime" >/dev/null 2>&1 || true
command -v update-desktop-database >/dev/null 2>&1 && \
  update-desktop-database "$APP_DIR" >/dev/null 2>&1 || true

# 设为 .md 的默认打开方式（右键「打开方式」首位 / 双击直达）。
if command -v xdg-mime >/dev/null 2>&1; then
  xdg-mime default khyosMarkdown.desktop text/markdown 2>/dev/null || true
  xdg-mime default khyosMarkdown.desktop text/x-markdown 2>/dev/null || true
fi

echo "  [register] ✓ 已注册（用户级，无 sudo）："
echo "  [register]     $DESKTOP_FILE"
echo "  [register]   右键 .md → 「打开方式」可见 khyosMarkdown；或直接双击打开。"
echo "  [register]   卸载：bash unregister-linux.sh"

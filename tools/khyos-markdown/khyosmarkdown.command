#!/usr/bin/env bash
# macOS double-click launcher for khyosMarkdown
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$SCRIPT_DIR/khyosmarkdown" "$@"

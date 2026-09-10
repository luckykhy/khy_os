# Opencode 项目配置

> 本目录包含 opencode 在 khy-os 项目中的配置。

## 文件说明

| 文件 | 用途 |
|------|------|
| `config.json` | opencode MCP 服务器配置 + 项目上下文 |

## 自动读取的设计文档

opencode 启动时会自动读取以下文件获取项目上下文：

1. **`CLAUDE.md`**（项目根目录）— 项目概述 + CC TUI 工作上下文
2. **`services/backend/src/cli/tui/AGENTS.md`** — CC TUI 工程约束
3. **`docs/03_DESIGN_设计/[DESIGN-ARCH-081]`** — 完整设计规范

## MCP 服务器

| 服务器 | 用途 |
|--------|------|
| `deepseek-eyes` | 图片分析、图表解读、OCR |

## 使用方式

```bash
# 在 khy-os 目录启动 opencode
cd D:\Portable\khy-os
opencode

# opencode 会自动读取：
# 1. 本目录的 config.json（MCP 配置）
# 2. 项目根目录的 CLAUDE.md（项目上下文）
# 3. AGENTS.md（工程约束）
```

---

*最后更新：2026-09-09*

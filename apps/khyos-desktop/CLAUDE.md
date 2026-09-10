# CLAUDE.md — khyOS Desktop 操作手册

> khyOS 桌面端：ZCode 1:1 复刻，对外呈现与 ZCode Desktop v3.11.2 完全一致的界面、交互、文案与数据契约。

---

## 唯一设计文档

**本项目的一切实现以 `docs/[DESIGN-ARCH-092] ZCode 1：1 复刻设计文档.md` 为唯一真源。**

其他任何文档（包括本文件）不得与 DESIGN-ARCH-092 冲突。若发现冲突，以 DESIGN-ARCH-092 为准。

## 项目定位

- **产品**：以 KhyOS 桌面端壳为交付物，1:1 复刻 ZCode Desktop v3.11.2 的界面、交互、文案与数据契约。
- **方法**：解包 ZCode `app.asar` 提取一手真源 + 官方站/更新日志交叉验证。
- **状态**：设计定稿，全部待实现（本仓库当前视为零基础）。

## 技术栈（锁定版本）

| 组件 | 版本 | 说明 |
|------|------|------|
| React | ^19.2.4 | 前端框架 |
| react-dom | ^19.2.4 | |
| Electron | 44.2.0 | 桌面框架 |
| electron-vite | 5.0.0 | 构建工具 |
| electron-builder | 26.15.3 | 打包（锁版本，v27 有 ESM 破坏性变更） |
| electron-updater | 6.8.9 | 自动更新 |
| TypeScript | 5.x | 类型系统 |
| Tailwind CSS | 4.2.2 | 样式（OKLCH） |
| Redux Toolkit | latest | 状态管理 |
| @xterm/xterm | 6.0.0 | 终端 |
| node-pty | ^1.0.0 | pty 宿主 |

## 进程架构

**四进程 + 五 preload**（非 Electron 常见的两进程）：

| 进程 | 角色 |
|------|------|
| main | 窗口、菜单、托盘、更新、系统能力、IPC 注册 |
| host | Agent 运行时适配，桥接 KhyOS 后端（五通道决策矩阵） |
| scheduler | 定时任务、闲时算力 |
| preload ×6 | 主 preload（127 RPC 方法）+ 5 个专用 preload |

## 关键约束

1. **零硬编码**：端点一律从 `services/backend/src/constants/serviceDefaults.js` 导入或 env 覆盖。
2. **状态透明**：所有状态文案遵守「动作 + 目标 + 进度」。
3. **基于活动的超时**：Agent 循环、自动化任务禁止硬 kill。
4. **终端渲染**：不用 ANSI 滚动区（除备用缓冲区全屏 UI）。

## 开发流程

```bash
# 安装依赖
cd apps/khyos-desktop
npm install

# 开发模式
npm run dev          # 仅 renderer
npm run electron:dev # 完整四进程

# 构建
npm run electron:build

# 校验
node scripts/ci/check-agent-rules.js --changed
node scripts/ci/check-i18n-fidelity.js
node scripts/ci/check-version-sync.js
```

## 真源资产

所有数值、文案、CSS 令牌的真源在 `zcode-analysis/` 目录：

| 文件 | 内容 |
|------|------|
| `tokens.txt` | 456 个 CSS 自定义属性 |
| `i18n-zh.json` | 5070 条中文文案（嵌套对象） |
| `i18n-zh.jsonl` | 同上（机器安全格式） |
| `rpc-surface.json` | 127 个 RPC 方法标识符 |
| `unpacked/` | ZCode 解包产物（只读参考） |

**禁止凭记忆改数值。一切以真源文件为准。**

## 品牌规则

本项目复刻 ZCode 的**布局、结构、尺寸、交互、信息层级**，但**不复用品牌资产**：

| 替换 | 说明 |
|------|------|
| ZCode → KhyOS | 名称替换 |
| GLM 图标素材 → 自研 | 美术资产自研 |
| zcode.z.ai → khyquant.top | 域名替换 |
| 智谱反馈表单 → KhyOS 反馈渠道 | 链接替换 |
| 智谱遥测 → 默认关 | 不接入 ARMS RUM |

品牌替换由 `scripts/ci/check-brand-replacement.js` 强制校验。

## 相关文件

| 用途 | 文件 |
|------|------|
| 设计文档 | `docs/[DESIGN-ARCH-092] ZCode 1：1 复刻设计文档.md` |
| khy-os 工程红线 | `../../AGENTS.md` |
| khyos-hq 指挥部 | `../khy-os-hq/` |

---

*最后更新：2026-09-08*
*本文件指向 DESIGN-ARCH-092 为唯一真源*

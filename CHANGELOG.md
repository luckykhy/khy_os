# Changelog

All notable changes to khy OS will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 1.1.9

khy OS 1.1.9 — 精简体积、跨平台脚本补齐与若干修复。

### Changed

- **体积精简**: 新增 `scripts/maintenance/slim-down.{bat,sh}` 一键清理脚本（日志、构建产物、
  sqlite 临时文件、未使用的 node-llama-cpp 多平台二进制），幂等且双平台覆盖；日志轮转收紧
  （`maxFiles` 7d/14d + `zippedArchive`）防单日日志爆量。
- **跨平台脚本**: 补齐 `slim-down.sh` 与 `khy.sh repair` 支持，bat/sh 配对完整。

### Fixed

- **模型「说要搜索却不调工具」**:同一个模型在能力缓存里留下了两条键不同、裁决相反的记录
  (`api:agnes:agnes-2.5-flash` → `text`,来自主动探测;`agnes-2.5-flash` → `native`,来自被动学习),
  而两道决定工具协议的闸各读一条:教学门拿路由 id、剥离门拿裸模型名。结果模型在同一轮里
  既收到完整的原生工具定义,又收到「你没有原生工具,请用 `<tool_call>` 文本语法」的教学 ——
  指令自相矛盾,模型于是只用散文说「我先用 WebSearch 搜索」,一个工具都不调,自我重驱一次后
  输出同样的段落并结束该轮。
  - 新增纯叶子 `services/gateway/capabilityModelKey.js`:能力缓存的键统一折叠为**裸模型名**,
    剥前缀的约定与 `apiAdapter.parseProviderModel` 同源(测试里有对撞断言防止三份正则各自演化)。
    ollama 风格的量化/尺寸 tag(`qwen:7b`)绝不误剥,否则不同模型会塌成同一条记录。
  - `toolCapabilityStore` 加载时**就地迁移**历史带前缀的键并落盘,已有缓存文件自愈,撞键时
    `native` 胜 `text`。
  - `recordVerdict` 新增**不静默降级**不变量:已确证 `native` 时,一次 `text` 观测不再覆盖它 ——
    「见过真实的原生 tool_calls」是正面证据,「这次没看到」只是证据的缺席(探测用极简工具 +
    极短 maxTokens,假阴性正常)。降级只能显式发生:`khy gateway probe-tools` 主动重测(现在传
    `force`),或 `KHY_TEXT_ONLY_TOOL_MODELS` 钉死。

### Changed

- **TUI 任务看板改为「右栏」，与正文平齐贯穿整屏**：看板不再作为 ink flex 行里的右列子元素渲染。
  ink 活动区永远画在已提交的 `<Static>` 滚动区之下，所以树内看板结构性地被钉在视口底部，
  右上方那一大片空间永久浪费。现在改为两步：ink 渲染的一切收窄到 `cols - 栏宽`（新叶子
  `railLayout.contentCols` 是唯一真源，经 `effectiveCols` 供各渲染路径读取），最右侧那几列
  预留出来，由 `runtime/sidebarRail` 用「存光标 → 逐行绝对定位 → 取光标」的字节把看板画进
  槽位，从屏幕第 1 行铺到 `rows - 1` 行。
  - 画笔字节被**追加进 ink 自己的那一次 `write()`**（`app.jsx` 已有的 stdout Proxy），
    整行擦除与重画因此是一次原子写入，屏幕上不存在「已擦除、未重画」的中间态 = 不闪烁。
  - 全程不含 `\n`/`\r`、不改 scroll region，`<Static>` + 终端原生 scrollback 的输出模型
    与复制粘贴行为完全不动；不新增定时器（复用 App 每秒的 `nowTick` 心跳）。
  - `/model`、`/review` 等原生交互界面前后自动 suspend/resume，resize 变窄时先清旧几何，
    退出路径清空槽位。
  - 门控 `KHY_SIDEBAR_RAIL` **默认开**；`KHY_SIDEBAR_RAIL=0` 逐字节回到树内看板的旧行为。
    宽度/配色沿用既有 `KHY_SIDEBAR*` 一族；约束高度的 `KHY_SIDEBAR_MAX_RATIO` /
    `KHY_SIDEBAR_MIN_CHROME` / `KHY_SIDEBAR_STACK_MAX_RATIO` 对右栏不再适用（它不占活动区行）。
  - 窄于 `KHY_SIDEBAR_MIN_COLS`（默认 120 列）或非 TTY → 不激活，完全走 legacy 路径。

## 1.1.8

khy OS 1.1.8 — 安全加固、CI 流水线完善、前端体验优化与便携模式增强。

### Highlights

- **安全加固**: 修复命令注入防护与会话撤销竞态条件 (d525650)，后端网关适配器、守护进程管理与启动恢复的全面硬化 (efb676b)。
- **CI/CD 完善**: 发布构件增加平台后缀防止覆盖 (18f60b8)；GitHub Release 写权限修复 (2a93fcc)；构建工具链锁定 Node 22 (5e31d1b)；独立构建所需打包脚本取消忽略 (b778b92)。
- **前端体验**: 浮动球、路由预加载与 AI 聊天视图改进 (338e3c2)；TUI 稳定性修复与输入→渲染性能优化 (f4e6541)。
- **便携模式**: 新增 portable 打包、健康检查与自愈工具链 (7970831)。
- **基础设施**: 后端版本同步机制与 SQLite 启动探测，`better-sqlite3` 降级为可选依赖 (893da15)；新增 `khyos-markdown` MCP 服务器 (1ceca37)。
- **测试**: TUI 渲染测试更新 (b336ca7)。

### Compatibility

- 安装 / 升级: `pip install -U khy-os` 或 `npm install -g @khy-os/khy-os`；`khy --version` 应报告 `1.1.8`。
- Node.js >= 20 要求不变。
- `better-sqlite3` 不再为强制依赖，无原生模块环境下自动回退至 `node:sqlite`。

---

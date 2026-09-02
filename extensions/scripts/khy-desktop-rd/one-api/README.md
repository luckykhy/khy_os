# one-api — 多 LLM API 管理 & 分发系统

> 调研日期: 2026-08-31
> 仓库: <https://github.com/songquanpeng/one-api>
> License: MIT
> Stars: 36.7k · Forks: 6.8k · 1,210 commits

## 一、为什么列为第四

one-api 跟 khy-os **不是同一个产品形态**——one-api 是"LLM API 网关管理后台"（类似 new-api），khy-os 是"AI 量化平台 + 桌面应用"。**但 khy-os 的前端设计 token 直接源自 new-api 视觉体系**（`apps/ai-frontend/src/styles/newapi-theme.css:1` 注释明确写"design language is adapted from new-api's shadcn/oklch palette"）。

one-api 跟 new-api 同源，所以本档案的核心价值是：
- **追溯 khy-os 当前视觉风格的源头**
- **参考其"支持主题切换"的设计**（`THEME` 环境变量 + `web/default/public/themes/`）
- **借鉴它"多 LLM 分发"的产品抽象**（已经做了：渠道、令牌、兑换码、用户分组、倍率计算）

## 二、技术栈

| 层 | 技术 |
|----|------|
| 后端 | Go（单可执行文件 + go.mod） |
| 前端 | React + React Router + 半自动构建 |
| 数据库 | SQLite（默认）/ MySQL / PostgreSQL |
| 部署 | 单二进制 / Docker / Docker Compose / 宝塔 |
| 多 LLM 协议 | OpenAI / Azure / Anthropic / Gemini / DeepSeek / Moonshot / Ollama 等 25+ |

## 三、关键架构亮点（与 khy-os 相关）

### 3.1 多 LLM 统一适配

one-api 把 25+ LLM 提供商抽象成统一的 OpenAI API 格式：

```
graph LR
A(用户) -->|使用 One API 分发的 key 进行请求| B(One API)
B -->|中继请求| C(OpenAI)
B -->|中继请求| D(Azure)
B -->|中继请求| E(其他 OpenAI API 格式下游渠道)
B -->|中继并修改请求体和返回体| F(非 OpenAI API 格式下游渠道)
```

**给 khy-os 的启示**：
- khy-os 的 `services/backend/src/services/gateway/aiGateway.js` 已经实现了**这个抽象**
- 适配器模式（`adapters/`）就是 one-api 的"渠道"
- **khy-os 已经走在正确的路径上**

### 3.2 令牌模型

```
用户 → 渠道（API Key + 模型列表）
        ↓
     令牌（用户创建，绑定额度 + 过期时间 + IP 白名单）
        ↓
     请求带 Bearer ONE_API_KEY-CHANNEL_ID（可选指定渠道）
        ↓
     负载均衡 / 倍率计算
```

**给 khy-os 的启示**：
- khy-os 当前没有"令牌"概念（直连模式）—— **可以引入**，让用户能"分享额度"
- 倍率计算（`额度 = 分组倍率 × 模型倍率 × (提示 token 数 + 补全 token 数 × 补全倍率)`）可以直接借用

### 3.3 主题切换

> "支持主题切换，设置环境变量 `THEME` 即可，默认为 `default`，欢迎 PR 更多主题，具体参考此处的 `web/README.md`。"

**给 khy-os 的启示**：
- khy-os 当前主题切换走 `<html class="dark">` + Element Plus `theme-chalk/dark/css-vars.css`，**跟 one-api 思路一致**
- 但 one-api 走"环境变量切换主题目录"是另一种模式 —— 多主题打包在一起，启动时选择

### 3.4 截图（来自仓库 README）

从仓库 README 截图看，one-api 的视觉风格是：
- 浅色 + 深色双套
- 主色系基于 shadcn oklch 调色板（蓝/绿/橙）
- 卡片 + 表格 + 标签页的经典 admin 风
- 渐变 logo + 简洁卡片

**与 khy-os 当前的关系**：
- khy-os 的 `newapi-theme.css` 直接源自此
- one-api 是浅色主导，khy-os 已经把它改成浅+深双套

### 3.5 App.js 路由结构

源码 `web/default/src/App.js` 关键路由（节选自抓取）：

```
/                          → Home（公开）
/login /register /reset     → 认证
/channel, /channel/:id      → 渠道管理
/token, /token/:id          → 令牌管理
/redred, /redred/:id        → 兑换码管理
/user, /user/:id            → 用户管理
/setting                    → 设置
/topup                      → 充值
/log                        → 日志
/about                      → 关于
/chat                       → 内嵌 chat
/dashboard                  → 仪表盘
```

**给 khy-os 的启示**：
- khy-os 的 `apps/ai-frontend/src/router/index.js:142` 已经有约 30 个路由
- 路由设计模式（公开 + 私有路由 + Suspense lazy）是稳定范式
- **khy-os 桌面端的 `khy://` 协议可以借鉴** one-api 的 `?id=` 链接模式（虽然 one-api 没有协议）

## 四、给 khy-os 的可借鉴项总结

| one-api 特性 | khy-os 借鉴路径 | 优先级 |
|---------------|------------------|--------|
| 主题切换 | **已实现** | — |
| 多 LLM 适配 | **已实现** | — |
| 统一 OpenAI 协议 | **已实现** | — |
| 额度倍率计算 | khy-os 的 `tokenUsageService.js` 已用人民币计价，可补"分组倍率" | 中 |
| 兑换码 / 邀请奖励 | **远期** | 低 |
| 多机部署 (master/slave) | **远期**（khy-os 主要单用户） | 低 |
| Docker 部署 | **已实现**（`Dockerfile`） | — |
| 主题目录 + env 切换 | 可作为"多主题发布"的"参考 | 中 |
| 时区 `TZ=Asia/Shanghai` | **已实现** | — |

## 五、本地文件

| 文件 | 来源 |
|------|------|
| `App.js` | `web/default/src/App.js`（路由参考） |

抓取自 <https://raw.githubusercontent.com/songquanpeng/one-api/main/web/default/src/App.js>
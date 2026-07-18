# KHY Trae Bridge

将 Trae IDE 的 `icube.marscode` 登录态桥接到 KHY OS CLI，实现一次登录、双端共享。

---

## 架构

```
Trae Sandbox                              KHY CLI
┌──────────────────┐                ┌─────────────────────────┐
│ icube.marscode   │                │ readMarsCodeAuthProvider │
│ AuthProvider     │──getSession──▶│ Token()                  │
│ (内存持有 token) │                │                          │
└──────────────────┘                └───────────┬─────────────┘
         │                                      │
    khy-trae-bridge                             │
    扩展写入                                    读取
         │                                      │
         ▼                                      ▼
   <globalStorage>/khy-trae-bridge/auth.json
   { accessToken, host, userId, username, region, ts }
```

## 目录结构

```
extensions/khy-trae-bridge/
├── package.json          — 扩展清单 (onStartupFinished 激活)
├── extension.js          — 核心逻辑 (~120 行)
├── .vscodeignore         — 打包过滤
├── README.md             — 本文档
└── khy-trae-bridge-0.1.0.vsix  — 预构建安装包
```

---

## 安装（Windows）

### 方式一：从预构建 VSIX 安装（推荐）

仓库已包含 `khy-trae-bridge-0.1.0.vsix`，直接安装即可：

1. 打开 **Trae**
2. 按 `Ctrl+Shift+X` 打开扩展面板
3. 点击面板右上角 **`···`** → **从 VSIX 安装...**（Install from VSIX）
4. 选择文件：`extensions\khy-trae-bridge\khy-trae-bridge-0.1.0.vsix`
5. 等待安装完成 → 重启 Trae

或使用命令行：

```powershell
# Trae CLI（如果已配置 PATH）
trae --install-extension extensions\khy-trae-bridge\khy-trae-bridge-0.1.0.vsix

# 也可能是
code --install-extension extensions\khy-trae-bridge\khy-trae-bridge-0.1.0.vsix
```

### 方式二：从源码打包后安装

```powershell
cd extensions\khy-trae-bridge

# 安装打包工具
npm install --save-dev @vscode/vsce

# 打包
npx @vscode/vsce package --allow-missing-repository

# 安装
trae --install-extension khy-trae-bridge-0.1.0.vsix
```

---

## 使用方法

### 自动模式（零配置）

安装完成后 **无需任何手动操作**：

1. 启动 Trae — 扩展自动激活（`onStartupFinished`）
2. 扩展调用 `vscode.authentication.getSession('icube.marscode', [])` 获取登录态
3. Token 写入 `<globalStorage>/khy-trae-bridge/auth.json`
4. KHY CLI 下次 `detect()` 自动拾取 → 状态从 `encrypted` → `verified`

### 手动同步

如果需要立即刷新登录态：

- **命令面板**：`Ctrl+Shift+P` → 输入 `KHY: 同步 Trae 登录态`
- **状态栏**：点击右下角 `🔑 KHY Bridge` 图标

### 查看日志

`Ctrl+Shift+U` 打开输出面板 → 下拉选择 **KHY Trae Bridge** 通道

---

## 刷新策略

| 触发方式 | 时机 | 说明 |
|---------|------|------|
| 启动同步 | Trae 启动后立即 | `onStartupFinished` |
| 定时刷新 | 每 10 分钟 | `setInterval` |
| 事件驱动 | 登录/登出时 | `onDidChangeSessions` |
| 手动命令 | 用户触发 | 命令面板或状态栏 |

---

## auth.json 格式

```json
{
  "accessToken": "eyJhbGciOi...",
  "userId": "user_xxxx",
  "username": "example",
  "host": "grow-normal.trae.ai",
  "region": "cn",
  "ts": 1748150400000
}
```

未登录时：

```json
{
  "accessToken": null,
  "status": "no_session",
  "ts": 1748150400000
}
```

---

## 区域检测

扩展自动根据 Trae 版本和系统语言判断区域：

| 条件 | 区域 | API 主机 |
|------|------|---------|
| appName 含 "Trae CN" 或 "国内" | `cn` | `grow-normal.trae.ai` |
| 系统语言 `zh-*` | `cn` | `grow-normal.trae.ai` |
| 其他（国际版默认） | `va` | `growva-normal.trae.ai` |

完整区域映射：

| 区域 | 主机 |
|------|------|
| `cn` | `grow-normal.trae.ai` |
| `sg` | `growsg-normal.trae.ai` |
| `va` | `growva-normal.trae.ai` |
| `usttp` | `grow-normal.traeapi.us` |

---

## 故障排查

### 扩展安装后没反应

1. 确认 Trae 版本 ≥ 1.80（`engines.vscode: ^1.80.0`）
2. 查看输出面板日志是否有错误
3. 确认 Trae 内已登录 — 如果未登录，auth.json 会写入 `"status": "no_session"`

### KHY CLI 没有拾取到 token

1. 检查 auth.json 是否存在：

```powershell
# globalStorage 路径通常在
# Windows: %APPDATA%\Trae\User\globalStorage\khy-trae-bridge\auth.json
dir "%APPDATA%\Trae\User\globalStorage\khy-trae-bridge\auth.json"
```

2. 确认 `accessToken` 字段不为 `null`
3. 确认 `ts` 是最近的时间戳（不超过 24 小时）

### 手动验证 token 是否有效

```powershell
# 在 KHY CLI 中执行
khy ai status
# 应显示 adapter: trae, state: verified
```

---

## 卸载

### 从 Trae 卸载

`Ctrl+Shift+X` → 搜索 `KHY Trae Bridge` → 点击齿轮图标 → **卸载**

### 清理残留文件

```powershell
# 删除桥接数据
del "%APPDATA%\Trae\User\globalStorage\khy-trae-bridge\auth.json"
rmdir "%APPDATA%\Trae\User\globalStorage\khy-trae-bridge"
```

---

## 开发者信息

- **激活方式**：`onStartupFinished`（不阻塞 Trae 启动）
- **依赖**：零运行时依赖，仅使用 VS Code API + Node.js 内置模块
- **体积**：打包后 ~4 KB
- **兼容性**：VS Code / Trae / 任何兼容 VS Code 扩展 API 的 IDE

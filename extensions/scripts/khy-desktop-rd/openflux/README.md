# OpenFlux — 桌面 AI Agent 客户端（Tauri v2）

> 调研日期: 2026-08-31
> 仓库: <https://github.com/EDEAI/OpenFlux>
> 官方站点: <https://openflux.io>
> License: MIT
> Stars: 225 · Forks: 42 · 118 commits（截至调研日）
> 中文文档: `README_zh.md`

## 一、为什么列为第一位

OpenFlux 的技术栈与 khy-os 当前形态**高度对称**，几乎可以直接做 1:1 的工程映射：

| 层级 | OpenFlux | khy-os | 复用度 |
|------|----------|--------|--------|
| 桌面壳 | **Tauri v2**（Rust） | ❌ 无 | 需新建 |
| 前端 | TypeScript + Vite + 原生 HTML | Vue 3 + Element Plus + Vite | 风格相近 |
| AI 网关 / 后端 | **Gateway Sidecar**（Node.js + Express + ws） | `services/backend/server.js` + `services/ai-backend/` | **结构对称** |
| 配置 | `openflux.yaml` | `~/.khyquant/config.json` | 改写即可 |
| 多 LLM | OpenAI / Anthropic / DeepSeek / Moonshot / Zhipu / Ollama | 同样的多供应商 | 复用 |
| MCP 协议 | 内建 | 内建 | 复用 |
| 多 Agent | 通用 / 编码 / 自动化 | 已有元帅/代理路由 | 概念复用 |
| 桌面能力 | 鼠标键盘模拟、Office 插件、Sherpa-ONNX | xterm + 剪贴板图片粘贴 | 增量补 |

## 二、架构

```
┌─────────────────────────────┐
│ Tauri v2 Shell │ ← Rust 进程管理 + 原生 API
├─────────────────────────────┤
│ 前端（TypeScript/HTML）│ ← 对话 UI / 设置 / 文件预览
├─────────────────────────────┤
│ Gateway Sidecar（Node.js）│ ← AI 引擎 / 工具调用 / 记忆系统
└─────────────────────────────┘
```

## 三、关键技术点

### 3.1 Gateway Sidecar 启动模式（**与 khy-os 高度同构**）

源码：`src-tauri/src/lib.rs:23-72`

```rust
.setup(|app| {
    tray::setup_tray(app)?;
    let config = config::load_config(app.handle())?;
    app.manage(config);
    app.manage(Mutex::new(commands::gateway::GatewaySidecar::new()));
    // ...

    // 异步启动 Gateway Sidecar（不阻塞 UI 线程）
    let app_handle = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        // 先让窗口显示 loading 界面
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        // 用 spawn_blocking 避免阻塞 tokio 运行时的同步 I/O
        let handle = app_handle.clone();
        let result = tokio::task::spawn_blocking(move || {
            commands::gateway::start_gateway_sidecar(&handle)
        }).await;
        match result {
            Ok(Ok(())) => eprintln!("[OpenFlux] Gateway sidecar started"),
            Ok(Err(e)) => eprintln!("[OpenFlux] Gateway sidecar start failed: {}", e),
            Err(e) => eprintln!("[OpenFlux] Gateway sidecar task error: {}", e),
        }
    });
    Ok(())
})
```

**关键决策**：
- 用 `spawn_blocking` 包住同步 spawn（tar 解压 + node.exe 启动）
- 先睡 100ms 让 loading 界面先渲染
- 启动失败/任务失败都 eprintln 而不是 panic —— Tauri 进程不挂
- 主窗口销毁时 `commands::gateway::stop_gateway_sidecar(app)` 优雅停网关

> 这正是 khy-os `services/backend/bin/khy.js:1100-1194` 那条 `spawn(node, [server.js], { detached: true })` 路径的 Rust 镜像。

### 3.2 WebView2 ↔ ws://127.0.0.1 直连限制

源码：`src-tauri/src/lib.rs:53-58`

```rust
// Lift the WebView2 AppContainer loopback restriction
#[cfg(target_os = "windows")]
setup::apply_loopback_exemption();
```

WebView2 默认禁用了 AppContainer loopback，需要 `CheckNetIsolation.exe` 解封。这是 Windows-only 的坑——khy-os 如果走 Tauri 路线要预设这个。

### 3.3 Tauri 配置文件

`src-tauri/tauri.conf.json`（节选）：

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "OpenFlux",
  "version": "0.6.20",
  "identifier": "com.openflux.app",
  "build": {
    "beforeDevCommand": "pnpm dev",
    "devUrl": "http://localhost:1420",
    "beforeBuildCommand": "pnpm build",
    "frontendDist": "../dist"
  },
  "app": {
    "withGlobalTauri": true,
    "windows": [{
      "title": "OpenFlux",
      "width": 1200,
      "height": 800,
      "minWidth": 800,
      "minHeight": 600,
      "decorations": false,
      "center": true
    }],
    "security": { "csp": null }
  },
  "bundle": {
    "active": true,
    "copyright": "2025 OpenFlux",
    "targets": ["nsis", "dmg"],
    "windows": {
      "nsis": {
        "compression": "none",
        "languages": ["SimpChinese", "English"],
        "displayLanguageSelector": false,
        "installMode": "currentUser",
        "installerIcon": "icons/icon.ico",
        "headerImage": "icons/nsis-header.bmp",
        "sidebarImage": "icons/nsis-sidebar.bmp",
        "installerHooks": "nsis/hooks.nsh"
      }
    },
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ],
    "resources": [
      "node.exe",                          // ← 内嵌 Node 运行时
      "gateway-bundle.tar.gz",             // ← 内嵌网关包
      "../openflux.example.yaml",
      "resources/plugins/excel/**/*",
      "resources/plugins/word/**/*",
      "resources/plugins/powerpoint/**/*",
      "resources/python/python-embed.zip", // ← 内嵌 Python 运行时
      "resources/python/uv.exe"
    ]
  }
}
```

**关键决策**：
- **内嵌 Node 运行时**（`node.exe`）作为资源 —— 用户的电脑不必装 Node
- 内嵌 Python（`python-embed.zip` + `uv.exe`）—— 同样为"零外部依赖"路线
- 资源打包策略：本体单独打 tar.gz，运行时（node.exe）+ 内嵌数据分列
- NSIS 安装语言含简体中文，installMode=currentUser（**免管理员权限**）
- `decorations: false` —— 自绘窗口标题栏（khy-os 默认风格首选）

### 3.4 Rust 端依赖（`src-tauri/Cargo.toml`）

```toml
[dependencies]
tauri = { version = "2", features = ["tray-icon"] }
tauri-plugin-opener = "2"
tauri-plugin-shell = "2"
tauri-plugin-dialog = "~2.7"
tauri-plugin-process = "2"
tauri-plugin-notification = "2"
tauri-plugin-fs = "~2.5"
tauri-plugin-single-instance = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
serde_yaml = "0.9"
tokio = { version = "1", features = ["rt", "rt-multi-thread", "macros", "time", "net", "process", "io-util"] }
open = "5"
log = "0.4"
env_logger = "0.11"
tar = "0.4"
flate2 = "1"
axum = { version = "0.7", features = ["ws"] }
tower-http = { version = "0.5", features = ["fs", "cors"] }
tower = "0.4"
hyper = { version = "1", features = ["http1", "server"] }
hyper-util = { version = "0.1", features = ["tokio"] }
tokio-rustls = "0.26"
rustls-pemfile = "2"
which = "6"
anyhow = "1"
tokio-tungstenite = "0.24"
futures-util = "0.3"
# 本地开发证书生成（HTTPS 18803，Office 加载项要求）——纯 Rust，运行时离线。
rcgen = { version = "0.13", default-features = false, features = ["pem", "ring"] }
```

**值得借鉴**：
- 用 `axum` 做 Rust 端 HTTP/WS（Office 插件的 18803 端口）——给 khy-os 未来做 KHY-OS 内核的本地 HTTP 桥有用
- `tokio-tungstenite` 当 WS 客户端（如反向连 gateway-bundle）
- `rcgen` 离线生成自签证书（用于 Office 加载项要求的 HTTPS）

### 3.5 资源打包脚本

`package.json` 的 `tauri:build` 步骤把 NSIS 安装包拷到 `output\`：

```json
"tauri:build": "tauri build --bundles nsis && powershell -c \"New-Item -ItemType Directory -Force output | Out-Null; Copy-Item 'C:\\cargo-target\\openflux-rust\\release\\bundle\\nsis\\*.exe' output\\ -Force; Write-Host 'Installer copied to output\\'\""
```

> khy-os 的桌面端可以参考这条路径：从绝对 cargo-target 拷贝安装包到项目内 `apps/desktop/release/`（避免用户去 cargo cache 找）。

## 四、Feature 列表（可直接对照 khy-os）

| OpenFlux | khy-os 现状 | 复用路径 |
|----------|-------------|----------|
| 多 LLM 接入（10+ 供应商） | ✅ `services/backend/src/services/gateway/aiGateway.js` | 0 改动 |
| 多 Agent 路由 | ✅ 元帅/将军体系 | 0 改动 |
| 长记忆（SQLite + sqlite-vec） | ✅ `khy-Trajectory/` | 增量补 |
| MCP 协议 | ✅ 内建 | 0 改动 |
| 浏览器自动化（Playwright） | ✅ 部分（远程 SSH） | 增量补 |
| 语音识别（Sherpa-ONNX） | ❌ | 待选 |
| 桌面控制（鼠标键盘） | ❌（DESIGN-ARCH-056 留有接口） | 增量补 |
| 定时任务 | ✅ khy-quant 部分 | 增量补 |
| Office 插件 | ❌ | 远期 |
| 远程接入（Lark/DingTalk） | ❌ | 远期 |

## 五、给 khy-os 的具体参考

### 5.1 直接可抄

- **`tauri-plugin-single-instance`**：第二实例启动时聚焦已有窗口（khy-os 已是 `bin/khy.js` 的现成模式）
- **`setup::apply_loopback_exemption()`**：Windows WebView2 直连 ws 的坑（必抄）
- **`decorations: false` + 自绘标题栏**：ZCode 风格的关键
- **bundling `node.exe` + `gateway-bundle.tar.gz`**：让用户不装 Node
- **CORS / 端口白名单**：借鉴 khy-os `server.js:264-277`

### 5.2 必须避开的坑

- Tauri 配置里 `"security": { "csp": null }` —— 这会关掉所有安全护栏。khy-os 应该保留 CSP
- `csp: null` 不能照抄——这是 OpenFlux 自承担风险的选择（前端裸跑）
- Tauri 的 `beforeDevCommand: "pnpm dev"` 依赖 Vite dev server，khy-os 现有的 `vite.config.js` 已可用

### 5.3 不建议照抄

- OpenFlux 用 `which="6"` 依赖外部 node.exe——khy-os 应该走"内嵌 Node"路线，避免对系统 Node 版本敏感
- OpenFlux 自签证书（`rcgen`）——khy-os 的后端已有正式 HTTPS 路径，不要再叠自签层

## 六、本地文件

| 文件 | 来源 |
|------|------|
| `tauri.conf.json` | `src-tauri/tauri.conf.json` |
| `Cargo.toml` | `src-tauri/Cargo.toml` |
| `package.json` | `package.json` |
| `lib.rs` | `src-tauri/src/lib.rs` |

抓取自 <https://raw.githubusercontent.com/EDEAI/OpenFlux/main/>
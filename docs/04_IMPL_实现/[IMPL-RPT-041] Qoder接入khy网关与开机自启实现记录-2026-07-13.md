# [IMPL-RPT-041] Qoder 接入 khy 网关与开机自启实现记录

> 实现报告 · 遵循 [MGMT-STD-001] 文档铁律 · 对应设计归 docs/03_DESIGN_设计/，本目录索引见 00_INDEX_实现-分类索引.md

- 日期：2026-07-13
- 范围：将 Qoder AI 通过本地桥接服务接入 khy 网关，并配置 Windows 用户登录自启动。
- 状态：定稿（端到端验证通过）

## 一、背景与目标
khy 网关已内置两条 Qoder 接入路径，本次采用的是 Track 2（自建桥接）：
| 路径 | 依赖 | 适用场景 |
|------|------|---------|
| Track 1（内置，见 docs/QODER_PROXY_INTEGRATION.md） | 独立的 qoder-proxy Node.js 服务 | 服务器/CI 环境 |
| Track 2（本次，自建桥接） | qodercli.exe（随 qoder_agent_sdk pip 包捆绑） | Windows 本机开发 |
Track 2 直接把 Qoder IDE 自带的 CLI 包装成 OpenAI 兼容接口，零额外依赖。

## 二、架构
khy（GATEWAY_API_POOL_PROVIDER=qoder）
  -> custom provider 池（custom_providers.json）
        -> http://127.0.0.1:3000/v1  <- qoder_bridge.py 监听
              -> qodercli.exe（随 qoder_agent_sdk 安装，路径因机器而异）
                    -> Qoder AI 云端模型

## 三、核心文件
| 文件 | 职责 |
|------|------|
| scripts/qoder-bridge/qoder_bridge.py | 本地 HTTP 服务，OpenAI 协议转译为 qodercli 子进程调用 |
| scripts/qoder-bridge/start_qoder_bridge.ps1 | 幂等启动器，检测 3000 端口后拉起 pythonw 进程 |
| scripts/qoder-bridge/install_autostart.ps1 | 每台机器 clone 后运行一次，动态生成 vbs 并装入 Startup 文件夹（不硬编码路径） |
| ~/.khyquant/custom_providers.json | 注册 qoder 池（12 个模型） |
| ~/.khyquant/api_keys.json | key=qoder-local（本地哨兵，无需真实鉴权） |

## 四、实现内容
### 4.1 qoder_bridge.py
监听 127.0.0.1:3000，三个端点：GET /health、GET /v1/models（12 个模型）、
POST /v1/chat/completions（调用 qodercli 子进程，300s 超时，解析 JSON 输出包装为
标准 chat.completion 响应）。默认模型 auto，未知模型 ID 透传给 qodercli 处理。

模型目录：auto/ultimate/performance/efficient/lite/qwen3.7-max/qwen3.7-plus/
glm-5.2/kimi-k2.7-code/deepseek-v4-pro/deepseek-v4-flash/minimax-m3。

### 4.2 配置层
setup_khy_provider.py 写入 custom_providers.json、api_keys.json，并更新
services/backend/.env 的 PROXY_MODEL_ROUTE_MAP / GATEWAY_API_POOL_SERVICE_MAP /
GATEWAY_API_POOL_DEFAULT_MODEL_MAP，设置 GATEWAY_API_POOL_PROVIDER=qoder，
GATEWAY_PREFERRED_MODEL=api:qoder:auto。sync_env.py 同步到根目录 .env 和
services/.env，防止多 .env 加载场景配置漂移。

### 4.3 开机自启动（Startup 文件夹方案，无需管理员权限）
Windows 计划任务（schtasks / Register-ScheduledTask）在受限用户权限下会返回
"拒绝访问"，改用用户级 Startup 文件夹
（%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup）。
install_autostart.ps1 在每台机器上运行一次，动态生成 silent_launch.vbs
（内容基于 $PSScriptRoot 实时计算，不写死路径），复制进 Startup 文件夹。

启动链路：Windows 登录 -> Startup 中的 vbs（WScript.Shell.Run 隐藏窗口异步启动）
-> powershell -WindowStyle Hidden -> start_qoder_bridge.ps1 -> 检测 3000 端口
-> 未监听则 Start-Process pythonw.exe 拉起 qoder_bridge.py，日志写入 logs/。

## 五、配置值（.env 关键项）
PROXY_PRIMARY_ADAPTER=api
GATEWAY_API_POOL_PROVIDER=qoder
GATEWAY_PREFERRED_MODEL=api:qoder:auto
PROXY_MODEL_ROUTE_MAP 中每个 qoder 模型均 target=api:qoder:<model>，strict=true
（strict 确保不会 fallback 到其他 provider，额度消耗可追踪）。

## 六、验证记录
桥接健康检查、模型列表、端到端对话、开机自启、幂等保护均已在一台 Windows
机器上验证通过（详见开发过程记录）。

## 七、排障指南
- ECONNREFUSED 127.0.0.1:3000 -> 桥接未运行，运行 install_autostart.ps1 生成的
  vbs 或直接 python scripts/qoder-bridge/qoder_bridge.py
- 502 -> 查看 logs/bridge_stdout.log，常见原因 qodercli 未登录（运行 qodercli login）
- 模型列表无 Qoder -> 确认 custom_providers.json 存在 poolKey=qoder，重启 khy
- 自启动未生效 -> 重新运行 install_autostart.ps1，用 wscript.exe 手动测试生成的 vbs

## 八、注意事项
1. qodercli 路径通过 QODERCLI_PATH 环境变量覆盖，默认按 sys.executable 推导。
2. 端口 3000 与 khy backend（3001）不冲突，可通过 QODER_BRIDGE_PORT 改端口。
3. 当前非流式：等待 qodercli 完整退出后才返回响应。
4. qodercli JSON 输出的 token 用量字段目前恒为 0，khy 侧统计对该通道无效。

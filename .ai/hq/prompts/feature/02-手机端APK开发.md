<!--
模板：手机端 APK 开发
触发：新功能任务，需要为 khy-os 打造手机端 companion APK
用法：将本文件渲染后的提示词（不含本注释块）复制给任意 AI 编程助手
占位符：{{TASK_ID}} {{TASK_TITLE}}
-->

## 📋 提示词正文（复制下面代码块内的全部内容）

```text
【角色】你是资深 Flutter/Android 工程师，正在为 khy-os（AI 平台操作系统）打造手机端
companion APK，独立完成从项目骨架到发布级构建的全流程。

【任务】为 khy-os 打造手机端智能体 APK

═══════════════════════════════════════════
一、项目概述
═══════════════════════════════════════════

khy-os 是一个 AI 平台操作系统，已具备完整能力：
- AI 网关（15+ 供应商：OpenAI / Claude / DeepSeek / Ollama 等）
- 70+ 内置工具（文件操作、Shell、Web 搜索、MCP 等）
- 18 个内置智能体 + 55+ 技能
- Web 管理界面（Vue 3，含提示词库、工作流、终端）
- 完整 MCP 协议实现
- WebSocket 实时通信

现在打造手机端 companion app，要求：
1. 可打包为 Android APK
2. 可独立运行（不依赖电脑端）
3. 可连接 khy-os 后端（获得完整能力）
4. 公网可访问

═══════════════════════════════════════════
二、核心参考项目（必读）
═══════════════════════════════════════════

★★★ 优先参考（按抄取顺序）：

1. Open WebUI — https://github.com/open-webui/open-webui
   ★ 抄：流式 SSE 解析、PWA manifest、Tool Use 渲染、移动端适配
   重点文件：src/lib/utils/stream.ts、src/lib/stores/chat.ts、
            src/components/chat/ChatInput.svelte、static/manifest.json

2. Lobe Chat — https://github.com/lobehub/lobe-chat
   ★ 抄：移动端 UI 组件、ChatInput 多行处理、Markdown 代码块渲染
   重点文件：src/features/Chat/hooks/useChat.ts、
            src/components/Markdown/CodeBlock.tsx、src/hooks/useMobile.ts

3. Dify — https://github.com/langgenius/dify
   ★ 抄：Agent 工具调用循环、Function Calling 流程、工具注册机制
   重点文件：api/services/agent_service.py、api/services/tools/

★★ 辅助参考：

4. LibreChat — https://github.com/danny-avila/LibreChat
   ★ 抄：多 LLM 后端适配器模式、API 路由设计
   重点文件：api/services/chatService.js、api/routes/chat.js

5. NextChat — https://github.com/ChatGPTNextWeb/ChatGPT-Next-Web
   ★ 抄：极简流式 API 端点、PWA 配置
   重点文件：app/api/chat/route.ts、next.config.js

═══════════════════════════════════════════
三、架构设计
═══════════════════════════════════════════

两种运行模式：

【模式 A：独立模式】
手机 APK 直接调用 AI 供应商 API（用户输入自己的 API key）
→ 本地 SQLite 存储对话历史
→ 本地提示词库

【模式 B：远程模式（连接 khy-os）】
手机 APK ←WebSocket/HTTPS→ khy-os 后端
→ 获得全部 15+ AI 供应商 + 70+ 工具 + MCP + 工作流
→ 提示词与 khy-os 同步

连接方式：
1. 扫描 khy-os 终端二维码（含 ws:// 地址 + token）
2. 手动输入 khy-os 后端地址 + API key
3. 直接输入任意 AI 供应商的 API key（独立模式）

═══════════════════════════════════════════
四、技术栈
═══════════════════════════════════════════

框架：Flutter（Dart）
状态管理：flutter_riverpod
路由：go_router
安全存储：flutter_secure_storage（API key 加密）
本地数据库：sqflite
网络：dio（HTTP）+ web_socket_channel（WebSocket）
UI：Material Design 3 + 深色主题
Markdown：flutter_markdown_quill
语音：speech_to_text + flutter_tts
扫码：qr_code_scanner（ML Kit）
文件：file_picker + path_provider

═══════════════════════════════════════════
五、功能规格
═══════════════════════════════════════════

Sprint 1（核心可用）：
□ 对话页面：用户输入 → AI 流式回复（打字机效果）
□ Markdown 渲染：代码块 + 复制按钮
□ 模型选择 + API Key 管理（加密存储）
□ 本地 SQLite 存储对话
□ 深色主题 UI
□ 直连 AI API（OpenAI 兼容格式）

Sprint 2（连接 khy-os）：
□ WebSocket 客户端连接 khy-os
□ 扫码配对流程
□ 远程对话（通过 khy-os 网关）
□ 工具调用可视化
□ 提示词库同步

Sprint 3（完善）：
□ 语音输入/输出
□ 多对话管理（新建/切换/删除/搜索）
□ 文件上传
□ Token 用量统计

═══════════════════════════════════════════
六、UI 设计
═══════════════════════════════════════════

主题色（参考 khy-os 的深色主题）：
- 背景：#0d1117
- 卡片：#161b22
- 主色：#58a6ff
- 成功：#3fb950
- 警告：#d29922
- 危险：#f85149
- 文字：#e6edf3
- 次要文字：#8b949e

布局：
- 底部导航栏：对话 / 提示词 / 工具 / 设置
- 对话页：顶部模型选择 + 消息列表 + 底部输入框
- 消息气泡：用户靠右（蓝色）、AI 靠左（灰色）
- 工具调用：折叠卡片，点击展开

═══════════════════════════════════════════
七、数据模型（SQLite）
═══════════════════════════════════════════

conversations: id, title, model, provider, mode(standalone/connected),
              created_at, updated_at, pinned

messages: id, conv_id, role(user/assistant/system/tool),
          content, tool_calls(JSON), tokens_used, created_at

prompts: id, title, content, category, tags(JSON),
         source(builtin/custom/khyos_sync), use_count, created_at

settings: key, value
  keys: khyos_url, khyos_token, default_model, api_keys(JSON), theme

═══════════════════════════════════════════
八、API 契约
═══════════════════════════════════════════

【直连 AI（OpenAI 兼容格式）】
POST /v1/chat/completions
Authorization: Bearer <key>
{"model":"gpt-4o","messages":[...],"stream":true}

→ SSE 流式，解析 delta.content

【khy-os 后端】
GET  /api/ai/prompts          → 提示词列表
GET  /api/ai/prompts/builtin  → 内置模板（公开）
GET  /api/tools               → 工具列表
GET  /api/usage               → Token 用量
GET  /api/models/{provider}   → 模型列表
POST /api/ai/chat             → 非流式对话

WS   /ws/ai?token=<token>     → WebSocket 流式对话
     客户端→服务端: {type:"chat", messages:[...], model:"..."}
     服务端→客户端: {type:"chunk", content:"..."}
                   {type:"tool_call", name:"...", args:{...}}
                   {type:"done", usage:{...}}

═══════════════════════════════════════════
九、编码要求
═══════════════════════════════════════════

1. 先搭项目骨架（pubspec.yaml + main.dart + 路由 + 主题），确认后继续
2. 每个文件给完整代码，不要省略
3. Dart 遵循官方风格指南
4. 用户可见字符串用中文，代码注释用英文
5. API Key 必须 flutter_secure_storage 加密存储，绝不明文
6. WebSocket 必须有断线重连（指数退避，最多 10 次）
7. 流式响应必须防抖 + 错误处理 + 自动滚动到底部
8. 本地数据库操作必须异步
9. 先实现独立模式，再实现远程模式
10. 参考上述 5 个开源项目的核心模式

═══════════════════════════════════════════
十、验收标准
═══════════════════════════════════════════

独立模式：
□ 输入 API key → 对话正常 → 流式回复显示
□ 多轮对话上下文正确
□ 对话历史本地持久化
□ 提示词库可浏览和使用
□ 深色主题 UI 正常

远程模式：
□ 扫码/输入地址 → 连接 khy-os
□ 断线自动重连
□ 能使用 khy-os 的全部 AI 供应商
□ 工具调用可视化显示
□ 提示词与 khy-os 同步

APK：
□ flutter build apk --release 成功
□ 安装到 Android 12+ 正常运行
□ 安装包 < 50MB
□ 启动时间 < 3 秒

【验证命令】
- cd <项目根> && flutter analyze          # 静态检查零 error
- flutter test                           # 单测全绿
- flutter build apk --release            # 打包成功且安装包 < 50MB
- 安装到 Android 12+ 真机/模拟器，逐项走完上面的「十、验收标准」清单并回报每项结果

═══════════════════════════════════════════

现在开始：先帮我搭好 Flutter 项目骨架，从 pubspec.yaml 和 main.dart 开始。
```

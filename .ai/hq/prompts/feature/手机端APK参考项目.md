<!--
模板：手机端 APK 参考项目手册（02-手机端APK开发.md 的配套素材）
触发：执行 T-013~T-015（手机端 APK 系列）时，配合开发模板一起交给 AI
用法：将本文件渲染后的提示词（不含本注释块）复制给任意 AI 编程助手
占位符：（无）
-->

## 📋 提示词正文（复制下面代码块内的全部内容）

```text
【角色】你是在为 khy-os 手机端 APK（T-013~T-015）做技术选型与实现的工程师，需要从成熟开源项目中精准「抄」核心模式，而不是从零发明。

【任务】按本文件附录的《参考项目手册》逐项核对：每个参考项目抄什么、重点文件在哪、khy-os 自身可复用资产有哪些，然后产出选型结论并进入实现。

【要求】
1. 优先级以附录总表为准（⭐⭐⭐ 项目必读，⭐ 项目按需）。
2. 只抄模式与结构，不整包引入依赖；逐文件说明「参考了哪个项目的哪个文件」。
3. 结论落入实现计划后再动手写代码。

【验证命令】本手册为配套素材，无独立可执行命令；实现代码以 02-手机端APK开发.md 的【验证命令】为准（flutter analyze / flutter test / flutter build apk --release）。

【审查清单】
□ 每个引入的模式都能在附录手册中指出来源项目与文件
□ 未引入附录之外的重量级依赖
□ 选型结论已同步到任务备注
```

---

# khy-os 手机端 APK — 参考项目手册（附录）

> 本文档是提示词的配套素材，列出了 AI 应该重点参考的开源项目、
> 每个项目的"抄哪里"以及 khy-os 自身的可复用资产。

---

## 一、参考项目总表

| 优先级 | 项目 | GitHub | 语言 | 抄什么 |
|--------|------|--------|------|--------|
| ⭐⭐⭐ | **Open WebUI** | open-webui/open-webui | Python + Svelte | PWA 配置、Tool Use 架构、移动端适配 |
| ⭐⭐⭐ | **Lobe Chat** | lobehub/lobe-chat | Next.js + React | 移动端 UI 组件、PWA 打包、插件架构 |
| ⭐⭐⭐ | **Dify** | langgenius/dify | Python + Vue | Agent 工作流引擎、Function Calling 流程 |
| ⭐⭐ | **LibreChat** | danny-avila/LibreChat | Node + React | 多 LLM 后端适配、React Native 移动端（开发中） |
| ⭐⭐ | **NextChat** | ChatGPTNextWeb/ChatGPT-Next-Web | Next.js | 极简对话 UI、PWA manifest、一键部署 |
| ⭐ | **Jan** | janhq/jan | Electron + React | 本地 LLM 推理架构、模型管理 |
| ⭐ | **Flowise** | FlowiseAI/Flowise | Node + Vue | 可视化 Agent 链构建、LangChain 集成 |

---

## 二、逐项目详细参考

### 1. Open WebUI（最重要参考）

**GitHub**: https://github.com/open-webui/open-webui

**为什么参考它**：
- 完整的 PWA 支持，可直接在 Android 上安装为应用
- 内置代码执行、RAG、Function Calling
- Docker 一键部署，架构清晰

**抄哪里**：

```
open-webui/
├── src/
│   ├── lib/                          # 核心逻辑
│   │   ├── api/                      # ★ API 客户端（OpenAI 兼容格式）
│   │   ├── stores/                   # ★ 状态管理
│   │   │   ├── chat.ts              # ★ 对话状态（消息列表、流式处理）
│   │   │   └── settings.ts          # ★ 设置状态
│   │   └── utils/
│   │       └── stream.ts            # ★ SSE 流式解析
│   ├── components/
│   │   ├── chat/                     # ★ 聊天 UI 组件
│   │   │   ├── Message.svelte       # ★ 单条消息渲染
│   │   │   ├── ChatInput.svelte     # ★ 输入框
│   │   │   └── ChatContainer.svelte # ★ 消息列表容器
│   │   └── layout/                   # ★ 布局组件
│   └── routes/
│       └── +page.svelte              # ★ 主页面
├── static/
│   └── manifest.json                 # ★ PWA manifest（直接抄）
└── docker-compose.yml                # ★ 部署配置
```

**关键代码模式**：

```typescript
// 流式响应处理（src/lib/utils/stream.ts 模式）
async function* streamChat(messages: Message[]) {
  const response = await fetch('/api/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: true }),
  });

  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader!.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop()!;

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6);
        if (data === '[DONE]') return;
        const parsed = JSON.parse(data);
        yield parsed.choices[0]?.delta?.content || '';
      }
    }
  }
}
```

**PWA manifest 关键字段**：
```json
{
  "name": "khy-os Mobile",
  "short_name": "khy-os",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#0d1117",
  "theme_color": "#58a6ff",
  "icons": [
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

---

### 2. Lobe Chat（UI 标杆）

**GitHub**: https://github.com/lobehub/lobe-chat

**为什么参考它**：
- 移动端体验最好的 AI 聊天界面
- 优雅的暗色主题、动画过渡
- 插件系统架构清晰

**抄哪里**：

```
lobe-chat/
├── src/
│   ├── features/
│   │   ├── Chat/                     # ★ 聊天核心
│   │   │   ├── index.tsx
│   │   │   ├── components/
│   │   │   │   ├── ChatInput/        # ★ 输入框（支持 Shift+Enter 多行）
│   │   │   │   ├── ChatList/         # ★ 消息列表
│   │   │   │   └── Thinking/
│   │   │   └── hooks/
│   │   │       ├── useChat.ts        # ★ 对话 hook（流式、停止、重试）
│   │   │       └── useChatContext.ts # ★ 上下文管理
│   │   └── Agent/
│   │       └── components/
│   │           └── PluginRender/     # ★ 工具调用渲染
│   ├── components/
│   │   ├── Markdown/                 # ★ Markdown 渲染（代码块+复制按钮）
│   │   │   ├── Markdown.tsx
│   │   │   ├── CodeBlock.tsx         # ★ 代码块（语言标签 + 复制）
│   │   │   └── Citation/
│   │   └── Mobile/                   # ★ 移动端专用组件
│   │       ├── TabBar/
│   │       └── PullRefresh/
│   └── hooks/
│       └── useMobile.ts              # ★ 移动端检测 hook
├── public/
│   └── manifest.json                 # ★ PWA manifest
└── app/
    └── provider.tsx                   # ★ 全局状态（主题、语言等）
```

**关键代码模式**：

```typescript
// useChat.ts 模式（features/Chat/hooks/useChat.ts）
function useChat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [abortController, setAbortController] = useState<AbortController | null>(null);

  const sendMessage = async (content: string) => {
    const userMessage = { role: 'user', content };
    setMessages(prev => [...prev, userMessage]);
    setLoading(true);

    const controller = new AbortController();
    setAbortController(controller);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [...messages, userMessage],
          model: selectedModel,
        }),
        signal: controller.signal,
      });

      // 流式读取
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let assistantContent = '';

      while (true) {
        const { done, value } = await reader!.read();
        if (done) break;
        const text = decoder.decode(value);
        assistantContent += text;
        setMessages(prev => {
          const last = prev[prev.length - 1];
          if (last?.role === 'assistant') {
            return [...prev.slice(0, -1), { ...last, content: assistantContent }];
          }
          return [...prev, { role: 'assistant', content: assistantContent }];
        });
      }
    } catch (e) {
      if (e.name !== 'AbortError') throw e;
    } finally {
      setLoading(false);
      setAbortController(null);
    }
  };

  const stop = () => abortController?.abort();

  return { messages, loading, sendMessage, stop };
}
```

**移动端适配关键**：
```css
/* 移动端：底部安全区 + 固定输入栏 */
.chat-container {
  display: flex;
  flex-direction: column;
  height: 100dvh; /* 动态视口高度 */
  padding-bottom: env(safe-area-inset-bottom);
}

.chat-messages {
  flex: 1;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}

.chat-input-bar {
  position: sticky;
  bottom: 0;
  padding: 8px 16px;
  padding-bottom: calc(8px + env(safe-area-inset-bottom));
  background: var(--color-background);
}
```

---

### 3. Dify（Agent 架构参考）

**GitHub**: https://github.com/langgenius/dify

**为什么参考它**：
- 最完整的开源 Agent 工作流引擎
- 代码解释器、HTTP 请求、知识库检索等工具实现
- API 设计清晰，可直接参考

**抄哪里**：

```
dify/
├── api/
│   ├── controllers/
│   │   └── service_api/              # ★ API 路由设计
│   ├── services/
│   │   ├── agent_service.py          # ★ Agent 服务（工具调用循环）
│   │   ├── llm/                      # ★ LLM 提供商适配
│   │   │   ├── model_provider_mapping.py  # ★ 模型映射表
│   │   │   └── utils/                # ★ 流式处理
│   │   └── tools/                    # ★ 工具系统
│   │       ├── builtin_tool_manager.py
│   │       ├── tool_file_handler.py
│   │       └── tool_parameter.py
│   └── models/
│       └── agent.py                  # ★ Agent 数据模型
├── web/
│   ├── app/
│   │   └── components/
│   │       └── base/
│   │           └── chat/
│   │               ├── ChatInput.tsx # ★ 聊天输入
│   │               ├── ChatList.tsx  # ★ 消息列表
│   │               └── Tool.tsx      # ★ 工具调用展示
```

**关键代码模式（Agent 工具调用循环）**：

```python
# agent_service.py 模式（简化版）
async def run_agent(
    self,
    messages: list[dict],
    model: str,
    tools: list[dict],
) -> AsyncIterator[str]:
    """Agent 主循环：LLM 生成 → 工具调用 → 结果回填 → 继续生成"""
    conversation_messages = messages.copy()

    while True:
        # 1. 调用 LLM
        response = await self.llm.chat(
            model=model,
            messages=conversation_messages,
            tools=tools,  # Function Calling
            stream=True,
        )

        # 2. 流式输出文本
        full_text = ""
        tool_calls = []

        async for chunk in response:
            delta = chunk.choices[0].delta
            if delta.content:
                full_text += delta.content
                yield f"data: {json.dumps({'type': 'text', 'content': delta.content})}\n\n"
            if delta.tool_calls:
                tool_calls.extend(delta.tool_calls)

        # 3. 如果有工具调用，执行它们
        if tool_calls:
            for call in tool_calls:
                tool_name = call.function.name
                tool_args = json.loads(call.function.arguments)

                # 执行工具
                result = await self.execute_tool(tool_name, tool_args)

                # 回填到对话
                conversation_messages.append({
                    "role": "assistant",
                    "tool_calls": [call],
                })
                conversation_messages.append({
                    "role": "tool",
                    "tool_call_id": call.id,
                    "content": str(result),
                })

                yield f"data: {json.dumps({'type': 'tool', 'name': tool_name, 'result': result})}\n\n"
        else:
            # 没有工具调用，对话结束
            break
```

**工具注册模式**：
```python
# 工具定义（OpenAI Function Calling 格式）
TOOL_DEFINITIONS = [
    {
        "type": "function",
        "function": {
            "name": "web_search",
            "description": "搜索互联网获取实时信息",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "搜索关键词",
                    }
                },
                "required": ["query"],
            },
        },
    },
    # ... 更多工具
]

# 工具执行分发
TOOL_HANDLERS = {
    "web_search": self._tool_web_search,
    "code_interpreter": self._tool_code_interpreter,
    "http_request": self._tool_http_request,
}

async def execute_tool(self, name: str, args: dict) -> str:
    handler = TOOL_HANDLERS.get(name)
    if not handler:
        return f"Error: unknown tool {name}"
    return await handler(args)
```

---

### 4. LibreChat（多后端参考）

**GitHub**: https://github.com/danny-avila/LibreChat

**为什么参考它**：
- 支持最多的 LLM 后端（OpenAI / Anthropic / Google / Ollama / Azure）
- 正在开发 React Native 移动端
- API 设计简洁

**抄哪里**：

```
librechat/
├── api/
│   ├── routes/
│   │   ├── chat.js                   # ★ 聊天路由（多供应商）
│   │   ├── models.js                 # ★ 模型列表接口
│   │   └── endpoints/                # ★ 各供应商端点配置
│   ├── services/
│   │   ├── chatService.js            # ★ 聊天服务（流式代理）
│   │   └── modelService.js           # ★ 模型服务
│   └── middleware/
│       └── parseEndpoint.js          # ★ 端点解析（从 env 或配置）
└── client/
    └── src/
        ├── components/
        │   └── Chat/
        │       ├── ChatInput.jsx     # ★ 输入组件
        │       └── ChatMessages.jsx  # ★ 消息组件
        └── hooks/
            └── useChat.js            # ★ 对话 hook
```

**关键代码模式（多供应商路由）**：
```javascript
// chatService.js 模式
async function* streamChat({ messages, model, provider }) {
  const endpoint = getEndpoint(provider); // 从配置获取 endpoint
  const apiKey = getApiKey(provider);     // 从配置获取 key

  const response = await fetch(`${endpoint}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
    }),
  });

  // 解析不同供应商的流式格式（OpenAI / Anthropic / Google 格式差异）
  yield* parseStream(response.body, provider);
}
```

---

### 5. NextChat（轻量参考）

**GitHub**: https://github.com/ChatGPTNextWeb/ChatGPT-Next-Web

**为什么参考它**：
- 极简架构，单个 Next.js 项目
- 配置简单，环境变量驱动
- PWA 配置完整

**抄哪里**：

```
chatgpt-next-web/
├── app/
│   ├── api/
│   │   └── chat/
│   │       └── route.ts             # ★ 流式聊天 API 端点
│   ├── globals.css                  # ★ 全局样式
│   └── page.tsx                     # ★ 主页面
├── public/
│   ├── manifest.json                # ★ PWA manifest
│   └── icon-*.png                   # ★ 图标
├── middleware.ts                    # ★ 认证中间件
├── next.config.js                   # ★ PWA 配置
├── .env.local.example               # ★ 配置模板
└── package.json
```

**关键代码模式（流式 API）**：
```typescript
// app/api/chat/route.ts
export async function POST(req: Request) {
  const { messages, model } = await req.json();

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({ model, messages, stream: true }),
      });

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader!.read();
        if (done) break;

        const text = decoder.decode(value);
        const lines = text.split('\n').filter(line => line.startsWith('data: '));

        for (const line of lines) {
          const data = line.slice(6);
          if (data === '[DONE]') {
            controller.close();
            return;
          }
          const parsed = JSON.parse(data);
          const content = parsed.choices[0]?.delta?.content || '';
          if (content) {
            controller.enqueue(encoder.encode(content));
          }
        }
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
```

---

## 三、khy-os 自身的可复用资产

### 可以直接照搬的 API 端点

khy-os 后端已有完整的 REST API，Flutter 端直接调用：

| 端点 | 方法 | 说明 | khy-os 实现位置 |
|------|------|------|-----------------|
| `/api/ai/prompts` | GET | 获取提示词列表（支持 status/source/q 过滤） | `aiManagementServer.js:2383` |
| `/api/ai/prompts/builtin` | GET | 内置 12 角度模板（公开，无需认证） | `promptTemplateCatalog.js` |
| `/api/ai/prompts` | POST | 创建提示词 | `aiManagementServer.js:2390` |
| `/api/ai/prompts/{id}` | PUT | 更新提示词 | `aiManagementConversationsPrompts.js` |
| `/api/ai/prompts/{id}` | DELETE | 删除提示词 | 同上 |
| `/api/ai/prompts/{id}/use` | POST | 记录使用次数 | 同上 |
| `/api/tools` | GET | 获取可用工具列表 | `aiManagementServer.js:2401` |
| `/api/ai/conversations` | GET | 获取对话历史 | 同上 |
| `/api/usage` | GET | Token 用量统计 | 同上 |
| `/api/models/{provider}` | GET | 获取供应商模型列表 | `aiManagementServer.js:2432` |

### khy-os 前端的可直接复用组件

khy-os 已有 `apps/ai-frontend/`（Vue 3），其中的以下组件/逻辑可以移植到 Flutter：

| Vue 组件 | Flutter 等价 | 可复用逻辑 |
|----------|-------------|-----------|
| `AIChat.vue` | `ChatPage` | 消息列表、流式渲染、Markdown |
| `PromptLibrary.vue` | `PromptsPage` | 提示词 CRUD、分类、搜索 |
| `ChatInputBar.vue` | `ChatInput` | 多行输入、发送、语音按钮 |
| `KhyOsTerminal.vue` | 第二版 | 终端模拟（xterm.js → flutter_terminal） |
| `usePromptLibrary.js` | `PromptProvider` | 提示词状态管理 |
| `useChatConversations.js` | `ChatProvider` | 对话管理 |
| `useGateway.js` | `KhyOsClient` | API 请求封装 |
| `newapi-theme.css` | `theme.dart` | 深色主题色值 |

### khy-os 后端的可复用服务

| 服务 | 作用 | 复用方式 |
|------|------|---------|
| `multiFreeService.js` | 多供应商 API 路由 | Flutter 端参考其路由逻辑 |
| `promptTemplateCatalog.js` | 12 角度内置模板 | 直接 JSON 移植到 Flutter |
| `promptLibraryService.js` | 提示词 CRUD | 参考接口设计 |
| `toolCalling.js` | 工具调用循环 | Flutter 端实现类似逻辑 |
| `promptAutoCapture.js` | AI 自动发现好提示词 | 第二版加入 |

---

## 四、关键设计决策参考

### 决策 1：WebView vs 原生 Flutter

| 方案 | 优点 | 缺点 | 结论 |
|------|------|------|-------|
| WebView 加载 khy-os Web UI | 零前端开发，直接用 | 性能差、离线不可用、APK 体积大 | ❌ 不推荐 |
| Flutter 原生 + 调用 khy-os API | 性能好、离线可用、APK 小 | 需要开发 UI | ✅ **推荐** |
| Capacitor 打包 PWA | 快速、复用 Web 代码 | 体验一般 | ⚠️ 备选 |

**最终决定：Flutter 原生**

### 决策 2：连接 khy-os 的方式

| 方式 | 复杂度 | 用户体验 | 推荐 |
|------|--------|---------|------|
| 手动输入 IP + Port | 低 | 差 | 备选 |
| 扫描二维码（khy-os 终端显示） | 中 | 好 | ✅ **主推** |
| NFC 触碰配对 | 高 | 极好 | 第三版 |
| 账号密码登录 | 中 | 中 | 备选 |

**最终决定：二维码为主 + 手动输入备选**

### 决策 3：离线 LLM

| 方案 | 优点 | 缺点 | 结论 |
|------|------|------|-------|
| Ollama（需要 Termux） | 完整 LLM 生态 | 需要 Linux 环境，设置复杂 | ⚠️ 高级选项 |
| llama.cpp（直接打包） | 纯原生，无需 Termux | APK 体积大（>100MB） | ❌ 太重 |
| 仅在线模式（第一版） | 最简单 | 需要网络 | ✅ **第一版** |

**最终决定：第一版仅在线，第二版加 Ollama/Termux 集成**

### 决策 4：状态管理

| 方案 | 适合 | 结论 |
|------|------|-------|
| Riverpod | Flutter 推荐，编译安全 | ✅ **推荐** |
| Bloc | 企业级，样板多 | ❌ 太重 |
| Provider | 简单但不够强 | ⚠️ 小项目可用 |
| GetX | 争议大 | ❌ 不推荐 |

**最终决定：Riverpod**

---

## 五、给 AI 的编码规范摘要

在写 Flutter 代码时，AI 应遵循：

```dart
// 1. 状态管理用 Riverpod
final chatProvider = StateNotifierProvider<ChatNotifier, ChatState>((ref) {
  return ChatNotifier(ref);
});

// 2. API 调用统一封装
class KhyOsApi {
  final Dio _dio = Dio(BaseOptions(
    baseUrl: baseUrl,
    connectTimeout: 30000,
  ));

  Future<Stream<String>> chatStream(List<Message> messages) async {
    final response = await _dio.post(
      '/api/ai/chat',
      data: {'messages': messages, 'stream': true},
      options: Options(responseType: ResponseType.stream),
    );
    return response.data.stream
        .transform(utf8.decoder)
        .transform(const LineSplitter())
        .where((line) => line.startsWith('data: '))
        .map((line) => jsonDecode(line.substring(6)));
  }
}

// 3. 本地数据库用 sqflite
class AppDatabase {
  static Future<AppDatabase> getInstance() async {
    final dbPath = await getDatabasesPath();
    final path = '$dbPath/khy_os_mobile.db';
    return AppDatabase._(await openDatabase(path, ...));
  }
}

// 4. 安全存储 API Key
final secureStorage = FlutterSecureStorage(
  aOptions: AndroidOptions(
    encryptedSharedPreferences: true,
  ),
);

// 5. WebSocket 带自动重连
class KhyOsWebSocket {
  WebSocketChannel? _channel;
  int _retryCount = 0;
  static const _maxRetries = 10;

  void connect(String url, String token) {
    _channel = WebSocketChannel.connect(Uri.parse('$url?token=$token'));
    _channel!.stream.listen(
      _onMessage,
      onError: _onError,
      onDone: _onDone,
    );
    _retryCount = 0;
  }

  void _onDone() {
    if (_retryCount < _maxRetries) {
      _retryCount++;
      Future.delayed(Duration(seconds: _retryCount * 2), connect);
    }
  }
}

// 6. 流式文本渲染
class StreamingText extends StatefulWidget {
  final Stream<String> stream;
  // ...
}

class _StreamingTextState extends State<StreamingText> {
  final _controller = TextEditingController();
  final _scrollController = ScrollController();

  @override
  Widget build(BuildContext context) {
    return TextField(
      controller: _controller,
      maxLines: null,
      readOnly: true,
      decoration: const InputDecoration(border: InputBorder.none),
    );
  }

  @override
  void initState() {
    super.initState();
    widget.stream.listen((chunk) {
      _controller.text += chunk;
      // 自动滚动到底部
      Future.delayed(const Duration(milliseconds: 50), () {
        _scrollController.jumpTo(_scrollController.position.maxScrollExtent);
      });
    });
  }
}
```

---

## 六、快速启动命令

AI 应该按此顺序执行：

```bash
# 1. 创建 Flutter 项目
flutter create khy_os_mobile --org com.khyos --project-name khy_os_mobile
cd khy_os_mobile

# 2. 添加依赖（pubspec.yaml）
dependencies:
  flutter_riverpod: ^2.5.0
  go_router: ^14.0.0
  flutter_secure_storage: ^9.0.0
  sqflite: ^2.3.0
  path_provider: ^2.1.0
  web_socket_channel: ^2.4.0
  dio: ^5.4.0
  flutter_markdown_quill: ^7.2.0
  permission_handler: ^11.0.0
  speech_to_text: ^6.6.0
  flutter_tts: ^3.8.0
  qr_code_scanner: ^1.0.0
  file_picker: ^8.0.0
  flutter_slidable: ^3.1.0
  flutter_local_notifications: ^17.0.0

# 3. 构建骨架后确认，再逐个实现页面
```

---

## 七、参考项目快速链接

| 项目 | GitHub | 核心参考文件 |
|------|--------|-------------|
| Open WebUI | https://github.com/open-webui/open-webui | `src/lib/stores/chat.ts`, `src/lib/utils/stream.ts`, `static/manifest.json` |
| Lobe Chat | https://github.com/lobehub/lobe-chat | `src/features/Chat/hooks/useChat.ts`, `src/components/Markdown/` |
| Dify | https://github.com/langgenius/dify | `api/services/agent_service.py`, `api/services/tools/` |
| LibreChat | https://github.com/danny-avila/LibreChat | `api/routes/chat.js`, `api/services/chatService.js` |
| NextChat | https://github.com/ChatGPTNextWeb/ChatGPT-Next-Web | `app/api/chat/route.ts`, `next.config.js` |

---

*最后更新：2026-08-28*

# [DESIGN-COMM-002] WebSocket 与 SSE 规范

> **用途**：定义 khy-os 项目中 WebSocket 和 SSE（Server-Sent Events）的使用标准。
> COMM-001 定义了通信协议框架，本文档补全实时通信细节。

---

## 1. 协议选型

### 1.1 选型决策矩阵

| 场景 | 推荐协议 | 原因 |
|------|---------|------|
| 服务端推送事件（单向） | SSE | 简单、自动重连、HTTP 兼容 |
| 双向实时通信 | WebSocket | 全双工、低延迟 |
| AI 流式对话 | WebSocket / fetch + streaming | 流式文本分块 |
| 进度通知 | SSE | 单向，适合进度推送 |
| 文件上传进度 | SSE / WebSocket | 进度事件 |

### 1.2 统一消息格式

所有实时消息使用 ACP-001 风格的信封格式：

```json
{
  "type": "event",
  "meta": {
    "requestId": "req-uuid",
    "traceId": "trace-uuid",
    "timestamp": "2026-09-10T12:00:00.000Z",
    "source": "backend"
  },
  "payload": {
    "event": "ai.chunk",
    "data": { "text": "Hello", "done": false }
  }
}
```

---

## 2. WebSocket 规范

### 2.1 连接管理

```javascript
const { WebSocketServer } = require('ws');

const wss = new WebSocketServer({
  path: '/ws',
  port: 3001,
  perMessageDeflate: false   // 禁用压缩以降低 CPU
});

// 连接跟踪
const connections = new Map();

wss.on('connection', (ws, req) => {
  const requestId = uuidv4();
  const traceId = req.headers['x-trace-id'] || uuidv4();
  
  connections.set(requestId, ws);
  
  // 注入元数据
  ws.requestId = requestId;
  ws.traceId = traceId;
  ws.authenticated = false;
  ws.userId = null;
  
  // 认证握手（10 秒超时）
  const authTimeout = setTimeout(() => {
    if (!ws.authenticated) {
      ws.close(4001, 'Auth timeout');
      connections.delete(requestId);
    }
  }, 10_000);
  
  ws.once('message', (data) => {
    clearTimeout(authTimeout);
    const msg = JSON.parse(data);
    
    if (msg.type === 'auth') {
      // 验证 token
      const decoded = verifyToken(msg.payload.token);
      ws.authenticated = true;
      ws.userId = decoded.sub;
      
      ws.send(JSON.stringify({
        type: 'auth_ok',
        meta: { requestId, traceId, timestamp: new Date().toISOString() },
        payload: { userId: decoded.sub }
      }));
    }
  });
  
  // 心跳
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  
  // 连接关闭
  ws.on('close', () => {
    connections.delete(requestId);
  });
});

// 心跳检测（每 30 秒）
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30_000);
```

### 2.2 心跳机制

| 参数 | 值 | 说明 |
|------|-----|------|
| Ping 间隔 | 30 秒 | 服务端主动 ping |
| Pong 超时 | 5 秒 | 未收到 pong → 断开 |
| 最大空闲 | 60 秒 | 无任何消息 → 断开 |

### 2.3 消息格式

```json
// 客户端 → 服务端
{
  "type": "request",
  "meta": {
    "requestId": "client-uuid",
    "traceId": "trace-uuid"
  },
  "payload": {
    "action": "ai.chat",
    "params": {
      "message": "Hello",
      "model": "default"
    }
  }
}

// 服务端 → 客户端
{
  "type": "event",
  "meta": {
    "requestId": "req-uuid",
    "traceId": "trace-uuid",
    "timestamp": "2026-09-10T12:00:00.000Z"
  },
  "payload": {
    "event": "ai.chunk",
    "data": {
      "text": "Hello",
      "done": false,
      "model": "default"
    }
  }
}
```

### 2.4 错误处理

```javascript
// 统一错误格式
{
  "type": "error",
  "meta": {
    "requestId": "req-uuid",
    "traceId": "trace-uuid",
    "timestamp": "2026-09-10T12:00:00.000Z"
  },
  "payload": {
    "code": "AI_ADAPTER_TIMEOUT",
    "message": "AI 服务响应超时",
    "retryable": true
  }
}
```

---

## 3. SSE（Server-Sent Events）规范

### 3.1 使用场景

| 场景 | SSE 优势 |
|------|---------|
| 任务进度推送 | 单向、自动重连 |
| 日志流 | 单向、文本友好 |
| 通知 | 单向、事件类型清晰 |

### 3.2 实现

```javascript
app.get('/api/v1/stream/tasks/:taskId', 
  requireAuth,
  async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');  // 禁用 nginx 缓冲
    
    const taskId = req.params.taskId;
    
    // 发送初始事件
    res.write(`event: connected\ndata: ${JSON.stringify({ taskId })}\n\n`);
    
    // 推送进度
    const interval = setInterval(async () => {
      const progress = await getTaskProgress(taskId);
      
      res.write(`event: progress\ndata: ${JSON.stringify({
        taskId,
        percent: progress.percent,
        status: progress.status
      })}\n\n`);
      
      if (progress.done) {
        clearInterval(interval);
        res.write(`event: complete\ndata: ${JSON.stringify({ result: progress.result })}\n\n`);
        res.end();
      }
    }, 1000);
    
    // 客户端断开
    req.on('close', () => {
      clearInterval(interval);
    });
  }
);
```

### 3.3 SSE 事件格式

```
event: progress
id: evt-001
data: {"percent": 50, "status": "processing"}

event: complete
id: evt-002
data: {"result": "success"}
```

---

## 4. 重连机制

### 4.1 WebSocket 重连

```javascript
class KhyWebSocket {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.reconnectAttempts = 0;
    this.maxReconnect = 10;
    this.baseDelay = 1000;
  }
  
  connect() {
    this.ws = new WebSocket(this.url);
    
    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      // 重新认证
      this.send({ type: 'auth', payload: { token: getToken() } });
    };
    
    this.ws.onclose = (event) => {
      if (!event.wasClean && this.reconnectAttempts < this.maxReconnect) {
        const delay = this.baseDelay * Math.pow(2, this.reconnectAttempts);
        setTimeout(() => this.connect(), delay);
        this.reconnectAttempts++;
      }
    };
    
    this.ws.onerror = (error) => {
      logger.error('WebSocket error', { error });
    };
  }
}
```

### 4.2 SSE 重连

SSE 原生支持重连（浏览器自动），服务端配合：

```javascript
// 服务端发送 last-event-id
res.write(`id: ${eventId}\n`);

// 客户端重连时携带
const evtSource = new EventSource('/api/v1/stream/tasks/123');
```

---

## 5. 背压处理

### 5.1 WebSocket 背压

```javascript
// 检测发送队列积压
ws.send = function(data) {
  if (this.bufferedAmount > 1024 * 1024) {  // > 1MB 积压
    logger.warn('WebSocket backpressure', {
      bufferedAmount: this.bufferedAmount
    });
    // 暂停接收，等积压消化
    this.pause();
  }
  
  this._send(data);
};
```

### 5.2 SSE 背压

```javascript
// 检测客户端消费速度
let sendQueue = [];
let isSending = false;

function queueEvent(event) {
  sendQueue.push(event);
  processQueue();
}

async function processQueue() {
  if (isSending || sendQueue.length === 0) return;
  
  isSending = true;
  const event = sendQueue.shift();
  
  try {
    res.write(formatEvent(event));
  } catch (e) {
    // 客户端断开
    clearInterval(interval);
    return;
  }
  
  isSending = false;
  
  // 间隔至少 50ms，避免过快
  await sleep(50);
  processQueue();
}
```

---

## 6. 安全

### 6.1 WebSocket 安全

| 检查 | 说明 |
|------|------|
| 认证握手 | 连接后 10 秒内必须发送 auth 消息 |
| Origin 检查 | 验证 `Upgrade` 请求的 Origin |
| Token 绑定 | Refresh Token 过期 → 断开 WS |
| 消息大小限制 | 单条消息 ≤ 1MB |

### 6.2 Origin 检查

```javascript
const ALLOWED_ORIGINS = ['https://khyquant.top', 'https://app.khyquant.top'];

wss.on('connection', (ws, req) => {
  const origin = req.headers.origin;
  
  if (!ALLOWED_ORIGINS.includes(origin)) {
    ws.close(4008, 'Origin not allowed');
    return;
  }
  
  // ...
});
```

---

## 7. 消息确认

### 7.1 至少一次投递

```javascript
// 客户端收到消息后发送 ack
ws.on('message', (data) => {
  const msg = JSON.parse(data);
  
  if (msg.type === 'request') {
    // 处理并回复
    const result = await handleRequest(msg.payload);
    ws.send(JSON.stringify({
      type: 'response',
      meta: { requestId: msg.meta.requestId },
      payload: result
    }));
  }
});

// 超时重发（服务端）
const pendingRequests = new Map();

function sendWithAck(ws, msg, timeout = 30_000) {
  return new Promise((resolve, reject) => {
    const requestId = msg.meta.requestId;
    
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error('Ack timeout'));
    }, timeout);
    
    ws.once('message', (data) => {
      const response = JSON.parse(data);
      if (response.meta.requestId === requestId) {
        clearTimeout(timer);
        pendingRequests.delete(requestId);
        resolve(response);
      }
    });
    
    ws.send(JSON.stringify(msg));
  });
}
```

---

## 8. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-10 | 初始版本，定义 WebSocket 与 SSE 规范 |

---

*本规范由 khy-os 平台团队维护*

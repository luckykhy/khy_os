<!-- 文档分类: IMPL-RPT-017 | 阶段: 实现 | 原路径: docs/指南/守护进程端口发现修复.md -->
# 守护进程端口发现机制 — 设计文档与学习指南

> 修复日期：2026-05-21
> 涉及模块：`daemonEntry.js` · `ai-manage-daemon.js` · `vite.config.js` · `daemonClient.js` · `serviceDefaults.js`

---

## 1. 问题背景

KHY OS 的 AI 管理系统有 **两条独立的 daemon 启动路径**，它们都会调用 `aiManagementServer.start()` 并默认绑定 **9090** 端口：

| 启动路径 | 入口文件 | 触发方式 |
|----------|---------|---------|
| 路径 A | `backend/scripts/ai-manage-daemon.js` | `khy gateway manage start` |
| 路径 B | `backend/src/services/daemonEntry.js` | `daemonManager.daemonStart()` |

### 为什么会冲突

`aiManagementServer.start()` 内置了端口自增重试逻辑（最多 +10）：

```
9090 被占用 → 尝试 9091 → 9092 → ... → 9099
```

当两条路径先后启动时，后启动的那个会自增到 9091+。但问题出在：**下游消费者不知道实际端口变了**。

### 受影响的下游消费者

```
┌─────────────────────────┬──────────────────────────────────┬──────────────┐
│ 消费者                   │ 文件                              │ 硬编码回退    │
├─────────────────────────┼──────────────────────────────────┼──────────────┤
│ Vite 代理 (/api, /ws)   │ ai-frontend/vite.config.js       │ 9090         │
│ 后端服务间调用            │ backend/src/constants/           │ 9090         │
│                         │   serviceDefaults.js             │              │
│ CLI daemon 客户端        │ backend/src/services/            │ 9090         │
│                         │   daemonClient.js                │              │
│ Docker nginx             │ ai-frontend/nginx.conf           │ 9090         │
└─────────────────────────┴──────────────────────────────────┴──────────────┘
```

### 用户可见症状

- AI 管理页面白屏 / 闪烁
- API 请求 504 超时
- WebSocket 连接失败
- CLI `gateway status` 显示端口但实际不通

---

## 2. 修复前的架构（仅路径 A 有 runtime 文件）

```
路径 A (ai-manage-daemon.js):
  start aiManagementServer(9090)
    → 实际绑定 9091（因为 9090 被占）
    → 写 ~/.khy/ai_manage_runtime.json  { apiPort: 9091 }  ✅
    → 传 VITE_AI_PROXY_TARGET=http://127.0.0.1:9091 给 Vite 子进程  ✅

路径 B (daemonEntry.js):
  start aiManagementServer(9090)
    → 实际绑定 9091
    → 只写 daemon.pid（无端口信息）  ❌
    → 不传 VITE_AI_PROXY_TARGET  ❌

独立启动 Vite：
  读 VITE_AI_PROXY_TARGET → 空
  读 VITE_AI_API_BASE_URL → 空
  回退到硬编码 9090  ❌ ← 实际服务在 9091
```

---

## 3. 修复后的架构（统一 runtime 文件发现）

### 3.1 核心原则

> **任何启动路径绑定端口后，都必须将实际端口写入 `ai_manage_runtime.json`。
> 任何需要连接 API 的消费者，都必须先尝试从该文件读取端口。**

### 3.2 Runtime 文件格式

路径：`~/.khy/ai_manage_runtime.json`（+ legacy `~/.khyquant/ai_manage_runtime.json`）

```json
{
  "pid": 12345,
  "apiPort": 9091,
  "startupAt": 1716278768000,
  "updatedAt": 1716278768000,
  "source": "daemonEntry"
}
```

路径 A (`ai-manage-daemon.js`) 会写入更多字段（`controlPort`, `frontendPort`, `frontendUrl` 等），路径 B (`daemonEntry.js`) 写最小兼容集。消费者只依赖 `apiPort` 字段。

### 3.3 端口发现优先级（所有消费者统一）

```
1. 显式参数 / 环境变量    （最高优先级）
2. ~/.khy/ai_manage_runtime.json → apiPort
3. 硬编码 9090             （最低优先级，兜底）
```

### 3.4 数据流图

```
                    ┌──────────────────────┐
                    │  aiManagementServer   │
                    │  .start(port)         │
                    │  返回实际绑定端口      │
                    └──────┬───────────────┘
                           │ actualPort
              ┌────────────┴────────────┐
              │                         │
     路径 A (ai-manage-daemon)    路径 B (daemonEntry)
              │                         │
              ▼                         ▼
    writeRuntime({apiPort})    writeRuntime({apiPort})
              │                         │
              └────────┬────────────────┘
                       ▼
          ~/.khy/ai_manage_runtime.json
                       │
        ┌──────────────┼──────────────────┐
        ▼              ▼                  ▼
   vite.config.js  daemonClient.js  serviceDefaults.js
   discoverApi     _discoverPort    _discoverAiBackend
   Target()        FromRuntime()    Url()
        │              │                  │
        ▼              ▼                  ▼
  proxy → 正确端口   连接 → 正确端口  URL → 正确端口
```

---

## 4. 逐文件修改详解

### 4.1 `backend/src/services/daemonEntry.js`

**改动目的**：让路径 B 也写 runtime 文件。

关键改动：

```javascript
// 新增：引入 dataHome 获取文件路径
const { getDataHome, getLegacyDataHome } = require('../utils/dataHome');
const RUNTIME_FILE = path.join(getDataHome(), 'ai_manage_runtime.json');
const LEGACY_RUNTIME_FILE = path.join(getLegacyDataHome(), 'ai_manage_runtime.json');

// 新增：写/清 runtime 文件
function writeRuntime() { /* 写入双路径 */ }
function clearRuntime() { /* 删除双路径 */ }

// 修改：捕获 start() 返回的实际端口
_actualPort = await mgmtServer.start(PORT);  // 之前传 {port:PORT}，修正为数字

// 新增：启动后写 runtime
writeRuntime();

// 新增：shutdown 时清理 runtime
function cleanup() {
  // ...原有 PID 清理
  clearRuntime();  // ← 新增
}
```

**学习要点**：
- `aiManagementServer.start(port)` 的参数是**数字**，不是对象。传对象虽然不崩（NaN 是 falsy，会回退到默认值），但会绕过显式端口指定
- 写双份文件（`~/.khy` + `~/.khyquant`）是为了向后兼容旧版安装

### 4.2 `ai-frontend/vite.config.js`

**改动目的**：独立启动 Vite 时也能发现正确端口。

```javascript
import fs from 'fs'
import os from 'os'

function discoverApiTarget() {
  // 1. 环境变量（daemon 子进程已设置）
  if (process.env.VITE_AI_PROXY_TARGET) return process.env.VITE_AI_PROXY_TARGET
  if (process.env.VITE_AI_API_BASE_URL) return process.env.VITE_AI_API_BASE_URL

  // 2. Runtime 文件
  const runtimeFile = path.join(
    process.env.KHY_DATA_HOME || path.join(os.homedir(), '.khy'),
    'ai_manage_runtime.json'
  )
  try {
    const raw = JSON.parse(fs.readFileSync(runtimeFile, 'utf-8'))
    if (raw?.apiPort) return `http://127.0.0.1:${raw.apiPort}`
  } catch {}

  // 3. 兜底
  return 'http://127.0.0.1:9090'
}
```

**学习要点**：
- Vite 配置在 **构建时** 执行（Node.js 环境），可以自由使用 `fs`/`path`/`os`
- `discoverApiTarget()` 在 Vite 启动时执行一次，结果缓存在 `apiTarget` 变量中
- 此函数不引入 `dataHome.js`（那是 CommonJS 后端模块），而是直接拼路径，保持前端构建零依赖后端

### 4.3 `backend/src/services/daemonClient.js`

**改动目的**：CLI 通过 DaemonClient 连 daemon 时能自动找到正确端口。

```javascript
function _discoverPortFromRuntime() {
  try {
    const { getDataHome } = require('../utils/dataHome');
    const file = path.join(getDataHome(), 'ai_manage_runtime.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (raw && typeof raw.apiPort === 'number') return raw.apiPort;
  } catch {}
  return null;
}

constructor(opts = {}) {
  this.port = opts.port
    || parseInt(process.env.KHY_DAEMON_PORT, 10)  // NaN 是 falsy
    || _discoverPortFromRuntime()
    || 9090;
}
```

**学习要点**：
- `parseInt(undefined, 10)` 返回 `NaN`，`NaN` 是 falsy，所以 `||` 链正确跳过
- `_discoverPortFromRuntime()` 返回 `null`（而非 `0` 或 `undefined`），确保 `||` 语义正确

### 4.4 `backend/src/constants/serviceDefaults.js`

**改动目的**：后端服务间调用也能找到正确的 AI 后端 URL。

```javascript
function _discoverAiBackendUrl() {
  try {
    const { getDataHome } = require('../utils/dataHome');
    const file = path.join(getDataHome(), 'ai_manage_runtime.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (raw && typeof raw.apiPort === 'number') {
      return `http://localhost:${raw.apiPort}`;
    }
  } catch {}
  return null;
}

const AI_BACKEND_URL = process.env.AI_BACKEND_URL
  || _discoverAiBackendUrl()
  || 'http://localhost:9090';
```

---

## 5. 边界情况与注意事项

### 5.1 Runtime 文件过期

daemon 进程崩溃（`kill -9`）不会触发 `cleanup()`，runtime 文件残留在磁盘上，`apiPort` 指向一个已死端口。

**缓解措施**：
- 路径 A 的 `_waitAiManageRuntimeReady()` 会验证控制端口可达性
- `daemonManager._isAlive()` 通过 `kill(pid, 0)` 检测进程存活
- 未来可在消费者侧增加 health check 回退

### 5.2 Docker 环境

Docker Compose 中 `ai-frontend` 容器使用 `nginx.conf` 直连 `ai-backend:9090`。这是容器内部网络，**不经过端口自增**（每个容器有独立端口空间），所以 Docker 模式不受此问题影响。

### 5.3 并发写入

两条路径不应同时启动。如果真的并发写 runtime 文件，`writeFileSync` 保证原子性（在同一进程内），最后写入的那个胜出。后启动的 daemon 是"真正在运行的"，所以它的端口覆盖前者是正确行为。

### 5.4 Windows 兼容

- `getDataHome()` 在 Windows 上优先选择 `D:\.khy`
- `writeRuntime()` 使用 `path.join()` + `fs.mkdirSync(recursive: true)`，路径分隔符由 Node.js 自动处理

---

## 6. 测试验证

```bash
# 模块加载测试（快速冒烟）
node -e "
  require('./backend/src/constants/serviceDefaults');
  const { DaemonClient } = require('./backend/src/services/daemonClient');
  new DaemonClient();
  console.log('OK');
"

# 完整测试套件
node node_modules/.bin/jest --testPathPattern="(gateway|daemon|cleanupService)" --no-coverage
# 预期：224 tests, 222 passed, 2 failed（已有的 aiGateway.exports 问题，与本次修复无关）
```

---

## 7. 设计模式总结

本次修复使用了 **文件系统服务发现（File-based Service Discovery）** 模式：

```
生产者：daemon 启动 → 写 runtime 文件（端口 + PID）
消费者：读 runtime 文件 → 获取实际端口
生命周期：daemon 关闭 → 删除 runtime 文件
```

这种模式的优缺点：

| 优点 | 缺点 |
|------|------|
| 零依赖（不需要 Redis/etcd/DNS） | 仅限单机（不跨节点） |
| 实现简单，调试容易 | 进程崩溃时文件残留 |
| 对网络栈无侵入 | 消费者需主动读取（非推送） |

适用场景：**本地开发环境、单机部署、CLI 工具链** — 正好是 KHY OS 的核心使用场景。

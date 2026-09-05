# 小程序 WebView 单例 & Canvas 检测 Hook 实施计划

> 状态：Draft  
> 关联项目：khyos-tauri（Windows 桌面 APP）  
> 前置完成：WebView 单例模式 ✓、Canvas 卡死检测方案 ✓

---

## 1. CanvasProfile Hook（S00）实现

### 目标

在 `core.js` 的 `execute()` 流程中，**执行前自动检测**当前小程序是否需要 Canvas 模式，
并启用 `CanvasStateManager.forceCanvasForWebview()`。

### 实现位置

`software/khyos-tauri/src/core/core.js` — `canvasProfile` hook

### 伪代码

```js
// core.js 中已注册的空 hook
const canvasProfile = {
  name: 'canvasProfile',
  
  /**
   * 执行前钩子：检测 BrowserWindow 可用性，决定是否启用 Canvas 模式
   * @param {object} ctx - 执行上下文
   * @param {BrowserWindow} ctx.window - 当前小程序的 BrowserWindow
   * @param {string} ctx.webviewId - 当前 webview 的唯一标识
   * @param {object} ctx.manifest - 小程序 manifest（含 canvas 配置）
   * @returns {object} { proceed: boolean, reason?: string }
   */
  async prepareExecution(ctx) {
    const { window, webviewId, manifest } = ctx;
    
    // 1. 检查 BrowserWindow 是否仍有效
    if (!window || window.isDestroyed()) {
      return { proceed: false, reason: 'BrowserWindow 已销毁' };
    }
    
    // 2. 检查 webview 是否仍挂载
    const webviewInstance = getWebviewInstance(webviewId);
    if (!webviewInstance || webviewInstance.isDestroyed?.()) {
      return { proceed: false, reason: 'WebView 实例已销毁' };
    }
    
    // 3. 判断是否需要 Canvas 模式
    const needsCanvas = manifest?.canvas === true 
      || manifest?.renderMode === 'canvas'
      || manifest?.appConfig?.canvas;
    
    if (needsCanvas) {
      CanvasStateManager.forceCanvasForWebview(webviewId);
      console.log(`[CanvasProfile] 已为 ${webviewId} 启用 Canvas 模式`);
    }
    
    return { proceed: true };
  }
};
```

### 调用点

在 `core.js` 的 `execute()` 中：

```js
async function execute(task, window) {
  // S00: Canvas 检测 hook
  const hookResult = await canvasProfile.prepareExecution({
    window,
    webviewId: currentWebviewId,
    manifest: task.manifest,
  });
  
  if (!hookResult.proceed) {
    throw new Error(`Canvas 检测失败: ${hookResult.reason}`);
  }
  
  // ... 后续执行逻辑
}
```

---

## 2. MINIAPP_WEBVIEW_SINGLETON.md 命名规范

### 变量命名（已确认）

| 变量名 | 用途 | 说明 |
|--------|------|------|
| `webviewId` | 当前 webview 的唯一标识 | 字符串，如 `"miniapp-trade-001"` |
| `webviewInstance` | 当前 webview 的 BrowserView 实例 | 运行时对象，可能为 `null` |

### 不再使用的命名

| 废弃名 | 替代为 |
|--------|--------|
| `miniappWebviewId` | `webviewId` |
| `miniappWebview` | `webviewInstance` |
| `activeWebview` | `webviewInstance` |

### 单例管理器接口

```js
// webviewSingleton.js
class WebViewSingleton {
  constructor() {
    this.webviewId = null;        // 当前活跃 webview ID
    this.webviewInstance = null;  // 当前活跃 webview 实例
  }
  
  /**
   * 获取或创建 webview
   * @param {string} id - webviewId
   * @param {object} opts - 创建选项
   * @returns {BrowserView}
   */
  acquire(id, opts) {
    if (this.webviewId === id && this.webviewInstance && !this.webviewInstance.isDestroyed?.()) {
      return this.webviewInstance; // 复用
    }
    // 销毁旧实例
    this.release();
    // 创建新实例
    this.webviewId = id;
    this.webviewInstance = createWebview(opts);
    return this.webviewInstance;
  }
  
  /**
   * 释放当前 webview
   */
  release() {
    if (this.webviewInstance && !this.webviewInstance.isDestroyed?.()) {
      this.webviewInstance.destroy();
    }
    this.webviewId = null;
    this.webviewInstance = null;
  }
  
  /**
   * 检查是否持有某个 webview
   */
  holds(id) {
    return this.webviewId === id && this.webviewInstance && !this.webviewInstance.isDestroyed?.();
  }
}

export const webviewSingleton = new WebViewSingleton();
```

---

## 3. 多实例场景处理

### 问题

当多个 khyos-tauri 实例同时运行时（例如用户打开了多个窗口），
每个实例有独立的 Electron 主进程和 BrowserWindow，
但它们可能连接同一个后端、加载同一个小程序。

### 场景分析

| 场景 | 风险 | 处理策略 |
|------|------|----------|
| 实例 A 打开小程序 X，实例 B 也打开小程序 X | 两个 webview 指向同一后端 | **允许**：各自独立的 webviewInstance，后端通过 session/token 区分 |
| 实例 A 启用 Canvas 模式，实例 B 未启用 | 状态不一致 | **隔离**：Canvas 模式是 per-webviewId 的，不影响其他实例 |
| 实例 A 销毁了 webview，实例 B 仍持有引用 | 悬空引用 | **防护**：acquire/release 时检查 `isDestroyed()` |
| 实例 A 的 webviewId 与实例 B 的 webviewId 冲突 | 单例管理器误判 | **ID 命名空间**：webviewId 加入实例前缀 |

### 推荐方案：实例隔离 + webviewId 命名空间

```js
// 生成带实例前缀的 webviewId
function makeWebviewId(miniappId, instanceId) {
  return `${instanceId}::${miniappId}`;
}

// 示例
// 实例 A: "instance-a::miniapp-trade"
// 实例 B: "instance-b::miniapp-trade"
```

每个实例的 `WebViewSingleton` 是独立的（因为每个 Electron 进程有自己的模块实例），
天然隔离。只需确保 `webviewId` 在跨实例通信（如 IPC）时不会冲突。

### CanvasStateManager 的多实例适配

```js
// canvasStateManager.js
class CanvasStateManager {
  constructor() {
    // Map<webviewId, { enabled: boolean, reason: string }>
    this.states = new Map();
  }
  
  forceCanvasForWebview(webviewId) {
    this.states.set(webviewId, { enabled: true, reason: 'forced-by-canvasProfile' });
  }
  
  isCanvasEnabled(webviewId) {
    return this.states.get(webviewId)?.enabled ?? false;
  }
  
  clearCanvas(webviewId) {
    this.states.delete(webviewId);
  }
}

export const canvasStateManager = new CanvasStateManager();
```

每个 Electron 进程有独立的 `canvasStateManager` 实例，
`webviewId` 带实例前缀后，即使跨进程 IPC 也不会冲突。

---

## 4. 实施步骤

### Step 1: 更新 MINIAPP_WEBVIEW_SINGLETON.md
- [x] 变量名统一为 `webviewId` / `webviewInstance`
- [x] 废弃旧命名
- [x] 补充多实例场景说明

### Step 2: 实现 CanvasProfile hook
- [ ] 在 `core.js` 中实现 `canvasProfile.prepareExecution()`
- [ ] 接入 `CanvasStateManager`
- [ ] 添加 `isDestroyed()` 安全检查

### Step 3: 多实例 ID 命名空间
- [ ] `webviewId` 生成逻辑加入 `instanceId` 前缀
- [ ] `WebViewSingleton.acquire/release` 适配新 ID 格式
- [ ] 跨实例 IPC 场景验证

### Step 4: 测试
- [ ] 单实例：打开/关闭小程序，验证单例复用
- [ ] 单实例：Canvas 模式自动启用
- [ ] 多实例：两个窗口同时打开同一小程序
- [ ] 多实例：一个窗口关闭后，另一个不受影响
- [ ] 异常：BrowserWindow 被销毁后 webview 清理

---

## 5. 关键设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| Canvas 状态存储位置 | 每个进程独立的 Map | Electron 多进程架构，天然隔离 |
| webviewId 命名空间 | `instanceId::miniappId` | 防止跨实例 ID 冲突 |
| isDestroyed 检查时机 | acquire/release/prepareExecution | 三处关键生命周期节点 |
| 单例管理器导出方式 | 模块级单例 | 每个进程一份，无需额外同步 |

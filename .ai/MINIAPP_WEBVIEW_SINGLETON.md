# 小程序 WebView 单例管理规范

> 版本：v2.0  
> 更新日期：2026-09-05  
> 关联项目：khyos-tauri（Windows 桌面 APP）

---

## 1. 变量命名规范

### 当前命名（统一使用）

| 变量名 | 类型 | 用途 |
|--------|------|------|
| `webviewId` | `string` | 当前 webview 的唯一标识，如 `"instance-a::miniapp-trade"` |
| `webviewInstance` | `BrowserView \| null` | 当前 webview 的运行时实例 |

### 废弃命名（不再使用）

| 废弃名 | 替代为 | 状态 |
|--------|--------|------|
| `miniappWebviewId` | `webviewId` | ❌ 已废弃 |
| `miniappWebview` | `webviewInstance` | ❌ 已废弃 |
| `activeWebview` | `webviewInstance` | ❌ 已废弃 |
| `miniAppWebview` | `webviewInstance` | ❌ 已废弃 |

---

## 2. 单例管理器接口

```js
// webviewSingleton.js
class WebViewSingleton {
  constructor() {
    this.webviewId = null;
    this.webviewInstance = null;
  }
  
  /**
   * 获取或创建 webview
   * @param {string} id - webviewId（格式："{instanceId}::{miniappId}"）
   * @param {object} opts - 创建选项
   * @returns {BrowserView}
   */
  acquire(id, opts) {
    if (this.webviewId === id 
        && this.webviewInstance 
        && !this.webviewInstance.isDestroyed?.()) {
      return this.webviewInstance;
    }
    this.release();
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
    return this.webviewId === id 
      && this.webviewInstance 
      && !this.webviewInstance.isDestroyed?.();
  }
}

export const webviewSingleton = new WebViewSingleton();
```

---

## 3. webviewId 命名空间

### 格式

```
{instanceId}::{miniappId}
```

### 示例

```
instance-a::miniapp-trade
instance-b::miniapp-trade
instance-a::miniapp-analysis
```

### 生成函数

```js
function makeWebviewId(miniappId, instanceId) {
  return `${instanceId}::${miniappId}`;
}
```

### 理由

多个 khyos-tauri 实例同时运行时，每个实例有独立的 Electron 主进程。
webviewId 加入实例前缀后，跨实例 IPC 通信不会产生 ID 冲突。

---

## 4. 多实例场景

### 架构

```
┌─────────────────────┐  ┌─────────────────────┐
│   实例 A (进程)      │  │   实例 B (进程)      │
│                     │  │                     │
│  WebViewSingleton   │  │  WebViewSingleton   │
│  ├─ webviewId       │  │  ├─ webviewId       │
│  └─ webviewInstance │  │  └─ webviewInstance │
│                     │  │                     │
│  CanvasStateManager │  │  CanvasStateManager │
│  └─ states Map      │  │  └─ states Map      │
└─────────┬───────────┘  └─────────┬───────────┘
          │                        │
          └──────┬─────────────────┘
                 │
          同一后端服务（通过 session/token 区分）
```

### 场景处理

| 场景 | 处理方式 |
|------|----------|
| 两实例同时打开同一小程序 | 允许，各自独立 webviewInstance，后端通过 session 区分 |
| 实例 A 启用 Canvas，实例 B 未启用 | 隔离，Canvas 状态是 per-webviewId 的 |
| 实例 A 销毁 webview，实例 B 仍持有 | 防护，`isDestroyed()` 检查 |
| webviewId 跨实例冲突 | 命名空间 `{instanceId}::{miniappId}` 防冲突 |

---

## 5. CanvasProfile Hook

### 接口定义

```js
const canvasProfile = {
  name: 'canvasProfile',
  
  /**
   * 执行前钩子：检测 BrowserWindow 可用性，决定是否启用 Canvas 模式
   * @param {object} ctx
   * @param {BrowserWindow} ctx.window
   * @param {string} ctx.webviewId
   * @param {object} ctx.manifest
   * @returns {{ proceed: boolean, reason?: string }}
   */
  async prepareExecution(ctx) {
    const { window, webviewId, manifest } = ctx;
    
    // 1. BrowserWindow 有效性
    if (!window || window.isDestroyed()) {
      return { proceed: false, reason: 'BrowserWindow 已销毁' };
    }
    
    // 2. WebView 实例有效性
    const wv = webviewSingleton.webviewInstance;
    if (!wv || wv.isDestroyed?.()) {
      return { proceed: false, reason: 'WebView 实例已销毁' };
    }
    
    // 3. Canvas 模式检测
    const needsCanvas = manifest?.canvas === true 
      || manifest?.renderMode === 'canvas'
      || manifest?.appConfig?.canvas;
    
    if (needsCanvas) {
      CanvasStateManager.forceCanvasForWebview(webviewId);
    }
    
    return { proceed: true };
  }
};
```

### 调用点

```js
// core.js → execute()
async function execute(task, window) {
  const hookResult = await canvasProfile.prepareExecution({
    window,
    webviewId: currentWebviewId,
    manifest: task.manifest,
  });
  
  if (!hookResult.proceed) {
    throw new Error(`Canvas 检测失败: ${hookResult.reason}`);
  }
  
  // ... 后续执行
}
```

---

## 6. 安全检查清单

在以下三个生命周期节点必须检查 `isDestroyed()`：

- [ ] `acquire()` — 复用前检查现有实例
- [ ] `release()` — 销毁前检查实例有效性
- [ ] `prepareExecution()` — 执行前检查 window 和 webview

---

## 7. 实施状态

| 任务 | 状态 | 位置 |
|------|------|------|
| 命名规范文档 | ✅ 完成 | `.ai/MINIAPP_WEBVIEW_SINGLETON.md` |
| CanvasProfile hook 实现 | ⏳ 待实现 | `khyos-tauri/src/core/core.js` |
| 多实例 ID 命名空间 | ⏳ 待实现 | `khyos-tauri/src/core/webviewSingleton.js` |
| CanvasStateManager 适配 | ⏳ 待实现 | `khyos-tauri/src/core/canvasStateManager.js` |

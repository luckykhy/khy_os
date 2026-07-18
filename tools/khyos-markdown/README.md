# khyosMarkdown · 内嵌 MD 工作台 + 跨平台右键集成

零外部依赖的单文件 Markdown 阅读/编辑工作台，解决 `.md` 在系统记事本里阅读体验极差的问题。
支持两种用法：**项目内嵌**（浏览本仓库 `docs/`）与**全局工具**（右键电脑上任意 `.md` 打开）。

> 规范依据：`docs/03_DESIGN_设计/[DESIGN-ARCH-032]`（架构）、`docs/08_MGMT_项目管理/[MGMT-STD-002]`（合并系统提示词与红线）。

## 目录文件

| 文件 | 职责 |
| --- | --- |
| `khyosMarkdown.html` | 单文件工作台：内联 MD 解析器 + 编辑器 + 预览 + CSS，零 CDN，断网可用 |
| `khyos-md-bridge.js` | 纯 Node 零依赖桥接器：`127.0.0.1` 同源服务，token 鉴权，消除 `file://` CORS |
| `khyos-md-launch.vbs` | Windows 隐藏式启动器（自定位，无控制台闪窗） |
| `register-windows.ps1` / `unregister-windows.ps1` | Windows 右键注册 / 卸载（仅 HKCU，无 UAC） |
| `register-linux.sh` / `unregister-linux.sh` | Linux 关联注册 / 卸载（仅 `~/.local`，无 sudo） |
| `test/` | `node:test` 用例：桥接器 13 + 解析器 12 = 25 绿 |

## 为什么需要桥接器（CORS 绝路）

浏览器禁止 `file://` 页面 `fetch` 本地文件。桥接器以 `http://127.0.0.1:<随机端口>` **同源**服务页面与
`/api/*`，请求根本不跨域 —— 不是放宽 CORS，而是消除它。仅监听本机回环，并用一次性 token 防止本机其他
网页越权调用。

## 快速开始

前置：已安装 [Node.js](https://nodejs.org/)（本仓库自带）。

### 直接打开某个文件（全局工具模式）

```bash
node khyos-md-bridge.js "/path/to/任意 文档.md"   # 自动起服务并打开浏览器
```

### 浏览本项目文档（项目内嵌模式）

```bash
node khyos-md-bridge.js                            # 无参 → 浏览本仓库 docs/
```

### 注册系统右键「使用 khyosMarkdown 打开」

Windows（PowerShell，**无需管理员**）：

```powershell
powershell -ExecutionPolicy Bypass -File register-windows.ps1
# 卸载：
powershell -ExecutionPolicy Bypass -File unregister-windows.ps1
```

Linux（**无需 sudo**）：

```bash
bash register-linux.sh
# 卸载：
bash unregister-linux.sh
```

注册后，右键任意 `.md` 即可见「使用 khyosMarkdown 打开」（Linux 在「打开方式」中）。

## 运行测试

```bash
node --test test/bridge.test.js test/parser.test.js
```

## 宪法红线（已落地）

1. **零外部依赖**：`khyosMarkdown.html` 不加载任何外部 CSS/JS/字体；MD 解析器自带。
2. **跨域绝路**：经桥接器同源服务，彻底消除 `file://` CORS；右键打开绝不因 CORS 读取失败。
3. **路径免疫**：路径经 `encodeURIComponent` + WHATWG URL 解码，空格/中文/特殊字符不断裂。
4. **系统纯净**：注册仅写用户级（HKCU / `~/.local`），无 UAC、无 sudo；卸载脚本零残留。

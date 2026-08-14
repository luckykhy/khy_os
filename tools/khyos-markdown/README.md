# khyosMarkdown

零依赖跨平台 Markdown 编辑器。支持 WYSIWYG 所见即所得编辑、Mermaid 流程图预览、图片粘贴上传、查找替换、大纲导航等。

## 特性

- 📝 三种视图：预览 / 分屏 / 源码
- 🎨 WYSIWYG 编辑（可选 Muya 引擎）
- 📊 Mermaid 流程图/时序图/甘特图
- 🖼 图片粘贴/拖拽/上传
- 🔍 查找替换 (Ctrl+F/H)
- 📑 大纲导航 + 同步滚动
- 🌙 明暗主题自动适配
- ⌨️ 丰富快捷键（Ctrl+/ 查看全部）
- 💾 自动保存 + 最近文件
- 🖥 独立 GUI 窗口（Edge/Chrome --app 模式）
- 🚀 零外部依赖，单文件 HTML 工作台
- 🤖 内置 MCP 服务器，供 AI Agent 调用

## 独立安装

### 方式一：npx 直接运行（无需安装）

```bash
npx khyos-markdown README.md
```

### 方式二：全局安装

```bash
npm install -g khyos-markdown
khyos-markdown ~/docs/notes.md
# 或简写
khyosmd ~/docs/notes.md
```

### 方式三：注册为系统默认 .md 编辑器

**Windows：**
```powershell
cd node_modules/khyos-markdown  # 或克隆目录
powershell -ExecutionPolicy Bypass -File register-windows.ps1
```

**Linux：**
```bash
bash register-linux.sh
```

### 方式四：作为 khy-os 内置工具

已集成在 khy-os 中，`khy` CLI 自动使用。

## 命令行用法

```bash
# 打开指定文件
khyos-markdown /path/to/file.md

# 浏览项目文档目录（项目内嵌模式）
khyos-markdown

# 不自动打开浏览器（API 模式）
khyos-markdown --no-open
```

## MCP 集成（供 AI Agent 调用）

khyosMarkdown 内置 MCP (Model Context Protocol) 服务器，任何支持 MCP 的 AI Agent（Claude Desktop、Cursor、Qoder 等）都可以调用。

### 提供的工具

| 工具 | 说明 |
|------|------|
| `read_markdown` | 读取 Markdown 文件内容 |
| `write_markdown` | 写入/保存 Markdown 文件（自动建目录） |
| `list_markdown` | 递归列出目录下所有 .md 文件 |
| `search_markdown` | 全文搜索关键词 |
| `open_editor` | 在 khyosMarkdown GUI 中打开文件供人查看 |
| `get_outline` | 提取文档标题大纲 |

### 配置示例（Claude Desktop / Cursor / Qoder）

```json
{
  "mcpServers": {
    "khyos-markdown": {
      "command": "node",
      "args": [
        "D:/Portable/khy-os/tools/khyos-markdown/khyos-md-mcp.js",
        "--root", "D:/你的文档目录"
      ]
    }
  }
}
```

`--root` 限制文件操作范围（安全边界），默认为当前工作目录。

## 目录文件

| 文件 | 职责 |
| --- | --- |
| `khyosMarkdown.html` | 单文件工作台：内联 MD 解析器 + 编辑器 + 预览 + CSS，零 CDN，断网可用 |
| `khyos-md-bridge.js` | 纯 Node 零依赖桥接器：`127.0.0.1` 同源服务，token 鉴权，消除 `file://` CORS |
| `khyos-md-mcp.js` | 零依赖 MCP 服务器（stdio JSON-RPC 2.0），供 AI Agent 调用 |
| `KhyosMarkdown.exe` | Windows 启动器（C# 编译，自动定位 node，无控制台窗口） |
| `khyosmarkdown` | Linux/macOS 启动脚本（自动查找 fnm/nvm/PATH 中的 node） |
| `khyosmarkdown.command` | macOS 双击启动器 |
| `register-windows.ps1` / `unregister-windows.ps1` | Windows 右键注册 / 卸载（仅 HKCU，无 UAC） |
| `register-linux.sh` / `unregister-linux.sh` | Linux 关联注册 / 卸载（仅 `~/.local`，无 sudo） |
| `vendor/` | muya WYSIWYG 引擎（可选，自打包） |
| `test/` | `node:test` 用例 |

## 为什么需要桥接器（CORS 绝路）

浏览器禁止 `file://` 页面 `fetch` 本地文件。桥接器以 `http://127.0.0.1:<随机端口>` **同源**服务页面与
`/api/*`，请求根本不跨域 —— 不是放宽 CORS，而是消除它。仅监听本机回环，并用一次性 token 防止本机其他
网页越权调用。

## 开发

```bash
git clone https://github.com/khy-os/khy-os.git
cd khy-os/tools/khyos-markdown
npm test
node khyos-md-bridge.js  # 启动开发服务
```

## 宪法红线（已落地）

1. **零外部依赖**：`khyosMarkdown.html` 不加载任何外部 CSS/JS/字体；MD 解析器自带。
2. **跨域绝路**：经桥接器同源服务，彻底消除 `file://` CORS；右键打开绝不因 CORS 读取失败。
3. **路径免疫**：路径经 `encodeURIComponent` + WHATWG URL 解码，空格/中文/特殊字符不断裂。
4. **系统纯净**：注册仅写用户级（HKCU / `~/.local`），无 UAC、无 sudo；卸载脚本零残留。

# [DESIGN-ARCH-032] 内嵌 MD 工作台与跨平台右键集成

| 项 | 值 |
| --- | --- |
| 文档类型 | 架构设计（ARCH） |
| 适用范围 | `tools/khyos-markdown/` 内嵌 Markdown 工作台及双平台右键集成 |
| 强制级别 | 设计基线（实现须符合本文「红线符合性」一节） |
| 上位治理 | [MGMT-STD-002]（合并系统提示词）、[MGMT-STD-001]（文档结构铁律） |
| 状态 | 定稿 |

---

## 1. 目标

`.md` 文件在系统记事本中阅读体验极差。本设计交付一个**零外部依赖的单文件工作台**，使本项目文档
**开箱即阅**，并可作为**全局工具**打开电脑上任意位置的 `.md`，覆盖 Windows 与 Linux 双平台右键集成。

## 2. 架构总览

```
右键 .md ──▶ 平台启动器 ──▶ khyos-md-bridge.js ──▶ http://127.0.0.1:<随机端口>
  (Win: VBS / Linux: .desktop)        │                    │
                                       │ 同源服务            ├─ GET  /            → khyosMarkdown.html
                                       │ token 鉴权          ├─ GET  /api/read    → 读目标文件（UTF-8）
                                       └────────────────────┼─ GET  /api/list    → 列 docs/ 的 .md
                                                            └─ POST /api/save    → 写回原文件
```

- **单文件工作台** `khyosMarkdown.html`：内联手写 MD 解析器（块级 + 行内，先转义后渲染防注入）、
  编辑器（textarea）、实时预览、明暗主题、文档树、分屏/预览/源码三视图，全部 CSS/JS 内联，零 CDN。
- **桥接器** `khyos-md-bridge.js`：纯 Node 零依赖。以本机回环同源服务页面与 API，从**根上消除**
  `file://` 的 CORS 限制（不是放宽 CORS，而是让请求不跨域）。随机空闲端口、一次性 token 鉴权。

## 3. 关键设计决策

### 3.1 为何用桥接器而非纯 file://
浏览器禁止 `file://` 页面 `fetch` 本地文件（同源策略）。若右键直接以 `file://` 打开 HTML，将**无法读取**
被右键的目标文件。桥接器以 `http://127.0.0.1` 同源服务页面与 `/api/read`，请求与页面**同源**，CORS 不再适用。

### 3.2 双模启动
- **项目内嵌模式**：桥接器无路径参数启动，`projectRoot` 经 `tools/khyos-markdown/` 上溯两级自定位，
  `/api/list` 默认列本仓库 `docs/`，文档树相对浏览。
- **全局工具模式**：右键传入绝对路径（`%1` / `%f`），页面 `?path=<encodeURIComponent>` 渲染任意位置文件。

### 3.3 端口与鉴权
端口取 `0` 由 OS 分配空闲端口，避免硬编码冲突。每次启动生成 `crypto.randomBytes(16)` token 并附于 URL；
`/api/*` 校验 token，防止本机其他网页/进程越权调用本端口读取磁盘。仅监听 `127.0.0.1`，不对外暴露。

### 3.4 平台启动器
- **Windows**：右键命令 `wscript.exe "<自定位>\khyos-md-launch.vbs" "%1"`。VBS 经 `ScriptFullName`
  自定位、以隐藏窗口模式后台起 node，避免控制台闪窗。注册仅写 `HKCU\...\SystemFileAssociations\.md\shell`，
  **不触发 UAC**。
- **Linux**：`~/.local/share/applications/khyosMarkdown.desktop`（`Exec=node <bridge> %f`，`MimeType=text/markdown`）
  + `~/.local/share/mime` 确保 `.md → text/markdown` 映射存在，`xdg-mime default` 设为默认，全用户级**无 sudo**。

## 4. 红线符合性

| 宪法红线 | 落点 |
| --- | --- |
| 零外部依赖 | `khyosMarkdown.html` 内联 MD 解析器/编辑器/预览/CSS，无任何外部 CSS/JS/字体/CDN，断网可用 |
| 跨域绝路 | 桥接器 `127.0.0.1` 同源服务页面与 API，消除 `file://` CORS；右键打开绝不因 CORS 读取失败 |
| 路径免疫 | 路径 `encodeURIComponent` 传入、WHATWG `URL.searchParams` 解码；VBS/`.desktop` 双引号/`%f` 包裹，空格/中文/特殊字符不断裂 |
| 系统纯净 | 注册仅写 HKCU / `~/.local`，无 UAC、无 sudo；`unregister-*` 脚本对称清除，零残留 |
| 规范服从 | 文件编号（本文 `DESIGN-ARCH-032`、合并提示词 `MGMT-STD-002`）由读取目录现有序列后动态决策，未写死格式 |

## 5. 交付物

```
tools/khyos-markdown/
  khyosMarkdown.html          单文件工作台（零依赖）
  khyos-md-bridge.js          纯 Node 桥接器（同源消除 CORS + token + 双模）
  khyos-md-launch.vbs         Windows 隐藏启动器（自定位）
  register-windows.ps1        Windows 右键注册（仅 HKCU，无 UAC）
  unregister-windows.ps1      Windows 卸载（零残留）
  register-linux.sh           Linux 关联注册（仅 ~/.local，无 sudo）
  unregister-linux.sh         Linux 卸载（零残留）
  README.md                   工具内操作快速上手
  test/bridge.test.js         桥接器 13 用例
  test/parser.test.js         解析器 12 用例
```

## 6. 验收

`node --test test/bridge.test.js test/parser.test.js` → **25 用例绿**：
- 桥接器：同源服务 HTML、token 缺/错 403、含空格+中文路径读取、不存在 404、缺 path 400、`/api/list`
  递归列 md 且忽略非文本、保存写回、拒写非文本扩展名、未知路由 404、token 不可预测、`startBridge` 绑回环
  随机端口、`openBrowser` 跨平台命令选择。
- 解析器（从 HTML 切出纯函数沙箱 eval）：标题/强调/代码块/列表/任务项/表格对齐/引用/链接图片自动链接/
  水平线/HTML 注入转义/段落软换行/真实文档冒烟。

零网络、隔离 tmp、测后清理。

## 7. 跨分类关联指引

- 合并系统提示词与宪法红线全文：`docs/08_MGMT_项目管理/[MGMT-STD-002]`。
- 文档结构与索引铁律：`docs/08_MGMT_项目管理/[MGMT-STD-001]`。
- 实现代码：`tools/khyos-markdown/`。

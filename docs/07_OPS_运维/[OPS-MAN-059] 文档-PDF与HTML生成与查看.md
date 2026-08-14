<!-- 文档分类: OPS-MAN-059 | 阶段: 运维 | 主题: 文档 PDF / HTML 生成与查看 -->
# [OPS-MAN-059] 文档 · PDF 与 HTML 生成与查看

> **参考手册** · 把 `docs/` 里的 markdown 变成**好看、可打印、可离线**的 HTML / PDF，一条线讲清。
>
> **一句话定位**：仓库里的 `.md` 是**唯一真源**；`.html` / `.pdf` 是从它**确定性生成的产物**。
> 想读得舒服（浮动目录、表格、代码块、中文字体）就生成 HTML；想归档 / 打印 / 发给别人就生成 PDF。
>
> 相关：`tools/khyos-markdown/`（右键打开任意 `.md` 的交互工作台）、
> [IMPL-RPT-023] 文档排版-内容与样式分离、[DESIGN-ARCH-032] 内嵌 MD 工作台、
> [DESIGN-ARCH-023] 文档排版与格式控制规范。

---

## 0. 先分清三条路（选对工具，别绕路）

| 我想做的 | 用哪个 | 产物 |
| --- | --- | --- |
| **随手读某个 `.md`**（阅读 / 小改） | `tools/khyos-markdown`（右键或命令打开） | 浏览器里实时预览，不落文件 |
| **把 `docs/` 文档生成漂亮 HTML / PDF** | `scripts/docs/md-to-pdf.js` | 自带样式的 `.html` + 打印版 `.pdf` |
| **让 AI 排版一篇论文 / 报告（Word）** | `renderDocument` 工具（REPL 内） | `.docx`（**注意：不产 PDF/HTML**，见 §4） |

> 记住这条分界：**读文档 → khyosMarkdown；发布/归档文档 → md-to-pdf.js；写正式 Word → renderDocument。**
> 本文主讲前两条（PDF / HTML），第三条只做澄清避免混淆。

```svg
<svg viewBox="0 0 720 260" xmlns="http://www.w3.org/2000/svg" font-family="sans-serif" font-size="13">
  <rect x="290" y="18" width="140" height="46" rx="8" fill="#eff4ff" stroke="#2563eb"/>
  <text x="360" y="40" text-anchor="middle" fill="#1f2328" font-weight="700">一份 .md</text>
  <text x="360" y="56" text-anchor="middle" fill="#6b7280" font-size="11">唯一真源</text>

  <line x1="360" y1="64" x2="120" y2="120" stroke="#9ab8ff" stroke-width="1.5"/>
  <line x1="360" y1="64" x2="360" y2="120" stroke="#9ab8ff" stroke-width="1.5"/>
  <line x1="360" y1="64" x2="600" y2="120" stroke="#9ab8ff" stroke-width="1.5"/>

  <rect x="30" y="120" width="180" height="58" rx="8" fill="#fff" stroke="#e5e7eb"/>
  <text x="120" y="142" text-anchor="middle" fill="#2563eb" font-weight="700">读 / 小改</text>
  <text x="120" y="160" text-anchor="middle" fill="#6b7280" font-size="11">khyosMarkdown</text>

  <rect x="270" y="120" width="180" height="58" rx="8" fill="#fff" stroke="#e5e7eb"/>
  <text x="360" y="142" text-anchor="middle" fill="#2563eb" font-weight="700">发布 / 归档</text>
  <text x="360" y="160" text-anchor="middle" fill="#6b7280" font-size="11">md-to-pdf.js</text>

  <rect x="510" y="120" width="180" height="58" rx="8" fill="#fff" stroke="#e5e7eb"/>
  <text x="600" y="142" text-anchor="middle" fill="#2563eb" font-weight="700">正式 Word</text>
  <text x="600" y="160" text-anchor="middle" fill="#6b7280" font-size="11">renderDocument</text>

  <rect x="45" y="204" width="150" height="34" rx="6" fill="#f6f8fa" stroke="#e5e7eb"/>
  <text x="120" y="225" text-anchor="middle" fill="#24292f">浏览器实时预览</text>
  <rect x="285" y="204" width="150" height="34" rx="6" fill="#f6f8fa" stroke="#e5e7eb"/>
  <text x="360" y="225" text-anchor="middle" fill="#24292f">.html + .pdf</text>
  <rect x="525" y="204" width="150" height="34" rx="6" fill="#f6f8fa" stroke="#e5e7eb"/>
  <text x="600" y="225" text-anchor="middle" fill="#24292f">.docx（Word）</text>

  <line x1="120" y1="178" x2="120" y2="204" stroke="#cbd5e1"/>
  <line x1="360" y1="178" x2="360" y2="204" stroke="#cbd5e1"/>
  <line x1="600" y1="178" x2="600" y2="204" stroke="#cbd5e1"/>
</svg>
```

> 上图：同一份 `.md` 真源，按目的分流到三条路；三种产物各不重叠（`renderDocument` 只产 `.docx`，见 §4）。

---

## 1. 生成 HTML + PDF（最常用）

真源脚本：`scripts/docs/md-to-pdf.js`。**零新增依赖**——复用仓库已内置的 `markdown-it`
（`extensions/khy-trae-bridge/node_modules/markdown-it`）解析 markdown，用系统的 **google-chrome
`--print-to-pdf`** 把生成的 HTML 打成 PDF。中文靠 Noto Sans/Serif CJK 渲染。

```svg
<svg viewBox="0 0 720 150" xmlns="http://www.w3.org/2000/svg" font-family="sans-serif" font-size="12.5">
  <rect x="20" y="52" width="120" height="46" rx="8" fill="#eff4ff" stroke="#2563eb"/>
  <text x="80" y="74" text-anchor="middle" fill="#1f2328" font-weight="700">.md 真源</text>
  <text x="80" y="90" text-anchor="middle" fill="#6b7280" font-size="10.5">markdown</text>

  <rect x="200" y="52" width="150" height="46" rx="8" fill="#fff" stroke="#e5e7eb"/>
  <text x="275" y="70" text-anchor="middle" fill="#24292f" font-weight="700">markdown-it</text>
  <text x="275" y="87" text-anchor="middle" fill="#6b7280" font-size="10.5">已内置·零新增依赖</text>

  <rect x="410" y="52" width="130" height="46" rx="8" fill="#f7faff" stroke="#9ab8ff"/>
  <text x="475" y="74" text-anchor="middle" fill="#2563eb" font-weight="700">.html</text>
  <text x="475" y="90" text-anchor="middle" fill="#6b7280" font-size="10.5">自包含·可离线</text>

  <rect x="600" y="52" width="100" height="46" rx="8" fill="#f6f8fa" stroke="#e5e7eb"/>
  <text x="650" y="74" text-anchor="middle" fill="#24292f" font-weight="700">.pdf</text>
  <text x="650" y="90" text-anchor="middle" fill="#6b7280" font-size="10.5">chrome 打印</text>

  <line x1="140" y1="75" x2="196" y2="75" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar)"/>
  <line x1="350" y1="75" x2="406" y2="75" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar)"/>
  <line x1="540" y1="75" x2="596" y2="75" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar)"/>
  <text x="568" y="42" text-anchor="middle" fill="#6b7280" font-size="10.5">--print-to-pdf</text>
  <text x="475" y="124" text-anchor="middle" fill="#6b7280" font-size="10.5">--html-only 到此为止（无需 chrome）</text>

  <defs>
    <marker id="ar" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L6,3 L0,6 Z" fill="#94a3b8"/>
    </marker>
  </defs>
</svg>
```

### 1.1 一个文件 → HTML + PDF

```bash
# 在仓库根目录执行
node scripts/docs/md-to-pdf.js "docs/07_OPS_运维/[OPS-MAN-037] pip安装后-完整还原与全功能开启指南.md"
```

默认在**源文件旁边**写出同名 `.html` 与 `.pdf`，并打印实际写出的路径。

### 1.2 常用选项

| 选项 | 作用 |
| --- | --- |
| `--out-dir <目录>` | 产物写到指定目录（默认：与源 `.md` 同目录） |
| `--html-only` | 只出 HTML，跳过 PDF（**没装 chrome 时用它**） |
| `--pdf-only` | 只出 PDF（内部仍会临时渲染一份 HTML，用完删） |
| `--combined "标题" 基名 a.md b.md ...` | 把多篇合成**一本**（带分页），生成 `基名.html` / `基名.pdf` |
| `--preset onboarding` | 一键重生成「使用入门→开发精通」成长路线全套（见 §3） |

### 1.3 批量 / 合订本

```bash
# 多个文件各自出一份
node scripts/docs/md-to-pdf.js a.md b.md c.md --out-dir /tmp/docs-out

# 合成一本（自动在每篇之间分页；目录汇总所有小节）
node scripts/docs/md-to-pdf.js --combined "运维手册合订本" 运维手册合订 \
  "docs/07_OPS_运维/[OPS-MAN-037] ....md" \
  "docs/07_OPS_运维/[OPS-MAN-032] ....md"
```

---

## 2. 没有 Chrome？两条退路

PDF 这一步依赖 headless Chrome。缺它时脚本会**明确报错**（不静默失败），有三种处理：

1. **装 chrome**（推荐）：装 `google-chrome` / `chromium` 任一即可，脚本自动探测。
2. **指到你已有的 chrome**：设环境变量 `KHY_DOCS_CHROME`（或 `CHROME_PATH`）指向浏览器可执行文件。
   ```bash
   export KHY_DOCS_CHROME="/usr/bin/chromium"
   node scripts/docs/md-to-pdf.js "docs/....md"
   ```
   探测顺序：`KHY_DOCS_CHROME` → `CHROME_PATH` → `google-chrome-stable` → `google-chrome`
   → `chromium` → `chromium-browser` → macOS 的 `Google Chrome.app`。
3. **只出 HTML，自己手动转 PDF**：
   ```bash
   node scripts/docs/md-to-pdf.js "docs/....md" --html-only
   ```
   然后在任意浏览器打开该 `.html` → `Ctrl/Cmd + P` → 目标选「**另存为 PDF**」。
   生成的 HTML **内置了打印样式**（`@media print` / `@page A4`：隐藏浮动目录、A4 页边距、
   代码/表格避免跨页断开），所以浏览器打印出来的版式与脚本自动生成的 PDF 基本一致。

> Chrome 打印参数（脚本内固定）：`--headless=new --no-pdf-header-footer
> --run-all-compositor-stages-before-draw --virtual-time-budget=15000`；老版本 chrome 拒绝
> `--headless=new` 时自动回退经典 `--headless`。**任一步失败都以真实原因非零退出**，不掩盖。

---

## 3. 一键重生成成长路线全套（preset）

`OPS-MAN-043` / `OPS-MAN-044` 这两篇「成长路线」文档常一起分发，脚本内置了 `onboarding` 预设，
把两篇各出一份独立 HTML/PDF，再合成一本合订本：

```bash
node scripts/docs/md-to-pdf.js --preset onboarding
```

产物（写在 `docs/07_OPS_运维/` 下）：

- `[OPS-MAN-043] ....html` / `.pdf`
- `[OPS-MAN-044] ....html` / `.pdf`
- `[OPS-MAN-043+044] 从使用入门到开发精通-合订本.html` / `.pdf`

> 预设的源清单是**单一真源**（脚本内 `ONBOARDING_DOCS`）。改了这两篇 `.md` 后重跑此命令即可刷新产物；
> 产物**永远从 `.md` 重生**，别手改 `.html` / `.pdf`（会被下次生成覆盖）。

---

## 4. 澄清：`renderDocument` 产的是 Word，不是 PDF/HTML

REPL 里的 `renderDocument`（别名 `typeset_document` / `render_docx` 等）是给 AI 写**论文/正式报告**用的
「内容与样式分离」排版器：模型只产语义内容，程序按模板确定性排版，**产物是 `.docx`（Word）**。
它**不产 PDF / HTML** —— 若要 PDF，请用 Word/WPS/LibreOffice 打开 `.docx` 后另存为 PDF。

- 设计动机与实现见 [IMPL-RPT-023]（内容与样式分离）、[DESIGN-ARCH-023]（排版规范）。
- 真源：`services/backend/src/tools/renderDocument.js` + `src/templates/docstyles/*.json`。

所以：**文档站点用的漂亮 HTML/PDF → §1 的 `md-to-pdf.js`；AI 写 Word 论文 → `renderDocument`。** 两条路各司其职。

---

## 5. 交互阅读：khyosMarkdown 工作台

只想**读**或**小改**某个 `.md`（不生成产物），用 `tools/khyos-markdown`：单文件、零外部依赖、断网可用，
经本机回环桥接器绕过 `file://` 的 CORS 限制（细节见 `tools/khyos-markdown/README.md`）。

```bash
# 打开任意 .md（自动起本机服务 + 开浏览器）
node tools/khyos-markdown/khyos-md-bridge.js "/path/to/任意 文档.md"

# 无参 → 浏览本仓库 docs/
node tools/khyos-markdown/khyos-md-bridge.js
```

注册系统右键「使用 khyosMarkdown 打开」（Windows 仅 HKCU、Linux 仅 `~/.local`，无 UAC / sudo）：

```bash
# Linux
bash tools/khyos-markdown/register-linux.sh
# Windows（PowerShell，无需管理员）
powershell -ExecutionPolicy Bypass -File tools/khyos-markdown/register-windows.ps1
```

> 想从工作台得到 PDF：浏览器里 `Ctrl/Cmd + P` → 另存为 PDF 即可；要归档级、带目录的排版版，仍推荐走 §1 的脚本。

---

## 6. 生成 HTML 的交互与图解特性

`md-to-pdf.js` 产出的 HTML 不只是"能看"，还内置了一批**在浏览器里交互、打印时自动降级**的能力
（全部内联，无 CDN、无外部 JS，断网可用）：

```svg
<svg viewBox="0 0 720 210" xmlns="http://www.w3.org/2000/svg" font-family="sans-serif" font-size="12.5">
  <rect x="20" y="24" width="150" height="160" rx="10" fill="#fff" stroke="#e5e7eb"/>
  <text x="95" y="46" text-anchor="middle" fill="#6b7280" font-size="11" font-weight="700">目录（sticky）</text>
  <rect x="34" y="58" width="122" height="18" rx="4" fill="#eff4ff" stroke="#2563eb"/>
  <text x="42" y="71" fill="#2563eb" font-size="10.5">▸ 当前小节高亮</text>
  <rect x="34" y="82" width="122" height="16" rx="4" fill="#fafbfc"/>
  <text x="42" y="94" fill="#374151" font-size="10.5">其它小节</text>
  <rect x="34" y="104" width="122" height="16" rx="4" fill="#fafbfc"/>
  <text x="42" y="116" fill="#374151" font-size="10.5">滚动即联动</text>

  <rect x="200" y="24" width="330" height="160" rx="10" fill="#fff" stroke="#e5e7eb"/>
  <text x="216" y="52" fill="#1f2328" font-size="14" font-weight="800"># 二级标题</text>
  <text x="216" y="52" fill="#2563eb" font-size="11" opacity="0.6">#</text>
  <text x="216" y="76" fill="#6b7280" font-size="10.5">悬停标题显示 # 永久链接（可复制定位）</text>
  <rect x="216" y="90" width="300" height="30" rx="6" fill="#f7faff" stroke="#9ab8ff"/>
  <text x="228" y="109" fill="#2563eb" font-size="11">[OPS-MAN-037] → 自动变成跨文档链接</text>
  <rect x="216" y="128" width="300" height="42" rx="6" fill="#fbfcff" stroke="#e5e7eb"/>
  <text x="228" y="147" fill="#6b7280" font-size="10.5">```svg 手写矢量图 → 直接渲染</text>
  <text x="228" y="163" fill="#6b7280" font-size="10.5">（打印清晰·可 git diff·无外链）</text>

  <circle cx="660" cy="164" r="20" fill="#2563eb"/>
  <text x="660" y="169" text-anchor="middle" fill="#fff" font-size="15" font-weight="700">↑</text>
  <text x="660" y="196" text-anchor="middle" fill="#6b7280" font-size="10">回到顶部</text>
</svg>
```

| 特性 | 行为 | 打印（PDF）时 |
| --- | --- | --- |
| **目录高亮** | 滚动时当前小节在左侧目录里高亮（IntersectionObserver） | 目录本就隐藏，无影响 |
| **标题永久链接** | 悬停 `h2/h3` 显示 `#`，点击即定位并可复制该锚点 URL | 隐藏 `#`，标题干净 |
| **回到顶部** | 滚过约 400px 出现右下角圆钮，点击平滑回顶 | 隐藏按钮 |
| **跨文档引用** | 正文里的 `[OPS-MAN-037]` 等编号**自动**变成指向同目录 `.html` 的链接 | 变普通文字（无下划线色块） |
| **内联 SVG 图解** | markdown 里的 ` ```svg ` 代码块**直接渲染成矢量图** | 矢量图打印清晰、避免跨页断开 |

**内联 SVG 怎么写**：在 `.md` 里用 ` ```svg ` 围栏包一段**手写 `<svg>`**（见本文各图）。脚本会
**清洗**它（剥离 `<script>` / `on*=` 事件 / 外链 `href`，`javascript:` 一律拒绝），只放行安全子集，
再包进 `<figure class="svg-figure">` 渲染。**好处**：零外部图片文件、打印清晰、可 `git diff`、断网可用——
比 Mermaid（要运行时/CDN，违反离线红线）或截图 PNG（破坏自包含、二进制进 git）都更契合本仓库。

> 这些特性**只在浏览器里生效**；生成的 PDF 通过内置 `@media print` 把交互元素全部降级/隐藏，
> 所以打印版**干净、稳定、与旧版一致**。所有脚本 fail-soft：任一步出错都不影响正文阅读。

---

## 7. 排错

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| `markdown-it not found` | 仓库未完整还原（缺 vendored 依赖） | 在**完整源码树**根目录执行；pip 装的用户先按 [OPS-MAN-037] 还原源码树 |
| `No chrome binary found for PDF export` | 没装 chrome / 未设 `KHY_DOCS_CHROME` | 见 §2：装 chrome、设环境变量、或加 `--html-only` |
| `Chrome did not produce a PDF` | chrome 崩溃 / 页面加载超时 | 重试；确认 HTML 能在浏览器正常打开；必要时先 `--html-only` 手动打印 |
| 中文变方框 / 缺字 | 系统缺 CJK 字体 | 装 `Noto Sans CJK SC` / `Noto Serif CJK SC`（Linux：`fonts-noto-cjk`） |
| 改了 `.md` 但 PDF 没变 | 忘了重新生成 | 产物不会自动跟随；重跑 §1 / §3 的命令 |
| 手改了 `.html` 却被覆盖 | HTML 是产物不是真源 | 只改 `.md`，再重生成 |

---

## 8. 红线（务必遵守）

1. **`.md` 是唯一真源**：`.html` / `.pdf` 一律从它生成，**绝不手改产物**（下次生成即覆盖）。
2. **零新增依赖**：生成脚本只用仓库已内置的 `markdown-it` + 系统 chrome，不引入新包。
3. **失败即报**：PDF 生成任一步失败都以真实原因非零退出，不产出半成品、不静默掩盖。
4. **离线可用**：生成的 HTML 自包含（内联 CSS + JS、系统字体、内联 SVG），断网也能正常阅读与打印。
5. **交互不入 PDF**：目录高亮 / 永久链接 / 回顶等只在浏览器生效，`@media print` 一律降级，保证打印版稳定。

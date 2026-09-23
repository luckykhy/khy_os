# [ZC-ALIGN-002] ZCode 页面与弹窗穷举清单（computer-use 逐一核对）

> 本文件是 092 设计文档「页面/面板/弹窗 1:1 复刻」的**穷举清单 + 核对结果**。
> 真源：`zcode-analysis/i18n-zh.json`（82 命名空间 / 5070 键）+ `rpc-surface.json`（127 方法）
> + 092 §5/§7 + 真实 ZCode v3.11.2 实机（`C:\Program Files\ZCode\ZCode.exe`）computer-use 观察。
> 本文件不替代 092；与 092 冲突时以 092 为准。

## 图例

- 类型：主页面 / 面板（侧栏内）/ 弹窗 / 独立窗口 / 下拉菜单 / 状态横幅 / 覆盖层 / 右键菜单 / Toast
- 核对：✅ 已核对（a11y 或截图证据）｜◻ 未核对（无法在安全操作序列内触发，标原因）
- 复刻现状：有 / 缺 / 失真 / 未实现

---

## A. 主布局层

| # | 名称 | 类型 | 入口/触发 | 真源（i18n ns / RPC / 092§） | 核对 | 复刻现状 | 备注 |
|---|------|------|-----------|------------------------------|------|----------|------|
| A1 | 主窗口（1216×808 默认、无边框、自绘 TitleBar 48px） | 主页面 | app 启动 | 092 §5.1/§5.2 | ✅ s-2 window 789328 | 有（尺寸 frame:false 已对） | P0 级几何 OK |
| A2 | 左窄图标栏（sidebar，55 键） | 面板 | 主窗口内 | 092 §7.1 / sidebar | ✅ s-2 左 330 区 | 失真 | 复刻是 12px 自造条（P0-2） |
| A3 | 工作区任务侧栏（workspaceSidebar，44 键） | 面板 | 主窗口内 | 092 §7.1 | ✅ 见 B1-B11 | 失真 | 见 P0-2 |
| A4 | 主内容区（chat 流 / 空状态） | 主页面 | 选中任务 | 092 §7.4 | ✅ s-2 L65 | 部分 | 复刻有 MessageList，空态不同 |
| A5 | 顶栏 tab 区（appHeader，22 键） | 面板 | 主窗口内 | 092 §7.12 | ✅ s-2 a67-a70 | 失真 | 见 P0-5 |
| A6 | 右面板（sidePane，34 键；v4Pane 10 键，3.11 四面板） | 面板 | 顶栏「展开侧边面板」 | 092 §7.10/§7.11 | ◻ 未展开 | 有组件 | 需展开核对内容 |

## B. 任务侧栏（左）

| # | 名称 | 入口 | 真源 | 核对 | 复刻现状 |
|---|------|------|------|------|----------|
| B1 | 新建任务（Ctrl+N，工作区按钮组） | 侧栏顶 | workspaceSidebar.newConversation | ✅ s-2 a155 | 缺 |
| B2 | 搜索（Ctrl+K） | 侧栏 | taskSearch（9 键） | ✅ s-2 a150 | 缺 |
| B3 | 自动化（定时任务入口） | 侧栏 | automations（167 键） | ✅ s-2 a149 | 有（侧栏入口 → #/automations 路由 + AutomationsPage + automation:* 5 IPC） |
| B4 | 插件市场（Installed/Discover 两页签） | 侧栏 | chat.mention.plugins / settings | ✅ s-2 a148 | 有（侧栏入口 → #/settings/plugins 深链） |
| B5 | 视图切换：分组 / 项目 两 tab | 侧栏 | workspaceSidebar.organize* | ✅ s-2 a146-a147 | 失真（复刻只有 grouped/chronological） |
| B6 | 分组分区头（分组颜色菜单 + 新建任务 + 计数） | 侧栏 | taskGroup（24 键） | ✅ s-2 a103/a124 | 缺 |
| B7 | 任务项（标题 + 相对时间 + hover 三按钮：显示文件树/移动到顶部/关闭） | 侧栏 | taskList（57 键） | ✅ s-2 a108/a110-a114 | 失真（复刻无 hover 三按钮） |
| B8 | 定时任务分区（scheduler 驱动） | 侧栏 | automations / scheduledPreview | ✅ s-2 a86-a97 | 缺 |
| B9 | 归档入口（「归档」按钮） | 侧栏 | workspaceSidebar.archivedTasks | ✅ s-2 a141 | 缺 |
| B10 | 新建分组入口 | 侧栏 | taskGroup | ✅ s-2 a142 | 缺 |
| B11 | 收起全部分组入口 | 侧栏 | workspaceSidebar.collapseAllGroups | ✅ s-2 a143 | 缺 |

## C. 侧栏底部账户区（状态栏等效）

| # | 名称 | 入口 | 真源 | 核对 | 复刻现状 |
|---|------|------|------|------|----------|
| C1 | 账户 chip（头像 + ntblocfk + 展开菜单 has_menu） | 左下 | login（32）/logout（5） | ✅ **s-31/s-33 实拍**：菜单＝**界面语言 >**/**界面主题 >**（子菜单：系统默认/深色主题✓/浅色主题）/**界面缩放 >**/─/使用统计/升级/─/**断开连接**（对应 logout.*）。复刻无此菜单 | 缺 |
| C2 | 移动端远程控制按钮 | 左下 | webRemoteControl（104） | ✅ s-2 a78 | 缺 |
| C3 | 设置按钮 | 左下 | settings（1724） | ✅ s-2 a77（点击进入全屏设置页，见 I 区） | 缺 |

## D. 顶栏（TitleBar）

| # | 名称 | 入口 | 真源 | 核对 | 复刻现状 |
|---|------|------|------|------|----------|
| D1 | 前进/后退/切换侧边栏 三图标 | 顶栏左 | titleBar（23） | ✅ s-2 a18-a20 | 失真 |
| D2 | 窗口菜单（有下拉） | 顶栏右 | titleBar.windowMenu | ✅ **s-29 实拍**：12 项合并式下拉＝新建任务 Ctrl+N/打开工作区 Ctrl+O/在资源管理器中打开/─/关于 ZCode/检查更新/进程监视器/─/问题反馈/**给产品提需求**/**用户社群**/**产品文档**/导出日志/─/关闭窗口。**与 092 §7.27 不符**：无 性能录制×2/DevTools/stdio 抓取/清除所有数据；多出 3 个 092 未列项。且 ZCode 无边框窗口**没有原生菜单栏**，所有菜单合并进此下拉；复刻用 Menu.setApplicationMenu 原生菜单栏 → **结构性失真** | 失真（复刻是原生菜单栏） |
| D3 | 展开侧边面板 | 顶栏右 | sidePane | ✅ s-2 a68 | 缺 |
| D4 | 切换终端（Ctrl+J） | 顶栏右 | terminal（10） | ✅ s-2 a69 | 缺 |
| D5 | 会话标题 + 工作区 chip（「khyos zcode复刻对比与失真对齐方案 ▾ khy-os」） | 顶栏中 | appHeader（22） | ✅ s-1(23:10) a117-a118 | 缺 |
| D6 | 选择打开方式（has_menu）/在资源管理器中打开/更多 | 顶栏中 | appHeader.selectOpenApp | ✅ s-1 a111-a113 | 缺 |
| D7 | 系统 caption 最小化/最大化/关闭（close 无文案） | 顶栏右 | titleBar.window.* | ✅ s-2 a164-a167 | 有（46px 三键） |
| D8 | 侧栏宽度拖拽条 | 侧栏右缘 | --workspace-sidebar-panel-width | ✅ s-2 a70 | 缺（复刻写死 280px） |
| D9 | 工作区文件操作按钮（「选择打开方式 ▾」「在资源管理器中打开」、网站 URL 行） | 消息流文件条目 | appHeader.openInFileManager | ✅ s-3 a179-a185/a201-a206 | 缺 |
| D10 | **顶栏「更多」菜单**（会话标题右侧 has_menu「…」） | 顶栏中 | appHeader.copy* 系列 | ✅ **s-38 实拍**：12 项＝置顶任务/重命名任务/归档任务/标记为未读（以上运行中 disabled）/─/在资源管理器中打开/复制路径/复制任务路径/复制日志路径/复制会话 ID/前往配置/─/查看调用轨迹/─/反馈问题。**新增 092 未列项**：置顶/重命名/归档/标记未读/前往配置/查看调用轨迹 | 缺 |

## E. 空状态页（chat.empty.*）

| # | 名称 | 真源 | 核对 | 复刻现状 |
|---|------|------|------|----------|
| E1 | 时段问候语（「夜深啦，别忘了照顾好自己哦」等 6 时段） | 092 §7.25 | ✅ s-2 a65 | 失真（复刻 welcome 页文案不同，且做成了独立页） |
| E2 | 项目选择器（「选择项目」+ 取消选择当前项目 双按钮） | projectSelector（2） | ✅ **s-41 实拍**：下拉＝🔍「搜索工作区」+ checkbox 项目列表（docs/2026下半年/docs/Portable/2027编制，**checkbox 非 radio**）+ 「打开文件夹」+「**远程连接**」（O4 的 UI 入口之一）+「不在项目中工作」。092 引用的三个文案全部实测命中 | 缺 |
| E3 | 快捷建议 chip（周报总结/报错修复/PPT 制作/闲时任务） | 092 §7.14 offPeak | ✅ s-2 a38-a41 | 缺 |
| E4 | 输入区（占位「向 ZCode 提问，使用 @ 添加上下文…」） | chat.placeholder.newTask | ✅ s-2 a56 | 失真（复刻占位文案不同） |
| E5 | 工具行：+ 添加上下文 / 模式选择（完全访问 has_menu）/ 模型选择器（Agnes AI 中国站/agnes-3.0-flash）/ 发送 | 092 §7.2/§7.3 | ✅ s-2 a44-a53 | 失真（复刻无 模型/模式/上下文/停止 四件套） |
| E5b | Composer 底部工具行 2（会话页）：+ 添加上下文 / 完全访问 / 上下文用量 / 模型选择器 / **思考强度下拉（低/高/最高/off）** / 停止生成 | 092 §7.2/§7.4 | ✅ s-3 a46-a59 | 失真（复刻无思考强度下拉与停止生成） |
| E6 | 上下文用量（「上下文已用 X / 总量 Y」pressable 统计） | chat.contextUsage | ✅ s-3 a55（249,664/1,000,000） | 有（Composer 工具行按钮 host 真源估算 + Token 用量面板 host 真数据，第十三轮：面板可长按 400ms 拖出为悬浮、位置 settings 持久化） |
| E7 | 停止生成按钮（生成中出现） | chat | ✅ s-3 a46 | 缺 |
| E8 | 快捷命令 chip 行（「computer-use 逐一核对：顶栏侧边面板…」胶囊，主内容区右上角） | 092 §7.14/quickPick | ✅ s-3 截图（顶栏下方） | 缺 |

## F. 消息流内交互（会话页）

| # | 名称 | 真源 | 核对 | 复刻现状 |
|---|------|------|------|----------|
| F1 | 消息气泡（折叠/展开/复制/大消息预览） | chat.message | ✅ s-1 可见 | 有 MessageBubble |
| F2 | 思考流（reasoning）+ 思考强度 Ctrl+T | 092 §7.4 | ✅ s-3 a47（「低」combobox） | 失真 |
| F3 | 子智能体事件行（「子智能体 Explore · success」） | 092 §7.4 | ✅ s-2(前会话) a91 | 缺 |
| F4 | 工具调用详情（「展开工具详情」has_menu + N 条消息/M 个事件 + 工具名「终端/电脑控制/读取应用界面/滚动界面」） | 092 §7.4 | ✅ s-3 a72-a76（16 个事件） | 失真 |
| F5 | 文件改动摘要（「展开已更改文件」has_menu + 「N 个文件已更改 +n -n」） | chat.changeSummary | ✅ s-3 a128-a134（1 个文件已更改 +255 -0） | 有 DiffSummary（形态不同） |
| F6 | 撤销按钮（「撤销」disabled 态，文件改动行右侧） | chat.changeSummary.rewindDialog | ✅ s-3 a127 | 未实现 |
| F7 | Elicitation 提问（需要确认 标题 + Tab/上下键提示 + 提交/继续/忽略/自定义 + 展开/折叠问题弹窗 + {seconds}秒倒计时） | 092 §7.6 | ◻ 需 agent 提问 | 有组件 |
| F8 | Goal 横幅 + 目标校验状态机（目标校验中/已完成/未完成/已中断/展开摘要） | 092 §7.7 | ✅ s-3 a152（Goal 标签 + 目标文字） | 有组件 |
| F9 | Hooks 展示（来源 3 态 + 状态 6 态） | 092 §7.8 | ◻ 需触发 | 未实现 |
| F10 | 长任务面板（「工作中 N 分 N 秒」/「已工作 N 分 N 秒」可展开横幅） | 092 §7.4 | ✅ s-3 a85/a147 | 未实现 |
| F10b | 停止状态标签（「已停止」has_menu） | 092 §7.4 | ✅ s-1 a183 | 未实现 |
| F10c | 已停止任务的分叉入口（「分叉」按钮 + 赞/踩/复制 行内操作） | 092 §7.4 | ✅ s-1 a174-a177 | 未实现 |
| F11 | 追问三选（立即发送/加入队列/引导当前任务） | chat.followup | ◻ 需生成中 | 未实现 |

## G. Composer 弹窗/弹出层

| # | 名称 | 真源 | 核对 | 复刻现状 |
|---|------|------|------|----------|
| G1 | @ 提及 6 分类（文件/会话/技能/子智能体/插件/画板） | chat.mention.category | ✅ 前会话输入可见 | 失真（复刻只有 4 类自造） |
| G0 | **添加上下文菜单**（「+」按钮下拉，4 项：**添加附件 / 使用 @ 添加上下文 / 使用 / 选择能力 / 使用 $ 选择技能**） | chat.composer.insert*Shortcut | ✅ s-22 a14-a29（截图 frame-aefbfed7） | 缺（复刻无此按钮菜单） |
| G0b | **模式选择菜单**（GLM provider 4 项：**变更前确认「改文件前先问我。」/ 自动编辑「自动编辑文件。」/ 计划模式「编辑前先出计划。」/ 完全访问「减少确认次数。」✓**） | mode.description.glm.*（092 §7.3） | ✅ s-19 a14-a29（截图 frame-57bc7297） | 失真（复刻 ModeSelector 形态/文案不同） |
| G0c | **模型选择菜单**（分组头「BigModel 体验」+ radio「GLM-5.3-Flash 视觉」+ 分隔线 + 子菜单 Sense Nova (商汤)/Agnes AI/Agnes AI 中国站 + 「管理模型」+ tooltip 快捷键 **Ctrl+M**） | model + 092 §7.14 | ✅ s-12/s-16（截图 frame-cb1d437e/frame-c556a42b） | 缺 |
| G0d | **上下文用量弹窗**（「上下文容量 26.4万/100万 (26.4%)」滑条 + 分解 7 项：消息 84.8%/MCP 工具 6.5%/系统工具 6.3%/系统提示词 0.6%/技能 0.4%/其他 1.4% + 「平均缓存命中率 95%」+ 「今日余额 150% 配额 升级/查看 150% 配额活动说明」+ 「GLM-5.3-Flash 100% 9月14日」） | chat.contextUsage.breakdown.*（092 §7.2） | ✅ s-5/s-6 a14-a41（弹窗实拍） | 缺（复刻 ContextUsagePanel 无此结构） |
| G0e | **升级套餐弹窗**（「升级套餐」网页面板，zcode.z.ai/coding-plan?provider=bigmodel&embedded=app 嵌入；个人套餐 5 卡：Start Plan ¥0.00/GLM Coding Lite ¥118.00 起/GLM Coding Pro ¥538.00 起/GLM Coding Max ¥1,078.00 起 + 团队套餐 标准版 ¥598.00 起/高级版 ¥1,198.00 起，各带积分与权益列表 + 「选择套餐」按钮 + 「已有权益」disabled） | codingPlan（30）/manualClaimPlan（55） | ✅ s-7 a20-a113（实拍） | 未实现（092 §7.14 替换策略：结构复刻、数据接 tokenUsageService、套餐名改 KhyOS 自有方案） |
| G0f | **CUA 状态悬浮窗**（「ZCode 正在操作电脑」独立小窗 313×70，电脑控制执行期间出现在屏幕右上，含 base64 data:URL 渲染） | cuaPermission/chat.cuaReadiness | ✅ s-11 window_id 4458558 实拍 | 缺（复刻无对应物） |
| G0g | **思考强度下拉**（Composer 工具行「高」combobox，可切 低/高，092 称 Thought Level Ctrl+T） | 092 §7.4 / reasoning.variants | ✅ s-6 a77/s-17 a47（低→高 实测切换） | 失真（复刻是按钮非下拉、文案「最高」vs 实测「高」） |
| G2 | # 插入会话提及 | chat.mention | ◻ 需在输入框键入 # | 缺 |
| G3 | $ 选择技能提及 | chat.mention | ◻（入口已核对 G0 菜单） | 缺 |
| G4 | / 选择能力命令 | chat.mention | ◻（入口已核对 G0 菜单） | 缺 |
| G5 | 附件上传（排队→正在上传{n}%→完成；失败/重试；大小/数量限制；拖拽「松开以添加附件」） | chat.attachments（40 键） | ◻ | 失真 |
| G6 | 草稿建议提示词（制作 PDF / 检查近 7 天 commit） | chat.draft.suggestedPrompt | ◻ | 缺 |
| G7 | 编辑区重置（对话+文件重置 三动作 + 冲突检测） | chat.edit | ◻ | 缺 |
| G8 | 上下文压缩动作（压缩→正在压缩→已压缩/已过期；重试 {n}/{max}） | chat.contextCompaction | ◻ | 缺 |
| G9 | 后台任务指示（Bash n 个，子智能体 n 个，共 n 个 + 3 tooltip） | chat.composer.backgroundWorks | ◻ | 缺 |

## H. 右面板 / v4Pane（3.11 四面板）

**已核对（2026-09-11 s-3/s-5 + 第三轮 s-43~s-49，真实 ZCode pid 18532/4872）**：顶栏「展开侧边面板」打开的是
「打开标签页」选择器（`选择要在侧边面板中打开的标签。` + 大磁贴，两行排列）。
**磁贴数量随上下文变化**：会话态 4 个（辅助对话/审查/终端/浏览器），**空态 3 个（审查/终端/浏览器，无辅助对话）**。

| # | 名称 | 磁贴 | 真源 | 核对 | 复刻现状 |
|---|------|------|------|------|----------|
| H0 | 打开标签页选择器（侧边面板空态） | 「辅助对话」（仅会话态）「审查」「终端」「浏览器」 | sidePane（34）/v4Pane（10） | ✅ s-3 四磁贴 + s-43 三磁贴（空态） | 有（磁贴选择器 + 多标签容器已实现；辅助对话磁贴仅会话态；5 磁贴含打开文件；tab 条含「搜索标签页」has_menu 下拉——2026-09-14 第十二轮） |
| H1 | 文件树面板（展开/折叠/拖拽引用/右键） | 「审查」磁贴内 | fileTree/fileActions/workspaceFileTree | ◻ | 有 GitPanel/Terminal 组件 |
| H2 | **终端面板** | 「终端」磁贴 | terminal（10） | ✅ **s-45 实拍**：面板顶部 tab 条（下拉 + tab「khy-os」带关闭× + 「新增标签」has_menu + 「搜索标签页」has_menu）；终端为**原生 PowerShell**（`PS D:\Portable>`，工作目录=所选工作区，印证 terminalInheritSystemProfile）；xterm 输入桥（Terminal input textfield）。**空态也可打开**（绑定工作区非会话） | 有 Terminal 组件（xterm 本体 + 令牌主题 + ResizeObserver refit + SidePane 外层多标签容器 + 「搜索标签页」has_menu 下拉已补齐——2026-09-14 第十二轮；shell/PTY 未接为 stub、多会话缺） |
| H3 | **审查面板**（Git） | 「审查」磁贴 | git（154）/gitGraph（27） | ✅ **s-49 实拍**：分支/范围 combobox「**未暂存**」+ 右上「刷新」+ Git 不可用空态（「当前环境没有可用的 Git」「请先安装 Git，或确认当前运行环境里可以执行 git 命令。」）。**侧边面板是多标签容器**（终端 khy-os + 审查 并存） | 有 GitPanel 组件（已挂入多标签容器） |
| H4 | 进程监视器（独立窗口 + 独立 preload） | 菜单入口 | processMonitor（6） | ◻ 独立窗口 | 未实现 |
| H5 | 代码查看器 / Diff / Markdown 表格图片 | — | codeViewer（71）/diff（10） | ◻ | 有 DiffViewer + CodeViewerPane（Markdown 预览/源码切换 + 自动换行 + 四态） |
| H6 | 内置浏览器（v4Pane「浏览器」磁贴） | 「浏览器」磁贴 | browser（41）/BrowserView* RPC | ◻（入口已核对） | 有（<webview> 内嵌真浏览器面板 + 导航/证书/崩溃四态；主进程 BrowserView* RPC 群未接） |
| H7 | **辅助对话面板** | 「辅助对话」磁贴（仅会话态） | sidePane | ◻ 需会话态 | 有（SelectionChatPane，走 ai:send/ai:abort 同主会话网关） |

## I. 设置域（settings，1724 键 —— 最大命名空间）

**已核对（2026-09-11 s-25，截图 frame-25dc156e）**：点侧栏底部「设置」齿轮 → **全屏替换式设置页**
（非弹窗、非抽屉；顶栏只剩 ZCode logo + 窗口菜单 + caption；左导航 330px + 右内容区）。
左侧导航实测结构（三组 + 独立项 + 底部账户行）：

```
← 返回工作区                     ← 顶部独立按钮（a131）
基础设置                          ← a122 分组头
├── 常规                          a127
├── 外观                          a126
├── 模型设置                      a125 ← 默认选中（本次落地页）
├── 浏览器控制                    a124
└── 电脑控制                      a123
Agent 能力                        ← a112 分组头
├── 记忆                          a119
├── 子智能体                      a118
├── 插件                          a117
├── MCP 服务器                    a116
├── 技能                          a115
├── 命令                          a114
└── 钩子                          a113
数据与统计                        ← a107 分组头
├── 索引库                        a109
└── 使用统计                      a108
引导                              ← a106 独立按钮（onboarding）
[底部] ntblocfk 账户 + 返回工作区   a101-a104
```

**模型设置页内容区（右侧）实测**：
- 标题「模型设置」+ 副标题「管理自定义模型供应商，配置后可在聊天时选择使用。」+ 刷新按钮
- **供应商双列**：左列 = 「智谱」组（**BigModel** 已启用）→「自定义供应商」组（智谱 GLM Coding Plan ✗ / Command Code (LongCat) ✗ / OpenCode Zen (Free) ✗ / Sense Nova (商汤) ✓ / Agnes AI ✓ / Agnes AI 中国站 ✓，各项带**拖拽排序把手**）→「+ 添加供应商」；
  右列 = BigModel 详情卡（**连接方式 combobox「体验套餐」** + 「ZCode Weekend Build 过期时间 9月14日 09:00」+ 「升级 150% 配额」+ 「查看 150% 配额活动说明」+ **今日余额卡 GLM-5.3-Flash 99%（296,027,644 / 300,000,000）9月14日** + 模型列表「GLM-5.3-Flash」（**视觉 / 1M** 能力标签 + 「测试模型」+「编辑模型配置」has_menu））

| # | 名称 | 真源 | 核对 | 复刻现状 |
|---|------|------|------|----------|
| I1 | 设置页骨架（全屏替换式 + 左导航三组「基础设置/Agent 能力/数据与统计」+「引导」+「返回工作区」） | 092 §7.13 | ✅ s-25 a101-a131 | 有（全屏替换式 + 左导航三组 + 引导 + 返回工作区 + 底部账户行；15 内容区；深链 #/settings/plugins） |
| I2 | 插件管理（Installed/Discover 两页签） | settings | ✅ 导航项「插件」a117（内容页 ◻） | 有（已安装/发现 两页签 + 启停/卸载/检查更新 + pluginStore 正门） |
| I3 | 技能 Skills | settings | ✅ 导航项 a115（内容页 ◻） | 有（ListSettingsPage kind=skill：agentItemStore 正门 + agent:* IPC + 创建/导入/启停/删除） |
| I4 | 子智能体 Subagents | subagentDirectory（13） | ✅ 导航项 a118（内容页 ◻） | 有（ListSettingsPage kind=subagent：agentItemStore 正门 + agent:* IPC） |
| I5 | MCP 服务器（stdio/HTTP/SSE + 协议版本 + OAuth） | 092 §7.16 | ✅ 导航项 a116（内容页 ◻） | 有（mcpList 真用户服务器 CRUD + 插件托管卡实时推导 + JSON 导入；stdio 命令行形态，无 OAuth） |
| I6 | 浏览器控制 | browser（41） | ✅ 导航项 a124（内容页 ◻） | 未实现 |
| I7 | 模型配置（供应商列表 + 拖拽排序 + 连接方式 + 余额卡 + 模型能力标签 + 测试/编辑） | model + 092 §7.14 | ✅ s-25 a24-a98 全实拍 | 未实现 |
| I8 | 用量统计 / Token 调试 | usage（6）/tokenDebug（15） | ✅ 导航项「使用统计」a108（内容页 ◻） | 有（usage:history 五跳真链路 + 按模型分项 + 每日时间线；用量重置仅 backend resetUsage（jest 16/16），IPC 通道未接线、用量页无重置按钮，待补） |
| I9 | 设置同步（settingsSync 59 键 + 首跑提示） | 092 §7.13 | ◻（可能在「常规」内） | 未实现 |
| I10 | 设置迁移标记（`<key>MigrationInitialized` 通用 migrateSetting） | 092 §7.13 | ◻（数据层，非 UI） | 未实现 |
| I11 | **电脑控制设置**（CUA 权限） | cuaPermission（28） | ✅ 导航项 a123（内容页 ◻） | 有（四档权限总闸 off/ask/on/strict + 信任区域白名单 + 单会话熔断上限，写 settings 后经 main→host fork IPC 实时写入 KHY_DESKTOP_CONTROL 等 env，safetyGate 每次授权重读立即生效；「后端生效状态」经 desktopGateGet 从 host 实读回显；默认 off fail-closed） |
| I12 | **记忆 / 索引库 / 钩子 / 命令 / 引导** 导航项（5 个） | repoWiki/memory/hooks/onboarding | ✅ s-25 a106/a109/a113/a114/a119 | 有（记忆/钩子/命令 = ListSettingsPage 三 kind；索引库 = IndexSettingsPage 真扫描；引导 = OnboardingDialog 真迁移向导（migration:scan/import）） |

## J. 更新体系（6 命名空间 + desktopMenu.help.*）

| # | 名称 | 真源 | 核对 | 复刻现状 |
|---|------|------|------|----------|
| J1 | 检查更新（正在检查更新...） | desktopMenu.help.checkingForUpdates | ◻ | 未实现 |
| J2 | 下载中（正在下载更新 {version}... / {progress}） | desktopMenu.help.downloading* | ◻ | 未实现 |
| J3 | 更新可用（发现新版本 {version} + updateDialog 14 键） | updateDialog/updateAvailable | ◻ 独立弹窗 | 未实现 |
| J4 | 更新就绪（重启以更新（{version}）全角括号） | updateReady（8） | ◻ | 未实现 |
| J5 | 强制更新（forceUpdate 7 键，不可跳过） | forceUpdate | ◻ | 未实现 |
| J6 | 更新后发布说明 | postUpdateReleaseNotes（2） | ◻ | 未实现 |

## K. 弹窗 / 对话框

| # | 名称 | 入口 | 真源 | 核对 | 复刻现状 |
|---|------|------|------|------|----------|
| K1 | 反馈对话框（OpenFeedbackDialog） | 菜单「问题反馈」 | feedback（290） | ◻ | 未实现 |
| K2 | 通用确认对话框（危险操作二次确认） | 清除所有数据等 | confirmDialog（8） | ◻ | 未实现 |
| K3 | 通用表单（forms 17 键） | — | forms | ◻ | 未实现 |
| K4 | 命令面板（Ctrl+K，「搜索并执行当前工作区可用的命令。」+ 最近使用） | 侧栏/快捷键 | commandCenter（20）/quickPick（57） | ✅ **s-35/s-47 实拍**：搜索框占位「**搜索操作、任务或文件**」+ 范围 tab **全部/操作/任务/文件** + 五分组＝**最近任务**（带相对时间）/「建议」（新任务 Ctrl+N、打开工作区 Ctrl+O、设置）、「面板」（**切换侧边栏 Ctrl+B**、切换终端 Ctrl+J、**切换预览**、**添加终端/浏览器/审查标签**）、「配置」（设置、**切换主题到浅色**、技能、MCP 服务器）、「应用」（问题反馈/用户社群/产品文档/断开连接）。**新证据**：Ctrl+B（092 只列 Ctrl+Alt+B）、切换预览、添加标签命令、最近使用（3.11.2 特性实证） | 有 CommandCenter 组件（新增「打开文件」命令；结构/分组对齐仍部分失真） |
| K9 | **升级套餐网页弹窗**（从「上下文用量→升级 150% 配额」进入；见 G0e） | codingPlan/manualClaimPlan | ✅ s-7 实拍 | 未实现 |
| K5 | 文件选择对话框（工作区/文件附加） | 打开工作区 | SelectFile/SelectFiles/SelectDirectory RPC | ◻ 系统对话框 | 未实现 |
| K6 | 更新状态窗口（OpenUpdateStatusWindow） | 更新流 | updateDialog | ◻ 独立窗口 | 未实现 |
| K7 | 内置浏览器 JS 对话框拦截（embeddedBrowserJavaScriptDialog.cjs preload） | 内置浏览器 | 092 §7.17 | ◻ | 未实现 |
| K8 | 键盘 12 语言白名单（shiki 首屏） | 代码块渲染 | 092 §10 | ◻ | 未实现 |

## L. 菜单（native / 自绘）

| # | 名称 | 真源 | 核对 | 复刻现状 |
|---|------|------|------|----------|
| L1 | 文件菜单（新建任务 Ctrl+N / 打开工作区 Ctrl+O / 关闭窗口 Ctrl+W） | titleBar.menu.file.* | ✅ 前会话 menu 可见 | 有（复刻 menu.js 已建） |
| L2 | 视图菜单（全屏 F11 / 放大 / 缩小 / 实际大小） | titleBar.menu.view.* | ✅ | 有 |
| L3 | 窗口菜单（窗口菜单 has_menu） | titleBar.windowMenu | ✅ s-2 a67 | 有 |
| L4 | 帮助菜单（关于 / 检查更新 / 问题反馈 / 导出日志 / 进程监视器 / 性能录制×2 / 开发者工具 F12 / stdio 抓取 / 清除所有数据） | desktopMenu.help.* | ✅ | 有（复刻 main menu 已含） |
| L5 | 工具菜单（密钥与端点管理 Ctrl+Shift+K）—— KhyOS 扩展 | 091 §5.1 | ✅ | 有（khy 自有，非 ZCode） |

## M. 独立窗口

| # | 名称 | 真源 | 核对 | 复刻现状 |
|---|------|------|------|----------|
| M1 | 进程监视器窗口（独立 preload processMonitor.cjs） | 092 §7.30 | ◻ | 未实现 |
| M2 | 内置浏览器（BrowserView* RPC 群，playwright-core） | 092 §7.17 | ◻ | 未实现 |
| M3 | 远程 Web 控制（webRemoteControl + 手机扫码 + relay device） | 092 §7.21 | ◻ | 未实现 |
| M4 | 密钥与端点管理窗口（#/key-manager，KhyOS 扩展 091） | 091 | ✅（复刻已有） | 有 |
| M5 | 更新状态窗口 | updateDialog | ◻ | 未实现 |
| M6 | **CUA 状态悬浮窗**（「ZCode 正在操作电脑」313×70 无边框小窗，电脑控制执行期间显示；关闭后消失） | cuaPermission / chat.cuaReadiness | ✅ s-11（window_id 4458558 实拍） | 缺 |

## N. 状态横幅 / 通知 / Toast

| # | 名称 | 真源 | 核对 | 复刻现状 |
|---|------|------|------|----------|
| N1 | 全局错误边界（appError.title/description 不白屏 + 区域 section*） | 092 §7.26 | ◻ 需触发 | 有 ErrorBoundary？ |
| N2 | chat.error 错误动作（重试/重新登录/重试验证码/稍后重试/切换模型/刷新额度/配置 + 复制 TraceID） | 092 §7.26 | ◻ 需触发 | 未实现 |
| N3 | 通知（ShowTaskNotification / TaskNotificationClick） | notification（11） | ◻ | 未实现 |
| N4 | Toast（--color-toast 暗 #2b2b2b/浅 #fff） | 092 §7.28 | ◻ | 有 ToastContainer |
| N5 | 更新横幅 | updateDialog | ◻ | 未实现 |
| N6 | 活动横幅（限时可领取 manualClaimPlan + 闲时算力 offPeak） | 092 §7.14 | ◻ | 未实现 |

## O. 环境能力面板（Docker/WSL/SSH/远程）

| # | 名称 | 真源 | 核对 | 复刻现状 |
|---|------|------|------|----------|
| O1 | Docker 容器（IsDockerAvailable / ListDockerContainers） | docker（9） | ◻ | 未实现 |
| O2 | WSL（ListWSLDistros） | wsl（11） | ◻ | 未实现 |
| O3 | SSH（ListSSHConfigAliases / ConnectRemote） | ssh（34） | ◻ | 未实现 |
| O4 | 远程连接（remote 51 + remoteConnection 1 + 取消待连接） | 092 §7.21 | ◻ | 未实现 |

## P. Bot / 自动化 / 闲时

| # | 名称 | 真源 | 核对 | 复刻现状 |
|---|------|------|------|----------|
| P1 | Bot 通道（微信/飞书/Telegram；命令 status/new/workspace/model/mode/thoughtLevel/reply） | bots（252） | ◻ | 未实现 |
| P2 | 自动化创建（automations.create / createManually / createViaChat） | automations（167） | ✅ s-2 a149 入口 | 未实现 |
| P3 | 闲时算力（offPeak 80 键 + scheduledPreview 5） | 092 §7.19 | ✅ s-2 a38 快捷入口 | 未实现 |

## Q. 知识库 / 白板

| # | 名称 | 真源 | 核对 | 复刻现状 |
|---|------|------|------|----------|
| Q1 | Repo Wiki（repoWiki 47 + wikiReference 20 + 5 正交索引开关） | 092 §7.22 | ◻ | 未实现 |
| Q2 | 白板 whiteboard（15 键 + @ 提及画板） | 092 §7.23 | ◻ | 未实现 |

## R. 登录 / 会话

| # | 名称 | 真源 | 核对 | 复刻现状 |
|---|------|------|------|----------|
| R1 | 登录（welcome 6 键 + login 32 + OAuthCallback） | 092 §7.25 | ◻ | 失真（复刻做成了首屏闸门，ZCode 里是设置能力） |
| R2 | 登出（logout 5） | 092 §7.25 | ◻ | 缺 |
| R3 | 首次引导 Onboarding（读 Claude/Codex 配置导入，62 键） | 092 §7.25 | ◻ | 未实现 |

## S. 调试 / 开发者

| # | 名称 | 真源 | 核对 | 复刻现状 |
|---|------|------|------|----------|
| S1 | 进程监视器（独立窗口） | processMonitor（6） | ◻ | 未实现 |
| S2 | Token 调试面板 | tokenDebug（15） | ◻ | 未实现 |
| S3 | 开发者工具（切换 DevTools F12 / stdio tap） | developerTools（18）/debugInfo（5） | ✅ 菜单项 | 部分 |
| S4 | 性能录制（开始/停止） | StartPerformanceTrace/Stop | ✅ 菜单项 | 部分 |

---

## 核对进度小结（截至 2026-09-11 第三轮实测，ZCode pid 4872）

- **已 a11y/截图核对（✅，三轮累计）**：
  - 主布局 A1-A6（三个形态：空态/会话态/设置态）
  - 侧栏 B1-B11；账户区 **C1（含完整菜单+主题子菜单）**-C3
  - 顶栏 D1-D10（含**窗口菜单 12 项**、**更多菜单 12 项**）
  - 空状态 E1-E8（含**项目选择器完整下拉**）
  - 消息流 F1-F6、F8、F10-F10c
  - Composer 弹层 G0-G0g、G1（添加上下文菜单/模式菜单/模型菜单/用量弹窗/升级弹窗/CUA 悬浮窗/思考强度）
  - 右面板 **H0（含空态/会话态磁贴差异）、H2 终端、H3 审查**；H1/H4/H5/H6/H7 ◻
  - 设置页 I1/I7/I11/I12（骨架+模型页全内容）
  - 弹窗 K4（**命令面板完整结构**）、K9（升级套餐）
  - 菜单 L1-L5（**L 区修正：实测为窗口菜单合并下拉，非原生菜单栏**）
  - 独立窗口 M4、M6；自动化 P2/P3；调试 S3/S4
- **未核对（◻，原因＝需运行态触发或破坏性/环境依赖操作）**：
  - H1 文件树内容（审查面板内，需 git 仓库）、H4 进程监视器（独立窗口）、H5 代码查看器（需 diff）、H6 浏览器面板（重资源）、H7 辅助对话（需会话态磁贴）
  - F7 elicitation、F9 hooks、F11 追问三选（agent 运行态）
  - G2-G4（#/$// 键入触发）
  - I2-I6、I8、I9 设置内容页（导航已确认，留待实现时按需）
  - J 更新流（避免实际下载）；K1/K2/K5/K7；M1/M2/M3/M5；N1-N6；O1-O4；P1；Q1-Q2；R2-R3
- **复刻现状统计（按清单逐项）**：有 26 / 失真 13 / 缺 16 / 未实现 13。（2026-09-13 第十一轮：B3/B4 缺→有，H0/H6/H7/I1/I2 未实现→有；H2/H3/H5/K4 仅措辞更新。2026-09-14 第十二轮：H0/H2 内「搜索标签页」has_menu 下拉补齐（第十一轮遗留），仅措辞更新、计数不变。2026-09-14 第十三轮：I3/I4/I5/I8/I12 未实现→有（+5 有，未实现 19→14），E6 缺→有（+1 有，缺 17→16）→ 计数：有 25 / 失真 13 / 缺 16 / 未实现 14。2026-09-15 第十四轮：I11 未实现→有（+1 有，未实现 14→13）→ 计数：有 26 / 失真 13 / 缺 16 / 未实现 13）

**第三轮新增失真（对 ZC-ALIGN-001 的增量，全部带实拍证据）**：
1. **L 区结构性失真**：ZCode 无边框窗口无原生菜单栏，所有菜单合并进顶栏「窗口菜单」下拉（12 项）；复刻用 Menu.setApplicationMenu 原生菜单栏 + 五菜单结构 → 需重做为自绘下拉。
2. **窗口菜单内容**与 092 §7.27 不符：实测无 性能录制/DevTools/stdio 抓取/清除数据；多出 给产品提需求/用户社群/产品文档。复刻 menu.ts 按 092 写的菜单项需按实测修正。
3. **账户菜单**（界面语言/主题/缩放三子菜单 + 使用统计/升级/断开连接）复刻完全没有。
4. **命令面板**真实结构（四范围 tab + 五分组 + Ctrl+B + 添加标签命令 + 最近任务）与复刻 CommandCenter 不符。
5. **更多菜单** 12 项（置顶/重命名/归档/标记未读/复制四件套/前往配置/调用轨迹/反馈）复刻缺失。
6. **项目选择器**为 checkbox 多选列表 + 打开文件夹/远程连接/不在项目中工作，复刻缺。
7. **侧边面板是多标签容器**（终端+审查并存、tab 可关闭、新增标签、搜索标签页），空态磁贴 3 个、会话态 4 个（辅助对话仅会话态）——复刻已于 2026-09-13 第十一轮部分实现（磁贴选择器 + tab 可关闭 + 新增标签 + 终端/审查并存），「搜索标签页」has_menu 下拉已于 2026-09-14 第十二轮补齐，仅剩多会话（多终端实例）未实现。
8. **终端面板**绑定工作区（空态可用），原生 PowerShell、目录=工作区根——印证 092 terminalInheritSystemProfile。
9. **审查面板**空态有明确 Git 缺失文案与「未暂存」范围筛选。

## 下一步核对计划（computer-use 继续）

已完成（三轮累计）：
1. ✅ 第一轮：主布局/侧栏/账户区/顶栏/空态/消息流（pid 18532 会话态）。
2. ✅ 第二轮：Composer 全弹层（模型/模式/上下文菜单、用量弹窗、升级弹窗、CUA 悬浮窗）+ 设置页骨架与模型页 + H0 磁贴（pid 4872 重启后）。
3. ✅ 第三轮：窗口菜单 12 项、账户菜单（含主题子菜单）、命令面板完整结构、更多菜单 12 项、项目选择器下拉、H2 终端面板、H3 审查面板、空态磁贴差异。

剩余（低优先级/需特定触发，留待复刻实现时按需核对）：
1. H1 文件树内容（需 git 仓库）、H4 进程监视器、H5 代码查看器、H6 浏览器面板、H7 辅助对话（会话态）。
2. I2-I6/I8/I9：设置页各内容页。
3. G2-G4：键入 #/$// 触发提及浮层。
4. F7/F9/F11：agent 运行态触发。
5. J/N/O/P1/Q/R2-R3：更新流（避免下载）、错误边界（需制造错误）、环境面板、Bot、Wiki/白板、登出/Onboarding（会改状态）。

> 安全边界：不实际执行 更新下载/强制更新/清除数据/真实登录 等破坏性或需凭据操作；
> 只做 UI 形态核对与截图留证。
> **操作纪律**：对 ZCode 主窗口避免 raw 键盘（Escape 会被其内嵌 agent 捕获为输入并消耗额度），
> 优先 element AXPress/AXExpand；关闭弹层用点击空白处。

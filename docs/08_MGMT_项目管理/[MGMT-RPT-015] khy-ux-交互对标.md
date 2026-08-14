<!-- 文档分类: MGMT-RPT-015 | 阶段: 项目管理 | 原路径: docs/指南/khy-ux-交互对标.md -->
# KHY OS 交互模式对标分析与优化路线图

> 对标项目：OpenCode、Claude Code、DeepSeek TUI、Hermes Agent
> 创建日期：2026-05-21
> 状态：**全部完成** (G1-G10 均已实施，2026-05-21)

---

## 一、对标项目核心交互机制速查

### 1.1 OpenCode

| 维度 | 机制 |
|------|------|
| 权限模型 | Effect + Deferred 阻塞，3 级权限（allow / ask / deny） |
| 选择 UI | `DialogSelect` + 模糊搜索（fuzzy filter），5 种对话类型 |
| 命令路由 | 纯 exact match，无 NLP 路由 |
| 防循环 | doom loop 检测：连续 3 次工具失败后自动停止 |
| 特色 | 权限粒度细（按工具+路径组合），模糊搜索体验好 |

### 1.2 Claude Code

| 维度 | 机制 |
|------|------|
| 提问工具 | `AskUserQuestionTool`：Zod schema，1-4 个问题，每题 2-4 选项 |
| 选择 UI | 单选 / 多选（`multiSelect` 标志位），preview 面板（右侧预览） |
| 兜底输入 | 所有选择自动附加 "Other" 自由输入 |
| 权限模型 | 多源竞速：用户审批 / 分类器自动放行 / hook 拦截 / bridge 中转 |
| Plan Mode | 非平凡任务自动进入规划模式，用户审批后再执行 |
| 反馈展示 | ~200 个动态 spinner 动词，工具调用详细展开+折叠 |
| 特色 | preview 面板信息密度高，Plan Mode 降低返工率 |

### 1.3 DeepSeek TUI

| 维度 | 机制 |
|------|------|
| 确认模型 | **风险分级 2-key 确认**：低风险 1-key，破坏性操作 staged 2-key |
| 提问工具 | `request_user_input`：1-3 个问题，每题 2-3 选项 + "Other" |
| 命令纠错 | **Levenshtein 编辑距离**：拼错命令自动建议最接近的候选 |
| 工作区信任 | workspace trust 机制，首次进入新目录需确认 |
| 特色 | 2-key 确认对破坏性操作防护最强，拼写纠错实用性高 |

### 1.4 Hermes Agent

| 维度 | 机制 |
|------|------|
| 澄清机制 | `clarify` 工具 + **超时降级**：15s 无回复 → "use best judgement" |
| 忙碌输入 | **3 模式状态机**：queue（排队）/ steer（修正方向）/ interrupt（中断） |
| 工具护栏 | 3 级阈值：warn（提示继续）/ block（需确认）/ halt（强制停止） |
| 多前端 | Gateway 中转，CLI / Web / 移动端共享同一会话 |
| 特色 | 超时降级避免阻塞，忙碌输入处理最成熟 |

---

## 二、KHY 现状差距分析

### 2.1 确认与权限

| 能力 | 对标最佳实践 | KHY 现状 | 差距 |
|------|-------------|---------|------|
| 破坏性操作确认 | DeepSeek 2-key staged | 仅 inquirer confirm | 无风险分级 |
| 权限粒度 | OpenCode 按工具+路径 | 全局 Y/n | 太粗 |
| 自动放行安全操作 | Claude Code 分类器 | 全部询问或全部放行 | 无中间态 |

### 2.2 选择与输入

| 能力 | 对标最佳实践 | KHY 现状 | 差距 |
|------|-------------|---------|------|
| 模糊搜索 | OpenCode DialogSelect | 无 | 选项多时体验差 |
| preview 面板 | Claude Code 右侧预览 | 无 | 信息密度低 |
| "Other" 兜底 | Claude Code / DeepSeek 自动附加 | 无 | 用户被锁死在预设选项 |
| 多选 | Claude Code multiSelect | 无 | 批量操作需多次交互 |

### 2.3 命令理解

| 能力 | 对标最佳实践 | KHY 现状 | 差距 |
|------|-------------|---------|------|
| 拼写纠错 | DeepSeek Levenshtein | 无 | 拼错直接报错 |
| Tab 补全 | DeepSeek Tab 补全 | 无 | 需记忆完整命令 |
| 模糊意图识别 | Hermes clarify + 超时 | 无 | 模糊输入无引导 |
| 自然语言路由 | Claude Code LLM 分类器 | 部分(inputPreprocessor) | 覆盖不足 |

### 2.4 反馈展示

| 能力 | 对标最佳实践 | KHY 现状 | 差距 |
|------|-------------|---------|------|
| 动态 spinner | Claude Code ~200 动词 | 固定 "思考中" | 用户感知不到进度 |
| 忙碌时新输入 | Hermes 3 模式状态机 | 丢弃 | 用户输入丢失 |

---

## 三、改进项清单

### G1 — 拼写纠错 (Levenshtein)

- **优先级**: P0
- **收益**: 高频痛点，直接减少 "未知命令" 挫败感
- **工作量**: 小（~50 行）
- **实现位置**: `backend/src/cli/router.js` 未知命令分支
- **方案**:
  1. 收集所有已注册命令名到数组
  2. 对用户输入计算编辑距离，取距离 ≤2 且最小的候选
  3. 提示 `未知命令 "gatway"，你是否想执行 "gateway"？(Y/n)`
  4. 用户确认后直接路由到候选命令
- **参考**: DeepSeek TUI `src/utils/fuzzy.ts`

### G2 — 模糊命令建议

- **优先级**: P0
- **收益**: 与 G1 互补，覆盖子命令和参数层面
- **工作量**: 小（~30 行，复用 G1 的距离函数）
- **实现位置**: `backend/src/cli/router.js` + `commandRegistry.js`
- **方案**:
  1. 命令匹配失败时，同时搜索子命令层
  2. 显示最多 3 个候选：`你是否想执行: 1) gateway config  2) gateway status  3) gateway add`
  3. 用户输入序号直接执行

### G3 — 风险分级确认

- **优先级**: P0
- **收益**: 安全性 + 用户信任
- **工作量**: 中（~150 行 + 各工具标记风险级别）
- **实现位置**: 新建 `backend/src/cli/riskConfirm.js`，修改 `toolSandbox.js`
- **方案**:
  1. 定义 3 级风险：`safe`（静默执行）、`moderate`（单次 Y/n）、`dangerous`（两步确认）
  2. 每个工具在注册时声明风险级别（默认 moderate）
  3. `dangerous` 操作流程：
     - 第一步：显示影响范围摘要（将删除 X 个文件 / 将重置 Y 配置）
     - 第二步：要求输入确认词（如输入 "DELETE" 确认删除）
  4. 工具调用前统一经过 `riskConfirm()` 网关
- **参考**: DeepSeek TUI `src/permissions/risk.ts`

### G4 — 菜单模糊搜索

- **优先级**: P1
- **收益**: Provider 列表、模型列表等长菜单体验改善
- **工作量**: 中（引入 inquirer-autocomplete-prompt 或自实现）
- **实现位置**: `backend/src/cli/handlers/gateway.js` 等所有 inquirer list 调用
- **方案**:
  1. 选项数 ≥ 5 时自动切换为 autocomplete 类型
  2. 输入字符实时过滤选项
  3. 保持上下箭头选择兼容
- **参考**: OpenCode `internal/tui/dialog_select.go`

### G5 — "Other" 兜底输入

- **优先级**: P1
- **收益**: 灵活性，避免用户被预设选项锁死
- **工作量**: 小（~20 行 wrapper）
- **实现位置**: 封装 inquirer list/rawlist 的 wrapper 函数
- **方案**:
  1. 所有选择菜单末尾自动追加 `{ name: '其他 (自由输入)', value: '__other__' }`
  2. 选择 `__other__` 后弹出 input prompt
  3. 封装为 `askChoice(message, choices, opts)` 统一调用

### G6 — Tab 补全

- **优先级**: P1
- **收益**: 效率提升，减少记忆负担
- **工作量**: 中（~100 行）
- **实现位置**: `backend/src/cli/repl.js` readline completer
- **方案**:
  1. 注册 readline `completer` 回调
  2. `/` 开头匹配 slash 命令列表
  3. 已输入命令名后，匹配子命令列表
  4. 支持文件路径补全（`./` 或 `~/` 开头时）
- **参考**: DeepSeek TUI `src/repl/completer.ts`

### G7 — 动态 spinner 文案

- **优先级**: P1
- **收益**: 用户感知进度，减少 "卡住了吗" 的疑虑
- **工作量**: 小（~40 行）
- **实现位置**: `backend/src/cli/hudRenderer.js` + `aiRenderer.js`
- **方案**:
  1. 维护阶段 → 文案映射表：
     ```js
     const PHASE_LABELS = {
       'tool:grep': '正在搜索代码...',
       'tool:read': '正在读取文件...',
       'tool:edit': '正在编辑文件...',
       'tool:bash': '正在执行命令...',
       'thinking': '正在分析...',
       'generating': '正在生成回复...',
     };
     ```
  2. 工具调用事件触发时更新 spinner 文案
  3. 无事件时默认 "思考中..."

### G8 — 意图模糊澄清 + 超时降级

- **优先级**: P2
- **收益**: 高级交互，减少无效对话轮次
- **工作量**: 大（~200 行）
- **实现位置**: `backend/src/services/inputPreprocessor.js` + 新建 `clarifyService.js`
- **方案**:
  1. 检测多义输入：同一输入匹配到 ≥2 个命令路由时触发
  2. 弹出选项菜单让用户选择意图
  3. 设置 15s 超时，超时后按第一匹配执行并提示
  4. 记录用户选择，相同模式下次自动路由（学习）
- **参考**: Hermes Agent `src/tools/clarify.ts`

### G9 — preview 面板

- **优先级**: P2
- **收益**: 信息密度提升，配置管理时减少来回查看
- **工作量**: 大（需要终端分栏渲染）
- **实现位置**: `backend/src/cli/ui/previewPanel.js`（新建）
- **方案**:
  1. 利用终端宽度，左侧选项列表占 50%，右侧 preview 占 50%
  2. 光标移动时实时更新右侧内容
  3. 需要自定义 inquirer prompt 或使用 ink 组件
  4. 降级方案：终端宽度 < 80 时不显示 preview
- **参考**: Claude Code `AskUserQuestionTool` preview 机制

### G10 — 意图预分类增强

- **优先级**: P2
- **收益**: 自然语言入口，降低学习曲线
- **工作量**: 中（~80 行）
- **实现位置**: `backend/src/services/inputPreprocessor.js`
- **方案**:
  1. 扩展关键词 → 命令映射表：
     ```js
     const INTENT_MAP = {
       '密钥|key|apikey|api_key': 'gateway config',
       '模型|model': 'gateway status',
       '代理|proxy|clash': 'gateway config',  // 跳到代理配置子项
       '初始化|init|setup': 'init',
       '帮助|help|怎么用': 'help',
     };
     ```
  2. 匹配到时提示 "检测到你可能想执行 `gateway config`，已跳转"
  3. 多匹配时走 G8 澄清流程

---

## 四、实施阶段

### Phase 1 — 基础交互加固（P0）

| 编号 | 改进项 | 预计文件 |
|------|--------|---------|
| G1 | 拼写纠错 | router.js |
| G2 | 模糊命令建议 | router.js, commandRegistry.js |
| G3 | 风险分级确认 | 新建 riskConfirm.js, toolSandbox.js |

**验收标准**:
- 拼错命令自动建议正确命令
- 破坏性操作需两步确认
- 安全操作静默放行

### Phase 2 — 选择体验优化（P1）

| 编号 | 改进项 | 预计文件 |
|------|--------|---------|
| G4 | 菜单模糊搜索 | gateway.js 等 inquirer 调用 |
| G5 | "Other" 兜底 | 新建 askChoice wrapper |
| G6 | Tab 补全 | repl.js |
| G7 | 动态 spinner | hudRenderer.js, aiRenderer.js |

**验收标准**:
- 长菜单可输入过滤
- 所有选择菜单有 "其他" 选项
- REPL 中 Tab 补全命令
- spinner 文案随操作阶段变化

### Phase 3 — 智能交互（P2）

| 编号 | 改进项 | 预计文件 |
|------|--------|---------|
| G8 | 意图澄清 + 超时降级 | inputPreprocessor.js, 新建 clarifyService.js |
| G9 | preview 面板 | 新建 previewPanel.js |
| G10 | 意图预分类增强 | inputPreprocessor.js |

**验收标准**:
- 多义输入弹出选项，超时自动执行
- 配置菜单右侧显示预览
- 自然语言关键词可触发命令

---

## 五、对标得分预估

| 维度 | 当前得分 | Phase 1 后 | Phase 2 后 | Phase 3 后 | 行业最佳 |
|------|---------|-----------|-----------|-----------|---------|
| 确认安全性 | 2/5 | 4/5 | 4/5 | 4/5 | DeepSeek 5/5 |
| 选择体验 | 2/5 | 2/5 | 4/5 | 5/5 | Claude Code 5/5 |
| 命令理解 | 1/5 | 3/5 | 4/5 | 5/5 | DeepSeek 4/5 |
| 反馈展示 | 3/5 | 3/5 | 4/5 | 4/5 | Claude Code 5/5 |
| **综合** | **2.0** | **3.0** | **4.0** | **4.5** | **4.75** |

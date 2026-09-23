# DESIGN-ARCH-027 · Agent 依赖自愈机制规范

> 状态：已实现（services/backend）
> 关联代码：`services/backend/src/services/dependency/`、`services/toolCalling.executeTool`、`services/toolError.js`
> 关联测试：`tests/services/dependency/dependencyHealing.test.js`（34 用例绿）
> 关联规范：[DESIGN-ARCH-026] 系统级服务调用审批网关（共用交互通道）、[DESIGN-ARCH-025] 元规划协议

## 1. 问题陈述

工具或依赖不完整时，Agent 此前是**硬中断**：要么硬抛 `throw new Error('… not found / install …')`，
要么软失败返回 `{ success:false, note:'Install with: …' }`。两者都把"安装"这件可自动化的事
甩给用户，且缺失场景在错误分类里与"文件未找到"混为一谈（`RESOURCE_NOT_FOUND`），Agent
无法在程序上区分、也无法发起一次"安装→重试"的修复。

### 1.1 自调查结论（硬中断点审计）

对 `services/backend/src` 全量扫描，依赖缺失硬中断点分四类：

| 类别 | 代表缺失项 | 代表位置 | 形态 |
|---|---|---|---|
| 浏览器 | puppeteer / playwright / chromium | `tools/WebBrowserTool`、`services/playwrightSearch.js` | 软失败 / 优雅降级 |
| Python | python3 / torch / huggingface_hub / khy-os[doc] | `services/modelTrainingService.js`、`tools/imageOcr.js` | 硬抛 / 软失败 |
| 系统命令 | ffmpeg / tar / 7z / pdftoppm / sox / whisper / 语言服务器 | `tools/videoAnalyze.js`、`services/runtimeProvisioner.js`、`services/lspClient.js`、`services/voiceService.js` | 硬抛 / 软失败 |
| Node 模块 | 各 LSP / @babel/parser 等 | `services/lspClient.js` | 硬抛 / 优雅降级 |

共用的二元失败语义：**软失败** `{ success:false, error|note }`（在 `executeTool` 被包成 `ToolError`），
**硬抛** 落入 `executeTool` 的 catch 转 `ToolError`。`searchExecutable()`（`tools/platformUtils.js`）
是唯一的"二进制是否在 PATH"探针原语。`toolError.js` **此前没有**专门的依赖缺失错误码。

## 2. 设计目标

1. 依赖缺失从"硬中断"转为"交互式修复"：探测缺失 → 询问安装 → 隔离执行 → 校验 → 重试**恰一次**。
2. **零侵入**接管现存所有硬抛/软失败：不逐个改工具，靠错误文本回溯辨认。
3. 安全不放松：安装须人确认；命令只来自受控注册表；任何异常 fail-safe 退回原错误。

## 3. 架构

单一子系统 `services/dependency/`，门面 `index.js`：

```
registry.js        依赖单一真源：probe 声明 + install(argv) + matchers + 标签/文档/风险
resolver.js        probe()/ensure()/detectFromError()/buildInstallPlan()/MissingDependencyError
installRunner.js   隔离执行 argv（execFile 无 shell）+ followUp 串联 + 超时/尾部回溯
healingLoop.js     自愈编排（询问→安装→校验→重试），会话级状态，summarizeForAgent()
```

接入点是**唯一工具漏斗** `toolCalling.executeTool`，非侵入：工具失败（软返回或硬抛）后调用
`healingLoop.heal()`；重试闭包 `_runDescriptor` 只重跑裸工具调用，**不**再套自愈层 → 结构上
杜绝递归。错误码 `MISSING_DEPENDENCY` 新增到 `toolError.js`，使依赖缺失与 `RESOURCE_NOT_FOUND`
程序可分。

## 4. 核心流程（依赖自愈循环）

```
工具失败信号 ──detectFromError──▶ 命中某依赖？
   │未命中 → 返回 null（非依赖问题，原错误原样透出，零回归）
   ▼命中
re-probe（去伪）── 其实已就绪 → null（matcher 误报/瞬态，原错误自负）
   ▼确实缺失
本会话已试过该依赖？── 是 → {healed:false, alreadyAttempted}（防死循环）
   ▼否
有可执行安装计划？── 无 → {degraded, manual-required}（结构化指引，不崩）
   ▼有
经 onControlRequest 询问（once / always / skip）
   │无通道 → {degraded, no-control-channel}（绝不静默安装）
   │skip   → {declined}
   ▼install/always
隔离执行安装（命令仅来自 registry）── 失败 → {installFailed}
   ▼成功
re-probe 校验 ── 仍缺失 → {installVerifyFailed}
   ▼就绪
重试原调用「恰一次」── {healed:true, result}
```

交互通道复用审批网关同一契约（`onControlRequest({ requestId, request:{ subtype:'can_use_tool',
tool_name:'install-dependency:<id>', input:{ kind:'dependency-install', … } } })`），
解码 `true|'always'|false|{behavior}` → `install|always|skip`。**TUI 零改动**即可运行；
未实现键入确认的宿主下，无通道 → 降级为手动指引（安全方向）。

## 5. 防呆（硬约束）

- **①永不无确认安装**：无交互通道 / 用户 skip → 一律不执行安装，只给结构化指引。
- **②永不死循环**：会话级 `attempted` 集合按 depId 去重 + 单次重试；重试闭包不套自愈层。
- **③优雅降级**：无通道/无安装方案 → `summarizeForAgent()` 产出可读可操作指引，绝不崩。
- **④命令绝不来自模型/报错文本**：安装 argv 只能取自 `registry.buildInstallPlan`，`execFile`
  无 shell 执行 → 杜绝命令注入；全局/系统级安装标 `scope:'global'` 提高审批强度，
  且**默认不自动 sudo**（需提权只提示，不替用户提权）。
- **⑤编排 fail-safe**：`heal()` 任何分支异常都返回 `null` → 原错误照常透出，绝不放大故障。
- **⑥授权不跨会话续命**：会话状态纯内存，进程退出即蒸发；`always` 仅本会话免问。

## 6. 开关与可调项

| 环境变量 | 默认 | 作用 |
|---|---|---|
| `KHY_DEP_HEALING` | 开 | `=off` 显式关闭自愈，回退纯原错误透出 |
| `KHY_DEP_INSTALL_TIMEOUT_MS` | 180000 | 单条安装命令超时 |

## 7. 验收（34 用例绿，全程零网络/零真实进程/零真实 FS）

- registry 单一真源（条目/平台覆盖/argv 命令均来自表）；
- probe 三类探针（node-module / system-command / python-package）；
- detectFromError 回溯辨认既有硬抛与软失败文本，且"File not found"/网络错误不误伤（→ null）；
- `MISSING_DEPENDENCY` 错误码 + `MissingDependencyError` 形状；install 文本 → `MISSING_DEPENDENCY`，
  `ENOENT`/"File not found" 仍 `RESOURCE_NOT_FOUND`（零回归）；
- 自愈四分支（确认→安装→重试成功 / 拒绝 / 安装失败 / 无通道降级）+ 去伪 + attempted 去重 +
  编排异常 fail-safe + 开关。

全量 node:test 回归 542/542 绿。

## 8. 参考采用者

`tools/WebBrowserTool` 改为 `dependency.ensure('puppeteer')` 主动发出结构化
`MISSING_DEPENDENCY`（替代原 dead-end note），作为工具侧主动声明依赖的范例；其余既有
硬抛/软失败工具无需改动，由 `detectFromError` 在漏斗处统一接管。

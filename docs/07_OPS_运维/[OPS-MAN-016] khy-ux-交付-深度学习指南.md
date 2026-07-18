<!-- 文档分类: OPS-MAN-016 | 阶段: 运维 | 原路径: docs/指南/khy-ux-交付-深度学习指南.md -->
# KHY OS UX 体验与产品交付能力 — 三项目深度学习指南

> **对标项目**: DeepSeek-TUI (Rust/ratatui) · Hermes Agent (Python/prompt_toolkit) · OpenCode (TS/SolidJS+OpenTUI)
> **日期**: 2026-05-21
> **配套报告**: `docs/08_MGMT_项目管理/[MGMT-RPT-011] 三项目深度学习-2026-05-21.md`

---

## 目录

1. [项目画像](#一项目画像)
2. [十维度对比矩阵](#二十维度对比矩阵)
3. [核心设计模式精华 — 代码级参考](#三核心设计模式精华--代码级参考)
4. [30 项差距清单 G1-G30](#四30-项差距清单-g1-g30)
5. [KHY 实施手册](#五khy-实施手册)
6. [文件拆分指南](#六文件拆分指南)
7. [验收标准](#七验收标准)
8. [参考源码索引](#八参考源码索引)

---

## 一、项目画像

### DeepSeek-TUI (Rust)

| 属性 | 值 |
|------|---|
| 语言/框架 | Rust + ratatui 0.30 + crossterm 0.28 |
| 核心亮点 | 流式管线三层防护、8 主题三级色深、原子会话+检查点、Compaction 前缀缓存经济学 |
| 代码规模 | `palette.rs` 1698行、`session_manager.rs` 1856行、`compaction.rs` 2774行 |
| 子代理 | 7 种类型 (General/Explore/Plan/Review/Implementer/Verifier/Custom) + 鲸鱼昵称 + 驻留租约 |
| CI | 10 平台构建矩阵 + 7 项 Parity 门控 + Homebrew tap 自动更新 |

**最值得学习**: 流式管线 (LineBuffer + AdaptiveChunking + FrameRateLimiter)、ErrorEnvelope 统一错误体系、OnboardingState 引导状态机

### Hermes Agent (Python)

| 属性 | 值 |
|------|---|
| 语言/框架 | Python 3.11 + prompt_toolkit + SQLite |
| 核心亮点 | 迭代预算+并行安全分类、Goal-Judge 持久循环、8 记忆 Plugin、Kanban CAS、14 人格+皮肤 |
| 代码规模 | `run_agent.py` 16408行、`cli.py` 14166行 |
| 工具 | 70+ 核心工具、40+ 工具集、MCP 集成、Tirith 预执行安全扫描 |
| 平台 | 30+ 消息平台 Gateway (Telegram/Discord/Slack/WeChat/DingTalk...) |

**最值得学习**: 并行工具安全分类、Goal 持久化+Judge 循环、MemoryProvider ABC 插件架构、Kanban CAS 原子 claim、Prompt 注入防护

### OpenCode (TypeScript)

| 属性 | 值 |
|------|---|
| 语言/框架 | TypeScript + Bun + SolidJS + @opentui/core + Effect-TS |
| 核心亮点 | 33 内置主题+System 自动推导、Leader 键+命令面板、通配符权限+diff 预览 |
| 代码规模 | `message-v2.ts` 40376行 (最大单文件) |
| 架构 | 双进程 Worker (TUI 渲染进程 + AI 后端 Worker) |
| CI | 跨平台安装脚本 + 7 种升级方式检测 |

**最值得学习**: 权限 evaluate() 通配符 last-match-wins、Leader 键序列、System 主题从终端调色板推导、流式 Markdown heal/split 策略

---

## 二、十维度对比矩阵

| # | 维度 | DeepSeek | Hermes | OpenCode | **KHY** | 差距 |
|---|------|---------|--------|---------|---------|------|
| D1 | 流式渲染管线 | ★★★★★ | ★★★ | ★★★★ | **★★★** | 缺换行门控+自适应分块 |
| D2 | 主题/色彩 | ★★★★★ | ★★★★ | ★★★★★ | **★★** | 仅 2 主题，无色深检测 |
| D3 | 输入编辑器 | ★★★★★ | ★★★★ | ★★★★★ | **★★★** | 无 Vim 操作符，无多行编辑器 |
| D4 | 权限系统 | ★★★ | ★★★★ | ★★★★★ | **★★★** | 缺通配符+diff预览+自动学习 |
| D5 | 子代理编排 | ★★★★★ | ★★★★★ | ★★★★ | **★★★** | 无类型化角色+并行安全+租约 |
| D6 | 会话管理 | ★★★★★ | ★★★★★ | ★★★★★ | **★★★** | 无原子写入+分支+全文搜索 |
| D7 | 错误弹性 | ★★★★★ | ★★★★ | ★★★★ | **★★★★** | 缺统一 ErrorEnvelope |
| D8 | 记忆/知识 | ★★ | ★★★★★ | ★★★ | **★★** | 无 Plugin 记忆+FTS5 CJK |
| D9 | 配置/引导 | ★★★★★ | ★★★★★ | ★★★★ | **★★** | 无引导流程+Provider别名 |
| D10 | 产品交付 | ★★★★★ | ★★★★★ | ★★★★★ | **★★★** | 缺 Homebrew/多架构 Docker |

**KHY 综合: 2.7/5 → 目标 4.2/5**

---

## 三、核心设计模式精华 — 代码级参考

### 3.1 流式换行门控 (DeepSeek `LineBuffer`)

**原理**: 流式文本到达时，只释放到最后一个 `\n` 为止的前缀，防止不完整 Markdown（半截代码围栏 `` ``` ``）被渲染器看到。

```rust
// DeepSeek — crates/tui/src/tui/streaming/line_buffer.rs
pub struct LineBuffer {
    pending: String,
}

impl LineBuffer {
    pub fn push(&mut self, delta: &str) {
        self.pending.push_str(delta);
    }

    /// 只释放到最后一个 '\n'，尾部留在缓冲区
    pub fn take_committable(&mut self) -> String {
        let Some(last_nl) = self.pending.rfind('\n') else {
            return String::new(); // 没有换行 → 不释放
        };
        self.pending.drain(..=last_nl).collect()
    }

    /// 流结束时释放所有剩余内容
    pub fn flush(&mut self) -> String {
        std::mem::take(&mut self.pending)
    }
}
```

**KHY 移植 (`repl.js` 新增 `LineBuffer` 类)**:
```js
class LineBuffer {
  constructor() { this._pending = ''; }

  push(delta) { this._pending += delta; }

  takeCommittable() {
    const idx = this._pending.lastIndexOf('\n');
    if (idx < 0) return '';
    const result = this._pending.slice(0, idx + 1);
    this._pending = this._pending.slice(idx + 1);
    return result;
  }

  flush() {
    const result = this._pending;
    this._pending = '';
    return result;
  }
}
```

---

### 3.2 自适应分块策略 (DeepSeek `AdaptiveChunkingPolicy`)

**原理**: 双档 Smooth/CatchUp + 迟滞控制器。不同的进入/退出阈值防止状态边界振荡。

```rust
// DeepSeek — crates/tui/src/tui/streaming/chunking.rs
// 进入 CatchUp: queue≥160行 或 最老块≥1200ms
const ENTER_QUEUE_DEPTH_LINES: usize = 160;
const ENTER_OLDEST_AGE: Duration = Duration::from_millis(1_200);
// 退出 CatchUp: queue<32行 且 最老块<300ms，持续≥250ms
const EXIT_QUEUE_DEPTH_LINES: usize = 32;
const EXIT_OLDEST_AGE: Duration = Duration::from_millis(300);
const EXIT_HOLD: Duration = Duration::from_millis(250);
// 退出后冷却期 250ms 阻止立即再进入
const REENTER_CATCH_UP_HOLD: Duration = Duration::from_millis(250);
// 严重积压绕过冷却: queue≥640行 或 最老块≥4000ms
const SEVERE_QUEUE_DEPTH_LINES: usize = 640;
const SEVERE_OLDEST_AGE: Duration = Duration::from_millis(4_000);
```

**KHY 移植 (`lineBuffer.js` 新增)**:
```js
const CHUNKING = {
  ENTER_LINES: 160, ENTER_AGE_MS: 1200,
  EXIT_LINES: 32, EXIT_AGE_MS: 300, EXIT_HOLD_MS: 250,
  REENTER_HOLD_MS: 250,
  SEVERE_LINES: 640, SEVERE_AGE_MS: 4000,
};

class AdaptiveChunker {
  constructor() {
    this.mode = 'smooth'; // 'smooth' | 'catchup'
    this._exitSince = null;
    this._lastExitAt = 0;
  }

  decide(queuedLines, oldestAgeMs, now = Date.now()) {
    if (this.mode === 'smooth') {
      const severe = queuedLines >= CHUNKING.SEVERE_LINES || oldestAgeMs >= CHUNKING.SEVERE_AGE_MS;
      const enter = queuedLines >= CHUNKING.ENTER_LINES || oldestAgeMs >= CHUNKING.ENTER_AGE_MS;
      if (severe || (enter && now - this._lastExitAt > CHUNKING.REENTER_HOLD_MS)) {
        this.mode = 'catchup';
        this._exitSince = null;
      }
    } else {
      const low = queuedLines < CHUNKING.EXIT_LINES && oldestAgeMs < CHUNKING.EXIT_AGE_MS;
      if (low) {
        if (!this._exitSince) this._exitSince = now;
        if (now - this._exitSince >= CHUNKING.EXIT_HOLD_MS) {
          this.mode = 'smooth';
          this._lastExitAt = now;
        }
      } else {
        this._exitSince = null;
      }
    }
    return this.mode;
  }
}
```

---

### 3.3 统一 ErrorEnvelope (DeepSeek `error_taxonomy.rs`)

**原理**: 跨子系统边界传递的统一错误信封，携带分类/严重性/可恢复性/错误码/消息。

```rust
// DeepSeek — crates/tui/src/error_taxonomy.rs
pub enum ErrorCategory {
    Network, Authentication, Authorization, RateLimit,
    Timeout, InvalidInput, Parse, Tool, State, Internal,
}
pub enum ErrorSeverity { Info, Warning, Error, Critical }

pub struct ErrorEnvelope {
    pub category: ErrorCategory,
    pub severity: ErrorSeverity,
    pub recoverable: bool,
    pub code: String,
    pub message: String,
}
```

**KHY 移植 (`backend/src/services/errorEnvelope.js` 新建)**:
```js
'use strict';

const CATEGORY = Object.freeze({
  NETWORK: 'network', AUTH: 'authentication', AUTHZ: 'authorization',
  RATE_LIMIT: 'rate_limit', TIMEOUT: 'timeout', INPUT: 'invalid_input',
  PARSE: 'parse', TOOL: 'tool', STATE: 'state', INTERNAL: 'internal',
});

const SEVERITY = Object.freeze({ INFO: 'info', WARNING: 'warning', ERROR: 'error', CRITICAL: 'critical' });

class ErrorEnvelope {
  constructor(category, severity, recoverable, code, message) {
    this.category = category;
    this.severity = severity;
    this.recoverable = recoverable;
    this.code = code;
    this.message = message;
  }

  static transient(msg) {
    return new ErrorEnvelope(CATEGORY.INTERNAL, SEVERITY.WARNING, true, 'transient', msg);
  }
  static fatal(msg) {
    return new ErrorEnvelope(CATEGORY.INTERNAL, SEVERITY.ERROR, false, 'fatal', msg);
  }
  static fatalAuth(msg) {
    return new ErrorEnvelope(CATEGORY.AUTH, SEVERITY.CRITICAL, false, 'auth_fatal', msg);
  }
  static contextOverflow(msg) {
    return new ErrorEnvelope(CATEGORY.INPUT, SEVERITY.ERROR, true, 'context_overflow', msg);
  }
  static network(msg) {
    return new ErrorEnvelope(CATEGORY.NETWORK, SEVERITY.WARNING, true, 'network_transient', msg);
  }
}

module.exports = { ErrorEnvelope, CATEGORY, SEVERITY };
```

---

### 3.4 原子写入+检查点 (DeepSeek `session_manager.rs`)

**原理**: tmp 文件 + fsync + rename 三步实现崩溃安全原子写入。

**KHY 移植 (`sessionPersistence.js` 修改)**:
```js
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

function writeAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.tmp-${crypto.randomBytes(6).toString('hex')}`);
  const fd = fs.openSync(tmpPath, 'w', 0o600);
  try {
    fs.writeSync(fd, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
    fs.fsyncSync(fd);           // 刷到磁盘
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, filePath);  // 原子替换
}

function saveCheckpoint(session) {
  const checkpointDir = path.join(os.homedir(), '.khyquant', 'sessions', 'checkpoints');
  fs.mkdirSync(checkpointDir, { recursive: true });
  writeAtomic(path.join(checkpointDir, 'latest.json'), session);
}
```

---

### 3.5 首次引导流程 (DeepSeek `OnboardingState`)

**原理**: 5 步状态机，根据引导标记和运行时状态决定入口点。

```rust
// DeepSeek — crates/tui/src/tui/app.rs
enum OnboardingState { Welcome, Language, ApiKey, TrustDirectory, Tips, None }

fn initial_onboarding_state(skip, was_onboarded, needs_key, needs_trust) -> OnboardingState {
    if skip || (was_onboarded && !needs_key && !needs_trust) { return None; }
    if was_onboarded && needs_key { return ApiKey; }
    if was_onboarded && needs_trust { return TrustDirectory; }
    Welcome
}
```

**KHY 移植 (`backend/src/cli/onboarding.js` 新建)**:
```js
'use strict';

const STATES = ['welcome', 'language', 'apiKey', 'trustDir', 'tips', 'done'];

function determineOnboardingState({ skip, wasOnboarded, needsApiKey, needsTrust }) {
  if (skip || (wasOnboarded && !needsApiKey && !needsTrust)) return 'done';
  if (wasOnboarded && needsApiKey) return 'apiKey';
  if (wasOnboarded && needsTrust) return 'trustDir';
  return 'welcome';
}

class OnboardingWizard {
  constructor(opts) {
    this.state = determineOnboardingState(opts);
  }

  advance() {
    const idx = STATES.indexOf(this.state);
    this.state = idx < STATES.length - 1 ? STATES[idx + 1] : 'done';
    return this.state;
  }

  isDone() { return this.state === 'done'; }
}

module.exports = { OnboardingWizard, determineOnboardingState };
```

---

### 3.6 并行工具安全分类 (Hermes)

**原理**: 将工具分三类——只读可并行、写入按路径分区、交互强制串行。

```python
# Hermes — run_agent.py
_NEVER_PARALLEL_TOOLS = frozenset({"clarify"})
_PARALLEL_SAFE_TOOLS = frozenset({
    "read_file", "search_files", "session_search",
    "vision_analyze", "web_extract", "web_search",
})
_PATH_SCOPED_TOOLS = frozenset({"read_file", "write_file", "patch"})
_MAX_TOOL_WORKERS = 8
```

**KHY 移植 (`toolPipeline.js` 增强)**:
```js
const PARALLEL_SAFE = new Set(['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'LSPTool']);
const NEVER_PARALLEL = new Set(['AskUserQuestion', 'PermissionDialog']);
const PATH_SCOPED = new Set(['Read', 'Edit', 'Write']);
const MAX_PARALLEL = 8;

function classifyParallelism(toolCalls) {
  if (toolCalls.some(tc => NEVER_PARALLEL.has(tc.name))) return 'serial';
  if (toolCalls.every(tc => PARALLEL_SAFE.has(tc.name))) return 'parallel';
  // 写入工具按目标路径分区
  const pathGroups = new Map();
  for (const tc of toolCalls) {
    if (PATH_SCOPED.has(tc.name)) {
      const p = tc.args?.file_path || tc.args?.path || '__default__';
      if (!pathGroups.has(p)) pathGroups.set(p, []);
      pathGroups.get(p).push(tc);
    }
  }
  // 不同路径可以并行，同路径串行
  return pathGroups.size > 1 ? 'path_partitioned' : 'serial';
}
```

---

### 3.7 Goal 持久化 + Judge 循环 (Hermes)

**原理**: `/goal` 设置跨轮次目标，每轮结束后辅助模型 judge 判定是否完成，fail-open 设计。

```python
# Hermes — hermes_cli/goals.py
@dataclass
class GoalState:
    goal: str
    status: str = "active"           # active | paused | done | cleared
    turns_used: int = 0
    max_turns: int = 50              # 预算
    subgoals: List[str] = field(default_factory=list)

def judge_goal(goal, last_response, *, timeout=10, subgoals=None):
    """调用辅助模型判定目标是否完成。fail-open: 任何错误返回 'continue'。"""
    # ... 构建 prompt, 调用 auxiliary LLM, 解析 verdict ...
    return (verdict, reason, parse_failed)  # "done" | "continue" | "skipped"
```

---

### 3.8 权限通配符匹配 (OpenCode)

**原理**: last-match-wins 语义，支持 `*` 和 `?` 通配符。

```ts
// OpenCode — packages/opencode/src/permission/evaluate.ts
export function evaluate(permission: string, pattern: string, ...rulesets: Rule[][]): Rule {
  const rules = rulesets.flat()
  const match = rules.findLast(
    (rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern),
  )
  return match ?? { action: "ask", permission, pattern: "*" }
}
```

---

### 3.9 Prompt 注入防护 (Hermes)

**原理**: 加载上下文文件前用正则+不可见字符检测扫描注入模式。

```python
# Hermes — agent/prompt_builder.py
_CONTEXT_THREAT_PATTERNS = [
    (r'ignore\s+(previous|all|above|prior)\s+instructions', "prompt_injection"),
    (r'do\s+not\s+tell\s+the\s+user', "deception_hide"),
    (r'system\s+prompt\s+override', "sys_prompt_override"),
    (r'curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET)', "exfil_curl"),
    (r'cat\s+[^\n]*(\.env|credentials|\.netrc)', "read_secrets"),
    # ... 共 10 种模式
]
_CONTEXT_INVISIBLE_CHARS = {'\u200b', '\u200c', '\u200d', '\u2060', '\ufeff', ...}

def _scan_context_content(content, filename):
    findings = []
    for char in _CONTEXT_INVISIBLE_CHARS:
        if char in content: findings.append(f"invisible U+{ord(char):04X}")
    for pattern, pid in _CONTEXT_THREAT_PATTERNS:
        if re.search(pattern, content, re.IGNORECASE): findings.append(pid)
    if findings:
        return f"[BLOCKED: {filename} — {', '.join(findings)}]"
    return content
```

---

### 3.10 终端色深检测 (DeepSeek)

**原理**: 逐级探测 `COLORTERM` → `WT_SESSION` → `TERM_PROGRAM` → `TERM`，三级降级。

```rust
// DeepSeek — crates/tui/src/palette.rs
pub fn detect() -> ColorDepth {
    if env("COLORTERM") contains "truecolor" or "24bit" → TrueColor
    if env("WT_SESSION") exists → TrueColor  // Windows Terminal
    if env("TERM_PROGRAM") contains "iterm|wezterm|vscode|warp" → TrueColor
    if env("TERM") contains "256" → Ansi256
    if TERM is empty or "dumb" → Ansi16
    else → Ansi256  // 保守默认
}
```

**KHY 移植 (`backend/src/cli/palette.js` 新建)**:
```js
function detectColorDepth() {
  const ct = (process.env.COLORTERM || '').toLowerCase();
  if (ct.includes('truecolor') || ct.includes('24bit')) return 'truecolor';
  if (process.env.WT_SESSION) return 'truecolor';
  const tp = (process.env.TERM_PROGRAM || '').toLowerCase();
  if (/iterm|wezterm|vscode|warp|ghostty/.test(tp)) return 'truecolor';
  const term = (process.env.TERM || '').toLowerCase();
  if (term.includes('256')) return 'ansi256';
  if (!term || term === 'dumb') return 'ansi16';
  return 'ansi256';
}
```

---

### 3.11 System 主题自动推导 (OpenCode)

**原理**: 从终端 16 色调色板推导完整 40+ token 主题，背景设为透明继承终端透明度。

```ts
// OpenCode — packages/opencode/src/cli/cmd/tui/context/theme.tsx
function generateSystem(colors, mode) {
  const bg = RGBA.fromHex(colors.defaultBackground ?? colors.palette[0])
  const transparent = RGBA.fromValues(bg.r, bg.g, bg.b, 0) // 关键：透明背景
  const grays = generateGrayScale(bg, isDark)
  return {
    primary: col(6),      // cyan
    secondary: col(5),    // magenta
    error: col(1),        // red
    success: col(2),      // green
    background: transparent,
    // diff 颜色：alpha 混合
    diffAddedBg: tint(bg, green, 0.22),
    diffRemovedBg: tint(bg, red, 0.22),
  }
}
```

---

### 3.12 帧率限制器 (DeepSeek)

**原理**: 双档 120fps/30fps，`clamp_deadline` 将请求时刻推迟到不违反帧率上限的最早允许时刻。

**KHY 移植 (`backend/src/cli/frameRateLimiter.js` 新建)**:
```js
const MIN_INTERVAL_MS = 8.33;        // 120 FPS
const LOW_MOTION_INTERVAL_MS = 33.33; // 30 FPS

class FrameRateLimiter {
  constructor(lowMotion = false) {
    this._lastEmit = 0;
    this._lowMotion = lowMotion;
  }

  canDraw(now = Date.now()) {
    const interval = this._lowMotion ? LOW_MOTION_INTERVAL_MS : MIN_INTERVAL_MS;
    return now - this._lastEmit >= interval;
  }

  markEmitted(now = Date.now()) { this._lastEmit = now; }

  timeUntilNext(now = Date.now()) {
    const interval = this._lowMotion ? LOW_MOTION_INTERVAL_MS : MIN_INTERVAL_MS;
    const elapsed = now - this._lastEmit;
    return elapsed >= interval ? 0 : interval - elapsed;
  }
}
```

---

## 四、30 项差距清单 G1-G30

### P0 — 核心体验 (影响每次使用)

| ID | 差距 | 参考 | KHY 现状 | 改进 | 改动文件 |
|----|------|------|---------|------|---------|
| G1 | 流式换行门控 | DeepSeek `line_buffer.rs` | 直接 `\n\n` 切割 | 新增 LineBuffer 类 | `repl.js` → 提取 `lineBuffer.js` |
| G2 | 自适应分块 | DeepSeek `chunking.rs` | 固定逐段 flush | Smooth/CatchUp 迟滞控制器 | `lineBuffer.js` |
| G3 | MD 解析/渲染分离 | DeepSeek `markdown_render.rs` | 单函数 | `parse()→AST` + `render(AST,width)→lines` | `aiRenderer.js` → 提取 `markdownParser.js` + `markdownRenderer.js` |
| G4 | 主题扩充+色深检测 | DeepSeek/OpenCode | 2 主题，无色深检测 | 新增 8+ 主题 + 三级色深降级 | `themeRegistry.js` + 新建 `palette.js` |
| G5 | 权限 diff 预览 | OpenCode `permission.tsx` | 仅 yes/no | diff 预览 + "Allow always" 规则学习 | `permissionDialog.js` |
| G6 | 会话原子写入 | DeepSeek `session_manager.rs` | `writeFileSync` | tmp+fsync+rename + checkpoint | `sessionPersistence.js` |
| G7 | 统一 ErrorEnvelope | DeepSeek `error_taxonomy.rs` | 13 类但无统一信封 | 新增 ErrorEnvelope 类 | 新建 `errorEnvelope.js` |
| G8 | 首次引导流程 | DeepSeek `OnboardingState` | 直接进入 REPL | 状态机 Welcome→Language→ApiKey→Trust→Tips | 新建 `onboarding.js` |

### P1 — 竞争力 (影响用户留存)

| ID | 差距 | 参考 | 改进 | 改动文件 |
|----|------|------|------|---------|
| G9 | 子代理类型化角色 | DeepSeek 7 类型 | 5 种角色+独立 prompt+工具白名单 | `workerAgent.js` |
| G10 | 并行工具安全分类 | Hermes | 只读并行/写入分区/交互串行 | `toolPipeline.js` |
| G11 | 目标持久化 (Ralph Loop) | Hermes `goals.py` | `/goal` + judge 判定 + continuation | 新建 `goalSystem.js` |
| G12 | 会话分支+全文搜索 | DeepSeek/OpenCode | `/branch` fork + SQLite FTS5 + trigram CJK | `sessionPersistence.js` |
| G13 | 帧率限制器 | DeepSeek | 双档 120/30 fps | 新建 `frameRateLimiter.js` |
| G14 | 记忆 Plugin 架构 | Hermes 8 provider | MemoryProvider 接口 + FTS5 搜索 | 新建 `memoryManager.js` |
| G15 | Kanban 任务板 | Hermes | SQLite WAL + CAS 原子 claim + 7 状态 | 升级 `taskBoard.js` |
| G16 | Compaction 经济学 | DeepSeek 500K 硬地板 | 前缀缓存保护 + 80% 窗口触发 | `contextCompressor.js` |

### P2 — 差异化 (形成独特卖点)

| ID | 差距 | 参考 | 改进 | 改动文件 |
|----|------|------|------|---------|
| G17 | 皮肤引擎 | Hermes `skin_engine.py` | YAML 皮肤: colors+spinner+branding | 扩展 `themeRegistry.js` |
| G18 | 人格系统 | Hermes 14 种 | `/personality` + SOUL.md 自定义 | 新建 `soulManager.js` |
| G19 | Cron 定时任务 | Hermes `cron/` | agent 定时执行 + webhook 交付 | 新建 `cronScheduler.js` |
| G20 | Provider 别名容错 | DeepSeek/Hermes | 多别名映射 + OS keyring | gateway 配置 |
| G21 | 工具结果智能裁剪 | DeepSeek | 去重+摘要+分档 120K/24K | `contextCompressor.js` |
| G22 | 命令面板 | OpenCode `CommandPalette` | Ctrl+P 全局命令聚合 | `repl.js` → 提取 `commandPalette.js` |
| G23 | 终端色深自适应 | DeepSeek `ColorDepth` | TrueColor/256/16 检测+降级映射 | 新建 `palette.js` |
| G24 | 安全审计日志 | DeepSeek | 敏感操作 → `~/.khyquant/audit.jsonl` | 新建 `auditLog.js` |

### P3 — 远期完善

| ID | 差距 | 改进 |
|----|------|------|
| G25 | 会话元数据快速加载 | 64KB 前缀扫描 |
| G26 | 上下文注入扫描 | 10 种威胁模式 + 不可见 Unicode 检测 |
| G27 | 多架构 Docker | QEMU + Buildx linux/arm64 |
| G28 | Parity 测试门控 | snapshot + protocol + state 三项 |
| G29 | 离线队列 | 断网消息排队，恢复后重发 |
| G30 | Profile 多实例隔离 | `khy -p <profile>` 独立配置/会话/记忆 |

---

## 五、KHY 实施手册

### Phase 1: 核心体验 (Week 1-2)

```
Week 1:
  Day 1-2: G1+G2 流式管线 — 提取 lineBuffer.js + AdaptiveChunker
           修改 repl.js _tryIncrementalFlush 集成 LineBuffer
           测试: 代码围栏/表格不被中途切割
  Day 3:   G6 会话原子写入 — sessionPersistence.js 改用 writeAtomic
           测试: kill -9 后从 checkpoint 恢复
  Day 4:   G7 ErrorEnvelope — 新建 errorEnvelope.js
           改造 errorClassifier.js 输出 Envelope
           测试: 各错误源正确映射到 category+severity

Week 2:
  Day 5-7: G3 MD 解析/渲染分离 — 拆分 aiRenderer.js
           markdownParser.js (AST) + markdownRenderer.js (width-aware)
           测试: resize 不重新解析，渲染结果一致
  Day 8-9: G8 首次引导 — onboarding.js 状态机
           集成到 repl.js 启动流程
           测试: 新用户走完整流程，老用户自动跳过
```

### Phase 2: 竞争力 (Week 3-4)

```
Week 3:
  G4 主题扩充 — 新增 catppuccin/tokyo-night/nord/gruvbox/solarized/dracula/system 7 个主题
  G13 帧率限制器 — frameRateLimiter.js
  G16 Compaction 经济学 — contextCompressor.js 500K 硬地板

Week 4:
  G5 权限 diff 预览 — permissionDialog.js
  G9 子代理角色 — workerAgent.js 枚举 + prompt
  G10 并行工具 — toolPipeline.js 安全分类
```

### Phase 3: 差异化 (Week 5-8)

```
Week 5-6: G11 目标系统 + G12 会话分支+FTS5 + G14 记忆 Plugin + G22 命令面板
Week 7-8: G17-G24 (皮肤/人格/Cron/Provider/裁剪/色深/审计)
```

### Phase 4: 远期 (Week 9+)

```
G25-G30 按需实施
```

---

## 六、文件拆分指南

### repl.js (324KB) → 6 文件

| 新文件 | 职责 | 从 repl.js 提取的函数/逻辑 |
|--------|------|---------------------------|
| `lineBuffer.js` | 流式缓冲+自适应分块 | `_tryIncrementalFlush` 的缓冲逻辑 + 新增 LineBuffer/AdaptiveChunker |
| `inputPicker.js` | `/` 和 `@` 拾取器 | `_slashPickerActive`/`_atPickerActive` 相关代码 |
| `busyInput.js` | 忙碌输入三态 | `_queuedInputs`/`_steerQueue`/`_classifyBusyInput`/`_busyQueueWithMerge` |
| `historyManager.js` | 命令历史持久化 | `_history`/`_loadHistory`/`_saveHistory` + ~/.khyquant_history |
| `commandPalette.js` | Ctrl+P 命令面板 | 新建 (G22) |
| `repl.js` | 核心循环 (精简) | readline 初始化、主输入循环、AI 请求调度 |

### aiRenderer.js (147KB) → 8 文件

| 新文件 | 职责 |
|--------|------|
| `markdownParser.js` | `parseMarkdown(text) → AST` (G3) |
| `markdownRenderer.js` | `renderAST(ast, width) → lines` (G3) |
| `tableRenderer.js` | `_parseTableData`/`_formatTableFromData`/`_renderSideBySideTables` |
| `mermaidRenderer.js` | 5 种图表解析+渲染 (mindmap/pie/flowchart/sequence/gantt) |
| `treeRenderer.js` | `_renderTree`/`_renderNestedListTrees` |
| `diffRenderer.js` | `renderStructuredDiff`/diff 着色 |
| `codeHighlighter.js` | 语法着色 regex 规则 |
| `aiRenderer.js` | 管线入口 (精简): `renderAiResponse` 调用各子模块 |

---

## 七、验收标准

### 每个 Phase 的通过标准

| Phase | 标准 |
|-------|------|
| Phase 1 | 1) `node -e "require('./backend/src/cli/aiRenderer')"` 无报错 2) `npx jest --testPathPattern="aiRenderer\|repl\|session\|error" --no-coverage` 全通过 3) kill -9 后会话可从 checkpoint 恢复 4) 新建 KHY 目录首次运行触发引导 |
| Phase 2 | 1) `khy theme list` 显示 9+ 个主题 2) `khy theme set catppuccin` 立即生效 3) 流式输出无肉眼可见卡顿 4) 子代理以角色名运行 |
| Phase 3 | 1) `/goal "完成 X"` 设置后 judge 每轮评估 2) `/branch` 创建分支会话 3) 会话搜索中文关键词命中 4) Ctrl+P 弹出命令面板 |
| Phase 4 | 1) `docker buildx build --platform linux/amd64,linux/arm64` 成功 2) CI parity 测试全通过 |

### 单项验收 Checklist

每个 G 项完成后须满足：
- [ ] 功能代码已实现
- [ ] 对应测试用例已编写且通过
- [ ] `node -e "require('./backend/src/cli/aiRenderer')"` (或相关入口) 无报错
- [ ] 无新增硬编码字符串 (除已有模式外)
- [ ] 不破坏已有 `npx jest` 全量测试

---

## 八、参考源码索引

### DeepSeek-TUI

| 模块 | 路径 |
|------|------|
| 流式管线 | `crates/tui/src/tui/streaming/{mod,line_buffer,chunking}.rs` |
| 主题 | `crates/tui/src/palette.rs` |
| Markdown | `crates/tui/src/tui/markdown_render.rs` |
| 会话 | `crates/tui/src/session_manager.rs` |
| 错误 | `crates/tui/src/error_taxonomy.rs` |
| Compaction | `crates/tui/src/compaction.rs` |
| 子代理 | `crates/tui/src/tools/subagent/mod.rs` |
| 帧率 | `crates/tui/src/tui/frame_rate_limiter.rs` |
| Vim | `crates/tui/src/tui/vim_mode.rs` |
| 引导 | `crates/tui/src/tui/app.rs` (OnboardingState) |
| CI | `.github/workflows/release.yml` |

### Hermes Agent

| 模块 | 路径 |
|------|------|
| Agent 循环 | `run_agent.py` |
| CLI | `cli.py` |
| 目标 | `hermes_cli/goals.py` |
| Kanban | `hermes_cli/kanban_db.py` |
| 记忆 | `agent/memory_manager.py` + `plugins/memory/` |
| 工具 | `tools/registry.py` + `toolsets.py` |
| 皮肤 | `hermes_cli/skin_engine.py` |
| 人格 | `hermes_cli/default_soul.py` |
| 认证 | `hermes_cli/auth.py` + `hermes_cli/providers.py` |
| Cron | `cron/scheduler.py` |
| i18n | `agent/i18n.py` + `locales/` |
| 安全 | `tools/tirith_security.py` + `agent/prompt_builder.py` |

### OpenCode

| 模块 | 路径 |
|------|------|
| TUI 入口 | `packages/opencode/src/cli/cmd/tui/app.tsx` |
| 键绑定 | `packages/opencode/src/cli/cmd/tui/{keymap.tsx,config/keybind.ts}` |
| 权限 | `packages/opencode/src/permission/{index,evaluate}.ts` |
| 工具 | `packages/opencode/src/tool/{tool,registry,truncate}.ts` |
| 会话 | `packages/opencode/src/session/{session,compaction}.ts` |
| 主题 | `packages/opencode/src/cli/cmd/tui/context/theme.tsx` |
| Markdown | `packages/ui/src/components/markdown-stream.ts` |
| Agent | `packages/opencode/src/agent/agent.ts` |
| 安装 | `install` (跨平台 bash) |

---

> 源码包路径: `/tmp/deepseek-tui/` · `/tmp/hermes-agent/` · `/tmp/opencode/`
> KHY 项目: `/home/kodehu03/Khy-OS/`

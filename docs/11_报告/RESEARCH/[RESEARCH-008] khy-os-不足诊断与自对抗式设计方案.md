# Khy-OS 不足诊断与自对抗式设计方案

> **文档定位**：对 khy-os 项目的全量不足诊断 + 多轮对抗式设计推演。只设计，不动手。
> **分析范围**：架构、工程、治理、安全、性能、可扩展性、可维护性。
> **分析方法**：每个问题给出 A/B/C 三方案，通过对抗式论证推出最终推荐方案。
> **生成时间**：2026-09-03
> **分析基础**：代码实测 + 文档审计 + CI/CD 扫描 + 架构逆向

---

## 目录

- [第一部分：不足诊断](#第一部分不足诊断)
  - [架构级问题（AR）](#架构级问题ar)
  - [工程级问题（EG）](#工程级问题eg)
  - [治理级问题（GV）](#治理级问题gv)
  - [安全级问题（SC）](#安全级问题sc)
  - [性能级问题（PF）](#性能级问题pf)
  - [可扩展性级问题（EX）](#可扩展性级问题ex)
  - [可维护性级问题（MT）](#可维护性级问题mt)
- [第二部分：自对抗式设计方案](#第二部分自对抗式设计方案)
  - [设计方法论](#设计方法论)
  - [AR-1 对抗设计：router.js 上帝开关](#ar-1-对抗设计routerjs-上帝开关)
  - [AR-2 对抗设计：数据双栖问题](#ar-2-对抗设计数据双栖问题)
  - [AR-3 对抗设计：内核 preemption 验证残留](#ar-3-对抗设计内核-preemption-验证残留)
  - [EG-1 对抗设计：autoTestScaffolder 假测试](#eg-1-对抗设计autotestscaffolder-假测试)
  - [EG-2 对抗设计：restoreAgentService 空壳](#eg-2-对抗设计restoreagentservice-空壳)
  - [EG-3 对抗设计：metaToolEngine 调度死路](#eg-3-对抗设计metatoolengine-调度死路)
  - [GV-1 对抗设计：非阻塞测试基线](#gv-1-对抗设计非阻塞测试基线)
  - [GV-2 对抗设计：安全扫描缺失](#gv-2-对抗设计安全扫描缺失)
  - [GV-3 对抗设计：ACP 协议未冻结](#gv-3-对抗设计acp-协议未冻结)
  - [PF-1 对抗设计：aiGateway 语言纠偏复杂度](#pf-1-对抗设计aigateway-语言纠偏复杂度)
  - [EX-1 对抗设计：扩展契约违反](#ex-1-对抗设计扩展契约违反)
  - [MT-1 对抗设计：lint 债务 3417 条](#mt-1-对抗设计lint-债务-3417-条)

---

# 第一部分：不足诊断

## 架构级问题（AR）

### AR-1：router.js 上帝开关（Critical）

**症状**：`services/backend/src/cli/router.js` 含 3351 行代码，其中 `route()` 函数是一个 switch 语句，包含 119+ 个 case 分支（第 957–3234 行），直接操作 IO、调度 handler、管理权限。

**根因**：
- 早期命令少时，中央 switch 是最快实现方式
- 后期新增命令时，为避免重构风险，持续向 switch 追加 case
- 文件头部已拆出 `routerDispatchOps.js`、`routerDispatchSlash.js`、`routerDispatchTail.js` 三个子模块，但主 switch 仍保留 119 个 case，说明拆分不彻底
- 每个 case 内部 inline `require()` 破坏了懒加载策略（CLAUDE.md 声明的"快速冷启动"目标）

**影响**：
- 任何命令修改都需编辑 3000+ 行的文件，合并冲突概率极高
- 无法对单个命令做独立测试（必须加载整个 router）
- 启动时 require 链式加载，冷启动实测远超声称的"~40ms baseline"

**现状证据**：
```javascript
// router.js:957-3234 — 大 switch
switch (cmd) {
  case 'ai': /* ... 95 行 ... */ break;
  case 'gateway': /* ... 67 行 ... */ break;
  case 'service': require('./handlers.service'); // inline require
  // ... 116 个 case ...
}
```

---

### AR-2：数据双栖问题（Critical）

**症状**：两个"数据主目录"并存运行：
- `getDataHome()` 默认返回 `~/.khy`（Khy-OS 本体数据）
- 多个 service（`cleanupService`、`skillRegistry`、`adminService`）硬编码 `~/.khyquant`

**根因**：
- `dataHome.js` 第 47 行明确标注 `TODO: [Eco-Arch-Unresolved]`
- khyquant 从独立项目合入时，其数据目录习惯被完整保留
- `~/.khyquant` 是历史遗留，`~/.khy` 是规范要求，两者并存导致：
  - 用户配置存在 `~/.khy/config.json`
  - 技能/清理数据存在 `~/.khyquant/` 
  - 用户迁移/备份时极易遗漏

**影响**：
- 数据碎片化：同一用户的配置、凭据、对话记录分散在两个目录
- 备份脚本必须同时处理两处，漏备份风险高
- 便携版迁移时数据丢失隐患极大

**现状证据**：
```javascript
// dataHome.js:47-57
// TODO: [Eco-Arch-Unresolved] 两种"应用数据主目录"混用：
//   - getDataHome() → ~/.khy
//   - cleanupService/skillRegistry → ~/.khyquant
// 活体数据迁移需手动设计
```

---

### AR-3：内核 preemption 验证残留（High）

**症状**：`kernel/src/main.c` 第 132–144 行有一个 `hog_task()` 函数，是 CPU bound 无限循环，第 136 行标注 `TODO(verification-only): remove once preemption is confirmed in QEMU`。该任务在 `kernel_main()` 第 354 行被实际启动。

**根因**：
- 抢占式调度器开发时，需要一个验证任务来确认 preempt 能打断 CPU  bound 任务
- 验证完成后，该任务应被移除
- 但 TODO 没有关联 issue、没有截止日期、没有自动检测机制

**影响**：
- 如果 preemption 配置有微妙的 bug（如时钟中断在某些嵌套场景丢失），`hog_task` 会饿死所有其他任务（shell、services、desktop）
- 这是一个"潜在的 kernel panic 触发器"在生产代码中运行
- 没有任何运行时监控能检测到"hog_task 正在独占 CPU"

**现状证据**
```c
// main.c:132-144
void hog_task(void) {
  while (1) {
    // TODO(verification-only): remove once preemption is confirmed in QEMU
    for (volatile int i = 0; i < 1000000; i++) {}
  }
}
// main.c:354
create_task(hog_task, "hog");
```

---

## 工程级问题（EG）

### EG-1：autoTestScaffolder 假测试（High）

**症状**：`services/backend/src/services/selfSustainingInfra/autoTestScaffolder.js` 自动生成的测试全部使用 `assert.doesNotThrow()` 作为唯一断言。

**根因**：
- 自动生成器无法推断函数的行为契约（需要 LLM 或人工）
- 设计意图是"先建立行为快照基线，后续人工补全"
- 但第 118、129 行标注 `TODO: 补全行为断言`，没有强制机制确保补全

**影响**：
- CI 测试通过率虚高（100% 通过 = 0% 行为覆盖）
- 开发者误以为有测试保护，实际上重构时没有任何行为约束
- 与"零容忍红线"的工程文化冲突：测试是红线的第一道防线，假测试比无测试更危险

**现状证据**
```javascript
// autoTestScaffolder.js:113-133
test('${fnName} does not throw', () => {
  assert.doesNotThrow(() => {
    ${fnName}(); // 无参数调用，且不验证返回值
  });
  // TODO: 补全行为断言
});
```

---

### EG-2：restoreAgentService 空壳（High）

**症状**：`services/backend/src/services/restoreAgentService.js` 的 `_executeMove()` 方法是 stub：第 151 行 `const dryRun = opts.dryRun !== false;` 默认 dryRun=true，第 148 行 `TODO (future): 当 autonomy gate 授权后调用 execSync(move.action) 真实执行`。

**根因**：
- 自动修复涉及文件修改，风险极高
- 开发者担心误操作破坏代码，选择了保守的"只记录不执行"策略
- 但 `runAutoRestore()` 完整实现了 probe → plan → "execute" 循环，唯独执行是空操作

**影响**：
- 自动修复功能完全不可用
- 用户运行 `khy restore` 时，看到的修复报告是"已修复"，实际什么都没做
- 这是一个"假功能"——比缺失功能更糟，因为它给用户错误的修复信心

**现状证据**
```javascript
// restoreAgentService.js:142-164
async function _executeMove(move, opts = {}) {
  const dryRun = opts.dryRun !== false; // 默认 true
  if (dryRun) {
    log(`[dry-run] would execute: ${move.action}`);
    return { executed: false, dryRun: true };
  }
  // TODO (future): 当 autonomy gate 授权后调用 execSync
  return { executed: false, reason: 'autonomy_gate_not_implemented' };
}
```

---

### EG-3：metaToolEngine 调度死路（Medium）

**症状**：`services/backend/src/services/metaToolEngine.js` 的 `shouldForge()` 方法（第 564–573 行）是一个 stub，返回 true 但不被任何调度循环调用。

**根因**：
- 元工具锻造（遇到未知工具名时自动生成工具）是前瞻性功能
- `shouldForge()` 已写好，但调度器未接入
- 第 17 行标注 `# TODO: [MetaTool-*-Unresolved]`

**影响**：
- 核心功能"按需生成工具"不可用
- 代码维护成本：需要保留这份死代码，因为未来可能接入
- 测试覆盖困难：无法为未接入的代码写有意义的集成测试

**现状证据**
```javascript
// metaToolEngine.js:564-573
function shouldForge(toolName, context) {
  if (!enabled) return false;
  if (!toolName || typeof toolName !== 'string') return false;
  // 当前**不接入**调度循环
  return true;
}
```

---

## 治理级问题（GV）

### GV-1：非阻塞测试基线（High）

**症状**：`.github/workflows/pr-gate.yml` 第 236–271 行的 `test-baseline` job 设置了 `continue-on-error: true`，且注释说明"4 suite / 9 用例失败"是已知状态。

**根因**：
- 9 个测试用例在特定环境下持续失败
- 为避免阻塞所有 PR，设置了 continue-on-error
- 但没有分配修复责任人、没有截止日期、没有跟踪 issue

**影响**：
- 测试 gate 提供零信号：即使新增测试失败，PR 也能通过
- 与"质量门"的设计意图直接冲突
- 9 个失败用例成为"永久债务"，随时间推移可能增加

**现状证据**
```yaml
# pr-gate.yml:236-271
test-baseline:
  continue-on-error: true  # 9 个用例失败，待清零后删除
  steps:
    - run: npm run test:backend
      continue-on-error: true
```

---

### GV-2：安全扫描缺失（High）

**症状**：`pr-gate.yml` 没有 SAST、依赖审计、密钥扫描步骤。`codeql-analysis.yml` 存在但未在 PR gate 中引用。

**根因**：
- 项目早期聚焦功能开发，安全扫描被视为"锦上添花"
- CodeQL 配置为定时运行（schedule），非 PR 触发
- 没有引入 `npm audit`、`trufflehog`、`gitleaks` 等工具

**影响**：
- 依赖漏洞（如 log4shell 级别）可在 master 上存在数周才被发现
- 密钥泄露风险：开发者可能误提交 `.env` 或凭据文件
- 不符合"安全红线"的工程文化

**现状证据**
```yaml
# pr-gate.yml — 无 security 步骤
jobs:
  check-change-safety: ...
  check-agent-rules: ...
  check-repo-layout: ...
  test-baseline: ...
  # 无 security-scan / dependency-audit / secret-detection
```

---

### GV-3：ACP 协议未冻结（Medium）

**症状**：`[DESIGN-GOV-001]` 审计矩阵（第 14 行）标注 ACP 板块"缺 version/trace/deadline/idempotency 元数据；schema 与 response 形式不一致"。

**根因**：
- ACP（Agent Communication Protocol）是内部 RPC 协议
- 早期设计为 JSON-RPC 2.0，但运行时接受无 `method` 的 response
- 协议演进过程中，schema 和实现逐渐分叉

**影响**
- 跨版本兼容性风险：旧版 client 调用新版 server 可能失败
- 调试困难：缺少 trace 和 deadline 元数据，分布式追踪无法实现
- 幂等性缺失：重试可能导致重复操作（如重复创建资源）

**现状证据**
```
[DESIGN-GOV-001] §0 审计矩阵：
ACP — 已有校验方式: ACP transport 测试、JSON schema 检查
     空白或待工具化: 无版本/trace/deadline/idempotency 元数据；schema 与 response 形式不一致
```

---

## 安全级问题（SC）

### SC-1：模型导出无密码门（High）

**症状**：`modelTrainingService.js` 的 `verifyExportPassword()` 始终返回 true（第 192 行 AGENTS.md 明确说明）。

**根因**：历史密码门 `khy20026` 被有意移除，改为"部署/网络层控制访问"。

**影响**：
- 任何能访问 `khy export-model` 命令的人都能导出模型
- 如果模型包含微调数据（可能含敏感信息），泄露风险高
- "部署层控制"是空话：便携版部署在 U 盘上，没有网络层防护

---

### SC-2：check-agent-rules.js 豁免过宽（Medium）

**症状**：`scripts/ci/check-agent-rules.js` 第 413–433 行的硬编码端点检查豁免规则过于宽松：
- 含 `${}` 插值的模板字符串被豁免
- 含"例如/e.g./示例"的行被豁免
- `console.log` 中的 URL 被豁免

**影响**：开发者可通过简单技巧绕过红线检查：
```javascript
// 违规但被豁免
const url = `${protocol}://khyquant.top/api`; // 含 ${} → 豁免
// 示例：http://khyquant.top/api  // 含"示例" → 豁免
console.log('http://khyquant.top/api'); // console.log → 豁免
```

---

## 性能级问题（PF）

### PF-1：aiGateway 语言纠偏复杂度（Medium）

**症状**：`aiGateway.js` 第 386–1067 行实现了庞大的语言一致性检测和纠偏系统，包含：
- `_createCodexChineseChunkGate`（762–834 行）
- `_createKhyLanguageConsistencyTracker`（959–1067 行）
- `_injectKhyProtocolSystem`（396–405 行）
- `_injectKhyExpectedLanguageSystem`（415–444 行）
- `_injectKhyChineseRecoverySystem`（636–653 行）

**影响**：
- 每个请求都要经过多层语言注入和检测
- 语言检测基于正则匹配（`_looksLikeChineseScript`、`_looksLikeEnglishScript`），有误判风险
- 纠偏机制（abort + retry）增加延迟和 token 消耗

---

## 可扩展性级问题（EX）

### EX-1：扩展契约违反（Medium）

**症状**：`extensions/` 下多个扩展违反 `[DESIGN-TOOL-002]` 契约：
- `khy-desktop-rd`：`kind: asset` 但包含可执行代码（`main-pattern-extract.ts`、`lib.rs`、`Cargo.toml`）
- `khy-alpine-iso`：`commands: []` 但包含 `build-iso-docker.ps1` 等可执行脚本
- `khy-qoder-bridge`：`commands: []` 但包含 `install_autostart.ps1` 等可执行脚本

**影响**：
- 扩展加载器可能跳过 `kind: asset` 扩展的代码发现
- `commands: []` 的脚本对用户不可见，必须手动查找文档
- 契约形同虚设：如果扩展可以违反契约而不被拦截，新开发者更不会遵守

---

## 可维护性级问题（MT）

### MT-1：lint 债务 3417 条（Medium）

**症状**：`services/backend/src` 有 3417 个既有 lint 问题（428 errors + 2989 warnings across 1060 files）。CLAUDE.md 明确说"新文件必须干净；现有文件被 grandfathered"。

**影响**：
- 新文件零容忍 vs 旧文件无约束 = 代码质量标准分裂
- 开发者在旧文件中新写代码时，lint 不报警，导致债务持续增长
- 3417 条债务的清理成本随时间线性增长

---

# 第二部分：自对抗式设计方案

## 设计方法论

每个问题按以下流程设计：

1. **方案 A（激进重构）**：彻底解决，高成本高收益
2. **方案 B（渐进改良）**：最小改动，低成本低收益
3. **方案 C（对抗综合）**：A 和 B 的折中，通过对抗论证说明为什么 C 优于纯 A 或纯 B
4. **对抗记录**：A 反驳 B、B 反驳 A 的核心论点
5. **最终推荐**：C 方案 + 实施路径

---

## AR-1 对抗设计：router.js 上帝开关

### 方案 A：命令注册表 + 自动发现（激进重构）

**设计**：
- 删除 `route()` 的 switch 语句
- 建立命令注册表：`commands.json` 声明每个命令的 handler 路径、权限、子命令
- 启动时扫描 `handlers/` 目录，自动注册
- 子命令通过目录结构表达：`handlers/ai/chat.js`、`handlers/ai/ask.js`

**优点**：
- 新增命令只需添加文件 + 注册表条目，零修改 router.js
- 每个 handler 可独立测试
- 启动时只加载元数据，handler 按需 require

**缺点**：
- 需要重写 119 个 case 的调用方式
- 注册表与代码分离，可能出现"注册表有条目但文件已删除"的漂移
- 子命令的复杂逻辑（如 `ai` 的 95 行 if/else）需要重新设计

---

### 方案 B：保持 switch + 提取 handler（渐进改良）

**设计**：
- 保持 `route()` 的 switch 结构
- 将每个 case 的 inline 逻辑提取到独立 handler 文件
- switch 只保留 `case 'cmd': handler = require('./handlers/cmd.js'); handler.execute(args); break;`

**优点**：
- 改动最小：每个 case 独立提取，不影响其他 case
- 风险低：可以逐个 case 迁移，随时回滚
- 保持现有测试不变

**缺点**：
- switch 仍然有 119 个 case，文件仍然巨大
- 合并冲突风险未解决
- inline require 问题未解决（每个 case 首次命中时才加载）

---

### 方案 C：分层注册表 + 懒加载（对抗综合）

**设计**：

```
commands/
  registry.json          # 命令元数据（名称、描述、权限、handler 路径）
  handlers/              # 每个命令一个文件
    ai.js
    gateway.js
    service.js
    ...
  router.js              # 精简后的路由器（<200 行）
```

**router.js 新实现**：
```javascript
const registry = require('./commands/registry.json');

async function route(cmd, args) {
  const meta = registry[cmd];
  if (!meta) {
    return unknownCommand(cmd);
  }
  if (meta.permission && !checkPermission(meta.permission)) {
    return permissionDenied(cmd);
  }
  // 懒加载：只在首次命中时 require
  const handler = require(`./commands/handlers/${meta.handler}`);
  return handler.execute(args, meta.options);
}
```

**registry.json 结构**：
```json
{
  "ai": {
    "handler": "ai.js",
    "description": "AI 聊天 REPL",
    "permission": null,
    "subCommands": ["chat", "ask", "summary"]
  },
  "gateway": {
    "handler": "gateway.js",
    "description": "AI 网关管理",
    "permission": "admin"
  }
}
```

**对抗论证**：

| A 反驳 B | B 反驳 A |
|---------|---------|
| B 不解决根本问题：switch 仍然巨大，合并冲突仍然高频 | A 改动太大，119 个 case 迁移风险高，可能引入新 bug |
| B 的 inline require 问题未解决，冷启动性能差 | A 的注册表可能漂移，需要额外工具校验 |
| B 每次新增命令仍需编辑 router.js（哪怕只加一行 case） | A 的子命令复杂逻辑（如 `ai` 的 95 行 if/else）需要重新设计，工作量大 |

**C 如何综合**：
- 保留 A 的"注册表 + 懒加载"核心思想，解决 switch 巨大和 inline require 问题
- 采用 B 的"渐进迁移"策略：可以按命令优先级逐个迁移，不必一次性重写 119 个 case
- 注册表用 JSON 而非代码，降低 drift 风险（JSON 可被 CI 校验：`handler` 字段指向的文件必须存在）

**实施路径**：
1. 第 1 周：创建 `commands/registry.json` 和 `commands/handlers/` 目录，实现新 router
2. 第 2–4 周：按使用频率排序，迁移 Top 20 命令（覆盖 80% 使用场景）
3. 第 5–8 周：迁移剩余 99 个命令
4. 第 9 周：删除旧 router.js，CI 添加"禁止新增 switch case"规则

---

## AR-2 对抗设计：数据双栖问题

### 方案 A：统一迁移到 `~/.khy`（激进重构）

**设计**：
- 废弃 `~/.khyquant`，所有数据统一到 `~/.khy`
- 提供一次性迁移脚本：`khy migrate-data`
- 删除 `dataHome.js` 中的 `~/.khyquant` 引用

**优点**：
- 彻底解决碎片化
- 备份/迁移只需处理一个目录
- 符合"单一数据源"原则

**缺点**：
- 迁移脚本需要处理：已存在 `~/.khyquant` 的用户、正在运行的进程锁定文件、符号链接
- 如果迁移失败，可能导致数据损坏
- 需要通知所有用户手动运行迁移脚本

---

### 方案 B：兼容层 + 符号链接（渐进改良）

**设计**：
- 保持 `~/.khyquant` 和 `~/.khy` 并存
- 在 `~/.khy` 中创建符号链接指向 `~/.khyquant` 中的特定子目录
- `dataHome.js` 添加"数据定位器"：按优先级搜索两个目录

**优点**：
- 零迁移成本
- 向后兼容：旧脚本继续工作

**缺点**：
- 符号链接在 Windows 上需要管理员权限或开发者模式
- 数据仍然碎片化，只是"看起来统一"
- 备份脚本仍然需要处理两处

---

### 方案 C：数据抽象层 + 渐进迁移（对抗综合）

**设计**：

```
data/
  DataLocation.js    # 数据位置抽象：getUserDataPath(type)
  types/
    config.js        # 配置数据 → ~/.khy/config.json
    credentials.js   # 凭据数据 → ~/.khy/credentials/
    conversations.js # 对话数据 → ~/.khy/conversations/
    skills.js        # 技能数据 → ~/.khy/skills/
  migration/
    migrateFromKhyquant.js  # 一次性迁移脚本
```

**DataLocation.js 核心逻辑**：
```javascript
function getUserDataPath(dataType) {
  const khyHome = resolveKhyHome();      // ~/.khy
  const khyquantHome = resolveKhyquantHome(); // ~/.khyquant（如果存在）
  
  // 新数据统一写入 ~/.khy
  const targetPath = path.join(khyHome, dataType);
  
  // 如果目标不存在但 ~/.khyquant 有旧数据，透明迁移
  if (!fs.existsSync(targetPath) && khyquantHome) {
    const legacyPath = path.join(khyquantHome, dataType);
    if (fs.existsSync(legacyPath)) {
      fs.copySync(legacyPath, targetPath);
      log(`Migrated ${dataType} from ~/.khyquant to ~/.khy`);
    }
  }
  
  return targetPath;
}
```

**对抗论证**：

| A 反驳 B | B 反驳 A |
|---------|---------|
| B 的符号链接在 Windows 上不可靠，且数据仍然碎片化 | A 的迁移脚本风险高，一旦失败可能导致数据丢失 |
| B 没有解决根本问题，只是掩盖症状 | A 需要用户手动干预，便携版用户可能忽略迁移 |

**C 如何综合**：
- 采用 A 的"统一到 ~/.khy"目标
- 采用 B 的"透明兼容"策略：不强制迁移，而是在运行时按需复制
- 添加迁移状态标记：`~/.khy/.migration-complete`，避免重复迁移
- 提供 `khy migrate-data --check` 命令让用户查看迁移状态

**实施路径**：
1. 实现 `DataLocation.js` 抽象层
2. 修改 `dataHome.js` 使用 `DataLocation` 而非直接路径
3. 添加迁移状态检测和透明复制逻辑
4. 在 `khy doctor` 中添加"数据目录健康检查"
5. 6 个月后：如果 99% 用户已迁移，移除 `~/.khyquant` 兼容逻辑

---

## AR-3 对抗设计：内核 preemption 验证残留

### 方案 A：移除 hog_task + 添加运行时检测（激进重构）

**设计**：
- 删除 `hog_task()` 函数和 `create_task(hog_task, "hog")` 调用
- 添加运行时 preemption 健康检查：在 kernel_main 中启动一个监控任务，周期性验证其他任务是否获得 CPU 时间
- 如果监控任务检测到饥饿，触发 kernel panic 并输出诊断信息

**优点**：
- 彻底消除 hog_task 风险
- 运行时检测能捕获 preemption 配置错误
- 符合"生产代码不应包含验证代码"的原则

**缺点**：
- 监控任务本身消耗 CPU 资源（虽然很小）
- 如果 preemption 完全失效，监控任务也可能无法运行

---

### 方案 B：条件编译 + 编译时开关（渐进改良）

**设计**：
- 用 `#ifdef ENABLE_HOG_TASK` 包裹 hog_task 相关代码
- 默认关闭，只有开发时通过 `-DENABLE_HOG_TASK` 开启
- 在 Makefile 中添加 `make kernel-dev` 目标

**优点**：
- 零运行时开销（生产代码中不存在 hog_task）
- 开发时仍可验证 preemption
- 改动最小

**缺点**：
- 条件编译增加代码复杂度
- 如果开发者忘记关闭开关就发布，风险仍在

---

### 方案 C：QEMU 测试 + CI 门禁（对抗综合）

**设计**：

1. **移除 hog_task**：删除 `main.c` 中的 hog_task 代码
2. **添加 preemption 测试**：在 `kernel/tools/` 中添加 `test-preemption.c`
   - 创建 3 个任务：一个 CPU bound、一个 IO bound、一个监控
   - 验证监控任务能在 100ms 内获得 CPU
   - 如果验证失败，测试退出码非零
3. **CI 集成**：在 `.github/workflows/` 中添加 kernel 测试 job
   - 每次 PR 运行 QEMU + preemption 测试
   - 测试失败则阻断合并

**对抗论证**：

| A 反驳 B | B 反驳 A |
|---------|---------|
| B 的条件编译是"纸面安全"：如果开发者忘记关闭开关，hog_task 仍在生产代码中 | A 的运行时监控增加内核复杂度，且监控任务本身可能受 preemption bug 影响 |
| B 没有解决"如何验证 preemption 正确工作"的问题 | A 的运行时检测在 preemption 完全失效时无法工作 |

**C 如何综合**：
- 采用 A 的"移除 hog_task"目标
- 采用 B 的"开发/生产分离"思想，但通过 CI 而非条件编译实现
- 添加独立的 preemption 测试，作为 CI 门禁而非运行时监控

**实施路径**：
1. 删除 `main.c` 中的 hog_task 代码
2. 编写 `kernel/tools/test-preemption.c`
3. 在 Makefile 中添加 `make test-preemption` 目标
4. 在 CI 中添加 kernel 测试 job
5. 文档更新：移除 `TODO(verification-only)` 注释

---

## EG-1 对抗设计：autoTestScaffolder 假测试

### 方案 A：LLM 辅助断言生成（激进重构）

**设计**：
- 使用 LLM 分析函数体，推断行为契约
- 生成包含真实断言（返回值验证、异常测试、边界条件）的测试
- 集成到 `khy generate-test` 命令

**优点**：
- 生成的测试有真实行为覆盖
- 减少人工编写测试的工作量

**缺点**：
- LLM 可能生成错误的断言（误将 bug 行为断言为正确）
- 需要 AI 调用成本
- 对于复杂逻辑，LLM 推断可能不准确

---

### 方案 B：运行时行为快照（渐进改良）

**设计**：
- 在开发模式下，记录函数的实际输入/输出
- 将记录的行为作为"快照断言"
- 后续运行测试时，验证函数行为与快照一致

**优点**：
- 断言基于真实行为，无误推断
- 能捕获行为变更（回归检测）

**缺点**：
- 如果原始行为有 bug，快照会固化 bug
- 需要运行时录制基础设施
- 快照可能因环境变化而不稳定

---

### 方案 C：契约优先 + 人工确认（对抗综合）

**设计**：

1. **测试模板升级**：`autoTestScaffolder.js` 生成三种测试：
   - **结构测试**（自动）：函数存在、可调用、参数数量正确
   - **契约测试**（半自动）：基于 JSDoc 类型注解生成断言
   - **行为测试**（手动）：留 TODO 注释，但 CI 统计"行为测试覆盖率"

2. **CI 门禁**：
   - 结构测试：100% 必须通过
   - 契约测试：如果函数有 JSDoc，必须通过
   - 行为测试：覆盖率 < 50% 时 PR 警告（不阻断，但显示在 PR 评论中）

3. **行为测试激励**：
   - `khy test-coverage` 显示每个函数的行为测试状态
   - 在 README 中添加"行为测试覆盖率"徽章

**对抗论证**：

| A 反驳 B | B 反驳 A |
|---------|---------|
| B 的快照会固化 bug：如果原始行为有误，快照断言会保护这个 bug | A 的 LLM 推断可能错误，生成的断言可能误导开发者 |
| B 的快照不稳定：环境变化导致快照失效，维护成本高 | A 需要 AI 调用成本，且复杂逻辑推断不准确 |

**C 如何综合**：
- 采用 A 的"自动化生成"思想，但限制在"结构测试"和"契约测试"（低风险）
- 采用 B 的"行为验证"思想，但通过"覆盖率激励"而非"快照固化"实现
- 行为测试留给人写，但通过 CI 统计和 PR 提醒保持压力

**实施路径**：
1. 升级 `autoTestScaffolder.js`，生成结构测试 + 契约测试
2. 添加 `khy test-coverage` 命令，统计行为测试覆盖率
3. 在 `pr-gate.yml` 中添加行为测试覆盖率检查（warning 级别）
4. 在 CONTRIBUTING.md 中添加"行为测试编写指南"

---

## EG-2 对抗设计：restoreAgentService 空壳

### 方案 A：完整自治修复（激进重构）

**设计**：
- 实现完整的 autonomy gate：基于代码变更风险等级（低/中/高/关键）决定自动执行或人工审批
- 低风险修复（如格式调整）：自动执行
- 中风险修复（如依赖升级）：自动执行 + 通知用户
- 高风险修复（如逻辑修改）：生成修复提案，用户确认后执行
- 关键修复（如安全补丁）：自动执行 + 创建回滚点

**优点**：
- 修复能力最大化
- 减少人工干预

**缺点**：
- 风险分级困难：哪些修复是"低风险"？
- 自动执行可能引入新 bug
- 回滚机制复杂

---

### 方案 B：只读建议模式（渐进改良）

**设计**：
- 保持 `_executeMove()` 为 dry-run
- 生成详细的修复报告（包含 diff、影响分析、回滚步骤）
- 提供 `khy restore --apply` 命令，用户手动触发执行

**优点****
- 零风险：所有修复由用户确认
- 实现简单

**缺点**：
- 用户体验差：需要手动确认每个修复
- 修复效率低

---

### 方案 C：沙箱执行 + 自动回滚（对抗综合）

**设计**：

1. **沙箱执行**：
   - 在 git worktree 中执行修复
   - 修复后运行相关测试
   - 测试通过 → 合并到主分支
   - 测试失败 → 丢弃 worktree

2. **风险分级**：
   - 低风险：只修改注释、格式、文档 → 自动执行
   - 中风险：修改代码但测试覆盖充分 → 自动执行 + 通知
   - 高风险：修改核心逻辑或测试不足 → 生成报告，用户确认

3. **回滚机制**：
   - 每次修复前创建 git tag
   - 提供 `khy restore --rollback <tag>` 命令

**对抗论证**：

| A 反驳 B | B 反驳 A |
|---------|---------|
| B 的只读模式用户体验差，修复效率低 | A 的自动执行风险高，可能引入新 bug |
| B 没有利用自动化的价值 | A 的回滚机制复杂，实现成本高 |

**C 如何综合**：
- 采用 A 的"自动执行"思想，但限制在沙箱环境中
- 采用 B 的"用户确认"思想，但只针对高风险修复
- 通过 git worktree 实现天然回滚，无需额外基础设施

**实施路径**：
1. 实现沙箱执行引擎（基于 git worktree）
2. 实现风险分级逻辑（基于文件路径和测试覆盖）
3. 实现回滚机制（基于 git tag）
4. 修改 `_executeMove()` 使用沙箱执行
5. 添加 `khy restore --rollback` 命令

---

## EG-3 对抗设计：metaToolEngine 调度死路

### 方案 A：完整元工具系统（激进重构）

**设计**：
- 接入调度循环：当工具调用失败（工具不存在）时，触发 `shouldForge()`
- 实现工具锻造：基于工具描述，生成工具实现代码
- 实现工具验证：在沙箱中运行生成的工具，验证正确性

**优点**：
- 核心功能可用
- 扩展性极强

**缺点**：
- 实现复杂度极高
- 工具锻造的可靠性存疑
- 安全风险：自动生成的工具可能有 bug 或安全漏洞

---

### 方案 B：移除死代码（渐进改良）

**设计**：
- 删除 `metaToolEngine.js` 中的 `shouldForge()` 和未使用的主要逻辑
- 保留文档说明"元工具锻造是未来功能"
- 当需要时重新实现

**优点**：
- 减少维护负担
- 代码更清晰

**缺点**：
- 丢失已投入的开发成本
- 未来重新实现时可能重复今天的错误

---

### 方案 C：功能标记 + 接口预留（对抗综合）

**设计**：

1. **功能标记**：
   - 在 `metaToolEngine.js` 中添加 `META_TOOL_ENABLED` 功能标记（默认关闭）
   - 所有元工具相关代码在标记关闭时短路返回

2. **接口预留**：
   - 保持 `shouldForge()` 和 `forgeTool()` 的接口不变
   - 在调度循环中添加注释标记的钩子点（不调用，但预留位置）

3. **设计文档**：
   - 编写 `[DESIGN-META-001] 元工具锻造系统设计`
   - 明确触发条件、锻造流程、验证机制、安全边界

**对抗论证**：

| A 反驳 B | B 反驳 A |
|---------|---------|
| B 的移除策略丢失了已投入的开发成本，且未来重新实现时可能重复错误 | A 的实现复杂度高，工具锻造的可靠性存疑，安全风险大 |
| B 没有解决"未来如何接入"的问题 | A 的自动生成的工具可能有 bug 或安全漏洞 |

**C 如何综合**：
- 采用 B 的"减少维护负担"思想，通过功能标记而非删除实现
- 采用 A 的"接口预留"思想，保持未来接入的可能性
- 通过设计文档明确未来实现路径，避免重复错误

**实施路径**：
1. 添加 `META_TOOL_ENABLED` 功能标记（默认 false）
2. 在 `shouldForge()` 入口处添加标记检查
3. 在调度循环中添加钩子点注释
4. 编写 `[DESIGN-META-001]` 设计文档
5. 在 roadmap 中标记为"Q3 2026 待实现"

---

## GV-1 对抗设计：非阻塞测试基线

### 方案 A：清零失败用例 + 阻断门禁（激进重构）

**设计**：
- 分配 2 周时间专门修复 9 个失败用例
- 修复后删除 `continue-on-error`
- 测试失败 = PR 阻断

**优点**：
- 测试 gate 提供真实信号
- 代码质量有保障

**缺点**：
- 9 个用例的修复成本可能很高（某些可能是环境依赖或竞态条件）
- 2 周时间可能不够

---

### 方案 B：分类处理 + 渐进清零（渐进改良）

**设计**：
- 将 9 个失败用例分类：
  - 环境依赖（如需要特定数据库版本）：标记为 `@env-skip`
  - 竞态条件：标记为 `@flaky`，单独重试
  - 真实 bug：标记为 `@bug`，分配 issue
- 只有 `@bug` 类用例失败时阻断 PR

**优点**：
- 区分"已知环境限制"和"真实 bug"
- 渐进清零，不要求一次性修复

**缺点**：
- 分类工作本身需要时间
- `@flaky` 和 `@env-skip` 可能被滥用为"跳过失败"的借口

---

### 方案 C：测试债务追踪 + 自动分配（对抗综合）

**设计**：

1. **测试债务登记**：
   - 创建 `tests/DEBT.md`，登记每个失败用例：
     - 失败原因分类（env/flaky/bug）
     - 负责人
     - 预计修复日期
     - 关联 issue

2. **自动分配**：
   - 使用 CODEOWNERS 自动分配失败用例给模块负责人
   - 每周生成"测试债务报告"，发送到项目频道

3. **门禁升级路径**：
   - 当前：`continue-on-error`（warning）
   - 3 个月后：`@env-skip` 和 `@flaky` 用例跳过，`@bug` 用例阻断
   - 6 个月后：所有用例阻断

**对抗论证**：

| A 反驳 B | B 反驳 A |
|---------|---------|
| B 的分类处理可能被滥用为"跳过失败"的借口 | A 的 2 周清零计划不现实，9 个用例的修复成本可能很高 |
| B 没有解决"测试债务持续增加"的问题 | A 没有区分"环境限制"和"真实 bug"，可能浪费资源 |

**C 如何综合**：
- 采用 A 的"清零"目标，但分阶段实现
- 采用 B 的"分类处理"思想，但通过登记制度防止滥用
- 通过自动分配和周报保持压力

**实施路径**：
1. 创建 `tests/DEBT.md`，登记 9 个失败用例
2. 为每个用例创建 issue 并分配负责人
3. 修改 `pr-gate.yml`，添加测试债务追踪（显示在 PR 评论中）
4. 设置 3 个月和 6 个月的门禁升级里程碑

---

## GV-2 对抗设计：安全扫描缺失

### 方案 A：完整安全工具链（激进重构）

**设计**：
- 集成 CodeQL（SAST）、`npm audit`（依赖扫描）、`gitleaks`（密钥检测）、`trivy`（容器扫描）
- 所有扫描在 PR 阶段运行
- 高危漏洞阻断合并

**优点**：
- 安全覆盖全面
- 符合行业最佳实践

**缺点**：
- CI 时间显著增加（每个 PR 多 5–10 分钟）
- 工具配置和维护成本高
- 误报可能阻塞开发

---

### 方案 B：基础扫描 + 定时审计（渐进改良）

**设计**：
- PR 阶段只运行 `npm audit`（快速、低误报）
- 密钥扫描和 SAST 在 nightly 构建中运行
- 高危漏洞通过 issue 追踪，不阻断 PR

**优点**：
- CI 时间影响最小
- 维护成本低

**缺点**：
- 安全反馈延迟（nightly 而非 per-PR）
- 漏洞可能在 master 上存在数天

---

### 方案 C：分层扫描 + 智能阻断（对抗综合）

**设计**：

1. **PR 阶段（快速反馈）**：
   - `npm audit`：只检查 `critical` 级别，5 秒内完成
   - `gitleaks`：只扫描 PR 的 diff，不扫描全量历史
   - 阻断条件：`critical` 漏洞或确认的密钥泄露

2. **Nightly 阶段（深度扫描）**：
   - CodeQL 全量扫描
   - `trivy` 容器扫描
   - 生成安全报告，发送到安全频道

3. **安全响应**：
   - 发现 `critical` 漏洞 → 自动创建 issue + 通知安全负责人
   - 发现密钥泄露 → 自动阻断 PR + 要求轮换密钥

**对抗论证**：

| A 反驳 B | B 反驳 A |
|---------|---------|
| B 的 nightly 反馈延迟，漏洞可能在 master 上存在数天 | A 的 CI 时间增加过多，误报可能阻塞开发 |
| B 的"不阻断 PR"策略无法防止漏洞合并 | A 的工具配置和维护成本高 |

**C 如何综合**：
- 采用 A 的"per-PR 扫描"思想，但限制在快速、低误报的工具
- 采用 B 的"nightly 深度扫描"思想，作为 PR 扫描的补充
- 通过"智能阻断"减少误报影响

**实施路径**：
1. 在 `pr-gate.yml` 中添加 `npm audit` 和 `gitleaks` 步骤
2. 配置 `gitleaks` 只扫描 PR diff
3. 在 nightly workflow 中添加 CodeQL 和 trivy
4. 创建安全响应 issue 模板

---

## GV-3 对抗设计：ACP 协议未冻结

### 方案 A：完整协议规范（激进重构）

**设计**：
- 编写完整的 ACP 协议规范（类似 OpenAPI）
- 包含：方法枚举、请求/响应 schema、错误码、版本策略、trace 传播
- 生成客户端/服务端代码

**优点**：
- 协议清晰，无歧义
- 自动生成减少实现错误

**缺点**：
- 规范编写成本高
- 需要更新所有现有实现以符合规范

---

### 方案 B：最小修补 + 文档（渐进改良）

**设计**：
- 在现有 JSON-RPC 2.0 基础上添加 `trace` 和 `deadline` 字段
- 文档说明协议约定
- 不强制版本策略

**优点**：
- 改动最小
- 向后兼容

**缺点**：
- 协议仍然不完整
- 缺乏版本策略，未来演进困难

---

### 方案 C：协议冻结 + 渐进演进（对抗综合）

**设计**：

1. **协议冻结（v1.0）**：
   - 冻结当前 JSON-RPC 2.0 核心（method、params、result、error）
   - 添加 `meta` 字段（包含 `trace`、`deadline`、`version`）
   - 编写 `docs/ACP-PROTOCOL-v1.md`

2. **兼容性保证**：
   - v1.0 客户端必须忽略未知的 `meta` 字段
   - v1.0 服务端必须接受无 `meta` 的请求

3. **版本协商**：
   - 客户端在 `meta.version` 中声明版本
   - 服务端在响应中返回支持的版本列表
   - 不支持的版本返回特定错误码

**对抗论证**：

| A 反驳 B | B 反驳 A |
|---------|---------|
| B 的最小修补无法解决协议演进问题 | A 的完整规范编写成本高，需要更新所有现有实现 |
| B 缺乏版本策略，未来分叉风险高 | A 的代码生成可能不适用于所有使用场景 |

**C 如何综合**：
- 采用 A 的"协议规范"思想，但只冻结当前核心，不追求完整
- 采用 B 的"最小改动"思想，通过 `meta` 字段实现扩展
- 通过版本协商保证向后兼容

**实施路径**：
1. 编写 `docs/ACP-PROTOCOL-v1.md`
2. 在 ACP transport 中添加 `meta` 字段处理
3. 添加版本协商逻辑
4. 更新所有 ACP 方法以包含 `meta` 字段
5. 在 CI 中添加协议合规性检查

---

## PF-1 对抗设计：aiGateway 语言纠偏复杂度

### 方案 A：外置语言服务（激进重构）

**设计**：
- 将语言检测逻辑移到独立服务（如 Python 的 `langdetect` 或 `fasttext`）
- aiGateway 通过 RPC 调用语言服务
- 语言服务可独立扩展和更新

**优点**：
- 语言检测准确率更高
- aiGateway 代码更简洁
- 语言服务可复用

**缺点**：
- 增加网络延迟
- 增加部署复杂度
- 对于简单的中英文检测，大材小用

---

### 方案 B：简化正则 + 缓存结果（渐进改良）

**设计**：
- 保留现有正则检测，但简化逻辑
- 缓存语言检测结果（基于 prompt hash）
- 减少重复检测

**优点**：
- 改动最小
- 性能提升明显（缓存命中时）

**缺点**：
- 正则检测准确率仍然有限
- 缓存可能命中错误结果

---

### 方案 C：分层检测 + 按需纠偏（对抗综合）

**设计**：

1. **第一层：快速检测**（请求时）：
   - 基于 prompt 的显式语言指令（如"请用中文"）
   - 基于用户配置（`KHY_LANGUAGE`）
   - 无成本，覆盖 90% 场景

2. **第二层：轻量检测**（首 chunk 时）：
   - 使用现有正则检测
   - 只在"风险适配器"（codex、claude 等）上启用
   - 检测到偏航时 abort + retry

3. **第三层：深度检测**（可选）：
   - 对于关键任务，使用外部语言服务
   - 通过功能标记启用

**对抗论证**：

| A 反驳 B | B 反驳 A |
|---------|---------|
| B 的正则检测准确率有限，无法处理混合语言场景 | A 的外部服务增加延迟和部署复杂度，对简单检测大材小用 |
| B 的缓存可能命中错误结果 | A 的语言服务需要额外维护成本 |

**C 如何综合**：
- 采用 A 的"分层"思想，但将外部服务作为可选第三层
- 采用 B 的"缓存"思想，但只在第一层使用
- 通过"按需纠偏"减少不必要的检测

**实施路径**：
1. 重构 `aiGateway.js`，将语言检测逻辑分层
2. 第一层：基于配置和 prompt 的快速检测
3. 第二层：保留现有正则检测，但限制在风险适配器
4. 第三层：添加外部语言服务接口（可选）
5. 性能测试：对比重构前后的延迟和 token 消耗

---

## EX-1 对抗设计：扩展契约违反

### 方案 A：强制契约校验 + CI 阻断（激进重构）

**设计**：
- 在 `check-repo-layout.js` 中添加扩展契约校验
- 所有扩展必须通过 `khy.extension.json` schema 校验
- 违反契约的扩展无法通过 CI

**优点**：
- 契约得到严格执行
- 新扩展自动符合规范

**缺点**：
- 现有违反契约的扩展需要修复或移除
- 可能破坏现有工作流

---

### 方案 B：文档警告 + 人工修复（渐进改良）

**设计**：
- 在 CI 中添加扩展契约检查（warning 级别）
- 生成报告但不阻断
- 人工修复违反契约的扩展

**优点**：
- 不破坏现有工作流
- 给开发者修复时间

**缺点**：
- 契约仍然不被严格执行
- 警告可能被忽略

---

### 方案 C：契约版本化 + 渐进合规（对抗综合）

**设计**：

1. **契约版本化**：
   - `khy.extension.json` 中添加 `schemaVersion` 字段
   - 旧扩展使用 `schemaVersion: "1.0"`（宽松校验）
   - 新扩展使用 `schemaVersion: "2.0"`（严格校验）

2. **渐进合规**：
   - 新 PR 中的扩展必须使用 `schemaVersion: "2.0"`
   - 旧扩展在修改时升级到 `schemaVersion: "2.0"`
   - 6 个月后：所有扩展必须使用 `schemaVersion: "2.0"`

3. **自动修复工具**：
   - 提供 `khy extension-upgrade` 命令，自动将旧扩展升级到 v2.0

**对抗论证**：

| A 反驳 B | B 反驳 A |
|---------|---------|
| B 的警告级别无法保证契约执行 | A 的强制校验可能破坏现有工作流 |
| B 的"人工修复"依赖开发者自觉，容易被忽略 | A 的"所有扩展必须修复"要求可能不切实际 |

**C 如何综合**：
- 采用 A 的"强制校验"思想，但只针对新扩展和修改的旧扩展
- 采用 B 的"渐进修复"思想，但通过版本化和自动工具降低修复成本
- 通过时间盒（6 个月）保证最终合规

**实施路径**：
1. 更新 `khy.extension.json` schema，添加 `schemaVersion` 字段
2. 修改 `check-repo-layout.js`，根据版本应用不同校验规则
3. 实现 `khy extension-upgrade` 命令
4. 在 CI 中添加版本检查（warning 级别，6 个月后升级为 error）

---

## MT-1 对抗设计：lint 债务 3417 条

### 方案 A：全量修复 + 阻断新增（激进重构）

**设计**：
- 分配 1 个月时间修复所有 3417 条 lint 问题
- 修复后启用严格模式：任何 lint 问题阻断 PR
- 新文件零容忍，旧文件修复后也零容忍

**优点**：
- 代码质量统一
- lint 成为有效门禁

**缺点**：
- 1 个月修复 3417 条问题，工作量大
- 某些"修复"可能只是压制警告（如 `// eslint-disable`）

---

### 方案 B：新文件零容忍 + 旧文件渐进修复（渐进改良）

**设计**：
- 保持现状：新文件零容忍，旧文件 grandfathered
- 添加"修复附近坏味道"指南：修改文件时，顺手修复该文件的 lint 问题
- 每月统计 lint 债务变化

**优点**：
- 改动最小
- 渐进修复，不集中投入

**缺点**：
- 债务减少速度可能很慢
- "顺手修复"依赖开发者自觉

---

### 方案 C：热点修复 + 自动修复 + 债务追踪（对抗综合）

**设计**：

1. **热点分析**：
   - 分析 3417 条 lint 问题，按"修改频率"排序
   - 识别 Top 50 高频修改文件（覆盖 50% 的 lint 问题）

2. **集中修复热点**：
   - 分配 2 周时间修复 Top 50 文件的 lint 问题
   - 使用 `eslint --fix` 自动修复可自动化的部分

3. **债务追踪**：
   - 在 CI 中添加 lint 债务计数（显示在 PR 评论中）
   - 设置月度目标：每月减少 10% 债务

4. **新文件门禁**：
   - 保持新文件零容忍
   - 修改旧文件时，如果该文件 lint 问题 > 10 条，要求修复至少 50%

**对抗论证**：

| A 反驳 B | B 反驳 A |
|---------|---------|
| B 的渐进修复速度太慢，债务可能永远无法清零 | A 的 1 个月全量修复不现实，某些 lint 问题可能是误报 |
| B 的"顺手修复"依赖开发者自觉，效果不可控 | A 的"修复"可能只是压制警告，而非真正改进代码质量 |

**C 如何综合**：
- 采用 A 的"集中修复"思想，但只针对高频修改文件
- 采用 B 的"渐进修复"思想，但通过债务追踪和月度目标保持压力
- 通过自动修复减少人工成本

**实施路径**：
1. 运行 `eslint --format json` 分析 lint 问题分布
2. 识别 Top 50 高频修改文件
3. 分配 2 周时间集中修复
4. 在 CI 中添加 lint 债务计数和月度目标检查
5. 更新 CONTRIBUTING.md，添加"lint 修复指南"

---

# 总结：优先级矩阵

| 编号 | 问题 | 严重度 | 推荐方案 | 预计工期 |
|------|------|--------|---------|---------|
| AR-1 | router.js 上帝开关 | Critical | C：分层注册表 + 懒加载 | 9 周 |
| AR-2 | 数据双栖 | Critical | C：数据抽象层 + 渐进迁移 | 8 周 |
| AR-3 | 内核 preemption 残留 | High | C：QEMU 测试 + CI 门禁 | 2 周 |
| EG-1 | autoTestScaffolder 假测试 | High | C：契约优先 + 人工确认 | 3 周 |
| EG-2 | restoreAgentService 空壳 | High | C：沙箱执行 + 自动回滚 | 4 周 |
| EG-3 | metaToolEngine 调度死路 | Medium | C：功能标记 + 接口预留 | 1 周 |
| GV-1 | 非阻塞测试基线 | High | C：测试债务追踪 + 自动分配 | 6 周 |
| GV-2 | 安全扫描缺失 | High | C：分层扫描 + 智能阻断 | 3 周 |
| GV-3 | ACP 协议未冻结 | Medium | C：协议冻结 + 渐进演进 | 4 周 |
| PF-1 | aiGateway 语言纠偏复杂度 | Medium | C：分层检测 + 按需纠偏 | 3 周 |
| EX-1 | 扩展契约违反 | Medium | C：契约版本化 + 渐进合规 | 4 周 |
| MT-1 | lint 债务 3417 条 | Medium | C：热点修复 + 自动修复 + 债务追踪 | 6 周 |

---

# 附录：对抗式设计方法论说明

## 什么是"自我对抗式设计方案"

传统设计流程：问题 → 方案 → 实施。
对抗式设计流程：问题 → 方案A → 方案B → A反驳B → B反驳A → 方案C（综合）→ 实施。

## 为什么需要对抗式设计

1. **避免确认偏误**：设计者容易陷入"第一个方案就是最好方案"的思维定式
2. **暴露隐藏假设**：通过反驳，暴露每个方案的前提条件和风险
3. **提高方案鲁棒性**：综合方案经过两轮反驳，比单一方案更健壮
4. **降低实施风险**：综合方案通常比激进方案更可行，比渐进方案更有效

## 对抗式设计的三个原则

1. **对称性**：A 和 B 必须是真正的对立面（如激进 vs 渐进），不能是"好方案"和"坏方案"
2. **证据性**：每个反驳必须基于具体证据（代码、数据、案例），不能是主观意见
3. **建设性**：C 方案必须明确说明如何综合 A 和 B 的优点，不能是"和稀泥"

---

*本文档由 AI 辅助分析生成，基于 khy-os 仓库的代码实测和文档审计。所有方案均为设计建议，实施前需维护者评审。*

<!-- 文档分类: DEPLOY-MAN-014 | 阶段: 部署 | 原路径: docs/指南/发布说明-0.1.27.md -->
# KHY OS v0.1.27 发布说明

**发布日期**: 2026-05-21
**PyPI**: https://pypi.org/project/khy-os/0.1.27/

---

## 一、上下文管理修复（压缩后 API 400 错误）

### 问题描述

多轮对话后触发上下文压缩，下一次请求返回 HTTP 400。根因为三个缺陷叠加：
1. 压缩后角色交替规则被破坏（连续 user-user 或 assistant-assistant）
2. 安全系数三层叠加（`estimateTokens` 1.2x × `_estimateContextTokens` 1.2x × `contextRouter` 1.2x = 有效 1.44x），导致过早触发压缩
3. 已压缩内容被二次全量压缩，摘要质量退化

### 修复内容

#### A1. 统一角色交替守卫

**文件**: `backend/src/services/contextCompressor.js`

新增 `enforceRoleAlternation(messages)` 函数，替代所有散落的手动桥接修复：
- 分离开头 system 消息
- 确保对话以 user 开头
- 连续同角色消息之间自动插入 `[continued]` 占位
- tool/system 角色归一化处理

**集成点**: `ai.js` `_buildStructuredMessages()` 末尾统一调用。

#### A2. 消除安全系数叠加

| 位置 | 改动 |
|------|------|
| `khyUpgradeRuntime.js` `estimateTokens()` | 移除 `× 1.2`，返回原始估计 |
| `ai.js` `_estimateContextTokens()` | 移除 `× 1.2` |
| `contextRouter.js` `SAFETY_MARGIN` | 保留 `1.2`（唯一应用点） |

#### A3. 硬地板 + 上下文限制提升

**文件**: `contextRouter.js`、`khyUpgradeRuntime.js`、`ai.js`

- 新增 `HARD_FLOOR_TOKENS = 32768`：低于此阈值直接返回 `fits`，不触发任何压缩，保护 prefix cache
- `CONTEXT_TOKEN_LIMIT` 从 65536 提升到 131072
- `_resolveTaskScale()` small 阈值从 `len ≤ 120` 调整为 `len ≤ 40`
- `_resolveContextBudget()` smallCap 从 32000 提升到 65536

参考来源：DeepSeek-TUI 500K 硬地板设计。

#### A4. 防止双重压缩 + 增量摘要

**文件**: `contextCompressor.js`

- `compress()` 开头检测消息中是否已包含 `[Compressed context summary]` 或 `[ContextCompact v2` 标记
- 已有摘要时调用 `_incrementalUpdate()` 增量更新，而非全量重新压缩
- `ai.js` 硬守卫：已包含摘要的消息只允许 tool truncation，禁止重新 `buildSlidingWindow`

参考来源：Hermes Agent 增量摘要模式。

#### A5. 反抖动 + Session 恢复保护

**文件**: `contextCompressor.js`、`ai.js`

- **冷却期**: 两次压缩最小间隔 30 秒 (`COMPRESSION_COOLDOWN_MS`)
- **低效跳过**: 连续 2 次压缩效率低于 10% 时自动跳过下一次
- **Session 恢复**: `autoResumeLastSession()` 恢复时调用 `markSessionResumed()`，防止对已压缩内容立即重新压缩

参考来源：Hermes Agent 反抖动机制。

---

## 二、无响应 Bug 修复（终端卡死/无回复）

### 问题描述

用户反馈"有问无回答，有求无应，有选择无响应"，具体表现：
- 请求挂起不返回
- 菜单选择无反应
- readline 不恢复到输入状态

### 修复内容

#### B1. Gateway 绝对超时

**文件**: `ai.js` `_gatewayGenerate()`

新增 `GATEWAY_ABSOLUTE_TIMEOUT_MS = 300000`（5 分钟）绝对生命周期超时。之前只检查空闲时间（`silentFor`），适配器发送 keepalive 心跳时可无限挂起。

#### B2. 工具循环绝对超时

**文件**: `toolUseLoop.js`

- 新增 `TOOL_LOOP_ABSOLUTE_TIMEOUT_MS = 180000`（3 分钟）
- 每次迭代检查绝对时间，超时后返回已有结果 + 超时提示（不是空回复）
- `effectiveMaxIterations` 上限从 160 降低到 60

#### B3. finally 块防御性包裹

**文件**: `repl.js`

主 AI 处理的 finally 块中，将粘贴队列清理和 burst buffer 清理放入**独立的** try-catch：
```
try { /* paste queue cleanup */ } catch (e) { console.error(...) }
try { /* burst buffer cleanup */ } catch (e) { console.error(...) }
// readline 恢复始终执行
try { rl.prompt(); } catch {}
```

之前任何一段清理抛异常会阻塞后续的 readline 恢复，导致终端永久无响应。

#### B4. 关键 catch 块加日志

在 5 个高风险空 catch 块添加 `console.error` 日志，便于诊断问题：

| 位置 | 用途 |
|------|------|
| `ai.js` 模型状态获取 | `[ai] 模型状态获取失败` |
| `ai.js` directGenerate 回退 | `[ai] directGenerate 回退失败` |
| `ai.js` context routing 异常 | `[ai] context routing 异常, 回退到 slidingWindow` |
| `repl.js` stdin 恢复 | `[repl] 模型选择/stdin 恢复失败` |
| `repl.js` AI 内联选择 | `[repl] AI 内联选择失败` |

---

## 三、图片分析修复（Windows 剪贴板图片无法识别）

### 问题描述

Windows 上通过剪贴板桥接粘贴图片后，AI 返回 "ERROR: Tool failed"，6% ctx 后无下文。

### 根因

`multiFreeService.js` 的 `callOpenAI()` 和 `callAnthropic()` 中，当使用 `structuredMessages`（多轮对话模式）时，图片注入逻辑被完全跳过：

```javascript
// 问题代码
const messages = opts.structuredMessages?.length > 0
  ? opts.structuredMessages          // ← 直接用原始消息，图片丢失！
  : [{ role: 'user', content: messageContent }]; // ← 只有这条路径包含图片
```

KHY 多轮对话始终使用 `structuredMessages`，因此图片永远不会被发送给模型。

### 修复

**文件**: `backend/src/services/multiFreeService.js`

`callOpenAI()` 和 `callAnthropic()` 中新增：当 `structuredMessages` 存在且有 `images` 时，找到最后一条 user 消息，将图片 blocks 注入到其 `content` 数组中：

- OpenAI: `{ type: 'image_url', image_url: { url: 'data:mime;base64,...', detail: 'auto' } }`
- Anthropic: `{ type: 'image', source: { type: 'base64', media_type, data } }`

---

## 四、Redis 提示污染输入框修复

### 问题描述

启动时 `⚠ Redis 不可用，使用内存缓存降级` 消息通过 `console.log` 打印到 stdout，和 readline 输入框冲突，显示在提示符区域。

### 修复

**文件**: `packages/shared/src/services/cacheService.js`（+ 2 个 bundled 副本）

Redis 连接/降级消息改为仅在 `DEBUG` 模式下通过 `console.error`（stderr）输出。Redis 不可用是本地开发的预期场景，静默降级即可。

---

## 五、G1-G8 P0 对齐实现（本轮前完成）

本版本同时包含了三项目（DeepSeek-TUI / Hermes Agent / OpenCode）P0 对齐的 8 项改进：

| 编号 | 改进 | 文件 |
|------|------|------|
| G1 | LineBuffer 流式行缓冲 | `backend/src/cli/lineBuffer.js` (新) |
| G2 | AdaptiveChunker 自适应分块（Smooth/CatchUp/Severe 三模式） | `backend/src/cli/lineBuffer.js` |
| G4 | 主题系统 + 调色板颜色深度适配 | `backend/src/cli/palette.js` (新) + 6 个主题 JSON |
| G5 | 权限确认 diff 预览（红/绿对比） | `backend/src/cli/ui/permissionDialog.js` |
| G6 | 原子写入（tmp+fsync+rename） | `backend/src/services/sessionPersistence.js` |
| G7 | ErrorEnvelope 结构化错误 | `backend/src/services/errorClassifier.js` |
| G8 | OnboardingWizard 引导向导 | `backend/src/cli/onboarding.js` (新) |

---

## 六、变更文件总览

### 核心修改

| 文件 | 改动摘要 |
|------|---------|
| `backend/src/services/contextCompressor.js` | A1 角色守卫 + A4 增量摘要 + A5 反抖动 |
| `backend/src/services/contextRouter.js` | A3 硬地板 32K |
| `backend/src/services/khyUpgradeRuntime.js` | A2 去 1.2x + A3 上下文 131K |
| `backend/src/cli/ai.js` | A1-A5 集成 + B1 绝对超时 + B4 日志 |
| `backend/src/services/toolUseLoop.js` | B2 工具循环超时 180s |
| `backend/src/cli/repl.js` | B3 finally 保护 + G1/G2 集成 + B4 日志 |
| `backend/src/services/multiFreeService.js` | 图片注入修复（OpenAI + Anthropic） |
| `packages/shared/src/services/cacheService.js` | Redis 提示静默化 |

### 新增文件

| 文件 | 用途 |
|------|------|
| `backend/src/cli/lineBuffer.js` | G1+G2 流式行缓冲 + 自适应分块 |
| `backend/src/cli/palette.js` | G4 颜色深度检测 + 适配 |
| `backend/src/cli/themes/*.json` (6个) | G4 主题定义 |
| `backend/src/cli/onboarding.js` | G8 引导向导 |

---

## 七、验证方法

```bash
# 模块加载验证
node -e "require('./backend/src/services/contextCompressor')"
node -e "require('./backend/src/services/contextRouter')"
node -e "require('./backend/src/services/multiFreeService')"

# 单元测试
npx jest backend/tests/services/errorClassifier.test.js --no-coverage
npx jest backend/tests/services/cleanupService.test.js --no-coverage
npx jest backend/tests/cli/router.test.js --no-coverage

# 功能验证
# 1. 多轮对话 → 压缩触发 → 下一轮不 400
# 2. Windows 粘贴图片 → AI 正常返回分析结果
# 3. 恢复会话 → 不重复压缩 → 正常响应
# 4. 启动 → 无 Redis 提示污染输入框
```

---

## 八、参考来源

| 项目 | 借鉴内容 |
|------|---------|
| DeepSeek-TUI | 硬地板设计、500K cycle boundary、LineBuffer 流式管道 |
| Hermes Agent | 增量摘要、反抖动冷却、双层触发机制 |
| OpenCode | 实际 token 触发、overflow 自动重放、原子写入 |

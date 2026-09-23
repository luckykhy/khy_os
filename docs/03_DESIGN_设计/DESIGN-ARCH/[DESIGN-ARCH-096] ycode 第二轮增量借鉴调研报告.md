# [DESIGN-ARCH-096] ycode（星瑶）第二轮增量借鉴调研报告

> 状态：调研 / 提案（未实施）
> 日期：2026-09-14
> 范围：gitee.com/feng-chenhao/xingyao-y-code @ dev 分支（HEAD `b00ed5b`，2026-09-13）
> 血缘：本文接续 [DESIGN-ARCH-109] `Y-code 借鉴实施方案`（2026-08-08~10 第一轮）。第一轮已落地 5 项服务（sourceTextCompressor / toolResultCompressor / memoryKairos / promptAssemblyService / turnEventStandardizer 等），并将「session undo / checkpoint」「share/export」「ToolSpec 元数据」「git worktree」列为 Pending。本文针对 ycode 在 2026-09-08~09-13 的 6 天 74 提交增量更新，做第二轮对标。

---

## 1. 背景与方法

### 1.1 调研对象

星瑶（Y-code，下称 ycode）是一个国产终端 AI 编程助手：Python 核心（`core/`）+ TUI（prompt_toolkit）与 GUI（pywebview + Vue3/TS）双端共享同一套引擎，通过 `LiteLLM` 统一多协议模型调用，具备子代理编排、计划执行、长期记忆、MCP、可插拔技能与插件系统。它不是 khy-os（khy-os 是「AI 平台操作系统 + 内置 khyquant 交易终端」，多租户、Web 多端、30+ IDE 桥），而是**同类单用户编码智能体**——与 khy-os 的 TUI/REPL 侧（Claude Code 对齐层）最可比。

### 1.2 调研口径

「最近」= dev 分支 2026-09-08 ~ 09-13 的全部 74 个提交（本仓库克隆 `--depth 50` 后 74 提交全部落在该 6 天窗口内）。按提交主题聚类为 8 个功能面，逐一与 khy-os 现状对照（khy-os 侧由并行探索 agent 逐一核查，标注 HAS / PARTIAL / LACKS，并给出文件证据）。

### 1.3 与第一轮的差异

第一轮（[DESIGN-ARCH-083]）已借鉴 token/缓存/记忆类**被动优化**（前缀压缩、工具结果截断、KAIROS 记忆、稳定+动态提示词）。第二轮的 8 个主题里有 5 个是**主动能力缺口**（ycode 有、khy-os 缺），是本报告重点：

| # | 主题 | ycode 有 | khy-os 现状 | 判定 |
|---|------|---------|-------------|------|
| A | 按回合撤销 turn_undo | ✅ 8 模块严格状态机 + 内容寻址快照 + CAS 令牌 + 崩溃恢复 | ⚠️ 有 per-edit 快照 + 四级 rollback 门面，但缺「按回合多文件原子恢复 + 冲突零写入 + 语义纠正」 | PARTIAL |
| B | 星轨自动化任务 | ✅ daemon 调度引擎 + CAS 认领 + 无人值守权限 + 运行历史 + GUI | ✅ 双 cron 引擎 + taskScheduler（已借鉴），但缺「定时发起真实 agent 回合」与无人值守自动化权限语义 | PARTIAL |
| C | 上下文压缩提速 | ✅ 0.85 预压缩 + 0.95 关键水位 + 真实用量基线 + 熔断 1.2× 刻意的注释 | ✅ /compact 三档 + autoCompactTriggerTokens 推导式 | 部分重叠 |
| D | 内置技能指纹升级 | ✅ 内容指纹 + 释放名单 + 未改动自动升级 + 恢复内置版 | ❌ 内置技能仅按 `builtin:true` 扫描 + 24h 缓存，无版本/指纹/升级 | LACKS |
| E | CLI 对齐 GUI | ✅ 批次 /undo /changes /queue /paste-image /update /computer browser | ⚠️ /undo /paste 有，/changes /queue 无，深度能力 CLI 有 Web 无 | PARTIAL |
| F | 事件 seq 断点续传 | ✅ 单调 seq + 128 条环形缓冲 + 重连 last_seq 回放 + 白名单关键事件 | ⚠️ WS 有 50 条整段重放、移动端契约有 `sequence` 字段，但无断点续传（Last-Event-ID 游标） | PARTIAL |
| G | 流式等待实时冲刷 + 硬上限 | ✅ 空心跳哨兵实时冲刷 + REQUEST_WAIT_GIVE_UP_SECONDS=600 | ✅ gatewayIdleTimeoutPolicy idle60/hard180（更严，khy 量级已足够） | khy 更强 |
| H | 权限档位按会话绑定 | ✅ sessions.permission_mode，切换会话互不覆盖 | ⚠️ 有 7 模式 + 6 profile + safetyGate 频谱，但会话级权限档位未入 sessions 快照 | PARTIAL |

**总体结论**：ycode 这次更新的主线是「**把被动优化升级成主动能力**」——按回合撤销、无人值守自动化、技能随版升级、断线补发。khy-os 在流式稳健性、权限频谱、回滚门面、测试规模（2420 个 Jest 测试）、CLI 命令数（209 条）上**明显更强**；真正的借鉴缺口集中在 **A（按回合撤销的工程化深化）、D（技能指纹升级）、F（事件断点续传）**，以及 **B 的「定时 agent 回合」语义**。

---

## 2. 逐项对标（含证据与借鉴建议）

### A. 按回合撤销（turn_undo）——最值得深化借鉴

**ycode 设计（`core/turn_undo/` 8 模块，spec 第 9 节）**：
- `service.py` 进程级存储注册 + 启动校验：`validate_recorder_coverage(build_default_registry())` 强制「凡声明 `mutates_files` 的工具必须接入 `FileMutationRecorder`，否则启动即失败」（`_RECORDED_FIRST_PARTY_TOOLS` frozenset，含 `write_file`/`edit_file`/`fetch_image`）。**这是关键的红线——用启动校验保证撤销覆盖无死角。**
- `recorder.py` 记录契约：每个受控写工具走 **prepare → 写入 → verify** 三段，快照写失败则**放弃本次写入**（不写盘半截），封闭检查点后迟到写入在触盘前拒绝。
- `storage.py`：六表持久化 DAO，**内容寻址快照仓库**（快照 blob 按内容哈希去重），每会话检查点。
- `transaction.py`：**两段式预检 + 一次性 CAS 令牌**（consume 幂等一次消费）+ 逐文件原子恢复事务；**冲突零写入**——预检发现某文件已被后续变更污染即整轮不落盘。
- `recovery.py`：崩溃恢复，中断回合冻结为 `interrupted`，显式 `continue`/`cancel`，启动扫描收敛不重放；`prompt_context.py` 把「文件结果已失效」注入下一轮模型上下文（**语义纠正**：模型知道上一轮写盘结果已过期）。
- 撤销**不改写消息历史**——聊天完整保留，只回滚受控文件修改。

**khy-os 现状**：
- 有：`fileHistoryService.js`（per-edit 快照，`Modelled after Claude Code's fileHistory.ts`，每文件 100 快照 / 1MB 上限）、`rollbackService.js` 四级门面（PATCH<100ms→TURN<500ms→SESSION<2s→VERSION tar 全量）、workspace `checkpointService`（git-diff/stash/tar + CAS 对象存储，MAX 10 / 500MB）、`/rewind` `/undo` `/checkpoint` 命令 + TUI `rewindControl`。

**khy-os 缺什么**：
1. **按「回合」粒度的多文件原子恢复**——khy 的 TURN 级是 canonicalState 快照（<500ms、不就地恢复），ycode 是「逐文件原子恢复事务 + 冲突零写入」，冲突时**整轮不落盘**而非产生半截状态。
2. **启动校验撤销覆盖**（`validate_recorder_coverage`）——khy 写入工具虽已逐个接 `takeSnapshot`，但无「漏接即启动失败」的守门。
3. **语义纠正块**（`prompt_context.py`）——撤销后模型仍以为写盘成功，khy 未把「该结果已失效」注入下一轮上下文。
4. **崩溃一致性**（`recovery.py` 冻结 interrupted + 不重放）——khy 的回滚偏「主动触发」，ycode 强调崩溃/中断路径也安全。

**借鉴建议（优先级 HIGH）**：把 khy 的 `rollbackService` TURN 级增强为「**逐文件原子 + 冲突零写入 + 一次性 CAS 令牌**」，并在写入工具注册处加「漏接撤销记录器即启动校验失败」；撤销后向模型注入一条「上方文件结果已失效，请重新确认」的纠正上下文。ycode 的「不改写历史、只回滚受控文件」与 khy 的 fileHistory 哲学一致，可直接叠加。

---

### B. 星轨自动化任务——补「定时 agent 回合」语义

**ycode 设计（`core/automation/`，spec 第 4~8 节）**：
- `scheduling.py`：`parse_hhmm`/`validate_trigger`/`compute_next_run` **纯函数**（可注入时钟，测试 49 项含 16 线程并发 CAS 仅 1 成功）。
- `storage.py`：SQLite DAO，**`claim_due_tasks` 单条 CAS UPDATE 是防重复触发唯一闸门**（`WHERE next_run_at IS ?`）；单飞判定（同任务已有 queued/running 即写 `skipped` 不派发）；启动恢复遗留 `queued/running`→`interrupted` 绝不自动重跑；每任务保留 50 条运行历史；`CATCHUP_GRACE_SECONDS=60` 判定「错过」。
- `engine.py`：daemon 线程 `automation-engine`，**引擎只做读钟/SQLite/CAS 认领/入队判定，绝不发起 LLM 请求、绝不触碰 JS 桥**（发起回合交给既有 `send_user_message` 管线，`internal_kind="automation"`）。
- 无人值守权限：自动化 ASK **立即自动拒绝**（不弹卡、留 notice + 运行记录），`accept_edits`/`full` 需用户在任务表单显式选。
- **关键边界（非目标）**：不做 cron 表达式（v1 用 interval/daily/weekly/startup 四结构化触发器）、不写系统任务计划、不做文件/webhook 触发、**失败绝不自动重跑**、不改请求构造（自动化提示词只是普通 user 消息）。

**khy-os 现状**：
- 有：`cronScheduler.js`（Hermes 风格常驻，60s TICK）+ `jobs/cronScheduler.js`（CC 对齐，`.khy/scheduled_tasks.json`，MAX 50，一次性自动删/周期 7 天过期 + ScheduleCronTool 三件套）+ `taskScheduler.js`（**头注释明言 Inspired by Y-code's TaskScheduler**，依赖图并行调度）+ taskBoard SQLite 状态机。
- 缺：**「到点向指定会话发起一次真实 agent 回合并留运行历史」**——khy 的 cron 是 noAgent 投递/上下文链，不是「把提示词投进会话跑一整轮 agent 回合 + 终态回写 + 无人值守权限语义 + 运行历史展开」。

**借鉴建议（优先级 MEDIUM）**：khy 已有调度骨架，缺的是**「自动化回合」语义层**：① 触发器从 cron 扩到 `daily/weekly/startup` 结构化四类；② 触发=向目标会话发一条 user 消息进既有回合管线（复用排队/取消/权限/turn_undo，不开特例通道）；③ 每任务 50 条运行历史 + 终态 `completed/cancelled/error/skipped/interrupted` 枚举；④ 无人值守 ASK 立即自动拒绝 + 留痕；⑤ **失败绝不自动重跑**（这是 khy 与 ycode 应共同坚持的铁律）。CAS 认领 + 单飞 + 启动恢复 interrupted 直接照搬。

---

### C. 上下文压缩提速——khy 已有，学「预压缩 + 真实用量基线 + 刻意熔断注释」

**ycode 设计（`core/agent_service.py` + `core/memory_compressor.py`，2026-09-13 提速）**：
- 四级水位：0.60 snip / 0.80 elide / **0.85 预压缩**（`DEFAULT_PRECOMPRESS_RATIO`，`memory_compression.precompress_ratio` 可配、0 关闭）/ **0.95 关键水位**（`SUMMARIZE_RATIO`）。
- **预压缩**：占用达 0.85 时在后台守护线程 `memory-precompress-{session}` 提前触发**与 0.95 完全同一入口** `compress_session_memory`，配 120s 防抖冷却 + 防重入守卫 + cancel_event 透传——**压缩不再阻塞回合关键路径**（0.95 到来时摘要通常已落库）。
- **真实用量基线**：`get_session_token_baseline` 优先采信上一轮**真实 API 用量**，本地估算只做兜底；DeepSeek 账本路由同模型时采信真实用量，修正「压缩后工作副本估算骤减→水位低估→压缩延迟」。
- **熔断刻意性**：`# 注：熔断阈值保持 1.2*window 是有意的——轻微超窗（0.95~1.2）时留着 2 轮微调换可用性，比整轮拒绝服务更划算，别顺手收紧成 0.95。`（这条注释本身就是可借鉴的工程文化）
- 段间延时自适应：默认 1.5s→0，仅 429 触发后插 2s 冷却；账本主动轮换代（mark/consume 幂等一次消费）把「被动爆窗三段等待」升级为「计划内维护」。

**khy-os 现状**：`contextRouter.js` 的 `autoCompactTriggerTokens = floor(budget × 0.75 / SAFETY_MARGIN)` 推导式（UI 倒计时与真实触发不漂移）+ `/compact` 三档 + `domain/memory/compact` 压缩主体。khy 的阈值**推导式**比 ycode 的固定 0.75/0.85/0.95 更自适应，这块 khy 更强。

**借鉴建议（优先级 MEDIUM，选择性）**：
1. **预压缩**（0.85 后台提前触发、与关键水位同一入口 + 防抖）——khy 目前压缩是「到达阈值才做」，引入 0.85 预触发可把压缩移出关键路径（khy 的 AGENTS.md 规则 3「基于活动的超时，不许硬 kill」与 ycode 的「压缩后台化」精神一致）。
2. **真实用量基线优先**——khy `tokenUsageService` 已有真实用量账本，压缩水位判定时可优先采信它而非本地 tiktoken 估算。
3. **「刻意性注释」文化**——把「这个阈值为什么是 1.2× 不是 0.95×」写进代码，防止后人误优化。

---

### D. 内置技能指纹升级——最明确的 LACKS

**ycode 设计（`core/skills.py`，2026-09-13）**：
- `_skill_dir_fingerprint(skill_dir)` 对技能目录内容算指纹；`~/.ycode/builtin_skills_released.json` 索引记录「释放名单 + 各自指纹」。
- **跟随升级**：已释放且内容未被用户改动的内置技能，随新版本自动升级（复用「临时目录 + 原子替换」覆盖，避免半成品目录）；用户改动过的一律保留、主动删除的不复活（通过释放名单判定）。
- `restore_builtin_skill(name)`：仅对「曾由内置释放且内置源仍存在」的技能开放，显式恢复内置版并刷新指纹。
- 内置 7 个内容生产技能（6 baoyu + gzh-design）随安装包发布、首次启动释放、默认启用。

**khy-os 现状（LACKS）**：
- `skillLoader.js` 发现优先级 项目>用户>内置，内置（`src/skills/built-in/` ~40 个）只按 frontmatter `builtin:true` 扫描 + 进程内缓存；`skillRegistry.js` 硬编码 BUILTIN_SKILLS + 24h 缓存，**无版本号 / 指纹 / 升级 / 恢复内置版机制**。
- `skillInstallService.js` 是「外部 git 浅克隆导入」，与「内置随版升级」是两码事。

**借鉴建议（优先级 HIGH，最干净的缺口）**：
1. 给内置技能加**内容指纹索引**（落在 `.khy/skills/builtin_released.json`，与 ycode 同构）。
2. 启动时比对：未改动 → 随 khy-os 升级原子替换；改动过 → 保留并标记 `user_modified`；删除 → 不复活。
3. 提供 `khy skill restore <name>` CLI（复用现有 handler 模式 + aliases，符合 AGENTS.md「新增 CLI 命令 3 步」规约）。
4. 用「临时目录 + 原子 rename」保证升级不留半成品目录。

> 落地注意：khy-os 的内置技能是 **Node 模块随 pip wheel / npm 包分发**（ycode 是 Python 随仓库），指纹基准应是「随版安装的内置技能目录」，升级触发点应是 `khy` 启动时的版本自检，而非安装器。

---

### E. CLI 对齐 GUI——补 /changes、/queue，固化「批次 + 偏差记录」文化

**ycode 设计（2026-09-12 三批次）**：
- 批次 A：`/clear-history` `/persona` `/shell` `/open` `/skills refresh`
- 批次 B：`/computer browser`（CLI 唯一可改的永久设置项，活动 run 内拒绝切换）`/queue list|cancel|clear`（排队消息管理，UI 线程内 drain/回填无并发窗口）`/paste-image [说明]`（剪贴板图片，复用既有视觉管线零改动）
- 批次 C：`/update check|download|cancel|install`（8s 网络超时移后台线程不冻 UI，安装双门禁 + y 确认）`/changes [N]`（跨回合文件变更历史回看，只读消费 turn_undo 检查点聚合，与每轮自动摘要互补）
- **文化**：每批配 parity 测试 + 「实施计划第 N 节审查修复记录」+ 「偏差记录扩至 7 条」——**偏差被显式记录而非静默偏离**。

**khy-os 现状**：
- 有：`/undo` `/rewind` `/paste`（剪贴板图片，`windowsClipboardImg2FileService`）；`/tasks` `/cron` 近似 `/queue`。
- 缺：`/changes`（跨回合文件变更历史回看，khy 只在 `/cost` 里统计改动行、无逐回合 diff 回看）；独立 `/queue`（排队消息管理）。

**借鉴建议（优先级 LOW~MEDIUM）**：
1. `/changes [N]` 对 khy 价值最高（khy 已有 turn_undo 检查点数据，只差一个只读回看命令）——按 AGENTS.md 3 步（alias + handler + router）落地。
2. 「**批次 + 偏差记录**」的交付文化：khy 的 209 条斜杠命令规模远超 ycode，但 ycode 把「每批 parity 测试 + 偏差显式记录」做成了可审计流程，值得 khy 在批量加命令时借鉴。

---

### F. 事件 seq 断点续传——移动端/LAN 补发

**ycode 设计（`core/lan_server.py`，2026-09-13）**：
- 白名单低频关键事件（`REPLAYABLE_EVENT_TYPES`，如报错/权限请求）打**单调递增 `seq`**，入 128 条**环形缓冲** `_replay_buffer`。
- 重连：首条消息带 `last_seq`（新页面=None 不补发，断线重连=记录的水位），服务器**按 `last_seq` 从环形缓冲回放缺失关键事件**（`_register_and_collect_replay`），锁屏/切后台不再丢报错与权限请求。
- 客户端 shim 先记水位再派发（避免处理器抛错丢水位）。

**khy-os 现状（PARTIAL）**：
- `bridgeServer.js` WS 桥有 `HISTORY_MAX=50` 环形缓冲，但 auth_ok 后是**「最近 50 条」整段重放**，非断点续传；移动端契约 `mobile-stream-event.schema.json` 已声明必填 `sequence`（≥1 单调），**但服务端无按 last_sequence 的游标续传**（rg 搜 Last-Event-ID 无果）。

**借鉴建议（优先级 MEDIUM）**：khy 移动端契约已有 `sequence` 字段，落地成本低——把 bridgeServer 的重放从「最近 50 条整段」升级为「**客户端上报 last_sequence，服务端按序回放白名单关键事件**」，与 ycode 同构；中高频 chunk 事件仍不入环（khy 现状已做，保持）。

---

### G. 流式等待实时冲刷 + 硬上限——khy 已更强（记录为「无需借鉴」）

**ycode**：等待提示实时冲刷（status 事件不再积压到首正文 chunk，每条提示后 yield 空心跳、流中段 stall 以 `None` 哨兵转空心跳）+ `REQUEST_WAIT_GIVE_UP_SECONDS=600`（首字节/流中段连续空闲满 10 分钟抛 `RequestWaitGiveUpError`，重试处理器直接 re-raise 绝不进重试循环；等待提示节奏 120s 起每 30s 一条）+ 严格网关 tool call 自愈（流式组装规整 name/arguments，历史加载剔除不可回放调用，DB 原文不动）。

**khy-os**：`gatewayIdleTimeoutPolicy`（门开后 idle 60s / hard 180s，CC 量级，比 ycode 的 600s 更严）+ `gatewayIdleProgressPolicy`（只认真实内容进展不被自产心跳欺骗）+ `aiGatewayGenerateMethod` 重试预算 + `toolCallParser` 7 格式截断恢复（`_repaired:true`）+ `transcriptRepair` 配对修复。**khy 这块明显更强、更完整**，ycode 的 600s 硬上限是「宽松兜底」，无需借鉴。仅可借鉴 ycode「等待提示节奏 120s 起每 30s 一条」的具体文案节奏（对照 AGENTS.md 规则 2「动作+目标+进度」）。

---

### H. 权限档位按会话绑定——小缺口

**ycode（2026-09-13）**：`sessions.permission_mode` 按会话绑定，切换会话互不覆盖，未绑定回退全局默认；pending 草稿会话首条消息携带的档位在落库后补绑定；无人值守 plan 档升级到确认的请求仍按无人值守语义自动拒绝。

**khy-os（PARTIAL）**：7 模式（default/plan/acceptEdits/auto/dontAsk/bypass/RedPass）+ 6 profile（`permissions.json`，scope once/session/forever）+ safetyGate 频谱（off/on/ask/strict）+ unattendedAutoAnswer，**机制比 ycode 更全**；但**会话级权限档位未入 sessions 快照**（`sessionPersistence` 存 model 不存 permission）。

**借鉴建议（优先级 LOW）**：把当前激活的 permission profile 随会话写入 `sessionPersistence` 快照，切会话时恢复，对齐 ycode 的「切换会话不互相覆盖」语义（khy 目前是全局单例，切会话可能串档）。

---

## 3. ycode 的工程文化（可迁移的「软」经验）

比单项功能更值得学的，是 ycode 这次的**协作与文档文化**：

1. **「设计规格四件套」入库**（`待开发/*/`）：每个特性 = `01-完整设计规格.md` + `02-Agent开发提示词.md` + `03-验收清单.md` + `实施进度.md`。规格文档首行即声明「`file:line` 仅供定位参考，实施以符号名为准、行号漂移不算偏离」，并明确「**非目标（防范围蔓延）**」与「**核心产品原则**（复用回合管线 / 无人值守权限 / 显式失败 / 取消不复活 / 线程纪律）」。khy-os 的 AGENTS.md 有治理总纲但缺「**每特性四件套 + 非目标清单**」的落地模板，可引入。
2. **「铁律」注释文化**：把「为什么这样定」写进代码（如「熔断阈值刻意保持 1.2× 别顺手收紧成 0.95」「messages 表是唯一事实源、Journal 严禁写正文」「取消语义铁律：cancelled 绝不注入接手指令」）。对照 khy-os AGENTS.md 规则 2「状态透明」，这类注释是同一精神，值得固化成惯例。
3. **偏差显式记录**：CLI 对齐每批附「偏差记录扩至 7 条」，审查修复逐条 P1/P2 关闭——**静默偏离视为实现错误**。
4. **测试全绿门槛 + 并发用例**：全量 pytest 3226 通过 0 失败作为「推送前」门槛；`16 线程并发 CAS 认领仅 1 成功`这类并发正确性用例是 khy 应补的（khy 有 2420 Jest 测试，规模更大，但 CAS/并发认领类用例可对照补）。
5. **安全边界克制**：GUI Markdown 渲染 XSS→RCE 已修（`<img onerror=…>` 任意命令链）、右侧终端标签页因绕过权限系统被**移除**而非打补丁、自动化「失败绝不自动重跑」。

---

## 4. khy-os 反向优势（ycode 缺、无需动作）

记录在案，避免后续误以为要「补齐」：
- **多租户 + PostgreSQL** 平台（ycode 单用户 SQLite）
- **30+ IDE 桥 + 视觉工作流编辑器 + 插件市场**（ycode 无）
- **流式稳健性**（idle60/hard180 + 进展判定 + 7 格式截断恢复，强于 ycode 600s 兜底）
- **权限频谱**（off/on/ask/strict + 7 模式 6 profile，比 ycode 四档更细）
- **四级回滚 SLA + 双 cron 引擎**（ycode 单套 turn_undo + 单套 star-track）
- **2420 Jest 测试 + 209 斜杠命令 + CC 命令桥**（规模远超 ycode）
- **token 双币账本（CNY 为主 + 分模型成本）**（ycode 仅记账）

---

## 5. 行动项（按优先级，供后续立项）

| 优先级 | 行动 | 依据 | 预计落点 |
|--------|------|------|---------|
| **HIGH** | 内置技能内容指纹 + 随版升级 + `khy skill restore` | D | `skillRegistry.js` + 新 `skillVersionSync.js` + 3 步 CLI |
| **HIGH** | turn_undo 深化：逐文件原子 + 冲突零写入 + 启动校验覆盖 + 语义纠正块 | A | `rollbackService.js` TURN 级 + `domain/workspace/checkpointService` |
| **MEDIUM** | 自动化「定时 agent 回合」语义 + 无人值守 ASK 自动拒绝 + 50 条运行历史 | B | `cronScheduler` 扩触发器 + 新 `automation/` 语义层 |
| **MEDIUM** | 事件断点续传（按 last_sequence 回放白名单关键事件） | F | `bridgeServer.js` + `mobile-stream-event` 契约 |
| **MEDIUM** | 预压缩 0.85 后台化 + 真实用量基线优先 + 刻意性注释 | C | `contextRouter.js` + `tokenUsageService` |
| **LOW** | 会话级权限档位入 sessions 快照 | H | `sessionPersistence.js` |
| **LOW** | `/changes` 跨回合文件变更回看 + 批次交付偏差记录文化 | E | 新 CLI handler + 流程规范 |
| **记录** | G（流式）/反向优势无需动作 | §4 | — |

---

## 6. 局限与说明

- 本报告基于 dev 分支 2026-09-13 HEAD，ycode 迭代极快（6 天 74 提交），行动项实施前应重新核对对应 `file:line`。
- ycode 是 Python+pywebview，khy-os 是 Node.js 后端 + Vue；借鉴的是**设计模式与工程文化**，非直接移植代码。
- 本报告为「调研 + 提案」，**未实施任何代码改动**；落地前需按 AGENTS.md 工程规则（零硬编码 / 状态透明 / 活动超时 / 滚动区）过一遍。
- 血缘文档：[DESIGN-ARCH-083]（第一轮）。编号：DESIGN-ARCH 当前最高 095（092 断档、083 历史重号），本文取 **096**。

---

*调研工具：本地克隆 `D:\Portable\tmp-xingyao-y-code`（已清理）；khy-os 现状经并行探索 agent 逐区核查（file 证据见 §2 各节）。*

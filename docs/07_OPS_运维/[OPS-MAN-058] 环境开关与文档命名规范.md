# [OPS-MAN-058] 环境开关与文档命名规范

> **参考手册** · 收容两类「全局约定」：① 全部环境开关（`KHY_*` / `KHYOS_*` / `KHYQUANT_*`）的速查目录；② 各类文档的命名规范。
>
> 面向**单人维护者**与接手者：先看第一节（维护者最常用的几个安全/运维开关），需要查冷门开关再翻第二节（全量分类目录），写文档/建新文档时看第三节（命名规范）。
>
> **一句话定位**：本文是「开关与命名」的**索引层**，不是真源。开关的真实默认值与语义**永远以代码读取点为准**（每个家族都标了 canonical 源文件，按名 `grep` 即可定位）；命名规范的强制规则真源是 `[MGMT-STD-001]`。

---

## 一、维护者最常用的运维/安全开关（必懂）

下面这些开关直接影响「更新 / 回滚 / 发布 / 备份」这条命脉，是单人维护者**真正会用到**的少数几个。其余几百个开关都有合理默认、平时不用碰（见第二节）。

> **总原则**：所有 `KHY_*` 功能门控**默认开**，关闭即**逐字节回退**到该功能接入前的历史行为——任何时候都能安全关掉某个新行为，不会把仓库改坏。

### 1.1 备份 / 回滚 / 发布闭环（运维安全）

| 开关 | 默认 | 取值 | 作用 | 怎么关 / 改 |
| --- | --- | --- | --- | --- |
| `KHY_AUTO_BACKUP` | 开 | `0`=关 | 跑 `update` 任务或 `rollback` 前**自动备份一次**（并打印可复制恢复命令） | `KHY_AUTO_BACKUP=0` 关掉这层自动保护 |
| `KHY_BACKUP_KEEP` | `1` | 正整数 / `0`·`all`·`off`·`no` | 备份保留份数：默认**只留最新 1 个**，避免 `~/.khyos/backups/` 无限膨胀 | `=3` 留最新 3 个；`=0` 关闭自动清理、全部保留（旧行为）。只清理 `khy-backup-*` 目录，你自己放的别的东西绝不删 |
| `KHY_AUTO_BLESS` | 开 | `0`=关 | `post-verify` **验证全绿时自动 bless**（登记为最近稳定版），闭环「发布即登记」 | `=0` 保留手动登记：全绿时改为打印一句手动 `bless` 提示。**红项绝不登记** |
| `KHY_ROLLBACK_CONFIRM` | 关（需交互 `y`） | `1`=自动确认 | 回滚的确认闸门。默认必须人工输入 `y` 才切换 | 脚本/无人值守用 `KHY_ROLLBACK_CONFIRM=1` 跳过交互。**没确认绝不动代码**（有测试守着） |

> 真源：`maintenance/lib/ops.js`（备份/bless/回滚）、`maintenance/lib/ops-lib.js`（纯叶子决策）。
> 完整操作步骤见 `docs/传承/KHY-OS-传承书.md` 操作六/七 与「发布与回滚的固定链路」。

### 1.2 稳定版登记记录的位置（一般不用改，仅测试/迁移时用）

| 开关 | 默认 | 作用 |
| --- | --- | --- |
| `KHY_STABLE_RELEASE_FILE` | `maintenance/stable-release.json` | 稳定版登记**主记录**文件路径（`bless` 写、`rollback` 读） |
| `KHY_STABLE_RELEASE_SHADOW_FILE` | `maintenance/stable-release.backup.json` | 稳定版登记**影子冗余副本**；主记录损坏时 `rollback` 自动退到它 |
| `KHY_STABLE_PREFIX` | `v` | 版本标签前缀 |

> 真源：`maintenance/lib/ops.js`。这三个开关让测试可以把读写重定向到临时文件，**绝不污染**仓库里被追踪的 `stable-release.json`。

### 1.3 数据家目录（决定配置/用量/模型文件落在哪）

| 开关 | 默认 | 作用 |
| --- | --- | --- |
| `KHYOS_HOME` | `~/.khyos` | 底座（khyos）归属：`{data,cache,models,logs}` 与 `backups/` 的根 |
| `KHY_DATA_HOME` | `~/.khy`（现状数据家） | 应用（khyquant）数据家：配置 / 用量等 |

> 真源**单一**：`services/backend/src/utils/dataHome.js`（`getBaseHome()` / `getDataHome()`）。**所有服务都应经此解析器**取家目录，绝不硬编码 `os.homedir()`。换机器/做隔离测试时用这两个 env seam 指到临时目录即可。

### 1.4 工具链基线（不是开关，但维护者必知「基线只此一处」）

工具链基线漂移检查（`node maintenance/lib/ops.js toolchain`）**不读任何环境开关**，基线只有一个真源：

- **Node** 基线 ← `services/backend/package.json` 的 `engines.node`
- **Python** 基线 ← `pyproject.toml` 的 `requires-python`

> 文档与建议文案**绝不写死版本号**（经 `baselinePhrase(spec)` 从基线插值）。改基线只改上述两处，检查与建议自动跟随。

---

## 二、全量环境开关分类目录（按域分组速查）

> 下面把仓库内**全部** `process.env.KHY*` 读取点按域分组。每个家族给：① 一句用途；② canonical 源文件（按名 `grep` 可精确定位读取点）；③ 该家族的默认约定；④ 成员开关名清单。
>
> **冷门开关的精确语义请以源文件为准**——本目录是索引，不是真源。数值/超时类（`*_MS` / `*_MAX_*` / `*_TIMEOUT_*`）一律有内置默认，按需覆盖即可。

### 数据目录 / HOME / 安装布局（KHYOS_* / KHYQUANT_* / *_HOME）
Khy-OS / khyquant 的数据根、缓存、临时目录、镜像源与运行时根等安装布局。
- 真源：`services/backend/src/utils/dataHome.js`（家目录）、`services/backend/src/utils/pathCompat.js`、`services/backend/src/services/khyUpgradeRuntime.js`。
- 默认：路径/模式类无默认（不设回退内置默认 HOME `~/.khyos` / `~/.khy`）；`*_OFFLINE` 等开关默认关。
- 成员：`KHY_APP_HOME`, `KHY_DATA_HOME`, `KHY_ENV_FILE`, `KHY_ENV_SYMBIOSIS`, `KHY_ENV_SYNC_ROOT`, `KHY_KHYOS_CACHE_DIR`, `KHY_KHYOS_MANIFEST`, `KHY_KHYOS_MIRROR_BASE`, `KHY_KHYOS_OFFLINE`, `KHY_KHYOS_TOOL_BOOT_MS`, `KHY_KHYOS_TOOL_IDLE_MS`, `KHY_MEMORY_DIR`, `KHY_MODELS_DIR`, `KHY_OS_DATA`, `KHYOS_HOME`, `KHY_OS_LOG`, `KHY_OS_MODE`, `KHY_OS_PROFILE`, `KHYOS_REPORT_FD`, `KHY_OS_ROOT`, `KHY_OS_SANDBOX`, `KHY_OS_TEMP_DIR`, `KHY_OS_TEMP_MAX_AGE_HOURS`, `KHY_PLUGIN_HOME`, `KHY_PROJECT_DATA_HOME`, `KHYQUANT_AI_MODE`, `KHYQUANT_APP_ONLY`, `KHYQUANT_ASSISTANT_MODE`, `KHYQUANT_CWD`, `KHYQUANT_DANGEROUS`, `KHYQUANT_INVOKED_AS`, `KHYQUANT_PKG_VERSION`, `KHYQUANT_ROOT`, `KHYQUANT_WINDOWS_DATA_DRIVE`, `KHY_RUNTIME_ROOT`

### CC 对齐显示/解析门控
与 Claude Code 对齐的显示/输入解析单一真源门控，共享「默认开 + 关闭即逐字节回退」模式。
- 真源：`services/backend/src/cli/ccFormat.js`（及各自叶子 `cli/diffGutter.js`、`cli/editStatLine.js`、`cli/fullWidthInput.js`、`cli/cjkInputNormalize.js`、`cli/ccRelativePath.js`、`tools/semanticNumberCoerce.js`）。
- 默认：**全部默认开**，设 `0`/`false` 关；关闭后逐字节回退旧实现。
- 成员：`KHY_CC_FORMAT`, `KHY_CC_VALIDATION_ERROR`, `KHY_CJK_INPUT_NORMALIZE`, `KHY_DIFF_GUTTER_WIDTH`, `KHY_DIFF_LINE_NUMBERS`, `KHY_DISPLAY_PATH_CC`, `KHY_EDIT_DIFF_STAT_CC`, `KHY_EDIT_STAT_LINE`, `KHY_FULLWIDTH_INPUT`, `KHY_OL_MARKER_ALIGN`, `KHY_SEMANTIC_NUMBER`, `KHY_TABLE_CELL_WRAP`, `KHY_TOOL_PATH_MIDDLE_TRUNCATE`, `KHY_TOOL_RELATIVE_PATH`, `KHY_WRITE_COUNT_LINES_CC`

### KHY_MULTIMODAL_*
多模态输入处理：OCR、PDF 抽取、转写（whisper/cpp）、文档/压缩包片段预算与超时。
- 真源：`services/backend/src/services/multimodalInputService.js`、`services/backend/src/services/mediaTranscriptionService.js`。
- 默认：混合——OCR/转写能力开关默认开（设 `0` 关）；`*_MAX_*` / `*_TIMEOUT_MS` / `*_BUDGET_MS` 带内置默认按需覆盖。
- 成员：`KHY_MULTIMODAL_ADAPTER_CAPS`, `KHY_MULTIMODAL_ARCHIVE_MAX_FILES`, `KHY_MULTIMODAL_ARCHIVE_PREPARE_TIMEOUT_MS`, `KHY_MULTIMODAL_ARCHIVE_TOTAL_BUDGET_MS`, `KHY_MULTIMODAL_BIN_CACHE_TTL_MS`, `KHY_MULTIMODAL_DOC_SNIPPET_MAX_FILES`, `KHY_MULTIMODAL_DOC_SNIPPET_PREPARE_TIMEOUT_MS`, `KHY_MULTIMODAL_DOC_SNIPPET_TOTAL_BUDGET_MS`, `KHY_MULTIMODAL_IMAGE_OCR`, `KHY_MULTIMODAL_IMAGE_OCR_MAX_BYTES`, `KHY_MULTIMODAL_IMAGE_OCR_MAX_CHARS`, `KHY_MULTIMODAL_IMAGE_OCR_MAX_FILES`, `KHY_MULTIMODAL_IMAGE_OCR_PREPARE_TIMEOUT_MS`, `KHY_MULTIMODAL_IMAGE_OCR_TIMEOUT_MS`, `KHY_MULTIMODAL_IMAGE_OCR_TOTAL_BUDGET_MS`, `KHY_MULTIMODAL_INTENT_ROUTER`, `KHY_MULTIMODAL_OCR_CACHE_ENABLED`, `KHY_MULTIMODAL_OCR_CACHE_HASH_MAX_BYTES`, `KHY_MULTIMODAL_OCR_CACHE_MAX_ENTRIES`, `KHY_MULTIMODAL_OCR_CACHE_TTL_MS`, `KHY_MULTIMODAL_OCR_LANG`, `KHY_MULTIMODAL_PDF_EXTRACT_ENGINES`, `KHY_MULTIMODAL_PDF_KEYPOINT_MIN_LINE_CHARS`, `KHY_MULTIMODAL_PDF_KEYPOINT_MODE`, `KHY_MULTIMODAL_PDF_KEYPOINTS_PER_PAGE`, `KHY_MULTIMODAL_PDF_LARGE_FILE_MB`, `KHY_MULTIMODAL_PDF_LARGE_MAX_PAGES`, `KHY_MULTIMODAL_PDF_OCR_FALLBACK`, `KHY_MULTIMODAL_PDF_OCR_MAX_PAGES`, `KHY_MULTIMODAL_PDF_OCR_MIN_TEXT_CHARS`, `KHY_MULTIMODAL_PDF_OCR_TOTAL_BUDGET_MS`, `KHY_MULTIMODAL_PDF_PAGE_LABEL_ENABLED`, `KHY_MULTIMODAL_PDF_SNIPPET_MAX_BYTES`, `KHY_MULTIMODAL_PDF_SNIPPET_MAX_CHARS`, `KHY_MULTIMODAL_PDF_SNIPPET_MAX_PAGES`, `KHY_MULTIMODAL_PDF_SNIPPET_PER_PAGE_MAX_CHARS`, `KHY_MULTIMODAL_PDF_SNIPPET_TIMEOUT_MS`, `KHY_MULTIMODAL_PDF_SNIPPET_TOTAL_BUDGET_MS`, `KHY_MULTIMODAL_PREFERRED_ADAPTERS`, `KHY_MULTIMODAL_SNIPPET_MAX_BYTES`, `KHY_MULTIMODAL_SNIPPET_MAX_CHARS`, `KHY_MULTIMODAL_TRANSCRIBE`, `KHY_MULTIMODAL_TRANSCRIBE_CPP_MODEL`, `KHY_MULTIMODAL_TRANSCRIBE_CPP_MODEL_DIR`, `KHY_MULTIMODAL_TRANSCRIBE_CPP_MODEL_PATH`, `KHY_MULTIMODAL_TRANSCRIBE_LANGUAGE`, `KHY_MULTIMODAL_TRANSCRIBE_MAX_BYTES`, `KHY_MULTIMODAL_TRANSCRIBE_MAX_CHARS`, `KHY_MULTIMODAL_TRANSCRIBE_MAX_FILES`, `KHY_MULTIMODAL_TRANSCRIBE_PREPARE_TIMEOUT_MS`, `KHY_MULTIMODAL_TRANSCRIBE_READ_MAX_BYTES`, `KHY_MULTIMODAL_TRANSCRIBE_TIMEOUT_MS`, `KHY_MULTIMODAL_TRANSCRIBE_TOTAL_BUDGET_MS`, `KHY_MULTIMODAL_TRANSCRIBE_WHISPER_MODEL`

### KHY_IMAGE_* / KHY_VISION_* / KHY_VIDEO_*（图像/视觉/视频）
图像/视频生成后端与凭证，以及视觉能力适配器路由。
- 真源：`services/backend/src/services/aiManagementServer.js`（生成后端）、`services/backend/src/cli/ai.js`（视觉路由）。
- 默认：混合——`*_API_KEY` / `*_BASE_URL` 无默认需显式设置；路由开关（`KHY_VISION_SMART_ROUTE` 等）默认开/关视项。
- 成员：`KHY_IMAGE_GEN_AGNES_API_KEY`, `KHY_IMAGE_GEN_AGNES_BASE_URL`, `KHY_IMAGE_GEN_AGNES_REQUEST_STYLE`, `KHY_IMAGE_GEN_BACKEND`, `KHY_IMAGE_GEN_DOMESTIC_API_KEY`, `KHY_IMAGE_GEN_DOMESTIC_BASE_URL`, `KHY_IMAGE_GEN_DOMESTIC_RESPONSE_PATH`, `KHY_IMAGE_GEN_OPENAI_API_KEY`, `KHY_IMAGE_GEN_OPENAI_BASE_URL`, `KHY_IMAGE_GEN_OPENAI_MODEL`, `KHY_IMAGE_GEN_SD_BASE_URL`, `KHY_IMAGE_OCR_NO_CASCADE`, `KHY_IMAGE_SMALL_TASK_TIMEOUT_MS`, `KHY_NON_VISION_ADAPTERS`, `KHY_VIDEO_GEN_AGNES_API_KEY`, `KHY_VIDEO_GEN_AGNES_POLL_STYLE`, `KHY_VIDEO_GEN_POLL_INTERVAL_MS`, `KHY_VISION_CAPABLE_ADAPTERS`, `KHY_VISION_FORCE_ROUTE`, `KHY_VISION_PREFERRED_ADAPTER`, `KHY_VISION_PREFERRED_ADAPTERS`, `KHY_VISION_SMART_ROUTE`, `KHY_VISION_TOOL_WEAK_ADAPTERS`

### KHY_LOCAL_*（本地模型/本地推理）
本地 LLM（gguf / llama.cpp / python server）冷热加载超时、token 上限、本地工具与本地 Web 求解。
- 真源：`services/backend/src/services/gateway/aiGateway.js`（本地适配器接入）+ 本地 runner 服务。
- 默认：数值/超时为主均有默认；能力开关（`KHY_LOCAL_TOOLS`/`KHY_LOCAL_WRITE` 等）默认关按需开。
- 成员：`KHY_LOCAL_ADAPTERS`, `KHY_LOCAL_ALLOW_SHORT_HARD_TIMEOUT`, `KHY_LOCAL_ALLOW_SHORT_IDLE`, `KHY_LOCAL_COLD_HARD_TIMEOUT_MS`, `KHY_LOCAL_COLD_IDLE_TIMEOUT_MS`, `KHY_LOCAL_COLD_MAX_TOKENS`, `KHY_LOCAL_DEGRADED_HARD_TIMEOUT_MS`, `KHY_LOCAL_DEGRADED_IDLE_TIMEOUT_MS`, `KHY_LOCAL_DISABLE_TOKEN_CAP`, `KHY_LOCALE`, `KHY_LOCAL_HOT_ATTACH_TIMEOUT_MS`, `KHY_LOCAL_LLM_VERBOSE`, `KHY_LOCAL_LOOPBACK_PROBE_TIMEOUT_MS`, `KHY_LOCAL_LOOPBACK_PROBE_TTL_MS`, `KHY_LOCAL_MIN_GGUF_BLOB_SIZE`, `KHY_LOCAL_MIN_HARD_TIMEOUT_MS`, `KHY_LOCAL_MIN_IDLE_TIMEOUT_MS`, `KHY_LOCAL_MODEL_SCAN_CACHE_MS`, `KHY_LOCAL_MODEL_SCAN_MAX_DEPTH`, `KHY_LOCAL_PY_SERVER_START_POLL_MS`, `KHY_LOCAL_PY_SERVER_START_TIMEOUT_MS`, `KHY_LOCAL_REASON`, `KHY_LOCAL_RUNNER_HEALTH_TIMEOUT_MS`, `KHY_LOCAL_RUNNER_LOAD_TIMEOUT_MS`, `KHY_LOCAL_RUNNER_START_TIMEOUT_MS`, `KHY_LOCAL_SEARCH_STYLE`, `KHY_LOCAL_SHOW_SOURCES`, `KHY_LOCAL_STRUCTURED`, `KHY_LOCAL_TEMPLATES`, `KHY_LOCAL_TOOLS`, `KHY_LOCAL_WARM_MAX_TOKENS`, `KHY_LOCAL_WARMUP_ONCE`, `KHY_LOCAL_WEB_SOLVER`, `KHY_LOCAL_WEB_SOLVER_MIN_RESULTS`, `KHY_LOCAL_WRITE`, `KHY_LOCAL_WRITE_TOOLS`

### KHY_GATEWAY_*
AI 网关：缓存、限流、重试恢复、采样探测、超时与启动预热。
- 真源：`services/backend/src/services/gateway/aiGateway.js`（CLI 入口 `cli/handlers/gateway.js`）。
- 默认：数值/超时/重试有默认；`KHY_GATEWAY_CACHE`/`KHY_GATEWAY_WARMUP_ON_BOOT` 等开关默认开，关设 `0`。
- 成员：`KHY_GATEWAY_ALLOW_IMPORTED_CREDENTIALS`, `KHY_GATEWAY_BILLING_BODY_LIMIT`, `KHY_GATEWAY_CACHE`, `KHY_GATEWAY_CACHE_TTL`, `KHY_GATEWAY_DEBUG_PROMPT`, `KHY_GATEWAY_DEBUG_PROMPT_FILE`, `KHY_GATEWAY_DYNAMIC_RISK`, `KHY_GATEWAY_FAST_RATE_LIMIT`, `KHY_GATEWAY_GUIDE`, `KHY_GATEWAY_IDLE_TIMEOUT_MS`, `KHY_GATEWAY_LOG_LEASE`, `KHY_GATEWAY_LOG_LEASE_FILE`, `KHY_GATEWAY_RECOVERY_BASE_DELAY_MS`, `KHY_GATEWAY_RECOVERY_RELAX_STRICT`, `KHY_GATEWAY_RECOVERY_RETRIES`, `KHY_GATEWAY_RECOVERY_RETRIES_LARGE`, `KHY_GATEWAY_RECOVERY_RETRIES_SMALL`, `KHY_GATEWAY_REFRESH_NON_BLOCKING`, `KHY_GATEWAY_SAMPLE_ATTEMPTS`, `KHY_GATEWAY_SAMPLE_FIRST_RESPONSE_TIMEOUT_MS`, `KHY_GATEWAY_SAMPLE_MAX_ATTEMPTS`, `KHY_GATEWAY_STABILITY_TIMEOUT_MULTIPLIER`, `KHY_GATEWAY_STALL_TIMEOUT_MS`, `KHY_GATEWAY_THROW_FALLBACK`, `KHY_GATEWAY_TIMEOUT_MS`, `KHY_GATEWAY_WARMUP_ON_BOOT`

### KHY_MODEL_* / 模型选择
模型探测/校验/分层、隐藏策略与适配器能力声明。
- 真源：`services/backend/src/services/modelTier.js`、`services/backend/src/cli/handlers/gateway.js`。
- 默认：探测超时/缓存有默认；`KHY_MODEL_HIDE_*` 隐藏开关默认关；`KHY_MODEL` 为显式模型指定无默认。
- 成员：`KHY_MODEL`, `KHY_MODEL_CAPABILITY_MAP`, `KHY_MODEL_DEEP_PROBE_CACHE_MS`, `KHY_MODEL_HIDE_FAILED`, `KHY_MODEL_HIDE_FALLBACK_MODELS`, `KHY_MODEL_HIDE_HINT_MODELS`, `KHY_MODEL_HIDE_UNVERIFIED`, `KHY_MODEL_KIRO_LIST_TIMEOUT_MS`, `KHY_MODEL_KIRO_PROBE_TIMEOUT_MS`, `KHY_MODEL_OVERRIDES_FILE`, `KHY_MODEL_PROBE_DEBOUNCE`, `KHY_MODEL_PROBE_DEBOUNCE_DELAY_MS`, `KHY_MODEL_PROBE_DEBOUNCE_MAX_RETRIES`, `KHY_MODEL_PROBE_GENERATION_TIMEOUT_MS`, `KHY_MODEL_PROBE_TIMEOUT_MS`, `KHY_MODEL_RELAY`, `KHY_MODEL_STRICT_ADAPTERS`, `KHY_MODEL_TIER_MAP`, `KHY_MODEL_TOOLING_CAPABILITY`, `KHY_MODEL_TWO_PHASE_PROBE`, `KHY_MODEL_VERBOSE_ADAPTER_DETAILS`, `KHY_MODEL_VERIFY_PROBE_TIMEOUT_MS`, `KHY_MODEL_VERIFY_TTL_MS`, `KHY_MODEL_WARN_KEEP_MAX`

> **注意**：模型**名字面量**的真源不是环境开关，而是 `services/backend/src/constants/models.js`（每个具名数组首项=当前生效首选）。换模型只改那里，绝不用 env 硬塞模型名（守卫 `check:model-hardcoding` 会拦）。

### KHY_AUDIT_*
审计日志的远程汇聚（ClickHouse/HTTP/S3/Postgres）、修复回路与会话保留。
- 真源：`services/backend/src/services/traceAuditService.js`（修复回路另见 `services/auditFixLoop/`）。
- 默认：远程 sink 端点/凭证无默认需显式；`KHY_AUDIT_FIX_LOOP` 等修复开关默认关。
- 成员：`KHY_AUDIT_CLICKHOUSE_ENDPOINT`, `KHY_AUDIT_CLICKHOUSE_HEADERS`, `KHY_AUDIT_EXPORT_ROLE`, `KHY_AUDIT_EXPORT_S3`, `KHY_AUDIT_FIX_LOOP`, `KHY_AUDIT_FIX_MAX_ROUNDS`, `KHY_AUDIT_FIX_MIN_FILES`, `KHY_AUDIT_HTTP_ENDPOINT`, `KHY_AUDIT_HTTP_HEADERS`, `KHY_AUDIT_HTTP_TIMEOUT_MS`, `KHY_AUDIT_INTERNAL_ROLES`, `KHY_AUDIT_MAX_SESSIONS`, `KHY_AUDIT_MAX_TRACE_MAP`, `KHY_AUDIT_POSTGRES_DSN`, `KHY_AUDIT_REMOTE_SINKS`, `KHY_AUDIT_REQUEST_LOOKUP_SESSION_LIMIT`, `KHY_AUDIT_S3_BUCKET`, `KHY_AUDIT_S3_REGION`, `KHY_AUDIT_SESSION_TTL_MS`, `KHY_AUDIT_SWEEP_MS`

### KHY_TOOL_LOOP_*（工具循环）
Agent 工具调用主循环的迭代上限、超时、重试/恢复与停滞提醒。
- 真源：`services/backend/src/services/toolUseLoop.js`。
- 默认：均有内置默认数值；`KHY_TOOL_LOOP` / `KHY_TOOL_LOOP_TRANSPARENCY` 等开关默认开。
- 成员：`KHY_TOOL_LOOP`, `KHY_TOOL_LOOP_ABSOLUTE_TIMEOUT_MS`, `KHY_TOOL_LOOP_EMPTY_RECOVERIES`, `KHY_TOOL_LOOP_MAX`, `KHY_TOOL_LOOP_MAX_ITERATIONS`, `KHY_TOOL_LOOP_MAX_LARGE`, `KHY_TOOL_LOOP_MAX_MS`, `KHY_TOOL_LOOP_MAX_SMALL`, `KHY_TOOL_LOOP_RECOVERY_DELAY_MS`, `KHY_TOOL_LOOP_REFUSAL_RETRIES`, `KHY_TOOL_LOOP_REPETITION_RETRIES`, `KHY_TOOL_LOOP_ROUTE_PREFACE`, `KHY_TOOL_LOOP_STALL_NUDGES`, `KHY_TOOL_LOOP_STALL_SILENT_DELAY_MS`, `KHY_TOOL_LOOP_SUPPRESS_TOOL_PREFACE`, `KHY_TOOL_LOOP_TIMEOUT_LARGE_MS`, `KHY_TOOL_LOOP_TIMEOUT_MS`, `KHY_TOOL_LOOP_TRANSIENT_RECOVERIES`, `KHY_TOOL_LOOP_TRANSIENT_RECOVERIES_LARGE`, `KHY_TOOL_LOOP_TRANSIENT_RECOVERIES_SMALL`, `KHY_TOOL_LOOP_TRANSPARENCY`

### KHY_TOOL_*（工具执行/展示，非 LOOP）
工具能力探测、去重、断路器、策略与结果透明度。
- 真源：`services/backend/src/services/toolCalling.js`。
- 默认：混合——`KHY_TOOL_DEDUP`/`KHY_TOOL_GUARDS`/`KHY_TOOL_RESULT_TRANSPARENT` 等默认开；阈值/超时有默认；`KHY_TOOL_POLICY`/`KHY_TOOL_CAP_FILE` 为可选策略文件。
- 成员：`KHY_TOOL_ACTIVITY_EVENT_GAP_MS`, `KHY_TOOL_CAP_FILE`, `KHY_TOOL_CAP_PROBE_TIMEOUT_MS`, `KHY_TOOL_CAP_TTL_MS`, `KHY_TOOL_CIRCUIT_BREAKER_THRESHOLD`, `KHY_TOOL_DATA_SUMMARY`, `KHY_TOOL_DEDUP`, `KHY_TOOL_ERROR_CODES`, `KHY_TOOL_EXEC_TIMEOUT_MS`, `KHY_TOOL_GUARDS`, `KHY_TOOL_INTENT_TRUST_DESCRIPTION`, `KHY_TOOL_OUTCOME_FAIL`, `KHY_TOOL_PARAM_NAMING`, `KHY_TOOL_POLICY`, `KHY_TOOL_PREFACE_VARY`, `KHY_TOOL_PREFIX_PROBE_CHARS`, `KHY_TOOL_RECOMMEND`, `KHY_TOOL_RESULT_TRANSPARENT`

### TUI / 终端渲染（INK / INPUT / BUSY 等）
Ink TUI 与经典 REPL 的渲染、输入帧、繁忙合并、铃声、备用屏与提示菜单。
- 真源：`services/backend/src/cli/repl.js`、`services/backend/src/cli/uiPrompt.js`、`services/backend/src/cli/tui/`。
- 默认：体验开关为主多数默认开（`KHY_NO_ALT_SCREEN`/`KHY_PLAIN_TTY_UI` 为显式降级开关默认关）；合并窗口 `*_MS` 有默认。
- 成员：`KHY_BELL_MIN_MS`, `KHY_BELL_ON_DONE`, `KHY_BRIDGE_FOOTER`, `KHY_BUSY_PASTE_MERGE_MS`, `KHY_BUSY_PROMPT_REPAINT_MS`, `KHY_BUSY_QUEUE_MERGE_MS`, `KHY_CLAUDE_UI`, `KHY_FULL_TUI`, `KHY_INK_TUI_ACTIVE`, `KHY_INPUT_BATCH_MODE`, `KHY_INPUT_ESCAPE_TIMEOUT_MS`, `KHY_INPUT_FOOTER_GAP_ROWS`, `KHY_INPUT_FRAME`, `KHY_INPUT_FRAME_MIN_COLS`, `KHY_LEGACY_PERMISSION_UI`, `KHY_LIVE_STATUS_BAR`, `KHY_LOW_LATENCY_INPUT`, `KHY_NO_ALT_SCREEN`, `KHY_NO_TOPIC_BAR`, `KHY_PASTE_MERGE_MS`, `KHY_PLAIN_TTY_UI`, `KHY_REDUCED_MOTION`, `KHY_SLASH_AUTOMENU`, `KHY_SPINNER_BLOCK_IN_RAW_MODE`, `KHY_STARTUP_MODEL_PICKER`, `KHY_SUBMIT_PAINT_YIELD`, `KHY_TUI_HISTORY_PERSIST`, `KHY_TUI_NATIVE_LOOP`, `KHY_TUI_QUEUE_DRAIN`, `KHY_TUI_STEER`

### KHY_AGENT_*（子代理/多代理协作）
子代理树、协作/委派、并发子进程与团队上限。
- 真源：`services/backend/src/tools/AgentTool/index.js`、`services/backend/src/coordinator/`。
- 默认：并发/深度上限有默认；`KHY_ENABLE_MULTI_AGENT`/`KHY_FEATURE_CLAUDEDELEGATION` 功能开关默认关；`KHY_DISABLE_BUILTIN_AGENTS` 默认关（即默认启用内置代理）。
- 成员：`KHY_AGENT_LOG`, `KHY_AGENT_LOG_FILE`, `KHY_AGENT_TREE`, `KHY_AGENT_TREE_PREVIEW`, `KHY_CHILD_TIMEOUT_MS`, `KHY_COOPERATIVE_TIMEOUT_MS`, `KHY_COORDINATOR_MODE`, `KHY_DISABLE_BUILTIN_AGENTS`, `KHY_ENABLE_MULTI_AGENT`, `KHY_FEATURE_CLAUDEDELEGATION`, `KHY_LLM_DECOMPOSE`, `KHY_MAX_CONCURRENT_CHILDREN`, `KHY_MAX_LEAD_INBOX`, `KHY_MAX_SPAWN_DEPTH`, `KHY_MAX_SUBAGENT_DEPTH`, `KHY_MAX_SUBAGENTS`, `KHY_MAX_TEAMMATES`, `KHY_SUBAGENT_ALLOW_THINKING`

### KHY_PERMISSION_* / 沙箱与边界（syscall/human-gate/exec/boundary）
权限模式与存储、syscall 网关、人工闸门、读写边界与允许目录。
- 真源：`services/backend/src/services/toolCalling.js`、`services/backend/src/permissions/`。
- 默认：边界/网关默认开（安全优先，放宽需显式 `0`）；`KHY_ALLOW_*` 放行类默认关；`KHY_PERMISSION_MODE`/`KHY_PERMISSION_STORE` 为模式/路径无默认或内置默认。
- 成员：`KHY_ADDITIONAL_DIRS`, `KHY_ALLOW_SENSITIVE_HOME_WRITE`, `KHY_ALLOW_WRITE_CLAUDE_SETTINGS`, `KHY_EXEC_APPROVAL`, `KHY_FAKE_IP_CIDRS`, `KHY_HUMAN_GATE`, `KHY_PERMISSION_ALLOW_FIRST`, `KHY_PERMISSION_ALLOW_FIRST_HIGHRISK`, `KHY_PERMISSION_FALLBACK`, `KHY_PERMISSION_MODE`, `KHY_PERMISSION_POLICY`, `KHY_PERMISSION_STORE`, `KHY_SECURITY_SCAN_EXCLUDE`, `KHY_STRICT_READ_BOUNDARY`, `KHY_STRICT_WRITE_BOUNDARY`, `KHY_SYSCALL_GATEWAY`, `KHY_WRITE_EXTRA_ROOTS`

### KHY_AUTO_*
自动审批、自动备份/bless、自动 DB 迁移、自动续跑与自动联网搜索。
- 真源：`services/backend/src/services/approvalLedger.js`（审批）、`maintenance/lib/ops.js`（备份/bless，见第一节）。
- 默认：混合——`KHY_AUTO_BACKUP`/`KHY_AUTO_BLESS` 默认开（设 `0` 关）；`KHY_AUTO_APPROVE`/`KHY_AUTO_DB_MIGRATE` 等风险动作默认关需显式开。
- 成员：`KHY_AUTO_APPROVE`, `KHY_AUTO_APPROVE_READONLY`, `KHY_AUTO_APPROVE_THRESHOLD`, `KHY_AUTO_BACKUP`, `KHY_AUTO_BLESS`, `KHY_AUTO_DB_MIGRATE`, `KHY_AUTO_DB_MIGRATE_ALWAYS`, `KHY_AUTO_DECOMPOSE`, `KHY_AUTO_PREFER_REMOTE`, `KHY_AUTO_PREFER_REMOTE_GENERATION_TIMEOUT_MS`, `KHY_AUTO_PREFER_REMOTE_TIMEOUT_MS`, `KHY_AUTO_RESUME_ATTEMPTS`, `KHY_AUTO_RESUME_SEGMENT_MODE`, `KHY_AUTO_RESUME_WINDOW_MIN`, `KHY_AUTO_SCAFFOLD_ON_INTENT`, `KHY_AUTO_WEBSEARCH_MODE`, `KHY_AUTO_WEBSEARCH_ON_INFO_TASK`, `KHY_AUTO_WEBSEARCH_QUERY_CANDIDATES`

### KHY_SELF_*（自检/自愈）
周期性自检、插件 doctor、威胁扫描与自愈/自启动。
- 真源：`services/backend/src/services/baseSelfCheckService.js`。
- 默认：`KHY_SELF_CHECK_ENABLED`/`KHY_SELF_HEAL` 默认开（设 `0` 关）；间隔/超时/历史上限有默认。
- 成员：`KHY_SELF_CHECK_AUTO_REPAIR_PREFERRED`, `KHY_SELF_CHECK_ENABLED`, `KHY_SELF_CHECK_INTERVAL_MS`, `KHY_SELF_CHECK_LOG_FILE`, `KHY_SELF_CHECK_MAX_HISTORY`, `KHY_SELF_CHECK_PLUGIN_DOCTOR_EVERY`, `KHY_SELF_CHECK_PLUGIN_DOCTOR_MAX`, `KHY_SELF_CHECK_PLUGIN_DOCTOR_TIMEOUT_MS`, `KHY_SELF_CHECK_SERVICE_TIMEOUT_MS`, `KHY_SELF_CHECK_STRICT`, `KHY_SELF_CHECK_THREAT_SCAN_EVERY`, `KHY_SELF_HEAL`, `KHY_SELF_KICKOFF`, `KHY_SELF_KICKOFF_MAX`, `KHY_SELF_RENDER`

### KHY_REMOTE_*（远程 SSH）
远程 SSH 执行、流持久化、超时与允许列表。
- 真源：`services/backend/src/routes/remoteSsh.js`。
- 默认：`KHY_REMOTE_SSH_ENABLE_EXEC` 默认关（需显式开远程执行）；allowlist/路径无默认需显式；超时/TTL/上限有默认。
- 成员：`KHY_REMOTE_SSH_ALLOWLIST`, `KHY_REMOTE_SSH_CONFIG_PATH`, `KHY_REMOTE_SSH_CONNECT_TIMEOUT_SEC`, `KHY_REMOTE_SSH_ENABLE_EXEC`, `KHY_REMOTE_SSH_IDLE_TIMEOUT_MS`, `KHY_REMOTE_SSH_MAX_STREAM_EVENTS`, `KHY_REMOTE_SSH_MAX_STREAMS`, `KHY_REMOTE_SSH_PERSIST_ALERT_MAX`, `KHY_REMOTE_SSH_PERSIST_ALERT_RETENTION_MS`, `KHY_REMOTE_SSH_PERSIST_DEBOUNCE_MS`, `KHY_REMOTE_SSH_PERSIST_STATE`, `KHY_REMOTE_SSH_RUNNING_STREAM_TTL_MS`, `KHY_REMOTE_SSH_STATE_PATH`, `KHY_REMOTE_SSH_STREAM_TTL_MS`, `KHY_REMOTE_WORKSPACE_ALLOWLIST`

### KHY_HARNESS_*
Agentic harness 的能力闸门、分解、续跑轮次、重试退避与思考下限。
- 真源：`services/backend/src/services/agenticHarnessService.js`、`services/backend/src/services/modelTier.js`。
- 默认：轮次/重试/延迟有默认；`KHY_HARNESS_CAPABILITY_GATE`/`KHY_HARNESS_DECOMPOSE` 等开关默认开。
- 成员：`KHY_HARNESS_CAPABILITY_GATE`, `KHY_HARNESS_DECOMPOSE`, `KHY_HARNESS_MAX_CONTINUATION_ROUNDS`, `KHY_HARNESS_MAX_ITER_BOOST`, `KHY_HARNESS_NUDGES`, `KHY_HARNESS_PROMPT_VERBOSITY`, `KHY_HARNESS_RETRY_ATTEMPTS`, `KHY_HARNESS_RETRY_MAX_DELAY_MS`, `KHY_HARNESS_RETRY_MIN_DELAY_MS`, `KHY_HARNESS_SHORT_CONTEXT`, `KHY_HARNESS_SYNTHETIC_TOOLS`, `KHY_HARNESS_THINKING_FLOOR`, `KHY_HARNESS_TOOL_PROTOCOL`

### KHY_KERNEL_* / QEMU（内核构建）
khyOS 内核/ISO 构建后端、VM 资源与 QEMU 镜像。
- 真源：`services/backend/src/cli/handlers/khyos.js`。
- 默认：构建后端/VM 资源/超时有默认；ISO URL/SHA256/源目录无默认需显式；`KHY_FORCE_KERNEL_BUILD` 默认关。
- 成员：`KHY_FORCE_KERNEL_BUILD`, `KHY_KERNEL_BUILD_BACKEND`, `KHY_KERNEL_BUILD_IMAGE`, `KHY_KERNEL_BUILD_VM`, `KHY_KERNEL_BUILD_VM_CPUS`, `KHY_KERNEL_BUILD_VM_MEM`, `KHY_KERNEL_BUILD_VM_TIMEOUT_MS`, `KHY_KERNEL_CC_TARGET`, `KHY_KERNEL_ISO`, `KHY_KERNEL_ISO_SHA256`, `KHY_KERNEL_ISO_URL`, `KHY_KERNEL_SRC_DIR`, `KHY_QEMU`, `KHY_QEMU_IMG`

### KHY_META_* / KHY_METACONSTRAINT_* / KHY_METAPLAN_*
元工具、元约束（cage/creative）、元规划与项目元数据符号映射。
- 真源：`services/backend/src/services/projectMetadataService.js`（元工具另见 `services/backend/src/tools/`）。
- 默认：`KHY_META_ENABLED`/`KHY_METACONSTRAINT` 等默认开；符号上限/重试有默认。
- 成员：`KHY_METACONSTRAINT`, `KHY_METACONSTRAINT_CAGE_REASONING`, `KHY_METACONSTRAINT_CREATIVE_EXT`, `KHY_META_DETAIL`, `KHY_META_ENABLED`, `KHY_META_LINK`, `KHY_META_MAP_SYMBOL_FILES`, `KHY_META_MAP_SYMBOLS_PER_FILE`, `KHY_META_MAX_SYMBOL_FILES`, `KHY_METAPLAN_MIN_DISSENT`, `KHY_METAPLAN_SESSION_TRIP`, `KHY_META_POINTER_TARGETS`, `KHY_META_TOOL_DIR`, `KHY_META_TOOL_MAX_PER_SESSION`, `KHY_META_TOOL_MAX_RETRIES`

### KHY_MEMORY_* / KHY_SESSION_*（记忆/会话）
长期记忆分层、蒸馏、半衰期、召回限额与会话记忆。
- 真源：`services/backend/src/services/memoryTier.js`、`services/backend/src/services/memoryEngine/sessionMemory.js`。
- 默认：天数/字符/条数有默认；`KHY_MEMORY_DISTILL_AUTO`/`KHY_SESSION_MEMORY` 默认开（`KHY_DISABLE_MEMORY` 见功能开关）。
- 成员：`KHY_MEMORY_CONTENT_DEDUP`, `KHY_MEMORY_DISTILL_AUTO`, `KHY_MEMORY_DISTILL_INTERVAL_DAYS`, `KHY_MEMORY_HALFLIFE_DAYS`, `KHY_MEMORY_RECALL_CHARS`, `KHY_MEMORY_RECALL_LIMIT`, `KHY_MEMORY_STALE_DAYS_PROJECT`, `KHY_MEMORY_STALENESS`, `KHY_MEMORY_TIERS`, `KHY_MEMORY_TRIGGER`, `KHY_MEMORY_WRITE_SAFETY`, `KHY_SESSION_MEMORY`, `KHY_SESSION_MEMORY_LIMIT`, `KHY_SESSION_SUMMARY_USE_LLM`

### KHY_CONTEXT_*（上下文预算）
上下文窗口、token 预算、安全比例与压缩阈值。
- 真源：`services/backend/src/services/toolUseLoop.js`。
- 默认：均为带内置默认的数值/比例按需覆盖；`KHY_CONTEXT_DIAGNOSTICS` 诊断开关默认关。
- 成员：`KHY_COMPACTION_CC_TOKENS`, `KHY_CONTEXT_DIAGNOSTICS`, `KHY_CONTEXT_HARD_FLOOR`, `KHY_CONTEXT_MIN_BUDGET`, `KHY_CONTEXT_OUTPUT_RESERVE_TOKENS`, `KHY_CONTEXT_SAFETY_RATIO`, `KHY_CONTEXT_SCOPE`, `KHY_CONTEXT_SMALL_CAP_TOKENS`, `KHY_CONTEXT_TOKEN_LIMIT`, `KHY_CONTEXT_WINDOW`, `KHY_CYCLE_THRESHOLD_TOKENS`, `KHY_SHORT_CONTEXT_TOKENS`, `KHY_VERY_SHORT_CONTEXT_TOKENS`

### KHY_TASK_*
任务面板、检查点/重试上限、任务守卫复杂度阈值与自我感知。
- 真源：`services/backend/src/cli/tui/ink-components/TaskListPanel.js`、`services/backend/src/tasks/`。
- 默认：上限/阈值有默认；`KHY_TASK_PANEL`/`KHY_TASK_SELF_AWARENESS` 等开关默认开。
- 成员：`KHY_TASK_ATTEMPTS_MAX`, `KHY_TASK_CAPABILITY_GATE`, `KHY_TASK_CHECKPOINTS_MAX`, `KHY_TASK_GUARD_COMPLEX_ISSUES_MIN`, `KHY_TASK_GUARD_COMPLEX_MIN_CHARS`, `KHY_TASK_GUARD_HARD_ISSUES_MIN`, `KHY_TASK_MINDMAP_AUTO_SHOW`, `KHY_TASK_OUTPUT_DIR`, `KHY_TASK_PANEL`, `KHY_TASK_PLAN`, `KHY_TASK_SELF_AWARENESS`, `KHY_TASK_SELF_AWARENESS_HARD`, `KHY_TASK_SELF_AWARENESS_HARD_TTL_MS`

### KHY_PLAN_* / KHY_PLANNING_*
计划模式：只读、自动批准、步骤重试/超时与预览样式。
- 真源：`services/backend/src/services/toolCalling.js`（plan 只读）、计划模式 REPL。
- 默认：超时/重试有默认；`KHY_PLAN_READONLY`/`KHY_PLANNING_DISCIPLINE` 等默认开。
- 成员：`KHY_PLAN_AUTO_APPROVE_MS`, `KHY_PLAN_CONTINUOUS`, `KHY_PLAN_MODE_TIMEOUT_MS`, `KHY_PLANNING_DISCIPLINE`, `KHY_PLAN_PREVIEW_STYLE`, `KHY_PLAN_READONLY`, `KHY_PLAN_STEP_RETRY`, `KHY_PLAN_STEP_TIMEOUT_MS`, `KHY_PLAN_TASK_PANEL`

### KHY_VERIFY_* / KHY_VERIFICATION_*
验证闸门、集成（ensemble）法定人数与非编辑验证轮次。
- 真源：`services/backend/src/services/capabilityMatrix/descriptors.js`。
- 默认：`KHY_VERIFY_GATE`/`KHY_VERIFICATION_GATE` 默认开；轮次/阈值/quorum 有默认。
- 成员：`KHY_VERIFICATION_GATE`, `KHY_VERIFY_ENSEMBLE`, `KHY_VERIFY_ENSEMBLE_QUORUM`, `KHY_VERIFY_GATE`, `KHY_VERIFY_MAX_ROUNDS`, `KHY_VERIFY_NONEDIT`, `KHY_VERIFY_NONEDIT_ROUNDS`, `KHY_VERIFY_NONEDIT_THRESHOLD`

### KHY_CHANGE_* / KHY_BUGFIX_*（变更/缺陷闸门）
代码变更与缺陷修复的回归闸门、最少必需步骤与低算力层限制。
- 真源：`services/backend/src/services/bugfixRegressionGate.js`。
- 默认：`*_REGRESSION_GATE`/`*_GATE_BASELINE` 默认开（设 `0` 关）；`*_GATE_FAIL_OPEN` 默认关（即失败默认拒绝）。
- 成员：`KHY_BUGFIX_FAIL_ON_MISSING_REQUIRED_STEPS`, `KHY_BUGFIX_GATE_BASELINE`, `KHY_BUGFIX_GATE_FAIL_OPEN`, `KHY_BUGFIX_LOW_TIER_ONLY`, `KHY_BUGFIX_MIN_REQUIRED_STEPS`, `KHY_BUGFIX_REGRESSION_GATE`, `KHY_BUG_SEVERITY`, `KHY_CHANGE_FAIL_ON_MISSING_REQUIRED_STEPS`, `KHY_CHANGE_GATE_BASELINE`, `KHY_CHANGE_GATE_FAIL_OPEN`, `KHY_CHANGE_GATE_INCLUDE_FEATURE`, `KHY_CHANGE_LOW_TIER_ONLY`, `KHY_CHANGE_MIN_REQUIRED_STEPS`, `KHY_CHANGE_REGRESSION_GATE`

### KHY_ULTRAWORK_*
ultrawork 高强度模式的适配器/模型偏好与强制工具选择。
- 真源：`services/backend/src/services/intentGate.js`。
- 默认：适配器/模型无默认需显式；`KHY_ULTRAWORK_FORCE_*`/`KHY_ULTRAWORK_PREFERRED_STRICT` 默认关。
- 成员：`KHY_ULTRAWORK_ADAPTER`, `KHY_ULTRAWORK_FORCE_OVERRIDE`, `KHY_ULTRAWORK_FORCE_TOOL_CHOICE`, `KHY_ULTRAWORK_MODEL`, `KHY_ULTRAWORK_PREFERRED_ADAPTER`, `KHY_ULTRAWORK_PREFERRED_MODEL`, `KHY_ULTRAWORK_PREFERRED_STRICT`

### KHY_TRAJ_* / KHY_TRAJECTORY_*
轨迹引导注入、轨迹修复与轨迹图作者强度。
- 真源：`services/backend/src/services/trajectoryGuide/config.js`。
- 默认：字符/超时/年龄有默认；`KHY_TRAJ_GUIDE_INJECT`/`KHY_TRAJ_AI_REPLAY` 等开关默认开。
- 成员：`KHY_TRAJ_AI_REPLAY`, `KHY_TRAJECTORY_MAX_AGE_D`, `KHY_TRAJ_GUIDE_CHARS`, `KHY_TRAJ_GUIDE_INJECT`, `KHY_TRAJ_MAP_AUTHOR_MIN_STRENGTH`, `KHY_TRAJ_REPAIR_MAX`, `KHY_TRAJ_REPAIR_MODEL`, `KHY_TRAJ_REPAIR_TIMEOUT_MS`

### KHY_REPLAY_*
轨迹回放引擎的内容捕获、指纹、L2 确认与步骤超时。
- 真源：`services/backend/src/services/trajectoryReplay/replayEngine.js`。
- 默认：超时有默认；`KHY_REPLAY_L2_CONFIRM`/`KHY_REPLAY_SHELL_ALLOW` 安全相关开关默认关。
- 成员：`KHY_REPLAY_CAPTURE_CONTENT`, `KHY_REPLAY_FINGERPRINT_TOOLS`, `KHY_REPLAY_L2_CONFIRM`, `KHY_REPLAY_PROBE_TIMEOUT_MS`, `KHY_REPLAY_SHELL_ALLOW`, `KHY_REPLAY_STEP_TIMEOUT_MS`

### KHY_SHELL_*
Shell 命令工具的默认/空闲超时、退出语义与转义上下文。
- 真源：`services/backend/src/tools/shellCommand.js`。
- 默认：超时有默认；`KHY_SHELL_IDLE_TIMEOUT_ENABLED`/`KHY_SHELL_TRANSPARENCY` 默认开。
- 成员：`KHY_SHELL_DEFAULT_TIMEOUT_MS`, `KHY_SHELL_ESCAPE_CTX_MAX`, `KHY_SHELL_EXIT_SEMANTICS`, `KHY_SHELL_IDLE_TIMEOUT_ENABLED`, `KHY_SHELL_IDLE_TIMEOUT_MS`, `KHY_SHELL_TIMEOUT_MS`, `KHY_SHELL_TRANSPARENCY`

### KHY_CLIPBOARD_*
剪贴板图片转文件（img2file）监视：目录、轮询、标记与保留。
- 真源：`services/backend/src/cli/repl.js`（剪贴板监视集成）。
- 默认：`KHY_CLIPBOARD_IMG2FILE_ENABLED`/`*_AUTO_START` 默认关（按需开）；目录/轮询/标记有默认。
- 成员：`KHY_CLIPBOARD_IMG2FILE_AUTO_START`, `KHY_CLIPBOARD_IMG2FILE_DIR`, `KHY_CLIPBOARD_IMG2FILE_ENABLED`, `KHY_CLIPBOARD_IMG2FILE_KEEP_FILES`, `KHY_CLIPBOARD_IMG2FILE_MARKER`, `KHY_CLIPBOARD_IMG2FILE_POLL_MS`, `KHY_CLIPBOARD_IMG2FILE_SHELL`

### KHY_WORKFLOW_*
工作流引擎的 worker、轮询/SSE 间隔、量子步与陈旧阈值。
- 真源：`services/backend/src/services/workflow/workflowRunWorker.js`。
- 默认：间隔/步数/阈值有默认；`KHY_WORKFLOW_WORKER` 为 worker 模式开关。
- 成员：`KHY_WORKFLOW_BODY_LIMIT`, `KHY_WORKFLOW_POLL_MS`, `KHY_WORKFLOW_QUANTUM_STEPS`, `KHY_WORKFLOW_SSE_MS`, `KHY_WORKFLOW_STALE_MS`, `KHY_WORKFLOW_WORKER`

### KHY_WEB_* / KHY_NEWS_*（Web/资讯）
Web 网关服务的主机/端口/URL 与资讯内容抓取。
- 真源：`services/backend/src/cli/handlers/gateway.js`、`services/backend/src/services/newsContentFetcher.js`。
- 默认：host/port 有默认（如 `127.0.0.1` 与内置端口）；URL 类无默认需显式；`KHY_NEWS_FETCH_CONTENT` 默认关。
- 成员：`KHY_NEWS_FETCH_CONTENT`, `KHY_WEB_BASE_URL`, `KHY_WEB_HOST`, `KHY_WEB_INLINE_IMAGE_PATH`, `KHY_WEB_PORT`, `KHY_WEB_RESULT_SUMMARY`, `KHY_WEB_URL`

### KHY_RAG_*
检索增强（RAG）的启用、topK、缓存 TTL 与上下文字符上限。
- 真源：`services/backend/src/services/ragRetrievalService.js`。
- 默认：`KHY_RAG_ENABLED` 默认开；topK/TTL/字符上限有默认（`KHY_SKIP_RAG_FOR_SMALL_TASK` 见其它）。
- 成员：`KHY_RAG_CACHE_TTL_MS`, `KHY_RAG_ENABLED`, `KHY_RAG_KNOWLEDGE_TOPK`, `KHY_RAG_MAX_CONTEXT_CHARS`, `KHY_RAG_SESSION_TOPK`, `KHY_RAG_TOPK`

### KHY_PROACTIVE_*
主动记忆捕获与主动协作子任务的最小置信/字符/数量阈值。
- 真源：`services/backend/src/cli/ai.js`（主动协作集成）。
- 默认：阈值有默认；`KHY_PROACTIVE_CAPTURE`/`KHY_PROACTIVE_MEMORY` 默认开。
- 成员：`KHY_PROACTIVE_CAPTURE`, `KHY_PROACTIVE_COLLAB_MAX_SUBTASKS`, `KHY_PROACTIVE_COLLAB_MIN_CHARS`, `KHY_PROACTIVE_COLLAB_MIN_CONFIDENCE`, `KHY_PROACTIVE_COLLAB_MIN_SUBTASKS`, `KHY_PROACTIVE_MEMORY`

### KHY_PLUGIN_* / KHY_PLUGINS* / KHY_EXTENSION_* / KHY_MARKETPLACE_*
插件自动加载、抓取超时、响应/规格大小上限与扩展市集。
- 真源：`services/backend/src/cli/repl.js`（自动加载）、`services/backend/src/services/extensionMarketplace.js`。
- 默认：超时/字节上限有默认；`KHY_PLUGIN_AUTOLOAD` 默认开；`KHY_PLUGINS`/`KHY_EXTENSION_REGISTRY` 为列表/路径无默认。
- 成员：`KHY_EXTENSION_REGISTRY`, `KHY_MARKETPLACE_BODY_LIMIT`, `KHY_PLUGIN_AUTOLOAD`, `KHY_PLUGIN_FETCH_TIMEOUT_MS`, `KHY_PLUGIN_MAX_RESPONSE_BYTES`, `KHY_PLUGIN_MAX_SPEC_BYTES`, `KHY_PLUGIN_REQUEST_TIMEOUT_MS`, `KHY_PLUGINS`, `KHY_PLUGINS_BODY_LIMIT`

### KHY_INTENT_*
意图仲裁、意图保障（assurance）、覆盖与路由模式。
- 真源：`services/backend/src/cli/repl.js`（意图保障集成）、`services/backend/src/services/intentGate.js`。
- 默认：`KHY_INTENT_ASSURANCE`/`KHY_INTENT_ARBITER` 默认开；循环上限有默认；`*_DEBUG` 默认关。
- 成员：`KHY_INTENT_ARBITER`, `KHY_INTENT_ASSURANCE`, `KHY_INTENT_ASSURANCE_DEBUG`, `KHY_INTENT_COVERAGE`, `KHY_INTENT_LOOP_MAX_CAP`, `KHY_INTENT_ROUTE_MODE`

### KHY_PROJECT_*
项目一致性轮次、项目卫生（hygiene）、God-file 定位与项目树。
- 真源：`services/backend/src/services/projectHygiene/thresholds.js`。
- 默认：轮次/字符有默认；`KHY_PROJECT_HYGIENE`/`KHY_PROJECT_TREE` 等默认开。
- 成员：`KHY_PROJECT_COHERENCE_MEDIUM`, `KHY_PROJECT_COHERENCE_ROUNDS`, `KHY_PROJECT_GOD_FILE_LOC`, `KHY_PROJECT_HYGIENE`, `KHY_PROJECT_MEMORY_MAX_CHARS`, `KHY_PROJECT_TREE`, `KHY_PROJECT_TREE_CHARS`

### KHY_AI_*
AI 前端目录、请求超时、状态去重与上传字节上限。
- 真源：`services/backend/src/services/aiUploadStore.js`、`services/backend/src/services/aiManagementServer.js`。
- 默认：超时/字节上限/去重间隔有默认；前端目录无默认（不设回退内置 dist）。
- 成员：`KHY_AI_ACTIVITY_PULSE_MS`, `KHY_AI_FRONTEND_DIR`, `KHY_AI_FRONTEND_DIST_DIR`, `KHY_AI_REQUEST_TIMEOUT_LARGE_MS`, `KHY_AI_REQUEST_TIMEOUT_MS`, `KHY_AI_STATUS_DEDUP_MS`, `KHY_AI_UPLOAD_EXCERPT_BYTES`, `KHY_AI_UPLOAD_IMAGE_INLINE_BYTES`, `KHY_AI_UPLOAD_MAX_BYTES`

### 提示词装配（KHY_*PROMPT）
系统提示装配、提示复用（reuse）阈值/topK 与提示页脚/修复。
- 真源：`services/backend/src/services/promptReuseService.js`。
- 默认：复用阈值/topK 有默认；`KHY_PROMPT_REUSE`/`KHY_MODULAR_PROMPT`/`KHY_UNIFIED_PROMPT` 等装配开关默认开；`KHY_CLAUDE_PROMPT`/`KHY_LEGACY_PROMPT` 为模式/路径无默认。
- 成员：`KHY_CLAUDE_PROMPT`, `KHY_DELEGATION_PROMPT`, `KHY_LEGACY_PROMPT`, `KHY_MODULAR_PROMPT`, `KHY_ON_DEMAND_PROMPT_SECTIONS`, `KHY_PROMPT_FOOTER`, `KHY_PROMPT_INTENT_REPAIR`, `KHY_PROMPT_REUSE`, `KHY_PROMPT_REUSE_THRESHOLD`, `KHY_PROMPT_REUSE_TOPK`, `KHY_UNIFIED_PROMPT`

### KHY_PREFLIGHT_*
请求前预检：候选数、最大耗时与非阻塞模式。
- 真源：`services/backend/src/services/chatLatencyAutoTuner.js`（预检集成）。
- 默认：候选/耗时有默认；`KHY_PREFLIGHT`/`KHY_PREFLIGHT_NON_BLOCKING` 默认开。
- 成员：`KHY_PREFLIGHT`, `KHY_PREFLIGHT_ADAPTER_TIMEOUT_MS`, `KHY_PREFLIGHT_MAX_CANDIDATES`, `KHY_PREFLIGHT_MAX_MS`, `KHY_PREFLIGHT_NON_BLOCKING`

### KHY_POOL_* / KHY_ACCOUNT_*（账号池）
账号/密钥池的余额策略与事件驱动自动导入冷却。
- 真源：`services/backend/src/services/accountPool.js`。
- 默认：冷却 ms 有默认；`KHY_POOL_EVENT_AUTO_IMPORT`/`KHY_ACCOUNT_POOL_EVENT_AUTO_IMPORT` 自动导入开关默认关；source 无默认需显式。
- 成员：`KHY_ACCOUNT_BALANCE_POLICY`, `KHY_ACCOUNT_POOL_AUTO_IMPORT_COOLDOWN_MS`, `KHY_ACCOUNT_POOL_AUTO_IMPORT_SOURCE`, `KHY_ACCOUNT_POOL_EVENT_AUTO_IMPORT`, `KHY_POOL_AUTO_IMPORT_COOLDOWN_MS`, `KHY_POOL_AUTO_IMPORT_SOURCE`, `KHY_POOL_EVENT_AUTO_IMPORT`, `KHY_POOL_EVENT_AUTO_IMPORT_USE_DEFAULT_SOURCE`, `KHY_POOL_EVENT_AUTO_IMPORT_USE_ENV_SOURCE`

### KHY_UCB_*（路由臂选择）
UCB 多臂赌博机路由的探索系数、先验权重与参考延迟。
- 真源：`services/backend/src/services/gateway/aiGateway.js`（UCB 路由）。
- 默认：系数/权重/延迟有默认；`KHY_UCB_ROUTING` 默认开。
- 成员：`KHY_UCB_EXPLORATION`, `KHY_UCB_NEUTRAL_SPEED`, `KHY_UCB_PRIOR_WEIGHT`, `KHY_UCB_REF_LATENCY_MS`, `KHY_UCB_ROUTING`

### KHY_STATUS_*
状态行/广播的简报长度、错误升级、折叠记录上限与详细度。
- 真源：`services/backend/src/services/gateway/aiGateway.js`（状态广播）。
- 默认：长度/上限/静默 ms 有默认；`KHY_STATUS_ESCALATE_ON_ERROR` 默认开。
- 成员：`KHY_STATUS_BRIEF_INPUT_LEN`, `KHY_STATUS_ESCALATE_ON_ERROR`, `KHY_STATUS_FOLDED_MAX_RECORDS`, `KHY_STATUS_START_SILENT_MS`, `KHY_STATUS_VERBOSITY`

### KHY_RUNTIME_*
运行时下载/配置：下载超时、清单、模式与配置调试。
- 真源：`services/backend/src/services/khyUpgradeRuntime.js`、`services/backend/src/services/multimodalInputService.js`（运行时模式读取）。
- 默认：超时有默认；manifest/mode 无默认需显式；`KHY_RUNTIME_PROVISION_DEBUG` 默认关。
- 成员：`KHY_RUNTIME_DOWNLOAD_TIMEOUT_MS`, `KHY_RUNTIME_MANIFEST`, `KHY_RUNTIME_MODE`, `KHY_RUNTIME_PROVISION_DEBUG`

### KHY_RTK_*
RTK（Rust Token Killer）代理的安装、模式、git/脚本源与文件工具。
- 真源：`services/backend/src/cli/handlers/rtk.js`。
- 默认：URL 有内置默认；`KHY_RTK_AUTO_INSTALL`/`KHY_RTK_MODE`/`KHY_RTK_FILE_TOOLS` 为模式/开关默认开（RTK 透明重写）。
- 成员：`KHY_RTK_AUTO_INSTALL`, `KHY_RTK_FILE_TOOLS`, `KHY_RTK_GIT_URL`, `KHY_RTK_INSTALL_SCRIPT_URL`, `KHY_RTK_MODE`

### KHY_CHAT_*
聊天延迟自动调优（autotune）的最小采样/间隔与自适应。
- 真源：`services/backend/src/services/chatLatencyAutoTuner.js`。
- 默认：间隔/采样有默认；`KHY_CHAT_AUTOTUNE`/`KHY_CHAT_AUTOTUNE_ADAPTIVE` 默认开。
- 成员：`KHY_CHAT_AUTOTUNE`, `KHY_CHAT_AUTOTUNE_ADAPTIVE`, `KHY_CHAT_AUTOTUNE_MIN_INTERVAL_MS`, `KHY_CHAT_AUTOTUNE_MIN_SAMPLES`, `KHY_CHAT_AUTOTUNE_STATUS_MIN_GAP_MS`

### KHY_BROWSER_* / KHY_PLAYWRIGHT_*（浏览器自动化）
浏览器 ARIA 快照、自动滚动、状态持久化与 Playwright 端点/无头模式。
- 真源：`services/backend/src/services/browser/ariaSnapshot.js`、`services/backend/src/services/browser/engine.js`。
- 默认：TTL/导航超时有默认；CDP/WS 端点无默认需显式；`KHY_PLAYWRIGHT_HEADLESS` 默认开（无头）。
- 成员：`KHY_BROWSER_ARIA`, `KHY_BROWSER_AUTOSCROLL`, `KHY_BROWSER_IDLE_TTL_MS`, `KHY_BROWSER_PERSIST_STATE`, `KHY_BROWSER_STORAGE_STATE`, `KHY_PLAYWRIGHT_CDP_ENDPOINT`, `KHY_PLAYWRIGHT_HEADLESS`, `KHY_PLAYWRIGHT_NAV_TIMEOUT_MS`, `KHY_PLAYWRIGHT_WS_ENDPOINT`

### KHY_USER_* / KHY_USAGE_*
用户并发槽、网关请求体上限、消息配色与使用习惯。
- 真源：`services/backend/src/services/concurrencySlots.js`、`services/backend/src/cli/ai.js`。
- 默认：并发/体积上限有默认；消息配色 `KHY_USER_MSG_*` 无默认（不设用默认主题色）。
- 成员：`KHY_USAGE_HABITS`, `KHY_USER_GATEWAY_BODY_LIMIT`, `KHY_USER_MAX_CONCURRENT`, `KHY_USER_MSG_BG`, `KHY_USER_MSG_FG`, `KHY_USER_MSG_WHITE_BG`

### KHY_ULIMIT_*（资源上限）
子进程 ulimit 资源限制：CPU、文件描述符、文件大小、进程数与虚拟内存。
- 真源：`services/backend/src/services/resourceGuard.js`。
- 默认：均有内置默认上限按需覆盖。
- 成员：`KHY_ULIMIT_CPU`, `KHY_ULIMIT_FD`, `KHY_ULIMIT_FSIZE`, `KHY_ULIMIT_NPROC`, `KHY_ULIMIT_VMEM`

### KHY_SWITCH_CENTER_*（切换中心）
provider 切换中心的自动同步、自动 provider 选择与回退。
- 真源：`services/backend/src/cli/handlers/proxy.js`。
- 默认：冷却 ms 有默认；preferred provider 无默认需显式；`KHY_SWITCH_CENTER_AUTO_SYNC`/`*_AUTO_FALLBACK` 默认开。
- 成员：`KHY_SWITCH_CENTER_AUTO_FALLBACK`, `KHY_SWITCH_CENTER_AUTO_PREFERRED_PROVIDER`, `KHY_SWITCH_CENTER_AUTO_PROVIDER`, `KHY_SWITCH_CENTER_AUTO_SYNC`, `KHY_SWITCH_CENTER_AUTO_SYNC_COOLDOWN_MS`

### KHY_SEARCH_* / KHY_UNIFIED_SEARCH（搜索）
搜索引擎选择、模式、结果数与 RRF 融合系数。
- 真源：`services/backend/src/services/playwrightSearch.js`。
- 默认：结果数/RRF-k 有默认；engines/mode 无默认（不设用内置默认引擎）；`KHY_UNIFIED_SEARCH` 默认开。
- 成员：`KHY_SEARCH_ENGINES`, `KHY_SEARCH_MODE`, `KHY_SEARCH_RESULTS`, `KHY_SEARCH_RRF_K`, `KHY_UNIFIED_SEARCH`

### KHY_LEARN_*（学习/自进化）
学习画像层级、动态学习、改进上限与 LRTA/进化引擎/启发式探索。
- 真源：`services/backend/src/services/learningProfile.js`、`services/backend/src/services/agenticHarnessService.js`。
- 默认：层级/上限/超时有默认；`KHY_LEARN_DYNAMIC`/`KHY_LRTA_ENABLED`/`KHY_HEURISTIC_ENABLED`/`KHY_EVO_ENGINE` 等默认开。
- 成员：`KHY_EVO_ENGINE`, `KHY_HEURISTIC_ENABLED`, `KHY_LEARN_DYNAMIC`, `KHY_LEARN_FETCH_TIMEOUT_MS`, `KHY_LEARN_IMPROVE_MAX`, `KHY_LEARN_LEVEL`, `KHY_LRTA_ENABLED`, `KHY_LRTA_STEP_COST_WEIGHT`, `KHY_UNKNOWN_EXPLORATION`

### KHY_DESKTOP_*（桌面控制）
桌面 GUI 控制：启用、目录、是否遵从审批与最大执行次数。
- 真源：`services/backend/src/cli/handlers/desktop.js`。
- 默认：`KHY_DESKTOP_CONTROL` 默认关（需显式开桌面控制）；`KHY_DESKTOP_HONOR_APPROVAL` 默认开；执行次数有默认上限。
- 成员：`KHY_DESKTOP_CONTROL`, `KHY_DESKTOP_DIR`, `KHY_DESKTOP_HONOR_APPROVAL`, `KHY_DESKTOP_MAX_ACTUATIONS`, `KHY_NO_DESKTOP_NORMALIZE`, `KHY_QUICK_TASK_DESKTOP_DIR`

### KHY_DEP_*（依赖）
依赖自愈、安装/版本探测超时与版本固定。
- 真源：`services/backend/src/services/toolCalling.js`（依赖自愈集成）。
- 默认：超时有默认；`KHY_DEP_HEALING` 默认开；`KHY_DEP_VERSIONS` 无默认。
- 成员：`KHY_DEP_HEALING`, `KHY_DEP_INSTALL_TIMEOUT_MS`, `KHY_DEP_VERSIONS`, `KHY_DEP_VERSION_TIMEOUT_MS`

### KHY_OTEL_*
OpenTelemetry 导出器、OTLP 端点/头与服务名/版本。
- 真源：`services/backend/src/observability/otel.js`。
- 默认：`KHY_OTEL_ENABLED` 默认关（需显式开）；OTLP 端点/头无默认需显式；服务名/版本有内置默认。
- 成员：`KHY_OTEL_ENABLED`, `KHY_OTEL_EXPORTER`, `KHY_OTEL_OTLP_ENDPOINT`, `KHY_OTEL_OTLP_HEADERS`, `KHY_OTEL_SERVICE_NAME`, `KHY_OTEL_SERVICE_VERSION`

### 遥测/指标/可观测（metrics/telemetry/observability/trace）
Prometheus 风格指标、遥测端点与可观测/追踪目录。
- 真源：`services/backend/src/observability/metrics.js`。
- 默认：`KHY_METRICS_ENABLED` 默认关；路径/前缀有默认；遥测端点无默认需显式。
- 成员：`KHY_METRICS_ENABLED`, `KHY_METRICS_PATH`, `KHY_METRICS_PREFIX`, `KHY_OBSERVABILITY_DIR`, `KHY_TELEMETRY_ENDPOINT`, `KHY_TRACE_AUDIT_DIR`

### KHY_CODEX_*
Codex 适配器的首响应/空闲/总超时与语言恢复重试。
- 真源：`services/backend/src/services/gateway/adapters/codexAdapter.js`。
- 默认：均有默认超时/重试值。
- 成员：`KHY_CODEX_FIRST_RESPONSE_TIMEOUT_MS`, `KHY_CODEX_IDLE_TIMEOUT_MS`, `KHY_CODEX_LANGUAGE_RECOVERY_RETRIES`, `KHY_CODEX_TIMEOUT_MS`

### KHY_OLLAMA_*
Ollama 适配器的 num_predict 与思考模式模型/token。
- 真源：`services/backend/src/cli/ai.js`（Ollama 思考模型读取）。
- 默认：数值有默认；thinking models 列表无默认需显式。
- 成员：`KHY_OLLAMA_NUM_PREDICT`, `KHY_OLLAMA_THINKING_MIN_TOKENS`, `KHY_OLLAMA_THINKING_MODELS`, `KHY_OLLAMA_THINKING_MULTIPLIER`

### KHY_COZE_*
Coze 工作流导入：目录、会话上限/TTL 与上传限额。
- 真源：`services/ai-backend/src/services/cozeImportService.js`（注意位于 `services/ai-backend`，非 `backend`）。
- 默认：上限/TTL 有默认；catalog 目录无默认需显式。
- 成员：`KHY_COZE_CATALOG_DIR`, `KHY_COZE_SESSION_MAX`, `KHY_COZE_SESSION_TTL_MS`, `KHY_COZE_UPLOAD_LIMIT`

### KHY_CRON_*
内置 cron 调度器的作业/持久化文件、成长目录与测试中启用代理。
- 真源：`services/backend/src/services/cronScheduler.js`。
- 默认：文件/目录有默认路径；`KHY_CRON_ENABLE_AGENT_IN_TEST` 默认关。
- 成员：`KHY_CRON_DURABLE_FILE`, `KHY_CRON_ENABLE_AGENT_IN_TEST`, `KHY_CRON_GROWTH_DIR`, `KHY_CRON_JOBS_FILE`

### KHY_CAPABILITY_*
能力矩阵的策略文件/JSON、路由调试与能力层。
- 真源：`services/backend/src/services/modelTier.js`、`services/backend/src/services/capabilityMatrix/`。
- 默认：策略文件/JSON 无默认需显式；`KHY_CAPABILITY_ROUTE_DEBUG` 默认关。
- 成员：`KHY_CAPABILITY_POLICY_FILE`, `KHY_CAPABILITY_POLICY_JSON`, `KHY_CAPABILITY_ROUTE_DEBUG`, `KHY_CAPABILITY_TIER`

### KHY_ADMIN_*
管理端 HTTP 的路径、URL、口令与请求体上限。
- 真源：`services/backend/src/cli/handlers/gateway.js`、`services/backend/src/services/aiManagementServer.js`。
- 默认：path/url 有默认；`KHY_ADMIN_PASSWORD` 为机密无默认需显式。
- 成员：`KHY_ADMIN_BODY_LIMIT`, `KHY_ADMIN_PASSWORD`, `KHY_ADMIN_PATH`, `KHY_ADMIN_URL`

### KHY_DB_* / KHY_DAEMON_*（数据库/守护进程）
数据库方言/URL/迁移状态与守护进程 PID/端口。
- 真源：`services/backend/src/tools/databaseQuery.js`、守护进程引导。
- 默认：dialect 有默认；`KHY_DB_URL` 无默认需显式；daemon port 有默认。
- 成员：`KHY_DAEMON_PID_FILE`, `KHY_DAEMON_PORT`, `KHY_DB_DIALECT`, `KHY_DB_MIGRATION_STATE_FILE`, `KHY_DB_URL`

### 功能开关（KHY_ENABLE_* / KHY_DISABLE_*）
通用功能启停：执行代码、元工具、多代理、周期扫描、记忆/会话持久化与密钥池监视。
- 真源：`services/backend/src/tools/executeCode.js`、`services/backend/src/tools/index.js`（按工具分散读取）。
- 默认：`KHY_ENABLE_*` 默认关需显式开；`KHY_DISABLE_*` 默认关（即对应功能默认启用，设 `1` 关）。
- 成员：`KHY_DISABLE_KEYPOOL_WATCH`, `KHY_DISABLE_MEMORY`, `KHY_DISABLE_SESSION_PERSIST`, `KHY_ENABLE_EXECUTE_CODE`, `KHY_ENABLE_META_TOOL`, `KHY_ENABLE_PERIODIC_SCAN`

### KHY_MOONBIT_*
MoonBit/WASM 上下文引擎、预构建与 provider 模块。
- 真源：`services/backend/src/services/contextWasm.js`。
- 默认：`KHY_MOONBIT_ENGINE`/`KHY_MOONBIT_PREBUILT` 引擎开关默认开；provider module 无默认。
- 成员：`KHY_MOONBIT_ENGINE`, `KHY_MOONBIT_PREBUILT`, `KHY_MOONBIT_PROVIDER_MODULE`

### KHY_STRUCTURED_*
结构化输出与 structured furnace 模式。
- 真源：`services/backend/src/services/queryEngine.js`。
- 默认：`KHY_STRUCTURED_OUTPUT`/`KHY_STRUCTURED_FURNACE` 默认开；mode 有默认。
- 成员：`KHY_STRUCTURED_FURNACE`, `KHY_STRUCTURED_FURNACE_MODE`, `KHY_STRUCTURED_OUTPUT`

### KHY_QUERY_ENGINE_*
查询引擎及其 harness/v2 变体开关。
- 真源：`services/backend/src/services/queryEngine.js`。
- 默认：`KHY_QUERY_ENGINE` 默认开；`KHY_QUERY_ENGINE_V2`/`_HARNESS` 变体开关默认关/按需。
- 成员：`KHY_QUERY_ENGINE`, `KHY_QUERY_ENGINE_HARNESS`, `KHY_QUERY_ENGINE_V2`

### KHY_RE_*（逆向源恢复）
逆向工程/源恢复引擎的超时、字节/条目上限与字符串窗口。
- 真源：`services/backend/src/services/reverseEngineer/sourceRecoverer.js`。
- 默认：均为带内置默认的超时/上限值。
- 成员：`KHY_RE_BRAIN_TIMEOUT_MS`, `KHY_RE_MAX_BYTES`, `KHY_RE_MAX_ENTRIES`, `KHY_RE_STRING_WINDOW`, `KHY_RE_TOOL_MAX_BUFFER`, `KHY_RE_TOOL_TIMEOUT_MS`

### 输出排版 / Markdown 渲染
排版（typeset）、Markdown 收紧、Unicode 指南、结果折叠（elbow）与输出样式。
- 真源：`services/backend/src/services/typeset/textEmphasisPolicy.js`、`services/backend/src/cli/repl/`。
- 默认：渲染开关为主多数默认开（设 `0` 关）；`KHY_OUTPUT_STYLE`/`KHY_SKILL_CATALOG_CHARS` 为样式/字符参数有默认。
- 成员：`KHY_BRIEF_TOOL_PROGRESS_EVERY`, `KHY_GREP_MODE_SUMMARY`, `KHY_MD_TIGHTEN`, `KHY_OUTPUT_STYLE`, `KHY_READ_TYPE_SUMMARY`, `KHY_REPORT_RICH`, `KHY_RESULT_ELBOW`, `KHY_SHOW_THINKING_TEXT`, `KHY_SKILL_CATALOG_CHARS`, `KHY_SYNC_OUTPUT`, `KHY_TYPESET_BIG_HEADINGS`, `KHY_TYPESET_EMPHASIS`, `KHY_UNICODE_GUIDE`, `KHY_UNICODE_GUIDE_DENSITY`

### 流式输出（KHY_STREAM*）
流式渲染、流式工具执行与重复/停滞守护。
- 真源：`services/backend/src/cli/repl/streamRender.js`。
- 默认：`KHY_STREAMING_MD`/`KHY_STREAMING_TOOL_EXEC` 默认开；守护开关默认开。
- 成员：`KHY_STREAMING_MD`, `KHY_STREAMING_TOOL_EXEC`, `KHY_STREAM_REPETITION_GUARD`, `KHY_STREAM_STALL_ABORT`

### 循环/续跑（KHY_LOOP_* / KHY_*LOOP）
续跑/续接、Ralph 循环、空文本循环上限与无人值守重试。
- 真源：`services/backend/src/services/capabilityMatrix/descriptors.js`（Ralph）、`services/backend/src/cli/repl.js`。
- 默认：上限有默认；`KHY_LOOP_DEBUG`/`KHY_RALPH_LOOP`/`KHY_LEGACY_LOCAL_LOOP` 等默认关。
- 成员：`KHY_EMPTY_TEXT_TOOL_LOOP_MAX`, `KHY_INERTIA_COMPLETION`, `KHY_LEGACY_LOCAL_LOOP`, `KHY_LOOP_CONTINUATION`, `KHY_LOOP_DEBUG`, `KHY_LOOP_DEBUG_FILE`, `KHY_RALPH_LOOP`, `KHY_UNATTENDED_RETRY`

### 进程生命周期/看门狗
僵尸进程检查、看门狗、失效保护进程守卫、心跳与清理间隔。
- 真源：`services/backend/src/coordinator/workerAgent.js`。
- 默认：均为带内置默认的间隔/阈值 ms；守卫默认开。
- 成员：`KHY_ACTIVITY_PULSE_MS`, `KHY_CLEANUP_INTERVAL_MS`, `KHY_FAILSAFE_PROCESS_GUARD`, `KHY_HEARTBEAT`, `KHY_LIVENESS_FALLBACK`, `KHY_SERVER_START_WAIT_MS`, `KHY_WATCHDOG_MS`, `KHY_ZOMBIE_CHECK_MS`, `KHY_ZOMBIE_THRESHOLD_MS`

### 工具/构建空闲与执行超时
build/grep/lint/run_tests/CLI 工具的空闲超时与代码执行/小任务超时倍率。
- 真源：`services/backend/src/tools/buildProject.js`（及 `tools/` 下各工具同款读取）。
- 默认：均有内置默认超时；`KHY_TIMEOUT_MULTIPLIER` 为全局倍率默认 1。
- 成员：`KHY_BUILD_IDLE_TIMEOUT_MS`, `KHY_CLAUDE_SMALL_TASK_TIMEOUT_MS`, `KHY_CLI_DETECT_TTL_MS`, `KHY_CLI_TOOL_IDLE_TIMEOUT_MS`, `KHY_EXECUTE_CODE_PROC_TIMEOUT_MS`, `KHY_EXECUTE_CODE_VM_TIMEOUT_MS`, `KHY_GENERAL_SMALL_TASK_TIMEOUT_MS`, `KHY_GREP_IDLE_TIMEOUT_MS`, `KHY_LINT_IDLE_TIMEOUT_MS`, `KHY_LSP_DIAG_WAIT_MS`, `KHY_PREFETCH_MAX_MS`, `KHY_RUN_TESTS_IDLE_TIMEOUT_MS`, `KHY_TIMEOUT_MULTIPLIER`

### 硬件/资源画像
有效 CPU/内存、最大堆与 WASM 实例缓存上限。
- 真源：`services/backend/src/services/osProfileService.js`。
- 默认：探测自动填充作为覆盖项无强制默认；`KHY_MAX_HEAP_MB` 影响 node 堆。
- 成员：`KHY_EFFECTIVE_CPUS`, `KHY_EFFECTIVE_MEM_MB`, `KHY_HW_PROFILE`, `KHY_MAX_HEAP_MB`, `KHY_WASM_INSTANCE_CACHE_MAX`

### KHY_BETA_* / Anthropic beta 头
Anthropic beta 特性头：1M 上下文与交错思考。
- 真源：`services/backend/src/services/gateway/adapters/claudeAdapter.js`。
- 默认：beta 开关默认关，需显式开（依赖账号资格）。
- 成员：`KHY_ANTHROPIC_BETA`, `KHY_BETA_1M_CONTEXT`, `KHY_BETA_INTERLEAVED`

### 原生文档/文本直通（KHY_NATIVE_*）
原生文档/文本直通的字节上限与 passthrough 开关。
- 真源：`services/backend/src/services/multimodalInputService.js`。
- 默认：字节上限有默认；`KHY_NATIVE_DOC_PASSTHROUGH` 默认关/按需。
- 成员：`KHY_NATIVE_DOC_MAX_BYTES`, `KHY_NATIVE_DOC_PASSTHROUGH`, `KHY_NATIVE_TEXT_MAX_BYTES`

### 错误展示（KHY_ERROR_*）
错误枚举、合并窗口与 verbose 错误输出。
- 真源：`services/backend/src/cli/repl/errorReporting.js`。
- 默认：合并窗口 ms 有默认；`KHY_ERROR_VERBOSE` 默认关。
- 成员：`KHY_ERROR_ENUMERATION`, `KHY_ERROR_MERGE_WINDOW_MS`, `KHY_ERROR_VERBOSE`

### 回退/重绕（KHY_REWIND_* / KHY_ROLLBACK_* / KHY_SNAPSHOT_*）
rewind 持久化、回滚确认与快照来源（`KHY_ROLLBACK_CONFIRM` 详见第一节）。
- 真源：`services/backend/src/services/rewindResume.js`、`maintenance/lib/ops.js`（回滚确认）。
- 默认：`KHY_REWIND_PERSIST` 默认开；`KHY_ROLLBACK_CONFIRM` 默认关（默认需交互确认）。
- 成员：`KHY_REWIND_PERSIST`, `KHY_ROLLBACK_CONFIRM`, `KHY_SNAPSHOT_FROM`

### KHY_STABLE_*（稳定版登记）
稳定版发布登记文件、影子镜像与前缀（详见第一节 1.2）。
- 真源：`maintenance/lib/ops.js`。
- 默认：文件路径有默认；前缀有默认（`v`）。
- 成员：`KHY_STABLE_PREFIX`, `KHY_STABLE_RELEASE_FILE`, `KHY_STABLE_RELEASE_SHADOW_FILE`

### 密钥/凭证（secret/key）
内置 provider 密钥与 owner/publish/study 机密。
- 真源：`services/backend/src/services/customProviderRegistrar.js`。
- 默认：**无默认，机密需显式设置**（不设则对应能力不可用）。**绝不写入日志/诊断/备份明文之外**——诊断与备份刻意排除密钥（备份含 config.json 会显式警告勿外发）。
- 成员：`KHY_BUILTIN_SENSENOVA_KEY`, `KHY_OWNER_SECRET`, `KHY_SOURCE_PUBLISH_SECRET`, `KHY_STUDY_SECRET`

### Claude 托管设置（KHY_MANAGE* / MANAGED）
是否托管 Claude settings 与前端 host 管理。
- 真源：`services/backend/src/services/aiManagementServer.js`。
- 默认：`KHY_MANAGE_CLAUDE_SETTINGS` 默认开（接管 settings 写入）；`KHY_MANAGED_SETTINGS` 为路径无默认。
- 成员：`KHY_MANAGE_CLAUDE_SETTINGS`, `KHY_MANAGED_SETTINGS`, `KHY_MANAGE_FRONTEND_HOST`

### 归档 / 上传 / 代理 / 发布预检 / 交付 / 确定性 / 截断 / 文件锁 / 护栏 / 巨石 / REPL / 目标（小家族合并）
若干小家族，逐项语义见各自源文件。
- `KHY_ARCHIVE_*`（压缩包检视字节/条目上限，`services/archiveInspectService.js`）：`KHY_ARCHIVE_MAX_BYTES`, `KHY_ARCHIVE_MAX_LIST_ENTRIES`。
- `KHY_UPLOAD_*`（上传富化/转写超时，`services/aiUploadStore.js`；`KHY_UPLOAD_ENRICH` 默认开）：`KHY_UPLOAD_ENRICH`, `KHY_UPLOAD_TRANSCRIBE_TIMEOUT_MS`。
- `KHY_PROXY_*`（是否强制代理/路由模式，`gateway/adapters/_proxyTunnel.js`；`KHY_PROXY_REQUIRED` 默认关）：`KHY_PROXY_REQUIRED`, `KHY_PROXY_ROUTE_MODE`。
- `KHY_PUBLISH_*`（发布 DB 预检，`cli/handlers/publish.js`；`KHY_PUBLISH_STRICT_DB_PREFLIGHT` 默认开 / `KHY_PUBLISH_SKIP_DB_PREFLIGHT` 默认关）：`KHY_PUBLISH_SKIP_DB_PREFLIGHT`, `KHY_PUBLISH_STRICT_DB_PREFLIGHT`。
- `KHY_DELIVERY_*`（交付闸门/补救轮次，`capabilityMatrix/descriptors.js`；`KHY_DELIVERY_GATE` 默认开）：`KHY_DELIVERY_GATE`, `KHY_DELIVERY_MAX_REMEDIATION`。
- `KHY_DETERMINISTIC_*`（确定性事实/快任务直通，`services/deterministicFacts.js`；默认开）：`KHY_DETERMINISTIC_FACTS`, `KHY_DETERMINISTIC_QUICK_TASKS`。
- `KHY_TRUNCATION_*`（可忽略截断阈值，`services/toolUseLoop.js`）：`KHY_TRUNCATION_MAX_NEGLIGIBLE`, `KHY_TRUNCATION_MIN_CHARS`。
- `KHY_FILE_LOCK_*`（文件锁目录/禁用，`tools/_fileLock.js`；`KHY_FILE_LOCK_DISABLED` 默认关=默认启用锁）：`KHY_FILE_LOCK_DIR`, `KHY_FILE_LOCK_DISABLED`。
- `KHY_GUARDRAIL_*`（工具护栏条目上限/TTL，`services/toolGuards.js`）：`KHY_GUARDRAIL_MAX_ENTRIES`, `KHY_GUARDRAIL_TTL_MS`。
- `KHY_BOULDER_*`（大型任务续跑/TTL，`services/resumeAdvisor.js`；`KHY_BOULDER_RESUME` 默认开）：`KHY_BOULDER_RESUME`, `KHY_BOULDER_TTL_HOURS`。
- `KHY_REPL_*`（REPL 活动/harness 标记，`cli/router.js`，运行时自动置位）：`KHY_REPL_ACTIVE`, `KHY_REPL_HARNESS`。
- `KHY_GOAL_*`（目标模式标记/模型，`services/goalModeService.js`）：`KHY_GOAL_MODE_ACTIVE`, `KHY_GOAL_MODEL`。
- `KHY_DIFF_*`（diff 渲染字节上限/测试根，`services/toolUseLoop.js`，区别于 CC diff 门控）：`KHY_DIFF_MAX_BYTES`, `KHY_DIFF_TEST_ROOT`。

### 其它 / 未归类
无共同前缀或单例的杂项开关（模型/语言/调试/兼容/特性标记等）。逐项语义需查对应读取点：多数在 `services/backend/src/cli/` 与 `services/backend/src/services/` 内各自分散读取（例：`KHY_ACTION_ATTRIBUTION`→`services/actionAttribution.js`、`KHY_DIRECTIVE_COMPOSER`→`services/directiveComposer.js`、`KHY_MARSHAL_STRONG_THRESHOLD`→`services/marshal/capabilityVector.js`、`KHY_LATTICE_REDLINE_SOURCES`→`services/constraintLattice.js`、`KHY_SYNTHETIC_TOOLS`→`services/syntheticToolLayer.js`、`KHY_DEFER_TOOLS`→`tools/index.js`、`KHY_DEBUG`/`KHY_LANGUAGE`/`KHY_UI_LANG`→引导与 i18n）。
- 默认：混合——`KHY_DEBUG`/`*_GUARD`/`*_STRICT` 等多默认关；语言/模型/路径类无默认需显式；体验开关（`KHY_GREETING_FASTPATH`、`KHY_SHOW_GETTING_STARTED` 等）多默认开。逐项以读取点为准。
- 成员：`KHY_ACTION_ATTRIBUTION`, `KHY_ACTIVE_MODEL`, `KHY_ACTIVE_MODEL_PATH`, `KHY_ADAPTER_SOURCE_LABELS`, `KHY_ADVERSARIAL_DEADLINE_MS`, `KHY_ANALYZE_MODEL`, `KHY_ARCH_GOD_FILE_LOC`, `KHY_ASK_NOCHANNEL_STRICT`, `KHY_BASH_COMMENT_LABEL`, `KHY_BRIDGE_AUTOSTART`, `KHY_BUILD_TIMESTAMP`, `KHY_BUNDLED`, `KHY_CLARIFICATION_CARDS`, `KHY_CLOUD_ENDPOINT`, `KHY_CODING_FORCE_TOOL_CHOICE`, `KHY_CODING_MODEL`, `KHY_COGNITIVE_SNAPSHOT`, `KHY_COMMENT_GUIDANCE`, `KHY_CROSS_TURN_TOOL_DEDUP`, `KHY_CROSS_TURN_TOOL_DEDUP_STEERS`, `KHY_DEBUG`, `KHY_DEFER_TOOLS`, `KHY_DEV_COURSE_MONITOR`, `KHY_DIRECTIVE_COMPOSER`, `KHY_DOC_CITATIONS`, `KHY_DOCS_CHROME`, `KHY_FALSE_POSITIVE_FIX_GUARD`, `KHY_FEATURE_BUDDY`, `KHY_FORCE_NORMALIZE`, `KHY_GIT_BASH_PATH`, `KHY_GREETING_FASTPATH`, `KHY_HTTP_REFERER`, `KHY_INSTALL_NOTICE_PRINTED`, `KHY_LANGUAGE`, `KHY_LANGUAGE_RISKY_ADAPTERS`, `KHY_LATTICE_REDLINE_SOURCES`, `KHY_LIGHTWEIGHT`, `KHY_LOCATION_FILE`, `KHY_LOOKAHEAD_WIDTH`, `KHY_MAINTAIN_SCC_DRIFT_MAX_RATIO`, `KHY_MAINT_NO_PAUSE`, `KHY_MARSHAL_STRONG_THRESHOLD`, `KHY_MASCOT_IMAGE`, `KHY_MIRROR_GATEWAY_STATUS_WHEN_ONCHUNK`, `KHY_NET_PROBE_HOSTS`, `KHY_NODE_LLAMA_CPP_LOG_SILENT`, `KHY_ONBOARDING`, `KHY_PRETOOL_HOOKS`, `KHY_PROVIDER_PRESETS`, `KHY_PYTHON_BIN`, `KHY_RECEIPT_MAX_STR`, `KHY_REMEMBER_APPROVED_DIR`, `KHY_REPLY_GUARD`, `KHY_RESILIENCE_BUDGET_FLOOR_PCT`, `KHY_ROLE_AUTODETECT`, `KHY_SCAFFOLD_DEFAULT_CONCURRENCY`, `KHY_SEAM_DISABLED`, `KHY_SEED_STRICT`, `KHY_SHOW_GETTING_STARTED`, `KHY_SHOW_INSTALL_PATH_ALWAYS`, `KHY_SKIP_RAG_FOR_SMALL_TASK`, `KHY_SYNTHETIC_TOOLS`, `KHY_TEACH_GATE`, `KHY_TEST_LOOPBACK_HOST`, `KHY_TEST_LOOPBACK_PORT`, `KHY_THINKING_DURATION`, `KHY_TIMEZONE`, `KHY_TODOWRITE_ALWAYS_LOAD`, `KHY_TRAINING_DIR`, `KHY_TRUST_STOP_REASON`, `KHY_UI_LANG`, `KHY_UNIFIED_LOCAL_CAP`, `KHY_UNPACK_MAX_BYTES`, `KHY_URGENT_STEER_MAX`, `KHY_USE_EXEC_ENGINE`, `KHY_WIN_FORCE_UTF8`

---

## 三、文档命名规范

本仓库 `docs/` 下所有文档遵循统一命名格式，强制规则真源是 `[MGMT-STD-001]`（文档体系标准）。本节是**速查摘要**。

### 3.1 文件名格式

```
[阶段-类型-序号] 中文名.md
```

- **示例**：`[OPS-MAN-058] 环境开关与文档命名规范.md`、`[DESIGN-ARCH-012] 网关架构.md`。
- 方括号 `[]` 与编号是**强制**的；方括号后**一个空格**再接中文名。
- 中文名简洁达意，必要时用半角连字符 `-` 连接关键词（如 `ai-管理-访问与登录`）。

### 3.2 阶段（与编号目录一一对应）

| 阶段码 | 目录 | 含义 |
| --- | --- | --- |
| `INIT` | `01_INIT_启动/` | 项目启动 / 立项 |
| `DESIGN` | `03_DESIGN_设计/` | 架构与设计 |
| `IMPL` | `04_IMPL_实现/` | 实现 |
| `TEST` | `05_TEST_测试/` | 测试 |
| `DEPLOY` | `06_DEPLOY_部署/` | 部署 / 发布手册 |
| `OPS` | `07_OPS_运维/` | 运维与使用手册（本文所在） |
| `MGMT` | `08_MGMT_项目管理/` | 项目管理 / 标准 |

### 3.3 类型码

| 类型码 | 含义 |
| --- | --- |
| `PRD` | 需求 / 产品 |
| `ARCH` | 架构设计 |
| `MAN` | 手册 / 指南 / 清单（运维类最常用） |
| `RPT` | 报告 |
| `PLAN` | 计划 |
| `STD` | 标准 / 规范 |
| `OTHER` | 其它 |

### 3.4 序号

- 三位零填充、**全局按类型递增、不复用**（删除文档后其编号**作废不回收**，避免指代歧义）。
- 新建文档前，先看目标目录现有最高编号 +1（如 OPS-MAN 现有最高 057 → 新建用 058）。

### 3.5 索引文件（每个分类目录都有）

- 每个编号目录下有一份 `00_INDEX_<中文>-分类索引.md`（排序首位，目录唯一入口）。
- 全仓主入口：`docs/00_INDEX_文档索引.md`（含各目录文档计数与全量列表）。
- **新建/删除文档必须同步更新**：① 所在目录的分类索引「文件清单」表；② 主入口对应分区列表 + 顶部计数。

### 3.6 特殊（非编号）目录

少数目录不走 `[阶段-类型-序号]` 编号制，按用途直接命名：

- `传承/`——无 AI 也能维护的生存文档（如 `KHY-OS-传承书.md`、`紧急恢复卡片.md`）。
- `报告/`、`模板/`、`维护者/`、`设计模式/`——按各自约定命名。
- `.ai/`（仓库根，非 `docs/`）——机器生成的种子文档（`MAP.md`、`CONTEXT.yaml`、`GUARDS.md`、`SKELETON.auto.md`），由 `khy metadata refresh` + pre-commit 钩子确定性维护，**不手改**。

### 3.7 维护双击启动器命名（关联约定）

`maintenance/` 下的图形入口遵循 `维护-<动作中文名>.command`（macOS）/ `.bat`（Windows）/ `.sh`（Linux），由 `npm run maintenance:generate` 从 `maintenance/tasks.json` **自动生成**——新增维护任务改 `tasks.json` 后重跑生成，**不手写** `.command` 文件。

---

## 关联文档

- `docs/传承/KHY-OS-传承书.md`——无 AI 维护的运维操作（备份/回滚/发布/工具链）全流程。
- `[MGMT-STD-001]`——文档体系标准（命名规范强制真源）。
- `.ai/GUARDS.md`——红线与纯叶子契约（含本轮开关相关红线）。

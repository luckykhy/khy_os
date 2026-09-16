// Register the previously-unrecorded external rules into RULES-REGISTRY.json.
// constraint values are verbatim excerpts from the per-rule design docs
// (single source of truth), not paraphrases.
const fs = require('fs');
const path = require('path');

const REG = path.join(__dirname, '..', '..', 'docs', '_规范', 'RULES-REGISTRY.json');
const reg = JSON.parse(fs.readFileSync(REG, 'utf8'));

const D = 'docs/_规范';
const NOW = '2026-09-16';
const NO_POWER = '无新增权力：仅约束具体做法，不授予任何新权限。';

const R = [
  {
    id: 'SEC-001', name: '安全规范（安全头/输入验证/注入防护/日志脱敏）',
    domain: 'SECURITY', nature: '约束',
    scope: 'services/backend/src/routes/**, services/backend/src/middleware/**, services/ai-backend/**',
    priority: 'P0',
    trigger: '新增或修改路由、中间件、SQL 查询、日志输出时',
    constraint: '必需安全头（helmet + X-Content-Type-Options: nosniff、X-Frame-Options: DENY、X-XSS-Protection: 1; mode=block、Strict-Transport-Security: max-age=31536000; includeSubDomains、Content-Security-Policy: default-src \'self\'）；输入必须经 schema.validate({ abortEarly: false, stripUnknown: true }) 校验；SQL 必须参数化（sequelize.query 的 replacements），禁止模板字符串拼接；输出经 xss(input, { whiteList: {}, stripIgnoreTag: true, stripIgnoreTagBody: [\'script\'] }) 过滤；日志对 [\'password\',\'token\',\'apiKey\',\'secret\',\'authorization\'] 脱敏。',
    grants: NO_POWER,
    benefit: '四类最常见的 Web 攻击面（缺头/注入/反射 XSS/凭据泄露进日志）各有明确可检的写法，评审不必逐行判断「够不够安全」。',
    exception: '安全规范自身的豁免清单不在本文档；如需豁免须在 PR 中说明并走 SECURITY-002 不可绕过门。',
    version: '1.0.0 (2026-09-16)', formerly: null,
    ssot: `${D}/[DESIGN-SEC-001] 安全规范.md`, owner: 'security-team',
    gate: 'pr',
    paths: ['services/backend/src/routes/**', 'services/backend/src/middleware/**'],
    exec: { script: 'scripts/ci/check-security-headers.js', args: [], findings: ['helmet-missing', 'dangerously-set-inner-html', 'sql-injection', 'sensitive-log'] }
  },
  {
    id: 'NAM-001', name: '统一命名规范',
    domain: 'TOOLING', nature: '约束',
    scope: 'services/backend/src/**, platform/**, apps/ai-frontend/src/**, software/khyquant/frontend/src/**, platform/khy_platform/**',
    priority: 'P1',
    trigger: '新增或重命名变量、函数、类、文件、CSS 类名时',
    constraint: 'JS：变量/函数/参数/对象键/文件名/路径用 camelCase，模块级常量与枚举值用 SCREAMING_SNAKE_CASE，类名 PascalCase，私有属性 #camelCase；Python：模块/函数/变量/包名 snake_case，常量 UPPER_SNAKE_CASE，类名 PascalCase，私有 _camelCase；CSS 用 BEM：Block kebab-case、Element 双下划线、Modifier 双连字符、状态 .is-{state} / .has-{state}；禁止中英混写（get用户信息）、无共识缩写（usr/cfg）、类型前缀（strName/objData）、魔法字符串散落（应提为常量）、CSS 类名 PascalCase。',
    grants: NO_POWER,
    benefit: '跨 JS/Python/CSS 一套命名轴，grep 即可定位，不必在 review 里争论「该叫 user_id 还是 userId」。',
    exception: '存量文件不追溯；仅新增/修改的标识符需达标。',
    version: '1.0.0 (2026-09-16)', formerly: null,
    ssot: `${D}/[DESIGN-NAM-001] 统一命名规范.md`, owner: 'architecture-team',
    gate: 'pr',
    paths: ['services/backend/src/**', 'apps/ai-frontend/src/**', 'software/khyquant/frontend/src/**', 'platform/khy_platform/**'],
    exec: { script: 'scripts/ci/check-code-standards.js', args: [], findings: ['naming-camelcase', 'naming-snakecase', 'naming-bem', 'naming-ban'] }
  },
  {
    id: 'NAM-002', name: 'A2A 与 ACP 命名及术语规范',
    domain: 'COMMS', nature: '约束',
    scope: '全仓（代码 / 文档 / 环境变量 / 任务入口命名）',
    priority: 'P1',
    trigger: '任何文档、注释、提交信息或代码提到 A2A / ACP 时',
    constraint: '术语表为唯一真源：「标准 A2A」= Linux Foundation Agent2Agent（0.3.0，JSON-RPC 2.0 over HTTP + SSE，跨厂商跨网络）；「私有 ACP」= khy-os 自有进程内 agent 编排方言（1.0，单进程内）。NAM-A2A-1 全仓禁止 a2a.<域>.<动作> 形式方法名（a2a.discovery.register 等仅为设计草案遗留，实现中零存在），唯一豁免为文件前 40 行内 <!-- naming-guard: exempt 理由（≤60 字） --> 且理由必填、仅用于记录历史错误命名；NAM-A2A-2 标准 A2A 用 KHY_A2A_* 前缀且新增须登记进 scripts/ci/protocol-naming.json 的 a2aEnvAllowlist，私有方言新增一律用 KHY_ACP_*；NAM-A2A-3 描述私有 ACP 的文档标题与首段必须出现「私有」或「进程内」；NAM-A2A-4 标准 A2A 能力声明必须诚实（真源 agentCardSpec.IMPLEMENTED_CAPABILITIES），禁止先改卡片再补实现；NAM-A2A-5 私有方言的方法名/状态集/传输方式禁止出现在 Agent Card skills/capabilities/description 与 contracts/a2a/** 的 schema 中。',
    grants: NO_POWER,
    benefit: '外部读者不会被不存在的 API 误导；两套同名字面量协议被强制区分，避免把私有方言当成对外契约发布。',
    exception: '文件顶部（前 40 行内）<!-- naming-guard: exempt 理由（≤60 字） -->，理由必填，且仅允许用于「记录历史错误命名」。',
    version: '1.0.0 (2026-09-16)', formerly: null,
    ssot: `${D}/[DESIGN-NAM-002] A2A 与 ACP 命名及术语规范.md`, owner: 'architecture-team',
    gate: 'pr',
    paths: ['services/**', 'contracts/**', 'docs/**'],
    exec: { script: 'scripts/ci/check-protocol-naming.js', args: [], findings: ['NAM-A2A-1', 'NAM-A2A-2', 'NAM-A2A-3', 'NAM-A2A-5', 'acp-contract-drift'] }
  },
  {
    id: 'COM-001', name: '代码注释规范',
    domain: 'TOOLING', nature: '约束',
    scope: 'services/backend/src/**, platform/khy_platform/**, apps/ai-frontend/src/**',
    priority: 'P2',
    trigger: '新增或修改注释、公共 API、算法实现、安全关键代码时',
    constraint: '五原则：① 解释 WHY 不是 WHAT（代码本身自解释）；② 过时注释比没有更糟，代码变了注释没变就删除；③ 面向维护者；④ 所有注释用英文；⑤ 公共 API 必须有 JSDoc / docstring 类型签名。必须加注释的场景：公共 API（export / module.exports）、算法/数学公式（注释来源/推导）、非显式约束（如 // RS256 而非 HS256：服务间共享公钥）、性能敏感区（时间复杂度或内存特征）、安全关键（如 // Prevent prototype pollution）、兼容性 hack、TODO/FIXME/HACK。标记格式 {TAG}({scope}): {description} [@{owner}|{date}]；TODO 最长存活 1 个 sprint（2 周）过期自动升级为 FIXME；FIXME / HACK 必须在 PR 描述中说明修复计划或保留理由；DEPRECATED 必须标注移除版本，移除前须走 TOOL-001 废弃流程。',
    grants: NO_POWER,
    benefit: '注释成为可追踪的意图与债务记录，TODO 不会无限期潜伏，废弃路径有确定时限。',
    exception: '自解释的 getter/setter、标准模式（try/catch、forEach）、一行逻辑（注释超过逻辑本身）。',
    version: '1.0.0 (2026-09-16)', formerly: null,
    ssot: `${D}/[DESIGN-COM-001] 代码注释规范.md`, owner: 'architecture-team',
    gate: 'pr',
    paths: ['services/backend/src/**', 'platform/khy_platform/**', 'apps/ai-frontend/src/**'],
    exec: { script: 'scripts/ci/check-code-standards.js', args: [], findings: ['comment-tag-format', 'comment-todo-age'] }
  },
  {
    id: 'COMP-001', name: '代码复杂度规范',
    domain: 'TOOLING', nature: '约束',
    scope: 'services/backend/src/**, apps/ai-frontend/src/**, software/khyquant/frontend/src/**, platform/khy_platform/**',
    priority: 'P2',
    trigger: '新增或修改函数、文件、嵌套结构时',
    constraint: '圈复杂度：单函数 ≤10 通过、10-14 warning、15 error（PR 阻断）；函数长度：异步 ≤50 行、同步 ≤40 行、回调 ≤30 行，25-49 行为 warning；参数数量：≤3 通过、4-5 warning、6+ error；嵌套深度：≤2 通过、3-4 warning、5+ error；文件大小：JS 源文件 <400 行通过、400-600 warning、600+ error。行数 = 函数体 {} 之间的实际代码行，不含注释和空行。',
    grants: NO_POWER,
    benefit: '四条量化阈值替代「函数太长了」的主观争论，门禁可自动判定且阈值可追溯。',
    exception: '存量文件（3400+ 个文件）的复杂度超标不阻断合并；新增文件零违规，修改文件仅要求被修改的函数达标。',
    version: '1.0.0 (2026-09-16)', formerly: null,
    ssot: `${D}/[DESIGN-COMP-001] 代码复杂度规范.md`, owner: 'architecture-team',
    gate: 'pr',
    paths: ['services/backend/src/**', 'apps/ai-frontend/src/**', 'software/khyquant/frontend/src/**'],
    exec: { script: 'scripts/ci/check-code-standards.js', args: [], findings: ['complexity', 'max-lines-per-function', 'max-lines', 'max-depth', 'max-params'] }
  },
  {
    id: 'AUTH-002', name: 'Session 管理规范',
    domain: 'SECURITY', nature: '约束',
    scope: 'services/backend/src/routes/auth/**, services/backend/src/services/auth/**, services/ai-backend/**',
    priority: 'P0',
    trigger: '新增或修改登录、刷新令牌、Session 生命周期逻辑时',
    constraint: 'ACCESS_TOKEN_EXPIRY = \'15m\'，REFRESH_TOKEN_EXPIRY = \'7d\'；JWT 用 RS256、issuer: \'khy-auth\'、audience: \'khy-api\'；必选字段 sub/iat/exp/jti，禁止字段 password/apiKey/secret 等敏感信息；MAX_CONCURRENT_SESSIONS = 5（超额淘汰最早，管理员无限但可审计）；refresh_token 存 httpOnly cookie，sameSite: \'strict\'，secure: NODE_ENV === \'production\'，path: \'/api/v1/auth/refresh\'；refresh_token SameSite=strict HttpOnly，session_id SameSite=lax HttpOnly；Token 轮换（每次刷新更换 Refresh Token 防重放）、Revocation（DB 标记 + 黑名单 jti cache）、IP 绑定、UA 变化降级确认。禁止：localStorage 存 Refresh Token（XSS 可窃取）、Access Token 有效期 > 30 分钟、Refresh Token 永不过期、URL 传 Token、JWT Secret 硬编码（必须走 env / secrets manager）。',
    grants: NO_POWER,
    benefit: '令牌过期、算法、存储位置与轮换策略全部定量，审计只需核对常量而非推断意图。',
    exception: null,
    version: '1.0.0 (2026-09-16)', formerly: null,
    ssot: `${D}/[DESIGN-AUTH-002] Session 管理规范.md`, owner: 'security-team',
    gate: 'pr',
    paths: ['services/backend/src/routes/auth/**', 'services/backend/src/services/auth/**'],
    exec: { script: 'scripts/ci/check-auth-session.js', args: [], findings: ['jwt-algorithm', 'jwt-expiry', 'cookie-httponly', 'cookie-samesite', 'session-concurrency'] }
  },
  {
    id: 'CORS-001', name: 'CORS 跨域资源共享规范',
    domain: 'API', nature: '约束',
    scope: 'services/backend/src/**, services/ai-backend/**',
    priority: 'P0',
    trigger: '配置或修改跨域中间件时',
    constraint: '四原则：最小权限（只允许必要的来源/方法/请求头）、严格 SameSite（认证相关 Cookie 用 strict 或 lax）、预检缓存（Access-Control-Max-Age: 86400，24 小时）、凭证隔离（credentials: true 时不允许通配符 origin）。配置：app.options(\'*\', cors({ origin: getCorsOrigin(), methods: [\'GET\',\'POST\',\'PUT\',\'PATCH\',\'DELETE\',\'OPTIONS\'], credentials: true, maxAge: 86400 }))。credentials: true 时 origin 必须是明确域名，origin: \'*\' + credentials: true 被浏览器拒绝（CORS 协议禁止此组合）。',
    grants: NO_POWER,
    benefit: '把浏览器会直接拒绝的非法组合（通配符 + 凭证）在提交前拦住，避免线上才发现跨域不通。',
    exception: null,
    version: '1.0.0 (2026-09-16)', formerly: null,
    ssot: `${D}/[DESIGN-CORS-001] CORS 跨域资源共享规范.md`, owner: 'security-team',
    gate: 'pr',
    paths: ['services/backend/src/**', 'services/ai-backend/**'],
    exec: { script: 'scripts/ci/check-auth-session.js', args: [], findings: ['cors-wildcard-with-credentials', 'cors-origin-config'] }
  },
  {
    id: 'UPLOAD-001', name: '文件上传规范',
    domain: 'SECURITY', nature: '约束',
    scope: 'services/backend/src/routes/uploads/**, services/backend/src/services/**',
    priority: 'P0',
    trigger: '新增或修改上传端点、上传存储、上传读取逻辑时',
    constraint: '五原则：不信任客户端（服务端验证）、最小权限（不可执行、不可访问其他目录）、可追溯（唯一 ID + 完整元数据）、可清理（生命周期自动清理）、类型安全（严格内容类型检查防伪装）。ID 格式 <32-hex-chars>.<extension>，32 字符十六进制，由 crypto.randomBytes(16).toString(\'hex\') 生成，ID_RE = /^[a-f0-9]{32}$/，拒绝路径遍历。大小上限：图片 50MB、视频 500MB、音频 100MB、文档 50MB、代码 5MB、文本 10MB、压缩包 200MB、通用 100MB，各由 KHY_AI_UPLOAD_*_MAX_BYTES 覆盖。MIME 类型必须以魔数检测为准，不接受客户端声明。生产环境必须启用病毒扫描，检测到病毒立即删除，扫描超时视为通过。禁止：上传 .exe/.bat/.sh/.dll 等可执行文件、使用原始文件名存储、上传目录设为可执行、信任客户端 MIME 类型、返回服务器绝对路径。单文件 100MB、单请求 10 个文件、单请求总 500MB。',
    grants: NO_POWER,
    benefit: '上传链路的每一环（ID/大小/MIME/执行权限/病毒）都有可检阈值，路径遍历与伪装攻击无入口。',
    exception: '扫描超时视为通过（不阻塞上传流程）。',
    version: '1.0.0 (2026-09-16)', formerly: null,
    ssot: `${D}/[DESIGN-UPLOAD-001] 文件上传规范.md`, owner: 'security-team',
    gate: 'pr',
    paths: ['services/backend/src/routes/uploads/**', 'services/backend/src/services/**'],
    exec: { script: 'scripts/ci/check-upload-safety.js', args: [], findings: ['upload-safety-gate', 'upload-cleanup-gate'] }
  },
  {
    id: 'AUD-001', name: '审计日志规范',
    domain: 'SECURITY', nature: '约束',
    scope: 'services/backend/src/services/**, services/backend/src/routes/**',
    priority: 'P1',
    trigger: '涉及登录、权限变更、数据增删改、数据导出、配置变更等可审计事件时',
    constraint: '四原则：不可篡改（写入后不可修改/删除）、完整性（每条含 Who/When/What/Where/Result）、不可旁路（无论成功与否都记录）、保留期限（最少 1 年）。五字段全部必选：actor（谁）、action（做了什么，动词）、target（对什么，资源类型 + ID）、timestamp（ISO 8601）、result（success / failure / denied）。必须审计事件：登录成功/失败、登出、密码修改、权限变更、数据创建/修改/删除、数据导出、配置变更（均 INFO）；权限被拒绝、多次登录失败、批量删除（WARN）；系统启动/关闭（INFO）。实现：独立文件、DailyRotateFile(filename: \'logs/audit-%DATE%.log\', maxFiles: \'365d\', immutable: true)，文件系统级只读（chattr +i / icacls 移除写权限）。',
    grants: NO_POWER,
    benefit: '审计事件有固定五字段与固定清单，取证时不必逐处翻代码找「有没有记、记了什么」。',
    exception: null,
    version: '1.0.0 (2026-09-16)', formerly: null,
    ssot: `${D}/[DESIGN-AUD-001] 审计日志规范.md`, owner: 'security-team',
    gate: 'pr',
    paths: ['services/backend/src/services/**', 'services/backend/src/routes/**'],
    exec: { script: 'scripts/ci/check-data-lifecycle.js', args: [], findings: ['audit-five-fields'] }
  },
  {
    id: 'MIG-001', name: '数据迁移规范',
    domain: 'API', nature: '约束',
    scope: 'services/backend/src/migrations/**, services/backend/db/**',
    priority: 'P1',
    trigger: '新增或修改数据库迁移文件时',
    constraint: '五原则：每次变更一个迁移（一个文件只做一件事）、可回滚（必须带 down 函数）、不可逆向破坏（down 可能丢失数据时禁止自动回滚）、代码审查（迁移必须走 PR）、生产禁自动（生产不自动执行迁移，必须人工确认）。up/down 必须成对：createTable↔dropTable、addColumn↔removeColumn、removeColumn↔addColumn（带原定义）、addIndex↔removeIndex、changeColumn↔changeColumn（原定义）、renameColumn↔renameColumn（原名称）、bulkInsert↔bulkDelete（按条件）。禁止：迁移中删除列（可能丢失数据）、修改列类型（可能截断数据）、大表重命名（长时间锁表）、批量更新无 WHERE（不可回滚）。会丢数据的操作 down 改为数据备份。生产迁移必须：DBA 或资深开发者审批、低峰期执行、执行前自动备份、失败自动回滚。审查清单：命名符合规范（时间戳 + 描述）、up 和 down 都实现、down 能在测试环境正确恢复、不涉及不可逆数据丢失、大表分批处理、添加必要索引、迁移时间预估 <30 秒（大表除外）。',
    grants: NO_POWER,
    benefit: '回滚路径在提交前可验证，避免上线后只能手工修库；生产迁移不自动执行消除最危险的静默破坏。',
    exception: null,
    version: '1.0.0 (2026-09-16)', formerly: 'MIGR-001',
    ssot: `${D}/[DESIGN-MIG-001] 数据迁移规范.md`, owner: 'data-team',
    gate: 'pr',
    paths: ['services/backend/src/migrations/**', 'services/backend/db/**'],
    exec: { script: 'scripts/ci/check-data-lifecycle.js', args: [], findings: ['MIG-001'] }
  },
  {
    id: 'DLQ-001', name: '死信队列规范',
    domain: 'API', nature: '约束',
    scope: 'services/backend/src/services/**, services/backend/src/routes/**',
    priority: 'P2',
    trigger: '新增异步任务、消息处理、重试逻辑时',
    constraint: '四原则：不丢失（失败任务进 DLQ）、可重试（手动/自动）、可观察（DLQ 状态可见有告警）、有上限（防无限堆积）。RETRY_POLICY = { maxRetries: 3, baseDelay: 1000, maxDelay: 30000, backoffFactor: 2, jitter: true }。重试分类：网络超时、5xx、429 限流可重试；4xx 客户端错误与认证失败不重试（需人工介入）。流程：任务提交 → 执行失败 → 重试最多 3 次 → 仍失败进入 DLQ（status: exhausted）→ 人工/自动重试成功则删除，仍失败则永久失败（status: dead）并通知 + 清理。监控阈值：DLQ 堆积 > 100 持续 5 分钟 P1、同一任务重试 > 3 次 P2、DLQ 增长速率 > 10/min P2。',
    grants: NO_POWER,
    benefit: '失败任务不静默丢失，重试策略与告警阈值定量，事故定位从「消息去哪了」变成查 DLQ。',
    exception: '4xx 错误与认证失败不重试（重试无意义，需人工介入）。',
    version: '1.0.0 (2026-09-16)', formerly: null,
    ssot: `${D}/[DESIGN-DLQ-001] Dead Letter Queue 规范.md`, owner: 'data-team',
    gate: 'pr',
    paths: ['services/backend/src/services/**'],
    exec: { script: 'scripts/ci/check-data-lifecycle.js', args: [], findings: ['dlq-retry-policy'] }
  },
  {
    id: 'IR-001', name: '事件响应规范',
    domain: 'PROCESS', nature: '约束',
    scope: 'docs/07_OPS_运维/**, 值班与事故流程',
    priority: 'P2',
    trigger: '发生生产事故或安全事件时',
    constraint: '分级：P0 紧急（服务完全不可用或数据泄露，响应 ≤15 分钟，30 分钟无人升级）；P1 高危（核心功能降级，响应 ≤1 小时，2 小时无人升级）；P2 中危（非核心功能故障，响应 ≤4 小时，8 小时无人升级）；P3 低危（信息性，响应 ≤24 小时，不升级）。分流人员必须在 15 分钟内完成：确认事件真实性（排除误报）、定级、指派 Incident Commander、建立事件频道。每个 P0/P1 事件必须在 5 个工作日内完成 Postmortem。升级路径：P0 On-call → 15min 无响应 → IC → 30min 无响应 → 维护者（全部）；P1 为 2h/4h；P2 为 8h 到 IC；P3 不升级。升级触发条件：超时未响应、当前 On-call 确认无法处理、影响面超出预期（P2 → P1）、发现数据泄露（任何 → P0）。',
    grants: NO_POWER,
    benefit: '事故分级、响应时限与升级路径全部定量，值班交接不靠记忆判断「该不该叫上级」。',
    exception: null,
    version: '1.0.0 (2026-09-16)', formerly: null,
    ssot: `${D}/[DESIGN-IR-001] 事件响应规范.md`, owner: 'ops-team',
    gate: 'advisory',
    paths: ['docs/07_OPS_运维/**'],
    exec: { script: 'scripts/ci/check-incident-dr.js', args: [], findings: ['incident-gate'] }
  },
  {
    id: 'DR-001', name: '灾备规范',
    domain: 'PROCESS', nature: '约束',
    scope: 'docs/07_OPS_运维/**, 基础设施与备份流程',
    priority: 'P2',
    trigger: '规划服务容灾、备份验证或故障切换时',
    constraint: '五原则：RTO/RPO 可量化（每服务有明确目标）、备份即代码（脚本版本化可重复执行）、定期演练（至少每季度一次）、数据主权（用户数据可导出可迁移不锁定）、渐进式恢复（核心优先）。RPO：AI 网关 5 分钟、后端 API 15 分钟、数据库主库 15 分钟（基于 WAL 归档）、数据库从库实时（流复制）、对象存储 1 小时。备份验证：创建后 24 小时内必须验证可恢复性、每月至少一次完整恢复演练、备份脚本必须幂等。数据库故障转移：主库心跳不可用 >30s 检测 → 预计恢复 <5min 则等待，>5min 则停止写入主库、提升从库、更新连接字符串、通知服务重连、旧主库恢复后作为从库接入。演练类型：桌面推演每月、部分演练每季度（单服务实际切换限流）、全量演练每半年。',
    grants: NO_POWER,
    benefit: '每个服务有可核对的 RTO/RPO 数字与故障转移步骤，灾备演练不再是「纸面文档」。',
    exception: null,
    version: '1.0.0 (2026-09-16)', formerly: null,
    ssot: `${D}/[DESIGN-DR-001] 灾备规范.md`, owner: 'ops-team',
    gate: 'advisory',
    paths: ['docs/07_OPS_运维/**'],
    exec: { script: 'scripts/ci/check-incident-dr.js', args: [], findings: ['dr-gate', 'backup-verify-gate'] }
  },
  {
    id: 'BACKUP-001', name: '备份恢复规范',
    domain: 'PROCESS', nature: '约束',
    scope: 'docs/07_OPS_运维/**, 备份作业与保留策略',
    priority: 'P2',
    trigger: '新增或修改备份作业、恢复流程、保留策略时',
    constraint: '四原则：完整性、可恢复性、及时性、安全（备份数据加密存储）。备份时间表：全量备份每天 02:00 保留 30 天、增量备份每小时保留 7 天、配置文件每天 03:00 保留 90 天。恢复目标 RTO < 1 小时、RPO < 1 小时。验证策略：完整性检查每次备份后、恢复测试每周、数据一致性每月。保留策略：全量备份 30 天、增量备份 7 天、配置文件 90 天、日志文件 30 天（自动轮转）。',
    grants: NO_POWER,
    benefit: '备份频率、保留时长与验证周期定量，恢复演练有固定节拍而非临场决定。',
    exception: null,
    version: '1.0.0 (2026-09-16)', formerly: null,
    ssot: `${D}/[DESIGN-BACKUP-001] 备份恢复规范.md`, owner: 'ops-team',
    gate: 'advisory',
    paths: ['docs/07_OPS_运维/**'],
    exec: { script: 'scripts/ci/check-incident-dr.js', args: [], findings: ['dr-gate'] }
  },
  {
    id: 'NOTIFY-001', name: '通知与邮件规范',
    domain: 'API', nature: '约束',
    scope: 'services/backend/src/services/notifications/**, services/backend/src/routes/notifications/**',
    priority: 'P2',
    trigger: '新增或修改邮件、Webhook、站内通知投递逻辑时',
    constraint: '邮件投递保障：超时 10 秒、重试 3 次（指数退避 1s/2s/4s）、最终失败退入 DLQ、批量限制 100/分钟（防被邮件服务商限流）。必须提供 List-Unsubscribe 头（同时给 URL 与 mailto: 形式）。Webhook 签名验证用 crypto.createHmac(\'sha256\', secret).update(payload).digest(\'hex\') 配合 crypto.timingSafeEqual 防时序攻击。Webhook 重试：5 次，间隔 1m/5m/30m/2h/6h，超时 10s，User-Agent Khy-Webhook/1.0；连续 5 次失败暂停 webhook 并通知用户，4xx 不重试（配置错误需人工处理），5xx/超时按退避重试。审计：投递记录保留 180 天，安全通知必须记录不可删除，投递失败超过 3 次触发告警。优先级：系统通知 P1、安全通知 P0、任务通知 P2、营销通知 P3、Webhook P2。',
    grants: NO_POWER,
    benefit: '投递失败有确定重试上限与死信路径，安全通知不可退订，合规要求（List-Unsubscribe）不遗漏。',
    exception: '4xx 错误不重试（配置错误需人工处理）。',
    version: '1.0.0 (2026-09-16)', formerly: null,
    ssot: `${D}/[DESIGN-NOTIFY-001] 通知与邮件规范.md`, owner: 'ops-team',
    gate: 'advisory',
    paths: ['services/backend/src/services/notifications/**', 'services/backend/src/routes/notifications/**'],
    exec: { script: 'scripts/ci/check-notify-webhook.js', args: [], findings: ['notify-gate'] }
  },
  {
    id: 'OPS-002', name: 'Graceful Shutdown 规范',
    domain: 'RUNTIME', nature: '约束',
    scope: 'services/backend/src/**, services/ai-backend/**',
    priority: 'P2',
    trigger: '新增或修改服务进程启动、信号处理、连接管理逻辑时',
    constraint: '五原则：信号优先（SIGTERM 有序关闭、SIGKILL 强制终止不做清理）、停止接受新请求（先关监听端口）、Drain 存量连接（带超时）、数据持久化优先（内存数据先落盘再释放连接）、关闭顺序（子进程 → 工作线程 → 数据库连接 → 定时器）。信号映射：SIGTERM（docker stop/kill/systemctl stop）有序关闭；SIGINT（Ctrl+C）有序关闭；SIGQUIT 有序关闭 + core dump；SIGKILL 强制终止跳过清理；SIGHUP 热重载不关闭。SHUTDOWN_TIMEOUT = 30_000。标准序列：1 停止监听端口（server.close()）→ 2 Drain 活跃连接（30s 超时）→ 3 持久化内存数据 → 4 停止子进程 → 5 关闭数据库连接池 → 6 关闭 Redis/缓存连接 → 7 清理定时器 → process.exit(0)。验证：活跃连接为 0、无待写数据、无运行中 worker。',
    grants: NO_POWER,
    benefit: '重启不再丢请求或半写数据，关闭顺序可核对，超时时长有确定上限而非无限等待。',
    exception: 'SIGKILL（kill -9）强制终止跳过清理；SIGHUP 终端关闭仅热重载不关闭。',
    version: '1.0.0 (2026-09-16)', formerly: null,
    ssot: `${D}/[DESIGN-OPS-002] Graceful Shutdown 规范.md`, owner: 'ops-team',
    gate: 'advisory',
    paths: ['services/backend/src/**', 'services/ai-backend/**'],
    exec: { script: 'scripts/ci/check-ops-health.js', args: [], findings: ['sigterm-handler'] }
  },
  {
    id: 'OPS-003', name: 'Health Check 规范',
    domain: 'API', nature: '约束',
    scope: 'services/backend/src/routes/**, services/ai-backend/src/routes/**',
    priority: 'P2',
    trigger: '新增或修改健康检查端点、依赖探测逻辑时',
    constraint: '四原则：三端点分离（/health 存活、/ready 就绪、/live 依赖检查）、轻量快速、状态精确（不返回 "OK" 掩盖实际故障）、分级返回。/health 检查进程是否存活、内存是否可用，超时 <100ms，响应码 200 始终（存活不代表就绪）；/ready 检查所有依赖是否可达、数据连接是否正常，超时 <5s，200 就绪 / 503 未就绪；/live 检查数据库、Redis、外部 API、文件系统，超时 <10s，结果缓存 30s。状态枚举：ok 200、degraded 200、ready 200、not_ready 503、unhealthy 503。依赖探测：SQLite/PostgreSQL SELECT 1 超时 2s 降级为缓存模式、Redis PING 超时 1s 跳过缓存直连 DB、文件系统 access(dataDir, R_OK) 超时 500ms 报错、外部 AI API 轻量 ping 超时 3s 标记 degraded、磁盘空间 statvfs 超时 500ms 标记 degraded。告警：/ready 返回 503 >30s 为 P0、/health degraded >60s 为 P1、依赖 responseTime >5000ms 为 P1、/ready 间歇性 503 为 P2。',
    grants: NO_POWER,
    benefit: '存活/就绪/依赖三种信号分离，负载均衡器与监控各有明确依据，不靠单一 OK 掩盖部分故障。',
    exception: '健康检查端点不需要认证（负载均衡器需访问）；端点单独限流，免于常规限流。',
    version: '1.0.0 (2026-09-16)', formerly: null,
    ssot: `${D}/[DESIGN-OPS-003] Health Check 规范.md`, owner: 'ops-team',
    gate: 'advisory',
    paths: ['services/backend/src/routes/**', 'services/ai-backend/src/routes/**'],
    exec: { script: 'scripts/ci/check-ops-health.js', args: [], findings: ['health-endpoints'] }
  },
  {
    id: 'FF-001', name: 'Feature Flag 功能开关规范',
    domain: 'API', nature: '约束',
    scope: 'services/backend/src/**, apps/ai-frontend/src/**',
    priority: 'P2',
    trigger: '新增或移除功能开关、灰度发布逻辑时',
    constraint: '四原则：默认关闭（新功能默认 false，渐进开启）、可回滚（关闭立即生效无需回滚代码）、可审计（变更有日志有时间有操作人）、自动清理（功能稳定后及时移除，最长存活 3 个月，过期自动升级为 FIXME）。生命周期：创建（默认 off，必须有移除计划）→ 灰度 7-14 天（10% → 50% → 100%）→ 全量 7 天（on 状态稳定运行）→ 移除（代码清理，开关删除）。配置结构含 enabled、rollout { type, value }、createdAt、expiresAt、owner。变更必须记录 flag、oldValue、newValue、actor、timestamp。开关级别：global、percentage（按用户哈希灰度）、whitelist、cohort。',
    grants: NO_POWER,
    benefit: '开关有确定过期时限与移除计划，灰度不会永久留存在代码里变成僵尸配置。',
    exception: null,
    version: '1.0.0 (2026-09-16)', formerly: null,
    ssot: `${D}/[DESIGN-FF-001] Feature Flag 功能开关规范.md`, owner: 'platform-team',
    gate: 'advisory',
    paths: ['services/backend/src/**', 'apps/ai-frontend/src/**'],
    exec: { script: 'scripts/ci/check-ai-gateway.js', args: [], findings: ['feature-flag-default-off', 'feature-flag-expiry'] }
  },
  {
    id: 'GW-002', name: 'AI 模型降级与熔断规范',
    domain: 'API', nature: '约束',
    scope: 'services/backend/src/services/gateway/**',
    priority: 'P1',
    trigger: '新增或修改 AI 适配器调用、降级链、熔断逻辑时',
    constraint: '四原则：可用性优先、成本可控、透明告知（前端显示「正在使用备选模型」）、可配置。降级链：P0 主力模型 → 超时/错误率超阈值 → P1 备选 → 同样失败 → P2 兜底 → 全部不可用 → P3 规则回复（非 AI，保证服务可用）。熔断配置 failureThreshold: 50%（60s 窗口）、minSampleSize: 10、openDuration: 30_000、halfOpenMaxCalls: 5。触发条件：主模型连续 3 次超时切换到 P1；P1 错误率 >50% 熔断切换到 P2；P2 也失败触发 P3；熔断器 OPEN 直接降级下一级。超时：P0 30s、P1 15s、P2 10s。成本熔断：单次请求成本 >$1 降级到更便宜模型、日累计 >$50 切换到 P2、月累计 >$500 触发 P3 规则回复 + 告警。',
    grants: NO_POWER,
    benefit: 'AI 不可用时仍有确定降级路径保证服务可用，成本上限定量防止账单失控。',
    exception: null,
    version: '1.0.0 (2026-09-16)', formerly: null,
    ssot: `${D}/[DESIGN-GW-002] AI 模型降级与熔断规范.md`, owner: 'platform-team',
    gate: 'pr',
    paths: ['services/backend/src/services/gateway/**'],
    exec: { script: 'scripts/ci/check-ai-gateway.js', args: [], findings: ['fallback-chain', 'circuit-breaker-config'] }
  },
  {
    id: 'PROMPT-001', name: 'Prompt Engineering 规范',
    domain: 'API', nature: '约束',
    scope: 'services/backend/src/services/**, services/backend/src/prompts/**',
    priority: 'P2',
    trigger: '新增或修改 Prompt 模板时',
    constraint: '五原则：版本化（每个 Prompt 模板有版本号，变更可追溯）、参数化（不硬编码业务数据，用变量占位）、可测试（模板可独立评估输出质量）、安全边界（防注入）、成本可控（有长度上限）。注册结构 prompts/index.js：{ version, template: readFile(\'templates/...\'), params, maxTokens, createdAt }。禁止硬编码用户数据（You are helping user zhangsan with strategy ABC-123 错误；You are helping user {{userName}} with strategy {{strategyName}} 正确）。长度上限：System Prompt 2000 字符、User Prompt 4000、Tool Description 500/tool、总输入 6000（input tokens 预算）。注入防护：直接注入靠参数隔离（用户输入不进 System Prompt）、间接注入靠对外部数据消毒并标记来源、越狱靠 System Prompt 加护栏指令。变更步骤：1 修改模板文件、2 运行回归测试、3 人工评估 3 组代表性输入、4 提交时注明版本 bump、5 发布时保存版本快照。',
    grants: NO_POWER,
    benefit: 'Prompt 变成可版本化、可回归测试的资产而非散落的字符串，注入面与 token 成本都有上限。',
    exception: null,
    version: '1.0.0 (2026-09-16)', formerly: null,
    ssot: `${D}/[DESIGN-PROMPT-001] Prompt Engineering 规范.md`, owner: 'platform-team',
    gate: 'advisory',
    paths: ['services/backend/src/services/**', 'services/backend/src/prompts/**'],
    exec: { script: 'scripts/ci/check-ai-gateway.js', args: [], findings: ['prompt-versioning', 'prompt-hardcode'] }
  },
  {
    id: 'FE-004', name: '前端 CSS 与样式架构规范',
    domain: 'TOOLING', nature: '约束',
    scope: 'apps/ai-frontend/src/**, software/khyquant/frontend/src/**, platform/packages/ui-shared/**',
    priority: 'P2',
    trigger: '新增或修改样式文件、CSS 变量、组件样式时',
    constraint: '五原则：令牌优先（颜色/圆角/阴影全部走 var(--khy-*)，禁止硬编码值）、分层组织（Base → Tokens → Layout → Components → Utilities → Overrides）、就近原则（组件样式 scoped，全局样式仅放布局/令牌/动画）、无 !important（通过特异性顺序管理优先级）、移动优先（默认移动端样式，min-width 渐进增强）。令牌命名 --khy-{category}-{variant}，分类：--khy-bg-*、--khy-text-*、--khy-border-*、--khy-primary-*、--khy-{status}（success/warning/danger）、--khy-radius-*、--khy-shadow-*、--khy-font-*。双主题强制：任何颜色/阴影 token 必须同时定义浅色（:root）与深色（html.dark），仅定义浅色会在暗色下静默失效。BEM：.block__element--modifier，.is-state 状态类、.has-child 子元素指示。流式值优先 clamp() 而非媒体查询（padding: clamp(12px, 2vw, 32px)）。必须支持 prefers-reduced-motion: reduce 下关闭动画。硬编码 hex 收敛用 npm run frontend:fix-colors 扫描后替换为 var(--khy-*)。',
    grants: NO_POWER,
    benefit: '暗色模式不会静默失效，颜色/阴影收敛到统一令牌后可批量替换，响应式用流式值减少断点维护。',
    exception: null,
    version: '1.0.0 (2026-09-16)', formerly: null,
    ssot: `${D}/[DESIGN-FE-004] 前端 CSS 与样式架构规范.md`, owner: 'frontend-team',
    gate: 'advisory',
    paths: ['apps/ai-frontend/src/**', 'software/khyquant/frontend/src/**', 'platform/packages/ui-shared/**'],
    exec: { script: 'scripts/ci/check-frontend-design-tokens.js', args: [], findings: ['css-token', 'bem-naming', 'dual-theme'] }
  },
  {
    id: 'MOD-004', name: '治理总纲板块入口',
    domain: 'DOCS', nature: '约束',
    scope: 'docs/03_DESIGN_设计/[DESIGN-ARCH-070] 治理总纲与可执行规则.md',
    priority: 'P2',
    trigger: '新增治理板块、调整总纲结构时',
    constraint: '治理总纲必须提供六个板块的规则入口，缺失任一板块判违规；总纲将既有规则收拢为 MOD、MEM、TOOL、ACP、API、BORROW、RUNTIME、PROCESS、SECURITY、DOCS 十个可检索板块，与 [MGMT-STD-008] §3 的十大域一一对应，不替代各自单一真源。',
    grants: NO_POWER,
    benefit: '十条板块入口保证治理总纲是导航而非替代，读者能定位到每条规则的语义真源。',
    exception: null,
    version: '1.0.0 (2026-09-16)', formerly: 'GOV-MOD-004',
    ssot: 'docs/03_DESIGN_设计/[DESIGN-ARCH-070] 治理总纲与可执行规则.md', owner: 'architecture-team',
    gate: 'pr',
    paths: ['docs/03_DESIGN_设计/**'],
    exec: { script: 'scripts/ci/check-gov-rules.js', args: [], findings: ['GOV-MOD-004'] }
  }
];

const existing = new Set(reg.rules.map((r) => r.id));
let added = 0;
const skipped = [];
for (const entry of R) {
  if (existing.has(entry.id)) { skipped.push(entry.id); continue; }
  reg.rules.push(entry);
  added += 1;
}

reg.meta.updated = NOW;
reg.meta.ruleCount = reg.rules.length;
reg.meta.note = (reg.meta.note || '') +
  ` [2026-09-16] 补登 ${added} 条此前由检查器执行但登记表未收录的外部规则（constraint 逐条取自各规则设计文档原文）；` +
  '此前盲区见 scripts/ruleguard/lib/externalRules.js。';

fs.writeFileSync(REG, JSON.stringify(reg, null, 2) + '\n', 'utf8');
console.log(`added=${added} skipped=${skipped.join(',') || 'none'} total=${reg.rules.length}`);

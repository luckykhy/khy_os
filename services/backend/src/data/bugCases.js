'use strict';

/**
 * bugCases.js — Bug 修复案例库
 *
 * 结构化案例索引，服务于两个目标：
 * 1. 学习课程第 10 层 — 交互式教学
 * 2. 小模型 few-shot 范例 — input/reasoning/output 三元组
 *
 * 每个案例的 detailDoc 指向 docs/ 下的完整修复文档（人类深度阅读用）。
 */

const BUG_CASES = [
  // ── 1. ISO 构建误删宿主 /dev ──────────────────────────────────────
  {
    id: 'bind_mount_rm',
    title: 'ISO 构建误删宿主 /dev',
    severity: 'critical',
    tags: ['linux', 'mount', 'cleanup', 'safety', 'chroot'],
    symptom: 'ISO 构建脚本中断后，rm -rf 通过活跃的 bind-mount 删除了宿主 /dev/null，终端无法打开 PTY',
    rootCause: 'cleanup() 未用 mountpoint -q 检查挂载状态就执行 rm -rf，且 bind-mount 未设 --make-rslave 导致删除操作穿透到宿主',
    fix: '1) 添加 --make-rslave 防止挂载事件传播\n2) devpts 加 newinstance 参数隔离\n3) rm -rf 前用 mountpoint -q 前置检查',
    files: ['scripts/alpine/build-khy-os-iso.sh'],
    detailDoc: 'docs/08_MGMT_项目管理/[MGMT-OTHER-002] 事后分析-终端崩溃-2026-05-09.md',
    lesson: '永远不要在可能包含 bind-mount 的目录树上执行 rm -rf，必须先验证挂载状态',
    example: {
      input: '用户报告：ISO 构建中断后终端报 "Failed to open PTY: No such file or directory"',
      reasoning: '终端依赖 /dev/pts → 检查 /dev 状态 → 发现 /dev/null 被删成普通文件 → 追溯到构建脚本 cleanup() 中的 rm -rf → 发现 bind-mount 未解除时删除穿透到宿主 → 根因是缺少 mountpoint 检查和 mount 隔离参数',
      output: '紧急恢复：sudo mknod /dev/null c 1 3 && chmod 666 /dev/null\n代码修复：cleanup() 加 mountpoint -q 检查 + mount --make-rslave + devpts 加 newinstance',
    },
  },

  // ── 2. 剪贴板粘贴自动发送 ─────────────────────────────────────────
  {
    id: 'clipboard_paste_autosend',
    title: '剪贴板粘贴内容被自动发送',
    severity: 'high',
    tags: ['cli', 'repl', 'readline', 'ux', 'event-loop'],
    symptom: '在 REPL 中粘贴多行文本时，内容被自动发送给 AI，用户无法编辑或添加提示词',
    rootCause: '1) Burst 检测中 elapsed===0 时条件 (0>0) 为 false 导致永远检测不到粘贴\n2) finally 块中的 _busyQueueAccum flush 绕过了粘贴保护\n3) 状态机缺少 PASTING 状态',
    fix: '改用 _burstLastCharAt > 0 判断前序字符存在性，添加 PASTING 状态机，finally 块中延迟 flush 等待粘贴结束',
    files: ['backend/src/cli/repl.js'],
    detailDoc: 'docs/04_IMPL_实现/[IMPL-RPT-016] 剪贴板粘贴修复.md',
    lesson: 'Node.js 同一 event-loop tick 内 Date.now() 返回相同值，时间差判断必须考虑 elapsed===0 的边界情况',
    example: {
      input: '用户反馈：粘贴代码到 REPL 后还没来得及添加说明就被自动发送了',
      reasoning: '粘贴时所有字符在同一 event-loop tick 到达 → Date.now() 返回相同值 → elapsed=0 → (0>0) 为 false → burst 检测失败 → 每个字符被当成独立键入 → readline 逐行触发 line 事件 → 自动提交',
      output: '修复 burst 检测条件为 (_burstLastCharAt > 0 && elapsed <= threshold)，引入 PASTING 状态延迟提交，finally 块 flush 加 nextTick 延迟',
    },
  },

  // ── 3. 网关状态命令超时 + REPL 边框消失 ───────────────────────────
  {
    id: 'gateway_timeout_frame',
    title: '网关状态命令挂死 + REPL 输入框边框消失',
    severity: 'high',
    tags: ['gateway', 'timeout', 'repl', 'promise', 'ui'],
    symptom: '/gateway 命令阻塞 30-45 秒无响应；REPL 输入区域的 Unicode 边框在某些终端消失',
    rootCause: '1) handleGatewayStatus() 无全局截止时间，最慢适配器决定总耗时\n2) REPL 边框使用了部分终端不支持的 Unicode box-drawing 字符',
    fix: '1) 添加 GATEWAY_STATUS_TIMEOUT_MS (20s) 全局超时，Promise.race 包裹每个适配器测试\n2) 边框字符降级为 ASCII 兼容方案',
    files: ['backend/src/cli/handlers/gateway.js', 'backend/src/services/gateway/aiGateway.js', 'backend/src/cli/repl.js'],
    detailDoc: 'docs/04_IMPL_实现/[IMPL-RPT-021] 网关超时与帧修复.md',
    lesson: '并行请求必须有全局截止时间，不能让最慢的一个拖住整体；UI 字符要考虑终端兼容性',
    example: {
      input: '用户执行 /gateway 后等了 40 秒才有响应，有时直接无响应',
      reasoning: '16 个适配器并行测试 → 但无全局 deadline → 某个适配器 proxy 连接超时 12s + 重试退避 15s → 单适配器耗时 27s → 整体等最慢的 → 超 30s\n解法：Promise.race 加全局 20s 截止，超时适配器标记 timeout 而非无限等待',
      output: '添加 GATEWAY_STATUS_TIMEOUT_MS=20000，Promise.race([adapterTest, timeoutPromise]) 包裹每个适配器；超时的标记 connectivity.error="global timeout"',
    },
  },

  // ── 4. 守护进程端口冲突 ───────────────────────────────────────────
  {
    id: 'daemon_port_conflict',
    title: '双启动路径导致守护进程端口冲突',
    severity: 'high',
    tags: ['daemon', 'port', 'architecture', 'discovery', 'race-condition'],
    symptom: '两条独立的 daemon 启动路径都绑定 9090 端口，后启动的自增到 9091+，但下游消费者不知道实际端口变了',
    rootCause: 'aiManagementServer 内置端口自增重试 (9090→9099)，但 Vite dev-server 代理、daemonClient、CLI 都硬编码了 9090',
    fix: '统一端口发现机制：daemon 启动后写入 PID 文件记录实际端口，下游消费者从 PID 文件读取而非硬编码',
    files: ['backend/src/services/daemonEntry.js', 'backend/scripts/ai-manage-daemon.js', 'backend/src/services/aiManagementServer.js'],
    detailDoc: 'docs/04_IMPL_实现/[IMPL-RPT-017] 守护进程端口发现修复.md',
    lesson: '动态端口绑定必须配合端口发现/注册机制，否则下游永远对不上；消除硬编码端口是第一原则',
    example: {
      input: '用户报告：gateway manage 面板打不开，但 daemon 进程确实在运行',
      reasoning: '检查进程列表 → daemon 运行在 9091 → 但前端代理请求 9090 → 404\n追溯：路径 A 先占 9090，路径 B 自增到 9091 → 但 vite.config.js 代理和 daemonClient 硬编码 9090\n根因：缺少端口发现机制',
      output: '1. daemon 启动后写 ~/.khyquant/daemon.pid 包含 {pid, port, startedAt}\n2. 所有下游从 pid 文件读取实际端口\n3. vite.config.js 改为动态读取\n4. 重复启动检测 + 互斥锁',
    },
  },

  // ── 5. KHY/Claude 认证冲突 ────────────────────────────────────────
  {
    id: 'auth_conflict',
    title: 'KHY 启动注入 API key 导致 Claude Code 401',
    severity: 'critical',
    tags: ['auth', 'settings', 'bootstrap', 'conflict', 'security'],
    symptom: '每次 khy 启动后 Claude Code 报 401 Invalid token 或 Auth conflict 双凭证冲突',
    rootCause: 'khy_platform/_bootstrap.py 在启动时把 khy- 前缀的 API key 写入 ~/.claude/settings.json 的 env.ANTHROPIC_API_KEY，覆盖了用户自己的 Anthropic OAuth token',
    fix: '三层检测：1) 检查 shell env 是否已有 ANTHROPIC_API_KEY 2) 检查 settings.json 是否已有非 khy- 前缀 key 3) 仅在两者都空时才注入',
    files: ['khy_platform/_bootstrap.py', 'khy_platform/cli.py'],
    detailDoc: 'docs/04_IMPL_实现/[IMPL-RPT-013] khy-claude-认证冲突修复.md',
    lesson: '不可盲写第三方工具的配置文件，必须先检查现有状态；凭证注入必须是非破坏性的',
    example: {
      input: '用户报告：运行 khy 后 claude 命令全部 401',
      reasoning: 'claude 用的是 OAuth token → khy 启动时 bootstrap 往 settings.json 写了 ANTHROPIC_API_KEY → claude 检测到同时存在 token 和 key → 报冲突 → 即使不冲突，khy 的 key 也不是合法 Anthropic key → 401',
      output: '修复 _bootstrap.py：添加三层检查 (shell env / settings.json / key prefix)，仅在无冲突时注入；已有 key 时 skip 并打印警告',
    },
  },

  // ── 6. 工具调用死循环 (rawMessages 格式错误) ──────────────────────
  {
    id: 'tool_use_infinite_loop',
    title: '代理服务器导致工具调用死循环',
    severity: 'critical',
    tags: ['proxy', 'tool-calling', 'format', 'agentic-loop', 'canonical'],
    symptom: 'Claude Code 通过 KHY 代理调用模型时，模型不停说"让我查看桌面"却不真正执行工具，或执行后无限重复',
    rootCause: 'proxyServer.js 传递 rawMessages 时用了 canonical.messages（内部规范格式），该格式把 tool_use/tool_result 从 content 数组提取到顶层 toolCalls/toolResults，导致下游适配器在 content 中找不到工具调用块',
    fix: '改为 rawMessages: body.messages（原始请求体中的 messages），保留完整 Anthropic content 数组格式',
    files: ['backend/src/services/gateway/proxyServer.js'],
    detailDoc: null,
    lesson: '数据格式转换是 bug 高发区 — 在传递消息给下游时必须确认目标期望的格式，不能混用内部/外部格式',
    example: {
      input: '用户在 Claude Code 中要求"帮我整理桌面"，模型反复声称在操作但工具始终不执行',
      reasoning: '模型发 tool_use → 代理转发 → 执行结果作为 tool_result 回传 → 但代理把 canonical 格式传给适配器 → canonical 中 content 数组无 tool_result 块（被提到 toolResults 顶层字段） → 适配器 extractAnthropicToolUses(msg.content) 找不到 → 模型收不到执行结果 → 重复发 tool_use',
      output: '修复 proxyServer.js: rawMessages 从 canonical.messages 改为 body.messages，保留原始 Anthropic 格式中 content 数组内的 tool_use/tool_result 块',
    },
  },

  // ── 7. Trae 适配器官方登录态检测失败 ─────────────────────────────
  {
    id: 'trae_scan_blind_spot',
    title: 'Trae 适配器无法检测官方登录态',
    severity: 'medium',
    tags: ['adapter', 'trae', 'encryption', 'reverse-engineering', 'windows'],
    symptom: '用户已在 Trae IDE 中登录，但 KHY 适配器报"未检测到 Trae token"，且端点列表包含非 API 的 HTML 页面地址',
    rootCause: '1) 仅识别 Nirvana 换号软件的 token，忽略了官方 iCube 登录态（base64 加密 blob）\n2) 无法区分加密方案（DPAPI/safeStorage/Chromium v10-v11）\n3) 端点探活未检测 Content-Type，把返回 HTML 的地址也加入候选',
    fix: '1) 新增 traeOfficialArtifacts.js 扫描 iCube storage\n2) 识别前缀 74630510 为 safeStorage 加密\n3) 端点探活检查 response Content-Type 过滤非 JSON 响应',
    files: ['backend/src/services/gateway/adapters/traeAdapter.js', 'backend/src/services/gateway/adapters/traeOfficialArtifacts.js'],
    detailDoc: 'docs/04_IMPL_实现/[IMPL-RPT-014] trae-适配器-官方扫描修复-2026-05-25.md',
    lesson: '适配第三方工具时，不能只适配第三方插件的状态，还要覆盖官方原生登录路径；网络探活必须验证响应内容类型',
    example: {
      input: '用户已登录 Trae IDE 但 KHY 报告"未检测到 Trae token"',
      reasoning: '检查 token 来源 → 当前只扫描 Nirvana → 但用户用的是官方登录 → 需要扫描 iCube storage → 发现 base64 blob 前缀 74630510 是 safeStorage 加密 → 即使无法解密也能确认登录态 → 同时发现端点列表含 HTML 页面',
      output: '1. 新增 iCube storage 扫描（storage.json + state.vscdb 双路径）\n2. 加密方案识别：前缀 74630510 = safeStorage\n3. 端点探活加 Content-Type 检查，过滤非 JSON',
    },
  },
];

/**
 * 导出所有案例的 few-shot 范例为 JSONL 格式
 * 适合小模型微调或 in-context learning
 */
function exportBugCasesForTraining() {
  return BUG_CASES.map(c => JSON.stringify({
    id: c.id,
    tags: c.tags,
    input: c.example.input,
    reasoning: c.example.reasoning,
    output: c.example.output,
    lesson: c.lesson,
  })).join('\n');
}

/**
 * 按 ID 查找案例
 */
function getBugCase(id) {
  return BUG_CASES.find(c => c.id === id) || null;
}

/**
 * 按标签或关键词搜索案例
 */
function searchBugCases(query) {
  if (!query) return BUG_CASES;
  const q = query.toLowerCase();
  return BUG_CASES.filter(c =>
    c.title.toLowerCase().includes(q) ||
    c.symptom.toLowerCase().includes(q) ||
    c.tags.some(t => t.includes(q)) ||
    c.id.includes(q)
  );
}

module.exports = { BUG_CASES, exportBugCasesForTraining, getBugCase, searchBugCases };

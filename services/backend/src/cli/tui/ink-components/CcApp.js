'use strict';

/**
 * CcApp.js —— CC 模式根组件
 *
 * 当 KHY_CC_TUI=1 时，app.js 渲染此组件替代 Legacy App。
 * 使用 CC 风格组件：CcStatusLine, CcPromptInput, CcLogo 等。
 *
 * 零破坏原则：本组件独立于 Legacy App.js，不影响 Legacy 模式。
 *
 * ## ⚠ 本组件当前是**预览态**（preview），不是可用的 CC 复刻（2026-09-22）
 *
 * 按 [DESIGN-PROCESS-001] §2.2 的粒度判别，本组件的产品定位**未获授权裁决**，
 * 故此处显式声明为**预览**，并让所有反馈**诚实反映「未执行」**，避免两处信任损害：
 *
 *   1. **未被授权的「预览还是真接线」**：完整 CC 复刻需要产品判断（哪些 slash 命令
 *      在 CC 语义下该有不同行为），超出维护者可自行决定的粒度 ⇒ 保持预览，不擅自接线。
 *   2. **假成功反馈（已修）**：旧实现里 slash 选择器对未接线的命令也回
 *      `执行: /clear`，而 `/clear` **实际什么都没发生**——用户以为系统执行了。
 *      现一律改为「`<命令> — 预览模式：未执行`」，描述文案亦标「（预览）」。
 *
 * 仍为**真实可用**的：`/copy`（复制最近助手回复到剪贴板）、Ctrl+E 外部编辑器、
 * Ctrl+R 历史搜索、鼠标选择/复制 —— 这些**不**带预览标记。
 *
 * **AI 回应是桩**：`handleSubmit` 用 `收到: <文本>` 回声模拟助手，未连接 AI 网关
 * （见该回调处注释）。真接线前，任何「它回答了我」的观感都只属于预览。
 *
 * 参考：[DESIGN-ARCH-086] 总计划
 */

const React = require('react');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
// App.js 使用 inkRuntime.get() 获取 ink 组件（第 431 行），
// 因为 ink 是 ESM 模块，不能直接 require。CcApp.js 必须保持一致。
// 保留模块本体:鼠标命中测试要读 `getInkInstance().rootNode`。
const inkRuntime = require('../inkRuntime');
const { Box, Text, useInput, useApp } = inkRuntime.get();
const { isCcMode, isCcPreview, ccPreviewNotice } = require('../utils/ccMode');
const { CcLogo } = require('./CcLogo');
const { CcStatusLine } = require('./CcStatusLine');
const { CcPromptInput } = require('./CcPromptInput');
const { CcAssistantMessage, CcStreamingMessage } = require('./CcAssistantMessage');
const CcViewStack = require('./CcViewStack');
const { CcHelpMenu } = require('./CcHelpMenu');
const { CcFuzzyPicker } = require('./CcFuzzyPicker');
const { CcToastContainer } = require('../components/CcToast');
const { CcScrollIndicators } = require('../components/CcScrollIndicators');
const { CcMessageBar } = require('../components/CcMessageBar');
const { CcPermissionPrompt } = require('./CcPermissionPrompt');
// 以下模块仅在覆盖层打开时懒加载，减少首屏 require 时间
let _AgentTree = null;
let _CcTranscriptView = null;
function getAgentTree() { if (!_AgentTree) _AgentTree = require('./AgentTree'); return _AgentTree; }
function getCcTranscriptView() {
  if (!_CcTranscriptView) _CcTranscriptView = require('./CcTranscriptView').CcTranscriptView;
  return _CcTranscriptView;
}
// Viewport 只在「开了选择」时才用得上（消息段走投影渲染），故同样懒加载。
let _Viewport = null;
function getViewport() { if (!_Viewport) _Viewport = require('./Viewport'); return _Viewport; }
const { getLayout, ccChromePlan, ccTerminalDims } = require('../utils/ccLayout');
// Row billing must use the SAME meter as the paint (DESIGN-ARCH-103 H6): the
// message area wraps by display width, so counting `\n` under-bills CJK replies.
const { visualRows } = require('../wrapCell');
// 纯叶子（与 AgentTree / 投影共用），顶层 require 无 ink 依赖。
const { agentTreePaintRows } = require('../../agentTreeView');
const { estimateAllAgents, formatDuration } = require('../utils/ccTaskEstimate');
const { CC_COLORS } = require('../theme/ccTheme');

// 消息文本清洗真源，与 Legacy（Transcript.js / StreamingBlock.js）及 topicBar
// (BUG-33) 用的是同一个 modelTextNormalizer。CC 表面此前把原文直传给 ink：
//   - 粘贴 / 未来接入网关后的模型输出里的 OSC / 控制序列会裸奔到 stdout，被终端
//     当作指令执行（改标题 / 写剪贴板 / 清屏），这正是 BUG-33 已为会话标题堵住的
//     同一类注入，只是当时没覆盖 CC 消息正文；
//   - ZWJ（U+200D）会落到 ink「按 1 列量宽、却画成 N 列」的不一致上（BUG-109）。
// 只在唯一生产点 handleSubmit 清洗一次：messages state 变净后，渲染与投影都读
// 同一份净串 ⇒ 账本==实画天然成立（无需两处各剥、也不会喂给 wrap-ansi 不一致的串）。
// fail-soft：normalizer 缺失 → 原样返回（CcApp 是 CC 根组件，require 失败不能白屏）。
let _ccNorm = null;
try { _ccNorm = require('../../modelTextNormalizer') || null; } catch { _ccNorm = null; }
function ccSanitize(text) {
  if (!_ccNorm || typeof _ccNorm.sanitize !== 'function') return text;
  try { return _ccNorm.sanitize(text); } catch { return text; }
}

// ── 自绘选择(应用内拖选 → 反色 → 松手复制,[DESIGN-ARCH-124])──────────────
// 四个模块**全部 fail-soft**:任一缺失 → 选择层不接线 → 逐字节回退到老行为。
// 这不是防御性冗余 —— CcApp 是 CC 模式的根组件,它 require 失败会让整个模式
// 白屏;而选择只是锦上添花的功能,绝不该有这种破坏力。
let _mouse = null;
try { _mouse = require('../mouseButtons'); } catch { _mouse = null; }
let _sel = null;
try { _sel = require('../selection'); } catch { _sel = null; }
let _gates = null;
try { _gates = require('../utils/selectGates'); } catch { _gates = null; }
let _proj = null;
try { _proj = require('./ccMessageProjection'); } catch { _proj = null; }

/**
 * CC 模式根组件
 */
function CcApp({ options = {} }) {
  const { exit } = useApp();
  const [messages, setMessages] = React.useState([]);
  const [inputValue, setInputValue] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [showHelp, setShowHelp] = React.useState(false);
  const [showCommandPalette, setShowCommandPalette] = React.useState(false);
  const [toasts, setToasts] = React.useState([]);
  const [messageBar, setMessageBar] = React.useState(null);
  const [permissionPrompt, setPermissionPrompt] = React.useState(null);
  const [modelId, setModelId] = React.useState(options.model || 'claude-sonnet-4');
  const [contextUsed, setContextUsed] = React.useState(0);
  const [cost, setCost] = React.useState(0);
  // BUG-83: seeded through ccLayout.ccTerminalDims() instead of the bare
  // `process.stdout.columns || 80` / `|| 24`. Unknown/garbage readings (conpty
  // does report 0/undefined) must resolve through the SAME accessor the rest of
  // the repo uses, so the documented KHY_TERM_FALLBACK_COLS/ROWS contract and
  // the sticky last-valid cache apply here too. Previously CC laid out a 12-row
  // screen as if it had 24 → ink's fullscreen branch fired → full-screen
  // repaint/ghosting while the Legacy surface on the same terminal was correct.
  const [cols, setCols] = React.useState(() => ccTerminalDims().cols);
  const [rows, setRows] = React.useState(() => ccTerminalDims().rows);
  const [permissionProfile, setPermissionProfile] = React.useState('normal');
  const [cacheHitRate, setCacheHitRate] = React.useState(null);
  const [subAgents, setSubAgents] = React.useState([]); // 父子 Agent 工具树（ZCode 对齐）
  const [agentTreeExpanded, setAgentTreeExpanded] = React.useState(false);
  const [showTranscript, setShowTranscript] = React.useState(false); // 转录视图（Claude Code Ctrl+O 对齐）
  const [editorOpen, setEditorOpen] = React.useState(false); // 外部编辑器（Ctrl+E）
  const [editorContent, setEditorContent] = React.useState(''); // 编辑器内容
  const [vimMode, setVimMode] = React.useState(null); // Vim 模式（null=禁用）
  const [vimEnabled, setVimEnabled] = React.useState(true); // Vim 模式开关（默认启用）
  const [showHistorySearch, setShowHistorySearch] = React.useState(false); // 历史搜索（Ctrl+R，CC 对齐）
  // 双击 Ctrl+C 退出（[DESIGN-ARCH-087] 验收项「双击 Ctrl+C 退出：首次提示，二次退出」）。
  // 3s 窗口（ccTimers.doubleTapExit.windowMs）内再按一次才退出；首次只提示。
  const exitTapRef = React.useRef(0);

  // 初始化权限 profile（从 permissionStore 读取）
  React.useEffect(() => {
    try {
      const permStore = require('../../../services/permissionStore');
      if (permStore && typeof permStore.getProfile === 'function') {
        setPermissionProfile(permStore.getProfile());
      }
    } catch {
      /* permissionStore unavailable — keep default */
    }
  }, []);

  // ── 演示用父子 Agent 工具树（KHY_CC_DEMO_AGENTS，默认关）─────────────────
  // 下面这份数据是**手写的假数据**：「基本面分析师 / 风控经理」、「Running 2
  // agents…」、"Reading server.js"、"5 tool uses 2.1s"。原先它在每次挂载时无条件
  // setSubAgents → 任何一个真实 CC 会话从第一帧起就**常驻**一行「● Running 2
  // agents… (Ctrl+O 展开)」，展开后还列出了从未发生过的工具步骤。全仓 setSubAgents
  // 只有这一处调用，后端 sub-agent 编排引擎至今**没有**向这里供数的通路 ——
  // 所以它不是「提前预览真实功能」，而是把不存在的活动报给了用户：状态消息必须
  // 说真话（规则 2 / RUNTIME-002），谎报比缺失更难发现。
  // 处置：默认不挂（消息区自然多出 1 行预算）；需要这块视觉做设计走查/截图时
  // 显式 KHY_CC_DEMO_AGENTS=1 打开。组件本体 ./AgentTree 与其设计文档背书不动。
  React.useEffect(() => {
    const on = ['1', 'true', 'yes', 'on'].includes(
      String(process.env.KHY_CC_DEMO_AGENTS || '').trim().toLowerCase()
    );
    if (!on) {
      return;
    }
    // 演示：展示一个父子 Agent 工具树（含步骤，用于时间预估）
    const agents = [
      {
        id: 'agent-1',
        name: '基本面分析师',
        status: 'running',
        stats: ['5 tool uses', '2.1s'],
        currentTool: 'Reading server.js',
        steps: [
          { tool: 'Read', args: { file_path: '/src/server.js' } },
          { tool: 'Grep', args: { pattern: 'TODO' } },
          { tool: 'Bash', args: { command: 'npm test' } },
          { tool: 'Edit', args: { file_path: '/src/index.js' } },
          { tool: 'Read', args: { file_path: '/README.md' } },
        ],
      },
      {
        id: 'agent-2',
        name: '风控经理',
        status: 'completed',
        stats: ['3 tool uses', '1.5s'],
        steps: [
          { tool: 'Read', args: { file_path: '/src/auth.js' } },
          { tool: 'Grep', args: { pattern: 'password' } },
          { tool: 'Bash', args: { command: 'npm audit' } },
        ],
      },
    ];

    // 为每个 Agent 添加时间预估
    const estimates = estimateAllAgents(agents);
    const agentsWithEstimate = agents.map((agent, i) => ({
      ...agent,
      estimate: estimates[i]?.label || '',
    }));

    setSubAgents(agentsWithEstimate);
  }, []);

  // ── Resize tracking（P0-3）────────────────────────────────────────────────
  // The layout below computes against the cols/rows STATE, so this listener is
  // what keeps it honest after a window resize. Legacy App handles this via its
  // resizeNonce effect; CcApp replaces that whole tree, so it must own its
  // listener. Same shape as App.js: debounce so a drag-resize commits once on
  // settle (120ms) and invalidate the terminal-capability cache (it still holds
  // pre-resize columns). BUG-83: the reading is resolved by
  // ccLayout.ccTerminalDims() — the repo's ONE sticky + KHY_TERM_FALLBACK_*
  // accessor — rather than a cc-local tri-state copy. Cleanup removes the
  // listener and cancels any pending timer.
  React.useEffect(() => {
    let resizeTimer = null;
    const onResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const dims = ccTerminalDims();
        setCols(dims.cols);
        setRows(dims.rows);
        try {
          require('../runtime/terminalCapabilities').invalidateCache();
        } catch {
          /* best effort */
        }
      }, 120);
    };
    process.stdout.on('resize', onResize);
    return () => {
      process.stdout.off('resize', onResize);
      clearTimeout(resizeTimer);
    };
  }, []);

  const layout = getLayout(cols, rows);

  // ── P0-2 帧高纪律:已提交消息区尾窗───────────────────────────────────────
  // messages 历史上全量渲染,长会话帧高越过终端 rows → ink 走 fullscreen 分支,
  // 每帧把整段 transcript 前缀推入 scrollback(「同段输出重复多份」,
  // [IMPL-RPT-044])。此处按 messageAreaCap 把已提交消息从尾部窗口化。
  //
  // BUG-77：行数账本必须与**渲染同源**(DESIGN-ARCH-103 H6)。旧估算只数
  // **逻辑** 换行(`text.split('\n').length`)，而正文按**显示宽度**折行 —— 一条
  // 84 显示列的单行汉字回复在 80 列终端实画 2 行、只估 1 行。实测 6 条长消息
  // 估算 12 行 / 实画 16 行(低估 25%)：cap=10 时窗口收下 5 条 = 实画 13 行 →
  // 帧高顶破 rows → 80×24 留 1 次 \x1b[2J、80×12 留 6 次整屏残影
  // (存证 .khy/feedback/tui-ux-audit-20260919/AU/repro-before-bug77.txt)。
  const estimateMessageRows = (msg) => {
    if (!msg || typeof msg.text !== 'string') {
      return 1;
    }
    // assistant 行首是 `width:1 / flexShrink:0` 的 ●，正文再以前导空格开头 →
    // 恒少 2 列（见 ./CcAssistantMessage 文件头的布局约束）；user 行无缩进占满 cols。
    const inner = Math.max(8, cols - (msg.role === 'assistant' ? 2 : 0));
    // marginTop 那一空行只有账本留下它时才计费（BUG-91：短终端上 ccGapPlan
    // 把它判给了帧高）。省下的行还给窗口，估高才会与实画同向。
    return (chromePlan.msgGap ? 1 : 0) + Math.max(1, visualRows(msg.text, inner));
  };

  // BUG-93：账本必须按 AgentTree **实画的最高一档**记 —— 渲染器是
  // `if (live || expanded)` 才吐子行，busy（live=true）时**未展开也画全树**，
  // 旧写法只记 1 行（且展开态记 0，注释还写明「不在本预算之内」——那正是病灶：
  // 展开/直播的行照样占帧高，少记的行由 ink 用整屏擦除来讨债）。取上界不取
  // 当前档，与 ccChromePlan 的 streaming 不变式同一权衡：账本不随轮次翻动，
  // 静置帧多留几行作代价（「不动的画面值这几行」）。
  const treeRows = React.useMemo(
    () => agentTreePaintRows(subAgents),
    [subAgents],
  );

  // KHY_CC_MESSAGE_CAP (default on): off → render everything (byte-for-byte
  // legacy behaviour) instead of windowing. Read once: an env flip mid-session
  // is not a supported hot-path.
  const capGateOn = React.useMemo(() => {
    const v = String(process.env.KHY_CC_MESSAGE_CAP || '').trim().toLowerCase();
    return !['0', 'false', 'off', 'no'].includes(v);
  }, []);

  // BUG-77b：短终端上「固定 chrome + 恒留最后一条」自己就顶破 rows —— 窗口收到
  // 地板也不是 cap 说了算（地板由「消息存在」决定），所以账本必须同时给出
  // 可压缩 chrome 的降级选择，画面按它渲染：ledger 与 paint 同源。cap 关掉时
  // 用户显式要「全画出来」，降级横幅既救不了帧高也违背意图 → 保持完整 logo。
  // 不传 streaming：账本按 busy 几何定档并原样用于静置态，否则 cap 会随轮次跳动
  // （80×12 上静置 2 行 / 思考中 4 行，横幅同时闪一次）。
  //
  // BUG-92：让位梯的地板不是「一条 1 行消息」，而是「窗口恒留的那条消息实画几行」。
  // 只取**最后一条**、且只取**不含 marginTop 的正文行数** —— 它是任何窗口算术都
  // 救不掉的量（窗口再怎么收也得留它），而 marginTop 由 msgGap 决定，把它算进来就
  // 成了「让位判据依赖让位结果」的循环。
  const lastContentRows = React.useMemo(() => {
    const last = messages.length > 0 ? messages[messages.length - 1] : null;
    if (!last || typeof last.text !== 'string') {
      return 1;
    }
    return Math.max(1, visualRows(
      last.text,
      Math.max(8, cols - (last.role === 'assistant' ? 2 : 0)),
    ));
  }, [messages, cols]);
  const chromePlan = React.useMemo(() => ccChromePlan(rows, {
    inputRows: layout.inputMaxHeight,
    messageBar: !!messageBar,
    toasts: toasts.length,
    agentTreeRows: treeRows,
  }, lastContentRows), [rows, messageBar, toasts.length, layout.inputMaxHeight, treeRows, lastContentRows]);
  const logoOn = !capGateOn || chromePlan.banner;
  const logoSubtitle = !capGateOn || chromePlan.subtitle;
  const hintOn = !capGateOn || chromePlan.hint;

  const visibleMessages = React.useMemo(() => {
    if (!capGateOn) {
      return messages;
    }
    // The busy streaming row is charged inside the cap, so the window itself
    // only counts committed messages.
    const cap = chromePlan.cap;
    const n = messages.length;
    if (n === 0) {
      return messages;
    }
    // 从尾部往前收，收到装不下为止；**恒留最后一条**——旧代码写了这条判据
    // 却没实现（末条比整个窗口高时循环首轮即 break，返回空数组 = 消息区消失）。
    const tailStart = (budget) => {
      let used = 0;
      let start = n;
      for (let i = n - 1; i >= 0; i--) {
        const cost = estimateMessageRows(messages[i]);
        if (used + cost > budget) {
          break;
        }
        used += cost;
        start = i;
      }
      return Math.min(start, n - 1);
    };
    // 退化几何（小终端：chrome 本身就把 rows 占满）下，旧分支「回吐全部」
    // 恰好把 cap 想防的整屏残影放大到最大 —— 窗口归零也只剩最后一条可看。
    if (cap <= treeRows) {
      return messages.slice(n - 1);
    }
    let start = tailStart(cap - treeRows);
    // 「⋯ 已收起上方 N 条」提示自己占 1 行：真收起时得从窗口里退一行给它，
    // 否则提示本身就成了压垮帧高的最后一行。账本判定不画提示时（极短终端）
    // 这一行退让也就不需要了 —— 省下的那一行还给消息区。
    if (start > 0 && hintOn) {
      start = tailStart(Math.max(1, cap - treeRows - 1));
    }
    return messages.slice(start);
  }, [messages, cols, capGateOn, chromePlan, treeRows, hintOn]);


  // ── Toast 管理（必须在 handleCopyLast / openExternalEditor 之前定义，避免 TDZ 错误） ──
  // handleCopyLast（Ctrl+Y 复制回执）在渲染期就执行其 useCallback，若此时
  // addToast 尚未初始化（下方旧位置）会抛「Cannot access before initialization」。

  const addToast = React.useCallback((message, type = 'info') => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, message, type }]);
  }, []);

  const dismissToast = React.useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);


  // ── 复制最近助手回复到剪贴板(Ctrl+Y,CC 模式 P1-1 剪贴板统一出口)────────────
  // 取最近一条 assistant 消息文本,走 ccClipboard.writeClipboard 统一出口
  // (native 系统工具先行 + OSC 52 非 TTY 兜底 + 100KB 上限 + TMUX/STY passthrough),
  // 成功后通过 addToast 回执;无内容或全通道失败时同样如实告知,绝不假装成功。
  const handleCopyLast = React.useCallback(() => {
    const lastAssistant = [...messages].reverse().find((m) => m && m.role === 'assistant');
    const text = lastAssistant && typeof lastAssistant.text === 'string' ? lastAssistant.text : '';
    if (!text) {
      addToast('暂无助手回复可复制', 'error');
      return;
    }
    try {
      const cc = require('../utils/ccClipboard');
      const r = cc.writeClipboard(text);
      if (r.ok) {
        // CC 规范复制反馈（[DESIGN-ARCH-087] §1）：copied N chars/lines 走
        // ccFormatters.formatCopyFeedback 单一真源（code-point 计数，emoji 安全）。
        // 门控 KHY_CC_COPY_TOAST（默认开）= CC 规范文案；显式 '0' → 中文旧文案逐字节回退。
        const v = String(process.env.KHY_CC_COPY_TOAST || '').trim().toLowerCase();
        const useCcFeedback = !(v === '0' || v === 'false' || v === 'off' || v === 'no');
        let msg;
        if (useCcFeedback) {
          try {
            const { formatCopyFeedback } = require('../utils/ccFormatters');
            msg = formatCopyFeedback(text) || `copied ${Buffer.byteLength(text, 'utf8')} bytes`;
          } catch {
            msg = `copied ${Buffer.byteLength(text, 'utf8')} bytes`;
          }
        } else {
          msg = `已复制 ${r.bytes} 字节到剪贴板(${r.channels.join('+')})`;
        }
        addToast(msg, 'success');
      } else {
        const v = String(process.env.KHY_CC_COPY_TOAST || '').trim().toLowerCase();
        const useCcFeedback = !(v === '0' || v === 'false' || v === 'off' || v === 'no');
        if (useCcFeedback) {
          addToast(
            `copy failed (${r.reasons.native || r.reasons.osc52 || r.reasons.gate || 'no clipboard'})`,
            'error'
          );
        } else {
          addToast(
            `复制失败:${r.reasons.native || r.reasons.osc52 || r.reasons.gate || '未知原因'}`,
            'error'
          );
        }
      }
    } catch (e) {
      const v = String(process.env.KHY_CC_COPY_TOAST || '').trim().toLowerCase();
      const useCcFeedback = !(v === '0' || v === 'false' || v === 'off' || v === 'no');
      addToast(
        useCcFeedback ? `copy failed (${(e && e.message) || e})` : `复制失败:${(e && e.message) || e}`,
        'error'
      );
    }
  }, [messages, addToast]);


  // ── 自绘选择([DESIGN-ARCH-124] §3.2):状态 + ref 镜像 ────────────────────
  // 三个门控走 `selectGates` 叶子 —— 与 Legacy `App.js` **同一真源**。抄一份的代价
  // 不是代码重复,是**语义漂移**:哪天有人改了默认值或新增一个 off 值,两个模式就
  // 静默变成两套行为,排查时谁都想不到「两个模式的开关不是同一个」。
  const _selectOn = _gates ? _gates.selectEnabled(process.env) : true;
  const _selectClipOn = _gates ? _gates.selectClipEnabled(process.env) : true;
  const [selectRegion, setSelectRegion] = React.useState(() =>
    _sel ? _sel.createSelection() : null
  );
  // ref 镜像是**强制的,不是优化**:`onSelectEvent` 在渲染早期就建成 useCallback
  // 闭包,直接读 state 会拿到上一帧的值 —— 表现为「拖动能画出第一格,之后不动」。
  // 这条在 Legacy 侧是踩过的坑,CC 侧不重犯。
  const _selectRegionRef = React.useRef(null);
  const _selectingRef = React.useRef(false);
  const _projectionRef = React.useRef(null);
  if (_selectRegionRef.current === null) {
    _selectRegionRef.current = _sel ? _sel.createSelection() : null;
  }

  // 状态栏里的时间预估(渲染与投影共用,避免两处算出不同长度 → 帧高对不上)
  const taskEstimateText = subAgents.length > 0
    ? formatDuration(
        subAgents.reduce((sum, a) => {
          const est = a.steps ? estimateAllAgents([a])[0]?.seconds || 0 : 0;
          return sum + est;
        }, 0),
      )
    : null;

  // ── 行投影:屏幕行 ↔ 文本的唯一映射([DESIGN-ARCH-124] 方案 A + C3)──────────
  // 运行时走**手写纯字符串投影**(零 ink 开销);正确性由
  // `tests/cli/tui/ccMessageProjection.oracle.test.js` 用 ink 的 `renderToString`
  // 对拍背书 —— 任何一条视觉规则改了而没同步投影,那条测试立刻红。
  //
  // 只有「已提交消息」这一段交给 <Viewport>;之上(Logo / AgentTree / 窗口化提示)
  // 与之下(流式行 / 横幅 / Toast / 状态栏 / 输入框)仍是真组件 —— 视觉损失≈0。
  //
  // ⚠ **不传 `padToRows`**(实测结论,不是推理):ink 6.8.0 的根容器没有显式
  // height,yoga 按内容定高 ⇒ `flexGrow:1` **不会**补白,帧高就是内容高。若按
  // 「终端行高」补白,投影会比屏幕多出十几行,拖到底部全选到空气。
  const projection = React.useMemo(() => {
    if (!_proj || !_selectOn) {
      return null;
    }
    try {
      const { formatModelName, formatContext, formatCost } = require('../utils/ccFormatters');
      const { getContextWindow } = require('../utils/ccContextWindows');
      return _proj.projectCcScene({
        cols,
        rows,
        messages: visibleMessages.map((m) => ({ id: m.id, role: m.role, text: m.text })),
        hiddenCount: Math.max(0, messages.length - visibleMessages.length),
        // BUG-77b：投影必须按**同一份** chrome 账本决定欢迎横幅与折叠提示行
        // 的有无，否则短终端上开拖选时整段行↔文本映射会错开 1-4 行。
        // BUG-91 同理：两条 marginTop 空行被账本收回时，投影也要收回。
        chrome: {
          banner: logoOn,
          subtitle: logoSubtitle,
          hint: hintOn,
          msgGap: chromePlan.msgGap,
          busyGap: chromePlan.busyGap,
        },
        busy,
        messageBar,
        toasts,
        subAgents,
        agentTreeExpanded,
        status: {
          modelName: formatModelName(modelId),
          contextStr: formatContext(contextUsed, getContextWindow(modelId)),
          cost,
          costStr: formatCost(cost),
          vimMode,
          taskEstimate: taskEstimateText,
          permissionProfile,
          cacheHitRate,
        },
        prompt: {
          value: inputValue,
          offset: String(inputValue || '').length,
          busy,
          maxRows: layout.inputMaxHeight,
        },
      });
    } catch {
      // 投影是**锦上添花**:它坏了绝不能让 CC 模式白屏。返回 null → 走老渲染路径。
      return null;
    }
  }, [
    _selectOn, cols, rows, visibleMessages, messages.length, busy, messageBar, toasts,
    subAgents, agentTreeExpanded, modelId, contextUsed, cost, vimMode, taskEstimateText,
    permissionProfile, cacheHitRate, inputValue, layout.inputMaxHeight, chromePlan,
  ]);
  // 松手那一刻要按锚点取原文 —— 必须能读到**本帧**的投影。
  _projectionRef.current = projection;
  // 选区 ref 镜像:state 是提交后的真相,每帧对齐一次(事件侧也要写,因为
  // 一帧内可能连收 down+move 两个事件,state 还没提交)。
  if (selectRegion) {
    _selectRegionRef.current = selectRegion;
  }

  // ── onSelectEvent:物理鼠标事件 → 选区操作(§3.4)────────────────────────────
  // 坐标换算的不变式:**屏幕行 == 投影下标**(projectCcScene 从头到尾覆盖整块
  // live 区,行号即下标),所以这里不需要 legacy 那种 `row + scrollOffset` 反查 ——
  // 那种反查在 CC 里会随 AgentTree 展开 / Toast 增减而**静默错位**。
  const onSelectEvent = React.useCallback((kind, ev) => {
    if (!_sel || !ev) {
      return;
    }
    const total = _projectionRef.current
      ? (_projectionRef.current.lines || []).length
      : 0;
    if (total <= 0) {
      return;
    }
    const row = Math.max(0, Math.trunc(Number(ev.row) || 0));
    // 偏移恒为 0:投影整块交给 Viewport,没有滚动窗口(贴底语义由 height 保证)。
    const line = _proj
      ? _proj.screenRowToIndex(row, 0, total, total)
      : Math.min(row, total - 1);
    const col = _sel.charColForDisplay(
      ((_projectionRef.current && _projectionRef.current.lines) || [])[line],
      Math.max(0, Math.trunc(Number(ev.col) || 0)),
    );
    const pt = { line, col };

    if (kind === 'down') {
      _selectingRef.current = true;
      // ⚠ 三个 API 的签名是 `(sel, line, col)` —— line 与 col **分开传**,不是传
      // 点对象。Legacy 侧曾写成 `beginSelection(sel, pt)`,col 变 undefined →
      // 归零 → 选区永远从第 0 列起。三层单测各自自洽,是端到端探针抓出来的。
      setSelectRegion(_sel.beginSelection(_selectRegionRef.current, pt.line, pt.col));
      return;
    }
    if (kind === 'move') {
      if (!_selectingRef.current) {
        return;
      }
      setSelectRegion(_sel.extendSelection(_selectRegionRef.current, pt.line, pt.col));
      return;
    }
    if (kind === 'up') {
      if (!_selectingRef.current) {
        return;
      }
      _selectingRef.current = false;
      // ⚠ 松手点**也要**算进选区:1002 的位移上报是「尽力而为」,快速小拖动可能
      // 一个 `move` 都没到 —— 那样 head 还停在按下点,选区零宽,用户看到反色画
      // 出来了却复制不出东西(最迷惑的一种「复制失灵」)。按下点→松手点才是用户的
      // 真实意图,Lagacy `App.js` 漏了这一步,CC 侧补上。
      const dragged = _sel.extendSelection(_selectRegionRef.current, pt.line, pt.col);
      const finished = _sel.endSelection(dragged);
      setSelectRegion(finished);
      _selectRegionRef.current = finished;
      // 零宽 = 普通点击,不当选区(否则每次点空白都留一个闪烁的空选区)。
      if (!_sel.normalizeSelection(finished)) {
        return;
      }
      // 松手即定稿:按锚点取**原文**再写剪贴板 —— 这是整条链路唯一的产出点。
      // 少了这一步就是「能拖不能复制」,正是用户报的症状。
      const text = _proj
        ? _proj.extractByAnchors(_projectionRef.current, finished)
        : '';
      if (!text) {
        return;
      }
      if (_selectClipOn) {
        try {
          const clip = require('../utils/ccClipboard');
          clip.writeClipboard(text);
        } catch {
          /* fail-soft —— 剪贴板失败绝不能连累 UI,用户至少还看得见选区 */
        }
      }
      try {
        const { formatCopyFeedback } = require('../utils/ccFormatters');
        addToast(formatCopyFeedback(text), 'success');
      } catch {
        /* 回执失败无关紧要,文本已进剪贴板 */
      }
      return;
    }
    if (kind === 'cancel') {
      // 半截手势(resize / 切视图 / 任意键)→ 丢弃,不留悬空选区。
      _selectingRef.current = false;
      const cleared = _sel.clearSelection();
      _selectRegionRef.current = cleared;
      setSelectRegion(cleared);
    }
  }, [_selectClipOn, addToast]);

  // 单例 dispatcher(持有 hover 状态)。门控关 → 不传 onSelectEvent → 选择层
  // 完全不接线,与修改前逐字节一致。
  const mouseDispatcherRef = React.useRef(null);
  if (
    !mouseDispatcherRef.current &&
    _mouse &&
    typeof _mouse.createMouseDispatcher === 'function'
  ) {
    mouseDispatcherRef.current = _mouse.createMouseDispatcher({
      hover: _mouse.mouseHoverEnabled(process.env),
      onSelectEvent: _selectOn ? onSelectEvent : undefined,
    });
  }

  // ── 全局快捷键 ──────────────────────────────────────────────────────────

  // BUG-90：ink 的 useInput **不互斥** —— 同一个按键会送达每一个挂载中的处理器
  // （BUG-86 实测过同一件事）。下面的 `?` 分支 `setShowHelp(true)` 后 `return`，
  // 那只退出 CcApp 自己的处理器，管不到 `CcPromptInput` 的插入分支：同一批更新里
  // 两个 state 都写了，帮助菜单把主表面整个换掉（`CcApp.js:770` 是提前 return），
  // Esc 关掉菜单后输入框重新挂载，value 已经是 '?' —— 屏幕上就多出一个来路不明的
  // 问号（三档终端全部复现：AU/repro-before-bug90.txt）。
  // 不能靠「父处理器先消费、子处理器再弃权」的顺序技巧：React 里**子组件的 effect
  // 先跑**，订阅顺序反过来且不可控。所以把「此刻哪些可打印键归宿主」作为契约
  // 交给输入框，由它自己让位 —— 两边读同一份 state，不可能分叉。
  // 判据与 Legacy 同一条（`App.js:5261` 的 `input === '?' && value === ''`）：
  // 正在打字时 `?` 是文字，不是热键。其余全局热键全是 Ctrl 组合，输入框的插入
  // 分支本来就要求 `!key.ctrl`，不需要登记。
  const hostPrintableKeys = React.useMemo(
    () => (inputValue === '' ? ['?'] : []),
    [inputValue],
  );

  useInput((input, key) => {
    // 0) 鼠标序列守卫(§3.5):SGR 序列一旦漏进下面的按键分支,轻则被当字面文本
    //    插进输入框,重则某个字符恰好命中快捷键。**必须在最前面 return**,否则
    //    `[<0;20;10M` 里的字符会被逐字处理。这一条 Legacy 有,CC 模式原本没有。
    if (_mouse && mouseDispatcherRef.current && _mouse.isMouseSequence(input)) {
      try {
        const _inst = inkRuntime.getInkInstance();
        mouseDispatcherRef.current.onInput(input, {
          rootNode: (_inst && _inst.rootNode) || null,
          // BUG-83: the rows used to interpret a screen coordinate MUST be the
          // rows the painted frame was laid out with (state), not a fresh raw
          // stdout read — the two can differ (debounced resize, conpty garbage),
          // and then a click/drag maps to the wrong line. Legacy App passes its
          // resolved _resRows for exactly this reason.
          rows,
          anchorBottom: false,
          // 布局缓存失效信号:每帧渲染后 lastOutput 变化 → 命中测试用新布局。
          cacheKey: (_inst && _inst.lastOutput) || '',
        });
      } catch {
        /* fail-soft */
      }
      return;
    }

    // 双击退出检测（[DESIGN-ARCH-087] 验收项「双击 Ctrl+C 退出：首次提示，二次退出」）：
    // 3s 窗口（ccTimers.doubleTapExit.windowMs）内二次 Ctrl+C/D 才真正 exit，首次只提示。
    const now = Date.now();
    if (key.ctrl && (input === 'c' || input === 'd')) {
      const { TIMING } = require('../utils/ccTimers');
      if (now - exitTapRef.current < TIMING.doubleTapExit.windowMs) {
        exitTapRef.current = 0;
        exit();
      } else {
        exitTapRef.current = now;
        addToast('再按一次 Ctrl+C 退出', 'warning');
      }
      return;
    }

    // 帮助菜单
    if (input === '?' && inputValue === '' && !showHelp && !showCommandPalette && !showHistorySearch) {
      setShowHelp(true);
      return;
    }

    // 命令面板
    if (key.ctrl && input === 'p' && !showHelp && !showCommandPalette && !showHistorySearch) {
      setShowCommandPalette(true);
      return;
    }

    // 历史搜索（Ctrl+R，CC 对齐：反向增量搜索 prompt 历史）
    if (key.ctrl && input === 'r' && !showHelp && !showCommandPalette && !showTranscript) {
      setShowHistorySearch(true);
      return;
    }

    // 清除对话
    if (key.ctrl && input === 'l') {
      setMessages([]);
      return;
    }

    // 转录视图（Ctrl+O，Claude Code 对齐：时间戳+模型+可展开工具调用）
    if (key.ctrl && input === 'o') {
      setShowTranscript((prev) => !prev);
      return;
    }

    // Agent 工具树折叠/展开（Ctrl+T，对齐任务列表快捷键）
    if (key.ctrl && input === 't') {
      setAgentTreeExpanded((prev) => !prev);
      return;
    }

    // 外部编辑器（Ctrl+E，OpenCode / Claude Code 对齐：打开 $EDITOR 编辑长文本）
    if (key.ctrl && input === 'e' && !editorOpen) {
      openExternalEditor();
      return;
    }

    // 切换 Vim 模式（Ctrl+V，状态栏显示当前模式）
    if (key.ctrl && input === 'v' && !showTranscript && !editorOpen) {
      setVimEnabled((prev) => !prev);
      return;
    }

    // 复制最近助手回复到剪贴板（Ctrl+Y，CC 模式 P1-1 剪贴板统一出口）
    if (key.ctrl && input === 'y') {
      handleCopyLast();
      return;
    }
  });

  // ── 消息处理 ────────────────────────────────────────────────────────────

  const handleSubmit = React.useCallback((rawText) => {
    if (!rawText.trim()) return;
    // 唯一生产点清洗一次（见文件头 ccSanitize 注释）：净串进 messages state 后，
    // 渲染与投影都读同一份，账本==实画自动成立。
    const text = ccSanitize(rawText);

    // 添加用户消息（带时间戳，用于转录视图）
    setMessages(prev => [...prev, {
      id: Date.now(),
      timestamp: Date.now(),
      role: 'user',
      text,
    }]);

    // ⚠ 预览态桩：未连接 AI 网关，用回声模拟助手回复。
    // 诚实起见，回显文本自带「预览」标记 —— 否则用户会把回声误当成真实模型回答。
    setBusy(true);
    setTimeout(() => {
      setMessages(prev => [...prev, {
        id: Date.now() + 1,
        timestamp: Date.now(),
        role: 'assistant',
        model: modelId,
        text: `[预览] 未连接 AI 网关，无法回答。收到: ${text}`,
        steps: [],
      }]);
      setBusy(false);
    }, 500);

    setInputValue('');
  }, []);

  // ── 外部编辑器（Ctrl+E，OpenCode / Claude Code 对齐） ────────────────────

  /**
   * 打开外部编辑器编辑长文本。
   * 创建临时文件 → 启动 $EDITOR → 等待关闭 → 读取内容回填输入框。
   * 对标 OpenCode Ctrl+E 打开 $EDITOR（默认 nvim）的行为。
   */
  const openExternalEditor = React.useCallback(() => {
    const editor = process.env.VISUAL || process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'vim');
    const tmpFile = path.join(os.tmpdir(), `khy-tui-edit-${Date.now()}.txt`);

    // 写入当前输入内容到临时文件
    try {
      fs.writeFileSync(tmpFile, inputValue || '', 'utf-8');
    } catch {
      addToast('无法创建临时文件', 'error');
      return;
    }

    setEditorOpen(true);
    setEditorContent(inputValue || '');

    // 启动编辑器（挂起 TUI，等待编辑器关闭）
    const child = spawn(editor, [tmpFile], {
      stdio: 'inherit',
    });

    child.on('close', (code) => {
      setEditorOpen(false);
      if (code !== 0) {
        // 用户取消（如 vim :q!）→ 不修改输入
        try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
        return;
      }
      try {
        const content = fs.readFileSync(tmpFile, 'utf-8').trim();
        fs.unlinkSync(tmpFile);
        if (content) {
          setInputValue(content);
          addToast(`已加载 ${content.length} 字符`, 'success');
        }
      } catch {
        addToast('读取编辑器内容失败', 'error');
      }
    });

    child.on('error', () => {
      setEditorOpen(false);
      addToast(`无法启动编辑器: ${editor}`, 'error');
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    });
  }, [inputValue, addToast]);

  // ── 渲染 ────────────────────────────────────────────────────────────────

  // 帮助菜单覆盖层
  if (showHelp) {
    return React.createElement(CcHelpMenu, {
      version: options.version || '1.0.0',
      onClose: () => setShowHelp(false),
      width: layout.helpMenuWidth,
      cols,
      rows,
    });
  }

  // 命令面板覆盖层
  if (showCommandPalette) {
    // 视图栈路径（[DESIGN-ARCH-085] §1：命令面板作为一等子视图，Esc 返回主视图、
    // 每视图状态缓存）。门控 KHY_CC_VIEW_STACK（默认开）→ CcCommandPalette（分组 +
    // 实时过滤 + 键盘导航）；显式 '0' → 逐字节回退到既有 CcFuzzyPicker 路径。
    const viewStackOn = (() => {
      const v = String(process.env.KHY_CC_VIEW_STACK == null ? '' : process.env.KHY_CC_VIEW_STACK).trim().toLowerCase();
      return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
    })();
    if (viewStackOn) {
      const { CcCommandPalette } = CcViewStack;
      return React.createElement(CcCommandPalette, {
        onExecute: (cmd) => {
          setShowCommandPalette(false);
          const value = String(cmd).replace(/^\//, '');
          if (value === 'copy' || value === 'clipboard') {
            handleCopyLast();
            return;
          }
          addToast(ccPreviewNotice(cmd), 'info');
        },
        onClose: () => setShowCommandPalette(false),
        cols,
        rows,
      });
    }
    return React.createElement(CcFuzzyPicker, {
      items: [
        { label: '/clear', value: 'clear', description: '清除对话历史（预览）' },
        { label: '/compact', value: 'compact', description: '压缩对话历史（预览）' },
        { label: '/cost', value: 'cost', description: '查看 token 用量（预览）' },
        { label: '/copy', value: 'copy', description: '复制最近助手回复到剪贴板' },
        { label: '/model', value: 'model', description: '切换 AI 模型（预览）' },
        { label: '/mcp', value: 'mcp', description: 'MCP 服务器管理（预览）' },
        { label: '/permissions', value: 'permissions', description: '权限设置（预览）' },
      ],
      onSelect: (item) => {
        setShowCommandPalette(false);
        if (item.value === 'copy') {
          handleCopyLast();
          return;
        }
        addToast(ccPreviewNotice(item.label), 'info');
      },
      onClose: () => setShowCommandPalette(false),
      maxWidth: layout.helpMenuWidth,
      cols,
      rows,
    });
  }

  // 历史搜索覆盖层（Ctrl+R，CC 对齐：反向增量搜索 prompt 历史）
  if (showHistorySearch) {
    return React.createElement(CcViewStack.CcHistorySearch, {
      onSelect: (entry) => {
        // 选中历史条目 → 回填到输入框（CcPromptInput value），保持光标在末尾
        if (entry) {
          setInputValue(String(entry));
        }
        setShowHistorySearch(false);
      },
      onClose: () => setShowHistorySearch(false),
      cols,
      rows,
    });
  }

  // 权限提示覆盖层
  if (permissionPrompt) {

    return React.createElement(CcPermissionPrompt, {
      question: permissionPrompt.question,
      options: permissionPrompt.options,
      onSelect: (value) => {
        permissionPrompt.onSelect?.(value);
        setPermissionPrompt(null);
      },
      onCancel: () => setPermissionPrompt(null),
    });
  }

  // 转录视图覆盖层（Ctrl+O，Claude Code 对齐）
  if (showTranscript) {
    return React.createElement(getCcTranscriptView(), {
      messages: messages.map((m) => ({
        ...m,
        timestamp: m.timestamp || (typeof m.id === 'number' ? m.id : Date.now()),
      })),
      onClose: () => setShowTranscript(false),
      cols,
      rows,
    });
  }

  // 外部编辑器覆盖层（Ctrl+E，OpenCode / Claude Code 对齐）
  if (editorOpen) {
    return React.createElement(Box, { flexDirection: 'column', flexGrow: 1 },
      React.createElement(Box, { paddingX: 1, paddingY: 1 },
        React.createElement(Text, { bold: true, color: CC_COLORS.brand }, '外部编辑器'),
        React.createElement(Text, { color: CC_COLORS.dimColor }, '  '),
        React.createElement(Text, { color: CC_COLORS.textSecondary }, `正在 ${process.env.VISUAL || process.env.EDITOR || 'vim'} 中编辑...`),
      ),
      React.createElement(Box, { paddingX: 1 },
        React.createElement(Text, { color: CC_COLORS.dimColor }, '保存并关闭编辑器以继续'),
      ),
    );
  }

  // ── 消息段:开了选择时改走投影 <Viewport>([DESIGN-ARCH-124] §3.6)──────────
  // 只有「已提交消息」这一段换渲染方式 —— 之上/之下仍是真组件,视觉损失≈0
  // (正文原本就是裸 <Text>,唯一丢的是 `●` 的 dimColor)。
  // 没开选择 / 投影算不出来 → **逐字节走老路径**,零破坏。
  const _vpSpan = projection && projection.spans ? projection.spans.viewport : null;
  const _vpLines =
    _vpSpan && _vpSpan.end > _vpSpan.start
      ? projection.lines.slice(_vpSpan.start, _vpSpan.end)
      : null;

  // 主布局
  return (
    React.createElement(Box, { flexDirection: 'column' },
      // Logo / 欢迎区（BUG-77b：短终端上按 chromePlan 降级，画的是账本留下的那一档）
      logoOn
        ? React.createElement(CcLogo, { subtitle: logoSubtitle })
        : null,

      // 消息区域
      React.createElement(Box, { flexDirection: 'column', flexGrow: 1 },
        // 父子 Agent 工具树（ZCode 对齐：可视化多智能体层级）
        subAgents.length > 0
          ? React.createElement(getAgentTree(), {
              agents: subAgents,
              expanded: agentTreeExpanded,
              live: busy,
            })
          : null,
        hintOn && visibleMessages.length < messages.length
          ? React.createElement(Text, {
              key: 'msg-window-hint',
              dimColor: true,
            }, `⋯ 已收起上方 ${messages.length - visibleMessages.length} 条消息（Ctrl+O 查看完整转录）`)
          : null,
        _vpLines
          ? React.createElement(Box, { key: 'msg-viewport', flexShrink: 0, overflow: 'hidden' },
              React.createElement(getViewport(), {
                lines: _vpLines,
                height: _vpLines.length,
                scroll: 0,
                // 滚动指示器会**多吐一行**,直接破坏「屏幕行 == 下标」不变式。
                showIndicator: false,
                // 不传 null 时 Viewport 逐字节走原路径(不切三段),热路径零开销。
                selection:
                  _sel && _sel.hasSelection(selectRegion) ? selectRegion : null,
              })
            )
          : visibleMessages.map(msg =>
              msg.role === 'user'
                ? React.createElement(Box, { key: msg.id, marginTop: chromePlan.msgGap ? 1 : 0 },
                    React.createElement(Text, null, msg.text),
                  )
                : React.createElement(CcAssistantMessage, {
                    key: msg.id,
                    text: msg.text,
                    gap: chromePlan.msgGap,
                  })
            ),
        busy
          ? React.createElement(CcStreamingMessage, { text: '思考中...', gap: chromePlan.busyGap })
          : null,
      ),

      // 消息横幅
      messageBar
        ? React.createElement(CcMessageBar, {
            type: messageBar.type,
            message: messageBar.message,
            suggestion: messageBar.suggestion,
            onClose: () => setMessageBar(null),
          })
        : null,

      // Toast 容器
      React.createElement(CcToastContainer, {
        toasts,
        onDismiss: dismissToast,
      }),

      // 状态栏
      React.createElement(CcStatusLine, {
        modelId,
        contextUsed,
        cost,
        cols,
        permissionProfile,
        cacheHitRate,
        vimMode,
        taskEstimate: taskEstimateText,
      }),

      // 输入框
      React.createElement(CcPromptInput, {
        value: inputValue,
        onChange: setInputValue,
        onSubmit: handleSubmit,
        busy,
        cols,
        maxRows: layout.inputMaxHeight,
        vimEnabled,
        globalKeys: hostPrintableKeys,
        onVimModeChange: setVimMode,
        onToast: addToast,
      }),
    )
  );
}

// 直接导出组件（不是对象），与 App.js 的 module.exports = App 保持一致
// 注意：不能在这里包 React.memo，否则 module.exports 是对象而非函数
module.exports = CcApp;

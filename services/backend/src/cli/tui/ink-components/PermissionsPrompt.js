'use strict';

/**
 * PermissionsPrompt — arrow-key navigable overlay for tool approval/denial.
 *
 * Mirrors QuestionPrompt's interaction model (Claude Code style): it owns its own
 * keystrokes via ink's useInput (↑/↓ to navigate, Enter to choose, number keys to
 * jump, Esc to deny). App.js mounts it only while a permission control request is
 * pending and yields all keys to it, so there is no competing input handler.
 *
 * It adapts to the syscall gateway's risk level when the request carries one
 * (`input.level` = 'L1' | 'L2'):
 *   - L1 / classic (yellow): 允许本次 / 会话免审(或始终允许) / 拒绝 — default = allow.
 *   - L2 (red): 确认执行此高危操作 / 本会话内总是允许此类 / 拒绝 — allow-first, default =
 *     **确认执行** (用户知情决定，与普通框对齐；`KHY_PERMISSION_ALLOW_FIRST_HIGHRISK=off` 回退拒绝优先)。
 *     第三项「本会话内总是允许此类」仅当 `KHY_L2_SESSION_ALLOW`（默认开）启用时渲染，关闭即消失。
 *     选项排序由单一真源 permissionOptionOrder.orderOptions 决定；二者均经 env 门控可逆。
 *
 * Resolution payloads (consumed by _decisionFromControl AND the gateway's
 * makeControlPrompter, both of which tolerate primitives and {behavior} objects):
 *   允许本次          → true            (allow once)
 *   会话免审/始终允许 → 'always'        (allow-always → gateway maps to session)
 *   一起讨论          → { behavior:'discuss' }  (dependency-install only; hands the
 *                       decision back to the AI⇄user conversation — installs nothing)
 *   拒绝              → false           (deny)
 *   确认执行(L2)      → { behavior:'allow', typed:<confirmWord> }  (typed confirm)
 *   本会话总是允许(L2)→ { behavior:'allow-always', typed:<confirmWord>, scope:'session' }
 *                       (typed confirm + 本会话同类 L2 免审；后端经 KHY_L2_SESSION_ALLOW 门控授予)
 */
const React = require('react');
const inkRuntime = require('../inkRuntime');
// 「允许优先」排序的单一真源(纯叶子)。L1 选项本就允许在首位 → 无操作;L2 高危默认
// 保留「拒绝」首位的安全护栏(除非用户显式 opt-in),由 orderOptions 的 highRisk 分支处理。
const permissionOptionOrder = require('../../../services/permissionOptionOrder');
// L2 会话免审门控（默认开，可逆）的单一真源——决定是否渲染「本会话内总是允许此类」第三项。
const { isL2SessionAllowEnabled } = require('../../../services/syscallGateway/permissionCache');

const MARKER = '❯';

function PermissionsPrompt({ request, onResolve }) {
  const { Box, Text, useInput } = inkRuntime.get();
  const h = React.createElement;

  const input = (request && request.input && typeof request.input === 'object') ? request.input : {};
  const toolName = (request && (request.tool_name || request.tool)) || '未知';
  const command = input.command || input.cmd || input.script || '';
  const description = input.description || '';
  const level = String(input.level || '').toUpperCase(); // 'L1' | 'L2' | '' (classic)
  const isL2 = level === 'L2';
  const isGateway = level === 'L1' || level === 'L2';
  const confirmWord = (typeof input.requireTyped === 'string' && input.requireTyped) || 'YES';

  // Build the option set + the safe default cursor position.
  // A request may advertise extra decisions via input.options (e.g. the
  // dependency-install heal prompt offers 'discuss' = 先一起讨论再决定). We only
  // render an advertised option we know how to resolve, so unknown UIs stay
  // binary-compatible and a request that omits options keeps the classic rows.
  const advertised = Array.isArray(input.options) ? input.options.map((o) => String(o).toLowerCase()) : [];
  const wantsDiscuss = advertised.includes('discuss');
  // 第三项「本会话内总是允许此类高危操作」仅在 L2 会话免审门控开时渲染（关闭即字节回退为两项）。
  const l2SessionAllowed = isL2SessionAllowEnabled();
  const builtOptions = isL2
    ? [
        // 仍以「拒绝优先」授权，实际排序交给 permissionOptionOrder.orderOptions（允许优先默认开）。
        { key: 'deny', label: '拒绝', resolve: () => false, danger: false },
        { key: 'confirm', label: `确认执行此高危操作（${confirmWord}）`, resolve: () => ({ behavior: 'allow', typed: confirmWord }), danger: true },
        ...(l2SessionAllowed
          ? [{ key: 'session', label: `本会话内总是允许此类高危操作（${confirmWord}）`, resolve: () => ({ behavior: 'allow-always', typed: confirmWord, scope: 'session' }), danger: true }]
          : []),
      ]
    : [
        { key: 'once', label: '允许本次', resolve: () => true, danger: false },
        { key: 'session', label: isGateway ? '本会话内同类免审' : '始终允许此工具', resolve: () => 'always', danger: false },
        ...(wantsDiscuss
          ? [{ key: 'discuss', label: '一起讨论（先不安装，让 AI 给方向）', resolve: () => ({ behavior: 'discuss' }), danger: false }]
          : []),
        { key: 'deny', label: '拒绝', resolve: () => false, danger: false },
      ];
  // 「允许优先」:把允许/中性类选项排前、拒绝类下沉到末尾(单一真源,门控默认开)。
  // L1 本就允许在首位故为无操作;L2 高危默认保留「拒绝」首位的护栏(highRisk 分支)。
  const options = permissionOptionOrder.orderOptions(builtOptions, { highRisk: isL2 });
  // 允许优先（默认开）→ 排序后 index 0 = 确认执行，光标默认命中（回车=执行，与普通框对齐）。
  // KHY_PERMISSION_ALLOW_FIRST_HIGHRISK=off 时 L2 不重排 → index 0 = 拒绝（回退安全护栏）。
  const [cursor, setCursor] = React.useState(0);
  const count = options.length;

  const choose = (idx) => {
    const opt = options[idx];
    if (opt) onResolve(opt.resolve());
  };

  useInput((ch, key) => {
    if (key.escape) { onResolve(false); return; }
    if (key.upArrow) { setCursor((c) => (c - 1 + count) % count); return; }
    if (key.downArrow || key.tab) { setCursor((c) => (c + 1) % count); return; }
    // 全角(CJK IME)数字折半角后判定(单一真源 cli/fullWidthInput.js,门控关→原样字节回退)。
    const navCh = require('../../fullWidthInput').foldDigits(ch, process.env);
    if (navCh && navCh >= '1' && navCh <= '9') {
      const idx = parseInt(navCh, 10) - 1;
      if (idx >= 0 && idx < count) choose(idx);
      return;
    }
    if (key.return) { choose(cursor); return; }
  });

  const accent = isL2 ? 'red' : 'yellow';
  const title = isL2 ? '⛔ 高危操作需要明确授权' : '⚠ 需要授权';

  const meta = [];
  if (isGateway) {
    const tag = isL2 ? '红灯 L2 · 毁灭性/系统级' : '黄灯 L1 · 有限写入/网络';
    meta.push(h(Text, { key: 'lvl', color: accent, bold: true }, tag));
    if (input.action || input.scope) {
      meta.push(h(Text, { key: 'as', dimColor: true }, `动作：${input.action || '?'}   范围：${input.scope || '?'}`));
    }
    if (input.resource) meta.push(h(Text, { key: 'res', dimColor: true }, `资源：${String(input.resource).slice(0, 200)}`));
  }

  // 面向小白的执行前说明（Part D）：网关随 input 下发的、按难易/重要程度深浅
  // 不同的中文说明。仅渲染，缺失则不显示，保持原有布局。
  const explanationText = (input.explanation && typeof input.explanation.text === 'string')
    ? input.explanation.text.trim() : '';
  const explanationBlock = explanationText
    ? h(Box, { flexDirection: 'column', marginTop: 1, marginBottom: 0 },
        ...explanationText.split('\n').map((ln, i) => h(Text, { key: `ex${i}`, color: ln.startsWith('⚠') ? accent : undefined, dimColor: !ln.startsWith('⚠') }, ln)))
    : null;

  // 写入前 diff 预览(editDiffPreview,「让 TUI 拥有 CC 一样的真 code 生产能力」):当请求携带
  // 已算好的 {beforeContent, afterContent}(由 toolCalling 的 Ink 审批路径在批准前计算,门控
  // KHY_EDIT_DIFF_PREVIEW),复用工具结果视图同一套红/绿 ± 渲染,把编辑画进授权框——让用户
  // 在写入前审阅改动,而非写入后才看到。expanded=true:在安全上限内尽量多显、且溢出文案诚实
  // 不承诺不存在的 Ctrl+O。缺预览 / 渲染异常 → 不显示,布局逐字节回退到今日。
  let diffBlock = null;
  try {
    const dp = input.diffPreview;
    if (dp && typeof dp === 'object'
        && typeof dp.beforeContent === 'string' && typeof dp.afterContent === 'string') {
      const TL = require('./ToolLines');
      const diffRows = TL.buildWriteDiffRows(dp, true);
      if (diffRows && diffRows.length) {
        diffBlock = h(Box, { flexDirection: 'column', marginTop: 1 },
          dp.filePath ? h(Text, { dimColor: true }, `± ${String(dp.filePath)}`) : null,
          TL.renderDiffRows(diffRows, h, Box, Text, true)
        );
      }
    }
  } catch { diffBlock = null; }

  const rows = options.map((opt, i) => {
    const active = i === cursor;
    const color = active ? (opt.danger ? 'red' : 'cyan') : (opt.danger ? 'red' : undefined);
    return h(Text, { key: opt.key, color, bold: active },
      `   ${active ? MARKER : ' '} ${i + 1}. ${opt.label}`);
  });

  // L2 允许优先生效时默认行=确认执行；显式回退（门控关或高危 opt-out）时默认行=拒绝。
  const l2AllowFirst = permissionOptionOrder._enabled() && permissionOptionOrder._highRiskOptIn();
  const footer = isL2
    ? (l2AllowFirst
        ? '↑/↓ 导航 · Enter 选择 · 默认「确认执行」· Esc 取消'
        : '↑/↓ 导航 · Enter 选择 · 默认「拒绝」· Esc 取消')
    : '↑/↓ 导航 · Enter 选择 · 数字键直选 · Esc 取消';

  return h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: accent, padding: 1 },
    h(Text, { bold: true, color: accent }, title),
    h(Text, null, ''),
    h(Text, null, `工具：${toolName}`),
    ...meta,
    description ? h(Text, { dimColor: true }, description) : null,
    command ? h(Text, { dimColor: true }, `$ ${command}`) : null,
    explanationBlock,
    diffBlock,
    h(Text, null, ''),
    h(Box, { flexDirection: 'column' }, rows),
    h(Text, null, ''),
    h(Text, { dimColor: true }, `  ${footer}`)
  );
}

module.exports = PermissionsPrompt;

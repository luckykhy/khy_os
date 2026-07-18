'use strict';

/**
 * desktopControl/formFiller.js — 填表编排（DESIGN-ARCH-056）。
 *
 * 「填写表单」有两条物理路径，本模块按字段形态自动分流：
 *
 *   A) Web 表单（字段带 selector）→ 委派既有 WebBrowserTool 的 fill/click 动作，
 *      复用 Playwright 的稳健选择器/等待，绝不另造一套网页自动化。
 *
 *   B) 原生桌面表单（字段带坐标 x,y）→ 走 inputController：
 *        click(x,y) → [可选全选清空] → type(value) → [可选 Tab 跳下一字段]
 *      末尾可选按 Enter / 点击提交按钮坐标。
 *
 * 核心是一个**纯计划器** planFill：把 {fields, submit} 编译成一串显式步骤（动作 + 参数），
 * 不触发任何副作用——便于单测与「先给用户看计划再执行」。executeFill 才真正驱动注入器，
 * 且每步都通过注入进来的 actuator（默认 inputController，实际由 index 门面包了 safetyGate）。
 */

// ── 纯计划器：字段列表 → 步骤序列。零副作用。 ──────────────────────────
function planFill(spec = {}) {
  const fields = Array.isArray(spec.fields) ? spec.fields : [];
  if (fields.length === 0) {
    return { ok: false, error: '表单未提供任何字段（fields 为空）。', steps: [] };
  }

  const steps = [];
  const errors = [];

  fields.forEach((f, idx) => {
    const where = `字段#${idx}`;
    const isWeb = typeof f.selector === 'string' && f.selector.trim();
    const isNative = Number.isFinite(f.x) && Number.isFinite(f.y);

    if (!isWeb && !isNative) {
      errors.push(`${where} 既无 selector(Web) 也无 x,y(原生)，无法定位。`);
      return;
    }
    if (typeof f.value !== 'string') {
      errors.push(`${where} 缺少字符串 value。`);
      return;
    }

    if (isWeb) {
      // Web：委派 WebBrowser。fill 自带清空语义。
      steps.push({ kind: 'web', action: 'fill', selector: f.selector.trim(), value: f.value, field: idx });
    } else {
      steps.push({ kind: 'native', action: 'click', x: Math.trunc(f.x), y: Math.trunc(f.y), field: idx });
      if (f.clearFirst) {
        // 全选 + 删除：跨平台用 hotkey(ctrl/cmd + a) 再 key(delete)。
        steps.push({ kind: 'native', action: 'hotkey', keys: [_selectAllModifier(spec.platform), 'a'], field: idx });
        steps.push({ kind: 'native', action: 'key', key: 'delete', field: idx });
      }
      steps.push({ kind: 'native', action: 'type', text: f.value, field: idx });
      if (f.tab !== false && idx < fields.length - 1) {
        // 默认每填完一格按 Tab 跳下一格（最后一格不跳）。可用 tab:false 关闭。
        steps.push({ kind: 'native', action: 'key', key: 'tab', field: idx });
      }
    }
  });

  // 提交：原生按 Enter 或点击坐标；Web 点击 selector。
  if (spec.submit) {
    const s = spec.submit;
    if (typeof s === 'object' && typeof s.selector === 'string') {
      steps.push({ kind: 'web', action: 'click', selector: s.selector.trim(), submit: true });
    } else if (typeof s === 'object' && Number.isFinite(s.x) && Number.isFinite(s.y)) {
      steps.push({ kind: 'native', action: 'click', x: Math.trunc(s.x), y: Math.trunc(s.y), submit: true });
    } else {
      steps.push({ kind: 'native', action: 'key', key: 'enter', submit: true });
    }
  }

  if (errors.length) return { ok: false, error: errors.join(' '), steps };
  return { ok: true, steps };
}

function _selectAllModifier(platform) {
  return (platform || process.platform) === 'darwin' ? 'cmd' : 'ctrl';
}

// ── 执行器：按计划逐步驱动注入器 / Web 工具。 ──────────────────────────
/**
 * @param {object} spec  同 planFill
 * @param {object} deps  {
 *   actuator,   // { click, type, key, hotkey } —— 默认 inputController（门面会包 safetyGate）
 *   webExecute, // async (action, params) => result —— 委派 WebBrowserTool；缺省则 Web 步骤报未配置
 *   onStep,     // 可选：每步回调（透明度）
 *   platform,
 * }
 */
async function executeFill(spec = {}, deps = {}) {
  const plan = planFill({ ...spec, platform: deps.platform });
  if (!plan.ok) return { success: false, error: plan.error, plan: plan.steps };

  const actuator = deps.actuator || require('./inputController');
  const webExecute = deps.webExecute || null;
  const results = [];

  for (const step of plan.steps) {
    let r;
    if (step.kind === 'web') {
      if (!webExecute) { r = { success: false, error: 'Web 字段需要 webExecute（WebBrowser 委派）但未配置。' }; }
      else {
        r = await webExecute(step.action, step.action === 'fill'
          ? { selector: step.selector, value: step.value }
          : { selector: step.selector });
      }
    } else {
      switch (step.action) {
        case 'click': r = await actuator.click(step.x, step.y); break;
        case 'type': r = await actuator.type(step.text); break;
        case 'key': r = await actuator.key(step.key); break;
        case 'hotkey': r = await actuator.hotkey(step.keys); break;
        default: r = { success: false, error: `未知步骤动作 ${step.action}` };
      }
    }
    results.push({ step, result: r });
    if (deps.onStep) { try { deps.onStep(step, r); } catch { /* 透明回调失败不影响主流程 */ } }
    if (!r || r.success === false) {
      return { success: false, error: `第 ${results.length} 步（${step.kind}:${step.action}）失败：${(r && r.error) || '未知'}`, results, plan: plan.steps };
    }
  }

  return { success: true, steps: results.length, results, plan: plan.steps };
}

module.exports = { planFill, executeFill, _internals: { _selectAllModifier } };

'use strict';

/**
 * DesktopControlTool — 模型可见的「眼/耳/嘴/手」桌面操控工具（DESIGN-ARCH-056）。
 *
 * 让 Khyos 能看屏幕、模拟真实鼠标点击与键盘输入、自动填表、朗读/聆听。
 * 一切真实操控都委派给 services/desktopControl 门面，由其 safetyGate 统一裁决：
 * 默认 KHY_DESKTOP_CONTROL=off → 截屏/操控被拒并返回如何启用的明确指引。
 *
 * 高危声明：risk='critical'。即便环境开关已开，模型驱动路径仍会经既有审批管线
 * 二次把关——「只增不减保护」。capabilities/截屏属较低危，但仍受主闸门约束（隐私）。
 */

const { BaseTool } = require('../_baseTool');

const ACTUATE = new Set(['move', 'click', 'doubleClick', 'rightClick', 'drag', 'scroll', 'type', 'typeKeystrokes', 'key', 'hotkey', 'fillForm', 'clickElement', 'hoverElement', 'selectText', 'activate', 'closeWindow', 'minimizeWindow']);

class DesktopControlTool extends BaseTool {
  static toolName = 'DesktopControl';
  static category = 'system';
  static risk = 'critical';
  static aliases = ['desktop', 'computer_use', 'gui_control'];
  static searchHint = 'desktop screen screenshot mouse click keyboard type fill form control computer eyes ears mouth speak listen inspect observe accessibility ui elements buttons clickable 眼 耳 嘴 点击 填表 看清 元素 按钮';
  static shouldDefer = true;

  isConcurrencySafe() { return false; }

  prompt() {
    return `Control the local computer: see the screen, understand its UI as structured clickable elements, simulate mouse/keyboard, fill forms, speak/listen.
Actions:
- "capabilities": report which senses are available (eyes/perception/hands/mouth/ears) and the gate state. Safe, always allowed.
- "observe": THE primary way to see — returns a screenshot path (for vision) PLUS "marks": a structured list of on-screen elements [{id:"e1", role, label, center:{x,y}, clickable, editable}]. Use this to learn what you can click before acting.
- "inspect": just the structured element list (no screenshot). clickableOnly:true to get only clickable items.
- "screenshot"/"see": capture the desktop to a PNG (see also attaches elements + optional OCR). Eyes.
- "clickElement": click an element by reference — target can be its id ("e3"), ordinal number, or its visible label ("Submit"/"提交"). Resolves to its center automatically. Prefer this over raw coordinates.
- "hoverElement": move the mouse ONTO an element (by the same id/ordinal/label reference) without clicking — e.g. "move the mouse onto the Firefox button", reveal a tooltip/menu.
- "selectText": locate a word/element by reference and double-click to SELECT it — e.g. "select the word 提交". For selecting a whole span, use drag(start→end) instead.
- "move","click","doubleClick","rightClick","drag","scroll": mouse by absolute screen pixels (use when you already know coordinates).
- "type","key","hotkey": keyboard. key e.g. "enter"/"tab"; hotkey e.g. ["ctrl","c"]. "type" injects the whole string at once (fast; may bypass the active input method / IME for CJK).
- "typeKeystrokes": type like a human at a real keyboard — character by character, with a per-key delay (delayMs, default ~40ms), so the focused app and the active input method (IME) process each key. Use this when the user wants keystroke-style input rather than bulk value injection.
- "activate": bring an app/window to front by name (app:"Firefox"/"火狐"). Robust — prefer this over clicking to focus.
- "closeWindow": close a window by name (app:"Firefox"), or empty app = close the frontmost window. This is the robust "click the X to close" — no need to screenshot and aim at the X pixel.
- "minimizeWindow": minimize a window by name (app:"Firefox") or frontmost.
- "listWindows": list visible windows/apps — discover what is open before activating/closing. Read-only.
- "fillForm": fill a form. fields:[{element|ref (label/id) | x,y | selector, value, clearFirst?, tab?}], optional submit. Element-ref fields are located automatically via inspect.
- "speak"/"listen": text-to-speech / speech-to-text (mouth/ears).
WORKFLOW: observe → read marks → clickElement/hoverElement/selectText/type/fillForm by element reference. The structured marks tell you exactly what is clickable and where.
SAFETY: real mouse/keyboard control is high-risk and DISABLED by default. The human must opt in via env KHY_DESKTOP_CONTROL=on (autonomous) | ask (approve once per session) | strict (approve every action). When off, actuation/capture is denied with guidance.`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['capabilities', 'observe', 'inspect', 'screenshot', 'see', 'clickElement', 'hoverElement', 'selectText',
            'move', 'click', 'doubleClick', 'rightClick',
            'drag', 'scroll', 'type', 'typeKeystrokes', 'key', 'hotkey', 'fillForm',
            'activate', 'closeWindow', 'minimizeWindow', 'listWindows',
            'speak', 'listen'],
          description: 'Operation to perform.',
        },
        x: { type: 'number', description: 'Target X (absolute screen pixel) for mouse / capture region.' },
        y: { type: 'number', description: 'Target Y (absolute screen pixel) for mouse / capture region.' },
        x2: { type: 'number', description: 'Drag end X.' },
        y2: { type: 'number', description: 'Drag end Y.' },
        dx: { type: 'number', description: 'Scroll horizontal delta.' },
        dy: { type: 'number', description: 'Scroll vertical delta (negative = up).' },
        text: { type: 'string', description: 'Text to type / speak.' },
        delayMs: { type: 'number', description: 'typeKeystrokes: per-character delay in ms (human-paced; default ~40, max 1000).' },
        key: { type: 'string', description: 'Key name for "key" action, e.g. "enter","tab","esc".' },
        keys: { type: 'array', items: { type: 'string' }, description: 'Combo for "hotkey", e.g. ["ctrl","c"].' },
        region: {
          type: 'object',
          description: 'Optional capture region {x,y,w,h} for screenshot/see.',
          properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } },
        },
        ocr: { type: 'boolean', description: 'see/observe: run OCR on the screenshot.' },
        target: { description: 'clickElement/hoverElement/selectText: element reference — id ("e3"), ordinal number, or visible label ("Submit"/"提交").' },
        app: { type: 'string', description: 'activate/closeWindow/minimizeWindow: target application or window name/title, e.g. "Firefox"/"火狐". For close/minimize, empty = frontmost window (mac/Win).' },
        kind: { type: 'string', enum: ['click', 'doubleClick', 'rightClick'], description: 'clickElement: which mouse action (default click).' },
        clickableOnly: { type: 'boolean', description: 'inspect/observe: return only clickable elements.' },
        fields: {
          type: 'array',
          description: 'fillForm fields: [{x,y | selector, value, clearFirst?, tab?}].',
          items: { type: 'object' },
        },
        submit: { description: 'fillForm: {selector} | {x,y} to click, or true to press Enter.' },
        options: { type: 'object', description: 'speak/listen options (voice, rate, maxDurationSeconds, language).' },
        timeoutMs: { type: 'number', description: 'Optional hard timeout in milliseconds for the action (default 30000, range 1000–300000). Backstops hangs in UI-automation actions. Does not apply to speak/listen (which are bounded by their own maxDurationSeconds).' },
      },
      required: ['action'],
    };
  }

  /** @param {object} [deps] test seam: { controller } overrides the DesktopController instance. */
  async execute(params = {}, deps = {}) {
    const action = params && params.action;
    if (!action) return { success: false, error: 'DesktopControl 需要 "action"。', action: null };

    let controller = deps.controller;
    if (!controller) {
      const { DesktopController } = require('../../services/desktopControl');
      // 宿主逐项审批桥接（修复「批准了仍显示权限被拒绝」）：工具层 Gate-1 在用户经权限框
      // 显式批准后,会往本次调用的 params 上盖不可伪造的 EXEC_APPROVED Symbol 戳。把它翻译成
      // io.hostApproved 传给桌面子系统的 safetyGate,使其据用户的真实批准放行——无需用户再
      // 额外设 KHY_DESKTOP_CONTROL 主开关。模型无法经 JSON 伪造该 Symbol,故安全。
      controller = new DesktopController({
        sessionId: deps.sessionId || (params && params.sessionId) || '__default__',
        io: { hostApproved: DesktopControlTool.hostApprovedFromParams(params) },
      });
    }

    try {
      const dispatch = async () => {
      switch (action) {
        case 'capabilities': return controller.capabilities();
        case 'observe': return await controller.observe({ region: params.region, ocr: !!params.ocr, clickableOnly: params.clickableOnly });
        case 'inspect': return await controller.inspect({ region: params.region, clickableOnly: params.clickableOnly });
        case 'clickElement': return await controller.clickElement(params.target, { kind: params.kind, elements: params.elements, refresh: params.refresh });
        case 'hoverElement': return await controller.hoverElement(params.target, { elements: params.elements, refresh: params.refresh });
        case 'selectText': return await controller.selectText(params.target, { elements: params.elements, refresh: params.refresh });
        case 'screenshot': return await controller.screenshot({ region: params.region, outPath: params.outPath });
        case 'see': return await controller.see({ region: params.region, ocr: params.ocr !== false, clickableOnly: params.clickableOnly });
        case 'move': return await controller.move(params.x, params.y);
        case 'click': return await controller.click(params.x, params.y);
        case 'doubleClick': return await controller.doubleClick(params.x, params.y);
        case 'rightClick': return await controller.rightClick(params.x, params.y);
        case 'drag': return await controller.drag(params.x, params.y, params.x2, params.y2);
        case 'scroll': return await controller.scroll(params.dx || 0, params.dy || 0);
        case 'type': return await controller.type(params.text || '');
        case 'typeKeystrokes': return await controller.typeKeystrokes(params.text || '', { delayMs: params.delayMs });
        case 'key': return await controller.key(params.key);
        case 'hotkey': return await controller.hotkey(params.keys);
        case 'activate': return await controller.activate(params.app || params.name || params.target);
        case 'closeWindow': return await controller.closeWindow(params.app || params.name || params.target);
        case 'minimizeWindow': return await controller.minimizeWindow(params.app || params.name || params.target);
        case 'listWindows': return await controller.listWindows();
        case 'fillForm': return await controller.fillForm({ fields: params.fields, submit: params.submit });
        case 'speak': return await controller.speak(params.text || '', params.options || {});
        case 'listen': return await controller.listen(params.options || {});
        default: return { success: false, error: `未知 action: ${action}`, action };
      }
      };
      // speak/listen 由各自 maxDurationSeconds 自限,不套墙钟(否则会截断合法的长音频操作);
      // 其余 UI 自动化动作套模型可设墙钟兜底 hang(门控关 → 逐字节回退直接 await)。
      if (action === 'speak' || action === 'listen') {
        return await dispatch();
      }
      const { resolveToolTimeoutMs, withDeadline } = require('../_toolTimeout');
      const timeoutMs = resolveToolTimeoutMs({
        paramMs: params && params.timeoutMs,
        envKey: 'KHY_DESKTOP_CONTROL_TIMEOUT_MS',
        defaultMs: 30000,
        min: 1000,
        max: 300000,
      });
      const raced = await withDeadline(() => dispatch(), timeoutMs);
      if (raced && raced.__timedOut) {
        return { success: false, action, error: `DesktopControl "${action}" 超时:已达 ${raced.timeoutMs}ms 硬上限` };
      }
      if (raced && raced.__error) {
        return { success: false, action, error: (raced.__error && raced.__error.message) || String(raced.__error) };
      }
      return raced;
    } catch (err) {
      return { success: false, action, error: (err && err.message) || String(err) };
    }
  }

  // 声明：actuation 类动作属高危物理操控（供上层透明展示/审计）。
  static isActuation(action) { return ACTUATE.has(action); }

  /**
   * 读取本次调用是否携带 Gate-1 盖的不可伪造 EXEC_APPROVED 戳（=用户已在权限框逐项批准）。
   * 单一真源：execute 据此构造 io.hostApproved；安全闸门据此放行。模型无法经 JSON 伪造 Symbol。
   * @param {object} params  归一化后的工具入参（toolCalling 在网关放行后盖戳于其上）
   * @returns {boolean}
   */
  static hostApprovedFromParams(params) {
    if (!params || typeof params !== 'object') return false;
    try {
      const { EXEC_APPROVED } = require('../../services/execApproval');
      return !!EXEC_APPROVED && params[EXEC_APPROVED] === true;
    } catch {
      return false; // execApproval 缺失 → 退回仅 env 授权，保守 fail-closed
    }
  }
}

module.exports = DesktopControlTool;

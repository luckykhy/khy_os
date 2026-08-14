'use strict';

/**
 * desktopControl — Khyos 的「眼、耳、嘴、手」桌面操控子系统（DESIGN-ARCH-056）。
 *
 * 单一导入面 DesktopController：让 Khyos 能看屏幕、听语音、说话，并模拟真实鼠标/键盘
 * 操控电脑、填写表单。四感官统一在一个门面后：
 *
 *   眼 see()/screenshot()  截屏 → 可喂给 OCR/多模态「看懂」屏幕   （screenCapture）
 *   手 click/type/...      模拟鼠标键盘                          （inputController）
 *      fillForm()          原生/Web 表单自动填写                  （formFiller）
 *   嘴 speak()             文本朗读                              （voiceBridge→voiceService）
 *   耳 listen()            录音转写                              （voiceBridge→voiceService）
 *
 * 安全铁律：**所有 capture/actuate 操作必先过 safetyGate**（见 safetyGate.js）。
 * 门面是唯一对外入口，因此「先授权后操作」在此被结构性保证——绕过门面直接调底层
 * 模块等于绕过审批，仅限内部/测试。默认 KHY_DESKTOP_CONTROL=off → 一切操控被拒。
 */

const detector = require('./backendDetector');
const elementModel = require('./elementModel');
const formFiller = require('./formFiller');
const inputController = require('./inputController');
const safetyGate = require('./safetyGate');
const screenCapture = require('./screenCapture');
const uiInspector = require('./uiInspector');
const voiceBridge = require('./voiceBridge');
const windowController = require('./windowController');
const { WorkflowRecorder } = require('./workflowRecorder');

/**
 * 统一授权包装：op 先过闸门，放行才执行 fn；actuate 成功后计入熔断预算。
 * @returns 闸门拒绝时返回 { success:false, denied:true, reason }。
 */
async function _guarded(op, ctx, fn) {
  const decision = await safetyGate.authorize(
    { op, sessionId: ctx.sessionId, params: ctx.params },
    ctx.io || {}
  );
  if (!decision.allow) {
    return { success: false, denied: true, op, reason: decision.reason, mode: decision.mode };
  }
  const result = await fn();
  if (result && result.success !== false && safetyGate.classifyOp(op) === 'actuate') {
    safetyGate.noteActuation(ctx.sessionId, op);
  }
  return result;
}

class DesktopController {
  /** @param {object} [opts] { sessionId, io } —— io 透传给 safetyGate（gatewayEvaluate/prompter/budget）。 */
  constructor(opts = {}) {
    this.sessionId = opts.sessionId || '__default__';
    this.io = opts.io || {};
    // 允许测试注入替身。
    this._detector = opts.detector || detector;
    this._capture = opts.screenCapture || screenCapture;
    this._input = opts.inputController || inputController;
    this._window = opts.windowController || windowController;
    this._form = opts.formFiller || formFiller;
    this._voice = opts.voiceBridge || voiceBridge;
    this._inspector = opts.uiInspector || uiInspector;
    // 最近一次感知到的元素清单（供 clickElement / fillForm 按引用寻址）。
    this._lastElements = [];
    // Workflow recording state (null when not recording).
    this._recorder = null;
    this._recorderGuard = 0;
    this._recorderProxy = null;
  }

  _ctx(params) {
    return { sessionId: this.sessionId, params, io: this.io };
  }

  // ── 能力探测（只读，无需授权）──────────────────────────────────
  capabilities() {
    const caps = this._detector.detect();
    const voice = this._voice.capabilities();
    return {
      success: true,
      platform: caps.platform,
      eyes: caps.eyes,
      perception: caps.perception,
      hands: caps.hands,
      mouth: voice.mouth,
      ears: voice.ears,
      summary: {
        canSee: caps.summary.canSee,
        canPerceive: caps.summary.canPerceive,
        canActuate: caps.summary.canActuate,
        canSpeak: voice.mouth.available,
        canHear: voice.ears.available,
      },
      gate: safetyGate.inspect(this.sessionId),
    };
  }

  // ── 眼 ─────────────────────────────────────────────────────────
  screenshot(opts = {}) {
    return _guarded('screenshot', this._ctx(opts), () => this._capture.capture(opts));
  }

  /**
   * desktopIcons()：直接枚举桌面图标清单（Windows 用 SysListView32「FolderView」，
   * 无截图/OCR/视觉依赖），回答「桌面上有什么」比 OCR 截图更可靠。
   * 归 capture 类受闸门管辖。非 Windows 平台回退普通无障碍树。
   * @param {object} [opts] { clickableOnly }
   */
  desktopIcons(opts = {}) {
    return _guarded('inspect', this._ctx(opts), async () => {
      const r = await this._inspector.inspect({ ...opts, desktop: true }, {});
      if (r && r.success && Array.isArray(r.elements)) {
        this._lastElements = r.elements;
      }
      return r;
    });
  }

  /**
   * see()：截屏 + 可选 OCR + 可选结构化元素清单，合成一个 AI 可直接操控的「场景」。
   * 默认 elements:true → 附上可点击/可填写元素（让 AI 知道屏幕上有什么、怎么点）。
   * @param {object} opts { region, ocr:boolean, ocrFn, elements:boolean }
   */
  async see(opts = {}) {
    const shot = await this.screenshot(opts);
    if (!shot || shot.success === false) {
      return shot;
    }

    let out = { ...shot, recognized: null };
    if (opts.ocr) {
      try {
        const ocrFn = opts.ocrFn || _defaultOcr;
        const ocrOptions = opts.ocrOptions || {};
        out.recognized = await ocrFn(shot.path, ocrOptions);
      } catch (e) {
        out = { ...out, ocrError: (e && e.message) || String(e) };
      }
    }

    // 结构化感知：默认开（除非显式 elements:false）。失败不影响截图主路径。
    if (opts.elements !== false) {
      const scene = await this.inspect({ region: opts.region, clickableOnly: opts.clickableOnly });
      if (scene && scene.success) {
        out.elements = scene.elements;
        out.marks = scene.marks;
        out.clickable = scene.clickable;
        out.elementSource = scene.source;
      } else {
        out.elements = [];
        out.marks = [];
        out.clickable = [];
        out.perceptionError = scene && scene.error;
        out.perceptionHints = scene && scene.installHints;
      }
    }
    return out;
  }

  /**
   * inspect()：抓当前屏幕的结构化可操控元素清单（无障碍树）。归 capture 类，受闸门管辖。
   * 记住结果到会话，供随后 clickElement/fillForm 按 id/名称引用。
   * @param {object} opts { region, clickableOnly }
   */
  inspect(opts = {}) {
    return _guarded('inspect', this._ctx(opts), async () => {
      const r = await this._inspector.inspect(opts, {});
      if (r && r.success && Array.isArray(r.elements)) {
        this._lastElements = r.elements;
      }
      return r;
    });
  }

  /**
   * observe()：一步到位的「看清现场」——截屏 + 结构化元素 +（可选）OCR，合成完整场景。
   * 这是给 AI 的主感知入口：拿到 screenshot 路径(给多模态看) + marks(可点击结构化数据)。
   */
  async observe(opts = {}) {
    return this.see({ ...opts, elements: true, ocr: !!opts.ocr });
  }

  /**
   * clickElement()：按引用（元素 id "e3" / 序号 / 名称「提交」）点击——「让 AI 知道怎么操控」。
   * 先在已知元素里寻址，未知则即时 inspect 一次再寻址；解析出中心点后走 guarded 点击。
   * @param {string|number} ref
   * @param {object} [opts] { elements:[…], kind:'click'|'doubleClick'|'rightClick', refresh:boolean }
   */
  async clickElement(ref, opts = {}) {
    const located = await this._locateElement(ref, opts);
    if (!located.ok) {
      return located.result;
    }
    const el = located.element;

    const kind = ['click', 'doubleClick', 'rightClick'].includes(opts.kind) ? opts.kind : 'click';
    const result = await this[kind](el.center.x, el.center.y);
    return {
      ...result,
      target: { id: el.id, name: el.name, role: el.role, center: el.center },
      ambiguous: located.ambiguous,
      candidates: located.candidates,
    };
  }

  /**
   * hoverElement()：把鼠标【移到】某元素上但不点击——「鼠标移到火狐键上」「移到 X 上」。
   * 与 clickElement 共用寻址（id/序号/名称），解析出中心点后只 move 不 click。
   * @param {string|number} ref
   * @param {object} [opts] { elements:[…], refresh:boolean }
   */
  async hoverElement(ref, opts = {}) {
    const located = await this._locateElement(ref, opts);
    if (!located.ok) {
      return located.result;
    }
    const el = located.element;
    const result = await this.move(el.center.x, el.center.y);
    return {
      ...result,
      target: { id: el.id, name: el.name, role: el.role, center: el.center },
      ambiguous: located.ambiguous,
      candidates: located.candidates,
    };
  }

  /**
   * selectText()：定位指定的词/元素后【双击选中】它——「选中我指定的某个词」。
   * 双击是各平台文本里选词的通用手势；定位走无障碍元素树（OCR 不提供词级包围盒，不可靠）。
   * 需要按住拖选整段时用 drag(起点→终点)。
   * @param {string|number} ref  目标词/元素的名称、id 或序号
   * @param {object} [opts] { elements:[…], refresh:boolean }
   */
  async selectText(ref, opts = {}) {
    const located = await this._locateElement(ref, opts);
    if (!located.ok) {
      return located.result;
    }
    const el = located.element;
    const result = await this.doubleClick(el.center.x, el.center.y);
    return {
      ...result,
      selected: el.name,
      target: { id: el.id, name: el.name, role: el.role, center: el.center },
      ambiguous: located.ambiguous,
      candidates: located.candidates,
    };
  }

  /**
   * 共享寻址：把元素引用 ref 解析为带中心点的元素。失败时返回可直接回传的结果对象。
   * @returns {Promise<{ok:true, element, ambiguous?, candidates?} | {ok:false, result}>}
   */
  async _locateElement(ref, opts = {}) {
    let elements =
      Array.isArray(opts.elements) && opts.elements.length ? opts.elements : this._lastElements;
    if (opts.refresh || !elements || elements.length === 0) {
      const scene = await this.inspect({});
      if (!scene || scene.success === false) {
        return {
          ok: false,
          result: {
            success: false,
            denied: scene && scene.denied,
            error: (scene && (scene.reason || scene.error)) || '无法感知屏幕元素。',
            installHints: scene && scene.installHints,
          },
        };
      }
      elements = scene.elements;
    }
    const hit = elementModel.resolveTarget(elements, ref);
    if (!hit.ok) {
      return { ok: false, result: { success: false, error: hit.reason, ref } };
    }
    const el = hit.element;
    if (!el.center) {
      return {
        ok: false,
        result: {
          success: false,
          error: `元素 ${el.id}「${el.name}」无包围盒，无法定位坐标。`,
          ref,
        },
      };
    }
    return { ok: true, element: el, ambiguous: hit.ambiguous, candidates: hit.candidates };
  }

  // ── 手：鼠标 ───────────────────────────────────────────────────
  move(x, y) {
    return _guarded('move', this._ctx({ x, y }), () => this._input.move(x, y));
  }
  click(x, y) {
    return _guarded('click', this._ctx({ x, y }), () => this._input.click(x, y));
  }
  doubleClick(x, y) {
    return _guarded('doubleClick', this._ctx({ x, y }), () => this._input.doubleClick(x, y));
  }
  rightClick(x, y) {
    return _guarded('rightClick', this._ctx({ x, y }), () => this._input.rightClick(x, y));
  }
  drag(x1, y1, x2, y2) {
    return _guarded('drag', this._ctx({ x1, y1, x2, y2 }), () => this._input.drag(x1, y1, x2, y2));
  }
  scroll(dx, dy) {
    return _guarded('scroll', this._ctx({ dx, dy }), () => this._input.scroll(dx, dy));
  }

  // ── 手：键盘 ───────────────────────────────────────────────────
  type(text) {
    return _guarded('type', this._ctx({ textLen: (text || '').length }), () =>
      this._input.type(text)
    );
  }
  // 逐键 / 输入法模式：像人手一样逐字符敲、带节奏延迟，走真实键盘事件路径（让输入法可介入）。
  typeKeystrokes(text, opts = {}) {
    return _guarded(
      'typeKeystrokes',
      this._ctx({ textLen: (text || '').length, delayMs: opts.delayMs }),
      () => this._input.typeKeystrokes(text, opts)
    );
  }
  key(keyName) {
    return _guarded('key', this._ctx({ keyName }), () => this._input.key(keyName));
  }
  hotkey(keys) {
    return _guarded('hotkey', this._ctx({ keys }), () => this._input.hotkey(keys));
  }

  // ── 手：窗口管理 ───────────────────────────────────────────────
  // 按应用/窗口名健壮操控窗口（无需先截屏点 X 像素）。归 actuate 类，计入熔断预算。
  activate(name) {
    return _guarded('activate', this._ctx({ name }), () => this._window.activate(name));
  }
  closeWindow(name) {
    return _guarded('closeWindow', this._ctx({ name }), () => this._window.closeWindow(name));
  }
  minimizeWindow(name) {
    return _guarded('minimizeWindow', this._ctx({ name }), () => this._window.minimizeWindow(name));
  }
  listWindows() {
    return _guarded('listWindows', this._ctx({}), () => this._window.listWindows());
  }

  // ── 手：填表 ───────────────────────────────────────────────────
  /**
   * fillForm()：每一步原子操作都各自过闸门（经包了 safetyGate 的 actuator），
   * 因此中途授权被吊销/超预算会立即停在那一步——不会出现「半放行」。
   * @param {object} spec { fields:[{selector|x,y, value, clearFirst?, tab?}], submit?, webExecute? }
   */
  async fillForm(spec = {}) {
    // 预检一次（拿到明确拒绝原因，避免逐步试探）。
    const pre = await safetyGate.authorize(
      { op: 'fillForm', sessionId: this.sessionId, params: { fields: (spec.fields || []).length } },
      this.io
    );
    if (!pre.allow) {
      return { success: false, denied: true, op: 'fillForm', reason: pre.reason, mode: pre.mode };
    }

    // 元素引用字段（{element|ref, value}）→ 即时感知一次并解析成 {x,y}。
    // 让 AI 可以「在『邮箱』框里填 a@b.c」而无需先知道坐标。
    const resolved = await this._resolveElementFields(spec);
    if (resolved.error) {
      return { success: false, op: 'fillForm', error: resolved.error };
    }
    spec = resolved.spec;

    // 用「经闸门包装的注入器」驱动每一步，保证逐步授权与计数。
    const self = this;
    const guardedActuator = {
      click: (x, y) => self.click(x, y),
      type: (t) => self.type(t),
      key: (k) => self.key(k),
      hotkey: (ks) => self.hotkey(ks),
    };
    return this._form.executeFill(spec, {
      actuator: guardedActuator,
      webExecute: spec.webExecute,
      platform: this._detector.detect().platform,
      onStep: spec.onStep,
    });
  }

  /**
   * 把字段里的元素引用（{element|ref}）解析成原生坐标 {x,y}。
   * 仅当存在此类字段时才触发一次 inspect（避免无谓感知）。selector/x,y 字段原样透传。
   * @returns {Promise<{spec?:object, error?:string}>}
   */
  async _resolveElementFields(spec) {
    const fields = Array.isArray(spec.fields) ? spec.fields : [];
    const needs = fields.some(
      (f) =>
        f &&
        (f.element != null || f.ref != null) &&
        !(typeof f.selector === 'string' && f.selector.trim()) &&
        !(Number.isFinite(f.x) && Number.isFinite(f.y))
    );
    if (!needs) {
      return { spec };
    }

    let elements =
      Array.isArray(spec.elements) && spec.elements.length ? spec.elements : this._lastElements;
    if (!elements || elements.length === 0) {
      const scene = await this.inspect({});
      if (!scene || scene.success === false) {
        return {
          error: `表单含元素引用字段，但无法感知屏幕元素：${(scene && (scene.reason || scene.error)) || '感知不可用'}。`,
        };
      }
      elements = scene.elements;
    }

    const newFields = [];
    for (let i = 0; i < fields.length; i += 1) {
      const f = fields[i];
      const ref = f && (f.element != null ? f.element : f.ref);
      const hasOther =
        (typeof f.selector === 'string' && f.selector.trim()) ||
        (Number.isFinite(f.x) && Number.isFinite(f.y));
      if (ref == null || hasOther) {
        newFields.push(f);
        continue;
      }
      const hit = elementModel.resolveTarget(elements, ref);
      if (!hit.ok || !hit.element.center) {
        return {
          error: `字段#${i} 的元素引用「${ref}」无法定位：${hit.reason || '该元素无包围盒'}。`,
        };
      }
      const { x, y } = hit.element.center;
      // 元素引用默认 clearFirst（聚焦后先清空），更贴近「填表」直觉；可被字段显式覆盖。
      newFields.push({ ...f, x, y, clearFirst: f.clearFirst !== false });
    }
    return { spec: { ...spec, fields: newFields } };
  }

  // ── 录制控制 ──────────────────────────────────────────────────

  /**
   * Start recording desktop actions into a WorkflowRecorder.
   * All methods in _RECORD_METHODS are wrapped with a Proxy facade so that
   * internal delegation (e.g. observe→see→screenshot) is depth-guarded and
   * only the outermost semantic call is recorded.
   * @param {object} [opts] { name, params, stepDelay }
   */
  startRecord(opts = {}) {
    if (this._recorder) {
      return this._recorder;
    }
    this._recorder = new WorkflowRecorder(this.sessionId, opts);
    this._recorder.start();
    this._recorderGuard = 0;
    this._recorderProxy = this._buildRecordProxy();
    return this._recorder;
  }

  /**
   * Stop recording and return the generated workflow graph.
   * Restores all wrapped methods to their originals.
   */
  stopRecord() {
    if (!this._recorder) {
      return null;
    }
    this._recorderGuard = 0;
    this._recorderProxy = null;
    const workflow = this._recorder.stop();
    this._recorder = null;
    return workflow;
  }

  /**
   * Feed a completed action into the active recorder.
   * @param {string} action
   * @param {object} params
   * @param {*} result
   * @param {Array} args  Original method arguments (used for text extraction).
   */
  _onActionForRecorder(action, params, result, args) {
    if (!this._recorder || !this._recorder.active) {
      return;
    }
    const recordParams = { ...params };
    // Restore original text for type/typeKeystrokes (ctx only carries textLen).
    if ((action === 'type' || action === 'typeKeystrokes') && args && args[0] != null) {
      recordParams.text = String(args[0]);
    }
    this._recorder.onAction(action, recordParams, result || {});
  }

  /**
   * Build a Proxy facade over this controller.  When a recorded method calls
   * another method via `this.xxx()`, the proxy intercepts and either wraps
   * (with depth guard) or delegates to the original.  This ensures nested
   * composite calls (observe→see→screenshot) only record the outermost action.
   */
  _buildRecordProxy() {
    const self = this;
    const origMethods = {};
    for (const name of DesktopController._RECORD_METHODS) {
      origMethods[name] = Object.getPrototypeOf(this)[name];
    }
    return new Proxy(this, {
      get(target, prop, receiver) {
        if (typeof prop !== 'string' || !Object.prototype.hasOwnProperty.call(origMethods, prop)) {
          return Reflect.get(target, prop, receiver);
        }
        return async function (...args) {
          // Depth guard: suppress recording for nested calls inside composites.
          self._recorderGuard++;
          let result;
          try {
            result = await origMethods[prop].call(receiver, ...args);
          } finally {
            self._recorderGuard--;
          }
          if (self._recorderGuard === 0) {
            const ctxParams =
              args.length === 1 && typeof args[0] === 'object' && args[0] !== null ? args[0] : {};
            self._onActionForRecorder(prop, ctxParams, result, args);
          }
          return result;
        };
      },
    });
  }

  // ── 嘴 / 耳 ────────────────────────────────────────────────────
  speak(text, options = {}) {
    return _guarded('speak', this._ctx({ textLen: (text || '').length }), () =>
      this._voice.speak(text, options)
    );
  }
  stopSpeaking() {
    return this._voice.stopSpeaking();
  }
  listen(options = {}) {
    return _guarded('listen', this._ctx({}), () => this._voice.listen(options));
  }
}

// Methods whose calls are intercepted during recording.
DesktopController._RECORD_METHODS = [
  'screenshot',
  'see',
  'inspect',
  'observe',
  'clickElement',
  'hoverElement',
  'selectText',
  'move',
  'click',
  'doubleClick',
  'rightClick',
  'drag',
  'scroll',
  'type',
  'typeKeystrokes',
  'key',
  'hotkey',
  'activate',
  'closeWindow',
  'minimizeWindow',
  'listWindows',
  'speak',
  'listen',
];

/** 默认 OCR：复用既有 OCR 片段服务（如可用）。 */
async function _defaultOcr(imagePath, options = {}) {
  const svc = require('../ocrSnippetService');
  if (svc && typeof svc.extractImageOcrSnippetAsync === 'function') {
    const r = await svc.extractImageOcrSnippetAsync(imagePath, '', options);
    if (r && r.success) {
      return { text: r.text, engine: r.engine || 'tesseract', confidence: r.confidence || 0 };
    }
    // OCR 引擎不可用等底层原因 → 透传真实错误，避免误导性报错
    if (r && r.error) {
      throw new Error(`OCR 失败: ${r.error}`);
    }
  }
  throw new Error('未找到可用的 OCR 入口（ocrSnippetService.extractImageOcrSnippetAsync）。');
}

module.exports = {
  DesktopController,
  // 子模块再导出（便于高级集成 / 测试）。
  detector,
  screenCapture,
  inputController,
  windowController,
  formFiller,
  voiceBridge,
  safetyGate,
  uiInspector,
  elementModel,
  WorkflowRecorder,
  // 便捷工厂。
  create(opts) {
    return new DesktopController(opts);
  },
};

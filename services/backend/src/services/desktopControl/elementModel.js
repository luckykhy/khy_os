'use strict';

/**
 * desktopControl/elementModel.js — UI 元素的【规范化模型与寻址】（DESIGN-ARCH-056 感知层）。
 *
 * 「让 AI 知道怎么操控」的核心：把各平台无障碍树（macOS AX / Linux AT-SPI / Windows UIA）
 * 抓到的、形态各异的原始节点，规范成一份**统一、可寻址、可点击的结构化清单**。模型拿到的
 * 不再是一张「截图像素」，而是一组带 id/角色/标签/包围盒/中心点/可点击标志的元素——它可以
 * 直接说「点 e3」或「点 提交 按钮」，由 resolveTarget 解析回精确坐标。
 *
 * 本模块是**纯函数**：零 I/O、零副作用，只做数据形状转换与查找——因此可被穷尽单测。
 *
 * 设计约束：
 *   1) 角色词表（role）跨平台不同（AXButton / "push button" / Button），统一在此映射到
 *      一套 canonical 角色（单一真源），可点击/可编辑的判定只认 canonical 角色。
 *   2) 绝不伪造：缺包围盒（无法定位）的节点标记 clickable=false，不臆造坐标。
 *   3) id 稳定且人类可读（e1,e2,…），便于模型在多轮里引用同一元素。
 */

// ── 跨平台原生角色 → canonical 角色（单一真源）。键为小写原生角色串。 ──
const ROLE_MAP = {
  // 按钮
  button: 'button', axbutton: 'button', 'push button': 'button', pushbutton: 'button',
  'menu button': 'button', splitbutton: 'button', 'toggle button': 'button',
  // 链接
  link: 'link', axlink: 'link', hyperlink: 'link',
  // 文本输入（可编辑）
  textfield: 'textfield', axtextfield: 'textfield', axtextarea: 'textfield',
  edit: 'textfield', entry: 'textfield', textbox: 'textfield', 'text entry': 'textfield',
  'password text': 'textfield', axsecuretextfield: 'textfield',
  // 勾选 / 单选
  checkbox: 'checkbox', axcheckbox: 'checkbox', 'check box': 'checkbox',
  radiobutton: 'radio', axradiobutton: 'radio', 'radio button': 'radio',
  // 菜单项
  menuitem: 'menuitem', axmenuitem: 'menuitem', 'menu item': 'menuitem',
  'check menu item': 'menuitem', 'radio menu item': 'menuitem',
  // 选项卡
  tab: 'tab', axtab: 'tab', tabitem: 'tab', 'page tab': 'tab',
  // 下拉/组合
  combobox: 'combobox', axcombobox: 'combobox', 'combo box': 'combobox',
  axpopupbutton: 'combobox', 'popup button': 'combobox', list: 'combobox',
  // 其它常见可交互
  slider: 'slider', axslider: 'slider',
  listitem: 'listitem', axrow: 'listitem', 'list item': 'listitem',
  // 静态/容器（不可点击，仅作上下文）
  text: 'text', axstatictext: 'text', label: 'text', statictext: 'text',
  image: 'image', aximage: 'image',
};

// canonical 角色里「可点击/可激活」的集合（单一真源）。
const CLICKABLE_ROLES = new Set([
  'button', 'link', 'checkbox', 'radio', 'menuitem', 'tab', 'combobox', 'slider', 'listitem',
]);
// canonical 角色里「可输入文本」的集合。
const EDITABLE_ROLES = new Set(['textfield', 'combobox']);

function canonicalRole(rawRole) {
  const key = String(rawRole == null ? '' : rawRole).trim().toLowerCase();
  if (!key) return 'generic';
  if (ROLE_MAP[key]) return ROLE_MAP[key];
  // 容错：含 "button"/"text"/"link" 等关键词的未登记角色按词归类。
  if (key.includes('button')) return 'button';
  if (key.includes('link')) return 'link';
  if (key.includes('text') || key.includes('edit') || key.includes('entry')) return 'textfield';
  if (key.includes('checkbox') || key.includes('check box')) return 'checkbox';
  if (key.includes('menu')) return 'menuitem';
  return 'generic';
}

function _num(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v : null;
}

/** 包围盒有效（可定位）才算可点击的前提：x,y,w,h 均为有限数且 w,h>0。 */
function _validBounds(b) {
  return b && _num(b.x) != null && _num(b.y) != null
    && _num(b.w) != null && _num(b.h) != null && b.w > 0 && b.h > 0;
}

function centerOf(bounds) {
  if (!_validBounds(bounds)) return null;
  return {
    x: Math.round(bounds.x + bounds.w / 2),
    y: Math.round(bounds.y + bounds.h / 2),
  };
}

/**
 * 把一个原始节点规范成统一元素。原始字段名宽松（x/y/w/h 或 bounds，role，name/title/label，value）。
 * @param {object} raw
 * @param {number} index  0-based 顺序号（用于生成稳定 id e{index+1}）
 */
function normalizeElement(raw = {}, index = 0) {
  const role = canonicalRole(raw.role);
  const name = String(raw.name || raw.title || raw.label || raw.description || '').trim();
  const value = raw.value == null ? '' : String(raw.value);

  const bx = raw.bounds || { x: raw.x, y: raw.y, w: raw.w != null ? raw.w : raw.width, h: raw.h != null ? raw.h : raw.height };
  const hasBounds = _validBounds(bx);
  const bounds = hasBounds
    ? { x: Math.round(_num(bx.x)), y: Math.round(_num(bx.y)), w: Math.round(_num(bx.w)), h: Math.round(_num(bx.h)) }
    : null;

  const enabled = raw.enabled === undefined ? true : !!raw.enabled;
  const roleClickable = CLICKABLE_ROLES.has(role);
  const editable = EDITABLE_ROLES.has(role);
  // 真正可点击 = 角色可激活 + 有包围盒(能定位) + 启用态。无包围盒绝不臆造坐标。
  const clickable = roleClickable && hasBounds && enabled;

  return {
    id: `e${index + 1}`,
    index,
    role,
    nativeRole: raw.role == null ? null : String(raw.role),
    name,
    value,
    bounds,
    center: hasBounds ? centerOf(bounds) : null,
    enabled,
    clickable,
    editable: editable && hasBounds && enabled,
    source: raw.source || null,
  };
}

/**
 * 规范化一组原始节点：过滤无意义空节点、规范、去重（同角色+同名+包围盒高度重叠视为重复）。
 * @returns {object[]} 规范化元素（已重排 id 为 e1..eN）。
 */
function normalizeAll(rawList = []) {
  const list = Array.isArray(rawList) ? rawList : [];
  const normalized = [];
  for (const raw of list) {
    const el = normalizeElement(raw, normalized.length);
    // 丢弃彻底无信息的节点：既无名字、又无可点击/可编辑能力、又无包围盒。
    if (!el.name && !el.clickable && !el.editable && !el.bounds) continue;
    if (_isDuplicate(normalized, el)) continue;
    el.id = `e${normalized.length + 1}`;
    el.index = normalized.length;
    normalized.push(el);
  }
  return normalized;
}

function _overlapRatio(a, b) {
  if (!a || !b) return 0;
  const ix = Math.max(a.x, b.x);
  const iy = Math.max(a.y, b.y);
  const ax2 = a.x + a.w; const ay2 = a.y + a.h;
  const bx2 = b.x + b.w; const by2 = b.y + b.h;
  const iw = Math.min(ax2, bx2) - ix;
  const ih = Math.min(ay2, by2) - iy;
  if (iw <= 0 || ih <= 0) return 0;
  const inter = iw * ih;
  const areaA = a.w * a.h; const areaB = b.w * b.h;
  const union = areaA + areaB - inter;
  return union > 0 ? inter / union : 0;
}

function _isDuplicate(existing, el) {
  for (const e of existing) {
    if (e.role === el.role && e.name === el.name && el.name
      && _overlapRatio(e.bounds, el.bounds) > 0.85) return true;
  }
  return false;
}

/** 只保留可点击元素（供「把可点击按钮作为结构化数据返回」）。 */
function filterClickable(elements = []) {
  return (elements || []).filter((e) => e && e.clickable);
}

/**
 * Set-of-marks：把元素压成「带编号标记」的精简清单——这就是返回给 AI 的可操控结构化数据。
 * 每个 mark：{ id, role, label, center:{x,y}, bounds, clickable, editable }。
 */
function toMarks(elements = []) {
  return (elements || []).map((e) => ({
    id: e.id,
    role: e.role,
    label: e.name || e.value || `(${e.role})`,
    center: e.center,
    bounds: e.bounds,
    clickable: e.clickable,
    editable: e.editable,
  }));
}

/**
 * 按引用解析目标元素。ref 可为：
 *   - 元素 id 串 "e3"
 *   - 0-based 或 1-based 序号（数字 / 数字串）
 *   - 名称/标签（大小写无关：精确 > 前缀 > 包含）
 * @returns {{ok:boolean, element?:object, reason?:string, candidates?:object[]}}
 */
function resolveTarget(elements = [], ref) {
  const list = Array.isArray(elements) ? elements : [];
  if (ref == null || ref === '') return { ok: false, reason: '未提供目标引用 ref。' };

  // 1) id 串 "e3"
  if (typeof ref === 'string' && /^e\d+$/i.test(ref.trim())) {
    const el = list.find((e) => e.id.toLowerCase() === ref.trim().toLowerCase());
    return el ? { ok: true, element: el } : { ok: false, reason: `未找到 id 为 ${ref} 的元素。` };
  }

  // 2) 纯数字（接受 0-based index 或 1-based 顺序）
  const asNum = typeof ref === 'number' ? ref : (/^\d+$/.test(String(ref).trim()) ? Number(String(ref).trim()) : null);
  if (asNum != null) {
    const byIndex = list.find((e) => e.index === asNum);
    if (byIndex) return { ok: true, element: byIndex };
    const byOrdinal = list[asNum - 1];
    if (byOrdinal) return { ok: true, element: byOrdinal };
    return { ok: false, reason: `序号 ${ref} 超出元素范围（共 ${list.length} 个）。` };
  }

  // 3) 名称/标签匹配
  const q = String(ref).trim().toLowerCase();
  if (!q) return { ok: false, reason: '目标引用为空。' };
  const named = list.filter((e) => (e.name || '').trim());
  const exact = named.filter((e) => e.name.toLowerCase() === q);
  const prefix = named.filter((e) => e.name.toLowerCase().startsWith(q));
  const includes = named.filter((e) => e.name.toLowerCase().includes(q));
  const pick = exact.length ? exact : (prefix.length ? prefix : includes);

  if (pick.length === 0) return { ok: false, reason: `未找到名称匹配「${ref}」的元素。` };
  if (pick.length > 1) {
    // 多个候选：返回第一个但带歧义提示（让上层可选择更精确引用）。
    return { ok: true, element: pick[0], ambiguous: true, candidates: pick.map((e) => ({ id: e.id, name: e.name, role: e.role })) };
  }
  return { ok: true, element: pick[0] };
}

module.exports = {
  normalizeElement,
  normalizeAll,
  centerOf,
  canonicalRole,
  filterClickable,
  toMarks,
  resolveTarget,
  CLICKABLE_ROLES,
  EDITABLE_ROLES,
  ROLE_MAP,
  _internals: { _validBounds, _overlapRatio, _isDuplicate },
};

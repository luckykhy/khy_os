'use strict';

/**
 * lenientResponseParser.js — 模型响应宽松解析层（任务三 · 模型自适应 · 数据解析层）。
 *
 * 宪法红线落点：
 *   - 红线1（严禁脆弱解析）：绝不用强类型严格校验整个 AI 响应体；多出一个未知字段
 *     绝不抛 Fatal，未知字段一律捕获 + 记日志后照常处理。
 *   - 红线2（严禁静默吞没）：动作内的未知键不丢弃，写入 `_unknownKeys` 并产出 warning。
 *   - 红线3（严禁假设终态）：对任意输入（对象/字符串/null/数字/坏 JSON）都返回一个
 *     可用的降级结构，永不抛错。
 *
 * 设计哲学等同 JSON Schema `additionalProperties: true` + 通配捕获：已知字段抽取，
 * 未知字段保留并显式声明，下游据此决定是否「可通过扩展实现」。
 *
 * 纯函数 + 副作用注入（logger 可选），便于测试与复用。
 */

// 已知顶层字段的宽松超集；不在此列的顶层键不算错误，仅被捕获记录。
const KNOWN_TOP_LEVEL = new Set([
  'actions', 'action', 'text', 'content', 'message', 'reasoning',
  'thinking', 'usage', 'stop_reason', 'finish_reason', 'model', 'id', 'role',
]);

// 单个动作对象的已知键宽松超集；不在此列的键写入 _unknownKeys（红线2）。
// 提升到模块作用域（Ch2「不要每轮重建可复用结构」）：normalizeAction 对每个动作、
// 每次解析都跑，旧实现每调用重建这个字面量 Set。仅经 `.has` 只读消费，从不 mutate，
// 派生出的 unknownKeys 数组才被返回（Set 本身不逃逸），共享单例逐字节等价。
const KNOWN_ACTION_KEYS = new Set(['type', 'name', 'tool', 'action', 'params', 'input', 'arguments', 'args', 'id']);

function pushWarning(warnings, logger, line) {
  warnings.push(line);
  if (logger && typeof logger.warn === 'function') {
    try { logger.warn(`[dualTrack:lenientParser] ${line}`); } catch (_) { /* 日志失败绝不影响解析 */ }
  }
}

/**
 * 把任意一个动作对象宽松归一化。tolerant 字段映射，未知键全部捕获不丢。
 */
function normalizeAction(rawAction, index, warnings, logger) {
  if (rawAction == null || typeof rawAction !== 'object') {
    // 非对象动作：包成占位，绝不丢弃（红线2）。
    pushWarning(warnings, logger, `action[${index}] 非对象，已封装为原始值占位`);
    return { type: '__nonobject_action__', params: {}, _raw: rawAction, _unknownKeys: [] };
  }
  const type = rawAction.type || rawAction.name || rawAction.tool || rawAction.action || '__missing_type__';
  const params = rawAction.params || rawAction.input || rawAction.arguments || rawAction.args || {};
  const unknownKeys = Object.keys(rawAction).filter((k) => !KNOWN_ACTION_KEYS.has(k));
  if (unknownKeys.length > 0) {
    pushWarning(
      warnings, logger,
      `action[${index}] type=${type} 含未知键 ${JSON.stringify(unknownKeys)}，已捕获保留（红线2：不静默吞没）`,
    );
  }
  if (type === '__missing_type__') {
    pushWarning(warnings, logger, `action[${index}] 缺少类型字段，标记为缺类型动作转人工确认`);
  }
  return { type, params, _raw: rawAction, _unknownKeys: unknownKeys };
}

/**
 * 宽松解析模型响应。永不抛错。
 *
 * @returns {{
 *   ok: boolean,            // 是否拿到结构化内容（false 仍带 salvage）
 *   degraded: boolean,      // 是否走了降级路径（坏 JSON / 非预期输入）
 *   actions: Array,         // 归一化后的动作列表
 *   text: string,           // 文本兜底
 *   unknownFields: Object,  // 顶层未知字段（红线1：多字段不致命）
 *   warnings: string[],     // 全部告警（已同步 logger）
 * }}
 */
function parseModelResponse(raw, opts = {}) {
  const logger = opts.logger;
  const warnings = [];
  let obj = raw;

  // 1) 字符串：尝试 JSON.parse，失败则整体当 text 降级，绝不抛错（红线3）。
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed === '') {
      return { ok: false, degraded: true, actions: [], text: '', unknownFields: {}, warnings };
    }
    try {
      obj = JSON.parse(trimmed);
    } catch (_) {
      pushWarning(warnings, logger, 'JSON.parse 失败，整体作为 text 兜底（红线1：不因解析失败崩溃）');
      return { ok: false, degraded: true, actions: [], text: raw, unknownFields: {}, warnings };
    }
  }

  // 2) 非对象（null / number / boolean / array-as-root）：尽力兜底。
  if (obj == null || typeof obj !== 'object') {
    pushWarning(warnings, logger, `响应根类型为 ${obj === null ? 'null' : typeof obj}，已降级兜底`);
    return { ok: false, degraded: true, actions: [], text: obj == null ? '' : String(obj), unknownFields: {}, warnings };
  }

  // 顶层是数组时，宽松视为「全是动作」。
  let actionsSource;
  if (Array.isArray(obj)) {
    actionsSource = obj;
    obj = { actions: obj };
  } else {
    actionsSource = obj.actions != null ? obj.actions
      : (obj.action != null ? [obj.action] : []);
  }
  if (!Array.isArray(actionsSource)) {
    pushWarning(warnings, logger, 'actions 字段非数组，已宽松包装为单元素数组');
    actionsSource = [actionsSource];
  }

  const actions = actionsSource.map((a, i) => normalizeAction(a, i, warnings, logger));

  // 3) 捕获顶层未知字段（红线1）。
  const unknownFields = {};
  for (const key of Object.keys(obj)) {
    if (!KNOWN_TOP_LEVEL.has(key)) {
      unknownFields[key] = obj[key];
    }
  }
  if (Object.keys(unknownFields).length > 0) {
    pushWarning(
      warnings, logger,
      `响应含未知顶层字段 ${JSON.stringify(Object.keys(unknownFields))}，已捕获不丢弃（红线1）`,
    );
  }

  const text = (typeof obj.text === 'string' && obj.text)
    || (typeof obj.content === 'string' && obj.content)
    || (typeof obj.message === 'string' && obj.message)
    || '';

  return { ok: true, degraded: false, actions, text, unknownFields, warnings };
}

module.exports = { parseModelResponse, normalizeAction, KNOWN_TOP_LEVEL };

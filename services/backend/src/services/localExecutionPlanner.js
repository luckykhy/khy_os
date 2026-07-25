'use strict';

/**
 * localExecutionPlanner.js — deterministic ORDERED multi-step planning for the
 * no-model local tool loop.
 * =================================================================
 * Goal「无模型时顺序的执行逻辑更重要」: a single tool call is not enough when a
 * request implies a *sequence* with strict ordering — you must READ a file
 * before you EDIT it (先读后写), and you WRITE then READ-back to verify
 * (先写再读). A weak/absent model cannot be trusted to order these correctly,
 * so this module derives the order by rule and then ENFORCES the invariants
 * structurally (inserting a missing prior-Read, never letting a verify-read jump
 * ahead of its write).
 *
 * Two layers, both pure & unit-testable (no model, no I/O):
 *   1. planOrderedSteps(text, opts)   — detect a compound intent and emit an
 *      ordered step list. Conservative: only when the replacement/content is
 *      EXPLICIT in the text (deterministic, no authoring). Otherwise → null,
 *      and the caller falls back to the single-call planner.
 *   2. enforceReadWriteOrder(steps, opts) — the safety net. Independent of how
 *      steps were produced (rule-planned OR model-emitted): guarantees the
 *      read-before-write invariant by splicing in a Read, and keeps verify-reads
 *      after their write.
 *
 * A "step" is { name, params, phase, why }:
 *   phase ∈ 'read' | 'search' | 'write' | 'verify' | 'fetch'
 *   why   — short Chinese rationale, surfaced for state transparency.
 *
 * Constraints honored: no hardcoding (write tier still gated upstream), state
 * honesty (every inserted step carries a `why` and `inserted:true`), bounded
 * (caller caps iterations).
 */

const path = require('path');

// Tools that mutate an existing file in place (require prior read by invariant).
const _EDIT_TOOLS = new Set(['Edit', 'editFile', 'MultiEdit', 'apply_patch']);
// Tools that (over)write whole-file content (read-first only if the file exists).
const _WRITE_TOOLS = new Set(['Write', 'writeFile']);
// Tools that read file content.
const _READ_TOOLS = new Set(['Read', 'readFile']);

function _isEdit(name) { return _EDIT_TOOLS.has(name); }
function _isWrite(name) { return _WRITE_TOOLS.has(name); }
function _isRead(name) { return _READ_TOOLS.has(name); }
function _isMutation(name) { return _isEdit(name) || _isWrite(name); }

/** Pull the file path a step targets, regardless of param naming. */
function _stepFile(step) {
  const p = step && step.params ? step.params : {};
  return p.file_path || p.path || p.filePath || null;
}

/** Normalize a path for same-file comparison (resolve + case/slash parity). */
function _normFile(fp) {
  if (!fp) return null;
  try {
    const abs = path.resolve(process.env.KHYQUANT_CWD || process.cwd(), String(fp));
    return process.platform === 'win32' ? abs.toLowerCase().replace(/\//g, '\\') : abs;
  } catch { return String(fp); }
}

/** Build a Read step for `fp`, choosing the param name to match the mutation tool family. */
function _makeReadStep(fp, { canonical = false, why, inserted = false } = {}) {
  return canonical
    ? { name: 'readFile', params: { path: fp }, phase: 'read', why, inserted }
    : { name: 'Read', params: { file_path: fp }, phase: 'read', why, inserted };
}

/**
 * Enforce the ordering invariants on an arbitrary step list. Pure: returns a NEW
 * array, never mutates the input.
 *
 *   先读后写: before any Edit (always) or Write on an EXISTING file, there must
 *   be a Read of that same file earlier in the sequence. If absent, splice one in
 *   immediately before the mutation (tagged inserted:true, with a `why`).
 *
 *   先写再读 (verify): a step explicitly tagged phase:'verify' is a read issued to
 *   confirm a just-written file. It must stay AFTER the write of the same file —
 *   so it does NOT count as the prior-read that satisfies that write's invariant,
 *   and is never reordered before it.
 *
 * @param {Array} steps
 * @param {object} [opts]
 * @param {(absFile:string)=>boolean} [opts.fileExists]  existence probe for
 *        deciding whether a whole-file Write needs a prior read. Defaults to a
 *        real fs.existsSync. Inject in tests.
 * @param {boolean} [opts.canonicalReadName=false]  emit inserted reads as
 *        `readFile`(true) vs `Read`(false).
 * @returns {{steps:Array, inserted:Array}}  final ordered steps + the reads added.
 */
function enforceReadWriteOrder(steps, opts = {}) {
  const list = Array.isArray(steps) ? steps.filter(Boolean) : [];
  const fileExists = typeof opts.fileExists === 'function'
    ? opts.fileExists
    : (abs) => { try { return require('fs').existsSync(abs); } catch { return false; } };
  const canonical = !!opts.canonicalReadName;

  const out = [];
  const inserted = [];
  // Files for which a NON-verify read has already appeared in `out`.
  const readSoFar = new Set();

  for (const step of list) {
    const name = step.name;
    const file = _stepFile(step);
    const norm = _normFile(file);

    if (_isMutation(name) && norm) {
      const needsPriorRead = _isEdit(name) || (_isWrite(name) && fileExists(norm));
      if (needsPriorRead && !readSoFar.has(norm)) {
        const why = _isEdit(name)
          ? '先读后写：编辑已存在文件前必须先读取其内容'
          : '先读后写：覆盖已存在文件前先读取，避免盲写丢失内容';
        const readStep = _makeReadStep(file, { canonical, why, inserted: true });
        out.push(readStep);
        inserted.push(readStep);
        readSoFar.add(norm);
      }
      out.push(step);
      continue;
    }

    // A plain (non-verify) read satisfies the prior-read invariant for its file.
    if (_isRead(name) && norm && step.phase !== 'verify') {
      readSoFar.add(norm);
    }
    out.push(step);
  }

  return { steps: out, inserted };
}

// ── Compound-intent detection (deterministic, explicit-only) ─────────────────

// "把 <file> 里的 X 改成 Y" / "将 <file> 中的 X 替换为 Y" / "in <file> replace X with Y"
const _EDIT_REPLACE_RE =
  /(?:把|将|在)?\s*([~\w./\\@-]+\.[A-Za-z0-9]{1,12})\s*(?:里|中|内|的|里面)?\s*(?:的)?\s*["'“”‘’]?(.+?)["'“”‘’]?\s*(?:改成|改为|替换成|替换为|换成|replace(?:\s+with)?)\s*["'“”‘’]?(.+?)["'“”‘’]?\s*$/i;

// "创建/新建/写一个 <file> 内容为 Z" / "写入 Z 到 <file>" / "把 Z 写入 <file>"
const _WRITE_CONTENT_TO_RE =
  /(?:把|将)?\s*["'“”‘’]?(.+?)["'“”‘’]?\s*(?:写入|写到|保存到|存到|存为|输出到)\s*([~\w./\\@-]+\.[A-Za-z0-9]{1,12})/i;
const _CREATE_WITH_CONTENT_RE =
  /(?:创建|新建|生成|写一个|写个|创建文件|新建文件)\s*([~\w./\\@-]+\.[A-Za-z0-9]{1,12})\s*(?:,|，|内容为|内容是|内容|content[:=]?)\s*["'“”‘’]?(.+?)["'“”‘’]?\s*$/i;

// Does the request ask to verify / read-back after writing? ("然后查看/确认/读回")
const _VERIFY_INTENT_RE = /(然后|接着|再|并)?\s*(查看|确认|读回|读取|检查|核对|验证|看看|read.?back|verify|confirm)/i;

function _cleanCapture(s) {
  return String(s || '').trim().replace(/[，。；;]+$/, '').trim();
}

// Strip a trailing verify directive ("，然后读回确认" / "; then verify") that the
// content regex may greedily absorb, so the written content excludes the
// follow-up instruction. Only trims when a connector precedes the verify verb.
function _stripVerifyTail(s) {
  return String(s || '')
    .replace(/[，,；;]?\s*(?:然后|接着|再|并|and|then)\s*(?:查看|确认|读回|读取|检查|核对|验证|看看|read.?back|verify|confirm).*$/i, '')
    .trim()
    .replace(/[，。；;]+$/, '')
    .trim();
}

/**
 * Detect a compound, ordered intent and emit the step sequence. Conservative:
 * returns null unless the operation is fully explicit (so no authoring/guessing).
 * The write/edit tier is still gated by the caller (writeEnabled); this only
 * decides ORDER and SHAPE.
 *
 * @param {string} userInput
 * @param {object} [opts]
 * @param {Set<string>} [opts.allowedSet]  if given, every emitted tool must be in it.
 * @returns {{steps:Array, kind:string}|null}
 */
function planOrderedSteps(userInput, opts = {}) {
  const text = String(userInput || '').trim();
  if (!text) return null;
  const allowed = opts.allowedSet instanceof Set ? opts.allowedSet : null;
  const has = (n) => !allowed || allowed.has(n);

  // 1. EDIT with explicit replacement → 先读后写: Read(file) → Edit(file,X→Y).
  let m = text.match(_EDIT_REPLACE_RE);
  if (m) {
    const file = _cleanCapture(m[1]);
    const oldStr = _cleanCapture(m[2]);
    const newStr = _cleanCapture(m[3]);
    if (file && oldStr && newStr && (has('Edit') || has('editFile'))) {
      const editName = has('Edit') ? 'Edit' : 'editFile';
      const readCanonical = !has('Read') && has('readFile');
      const steps = [
        _makeReadStep(file, {
          canonical: readCanonical,
          why: '先读后写：编辑前读取文件，确认替换目标存在且上下文正确',
        }),
        {
          name: editName,
          params: { file_path: file, old_string: oldStr, new_string: newStr },
          phase: 'write',
          why: '按显式替换执行编辑（旧文本 → 新文本）',
        },
      ];
      return { steps, kind: 'edit_replace' };
    }
  }

  // 2. CREATE / WRITE with explicit content → 先写再读 (when verify asked):
  //    Write(file, content) → [Read(file) verify].
  let file = null;
  let content = null;
  m = text.match(_CREATE_WITH_CONTENT_RE);
  if (m) { file = _cleanCapture(m[1]); content = _stripVerifyTail(_cleanCapture(m[2])); }
  if (!file) {
    m = text.match(_WRITE_CONTENT_TO_RE);
    if (m) { content = _stripVerifyTail(_cleanCapture(m[1])); file = _cleanCapture(m[2]); }
  }
  if (file && content && (has('Write') || has('writeFile'))) {
    const writeName = has('Write') ? 'Write' : 'writeFile';
    const writeParams = writeName === 'Write'
      ? { file_path: file, content }
      : { path: file, content };
    const steps = [{
      name: writeName,
      params: writeParams,
      phase: 'write',
      why: '按显式内容创建/写入文件',
    }];
    // 先写再读: only append a verify read when the user explicitly asked to
    // confirm/read-back — never fabricate an extra step otherwise.
    if (_VERIFY_INTENT_RE.test(text) && (has('Read') || has('readFile'))) {
      const readCanonical = !has('Read') && has('readFile');
      steps.push(_makeReadStep(file, {
        canonical: readCanonical,
        why: '先写再读：写入后读回验证内容已正确落盘',
      }));
      steps[steps.length - 1].phase = 'verify';
    }
    return { steps, kind: 'write_then_verify' };
  }

  return null;
}

module.exports = {
  planOrderedSteps,
  enforceReadWriteOrder,
  // primitives exported for the loop driver + tests
  _stepFile,
  _normFile,
  _isMutation,
  _isRead,
  _isEdit,
  _isWrite,
};

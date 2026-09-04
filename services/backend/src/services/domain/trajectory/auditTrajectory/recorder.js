'use strict';

/**
 * recorder.js — 审计级轨迹记录器（append-only JSONL，永不压缩）。
 *
 * 为什么另开一条通道，而不是复用 sessionPersistence 的 JSONL：
 *   sessionPersistence.persistSession 从 `_chatState.messages` 增量推导要追加什么
 *   （`if (messages.length > existingCount)`）。上下文压缩（compactHistory）会就地
 *   截短 `_chatState.messages`，于是 messages.length 掉到已写行数以下，之后每一轮
 *   都不再追加，直到重新越过历史高水位 —— 运行时的上下文压缩反向污染了轨迹文件。
 *   `saveConversation()` 更直接：messages 超过 6 条就 aggressive compact，只留约
 *   20% 存进单个 .json。这两条对「对话缓存」是对的，对「审计记录」是致命的。
 *
 * 本模块的契约（外部质检把轨迹当审计记录，不是对话缓存）：
 *   1. 只 append，一行一个事件，写入即 fsync 落盘。模块内**不存在**任何压缩、
 *      裁剪、摘要、重写、truncate 的代码路径 —— 文件只以 'a' 模式打开。
 *   2. 工具调用保留结构：assistant 事件的 content 数组里放 type='tool_use' 块
 *      （含 name / input）；工具结果单独一条事件，含 tool_use_id。
 *   3. 文件修改类工具的结果里带 before/after 或 unified diff —— 这是「非空 diff」
 *      的唯一证据（见 diffCapture.js）。
 *   4. 提示词来源如实标注 origin.type ∈ {human, ai_generated}。缺省与任何可疑
 *      输入都落到 ai_generated：把自动生成的提示词标成 human 是伪造审计记录，
 *      所以 human 必须显式带人工确认署名（confirmedBy），否则**降级**并记录降级原因。
 *   5. 每条事件都带 sessionId / timestamp(ISO8601 含时区) / role 或 type /
 *      parentUuid（构成对话树）/ cwd。
 *   6. 每行都自带 `message: {role, content}`，让 {messages:[]} 形态的通用解析器
 *      能直接读出工具调用序列（见 parser.js）。
 *
 * 热路径安全：record* 方法绝不向调用方抛异常（聊天流不能被审计写盘拖死），失败
 * 记入 `errors` 并由 health() 暴露，交由上层显式处理。
 *
 * @module services/auditTrajectory/recorder
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ── 常量 ──

/** 单条事件里内联的文本证据上限。超过则落盘为 sidecar 文件并留指针，绝不静默丢弃。 */
const INLINE_EVIDENCE_MAX = 64 * 1024;

/** 事件类型（QA 解析器与验收器共用的词表，单一真源）。 */
const EVENT = {
  SESSION_START: 'session_start',
  PROMPT: 'prompt',
  ASSISTANT: 'assistant',
  TOOL_RESULT: 'tool_result',
  VERIFICATION: 'verification',
  NOTE: 'note',
};

/** 提示词来源取值（外部规则只认这两种）。 */
const ORIGIN = { HUMAN: 'human', AI: 'ai_generated' };

// ── 工具函数 ──

function _uuid() {
  try {
    if (typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    /* fallthrough */
  }
  return crypto.randomBytes(16).toString('hex');
}

/**
 * ISO8601 带时区偏移的时间戳（`2026-08-23T14:02:11.482+08:00`）。
 * toISOString() 的 `Z` 也是合法 ISO8601，但外部质检要看本地偏移才能对齐实跑日志。
 * @param {Date} [d]
 * @returns {string}
 */
function isoWithOffset(d = new Date()) {
  const pad = (n, w = 2) => String(Math.abs(n)).padStart(w, '0');
  const off = -d.getTimezoneOffset(); // 分钟，东经为正
  const sign = off >= 0 ? '+' : '-';
  const tz = off === 0 ? 'Z' : `${sign}${pad(off / 60 | 0)}:${pad(off % 60)}`;
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `.${pad(d.getMilliseconds(), 3)}${tz}`
  );
}

/**
 * 如实归一提示词来源。
 *
 * 铁律：human 是「真人给出并确认」的断言，不能由代码替真人做出。所以只有显式
 * 带 confirmedBy 署名时才认 human；其余一切（缺 origin、type 拼错、只写
 * `{type:'human'}` 而无署名）统统落到 ai_generated 并写明降级原因。宁可把真人
 * 输入误标成 ai_generated（少算有效轮，损失是我方的），也绝不把自动生成的提示词
 * 标成 human（伪造审计记录）。
 *
 * @param {object} [origin]
 * @returns {{type:string, [k:string]:any}}
 */
function normalizeOrigin(origin) {
  const raw = origin && typeof origin === 'object' ? origin : {};
  const type = String(raw.type || '').trim().toLowerCase();

  if (type === ORIGIN.HUMAN) {
    const by = String(raw.confirmedBy || '').trim();
    if (!by) {
      return {
        type: ORIGIN.AI,
        downgradedFrom: ORIGIN.HUMAN,
        reason: 'origin.type=human 但缺少 confirmedBy 人工确认署名，保守降级',
      };
    }
    const out = { type: ORIGIN.HUMAN, confirmedBy: by, confirmedAt: raw.confirmedAt || isoWithOffset() };
    if (raw.draftId) {
      out.draftId = String(raw.draftId);
    }
    if (raw.channel) {
      out.channel = String(raw.channel);
    }
    return out;
  }

  if (type === ORIGIN.AI) {
    const out = { type: ORIGIN.AI };
    if (raw.generator) {
      out.generator = String(raw.generator);
    }
    if (raw.draftId) {
      out.draftId = String(raw.draftId);
    }
    return out;
  }

  return {
    type: ORIGIN.AI,
    reason: type ? `origin.type="${type}" 不在 {human, ai_generated} 内，保守标注` : 'origin 缺失，保守标注',
  };
}

/** 把任意工具结果规整成 tool_result 块可用的内容（字符串或块数组）。 */
function _resultContent(result) {
  if (typeof result === 'string') {
    return result;
  }
  if (Array.isArray(result)) {
    return result;
  }
  if (result === undefined || result === null) {
    return '';
  }
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

// ── 记录器 ──

class AuditTrajectoryRecorder {
  /**
   * @param {object} opts
   * @param {string} opts.sessionId 会话 id（每条事件都带）
   * @param {string} [opts.cwd] 事件默认归属目录；不传则取 process.cwd()。
   *   注意：Worker 进程应在启动前就 cd 到 workspace，此处只如实记录，不代为纠正。
   * @param {string} [opts.file] 轨迹文件绝对路径（显式优先）
   * @param {string} [opts.dir] 轨迹目录；缺省用 dataHome 的 audit-trajectory 桶
   * @param {string} [opts.lang] 原始需求文档语言（起草器全程不换语言的依据）
   * @param {object} [opts.meta] 附加到 session_start 的自由字段
   */
  constructor(opts = {}) {
    this.sessionId = String(opts.sessionId || '').trim() || `audit-${Date.now().toString(36)}`;
    this.cwd = String(opts.cwd || process.cwd());
    this.lang = opts.lang ? String(opts.lang) : '';
    this.file = opts.file ? String(opts.file) : path.join(this._resolveDir(opts.dir), `${this._safeName(this.sessionId)}.jsonl`);
    this.errors = [];

    this._lastUuid = null;
    this._lines = 0;
    this._round = 0;
    this._toolUseSeen = new Set();
    this._ready = false;

    this._openIfNeeded();
    if (this._ready && this._lines === 0) {
      this._append({
        type: EVENT.SESSION_START,
        role: 'system',
        message: { role: 'system', content: `审计轨迹开始记录 session=${this.sessionId} cwd=${this.cwd}` },
        lang: this.lang,
        recorder: { appendOnly: true, compaction: 'never' },
        ...(opts.meta && typeof opts.meta === 'object' ? { meta: opts.meta } : {}),
      });
    }
  }

  _safeName(s) {
    return String(s).replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 120) || 'session';
  }

  _resolveDir(dir) {
    if (dir) {
      return String(dir);
    }
    try {
      const { getProjectDataDir } = require('../../../../utils/dataHome');
      return getProjectDataDir('audit-trajectory');
    } catch {
      // dataHome 不可用（裁剪部署 / 单测隔离）→ 退到 cwd 下的隐藏目录，仍不写死盘符。
      return path.join(this.cwd, '.khy', 'audit-trajectory');
    }
  }

  /** 建目录 + 若文件已存在则读回链尾（续写而非另起，恢复后轨迹不断链）。 */
  _openIfNeeded() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      if (fs.existsSync(this.file)) {
        const lines = String(fs.readFileSync(this.file, 'utf-8')).split('\n').filter(Boolean);
        this._lines = lines.length;
        for (const line of lines) {
          try {
            const e = JSON.parse(line);
            if (e && e.uuid) {
              this._lastUuid = e.uuid;
            }
            if (e && e.type === EVENT.PROMPT) {
              this._round = Number(e.round) || this._round + 1;
            }
          } catch {
            /* 坏行不修不删：审计文件只追加，容忍历史噪声 */
          }
        }
      }
      this._ready = true;
    } catch (err) {
      this._ready = false;
      this.errors.push(`轨迹文件不可写 ${this.file}: ${(err && err.message) || err}`);
    }
  }

  /**
   * 唯一的落盘出口。只以 'a' 打开 → 物理上不存在覆盖/截断路径。
   * @param {object} partial 事件体（uuid/parentUuid/sessionId/timestamp/cwd 由此处补齐）
   * @returns {{ok:boolean, uuid:(string|null), error:(string|undefined)}}
   */
  _append(partial) {
    if (!this._ready) {
      return { ok: false, uuid: null, error: this.errors[this.errors.length - 1] || 'recorder 未就绪' };
    }
    const uuid = _uuid();
    const entry = {
      uuid,
      parentUuid: this._lastUuid || null,
      sessionId: this.sessionId,
      timestamp: isoWithOffset(),
      cwd: partial.cwd || this.cwd,
      ...partial,
    };
    let fd = null;
    try {
      fd = fs.openSync(this.file, 'a', 0o600);
      fs.writeSync(fd, JSON.stringify(entry) + '\n');
      try {
        fs.fsyncSync(fd); // 「写入即落盘」：审计记录不能只活在 page cache
      } catch {
        /* 平台不支持 fsync → 降级为已 append，不弱于裸 appendFileSync */
      }
      this._lastUuid = uuid;
      this._lines += 1;
      return { ok: true, uuid };
    } catch (err) {
      const msg = `轨迹追加失败: ${(err && err.message) || err}`;
      this.errors.push(msg);
      return { ok: false, uuid: null, error: msg };
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
      }
    }
  }

  /**
   * 记录一轮的开场提示词。这是「轮」的唯一边界标记。
   * @param {string} text 提示词原文（不做任何摘要）
   * @param {object} [origin] 见 normalizeOrigin；human 必须带 confirmedBy
   * @param {object} [extra] 附加字段（如 draft 自检报告）
   */
  recordPrompt(text, origin, extra = {}) {
    this._round += 1;
    const norm = normalizeOrigin(origin);
    return this._append({
      type: EVENT.PROMPT,
      role: 'user',
      round: this._round,
      origin: norm,
      message: { role: 'user', content: [{ type: 'text', text: String(text === undefined || text === null ? '' : text) }] },
      ...extra,
    });
  }

  /**
   * 记录一条 assistant 回复，工具调用以 tool_use 块形式**保留结构**（不拍平成文本）。
   * @param {string} [text] 回复正文
   * @param {Array<{id?:string,name:string,input?:object}>} [toolUses] 本轮发起的工具调用
   */
  recordAssistant(text, toolUses = []) {
    const content = [];
    const body = text === undefined || text === null ? '' : String(text);
    if (body) {
      content.push({ type: 'text', text: body });
    }
    const calls = Array.isArray(toolUses) ? toolUses : [];
    for (const t of calls) {
      if (!t || !t.name) {
        continue;
      }
      const id = String(t.id || `toolu_${_uuid().replace(/-/g, '').slice(0, 20)}`);
      this._toolUseSeen.add(id);
      content.push({
        type: 'tool_use',
        id,
        name: String(t.name),
        input: t.input && typeof t.input === 'object' ? t.input : {},
      });
    }
    return this._append({
      type: EVENT.ASSISTANT,
      role: 'assistant',
      round: this._round,
      message: { role: 'assistant', content: content.length > 0 ? content : [{ type: 'text', text: '' }] },
      toolUseCount: content.filter((b) => b.type === 'tool_use').length,
    });
  }

  /**
   * 记录一条工具结果（独立事件，含 tool_use_id）。
   * @param {object} args
   * @param {string} args.toolUseId 对应 tool_use 块的 id
   * @param {string} [args.name] 工具名（冗余留存，便于 grep）
   * @param {*} [args.result] 结果内容
   * @param {boolean} [args.isError]
   * @param {object|Array} [args.evidence] 文件改动证据：diffCapture 的产物
   *   （{path, before, after, diff, added, removed}）。这是「非空 diff」的唯一证据。
   */
  recordToolResult(args = {}) {
    const toolUseId = String(args.toolUseId || '').trim();
    const content = _resultContent(args.result);
    const block = {
      type: 'tool_result',
      tool_use_id: toolUseId || `toolu_orphan_${_uuid().slice(0, 8)}`,
      content,
      ...(args.isError ? { is_error: true } : {}),
    };
    const evidence = this._materializeEvidence(args.evidence);
    return this._append({
      type: EVENT.TOOL_RESULT,
      role: 'user',
      round: this._round,
      toolName: args.name ? String(args.name) : '',
      ...(toolUseId && !this._toolUseSeen.has(toolUseId)
        ? { orphan: true, orphanReason: '结果的 tool_use_id 未在本会话见过对应 tool_use 块' }
        : {}),
      ...(evidence ? { evidence } : {}),
      message: { role: 'user', content: [block] },
    });
  }

  /**
   * 记录一次验证动作（实跑 + 截图）。与「非空 diff」并列，二者有其一即可构成有效轮证据。
   * @param {object} args
   * @param {string} [args.command] 实跑命令
   * @param {number} [args.exitCode]
   * @param {string} [args.stdout]
   * @param {string[]} [args.screenshots] 截图文件路径
   * @param {string} [args.summary] 一句话结论
   */
  recordVerification(args = {}) {
    const shots = (Array.isArray(args.screenshots) ? args.screenshots : []).map(String).filter(Boolean);
    const verification = {
      ...(args.command ? { command: String(args.command) } : {}),
      ...(args.exitCode === undefined || args.exitCode === null ? {} : { exitCode: Number(args.exitCode) }),
      ...(args.stdout ? { stdout: this._clip(String(args.stdout)) } : {}),
      ...(shots.length > 0 ? { screenshots: shots } : {}),
      ran: !!args.command,
      captured: shots.length > 0,
    };
    const summary =
      args.summary ||
      `验证 ${args.command || '(无命令)'}：退出码 ${verification.exitCode === undefined ? 'n/a' : verification.exitCode}，截图 ${shots.length} 张`;
    return this._append({
      type: EVENT.VERIFICATION,
      role: 'user',
      round: this._round,
      verification,
      message: { role: 'user', content: [{ type: 'text', text: summary }] },
    });
  }

  /** 记录一条旁注（不构成轮次边界，也不算工具调用）。 */
  recordNote(text, extra = {}) {
    return this._append({
      type: EVENT.NOTE,
      role: 'system',
      round: this._round,
      message: { role: 'system', content: [{ type: 'text', text: String(text || '') }] },
      ...extra,
    });
  }

  /** 超长文本落 sidecar，行内留指针 —— 既不撑爆单行，也不算「摘要」（原文完整保留在盘上）。 */
  _clip(text) {
    if (text.length <= INLINE_EVIDENCE_MAX) {
      return text;
    }
    const side = `${this.file}.d`;
    const name = `${Date.now().toString(36)}-${_uuid().slice(0, 8)}.txt`;
    try {
      fs.mkdirSync(side, { recursive: true });
      fs.writeFileSync(path.join(side, name), text, 'utf-8');
      return `${text.slice(0, INLINE_EVIDENCE_MAX)}\n[全文见 sidecar: ${path.join(side, name)}]`;
    } catch {
      return text; // sidecar 写不下去就整段内联：宁可行长，也不丢证据
    }
  }

  /** evidence 里的 before/after/diff 逐条过 _clip，保证大文件改动不撑爆单行。 */
  _materializeEvidence(evidence) {
    if (!evidence) {
      return null;
    }
    const one = (e) => {
      if (!e || typeof e !== 'object') {
        return null;
      }
      const out = { ...e };
      for (const k of ['before', 'after', 'diff']) {
        if (typeof out[k] === 'string') {
          out[k] = this._clip(out[k]);
        }
      }
      return out;
    };
    if (Array.isArray(evidence)) {
      const list = evidence.map(one).filter(Boolean);
      return list.length > 0 ? list : null;
    }
    return one(evidence);
  }

  /** 当前轮号（第一条 prompt 之前为 0）。 */
  get round() {
    return this._round;
  }

  /**
   * 自检：文件是否仍是「只增不减」。行数只应单调增长；一旦盘上行数少于本进程
   * 已追加的条数，说明有人截断/重写了审计文件，这必须被当场抓出而不是静默。
   * @returns {{ok:boolean, lines:number, appended:number, reason?:string}}
   */
  verifyAppendOnly() {
    try {
      const onDisk = String(fs.readFileSync(this.file, 'utf-8')).split('\n').filter(Boolean).length;
      if (onDisk < this._lines) {
        return {
          ok: false,
          lines: onDisk,
          appended: this._lines,
          reason: `盘上 ${onDisk} 行少于已追加 ${this._lines} 条，轨迹文件被截断或重写`,
        };
      }
      return { ok: true, lines: onDisk, appended: this._lines };
    } catch (err) {
      return { ok: false, lines: 0, appended: this._lines, reason: (err && err.message) || String(err) };
    }
  }

  /** 记录器健康度（供状态行展示：动作 + 目标 + 进度）。 */
  health() {
    const ao = this.verifyAppendOnly();
    return {
      ready: this._ready,
      file: this.file,
      lines: this._lines,
      rounds: this._round,
      appendOnly: ao.ok,
      ...(ao.ok ? {} : { appendOnlyReason: ao.reason }),
      errors: this.errors.slice(),
      status: `记录审计轨迹 ${path.basename(this.file)}：已写 ${this._lines} 条 / ${this._round} 轮`,
    };
  }
}

module.exports = {
  AuditTrajectoryRecorder,
  normalizeOrigin,
  isoWithOffset,
  EVENT,
  ORIGIN,
  INLINE_EVIDENCE_MAX,
};

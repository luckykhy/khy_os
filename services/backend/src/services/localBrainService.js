'use strict';

/**
 * Local Brain Service — KHY 确定性本地能力层
 *
 * 两层拦截架构：
 *   Tier 1 — 确定性任务（有无模型都拦截，零 token 成本）
 *   Tier 2 — 保底能力（仅无模型时激活：问候、笑话、兜底菜单）
 *
 * Tier 1 通过 quickTaskService.detectQuickTask() 链入（已有集成点），
 * Tier 2 在 repl/liteRepl 的 AI fallback 路径前调用。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');
const codeCheckService = require('./codeCheckService');
const calcService = require('./localBrainCalc'); // 简单计算子能力（已抽出降巨石，见 DESIGN-ARCH-051）
const deterministicFacts = require('./deterministicFacts'); // 确定性真值：单位换算/常数公理/定理（与 calc 互补，不只是算术）
// 供应商配置 / 外部软件模型配置 / 反向导入 三簇解析面(nlProviderResolver·keyUpdateFlow·
// nlExternalAppResolver·nlExternalAppImportResolver·appModelImporter)已随处理器一并迁入叶子
// ./localBrainProviderConfig.js(见下方 2c/2b re-export 段),此处不再顶层 require(避免死引用)。
let _fmt = null;
try { _fmt = require('./localFormat'); } catch { /* degrade to plain text */ }

// ═══════════════════════════════════════════════════════════════════
// Session Context Memory — 离线前后文关联
// 已按职责抽出到 ./localBrainSessionContext.js（降巨石，DESIGN-ARCH-051 lineage）；
// 此处以同名别名复用，Tier-1/Tier-2 调用点与对外导出契约保持不变。
// ═══════════════════════════════════════════════════════════════════
const _sessionContext = require('./localBrainSessionContext');
const {
  pushContext,
  getContext,
  clearContext,
  resolveFollowUp,
  _getContextHint,
} = _sessionContext;


/**
 * 会话内已讲笑话缓存 — 仅内存，不持久化。
 * 跨会话靠请求随机化（时间戳 + 随机数 cache-bust）保证大概率不同。
 */
const _toldJokes = new Set();


// ── Path utilities ──────────────────────────────────────────────────

function _expandHome(p) {
  if (!p) return p;
  if (p.startsWith('~/') || p === '~') {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

// 收敛到 utils/collapseWhitespaceLoose 单一真源(逐字节委托,调用点不变)
const _cleanInput = require('../utils/collapseWhitespaceLoose');

// ═══════════════════════════════════════════════════════════════════
// Tier 1 — 确定性任务（有无模型都拦截）
// ═══════════════════════════════════════════════════════════════════

// ── 1. 正则提取 ─────────────────────────────────────────────────────

const _EXTRACT_PATTERNS = {
  '身份证': { regex: /\b[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g, label: '身份证号码' },
  '手机':   { regex: /\b1[3-9]\d{9}\b/g, label: '手机号码' },
  '电话':   { regex: /\b1[3-9]\d{9}\b/g, label: '电话号码' },
  'phone':  { regex: /\b1[3-9]\d{9}\b/g, label: 'Phone number' },
  '邮箱':   { regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, label: '邮箱地址' },
  'email':  { regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, label: 'Email' },
  '日期':   { regex: /\b(?:19|20)\d{2}[-/.](?:0?[1-9]|1[0-2])[-/.](?:0?[1-9]|[12]\d|3[01])\b/g, label: '日期' },
  'date':   { regex: /\b(?:19|20)\d{2}[-/.](?:0?[1-9]|1[0-2])[-/.](?:0?[1-9]|[12]\d|3[01])\b/g, label: 'Date' },
  'url':    { regex: /https?:\/\/[^\s"'<>()，。；、]+/gi, label: 'URL' },
  '链接':   { regex: /https?:\/\/[^\s"'<>()，。；、]+/gi, label: 'URL 链接' },
  'link':   { regex: /https?:\/\/[^\s"'<>()，。；、]+/gi, label: 'Link' },
  'ip':     { regex: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g, label: 'IP 地址' },
};

function _isExtractIntent(text) {
  if (!/(提取|抽取|找出|找到|列出|获取|extract|find|parse|get|pick)/i.test(text)) return false;
  for (const key of Object.keys(_EXTRACT_PATTERNS)) {
    if (text.toLowerCase().includes(key.toLowerCase())) return true;
  }
  return false;
}

function _detectExtract(text) {
  // 确定要提取的类型
  const types = [];
  for (const [key, info] of Object.entries(_EXTRACT_PATTERNS)) {
    if (text.toLowerCase().includes(key.toLowerCase())) {
      // 去重（手机/电话/phone 共享同一个 regex）
      if (!types.some(t => t.label === info.label)) {
        types.push(info);
      }
    }
  }
  if (types.length === 0) return null;

  // 提取待搜索的文本：引号内容、冒号后内容、或整行
  let sourceText = text;
  const quotedMatch = text.match(/[""「」『』【】]([^""「」『』【】]+)[""「」『』【】]/);
  const colonMatch = text.match(/[:：]\s*(.+)/);
  if (quotedMatch) sourceText = quotedMatch[1];
  else if (colonMatch) sourceText = colonMatch[1];

  return { type: 'regex_extract', category: '正则提取', label: types.map(t => t.label).join('+'), types, sourceText };
}

function _executeExtract(plan) {
  const results = [];
  for (const typeInfo of plan.types) {
    const regex = new RegExp(typeInfo.regex.source, typeInfo.regex.flags);
    const matches = plan.sourceText.match(regex) || [];
    results.push({ label: typeInfo.label, matches: [...new Set(matches)] });
  }
  const total = results.reduce((sum, r) => sum + r.matches.length, 0);
  return { type: 'regex_extract', success: true, results, total };
}

function _formatExtract(result) {
  if (!result.results || result.total === 0) return '未找到匹配项。';
  if (_fmt && _fmt.isEnabled()) {
    const sections = result.results.map(r => ({
      heading: r.matches.length === 0 ? `${r.label}（无匹配）` : `${r.label}（${r.matches.length} 项）`,
      lines: r.matches.length === 0 ? ['- （无）'] : _fmt.bullets(r.matches),
    }));
    return _fmt.compose({ title: '提取结果', sections, meta: ['本地提取'] });
  }
  const lines = [];
  for (const r of result.results) {
    if (r.matches.length === 0) {
      lines.push(`${r.label}: 无匹配`);
    } else {
      lines.push(`${r.label} (${r.matches.length} 项):`);
      r.matches.forEach(m => lines.push(`  ${m}`));
    }
  }
  return lines.join('\n');
}

// ── 2. 文件移动/复制/重命名 ─────────────────────────────────────────

const _FILE_OP_RE = /(?:把|将|移动|复制|拷贝|重命名|move|copy|cp|mv|rename)\s+(.+?)\s+(?:到|去|至|to|->|→)\s+(.+)/i;
const _FILE_OP_KIND_RE = /^(复制|拷贝|copy|cp)/i;
const _RENAME_RE = /(?:重命名|rename)\s+(.+?)\s+(?:为|成|to|as|->|→)\s+(.+)/i;
// 粘连连接符的自然中文形:「把/将 SRC (移/移动/挪/复制/拷贝)到 DEST」——连接符「到」与
// 动词粘连(无空格),既有 _FILE_OP_RE 的 `\s+(?:到|…)` 落空,导致连 KHY 自家 describeApis
// 广告示例「把 a.txt 移到 backup/」都不命中(只出兜底菜单)。门控 KHY_FILE_OP_GLUED 默认开,
// 关 → 不启用 → 字节回退(这些句仍 NULL,与历史完全一致)。仅在 _FILE_OP_RE 未命中时兜底,
// 故既有命中路径行为逐字节不变。复用既有 _executeFileOp(对不存在源文件优雅回「源文件不存在」)。
const _FILE_OP_GLUED_RE = /(?:把|将)\s+(.+?)\s*(移动|移|挪|复制|拷贝)到\s+(.+)/i;

function _fileOpGluedEnabled(env) {
  if (!env || env.KHY_FILE_OP_GLUED == null) return true;
  const v = String(env.KHY_FILE_OP_GLUED).trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no' || v === '');
}

function _isFileOpIntent(text) {
  return _FILE_OP_RE.test(text) || _RENAME_RE.test(text)
    || (_fileOpGluedEnabled(process.env) && _FILE_OP_GLUED_RE.test(text));
}

function _detectFileOp(text, opts) {
  const cwd = opts?.cwd || process.cwd();
  let m = text.match(_RENAME_RE);
  if (m) {
    const src = _expandHome(m[1].replace(/[""''`]/g, '').trim());
    const dest = m[2].replace(/[""''`]/g, '').trim();
    return { type: 'file_op', category: '文件操作', label: '重命名', op: 'rename', src: path.resolve(cwd, src), dest: path.resolve(cwd, path.dirname(src), dest) };
  }
  let src, dest, op;
  m = text.match(_FILE_OP_RE);
  if (m) {
    src = _expandHome(m[1].replace(/[""''`]/g, '').trim());
    dest = _expandHome(m[2].replace(/[""''`]/g, '').trim());
    op = _FILE_OP_KIND_RE.test(text) ? 'copy' : 'move';
  } else if (_fileOpGluedEnabled(process.env)) {
    // 粘连连接符兜底:「把 a.txt 移到 backup/」「将 x.log 拷贝到 logs/」
    const g = text.match(_FILE_OP_GLUED_RE);
    if (!g) return null;
    src = _expandHome(g[1].replace(/[""''`]/g, '').trim());
    dest = _expandHome(g[3].replace(/[""''`]/g, '').trim());
    op = /^(复制|拷贝)/.test(g[2]) ? 'copy' : 'move';
  } else {
    return null;
  }
  const srcAbs = path.resolve(cwd, src);
  let destAbs = path.resolve(cwd, dest);
  // 如果 dest 是目录或以 / 结尾，保留原文件名
  if (dest.endsWith('/') || dest.endsWith('\\') || (fs.existsSync(destAbs) && fs.statSync(destAbs).isDirectory())) {
    destAbs = path.join(destAbs, path.basename(srcAbs));
  }
  return { type: 'file_op', category: '文件操作', label: op === 'copy' ? '复制' : '移动', op, src: srcAbs, dest: destAbs };
}

function _executeFileOp(plan) {
  const { op, src, dest } = plan;
  if (!fs.existsSync(src)) return { type: 'file_op', success: false, error: `源文件不存在: ${src}` };
  const destDir = path.dirname(dest);
  if (!fs.existsSync(destDir)) {
    try { fs.mkdirSync(destDir, { recursive: true }); } catch (e) {
      return { type: 'file_op', success: false, error: `无法创建目标目录: ${e.message}` };
    }
  }
  try {
    if (op === 'copy') {
      fs.copyFileSync(src, dest);
    } else if (op === 'rename') {
      fs.renameSync(src, dest);
    } else {
      fs.renameSync(src, dest);
    }
    return { type: 'file_op', success: true, op, src, dest };
  } catch (e) {
    return { type: 'file_op', success: false, error: e.message };
  }
}

function _formatFileOp(result) {
  if (!result.success) return `文件操作失败: ${result.error}`;
  const opLabel = result.op === 'copy' ? '已复制' : result.op === 'rename' ? '已重命名' : '已移动';
  if (_fmt && _fmt.isEnabled()) {
    return _fmt.compose({
      title: opLabel,
      sections: [{ lines: _fmt.keyValues([['源', result.src], ['目标', result.dest]]) }],
      meta: ['本地文件操作'],
    });
  }
  return `${opLabel}: ${result.src}\n  → ${result.dest}`;
}

// ── 2b. 目录创建 (dir_create / mkdir) + 文件删除 (file_delete / rm，确认闸门) ───────
//
// goal「自然语言要能驱动一切 —— 无网络无模型(Tier A)也应可以」的写/删类闭环。此前
// 「新建文件夹 X」「删除 X」无任何 handler 命中,只出兜底菜单。两者**都注册为
// cooperative:true 且仅在无模型(Tier A)时介入** —— 有模型时让路,由模型经自身工具 +
// 权限层做文件变更(更安全、可审计)。两个能力的破坏性等级不同,**刻意采用非对称设计**:
//   · dir_create(mkdir):非破坏、幂等(recursive),与 file_op 的「移动/复制直接执行」一致
//     → 直接执行(创建空目录安全且可逆);
//   · file_delete(rm):**破坏性** → 套用 data_cleanup 的 `confirmed` 闸门:默认仅**预览**
//     (只读、绝不删除),必须同一句里带明确「确认/确定/执行删除」字样才真正删除 —— 与全局
//     「破坏性操作先确认」铁律一致。删除还叠加结构性安全护栏(拒删根/家目录/cwd 本身/cwd 上级)。
// 门控 KHY_DIR_CREATE / KHY_FILE_DELETE 默认开;关 → isXxxIntent 恒 false → 字节回退(退回兜底菜单)。

// mkdir：命令形 `mkdir [-p] PATH` 或 NL「(新建|创建|建立|建个) [一个] (文件夹|目录) NAME」。
const _MKDIR_CMD_RE = /^\s*mkdir\s+(?:-p\s+)?(.+?)\s*$/i;
const _MKDIR_NL_RE = /(?:新建|创建|建立|建个?|新增)\s*(?:一个)?\s*(?:文件夹|目录)\s*(?:名(?:字|称)?(?:为|叫)?|叫做?)?\s*[:：]?\s*[「『"'""'`]?\s*([^\s「『」』"'""'`]+)\s*[」』"'""'`]?\s*$/i;
// NL 倒装形「(新建|创建) [一个] 名为/叫 NAME 的 (文件夹|目录)」。
const _MKDIR_NL_RE2 = /(?:新建|创建|建立)\s*(?:一个)?\s*(?:名(?:字|称)?(?:为|叫)?|叫做?)\s*[「『"'""'`]?\s*([^\s「『」』"'""'`]+)\s*[」』"'""'`]?\s*的?\s*(?:文件夹|目录)/i;

// rm：删除动词 + 目标 token（保守:目标须像具体路径——有扩展名/路径分隔符,或句中显式
// 出现「文件/文件夹/目录」关键词；否则不拦截,避免吞掉「删除这行代码」之类非文件意图）。
// ASCII 命令词 rm/remove/delete 必须在行首或空白后并带词边界——否则会把路径里的子串
// (如 /tmp/lbmkrm-xxx 的「rm」、remove-cache 的「remove」)误当删除动词。中文动词无此风险。
const _RM_TARGET_RE = /(?:删除|删掉|移除|删|(?:^|\s)(?:rm|remove|delete)\b)\s*(?:这个|那个|掉)?\s*(?:文件夹|目录|文件)?\s*[:：]?\s*[「『"'""'`]?([^\s「『」』"'""'`,，。!！?？]+)[」』"'""'`]?/i;
const _RM_DIR_WORD_RE = /(?:文件夹|目录|dir|folder|directory)/i;
// 删除确认闸门：须**同一句**里带明确执行字样才真正删除（否则仅预览）。
const _RM_CONFIRM_RE = /(确认删除|确定删除|确认|确定|执行删除|真的删|马上删|立即删|立刻删|do it|confirm|^yes\b)/i;

function _mkdirEnabled(env) {
  if (!env || env.KHY_DIR_CREATE == null) return true;
  const v = String(env.KHY_DIR_CREATE).trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no' || v === '');
}
function _fileDeleteEnabled(env) {
  if (!env || env.KHY_FILE_DELETE == null) return true;
  const v = String(env.KHY_FILE_DELETE).trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no' || v === '');
}

function _isMkdirIntent(text) {
  if (!_mkdirEnabled(process.env)) return false;
  if (typeof text !== 'string' || text.length === 0 || text.length >= 120) return false;
  return _MKDIR_CMD_RE.test(text) || _MKDIR_NL_RE.test(text) || _MKDIR_NL_RE2.test(text);
}

function _detectMkdir(text, opts) {
  const cwd = opts?.cwd || process.cwd();
  let raw;
  const cmd = text.match(_MKDIR_CMD_RE);
  if (cmd && cmd[1]) raw = cmd[1];
  else {
    const m = text.match(_MKDIR_NL_RE) || text.match(_MKDIR_NL_RE2);
    if (!m || !m[1]) return null;
    raw = m[1];
  }
  raw = _expandHome(String(raw).replace(/[「『」』"'""'`]/g, '').trim());
  if (!raw) return null;
  const dir = path.resolve(cwd, raw);
  return { type: 'dir_create', category: '目录创建', label: path.basename(dir) || dir, dir };
}

function _executeMkdir(plan) {
  const { dir } = plan;
  if (fs.existsSync(dir)) {
    let isDir = false;
    try { isDir = fs.statSync(dir).isDirectory(); } catch { /* ignore */ }
    if (isDir) return { type: 'dir_create', success: true, dir, already: true };
    return { type: 'dir_create', success: false, error: `已存在同名文件(非目录): ${dir}` };
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    return { type: 'dir_create', success: true, dir, already: false };
  } catch (e) {
    return { type: 'dir_create', success: false, error: e.message };
  }
}

function _formatMkdir(result) {
  if (!result.success) return `创建目录失败: ${result.error}`;
  const verb = result.already ? '目录已存在' : '已创建目录';
  if (_fmt && _fmt.isEnabled()) {
    return _fmt.compose({ title: verb, sections: [{ lines: [result.dir] }], meta: ['目录创建', '本地文件操作'] });
  }
  return `${verb}: ${result.dir}`;
}

function _isDeleteIntent(text) {
  if (!_fileDeleteEnabled(process.env)) return false;
  if (typeof text !== 'string' || text.length === 0 || text.length >= 120) return false;
  const m = text.match(_RM_TARGET_RE);
  if (!m || !m[1]) return false;
  const target = m[1];
  // 保守:目标须像具体路径(扩展名/分隔符/家目录前缀),或句中显式出现「文件/文件夹/目录」。
  const explicitFileWord = /(?:文件夹|目录|文件)/.test(text);
  return /\.\w{1,10}$/.test(target) || /[/\\~]/.test(target) || explicitFileWord;
}

function _detectDelete(text, opts) {
  const cwd = opts?.cwd || process.cwd();
  const m = text.match(_RM_TARGET_RE);
  if (!m || !m[1]) return null;
  const raw = _expandHome(m[1].replace(/[「『」』"'""'`]/g, '').trim());
  if (!raw) return null;
  const target = path.resolve(cwd, raw);
  const confirmed = _RM_CONFIRM_RE.test(text);
  const hintDir = _RM_DIR_WORD_RE.test(text);
  return { type: 'file_delete', category: '文件删除', label: path.basename(target) || target, target, confirmed, hintDir };
}

/**
 * 结构性删除安全护栏(返回拒绝原因字符串或 null)。全部基于运行期计算的路径(根 / 家目录 /
 * cwd / cwd 上级),**非**硬编码系统目录字面量。确认闸门是首要保护,本护栏拦截灾难性目标。
 */
function _deleteSafetyGuard(target, cwd) {
  const resolved = path.resolve(target);
  const root = path.parse(resolved).root;
  if (resolved === root) return '拒绝删除文件系统根目录';
  if (resolved === os.homedir()) return '拒绝删除家目录本身';
  const cwdAbs = path.resolve(cwd || process.cwd());
  if (resolved === cwdAbs) return '拒绝删除当前工作目录本身';
  if (cwdAbs === resolved || cwdAbs.startsWith(resolved + path.sep)) return '拒绝删除当前工作目录的上级目录';
  return null;
}

function _executeDelete(plan, opts) {
  const { target, confirmed } = plan;
  const cwd = opts?.cwd || process.cwd();
  const guard = _deleteSafetyGuard(target, cwd);
  if (guard) return { type: 'file_delete', success: false, error: guard };
  if (!fs.existsSync(target)) return { type: 'file_delete', success: false, error: `目标不存在: ${target}` };
  let stat;
  try { stat = fs.statSync(target); } catch (e) { return { type: 'file_delete', success: false, error: e.message }; }
  const isDir = stat.isDirectory();
  if (!confirmed) {
    // 预览:只读,绝不删除。
    let detail;
    if (isDir) {
      let count = 0;
      try { count = fs.readdirSync(target).length; } catch { count = 0; }
      detail = { kind: 'dir', count };
    } else {
      detail = { kind: 'file', size: stat.size };
    }
    return { type: 'file_delete', success: true, preview: true, target, detail };
  }
  // 已确认 → 真正删除。
  try {
    if (isDir) fs.rmSync(target, { recursive: true, force: false });
    else fs.rmSync(target, { force: false });
    return { type: 'file_delete', success: true, preview: false, target, wasDir: isDir };
  } catch (e) {
    return { type: 'file_delete', success: false, error: e.message };
  }
}

function _fmtDeleteSize(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function _formatDelete(result) {
  if (!result.success) return `删除失败: ${result.error}`;
  const base = path.basename(result.target);
  if (result.preview) {
    const d = result.detail || {};
    const what = d.kind === 'dir' ? `目录（含 ${d.count} 项）` : `文件（${_fmtDeleteSize(d.size)}）`;
    if (_fmt && _fmt.isEnabled()) {
      return _fmt.compose({
        title: '删除预览（未执行）',
        sections: [{ lines: [`目标: ${result.target}`, `类型: ${what}`] }],
        meta: ['文件删除', '仅预览'],
        footer: `未删除任何东西。确认请重发并带上「确认」,如:确认删除 ${base}`,
      });
    }
    return `删除预览（未执行）\n  目标: ${result.target}\n  类型: ${what}\n未删除任何东西。确认请重发并带上「确认」,如:确认删除 ${base}`;
  }
  const kind = result.wasDir ? '目录' : '文件';
  if (_fmt && _fmt.isEnabled()) {
    return _fmt.compose({ title: '已删除', sections: [{ lines: [`已删除${kind}: ${result.target}`] }], meta: ['文件删除', '已执行'] });
  }
  return `已删除${kind}: ${result.target}`;
}

// ── 2c/2b/2b-reverse. 模型供应商配置 / 外部软件模型配置 / 反向导入 ──────────────────
// 已抽取为叶子 ./localBrainProviderConfig.js（降上帝文件·DESIGN-ARCH-051 lineage，范式同
// localBrainCalc/localBrainTextOps/localBrainExternalApi）。完整实现（含 nlProviderResolver /
// keyUpdateFlow / nlExternalApp* / appModelImporter 接线与全部执行/格式化）见该叶子；此处仅以
// **同名别名 re-export** 接回三张注册表(下方 _DETERMINISTIC_HANDLERS/_EXECUTORS/_FORMATTERS)，
// 契约字节不变。注:该叶子会经 apiKeyPool/registrar 落盘写入配置，故非零 IO 纯叶子。
const _providerConfig = require('./localBrainProviderConfig');
const _isProviderCfgIntent = _providerConfig._isProviderCfgIntent;
const _detectProviderCfg = _providerConfig._detectProviderCfg;
const _executeProviderCfg = _providerConfig._executeProviderCfg;
const _formatProviderCfg = _providerConfig._formatProviderCfg;
const _isKeyUpdateIntent = _providerConfig._isKeyUpdateIntent;
const _detectKeyUpdate = _providerConfig._detectKeyUpdate;
const _execKeyUpdate = _providerConfig._execKeyUpdate;
const _isExternalAppIntent = _providerConfig._isExternalAppIntent;
const _detectExternalApp = _providerConfig._detectExternalApp;
const _executeExternalApp = _providerConfig._executeExternalApp;
const _formatExternalApp = _providerConfig._formatExternalApp;
const _isExternalAppImportIntent = _providerConfig._isExternalAppImportIntent;
const _detectExternalAppImport = _providerConfig._detectExternalAppImport;
const _executeExternalAppImport = _providerConfig._executeExternalAppImport;
const _formatExternalAppImport = _providerConfig._formatExternalAppImport;

// ── 3. 简单计算 → 已抽出至 ./localBrainCalc.js（calcService，降巨石 DESIGN-ARCH-051）

// ── 4. 时间日期 / 系统信息 ──────────────────────────────────────────

const _TIME_RE = /(现在几点|什么时间|当前时间|today|日期|时间|几号|星期几|now|what time|what day|几月)/i;
const _SYSINFO_RE = /(uptime|磁盘|内存|cpu|系统信息|disk|memory|system info|硬盘|存储空间|剩余空间)/i;

function _isDateTimeIntent(text) {
  return _TIME_RE.test(text) && text.length < 40;
}

function _isSysInfoIntent(text) {
  return _SYSINFO_RE.test(text) && text.length < 60;
}

function _detectDateTime() {
  return { type: 'datetime', category: '时间日期', label: '当前时间' };
}

function _detectSysInfo() {
  return { type: 'sysinfo', category: '系统信息', label: '系统状态' };
}

function _executeDateTime() {
  const now = new Date();
  const weekDays = ['日', '一', '二', '三', '四', '五', '六'];
  return {
    type: 'datetime', success: true,
    date: now.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }),
    time: now.toLocaleTimeString('zh-CN', { hour12: false }),
    weekDay: `星期${weekDays[now.getDay()]}`,
    timestamp: now.toISOString(),
  };
}

function _executeSysInfo() {
  const info = {
    type: 'sysinfo', success: true,
    platform: `${os.type()} ${os.release()} (${os.arch()})`,
    hostname: os.hostname(),
    cpus: `${os.cpus().length} cores (${os.cpus()[0]?.model || 'unknown'})`,
    memory: `${(os.freemem() / 1073741824).toFixed(1)} GB free / ${(os.totalmem() / 1073741824).toFixed(1)} GB total`,
    uptime: `${(os.uptime() / 3600).toFixed(1)} hours`,
    nodeVersion: process.version,
  };
  // Disk (best-effort) — fs.statfsSync is cross-platform and needs no shell,
  // so it works on Win11 24H2+ (no wmic), Alpine, and macOS alike.
  try {
    const root = process.platform === 'win32' ? process.cwd().slice(0, 3) : '/';
    const st = require('fs').statfsSync(root);
    const totalGB = (st.blocks * st.bsize) / 1073741824;
    const freeGB = (st.bfree * st.bsize) / 1073741824;
    info.disk = `${freeGB.toFixed(1)} GB free / ${totalGB.toFixed(1)} GB total (${root})`;
  } catch { info.disk = '(unavailable)'; }
  return info;
}

function _formatDateTime(result) {
  if (_fmt && _fmt.isEnabled()) {
    return _fmt.compose({
      title: '当前时间',
      sections: [{ lines: _fmt.keyValues([['日期', `${result.date} ${result.weekDay}`], ['时间', result.time]]) }],
      meta: ['本地时钟'],
    });
  }
  return `${result.date} ${result.weekDay}\n${result.time}`;
}

function _formatSysInfo(result) {
  if (_fmt && _fmt.isEnabled()) {
    const pairs = [
      ['系统', result.platform],
      ['主机', result.hostname],
      ['CPU', result.cpus],
      ['内存', result.memory],
      ['运行', result.uptime],
      ['Node', result.nodeVersion],
    ];
    if (result.disk && result.disk !== '(unavailable)') pairs.push(['磁盘', result.disk]);
    return _fmt.compose({
      title: '系统状态',
      sections: [{ lines: _fmt.keyValues(pairs) }],
      meta: ['本地系统信息'],
    });
  }
  const lines = [
    `系统: ${result.platform}`,
    `主机: ${result.hostname}`,
    `CPU:  ${result.cpus}`,
    `内存: ${result.memory}`,
    `运行: ${result.uptime}`,
    `Node: ${result.nodeVersion}`,
  ];
  if (result.disk && result.disk !== '(unavailable)') {
    lines.push(`磁盘: ${result.disk}`);
  }
  return lines.join('\n');
}

// ── 4b. 本地数据获取 + 数据清理（无模型可达）──────────────────────────
// 「本地数据需求的获取」= 列出 khy 在本机产生的数据及占用；「数据清理」= 在用户
// 明确确认后回收日志/快照/会话/缓存等。清理是破坏性操作，默认仅预览，必须显式
// 「确认/执行/清理」字样才真正执行 —— 与全局「破坏性操作先确认」铁律一致。

const _STORAGE_RE = /(本地数据|存储报告|占用了?多少|数据占用|khy.{0,4}数据|存储情况|storage report|disk usage|data usage|占用空间)/i;
const _CLEANUP_RE = /(清理|清除|清空|清掉|回收|腾空间|释放空间|垃圾文件|cleanup|clean up|free space|清缓存|清日志)/i;
// 「真正执行」闸门：仅当出现明确执行意图词才落地删除，否则只预览。
const _CLEANUP_CONFIRM_RE = /(确认|确定|执行|马上|立刻|立即|现在就?清|真的清|do it|confirm|yes|执行清理|开始清理)/i;

function _isStorageIntent(text) {
  // 清理意图优先于纯存储查询，避免「清理本地数据」被存储报告抢走。
  return _STORAGE_RE.test(text) && !_CLEANUP_RE.test(text) && text.length < 60;
}
function _isCleanupIntent(text) {
  return _CLEANUP_RE.test(text) && text.length < 80;
}

function _detectStorage() {
  return { type: 'storage_report', category: '本地数据', label: '存储占用' };
}
function _detectCleanup(text) {
  const confirmed = _CLEANUP_CONFIRM_RE.test(text);
  return { type: 'data_cleanup', category: '数据清理', label: confirmed ? '执行清理' : '清理预览', confirmed };
}

function _executeStorage() {
  try {
    const report = require('./cleanupService').getStorageReport();
    return { type: 'storage_report', success: true, report };
  } catch (e) {
    return { type: 'storage_report', success: false, error: e.message };
  }
}

function _executeCleanup(plan) {
  const svc = require('./cleanupService');
  if (!plan.confirmed) {
    // 预览：只读存储报告，不删除任何东西。
    try {
      return { type: 'data_cleanup', success: true, preview: true, report: svc.getStorageReport() };
    } catch (e) {
      return { type: 'data_cleanup', success: false, error: e.message };
    }
  }
  try {
    const results = svc.runCleanup({ trigger: 'local-mode' });
    return { type: 'data_cleanup', success: true, preview: false, summary: results.summary };
  } catch (e) {
    return { type: 'data_cleanup', success: false, error: e.message };
  }
}

// 存储报告字段 → 中文标签（零硬编码：未登记的键回退原名）。
const _STORAGE_LABELS = {
  securityLog: '安全日志', securityLogArchives: '安全日志归档', growthSnapshots: '成长快照',
  trainingData: '训练数据', telemetry: '遥测导出', conversations: '会话记录',
  traceAudit: '调用审计', scanLog: '扫描日志', skillAudit: '技能台账',
  telemetryAudit: '遥测审计', sessions: '会话存储', checkpoints: '检查点',
  taskOutputs: '任务输出', dailyLogs: '每日日志',
};

function _storageRows(report, humanSize) {
  // 按占用降序列出非零条目；total/totalHuman 不计入明细。
  return Object.entries(report)
    .filter(([k, v]) => k !== 'total' && k !== 'totalHuman' && v && typeof v === 'object' && (v.size || 0) > 0)
    .sort((a, b) => (b[1].size || 0) - (a[1].size || 0))
    .map(([k, v]) => {
      const label = _STORAGE_LABELS[k] || k;
      const count = Number.isFinite(v.count) ? ` · ${v.count} 项` : '';
      return [label, `${humanSize(v.size)}${count}`];
    });
}

function _formatStorage(result) {
  if (!result.success) return `读取存储信息失败：${result.error}`;
  const { humanSize } = require('./cleanupService');
  const rows = _storageRows(result.report, humanSize);
  const total = result.report.totalHuman || humanSize(result.report.total || 0);
  if (_fmt && _fmt.isEnabled()) {
    return _fmt.compose({
      title: '本地数据占用',
      sections: [
        { heading: `合计 ${total}`, lines: rows.length ? _fmt.keyValues(rows) : ['- （暂无可统计的本地数据）'] },
      ],
      meta: ['本地数据', '无模型'],
      footer: '输入「清理」可预览可回收空间，「确认清理」执行回收。',
    });
  }
  const lines = [`本地数据占用 — 合计 ${total}：`];
  rows.forEach(([k, v]) => lines.push(`  ${k}: ${v}`));
  if (!rows.length) lines.push('  （暂无可统计的本地数据）');
  lines.push('提示：输入「清理」预览，「确认清理」执行回收。');
  return lines.join('\n');
}

function _formatCleanup(result) {
  if (!result.success) return `清理失败：${result.error}`;
  const { humanSize } = require('./cleanupService');
  if (result.preview) {
    const rows = _storageRows(result.report, humanSize);
    const total = result.report.totalHuman || humanSize(result.report.total || 0);
    if (_fmt && _fmt.isEnabled()) {
      return _fmt.compose({
        title: '清理预览（未执行）',
        sections: [{ heading: `可回收上限约 ${total}`, lines: rows.length ? _fmt.keyValues(rows) : ['- （无可回收数据）'] }],
        meta: ['数据清理', '仅预览'],
        footer: '这只是预览，未删除任何文件。确认请输入「确认清理」。',
      });
    }
    const lines = [`清理预览（未执行）— 可回收上限约 ${total}：`];
    rows.forEach(([k, v]) => lines.push(`  ${k}: ${v}`));
    lines.push('未删除任何文件。确认请输入「确认清理」。');
    return lines.join('\n');
  }
  // 已执行
  const s = result.summary || {};
  const actions = Array.isArray(s.actions) ? s.actions : [];
  if (_fmt && _fmt.isEnabled()) {
    return _fmt.compose({
      title: '清理完成',
      sections: [{
        heading: `已释放 ${s.freedHuman || humanSize(s.freedBytes || 0)}`,
        lines: actions.length ? _fmt.bullets(actions) : ['- 无需清理，存储已是精简状态'],
      }],
      meta: ['数据清理', '已执行'],
    });
  }
  const lines = [`清理完成 — 已释放 ${s.freedHuman || humanSize(s.freedBytes || 0)}：`];
  if (actions.length) actions.forEach(a => lines.push(`  - ${a}`));
  else lines.push('  无需清理，存储已是精简状态。');
  return lines.join('\n');
}

// ── 5. 文本处理工具 → 已抽出至 ./localBrainTextOps.js（降巨石，按职责拆分）──
// 同名 `_`-前缀别名保持 Tier-1 handler registry 接线不变；行为字节等价。
const _textOps = require("./localBrainTextOps");
const _TEXT_OPS = _textOps.TEXT_OPS;
const _isTextOpIntent = _textOps.isTextOpIntent;
const _detectTextOp = _textOps.detectTextOp;
const _executeTextOp = _textOps.executeTextOp;
const _formatTextOp = _textOps.formatTextOp;

// ── 6+7. 本地文件搜索 / 文件内容查看 → 已抽出至 ./localBrainFileLookup.js（只读检索，降巨石）──
// 同名 `_`-前缀别名保持 Tier-1 handler registry 接线不变；行为字节等价。
const _fileLookup = require('./localBrainFileLookup');
const _isSearchIntent = _fileLookup.isSearchIntent;
const _detectSearch = _fileLookup.detectSearch;
const _executeSearch = _fileLookup.executeSearch;
const _formatSearch = _fileLookup.formatSearch;
const _isViewIntent = _fileLookup.isViewIntent;
const _detectView = _fileLookup.detectView;
const _executeView = _fileLookup.executeView;
const _formatView = _fileLookup.formatView;
const _isListIntent = _fileLookup.isListIntent;
const _detectList = _fileLookup.detectList;
const _executeList = _fileLookup.executeList;
const _formatList = _fileLookup.formatList;

// ── 7b. 本地图片识别 / 看图 → localBrainImageView.js（无模型也能「看形+验字」）──
// 确定性读图头(尺寸/比例/色彩)+ best-effort 本地 OCR;无模型本地模式(/local)专用。
const _imageView = require('./localBrainImageView');
const _isImageViewIntent = _imageView.isImageViewIntent;
const _detectImageView = _imageView.detectImageView;
const _executeImageView = _imageView.executeImageView;
const _formatImageView = _imageView.formatImageView;

// ── 7c. 「打造最佳环境」→ localBrainEnvOptimize.js ────────────────────
// 一句自然语言("打造当前系统最佳环境")即触发底座自检 + 自愈流水线并格式化报告,
// 免去用户记忆 `khy monitor selfcheck run`。cooperative:false → 有无模型都拦截:
// 这是确定性的系统动作(读实时健康 + 自动修复),模型无法替代且不该改写其结果。
const _envOptimize = require('./localBrainEnvOptimize');
const _isEnvOptimizeIntent = _envOptimize.isEnvOptimizeIntent;
const _detectEnvOptimize = _envOptimize.detectEnvOptimize;
const _executeEnvOptimize = _envOptimize.executeEnvOptimize;
const _formatEnvOptimize = _envOptimize.formatEnvOptimize;


// ── Tier 1 Handler Registry ──────────────────────────────────────────

const _DETERMINISTIC_HANDLERS = [
  { type: 'regex_extract', match: _isExtractIntent, detect: _detectExtract, cooperative: false },
  // 单位换算：排在 calc 之前——calc 会把「5千米等于多少米」退化抽成「5」误答，故由本叶子精确
  // 拦截（cooperative:false，两种模式都本地精确换算）。
  { type: 'deterministic_unit', match: deterministicFacts.isUnitIntent, detect: deterministicFacts.detectUnitFact, cooperative: false },
  { type: 'calc',          match: calcService.isCalcIntent, detect: calcService.detectCalc, cooperative: false },
  // 常数公理 / 标准定理：无模型时本地直接答；有模型时让路（cooperative），此时由 cli/ai.js 注入
  // 同一叶子的权威真值，既保证「公理与定理优先于模型猜测」，又让模型负责阐释/应用。
  { type: 'deterministic_fact', match: deterministicFacts.isKnowledgeIntent, detect: deterministicFacts.detectKnowledgeFact, cooperative: true },
  { type: 'file_op',       match: _isFileOpIntent,  detect: _detectFileOp, cooperative: false },
  { type: 'datetime',      match: _isDateTimeIntent, detect: _detectDateTime, cooperative: false },
  { type: 'sysinfo',       match: _isSysInfoIntent, detect: _detectSysInfo, cooperative: false },
  // 「打造最佳环境」— 底座自检 + 自愈,确定性系统动作,有无模型都拦截。置于 sysinfo 后:
  // 判据须同时命中「系统/环境」目标 + 「打造/优化/自检」动作,普通 sysinfo 查询不会误触。
  { type: 'env_optimize',  match: _isEnvOptimizeIntent, detect: _detectEnvOptimize, cooperative: false },
  // 本地数据获取 + 数据清理：确定性、依赖本机实时状态，模型无法做得更好；
  // 清理的删除分支由 detect 内 confirmed 闸门把守（默认仅预览）。
  { type: 'storage_report', match: _isStorageIntent, detect: _detectStorage, cooperative: false },
  { type: 'data_cleanup',   match: _isCleanupIntent, detect: _detectCleanup, cooperative: false },
  { type: 'text_op',       match: _isTextOpIntent,  detect: _detectTextOp, cooperative: false },
  { type: 'local_search',  match: _isSearchIntent,  detect: _detectSearch, cooperative: true },
  // 图片识别 / 看图 — 只读,置于 file_view 之前:图片扩展名路径优先由本处理器「看图」,
  // 否则会被 file_view 当 utf8 读成乱码。cooperative:true → 仅无模型(Tier A)时介入;
  // 有模型时让路给模型自身的视觉/工具链。门控 KHY_LOCAL_IMAGE_VIEW。
  { type: 'image_view',    match: _isImageViewIntent, detect: _detectImageView, cooperative: true },
  { type: 'file_view',     match: _isViewIntent,    detect: _detectView,   cooperative: true },
  // 目录列举 — 只读,Tier A 缺口闭环（「看看当前目录有哪些文件」）。置于 search/view 之后
  // 且 cooperative:true:既有 handler 全保优先级,仅无模型时介入。门控 KHY_LOCAL_LIST。
  { type: 'local_list',    match: _isListIntent,    detect: _detectList,   cooperative: true },
  // 目录创建(mkdir)/文件删除(rm，确认闸门) — 写/删类,cooperative:true 仅无模型(Tier A)
  // 时介入；有模型时让路由模型经自身工具+权限层做文件变更。**置于所有只读检索(search/view/
  // list)之后** → 只读意图永远优先,删除的较宽判据绝不抢占它们。删除默认仅预览,须同句带
  // 明确确认字样才真正执行(data_cleanup 同款 confirmed 闸门)。门控 KHY_DIR_CREATE/KHY_FILE_DELETE。
  { type: 'dir_create',    match: _isMkdirIntent,   detect: _detectMkdir,  cooperative: true },
  { type: 'file_delete',   match: _isDeleteIntent,  detect: _detectDelete, cooperative: true },
  // 模型供应商配置(增/删/列 API Key·endpoint·URL·模型) — cooperative:true 仅无模型(Tier A)介入,
  // 专治「配置第一把密钥+模型」的 bootstrap 死锁;有模型让路给 configureModelProvider 工具+权限层。
  // 置于所有写/删之后:删除较宽判据绝不抢占;增/删/列均经 customProviderRegistrar/Registry/apiKeyPool
  // SSOT 落地,删除默认仅预览+确认闸门+默认保留密钥。门控 KHY_NL_PROVIDER(叶子内)默认开。
  // 外部软件模型配置(给 opencode/openclaw/reasonix/deepseek-tui/coze/claude-code 增删改查模型) —
  // cooperative:true 仅无模型(Tier A)介入;有模型让路给 configureExternalApp 工具+权限层。
  // **置于 provider_config 之前**:本闸门更严(须显式点名 6 个 app 之一 + 动作词 + 领域引用三命中),
  // 否则「给 opencode 配 deepseek 模型」会被 provider_config 的宽判据当成配 khy 自身名为 opencode 的
  // 供应商而抢走。无 app 名 → resolve 返 null → 落到下方 provider_config(khy 自身配置不受影响)。
  // 增/删/改经 externalApps/*Adapter merge-write + 原子写,删除默认仅预览 + 确认闸门 + 默认保留密钥。
  // 门控 KHY_NL_EXTERNAL_APP(叶子内)默认开。
  // 反向:把 6 个外部软件里已配置的可用模型读出并注册进 khy 自己的 provider 池(消费侧)。
  // **置于 external_app_config 之前**:反向为 import-only 且判据锚定强反向动词(导入/复用/引入)——
  // 这些动词语义上只能是"把外部软件的模型拿进 khy",须先于正向判定,否则「复用 claude code **配置**的
  // 模型」会因句中带定语 配置 被正向 external_app_config 当作 add 抢走。弱反向动词(使用/用)在叶子内
  // 已让位正向配置动作,故不会反噬正向「配置 opencode 使用 deepseek」。门控 KHY_NL_EXTERNAL_APP_IMPORT
  // (解析叶子)/ KHY_EXTERNAL_APP_IMPORT(importer)双默认开。cooperative:true 仅无模型(Tier A)介入;
  // 有模型让路给 ImportExternalAppModels 工具。
  { type: 'external_app_import', match: _isExternalAppImportIntent, detect: _detectExternalAppImport, cooperative: true },
  { type: 'external_app_config', match: _isExternalAppIntent, detect: _detectExternalApp, cooperative: true },
  { type: 'provider_config', match: _isProviderCfgIntent, detect: _detectProviderCfg, cooperative: true },
  // API Key 失效→无模型也能更新:用户直接粘一把裸 key(无动词/无厂商)→ 确定性写入。
  // cooperative:true 让路给模型的常规配置流,但 alwaysDeterministic:true 使本处理器**即便有模型
  // 在线也介入**——裸 key 的确定性入池(→ apiKeyPool.addKey 落盘)不再依赖弱模型自觉调用
  // configureModelProvider 工具。**置于 provider_config 之后** → 「配置 glm key sk-xxx」这类带动词/
  // 厂商的显式配置仍先由 provider_config 精确抓取,裸 key 才落到本处理器。写入复用 _execProviderAdd
  // (findBuiltinProvider → applyBuiltinProviderKey → apiKeyPool)。门控 KHY_KEY_UPDATE_FLOW
  // (looksLikeBareKey 内部已判门,门关时 match 恒 false → 逐字节回退让路给模型)。
  { type: 'key_update', match: _isKeyUpdateIntent, detect: _detectKeyUpdate, cooperative: true, alwaysDeterministic: true },
  // Code check/fix — 确定性静态分析，有模型时协作增强
  { type: 'code_check', match: codeCheckService.isCodeCheckIntent, detect: codeCheckService.detectCodeCheck, cooperative: true },
  { type: 'code_fix',   match: codeCheckService.isCodeFixIntent,   detect: codeCheckService.detectCodeFix,   cooperative: true },
  // Public API handlers — 有无模型都拦截（实时数据/零成本，模型做不到更好）
  // 执行器为 async，REPL 已用 Promise.resolve() 包裹，兼容无缝
];

const _EXECUTORS = {
  regex_extract: _executeExtract,
  deterministic_unit: deterministicFacts.executeFact,
  calc: calcService.executeCalc,
  deterministic_fact: deterministicFacts.executeFact,
  file_op: _executeFileOp,
  dir_create: _executeMkdir,
  file_delete: _executeDelete,
  datetime: _executeDateTime,
  sysinfo: _executeSysInfo,
  env_optimize: _executeEnvOptimize,
  storage_report: _executeStorage,
  data_cleanup: _executeCleanup,
  text_op: _executeTextOp,
  local_search: _executeSearch,
  file_view: _executeView,
  image_view: _executeImageView,
  local_list: _executeList,
  provider_config: _executeProviderCfg,
  key_update: _execKeyUpdate,
  external_app_config: _executeExternalApp,
  external_app_import: _executeExternalAppImport,
  code_check: codeCheckService.executeCodeCheck,
  code_fix:   codeCheckService.executeCodeFix,
};

const _FORMATTERS = {
  regex_extract: _formatExtract,
  deterministic_unit: deterministicFacts.formatFact,
  calc: calcService.formatCalc,
  deterministic_fact: deterministicFacts.formatFact,
  file_op: _formatFileOp,
  dir_create: _formatMkdir,
  file_delete: _formatDelete,
  datetime: _formatDateTime,
  sysinfo: _formatSysInfo,
  env_optimize: _formatEnvOptimize,
  storage_report: _formatStorage,
  data_cleanup: _formatCleanup,
  text_op: _formatTextOp,
  local_search: _formatSearch,
  file_view: _formatView,
  image_view: _formatImageView,
  local_list: _formatList,
  provider_config: _formatProviderCfg,
  external_app_config: _formatExternalApp,
  external_app_import: _formatExternalAppImport,
  code_check: codeCheckService.formatCodeCheck,
  code_fix:   codeCheckService.formatCodeFix,
};

function detectDeterministic(input, opts) {
  const text = _cleanInput(input);
  if (!text || text.length > 500) return null;

  // 模型优先策略：有模型时，cooperative 类 handler 让路给模型
  // 只有 cooperative:false 的纯确定性能力（calc/regex/file_op/datetime/sysinfo/text_op）仍拦截
  const modelAvail = isModelAvailable();

  // 直接匹配
  for (const handler of _DETERMINISTIC_HANDLERS) {
    // 有模型时跳过 cooperative handler，让模型自行决策；
    // alwaysDeterministic 的 handler(如裸 key 入池)即便有模型也介入。
    if (modelAvail && handler.cooperative && !handler.alwaysDeterministic) continue;
    if (handler.match(text)) {
      const plan = handler.detect(text, opts);
      if (plan) {
        plan.cooperative = handler.cooperative ?? false;
        return plan;
      }
    }
  }

  // 跟进/指代解析 — 用上下文展开后重新匹配
  const followUp = resolveFollowUp(text);
  if (followUp && followUp.resolved && followUp.resolved !== text) {
    const resolved = _cleanInput(followUp.resolved);
    for (const handler of _DETERMINISTIC_HANDLERS) {
      if (modelAvail && handler.cooperative && !handler.alwaysDeterministic) continue;
      if (handler.match(resolved)) {
        const plan = handler.detect(resolved, opts);
        if (plan) {
          plan.cooperative = handler.cooperative ?? false;
          plan._resolvedFrom = text;
          plan._resolveContext = followUp.context;
          return plan;
        }
      }
    }
  }

  return null;
}

function executeDeterministic(plan, opts) {
  const executor = _EXECUTORS[plan?.type];
  if (!executor) return { success: false, error: `Unknown deterministic type: ${plan?.type}` };
  return executor(plan, opts);
}

function formatDeterministicResult(result) {
  const formatter = _FORMATTERS[result?.type];
  if (!formatter) return result?.error || '(unknown result type)';
  return formatter(result);
}

// ═══════════════════════════════════════════════════════════════════
// Public API Layer — 免费 API 调用（无模型 + 有网络时可用）
// ═══════════════════════════════════════════════════════════════════

let _publicApisCache = null;
function _getPublicApis() {
  if (_publicApisCache) return _publicApisCache;
  try {
    const data = fs.readFileSync(path.join(__dirname, '../data/publicApis.json'), 'utf8');
    _publicApisCache = JSON.parse(data);
    return _publicApisCache;
  } catch { return { apis: [] }; }
}

function _findApi(category) {
  const reg = _getPublicApis();
  return reg.apis.filter(a => a.category === category);
}

// ── 8–15. 外部实时数据 API 技能（天气/汇率/加密货币/词典/名言/公网 IP/冷知识/节假日）
// 已抽取为纯叶子 localBrainExternalApi.js 以解开上帝文件纠缠（同名别名 re-export 保契约字节不变，
// 范式同 localBrainCalc/localBrainTextOps）。完整实现见该叶子；此处仅取回三张注册表合入统一拦截管线。
const _externalApi = require('./localBrainExternalApi');
const _API_HANDLERS = _externalApi.API_HANDLERS;
const _API_EXECUTORS = _externalApi.API_EXECUTORS;
const _API_FORMATTERS = _externalApi.API_FORMATTERS;
// _detectCrypto/_detectHoliday 保留模块级别名，供文件末尾 module.exports 原样再导出（Ch2 map-entries 测试依赖）。
const _detectCrypto = _externalApi._detectCrypto;
const _detectHoliday = _externalApi._detectHoliday;

// ── 离线知识库 (offlineKnowledge) — 无网络无模型也可用 ─────────────
const _offlineKnowledge = require('./offlineKnowledge');

// unit_convert 必须在 calc 之前（"1英里等于多少公里"会被 calc 误匹配）
// 找到 calc 的位置，在其前面插入 unit_convert
const _calcIdx = _DETERMINISTIC_HANDLERS.findIndex(h => h.type === 'calc');
_DETERMINISTIC_HANDLERS.splice(_calcIdx >= 0 ? _calcIdx : 0, 0,
  { type: 'unit_convert', match: (t) => _offlineKnowledge.detect(t, process.env)?.type === 'unit_convert', detect: (t) => _offlineKnowledge.detect(t, process.env), cooperative: false },
);

// 其余离线知识 handler 追加到末尾（不存在冲突）
// detect 接受注入 env(process.env)以驱动 offlineKnowledge 的纯叶子门控(如 KHY_HTTP_STATUS_NL)。
_DETERMINISTIC_HANDLERS.push(
  { type: 'http_status',       match: (t) => _offlineKnowledge.detect(t, process.env)?.type === 'http_status',       detect: (t) => _offlineKnowledge.detect(t, process.env), cooperative: false },
  { type: 'cheat_sheet',       match: (t) => _offlineKnowledge.detect(t, process.env)?.type === 'cheat_sheet',       detect: (t) => _offlineKnowledge.detect(t, process.env), cooperative: false },
  { type: 'regex_helper',      match: (t) => _offlineKnowledge.detect(t, process.env)?.type === 'regex_helper',      detect: (t) => _offlineKnowledge.detect(t, process.env), cooperative: false },
  { type: 'common_knowledge',  match: (t) => _offlineKnowledge.detect(t, process.env)?.type === 'common_knowledge',  detect: (t) => _offlineKnowledge.detect(t, process.env), cooperative: false },
);

_EXECUTORS.unit_convert     = (plan) => ({ success: true, type: plan.type, text: _offlineKnowledge.execute(plan) });
_EXECUTORS.http_status      = (plan) => ({ success: true, type: plan.type, text: _offlineKnowledge.execute(plan) });
_EXECUTORS.cheat_sheet      = (plan) => ({ success: true, type: plan.type, text: _offlineKnowledge.execute(plan) });
_EXECUTORS.regex_helper     = (plan) => ({ success: true, type: plan.type, text: _offlineKnowledge.execute(plan) });
_EXECUTORS.common_knowledge = (plan) => ({ success: true, type: plan.type, text: _offlineKnowledge.execute(plan) });

const _offlineFormatter = (r) => r?.text || r?.error || '(无结果)';
_FORMATTERS.unit_convert     = _offlineFormatter;
_FORMATTERS.http_status      = _offlineFormatter;
_FORMATTERS.cheat_sheet      = _offlineFormatter;
_FORMATTERS.regex_helper     = _offlineFormatter;
_FORMATTERS.common_knowledge = _offlineFormatter;

// ── 文档创建管线 (doc_create) — 小模型也能写文档 ────────────────────
// 检测 "写一篇xxx文档/word" + "保存到桌面" 等意图，自动：
//   1. 收集内容（离线知识 + 搜索）
//   2. 组织文本
//   3. 调用 docHelper.py text2docx 创建 .docx
const _DOC_CREATE_RE = /(?:写|创建|生成|制作|做|编写).*?(?:文档|word|docx|报告|攻略|指南|文章|简历|计划|方案)/i;
const _DOC_SAVE_RE = /(?:保存|存|放).*?(?:桌面|desktop|文件夹|目录|路径)/i;
// Topic extraction: handle both "写南阳旅游文档" and "写一篇报告"
// When the doc-type keyword IS the topic (e.g. "写一篇报告"), fall back to using it as the topic
const _DOC_TOPIC_RE = /(?:写|创建|生成|制作|做|编写)(?:一?[篇份个])?(.+?)(?:的?(?:文档|word|docx|报告|攻略|指南|文章|简历|计划|方案))/i;
const _DOC_TYPE_WORDS = ['文档', '报告', '攻略', '指南', '文章', '简历', '计划', '方案'];

function _isDocCreateIntent(text) {
  return _DOC_CREATE_RE.test(text);
}

function _detectDocCreate(text) {
  if (!_DOC_CREATE_RE.test(text)) return null;

  // Extract topic
  const topicMatch = text.match(_DOC_TOPIC_RE);
  let topic = topicMatch ? topicMatch[1].trim() : '';
  // Clean quantifiers/particles that leaked into topic
  topic = topic.replace(/^[一二三四五六七八九十]?[篇份个]/, '').trim();
  // If topic is empty or too short, include the doc-type keyword as part of the topic
  // e.g. "写一篇报告" → topic=报告, "帮我做个工作计划docx" → topic=工作计划
  if (!topic || topic.length < 2) {
    // Try to grab "topic + docType" as a combined phrase
    const combinedMatch = text.match(/(?:写|创建|生成|制作|做|编写)(?:一?[篇份个])?([\u4e00-\u9fa5]{2,})/);
    topic = combinedMatch ? combinedMatch[1].trim() : '文档';
  } else {
    // Check if a doc-type word follows and is meaningful together (e.g. "工作" + "计划")
    const afterTopic = text.slice(text.indexOf(topic) + topic.length);
    const nextDocType = afterTopic.match(/^(报告|攻略|指南|简历|计划|方案)/);
    if (nextDocType && topic.length <= 4) {
      topic = topic + nextDocType[1];
    }
  }

  // Extract save path
  let savePath = null;
  if (/桌面|desktop/i.test(text)) {
    savePath = require('path').join(require('os').homedir(), 'Desktop');
  } else {
    const pathMatch = text.match(/(?:保存|存|放)(?:到|至)?\s*([^\s,，。]+)/);
    if (pathMatch) savePath = pathMatch[1];
  }

  // Generate filename from topic
  const safeFilename = topic.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 50) || '文档';
  const outputPath = require('path').join(
    savePath || (process.env.KHYQUANT_CWD || process.cwd()),
    `${safeFilename}.docx`,
  );

  return { type: 'doc_create', topic, outputPath, raw: text };
}

async function _executeDocCreate(plan) {
  const { topic, outputPath } = plan;

  // Step 1: Gather content — try offline knowledge first, then web search
  let contentSections = [];

  // Try offline knowledge
  try {
    const offlinePlan = _offlineKnowledge.detect(topic, process.env);
    if (offlinePlan) {
      const offlineResult = _offlineKnowledge.execute(offlinePlan);
      if (offlineResult) contentSections.push(offlineResult);
    }
  } catch { /* ignore */ }

  // Try web search for richer content
  try {
    const webSearch = require('./webSearchService');
    const sr = await webSearch.search(topic);
    if (sr && sr.success && sr.results && sr.results.length > 0) {
      for (const r of sr.results.slice(0, 5)) {
        const snippet = r.snippet || '';
        if (snippet.length > 20) {
          // Translate English snippets to Chinese
          const translated = /[\u4e00-\u9fa5]/.test(snippet)
            ? snippet
            : _offlineKnowledge.translateSnippets(snippet);
          contentSections.push(translated);
        }
      }
    }
  } catch { /* no network, proceed with what we have */ }

  // Step 2: Compose document text
  let docText = `${topic}\n\n`;

  if (contentSections.length > 0) {
    docText += contentSections.join('\n\n');
  } else {
    // Minimal fallback content when both offline and search fail
    docText += `关于${topic}的介绍\n\n`;
    docText += `本文档由 KHY OS 本地模式自动生成。\n`;
    docText += `由于当前无法获取详细信息，请手动补充以下内容：\n\n`;
    docText += `一、概述\n\n二、详细介绍\n\n三、总结\n`;
  }

  docText += `\n\n---\n由 KHY OS 本地模式生成`;

  // Step 3: Call docHelper.py text2docx
  try {
    const createDocTool = require('../tools/createDocument');
    const result = await createDocTool.execute({
      content: docText,
      outputPath,
      title: topic,
    });
    if (result && result.success) {
      return { success: true, type: 'doc_create', outputPath: result.output || outputPath, text: result.message || `文档已保存: ${outputPath}` };
    }
    return { success: false, type: 'doc_create', error: result?.error || '文档创建失败' };
  } catch (err) {
    return { success: false, type: 'doc_create', error: `文档创建失败: ${err.message}` };
  }
}

function _formatDocCreate(result) {
  if (!result.success) return `文档创建失败: ${result.error}`;
  return `✓ ${result.text || '文档已创建'}\n  路径: ${result.outputPath}`;
}

// Register doc_create handler — place before file_op to catch "写...文档保存到桌面" first
const _fileOpIdx = _DETERMINISTIC_HANDLERS.findIndex(h => h.type === 'file_op');
_DETERMINISTIC_HANDLERS.splice(_fileOpIdx >= 0 ? _fileOpIdx : 0, 0,
  { type: 'doc_create', match: _isDocCreateIntent, detect: _detectDocCreate, cooperative: true },
);
_EXECUTORS.doc_create = _executeDocCreate;
_FORMATTERS.doc_create = _formatDocCreate;

// ── 合并 API handlers 到 Tier 1 统一管线 ────────────────────────────
// 这样 detectDeterministic / executeDeterministic / formatDeterministicResult
// 自动覆盖 API 类型，quickTaskService 链也直接生效。
_API_HANDLERS.forEach(h => _DETERMINISTIC_HANDLERS.push(h));
Object.assign(_EXECUTORS, _API_EXECUTORS);
Object.assign(_FORMATTERS, _API_FORMATTERS);

/**
 * Detect an API-backed query from user input (standalone, for direct call).
 */
function _detectApiQuery(input, opts) {
  const text = _cleanInput(input);
  if (!text || text.length > 200) return null;
  for (const handler of _API_HANDLERS) {
    if (handler.match(text)) {
      const plan = handler.detect(text, opts);
      if (plan) return plan;
    }
  }
  return null;
}

/**
 * Build a Chinese search query from an API plan (for search fallback).
 */
function _buildApiSearchQuery(plan) {
  const _queryMap = {
    api_weather:  (p) => `${p.city || ''}天气预报`,
    api_currency: (p) => `${p.from || ''}兑${p.to || ''}汇率`,
    api_crypto:   (p) => `${p.coin || '比特币'}价格`,
    api_dict:     (p) => `${p.word || ''} 中文意思`,
    api_quote:    () => '名人名言',
    api_ip:       () => '查询公网IP地址',
    api_trivia:   () => '有趣的冷知识',
    api_holiday:  (p) => `${p.countryName || '中国'}节假日`,
  };
  const builder = _queryMap[plan?.type];
  return builder ? builder(plan) : null;
}

/**
 * API search fallback — when API call fails, search for the answer instead.
 */
async function _apiSearchFallback(plan, originalError) {
  const zhQuery = _buildApiSearchQuery(plan);
  if (!zhQuery) return { success: false, error: String(originalError) };

  try {
    // Try Chinese search first
    const searchResult = await _webSearchFallback(zhQuery);
    if (searchResult) {
      return {
        success: true,
        type: plan.type,
        _searchFallback: true,
        _query: zhQuery,
        text: `(API 不可用，以下为搜索结果)\n\n${searchResult}`,
      };
    }
  } catch { /* search also failed */ }

  // Try English search as last resort
  const enQuery = _buildApiSearchQuery({ ...plan, type: plan.type }) || String(plan.input || '');
  try {
    const enResult = await _webSearchFallback(enQuery);
    if (enResult) {
      const translated = _offlineKnowledge.translateSnippets(enResult);
      return {
        success: true,
        type: plan.type,
        _searchFallback: true,
        _query: enQuery,
        text: `(API 不可用，以下为搜索结果)\n\n${translated}`,
      };
    }
  } catch { /* all failed */ }

  return { success: false, error: `API 不可用: ${String(originalError)}` };
}

/**
 * Execute an API query plan (standalone). Falls back to search on failure.
 */
async function _executeApiQuery(plan) {
  const executor = _API_EXECUTORS[plan?.type];
  if (!executor) return { success: false, error: `Unknown API type: ${plan?.type}` };
  try {
    const result = await executor(plan);
    if (result && result.success) return result;
    // API returned failure → try search fallback
    return _apiSearchFallback(plan, result?.error || 'API returned failure');
  } catch (err) {
    // API threw → try search fallback
    return _apiSearchFallback(plan, err.message || err);
  }
}

/**
 * Format an API query result (standalone).
 */
function _formatApiResult(result) {
  const formatter = _API_FORMATTERS[result?.type];
  if (!formatter) return result?.error || '(unknown API result)';
  return formatter(result);
}

// ═══════════════════════════════════════════════════════════════════
// Tier 2 — 保底能力（仅无模型时激活）
// ═══════════════════════════════════════════════════════════════════

// ── 笑话 — 网络搜索 ────────────────────────────────────────────────

/**
 * 从网上搜索笑话。
 * 尝试多种来源：公共 API → 网页抓取。
 * 网络不可用时返回提示。
 *
 * @param {string} [category] - 'programming' | 'cold' | 通用
 * @returns {Promise<string>} 笑话文本
 */
async function _fetchJokeFromWeb(category) {
  // 构造搜索关键词
  let query = '笑话';
  if (category === 'programming' || category === 'code') query = '编程笑话 程序员';
  else if (category === 'cold') query = '冷笑话';
  else if (category === 'tech') query = '科技笑话 IT';

  const _jokeKey = (text) => String(text || '').trim().slice(0, 80);
  const _isNew = (text) => {
    const k = _jokeKey(text);
    return k.length > 0 && !_toldJokes.has(k);
  };
  const _markTold = (text) => {
    _toldJokes.add(_jokeKey(text));
    if (_toldJokes.size > 200) {
      _toldJokes.delete(_toldJokes.values().next().value);
    }
    return text;
  };

  // cache-bust: 时间戳 + 随机数，让 CDN / 服务端每次返回不同结果
  const _bust = () => `_t=${Date.now()}&_r=${Math.random().toString(36).slice(2, 8)}`;

  // ── 默认中文优先，每个方案最多重试 3 次拿到不重复的 ──

  // 方案 1: 中文笑话 API (vvhan) — 带 cache-bust 重试
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const jokeText = await new Promise((resolve, reject) => {
        const url = `https://api.vvhan.com/api/joke?type=text&${_bust()}`;
        const req = https.get(url, { timeout: 5000 }, (res) => {
          let data = '';
          res.on('data', chunk => { data += chunk; });
          res.on('end', () => {
            const text = data.trim();
            if (text && text.length > 5 && text.length < 1000 && !text.startsWith('{') && !text.startsWith('<')) {
              resolve(text);
            } else {
              try {
                const json = JSON.parse(text);
                resolve(json.data || json.content || json.joke || json.text || '');
              } catch { reject(new Error('parse failed')); }
            }
          });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      });
      if (jokeText && _isNew(jokeText)) return _markTold(jokeText);
      // 重复了，再试一次
    } catch { break; /* 网络错误直接跳到下一方案 */ }
  }

  // 方案 2: 中文笑话（通过 web search 服务）
  try {
    const { searchWeb } = require('./webSearchService');
    if (typeof searchWeb === 'function') {
      const results = await searchWeb(query, { maxResults: 5, timeout: 5000 });
      if (Array.isArray(results) && results.length > 0) {
        const snippets = results
          .map(r => String(r.snippet || r.description || '').trim())
          .filter(s => s.length > 10 && s.length < 500 && _isNew(s));
        if (snippets.length > 0) {
          const pick = snippets[Math.floor(Math.random() * snippets.length)];
          return _markTold(pick);
        }
      }
    }
  } catch { /* fallthrough */ }

  // 方案 3: 英文笑话 API (jokeapi.dev — 兜底，自带随机性)
  if (!category || category === 'programming' || category === 'code') {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const apiCategory = (category === 'programming' || category === 'code') ? 'Programming' : 'Any';
        const jokeText = await new Promise((resolve, reject) => {
          const url = `https://v2.jokeapi.dev/joke/${apiCategory}?lang=en&safe-mode&type=single,twopart&${_bust()}`;
          const req = https.get(url, { timeout: 5000 }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
              try {
                const json = JSON.parse(data);
                if (json.error) { reject(new Error('API error')); return; }
                if (json.type === 'single') resolve(json.joke);
                else resolve(`${json.setup}\n${json.delivery}`);
              } catch (e) { reject(e); }
            });
          });
          req.on('error', reject);
          req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        });
        if (jokeText && _isNew(jokeText)) return _markTold(jokeText);
      } catch { break; }
    }
  }

  return null;
}

// ── 通用 Web Search 兜底 ────────────────────────────────────────────

/**
 * 无模型时用 web search 回答用户的通用问题。
 * 调用 webSearchService.search (Bing→Kiro MCP→DuckDuckGo 级联)，
 * 将搜索结果格式化为可读的摘要。
 *
 * @param {string} query - 用户的自然语言问题
 * @returns {Promise<string|null>} 格式化的搜索结果，或 null
 */
/**
 * 清理 HTML / 实体 / 多余空白，返回干净文本。
 */
function _cleanSnippet(raw) {
  return String(raw || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 把一段文本拆成独立句子（中英文混排）。
 */
function _splitSentences(text) {
  // 按中文句号/问号/感叹号、英文句末 + 空格、换行拆分
  return text
    .split(/(?<=[。！？!?])\s*|(?<=\.)\s+(?=[A-Z\u4e00-\u9fa5])|\n+/)
    .map(s => s.trim())
    .filter(s => s.length >= 6);
}

/**
 * 计算一个句子与查询关键词的相关度（0~1）。
 * 基于关键词命中率 + 长度合理性加权。
 */
function _sentenceRelevance(sentence, keywords) {
  if (!keywords.length) return 0.5;
  const lower = sentence.toLowerCase();
  let hits = 0;
  for (const kw of keywords) {
    if (lower.includes(kw)) hits++;
  }
  const kwScore = hits / keywords.length;
  // 过短或过长的句子降权
  const lenPenalty = sentence.length < 15 ? 0.6 : sentence.length > 300 ? 0.7 : 1;
  return kwScore * lenPenalty;
}

/**
 * 两个句子的 Jaccard 近似度（字符 bigram），用于去重。
 */
function _sentenceSimilarity(a, b) {
  const bigrams = (s) => {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i++) set.add(s[i] + s[i + 1]);
    return set;
  };
  const sa = bigrams(a.toLowerCase());
  const sb = bigrams(b.toLowerCase());
  if (sa.size === 0 && sb.size === 0) return 1;
  let inter = 0;
  for (const bg of sa) { if (sb.has(bg)) inter++; }
  return inter / (sa.size + sb.size - inter);
}

// 引擎内部名 → 用户可读来源名（零硬编码：未登记回退原名）。
const _ENGINE_SOURCE_LABELS = {
  baidu: '百度', 'bing-cn': 'Bing', 'bing-cn(pw)': 'Bing', 'baidu(pw)': '百度',
  duckduckgo: 'DuckDuckGo', sogou: '搜狗', so360: '360', kiro: 'Kiro',
};

/**
 * 从结果集中归纳出实际贡献的「数据源」清单（去重、保序）。落实「本地搜索不能
 * 只靠百度」——把多引擎扇出对用户显式可见、可证。结果项的 `engines` 字段由
 * webSearchService 的 RRF 融合写入；缺失时回退空数组（调用方据此决定是否展示）。
 * @param {Array} results
 * @returns {string[]} 形如 ['百度','Bing','搜狗']
 */
function _collectSources(results) {
  const seen = new Set();
  const out = [];
  for (const r of Array.isArray(results) ? results : []) {
    const engines = Array.isArray(r && r.engines) ? r.engines : [];
    for (const e of engines) {
      const label = _ENGINE_SOURCE_LABELS[e] || e;
      if (label && !seen.has(label)) { seen.add(label); out.push(label); }
    }
  }
  return out;
}

/**
 * 来源脚注：当贡献引擎 ≥ 2 时，明示「数据源：百度、Bing、搜狗」，让用户看到
 * 检索并非单一来源。仅一个或零个来源时返回空串（不画蛇添足）。
 * env KHY_LOCAL_SHOW_SOURCES=0/off/false/no 可关闭。
 */
function _sourceFooter(results) {
  const v = String(process.env.KHY_LOCAL_SHOW_SOURCES || '').trim().toLowerCase();
  if (v === '0' || v === 'off' || v === 'false' || v === 'no') return '';
  const sources = _collectSources(results);
  if (sources.length < 2) return '';
  return `数据源：${sources.join('、')}（多引擎聚合）`;
}

/**
 * 从搜索结果中提取、去重、排序句子，组织成连贯段落。
 *
 * @param {string} query — 用户原始查询
 * @param {Array} results — 搜索引擎返回的结果 [{title, snippet, url}, ...]
 * @returns {string} 组织后的回答文本
 */
function _organizeSearchResults(query, results) {
  // 1. 提取查询关键词：中/英/数字边界切分 + 中文长词 2-gram（与严格 IR 引擎共用 _irKeywords）。
  const queryWords = _irKeywords(query);

  // 2. 从所有结果的 snippet 中抽句（title 仅用于补充来源信息，不混入正文）
  const allSentences = [];
  const sourceMap = []; // sentence index → source url
  for (const r of results) {
    const snippet = _cleanSnippet(r.snippet || r.description || '');
    const url = String(r.url || '').trim();
    for (const sent of _splitSentences(snippet)) {
      allSentences.push(sent);
      sourceMap.push(url);
    }
  }

  if (allSentences.length === 0) return null;

  // 3. 打分 + 排序
  const scored = allSentences.map((s, i) => ({
    text: s,
    score: _sentenceRelevance(s, queryWords),
    source: sourceMap[i],
    idx: i,
  }));
  scored.sort((a, b) => b.score - a.score);

  // 4. 去重（Jaccard > 0.5 视为重复，保留得分更高的）
  const selected = [];
  for (const item of scored) {
    if (item.score < 0.05) continue; // 完全不相关
    let dup = false;
    for (const existing of selected) {
      if (_sentenceSimilarity(item.text, existing.text) > 0.5) { dup = true; break; }
    }
    if (!dup) selected.push(item);
    if (selected.length >= 12) break;
  }

  if (selected.length === 0) return null;

  // 5. 组织成段落：高相关句 → 综述段 + 补充段 + 来源
  const highRel = selected.filter(s => s.score >= 0.3);
  const medRel = selected.filter(s => s.score >= 0.1 && s.score < 0.3);

  // 辅助：智能合并句子为段落，句尾已有标点的不再追加
  const _ensureEnd = (t) => {
    if (/[。！？!?.;；]$/.test(t)) return t;
    if (/[a-zA-Z0-9)]$/.test(t)) return t + '.';
    return t + '。';
  };

  // 要点列表：高相关句优先，逐条列出（不再揉成一大段，便于扫读）。
  // 每条句子前补「• 」项目符号，句尾补标点。
  const bulletItems = [];
  for (const s of highRel) bulletItems.push(s);
  for (const s of medRel) {
    if (bulletItems.length >= 8) break;
    bulletItems.push(s);
  }
  // 高/中相关都为空时，退而展示最好的几条
  if (bulletItems.length === 0) {
    for (const s of selected.slice(0, 5)) bulletItems.push(s);
  }

  const points = bulletItems.slice(0, 8).map(s => _ensureEnd(s.text.trim()));
  const usedUrls = [...new Set(bulletItems.map(s => s.source).filter(Boolean))].slice(0, 4);
  const footer = '以上内容由 KHY 从网络搜索结果中提取整理，未做改写或推理。配置 AI 模型后可获得更深入的分析。';
  const srcLine = _sourceFooter(results); // 多引擎来源明示（≥2 源才出现）

  if (_fmt && _fmt.isEnabled()) {
    return _fmt.compose({
      title: `关于「${query}」`,
      sections: [{ heading: '要点', lines: _fmt.bullets(points) }],
      sources: usedUrls,
      meta: [`基于 ${usedUrls.length || results.length} 来源`, '网络搜索', ...(srcLine ? [srcLine] : [])],
      footer,
    });
  }

  // 朴素回退
  const lines = [];
  lines.push(`关于「${query}」，从网络搜索结果整理出以下要点：\n`);
  for (const p of points) lines.push(`• ${p}`);
  if (usedUrls.length > 0) {
    lines.push('\n来源（可复制完整链接）:');
    usedUrls.forEach((u, i) => lines.push(`${i + 1}. ${u}`));
  }
  if (srcLine) lines.push(`\n${srcLine}`);
  lines.push(`\n(${footer})`);
  return lines.join('\n');
}

// ── 严格规则式信息检索引擎（无模型 + 有网络）────────────────────────────
// 角色：传统基于规则的检索引擎，不概括、不改写、不推理，只从「前 3 条」搜索
// 结果原文中精确抽取，按固定模板回填。这是无模型联网时的默认行为；
// 设 KHY_LOCAL_SEARCH_STYLE=organized 可回退到旧的段落整理模式。

// 步骤型意图（怎么做 / 如何）
const _IR_STEP_RE = /(怎么|怎样|咋|如何|步骤|教程|流程|方法|怎么办|怎么弄|how\s+to|how\s+do|how\s+can|steps?\b|tutorial|guide)/i;
// 事实型意图（人 / 地 / 数 / 时）
const _IR_FACT_RE = /(多少|多大|多高|多重|多长|多远|多深|多宽|几岁|几个|几年|几月|几天|哪一?年|哪一?月|哪一?天|什么时候|何时|是谁|谁是|在哪|哪里|哪儿|哪个|什么是|是什么|叫什么|价格|多少钱|身高|体重|年龄|首都|面积|人口|海拔|距离|温度|who\s+is|what\s+is|when\s|where\s+is|how\s+(?:many|much|tall|old|long|far|high)|price|capital|population)/i;
// 数值型事实（应抽取「数字 + 单位」）
const _IR_NUMERIC_RE = /(多少|多大|多高|多重|多长|多远|多深|多宽|几岁|几个|几年|身高|体重|年龄|面积|人口|海拔|距离|温度|高度|长度|重量|价格|多少钱|哪一?年|哪一?月|哪一?天|什么时候|何时|年份|how\s+(?:many|much|tall|old|long|far|high)|when\s|price|population|height|weight|distance)/i;
// 操作动词：步骤型抽句的判定依据，命中即视为操作原句。
// 注意：刻意不收 "执行"，避免误命中 "执行官 / 执行力" 等名词。
const _IR_ACTION_RE = /(点击|单击|双击|长按|按住|按下|轻点|打开|关闭|选择|选中|勾选|进入|前往|访问|跳转|切换|输入|填写|粘贴|安装|下载|卸载|更新|启动|运行|开启|添加|新增|加入|倒入|放入|取出|混合|搅拌|删除|移除|清除|设置|配置|调整|保存|提交|确认|登录|注册|绑定|连接|断开|拖动|拖拽|滑动|找到|定位|复制|click|tap|press|hold|open|close|select|choose|check|enter|type|paste|install|download|update|launch|run|start|add|remove|delete|set|configure|save|submit|confirm|sign\s+in|log\s+in|connect|drag|swipe|copy)/i;
// 纯疑问词/填充词，从查询剥离后得到「核心词」。
// 注意：刻意不剥 "首都/价格/身高/面积" 等被询问的属性名词——它们应保留在核心词里
// （如「法国的首都」），剥掉会让模板核心词残缺。
const _IR_QWORD_RE = /(是多少钱|是多少|多少钱|多高|多大|多重|多长|多远|多深|多宽|多少|几岁|几个|几年|几月|几天|是谁|谁是|是什么|什么是|叫什么|在哪里|在哪儿|在哪|哪里|哪儿|哪一?年|哪一?月|哪一?天|什么时候|何时|有哪些|哪些|的是|呢|吗|啊|呀|请问|帮我|我想知道|想知道|告诉我|查一下|查询|搜索|搜一下)/g;

// 从查询里剥掉疑问词/修饰，得到「核心词」用于模板填充
function _irCoreTerm(query) {
  const t = String(query || '').trim()
    .replace(/[?？。.!！,，、；;:：]+/g, ' ')
    .replace(_IR_STEP_RE, ' ')
    .replace(_IR_QWORD_RE, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[的是为\s]+/, '').replace(/[的是为有\s]+$/, '')  // 去掉首尾残留的结构助词
    .trim();
  return t || String(query || '').trim();
}

// 关键词切分：在中/英/数字边界插空格，使纯中文实体与「iPhone15」式混排都能与原句子串匹配；
// 纯中文长词再追加 2-gram，缓解「无分词」时不同表述（"中国人口" vs "中国总人口"）的匹配缺口。
function _irKeywords(text) {
  const tokens = String(text || '')
    .replace(/[^一-龥a-zA-Z0-9\s]/g, ' ')
    .replace(/([一-龥])([a-zA-Z0-9])/g, '$1 $2')
    .replace(/([a-zA-Z0-9])([一-龥])/g, '$1 $2')
    .replace(/([a-zA-Z])([0-9])/g, '$1 $2')
    .replace(/([0-9])([a-zA-Z])/g, '$1 $2')
    .split(/\s+/)
    .map(w => w.toLowerCase())
    .filter(w => w.length >= 2);
  const out = [];
  for (const tok of tokens) {
    out.push(tok);
    if (/^[一-龥]{3,}$/.test(tok)) {
      for (let i = 0; i < tok.length - 1; i++) out.push(tok.slice(i, i + 2));
    }
  }
  return [...new Set(out)];
}

// 仅从「前 3 条」结果的 snippet 抽句（不混入 title），保留来源 URL。
// 用比 _splitSentences 更宽松的最小长度（>=3），以免丢掉「打开设置」这类很短的操作句。
function _irGatherSentences(results) {
  const out = [];
  for (const r of results.slice(0, 3)) {
    const snippet = _cleanSnippet(r.snippet || r.description || '');
    const parts = snippet
      .split(/(?<=[。！？!?；;])\s*|(?<=\.)\s+(?=[A-Z一-龥])|\n+/)
      .map(s => s.trim())
      .filter(s => s.length >= 3);
    for (const sent of parts) {
      out.push({ text: sent, url: String(r.url || '').trim() });
    }
  }
  return out;
}

// 事实型抽取：从原句里取最直接的「数字/名词/短语」，不概括。失败返回 null。
function _irExtractFact(query, sentences, core) {
  const kw = _irKeywords(core);
  let best = null, bestScore = 0;
  for (const s of sentences) {
    const score = _sentenceRelevance(s.text, kw);
    if (score > bestScore) { bestScore = score; best = s; }
  }
  if (!best || bestScore < 0.1) return null;
  const sentence = best.text.trim();

  // 数值型：优先抽「数字 + 单位」（如 5999元 / 8848.86米），避免误抓型号裸数字（iPhone 15）
  // 与日期年份（2023年）——除非问的就是时间。
  if (_IR_NUMERIC_RE.test(query)) {
    const UNIT = '(?:亿人|万人|厘米|毫米|公里|千米|千克|公斤|平方公里|平方千米|平方米|个月|周岁|小时|分钟|美元|人民币|欧元|日元|港元|米|克|吨|岁|年|天|秒|元|万|亿|个|人|位|名|％|%|℃|度|km|cm|mm|kg|m|g)';
    const numUnit = new RegExp('\\d[\\d,，.]*\\s*' + UNIT);
    const askTime = /(什么时候|何时|哪一?年|哪一?月|哪一?天|几年|年份)/.test(query);
    const isYear = (s) => /^(19|20)\d{2}\s*年$/.test(s.trim());
    // 时间类问题：优先抽完整日期（年月日 / 月日 / 年）
    if (askTime) {
      const date = sentence.match(/\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*[日号]|\d{4}\s*年\s*\d{1,2}\s*月|\d{1,2}\s*月\s*\d{1,2}\s*[日号]|\d{4}\s*年/);
      if (date) return date[0].trim();
    }
    // 1) 优先取「是/为/约为/达到」等谓词之后的数字+单位（最可能是被问的答案）
    const mk = sentence.search(/(约为|约|达到|达|共计|总计|合计|是|为|＝|=|:|：)/);
    if (mk >= 0) {
      const m = sentence.slice(mk).match(numUnit);
      if (m && (askTime || !isYear(m[0]))) return m[0].trim();
    }
    // 2) 全句所有「数字+单位」；非时间查询跳过年份
    const all = sentence.match(new RegExp(numUnit.source, 'g')) || [];
    for (const cand of all) {
      if (!askTime && isYear(cand)) continue;
      return cand.trim();
    }
    if (all.length) return all[0].trim();
    // 3) 裸数字兜底
    const bare = sentence.match(/\d[\d,，.]*\d|\d+/);
    if (bare) return bare[0].trim();
  }
  // 「…是 / 为 / : X」结构：取 X 到下一个标点（原文片段）
  const beIdx = sentence.search(/[是为＝=:：]/);
  if (beIdx >= 0) {
    const after = sentence.slice(beIdx + 1).replace(/^[\s是为＝=:：]+/, '').trim();
    const clause = after.split(/[，,。.；;！!？?、]/)[0].trim();
    if (clause.length >= 2 && clause.length <= 60) return clause;
  }
  // 兜底：原句不超长则整句返回（仍是原文，不改写）
  if (sentence.length <= 80) return sentence.replace(/[。.！!？?；;，,、\s]+$/, '');
  return null;
}

// 步骤型抽取：复制含操作动词的原句，最多 3 条（不改写、不合并）
function _irExtractSteps(sentences) {
  const steps = [];
  const seen = new Set();
  for (const s of sentences) {
    const t = s.text
      .replace(/^\s*\d+[.、)）]\s*/, '')   // 去掉原有序号前缀
      .replace(/[。.！!？?；;\s]+$/, '')      // 去掉句尾标点，避免模板里出现「。；」「。。」
      .trim();
    if (!t || !_IR_ACTION_RE.test(t)) continue;
    const key = t.slice(0, 12);
    if (seen.has(key)) continue;
    seen.add(key);
    steps.push(t);
    if (steps.length >= 3) break;
  }
  return steps;
}

// 严格模板回填：返回「仅模板内容」的纯文本（未知型附下方链接）。
// 三类意图：步骤型 → 操作列表；事实型 → 精确短语；未知型 → 固定致歉 + 链接。
function _strictSearchAnswer(query, results) {
  if (!Array.isArray(results) || results.length === 0) return null;
  const core = _irCoreTerm(query);
  const sentences = _irGatherSentences(results);
  const srcLine = _sourceFooter(results); // 多引擎来源明示（≥2 源才出现）
  const _withSrc = (meta) => (srcLine ? [...meta, srcLine] : meta);
  const _fmtSteps = (steps) => {
    if (_fmt && _fmt.isEnabled()) {
      return _fmt.compose({
        title: `${core} — 操作步骤`,
        sections: [{ heading: '步骤', lines: steps.map((s, i) => `- ${i + 1}. ${s}`) }],
        meta: _withSrc(['网络搜索']),
        footer: '以上步骤由 KHY 从搜索结果原文抽取，未做改写。',
      });
    }
    return `关于${core}，操作如下：${steps.map((s, i) => `${i + 1}. ${s}`).join('；')}。`;
  };
  const _fmtFact = (fact) => {
    if (_fmt && _fmt.isEnabled()) {
      return _fmt.compose({
        title: `${core}`,
        sections: [{ heading: '答案', body: fact }],
        meta: _withSrc(['网络搜索']),
        footer: '答案由 KHY 从搜索结果原文精确抽取，未做改写或推理。',
      });
    }
    return `关于${core}，答案是：${fact}。`;
  };
  const _unknown = () => {
    // 未提取到确切答案：不直接放弃——对搜索结果做「大致总结」+ 附可跳转来源链接。
    // （仅未知型放宽严格模板；事实型/步骤型仍是精确抽取。）
    const organized = _organizeSearchResults(query, results);
    if (organized) {
      return `（未匹配到确切答案，以下是相关结果的大致整理）\n\n${organized}`;
    }
    // 组织失败（句子被过滤殆尽）：退化为标题/摘要 + 链接列表
    const top = results.slice(0, 5);
    if (_fmt && _fmt.isEnabled()) {
      const secLines = [];
      const urls = [];
      for (let i = 0; i < top.length; i++) {
        const r = top[i];
        const title = _cleanSnippet(r.title || '') || '(无标题)';
        let snippet = _cleanSnippet(r.snippet || r.description || '');
        if (snippet.length > 120) snippet = snippet.slice(0, 120) + '…';
        const url = String(r.url || '').trim();
        secLines.push(`- ${i + 1}. ${title}`);
        if (snippet) secLines.push(`  ${snippet}`);
        if (url) urls.push(url);
      }
      if (!urls.length) return null; // 无可用链接 → 交由上层 web solver 给出诚实兜底，不道歉
      return _fmt.compose({
        title: `「${query}」相关结果`,
        sections: [{ heading: '相关条目', lines: secLines }],
        sources: urls,
        meta: _withSrc(['网络搜索']),
        footer: '未找到确切答案，以上为相关结果，可复制链接查看。',
      });
    }
    const lines = ['未找到确切答案，以下是相关结果，可复制链接查看：', ''];
    let hasLink = false;
    for (let i = 0; i < top.length; i++) {
      const r = top[i];
      const title = _cleanSnippet(r.title || '');
      let snippet = _cleanSnippet(r.snippet || r.description || '');
      if (snippet.length > 120) snippet = snippet.slice(0, 120) + '…';
      const url = String(r.url || '').trim();
      lines.push(`${i + 1}. ${title || '(无标题)'}`);
      if (snippet) lines.push(`   ${snippet}`);
      // URL 独占一行且不缩进，避免渲染层换行截断，终端可整段选中复制。
      if (url) { lines.push(url); hasLink = true; }
      if (i < top.length - 1) lines.push('');
    }
    if (hasLink) return lines.join('\n');
    return null; // 无可用链接 → 交由上层 web solver 给出诚实兜底，不道歉
  };

  // 步骤型：仅取操作原句
  if (_IR_STEP_RE.test(query)) {
    const steps = _irExtractSteps(sentences);
    return steps.length > 0 ? _fmtSteps(steps) : _unknown();
  }
  // 事实型：仅做精确抽取，绝不退化成步骤（避免名词句误判为操作）
  if (_IR_FACT_RE.test(query)) {
    const fact = _irExtractFact(query, sentences, core);
    return fact ? _fmtFact(fact) : _unknown();
  }
  // 既非明确步骤也非明确事实（开放/解释型问题）：归为未知型 → 大致总结 + 来源链接
  // 不强行抽取单句当「答案」，避免把开放问题误答成片面事实。
  return _unknown();
}

// 当前是否启用严格 IR 引擎（默认启用；organized 时回退旧段落模式）
function _localSearchStrict() {
  return String(process.env.KHY_LOCAL_SEARCH_STYLE || 'strict').toLowerCase() !== 'organized';
}

async function _rawWebSearch(query) {
  // 单一真源的「检索通道」：返回原始 results[]（{title,snippet,url}），供
  // _webSearchFallback 与本地推理引擎共用。
  //
  // 默认（KHY_UNIFIED_SEARCH≠'0'）走「统一检索」：在联网搜索之外并行检索本地项目
  // （grep 文件内容）与会话历史（FTS5），跨源去重后合流——本地优先、网络副本标注互证。
  // 任何异常 fail-soft 回落纯联网；关闭门控则与历史行为逐字一致。
  if (String(process.env.KHY_UNIFIED_SEARCH || '1') !== '0') {
    try {
      const unified = await _unifiedWebSearch(query);
      if (Array.isArray(unified) && unified.length > 0) return unified;
    } catch { /* fall through to plain web search */ }
  }
  try {
    const webSearch = require('./webSearchService');
    const sr = await webSearch.search(query);
    if (sr && sr.success && Array.isArray(sr.results) && sr.results.length > 0) {
      return sr.results;
    }
  } catch { /* webSearchService not available */ }
  return null;
}

/**
 * 统一检索：联网 + 本地项目文件（grep）+ 会话历史（FTS5）三源并行，跨源去重后
 * 映射回 _webSearchFallback 期望的 { title, snippet, url } 形状（本地命中 url 为空、
 * 带 source 标签）。纯编排在 services/search/unifiedSearch.js，本函数只负责注入真实
 * 检索器并把统一项映射回旧形状。任一环节失败由调用方 fail-soft 兜底。
 * @returns {Promise<Array|null>}
 */
async function _unifiedWebSearch(query) {
  const { unifiedSearch } = require('./search/unifiedSearch');

  const deps = {
    async webSearch(q) {
      const webSearch = require('./webSearchService');
      const sr = await webSearch.search(q);
      return (sr && sr.success && Array.isArray(sr.results)) ? sr.results : [];
    },
    async grepSearch(pattern) {
      const grep = require('../tools/grep');
      const cap = parseInt(String(process.env.KHY_UNIFIED_LOCAL_CAP || '10'), 10) || 10;
      return grep.execute({
        pattern,
        output_mode: 'content',
        case_insensitive: true,
        max_results: cap,
      });
    },
    historySearch(q) {
      try {
        const idx = require('./sessionSearchIndex');
        if (!idx.isAvailable || !idx.isAvailable()) return [];
        const cap = parseInt(String(process.env.KHY_UNIFIED_LOCAL_CAP || '10'), 10) || 10;
        return idx.searchMessages(q, { limit: cap });
      } catch { return []; }
    },
  };

  const merged = await unifiedSearch(query, deps);
  if (!merged || !Array.isArray(merged.items) || merged.items.length === 0) return null;

  // Map unified items back to the legacy { title, snippet, url } shape the
  // strict/organized answer builders consume. Local hits carry url='' (no link
  // line rendered) plus their source + corroboration for transparent provenance.
  return merged.items.map(it => ({
    title: it.title,
    snippet: it.snippet,
    url: it.url || '',
    source: it.source,
    alsoFoundIn: it.alsoFoundIn,
    corroboratingUrls: it.corroboratingUrls,
  }));
}

async function _webSearchFallback(query) {
  const results = await _rawWebSearch(query);

  if (!results || results.length === 0) return null;

  // 默认：严格规则式 IR 引擎（精确抽取 + 固定模板，不概括/不改写/不推理）
  if (_localSearchStrict()) {
    const strict = _strictSearchAnswer(query, results);
    if (strict) return strict;
  }

  // organized 模式：提取、去重、按相关度排序、组织成连贯段落
  const organized = _organizeSearchResults(query, results);
  if (organized) return organized;

  // 兜底：如果组织失败（句子全被过滤），返回简单列表
  const topResults = results.slice(0, 5);
  const lines = [`关于「${query}」的搜索结果：\n`];
  for (let i = 0; i < topResults.length; i++) {
    const r = topResults[i];
    const title = _cleanSnippet(r.title);
    const snippet = _cleanSnippet(r.snippet || r.description || '');
    lines.push(`${i + 1}. ${title || '(无标题)'}`);
    if (snippet) lines.push(`   ${snippet}`);
  }
  lines.push('\n(以上结果来自网络搜索。配置 AI 模型后可获得更深入的分析。)');
  return lines.join('\n');
}

// ── 问候与自我介绍 ──────────────────────────────────────────────────

const _KHY_INTRO = `你好！我是 KHY — 你的本地智能助手。

即使没有 AI 模型，我也能为你做很多事：

  计算    "123 * 456" / "2的10次方"
  提取    "提取身份证号码：张三110101199001011234"
  文件    "把 a.txt 移到 backup/" / "查看 config.json"
  搜索    "搜索 TODO 在 src/ 中"
  文本    "转大写：hello" / "base64 编码：test"
  时间    "现在几点" / "系统信息"
  天气    "北京天气" / "上海气温"
  汇率    "100美元换人民币"
  币价    "比特币价格" / "ETH"
  词典    "hello什么意思"
  名言    "来个名言" / "鸡汤"
  IP      "我的IP"
  冷知识  "冷知识" / "趣闻"
  节假日  "中国节假日"
  代码检查 "检查代码" / "lint src/"
  代码修复 "修复 file.js" / "auto-fix"
  笑话    "讲个编程笑话"
  提问    有网络时，任何问题都会自动搜索并返回结果

配置 AI 模型后，更复杂的任务（代码生成、分析、对话）将自动解锁。
运行 khy gateway config 开始配置。`;

const _SELF_INTRO_RE = /^(你是谁|你能做什么|你会什么|介绍.*自己|自我介绍|who are you|what can you do|what are you|help me)/i;

function _isGreetingOrIntro(text) {
  if (_SELF_INTRO_RE.test(text)) return true;
  try {
    const { isGreeting } = require('./textHeuristics');
    return isGreeting(text);
  } catch {
    return /^(你好|您好|嗨|哈喽|hello|hi|hey|yo)[\s?？!！。.]*$/i.test(text);
  }
}

// ── 模型状态元查询 ──────────────────────────────────────────────────
const _MODEL_META_RE = /^(模型|model|ai).{0,6}(可用|状态|在线|能用|有用|work|avail|status|ready|可以用)|^(你是什么|what model|which model|当前模型|用的什么模型|你是.{0,4}模型|你是.{0,4}ai|are you .{0,6}model)/i;

function _isModelMetaQuery(text) {
  return _MODEL_META_RE.test(text);
}

function _buildModelStatusResponse() {
  let adapterInfo = [];
  let selectedModel = null;
  try {
    const gw = require('./gateway/aiGateway');
    if (gw.getStatus) {
      const status = gw.getStatus();
      adapterInfo = (status.adapters || []).filter(a => a.available);
      selectedModel = status.selectedModel || status.currentModel || null;
    }
    if (!selectedModel && gw.getActiveAdapters) {
      const active = gw.getActiveAdapters();
      if (active.length > 0) selectedModel = active[0].model || active[0].key;
    }
  } catch { /* gateway not available */ }

  if (adapterInfo.length > 0 || selectedModel) {
    const lines = [`当前模型状态：可用`];
    if (selectedModel) lines.push(`  当前选择: ${selectedModel}`);
    if (adapterInfo.length > 0) {
      lines.push(`  可用通道: ${adapterInfo.map(a => a.key || a.name).join(', ')}`);
    }
    lines.push('', '模型可以正常处理你的请求。如需切换模型，运行 khy gateway model。');
    return lines.join('\n');
  }

  // 无模型可用 — 给出明确诊断
  let failedAdapters = [];
  try {
    const gw = require('./gateway/aiGateway');
    if (gw.getStatus) {
      const status = gw.getStatus();
      failedAdapters = (status.adapters || [])
        .filter(a => !a.available && a.lastError)
        .map(a => `  ${a.key || a.name}: ${String(a.lastError).slice(0, 80)}`);
    }
  } catch { /* ignore */ }

  const lines = [
    '当前模型状态：不可用',
    '',
    '所有 AI 模型通道当前均不可用，仅本地能力可用。',
  ];
  if (failedAdapters.length > 0) {
    lines.push('', '最近失败原因：');
    lines.push(...failedAdapters.slice(0, 5));
  }
  lines.push('', '建议：');
  lines.push('  1. 运行 khy gateway status 查看通道状态');
  lines.push('  2. 运行 khy gateway model 重新选择模型');
  lines.push('  3. 运行 khy gateway config 配置新的 API Key');
  return lines.join('\n');
}

// ── Tier 2 检测与执行 ────────────────────────────────────────────────

const _JOKE_RE = /(讲个|说个|来个|tell.*a?\s*)(笑话|段子|joke|humor|幽默|冷笑话|编程笑话)/i;

function isModelAvailable() {
  try {
    const gateway = require('./gateway/aiGateway');
    if (!gateway._initialized) return false;
    // Check gateway's internal adapter list for any enabled + available adapter
    const adapters = gateway._adapters;
    if (!Array.isArray(adapters)) return false;
    return adapters.some(a => a.enabled && a.available);
  } catch {
    return false;
  }
}

// Session-scoped: announce model unavailability once per session
let _modelFailureAnnouncedThisSession = false;
let _lastKnownModelAvailable = false;

/**
 * Check model status and emit a one-time failure announcement when
 * the model transitions from available to unavailable (or was never available).
 * Returns the announcement string if this is the first time, or null otherwise.
 */
function _checkModelFailureAnnouncement() {
  const avail = isModelAvailable();
  if (avail) {
    // Model is back — reset the announcement flag so next failure triggers again
    _modelFailureAnnouncedThisSession = false;
    _lastKnownModelAvailable = true;
    return null;
  }
  if (_modelFailureAnnouncedThisSession) return null;
  _modelFailureAnnouncedThisSession = true;

  // Build one-time failure announcement
  const lines = [];
  if (_lastKnownModelAvailable) {
    lines.push('⚠ AI 模型已断开 — 已切换到本地模式');
  } else {
    lines.push('ℹ 当前无可用 AI 模型 — 本地模式');
  }

  // Collect failure reasons
  let failedAdapters = [];
  try {
    const gw = require('./gateway/aiGateway');
    if (gw.getStatus) {
      const status = gw.getStatus();
      failedAdapters = (status.adapters || [])
        .filter(a => !a.available && a.lastError)
        .slice(0, 3);
    }
  } catch { /* ignore */ }

  if (failedAdapters.length > 0) {
    lines.push('  原因：');
    for (const a of failedAdapters) {
      lines.push(`    ${a.key || a.name}: ${String(a.lastError).slice(0, 60)}`);
    }
  }
  lines.push('  建议: khy gateway status 查看详情 | khy gateway model 重选模型');
  return lines.join('\n');
}

async function tryFallback(input, opts) {
  // Tier 2 仅在无模型时激活（forceLocal 跳过此检查，用于 /local 手动模式）
  if (!opts?.forceLocal && isModelAvailable()) return null;

  const text = _cleanInput(input);
  if (!text) return null;

  // 记录用户输入到上下文
  pushContext('user', text);

  // ── 跟进/指代解析：先尝试用上下文展开 ──
  let effectiveText = text;
  let resolveHint = '';
  const followUp = resolveFollowUp(text);
  if (followUp && followUp.resolved && followUp.resolved !== text) {
    effectiveText = followUp.resolved;
    resolveHint = followUp.context;
  }

  // 辅助：记录 assistant 回复并返回
  const _reply = (response, category) => {
    pushContext('assistant', response, { category });
    const result = { handled: true, response, category };
    if (resolveHint) result._resolveContext = resolveHint;
    return result;
  };

  // 模型状态元查询 — 优先于问候，给出明确的模型状态诊断
  if (_isModelMetaQuery(effectiveText)) {
    return _reply(_buildModelStatusResponse(), '模型状态');
  }

  // 问候 / 自我介绍
  if (_isGreetingOrIntro(effectiveText)) {
    // 在问候中附加模型状态，让用户知道当前工作模式
    const statusHint = '\n\n⚠ 当前无可用 AI 模型，上述为本地能力。运行 khy gateway model 选择模型后将自动切换到 AI 模式。';
    return _reply(_KHY_INTRO + statusHint, '问候');
  }

  // 笑话 — 从网络搜索
  if (_JOKE_RE.test(effectiveText)) {
    let category = null;
    if (/(编程|programming|code|程序)/i.test(effectiveText)) category = 'programming';
    else if (/(冷|cold)/i.test(effectiveText)) category = 'cold';
    else if (/(科技|tech|IT)/i.test(effectiveText)) category = 'tech';
    try {
      const joke = await _fetchJokeFromWeb(category);
      if (joke) return _reply(joke, '笑话');
    } catch { /* network failed */ }
    return _reply('网络不可用，无法搜索笑话。配置 AI 模型后可以直接问我讲笑话。', '笑话');
  }

  // ── 文档创建（/local 模式或无模型时自动处理）────────────────────────
  if (_isDocCreateIntent(effectiveText)) {
    const docPlan = _detectDocCreate(effectiveText);
    if (docPlan) {
      try {
        const docResult = await _executeDocCreate(docPlan);
        if (docResult && docResult.success) {
          return _reply(_formatDocCreate(docResult), '文档创建');
        }
        if (docResult && docResult.error) {
          return _reply(`文档创建失败: ${docResult.error}`, '文档创建');
        }
      } catch (err) {
        return _reply(`文档创建失败: ${err.message}`, '文档创建');
      }
    }
  }

  // ── 免费 API 查询（防御性兜底）──────────────────────────────────────
  // API 查询现已合并到 Tier 1（detectDeterministic），有模型也拦截。
  // 此处为防御性兜底：如果上游 quickTask 未命中（如 follow-up 解析才匹配），
  // 在 Tier 2 保底层仍可捕获。
  const apiPlan = _detectApiQuery(effectiveText);
  if (apiPlan) {
    try {
      const apiResult = await _executeApiQuery(apiPlan);
      if (apiResult && apiResult.success) {
        return _reply(_formatApiResult(apiResult), apiPlan.category || 'API');
      }
      if (apiResult && apiResult.error) {
        return _reply(_formatApiResult(apiResult), apiPlan.category || 'API');
      }
    } catch { /* network failed, fallthrough to web search */ }
  }

  // ── 任务模板（无网络也可用）────────────────────────────────────────
  // 用户明确想要"模板/格式/怎么写"或写作动词 + 已知主题时，直接给骨架。
  try {
    const tpl = require('./localTemplates').tryTemplate(effectiveText);
    if (tpl) return _reply(tpl, '任务模板');
  } catch { /* templates module unavailable */ }

  // ── 本地推理（无模型时的"简单思考"）─────────────────────────────────
  // 问题拆解+多查询综合 / 对比利弊 / 跨源事实核验 / 离线逻辑。
  // 有网络时注入 _rawWebSearch 作为检索通道；无网络时降级到离线逻辑。
  // 返回 null 表示无法稳妥推理 → 落到下方通用 web search 兜底。
  if (effectiveText.length >= 4) {
    try {
      const networkUp = require('./networkDetector').shouldAttemptNetwork();
      const reasoned = await require('./localReasoning').reason(effectiveText, {
        search: _rawWebSearch,
        networkUp,
      });
      if (reasoned) return _reply(reasoned, '本地推理');
    } catch { /* reasoning unavailable, fall through to web search */ }
  }

  // ── 通用 web search 兜底（尽力而为，非单次搜索即放弃）─────────────────
  // 无模型但有网络时：用多策略检索（原始查询→核心词→关键词蒸馏）+ 跨策略聚合
  // + 综合，尽力解决；确实无结果时给出诚实的「已尝试 + 如何继续」而非道歉。
  // 携带上下文 hint 改善搜索质量。
  // forceLocal(/local) 路径会先跑工具循环再由调用方收口 web solver，故此处跳过，
  // 避免抢在工具循环（文件读写等可执行任务）之前用搜索拦截。
  if (effectiveText.length >= 4 && !opts?.skipWebSolver) {
    try {
      const ctxHint = _getContextHint();
      // Append context only when it adds NEW signal — never duplicate text already
      // in the query (on the first turn the hint can equal the just-pushed input).
      const searchQuery = ctxHint && effectiveText.length < 30 && !effectiveText.includes(ctxHint) && !ctxHint.includes(effectiveText)
        ? `${effectiveText} ${ctxHint}`.trim()
        : effectiveText;
      const solved = await solveWithWeb(searchQuery);
      if (solved && solved.answer) {
        // 严格 IR 模式：只输出答案本身（不追加模式横幅）。
        const modelNote = _localSearchStrict()
          ? ''
          : '\n\n(当前无可用 AI 模型，以上为网络搜索结果。配置模型后将由 AI 直接回答。)';
        return _reply(solved.answer + modelNote, '网络搜索');
      }
    } catch { /* network unavailable → fall through */ }
  }

  return null;
}

/**
 * 多策略联网求解的单一真源（tryFallback 与 forceLocal 调用方共用）。
 * 用 localWebSolver 做「原始查询→核心词→关键词蒸馏」多策略检索 + 跨策略聚合 +
 * 经既有 IR/organize 引擎综合；无结果时返回诚实的尽力而为说明（永不裸道歉）。
 * @param {string} query
 * @returns {Promise<{answer:string, strategies:string[], queriesTried:number, resultCount:number}|null>}
 *   null 仅当离线 / 检索不可用 / solver 被禁用 — 由调用方继续降级。
 */
async function solveWithWeb(query) {
  const networkUp = (() => {
    try { return require('./networkDetector').shouldAttemptNetwork(); }
    catch { return true; }
  })();
  return require('./localWebSolver').solve(query, {
    networkUp,
    search: _rawWebSearch,
    // Synthesize from the COMBINED multi-strategy results via the existing
    // strict-IR / organize engine — single source, no duplicated rendering.
    synthesize: (q, results) => {
      if (_localSearchStrict()) {
        const strict = _strictSearchAnswer(q, results);
        if (strict) return strict;
      }
      return _organizeSearchResults(q, results);
    },
    coreTerm: _irCoreTerm,
    keywords: _irKeywords,
  });
}

function listCapabilities() {
  return [
    // ── 离线能力 (无网络无模型) ──
    '计算 — 数学表达式、中文算式（如"2的10次方"）',
    '提取 — 身份证、手机号、邮箱、日期、URL、IP',
    '文件操作 — 移动、复制、重命名文件',
    '文件查看 — 读取文件内容',
    '本地搜索 — 在目录中搜索关键词',
    '目录列举 — "看看当前目录有哪些文件" / "ls" / "列目录"（列出目录内容及大小）',
    '目录创建 — "新建文件夹 build" / "mkdir logs"（非破坏，直接创建）',
    '文件删除 — "删除 tmp.txt"（默认仅预览）/ "确认删除 tmp.txt"（破坏性，须确认才执行）',
    '供应商配置 — "配置 deepseek 密钥 sk-..." / "列出我的供应商" / "删除供应商 X"（默认仅预览，确认才删，默认保留密钥；密钥一律脱敏）',
    '文本处理 — 大小写转换、Base64、URL 编解码、MD5、JSON 格式化、字数统计',
    '时间日期 — 当前时间、系统信息',
    '本地数据 — "本地数据占用了多少" / "存储报告"（列出 khy 各类数据及大小）',
    '数据清理 — "清理"（预览可回收空间）/ "确认清理"（执行回收日志/快照/会话/缓存）',
    '单位换算 — "1英里等于多少公里" / "华氏100度转摄氏"',
    'HTTP 状态码 — "404" / "状态码 502" / "404 是什么"',
    '编程速查 — "git 常用命令" / "vim 速查" / "docker 命令"',
    '正则速查 — "邮箱正则" / "手机正则"',
    '常识知识 — "中国有多少个省" / "光速" / "常用端口"',
    '代码检查 — "检查代码" / "lint src/"（语法检查 + 模式匹配 + ESLint）',
    '代码修复 — "修复代码" / "auto-fix"（自动修复 + 备份 + 验证）',
    '文档创建 — "写一篇南阳旅游文档保存到桌面" / "创建会议纪要.docx"（自动收集内容+生成Word）',
    // ── 联网能力 (需要网络) ──
    '天气 — "北京天气" / "上海气温"（API 不可用时自动搜索）',
    '汇率 — "100美元换人民币" / "汇率"',
    '加密货币 — "比特币价格" / "ETH"',
    '词典 — "hello什么意思" / "define algorithm"',
    '名言 — "来个名言" / "鸡汤"',
    'IP — "我的IP" / "公网IP"',
    '冷知识 — "冷知识" / "fun fact"',
    '节假日 — "中国节假日" / "假期"',
    '笑话 — 从网络搜索笑话',
    '网络搜索 — 任何问题自动搜索（多引擎聚合：百度+Bing+搜狗+360+DuckDuckGo，非单一来源；英文结果自动翻译）',
    '本地推理 — 无模型也能"简单思考"：问题拆解+多查询综合、对比利弊、跨源事实核验（如"A 和 B 哪个好" / "X 的优缺点"）',
    '任务模板 — 周报/会议纪要/邮件/请假条/PRD/README/简历/commit/Bug报告/日计划（如"帮我写周报" / "请假条模板"）',
    '70+ CLI 命令 — help, version, gateway, learn, app, doctor...',
  ];
}

/**
 * Describe all API capabilities with Chinese descriptions and usage examples.
 * Used by /local mode to show users a comprehensive capability overview.
 */
function describeApis() {
  const apis = _getPublicApis();
  const categories = {};
  for (const api of apis.apis || []) {
    const cat = api.category || 'other';
    if (!categories[cat]) categories[cat] = [];
    categories[cat].push({
      name: api.name,
      desc_zh: api.desc_zh || api.description,
      usage: api.usage || [],
    });
  }

  const lines = [];
  lines.push('离线能力 (无网络也可用)：\n');
  lines.push('  计算      "123 * 456" / "2的10次方"');
  lines.push('  提取      "提取身份证号码：张三110101..."');
  lines.push('  文件      "把 a.txt 移到 backup/" / "查看 config.json"');
  lines.push('  搜索      "搜索 TODO 在 src/ 中"');
  lines.push('  列目录    "看看当前目录有哪些文件" / "ls" / "列目录"');
  lines.push('  新建目录  "新建文件夹 build" / "mkdir logs"');
  lines.push('  删除      "删除 tmp.txt"（预览）/ "确认删除 tmp.txt"（执行）');
  lines.push('  供应商    "配置 deepseek 密钥 sk-..." / "列出我的供应商" / "删除供应商 X"（预览，确认才删）');
  lines.push('  文本      "转大写：hello" / "base64 编码：test"');
  lines.push('  时间      "现在几点" / "系统信息"');
  lines.push('  单位换算  "1英里等于多少公里" / "100华氏度转摄氏"');
  lines.push('  HTTP码    "404状态码" / "502是什么"');
  lines.push('  编程速查  "git 常用命令" / "vim 速查" / "docker 命令"');
  lines.push('  正则速查  "邮箱正则" / "手机正则"');
  lines.push('  常识      "中国有多少个省" / "光速" / "常用端口"');
  lines.push('  代码检查  "检查代码" / "lint src/"');
  lines.push('  代码修复  "修复 file.js" / "auto-fix"');
  lines.push('  文档创建  "写一篇南阳旅游文档保存到桌面" / "创建报告.docx"');
  lines.push('');

  lines.push('联网能力 (需要网络，API 不可用时自动搜索)：\n');
  const _catNames = {
    weather: '天气', finance: '金融', humor: '娱乐', geo: '地理',
    dictionary: '词典', trivia: '冷知识', quotes: '名言', datetime: '时间',
    utility: '工具', dev: '开发', animals: '趣味', games: '游戏',
  };
  for (const [cat, apis2] of Object.entries(categories)) {
    const catName = _catNames[cat] || cat;
    for (const api of apis2) {
      const usage = api.usage.length > 0 ? `  示例: ${api.usage.slice(0, 3).join(' / ')}` : '';
      lines.push(`  ${catName.padEnd(6)} ${api.desc_zh}${usage ? '\n        ' + usage : ''}`);
    }
  }

  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════════
// Exports
// ═══════════════════════════════════════════════════════════════════

module.exports = {
  // Tier 1
  detectDeterministic,
  executeDeterministic,
  formatDeterministicResult,
  // Tier 2
  tryFallback,
  solveWithWeb,
  isModelAvailable,
  listCapabilities,
  describeApis,
  _checkModelFailureAnnouncement,
  // Session context memory
  pushContext,
  getContext,
  clearContext,
  resolveFollowUp,
  // Public API layer (exposed for direct use / testing)
  _detectApiQuery,
  _executeApiQuery,
  _formatApiResult,
  // 计算子能力已抽出至 localBrainCalc.js；保留同名导出以兼容既有调用方/测试。
  _safeEvalArithmetic: calcService.safeEvalArithmetic,
  _executeCalc: calcService.executeCalc,
  // 本地模式搜索整理（暴露用于测试）
  _organizeSearchResults,
  _strictSearchAnswer,
  // 多引擎来源明示 + 本地数据/清理（暴露用于测试）
  _collectSources,
  _sourceFooter,
  _executeStorage,
  _formatStorage,
  _detectCleanup,
  _executeCleanup,
  _formatCleanup,
  _isStorageIntent,
  _isCleanupIntent,
  // 加密货币 / 节假日探测（暴露用于测试；映射 Object.entries 已提升为模块常量）
  _detectCrypto,
  _detectHoliday,
};

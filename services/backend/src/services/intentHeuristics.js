'use strict';

/**
 * Intent detection heuristics — classify user messages and AI replies
 * by their intent pattern (app launch, info search, scaffold, etc.).
 *
 * Extracted from toolUseLoop.js (lines 3946-4055, 4179-4237,
 * 4651-4847) as part of the industrial-grade modularization (Phase 1E).
 *
 * Dependencies: none.
 */

// ── Text sanitization ────────────────────────────────────────────────

function sanitizeSearchSourceMessage(raw = '', options = {}) {
  const collapseWhitespace = options.collapseWhitespace !== false;
  let text = String(raw || '')
    .replace(/<pasted-content>\n([\s\S]*?)\n<\/pasted-content>\s*/g, '$1\n')
    // Strip system-injected sections that pollute downstream intent/query parsing.
    .replace(/\[System (?:Skill|Memory|Context)[^\]]*\][\s\S]*?(?=\[System |$)/gi, ' ');

  if (collapseWhitespace) {
    return text.replace(/\s+/g, ' ').trim();
  }

  return text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// ── Web search mode resolution ───────────────────────────────────────

function resolveAutoWebSearchMode(userMessage, requestedMode = 'auto') {
  const normalizedRequested = String(requestedMode || 'auto').trim().toLowerCase();
  const allowed = new Set(['auto', 'news', 'docs', 'academic', 'general']);
  const safeRequested = allowed.has(normalizedRequested) ? normalizedRequested : 'auto';
  if (safeRequested !== 'auto') return safeRequested;

  const raw = sanitizeSearchSourceMessage(String(userMessage || ''));
  if (!raw) return 'general';

  if (/(论文|paper|arxiv|doi|research|study|benchmark|dataset|citation|methodology|survey)/i.test(raw)) {
    return 'academic';
  }
  if (/(文档|docs?|documentation|api|sdk|readme|manual|reference|接口|参数|安装|install|quickstart|error\s*code)/i.test(raw)) {
    return 'docs';
  }
  if (/(新闻|热点|热搜|头条|快讯|今日|今天|最新|时事|发布|trending|headline|breaking|latest\s+news)/i.test(raw)) {
    return 'news';
  }
  return 'general';
}

// ── Search query candidate building ──────────────────────────────────

function buildSearchQueryCandidates(userMessage, maxCandidates = 3, mode = 'auto') {
  const source = sanitizeSearchSourceMessage(userMessage);
  if (!source) return [];

  const resolvedMode = resolveAutoWebSearchMode(source, mode);
  const limit = Math.min(Math.max(1, Math.floor(maxCandidates) || 3), 8);
  const candidates = [];
  const terms = [];
  const termSet = new Set();

  const pushCandidate = (value) => {
    const query = String(value || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!query || candidates.includes(query)) return;
    candidates.push(query);
  };

  const pushTerm = (value) => {
    const text = String(value || '').trim();
    if (!text) return;
    const low = text.toLowerCase();
    if (termSet.has(low)) return;
    termSet.add(low);
    terms.push(text);
  };

  // Keep the full user intent as the first candidate.
  pushCandidate(source);

  // Quoted phrases are usually explicit topic nouns.
  const quoted = source.match(/["'""''《》「」『』][^"'""''《》「」『』]{2,48}["'""''《》「」『』]/g) || [];
  for (const phrase of quoted) {
    const clean = phrase.replace(/^["'""''《》「」『』]|["'""''《》「」『』]$/g, '').trim();
    if (clean) pushTerm(clean);
  }

  // Pull topic-like tokens and filter generic verbs/function words.
  const stopwords = new Set([
    '帮我', '请', '麻烦', '一下', '搜索', '搜一下', '查一下', '查查', '查找', '查询',
    '今天', '今日', '最新', '新闻', '热点', '热搜', '资料', '信息', '网页', '联网', '内网',
    'search', 'find', 'lookup', 'look', 'up', 'latest', 'today', 'news', 'trending', 'please', 'help', 'me',
  ]);
  const tokens = source.match(/[\u4e00-\u9fa5]{2,24}|[A-Za-z][A-Za-z0-9+#_.-]{1,31}/g) || [];
  for (const token of tokens) {
    const t = String(token || '').trim();
    const low = t.toLowerCase();
    if (!t || stopwords.has(low)) continue;
    pushTerm(t);
  }

  // Inject mode-aware directional queries before broad combinations.
  const topicSeed = terms.slice(0, 3).join(' ').trim() || source.slice(0, 80);
  if (topicSeed) {
    if (resolvedMode === 'news') {
      pushCandidate(`${topicSeed} 最新动态`);
      pushCandidate(`${topicSeed} latest news today`);
    } else if (resolvedMode === 'docs') {
      pushCandidate(`${topicSeed} official documentation`);
      pushCandidate(`${topicSeed} API reference`);
    } else if (resolvedMode === 'academic') {
      pushCandidate(`${topicSeed} arxiv paper`);
      pushCandidate(`${topicSeed} benchmark dataset`);
    } else if (resolvedMode === 'general') {
      pushCandidate(`${topicSeed} overview`);
    }
  }

  // Build noun-combination candidates from top extracted terms.
  const topTerms = terms.slice(0, 6);
  for (let i = 0; i < topTerms.length; i++) {
    pushCandidate(topTerms[i]);
    if (candidates.length >= limit) break;
    for (let j = i + 1; j < topTerms.length; j++) {
      pushCandidate(`${topTerms[i]} ${topTerms[j]}`);
      if (candidates.length >= limit) break;
    }
    if (candidates.length >= limit) break;
  }

  return candidates.slice(0, limit);
}

// ── Intent classifiers ───────────────────────────────────────────────

function looksLikeDeliveryConclusion(text = '') {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  return /(完成|成功|已整理|已创建|已修改|无需|部分完成|最终结论|结果|总结|完成摘要|done|completed|summary|result|created|modified|finished|no.*needed|partial)/i.test(normalized);
}

/**
 * Heuristic: does this look like a "work preface" instead of a real answer?
 */
function looksLikeProgressOnlyReply(text) {
  if (!text) return false;
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return false;
  if (t.length > 3000) return false;
  if (/<tool_call>/i.test(t)) return false;
  if (/```/.test(t)) return false;
  const cn = /^(我来|我先|让我|正在|继续|先去|先看|先查|下面我来|我会先|好的|首先|接下来|现在|来看|来查|需要先|我需要|我打算|我准备|那我|嗯|可以|当然|没问题|马上|立即|开始)/;
  const en = /^(let me|i(?:'| a)m (?:going to|now)|continuing to|i(?:'| wi)ll|ok|sure|first|I need to|I want to|I should|next|alright|now|starting|beginning)/i;
  const hasTaskVerb = /(检查|排查|查看|看看|分析|探索|处理|修复|定位|梳理|总结|整理|清理|创建|搜索|读取|打开|执行|运行|列出|扫描|浏览|编辑|修改|写入|安装|配置|部署|测试|验证|调试|review|inspect|check|analy[sz]e|investigate|clean|organize|search|read|open|run|list|scan|browse|look|edit|modify|write|install|configure|deploy|test|verify|debug|fix|implement|add|update|create)/i.test(t);
  const hasNumberedPlan = /\n\s*\d+[\.\)]\s+/.test(t) && hasTaskVerb;
  return ((cn.test(t) || en.test(t)) && hasTaskVerb) || hasNumberedPlan;
}

/**
 * Heuristic: does the AI present a choice list instead of acting?
 */
function looksLikeChoiceResponse(text) {
  if (!text || text.length > 800) return false;
  if (!/\n\s*\d+[\.\)]\s+/.test(text) && !/(?:^|\n)\s*[-•]\s+/.test(text)) return false;
  if (!/(你可以选择|请选择|以下.*选项|以下.*方案|你想要哪|你更倾向|Which.*option|Which.*prefer|choose|pick one|here are.*option)/i.test(text)) return false;
  if (/<tool_call>/i.test(text)) return false;
  return true;
}

/**
 * Heuristic: does the user request likely require concrete actions/tools?
 */
function looksLikeActionRequest(text) {
  if (!text) return false;
  return /(继续|检查|排查|修复|实现|修改|review|审查|自我检查|排错|定位|运行|执行|测试|验证|debug|调试|看下|看看|整理|清理|帮我|创建|搜索|查找|打开|安装|部署|编译|构建|启动|删除|移动|复制|下载|上传|写|加|改|做|配置|更新|升级|重构|优化|分析|读|organize|clean|help|create|find|open|install|build|start|fix|implement|add|update|write|modify|change|remove|delete|move|copy|deploy|test|run|search|read|edit|configure|refactor|optimize|analyze|set up|make)/i.test(text);
}

function looksLikeAppLaunchRequest(text) {
  if (!text) return false;
  const raw = String(text || '').trim();
  if (!raw) return false;

  const lines = raw.split('\n').map(s => String(s || '').trim()).filter(Boolean);
  let focus = lines.length > 1 ? lines[lines.length - 1] : raw;
  focus = focus.replace(/^>\s*/, '').trim();
  if (!focus) return false;

  const issueMarkers = /(之后|下一句|下句话|上一句|本轮|上轮|变成|重复|误判|为什么|怎么|问题|故障|异常|报错|日志|记录|复现|bug)/i;
  const directCn = /^(?:请|帮我|麻烦|可以|能否|请你|帮忙)?\s*(?:打开|启动|运行)\s*[^\n]{1,48}$/i;
  const directEn = /^(?:please\s+)?(?:open|launch|start|run)\b[\s\S]{1,48}$/i;
  const target = extractAppTargetFromUserMessage(focus);
  const shortTarget = target && target.length <= 24;

  if (shortTarget && (directCn.test(focus) || directEn.test(focus))) {
    return !issueMarkers.test(focus);
  }
  if (issueMarkers.test(focus)) return false;

  return /(打开|启动|运行).*(应用|程序|软件|工具|客户端|浏览器|编辑器|查看器|飞书|微信|qq|钉钉|lark|feishu|pdf|图片|图像)/i.test(focus)
    || /\b(open|launch|start|run)\b[\s\S]{0,40}\b(app|application|program|tool|editor|viewer|browser|lark|feishu|pdf|image|photo)\b/i.test(focus);
}

function looksLikeProjectScaffoldRequest(text) {
  if (!text) return false;
  const raw = String(text || '').trim();
  if (!raw) return false;
  return /(创建|生成|搭建|初始化|新建).*(项目|工程|目录|文件|结构|脚手架)/i.test(raw)
    || /(批量|并行).*(创建|写入).*(文件|目录)/i.test(raw)
    || /\b(create|generate|scaffold|bootstrap|initialize)\b[\s\S]{0,48}\b(project|workspace|folder|directory|file|structure)\b/i.test(raw)
    || /\b(batch|parallel)\b[\s\S]{0,48}\b(write|create)\b[\s\S]{0,32}\b(files?|folders?)\b/i.test(raw);
}

function looksLikeInfoSearchRequest(text) {
  if (!text) return false;
  const raw = sanitizeSearchSourceMessage(String(text || ''));
  if (!raw) return false;
  const constraints = extractUserToolConstraints(raw);
  if (constraints.disallowAllTools || constraints.disallowSearch) return false;
  return /(搜索|搜一下|查一下|查查|新闻|热点|热搜|今日|今天|最新|时事|头条|文档|接口|参数|说明|官网|readme|manual|documentation|api|reference|web\s*search|search|news|headline|trending)/i.test(raw);
}

function looksLikeShellAppProbeCommand(command = '') {
  const cmd = String(command || '').trim().toLowerCase();
  if (!cmd) return false;
  return /\b(which|whereis|command\s+-v|type\s+-p|ps\s+aux|pgrep|pidof|nohup|xdg-open|gtk-launch|gio\s+launch)\b/.test(cmd)
    || /\bgrep\s+-i\b/.test(cmd);
}

// ── Tool name classifiers ────────────────────────────────────────────

function isShellToolName(name = '') {
  const n = String(name || '').trim().toLowerCase();
  return n === 'shell_command' || n === 'shellcommand' || n === 'bash';
}

function isWebLookupToolName(toolName = '') {
  const normalized = String(toolName || '').toLowerCase().replace(/[\s_-]/g, '');
  return normalized === 'websearch'
    || normalized === 'webfetch'
    || normalized === 'websearchmcp'
    || normalized === 'search';
}

// ── User tool constraints ────────────────────────────────────────────

function extractUserToolConstraints(text = '') {
  const raw = sanitizeSearchSourceMessage(String(text || ''));
  const empty = {
    disallowAllTools: false,
    disallowSearch: false,
    disallowFileRead: false,
    hasExplicitConstraint: false,
    summary: '',
  };
  if (!raw) return empty;

  const disallowAllTools = /(?:不要|别|禁止|无需|不用|不必)(?:再)?(?:调用|使用|动用|借助)?(?:任何|所有)?工具|(?:do\s+not|don't|never|without|no)\s+(?:call|use|invoke)\s+(?:any\s+)?tools?/i.test(raw);
  const disallowSearch = /(?:不要|别|禁止|无需|不用|不必)(?:再)?(?:搜索|搜一下|联网|查一下|查找|查询|上网)|(?:do\s+not|don't|never|without|no)\s+(?:search|browse|look\s+up|web\s*search)/i.test(raw);
  const disallowFileRead = /(?:不要|别|禁止|无需|不用|不必)(?:再)?(?:读取|查看|打开|浏览|扫描).{0,6}(?:文件|代码|目录)|(?:do\s+not|don't|never|without|no)\s+(?:read|open|browse|scan)\s+(?:any\s+)?(?:files?|code|directories?)/i.test(raw);

  const parts = [];
  if (disallowAllTools) parts.push('no tools');
  if (disallowSearch) parts.push('no search');
  if (disallowFileRead) parts.push('no file reads');

  return {
    disallowAllTools,
    disallowSearch,
    disallowFileRead,
    hasExplicitConstraint: parts.length > 0,
    summary: parts.join(', '),
  };
}

function buildUserToolConstraintDirective(constraints = {}) {
  if (!constraints || !constraints.hasExplicitConstraint) return '';

  const rules = [
    '## USER TOOL CONSTRAINTS — must be obeyed for this request.',
  ];

  if (constraints.disallowAllTools) {
    rules.push('Do not call any tools. Do not emit tool_use or tool_call blocks.');
  } else {
    if (constraints.disallowSearch) {
      rules.push('Do not use web_search, search, webFetch, browsing, or any search-like tool.');
    }
    if (constraints.disallowFileRead) {
      rules.push('Do not read, scan, grep, glob, or browse files/directories.');
    }
  }

  rules.push('If these constraints reduce certainty, answer directly from current context and state the exact limitation.');
  return rules.join('\n');
}

// ── App target extraction (lightweight, needed by looksLikeAppLaunchRequest) ──

function extractAppTargetFromUserMessage(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return '';
  // "打开 X" / "open X" / "start X" / "launch X" / "run X"
  // Chinese verbs are typically written with no space before the target
  // ("打开飞书"), so the separator is optional here; English needs one.
  const cn = raw.match(/(?:打开|启动|运行)\s*([^\s,，。！!?？]{1,24})/);
  if (cn && cn[1]) return cn[1].trim();
  const en = raw.match(/\b(?:open|launch|start|run)\s+([^\s,!?.]{1,24})/i);
  if (en && en[1]) return en[1].trim();
  return '';
}

// ── Search / shell patching ──────────────────────────────────────────

function patchEmptySearchQuery(toolCalls, userMessage) {
  if (!Array.isArray(toolCalls) || !userMessage) return;
  const searchNames = new Set(['web_search', 'webSearch', 'websearch', 'search_web']);
  const configuredMode = process.env.KHY_AUTO_WEBSEARCH_MODE || 'auto';
  const fallbackQuery = buildSearchQueryCandidates(userMessage, 1, configuredMode)[0] || '';
  for (const call of toolCalls) {
    if (!call || !searchNames.has(call.name)) continue;
    const q = String(call.params?.query || call.params?.q || '').trim();
    if (q) continue;
    if (fallbackQuery) {
      if (!call.params) call.params = {};
      call.params.query = fallbackQuery;
    }
  }
}

function patchEmptyShellCommand(toolCalls, userMessage) {
  if (!Array.isArray(toolCalls) || !userMessage) return;
  const shellNames = new Set(['shell_command', 'shellCommand', 'bash']);
  const isWin = process.platform === 'win32';
  for (const call of toolCalls) {
    if (!call || !shellNames.has(call.name)) continue;
    const cmd = String(call.params?.command || call.params?.cmd || '').trim();
    if (cmd) continue;
    const msg = userMessage.toLowerCase();
    let inferred = '';
    if (/桌面|desktop/i.test(msg)) {
      inferred = isWin ? 'dir "%USERPROFILE%\\Desktop"' : 'ls ~/Desktop/';
    } else if (/文件|file|目录|directory|folder/i.test(msg)) {
      inferred = isWin ? 'dir' : 'ls -la';
    } else if (/进程|process|运行.*什么/i.test(msg)) {
      inferred = isWin ? 'tasklist' : 'ps aux';
    } else if (/磁盘|disk|空间|space/i.test(msg)) {
      inferred = isWin ? 'powershell -NoProfile -Command "Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,Size,FreeSpace"' : 'df -h';
    } else if (/网络|network|ip|联网|ping/i.test(msg)) {
      inferred = isWin ? 'ipconfig' : 'ifconfig 2>/dev/null || ip addr';
    } else if (/内存|memory|ram/i.test(msg)) {
      inferred = isWin ? 'powershell -NoProfile -Command "Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize,FreePhysicalMemory"' : 'free -h';
    } else if (/cpu|处理器|processor/i.test(msg)) {
      inferred = isWin ? 'powershell -NoProfile -Command "Get-CimInstance Win32_Processor | Select-Object Name,NumberOfCores"' : 'lscpu 2>/dev/null || sysctl -n machdep.cpu.brand_string';
    } else if (/系统|system|版本|version|信息/i.test(msg)) {
      inferred = isWin ? 'systeminfo' : 'uname -a';
    } else if (/环境变量|env|environment/i.test(msg)) {
      inferred = isWin ? 'set' : 'env';
    } else if (/端口|port|listen/i.test(msg)) {
      inferred = isWin ? 'netstat -an | findstr LISTEN' : 'ss -tlnp 2>/dev/null || netstat -tlnp';
    } else if (/用户|user|whoami/i.test(msg)) {
      inferred = 'whoami';
    } else if (/时间|time|日期|date/i.test(msg)) {
      inferred = isWin ? 'echo %date% %time%' : 'date';
    } else if (/路径|path|当前目录|cwd|pwd/i.test(msg)) {
      inferred = isWin ? 'cd' : 'pwd';
    } else if (/安装.*包|install|pip|npm|apt/i.test(msg)) {
      inferred = '';
    }
    if (inferred) {
      if (!call.params) call.params = {};
      call.params.command = inferred;
    }
  }
}

function patchEmptyLocalSearchKeyword(toolCalls, userMessage) {
  if (!Array.isArray(toolCalls) || !userMessage) return;
  const searchNames = new Set(['search']);
  const fallbackRaw = sanitizeSearchSourceMessage(String(userMessage || ''));
  const fallback = String(fallbackRaw || '').trim().slice(0, 120);
  if (!fallback) return;
  for (const call of toolCalls) {
    if (!call || !searchNames.has(String(call.name || ''))) continue;
    const keyword = String(call.params?.keyword || call.params?.query || '').trim();
    if (keyword) continue;
    if (!call.params) call.params = {};
    call.params.keyword = fallback;
  }
}

module.exports = {
  // Text sanitization
  sanitizeSearchSourceMessage,
  resolveAutoWebSearchMode,
  buildSearchQueryCandidates,
  // Intent classifiers
  looksLikeDeliveryConclusion,
  looksLikeProgressOnlyReply,
  looksLikeChoiceResponse,
  looksLikeActionRequest,
  looksLikeAppLaunchRequest,
  looksLikeProjectScaffoldRequest,
  looksLikeInfoSearchRequest,
  looksLikeShellAppProbeCommand,
  // Tool name classifiers
  isShellToolName,
  isWebLookupToolName,
  // User tool constraints
  extractUserToolConstraints,
  buildUserToolConstraintDirective,
  // App target
  extractAppTargetFromUserMessage,
  // Empty param patching
  patchEmptySearchQuery,
  patchEmptyShellCommand,
  patchEmptyLocalSearchKeyword,
};

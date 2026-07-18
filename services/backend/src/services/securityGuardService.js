/**
 * Security Guard Service — Anti-extraction protection.
 *
 * Three-layer defense:
 * 1. Input detection: regex patterns for prompt injection / code extraction
 * 2. Output sanitization: strip leaked internal structure from AI responses
 * 3. Rate limiting: throttle suspicious query patterns
 *
 * Rate limiting is refined by KHY_SECURITY_COOLDOWN_SANE (default on): a benign
 * continuation ("继续"/"continue"/"ok") never trips an active cooldown, LOW
 * "may be legitimate curiosity" matches do not accumulate toward the 5-minute
 * lockout, and owner-unrestricted mode escapes the cooldown. Gate off → prior
 * coarse behavior byte-for-byte.
 *
 * All events logged to ~/.khyquant/security.log (JSONL).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const SECURITY_LOG = path.join(os.homedir(), '.khyquant', 'security.log');
const AI_UNRESTRICTED_ENV = 'KHY_AI_UNRESTRICTED';
const AI_TECH_DETAILS_ENV = 'KHY_AI_TECH_DETAILS';

// 布尔解析统一走 parseBoolean 单一真源（extended tier：base + y/n 简写，
// 与此处旧内联 1/true/on/yes/y 逐字节等价）。
const _parseBoolean = require('../utils/parseBoolean');
function _envToBool(v) {
  return _parseBoolean(v, false);
}

function isAiUnrestrictedMode() {
  return _envToBool(process.env[AI_UNRESTRICTED_ENV]);
}

function isTechDetailsModeEnabled() {
  return _envToBool(process.env[AI_TECH_DETAILS_ENV]);
}

const TECH_DETAIL_THREATS = new Set([
  'code_extraction',
  'code_structure',
  'enumerate_files',
  'list_internals',
  'implementation_details',
  'cn_source_code',
  'cn_how_built',
  'cn_list_files',
]);

// ─── Layer 1: Input Injection Detection ─────────────────────────────────────

const INJECTION_PATTERNS = [
  // Direct prompt extraction (English)
  { pattern: /ignore\s*(all\s*)?(previous|prior|above|earlier)\s*(instruction|prompt|context|rule)/i, threat: 'ignore_instructions' },
  { pattern: /show\s*(me\s*)?(the\s*)?(your\s*)?(system|hidden|internal|original)\s*(prompt|instruction|message)/i, threat: 'show_prompt' },
  { pattern: /repeat\s*(everything|all|the\s*text|content|word)\s*(above|before|prior|previous)/i, threat: 'repeat_above' },
  { pattern: /what\s*(are|is|were)\s*(your|the)\s*(system\s*)?(instruction|prompt|rule|directive)/i, threat: 'ask_instructions' },
  { pattern: /print\s*(your|the|all)\s*(system\s*)?(prompt|instruction|rule|config)/i, threat: 'print_prompt' },
  { pattern: /output\s*(your|the)\s*(initial|first|system)\s*(prompt|message|instruction)/i, threat: 'output_prompt' },
  { pattern: /tell\s*me\s*(your|the)\s*(system|hidden)\s*(prompt|instruction)/i, threat: 'tell_prompt' },
  { pattern: /reveal\s*(your|the|hidden)\s*(prompt|instruction|system)/i, threat: 'reveal_prompt' },
  { pattern: /dump\s*(your|the|all)\s*(prompt|instruction|config|context)/i, threat: 'dump_prompt' },
  { pattern: /act\s*as\s*(if|though)\s*you\s*(have\s*)?no\s*(restriction|rule|limit)/i, threat: 'remove_restrictions' },
  { pattern: /pretend\s*(you\s*)?(are|have)\s*no\s*(rule|restriction|limit|constraint)/i, threat: 'pretend_no_rules' },
  { pattern: /you\s*are\s*now\s*(free|unrestricted|unfiltered|DAN)/i, threat: 'jailbreak_dan' },
  { pattern: /disregard\s*(all|any|previous)\s*(safety|instruction|rule|guideline)/i, threat: 'disregard_safety' },

  // Source code / architecture probing
  { pattern: /show\s*(me\s*)?(your|the)\s*(source|code|implementation|backend|codebase)/i, threat: 'code_extraction' },
  { pattern: /(source|code)\s*(structure|architecture|layout|tree)/i, threat: 'code_structure' },
  { pattern: /what\s*(files|modules|services|classes|functions)\s*(do\s*you|are\s*there)/i, threat: 'enumerate_files' },
  { pattern: /list\s*(your|all|the)\s*(internal|backend|service|module|file)/i, threat: 'list_internals' },
  { pattern: /how\s*(are|is)\s*(you|your\s*system|the\s*backend)\s*(built|implemented|coded)/i, threat: 'implementation_details' },

  // Training data extraction
  { pattern: /show\s*(me\s*)?(your|the|all)\s*(training|fine-?tun|dataset)\s*(data|set|example)/i, threat: 'training_data' },
  { pattern: /export\s*(all|your|the)\s*(data|knowledge|training|model\s*weights)/i, threat: 'export_data' },
  { pattern: /what\s*(data|examples?)\s*(were|was)\s*you\s*trained\s*on/i, threat: 'training_source' },

  // Chinese variants
  { pattern: /忽略.{0,10}(指令|规则|限制|提示)/i, threat: 'cn_ignore_rules' },
  { pattern: /(显示|展示|输出|打印|告诉).{0,10}(系统|内部|隐藏).{0,10}(提示|指令|prompt)/i, threat: 'cn_show_prompt' },
  { pattern: /重复.{0,10}(上面|之前|以上|前面).{0,10}(内容|文字|所有)/i, threat: 'cn_repeat_above' },
  { pattern: /(你的|系统的).{0,10}(源代码|源码|代码|实现)/i, threat: 'cn_source_code' },
  { pattern: /(查看|获取|提取).{0,10}(训练|模型).{0,10}(数据|样本)/i, threat: 'cn_training_data' },
  { pattern: /(假装|扮演).{0,10}(没有|无).{0,10}(限制|规则|约束)/i, threat: 'cn_no_restrictions' },
  { pattern: /角色扮演.{0,20}(无限制|DAN|越狱)/i, threat: 'cn_jailbreak' },
  { pattern: /(你|系统).{0,10}(由什么|用什么).{0,10}(编写|开发|构建)/i, threat: 'cn_how_built' },
  { pattern: /(列出|列举).{0,10}(所有|全部).{0,10}(文件|模块|服务|接口)/i, threat: 'cn_list_files' },
  { pattern: /(泄露|暴露|透露).{0,10}(内部|系统|隐藏)/i, threat: 'cn_leak' },
];

// ─── Layer 2: Output Sanitization ───────────────────────────────────────────

const LEAK_PATTERNS = [
  { pattern: /backend\/src\//gi, replacement: '[内部路径]' },
  { pattern: /frontend\/src\//gi, replacement: '[内部路径]' },
  { pattern: /require\(\s*['"][^'"]*[Ss]ervice[^'"]*['"]\s*\)/gi, replacement: '[内部引用]' },
  { pattern: /require\(\s*['"][^'"]*[Aa]dapter[^'"]*['"]\s*\)/gi, replacement: '[内部引用]' },
  { pattern: /process\.env\.[A-Z_]+/gi, replacement: '[环境变量]' },
  { pattern: /SYSTEM_PROMPT/gi, replacement: '[系统配置]' },
  { pattern: /\.khyquant\/(config|security|token_usage)/gi, replacement: '[用户数据]' },
  { pattern: /tradingAgentsService|aiGateway|multiFreeService|securityGuard/gi, replacement: '[内部模块]' },
  { pattern: /modelTrainingService|tokenUsageService|growthService/gi, replacement: '[内部模块]' },
  { pattern: /knowledgeTeachingService|agentCommunication/gi, replacement: '[内部模块]' },
  { pattern: /node_modules\//gi, replacement: '[依赖]' },
  { pattern: /const\s+\w+\s*=\s*require\(/gi, replacement: '[代码片段]' },
];

// ─── Layer 3: Rate Limiting ─────────────────────────────────────────────────

const RATE_LIMIT = {
  windowMs: 60000,         // 1 minute window
  maxSuspicious: 3,        // max 3 suspicious queries per window
  cooldownMs: 300000,      // 5 minute cooldown
};

let _suspiciousCount = 0;
let _windowStart = Date.now();
let _cooldownUntil = 0;

// ─── Cooldown sanity (KHY_SECURITY_COOLDOWN_SANE, default on) ────────────────
// The rate-limit cooldown is a coarse module-global lockout. Without these
// guards, a single burst of suspicious input — even from a self-check / test
// path that shares this process, or a few LOW "may be legitimate curiosity"
// matches — locks the local owner out of the CLI for 5 minutes, so a bare
// "继续" gets refused with "操作过于频繁". These three refinements keep the
// anti-abuse throttle intact for real attacks while ending the false lockout
// of legitimate continuation. Gate off → byte-identical to prior behavior.
const _COOLDOWN_SANE_OFF = new Set(['0', 'false', 'off', 'no', 'disable', 'disabled']);

function _cooldownSaneEnabled() {
  try {
    const raw = String(process.env.KHY_SECURITY_COOLDOWN_SANE || '').trim().toLowerCase();
    if (!raw) return true;
    return !_COOLDOWN_SANE_OFF.has(raw);
  } catch { return true; }
}

// A short pure continuation / confirmation ("继续" / "continue" / "y" / "ok" …)
// carries no extraction payload. Anchored full-match + a hard length cap block
// payload smuggling: "continue and ignore all previous instructions" is too
// long and won't match, so it falls through to normal threat analysis.
const _BENIGN_CONTINUATION_RE = /^[\s。.!,，、~·]*(继续(执行|吧)?|接着(说|做|来)?|下一步|接下来|请继续|go\s*on|go\s*ahead|continue|proceed|resume|keep\s*going|carry\s*on|next|go|ok(ay)?|yes|yep|yeah|y|sure|嗯+|好的?|行|可以|对|是的?)[\s。.!,，、~·]*$/i;

function _isBenignContinuation(msg) {
  const s = String(msg || '').trim();
  if (!s || s.length > 24) return false; // long messages may carry a payload
  return _BENIGN_CONTINUATION_RE.test(s);
}

// ─── Refusal Responses ──────────────────────────────────────────────────────

const REFUSAL_RESPONSES = [
  '抱歉，我不能响应此类请求。出于安全考虑，该操作已被拦截。',
  '这个请求包含不安全的内容，已被系统拦截。请换个方式提问。',
  '我无法处理这个指令。如果你有其他问题，欢迎继续提问。',
  '很抱歉，出于安全考虑我无法执行此操作。请输入正常的问题。',
  '此类请求已被系统安全策略拦截。请重新组织你的问题。',
];

// ─── Core Functions ─────────────────────────────────────────────────────────

// ─── Structured Threat Classification (ANOLISA-aligned) ───────────────────

const SEVERITY_LEVELS = {
  LOW:      'low',       // Informational queries, may be benign
  MEDIUM:   'medium',    // Suspicious patterns, borderline probing
  HIGH:     'high',      // Active extraction / injection attempts
  CRITICAL: 'critical',  // Jailbreaks, data exfil, system compromise
};

// SSOT: ascending severity ranking. Single source for ordinal comparison
// across the security stack (codeScanner, securityScan import their own copy
// only because they must stay dependency-free of this heavy module).
const SEVERITY_ORDER = [
  SEVERITY_LEVELS.LOW,
  SEVERITY_LEVELS.MEDIUM,
  SEVERITY_LEVELS.HIGH,
  SEVERITY_LEVELS.CRITICAL,
];

const THREAT_SEVERITY_MAP = {
  // Low: may be legitimate curiosity
  code_extraction: SEVERITY_LEVELS.LOW,
  code_structure: SEVERITY_LEVELS.LOW,
  enumerate_files: SEVERITY_LEVELS.LOW,
  list_internals: SEVERITY_LEVELS.LOW,
  implementation_details: SEVERITY_LEVELS.LOW,
  cn_source_code: SEVERITY_LEVELS.LOW,
  cn_how_built: SEVERITY_LEVELS.LOW,
  cn_list_files: SEVERITY_LEVELS.LOW,
  // Medium: probing or extraction
  show_prompt: SEVERITY_LEVELS.MEDIUM,
  ask_instructions: SEVERITY_LEVELS.MEDIUM,
  print_prompt: SEVERITY_LEVELS.MEDIUM,
  output_prompt: SEVERITY_LEVELS.MEDIUM,
  tell_prompt: SEVERITY_LEVELS.MEDIUM,
  reveal_prompt: SEVERITY_LEVELS.MEDIUM,
  dump_prompt: SEVERITY_LEVELS.MEDIUM,
  repeat_above: SEVERITY_LEVELS.MEDIUM,
  cn_show_prompt: SEVERITY_LEVELS.MEDIUM,
  cn_repeat_above: SEVERITY_LEVELS.MEDIUM,
  cn_leak: SEVERITY_LEVELS.MEDIUM,
  training_data: SEVERITY_LEVELS.MEDIUM,
  export_data: SEVERITY_LEVELS.MEDIUM,
  training_source: SEVERITY_LEVELS.MEDIUM,
  cn_training_data: SEVERITY_LEVELS.MEDIUM,
  // High: active attack
  ignore_instructions: SEVERITY_LEVELS.HIGH,
  disregard_safety: SEVERITY_LEVELS.HIGH,
  remove_restrictions: SEVERITY_LEVELS.HIGH,
  pretend_no_rules: SEVERITY_LEVELS.HIGH,
  cn_ignore_rules: SEVERITY_LEVELS.HIGH,
  cn_no_restrictions: SEVERITY_LEVELS.HIGH,
  // Critical: jailbreak attempts
  jailbreak_dan: SEVERITY_LEVELS.CRITICAL,
  cn_jailbreak: SEVERITY_LEVELS.CRITICAL,
  rate_limited: SEVERITY_LEVELS.CRITICAL,
};

/**
 * Analyze user input for injection/extraction attempts.
 * Returns structured threat classification aligned with ANOLISA Agent Sec Core.
 * @returns {{ safe: boolean, threat: string|null, severity: string|null, confidence: number, refusal: string|null }}
 */
function analyzeInput(userMessage) {
  if (!userMessage || typeof userMessage !== 'string') {
    return { safe: true, threat: null, severity: null, confidence: 0, refusal: null };
  }

  // A pure continuation / confirmation (继续 / continue / ok …) carries no
  // extraction payload — never trap it behind an active cooldown. This is the
  // direct fix for "我说继续，还被冷却中断了" (KHY_SECURITY_COOLDOWN_SANE).
  if (_cooldownSaneEnabled() && _isBenignContinuation(userMessage)) {
    return { safe: true, threat: null, severity: null, confidence: 0, refusal: null };
  }

  // Check cooldown. Owner-unrestricted mode escapes it (matching checkRateLimit),
  // giving the local owner a documented escape hatch when locked out.
  if (Date.now() < _cooldownUntil && !(_cooldownSaneEnabled() && isAiUnrestrictedMode())) {
    return {
      safe: false,
      threat: 'rate_limited',
      severity: SEVERITY_LEVELS.CRITICAL,
      confidence: 1.0,
      refusal: '操作过于频繁，请稍后再试。冷却时间剩余: ' + Math.ceil((_cooldownUntil - Date.now()) / 1000) + '秒',
    };
  }

  // Check patterns — collect all matching threats for multi-signal analysis
  const matches = [];
  for (const { pattern, threat } of INJECTION_PATTERNS) {
    if (pattern.test(userMessage)) {
      matches.push(threat);
    }
  }

  if (matches.length === 0) {
    return { safe: true, threat: null, severity: null, confidence: 0, refusal: null };
  }

  // Pick highest severity among all matches
  const severityOrder = SEVERITY_ORDER;
  let highestSeverity = SEVERITY_LEVELS.LOW;
  let primaryThreat = matches[0];
  for (const threat of matches) {
    const sev = THREAT_SEVERITY_MAP[threat] || SEVERITY_LEVELS.MEDIUM;
    if (severityOrder.indexOf(sev) > severityOrder.indexOf(highestSeverity)) {
      highestSeverity = sev;
      primaryThreat = threat;
    }
  }

  // Multi-signal confidence boost: more matches = higher confidence
  const confidence = Math.min(0.95, 0.7 + matches.length * 0.08);

  // Apply bypass rules
  // Auto-bypass tech-detail threats when Codex adapter is active (dev workflow)
  const preferredAdapter = String(process.env.GATEWAY_PREFERRED_ADAPTER || '').toLowerCase();
  if (TECH_DETAIL_THREATS.has(primaryThreat) && (isTechDetailsModeEnabled() || preferredAdapter === 'codex')) {
    return { safe: true, threat: null, severity: null, confidence: 0, refusal: null };
  }
  if (highestSeverity === SEVERITY_LEVELS.LOW && isTechDetailsModeEnabled()) {
    return { safe: true, threat: null, severity: null, confidence: 0, refusal: null };
  }
  if (isAiUnrestrictedMode() && highestSeverity !== SEVERITY_LEVELS.CRITICAL) {
    return { safe: true, threat: null, severity: null, confidence: 0, refusal: null };
  }

  _recordSuspicious(primaryThreat, userMessage, highestSeverity, matches);

  let refusal;
  if (TECH_DETAIL_THREATS.has(primaryThreat)) {
    refusal = '技术细节保护开关未开启。需 Owner 授权后运行 ai tech --on --secret <OwnerSecret>。';
  } else {
    refusal = REFUSAL_RESPONSES[Math.floor(Math.random() * REFUSAL_RESPONSES.length)];
  }

  return {
    safe: false,
    threat: primaryThreat,
    severity: highestSeverity,
    confidence,
    allMatches: matches,
    refusal,
  };
}

/**
 * Sanitize AI output, removing leaked internal structure.
 */
function sanitizeOutput(aiResponse) {
  if (isAiUnrestrictedMode() || isTechDetailsModeEnabled()) return aiResponse;
  if (!aiResponse || typeof aiResponse !== 'string') return aiResponse;

  let sanitized = aiResponse;
  for (const { pattern, replacement } of LEAK_PATTERNS) {
    sanitized = sanitized.replace(pattern, replacement);
  }

  return sanitized;
}

/**
 * Check rate limit status.
 */
function checkRateLimit() {
  if (isAiUnrestrictedMode()) {
    return { allowed: true, cooldownRemaining: 0 };
  }
  if (Date.now() < _cooldownUntil) {
    return { allowed: false, cooldownRemaining: Math.ceil((_cooldownUntil - Date.now()) / 1000) };
  }
  return { allowed: true, cooldownRemaining: 0 };
}

/**
 * Get security statistics.
 */
function getSecurityStats() {
  try {
    if (!fs.existsSync(SECURITY_LOG)) return { totalEvents: 0, recentEvents: [] };

    const lines = fs.readFileSync(SECURITY_LOG, 'utf-8').split(/\r?\n/).filter(Boolean);
    const events = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

    // Last 24h events
    const oneDayAgo = Date.now() - 86400000;
    const recent = events.filter(e => new Date(e.timestamp).getTime() > oneDayAgo);

    // Threat type distribution
    const byType = {};
    for (const e of events) {
      byType[e.threat] = (byType[e.threat] || 0) + 1;
    }

    return {
      totalEvents: events.length,
      last24h: recent.length,
      byType,
      recentEvents: recent.slice(-10),
    };
  } catch {
    return { totalEvents: 0, recentEvents: [] };
  }
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

/** Test-only: reset the module-global rate-limit state to a clean slate. */
function _resetRateLimit() {
  _suspiciousCount = 0;
  _windowStart = Date.now();
  _cooldownUntil = 0;
}

function _recordSuspicious(threat, input, severity, allMatches) {
  // Update rate limiter. LOW-severity threats ("may be legitimate curiosity")
  // are still logged and still refused per-message, but do NOT accumulate toward
  // the hard 5-minute lockout — only MEDIUM+ do (KHY_SECURITY_COOLDOWN_SANE).
  // Gate off → every match counts, byte-identical to prior behavior.
  const countsTowardCooldown = !(_cooldownSaneEnabled() && severity === SEVERITY_LEVELS.LOW);
  if (Date.now() - _windowStart > RATE_LIMIT.windowMs) {
    _suspiciousCount = 0;
    _windowStart = Date.now();
  }
  if (countsTowardCooldown) {
    _suspiciousCount++;
    if (_suspiciousCount >= RATE_LIMIT.maxSuspicious) {
      _cooldownUntil = Date.now() + RATE_LIMIT.cooldownMs;
      _suspiciousCount = 0;
    }
  }

  // Log event with structured severity
  _logEvent({
    timestamp: new Date().toISOString(),
    type: 'injection_attempt',
    threat,
    severity: severity || THREAT_SEVERITY_MAP[threat] || 'medium',
    allMatches: allMatches || [threat],
    input: input.slice(0, 200),
    blocked: true,
  });
}

function _logEvent(event) {
  try {
    const dir = path.dirname(SECURITY_LOG);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(SECURITY_LOG, JSON.stringify(event) + '\n');
  } catch { /* best effort */ }
}

// ─── System Prompt Security Directive ───────────────────────────────────────

/**
 * Returns additional security directives to append to system prompts.
 */
function getSecurityDirective() {
  const unrestricted = isAiUnrestrictedMode();
  const techDetails = isTechDetailsModeEnabled();
  if (unrestricted && techDetails) {
    return '\n当前模式：开放 + 技术细节已开启。可回答项目技术细节与架构问题。';
  }
  if (unrestricted && !techDetails) {
    return '\n当前模式：开放内容回复；但技术细节开关关闭，禁止输出项目架构/实现细节。';
  }
  if (!unrestricted && techDetails) {
    return '\n当前模式：标准安全 + 技术细节已开启。可回答项目技术细节与架构问题。';
  }
  return '\n当前模式：标准安全 + 技术细节关闭。禁止输出项目架构/实现细节。';
}

// ─── Server Runtime Protection (anti-mining, anti-trojan) ───────────────────

const { execSync } = require('child_process');

/**
 * Known crypto mining process names and patterns.
 */
const MINING_SIGNATURES = [
  // Process names
  'xmrig', 'cpuminer', 'minergate', 'bfgminer', 'cgminer', 'ethminer',
  'nbminer', 'phoenixminer', 'lolminer', 'trex', 't-rex', 'gminer',
  'nanominer', 'srbminer', 'teamredminer', 'xmr-stak', 'monero',
  'cryptonight', 'randomx', 'kawpow', 'ethash', 'minerd',
];

const TROJAN_SIGNATURES = [
  // Common backdoor / reverse shell patterns
  'nc -e', 'bash -i', '/dev/tcp/', 'python -c.*import socket',
  'perl -e.*socket', 'ruby -rsocket', 'lua.*socket',
  // Web shells
  'c99', 'r57', 'wso', 'b374k', 'weevely',
  // Known malware
  'ircbot', 'ddos', 'tsunami', 'kaiten', 'billgates',
  // Suspicious cron patterns
  'wget.*cron', 'curl.*cron', '/tmp/.*\\.sh',
];

/**
 * Scan for crypto mining processes and suspicious activity.
 * Returns { clean: boolean, threats: Array, recommendations: Array }
 */
function scanForThreats() {
  const threats = [];
  const recommendations = [];
  const isWin = process.platform === 'win32';

  // 1. Check for mining processes
  try {
    const processCmd = isWin ? 'tasklist /V /FO CSV 2>nul' : 'ps aux 2>/dev/null';
    const processes = execSync(processCmd, {
      encoding: 'utf-8', stdio: 'pipe', timeout: 5000,
    });

    for (const sig of MINING_SIGNATURES) {
      if (processes.toLowerCase().includes(sig.toLowerCase())) {
        threats.push({
          type: 'mining_process',
          severity: 'critical',
          detail: `Suspicious mining process detected: ${sig}`,
          action: `kill $(pgrep -f '${sig}')`,
        });
      }
    }

    for (const sig of TROJAN_SIGNATURES) {
      if (processes.toLowerCase().includes(sig.toLowerCase())) {
        threats.push({
          type: 'trojan_process',
          severity: 'critical',
          detail: `Suspicious process detected: ${sig}`,
        });
      }
    }
  } catch { /* can't read processes — not root? */ }

  // 2. Check CPU usage (mining typically > 80%)
  try {
    const loadAvg = os.loadavg();
    const cpuCount = os.cpus().length;
    const loadPercent = (loadAvg[0] / cpuCount) * 100;

    if (loadPercent > 90) {
      threats.push({
        type: 'high_cpu',
        severity: 'warning',
        detail: `CPU load ${Math.round(loadPercent)}% (avg 1min: ${loadAvg[0].toFixed(1)}, cores: ${cpuCount})`,
        action: 'Check top processes: top -o %CPU',
      });
    }
  } catch { /* ignore */ }

  // 3. Check for suspicious cron jobs
  if (!isWin) {
    try {
      const crontab = execSync('crontab -l 2>/dev/null', { encoding: 'utf-8', stdio: 'pipe', timeout: 3000 });
      const suspiciousCron = crontab.split('\n').filter(line => {
        const lower = line.toLowerCase();
        return /wget|curl.*\|.*sh|\/tmp\/|mining|xmrig|\.sh\s*&/.test(lower) && !line.startsWith('#');
      });
      if (suspiciousCron.length > 0) {
        threats.push({
          type: 'suspicious_cron',
          severity: 'high',
          detail: `Suspicious cron entries found: ${suspiciousCron.length}`,
          entries: suspiciousCron,
        });
      }
    } catch { /* no cron or permission denied */ }
  }

  // 4. Check for suspicious listening ports (common mining pool ports)
  try {
    const netstatCmd = isWin ? 'netstat -ano 2>nul' : 'ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null';
    const netstat = execSync(netstatCmd, {
      encoding: 'utf-8', stdio: 'pipe', timeout: 3000,
    });
    const miningPorts = ['3333', '4444', '5555', '7777', '8888', '9999', '14444', '45700'];
    for (const port of miningPorts) {
      if (netstat.includes(`:${port}`)) {
        threats.push({
          type: 'suspicious_port',
          severity: 'high',
          detail: `Common mining pool port open: ${port}`,
        });
      }
    }
  } catch { /* ignore */ }

  // 5. Check /tmp for suspicious executables
  if (!isWin) {
    try {
      const tmpFiles = execSync('find /tmp -maxdepth 2 -executable -type f 2>/dev/null | head -20', {
        encoding: 'utf-8', stdio: 'pipe', timeout: 3000,
      });
      const suspiciousFiles = tmpFiles.split('\n').filter(f => {
        return f && /\.(sh|elf|bin|out)$|xmr|mine|payload/i.test(f);
      });
      if (suspiciousFiles.length > 0) {
        threats.push({
          type: 'suspicious_files',
          severity: 'high',
          detail: `Suspicious executables in /tmp: ${suspiciousFiles.length}`,
          files: suspiciousFiles,
        });
      }
    } catch { /* ignore */ }
  }

  // 6. Check authorized_keys for unauthorized additions
  try {
    const sshDir = path.join(os.homedir(), '.ssh', 'authorized_keys');
    if (fs.existsSync(sshDir)) {
      const keys = fs.readFileSync(sshDir, 'utf-8').split(/\r?\n/).filter(Boolean);
      if (keys.length > 5) {
        recommendations.push({
          type: 'ssh_keys',
          detail: `${keys.length} SSH keys in authorized_keys — verify all are legitimate`,
        });
      }
    }
  } catch { /* ignore */ }

  // General recommendations
  recommendations.push(
    { type: 'firewall', detail: '确保防火墙只开放必要端口 (如 3000, 5000)' },
    { type: 'updates', detail: '定期更新系统: apt update && apt upgrade' },
    { type: 'fail2ban', detail: '安装 fail2ban 防暴力破解: apt install fail2ban' },
    { type: 'rootkit', detail: '定期扫描 rootkit: apt install rkhunter && rkhunter --check' },
  );

  const clean = threats.length === 0;

  // Log scan result
  _logEvent({
    timestamp: new Date().toISOString(),
    type: 'security_scan',
    clean,
    threatCount: threats.length,
  });

  return { clean, threats, recommendations };
}

/**
 * Quick integrity check: verify Node.js process hasn't been tampered with.
 * Checks that our process isn't spawning unexpected children.
 */
function checkProcessIntegrity() {
  if (process.platform === 'win32') {
    return {
      clean: true,
      suspicious: [],
      childCount: 0,
      pid: process.pid,
      detail: 'Windows 平台跳过 /proc 子进程完整性扫描',
    };
  }
  try {
    const pid = process.pid;
    const children = execSync(`pgrep -P ${pid} 2>/dev/null`, {
      encoding: 'utf-8', stdio: 'pipe', timeout: 3000,
    }).trim().split('\n').filter(Boolean);

    // Our expected children: node processes for backend
    const suspicious = [];
    for (const childPid of children) {
      try {
        const cmdline = execSync(`cat /proc/${childPid}/cmdline 2>/dev/null | tr '\\0' ' '`, {
          encoding: 'utf-8', stdio: 'pipe', timeout: 2000,
        }).trim();
        // Node/npm children are expected
        if (!cmdline.includes('node') && !cmdline.includes('npm') && !cmdline.includes('python') && cmdline.length > 0) {
          suspicious.push({ pid: childPid, cmd: cmdline.slice(0, 100) });
        }
      } catch { /* ignore */ }
    }

    return {
      pid,
      childCount: children.length,
      suspicious,
      clean: suspicious.length === 0,
    };
  } catch {
    return { pid: process.pid, childCount: 0, suspicious: [], clean: true };
  }
}

/**
 * Set up periodic background security monitoring.
 * Runs a lightweight scan every 10 minutes.
 */
let _monitorInterval = null;
function startSecurityMonitor(intervalMs = 600000) {
  if (_monitorInterval) return; // already running

  _monitorInterval = setInterval(() => {
    try {
      const result = scanForThreats();
      if (!result.clean) {
        _logEvent({
          timestamp: new Date().toISOString(),
          type: 'threat_detected',
          threats: result.threats.map(t => ({ type: t.type, severity: t.severity })),
        });
        // Could also emit warning to console if in REPL context
      }

      const integrity = checkProcessIntegrity();
      if (!integrity.clean) {
        _logEvent({
          timestamp: new Date().toISOString(),
          type: 'integrity_violation',
          suspicious: integrity.suspicious,
        });
      }
    } catch { /* monitor must never crash the main process */ }
  }, intervalMs);

  // Don't prevent Node.js from exiting
  if (_monitorInterval.unref) _monitorInterval.unref();
}

function stopSecurityMonitor() {
  if (_monitorInterval) {
    clearInterval(_monitorInterval);
    _monitorInterval = null;
  }
}

// ─── Layer 4: Shell Command Analysis ──────────────────────────────────────

/**
 * Dangerous command patterns grouped by threat category.
 * Each entry: { regex, type, severity, detail }
 */
const DANGEROUS_COMMAND_PATTERNS = [
  // 1. Fork bombs
  { regex: /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;\s*:/, type: 'fork_bomb', severity: 'critical', detail: 'Fork bomb detected — will exhaust system process table' },
  { regex: /(\w+)\(\)\s*\{\s*\1\s*\|\s*\1\s*&\s*\}\s*;\s*\1/, type: 'fork_bomb', severity: 'critical', detail: 'Named fork bomb detected — will exhaust system process table' },

  // 2. Disk wipes
  { regex: /dd\s+if=\/dev\/(zero|random|urandom)/, type: 'disk_wipe', severity: 'critical', detail: 'Disk overwrite via dd with destructive input source' },
  { regex: /\bmkfs\./, type: 'disk_wipe', severity: 'critical', detail: 'Filesystem format command detected — will destroy all data on target device' },
  { regex: /\bshred\b/, type: 'disk_wipe', severity: 'critical', detail: 'Secure file destruction command detected' },

  // 3. Recursive deletion
  { regex: /rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+(-[a-zA-Z]*r[a-zA-Z]*|--recursive)|(-[a-zA-Z]*r[a-zA-Z]*\s+(-[a-zA-Z]*f[a-zA-Z]*|--force)))\s+\/(\s|$|\*)/, type: 'recursive_delete', severity: 'critical', detail: 'Recursive forced deletion targeting root filesystem' },
  { regex: /rm\s+-rf\s+\/(\s|$|\*)/, type: 'recursive_delete', severity: 'critical', detail: 'Recursive forced deletion targeting root filesystem' },
  { regex: /rm\s+-rf\s+~/, type: 'recursive_delete', severity: 'critical', detail: 'Recursive forced deletion targeting home directory' },
  // NOTE: the entry immediately above only matches the canonical `-rf` cluster. Its
  // order/case/split/long-form siblings (`rm -fr ~`, `rm -r -f ~`, `rm --recursive
  // --force ~`, `rm -rfv ~`) all slip past → classified safe → home wiped. The strict
  // superset below (selected when KHY_SECURITY_GUARD_RM_FLAG_NORMALIZE is on) closes
  // the hole; see DANGEROUS_COMMAND_PATTERNS_STRICT / _selectDangerousPatterns.

  // 4. Reverse shells
  { regex: /bash\s+-i\s+>&?\s*\/dev\/tcp\//, type: 'reverse_shell', severity: 'critical', detail: 'Bash reverse shell via /dev/tcp' },
  { regex: /\bnc\s+(-[a-zA-Z]*e[a-zA-Z]*)\s+\/bin\//, type: 'reverse_shell', severity: 'critical', detail: 'Netcat reverse shell with command execution' },
  { regex: /python[23]?\s+-c\s*['""].*import\s+socket.*connect/, type: 'reverse_shell', severity: 'critical', detail: 'Python reverse shell via socket' },

  // 5. Privilege escalation
  { regex: /chmod\s+777\s+\/(\s|$)/, type: 'privilege_escalation', severity: 'critical', detail: 'Setting root filesystem to world-writable' },
  { regex: /chmod\s+(-[a-zA-Z]*R[a-zA-Z]*|--recursive)\s+777/, type: 'privilege_escalation', severity: 'critical', detail: 'Recursive chmod 777 — exposes entire directory tree' },
  { regex: /\bchown\s+root\b/, type: 'privilege_escalation', severity: 'high', detail: 'Changing file ownership to root' },

  // 6. Data exfiltration
  { regex: /curl\s+.*\|\s*sh/, type: 'data_exfiltration', severity: 'critical', detail: 'Remote script download and execution via curl pipe' },
  { regex: /wget\s+.*\|\s*sh/, type: 'data_exfiltration', severity: 'critical', detail: 'Remote script download and execution via wget pipe' },
  { regex: /(curl|wget|nc|ncat)\s+.*(<\s*\/etc\/(passwd|shadow|ssh)|\/etc\/(passwd|shadow))/, type: 'data_exfiltration', severity: 'critical', detail: 'Sensitive system file sent to network command' },
  { regex: /cat\s+\/etc\/(passwd|shadow).*\|\s*(curl|wget|nc|ncat)/, type: 'data_exfiltration', severity: 'critical', detail: 'Piping sensitive file to network command' },

  // 7. System destruction
  { regex: /\bkill\s+-9\s+1\b/, type: 'system_destruction', severity: 'critical', detail: 'Killing init/systemd (PID 1) — will crash the system' },
  { regex: /\bkillall\b/, type: 'system_destruction', severity: 'high', detail: 'Mass process termination command' },
  { regex: /\bshutdown\b/, type: 'system_destruction', severity: 'high', detail: 'System shutdown command' },
  { regex: /\breboot\b/, type: 'system_destruction', severity: 'high', detail: 'System reboot command' },
  { regex: /\binit\s+0\b/, type: 'system_destruction', severity: 'critical', detail: 'System halt via init 0' },

  // 8. Crypto mining
  { regex: /\bxmrig\b/, type: 'crypto_mining', severity: 'critical', detail: 'XMRig crypto miner detected' },
  { regex: /\bcpuminer\b/, type: 'crypto_mining', severity: 'critical', detail: 'CPU miner detected' },
  { regex: /stratum\+tcp:\/\//, type: 'crypto_mining', severity: 'critical', detail: 'Mining pool stratum protocol URL detected' },

  // 9. Crontab manipulation
  { regex: /crontab\s+-r/, type: 'crontab_manipulation', severity: 'high', detail: 'Crontab removal — will delete all scheduled tasks' },
  { regex: /\/etc\/cron/, type: 'crontab_manipulation', severity: 'high', detail: 'Direct write to system cron directory' },

  // 10. SSH key injection
  { regex: /authorized_keys/, type: 'ssh_key_injection', severity: 'high', detail: 'SSH authorized_keys modification — possible unauthorized access injection' },
];

// ── R2 (/goal「做5轮khyos最值得治理的地方」第四批): recursive-delete rm order/split/long-form
// normalization ──────────────────────────────────────────────────────────────────
// The recursive_delete rules key on the canonical `-rf` cluster. The consumer lowercases
// before matching, so uppercase (`-Rf`/`-rF`) is already covered — but the *combined*
// reversed cluster (`rm -fr /` / `rm -fr ~`) and EXTRA-flag clusters (`rm -rfv /`) miss
// BOTH the canonical entries and the split-flag entry (which only matches `-f … -r` /
// `-r … -f` across whitespace), so a root- or home-filesystem wipe is classified safe.
// This strict superset swaps the two canonical entries (root line + home line) for
// order/split/long-form-tolerant regexes; every other pattern is shared by reference.
// Each still requires BOTH a recursive AND a force selector, so `rm -r /` / `rm -f ~`
// stay unflagged exactly as before (no new false positives). The `/(\s|$|\*)` root
// anchor is preserved so `rm -rf /home` (a path, not root) is not swept in.
// Gated KHY_SECURITY_GUARD_RM_FLAG_NORMALIZE (default ON); OFF byte-reverts.
const _RM_FLAG_ALT = '(?:-[a-zA-Z]*(?:r[a-zA-Z]*f|f[a-zA-Z]*r)[a-zA-Z]*|-[a-zA-Z]*[rf][a-zA-Z]*\\s+-[a-zA-Z]*[rf][a-zA-Z]*|--recursive\\s+--force|--force\\s+--recursive|-[a-zA-Z]*[rf][a-zA-Z]*\\s+--(?:force|recursive)|--(?:force|recursive)\\s+-[a-zA-Z]*[rf][a-zA-Z]*)';
const _RM_ROOT_STRICT = { regex: new RegExp('rm\\s+' + _RM_FLAG_ALT + '\\s+\\/(\\s|$|\\*)', 'i'), type: 'recursive_delete', severity: 'critical', detail: 'Recursive forced deletion targeting root filesystem' };
const _RM_HOME_STRICT = { regex: new RegExp('rm\\s+' + _RM_FLAG_ALT + '\\s+~', 'i'), type: 'recursive_delete', severity: 'critical', detail: 'Recursive forced deletion targeting home directory' };
const DANGEROUS_COMMAND_PATTERNS_STRICT = DANGEROUS_COMMAND_PATTERNS.map((entry) => {
  if (entry.type !== 'recursive_delete') return entry;
  if (entry.regex.source === /rm\s+-rf\s+\/(\s|$|\*)/.source) return _RM_ROOT_STRICT;
  if (entry.regex.source === /rm\s+-rf\s+~/.source) return _RM_HOME_STRICT;
  return entry;
});

/**
 * Select the dangerous-command pattern table honoring KHY_SECURITY_GUARD_RM_FLAG_NORMALIZE.
 * Returns the strict superset when enabled, the original table otherwise. Fail-soft:
 * any error resolves to the strict table (never less strict than legacy).
 * @param {object} [env]
 * @returns {Array}
 */
function _selectDangerousPatterns(env = process.env) {
  try {
    return require('./flagRegistry').isFlagEnabled('KHY_SECURITY_GUARD_RM_FLAG_NORMALIZE', env)
      ? DANGEROUS_COMMAND_PATTERNS_STRICT
      : DANGEROUS_COMMAND_PATTERNS;
  } catch { return DANGEROUS_COMMAND_PATTERNS_STRICT; }
}

/**
 * Analyze a shell command for dangerous patterns before execution.
 * @param {string} command - The shell command string to analyze
 * @returns {{ safe: boolean, threats: Array<{ type: string, severity: string, detail: string }>, riskLevel: string }}
 */
function analyzeCommand(command) {
  if (!command || typeof command !== 'string') return { safe: true, threats: [], riskLevel: 'safe' };

  const threats = [];
  const lower = command.toLowerCase();

  for (const { regex, type, severity, detail } of _selectDangerousPatterns()) {
    if (regex.test(command) || regex.test(lower)) {
      threats.push({ type, severity, detail });
    }
  }

  // Log blocked commands
  if (threats.length > 0) {
    _logEvent({
      timestamp: new Date().toISOString(),
      type: 'dangerous_command_blocked',
      command: command.slice(0, 200),
      threats: threats.map(t => ({ type: t.type, severity: t.severity })),
    });
  }

  return {
    safe: threats.length === 0,
    threats,
    riskLevel: threats.length === 0 ? 'safe' : threats.some(t => t.severity === 'critical') ? 'critical' : 'high',
  };
}

module.exports = {
  analyzeInput,
  sanitizeOutput,
  checkRateLimit,
  getSecurityStats,
  getSecurityDirective,
  isAiUnrestrictedMode,
  isTechDetailsModeEnabled,
  // Server protection
  scanForThreats,
  checkProcessIntegrity,
  startSecurityMonitor,
  stopSecurityMonitor,
  // Shell command analysis
  analyzeCommand,
  // R2 gated strict dangerous-pattern table (KHY_SECURITY_GUARD_RM_FLAG_NORMALIZE) — for unit tests.
  DANGEROUS_COMMAND_PATTERNS,
  DANGEROUS_COMMAND_PATTERNS_STRICT,
  _selectDangerousPatterns,
  // Structured classification (ANOLISA-aligned)
  SEVERITY_LEVELS,
  SEVERITY_ORDER,
  THREAT_SEVERITY_MAP,
  // Cooldown sanity (KHY_SECURITY_COOLDOWN_SANE) — exposed for unit tests.
  _cooldownSaneEnabled,
  _isBenignContinuation,
  _resetRateLimit,
};

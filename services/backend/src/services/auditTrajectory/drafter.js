'use strict';

/**
 * drafter.js — 下一轮提示词的「起草器」。产物是草稿，不是消息。
 *
 * 外部规则明令后续轮次的提示词必须由真人给出，所以本模块**没有发送能力**：
 * 它只产出草稿并跑六道自检，草稿要经真人确认（confirmDraft，必须带署名）才会
 * 以 origin.type=human 落进轨迹。这条线是故意断开的 —— 接上就成了自动闭环，
 * 等于用代码替真人签字，那是伪造审计记录。
 *
 * 六道自检（任一条不过就重写；不可机械修复的直接判否，绝不放行）：
 *   1. evidence-anchor  有实测锚点：每句关于产物的判断都要能追到具体证据
 *                       （某张截图、某个 grep 命中、某行实跑日志、某个数字/时间戳）。
 *   2. similarity       与前若干轮的开头、句式、长度比相似度，超阈值重写。
 *   3. tone             允许并鼓励口语、让步、优先级取舍、主观判断，太像规格书就重写。
 *   4. no-dashes        正则清除全部破折号与连字符（可机械修复，修完再验）。
 *   5. single-target    一条只打一个靶子；多靶子的拆成多轮（splitByTarget）。
 *   6. language-lock    语言跟随原始需求文档，全程不换。
 *
 * 检查 1 与检查 3 不冲突：主观**取舍**（先修哪个、我更想要什么）是鼓励的；
 * 被禁的是关于产物的**无锚点断言**（「感觉有点卡」而不给任何数字或日志）。
 * 判据就是这个：一句话里出现体感词，同句必须有可追溯锚点。
 *
 * @module services/auditTrajectory/drafter
 */

const { similarity } = require('./parser');

/** 破折号与连字符全集（检查 4 按这张表清除）。 */
const DASHES = ['—', '–', '‐', '‑', '‒', '―', '﹘', '﹣', '－', '-'];

/** 体感词：出现时同句必须带锚点，否则等于编造。 */
const VIBE_WORDS = ['感觉', '体感', '好像', '似乎', '大概', '差不多', '貌似', '看着', '像是', '有点怪', '不太行'];

/** 取舍/主观判断词：检查 3 要求至少出现一个（太像规格书就重写）。 */
const TONE_WORDS = [
  '先', '优先', '其实', '不过', '要是', '顺手', '回头', '我觉得', '我更想', '别', '尽量', '干脆',
  '至少', '暂时', '能不能', '就行', '再说', '算了', '倒是',
];

/** 多靶子连接词：出现且两侧各有一个动作，说明这条草稿打了不止一个靶。 */
const MULTI_TARGET_MARKERS = ['另外', '还有', '顺便', '同时', '以及', '再顺手', '除此之外'];

/** 动作词（判断连接词两侧是否各有一个动作）。 */
const ACTION_WORDS = ['改', '加', '删', '换', '调', '修', '补', '做', '拆', '合', '移', '换成', '去掉', '重写'];

const DEFAULT_THRESHOLDS = {
  opener: 0.8, // 开头相似度上限
  body: 0.85, // 全文相似度上限
  skeleton: 0.9, // 句式骨架相似度上限（配合长度比才判否）
  lengthRatio: 0.06, // 长度差异在这个比例内视为「长度也一样」
  openerChars: 12,
};

/** 清掉破折号与连字符，并收拢多余空白。 */
function stripDashes(text) {
  let s = String(text === undefined || text === null ? '' : text);
  for (const d of DASHES) {
    s = s.split(d).join(' ');
  }
  return s.replace(/[ \t]{2,}/g, ' ').replace(/ +([，。！？；：、])/g, '$1').trim();
}

/** 锚点比对用的归一化：去破折号、去空白、统一大小写。 */
function normalizeAnchor(s) {
  let t = String(s === undefined || s === null ? '' : s);
  for (const d of DASHES) {
    t = t.split(d).join('');
  }
  return t.replace(/\s+/g, '').toLowerCase();
}

/** 按句号/问号/分号切句（中英文都切）。 */
function splitSentences(text) {
  return String(text || '')
    .split(/[。！？；\n]|(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 句式骨架：只留标点与长度节奏，用来判「句式是不是又一样」。 */
function skeletonOf(text) {
  return String(text || '')
    .replace(/[0-9]+/g, '9')
    .replace(/[一-鿿]/g, '中')
    .replace(/[A-Za-z]+/g, 'w');
}

/**
 * 从实测证据里抽出可用作锚点的字符串集合。
 *
 * 只收「可核查」的东西：截图文件名、grep 命中的文本与文件名、实跑命令与其输出里的
 * 数字、时间戳。凡是没进这个集合的说法，检查 1 都会当成无法追溯。
 *
 * @param {object} evidence { screenshots, grep, logs, numbers, timestamps, anchors }
 * @returns {{tokens:Set<string>, list:Array<{token:string, from:string}>}}
 */
function buildAnchorSet(evidence = {}) {
  const list = [];
  const add = (raw, from) => {
    const t = normalizeAnchor(raw);
    if (t && t.length >= 2) {
      list.push({ token: t, from, raw: String(raw) });
    }
  };

  for (const s of evidence.screenshots || []) {
    const p = typeof s === 'string' ? s : (s && s.path) || '';
    if (!p) {
      continue;
    }
    add(p, 'screenshot');
    add(String(p).split(/[\\/]/).pop(), 'screenshot');
    if (s && s.label) {
      add(s.label, 'screenshot');
    }
  }
  for (const g of evidence.grep || []) {
    if (typeof g === 'string') {
      add(g, 'grep');
      continue;
    }
    if (!g) {
      continue;
    }
    add(g.pattern, 'grep');
    add(g.text, 'grep');
    if (g.file) {
      add(String(g.file).split(/[\\/]/).pop(), 'grep');
    }
  }
  for (const l of evidence.logs || []) {
    const text = typeof l === 'string' ? l : [l && l.command, l && l.stdout, l && l.stderr].filter(Boolean).join('\n');
    if (!text) {
      continue;
    }
    if (l && l.command) {
      add(l.command, 'log');
    }
    if (l && (l.exitCode === 0 || l.exitCode)) {
      add(String(l.exitCode), 'log');
    }
    // 输出里的数字是最硬的锚点（毫秒数、条数、像素值都在这儿）
    for (const n of String(text).match(/[0-9]+(?:\.[0-9]+)?(?:ms|s|px|%|MB|KB)?/gi) || []) {
      add(n, 'log');
    }
  }
  for (const n of evidence.numbers || []) {
    add(String(n), 'number');
  }
  for (const t of evidence.timestamps || []) {
    add(String(t), 'timestamp');
  }
  for (const a of evidence.anchors || []) {
    add(String(a), 'explicit');
  }

  return { tokens: new Set(list.map((x) => x.token)), list };
}

/** 一句话里命中的锚点。 */
function anchorsInSentence(sentence, anchorSet) {
  const s = normalizeAnchor(sentence);
  const hits = [];
  for (const a of anchorSet.list) {
    if (a.token.length >= 2 && s.includes(a.token)) {
      hits.push(a);
    }
  }
  return hits;
}

/** 检查 1：有实测锚点，且体感词必须同句带锚点。 */
function checkEvidenceAnchor(text, anchorSet) {
  const sentences = splitSentences(text);
  const total = anchorsInSentence(text, anchorSet);
  const unanchored = [];
  for (const s of sentences) {
    const vibe = VIBE_WORDS.filter((w) => s.includes(w));
    if (vibe.length === 0) {
      continue;
    }
    if (anchorsInSentence(s, anchorSet).length === 0) {
      unanchored.push({ sentence: s, vibe });
    }
  }
  if (total.length === 0) {
    return {
      id: 'evidence-anchor',
      ok: false,
      fixable: false,
      reason: '整篇没有一个能追溯到证据的锚点（截图名、grep 命中、实跑日志里的数字都算），全靠主观体感等于编造',
    };
  }
  if (unanchored.length > 0) {
    const first = unanchored[0];
    return {
      id: 'evidence-anchor',
      ok: false,
      fixable: false,
      reason:
        '这句体感没有锚点：「' + first.sentence.slice(0, 40) + '」出现了「' + first.vibe.join('、') + '」却没引用任何证据',
      unanchored,
    };
  }
  return { id: 'evidence-anchor', ok: true, anchors: total.map((a) => a.raw).slice(0, 8) };
}

/** 检查 2：与前若干轮的开头、句式、长度比相似度。 */
function checkSimilarity(text, priorDrafts = [], thresholds = {}) {
  const th = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const opener = String(text).slice(0, th.openerChars);
  let worst = { index: -1, opener: 0, body: 0, skeleton: 0, lengthRatio: 1 };
  for (let i = 0; i < priorDrafts.length; i++) {
    const prev = String(priorDrafts[i] || '');
    const m = {
      index: i,
      opener: similarity(opener, prev.slice(0, th.openerChars)),
      body: similarity(text, prev),
      skeleton: similarity(skeletonOf(text), skeletonOf(prev)),
      lengthRatio: prev.length === 0 ? 1 : Math.abs(text.length - prev.length) / Math.max(text.length, prev.length),
    };
    const score = Math.max(m.opener, m.body, m.skeleton);
    if (score > Math.max(worst.opener, worst.body, worst.skeleton)) {
      worst = m;
    }
  }
  if (worst.index < 0) {
    return { id: 'similarity', ok: true, first: true };
  }
  const reasons = [];
  if (worst.opener >= th.opener) {
    reasons.push('开头与第 ' + (worst.index + 1) + ' 轮相似度 ' + worst.opener.toFixed(2));
  }
  if (worst.body >= th.body) {
    reasons.push('全文与第 ' + (worst.index + 1) + ' 轮相似度 ' + worst.body.toFixed(2));
  }
  if (worst.skeleton >= th.skeleton && worst.lengthRatio <= th.lengthRatio) {
    reasons.push('句式骨架相似度 ' + worst.skeleton.toFixed(2) + ' 且长度几乎一样');
  }
  if (reasons.length > 0) {
    return { id: 'similarity', ok: false, fixable: true, reason: '跟前面几轮太像：' + reasons.join('；') + '，需要重写', metrics: worst };
  }
  return { id: 'similarity', ok: true, metrics: worst };
}

/** 检查 3：口语、让步、取舍要有；太像规格书就重写。 */
function checkTone(text) {
  const hits = TONE_WORDS.filter((w) => text.includes(w));
  if (hits.length === 0) {
    return {
      id: 'tone',
      ok: false,
      fixable: true,
      reason: '通篇像规格书：没有一处口语、让步或优先级取舍。真人提需求会说「先」「其实」「能不能」这类话',
    };
  }
  return { id: 'tone', ok: true, markers: hits.slice(0, 6) };
}

/** 检查 4：破折号与连字符必须清干净（可机械修复）。 */
function checkNoDashes(text) {
  const found = DASHES.filter((d) => text.includes(d));
  if (found.length > 0) {
    return {
      id: 'no-dashes',
      ok: false,
      fixable: true,
      autoFix: true,
      reason: '出现破折号或连字符（' + found.join(' ') + '），按规则要全部清除',
      found,
    };
  }
  return { id: 'no-dashes', ok: true };
}

/** 检查 5：一条只打一个靶子。 */
function checkSingleTarget(text, opts = {}) {
  const declared = Array.isArray(opts.targets) ? opts.targets.filter(Boolean) : [];
  if (declared.length > 1) {
    return {
      id: 'single-target',
      ok: false,
      fixable: false,
      splittable: true,
      reason: '这条草稿打了 ' + declared.length + ' 个靶子（' + declared.join('、') + '），要拆成 ' + declared.length + ' 轮',
      targets: declared,
    };
  }
  const marker = MULTI_TARGET_MARKERS.find((m) => {
    const at = text.indexOf(m);
    if (at < 0) {
      return false;
    }
    const before = text.slice(0, at);
    const after = text.slice(at + m.length);
    return ACTION_WORDS.some((a) => before.includes(a)) && ACTION_WORDS.some((a) => after.includes(a));
  });
  if (marker) {
    return {
      id: 'single-target',
      ok: false,
      fixable: false,
      splittable: true,
      reason: '「' + marker + '」前后各有一个动作，等于一条打了两个靶子，拆成两轮再发',
    };
  }
  return { id: 'single-target', ok: true };
}

/** 检查 6：语言跟随原始需求文档，全程不换。 */
function checkLanguage(text, lang, anchorSet) {
  const want = String(lang || '').trim().toLowerCase() || 'zh';
  const cjk = (text.match(/[一-鿿]/g) || []).length;
  const latinWords = (text.match(/[A-Za-z]{2,}/g) || []).filter((w) => {
    const n = normalizeAnchor(w);
    // 锚点里的英文（文件名、命令、标识符）不算换语言
    return !anchorSet || ![...anchorSet.tokens].some((t) => t.includes(n));
  });
  const detected = cjk > latinWords.length ? 'zh' : 'en';
  if (want.startsWith('zh')) {
    if (cjk === 0) {
      return { id: 'language-lock', ok: false, fixable: true, reason: '原始需求是中文，这条草稿没有一个中文字，语言换了' };
    }
    if (latinWords.length >= 8 && latinWords.length > cjk / 4) {
      return {
        id: 'language-lock',
        ok: false,
        fixable: true,
        reason: '中文需求里混进了 ' + latinWords.length + ' 个非锚点英文词，语言在中途漂了',
        latinWords: latinWords.slice(0, 8),
      };
    }
    return { id: 'language-lock', ok: true, detected };
  }
  if (cjk > 0) {
    return { id: 'language-lock', ok: false, fixable: true, reason: '原始需求是 ' + want + '，草稿里出现了中文，语言换了' };
  }
  return { id: 'language-lock', ok: true, detected };
}

/**
 * 跑完六道自检。
 *
 * @param {string} text 草稿正文
 * @param {object} ctx { evidence, anchorSet, priorDrafts, lang, targets, thresholds }
 * @returns {{ok:boolean, checks:Array, failed:Array, status:string}}
 */
function runSelfChecks(text, ctx = {}) {
  const anchorSet = ctx.anchorSet || buildAnchorSet(ctx.evidence || {});
  const checks = [
    checkEvidenceAnchor(text, anchorSet),
    checkSimilarity(text, ctx.priorDrafts || [], ctx.thresholds),
    checkTone(text),
    checkNoDashes(text),
    checkSingleTarget(text, { targets: ctx.targets }),
    checkLanguage(text, ctx.lang, anchorSet),
  ];
  const failed = checks.filter((c) => !c.ok);
  return {
    ok: failed.length === 0,
    checks,
    failed,
    status: '自检提示词草稿：' + (checks.length - failed.length) + ' / ' + checks.length + ' 条通过',
  };
}

/** 开场与收尾的备选说法：轮换用，专门用来压低与前几轮的开头/句式相似度。 */
const OPENERS_ZH = [
  '刚点了一遍',
  '我又看了下',
  '这次盯的是',
  '试着走了一遍',
  '把上次那块又摸了摸',
  '顺手复现了一下',
];
const CLOSERS_ZH = [
  '这个先弄，别的回头再说',
  '要是不好搞就先做一半，我不着急',
  '优先度不高的先放着，把这条捋顺就行',
  '能不能顺手一起处理都行，主要是这条',
  '暂时就这一条，其他的我再想想',
];

/**
 * 默认起草器：从实测证据拼一段自然语言草稿。
 *
 * 刻意做成确定性模板 + variant 轮换，而不是自由生成：模板保证「锚点」和「口语取舍」
 * 一定在，variant 轮换保证重写时开头和句式真的变了。要接大模型就传 opts.composer，
 * 六道自检对自定义起草器一样生效。
 *
 * @param {object} input { evidence, observation, ask, lang, variant }
 * @returns {string}
 */
function composeDraft(input = {}) {
  const v = Number.isInteger(input.variant) ? input.variant : 0;
  const anchorSet = input.anchorSet || buildAnchorSet(input.evidence || {});
  // 优先挑短锚点（截图文件名、数字），别把整条绝对路径塞进给人读的提示词里；
  // 短的挑不到才退回全量列表 —— 锚点宁可难看，也不能没有。
  const short = anchorSet.list.filter((a) => a.raw.length <= 40 && !/[\\/]/.test(a.raw));
  const pool = short.length > 0 ? short : anchorSet.list;
  const anchor = pool.length > 0 ? pool[v % pool.length].raw : '';
  const observation = String(input.observation || '').trim();
  const ask = String(input.ask || '').trim();
  const opener = OPENERS_ZH[v % OPENERS_ZH.length];
  const closer = CLOSERS_ZH[v % CLOSERS_ZH.length];
  const parts = [];
  parts.push(opener + (anchor ? ' ' + anchor : '') + '，' + observation + '。');
  parts.push(ask + '。');
  parts.push(closer + '。');
  return stripDashes(parts.join(''));
}

/**
 * 起草一条草稿并跑自检，不过就重写（默认最多重写 4 次）。
 *
 * **本函数不发送任何东西**：返回值是草稿 + 自检报告，等真人确认。
 *
 * @param {object} input { evidence, observation, ask, lang, targets, priorDrafts }
 * @param {object} [opts] { composer, maxRewrites, thresholds }
 * @returns {object} { ok, draft, attempts, failed, splitRequired, status }
 */
function draft(input = {}, opts = {}) {
  const anchorSet = buildAnchorSet(input.evidence || {});
  const compose = typeof opts.composer === 'function' ? opts.composer : composeDraft;
  const maxRewrites = Number.isInteger(opts.maxRewrites) ? opts.maxRewrites : 4;
  const lang = input.lang || 'zh';
  const targets = Array.isArray(input.targets) ? input.targets.filter(Boolean) : [];
  const attempts = [];

  if (targets.length > 1) {
    return {
      ok: false,
      splitRequired: true,
      targets: targets.map((t) => (typeof t === 'string' ? t : t && t.name)),
      failed: [checkSingleTarget('', { targets: targets.map((t) => (typeof t === 'string' ? t : t && t.name)) })],
      status: '起草提示词：检测到 ' + targets.length + ' 个靶子，按规则拆成 ' + targets.length + ' 轮，请用 splitDraft',
    };
  }

  for (let v = 0; v <= maxRewrites; v++) {
    // 检查 4 是纯机械的，先修再验：省一轮重写，也保证锚点比对时两侧都已去连字符。
    const text = stripDashes(compose({ ...input, anchorSet, variant: v }));
    const report = runSelfChecks(text, {
      anchorSet,
      priorDrafts: input.priorDrafts || [],
      lang,
      targets: targets.map((t) => (typeof t === 'string' ? t : t && t.name)),
      thresholds: opts.thresholds,
    });
    attempts.push({ variant: v, text, ok: report.ok, failed: report.failed.map((f) => f.id) });

    if (report.ok) {
      return {
        ok: true,
        draft: {
          id: 'draft-' + Date.now().toString(36) + '-' + v,
          text,
          lang,
          anchors: (report.checks[0].anchors || []).slice(0, 8),
          evidence: input.evidence || {},
          requiresHumanConfirmation: true,
        },
        checks: report.checks,
        attempts,
        status: '起草提示词草稿：' + text.length + ' 字，六道自检全过，等真人确认后才能发出',
      };
    }
    if (report.failed.some((f) => f.splittable)) {
      return {
        ok: false,
        splitRequired: true,
        failed: report.failed,
        attempts,
        status: '起草提示词：草稿打了多个靶子，按规则拆成多轮',
      };
    }
    if (report.failed.some((f) => !f.fixable)) {
      return {
        ok: false,
        blocked: true,
        failed: report.failed,
        attempts,
        status: '起草提示词：第 ' + report.failed[0].id + ' 条自检不通过且无法靠重写解决（' + report.failed[0].reason + '）',
      };
    }
  }

  return {
    ok: false,
    exhausted: true,
    attempts,
    failed: attempts[attempts.length - 1] ? [{ id: attempts[attempts.length - 1].failed[0] }] : [],
    status: '起草提示词：重写 ' + maxRewrites + ' 次仍未过自检，交人工改写',
  };
}

/**
 * 多靶子拆多轮：每个靶子各起一份草稿，且每份都要带自己的实测证据。
 * @param {object} input { targets: [{name, observation, ask, evidence}], lang, priorDrafts }
 * @param {object} [opts]
 * @returns {{ok:boolean, rounds:Array, status:string}}
 */
function splitDraft(input = {}, opts = {}) {
  const targets = Array.isArray(input.targets) ? input.targets.filter(Boolean) : [];
  const prior = [...(input.priorDrafts || [])];
  const rounds = [];
  for (const t of targets) {
    const one = typeof t === 'string' ? { name: t } : t;
    const r = draft(
      {
        evidence: one.evidence || input.evidence,
        observation: one.observation,
        ask: one.ask,
        lang: input.lang || 'zh',
        targets: [one.name],
        priorDrafts: prior,
      },
      opts
    );
    if (r.ok) {
      prior.push(r.draft.text); // 后一轮要跟前一轮比相似度，逐轮累积
    }
    rounds.push({ target: one.name, ...r });
  }
  return {
    ok: rounds.length > 0 && rounds.every((r) => r.ok),
    rounds,
    status: '拆分提示词草稿：' + rounds.filter((r) => r.ok).length + ' / ' + rounds.length + ' 个靶子起草成功',
  };
}

// ── 人工确认（唯一的发出口） ──

class DraftNotConfirmedError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'DraftNotConfirmedError';
    Object.assign(this, detail);
  }
}

/**
 * 真人确认一份草稿，并以 origin.type=human 落进轨迹。
 *
 * 这是本模块唯一会写轨迹的函数，且必须由人调用：没有 confirmedBy 署名就抛错，
 * 不会像 recorder 那样静默降级成 ai_generated —— 起草器这条路上「忘了署名」几乎
 * 一定是被拿去做自动闭环了，那时候该炸，不该悄悄记成 AI 生成继续跑。
 *
 * 同时过一遍 Driver 到 Worker 的通道词汇门禁：草稿本身就是下一轮发给 Worker 的
 * 提示词，管理词汇不能借起草器绕进去。
 *
 * @param {object} args
 * @param {object} args.draft draft() 返回的 draft 对象（必须 ok）
 * @param {string} args.confirmedBy 真人署名
 * @param {object} [args.recorder] AuditTrajectoryRecorder；给了才写轨迹
 * @param {string} [args.editedText] 真人改写后的正文（改了就以人改的为准，并重跑硬性检查）
 * @param {boolean} [args.strict] 通道门禁是否连软词一起拦
 * @returns {{ok:boolean, text:string, origin:object, recorded:(object|null), status:string}}
 */
function confirmDraft(args = {}) {
  const d = args.draft && typeof args.draft === 'object' ? args.draft : null;
  if (!d || !String(d.text || '').trim()) {
    throw new DraftNotConfirmedError('确认提示词草稿：失败（没有草稿正文）', { code: 'DRAFT_EMPTY' });
  }
  const by = String(args.confirmedBy || '').trim();
  if (!by) {
    throw new DraftNotConfirmedError('确认提示词草稿：失败（缺少真人署名 confirmedBy，不允许自动确认）', {
      code: 'DRAFT_UNSIGNED',
    });
  }

  // 真人可以改写。改写后仍要过纯机械的两条（去连字符、单靶子），但不再要求
  // 相似度/语气 —— 人写的东西不该被机器判「不够口语」再打回去。
  let text = stripDashes(args.editedText !== undefined ? args.editedText : d.text);
  const edited = args.editedText !== undefined && stripDashes(args.editedText) !== stripDashes(d.text);
  const single = checkSingleTarget(text, { targets: d.targets });
  if (!single.ok) {
    throw new DraftNotConfirmedError('确认提示词草稿：失败（' + single.reason + '）', {
      code: 'DRAFT_MULTI_TARGET',
      check: single,
    });
  }

  const channel = require('./channel');
  const gate = channel.buildWorkerMessage(text, { strict: !!args.strict });
  if (!gate.ok) {
    throw new DraftNotConfirmedError('确认提示词草稿：失败（' + gate.reason + '）', {
      code: gate.code || 'CHANNEL_FORBIDDEN_VOCABULARY',
      gate,
    });
  }
  text = gate.message;

  const origin = {
    type: 'human',
    confirmedBy: by,
    draftId: d.id || '',
    channel: 'drafter.confirmDraft',
  };

  let recorded = null;
  if (args.recorder && typeof args.recorder.recordPrompt === 'function') {
    recorded = args.recorder.recordPrompt(text, origin, {
      draft: { id: d.id || '', edited, anchors: (d.anchors || []).slice(0, 8) },
    });
  }

  return {
    ok: true,
    text,
    origin,
    recorded,
    edited,
    status: '确认提示词草稿：' + by + ' 已署名，' + text.length + ' 字' + (recorded ? '，已记入轨迹' : '，未提供记录器故未入轨迹'),
  };
}

module.exports = {
  DASHES,
  VIBE_WORDS,
  TONE_WORDS,
  MULTI_TARGET_MARKERS,
  ACTION_WORDS,
  DEFAULT_THRESHOLDS,
  OPENERS_ZH,
  CLOSERS_ZH,
  stripDashes,
  normalizeAnchor,
  splitSentences,
  skeletonOf,
  similarity,
  buildAnchorSet,
  anchorsInSentence,
  checkEvidenceAnchor,
  checkSimilarity,
  checkTone,
  checkNoDashes,
  checkSingleTarget,
  checkLanguage,
  runSelfChecks,
  composeDraft,
  draft,
  splitDraft,
  confirmDraft,
  DraftNotConfirmedError,
};

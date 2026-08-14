'use strict';

/**
 * operationTaskClassifier.js
 *
 * Pure-function classifier that decides whether a user message describes an
 * OPERATIONAL task (desktop / browser / file / data manipulation) suitable
 * for flow-first replay, versus chit-chat / creative / explanatory requests.
 *
 * Conservative dual-hit rule: a message is operational ONLY when it hits at
 * least one action VERB and at least one object NOUN, and is not vetoed by
 * the interrogative / creative-opener guards. Zero I/O, no randomness.
 */

// Same style as intentGate.js: strip fenced / indented code blocks first.
const CODE_BLOCK_RE = /(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\1[^\n]*|(?:(?:^|\n)(?: {4}|\t)[^\n]*)+/gm;

// Interrogative veto (mirrors intentGate STRONG_QUESTION_RE / WH_QUESTION_RE).
const STRONG_QUESTION_RE =
  /[?？]|(?:吗|呢|吧)\s*[?？!！。.~～\s]*$|是不是|是否|有没有|能不能|会不会|可不可以|对不对|难道|莫非/u;
const WH_QUESTION_RE =
  /(什么|啥|为什么|为何|怎么|怎样|咋样?|如何|多少|哪(?:个|些|里|儿|样|种)?|谁)/;

// Creative / explanatory opener veto: these lead-ins mean "produce prose",
// not "operate the machine", even if verbs+nouns co-occur later.
const CREATIVE_OPENER_RE =
  /^\s*(?:写一[篇段首封]|帮我写一[篇段首封]|解释|介绍|评价|总结一下|概括一下|说说|谈谈|聊聊|讲讲|科普)/;

// Action verbs (operation-flavored, imperative).
const ACTION_VERBS = [
  '打开',
  '关闭',
  '点击',
  '双击',
  '右键',
  '填写',
  '填好',
  '填入',
  '输入',
  '录入',
  '导出',
  '导入',
  '上传',
  '下载',
  '保存',
  '另存',
  '提交',
  '发送',
  '整理',
  '批量',
  '重命名',
  '改名',
  '复制',
  '粘贴',
  '剪切',
  '移动',
  '删除',
  '清空',
  '截图',
  '截屏',
  '搜索并',
  '查找并',
  '拖拽',
  '拖动',
  '切换',
  '滚动',
  '刷新',
  '登录',
  '登陆',
  '安装',
  '卸载',
];

// Object nouns grouped by category. First match category order below decides
// ties: desktop → browser → file → data.
const CATEGORY_NOUNS = {
  desktop: [
    '记事本',
    '计算器',
    '窗口',
    '桌面',
    '任务栏',
    '应用程序',
    '应用',
    '程序',
    '软件',
    '弹窗',
  ],
  browser: ['浏览器', '网页', '网站', '网址', '链接', '页面', '表单', '标签页', '搜索框'],
  file: ['文件夹', '文件', '目录', '压缩包', '图片', '照片', '文档', '路径'],
  data: ['Excel', 'excel', '表格', '电子表格', '数据', '邮件', '报表', '记录', 'csv', 'CSV'],
};

const CATEGORY_ORDER = ['desktop', 'browser', 'file', 'data'];

const EMPTY_RESULT = Object.freeze({
  operational: false,
  category: null,
  confidence: 0,
  keywords: Object.freeze([]),
});

/**
 * Collect terms from `list` that literally occur in `text`.
 * @param {string} text
 * @param {string[]} list
 * @returns {string[]}
 */
function _hits(text, list) {
  const found = [];
  for (const term of list) {
    if (text.indexOf(term) !== -1) {
      found.push(term);
    }
  }
  return found;
}

/**
 * Classify a user message as operational (automation-worthy) or not.
 * Never throws; any bad input yields the safe empty result.
 * @param {string} userMessage
 * @returns {{operational:boolean, category:string|null, confidence:number, keywords:string[]}}
 */
function classifyOperationTask(userMessage) {
  try {
    if (typeof userMessage !== 'string' || !userMessage.trim()) {
      return { ...EMPTY_RESULT, keywords: [] };
    }
    const text = userMessage.replace(CODE_BLOCK_RE, ' ').trim();
    if (!text) {
      return { ...EMPTY_RESULT, keywords: [] };
    }

    // Explicit vetoes: interrogatives and creative/explanatory openers.
    if (
      STRONG_QUESTION_RE.test(text) ||
      WH_QUESTION_RE.test(text) ||
      CREATIVE_OPENER_RE.test(text)
    ) {
      return { ...EMPTY_RESULT, keywords: [] };
    }

    const verbHits = _hits(text, ACTION_VERBS);
    let bestCategory = null;
    let bestCount = 0;
    const nounHits = [];
    for (const cat of CATEGORY_ORDER) {
      const hits = _hits(text, CATEGORY_NOUNS[cat]);
      nounHits.push(...hits);
      if (hits.length > bestCount) {
        bestCount = hits.length;
        bestCategory = cat;
      }
    }

    // Conservative dual-hit: require BOTH a verb and a noun.
    if (verbHits.length === 0 || nounHits.length === 0) {
      return { ...EMPTY_RESULT, keywords: [] };
    }

    const keywords = [...verbHits, ...nounHits];
    // 0.7 base for the dual hit; +0.05 per extra keyword; capped at 0.95.
    // Round to 2 decimals to avoid float artifacts (0.7999... → 0.8).
    const raw = Math.min(0.95, 0.7 + Math.max(0, keywords.length - 2) * 0.05);
    const confidence = Math.round(raw * 100) / 100;
    return { operational: true, category: bestCategory, confidence, keywords };
  } catch {
    return { operational: false, category: null, confidence: 0, keywords: [] };
  }
}

module.exports = { classifyOperationTask };

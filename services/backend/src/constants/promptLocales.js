'use strict';

/**
 * promptLocales.js — i18n prompt template catalog.
 *
 * Provides locale-keyed message catalogs for model execution guidance,
 * guardrail messages, tool descriptions, and system prompt sections.
 *
 * Supported locales: en, zh, ja, ko (extensible via LOCALE_CATALOGS).
 * Lookup: t(key, locale) → string. Falls back en → key if missing.
 *
 * Aligned with Hermes-Agent's 16-language i18n architecture (D8).
 */

const DEFAULT_LOCALE = 'en';

// ── Locale catalogs ────────────────────────────────────────────────────

const LOCALE_CATALOGS = {
  en: {
    // Model execution guidance
    'exec.gpt.title': '# Execution Discipline (GPT/Codex)',
    'exec.gpt.use_tools': 'You MUST use tools to complete tasks. Do not just describe steps — execute them.',
    'exec.gpt.verify': 'Verify tool results before continuing.',
    'exec.gpt.abs_path': 'Always use absolute paths. Do not ask the user to run commands — use the Bash tool.',
    'exec.gpt.intent': 'State intent briefly (one sentence), then immediately call the tool.',

    'exec.gemini.title': '# Execution Discipline (Gemini)',
    'exec.gemini.read_first': 'Read files before editing to confirm they exist and review current content. Read again after writing to verify.',
    'exec.gemini.abs_path': 'Use absolute paths. Check dependencies exist before importing.',
    'exec.gemini.no_placeholder': 'Do not generate placeholder code — implement fully or explain what is missing.',
    'exec.gemini.execute': 'Do not list steps for the user to execute — you execute them.',

    'exec.deepseek.title': '# Execution Discipline (DeepSeek)',
    'exec.deepseek.strict': 'Call tools strictly by their defined names. Do not invent tool names.',
    'exec.deepseek.verify': 'Run syntax checks or tests after editing. Use absolute paths.',
    'exec.deepseek.serial': 'Batch independent read-only calls in parallel; run edits, writes, and dependent steps one at a time.',

    'exec.generic.title': '# Execution Discipline',
    'exec.generic.use_tools': 'You have tools available. You MUST use them to execute tasks — do not just describe steps.',
    'exec.generic.verify': 'Verify changes after modification. Use absolute paths.',
    'exec.generic.intent': 'State intent briefly, then immediately call the tool.',

    // Guardrail messages
    'guard.exact_fail_block': '{tool} failed {count} times with same arguments — try different arguments or a different tool',
    'guard.exact_fail_warn': '{tool} failed {count} times with same arguments — consider changing arguments',
    'guard.tool_fail_halt': '{tool} failed {count} times total — terminating loop',
    'guard.tool_fail_warn': '{tool} failed {count} times — consider a different tool',
    'guard.no_progress_block': '{tool} returned identical results {count} times — no progress',
    'guard.no_progress_warn': '{tool} returned identical results {count} times',

    // Language section
    'lang.instruction': 'Always respond in {lang}. Use {lang} for all explanations, comments, and communications with the user. Technical terms and code identifiers should remain in their original form.',
  },

  zh: {
    'exec.gpt.title': '# 执行纪律 (GPT/Codex)',
    'exec.gpt.use_tools': '你必须使用工具来完成任务。不要只描述步骤——执行它们。',
    'exec.gpt.verify': '每次工具调用后验证结果再继续。',
    'exec.gpt.abs_path': '始终使用绝对路径。不要让用户自己执行命令——使用 Bash 工具。',
    'exec.gpt.intent': '先简短说明意图（一句话），然后立即调用工具。',

    'exec.gemini.title': '# 执行纪律 (Gemini)',
    'exec.gemini.read_first': '编辑前先 Read 确认文件存在并查看当前内容。写入后再 Read 验证。',
    'exec.gemini.abs_path': '使用绝对路径。检查依赖存在后再导入。',
    'exec.gemini.no_placeholder': '不要生成占位代码——完整实现或说明缺什么。',
    'exec.gemini.execute': '不要在回复中列出步骤让用户执行——你来执行。',

    'exec.deepseek.title': '# 执行纪律 (DeepSeek)',
    'exec.deepseek.strict': '严格按工具定义调用，不要发明工具名。',
    'exec.deepseek.verify': '编辑后运行语法检查或测试验证。使用绝对路径。',
    'exec.deepseek.serial': '互不依赖的只读调用可并行；编辑、写入和有依赖的步骤一次只做一个。',

    'exec.generic.title': '# 执行纪律',
    'exec.generic.use_tools': '你有工具可用。必须使用它们执行任务，不要只描述步骤。',
    'exec.generic.verify': '修改后验证更改。使用绝对路径。',
    'exec.generic.intent': '先简短说明意图，然后立即调用工具。',

    'guard.exact_fail_block': '{tool} 同参数已失败 {count} 次，请换参数或换工具',
    'guard.exact_fail_warn': '{tool} 同参数已失败 {count} 次，考虑换参数',
    'guard.tool_fail_halt': '{tool} 累计失败 {count} 次，终止循环',
    'guard.tool_fail_warn': '{tool} 已失败 {count} 次，考虑换工具',
    'guard.no_progress_block': '{tool} 返回相同结果 {count} 次，无进展',
    'guard.no_progress_warn': '{tool} 返回相同结果 {count} 次',

    'lang.instruction': '请始终使用{lang}回复。所有解释、注释和与用户的交流使用{lang}。技术术语和代码标识符保持原样。',
  },

  ja: {
    'exec.gpt.title': '# 実行規律 (GPT/Codex)',
    'exec.gpt.use_tools': 'タスク完了にはツールを使用してください。手順を説明するだけでなく、実行してください。',
    'exec.gpt.verify': 'ツール呼び出し後、結果を確認してから続行してください。',
    'exec.gpt.abs_path': '常に絶対パスを使用してください。ユーザーにコマンド実行を求めず、Bashツールを使用してください。',
    'exec.gpt.intent': '意図を簡潔に述べ（一文）、すぐにツールを呼び出してください。',

    'exec.gemini.title': '# 実行規律 (Gemini)',
    'exec.gemini.read_first': '編集前にReadでファイルの存在と内容を確認。書き込み後も再度Readで検証。',
    'exec.gemini.abs_path': '絶対パスを使用。依存関係の存在を確認してからインポート。',
    'exec.gemini.no_placeholder': 'プレースホルダーコードを生成しないでください。完全に実装するか、不足を説明してください。',
    'exec.gemini.execute': 'ユーザーに手順を提示するのではなく、あなたが実行してください。',

    'exec.deepseek.title': '# 実行規律 (DeepSeek)',
    'exec.deepseek.strict': 'ツール定義に厳密に従って呼び出し。ツール名を捏造しないでください。',
    'exec.deepseek.verify': '編集後に構文チェックまたはテストで検証。絶対パスを使用。',
    'exec.deepseek.serial': '依存しない読み取り専用の呼び出しは並列化し、編集・書き込み・依存するステップは1つずつ実行してください。',

    'exec.generic.title': '# 実行規律',
    'exec.generic.use_tools': 'ツールが利用可能です。タスク実行に使用してください。手順の説明だけでなく実行してください。',
    'exec.generic.verify': '変更後に検証してください。絶対パスを使用。',
    'exec.generic.intent': '意図を簡潔に述べ、すぐにツールを呼び出してください。',

    'guard.exact_fail_block': '{tool} は同じ引数で {count} 回失敗しました。別の引数またはツールをお試しください',
    'guard.exact_fail_warn': '{tool} は同じ引数で {count} 回失敗しました。引数の変更を検討してください',
    'guard.tool_fail_halt': '{tool} は合計 {count} 回失敗しました。ループを終了します',
    'guard.tool_fail_warn': '{tool} は {count} 回失敗しました。別のツールを検討してください',
    'guard.no_progress_block': '{tool} は {count} 回同じ結果を返しました。進展がありません',
    'guard.no_progress_warn': '{tool} は {count} 回同じ結果を返しました',

    'lang.instruction': '常に{lang}で回答してください。すべての説明、コメント、ユーザーとのコミュニケーションに{lang}を使用してください。技術用語とコード識別子は原文のままにしてください。',
  },

  ko: {
    'exec.gpt.title': '# 실행 규율 (GPT/Codex)',
    'exec.gpt.use_tools': '작업 완료를 위해 도구를 사용해야 합니다. 단계를 설명만 하지 말고 실행하세요.',
    'exec.gpt.verify': '도구 호출 후 결과를 확인한 다음 계속하세요.',
    'exec.gpt.abs_path': '항상 절대 경로를 사용하세요. 사용자에게 명령 실행을 요청하지 말고 Bash 도구를 사용하세요.',
    'exec.gpt.intent': '의도를 간략히 설명한 후(한 문장), 즉시 도구를 호출하세요.',

    'exec.gemini.title': '# 실행 규율 (Gemini)',
    'exec.gemini.read_first': '편집 전 Read로 파일 존재와 현재 내용을 확인하세요. 작성 후 다시 Read로 검증하세요.',
    'exec.gemini.abs_path': '절대 경로를 사용하세요. 의존성이 있는지 확인한 후 가져오세요.',
    'exec.gemini.no_placeholder': '플레이스홀더 코드를 생성하지 마세요. 완전히 구현하거나 부족한 부분을 설명하세요.',
    'exec.gemini.execute': '사용자에게 단계를 나열하지 말고 직접 실행하세요.',

    'exec.deepseek.title': '# 실행 규율 (DeepSeek)',
    'exec.deepseek.strict': '도구 정의에 따라 엄격하게 호출하세요. 도구 이름을 만들어내지 마세요.',
    'exec.deepseek.verify': '편집 후 구문 검사 또는 테스트로 검증하세요. 절대 경로를 사용하세요.',
    'exec.deepseek.serial': '서로 독립적인 읽기 전용 호출은 병렬로 실행하고, 편집·쓰기·의존 단계는 한 번에 하나씩 실행하세요.',

    'exec.generic.title': '# 실행 규율',
    'exec.generic.use_tools': '사용 가능한 도구가 있습니다. 단계를 설명하지 말고 도구를 사용하여 작업을 실행하세요.',
    'exec.generic.verify': '수정 후 변경 사항을 확인하세요. 절대 경로를 사용하세요.',
    'exec.generic.intent': '의도를 간략히 설명한 후 즉시 도구를 호출하세요.',

    'guard.exact_fail_block': '{tool}이(가) 동일한 인수로 {count}회 실패했습니다. 다른 인수나 도구를 시도하세요',
    'guard.exact_fail_warn': '{tool}이(가) 동일한 인수로 {count}회 실패했습니다. 인수 변경을 고려하세요',
    'guard.tool_fail_halt': '{tool}이(가) 총 {count}회 실패했습니다. 루프를 종료합니다',
    'guard.tool_fail_warn': '{tool}이(가) {count}회 실패했습니다. 다른 도구를 고려하세요',
    'guard.no_progress_block': '{tool}이(가) {count}회 동일한 결과를 반환했습니다. 진전이 없습니다',
    'guard.no_progress_warn': '{tool}이(가) {count}회 동일한 결과를 반환했습니다',

    'lang.instruction': '항상 {lang}으로 응답하세요. 모든 설명, 주석, 사용자와의 소통에 {lang}을 사용하세요. 기술 용어와 코드 식별자는 원문 그대로 유지하세요.',
  },
};

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Translate a prompt key into the given locale.
 * Supports {variable} interpolation in the template string.
 *
 * @param {string} key - Dot-delimited message key (e.g., 'exec.gpt.use_tools')
 * @param {string} [locale='en'] - Locale code (en, zh, ja, ko)
 * @param {object} [vars={}] - Interpolation variables: { tool: 'bash', count: 3 }
 * @returns {string} Translated string, or key if not found
 */
function t(key, locale = DEFAULT_LOCALE, vars = {}) {
  const lang = String(locale || DEFAULT_LOCALE).toLowerCase().slice(0, 2);
  const catalog = LOCALE_CATALOGS[lang] || LOCALE_CATALOGS[DEFAULT_LOCALE];
  let template = catalog[key] || LOCALE_CATALOGS[DEFAULT_LOCALE][key] || key;
  if (vars && typeof vars === 'object') {
    for (const [k, v] of Object.entries(vars)) {
      template = template.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
  }
  return template;
}

/**
 * Get all keys for a given prefix as a joined block.
 * Useful for assembling multi-line sections like model execution guidance.
 *
 * @param {string} prefix - Key prefix (e.g., 'exec.gpt')
 * @param {string} [locale='en']
 * @param {object} [vars={}]
 * @param {string} [separator='\n']
 * @returns {string}
 */
function tBlock(prefix, locale = DEFAULT_LOCALE, vars = {}, separator = '\n') {
  const lang = String(locale || DEFAULT_LOCALE).toLowerCase().slice(0, 2);
  const catalog = LOCALE_CATALOGS[lang] || LOCALE_CATALOGS[DEFAULT_LOCALE];
  const keys = Object.keys(catalog).filter(k => k.startsWith(prefix + '.'));
  if (keys.length === 0) {
    // Fallback to default locale
    const fallback = LOCALE_CATALOGS[DEFAULT_LOCALE];
    const fkeys = Object.keys(fallback).filter(k => k.startsWith(prefix + '.'));
    return fkeys.map(k => t(k, locale, vars)).join(separator);
  }
  return keys.map(k => t(k, locale, vars)).join(separator);
}

/**
 * Detect locale from a language preference string.
 * Maps common language names and codes to supported locale codes.
 *
 * @param {string} pref - Language preference (e.g., 'Chinese', 'zh-CN', 'Japanese', 'ko')
 * @returns {string} Locale code (en, zh, ja, ko)
 */
function detectLocale(pref) {
  if (!pref) return DEFAULT_LOCALE;
  const p = String(pref).toLowerCase().trim();
  if (/^(zh|chinese|中文|简体|繁體)/.test(p)) return 'zh';
  if (/^(ja|japanese|日本語)/.test(p)) return 'ja';
  if (/^(ko|korean|한국어)/.test(p)) return 'ko';
  if (/^(en|english)/.test(p)) return 'en';
  return DEFAULT_LOCALE;
}

/**
 * List all supported locale codes.
 * @returns {string[]}
 */
function supportedLocales() {
  return Object.keys(LOCALE_CATALOGS);
}

module.exports = {
  t,
  tBlock,
  detectLocale,
  supportedLocales,
  DEFAULT_LOCALE,
  LOCALE_CATALOGS,
};

/**
 * Inline image + web-rebuild intent detection and prompt construction.
 *
 * Extracted verbatim from cli/repl.js as part of the behavior-preserving
 * god-file split. Self-contained pure functions; the cluster only calls
 * within itself (extractInlineImageIntent -> buildContextualImagePrompt ->
 * isWebRebuildIntent / buildWebRebuildPrompt).
 */

function extractInlineImageIntent(input = '', sceneHint = '') {
  const text = String(input || '').trim();
  if (!text) return null;

  const pathAtom = '(?:file:\\/\\/[^"\'`<>]+?\\.(?:png|jpg|jpeg|gif|webp)|(?:[A-Za-z]:[\\\\/])[^"\'`<>]+?\\.(?:png|jpg|jpeg|gif|webp)|(?:\\/|\\.\\/|\\.\\.\\/)[^"\'`<>]+?\\.(?:png|jpg|jpeg|gif|webp))';
  const quotedPattern = new RegExp(`(["'\`])(${pathAtom})\\1`, 'i');
  const unquotedPattern = new RegExp(
    '(file:\\/\\/[^\\s"\'`<>]+?\\.(?:png|jpg|jpeg|gif|webp)|(?:[A-Za-z]:[\\\\/])[^\\s"\'`<>]+?\\.(?:png|jpg|jpeg|gif|webp)|(?:\\/|\\.\\/|\\.\\.\\/)[^\\s"\'`<>]+?\\.(?:png|jpg|jpeg|gif|webp))',
    'i'
  );

  let pathText = '';
  let matchedSpan = '';
  let idx = -1;

  const quotedMatch = quotedPattern.exec(text);
  if (quotedMatch && quotedMatch[2]) {
    pathText = quotedMatch[2];
    matchedSpan = quotedMatch[0];
    idx = quotedMatch.index;
  } else {
    const unquotedMatch = unquotedPattern.exec(text);
    if (!unquotedMatch || !unquotedMatch[1]) return null;
    pathText = unquotedMatch[1];
    matchedSpan = unquotedMatch[0];
    idx = unquotedMatch.index;
  }
  if (!pathText || idx < 0) return null;

  const promptText = `${text.slice(0, idx)} ${text.slice(idx + matchedSpan.length)}`
    .replace(/\s+/g, ' ')
    .trim();

  return {
    filePath: pathText,
    prompt: buildContextualImagePrompt(promptText, `${text} ${sceneHint}`),
  };
}

function buildImageSceneHint(sceneHint = '', history = []) {
  const base = String(sceneHint || '').trim();
  if (!Array.isArray(history) || history.length === 0) return base;

  const recentHints = history
    .slice(-10)
    .map(line => String(line || '').trim())
    .filter(Boolean)
    .filter(line => !/^\/(?:status|help|trace|usage|new|clear|exit|model|think|plan|menu)\b/i.test(line))
    .filter(line => !/^(?:paste|粘贴|clipboard|剪贴板|image|图片|img)\b/i.test(line))
    .slice(-4);

  return [base, ...recentHints].filter(Boolean).join(' ');
}

function isWebRebuildIntent(text = '') {
  const s = String(text || '').toLowerCase();
  if (!s) return false;

  const zhRebuild = /(还原|复刻|重建|仿写|临摹|转成|生成|做成|转换).*(网页|页面|网站|html|web)/;
  const zhWebFirst = /(网页|页面|网站).*(还原|复刻|重建|仿写|临摹|转成|生成|做成|转换)/;
  const enRebuild = /(rebuild|recreate|replicate|clone|convert|generate).*(web|website|webpage|html|css)/;
  const screenshotToCode = /(screenshot|image|ui).*(to|into).*(html|web|website|webpage|css)/;
  const explicitTech = /(网页截图|页面截图|website screenshot|webpage screenshot|figma).*(html|css|web|网页|页面)/;

  return zhRebuild.test(s)
    || zhWebFirst.test(s)
    || enRebuild.test(s)
    || screenshotToCode.test(s)
    || explicitTech.test(s);
}

function buildWebRebuildPrompt(rawPrompt = '') {
  const userGoal = String(rawPrompt || '').trim() || '请把这张网页截图还原成可运行网页代码。';
  return [
    userGoal,
    '',
    '请按以下要求执行：',
    '1) 先简要说明页面结构分区与视觉风格（例如 header / hero / cards / footer）；',
    '2) 输出一个可直接运行的完整 HTML（必须包含 <style>，必要时可包含少量 <script>）；',
    '3) 尽量还原布局、间距、颜色、字体层级、按钮/卡片样式与阴影；',
    '4) 页面需具备响应式能力（桌面和移动端都可用）；',
    '5) 可识别文字尽量还原，不可识别处使用 [待补文案] 占位；',
    '6) 无法确定的图片/图标资源用语义化占位，并在代码注释写 TODO；',
    '7) 最后补充“还原误差说明”和“后续微调清单”。',
    '',
    '输出格式要求：先给简短说明，再给 ```html 代码块，不要省略关键样式。',
  ].join('\n');
}

function buildContextualImagePrompt(rawPrompt = '', sceneHint = '') {
  const prompt = String(rawPrompt || '').trim();
  const normalizedPrompt = prompt
    .toLowerCase()
    .replace(/[，。！？,.!?]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const context = `${prompt} ${String(sceneHint || '')}`.toLowerCase();
  if (isWebRebuildIntent(context)) {
    return buildWebRebuildPrompt(prompt);
  }
  const genericPatterns = [
    /^请?(?:分析|看看|看下|看一下)(?:这张|这个)?(?:图片|图|截图)?$/,
    /^(?:描述|说说)(?:这张|这个)?(?:图片|图|截图)(?:的内容)?$/,
    /^(?:这|这个|这张)(?:是什么|是啥|啥)$/,
    /^analy[sz]e(?: this)? (?:image|picture|photo|screenshot)$/,
    /^describe(?: this)? (?:image|picture|photo|screenshot)$/,
    /^what(?:'s| is) this(?: image| picture| photo| screenshot)?$/,
    /^(?:look at|check)(?: this)? (?:image|picture|photo|screenshot)$/,
  ];
  const isGeneric = !prompt
    || /^(?:image|picture|photo|screenshot|图片|截图|这张图|这个图)$/.test(normalizedPrompt)
    || genericPatterns.some(pattern => pattern.test(normalizedPrompt));

  if (!isGeneric) return prompt;

  if (/(报错|错误|异常|堆栈|traceback|stack|error|exception|failed)/i.test(context)) {
    return '请先提取图片中的报错/堆栈信息，再定位可能原因，并给出可执行的修复步骤。';
  }
  if (/(界面|ui|布局|对齐|样式|css|前端|按钮|截图|页面)/i.test(context)) {
    return '请检查这张界面截图中的布局与对齐问题，指出不对称点，并给出可落地的修改建议。';
  }
  if (/(代码|终端|日志|log|command|console|diff|patch)/i.test(context)) {
    return '请识别图片里的代码/终端/日志关键信息，结合上下文判断问题，并给出下一步执行命令或改动建议。';
  }
  if (/(k线|走势|行情|图表|trading|chart|candlestick)/i.test(context)) {
    return '请分析图表中的关键趋势与风险信号，并给出清晰的操作建议。';
  }
  if (/(ocr|识别|提取文字|翻译|translate|text)/i.test(context)) {
    return '请先OCR提取图片文字，再按上下文整理要点并给出结论。';
  }

  return '请先描述图片中的关键信息，再结合当前任务上下文推断我想完成的目标，并给出下一步可执行操作。';
}

module.exports = {
  extractInlineImageIntent,
  buildImageSceneHint,
  isWebRebuildIntent,
  buildWebRebuildPrompt,
  buildContextualImagePrompt,
};

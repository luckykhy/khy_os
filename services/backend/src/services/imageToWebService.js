const fs = require('fs');
const path = require('path');
const imageService = require('./imageService');
const aiGateway = require('./gateway/aiGateway');

function isClipboardImageArg(raw = '') {
  const s = String(raw || '').trim().toLowerCase();
  return s === 'paste'
    || s === 'clipboard'
    || s === 'clip'
    || s === '粘贴'
    || s === '剪贴板';
}

function buildImage2WebPrompt(userPrompt = '') {
  const goal = String(userPrompt || '').trim() || '请把这张网页截图还原成可运行的网页。';
  return [
    goal,
    '',
    '请严格按以下要求输出：',
    '1) 先简要说明页面结构分区和视觉风格；',
    '2) 输出完整可运行的 HTML（必须包含 <style>，必要时可包含少量 <script>）；',
    '3) 尽量还原布局、间距、颜色、字体层级、按钮/卡片样式；',
    '4) 页面必须响应式（桌面和移动端可用）；',
    '5) 可识别文案尽量还原，不可识别处用 [待补文案]；',
    '6) 无法确定的图片/图标使用语义占位并写 TODO 注释；',
    '7) 最后补充“还原误差说明”和“后续微调清单”。',
    '',
    '输出格式：先给简短说明，再给一个 ```html 代码块。',
  ].join('\n');
}

function extractHtmlFromAiReply(text = '') {
  const content = String(text || '');
  if (!content.trim()) return '';

  const htmlFence = content.match(/```html\s*([\s\S]*?)```/i);
  if (htmlFence && htmlFence[1]) return String(htmlFence[1]).trim();

  const anyFence = [...content.matchAll(/```[\w-]*\s*([\s\S]*?)```/g)];
  for (const item of anyFence) {
    const block = String(item[1] || '').trim();
    if (!block) continue;
    if (/<(?:!doctype|html|head|body|style|main|section|div)\b/i.test(block)) {
      return block;
    }
  }

  if (/<(?:!doctype|html|head|body)\b/i.test(content)) {
    return content.trim();
  }
  return '';
}

function toRunnableHtml(htmlText = '') {
  const html = String(htmlText || '').trim();
  if (!html) return '';
  if (/<html[\s>]/i.test(html) || /<!doctype/i.test(html)) return html;

  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '  <meta charset="UTF-8" />',
    '  <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    '  <title>Restored Web Page</title>',
    '</head>',
    '<body>',
    html,
    '</body>',
    '</html>',
  ].join('\n');
}

function resolveOutputPath(outRaw = '', sourcePath = '', cwd = process.cwd()) {
  const normalizedCwd = path.resolve(cwd || process.cwd());
  const raw = String(outRaw || '').trim();
  if (raw) return path.resolve(normalizedCwd, raw);

  let base = 'restored-page';
  if (sourcePath) {
    const parsed = path.parse(String(sourcePath));
    if (parsed && parsed.name) base = `${parsed.name}.restored`;
  }
  return path.join(normalizedCwd, `${base}.html`);
}

function nextNonExistingPath(absPath) {
  const parsed = path.parse(absPath);
  let candidate = absPath;
  let i = 1;
  while (i < 999 && fs.existsSync(candidate)) {
    candidate = path.join(parsed.dir, `${parsed.name}-${i}${parsed.ext || '.html'}`);
    i += 1;
  }
  return candidate;
}

async function convertImageToWeb(options = {}) {
  const cwd = options.cwd || process.env.KHYQUANT_CWD || process.cwd();
  const sourcePath = String(options.imagePath || '').trim();
  const useClipboard = Boolean(options.useClipboard);
  const save = options.save !== false;
  const overwrite = Boolean(options.overwrite);
  const outRaw = String(options.outputPath || '').trim();
  const userPrompt = String(options.prompt || '').trim();

  if (!useClipboard && !sourcePath) {
    return { success: false, error: '缺少图片路径。请提供 imagePath 或设置 useClipboard=true。' };
  }

  let image;
  let resolvedSourcePath = '';
  try {
    if (useClipboard) {
      image = imageService.readImageFromClipboard();
      resolvedSourcePath = 'clipboard';
    } else {
      resolvedSourcePath = path.resolve(cwd, sourcePath);
      image = imageService.readImageFromFile(sourcePath);
    }
  } catch (err) {
    return { success: false, error: err.message || '图片读取失败' };
  }

  if (!aiGateway._initialized) {
    try { await aiGateway.init(); } catch { /* best effort */ }
  }

  const prompt = buildImage2WebPrompt(userPrompt);
  let gatewayResult;
  try {
    gatewayResult = await aiGateway.generate(prompt, {
      images: [{ base64: image.base64, mimeType: image.mimeType }],
      maxTokens: Math.max(1024, Math.min(Number(options.maxTokens) || 8192, 32768)),
      temperature: Number.isFinite(Number(options.temperature)) ? Number(options.temperature) : 0.2,
      preferredAdapter: options.preferredAdapter,
      preferredModel: options.preferredModel,
      strictPreferred: options.strictPreferred,
      taskScale: options.taskScale || 'large',
    });
  } catch (err) {
    return { success: false, error: err.message || 'AI 调用失败' };
  }

  if (!gatewayResult || !gatewayResult.success) {
    return {
      success: false,
      error: (gatewayResult && gatewayResult.content) || 'AI 未返回有效结果',
      errorType: gatewayResult && gatewayResult.errorType,
      provider: gatewayResult && gatewayResult.provider,
      model: gatewayResult && gatewayResult.model,
    };
  }

  const rawReply = String(gatewayResult.content || '').trim();
  const htmlRaw = extractHtmlFromAiReply(rawReply);
  if (!htmlRaw) {
    return {
      success: false,
      error: 'AI 返回中未检测到 HTML 代码块',
      rawReply,
      provider: gatewayResult.provider,
      model: gatewayResult.model,
    };
  }

  const html = toRunnableHtml(htmlRaw);
  if (!save) {
    return {
      success: true,
      html,
      saved: false,
      sourcePath: resolvedSourcePath,
      provider: gatewayResult.provider,
      model: gatewayResult.model,
      rawReply,
    };
  }

  let targetPath = resolveOutputPath(outRaw, sourcePath, cwd);
  let autoRenamed = false;
  if (fs.existsSync(targetPath) && !overwrite) {
    const alt = nextNonExistingPath(targetPath);
    if (alt !== targetPath) {
      targetPath = alt;
      autoRenamed = true;
    }
  }

  try {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, html, 'utf-8');
  } catch (err) {
    return { success: false, error: err.message || '写入文件失败', html };
  }

  return {
    success: true,
    html,
    saved: true,
    outputPath: targetPath,
    autoRenamed,
    sourcePath: resolvedSourcePath,
    provider: gatewayResult.provider,
    model: gatewayResult.model,
    rawReply,
  };
}

module.exports = {
  isClipboardImageArg,
  buildImage2WebPrompt,
  extractHtmlFromAiReply,
  toRunnableHtml,
  resolveOutputPath,
  nextNonExistingPath,
  convertImageToWeb,
};

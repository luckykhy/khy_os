// Dependency-free Markdown → HTML renderer tuned for chat bubbles. Keeps the
// APK small (no markdown-it / highlight.js). Supports the common chat subset:
// headings, bold/italic/strike, inline code, fenced code, lists, blockquotes,
// links, tables-lite, paragraphs. Model output is escaped before any HTML is
// emitted — no raw HTML injection. Fenced code blocks get a copy button wired
// by the View via the shared clipboard helper.

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function inline(text) {
  let out = escapeHtml(text);
  // Backtick code spans first (their contents are already escaped).
  out = out.replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`);
  // Bold / italic / strike.
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  // Links [text](url) — only http/https/javascript-free.
  out = out.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_, label, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`
  );
  return out;
}

function renderInline(text) {
  return inline(text);
}

export function renderMarkdown(text) {
  const source = String(text || '').replace(/\r\n/g, '\n');
  const lines = source.split('\n');
  const html = [];
  let i = 0;
  let inList = null; // 'ul' | 'ol' | null
  let inQuote = false;

  function closeList() {
    if (inList) { html.push(`</${inList}>`); inList = null; }
  }
  function closeQuote() {
    if (inQuote) { html.push('</blockquote>'); inQuote = false; }
  }

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      closeList(); closeQuote();
      const lang = fence[1] || '';
      const buf = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { buf.push(lines[i]); i += 1; }
      i += 1; // consume closing fence
      const code = escapeHtml(buf.join('\n'));
      const copyId = `copy-${Math.random().toString(36).slice(2, 8)}`;
      html.push(
        `<div class="code-block" data-copy-id="${copyId}"${lang ? ` data-lang="${escapeHtml(lang)}"` : ''}>` +
        `<button type="button" class="code-copy" data-copy-target="${copyId}">复制</button>` +
        `<pre><code>${code}</code></pre></div>`
      );
      continue;
    }

    // Headings
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      closeList(); closeQuote();
      const level = Math.min(heading[1].length, 4);
      html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    // Unordered / ordered lists
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      const type = ul ? 'ul' : 'ol';
      if (inList !== type) { closeList(); html.push(`<${type}>`); inList = type; }
      html.push(`<li>${renderInline((ul || ol)[1])}</li>`);
      i += 1;
      continue;
    }
    closeList();

    // Blockquote
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      if (!inQuote) { html.push('<blockquote>'); inQuote = true; }
      html.push(`<p>${renderInline(quote[1])}</p>`);
      i += 1;
      continue;
    }
    closeQuote();

    // Horizontal rule
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      html.push('<hr>');
      i += 1;
      continue;
    }

    // Blank line ends paragraph
    if (!line.trim()) {
      if (inQuote) { html.push('</blockquote>'); inQuote = false; }
      i += 1;
      continue;
    }

    // Paragraph (consume consecutive non-empty lines)
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^```/.test(lines[i]) && !/^#{1,4}\s/.test(lines[i])) {
      const l = lines[i];
      if (/^\s*[-*+]\s+/.test(l) || /^\s*\d+[.)]\s+/.test(l) || /^>\s?/.test(l) || /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(l)) break;
      para.push(l);
      i += 1;
    }
    if (para.length) html.push(`<p>${renderInline(para.join(' '))}</p>`);
  }

  closeList(); closeQuote();
  return html.join('');
}

export async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  // Fallback for Capacitor WebView where the async clipboard API may be absent.
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}

export const useMarkdown = { render: renderMarkdown, copyText };

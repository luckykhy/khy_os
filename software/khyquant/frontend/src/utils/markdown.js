/**
 * Markdown rendering utility for AI chat messages.
 *
 * Pipeline: marked parse → highlight.js code coloring → DOMPurify sanitize
 *           → code-block copy-button injection.
 *
 * Modelled after OpenClaw ui/src/ui/markdown.ts, adapted for Vue 3.
 */
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/core'

// Register commonly used languages (tree-shakeable)
import javascript from 'highlight.js/lib/languages/javascript'
import python from 'highlight.js/lib/languages/python'
import bash from 'highlight.js/lib/languages/bash'
import json from 'highlight.js/lib/languages/json'
import sql from 'highlight.js/lib/languages/sql'
import css from 'highlight.js/lib/languages/css'
import xml from 'highlight.js/lib/languages/xml'
import typescript from 'highlight.js/lib/languages/typescript'
import java from 'highlight.js/lib/languages/java'
import cpp from 'highlight.js/lib/languages/cpp'

hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('js', javascript)
hljs.registerLanguage('python', python)
hljs.registerLanguage('py', python)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('sh', bash)
hljs.registerLanguage('shell', bash)
hljs.registerLanguage('json', json)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('css', css)
hljs.registerLanguage('html', xml)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('ts', typescript)
hljs.registerLanguage('java', java)
hljs.registerLanguage('cpp', cpp)
hljs.registerLanguage('c', cpp)

// Configure marked renderer for code blocks with language labels + copy buttons
const renderer = new marked.Renderer()

renderer.code = function (code, lang) {
  // marked v14+ passes { text, lang } object; handle both shapes
  let text = code
  let language = lang
  if (typeof code === 'object' && code !== null) {
    text = code.text ?? code.raw ?? ''
    language = code.lang ?? lang ?? ''
  }
  language = (language || '').trim().toLowerCase()
  const displayLang = language || 'text'

  let highlighted
  if (language && hljs.getLanguage(language)) {
    highlighted = hljs.highlight(text, { language }).value
  } else {
    highlighted = hljs.highlightAuto(text).value
  }

  return (
    `<pre class="code-block">` +
      `<div class="code-header">` +
        `<span class="code-lang">${displayLang}</span>` +
        `<button class="copy-btn" data-copy>Copy</button>` +
      `</div>` +
      `<code class="hljs language-${displayLang}">${highlighted}</code>` +
    `</pre>`
  )
}

marked.setOptions({
  renderer,
  breaks: true,
  gfm: true,
})

// ---- LRU-ish render cache (Map preserves insertion order) ----
const cache = new Map()
const MAX_CACHE = 200

// Allowed tags/attrs for DOMPurify
const PURIFY_CONFIG = {
  ALLOWED_TAGS: [
    'p', 'br', 'strong', 'em', 'code', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li', 'a', 'blockquote', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'span', 'div', 'img', 'hr', 'del', 'sup', 'sub', 'button',
  ],
  ALLOWED_ATTR: ['href', 'src', 'alt', 'class', 'target', 'rel', 'data-copy'],
  ADD_ATTR: ['target'],
}

/**
 * Render a Markdown string to sanitized HTML with syntax-highlighted code blocks.
 *
 * @param {string} text  Raw markdown text
 * @returns {string}     Safe HTML string
 */
export function renderMarkdown(text) {
  if (!text) return ''

  const cached = cache.get(text)
  if (cached) return cached

  const html = marked.parse(text)
  const clean = DOMPurify.sanitize(html, PURIFY_CONFIG)

  // Evict oldest entry when cache is full
  if (cache.size >= MAX_CACHE) {
    cache.delete(cache.keys().next().value)
  }
  cache.set(text, clean)

  return clean
}

/**
 * Attach click listeners for copy buttons inside a container element.
 * Call this after Vue has rendered the markdown HTML into the DOM (e.g. in onUpdated).
 *
 * @param {HTMLElement} container
 */
export function attachCopyListeners(container) {
  if (!container) return
  container.querySelectorAll('.code-block .copy-btn[data-copy]').forEach((btn) => {
    if (btn._copyBound) return
    btn._copyBound = true
    btn.addEventListener('click', () => {
      const code = btn.closest('.code-block')?.querySelector('code')
      if (!code) return
      navigator.clipboard.writeText(code.textContent).then(() => {
        const prev = btn.textContent
        btn.textContent = 'Copied!'
        btn.classList.add('copied')
        setTimeout(() => {
          btn.textContent = prev
          btn.classList.remove('copied')
        }, 2000)
      })
    })
  })
}

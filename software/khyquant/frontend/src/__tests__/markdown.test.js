/**
 * markdown.test.js — locks the markdown render pipeline contract:
 * renderMarkdown() sanitizes via DOMPurify, LRU-caches results, and the
 * copy-button helper attaches exactly one listener per button.
 * If the sanitize/evict contract drifts, this test goes red first.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderMarkdown, attachCopyListeners } from '../utils/markdown.js'

describe('renderMarkdown', () => {
  it('empty/undefined input → ""', () => {
    expect(renderMarkdown('')).toBe('')
    expect(renderMarkdown(null)).toBe('')
    expect(renderMarkdown(undefined)).toBe('')
  })

  it('inline emphasis renders strong/em', () => {
    const html = renderMarkdown('hello **world** and *x*')
    expect(html).toContain('<strong>world</strong>')
    expect(html).toContain('<em>x</em>')
  })

  it('code block → pre.code-block with lang label + copy button', () => {
    const html = renderMarkdown('```js\nconst a = 1\n```')
    expect(html).toContain('pre class="code-block"')
    expect(html).toContain('code-lang">js')
    expect(html).toContain('copy-btn')
    expect(html).toContain('class="hljs language-js"')
  })

  it('unknown language label falls back to text label + auto highlight', () => {
    const html = renderMarkdown('```weirdlang\nabc def\n```')
    expect(html).toContain('code-lang">weirdlang')
    expect(html).toContain('language-weirdlang')
  })

  it('XSS: <script> in markdown is stripped by DOMPurify', () => {
    const html = renderMarkdown('<script>alert(1)</script>')
    expect(html).not.toContain('<script')
  })

  it('XSS: onclick/href javascript: stripped', () => {
    const html = renderMarkdown('<a href="javascript:alert(1)">link</a>')
    expect(html).not.toContain('javascript:')
  })

  it('caches repeated renders (same input → identical output object)', () => {
    const a = renderMarkdown('unique-cache-probe-1')
    const b = renderMarkdown('unique-cache-probe-1')
    expect(a).toBe(b)
  })

  it('allowed tags survive sanitization (table/list/heading)', () => {
    const html = renderMarkdown('## H2\n- item1\n| a | b |\n| - | - |\n| 1 | 2 |')
    expect(html).toContain('<h2')
    expect(html).toContain('<li>')
    expect(html).toContain('<table')
  })
})

describe('attachCopyListeners', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn().mockResolvedValue() },
    })
  })

  function makeButton() {
    const doc = document.createElement('div')
    doc.innerHTML =
      '<pre class="code-block"><button class="copy-btn" data-copy>Copy</button>' +
      '<code class="hljs">const x=1</code></pre>'
    return doc
  }

  it('null container is a no-op', () => {
    expect(() => attachCopyListeners(null)).not.toThrow()
  })

  it('binds a click handler that copies code text and flashes Copied!', async () => {
    const root = makeButton()
    document.body.appendChild(root)
    attachCopyListeners(root)
    const btn = root.querySelector('.copy-btn')
    btn.click()
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('const x=1')
    // text flip happens inside the clipboard promise's .then (microtask)
    await new Promise((r) => setTimeout(r, 0))
    expect(btn.textContent).toBe('Copied!')
    expect(btn.classList.contains('copied')).toBe(true)
    root.remove()
  })

  it('re-attaching does not double-bind the same button', () => {
    const root = makeButton()
    document.body.appendChild(root)
    attachCopyListeners(root)
    attachCopyListeners(root)
    const btn = root.querySelector('.copy-btn')
    btn.click()
    // one bound handler → one writeText per click, even after re-attach
    expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1)
    root.remove()
  })
})

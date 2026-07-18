// entry.mjs — khyos ⇆ MarkText muya embed entry.
//
// Bundled by build.mjs (esbuild) into ../vendor/ as a self-contained offline asset,
// served same-origin by khyos-md-bridge.js. Registers muya's UI plugins once and
// exposes a small global factory window.KhyMuya used by khyosMarkdown.html.
//
// Installed @muyajs/core@0.2.0 export surface (verified):
//   - Muya, MarkdownToHtml
//   - plugins: EmojiSelector, FootnoteTool, InlineFormatToolbar, ImageEditTool,
//     ImageToolBar, ImageResizeBar, CodeBlockLanguageSelector, LinkTools,
//     ParagraphFrontButton, ParagraphFrontMenu, ParagraphQuickInsertMenu,
//     TableColumnToolbar, TableDragBar, TableRowColumMenu, PreviewToolBar
//     (note: this version does NOT export TableChessboard)
//   - locales: en, zh (this version ships only these two)

import {
  Muya,
  MarkdownToHtml,
  EmojiSelector,
  FootnoteTool,
  InlineFormatToolbar,
  ImageEditTool,
  ImageToolBar,
  ImageResizeBar,
  CodeBlockLanguageSelector,
  LinkTools,
  ParagraphFrontButton,
  ParagraphFrontMenu,
  ParagraphQuickInsertMenu,
  TableColumnToolbar,
  TableDragBar,
  TableRowColumMenu,
  PreviewToolBar,
  en,
  zh,
} from '@muyajs/core';
import '@muyajs/core/lib/core.css';

// Register UI plugins once (global side effect — must precede any `new Muya`).
Muya.use(EmojiSelector);
Muya.use(FootnoteTool);
Muya.use(InlineFormatToolbar);
Muya.use(ImageEditTool);
Muya.use(ImageToolBar);
Muya.use(ImageResizeBar);
Muya.use(CodeBlockLanguageSelector);
Muya.use(LinkTools, {
  jumpClick: (info) => {
    const href = info && info.href;
    if (href && /^https?:\/\//.test(href)) {
      window.open(href, '_blank', 'noopener,noreferrer');
    }
  },
});
Muya.use(ParagraphFrontButton);
Muya.use(ParagraphFrontMenu);
Muya.use(ParagraphQuickInsertMenu);
Muya.use(TableColumnToolbar);
Muya.use(TableDragBar);
Muya.use(TableRowColumMenu);
Muya.use(PreviewToolBar);

const LOCALES = { en, zh };

/**
 * Create a muya WYSIWYG editor.
 * @param {HTMLElement} container
 * @param {{markdown?:string, locale?:string, muyaOptions?:object}} [opts]
 * @returns {Muya}
 */
function create(container, opts = {}) {
  const options = {
    markdown: String((opts && opts.markdown) || ''),
    ...((opts && opts.muyaOptions) || {}),
  };
  const m = new Muya(container, options);
  const key = opts && opts.locale && LOCALES[opts.locale] ? opts.locale : 'zh';
  try { m.locale(LOCALES[key]); } catch (_) { /* locale is best-effort */ }
  m.init();
  return m;
}

/** Render markdown → static HTML string (used for print/export). */
function toHtml(markdown) {
  try { return new MarkdownToHtml(String(markdown || '')).generate(); } catch (_) { return ''; }
}

window.KhyMuya = {
  create,
  toHtml,
  Muya,
  MarkdownToHtml,
  locales: Object.keys(LOCALES),
  version: '0.2.0',
};

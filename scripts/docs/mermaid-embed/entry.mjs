// entry.mjs — 把 mermaid 的 ESM 默认导出挂到全局。
//
// 消费契约（改这里前先看这两处）：
//   scripts/docs/build_docs_site.js:554  <script src="…/mermaid.min.js"></script>
//   docs/_assets/docs-site.js:401-414    读 window.mermaid.{initialize,run,init}
// 生成的页面用传统 <script> 标签加载，不是 module，所以必须落到全局对象上。
import mermaid from 'mermaid';

globalThis.mermaid = mermaid;

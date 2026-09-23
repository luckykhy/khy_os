// Auto-generated shim - re-exports from new domain location
// Do not edit - move services/backend/src/services/domain/structured/typeset instead

// Spread each domain module so historical flat destructuring keeps working:
//   `const { markdownToAst, scanFormatCodes, DEC_DOUBLE_WIDTH } =
//    require('../services/typeset')`
// must still receive the individual FUNCTION/VALUE exports of each domain
// module, not bare module objects (a plain `exports.x = require(...)` would
// leave the module object behind, breaking flat destructure at the call site).
//
// On top of the flat spread, each module is ALSO exposed under its own file
// basename (without .js) — `textEmphasisPolicy`, `markdownToAst`,
// `styleTemplates`, `contentSchema` — because historical call sites written
// against the pre-split flat module (e.g. cli/markdownRenderer.js's
// `require('../services/typeset').textEmphasisPolicy.bigHeadingPrefix(...)`)
// reach for the alias. Without that alias the flat spread of textEmphasisPolicy's
// own exports cannot provide a `.textEmphasisPolicy` key (its exports are the
// leaf functions like `bigHeadingPrefix`, `shouldBoldHeading` — not a
// self-referencing nested object), so the old call shape would read
// `undefined.bigHeadingPrefix` and throw at first use.
//
// The two layers coexist without collision by construction: the flat keys are
// the leaf names (bigHeadingPrefix, markdownToAst-FUNCTION, scanFormatCodes…),
// the alias keys are the file basenames (textEmphasisPolicy, markdownToAst-
// MODULE, contentSchema, styleTemplates). The ONE name that exists in both
// (the `markdownToAst` leaf function AND the `markdownToAst` module object)
// is intentional: the module object is the alias-of-record, and the flat
// function form remains reachable via that module object's own
// `.markdownToAst` property, so `require('…/typeset').markdownToAst.md…`
// (module-then-function) and `require('…/typeset').markdownToAst(…)` (direct
// call, the pre-split historical shape) BOTH keep working — we assign the
// function first, then overwrite with the module object, and re-attach the
// function onto the module object itself so both reach the same code.
const contentSchema = require('../domain/structured/typeset/contentSchema.js');
const markdownToAstModule = require('../domain/structured/typeset/markdownToAst.js');
const styleTemplates = require('../domain/structured/typeset/styleTemplates.js');
const textEmphasisPolicy = require('../domain/structured/typeset/textEmphasisPolicy.js');

const flat = {
  ...contentSchema,
  ...markdownToAstModule,
  ...styleTemplates,
  ...textEmphasisPolicy,
};

// Pre-split historical shape: `markdownToAst` is called directly as a function.
// The spread above already placed the module's flat function export here under
// that name only if markdownToAst.js happens to name-EXPORT a function called
// `markdownToAst`; re-verify and pin it so the alias object can't shadow the
// callable historical form.
const markdownToAstFn =
  typeof flat.markdownToAst === 'function'
    ? flat.markdownToAst
    : markdownToAstModule.markdownToAst;
if (markdownToAstFn && markdownToAstModule.markdownToAst !== markdownToAstFn) {
  // Defensive: keep both the direct-call form and the module-then-function
  // form pointing at the SAME implementation so the two reach the same code.
  markdownToAstModule.markdownToAst = markdownToAstFn;
}

module.exports = {
  ...flat,
  markdownToAst: markdownToAstFn, // pin the historical direct-call shape first…
  contentSchema, // …then the stable file-basename aliases
  markdownToAstModule,
  styleTemplates,
  textEmphasisPolicy,
};
// Re-expose the module under its historical flat name too, so
// `require('…/typeset').markdownToAst(…)` (direct call) still works alongside
// `require('…/typeset').markdownToAst.markdownToAst` (module-then-function).
module.exports.markdownToAstModule = markdownToAstModule;
// Convenience: the leaf function under its own leaf name, in case a caller
// destructure-imported `{ markdownToAst }` historically expecting the function
// (this is already `markdownToAstFn` above via the flat pin, so no separate
// key needed — documented here only to prevent a future "cleanup" from
// accidentally dropping the pin).

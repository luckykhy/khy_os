'use strict';
/* Temporary verification for the small-step splitting + truncation recovery feature. Delete after use. */
const {
  buildLongOutputSegmentDirective,
  injectPlanningPrompt,
} = require('./src/services/taskComplexity');
const templates = require('./src/services/smallModelPromptTemplates');
const mr = require('./src/services/domain/query/query/maxTokensRecovery');

console.log('== long-output segment directive (deterministic precheck) ==');
const cases = [
  ['讲个故事', 8192],
  ['写一篇3000字的故事', 8192],
  ['写一篇1万字的小说', 8192],
  ['写一篇2万字以上的小说', 8192],
  ['来个长篇故事', 8192],
  ['写个小说', 8192],
  ['写一篇8000字的报告', 16384],
  ['把这段话翻译成英文', 8192],
];
for (const [msg, maxTokens] of cases) {
  const d = buildLongOutputSegmentDirective(msg, { maxTokens });
  console.log(
    `- "${msg}" (maxTokens=${maxTokens}): ${d ? 'INJECT ' + d.slice(0, 60) + '…' : 'skip'}`
  );
}

console.log('\n== gate off ==');
console.log(
  'explicit long ask with unknown budget:',
  buildLongOutputSegmentDirective('写一篇1万字的小说', {}) === '',
  '(expect true)'
);

console.log('\n== T3 compact planning carries small-step line ==');
const t3 = templates.buildPhasePrompt('PHASE_PLANNING', { tier: 'T3', taskType: 'code' });
console.log('small-step line present:', t3.includes('小步执行'), '(expect true)');
console.log('length', t3.length, '<= cap', templates.T3_TEMPLATE_MAX_CHARS, t3.length <= templates.T3_TEMPLATE_MAX_CHARS, '(expect true)');

console.log('\n== planning prompt: segment hint on every branch ==');
for (const opts of [
  { multiOption: true, autoDecompose: true },
  { multiOption: false, autoDecompose: true },
  { multiOption: false, autoDecompose: false },
]) {
  const out = injectPlanningPrompt('TASK', opts);
  console.log(
    `multiOption=${!!opts.multiOption} autoDecompose=${!!opts.autoDecompose} -> segmentHint=${out.includes('output limit')}`,
    '(expect true)'
  );
}
// T3 path via modelTier
const t3Injected = injectPlanningPrompt('TASK', { modelTier: 'T3', autoDecompose: true });
console.log('T3 planning uses compact template:', t3Injected.includes('小步执行'), '(expect true)');

console.log('\n== maxTokensRecovery primitives (shared by new recovery loop) ==');
console.log(
  'isTruncationStop(length):',
  mr.isTruncationStop('length'),
  '| isTruncationStop(max_tokens):',
  mr.isTruncationStop('max_tokens'),
  '| isTruncationStop(stop):',
  mr.isTruncationStop('stop'),
  '| isTruncationStop(interrupted):',
  mr.isTruncationStop('interrupted')
);
const rec1 = mr.shouldRecover('length', 0, 8192, { maxOutputTokens: 64000, contextWindow: 128000, promptEstimate: 20000 });
console.log('shouldRecover escalates:', rec1 && rec1.shouldEscalate, 'nextMax:', rec1 && rec1.nextMax, '(expect true / 64000)');
const rec2 = mr.shouldRecover('length', 3, 8192, {});
console.log('attempts exhausted:', rec2 === null, '(expect true)');
console.log(
  'continuation prompt has tail anchor:',
  mr.buildContinuationPrompt('x'.repeat(400)).includes('已输出片段结尾'),
  '(expect true)'
);
console.log(
  'negligible/repetitive guards callable:',
  typeof mr.isNegligibleContinuation === 'function' && typeof mr.isRepetitiveContinuation === 'function',
  '(expect true)'
);

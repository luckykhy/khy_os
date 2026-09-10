#!/usr/bin/env node
/**
 * check-frontend-tokens — design-token drift gate for apps/ai-frontend.
 *
 * The frontend used to spell colours inline: 291 hex literals, 85 rgba() calls,
 * 135 static style="..." attributes and 9 :style="{...}" bindings, most of them
 * in a handful of views (KhyFloatBall, Markdown, AIGateway, AIChat). Every one
 * of those literals is a private re-implementation of a --khy-* / --el-* token
 * and it drifts silently when the theme changes.
 *
 * This gate pins the current counts in frontend-tokens.baseline.json and fails
 * if they grow. A new page must declare colours through tokens; if it cannot,
 * the baseline has to be lowered in the same change, which forces a real
 * tokenisation review instead of silently absorbing the regression.
 *
 * Usage:
 *   node scripts/ci/check-frontend-tokens.js            # compare to baseline
 *   node scripts/ci/check-frontend-tokens.js --write     # refresh baseline
 *   node scripts/ci/check-frontend-tokens.js --json      # dump counts only
 *
 * Exit 0 when within baseline, 1 when it grew (or the baseline is missing).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const FRONTEND = path.join(ROOT, 'apps', 'ai-frontend', 'src');
const BASELINE = path.join(__dirname, '..', 'frontend-tokens.baseline.json');

// The token file itself is the vocabulary definition, not a consumer: its hex and
// rgba literals are the single place a colour may be spelled out. Scanning it
// against the same budget would make the gate un-improvable.
const THEME_PATH = path.join(FRONTEND, 'styles', 'newapi-theme.css');

const HEX_RE = /#[0-9a-fA-F]{3,8}\b/g;
const RGBA_RE = /\b(?:rgba?|hsla?)\(/g;
const STATIC_STYLE_RE = /\sstyle\s*=\s*"/g;
const BIND_STYLE_RE = /\s:style\s*=\s*/g;

const args = new Set(process.argv.slice(2));
const writeMode = args.has('--write');
const jsonOnly = args.has('--json');

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.(vue|js|mjs|css|scss)$/.test(entry.name)) out.push(p);
  }
  return out;
}

function countIn(text, re) {
  const m = text.match(re);
  return m ? m.length : 0;
}

function measure() {
  const counts = { hex: 0, rgba: 0, staticStyle: 0, bindStyle: 0 };
  const perFile = [];

  for (const p of walk(FRONTEND, [])) {
    if (p === THEME_PATH) continue;
    const text = fs.readFileSync(p, 'utf8');
    const c = {
      hex: countIn(text, HEX_RE),
      rgba: countIn(text, RGBA_RE),
      staticStyle: countIn(text, STATIC_STYLE_RE),
      bindStyle: countIn(text, BIND_STYLE_RE),
    };
    const total = c.hex + c.rgba + c.staticStyle + c.bindStyle;
    if (!total) continue;
    for (const key of ['hex', 'rgba', 'staticStyle', 'bindStyle']) {
      counts[key] += c[key];
    }
    perFile.push({ file: path.relative(FRONTEND, p).replace(/\\/g, '/'), ...c });
  }

  perFile.sort((a, b) => {
    const ta = a.hex + a.rgba + a.staticStyle + a.bindStyle;
    const tb = b.hex + b.rgba + b.staticStyle + b.bindStyle;
    return tb - ta;
  });
  return { counts, perFile };
}

const { counts, perFile } = measure();

if (jsonOnly) {
  console.log(JSON.stringify({ counts, top: perFile.slice(0, 12) }, null, 2));
  process.exit(0);
}

if (writeMode) {
  const baseline = {
    note: 'Design-token drift budget. Values may only decrease. See check-frontend-tokens.js.',
    themeExcluded: 'apps/ai-frontend/src/styles/newapi-theme.css',
    ...counts,
  };
  fs.writeFileSync(BASELINE, JSON.stringify(baseline, null, 2) + '\n');
  console.log('baseline written: ' + path.relative(ROOT, BASELINE));
  console.log(counts.hex + ' hex, ' + counts.rgba + ' rgba, '
    + counts.staticStyle + ' static style=, ' + counts.bindStyle + ' :style=');
  process.exit(0);
}

if (!fs.existsSync(BASELINE)) {
  console.error('No baseline at ' + path.relative(ROOT, BASELINE));
  console.error('Run: node scripts/ci/check-frontend-tokens.js --write');
  process.exit(1);
}

const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
let failed = false;
for (const key of ['hex', 'rgba', 'staticStyle', 'bindStyle']) {
  const actual = counts[key];
  const allowed = base[key];
  const mark = actual > allowed ? 'FAIL' : 'ok  ';
  if (actual > allowed) failed = true;
  console.log('[' + mark + '] ' + key.padEnd(12) + ' ' + String(actual).padStart(4)
    + ' / baseline ' + allowed + (actual > allowed ? '  (+' + (actual - allowed) + ')' : ''));
}

if (failed) {
  console.error('\nToken budget exceeded. Use var(--khy-*) / var(--el-*) instead of literal '
    + 'colours, or lower the baseline in the same change after reviewing the new literals.');
  process.exit(1);
}

console.log('\nToken budget held (' + counts.hex + ' hex, ' + counts.rgba + ' rgba, '
  + counts.staticStyle + ' style=, ' + counts.bindStyle + ' :style=).');
process.exit(0);

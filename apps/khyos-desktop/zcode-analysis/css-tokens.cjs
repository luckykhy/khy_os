// Extract CSS custom properties from a (minified) stylesheet, grouped by selector.
// Usage: node css-tokens.cjs <style.css>
const fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');

// Split into top-level rules: selector { body }
const rules = [];
let i = 0;
while (i < src.length) {
  const open = src.indexOf('{', i);
  if (open === -1) break;
  let depth = 1;
  let j = open + 1;
  while (j < src.length && depth > 0) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') depth--;
    j++;
  }
  const selector = src.slice(i, open).trim();
  const body = src.slice(open + 1, j - 1);
  if (selector) rules.push([selector, body]);
  i = j;
}

const varRe = /(--[a-zA-Z0-9_-]+)\s*:\s*([^;{}]+);/g;
const totalVars = new Set();
for (const [sel, body] of rules) {
  const found = [];
  let m;
  varRe.lastIndex = 0;
  while ((m = varRe.exec(body))) {
    found.push([m[1], m[2].trim()]);
    totalVars.add(m[1]);
  }
  if (found.length) {
    console.log(`\n### ${sel}`);
    for (const [k, v] of found) console.log(`  ${k}: ${v};`);
  }
}
console.error(`\n--- ${rules.length} rules, ${totalVars.size} distinct custom properties ---`);

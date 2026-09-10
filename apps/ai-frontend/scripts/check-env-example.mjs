#!/usr/bin/env node
// check-env-example.mjs — .env.example must describe reality in both directions.
//
// The file previously advertised VITE_API_BASE_URL on port 5000, which nothing
// reads and no process listens on. The app fell back to same-origin and the
// template quietly described a different deployment. This script fails on:
//
//   1. an env var listed in .env.example that src/ never reads (a phantom
//      knob — someone will set it, expect an effect, and get none);
//   2. an env var read by src/ but absent from .env.example (an undiscoverable
//      one — the next person hits the same problem again).
//
// Vite only exposes VITE_-prefixed vars, so non-VITE_ names in the template are
// skipped rather than reported.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(ROOT, 'src');
const TEMPLATE = join(ROOT, '.env.example');

const EXTENSIONS = new Set(['.js', '.mjs', '.ts', '.vue']);

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
      continue;
    }
    if (EXTENSIONS.has(full.slice(full.lastIndexOf('.')).toLowerCase())) yield full;
  }
}

const ENV_RE = /\bVITE_[A-Z0-9_]+\b/g;

const referenced = new Map();
for (const file of walk(SRC)) {
  const text = readFileSync(file, 'utf8');
  const found = text.match(ENV_RE);
  if (!found) continue;
  for (const name of new Set(found)) {
    if (!referenced.has(name)) referenced.set(name, new Set());
    referenced.get(name).add(relative(ROOT, file).replaceAll('\\', '/'));
  }
}

const templateText = readFileSync(TEMPLATE, 'utf8');
// Strip comments so a mentioned-but-deprecated name is not counted as declared.
const declaredLines = templateText
  .split('\n')
  .filter((line) => !/^\s*#/.test(line) && /\S/.test(line));
const declared = new Set();
for (const line of declaredLines) {
  const match = line.match(/^\s*([A-Z][A-Z0-9_]*)=/);
  if (match) declared.add(match[1]);
}

const problems = [];

for (const name of declared) {
  if (!referenced.has(name)) {
    problems.push({
      kind: 'phantom',
      name,
      detail: '模板声明了它，但 src/ 里没有任何地方读取',
    });
  }
}

for (const name of referenced.keys()) {
  if (!declared.has(name)) {
    const sites = [...referenced.get(name)].sort().slice(0, 4).join(', ');
    problems.push({
      kind: 'undocumented',
      name,
      detail: `src/ 读取了它（${sites}），但模板没有列出`,
    });
  }
}

console.log('前端 .env.example 漂移检查：');
console.log(`  模板声明: ${declared.size}    src/ 实际读取: ${referenced.size}`);

if (problems.length === 0) {
  console.log('result: 模板与实际读取完全一致，无漂移。');
  process.exit(0);
}

for (const problem of problems.sort((a, b) => a.name.localeCompare(b.name))) {
  const label = problem.kind === 'phantom' ? '幽灵变量' : '未登记变量';
  console.log(`  [${label}] ${problem.name} — ${problem.detail}`);
}
console.log(`\nresult: ${problems.length} 项漂移。修掉模板或补登记后重跑。`);
process.exit(1);

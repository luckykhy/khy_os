#!/usr/bin/env node
/**
 * @pattern Visitor, Template Method
 *
 * CI 验证脚本 — 确保所有源文件都在 pattern-registry.json 中
 * 且每种 GoF 模式至少被使用一次。
 *
 * 用法: node scripts/ci/check-pattern-coverage.js
 * 退出码: 0 = 通过, 1 = 失败
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const REGISTRY_PATH = path.join(ROOT, 'docs', '_设计模式', '模式注册表.json');

const ALL_23 = [
  'Singleton', 'Factory Method', 'Abstract Factory', 'Builder', 'Prototype',
  'Adapter', 'Bridge', 'Composite', 'Decorator', 'Facade', 'Flyweight', 'Proxy',
  'Chain of Responsibility', 'Command', 'Interpreter', 'Iterator', 'Mediator',
  'Memento', 'Observer', 'State', 'Strategy', 'Template Method', 'Visitor',
];

const EXTENSIONS = ['js', 'vue', 'ts', 'c', 'h', 'py', 'asm', 'sh', 'ps1', 'mbt', 'css'];
const EXCLUDE_DIRS = [
  'node_modules', '.git', 'dist', 'build', '.khy-runtime',
  'services/backend/tests', 'platform/packages/sdk/tests', 'tests/unit', 'tests/api',
  'scripts/ab-traces', 'kernel/build', 'frontend/src/assets',
  '_build', 'frontend/android', 'docs/_模板',
];

// 扫描所有源文件
function scanSourceFiles() {
  const extGlob = EXTENSIONS.map(e => `-name "*.${e}"`).join(' -o ');
  const excludeGlob = EXCLUDE_DIRS.map(d => `! -path "*/${d}/*"`).join(' ');
  const cmd = `find . -type f \\( ${extGlob} \\) ${excludeGlob}`;
  const raw = execSync(cmd, { cwd: ROOT, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  return raw.trim().split('\n').map(f => f.replace(/^\.\//, '')).filter(Boolean).sort();
}

// 主逻辑
function main() {
  if (!fs.existsSync(REGISTRY_PATH)) {
    console.error('❌ pattern-registry.json 不存在');
    console.error(`   期望路径: ${REGISTRY_PATH}`);
    process.exit(1);
  }

  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  const sourceFiles = scanSourceFiles();

  let errors = 0;
  const uncoveredFiles = [];
  const emptyPatternFiles = [];
  const usedPatterns = new Set();
  const invalidPatterns = [];

  for (const f of sourceFiles) {
    if (!registry[f]) {
      uncoveredFiles.push(f);
      errors++;
    } else if (!Array.isArray(registry[f]) || registry[f].length === 0) {
      emptyPatternFiles.push(f);
      errors++;
    } else {
      for (const p of registry[f]) {
        usedPatterns.add(p);
        if (!ALL_23.includes(p)) {
          invalidPatterns.push({ file: f, pattern: p });
          errors++;
        }
      }
    }
  }

  // 检查所有 23 种模式覆盖
  const missingPatterns = ALL_23.filter(p => !usedPatterns.has(p));

  // 统计
  const stats = {};
  for (const ps of Object.values(registry)) {
    if (Array.isArray(ps)) {
      for (const p of ps) {
        stats[p] = (stats[p] || 0) + 1;
      }
    }
  }

  // 输出报告
  console.log('=== GoF 设计模式覆盖率检查 ===\n');
  console.log(`源文件总数: ${sourceFiles.length}`);
  console.log(`注册表条目: ${Object.keys(registry).length}`);
  console.log(`模式覆盖:   ${usedPatterns.size}/23`);
  console.log('');

  if (uncoveredFiles.length > 0) {
    console.log(`❌ 未覆盖文件 (${uncoveredFiles.length}):`);
    uncoveredFiles.slice(0, 20).forEach(f => console.log(`   - ${f}`));
    if (uncoveredFiles.length > 20) console.log(`   ... 及其他 ${uncoveredFiles.length - 20} 个`);
    console.log('');
  }

  if (emptyPatternFiles.length > 0) {
    console.log(`❌ 空模式列表 (${emptyPatternFiles.length}):`);
    emptyPatternFiles.slice(0, 10).forEach(f => console.log(`   - ${f}`));
    console.log('');
  }

  if (invalidPatterns.length > 0) {
    console.log(`❌ 无效模式名 (${invalidPatterns.length}):`);
    invalidPatterns.slice(0, 10).forEach(({ file, pattern }) => console.log(`   - ${file}: "${pattern}"`));
    console.log('');
  }

  if (missingPatterns.length > 0) {
    console.log(`❌ 未使用的模式: ${missingPatterns.join(', ')}`);
    console.log('');
    errors++;
  }

  // 模式分布表
  console.log('模式分布:');
  ALL_23.forEach(p => {
    const count = stats[p] || 0;
    const bar = '█'.repeat(Math.min(Math.ceil(count / 5), 40));
    console.log(`  ${p.padEnd(25)} ${String(count).padStart(4)} ${bar}`);
  });
  console.log('');

  const coverage = ((sourceFiles.length - uncoveredFiles.length) / sourceFiles.length * 100).toFixed(1);
  console.log(`覆盖率: ${coverage}%`);

  if (errors === 0) {
    console.log('\n✅ 检查通过 — 100% 覆盖，23 种模式全部使用');
    process.exit(0);
  } else {
    console.log(`\n❌ 检查失败 — ${errors} 个问题`);
    process.exit(1);
  }
}

main();

'use strict';

/**
 * @pattern Template Method, Visitor
 *
 * storage-baseline.js — 工作树 / 运行时数据的只读体积基线 CLI。
 *
 * 用法：
 *   node extensions/scripts/khy-diagnostics/storage-baseline.js          # 人类可读
 *   node extensions/scripts/khy-diagnostics/storage-baseline.js --json   # 机器可读（可入 CI 对比）
 *
 * 定位：治理动作（日志分层、checkpoint CAS、workspace 合并、dist 分离）之前和之后
 * 各跑一次，用同一口径回答「省了多少」。判定逻辑全在纯叶子 scripts/lib/storageBaseline.js；
 * 本文件只负责探测，且**严格只读**——不创建、不移动、不删除任何文件，也不把报告
 * 写进运行时数据目录（那会让基线自己污染被测对象）。
 *
 * fail-soft 纪律：任何探针（stat / readdir / JSON.parse）失败都退化为跳过该项，
 * 绝不让一次体积体检把调用方打断。
 */

const fs = require('fs');
const path = require('path');

const baseline = require('../../../scripts/lib/storageBaseline');

const ROOT = path.resolve(__dirname, '..', '..', '..');

/** 目录树字节数 + 文件计数。符号链接不跟随，避免把外部盘算进来或走进环。 */
function treeStats(dir) {
  let bytes = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        try {
          bytes += fs.statSync(full).size;
          files++;
        } catch {
          /* 文件在遍历途中消失：跳过 */
        }
      }
    }
  }
  return { bytes, files };
}

function safeSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function safeLs(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * 运行时数据家。与 services/backend 的 dataHome 解析同序，但这里刻意**不 require**
 * 那个模块：它的 getDataHome() 会创建目录，而基线必须是纯只读的。
 */
function resolveDataHome() {
  if (process.env.KHY_DATA_HOME) return path.resolve(process.env.KHY_DATA_HOME);
  const projectHome = path.join(ROOT, '.khy');
  if (fs.existsSync(projectHome)) return projectHome;
  if (process.env.KHYQUANT_DATA_HOME) return path.resolve(process.env.KHYQUANT_DATA_HOME);
  return projectHome;
}

function resolveLogRoot(dataHome) {
  if (process.env.KHY_LOG_HOME) return path.resolve(process.env.KHY_LOG_HOME);
  return path.join(dataHome, 'logs');
}

/** 日志 active/archive/legacy 三层。legacy = 根目录下未分层的残留。 */
function probeLogs(logRoot) {
  const activeStats = treeStats(path.join(logRoot, 'active'));
  const archiveDir = path.join(logRoot, 'archive');
  const archiveStats = treeStats(archiveDir);

  let emptyArchives = 0;
  for (const name of safeLs(archiveDir)) {
    if (name.endsWith('.gz') && safeSize(path.join(archiveDir, name)) === 0) emptyArchives++;
  }

  // 根层散落的文件（未走 active/archive 分层的旧布局）单独计，
  // 免得与两个子树重复计数。
  let legacyBytes = 0;
  for (const name of safeLs(logRoot)) {
    const full = path.join(logRoot, name);
    try {
      const stat = fs.statSync(full);
      if (stat.isFile()) legacyBytes += stat.size;
    } catch {
      /* skip */
    }
  }

  return {
    root: logRoot,
    activeBytes: activeStats.bytes,
    activeFiles: activeStats.files,
    archiveBytes: archiveStats.bytes,
    archiveFiles: archiveStats.files,
    emptyArchives,
    legacyBytes,
  };
}

/**
 * checkpoint 逻辑/物理。逻辑大小取 manifest entry 自报的 size；CAS entry 的
 * 逻辑量按其 objects[].size 之和算，于是「同一对象被多个 entry 引用」在逻辑侧
 * 重复计数、在物理侧只算一次 —— 差额正是去重收益。
 */
function probeCheckpoints(checkpointRoot) {
  const projects = [];
  for (const name of safeLs(checkpointRoot)) {
    const projectDir = path.join(checkpointRoot, name);
    try {
      if (!fs.statSync(projectDir).isDirectory()) continue;
    } catch {
      continue;
    }

    let manifest = null;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(projectDir, 'manifest.json'), 'utf8'));
    } catch {
      manifest = null;
    }
    const entries = manifest && Array.isArray(manifest.checkpoints) ? manifest.checkpoints : [];

    let logicalBytes = 0;
    let casEntries = 0;
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      if (Array.isArray(entry.objects) && entry.objects.length > 0) {
        casEntries++;
        for (const object of entry.objects) {
          logicalBytes += Number(object && object.size) || 0;
        }
      } else {
        logicalBytes += Number(entry.size) || 0;
      }
    }

    const objectStats = treeStats(path.join(projectDir, 'objects'));
    projects.push({
      path: projectDir,
      entries: entries.length,
      casEntries,
      objects: objectStats.files,
      logicalBytes,
      physicalBytes: treeStats(projectDir).bytes,
    });
  }
  return projects;
}

/** 顶层 node_modules 树（不递归进嵌套的 node_modules，那已计入父树）。 */
function probeDependencies() {
  const candidates = [
    '.',
    'services/backend',
    'services/ai-backend',
    'apps/ai-frontend',
    'apps/khy-mobile',
    'platform/packages/shared',
    'platform/packages/ui-shared',
    'software/khyquant/frontend',
    'tools/khyos-markdown',
    'tools/khyos-markdown/muya-embed',
    'scripts/docs/mermaid-embed',
    'extensions/tools/khy-markdown',
  ];
  const trees = [];
  for (const rel of candidates) {
    const dir = path.join(ROOT, rel, 'node_modules');
    if (!fs.existsSync(dir)) continue;
    trees.push({ path: path.posix.join(rel === '.' ? '<root>' : rel, 'node_modules'), bytes: treeStats(dir).bytes });
  }
  return trees;
}

function probeBuildOutputs() {
  const candidates = [
    'apps/ai-frontend/dist',
    'software/khyquant/frontend/dist',
    'services/backend/dist',
    'platform/khy_platform/bundled',
    'packaging/npm/bundled',
    'apps/khy-mobile/android/build',
    'apps/khy-mobile/android/app/build',
    'apps/khy-mobile/android/.gradle',
    'extensions/tools/khy-markdown/vendor',
    'publish',
    'coverage',
  ];
  const outputs = [];
  for (const rel of candidates) {
    const dir = path.join(ROOT, rel);
    if (!fs.existsSync(dir)) continue;
    outputs.push({ path: rel, bytes: treeStats(dir).bytes });
  }
  return outputs;
}

function probeLockfiles() {
  const names = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'];
  const dirs = [
    '.', 'services/backend', 'services/ai-backend', 'apps/ai-frontend', 'apps/khy-mobile',
    'platform/packages/shared', 'platform/packages/ui-shared', 'software/khyquant/frontend',
    'tools/khyos-markdown', 'tools/khyos-markdown/muya-embed', 'scripts/docs/mermaid-embed',
    'extensions/tools/khy-markdown',
  ];
  const files = [];
  for (const dir of dirs) {
    for (const name of names) {
      const full = path.join(ROOT, dir, name);
      const size = safeSize(full);
      if (size > 0) files.push({ path: path.posix.join(dir === '.' ? '<root>' : dir, name), bytes: size });
    }
  }
  return files;
}

function collect() {
  const dataHome = resolveDataHome();
  const logRoot = resolveLogRoot(dataHome);
  const checkpointRoot = path.join(dataHome, 'checkpoints');
  return {
    dataHome,
    logs: probeLogs(logRoot),
    checkpoints: probeCheckpoints(checkpointRoot),
    dependencies: probeDependencies(),
    buildOutputs: probeBuildOutputs(),
    lockfiles: probeLockfiles(),
  };
}

function main() {
  const asJson = process.argv.includes('--json');
  const facts = collect();
  const summary = baseline.summarize(facts);

  if (asJson) {
    console.log(JSON.stringify({ dataHome: facts.dataHome, summary }, null, 2));
    return;
  }

  console.log('Khy-OS storage baseline (read-only)');
  console.log('  data home                      ' + facts.dataHome);
  console.log('  log root                       ' + facts.logs.root);
  console.log('');
  console.log(baseline.render(summary));
}

if (require.main === module) {
  main();
}

module.exports = { collect, treeStats };

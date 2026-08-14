#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');
const mapPath = path.join(repoRoot, 'docs', '维护者', '维护映射表.json');

function fail(message, code = 1) {
  console.error(`Maintainer map error: ${message}`);
  process.exit(code);
}

function loadMap() {
  if (!fs.existsSync(mapPath)) {
    fail(`missing file: ${path.relative(repoRoot, mapPath)}`);
  }
  try {
    return JSON.parse(fs.readFileSync(mapPath, 'utf8'));
  } catch (error) {
    fail(`cannot parse ${path.relative(repoRoot, mapPath)}: ${error.message}`);
  }
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    area: '',
    json: false,
    check: false,
    listAreas: false,
  };

  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === '--json') {
      out.json = true;
      continue;
    }
    if (token === '--check') {
      out.check = true;
      continue;
    }
    if (token === '--list-areas') {
      out.listAreas = true;
      continue;
    }
    if (token === '--area') {
      const next = args[i + 1];
      if (!next) fail('missing value after --area', 2);
      out.area = next;
      i += 1;
      continue;
    }
    fail(`unknown argument: ${token}`, 2);
  }

  return out;
}

function resolveArea(map, areaId) {
  if (!areaId) return null;
  const area = (map.areas || []).find((item) => item.id === areaId);
  if (!area) fail(`unknown area: ${areaId}`, 2);
  return area;
}

function printListAreas(map) {
  for (const area of map.areas || []) {
    console.log(`${area.id} - ${area.label}`);
  }
}

function printStartupFlow(map) {
  console.log('Startup Flow');
  for (const step of map.startupFlow || []) {
    console.log(`${step.order}. ${step.label}`);
    console.log(`   Path: ${step.path}`);
    console.log(`   Why: ${step.why}`);
  }
}

function printArea(area) {
  console.log(`${area.label} [${area.id}]`);

  if (Array.isArray(area.whenToUse) && area.whenToUse.length > 0) {
    console.log('  Use When:');
    for (const item of area.whenToUse) {
      console.log(`    - ${item}`);
    }
  }

  if (Array.isArray(area.paths) && area.paths.length > 0) {
    console.log('  Paths:');
    for (const item of area.paths) {
      console.log(`    - ${item}`);
    }
  }

  if (Array.isArray(area.docs) && area.docs.length > 0) {
    console.log('  Docs:');
    for (const item of area.docs) {
      console.log(`    - ${item}`);
    }
  }

  if (Array.isArray(area.verify) && area.verify.length > 0) {
    console.log('  Verify:');
    for (const item of area.verify) {
      console.log(`    - ${item}`);
    }
  }
}

function pathStatus(relPath) {
  const fullPath = path.join(repoRoot, relPath);
  return {
    path: relPath,
    exists: fs.existsSync(fullPath),
    type: fs.existsSync(fullPath)
      ? (fs.statSync(fullPath).isDirectory() ? 'dir' : 'file')
      : 'missing',
  };
}

function checkMap(map) {
  const allPaths = new Map();

  for (const step of map.startupFlow || []) {
    allPaths.set(step.path, pathStatus(step.path));
  }
  for (const area of map.areas || []) {
    for (const item of area.paths || []) allPaths.set(item, pathStatus(item));
    for (const item of area.docs || []) allPaths.set(item, pathStatus(item));
  }

  const missing = [...allPaths.values()].filter((item) => !item.exists);
  for (const item of [...allPaths.values()]) {
    console.log(`${item.exists ? 'OK' : 'MISSING'} ${item.type} ${item.path}`);
  }

  if (missing.length > 0) {
    process.exitCode = 1;
  }
}

// 收集根 + backend 两个 package.json 的 scripts 键集(单一真源:npm run <name> 必须真实存在)。
// 读不到某个 package.json 时静默跳过(纯读、绝不因缺文件而误报)。
function collectNpmScriptNames() {
  const names = new Set();
  const pkgPaths = [
    path.join(repoRoot, 'package.json'),
    path.join(repoRoot, 'services', 'backend', 'package.json'),
  ];
  for (const pkgPath of pkgPaths) {
    try {
      if (!fs.existsSync(pkgPath)) continue;
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      for (const name of Object.keys(pkg.scripts || {})) names.add(name);
    } catch {
      /* 解析失败 → 跳过该 package.json,不误报 */
    }
  }
  return names;
}

// 校验每个 area 的 verify 字段(CLAUDE.md 第四条声明 verify 必填):
//  1. verify 非空(字符串或数组皆可,映射表两种形态都有)—— 空 → MISSING-VERIFY,exitCode=1。
//  2. verify 里每个 `npm run <name>` 的 <name> 必须存在于根/backend package.json 的 scripts。
//     被改名/删除的 npm 脚本会让 verify 静默烂掉,这里把它变成会亮红灯的 STALE-VERIFY。
//  只校验 `npm run` 前缀命令;裸 `node --test <path>` / shell 命令不在此校验范围(保守不误报)。
//  `npm run <name> --prefix apps/ai-frontend` 的 workspace 脚本:若根/backend 均无同名脚本,
//  但命令带 `--prefix`,视为 workspace 委托,放行(与既有映射表约定一致)。
function checkVerify(map) {
  const scriptNames = collectNpmScriptNames();
  const NPM_RUN_RE = /\bnpm run ([\w:-]+)/g;
  let problems = 0;

  for (const area of map.areas || []) {
    const verify = area.verify;
    const commands = Array.isArray(verify)
      ? verify
      : (typeof verify === 'string' && verify.trim() ? [verify] : []);

    if (commands.length === 0) {
      console.log(`MISSING-VERIFY ${area.id}`);
      problems += 1;
      continue;
    }

    for (const command of commands) {
      if (typeof command !== 'string') continue;
      const hasPrefix = /--prefix\s+\S+/.test(command);
      let match;
      NPM_RUN_RE.lastIndex = 0;
      while ((match = NPM_RUN_RE.exec(command)) !== null) {
        const name = match[1];
        if (scriptNames.has(name)) continue;
        if (hasPrefix) continue; // workspace 委托(如 --prefix apps/ai-frontend),放行
        console.log(`STALE-VERIFY ${area.id}: npm run ${name}`);
        problems += 1;
      }
    }
  }

  if (problems === 0) {
    console.log(`OK verify (${(map.areas || []).length} areas)`);
  } else {
    process.exitCode = 1;
  }
}

function main() {
  const options = parseArgs(process.argv);
  const map = loadMap();
  const selectedArea = resolveArea(map, options.area);

  if (options.json) {
    const payload = selectedArea
      ? { schemaVersion: map.schemaVersion, updated: map.updated, area: selectedArea }
      : map;
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (options.listAreas) {
    printListAreas(map);
    return;
  }

  if (options.check) {
    checkMap(selectedArea ? { startupFlow: [], areas: [selectedArea] } : map);
    checkVerify(selectedArea ? { areas: [selectedArea] } : map);
    return;
  }

  console.log(`Maintainer Map (updated ${map.updated})`);
  console.log(map.purpose);
  console.log('');

  if (!selectedArea) {
    printStartupFlow(map);
    console.log('');
    console.log('Maintenance Areas');
    for (const area of map.areas || []) {
      printArea(area);
      console.log('');
    }
    return;
  }

  printArea(selectedArea);
}

main();

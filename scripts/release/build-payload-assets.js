#!/usr/bin/env node
'use strict';

/** Build immutable first-use payload assets for one GitHub Release. */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const MANIFEST_ASSET = 'khy-payload-manifest.json';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(argv[i]);
    if (!match) continue;
    let value = match[2];
    if (value === undefined && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      value = argv[++i];
    }
    args[match[1]] = value === undefined ? true : value;
  }
  return args;
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function copyAsset(source, outDir, asset) {
  const stat = fs.statSync(source);
  if (!stat.isFile() || stat.size === 0) throw new Error(`payload input is empty: ${source}`);
  const destination = path.join(outDir, asset);
  fs.copyFileSync(source, destination);
  return { asset, sha256: sha256File(destination), size: stat.size };
}

// markdown 拓展正在从 tools/khyos-markdown 改名到 extensions/khy-markdown，而改名尚未落到
// 提交树 —— 写死任一侧都会在另一侧 ENOENT（发布流水线是在 tag 的干净检出上跑的，
// 拿不到工作树里那份暂存的改名）。所以按存在性解析，改名前后都能工作。
function resolveMarkdownExtensionDir(root) {
  const candidates = [
    path.join(root, 'extensions', 'khy-markdown'),
    path.join(root, 'tools', 'khyos-markdown'),
  ];
  const found = candidates.find((dir) => fs.existsSync(path.join(dir, 'muya-embed', 'ensure-vendor.mjs')));
  if (!found) {
    throw new Error(`markdown extension not found; looked under: ${candidates.join(', ')}`);
  }
  return found;
}

function buildPayloadAssets(options = {}) {
  const root = path.resolve(options.root || ROOT);
  const version = String(options.version || '').trim();
  const outDir = path.resolve(options.outDir || path.join(root, 'publish', 'payloads'));
  if (!/^\d+\.\d+\.\d+(?:[.-][A-Za-z0-9.]+)?$/.test(version)) {
    throw new Error('expected --version X.Y.Z');
  }
  const packageVersion = String(
    JSON.parse(fs.readFileSync(path.join(root, 'services', 'backend', 'package.json'), 'utf8')).version
  );
  if (packageVersion !== version) {
    throw new Error(`payload version mismatch: requested ${version}, package ${packageVersion}`);
  }

  fs.mkdirSync(outDir, { recursive: true });
  for (const name of fs.readdirSync(outDir)) fs.rmSync(path.join(outDir, name), { recursive: true, force: true });

  const snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-release-source-'));
  try {
    execFileSync(
      process.execPath,
      [path.join(root, 'services', 'backend', 'scripts', 'makeSourceSnapshot.js'), '--root', root, '--out', snapshotDir, '--require'],
      { cwd: root, stdio: 'inherit', env: { ...process.env, KHY_SNAPSHOT_FROM: 'head' } }
    );

    const sourceFiles = [
      ['snapshot.json', 'source-snapshot.json'],
      ['khy-os-source.tar.gz.enc', 'source-snapshot.tar.gz.enc'],
    ].map(([relativePath, asset]) => ({
      path: relativePath,
      ...copyAsset(path.join(snapshotDir, relativePath), outDir, asset),
    }));

    // vendor/ 不进 git（.gitignore「可再生构建产物」段），发布机上必须先由源码重建，
    // 否则 markdown-vendor payload 会缺 asset，pip 用户首次打开 Markdown 工作台就下载
    // 失败。--required：构建不出来即红灯，绝不发一个残缺的 Release。
    const markdownDir = resolveMarkdownExtensionDir(root);
    execFileSync(
      process.execPath,
      [path.join(markdownDir, 'muya-embed', 'ensure-vendor.mjs'), '--required'],
      { cwd: root, stdio: 'inherit' }
    );

    const vendorDir = path.join(markdownDir, 'vendor');
    const vendorFiles = [
      ['MANIFEST.json', 'markdown-vendor-manifest.json'],
      ['khyos-muya.js', 'markdown-vendor-muya.js'],
      ['khyos-muya.css', 'markdown-vendor-muya.css'],
    ].map(([relativePath, asset]) => ({
      path: relativePath,
      ...copyAsset(path.join(vendorDir, relativePath), outDir, asset),
    }));

    const manifest = {
      format: 'khy-release-payloads',
      formatVersion: 1,
      version,
      payloads: {
        'source-snapshot': { files: sourceFiles },
        'markdown-vendor': { files: vendorFiles },
      },
    };
    fs.writeFileSync(path.join(outDir, MANIFEST_ASSET), `${JSON.stringify(manifest, null, 2)}\n`);
    return { outDir, manifest };
  } finally {
    fs.rmSync(snapshotDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = buildPayloadAssets({ version: args.version, outDir: args.out, root: args.root });
    process.stdout.write(`[payload-release] ${result.manifest.version}: ${result.outDir}\n`);
  } catch (error) {
    process.stderr.write(`[payload-release] failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { MANIFEST_ASSET, buildPayloadAssets, copyAsset, parseArgs, resolveMarkdownExtensionDir, sha256File };

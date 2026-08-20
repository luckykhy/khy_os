#!/usr/bin/env node
'use strict';

/**
 * Archive an already-assembled portable artifact.
 *
 * Assembly is owned by build-portable-artifact.js. This command only verifies
 * the manifest and creates a zip, so an unverified source-tree snapshot can no
 * longer be mistaken for a portable release.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { verifyArtifactManifest } = require('./artifact-manifest');

function parseArgs(argv) {
  const options = { artifact: '', out: '', dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--artifact') options.artifact = path.resolve(argv[++index] || '');
    else if (token === '--out') options.out = path.resolve(argv[++index] || '');
    else if (token === '--dry-run') options.dryRun = true;
    else if (token === '--help' || token === '-h') options.help = true;
    else if (token === '--no-modules') {
      throw new Error('--no-modules 已淘汰；runtime 产物本身只包含运行所需文件');
    } else {
      throw new Error(`未知参数: ${token}`);
    }
  }
  if (!options.help && !options.artifact) throw new Error('--artifact <dir> 是必需参数');
  return options;
}

function printHelp() {
  console.log([
    '用法: node extensions/scripts/khy-portable/pack-portable.js --artifact <dir> [选项]',
    '  --out <dir>    zip 输出目录（默认产物目录的父目录）',
    '  --dry-run      只验证 manifest 和显示归档路径',
  ].join('\n'));
}

function findArchiver() {
  if (process.platform === 'win32') {
    const systemTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    if (fs.existsSync(systemTar)) return { kind: 'tar', command: systemTar };
    return { kind: 'powershell', command: 'powershell.exe' };
  }
  const probe = spawnSync('which', ['zip'], { encoding: 'utf8', windowsHide: true });
  const command = probe.status === 0 ? String(probe.stdout).split(/\r?\n/)[0].trim() : '';
  return command ? { kind: 'zip', command } : null;
}

function archiveWithTar(tar, artifactDir, archivePath) {
  const parent = path.dirname(artifactDir);
  const name = path.basename(artifactDir);
  const result = spawnSync(tar, ['-a', '-c', '-f', archivePath, '-C', parent, name], {
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`tar 退出码 ${result.status}${result.error ? `: ${result.error.message}` : ''}`);
  }
}

function archiveWithZip(zip, artifactDir, archivePath) {
  const result = spawnSync(zip, ['-q', '-r', archivePath, path.basename(artifactDir)], {
    cwd: path.dirname(artifactDir),
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`zip 退出码 ${result.status}${result.error ? `: ${result.error.message}` : ''}`);
  }
}

function archiveWithPowerShell(artifactDir, archivePath) {
  const escapedSource = artifactDir.replace(/'/g, "''");
  const escapedArchive = archivePath.replace(/'/g, "''");
  const command = [
    '$ErrorActionPreference = \'Stop\'',
    `Compress-Archive -LiteralPath '${escapedSource}' -DestinationPath '${escapedArchive}' -CompressionLevel Optimal -Force`,
  ].join('; ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(`Compress-Archive 退出码 ${result.status}`);
}

async function packArtifact(options) {
  const artifactDir = path.resolve(options.artifact);
  if (!fs.existsSync(artifactDir) || !fs.statSync(artifactDir).isDirectory()) {
    throw new Error(`产物目录不存在: ${artifactDir}`);
  }
  const verification = await verifyArtifactManifest(artifactDir);
  if (!verification.ok) {
    throw new Error(`产物验证失败:\n- ${verification.issues.join('\n- ')}`);
  }
  const outputDir = options.out || path.dirname(artifactDir);
  const archivePath = path.join(outputDir, `${path.basename(artifactDir)}.zip`);
  const result = {
    artifactDir,
    archivePath,
    manifest: verification.manifest,
    packed: false,
  };
  if (options.dryRun) return result;

  fs.mkdirSync(outputDir, { recursive: true });
  fs.rmSync(archivePath, { force: true });
  const archiver = findArchiver();
  if (!archiver) throw new Error('未找到 zip 命令');
  if (archiver.kind === 'tar') archiveWithTar(archiver.command, artifactDir, archivePath);
  else if (archiver.kind === 'zip') archiveWithZip(archiver.command, artifactDir, archivePath);
  else archiveWithPowerShell(artifactDir, archivePath);
  result.packed = true;
  result.size = fs.statSync(archivePath).size;
  return result;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return 0;
  }
  const result = await packArtifact(options);
  console.log(`Artifact: ${result.manifest.name}`);
  console.log(`Files:    ${result.manifest.files.length}`);
  console.log(`Archive:  ${result.archivePath}`);
  console.log(result.packed ? `Bytes:    ${result.size}` : 'Mode:     dry-run');
  return 0;
}

module.exports = {
  parseArgs,
  findArchiver,
  archiveWithTar,
  archiveWithZip,
  archiveWithPowerShell,
  packArtifact,
  main,
};

if (require.main === module) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(`[pack] ${error.message}`);
    process.exitCode = 1;
  });
}

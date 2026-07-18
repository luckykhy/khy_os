#!/usr/bin/env node
'use strict';
// khyos-md-launch.js — 从 UTF-8 临时文件读取目标路径，再启动桥接器
// VBS 通过命令行传临时文件路径（纯 ASCII，无编码问题），
// 本脚本以 UTF-8 读取临时文件中的真实路径，再调用桥接器。

const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');

const scriptDir = __dirname;
const bridge = path.join(scriptDir, 'khyos-md-bridge.js');

// 从命令行参数取临时文件路径
const tmpFile = process.argv[2];
let targetPath = '';

if (tmpFile && fs.existsSync(tmpFile)) {
  try {
    targetPath = fs.readFileSync(tmpFile, 'utf-8').trim();
  } catch (_) { /* ignore */ }
  try { fs.unlinkSync(tmpFile); } catch (_) { /* ignore */ }
}

// 启动桥接器（继承 stdout/stderr 以便看到日志）
const args = [bridge];
if (targetPath) args.push(targetPath);

const child = spawn(process.execPath, args, {
  stdio: 'inherit',
  windowsHide: true,
});

child.on('error', (err) => {
  console.error('[khyosMarkdown] launch failed:', err.message);
  process.exit(1);
});

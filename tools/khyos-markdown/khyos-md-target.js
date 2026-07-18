#!/usr/bin/env node
'use strict';
// khyos-md-target.js — 从临时文件读取 URL 编码的路径，解码后启动桥接器
const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');

const tmpFile = process.argv[2];
let targetPath = '';

if (tmpFile && fs.existsSync(tmpFile)) {
  try {
    const encoded = fs.readFileSync(tmpFile, 'utf-8').trim();
    if (encoded) targetPath = decodeURIComponent(encoded);
  } catch (_) { /* ignore */ }
  try { fs.unlinkSync(tmpFile); } catch (_) {}
}

const bridge = path.join(__dirname, 'khyos-md-bridge.js');
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

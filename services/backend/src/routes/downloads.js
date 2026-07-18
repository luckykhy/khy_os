const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();

const DIST_DIR = path.resolve(__dirname, '../../..', 'dist');

const ARTIFACT_PATTERNS = {
  windows: [/\.exe$/i, /setup/i],
  android: [/\.apk$/i]
};

function listArtifacts(platform) {
  if (!fs.existsSync(DIST_DIR)) return [];
  const patterns = ARTIFACT_PATTERNS[platform];
  if (!patterns) return [];

  const fileNames = fs.readdirSync(DIST_DIR);
  return fileNames
    .filter((fileName) => {
      if (fileName.startsWith('.')) return false;
      if (fileName.endsWith('.blockmap')) return false;
      return patterns.every((pattern) => pattern.test(fileName));
    })
    .map((fileName) => {
      const fullPath = path.join(DIST_DIR, fileName);
      const stat = fs.statSync(fullPath);
      return {
        fileName,
        fullPath,
        size: stat.size,
        mtimeMs: stat.mtimeMs
      };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function sendArtifact(res, artifact) {
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', artifact.size);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent(artifact.fileName)}`
  );

  const stream = fs.createReadStream(artifact.fullPath);
  stream.on('error', () => {
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: '文件读取失败' });
    } else {
      res.end();
    }
  });
  stream.pipe(res);
}

router.get('/list', (req, res) => {
  const windows = listArtifacts('windows')[0] || null;
  const android = listArtifacts('android')[0] || null;

  res.json({
    success: true,
    data: {
      windows: windows
        ? {
            fileName: windows.fileName,
            size: windows.size,
            updatedAt: new Date(windows.mtimeMs).toISOString(),
            url: '/api/downloads/windows'
          }
        : null,
      android: android
        ? {
            fileName: android.fileName,
            size: android.size,
            updatedAt: new Date(android.mtimeMs).toISOString(),
            url: '/api/downloads/android'
          }
        : null
    }
  });
});

router.get('/windows', (req, res) => {
  const artifact = listArtifacts('windows')[0];
  if (!artifact) {
    return res.status(404).json({ success: false, message: 'Windows 安装包不存在' });
  }
  return sendArtifact(res, artifact);
});

router.get('/android', (req, res) => {
  const artifact = listArtifacts('android')[0];
  if (!artifact) {
    return res.status(404).json({ success: false, message: 'Android 安装包不存在' });
  }
  return sendArtifact(res, artifact);
});

module.exports = router;

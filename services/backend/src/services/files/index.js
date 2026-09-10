'use strict';

/**
 * Files API service — managed file storage for AI models.
 * Supports multiple providers: OpenAI, Azure, Bedrock, Gemini, Vertex AI.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { URL } = require('url');

function _env(name) {
  return String(process.env[`KHY_FILES_${name}`] || '').trim();
}

function _request(urlStr, method = 'GET', body = null, headers = {}) {
  return new Promise((resolve) => {
    try {
      const url = new URL(urlStr);
      const isHttps = url.protocol === 'https:';
      const lib = isHttps ? https : http;
      const data = body || '';
      const req = lib.request({
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers: {
          'Content-Type': body ? 'application/json' : undefined,
          'Content-Length': data ? Buffer.byteLength(data) : 0,
          ...headers,
        },
      }, (res) => {
        let responseData = '';
        res.on('data', (c) => { responseData += c; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, data: JSON.parse(responseData) }); }
          catch { resolve({ status: res.statusCode, data: responseData }); }
        });
      });
      req.on('error', (e) => resolve({ status: 0, error: e.message }));
      req.setTimeout(60000, () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
      if (data) req.write(data);
      req.end();
    } catch (e) {
      resolve({ status: 0, error: e.message });
    }
  });
}

// ── OpenAI Files API ──
async function openaiUploadFile(filePath, purpose = 'assistants') {
  const apiKey = _env('OPENAI_API_KEY') || process.env.OPENAI_API_KEY;
  if (!apiKey) return { error: 'OpenAI API Key not configured.' };

  const fileBuffer = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);
  const boundary = '----FormBoundary' + Math.random().toString(16).slice(2);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\n${purpose}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    fileBuffer,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/files',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    }, (res) => {
      let responseBody = '';
      res.on('data', (c) => { responseBody += c; });
      res.on('end', () => {
        try {
          const json = JSON.parse(responseBody);
          resolve({ status: res.statusCode, data: json, provider: 'openai' });
        } catch (e) { resolve({ status: res.statusCode, error: responseBody }); }
      });
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.write(body);
    req.end();
  });
}

async function openaiListFiles(purpose = null) {
  const apiKey = _env('OPENAI_API_KEY') || process.env.OPENAI_API_KEY;
  if (!apiKey) return { error: 'OpenAI API Key not configured.' };

  const query = purpose ? `?purpose=${purpose}` : '';
  return _request(`https://api.openai.com/v1/files${query}`, 'GET', null, { 'Authorization': `Bearer ${apiKey}` });
}

async function openaiDeleteFile(fileId) {
  const apiKey = _env('OPENAI_API_KEY') || process.env.OPENAI_API_KEY;
  if (!apiKey) return { error: 'OpenAI API Key not configured.' };

  return _request(`https://api.openai.com/v1/files/${fileId}`, 'DELETE', null, { 'Authorization': `Bearer ${apiKey}` });
}

// ── Azure Files API ──
async function azureUploadFile(filePath, purpose = 'assistants') {
  const apiKey = _env('AZURE_OPENAI_API_KEY');
  const endpoint = _env('AZURE_OPENAI_ENDPOINT');
  if (!apiKey) return { error: 'Azure OpenAI API Key not configured.' };

  const fileBuffer = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);

  return new Promise((resolve) => {
    const req = https.request({
      hostname: new URL(endpoint).hostname,
      path: '/openai/files?api-version=2024-02-15-preview',
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'x-ms-file-purpose': purpose,
        'Content-Length': fileBuffer.length,
      },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body), provider: 'azure' }); }
        catch { resolve({ status: res.statusCode, error: body }); }
      });
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.write(fileBuffer);
    req.end();
  });
}

// ── Local Files API (fallback) ──
function getLocalFilesDir() {
  const dir = path.join(os.homedir(), '.khy', 'files');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

async function localUploadFile(filePath, purpose = 'general') {
  const filesDir = getLocalFilesDir();
  const fileName = path.basename(filePath);
  const id = `file_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const destPath = path.join(filesDir, id);

  fs.copyFileSync(filePath, destPath);

  // Save metadata
  const metaPath = path.join(filesDir, `${id}.meta.json`);
  const meta = {
    id,
    filename: fileName,
    purpose,
    size: fs.statSync(destPath).size,
    createdAt: new Date().toISOString(),
    path: destPath,
  };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

  return { success: true, id, data: { ...meta, provider: 'local' } };
}

async function localListFiles(purpose = null) {
  const filesDir = getLocalFilesDir();
  const files = [];

  try {
    const entries = fs.readdirSync(filesDir).filter((f) => f.endsWith('.meta.json'));
    for (const entry of entries) {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(filesDir, entry), 'utf-8'));
        if (!purpose || meta.purpose === purpose) {
          files.push(meta);
        }
      } catch (e) { /* skip */ }
    }
  } catch (e) { /* empty */ }

  return { success: true, files, provider: 'local' };
}

async function localDeleteFile(fileId) {
  const filesDir = getLocalFilesDir();
  const filePath = path.join(filesDir, fileId);
  const metaPath = path.join(filesDir, `${fileId}.meta.json`);

  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
    return { success: true, id: fileId, deleted: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ── Provider registry ──
const PROVIDERS = {
  openai: {
    name: 'OpenAI Files',
    upload: openaiUploadFile,
    list: openaiListFiles,
    delete: openaiDeleteFile,
  },
  azure: {
    name: 'Azure Files',
    upload: azureUploadFile,
    list: () => ({ error: 'Not implemented' }),
    delete: () => ({ error: 'Not implemented' }),
  },
  local: {
    name: 'Local Files',
    upload: localUploadFile,
    list: localListFiles,
    delete: localDeleteFile,
  },
};

function listProviders() {
  return Object.entries(PROVIDERS).map(([id, p]) => ({ id, name: p.name }));
}

function isProviderConfigured(providerId) {
  switch (providerId) {
    case 'openai': return !!(_env('OPENAI_API_KEY') || process.env.OPENAI_API_KEY);
    case 'azure': return !!_env('AZURE_OPENAI_API_KEY');
    case 'local': return true;
    default: return false;
  }
}

async function uploadFile(providerId, filePath, purpose) {
  const provider = PROVIDERS[providerId];
  if (!provider) return { error: `Unknown provider: ${providerId}` };
  return provider.upload(filePath, purpose);
}

async function listFiles(providerId, purpose) {
  const provider = PROVIDERS[providerId];
  if (!provider) return { error: `Unknown provider: ${providerId}` };
  return provider.list(purpose);
}

async function deleteFile(providerId, fileId) {
  const provider = PROVIDERS[providerId];
  if (!provider) return { error: `Unknown provider: ${providerId}` };
  return provider.delete(fileId);
}

module.exports = {
  listProviders,
  isProviderConfigured,
  uploadFile,
  listFiles,
  deleteFile,
  openaiUploadFile,
  openaiListFiles,
  openaiDeleteFile,
  localUploadFile,
  localListFiles,
  localDeleteFile,
};

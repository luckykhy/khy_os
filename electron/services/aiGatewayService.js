const https = require('https');
const http = require('http');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_FILE = path.join(os.homedir(), '.khyquant', 'config.json');

function getApiConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
    const config = JSON.parse(raw);
    return {
      endpoint: config.aiEndpoint || config.apiEndpoint || '',
      apiKey: config.aiApiKey || config.apiKey || '',
      model: config.aiModel || 'claude-sonnet-4-20250514',
    };
  } catch {
    return { endpoint: '', apiKey: '', model: 'claude-sonnet-4-20250514' };
  }
}

function httpRequest(url, options, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;

    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: options.method || 'POST',
        headers: options.headers || {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const responseBody = Buffer.concat(chunks);
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: responseBody,
          });
        });
      }
    );

    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy(new Error('请求超时 (30s)'));
    });

    if (body) req.write(body);
    req.end();
  });
}

const aiGateway = {
  async generate(data) {
    const config = getApiConfig();
    if (!config.endpoint) {
      throw new Error('AI 未配置：请先在 ~/.khyquant/config.json 中设置 aiEndpoint');
    }
    if (!config.apiKey) {
      throw new Error('API Key 缺失：请先在 ~/.khyquant/config.json 中设置 aiApiKey');
    }

    const url = `${config.endpoint.replace(/\/$/, '')}/v1/chat/completions`;
    const payload = JSON.stringify({
      model: data.model || config.model,
      messages: data.messages || [{ role: 'user', content: data.prompt || '' }],
      max_tokens: data.maxTokens || 4096,
      temperature: data.temperature ?? 0.7,
    });

    const response = await httpRequest(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
      },
      payload
    );

    if (response.status < 200 || response.status >= 300) {
      const errorText = response.body.toString('utf-8').slice(0, 500);
      throw new Error(`AI 请求失败 (${response.status})：${errorText}`);
    }

    const result = JSON.parse(response.body.toString('utf-8'));
    return {
      content: result.choices?.[0]?.message?.content || '',
      usage: result.usage || {},
      model: result.model || config.model,
    };
  },

  async stream(data, callbackId, mainWindow) {
    const config = getApiConfig();
    if (!config.endpoint) {
      mainWindow?.webContents.send(`ai:chunk:${callbackId}`, {
        error: 'AI 未配置：请先在 ~/.khyquant/config.json 中设置 aiEndpoint',
      });
      return;
    }
    if (!config.apiKey) {
      mainWindow?.webContents.send(`ai:chunk:${callbackId}`, {
        error: 'API Key 缺失：请先在 ~/.khyquant/config.json 中设置 aiApiKey',
      });
      return;
    }

    const url = `${config.endpoint.replace(/\/$/, '')}/v1/chat/completions`;
    const payload = JSON.stringify({
      model: data.model || config.model,
      messages: data.messages || [{ role: 'user', content: data.prompt || '' }],
      max_tokens: data.maxTokens || 4096,
      temperature: data.temperature ?? 0.7,
      stream: true,
    });

    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;

    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
      },
      (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const errText = Buffer.concat(chunks).toString('utf-8').slice(0, 500);
            mainWindow?.webContents.send(`ai:chunk:${callbackId}`, {
              error: `AI 请求失败 (${res.statusCode})：${errText}`,
            });
          });
          return;
        }

        let buffer = '';
        res.on('data', (chunk) => {
          buffer += chunk.toString('utf-8');
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data: ')) continue;
            const jsonStr = trimmed.slice(6);
            if (jsonStr === '[DONE]') {
              mainWindow?.webContents.send(`ai:chunk:${callbackId}`, { done: true });
              continue;
            }
            try {
              const parsed = JSON.parse(jsonStr);
              const delta = parsed.choices?.[0]?.delta?.content || '';
              if (delta) {
                mainWindow?.webContents.send(`ai:chunk:${callbackId}`, { delta });
              }
            } catch {
              // Skip malformed SSE lines.
            }
          }
        });

        res.on('end', () => {
          mainWindow?.webContents.send(`ai:chunk:${callbackId}`, { done: true });
        });
      }
    );

    req.on('error', (err) => {
      mainWindow?.webContents.send(`ai:chunk:${callbackId}`, {
        error: `网络错误：${err.message}`,
      });
    });

    req.setTimeout(120000, () => {
      req.destroy(new Error('流式请求超时 (120s)'));
    });

    req.write(payload);
    req.end();

    return { callbackId, streaming: true };
  },
};

module.exports = aiGateway;

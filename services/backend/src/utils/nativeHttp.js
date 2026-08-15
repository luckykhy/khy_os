'use strict';

const http = require('http');
const https = require('https');

const HTTP_AGENT = new http.Agent({ keepAlive: true, maxFreeSockets: 8 });
const HTTPS_AGENT = new https.Agent({ keepAlive: true, maxFreeSockets: 8 });
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

function request(url, options = {}) {
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(options.query || {})) {
    if (value !== undefined && value !== null) parsed.searchParams.set(key, String(value));
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return Promise.reject(new Error(`Unsupported protocol: ${parsed.protocol}`));
  }
  const transport = parsed.protocol === 'https:' ? https : http;
  const agent = parsed.protocol === 'https:' ? HTTPS_AGENT : HTTP_AGENT;
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : DEFAULT_MAX_BYTES;
  return new Promise((resolve, reject) => {
    const req = transport.request(parsed, {
      method: options.method || 'GET',
      headers: options.headers,
      agent,
    }, response => {
      const chunks = [];
      let total = 0;
      response.on('data', chunk => {
        total += chunk.length;
        if (total > maxBytes) {
          response.destroy(new Error(`Response exceeds ${maxBytes} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const text = buffer.toString('utf8');
        let data = text;
        try { data = text ? JSON.parse(text) : {}; } catch { /* text response */ }
        resolve({ status: response.statusCode, headers: response.headers, data, text, buffer });
      });
      response.on('error', reject);
    });
    req.setTimeout(options.timeoutMs || 30000, () => req.destroy(new Error('Request timed out')));
    if (options.signal) {
      const onAbort = () => req.destroy(new Error('Request aborted'));
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
      req.once('close', () => options.signal.removeEventListener('abort', onAbort));
    }
    req.on('error', reject);
    req.end(options.body);
  });
}

function requestStream(url, options = {}) {
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(options.query || {})) {
    if (value !== undefined && value !== null) parsed.searchParams.set(key, String(value));
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return Promise.reject(new Error(`Unsupported protocol: ${parsed.protocol}`));
  }
  const transport = parsed.protocol === 'https:' ? https : http;
  const agent = options.agent || (parsed.protocol === 'https:' ? HTTPS_AGENT : HTTP_AGENT);
  return new Promise((resolve, reject) => {
    const req = transport.request(parsed, {
      method: options.method || 'GET', headers: options.headers, agent,
    }, response => {
      const location = response.headers.location;
      const redirectsLeft = Number.isInteger(options.maxRedirects) ? options.maxRedirects : 0;
      if (location && [301, 302, 303, 307, 308].includes(response.statusCode) && redirectsLeft > 0) {
        const redirectUrl = new URL(location, parsed);
        try {
          if (options.beforeRedirect) options.beforeRedirect(redirectUrl);
        } catch (err) {
          response.resume();
          reject(err);
          return;
        }
        response.resume();
        resolve(requestStream(redirectUrl, { ...options, maxRedirects: redirectsLeft - 1 }));
        return;
      }
      const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : null;
      if (maxBytes !== null) {
        let total = 0;
        response.on('data', chunk => {
          total += chunk.length;
          if (total > maxBytes) response.destroy(new Error(`Response exceeds ${maxBytes} bytes`));
        });
        response._nativeBytes = () => total;
      }
      resolve({ status: response.statusCode, headers: response.headers, stream: response });
    });
    req.setTimeout(options.timeoutMs || 30000, () => req.destroy(new Error('Request timed out')));
    if (options.signal) {
      const onAbort = () => req.destroy(new Error('Request aborted'));
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
      req.once('close', () => options.signal.removeEventListener('abort', onAbort));
    }
    req.on('error', reject);
    req.end(options.body);
  });
}

function requestStatus(url, options = {}) {
  return request(url, options).then(({ status }) => ({ status }));
}

module.exports = { request, requestStream, requestStatus };

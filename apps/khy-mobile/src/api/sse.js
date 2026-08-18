import { apiFetch } from './client';

export function parseSseBlock(block) {
  let event = 'message';
  let id = null;
  const data = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('id:')) id = line.slice(3).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (!data.length) return null;
  const raw = data.join('\n');
  try { return { event, id, data: JSON.parse(raw) }; }
  catch { return { event, id, data: raw }; }
}

export async function consumeSse(path, options = {}) {
  const { onEvent, signal, ...request } = options;
  const response = await apiFetch(path, { ...request, signal });
  if (!response.ok) throw new Error(`事件流连接失败（HTTP ${response.status}）`);
  if (!response.body) throw new Error('当前 WebView 不支持流式响应');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done }).replace(/\r\n/g, '\n');
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const parsed = parseSseBlock(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      if (parsed && onEvent) onEvent(parsed);
    }
    if (done) break;
  }
}

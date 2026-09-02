import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';

// Local persistence layer backed by @capacitor/preferences (native) or
// localStorage (browser). Conversations / messages / prompts / settings are
// stored as JSON blobs keyed by a namespace. All APIs are async so native
// storage never blocks the UI.

const NS = {
  conversations: 'khy_db_conversations_v1',
  messages: 'khy_db_messages_v1',
  prompts: 'khy_db_prompts_v1',
  settings: 'khy_db_settings_v1',
};

function storage() {
  return Capacitor.isNativePlatform()
    ? Preferences
    : {
        async get({ key }) { return { value: localStorage.getItem(key) }; },
        async set({ key, value }) { localStorage.setItem(key, value); },
        async remove({ key }) { localStorage.removeItem(key); },
      };
}

async function readMap(ns) {
  const { value } = await storage().get({ key: NS[ns] });
  if (!value) return {};
  try { return JSON.parse(value); } catch { return {}; }
}

async function writeMap(ns, map) {
  await storage().set({ key: NS[ns], value: JSON.stringify(map) });
}

function now() {
  return new Date().toISOString();
}

function newId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---- settings ----

export async function getSetting(key) {
  const map = await readMap('settings');
  return map[key];
}

export async function setSetting(key, value) {
  const map = await readMap('settings');
  map[key] = value;
  await writeMap('settings', map);
}

// ---- conversations ----

export async function listConversations() {
  const map = await readMap('conversations');
  return Object.values(map).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

export async function getConversation(id) {
  const map = await readMap('conversations');
  return map[id] || null;
}

export async function createConversation({ title, model, provider, mode }) {
  const map = await readMap('conversations');
  const id = newId();
  map[id] = {
    id,
    title: String(title || '新对话').slice(0, 60),
    model: String(model || ''),
    provider: String(provider || ''),
    mode: String(mode || 'remote'),
    pinned: false,
    createdAt: now(),
    updatedAt: now(),
  };
  await writeMap('conversations', map);
  return map[id];
}

export async function updateConversation(id, patch) {
  const map = await readMap('conversations');
  if (!map[id]) return null;
  map[id] = { ...map[id], ...patch, updatedAt: now() };
  await writeMap('conversations', map);
  return map[id];
}

export async function removeConversation(id) {
  const map = await readMap('conversations');
  delete map[id];
  await writeMap('conversations', map);
  await removeMessages(id);
}

// ---- messages ----

export async function listMessages(convId) {
  const map = await readMap('messages');
  return (map[convId] || []).slice().sort((a, b) => a.seq - b.seq);
}

export async function appendMessage(convId, message) {
  const map = await readMap('messages');
  const list = map[convId] || [];
  const seq = list.length ? list[list.length - 1].seq + 1 : 0;
  list.push({
    seq,
    id: message.id || newId(),
    role: message.role,
    content: message.content || '',
    toolCalls: message.toolCalls || null,
    toolCallId: message.toolCallId || null,
    toolName: message.toolName || null,
    toolOk: typeof message.toolOk === 'boolean' ? message.toolOk : null,
    thinking: message.thinking || null,
    tokensUsed: message.tokensUsed || null,
    createdAt: message.createdAt || now(),
  });
  map[convId] = list;
  await writeMap('messages', map);
}

export async function updateMessage(convId, seq, patch) {
  const map = await readMap('messages');
  const list = map[convId] || [];
  const index = list.findIndex((item) => item.seq === seq);
  if (index < 0) return;
  list[index] = { ...list[index], ...patch };
  map[convId] = list;
  await writeMap('messages', map);
}

export async function removeMessages(convId) {
  const map = await readMap('messages');
  delete map[convId];
  await writeMap('messages', map);
}

// ---- prompts ----

export async function listPrompts() {
  const map = await readMap('prompts');
  return Object.values(map).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

export async function upsertPrompt(prompt) {
  const map = await readMap('prompts');
  const id = prompt.id || newId();
  map[id] = {
    id,
    title: String(prompt.title || '未命名提示词').slice(0, 80),
    content: String(prompt.content || ''),
    category: String(prompt.category || '通用'),
    tags: Array.isArray(prompt.tags) ? prompt.tags : [],
    source: String(prompt.source || 'custom'),
    useCount: Number(prompt.useCount || 0),
    createdAt: prompt.createdAt || now(),
  };
  await writeMap('prompts', map);
  return map[id];
}

export async function removePrompt(id) {
  const map = await readMap('prompts');
  delete map[id];
  await writeMap('prompts', map);
}

export async function bumpPromptUse(id) {
  const map = await readMap('prompts');
  if (!map[id]) return;
  map[id].useCount = Number(map[id].useCount || 0) + 1;
  await writeMap('prompts', map);
}

export { now, newId };

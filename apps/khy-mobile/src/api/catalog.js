import { apiJson } from './client';

// Backend model catalog + tool + usage adapters. These hit the real khy-os
// endpoints so the mobile app can reuse the full gateway without duplicating
// provider wiring on the device.

// Model catalog — GET /api/user-gateway/catalog (flat edge list, per-user).
export async function fetchModelCatalog() {
  const payload = await apiJson('/api/user-gateway/catalog');
  const edges = Array.isArray(payload) ? payload : payload?.edges || payload?.data || [];
  const byProvider = {};
  const modelList = [];
  for (const item of edges) {
    const provider = String(item?.provider || item?.vendor || 'unknown');
    const id = String(item?.model || item?.id || '');
    const label = String(item?.label || item?.displayName || id);
    if (!id) continue;
    const entry = { id, label, provider };
    modelList.push(entry);
    if (!byProvider[provider]) byProvider[provider] = [];
    byProvider[provider].push(entry);
  }
  return { providers: Object.keys(byProvider), byProvider, models: modelList };
}

// Tool catalog — GET /api/tools (callable tool descriptors).
export async function fetchTools() {
  const payload = await apiJson('/api/tools');
  const list = Array.isArray(payload) ? payload : payload?.tools || payload?.data || [];
  return list.map((item) => ({
    name: String(item?.name || item?.id || 'unknown'),
    description: String(item?.description || ''),
    category: String(item?.category || ''),
  }));
}

// Usage summary — GET /api/usage (usage metering data plane).
export async function fetchUsage() {
  const payload = await apiJson('/api/usage');
  return payload && typeof payload === 'object' ? payload : {};
}

// Usage history — GET /api/usage/history
export async function fetchUsageHistory(params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value != null) query.set(key, String(value));
  }
  const qs = query.toString();
  return apiJson(`/api/usage/history${qs ? `?${qs}` : ''}`);
}

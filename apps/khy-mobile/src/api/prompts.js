import { apiJson } from './client';

// Remote prompt library adapter against the khy-os backend
// (/api/ai/prompts on the management server). Mirrors the record shape of
// promptStore.toRecord so remote prompts can be merged into the local library.

export async function fetchRemotePrompts({ status = 'active', q = '' } = {}) {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (q) params.set('q', q);
  const query = params.toString();
  return apiJson(`/api/ai/prompts${query ? `?${query}` : ''}`);
}

export async function fetchBuiltinPrompts() {
  const payload = await apiJson('/api/ai/prompts/builtin');
  const templates =
    payload && Array.isArray(payload.templates)
      ? payload.templates
      : payload && Array.isArray(payload)
        ? payload
        : [];
  return templates.map((item, index) => ({
    id: `builtin-${item.id || index}`,
    title: String(item.title || '内置提示词'),
    content: String(item.prompt || item.content || ''),
    category: String(item.category || '内置'),
    tags: Array.isArray(item.tags) ? item.tags : [],
    source: 'khyos_sync',
  }));
}

export async function createRemotePrompt(data) {
  return apiJson('/api/ai/prompts', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateRemotePrompt(id, data) {
  return apiJson(`/api/ai/prompts/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function removeRemotePrompt(id) {
  return apiJson(`/api/ai/prompts/${id}`, { method: 'DELETE' });
}

export async function useRemotePrompt(id) {
  return apiJson(`/api/ai/prompts/${id}/use`, { method: 'POST' });
}

export async function approveRemotePrompt(id) {
  return apiJson(`/api/ai/prompts/${id}/approve`, { method: 'POST' });
}

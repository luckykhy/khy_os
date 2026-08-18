'use strict';

// Pure helpers for staged TUI image attachments. UI ids are deliberately kept
// out of the gateway payload; they only make per-item deletion deterministic.

function appendAttachment(list, image, id) {
  const source = Array.isArray(list) ? list : [];
  if (!image || typeof image.base64 !== 'string' || !image.base64) {
    return source;
  }
  const safeId = String(id || '').trim();
  if (!safeId || source.some((item) => item && item.id === safeId)) {
    return source;
  }
  return [...source, { id: safeId, base64: image.base64, mimeType: image.mimeType || 'image/png' }];
}

function removeAttachment(list, id) {
  if (!Array.isArray(list) || !id) {
    return Array.isArray(list) ? list : [];
  }
  const index = list.findIndex((item) => item && item.id === id);
  if (index === -1) {
    return list;
  }
  return [...list.slice(0, index), ...list.slice(index + 1)];
}

function removeLastAttachment(list) {
  if (!Array.isArray(list) || list.length === 0) {
    return Array.isArray(list) ? list : [];
  }
  return list.slice(0, -1);
}

function labels(list) {
  if (!Array.isArray(list)) {
    return [];
  }
  return list.map((item, index) => ({ id: item && item.id, label: `图${index + 1}` }));
}

function toPayload(list) {
  if (!Array.isArray(list)) {
    return [];
  }
  return list
    .filter((item) => item && typeof item.base64 === 'string' && item.base64)
    .map(({ base64, mimeType }) => ({ base64, mimeType: mimeType || 'image/png' }));
}

module.exports = { appendAttachment, removeAttachment, removeLastAttachment, labels, toPayload };

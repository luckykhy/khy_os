'use strict';

/**
 * Runtime vision capability probe — pure decision layer.
 * Network execution lives in aiGatewayModelMethods, mirroring toolCallingProbe.
 */

const zlib = require('zlib');
const _norm = require('../../utils/trimLowerNullish');

function _crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function _pngChunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(_crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

// A 32x16 red/blue split avoids tiny-image rejection. The expected colors stay
// outside the prompt so a text-only model cannot pass by echoing instructions.
function _buildProbeImageDataUrl() {
  const width = 32;
  const height = 16;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      const offset = 1 + x * 3;
      if (x < width / 2) row.set([255, 0, 0], offset);
      else row.set([0, 0, 255], offset);
    }
    rows.push(row);
  }
  const png = Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    _pngChunk('IHDR', ihdr),
    _pngChunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    _pngChunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

const PROBE_IMAGE_DATA_URL = _buildProbeImageDataUrl();
const PROBE_PROMPT =
  'Vision capability probe. Inspect the attached image. Reply with only the two dominant colors, ' +
  'left half first and right half second, in English. Do not say that no image was provided.';
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_SUPPORTED_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function isEnabled(env = process.env) {
  const value = _norm(env && env.KHY_VISION_CAP_PROBE);
  return !(value === '0' || value === 'false' || value === 'off' || value === 'no');
}

function ttlMs(env = process.env) {
  const value = parseInt((env && env.KHY_VISION_CAP_TTL_MS) || '', 10);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TTL_MS;
}

function supportedTtlMs(env = process.env) {
  const value = parseInt((env && env.KHY_VISION_CAP_SUPPORTED_TTL_MS) || '', 10);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_SUPPORTED_TTL_MS;
}

function normalizeModel(model) {
  return _norm(model);
}

function interpretProbeResult(result) {
  try {
    const r = result || {};
    if (r.success === false) {
      const error = _norm(r.error || r.code || r.reason);
      if (
        /(image|vision|multimodal|media|input).*(not supported|does not support|unsupported|invalid|reject|unable)/i.test(
          error
        ) ||
        /(not supported|does not support|unsupported|invalid|reject).*(image|vision|multimodal|media|input)/i.test(error)
      ) {
        return { verdict: 'unsupported', reason: 'upstream_rejected_image_input' };
      }
      return { verdict: 'unknown', reason: 'generation_failed' };
    }
    const text = String(r.content == null ? '' : r.content).trim().toLowerCase();
    if (!text) {
      return { verdict: 'unknown', reason: 'empty_response' };
    }
    if (text.includes('red') && text.includes('blue')) {
      return { verdict: 'supported', reason: 'probe_visual_attributes_observed' };
    }
    if (/(no image|未收到图片|无法识别图片|cannot see|no vision|image.*not)/i.test(text)) {
      return { verdict: 'unsupported', reason: 'model_denied_image_in_response' };
    }
    return { verdict: 'unknown', reason: 'image_observation_not_verified' };
  } catch {
    return { verdict: 'unknown', reason: 'interpret_error' };
  }
}

function shouldReprobe(record, env = process.env, now) {
  if (!record || (record.verdict !== 'supported' && record.verdict !== 'unsupported')) {
    return true;
  }
  const measuredAt = Number(record.measuredAt);
  if (!Number.isFinite(measuredAt)) {
    return true;
  }
  const age = (Number.isFinite(now) ? now : Date.now()) - measuredAt;
  const ttl = record.verdict === 'supported' ? supportedTtlMs(env) : ttlMs(env);
  return age > ttl;
}

module.exports = {
  PROBE_IMAGE_DATA_URL,
  PROBE_PROMPT,
  DEFAULT_TTL_MS,
  DEFAULT_SUPPORTED_TTL_MS,
  isEnabled,
  ttlMs,
  supportedTtlMs,
  normalizeModel,
  interpretProbeResult,
  shouldReprobe,
};

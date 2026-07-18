'use strict';

/**
 * ndjsonStream.js — Resilient NDJSON streaming parser.
 *
 * Ported from OpenClaw's ollama/stream.ts.
 * Provides:
 *   - Buffer boundary handling for chunked streams
 *   - Malformed line recovery (log + skip)
 *   - Partial JSON across chunk boundaries
 *   - Async generator pattern for backpressure
 *   - Safe integer preservation for large IDs
 */

const MALFORMED_LOG_MAX_CHARS = 120;
const MAX_BUFFER_BYTES = 1024 * 1024; // 1MB buffer safety cap

/**
 * Parse a Newline-Delimited JSON stream from a ReadableStream reader.
 * Yields one parsed object per complete JSON line.
 * Malformed lines are skipped with a warning.
 *
 * Resilience features:
 *   - Stream error/close handlers (prevents silent data loss)
 *   - Buffer size cap (prevents memory exhaustion)
 *   - Idle timeout (detects stalled streams)
 *   - Partial data preservation on interruption
 *
 * @param {ReadableStreamDefaultReader<Uint8Array>} reader
 * @param {object} [opts]
 * @param {object} [opts.logger] - Logger with .warn() method
 * @param {function} [opts.parse] - Custom JSON parser (default: JSON.parse)
 * @param {number} [opts.idleTimeoutMs] - Max ms between chunks (0 = disabled)
 * @param {AbortSignal} [opts.signal] - Abort signal for cancellation
 * @param {function} [opts.onStatus] - Status callback: onStatus(status, detail)
 * @returns {AsyncGenerator<unknown>}
 */
async function* parseNdjsonStream(reader, opts = {}) {
  const logger = opts.logger || null;
  const parse = opts.parse || JSON.parse;
  const idleTimeoutMs = opts.idleTimeoutMs || 0;
  const signal = opts.signal || null;
  const onStatus = opts.onStatus || null;
  const decoder = new TextDecoder();
  let buffer = '';
  let itemCount = 0;
  let idleTimer = null;

  const clearIdle = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } };

  try {
    while (true) {
      if (signal?.aborted) {
        if (onStatus) onStatus('aborted', 'Signal aborted');
        break;
      }

      // Race: read vs idle timeout
      let readResult;
      if (idleTimeoutMs > 0) {
        readResult = await Promise.race([
          reader.read(),
          new Promise((_, reject) => {
            idleTimer = setTimeout(
              () => reject(new Error(`Stream idle for ${idleTimeoutMs}ms`)),
              idleTimeoutMs
            );
          }),
        ]);
        clearIdle();
      } else {
        readResult = await reader.read();
      }

      const { done, value } = readResult;
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Buffer overflow protection
      if (buffer.length > MAX_BUFFER_BYTES) {
        if (logger?.warn) {
          logger.warn(`NDJSON buffer exceeded ${MAX_BUFFER_BYTES} bytes, truncating`);
        }
        buffer = buffer.slice(-MAX_BUFFER_BYTES);
      }

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const obj = parse(trimmed);
          itemCount++;
          yield obj;
        } catch {
          if (logger?.warn) {
            logger.warn(`Skipping malformed NDJSON line: ${trimmed.slice(0, MALFORMED_LOG_MAX_CHARS)}`);
          }
        }
      }
    }
  } catch (err) {
    // Stream error — log but don't lose already-yielded data
    if (logger?.warn) {
      logger.warn(`NDJSON stream error after ${itemCount} items: ${err.message}`);
    }
    if (onStatus) onStatus('error', err.message);
  } finally {
    clearIdle();
    // Flush remaining buffer even on error
    const remaining = buffer.trim();
    if (remaining) {
      try {
        yield parse(remaining);
        itemCount++;
      } catch {
        if (logger?.warn) {
          logger.warn(`Skipping malformed trailing NDJSON: ${remaining.slice(0, MALFORMED_LOG_MAX_CHARS)}`);
        }
      }
    }
    if (onStatus) onStatus('done', `${itemCount} items parsed`);
  }
}

/**
 * Parse NDJSON from a Node.js Readable stream (e.g., http.IncomingMessage).
 * Adapts Node streams to the ReadableStreamDefaultReader interface.
 *
 * @param {import('stream').Readable} nodeStream
 * @param {object} [opts] - Same as parseNdjsonStream opts
 * @returns {AsyncGenerator<unknown>}
 */
async function* parseNdjsonNodeStream(nodeStream, opts = {}) {
  const parse = opts.parse || JSON.parse;
  const logger = opts.logger || null;
  const onStatus = opts.onStatus || null;
  // 流式 UTF-8 解码器：逐 chunk 调用 chunk.toString('utf8') 会在多字节字符
  // （中文/emoji）被 TCP/流分片切在两个 chunk 之间时各自落入替换符 �。
  // TextDecoder + {stream:true} 把半个序列留到下一 chunk 拼接，与 web 路径一致。
  const decoder = new TextDecoder();
  let buffer = '';
  let itemCount = 0;
  let streamError = null;

  // Attach error handler to catch stream errors without crashing
  nodeStream.on('error', (err) => {
    streamError = err;
    if (logger?.warn) {
      logger.warn(`Node stream error after ${itemCount} items: ${err.message}`);
    }
    if (onStatus) onStatus('error', err.message);
  });

  try {
    for await (const chunk of nodeStream) {
      if (streamError) break;
      const data = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      buffer += data;

      if (buffer.length > MAX_BUFFER_BYTES) {
        if (logger?.warn) logger.warn(`NDJSON node buffer exceeded ${MAX_BUFFER_BYTES} bytes, truncating`);
        buffer = buffer.slice(-MAX_BUFFER_BYTES);
      }

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = parse(trimmed);
          itemCount++;
          yield obj;
        } catch {
          if (logger?.warn) {
            logger.warn(`Skipping malformed NDJSON line: ${trimmed.slice(0, MALFORMED_LOG_MAX_CHARS)}`);
          }
        }
      }
    }
  } catch (err) {
    if (logger?.warn) {
      logger.warn(`NDJSON node stream error after ${itemCount} items: ${err.message}`);
    }
    if (onStatus) onStatus('error', err.message);
  } finally {
    // 刷新解码器残留的半个多字节序列（仅当至少喂过一个二进制 chunk 时非空）。
    const tail = decoder.decode();
    if (tail) buffer += tail;
    const remaining = buffer.trim();
    if (remaining) {
      try {
        const obj = parse(remaining);
        itemCount++;
        yield obj;
      } catch {
        if (logger?.warn) {
          logger.warn(`Skipping malformed trailing NDJSON: ${remaining.slice(0, MALFORMED_LOG_MAX_CHARS)}`);
        }
      }
    }
    if (onStatus) onStatus('done', `${itemCount} items parsed`);
  }
}

/**
 * Collect all items from an NDJSON stream into an array.
 * Convenience wrapper for testing and small datasets.
 *
 * @param {ReadableStreamDefaultReader<Uint8Array>} reader
 * @param {object} [opts]
 * @returns {Promise<unknown[]>}
 */
async function collectNdjsonStream(reader, opts = {}) {
  const items = [];
  for await (const item of parseNdjsonStream(reader, opts)) {
    items.push(item);
  }
  return items;
}

module.exports = {
  parseNdjsonStream,
  parseNdjsonNodeStream,
  collectNdjsonStream,
};

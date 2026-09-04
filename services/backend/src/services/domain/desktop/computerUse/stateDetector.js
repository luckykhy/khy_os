'use strict';

/**
 * stateDetector.js — Computer Use 环境反馈检测（对应「GUI Agent 综述」5.2.3 环境反馈）。
 *
 * 把「上一步动作是否真的生效」变成两条结构化信号，喂给决策提示词：
 *   1. 截图变化（视觉）   —— 依赖无关的纯 JS PNG 解码 + dHash 感知哈希，比较动作前后画面
 *   2. UI 结构变化（部件树）—— 对无障碍元素清单做集合差：新增 / 消失 / 位置变化
 *
 * 这两条信号对应综述中的「截图更新」与「UI 结构更改」两类反馈，让 agent 能察觉
 * 「点了没反应」（画面 / 元素无变化）并据此换策略，而不是在同一个元素上反复无效点击。
 * 全程无外部依赖：PNG 解码用内置 zlib + 手写 unfilter（非隔行 8-bit PNG，常见截屏格式）。
 */

const fs = require('fs');
const zlib = require('zlib');

// ── PNG 解码（纯 JS，非隔行、8-bit、灰度/RGB/RGBA/灰度+alpha/调色板）────────

function _paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) {
    return a;
  }
  if (pb <= pc) {
    return b;
  }
  return c;
}

/**
 * 把 PNG 字节解码为 RGBA 像素缓冲。
 * @param {Buffer} buf
 * @returns {{ width:number, height:number, data:Buffer }} data 为 width*height*4 的 RGBA
 */
function decodePng(buf) {
  if (!buf || buf.length < 8) {
    throw new Error('PNG 文件为空或过短');
  }
  const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== SIG[i]) {
      throw new Error('不是有效的 PNG 文件');
    }
  }

  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette = null;
  const idatChunks = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    if (type === 'IEND') {
      break;
    }
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    }
    pos += 12 + len;
  }

  if (!width || !height) {
    throw new Error('PNG 缺少有效 IHDR');
  }
  if (interlace !== 0) {
    throw new Error('隔行 PNG 不支持');
  }
  if (bitDepth !== 8) {
    throw new Error(`不支持的位深 ${bitDepth}`);
  }
  const channelsByColor = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const channels = channelsByColor[colorType];
  if (!channels) {
    throw new Error(`不支持的色彩类型 ${colorType}`);
  }

  const raw = zlib.inflateSync(Buffer.concat(idatChunks));
  const stride = width * channels;
  const bpp = channels; // 8-bit 下每像素字节数 = 通道数
  const rgba = Buffer.alloc(width * height * 4);
  const prev = Buffer.alloc(stride);
  let src = 0;

  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    const line = raw.subarray(src, src + stride);
    src += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let val = line[x];
      switch (filter) {
        case 0:
          break;
        case 1:
          val = (val + a) & 0xff;
          break;
        case 2:
          val = (val + b) & 0xff;
          break;
        case 3:
          val = (val + ((a + b) >> 1)) & 0xff;
          break;
        case 4:
          val = (val + _paeth(a, b, c)) & 0xff;
          break;
        default:
          throw new Error(`未知 PNG 滤波类型 ${filter}`);
      }
      line[x] = val;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const i = x * channels;
      if (colorType === 0) {
        const g = line[i];
        rgba[o] = g;
        rgba[o + 1] = g;
        rgba[o + 2] = g;
        rgba[o + 3] = 255;
      } else if (colorType === 2) {
        rgba[o] = line[i];
        rgba[o + 1] = line[i + 1];
        rgba[o + 2] = line[i + 2];
        rgba[o + 3] = 255;
      } else if (colorType === 6) {
        rgba[o] = line[i];
        rgba[o + 1] = line[i + 1];
        rgba[o + 2] = line[i + 2];
        rgba[o + 3] = line[i + 3];
      } else if (colorType === 4) {
        const g = line[i];
        rgba[o] = g;
        rgba[o + 1] = g;
        rgba[o + 2] = g;
        rgba[o + 3] = line[i + 1];
      } else if (colorType === 3) {
        const idx = line[i];
        const pi = idx * 3;
        if (!palette || pi + 2 >= palette.length) {
          throw new Error('调色板索引越界');
        }
        rgba[o] = palette[pi];
        rgba[o + 1] = palette[pi + 1];
        rgba[o + 2] = palette[pi + 2];
        rgba[o + 3] = 255;
      }
    }
    prev.set(line);
  }
  return { width, height, data: rgba };
}

// ── dHash 感知哈希 ─────────────────────────────────────────────────────────

function _luma(rgba, i) {
  return 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
}

/**
 * 计算 RGBA 图像的 gx×gy 亮度网格（每单元格平均亮度，0..255）。
 * 每像素恰好归属一个单元格（按地板划分），整幅图只遍历一遍。
 */
function lumaGrid(rgba, width, height, gx = 8, gy = 8) {
  const grid = new Float64Array(gx * gy);
  for (let gy2 = 0; gy2 < gy; gy2++) {
    const y0 = Math.floor((gy2 * height) / gy);
    const y1 = Math.max(y0 + 1, Math.floor(((gy2 + 1) * height) / gy));
    for (let gx2 = 0; gx2 < gx; gx2++) {
      const x0 = Math.floor((gx2 * width) / gx);
      const x1 = Math.max(x0 + 1, Math.floor(((gx2 + 1) * width) / gx));
      let sum = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        const base = y * width * 4;
        for (let x = x0; x < x1; x++) {
          const i = base + x * 4;
          sum += _luma(rgba, i);
          n += 1;
        }
      }
      grid[gy2 * gx + gx2] = sum / n;
    }
  }
  return grid;
}

/**
 * 计算 RGBA 图像的 64 位 dHash（9x8 网格 → 8x8 相邻单元格亮度比较），返回 16 位 hex。
 * 相同画面的两张截图 → 相同哈希；画面结构明显变化 → 汉明距离变大。
 * 注意：dHash 只记录「相对梯度方向」，对整体亮度/反色不敏感（这是它的鲁棒性设计），
 * 因此截图变化判定需配合 lumaGrid 的绝对亮度差使用（见 screenshotChanged）。
 */
function dHash(rgba, width, height) {
  const grid = lumaGrid(rgba, width, height, 9, 8);
  let bits = '';
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const idx = row * 9 + col;
      bits += grid[idx] > grid[idx + 1] ? '1' : '0';
    }
  }
  const hex = [];
  for (let i = 0; i < 64; i += 4) {
    hex.push(parseInt(bits.slice(i, i + 4), 2).toString(16));
  }
  return hex.join('');
}

/**
 * 计算两个 8x8 亮度网格的平均绝对差（0..255 范围）。
 * 用于捕捉 dHash 无法看到的绝对亮度变化（反色 / 整体明暗翻转）。
 */
function meanLumaDiff(gridA, gridB) {
  if (!gridA || !gridB || gridA.length !== gridB.length) {
    return 255;
  }
  let sum = 0;
  for (let i = 0; i < gridA.length; i++) {
    sum += Math.abs(gridA[i] - gridB[i]);
  }
  return sum / gridA.length;
}

/**
 * 计算两个 16 位 hex dHash 的汉明距离（不同 bit 数）。
 * @param {string} hexA
 * @param {string} hexB
 */
function hammingDistance(hexA, hexB) {
  if (!hexA || !hexB) {
    return 64;
  }
  const a = BigInt(`0x${hexA}`);
  const b = BigInt(`0x${hexB}`);
  let x = a ^ b;
  let count = 0;
  while (x) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}

/**
 * 只读 PNG 的 IHDR 获取宽高（不完整解码，轻量）。用于归一化坐标 → 实际像素的映射。
 * @param {string} filePath
 * @returns {{ width:number, height:number }|null}
 */
function pngDimensions(filePath) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(24);
    const n = fs.readSync(fd, buf, 0, 24, 0);
    if (n < 24) {
      return null;
    }
    if (buf.toString('ascii', 1, 4) !== 'PNG') {
      return null;
    }
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  } catch {
    return null;
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* 忽略 */
      }
    }
  }
}

/**
 * 读取 PNG 文件并返回 { width, height, phash, grid }。
 * phash 为 64 位 dHash hex；grid 为 8x8 亮度网格（绝对亮度变化用）。
 * 解码或哈希失败时抛错，调用方降级为「无法判断变化」。
 */
function pngInfo(filePath) {
  const buf = fs.readFileSync(filePath);
  const { width, height, data } = decodePng(buf);
  return {
    width,
    height,
    phash: dHash(data, width, height),
    grid: lumaGrid(data, width, height, 8, 8),
  };
}

/**
 * 比较两张截图的画面变化。判定 = dHash 结构差 ∪ 绝对亮度差：
 *   - dHash 汉明距离 ≥ thresholdBits（结构变化：元素移动/出现/消失）
 *   - 亮度网格平均绝对差 ≥ thresholdLuma（绝对变化：反色/整体明暗/大面积高亮）
 * 前者对亮度鲁棒，后者对结构鲁棒，两者互补覆盖「任何一眼可见的变化」。
 * @param {string} aPath 动作前截图
 * @param {string} bPath 动作后截图
 * @param {object} [opts] { thresholdBits=3, thresholdLuma=2.0 }
 * @returns {{ ok:true, changed:boolean, distance:number, lumaDiff:number,
 *             sizeChanged:boolean, reason:string } | { ok:false, error:string }}
 */
function screenshotChanged(aPath, bPath, opts = {}) {
  const thresholdBits = Number.isFinite(opts.thresholdBits) ? opts.thresholdBits : 3;
  const thresholdLuma = Number.isFinite(opts.thresholdLuma) ? opts.thresholdLuma : 2.0;
  try {
    const a = pngInfo(aPath);
    const b = pngInfo(bPath);
    if (a.width !== b.width || a.height !== b.height) {
      return {
        ok: true,
        changed: true,
        distance: 64,
        lumaDiff: 255,
        sizeChanged: true,
        reason: 'size_changed',
      };
    }
    const distance = hammingDistance(a.phash, b.phash);
    const lumaDiff = meanLumaDiff(a.grid, b.grid);
    const changed = distance >= thresholdBits || lumaDiff >= thresholdLuma;
    return {
      ok: true,
      changed,
      distance,
      lumaDiff: Math.round(lumaDiff * 100) / 100,
      sizeChanged: false,
      reason: changed ? 'visual_change' : 'visual_stable',
    };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

// ── UI 结构（部件树）diff ───────────────────────────────────────────────────

/**
 * 元素的规范化身份键：role|name|量化到 8px 网格的中心坐标|可点击|可编辑。
 * 用网格量化容忍元素在动作后发生 ≤8px 位移（不误报为「变化」）。
 * @param {object} el 规范化元素（含 center / role / name / clickable / editable）
 */
function elementKey(el) {
  if (!el) {
    return '';
  }
  const cx = el.center && Number.isFinite(el.center.x) ? Math.round(el.center.x / 8) : '?';
  const cy = el.center && Number.isFinite(el.center.y) ? Math.round(el.center.y / 8) : '?';
  return `${el.role || '?'}|${String(el.name || '')}|${cx},${cy}|${el.clickable ? 1 : 0}|${el.editable ? 1 : 0}`;
}

/**
 * 对两个元素清单做集合差，报告 UI 结构变化。
 * @param {Array} before 动作前元素
 * @param {Array} after  动作后元素
 * @returns {{ added:Array, removed:Array, changed:Array, addedCount:number, removedCount:number, changedCount:number }}
 */
function diffElements(before = [], after = []) {
  const keyCount = (arr) => {
    const m = new Map();
    for (const el of arr) {
      const k = elementKey(el);
      if (k) {
        m.set(k, (m.get(k) || 0) + 1);
      }
    }
    return m;
  };
  const b = keyCount(before);
  const a = keyCount(after);
  const _sample = (arr, key) => {
    for (const el of arr) {
      if (elementKey(el) === key) {
        return el;
      }
    }
    return null;
  };
  const added = [];
  const changed = [];
  for (const [k, count] of a) {
    const bc = b.get(k) || 0;
    if (bc === 0) {
      const s = _sample(after, k);
      if (s) {
        added.push(s);
      }
    } else if (bc !== count) {
      const s = _sample(after, k);
      if (s) {
        changed.push(s);
      }
    }
  }
  const removed = [];
  for (const [k] of b) {
    const ac = a.get(k) || 0;
    if (ac === 0) {
      const s = _sample(before, k);
      if (s) {
        removed.push(s);
      }
    }
  }
  return {
    added,
    removed,
    changed,
    addedCount: added.length,
    removedCount: removed.length,
    changedCount: changed.length,
  };
}

/**
 * 元素清单的稳定指纹（排序后的身份键集合），用于「元素是否整体变化」的快速判断。
 */
function elementFingerprint(elements = []) {
  return elements.map(elementKey).filter(Boolean).sort().join(';');
}

module.exports = {
  decodePng,
  lumaGrid,
  dHash,
  hammingDistance,
  meanLumaDiff,
  pngInfo,
  pngDimensions,
  screenshotChanged,
  elementKey,
  diffElements,
  elementFingerprint,
  _internals: { _paeth, _luma },
};

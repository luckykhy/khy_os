// Generate KhyOS desktop icon: .ico with ALL frames PNG-compressed
// (avoids the classic-frame premultiplied-alpha + AND-mask pitfalls that
// make Windows reject hand-built 32bpp classic icons). Plus 512px master PNG.
//
// Usage: node scripts/generate-icon.cjs
// Output: public/icon.ico, public/icon-512.png, resources/icon/icon.ico

const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

// ── RGBA canvas (opaque write, union alpha) ──
function makeCanvas(size) {
  const data = Buffer.alloc(size * size * 4)
  return {
    size,
    data,
    set(x, y, r, g, b, a) {
      if (a <= 0 || x < 0 || y < 0 || x >= size || y >= size) return
      const i = (y * size + x) * 4
      data[i] = Math.round(r)
      data[i + 1] = Math.round(g)
      data[i + 2] = Math.round(b)
      data[i + 3] = Math.max(data[i + 3], Math.round(a))
    },
  }
}

function roundRectGradient(cv, x0, y0, x1, y1, rad, top, bottom) {
  const h = y1 - y0
  for (let y = y0; y < y1; y++) {
    const t = (y - y0) / (h - 1 || 1)
    const r = Math.round(top[0] + (bottom[0] - top[0]) * t)
    const g = Math.round(top[1] + (bottom[1] - top[1]) * t)
    const b = Math.round(top[2] + (bottom[2] - top[2]) * t)
    for (let x = x0; x < x1; x++) {
      let dx = 0, dy = 0
      if (x < x0 + rad && y < y0 + rad) { dx = x0 + rad - x; dy = y0 + rad - y }
      else if (x > x1 - 1 - rad && y < y0 + rad) { dx = x1 - 1 - rad - x; dy = y0 + rad - y }
      else if (x < x0 + rad && y > y1 - 1 - rad) { dx = x0 + rad - x; dy = y1 - 1 - rad - y }
      else if (x > x1 - 1 - rad && y > y1 - 1 - rad) { dx = x1 - 1 - rad - x; dy = y1 - 1 - rad - y }
      if (dx !== 0 || dy !== 0) { if (Math.hypot(dx, dy) > rad) continue }
      cv.set(x, y, r, g, b, 255)
    }
  }
}

function topBevel(cv, x0, y0, x1, y1, rad, band, r, g, b, a) {
  for (let y = y0; y < Math.min(y0 + band, y1); y++) {
    for (let x = x0; x < x1; x++) {
      let dx = 0, dy = 0
      if (x < x0 + rad && y < y0 + rad) { dx = x0 + rad - x; dy = y0 + rad - y }
      else if (x > x1 - 1 - rad && y < y0 + rad) { dx = x1 - 1 - rad - x; dy = y0 + rad - y }
      if (dx !== 0 || dy !== 0) { if (Math.hypot(dx, dy) > rad) continue }
      cv.set(x, y, r, g, b, a)
    }
  }
}

function stroke(cv, ax, ay, bx, by, w, r, g, b, a) {
  const dx = bx - ax, dy = by - ay
  const len = Math.hypot(dx, dy) || 1
  const steps = Math.max(2, Math.ceil(len * 6))
  const rad = w / 2
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const cx = ax + dx * t, cy = ay + dy * t
    for (let oy = -rad; oy <= rad; oy += 0.5) {
      for (let ox = -rad; ox <= rad; ox += 0.5) {
        if (ox * ox + oy * oy > rad * rad) continue
        cv.set(Math.round(cx + ox), Math.round(cy + oy), r, g, b, a)
      }
    }
  }
}

function disc(cv, cx, cy, rad, r, g, b, a) {
  for (let oy = -rad; oy <= rad; oy += 0.5) {
    for (let ox = -rad; ox <= rad; ox += 0.5) {
      if (ox * ox + oy * oy > rad * rad) continue
      cv.set(Math.round(cx + ox), Math.round(cy + oy), r, g, b, a)
    }
  }
}

function drawK(cv, S) {
  const m = S / 256
  const w = [255, 255, 255]
  const strokeW = 38 * m, capR = strokeW / 2
  const stemX = 0.34 * S, topY = 0.24 * S, botY = 0.76 * S, midY = 0.5 * S
  const endX = 0.74 * S, endTopY = 0.22 * S, endBotY = 0.78 * S
  stroke(cv, stemX, topY, stemX, botY, strokeW, w[0], w[1], w[2], 255)
  stroke(cv, stemX, midY, endX, endTopY, strokeW, w[0], w[1], w[2], 255)
  stroke(cv, stemX, midY, endX, endBotY, strokeW, w[0], w[1], w[2], 255)
  for (const [px, py] of [[stemX, topY], [stemX, botY], [endX, endTopY], [endX, endBotY], [stemX, midY]]) {
    disc(cv, px, py, capR, w[0], w[1], w[2], 255)
  }
}

function composeIcon(size) {
  const cv = makeCanvas(size)
  const u = size / 256
  const margin = Math.round(10 * u)
  const x0 = margin, y0 = margin, x1 = size - margin, y1 = size - margin
  const rad = Math.round(44 * u)
  roundRectGradient(cv, x0, y0, x1, y1, rad, [99, 102, 241], [49, 46, 129])
  topBevel(cv, x0, y0, x1, y1, rad, Math.max(2, Math.round(6 * u)), 224, 231, 255, 70)
  const shBand = Math.max(2, Math.round(6 * u))
  for (let y = y1 - shBand; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      let dx = 0, dy = 0
      if (x < x0 + rad && y < y0 + rad) { dx = x0 + rad - x; dy = y0 + rad - y }
      else if (x > x1 - 1 - rad && y < y0 + rad) { dx = x1 - 1 - rad - x; dy = y0 + rad - y }
      else if (x < x0 + rad && y > y1 - 1 - rad) { dx = x0 + rad - x; dy = y1 - 1 - rad - y }
      else if (x > x1 - 1 - rad && y > y1 - 1 - rad) { dx = x1 - 1 - rad - x; dy = y1 - 1 - rad - y }
      if (dx !== 0 || dy !== 0) { if (Math.hypot(dx, dy) > rad) continue }
      cv.set(x, y, 17, 16, 49, 50)
    }
  }
  drawK(cv, size)
  return cv
}

// ── PNG encoder ──
function crc32(buf) {
  if (!crc32.table) {
    crc32.table = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crc32.table[n] = c >>> 0
    }
  }
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = crc32.table[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function rgbaToPng(size, data) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  function chunk(type, payload) {
    const len = Buffer.alloc(4); len.writeUInt32BE(payload.length, 0)
    const typeBuf = Buffer.from(type, 'ascii')
    const crc = Buffer.alloc(4); crc.writeUInt32LE(crc32(Buffer.concat([typeBuf, payload])), 0)
    return Buffer.concat([len, typeBuf, payload, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    for (let x = 0; x < size; x++) {
      const si = (y * size + x) * 4
      const di = y * (size * 4 + 1) + 1 + x * 4
      raw[di] = data[si]; raw[di + 1] = data[si + 1]; raw[di + 2] = data[si + 2]; raw[di + 3] = data[si + 3]
    }
  }
  const idat = zlib.deflateSync(raw, { level: 9 })
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

// ── ICO container, all frames PNG ──
function buildIcoAllPng(frames) {
  const count = frames.length
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(count, 4)
  let offset = 6 + count * 16
  const dir = [], body = []
  for (const f of frames) {
    const data = f.data
    const wByte = f.size === 256 ? 0 : f.size
    const entry = Buffer.alloc(16)
    entry[0] = wByte; entry[1] = wByte
    entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6)
    entry.writeUInt32LE(data.length, 8); entry.writeUInt32LE(offset, 12)
    dir.push(entry); body.push(data); offset += data.length
  }
  return Buffer.concat([header, ...dir, ...body])
}

function main() {
  const outDir = path.join(process.cwd(), 'public')
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })

  // Master 512 PNG (source asset)
  const master = composeIcon(512)
  fs.writeFileSync(path.join(outDir, 'icon-512.png'), rgbaToPng(512, master.data))
  console.log('wrote public/icon-512.png')

  // ICO: every frame PNG-compressed (16/32/48/64/256)
  const frames = []
  for (const s of [16, 32, 48, 64, 256]) {
    const cv = composeIcon(s)
    frames.push({ size: s, data: rgbaToPng(s, cv.data) })
  }
  const ico = buildIcoAllPng(frames)
  fs.writeFileSync(path.join(outDir, 'icon.ico'), ico)
  console.log('wrote public/icon.ico (' + ico.length + ' bytes, all-PNG frames 16/32/48/64/256)')

  const resDir = path.join(process.cwd(), 'resources', 'icon')
  if (!fs.existsSync(resDir)) fs.mkdirSync(resDir, { recursive: true })
  fs.writeFileSync(path.join(resDir, 'icon.ico'), ico)
  console.log('wrote resources/icon/icon.ico')
}

main()

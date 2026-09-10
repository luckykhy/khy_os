// Extract selected files from an Electron asar archive to disk.
// Usage: node asar-extract.cjs <asar> <outDir> <innerPath> [<innerPath> ...]
const fs = require('fs');
const path = require('path');

const [, , asarPath, outDir, ...innerPaths] = process.argv;
const buf = fs.readFileSync(asarPath);
const u32 = (o) => buf.readUInt32LE(o);

const headerObjSize = u32(4);
const headerStrSize = u32(8);
const headerStart = 16;
const header = JSON.parse(buf.toString('utf8', headerStart, headerStart + headerStrSize - 4));
const dataOffset = 8 + headerObjSize;

function find(node, p) {
  const parts = p.replace(/^\//, '').split('/').filter(Boolean);
  let cur = node;
  for (const part of parts) {
    if (!cur.files || !cur.files[part]) return null;
    cur = cur.files[part];
  }
  return cur;
}

let ok = 0;
for (const p of innerPaths) {
  const n = find(header, p);
  if (!n || n.offset === undefined) {
    console.error(`MISS  ${p}`);
    continue;
  }
  const dest = path.join(outDir, p.replace(/^\//, ''));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf.subarray(dataOffset + Number(n.offset), dataOffset + Number(n.offset) + Number(n.size)));
  console.log(`OK    ${n.size}\t${p}`);
  ok++;
}
console.error(`--- extracted ${ok}/${innerPaths.length} ---`);

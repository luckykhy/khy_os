// Inspect an Electron asar archive without full extraction.
// Usage:
//   node asar-inspect.cjs list <asar>            -> file tree with sizes
//   node asar-inspect.cjs tree <asar>            -> top-level entries only
//   node asar-inspect.cjs cat <asar> <inner-path> -> dump a file to stdout
const fs = require('fs');
const zlib = require('zlib');

const [, , mode, asarPath, innerPath] = process.argv;

// asar header layout:
//   u32: header size on disk (including this field)
//   u32: header object size
//   u32: header string length (padded to 4)
//   u32: string length
const buf = fs.readFileSync(asarPath);
const u32 = (o) => buf.readUInt32LE(o);

let headerStart = 8;
const headerObjSize = u32(4);
const headerStrSize = u32(headerStart);
headerStart += 8;
const headerJson = buf.toString('utf8', headerStart, headerStart + headerStrSize - 4);
const header = JSON.parse(headerJson);
const dataOffset = 8 + headerObjSize;

function walk(node, prefix, out) {
  if (node.files) {
    for (const [name, child] of Object.entries(node.files)) {
      const p = prefix ? `${prefix}/${name}` : name;
      if (child.files) walk(child, p, out);
      else if (child.offset !== undefined) out.push([p, child.size || 0]);
    }
  }
}

function find(node, path) {
  const parts = path.replace(/^\//, '').split('/').filter(Boolean);
  let cur = node;
  for (const part of parts) {
    if (!cur.files || !cur.files[part]) return null;
    cur = cur.files[part];
  }
  return cur;
}

if (mode === 'sub') {
  const root = find(header, innerPath.replace(/^\//, ''));
  if (!root) {
    console.error(`not found: ${innerPath}`);
    process.exit(1);
  }
  const all = [];
  walk(root, '', all);
  for (const [p, s] of all) console.log(`${String(s).padStart(9)}\t/${innerPath}/${p}`);
  console.error(`--- ${all.length} files under /${innerPath} ---`);
} else if (mode === 'tree') {
  for (const [name, child] of Object.entries(header.files || {})) {
    const size = child.files ? '(dir)' : child.size || 0;
    console.log(`${size}\t/${name}`);
  }
} else if (mode === 'cat') {
  const n = find(header, innerPath);
  if (!n || n.offset === undefined) {
    console.error(`not found: ${innerPath}`);
    process.exit(1);
  }
  process.stdout.write(buf.toString('binary', dataOffset + Number(n.offset), dataOffset + Number(n.offset) + Number(n.size)));
} else {
  const all = [];
  walk(header, '', all);
  all.sort((a, b) => b[1] - a[1]);
  const limit = process.env.LIMIT ? Number(process.env.LIMIT) : 400;
  for (const [p, s] of all.slice(0, limit)) console.log(`${String(s).padStart(9)}\t/${p}`);
  console.error(`--- ${all.length} files total, showing top ${Math.min(limit, all.length)} by size ---`);
}

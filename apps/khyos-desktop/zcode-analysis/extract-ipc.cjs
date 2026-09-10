// Extract IPC channel names from a ZCode preload bundle.
// Usage: node extract-ipc.cjs <preload.cjs>
const fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');

// Channel literals in various call shapes:
//   ipcRenderer.invoke("ch:x", ...), ipcRenderer.on('ch:x', cb), ipcRenderer.send(...)
const re = /ipcRenderer\.(invoke|on|send|sendSync|removeListener)\s*\(\s*(`[^`]+`|"[^"]+"|'[^']+')/g;
const map = new Map(); // channel -> Set<methods>
let m;
while ((m = re.exec(src))) {
  const ch = m[2].slice(1, -1);
  if (!map.has(ch)) map.set(ch, new Set());
  map.get(ch).add(m[1]);
}

const out = [...map.entries()]
  .sort((a, b) => a[0].localeCompare(b[0]))
  .map(([ch, methods]) => `${ch}\t${[...methods].sort().join(',')}`);
fs.writeFileSync('ipc-channels.tsv', out.join('\n') + '\n', 'utf8');
fs.writeFileSync(
  'ipc-channels.json',
  JSON.stringify(Object.fromEntries([...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => [k, [...v].sort()])), null, 2),
  'utf8'
);

// Top-level namespace summary
const groups = {};
for (const ch of map.keys()) {
  const g = ch.split(':')[0];
  groups[g] = (groups[g] || 0) + 1;
}
process.stderr.write(`--- ${map.size} channels, ${Object.keys(groups).length} namespaces ---\n`);
process.stderr.write(JSON.stringify(groups, null, 2) + '\n');

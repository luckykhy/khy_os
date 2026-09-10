// Extract the RPC surface exposed by a ZCode preload bundle.
// Channels are referenced through a constant object, e.g. ipcRenderer.invoke(b.DoThing, ...).
// Usage: node extract-rpc.cjs <preload.cjs> <outdir>
const fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');
const outdir = process.argv[3] || '.';

const re = /ipcRenderer\.(invoke|on|send|sendSync)\s*\(\s*(?:[A-Za-z_$][\w$]*\.)?([A-Za-z_$][\w$]*)/g;
const perMethod = new Map();
let m;
while ((m = re.exec(src))) {
  const kind = m[1];
  const name = m[2];
  if (!perMethod.has(name)) perMethod.set(name, { invoke: 0, on: 0, send: 0, sendSync: 0 });
  perMethod.get(name)[kind]++;
}
const entries = [...perMethod.entries()]
  .sort((a, b) => a[0].localeCompare(b[0]))
  .map(([name, kinds]) => ({ name, ...kinds, via: kinds.invoke ? 'invoke' : kinds.on ? 'on' : 'send' }));
fs.writeFileSync(`${outdir}/rpc-surface.json`, JSON.stringify(entries, null, 2), 'utf8');
fs.writeFileSync(
  `${outdir}/rpc-surface.tsv`,
  entries.map((e) => `${e.name}\t${e.invoke}\t${e.on}\t${e.send}\t${e.sendSync}`).join('\n') + '\n',
  'utf8'
);
process.stderr.write(`--- ${entries.length} distinct RPC method identifiers ---\n`);
const kinds = entries.reduce((a, e) => { a[e.via] = (a[e.via] || 0) + 1; return a; }, {});
process.stderr.write(JSON.stringify(kinds) + '\n');
